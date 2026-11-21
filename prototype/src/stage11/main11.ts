// Stage 11 page: everything at once. Stage 8's combat sim in a worker -> snapshots -> the Stage 2 render clock -> Stage 9's
// renderer with the full look, and Stage 10's director and mixer fed from the same snapshots and from the keyboard.
// The frame loop writes into preallocated arrays only; the bench summary lives in harness11.ts (its own chunk, loaded at
// the end), so the allocation measurement can tell the game from the harness.
import combatUrl from '../wasm/combat.wasm?url';
import workletUrl from '../stage10/mixer-b.worklet.ts?worker&url';
import detectorUrl from '../stage10/harness-detector.worklet.ts?worker&url';
import { GpuUnavailable, initGpu, showUnsupported } from '../gpu';
import type { Gpu } from '../gpu';
import { Overlay, Stat, fmt } from '../overlay';
import { SnapClock } from '../snapclock';
import { SLOT, SLOTS } from '../stage9/look';
import { Renderer9 } from '../stage9/render9';
import type { RenderOpts } from '../stage9/render9';
import { PassTimer } from '../stage9/timer9';
import { loadSounds } from '../stage10/loader';
import { MixerA } from '../stage10/mixer-a';
import { MixerB } from '../stage10/mixer-b';
import type { Mixer } from '../stage10/mixer';
import { Director } from '../stage10/director';
import { SND } from '../stage10/soundset';
import { probe } from '../stage10/probe';
import { params as p10 } from '../stage10/params';
import { D_LATE } from '../stage10/layout';
import { P11 as P } from './params11';
import { rec } from './rec11';

const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = P.cw; canvas.height = P.ch;
if (!P.overlay) document.getElementById('overlay')!.style.display = 'none';

// ---------------------------------------------------------------- sim worker and the hand-off
let worker: Worker;
let clock: SnapClock;
let pendingWorld: Float32Array | null = null, lastWorld: Float32Array | null = null;
let recvMs = 0;                 // main-thread time handling snapshot messages since the last frame
let lastEnemies = 0, snapsDuringOutage = 0;
const release = (b: ArrayBuffer) => worker.postMessage({ type: 'return', buffer: b }, [b]);

function onWorkerMessage(e: MessageEvent) {
  const m = e.data;
  if (m.type !== 'snapshot') return;
  const t0 = performance.now();
  const b = m.buffer as ArrayBuffer;
  const h = new Float32Array(b, 0, 32), u = new Uint32Array(b, 0, 8), f64 = new Float64Array(b, 56, 2);
  if (m.world) pendingWorld = m.world;
  lastEnemies = m.enemies;
  director.onSnapshot(b);
  clock.onSnapshot(b, t0);
  if (!gpu) snapsDuringOutage++;
  rec.snap(t0, performance.timeOrigin + t0 - f64[0], h[18], u[4], u[5], m.enemies, (u[7] & 1) !== 0);
  recvMs += performance.now() - t0;
}

// ---------------------------------------------------------------- GPU (the one rebuild path, also after a lost device)
let gpu: Gpu | null = null, timer: PassTimer | null = null, renderer: Renderer9 | null = null;
let deviceLosses = 0, rebuilds = 0, needWorld = false;
const errors: string[] = [];
let opts: RenderOpts;

async function startGpu() {
  const g = await initGpu(canvas);
  g.device.addEventListener('uncapturederror', (e) => { const msg = (e as GPUUncapturedErrorEvent).error.message; if (errors.length < 20) errors.push(msg); });
  const t = new PassTimer(g.device, g.features.timestamp);
  t.onSample = onGpuSample;
  const r = await Renderer9.create(g, t, opts);
  gpu = g; timer = t; renderer = r;
  needWorld = true;
  rebuilds++;
  g.device.lost.then(async (info) => {
    gpu = null; renderer = null; timer = null;
    (window as any).__lost = { reason: info.reason, message: info.message, at: performance.now() };
    snapsDuringOutage = 0;
    if (info.reason === 'destroyed') return;
    deviceLosses++;
    for (let attempt = 0; attempt < 240; attempt++) {
      try { await startGpu(); (window as any).__recovered = { at: performance.now(), attempt, snapshotsDuringOutage: snapsDuringOutage }; return; } catch { await new Promise((res) => setTimeout(res, 250)); }
    }
    showUnsupported('The GPU device was lost and did not come back.');
  });
}

function onGpuSample(ms: Float64Array, mask: number) {
  let total = 0;
  for (let i = 0; i < SLOTS.length; i++) if (i !== SLOT.overdraw && (mask & (1 << i)) && Number.isFinite(ms[i])) total += ms[i];
  gpuStat.push(total);
  rec.gpu(performance.now(), total);
}

// ---------------------------------------------------------------- audio
let ctx: AudioContext, mixer: Mixer, director: Director;
let harness10: typeof import('../stage10/harness-bench') | null = null;
let inputAudioMs = 0, inputTs = -1;

