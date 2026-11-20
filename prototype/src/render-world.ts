// Stage 3 renderer, in two modes that draw the same scene with the same shaders:
//   gpu:   every instance lives in one large GPU buffer; a compute pass culls against the camera and
//          writes per-kind visible lists and draw counts; a render bundle replays a fixed list of
//          indirect draws (firstInstance is always 0).
//   plain: the CPU culls every frame and issues one instanced draw per kind.
// The world is drawn at a fixed internal resolution, then one pass upscales it to the canvas with a
// sharpening filter and colour grading, and the UI is drawn after that at canvas resolution.
import type { Gpu } from './gpu';
import { GpuTimer } from './gpu';
import { ENTRY_BYTES, HEADER_BYTES } from './protocol';
import { ATLAS_COLS, ATLAS_ROWS, DYNAMIC_KINDS, KIND_COUNT, KIND_GRASS, KIND_TREE, KIND_WALL, POS_SCALE, VERTEX_LAYOUT, buildMeshes } from './meshes';
import type { MeshSet } from './meshes';
import { Camera } from './camera';
import { CULL_WGSL, FINAL_WGSL, WORLD_WGSL } from './shaders';

export const VAT_FRAMES = 32;
const VAT_KIND = 0;
export const SHADOW = KIND_COUNT;   // index of the blob-shadow draw in the indirect buffer
const DRAW_STRIDE = 256;            // per-draw uniform slot (minUniformBufferOffsetAlignment in core WebGPU)
// Layers, drawn front to back for a top-down camera: foreground (tree tops), play plane, background.
const LAYER_ORDER: number[] = [KIND_TREE, ...Array.from({ length: DYNAMIC_KINDS }, (_, k) => k), KIND_WALL, KIND_GRASS];

export function makeAtlas(): { size: number; levels: Uint8Array[] } {
  const size = 1024, px = new Uint8Array(size * size * 4);
  const cw = size / ATLAS_COLS, ch = size / ATLAS_ROWS;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const kind = Math.floor(y / ch) * ATLAS_COLS + Math.floor(x / cw);
    const u = (x % cw) / cw, v = (y % ch) / ch;
    let r: number, g: number, b: number;
    if (kind === 16) { r = g = 0.92; b = 1; }
    else if (kind === KIND_WALL) { r = 0.46; g = 0.44; b = 0.42; }
    else if (kind === KIND_GRASS) { r = 0.25; g = 0.5; b = 0.18; }
    else if (kind === KIND_TREE) { r = v < 0.5 ? 0.2 : 0.35; g = v < 0.5 ? 0.45 : 0.25; b = 0.15; }
    else { const h = kind / 16 * Math.PI * 2; r = 0.55 + 0.4 * Math.cos(h); g = 0.55 + 0.4 * Math.cos(h + 2.094); b = 0.55 + 0.4 * Math.cos(h + 4.188); }
    // Stripes and grain so the texture has detail for the mip chain and the sharpening pass.
    const detail = 0.85 + 0.15 * Math.sin(u * 40 + Math.sin(v * 23) * 3) * Math.sin(v * 31) + ((x * 7919 + y * 104729) % 17) / 17 * 0.08;
    const o = (y * size + x) * 4;
    px[o] = Math.min(255, r * detail * 255); px[o + 1] = Math.min(255, g * detail * 255); px[o + 2] = Math.min(255, b * detail * 255); px[o + 3] = 255;
  }
  const levels = [px];
  for (let s = size; s > 1; s >>= 1) {
    const src = levels[levels.length - 1], h = s >> 1, dst = new Uint8Array(h * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) for (let c = 0; c < 4; c++) {
      const a = (y * 2 * s + x * 2) * 4 + c;
      dst[(y * h + x) * 4 + c] = (src[a] + src[a + 4] + src[a + s * 4] + src[a + s * 4 + 4]) >> 2;
    }
    levels.push(dst);
  }
  return { size, levels };
}

