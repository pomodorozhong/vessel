// Stage 5 loader page: starts everything in parallel (see the inline script in stage5.html for the WASM
// compile and the asset downloads), unpacks with DecompressionStream and the meshopt decoder, uploads
// meshes and BC7 textures (RGBA8 fallback without texture-compression-bc), draws the first frame and records
// when it was presented, with a breakdown.
import { MeshoptDecoder } from 'meshoptimizer/decoder';

declare const __BUILD_TAG__: string;
const w = window as any;
const S = w.__S5 as {
  base: string; tag: string; buildId: string; wasm: { plain: string; gz: string };
  firstChunk: string[]; padFile: string; models: { name: string; file: string; texture: string }[];
  textures: { name: string; size: number; rgba8: string; bc7: Record<string, string> }[];
  lazyFiles: string[]; shippedLambda: number;
};
const E = w.__s5early as { marks: Record<string, number>; files: Record<string, ArrayBuffer>; wasm: Promise<WebAssembly.Module>; assets: Promise<unknown>; list: string[] };
const q = new URLSearchParams(location.search);
const marks: Record<string, number> = E.marks;
marks.jsStart = performance.now();
const errors: string[] = [];
const log: { t: number; kind: string; url: string; ok: boolean; status?: number; note?: string }[] = [];
w.__s5log = log;
const info = document.getElementById('info')!;
const canvas = document.getElementById('game') as HTMLCanvasElement;

// ---------- save-and-reload prompt ----------
let saved = 0;
function save() { saved++; w.__s5saved = saved; } // stub: the real game writes its save here
let prompted = false;
function onMissingFile(url: string, why: string) {
  log.push({ t: performance.now(), kind: 'missing', url, ok: false, note: why });
  if (prompted) return;
  prompted = true;
  save();
  document.getElementById('reload')!.style.display = 'block';
  document.getElementById('reload-btn')!.onclick = () => location.reload();
  w.__s5prompt = { t: performance.now(), url };
}
window.addEventListener('vite:preloadError', (e) => { onMissingFile('(vite preload)', String((e as any).payload?.message ?? 'preload error')); });

// ---------- helpers ----------
async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
type Mat = Float32Array;
const mul = (a: Mat, b: Mat): Mat => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const persp = (fov: number, asp: number, n: number, f: number): Mat => { const t = 1 / Math.tan(fov / 2); const m = new Float32Array(16); m[0] = t / asp; m[5] = t; m[10] = f / (n - f); m[11] = -1; m[14] = n * f / (n - f); return m; };
const trans = (x: number, y: number, z: number): Mat => { const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); return m; };
const rotY = (a: number): Mat => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
const scaleM = (k: number): Mat => new Float32Array([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1]);

// ---------- sim worker ----------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const workerReady = new Promise<number>((ok) => { worker.onmessage = (e) => { if (e.data.type === 'ready') { marks.workerReady = performance.now(); ok(e.data.stepMs); } }; });
E.wasm.then((m) => worker.postMessage({ type: 'init', module: m })).catch((e) => errors.push('wasm: ' + e));

// ---------- GPU ----------
async function initGpu() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const bc = adapter.features.has('texture-compression-bc') && q.get('bc') !== '0';
  const device = await adapter.requestDevice({ requiredFeatures: bc ? ['texture-compression-bc'] : [] });
  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  marks.gpuReady = performance.now();
  return { adapter, device, context, format, bc };
}

// ---------- decode ----------
interface Mesh { vb: Uint8Array; ib: Uint8Array; n: number; ni: number; center: number[]; half: number[] }
async function decodeMesh(gz: ArrayBuffer): Promise<Mesh> {
  const buf = await gunzip(gz);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(4, true), ni = dv.getUint32(8, true), vlen = dv.getUint32(16, true), ilen = dv.getUint32(20, true);
  const center = [0, 1, 2].map((k) => dv.getFloat32(24 + k * 4, true)), half = [0, 1, 2].map((k) => dv.getFloat32(36 + k * 4, true));
  const vb = new Uint8Array(n * 16), ib = new Uint8Array(ni * 2);
  MeshoptDecoder.decodeVertexBuffer(vb, n, 16, buf.subarray(48, 48 + vlen));
  MeshoptDecoder.decodeIndexBuffer(ib, ni, 2, buf.subarray(48 + vlen, 48 + vlen + ilen));
  return { vb, ib, n, ni, center, half };
}
interface Tex { bc: boolean; w: number; h: number; levels: { off: number; len: number; w: number; h: number }[]; data: Uint8Array }
async function decodeTex(gz: ArrayBuffer, bc: boolean): Promise<Tex> {
  const buf = await gunzip(gz);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (bc) { // KTX2, BC7, no supercompression
    const W = dv.getUint32(20, true), H = dv.getUint32(24, true), L = dv.getUint32(40, true);
    const levels = [];
    for (let i = 0; i < L; i++) levels.push({ off: Number(dv.getBigUint64(80 + i * 24, true)), len: Number(dv.getBigUint64(88 + i * 24, true)), w: Math.max(1, W >> i), h: Math.max(1, H >> i) });
    return { bc, w: W, h: H, levels, data: buf };
  }
  const W = dv.getUint32(0, true), H = dv.getUint32(4, true), L = dv.getUint32(8, true);
  const levels = []; let off = 12;
  for (let i = 0; i < L; i++) { const lw = Math.max(1, W >> i), lh = Math.max(1, H >> i); levels.push({ off, len: lw * lh * 4, w: lw, h: lh }); off += lw * lh * 4; }
  return { bc, w: W, h: H, levels, data: buf };
}

