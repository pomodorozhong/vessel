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
import { SnapClock } from './snapclock';
import { createRenderer } from './renderers';
import type { Renderer } from './renderers';

// Start the WASM download and compile first, in parallel with everything else.
// The compiled module is posted to the worker (a page's preloads are not shared with workers).
const wasmUrl = params.sim === 'wasm-nosimd' ? nosimdUrl : simdUrl;
const wasmModule = params.sim === 'ts' ? Promise.resolve(null) : WebAssembly.compileStreaming(fetch(wasmUrl));
wasmModule.catch(() => {});

const canvas = document.getElementById('game') as HTMLCanvasElement;
if (params.cw) { canvas.width = params.cw; canvas.height = params.ch; }
const hostOpt = { n: params.n, hz: params.hz, script: params.script, bench: !!params.bench, dur: params.dur, warmup: params.warmup };
const live = { design: params.design, lag: params.lag, cap: params.cap, delay: params.delay };

const frameStat = new Stat(), cpuStat = new Stat(), stepStat = new Stat(), gpuStat = new Stat(), latencyStat = new Stat(64);
let workerSkipped = 0, lastTick = 0, deviceLosses = 0, rebuilds = 0;
let gpu: Gpu | null = null;
let timer: GpuTimer | null = null;
let renderer: Renderer | null = null;
let worker: Worker | null = null;
let mainHost: SimHost | null = null;
let blocked: Uint8Array = new Uint8Array(65536);
let needUpload = false;
let outstanding = 0, maxOutstanding = 0; // snapshot buffers held by the main thread

const returnBuffer = (buffer: ArrayBuffer) => {
  outstanding--;
  if (worker) worker.postMessage({ type: 'return', buffer } satisfies ToWorker, [buffer]);
  else mainHost?.pool.push(buffer);
};
let clock = new SnapClock({ design: live.design, lag: live.lag, hz: params.hz, maxQueue: params.maxq }, returnBuffer);

// Bench recording on the main thread (preallocated).
const benchCap = params.bench ? Math.ceil((params.dur + params.warmup + 10) * 250) : 1;
const recFrame = new Float32Array(benchCap), recCpu = new Float32Array(benchCap), recDelivery = new Float32Array(benchCap), recGpu = new Float32Array(benchCap * 3), recEncode = new Float32Array(benchCap);
const recLatency = new Float32Array(4096), recRecovery: number[] = [];
let nFrame = 0, nDelivery = 0, nLatency = 0, nGpu = 0;
let benchFrom = Infinity, benchOn = false;
// Inputs sent but not yet seen on screen: [seq, event time].
const awaitSeq = new Uint32Array(64), awaitT = new Float64Array(64);
let awaitHead = 0, awaitTail = 0;
let stallEnd = 0, nextStall = Infinity;

const headerU = (b: ArrayBuffer) => new Uint32Array(b, 0, 4);
const headerF = (b: ArrayBuffer) => new Float32Array(b, 0, 20);

function onSnapshot(buffer: ArrayBuffer) {
  outstanding++;
  if (outstanding > maxOutstanding) maxOutstanding = outstanding;
  const f = headerF(buffer);
  stepStat.push(f[4]);
  lastTick = headerU(buffer)[1];
  const now = performance.now();
  if (benchOn && nDelivery < benchCap) recDelivery[nDelivery++] = wallNow() - new Float64Array(buffer, 48, 1)[0];
  clock.onSnapshot(buffer, now);
}

function onResult(sim: unknown) {
  const c = clock, minutes = params.dur / 60;
  (window as any).__result = {
    config: params, sim,
    frameMs: summarize(recFrame.subarray(0, nFrame)),
    mainCpuMs: summarize(recCpu.subarray(0, nFrame)),
    encodeMs: summarize(recEncode.subarray(0, nFrame)),
    gpuMs: nGpu ? summarize(recGpu.subarray(0, nGpu)) : null,
    gpuParts: renderer?.gpuParts?.() ?? null,
    deliveryMs: summarize(recDelivery.subarray(0, nDelivery)),
    framesOver20ms: recFrame.subarray(0, nFrame).reduce((a, v) => a + (v > 20 ? 1 : 0), 0),
    framesOver34ms: recFrame.subarray(0, nFrame).reduce((a, v) => a + (v > 34 ? 1 : 0), 0),
    clock: {
      design: live.design, lag: live.lag, frames: c.frames, pauses: c.pauses, jumps: c.jumps,
      pausesPerMin: c.pauses / minutes, jumpsPerMin: c.jumps / minutes,
      rmsErrMs: Math.sqrt(c.sumSqErr / Math.max(1, c.frames)) * 1000 / params.hz,
      snapshots: c.snapshots, gaps: c.gaps, droppedByMain: c.dropped, maxQueue: c.maxQueue, maxOutstanding,
    },
    inputLatencyMs: nLatency ? summarize(recLatency.subarray(0, nLatency)) : null,
    stallRecoveryMs: recRecovery,
    render: renderer ? { name: renderer.name, drawCalls: renderer.drawCalls, info: renderer.info?.() } : null,
    workerSkipped: worker ? workerSkipped : mainHost?.skipped ?? 0, deviceLosses,
    gpu: (window as any).__gpu, isolated: crossOriginIsolated, ua: navigator.userAgent, dpr: devicePixelRatio,
    canvas: [canvas.width, canvas.height], hidden: document.hidden,
  };
}