// A walk cycle for the character mesh as per-vertex offsets (model units), one row per frame.
function makeVat(vertexCount: number): Float32Array {
  const data = new Float32Array(vertexCount * VAT_FRAMES * 4);
  const part = (v: number) => Math.floor(v / 77); // 0 body, 1 head, 2-3 arms, 4-5 legs (77 vertices per ellipsoid)
  for (let f = 0; f < VAT_FRAMES; f++) {
    const t = f / VAT_FRAMES * Math.PI * 2;
    for (let v = 0; v < vertexCount; v++) {
      const p = part(v), o = (f * vertexCount + v) * 4;
      const side = p === 2 || p === 5 ? 1 : -1;
      if (p >= 2) { data[o] = Math.sin(t) * side * (p >= 4 ? 0.45 : 0.35); data[o + 2] = p >= 4 ? Math.max(0, Math.cos(t) * side) * 0.15 : 0; }
      else { data[o + 2] = Math.abs(Math.sin(t)) * 0.08; }
    }
  }
  return data;
}

// Static instances shared by every renderer: walls on blocked cells (play plane), trees on some of
// them (foreground), grass tufts (background). Rows of [x, y, facing, kind, radius].
export function buildStatics(blocked: Uint8Array): number[] {
  const st: number[] = [];
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < blocked.length; i++) if (blocked[i]) {
    const x = (i % 256) + 0.5, y = Math.floor(i / 256) + 0.5;
    st.push(x, y, 0, KIND_WALL, 1);
    if (rnd() < 0.25) st.push(x, y, rnd() * 6.28, KIND_TREE, 0.9 + rnd() * 0.5);
  }
  for (let i = 0; i < 12000; i++) { const x = 1 + rnd() * 254, y = 1 + rnd() * 254; if (!blocked[Math.floor(y) * 256 + Math.floor(x)]) st.push(x, y, rnd() * 6.28, KIND_GRASS, 0.6 + rnd() * 0.5); }
  return st;
}