const SHADER = /* wgsl */`
struct U { mvp: mat4x4<f32>, model: mat4x4<f32>, center: vec4<f32>, half: vec4<f32>, misc: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
struct VIn { @location(0) p: vec4<f32>, @location(1) uv: vec2<f32>, @location(2) n: vec4<f32> };
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) n: vec3<f32>, @location(2) ao: f32 };
@vertex fn vs(i: VIn) -> VOut {
  var o: VOut;
  let lp = u.center.xyz + i.p.xyz * u.half.xyz;
  o.pos = u.mvp * vec4<f32>(lp, 1.0);
  o.uv = i.uv * u.misc.x;
  o.n = (u.model * vec4<f32>(i.n.xyz, 0.0)).xyz;
  o.ao = i.n.w;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, i.uv).rgb;
  let l = max(dot(normalize(i.n), normalize(vec3<f32>(0.5, 0.9, 0.3))), 0.0) * 0.75 + 0.25;
  return vec4<f32>(pow(c * l * i.ao, vec3<f32>(1.0 / 2.2)), 1.0);
}`;

async function main() {
  const gpuP = initGpu();
  gpuP.catch(() => {});
  await MeshoptDecoder.ready;
  const gpu = await gpuP;
  const { device } = gpu;
  const files = (await E.assets.then(() => E.files)) as Record<string, ArrayBuffer>;
  // Textures: BC7 files are already in the first chunk. Without BC support, fetch the RGBA8 fallbacks instead.
  if (!gpu.bc) {
    const t0 = performance.now();
    await Promise.all(S.textures.filter((t) => ['atlas2048', 'bark1024', 'rock1024', 'ground1024'].includes(t.name)).map(async (t) => {
      files[t.rgba8] = await (await fetch(S.base + t.rgba8)).arrayBuffer();
    }));
    marks.fallbackDownloaded = performance.now();
    marks.fallbackDownloadMs = marks.fallbackDownloaded - t0;
  }

  // Decode
  const td0 = performance.now();
  const meshes: Record<string, Mesh> = {}, texs: Record<string, Tex> = {};
  let decodeMeshMs = 0, decodeTexMs = 0;
  for (const m of S.models) { const t = performance.now(); meshes[m.name] = await decodeMesh(files[m.file]); decodeMeshMs += performance.now() - t; }
  for (const t of S.textures) {
    const f = gpu.bc ? t.bc7['l' + S.shippedLambda] : t.rgba8;
    if (!files[f]) continue;
    const t1 = performance.now(); texs[t.name] = await decodeTex(files[f], gpu.bc); decodeTexMs += performance.now() - t1;
  }
  marks.decoded = performance.now();
  const decodeMs = marks.decoded - td0;

  // Upload
  const tu0 = performance.now();
  const mkBuf = (data: Uint8Array, usage: number) => { const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, data as BufferSource, 0, data.byteLength & ~3 ? data.byteLength : data.byteLength); return b; };
  const mkTex = (t: Tex) => {
    const tex = device.createTexture({ size: [t.w, t.h], mipLevelCount: t.levels.length, format: t.bc ? 'bc7-rgba-unorm-srgb' : 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    t.levels.forEach((l, i) => {
      const data = t.data.subarray(l.off, l.off + l.len);
      if (t.bc) { const bw = Math.ceil(l.w / 4), bh = Math.ceil(l.h / 4); device.queue.writeTexture({ texture: tex, mipLevel: i }, data as BufferSource, { bytesPerRow: bw * 16, rowsPerImage: bh }, [bw * 4, bh * 4]); }
      else device.queue.writeTexture({ texture: tex, mipLevel: i }, data as BufferSource, { bytesPerRow: l.w * 4, rowsPerImage: l.h }, [l.w, l.h]);
    });
    return tex;
  };
  const pad4 = (b: Uint8Array) => { if (b.length % 4 === 0) return b; const o = new Uint8Array((b.length + 3) & ~3); o.set(b); return o; };
  // ground quad in the same packed vertex format
  const gq = new Uint8Array(4 * 16), gdv = new DataView(gq.buffer);
  [[-1, 0], [1, 0], [-1, 1], [1, 1]].forEach(([x, z], i) => { const o = i * 16; gdv.setInt16(o, x * 32767, true); gdv.setInt16(o + 2, 0, true); gdv.setInt16(o + 4, (z * 2 - 1) * 32767, true); gdv.setUint16(o + 8, x < 0 ? 0 : 65535, true); gdv.setUint16(o + 10, z ? 65535 : 0, true); gdv.setInt8(o + 13, 127); gdv.setInt8(o + 15, 127); });
  const gi = new Uint8Array(new Uint16Array([0, 2, 1, 1, 2, 3]).buffer);
  meshes.ground = { vb: gq, ib: gi, n: 4, ni: 6, center: [0, 0, 0], half: [8, 1, 8] };
  const draws = [
    { mesh: 'ground', tex: 'ground1024', uvScale: 8, pos: [0, 0, 0], scale: 1, spin: 0 },
    { mesh: 'character', tex: 'atlas2048', uvScale: 1, pos: [-1.6, 0, 0], scale: 1, spin: 0.6 },
    { mesh: 'tree', tex: 'bark1024', uvScale: 3, pos: [1.5, 0, -1], scale: 0.9, spin: 0.2 },
    { mesh: 'rock', tex: 'rock1024', uvScale: 2, pos: [0.1, 0, 1.4], scale: 1, spin: 0.3 },
  ];
  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'snorm16x4' }, { shaderLocation: 1, offset: 8, format: 'unorm16x2' }, { shaderLocation: 2, offset: 12, format: 'snorm8x4' }] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: gpu.format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 4 });
  const gpuTex: Record<string, GPUTexture> = {};
  for (const k of Object.keys(texs)) gpuTex[k] = mkTex(texs[k]);
  const items = draws.map((d) => {
    const m = meshes[d.mesh];
    const ub = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return {
      d, m, ub, vb: mkBuf(pad4(m.vb), GPUBufferUsage.VERTEX), ib: mkBuf(pad4(m.ib), GPUBufferUsage.INDEX),
      bg: device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: sampler }, { binding: 2, resource: gpuTex[d.tex].createView() }] }),
    };
  });
  const depth = device.createTexture({ size: [canvas.width, canvas.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  marks.uploaded = performance.now();
  const uploadMs = marks.uploaded - tu0;

  const proj = persp(0.9, canvas.width / canvas.height, 0.1, 50);
  const view = mul(trans(0, -1.3, -6.5), rotY(0));
  const drawFrame = (t: number) => {
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: gpu.context.getCurrentTexture().createView(), clearValue: { r: 0.45, g: 0.6, b: 0.8, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(pipeline);
    for (const it of items) {
      const model = mul(mul(trans(it.d.pos[0], it.d.pos[1], it.d.pos[2]), rotY(it.d.spin + t * 0.0004 * (it.d.mesh === 'ground' ? 0 : 1))), scaleM(it.d.scale));
      const mvp = mul(mul(proj, view), model);
      const f = new Float32Array(64);
      f.set(mvp, 0); f.set(model, 16); f.set([...it.m.center, 0], 32); f.set([...it.m.half, 0], 36); f.set([it.d.uvScale, 0, 0, 0], 40);
      device.queue.writeBuffer(it.ub, 0, f);
      pass.setBindGroup(0, it.bg); pass.setVertexBuffer(0, it.vb); pass.setIndexBuffer(it.ib, 'uint16'); pass.drawIndexed(it.m.ni);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
  };
  drawFrame(0);
  marks.submitted = performance.now();
  await device.queue.onSubmittedWorkDone();
  marks.gpuDone = performance.now();
  await new Promise<void>((ok) => requestAnimationFrame(() => { marks.firstFrame = performance.now(); ok(); }));

  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  const stepMs = await Promise.race([workerReady, new Promise<number>((ok) => setTimeout(() => ok(NaN), 2000))]);
  const res = performance.getEntriesByType('resource').map((r) => { const e = r as PerformanceResourceTiming; return { name: e.name, start: e.startTime, end: e.responseEnd, transfer: e.transferSize, body: e.encodedBodySize, decoded: e.decodedBodySize, type: e.initiatorType }; });
  const result = {
    build: __BUILD_TAG__, usedBc7: gpu.bc, url: location.href, swControlled: !!navigator.serviceWorker?.controller,
    firstFrameMs: marks.firstFrame,
    breakdown: {
      htmlResponseEnd: nav.responseEnd, htmlDomInteractive: nav.domInteractive,
      jsStart: marks.jsStart, earlyScript: marks.earlyScript,
      wasmDownloaded: marks.wasmDownloaded, wasmCompiled: marks.wasmCompiled, workerReady: marks.workerReady, gpuReady: marks.gpuReady,
      assetsDownloaded: marks.assetsDownloaded, decodeMs, decodeMeshMs, decodeTexMs, uploadMs, submitted: marks.submitted, gpuDone: marks.gpuDone,
    },
    firstChunkFiles: E.list.length,
    resources: res, nav: { responseEnd: nav.responseEnd, transferSize: nav.transferSize, type: nav.type },
    workerStepMs: stepMs, errors,
  };
  w.__s5result = result;
  info.textContent = `first frame ${marks.firstFrame.toFixed(0)} ms  build ${__BUILD_TAG__}  ${gpu.bc ? 'BC7' : 'RGBA8 fallback'}  sw ${result.swControlled ? 'yes' : 'no'}\nhtml ${nav.responseEnd.toFixed(0)}  js ${marks.jsStart.toFixed(0)}  wasm ${(marks.wasmCompiled ?? NaN).toFixed(0)}  assets ${(marks.assetsDownloaded ?? NaN).toFixed(0)}  decode ${decodeMs.toFixed(0)}  upload ${uploadMs.toFixed(0)}`;

  // Keep drawing so the window is not frozen on the first frame.
  const loop = (t: number) => { drawFrame(t); requestAnimationFrame(loop); };
  if (q.get('loop') !== '0') requestAnimationFrame(loop);

  afterFirstFrame();
}

// ---------- after the first frame: service worker, version check, lazy loading ----------
async function afterFirstFrame() {
  if (q.get('sw') !== '0' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register(S.base + 'sw.js', { scope: S.base });
      w.__s5sw = { registered: true, scope: reg.scope };
      // Browsers only check for a new sw.js on navigation if the last check is over 24 hours old, so ask explicitly:
      // a conditional request for sw.js, which installs the new worker (skipWaiting then activates it at once).
      reg.update().catch((e) => errors.push('sw update: ' + e));
      marks.swRegistered = performance.now();
    } catch (e) { errors.push('sw: ' + e); }
  }
  try {
    const r = await fetch(S.base + 'builds.json', { cache: 'no-store' });
    const b = await r.json();
    w.__s5builds = b;
    log.push({ t: performance.now(), kind: 'builds.json', url: 'builds.json', ok: r.ok, status: r.status, note: `current ${b.current.id}` });
  } catch (e) { errors.push('builds.json: ' + e); }

  // Lazy loading over time: a code chunk and some assets. A 404 means the page's build is two deploys old.
  const manual = q.get('lazy') === 'manual'; // tests drive the lazy loads one at a time with window.__s5next()
  const every = manual ? 0 : Number(q.get('lazy') ?? 400);
  if (!every && !manual) return;
  const items: (() => Promise<void>)[] = [
    async () => { try { const m = await import('./lazy'); log.push({ t: performance.now(), kind: 'chunk', url: 'lazy.ts', ok: true, note: m.lazyHello() }); } catch (e) { onMissingFile('(lazy chunk)', String(e)); } },
    ...S.lazyFiles.map((f) => async () => {
      try {
        const r = await fetch(S.base + f);
        log.push({ t: performance.now(), kind: 'asset', url: f, ok: r.ok, status: r.status });
        if (r.status === 404) onMissingFile(f, 'HTTP 404'); else if (r.ok) await r.arrayBuffer();
      } catch (e) { onMissingFile(f, String(e)); }
    }),
  ];
  let i = 0;
  const tick = async () => { if (i >= items.length) { w.__s5lazyDone = true; return; } await items[i++](); setTimeout(tick, every); };
  w.__s5lazyCount = items.length;
  if (manual) { w.__s5next = async () => { if (i < items.length) await items[i++](); return i; }; w.__s5manualReady = true; return; }
  setTimeout(tick, every);
}

main().catch((e) => { errors.push(String(e)); w.__s5error = String(e); info.textContent = 'error: ' + e; });
