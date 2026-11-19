import simdUrl from './wasm/sim-simd.wasm?url';
import nosimdUrl from './wasm/sim-nosimd.wasm?url';
import { params } from './params';
import { GpuTimer, GpuUnavailable, initGpu, showUnsupported } from './gpu';
import type { Gpu } from './gpu';
import { gamepadInfo, installInput, pollInput } from './input';
import { Overlay, Stat, fmt } from './overlay';
import { HEADER_BYTES, snapshotBytes, wallNow } from './protocol';
import type { FromWorker, ToWorker } from './protocol';

// Start the WASM download and compile first, in parallel with everything else.
// The compiled module is posted to the worker (a page's preloads are not shared with workers).
const wasmUrl = params.sim === 'wasm-nosimd' ? nosimdUrl : simdUrl;
const wasmModule = WebAssembly.compileStreaming(fetch(wasmUrl));
wasmModule.catch(() => {});

const canvas = document.getElementById('game') as HTMLCanvasElement;
const POOL = 4;

const frameStat = new Stat(), cpuStat = new Stat(), stepStat = new Stat(), gpuStat = new Stat();
let queue: ArrayBuffer[] = [];
let workerSkipped = 0, mainDropped = 0, lastTick = 0, deviceLosses = 0;
let gpu: Gpu | null = null;
let timer: GpuTimer | null = null;
let worker: Worker | null = null;

function onSnapshot(buffer: ArrayBuffer) {
  const dv = new DataView(buffer);
  stepStat.push(dv.getFloat32(16, true));
  lastTick = dv.getUint32(4, true);
  queue.push(buffer);
}

function frame(encoder: GPUCommandEncoder, view: GPUTextureView) {
  // Stage 0: keep only the newest snapshot, hand the rest back to the worker's pool.
  while (queue.length > 1) { worker!.postMessage({ type: 'return', buffer: queue[0] } satisfies ToWorker, [queue.shift()!]); mainDropped++; }
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, clearValue: { r: 0.05, g: 0.07, b: 0.1, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    timestampWrites: timer!.writes(0),
  });
  pass.end();
}

async function startGpu() {
  gpu = await initGpu(canvas);
  timer = new GpuTimer(gpu.device, gpu.features.timestamp);
  (window as any).__gpu = { info: gpu.info, features: gpu.features, all: [...gpu.adapter.features] };
  gpu.device.lost.then(async (info) => {
    gpu = null;
    if (info.reason === 'destroyed') return; // destroyed on purpose
    deviceLosses++;
    // An adapter can create only one device, so recovery starts from a new adapter.
    try { await startGpu(); } catch (e) { showUnsupported(`The GPU device was lost and did not come back (${(e as Error).message}).`); }
  });
}

async function startSim() {
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'snapshot') onSnapshot(m.buffer);
    else if (m.type === 'stats') workerSkipped = m.skipped;
  };
  const pool = Array.from({ length: POOL }, () => new ArrayBuffer(snapshotBytes(params.n)));
  const init: ToWorker = { type: 'init', module: await wasmModule, n: params.n, seed: params.seed, sim: params.sim, hz: params.hz, script: params.script, pool, bench: !!params.bench, dur: params.dur };
  worker.postMessage(init, pool);
}

const overlay = new Overlay(() => {
  const f = frameStat.summary(), c = cpuStat.summary(), s = stepStat.summary(), g = gpuStat.summary();
  return [
    `frame  ${fmt(f.med)} ms  p99 ${fmt(f.p99)}  (${fmt(1000 / f.med, 0)} fps)`,
    `cpu    ${fmt(c.med)} ms  p99 ${fmt(c.p99)}`,
    `gpu    ${timer?.enabled ? `${fmt(g.med)} ms  p99 ${fmt(g.p99)}` : 'timestamp-query unavailable'}`,
    `sim    ${fmt(s.med, 3)} ms  p99 ${fmt(s.p99, 3)}  tick ${lastTick}`,
    `queue  ${queue.length}  skipped(worker) ${workerSkipped}  dropped(main) ${mainDropped}`,
    `gpu    ${gpu?.info.vendor ?? ''} ${gpu?.info.architecture ?? ''}  losses ${deviceLosses}`,
    `pad    ${gamepadInfo.connected ? `${gamepadInfo.id} [${gamepadInfo.mapping || 'non-standard'}]` : 'press a button to connect'}`,
  ];
});

let last = 0;
function raf(t: number) {
  requestAnimationFrame(raf);
  if (last) frameStat.push(t - last);
  last = t;
  const t0 = performance.now();
  const input = pollInput();
  if (input && worker) worker.postMessage({ type: 'input', input } satisfies ToWorker);
  if (gpu && timer) {
    const encoder = gpu.device.createCommandEncoder();
    frame(encoder, gpu.context.getCurrentTexture().createView());
    const readback = timer.endFrame(encoder, 1);
    gpu.device.queue.submit([encoder.finish()]);
    readback?.();
    if (Number.isFinite(timer.ms[0])) gpuStat.push(timer.ms[0]);
  }
  cpuStat.push(performance.now() - t0);
  overlay.update(t);
}

async function main() {
  installInput(canvas);
  try {
    await startGpu();
  } catch (e) {
    showUnsupported(e instanceof GpuUnavailable ? e.message : String(e));
    return;
  }
  await startSim();
  requestAnimationFrame(raf);
  (window as any).__ready = true;
}
main();
void HEADER_BYTES; void wallNow;