export class WorldRenderer {
  readonly name: string;
  camera = new Camera();
  drawCalls = 0;
  visibleCount = 0;
  cullMs = 0;
  private device: GPUDevice;
  private gpuMode: boolean;
  private meshes: MeshSet;
  private vbuf: GPUBuffer; private ibuf: GPUBuffer;
  private frameBuf: GPUBuffer; private frameData = new ArrayBuffer(128); private frameF = new Float32Array(this.frameData); private frameU = new Uint32Array(this.frameData);
  private instanceBuf: GPUBuffer; private visibleBuf: GPUBuffer; private indirectBuf: GPUBuffer; private drawBuf: GPUBuffer; private kindBuf: GPUBuffer;
  private indirectTemplate: Uint32Array<ArrayBuffer>;
  private kindBase = new Uint32Array(KIND_COUNT + 1); private kindCap = new Uint32Array(KIND_COUNT + 1);
  private staticCount: number; private total: number; private n = 0;
  private staticXY: Float32Array; private staticKind: Uint8Array;
  private cpuVisible: Uint32Array<ArrayBuffer>; private cpuCount = new Uint32Array(KIND_COUNT + 1);
  private snapshot: ArrayBuffer | null = null;
  private worldView: GPUTextureView; private depthView: GPUTextureView;
  private worldPass: GPURenderPassDescriptor; private finalPass: GPURenderPassDescriptor;
  private finalColor: GPURenderPassColorAttachment = { view: null as any, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
  private computePassDesc: GPUComputePassDescriptor;
  private meshPipe!: GPURenderPipeline; private groundPipe!: GPURenderPipeline; private shadowPipe!: GPURenderPipeline;
  private finalPipe!: GPURenderPipeline; private uiPipe!: GPURenderPipeline; private cullPipe!: GPUComputePipeline;
  private frameBG!: GPUBindGroup; private drawBG!: GPUBindGroup; private cullBG!: GPUBindGroup; private finalBG!: GPUBindGroup;
  private bundle!: GPURenderBundle;
  private readback: GPUBuffer; private readbackBusy = false; private counts = new Uint32Array(KIND_COUNT + 1);
  private frameNo = 0;
  private partSum = new Float64Array(3); private partN = 0;
  private timer: GpuTimer;
  readonly internal: [number, number];

  static async create(mode: string, gpu: Gpu, timer: GpuTimer, maxEntities: number, blocked: Uint8Array, internalHeight: number) {
    const r = new WorldRenderer(mode, gpu, timer, maxEntities, blocked, internalHeight);
    await r.build(gpu);
    return r;
  }

  private constructor(mode: string, gpu: Gpu, timer: GpuTimer, maxEntities: number, blocked: Uint8Array, internalHeight: number) {
    const device = this.device = gpu.device;
    this.timer = timer;
    this.gpuMode = mode === 'gpu';
    this.name = this.gpuMode ? 'gpu-driven' : 'plain';
    this.meshes = buildMeshes();
    this.vbuf = device.createBuffer({ size: this.meshes.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vbuf, 0, this.meshes.vertices);
    this.ibuf = device.createBuffer({ size: this.meshes.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.ibuf, 0, this.meshes.indices as Uint16Array<ArrayBuffer>);

    const st = buildStatics(blocked);
    const S = this.staticCount = st.length / 5;
    this.total = S + maxEntities;
    const sbuf = new ArrayBuffer(S * ENTRY_BYTES), sf = new Float32Array(sbuf), su = new Uint32Array(sbuf);
    this.staticXY = new Float32Array(S * 3); this.staticKind = new Uint8Array(S);
    const staticPerKind = new Uint32Array(KIND_COUNT);
    for (let i = 0; i < S; i++) {
      const o = i * 8, x = st[i * 5], y = st[i * 5 + 1];
      sf[o] = x; sf[o + 1] = y; sf[o + 2] = x; sf[o + 3] = y; sf[o + 4] = st[i * 5 + 2]; sf[o + 5] = st[i * 5 + 2]; su[o + 6] = st[i * 5 + 3]; sf[o + 7] = st[i * 5 + 4];
      this.staticXY[i * 3] = x; this.staticXY[i * 3 + 1] = y; this.staticXY[i * 3 + 2] = st[i * 5 + 4]; this.staticKind[i] = st[i * 5 + 3]; staticPerKind[st[i * 5 + 3]]++;
    }
    // Every instance of every kind lives in one large buffer: static instances first, then the sim's.
    this.instanceBuf = device.createBuffer({ size: this.total * ENTRY_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.instanceBuf, 0, sbuf);

    // Fixed visible-list range per kind, sized for the most instances the kind can have.
    let base = 0;
    for (let k = 0; k <= KIND_COUNT; k++) {
      const cap = k === SHADOW ? maxEntities : k < 16 ? Math.ceil(maxEntities / 16) + 1 : k === 16 ? 1 : staticPerKind[k];
      this.kindBase[k] = base; this.kindCap[k] = cap; base += cap;
    }
    this.cpuVisible = new Uint32Array(base);
    this.visibleBuf = device.createBuffer({ size: base * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const kinds = new Uint32Array((KIND_COUNT + 1) * 4);
    for (let k = 0; k <= KIND_COUNT; k++) { kinds[k * 4] = this.kindBase[k]; kinds[k * 4 + 1] = this.kindCap[k]; }
    this.kindBuf = device.createBuffer({ size: kinds.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.kindBuf, 0, kinds);

    // Indirect draw arguments. Indexed draws: indexCount, instanceCount, firstIndex, baseVertex, firstInstance (always 0).
    const ind = this.indirectTemplate = new Uint32Array((KIND_COUNT + 1) * 5);
    for (let k = 0; k < KIND_COUNT; k++) { const m = this.meshes.ranges[k]; ind[k * 5] = m.indexCount; ind[k * 5 + 2] = m.firstIndex; ind[k * 5 + 3] = m.baseVertex; }
    ind[SHADOW * 5] = 6; // non-indexed: vertexCount, instanceCount, firstVertex, firstInstance
    this.indirectBuf = device.createBuffer({ size: ind.byteLength, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.readback = device.createBuffer({ size: ind.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const draws = new Uint32Array((KIND_COUNT + 1) * DRAW_STRIDE / 4);
    for (let k = 0; k <= KIND_COUNT; k++) { const o = k * DRAW_STRIDE / 4; draws[o] = this.kindBase[k]; draws[o + 1] = k === VAT_KIND ? 1 : 0; draws[o + 2] = k < KIND_COUNT ? this.meshes.ranges[k].baseVertex : 0; }
    this.drawBuf = device.createBuffer({ size: draws.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.drawBuf, 0, draws);
    this.frameBuf = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const ih = internalHeight, iw = Math.round(ih * 16 / 9);
    this.internal = [iw, ih];
    const worldTex = device.createTexture({ size: [iw, ih], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.worldView = worldTex.createView();
    this.depthView = device.createTexture({ size: [iw, ih], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView();
    this.worldPass = {
      colorAttachments: [{ view: this.worldView, clearValue: { r: 0.1, g: 0.14, b: 0.1, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: timer.writes(0),
    };
    this.finalPass = { colorAttachments: [this.finalColor], timestampWrites: timer.writes(1) };
    const cw = timer.writes(2);
    this.computePassDesc = cw ? { timestampWrites: cw as unknown as GPUComputePassTimestampWrites } : {};
  }

  private async build(gpu: Gpu) {
    const d = this.device;
    const atlasData = makeAtlas();
    const atlas = d.createTexture({ size: [atlasData.size, atlasData.size], format: 'rgba8unorm', mipLevelCount: atlasData.levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    atlasData.levels.forEach((px, level) => { const s = atlasData.size >> level; d.queue.writeTexture({ texture: atlas, mipLevel: level }, px as Uint8Array<ArrayBuffer>, { bytesPerRow: s * 4 }, [s, s]); });
    const vatVerts = this.meshes.ranges[VAT_KIND].vertexCount;
    const vat = d.createTexture({ size: [vatVerts, VAT_FRAMES], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: vat }, makeVat(vatVerts) as Float32Array<ArrayBuffer>, { bytesPerRow: vatVerts * 16 }, [vatVerts, VAT_FRAMES]);

    const frameLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 5, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
    ] });
    const drawLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }] });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [frameLayout, drawLayout] });
    const world = d.createShaderModule({ code: WORLD_WGSL });
    const final = d.createShaderModule({ code: FINAL_WGSL });
    const cull = d.createShaderModule({ code: CULL_WGSL });
    const target: GPUColorTargetState = { format: 'rgba8unorm' };
    const depth = (write: boolean): GPUDepthStencilState => ({ format: 'depth24plus', depthWriteEnabled: write, depthCompare: 'less' });
    const blend: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    // Every pipeline is created at load time, asynchronously, so no shader compiles mid-game.
    [this.meshPipe, this.groundPipe, this.shadowPipe, this.finalPipe, this.uiPipe, this.cullPipe] = await Promise.all([
      d.createRenderPipelineAsync({ layout, vertex: { module: world, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] }, fragment: { module: world, entryPoint: 'fs', targets: [target] }, primitive: { cullMode: 'back' }, depthStencil: depth(true) }),
      d.createRenderPipelineAsync({ layout, vertex: { module: world, entryPoint: 'groundVs' }, fragment: { module: world, entryPoint: 'groundFs', targets: [target] }, primitive: { topology: 'triangle-strip' }, depthStencil: depth(true) }),
      d.createRenderPipelineAsync({ layout, vertex: { module: world, entryPoint: 'shadowVs' }, fragment: { module: world, entryPoint: 'shadowFs', targets: [{ format: 'rgba8unorm', blend }] }, depthStencil: depth(false) }),
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: final, entryPoint: 'vs' }, fragment: { module: final, entryPoint: 'fs', targets: [{ format: gpu.format }] } }),
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: final, entryPoint: 'uiVs' }, fragment: { module: final, entryPoint: 'uiFs', targets: [{ format: gpu.format, blend }] } }),
      d.createComputePipelineAsync({ layout: 'auto', compute: { module: cull, entryPoint: 'cull' } }),
    ]);
    this.frameBG = d.createBindGroup({ layout: frameLayout, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: { buffer: this.instanceBuf } }, { binding: 2, resource: { buffer: this.visibleBuf } },
      { binding: 3, resource: atlas.createView() }, { binding: 4, resource: d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }) }, { binding: 5, resource: vat.createView() },
    ] });
    this.drawBG = d.createBindGroup({ layout: drawLayout, entries: [{ binding: 0, resource: { buffer: this.drawBuf, size: 16 } }] });
    this.cullBG = d.createBindGroup({ layout: this.cullPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: { buffer: this.instanceBuf } }, { binding: 2, resource: { buffer: this.visibleBuf } },
      { binding: 3, resource: { buffer: this.indirectBuf } }, { binding: 4, resource: { buffer: this.kindBuf } },
    ] });
    const post = new Float32Array([1 / this.internal[0], 1 / this.internal[1], 0.2, 0, 0.0, 0.0, 0.01, 0, 1.06, 1.03, 0.98, 0.95]);
    const postBuf = d.createBuffer({ size: post.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(postBuf, 0, post);
    this.finalBG = d.createBindGroup({ layout: this.finalPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.worldView }, { binding: 1, resource: d.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }, { binding: 2, resource: { buffer: postBuf } },
    ] });

