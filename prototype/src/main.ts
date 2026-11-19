import simdUrl from './wasm/sim-simd.wasm?url';
import nosimdUrl from './wasm/sim-nosimd.wasm?url';
import { params } from './params';
import { GpuTimer, GpuUnavailable, initGpu, showUnsupported } from './gpu';
import type { Gpu } from './gpu';
import { gamepadInfo, installInput, pollInput } from './input';
import { Overlay, Stat, fmt } from './overlay';
import { snapshotBytes, wallNow } from './protocol';
import type { FromWorker, ToWorker } from './protocol';
import { SimHost, createBackend, summarize } from './simhost';

// Start the WASM download and compile first, in parallel with everything else.
// The compiled module is posted to the worker (a page's preloads are not shared with workers).
const wasmUrl = params.sim === 'wasm-nosimd' ? nosimdUrl : simdUrl;
const wasmModule = params.sim === 'ts' ? Promise.resolve(null) : WebAssembly.compileStreaming(fetch(wasmUrl));
wasmModule.catch(() => {});

const canvas = document.getElementById('game') as HTMLCanvasElement;
const POOL = 4;
const hostOpt = { n: params.n, hz: params.hz, script: params.script, bench: !!params.bench, dur: params.dur, warmup: params.warmup };

const frameStat = new Stat(), cpuStat = new Stat(), stepStat = new Stat(), gpuStat = new Stat();
let queue: ArrayBuffer[] = [];
let workerSkipped = 0, mainDropped = 0, lastTick = 0, deviceLosses = 0;
let gpu: Gpu | null = null;
let timer: GpuTimer | null = null;
let worker: Worker | null = null;
let mainHost: SimHost | null = null;

// Bench recording on the main thread (preallocated).
const benchCap = params.bench ? Math.ceil((params.dur + params.warmup + 10) * 250) : 1;
const recFrame = new Float32Array(benchCap), recCpu = new Float32Array(benchCap), recDelivery = new Float32Array(benchCap);
let nFrame = 0, nDelivery = 0;
const benchFrom = performance.now() + params.warmup * 1000;

const returnBuffer = (buffer: ArrayBuffer) => {
  if (worker) worker.postMessage({ type: 'return', buffer } satisfies ToWorker, [buffer]);
  else mainHost?.pool.push(buffer);
};

function onSnapshot(buffer: ArrayBuffer) {
  const dv = new DataView(buffer);
  stepStat.push(dv.getFloat32(16, true));
  lastTick = dv.getUint32(4, true);
  if (params.bench && performance.now() > benchFrom && nDelivery < benchCap) recDelivery[nDelivery++] = wallNow() - dv.getFloat64(48, true);
  queue.push(buffer);
}

function onResult(sim: unknown) {
  (window as any).__result = {
    config: params, sim,
    frameMs: summarize(recFrame.subarray(0, nFrame)),
    mainCpuMs: summarize(recCpu.subarray(0, nFrame)),
    deliveryMs: summarize(recDelivery.subarray(0, nDelivery)),
    framesOver20ms: recFrame.subarray(0, nFrame).reduce((a, v) => a + (v > 20 ? 1 : 0), 0),
    workerSkipped, mainDropped, deviceLosses,
    gpu: (window as any).__gpu, isolated: crossOriginIsolated, ua: navigator.userAgent, dpr: devicePixelRatio,
    canvas: [canvas.width, canvas.height], hidden: document.hidden,
  };
}

function frame(encoder: GPUCommandEncoder, view: GPUTextureView) {
  // Keep only the newest snapshot, hand the rest back to the sim's pool.
  while (queue.length > 1) { returnBuffer(queue.shift()!); mainDropped++; }
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
  const pool = Array.from({ length: POOL }, () => new ArrayBuffer(snapshotBytes(params.n)));
  if (params.thread === 'main') {
    // Comparison mode (Stage 1): the same sim and driver on the main thread, no worker.
    const backend = await createBackend(params.sim, await wasmModule, params.n, params.seed);
    mainHost = new SimHost(backend, hostOpt, onSnapshot);
    mainHost.pool.push(...pool);
    mainHost.onResult = onResult;
    mainHost.start();
    return;
  }
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'snapshot') onSnapshot(m.buffer);
    else if (m.type === 'stats') workerSkipped = m.skipped;
    else if (m.type === 'result') onResult(m.result);
  };
  const init: ToWorker = { type: 'init', module: await wasmModule, n: params.n, seed: params.seed, sim: params.sim, opt: hostOpt, pool };
  worker.postMessage(init, pool);
}

const overlay = new Overlay(() => {
  const f = frameStat.summary(), c = cpuStat.summary(), s = stepStat.summary(), g = gpuStat.summary();
  return [
    `frame  ${fmt(f.med)} ms  p99 ${fmt(f.p99)}  (${fmt(1000 / f.med, 0)} fps)`,
    `cpu    ${fmt(c.med)} ms  p99 ${fmt(c.p99)}`,
    `gpu    ${timer?.enabled ? `${fmt(g.med)} ms  p99 ${fmt(g.p99)}` : 'timestamp-query unavailable'}`,
    `sim    ${fmt(s.med, 3)} ms  p99 ${fmt(s.p99, 3)}  tick ${lastTick}  [${params.sim}, ${params.thread}, n=${params.n}]`,
    `queue  ${queue.length}  skipped(sim) ${worker ? workerSkipped : mainHost?.skipped ?? 0}  dropped(main) ${mainDropped}`,
    `gpu    ${gpu?.info.vendor ?? ''} ${gpu?.info.architecture ?? ''}  losses ${deviceLosses}`,
    `pad    ${gamepadInfo.connected ? `${gamepadInfo.id} [${gamepadInfo.mapping || 'non-standard'}]` : 'press a button to connect'}`,
  ];
});

let last = 0;
function raf(t: number) {
  requestAnimationFrame(raf);
  const dtFrame = last ? t - last : 0;
  if (last) frameStat.push(dtFrame);
  last = t;
  const t0 = performance.now();
  const input = pollInput();
  if (input) { if (worker) worker.postMessage({ type: 'input', input } satisfies ToWorker); else if (mainHost) mainHost.input = input; }
  if (gpu && timer) {
    const encoder = gpu.device.createCommandEncoder();
    frame(encoder, gpu.context.getCurrentTexture().createView());
    const readback = timer.endFrame(encoder, 1);
    gpu.device.queue.submit([encoder.finish()]);
    readback?.();
    if (Number.isFinite(timer.ms[0])) gpuStat.push(timer.ms[0]);
  }
  const cpu = performance.now() - t0;
  cpuStat.push(cpu);
  if (params.bench && t0 > benchFrom && nFrame < benchCap) { recFrame[nFrame] = dtFrame; recCpu[nFrame] = cpu; nFrame++; }
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