function installInput() {
  // Space = shoot, F = dash, as in Stage 10. The player's own sounds play straight from input.
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const a0 = performance.now();
    if (e.code === 'Space') director.own(SND.shoot, e.timeStamp);
    else if (e.code === 'KeyF') director.own(SND.dash, e.timeStamp);
    else return;
    inputAudioMs += performance.now() - a0;
    if (inputTs < 0) inputTs = e.timeStamp; // measured to the submit of the next frame
  });
}

// ---------------------------------------------------------------- frame loop
const frameStat = new Stat(), gpuStat = new Stat(), cpuStat = new Stat();
let lastT = 0, benchOn = false, benchFrom = Infinity, benchStart = 0, finished = false, frameNo = 0;
let lastPauses = 0, lastJumps = 0;

const overlay = new Overlay(() => {
  const f = frameStat.summary(), g = gpuStat.summary(), c = cpuStat.summary();
  return [
    `frame ${fmt(f.med)} ms p99 ${fmt(f.p99)}   cpu ${fmt(c.med)} p99 ${fmt(c.p99)}   gpu ${fmt(g.med)} p99 ${fmt(g.p99)}`,
    `wave  ${P.mode}  enemies ${lastEnemies}  pauses ${clock?.pauses ?? 0} jumps ${clock?.jumps ?? 0}  queue ${clock?.queueLength ?? 0}`,
    `audio mixer ${mixer?.name ?? '-'}  voices ${probe.mix[6]}  late ${probe.det[D_LATE]}   gpu losses ${deviceLosses} rebuilds ${rebuilds}`,
  ];
});

function frame(t: number) {
  requestAnimationFrame(frame);
  const t0 = performance.now(), dt = lastT ? t0 - lastT : 16.7;
  lastT = t0;
  if (frameNo > 0) frameStat.push(dt);
  if (!benchOn && P.bench && t0 >= benchFrom) {
    benchOn = true; benchStart = t0;
    probe.benchFrame = probe.nFrame; probe.trStart = probe.nTrack; probe.benchTime = t0;
    clock.resetMetrics(); lastPauses = lastJumps = 0;
    harness10?.onBenchStart();
    rec.start(t0);
  }
  clock.frame(t0, dt);
  // 1. Snapshot upload.
  const u0 = performance.now();
  if (renderer && clock.current) {
    if (pendingWorld) { lastWorld = pendingWorld; pendingWorld = null; renderer.setWorld(lastWorld); }
    else if (needWorld && lastWorld) renderer.setWorld(lastWorld);
    if (clock.changed || needWorld) renderer.setSnapshot(clock.current);
    needWorld = false;
  }
  // 2. Encode and submit.
  const e0 = performance.now();
  let encode = 0;
  if (gpu && renderer && clock.current) {
    const h = new Float32Array(clock.current, 0, 16), a = clock.alpha;
    const px = h[8] + (h[10] - h[8]) * a, py = h[9] + (h[11] - h[9]) * a;
    const encoder = gpu.device.createCommandEncoder();
    const after = renderer.render(encoder, gpu.context.getCurrentTexture(), a, t / 1000, Math.min(0.05, Math.max(0.001, dt / 1000)), px, py);
    gpu.device.queue.submit([encoder.finish()]);
    encode = performance.now() - e0;
    after();
  }
  const submitAt = performance.now();
  // 3. Audio.
  const a0 = performance.now();
  const n = probe.nFrame;
  director.pump(clock.displayed, n);
  director.updateMusic(a0);
  mixer.poll();
  if (a0 - lastTs > 500 && probe.nTs < probe.tsCtx.length) { lastTs = a0; const o = ctx.getOutputTimestamp(); probe.tsCtx[probe.nTs] = o.contextTime ?? 0; probe.tsPerf[probe.nTs++] = o.performanceTime ?? 0; }
  const audio = performance.now() - a0 + inputAudioMs; inputAudioMs = 0;
  // 4. UI (the debug overlay's DOM text; the game's HUD, health bars and damage numbers are drawn by the renderer's UI pass).
  const i0 = performance.now();
  overlay.update(t);
  const ui = performance.now() - i0;
  const cpu = performance.now() - t0;
  cpuStat.push(cpu);
  // Stage 10's probe, which its harness reads for latency and glitches.
  if (n < probe.frameMs.length) { probe.frameMs[n] = dt; probe.frameTick[n] = clock.displayed; probe.audioMs[n] = audio; probe.frameSubmit[n] = submitAt; probe.voices[n] = probe.mix[6]; probe.nFrame = n + 1; }
  const anomaly = clock.pauses > lastPauses ? 1 : clock.jumps > lastJumps ? 2 : 0;
  lastPauses = clock.pauses; lastJumps = clock.jumps;
  if (benchOn && !finished) rec.frame(t0, dt, cpu, recvMs, e0 - u0, encode, audio, ui, anomaly, probe.det[D_LATE], inputTs >= 0 ? submitAt - inputTs : -1, renderer ? 1 : 0);
  inputTs = -1; // a key press before the bench start is not carried into it
  recvMs = 0;
  frameNo++;
  if (benchOn && !finished && t0 - benchStart >= P.dur * 1000) {
    // The clock's counters are taken now: once the worker is asked to finish it stops stepping, and the frames that keep
    // running while the summaries are collected would count as pauses.
    finished = true; rec.on = false; clockAtEnd = { pauses: clock.pauses, jumps: clock.jumps, frames: clock.frames, dropped: clock.dropped, gaps: clock.gaps, maxQueue: clock.maxQueue, snapshots: clock.snapshots };
    void finish();
  }
}
let lastTs = 0, clockAtEnd: Record<string, number> | null = null;