    // The fixed list of indirect draws is recorded once and replayed every frame.
    const enc = d.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'], depthStencilFormat: 'depth24plus' });
    this.encodeWorld(enc, true);
    this.bundle = enc.finish();
  }

  // The world pass's draws. Used once to record the bundle (indirect) and every frame by the plain path (direct).
  private encodeWorld(pass: GPURenderPassEncoder | GPURenderBundleEncoder, indirect: boolean) {
    let draws = 0;
    pass.setBindGroup(0, this.frameBG);
    pass.setPipeline(this.meshPipe);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, 'uint16');
    for (const k of LAYER_ORDER) {
      if (!indirect && !this.cpuCount[k]) continue;
      pass.setBindGroup(1, this.drawBG, [k * DRAW_STRIDE]);
      if (indirect) pass.drawIndexedIndirect(this.indirectBuf, k * 20);
      else { const m = this.meshes.ranges[k]; pass.drawIndexed(m.indexCount, this.cpuCount[k], m.firstIndex, m.baseVertex, 0); }
      draws++;
    }
    pass.setPipeline(this.groundPipe);
    pass.setBindGroup(1, this.drawBG, [0]);
    pass.draw(4);
    pass.setPipeline(this.shadowPipe);
    pass.setBindGroup(1, this.drawBG, [SHADOW * DRAW_STRIDE]);
    if (indirect) pass.drawIndirect(this.indirectBuf, SHADOW * 20);
    else if (this.cpuCount[SHADOW]) pass.draw(6, this.cpuCount[SHADOW]);
    this.drawCalls = draws + 2 + 2; // + ground + shadows + upscale + UI
  }

  // Once per displayed snapshot: the sim's instance data is uploaded whole, with one writeBuffer.
  setSnapshot(buffer: ArrayBuffer) {
    this.snapshot = buffer;
    this.n = new Uint32Array(buffer, 0, 3)[2];
    this.device.queue.writeBuffer(this.instanceBuf, this.staticCount * ENTRY_BYTES, buffer, HEADER_BYTES, this.n * ENTRY_BYTES);
  }

  private cpuCull() {
    const cam = this.camera, { cpuVisible: vis, cpuCount: count, kindBase } = this;
    const x0 = cam.cx - cam.halfW, x1 = cam.cx + cam.halfW, y0 = cam.cy - cam.halfH, y1 = cam.cy + cam.halfH;
    count.fill(0);
    const S = this.staticCount, sxy = this.staticXY, sk = this.staticKind;
    for (let i = 0; i < S; i++) {
      const x = sxy[i * 3], y = sxy[i * 3 + 1], m = sxy[i * 3 + 2] * 6; // the same margin the compute pass uses
      if (x + m < x0 || x - m > x1 || y + m < y0 || y - m > y1) continue;
      const k = sk[i];
      vis[kindBase[k] + count[k]++] = i;
    }
    const f = new Float32Array(this.snapshot!, HEADER_BYTES, this.n * 8), u = new Uint32Array(this.snapshot!, HEADER_BYTES, this.n * 8);
    for (let i = 0; i < this.n; i++) {
      const o = i * 8, m = f[o + 7] * 6;
      const ax = f[o], ay = f[o + 1], bx = f[o + 2], by = f[o + 3];
      if ((ax > bx ? ax : bx) + m < x0 || (ax < bx ? ax : bx) - m > x1 || (ay > by ? ay : by) + m < y0 || (ay < by ? ay : by) - m > y1) continue;
      const k = u[o + 6];
      vis[kindBase[k] + count[k]++] = S + i;
      vis[kindBase[SHADOW] + count[SHADOW]++] = S + i;
    }
  }

  render(encoder: GPUCommandEncoder, target: GPUTexture, alpha: number, time: number, playerX: number, playerY: number): number {
    const cam = this.camera;
    cam.update(playerX, playerY, 16 / 9);
    const f = this.frameF, u = this.frameU;
    f.set(cam.viewProj, 0);
    // The sun's direction, colour and strength are uniforms, so a day/night cycle only changes these.
    f[16] = 0.35; f[17] = -0.45; f[18] = 0.82; f[19] = 0.38;
    f[20] = 1.0; f[21] = 0.96; f[22] = 0.88; f[23] = 0;
    f[24] = cam.cx; f[25] = cam.cy; f[26] = cam.halfW; f[27] = cam.halfH;
    f[28] = alpha; f[29] = time; u[30] = this.staticCount; u[31] = this.staticCount + this.n;
    this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);
    this.frameNo++;

    if (this.gpuMode) {
      this.device.queue.writeBuffer(this.indirectBuf, 0, this.indirectTemplate); // counts back to zero
      const c = encoder.beginComputePass(this.computePassDesc);
      c.setPipeline(this.cullPipe);
      c.setBindGroup(0, this.cullBG);
      c.dispatchWorkgroups(Math.ceil((this.staticCount + this.n) / 64));
      c.end();
      const pass = encoder.beginRenderPass(this.worldPass);
      pass.executeBundles([this.bundle]);
      pass.end();
      this.drawCalls = KIND_COUNT + 4;
      // Debug view of culled/drawn counts: read back a few frames later, never waiting on the GPU.
      if (!this.readbackBusy && this.frameNo % 30 === 0) {
        this.readbackBusy = true;
        encoder.copyBufferToBuffer(this.indirectBuf, 0, this.readback, 0, this.indirectTemplate.byteLength);
        this.device.queue.onSubmittedWorkDone().then(() => this.readback.mapAsync(GPUMapMode.READ)).then(() => {
          const r = new Uint32Array(this.readback.getMappedRange());
          let total = 0;
          for (let k = 0; k <= KIND_COUNT; k++) { this.counts[k] = r[k * 5 + 1]; if (k < KIND_COUNT) total += r[k * 5 + 1]; }
          this.visibleCount = total;
          this.readback.unmap(); this.readbackBusy = false;
        }).catch(() => {});
      }
    } else {
      const t0 = performance.now();
      this.cpuCull();
      this.cullMs = performance.now() - t0;
      this.device.queue.writeBuffer(this.visibleBuf, 0, this.cpuVisible);
      let total = 0;
      for (let k = 0; k <= KIND_COUNT; k++) { this.counts[k] = this.cpuCount[k]; if (k < KIND_COUNT) total += this.cpuCount[k]; }
      this.visibleCount = total;
      const pass = encoder.beginRenderPass(this.worldPass);
      this.encodeWorld(pass, false);
      pass.end();
    }

    this.finalColor.view = target.createView();
    const fp = encoder.beginRenderPass(this.finalPass);
    fp.setPipeline(this.finalPipe);
    fp.setBindGroup(0, this.finalBG);
    fp.draw(3);
    fp.setPipeline(this.uiPipe);
    fp.draw(6, 3);
    fp.end();

    const slots = this.gpuMode ? 3 : 2;
    if (this.timer.enabled && Number.isFinite(this.timer.ms[0])) { for (let i = 0; i < slots; i++) this.partSum[i] += this.timer.ms[i] || 0; this.partN++; }
    return slots;
  }

  overlay(): string[] {
    const c = this.counts;
    return [
      `draw   visible ${this.visibleCount} of ${this.staticCount + this.n}  shadows ${c[SHADOW]}  internal ${this.internal[0]}x${this.internal[1]}`,
      `       kinds ${Array.from(c.subarray(0, KIND_COUNT)).join(' ')}`,
    ];
  }
  info() { return { mode: this.name, internal: this.internal, staticInstances: this.staticCount, dynamic: this.n, visible: this.visibleCount, shadows: this.counts[SHADOW], perKind: Array.from(this.counts), triangles: this.meshes.triangles, cpuCullMs: this.cullMs }; }
  gpuParts() { const n = Math.max(1, this.partN); return { worldMs: this.partSum[0] / n, upscaleAndUiMs: this.partSum[1] / n, cullComputeMs: this.gpuMode ? this.partSum[2] / n : 0, samples: this.partN }; }
}
