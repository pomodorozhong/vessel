// Stage 2 renderer: simple instanced drawing of the sim's entities, one mesh per kind, no culling.
// The vertex shader interpolates inside one snapshot; the CPU never loops over entities per frame
// (it buckets entity indices by kind once per snapshot).
import type { Gpu } from './gpu';
import { GpuTimer } from './gpu';
import { ENTRY_BYTES, HEADER_BYTES } from './protocol';
import { DYNAMIC_KINDS, KIND_WALL, POS_SCALE, VERTEX_LAYOUT, buildMeshes } from './meshes';
import type { MeshSet } from './meshes';
import { Camera } from './camera';

const WGSL = /* wgsl */`
struct Frame { viewProj: mat4x4f, sun: vec4f, alpha: f32, time: f32, pad0: f32, pad1: f32 }
struct Entry { p0: vec2f, p1: vec2f, f0: f32, f1: f32, kind: u32, radius: f32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> entries: array<Entry>;
@group(1) @binding(1) var<storage, read> order: array<u32>;

struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec3f }

fn kindColor(kind: u32) -> vec3f {
  if (kind == 16u) { return vec3f(0.95, 0.95, 1.0); }
  if (kind == 17u) { return vec3f(0.42, 0.40, 0.38); }
  let h = f32(kind) / 16.0 * 6.2831853;
  return 0.55 + 0.4 * vec3f(cos(h), cos(h + 2.094), cos(h + 4.188));
}

@vertex fn vs(@location(0) position: vec4f, @location(1) normal: vec4f, @builtin(instance_index) inst: u32) -> VOut {
  let e = entries[order[inst]];
  let p = mix(e.p0, e.p1, frame.alpha);
  var df = e.f1 - e.f0;                       // turn the short way round
  df = df - 6.2831853 * round(df / 6.2831853);
  let f = e.f0 + df * frame.alpha;
  let c = cos(f); let s = sin(f);
  let local = position.xyz * ${POS_SCALE}.0 * e.radius;
  let world = vec3f(p.x + local.x * c - local.y * s, p.y + local.x * s + local.y * c, local.z);
  let n = vec3f(normal.x * c - normal.y * s, normal.x * s + normal.y * c, normal.z);
  var out: VOut;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  let light = 0.35 + 0.65 * max(0.0, dot(normalize(n), frame.sun.xyz));
  out.color = kindColor(e.kind) * light * position.w;
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return vec4f(in.color, 1.0); }
`;

export class SimpleRenderer {
  readonly name = 'simple';
  camera = new Camera();
  drawCalls = 0;
  private device: GPUDevice;
  private pipeline!: GPURenderPipeline;
  private frameBuf: GPUBuffer; private frameData = new Float32Array(24);
  private frameBG!: GPUBindGroup; private dynBG!: GPUBindGroup; private staticBG!: GPUBindGroup;
  private entryBuf: GPUBuffer; private orderBuf: GPUBuffer; private order: Uint32Array;
  private vbuf: GPUBuffer; private ibuf: GPUBuffer; private meshes: MeshSet;
  private depth: GPUTexture; private depthView: GPUTextureView;
  private counts = new Uint32Array(DYNAMIC_KINDS); private bases = new Uint32Array(DYNAMIC_KINDS + 1); private cursor = new Uint32Array(DYNAMIC_KINDS);
  private staticCount = 0; private n = 0;
  private passDesc: GPURenderPassDescriptor;
  private color: GPURenderPassColorAttachment = { view: null as any, clearValue: { r: 0.16, g: 0.2, b: 0.14, a: 1 }, loadOp: 'clear', storeOp: 'store' };

  static async create(gpu: Gpu, timer: GpuTimer, maxEntities: number, blocked: Uint8Array, canvas: HTMLCanvasElement) {
    const r = new SimpleRenderer(gpu, timer, maxEntities, blocked, canvas);
    const module = gpu.device.createShaderModule({ code: WGSL });
    r.pipeline = await gpu.device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: gpu.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    r.finish();
    return r;
  }

  private staticEntries: GPUBuffer; private staticOrder: GPUBuffer;