// Memory once a second: the JS heap (precise with --enable-precise-memory-info) and the clock's own counters.
setInterval(() => { if (benchOn && !finished) rec.mem(performance.now(), (performance as any).memory?.usedJSHeapSize ?? NaN); }, 1000);

async function finish() {
  const simResult = await new Promise<unknown>((res) => {
    const prev = worker.onmessage;
    worker.onmessage = (e) => { if (e.data.type === 'result') { worker.onmessage = prev; res(e.data.result); } else prev?.call(worker, e); };
    worker.postMessage({ type: 'finish' });
  });
  let audio: unknown = null;
  if (harness10) { await harness10.finish(); audio = (window as any).__result; (window as any).__result = null; }
  const h = await import('./harness11');
  (window as any).__result11 = h.summarize({
    config: P, sim: simResult, audio, clock: clockAtEnd,
    deviceLosses, rebuilds, errors, render: renderer?.info() ?? null, truncated: (renderer as any)?.truncated ?? null,
    lost: (window as any).__lost ?? null, recovered: (window as any).__recovered ?? null,
    gpu: gpu ? { info: gpu.info, timestamps: !!timer?.enabled } : null, ua: navigator.userAgent, isolated: crossOriginIsolated,
  });
}

// ---------------------------------------------------------------- start
async function main() {
  // Audio first: an AudioContext needs a user gesture, which the bench replaces with --autoplay-policy.
  ctx = new AudioContext({ latencyHint: 'interactive' });
  const bank = await loadSounds(ctx, import.meta.env.BASE_URL + 'stage10/');
  mixer = P.mixer === 'A' ? new MixerA(ctx, bank, true, P.vol) : await MixerB.create(ctx, bank, workletUrl, P.vol);
  if (ctx.state !== 'running') await ctx.resume();
  if (P.bench) {
    harness10 = await import('../stage10/harness-bench');
    await harness10.setup({ ctx, mixer, params: { ...p10, mixer: P.mixer, record: 0, forceglitch: 0, vol: P.vol, warmup: P.warmup, bench: 'stage11' }, bank, detectorUrl });
  }
  director = new Director(mixer);
  // Sim.
  const module = await WebAssembly.compileStreaming(fetch(combatUrl));
  worker = new Worker(new URL('./sim-worker.ts', import.meta.url), { type: 'module' });
  const ready = await new Promise<{ world: Float32Array; maxEntities: number; maxProj: number }>((resolve) => {
    worker.onmessage = (e) => { if (e.data.type === 'ready') resolve(e.data); };
    worker.postMessage({ type: 'init', module, cfg: { mode: P.mode, start: P.start, peak: P.peak, ramp: P.ramp, past: P.past, cap: P.cap, projPerEnemy: P.projPerEnemy, method: P.method, passes: P.passes, hz: P.hz, seed: P.seed, warmup: P.warmup, dur: P.dur } });
  });
  pendingWorld = ready.world;
  worker.onmessage = onWorkerMessage;
  clock = new SnapClock({ design: 'A', lag: P.lag, hz: P.hz, maxQueue: 4 }, release);
  // Renderer, sized for the sim's allocation. evRate sizes the particle spawn budget from Stage 8's event rates (as Stage 9).
  opts = {
    outline: P.outline, shadow: P.shadow, shadowRes: P.shadowres, grass: P.grass, bloom: !!P.bloom, overdraw: false,
    particles: P.particles, evRate: 7920 * 3 + 7540 * 6 + 30 * 24 + 40 * 96, ires: P.ires, cw: P.cw, ch: P.ch,
    maxEntities: ready.maxEntities, maxProj: ready.maxProj, pitch: 58, dist: 34, fog: true, ui: true, tod: 0.45, daylen: 120, outlinePx: 2,
  };
  try { await startGpu(); } catch (e) { showUnsupported(e instanceof GpuUnavailable ? e.message : String(e)); (window as any).__error = String(e); return; }
  rec.init(P.dur + 30);
  mixer.start();
  installInput();
  worker.postMessage({ type: 'start' });
  benchFrom = performance.now() + P.warmup * 1000;
  requestAnimationFrame(frame);
  (window as any).__ready = true;
  (window as any).__state = () => ({ deviceLosses, rebuilds, hasGpu: !!gpu, enemies: lastEnemies, pauses: clock.pauses, jumps: clock.jumps, late: probe.det[D_LATE], snapshots: clock.snapshots, info: renderer?.info() ?? null, errors });
}
main().catch((e) => { (window as any).__error = String(e); console.error(e); });