async function startGpu() {
  gpu = await initGpu(canvas);
  timer = new GpuTimer(gpu.device, gpu.features.timestamp);
  renderer = await createRenderer(params.render, gpu, timer, params.n, blocked, canvas);
  needUpload = true;
  rebuilds++;
  (window as any).__gpu = { info: gpu.info, features: gpu.features, all: [...gpu.adapter.features], limits: { maxStorageBufferBindingSize: gpu.device.limits.maxStorageBufferBindingSize } };
  gpu.device.lost.then(async (info) => {
    gpu = null; renderer = null;
    (window as any).__lost = { reason: info.reason, message: info.message, at: performance.now() };
    if (info.reason === 'destroyed') return; // destroyed on purpose
    deviceLosses++;
    // An adapter can create only one device, so recovery starts from a new adapter, and optional
    // features are chosen again. Retry for a minute (240 tries, 250 ms apart): right after a GPU process crash
    // no adapter exists yet, and after repeated crashes the browser may hold it back for longer.
    for (let attempt = 0; attempt < 240; attempt++) {
      try { await startGpu(); (window as any).__recovered = { at: performance.now(), attempt }; return; } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
    }
    showUnsupported('The GPU device was lost and did not come back.');
  });
}

async function startSim(): Promise<void> {
  const pool = Array.from({ length: params.pool }, () => new ArrayBuffer(snapshotBytes(params.n)));
  if (params.thread === 'main') {
    // Comparison mode (Stage 1): the same sim and driver on the main thread, no worker.
    const backend = await createBackend(params.sim, await wasmModule, params.n, params.seed, params.spawn);
    blocked = backend.blocked();
    mainHost = new SimHost(backend, hostOpt, onSnapshot);
    mainHost.pool.push(...pool);
    mainHost.delayMs = live.delay;
    mainHost.onResult = onResult;
    return;
  }
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const ready = new Promise<void>((resolve) => {
    worker!.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'snapshot') onSnapshot(m.buffer);
      else if (m.type === 'stats') workerSkipped = m.skipped;
      else if (m.type === 'result') onResult(m.result);
      else if (m.type === 'ready') { blocked = m.blocked; resolve(); }
    };
  });
  const init: ToWorker = { type: 'init', module: await wasmModule, n: params.n, seed: params.seed, sim: params.sim, spawn: params.spawn, opt: hostOpt, pool };
  worker.postMessage(init, pool);
  if (live.delay) worker.postMessage({ type: 'delay', ms: live.delay } satisfies ToWorker);
  await ready;
}

const overlay = new Overlay(() => {
  const f = frameStat.summary(), c = cpuStat.summary(), s = stepStat.summary(), g = gpuStat.summary(), l = latencyStat.summary();
  return [
    `frame  ${fmt(f.med)} ms  p99 ${fmt(f.p99)}  (${fmt(1000 / f.med, 0)} fps)`,
    `cpu    ${fmt(c.med)} ms  p99 ${fmt(c.p99)}   draws ${renderer?.drawCalls ?? 0}  [${renderer?.name ?? '-'}]`,
    `gpu    ${timer?.enabled ? `${fmt(g.med)} ms  p99 ${fmt(g.p99)}` : 'timestamp-query unavailable'}`,
    `sim    ${fmt(s.med, 3)} ms  p99 ${fmt(s.p99, 3)}  tick ${lastTick}  [${params.sim}, ${params.thread}, n=${params.n}]`,
    `snap   design ${live.design}  lag ${live.lag}  queue ${clock.queueLength}  held ${outstanding} (max ${maxOutstanding})`,
    `       pauses ${clock.pauses}  jumps ${clock.jumps}  skipped(sim) ${worker ? workerSkipped : mainHost?.skipped ?? 0}  dropped(main) ${clock.dropped}`,
    `input  to screen ${fmt(l.med, 1)} ms  max ${fmt(l.max, 1)}`,
    ...(renderer?.overlay?.() ?? []),
    `gpu    ${gpu?.info.vendor ?? ''} ${gpu?.info.architecture ?? ''}  losses ${deviceLosses}`,
    `pad    ${gamepadInfo.connected ? `${gamepadInfo.id} [${gamepadInfo.mapping || 'non-standard'}]` : 'press a button to connect'}`,
  ];
});