  private constructor(gpu: Gpu, timer: GpuTimer, maxEntities: number, blocked: Uint8Array, canvas: HTMLCanvasElement) {
    const device = this.device = gpu.device;
    this.meshes = buildMeshes();
    this.vbuf = device.createBuffer({ size: this.meshes.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vbuf, 0, this.meshes.vertices);
    this.ibuf = device.createBuffer({ size: this.meshes.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.ibuf, 0, this.meshes.indices);
    this.frameBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.entryBuf = device.createBuffer({ size: Math.max(32, maxEntities * ENTRY_BYTES), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.order = new Uint32Array(maxEntities);
    this.orderBuf = device.createBuffer({ size: Math.max(4, maxEntities * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // Static obstacles as instances in the same entry format (start == end).
    let walls = 0;
    for (let i = 0; i < blocked.length; i++) walls += blocked[i];
    const st = new ArrayBuffer(walls * ENTRY_BYTES), sf = new Float32Array(st), su = new Uint32Array(st);
    let w = 0;
    for (let i = 0; i < blocked.length; i++) if (blocked[i]) {
      const x = (i % 256) + 0.5, y = Math.floor(i / 256) + 0.5, o = w * 8;
      sf[o] = x; sf[o + 1] = y; sf[o + 2] = x; sf[o + 3] = y; su[o + 6] = KIND_WALL; sf[o + 7] = 1; w++;
    }
    this.staticCount = walls;
    this.staticEntries = device.createBuffer({ size: st.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.staticEntries, 0, st);
    this.staticOrder = device.createBuffer({ size: walls * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.staticOrder, 0, Uint32Array.from({ length: walls }, (_, i) => i));
    this.depth = device.createTexture({ size: [canvas.width, canvas.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depthView = this.depth.createView();
    this.passDesc = { colorAttachments: [this.color], depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' }, timestampWrites: timer.writes(0) };
  }

  private finish() {
    const d = this.device;
    this.frameBG = d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] });
    const l1 = this.pipeline.getBindGroupLayout(1);
    this.dynBG = d.createBindGroup({ layout: l1, entries: [{ binding: 0, resource: { buffer: this.entryBuf } }, { binding: 1, resource: { buffer: this.orderBuf } }] });
    this.staticBG = d.createBindGroup({ layout: l1, entries: [{ binding: 0, resource: { buffer: this.staticEntries } }, { binding: 1, resource: { buffer: this.staticOrder } }] });
  }

  // Called once per displayed snapshot: one upload of the entries, plus the per-kind order.
  setSnapshot(buffer: ArrayBuffer) {
    const n = this.n = new Uint32Array(buffer, 0, 3)[2];
    const u = new Uint32Array(buffer, HEADER_BYTES, n * 8);
    const { counts, bases, cursor, order } = this;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[u[i * 8 + 6]]++;
    bases[0] = 0;
    for (let k = 0; k < DYNAMIC_KINDS; k++) { bases[k + 1] = bases[k] + counts[k]; cursor[k] = bases[k]; }
    for (let i = 0; i < n; i++) order[cursor[u[i * 8 + 6]]++] = i;
    this.device.queue.writeBuffer(this.entryBuf, 0, buffer, HEADER_BYTES, n * ENTRY_BYTES);
    this.device.queue.writeBuffer(this.orderBuf, 0, order, 0, n);
  }

  render(encoder: GPUCommandEncoder, target: GPUTexture, alpha: number, time: number, playerX: number, playerY: number) {
    this.camera.update(playerX, playerY, target.width / target.height);
    const f = this.frameData;
    f.set(this.camera.viewProj, 0);
    f[16] = 0.35; f[17] = -0.45; f[18] = 0.82; f[19] = 0; f[20] = alpha; f[21] = time;
    this.device.queue.writeBuffer(this.frameBuf, 0, f);
    this.color.view = target.createView();
    const pass = encoder.beginRenderPass(this.passDesc);
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, 'uint16');
    pass.setBindGroup(0, this.frameBG);
    pass.setBindGroup(1, this.dynBG);
    let draws = 0;
    for (let k = 0; k < DYNAMIC_KINDS; k++) {
      if (!this.counts[k]) continue;
      const m = this.meshes.ranges[k];
      pass.drawIndexed(m.indexCount, this.counts[k], m.firstIndex, m.baseVertex, this.bases[k]);
      draws++;
    }
    pass.setBindGroup(1, this.staticBG);
    const m = this.meshes.ranges[KIND_WALL];
    pass.drawIndexed(m.indexCount, this.staticCount, m.firstIndex, m.baseVertex, 0);
    pass.end();
    this.drawCalls = draws + 1;
    return 1; // timestamp slots used
  }
}