function installSwitches() {
  const el = document.getElementById('switches')!;
  if (params.bench) { el.style.display = 'none'; return; }
  el.innerHTML = `
    <label><input type="checkbox" id="sw-cap"> cap at 30 fps</label>
    <label>message delay <select id="sw-delay"><option>0</option><option>5</option><option>10</option><option>20</option></select> ms</label>
    <label>design <select id="sw-design"><option>A</option><option>B</option></select> lag <select id="sw-lag"><option>1</option><option>1.5</option><option selected>2</option><option>2.5</option><option>3</option></select></label>
    <button id="sw-stall100">stall 100 ms</button> <button id="sw-stall500">stall 500 ms</button> <button id="sw-reset">reset counters</button>`;
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
  $('sw-cap').onchange = () => { live.cap = $('sw-cap').checked ? 30 : 0; };
  $('sw-delay').onchange = () => { live.delay = Number($('sw-delay').value); if (worker) worker.postMessage({ type: 'delay', ms: live.delay } satisfies ToWorker); else if (mainHost) mainHost.delayMs = live.delay; };
  const remake = () => {
    live.design = ($('sw-design') as unknown as HTMLSelectElement).value; live.lag = Number($('sw-lag').value);
    const old = clock;
    clock = new SnapClock({ design: live.design, lag: live.lag, hz: params.hz, maxQueue: params.maxq }, returnBuffer);
    old.releaseAll();
  };
  $('sw-design').onchange = remake; $('sw-lag').onchange = remake;
  $('sw-stall100').onclick = () => { pendingStall = 100; };
  $('sw-stall500').onclick = () => { pendingStall = 500; };
  $('sw-reset').onclick = () => { clock.resetMetrics(); maxOutstanding = outstanding; };
}

let pendingStall = 0;
function stallNow(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* block the main thread on purpose */ }
  stallEnd = performance.now();
}

let last = 0, lastDrawn = 0, parity = 0;
function raf(t: number) {
  requestAnimationFrame(raf);
  if (live.cap === 30 && (parity ^= 1)) return; // draw every second frame
  const dtFrame = lastDrawn ? t - lastDrawn : 0;
  if (lastDrawn) frameStat.push(dtFrame);
  lastDrawn = t; last = t;
  const t0 = performance.now();

  if (!benchOn && params.bench && t0 >= benchFrom) { benchOn = true; clock.resetMetrics(); maxOutstanding = outstanding; if (params.stall) nextStall = t0 + 5000; }
  if (benchOn && t0 >= nextStall) {
    if (stallEnd) recRecovery.push(Math.max(0, clock.lastAnomaly - stallEnd)); // recovery after the previous stall
    nextStall = t0 + 10000; pendingStall = params.stall;
  }
  if (pendingStall) { const ms = pendingStall; pendingStall = 0; stallNow(ms); }

  const input = pollInput();
  if (input) {
    if (worker) worker.postMessage({ type: 'input', input } satisfies ToWorker); else if (mainHost) mainHost.input = input;
    awaitSeq[awaitTail & 63] = input.seq; awaitT[awaitTail & 63] = input.t; awaitTail++;
  }

  clock.frame(t, dtFrame);
  let tEncode = 0;
  const cur = clock.current;
  if (gpu && timer && renderer && cur) {
    if (clock.changed || needUpload) { renderer.setSnapshot(cur); needUpload = false; }
    const f = headerF(cur), a = clock.alpha;
    const encoder = gpu.device.createCommandEncoder();
    const te0 = performance.now();
    const used = renderer.render(encoder, gpu.context.getCurrentTexture(), a, t / 1000, f[16] + (f[10] - f[16]) * a, f[17] + (f[11] - f[17]) * a);
    const readback = timer.endFrame(encoder, used);
    gpu.device.queue.submit([encoder.finish()]);
    tEncode = performance.now() - te0;
    readback?.();
    let g = 0;
    for (let i = 0; i < used; i++) g += timer.ms[i];
    if (Number.isFinite(g)) { gpuStat.push(g); if (benchOn && nGpu < recGpu.length) recGpu[nGpu++] = g; }
    // Input-to-screen: an input is on screen once a snapshot that applied it is displayed past its start.
    if (a > 0) {
      const shown = headerU(cur)[3];
      while (awaitHead < awaitTail && awaitSeq[awaitHead & 63] <= shown) {
        const d = performance.now() - awaitT[awaitHead & 63];
        latencyStat.push(d);
        if (benchOn && nLatency < recLatency.length) recLatency[nLatency++] = d;
        awaitHead++;
      }
    }
  }
  const cpu = performance.now() - t0;
  cpuStat.push(cpu);
  if (benchOn && nFrame < benchCap) { recFrame[nFrame] = dtFrame; recCpu[nFrame] = cpu; recEncode[nFrame] = tEncode; nFrame++; }
  overlay.update(t);
}

async function main() {
  installInput(canvas);
  installSwitches();
  await startSim();
  try {
    await startGpu();
  } catch (e) {
    showUnsupported(e instanceof GpuUnavailable ? e.message : String(e));
    return;
  }
  benchFrom = performance.now() + params.warmup * 1000;
  mainHost?.start();
  if (worker) worker.postMessage({ type: 'start' } satisfies ToWorker);
  requestAnimationFrame(raf);
  (window as any).__ready = true;
  (window as any).__state = () => ({ tick: lastTick, deviceLosses, rebuilds, pauses: clock.pauses, jumps: clock.jumps, frameMed: frameStat.summary().med, hasGpu: !!gpu, pad: { ...gamepadInfo } });
}
main();
