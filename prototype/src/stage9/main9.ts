// Stage 9 page: the scripted stream (in a worker) -> snapshots -> the cel-shaded renderer, with a bench mode that records
// frame time, CPU encode time, GPU time per pass, overdraw, dynamic resolution changes and particle counts.
import { GpuUnavailable, initGpu, showUnsupported } from '../gpu';
import type { Gpu } from '../gpu';
import { Overlay, Stat, fmt } from '../overlay';
import { GROUPS, SLOT, SLOTS } from './look';
import type { Slot } from './look';
import { P9 as P } from './params9';
import { Renderer9 } from './render9';
import type { RenderOpts } from './render9';
import { PassTimer } from './timer9';

const STEP_MS = 1000 / P.hz;
const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = P.cw; canvas.height = P.ch;
if (!P.overlay) document.getElementById('overlay')!.style.display = 'none';

const MAX_ENTITIES = P.enemies + 1;
const opts: RenderOpts = {
  outline: P.outline, shadow: P.shadow, shadowRes: P.shadowres, grass: P.grass, bloom: !!P.bloom, overdraw: !!P.overdraw,
  particles: P.particles, evRate: P.shots * 3 + P.hits * 6 + P.deaths * 24 + P.explosions * 96, ires: P.ires, cw: P.cw, ch: P.ch,
  maxEntities: MAX_ENTITIES, maxProj: Math.max(1, P.proj), pitch: P.pitch, dist: P.dist, fog: !!P.fog, ui: !!P.ui,
  tod: P.tod === 'auto' ? 'auto' : Number(P.tod), daylen: P.daylen, outlinePx: P.olw,
};

// ---------------------------------------------------------------- statistics
const frameStat = new Stat(), cpuStat = new Stat(), gpuStat = new Stat();
const benchCap = P.bench ? Math.ceil((P.dur + P.warmup + 10) * 250) : 1;
const recFrame = new Float32Array(benchCap), recCpu = new Float32Array(benchCap), recEncode = new Float32Array(benchCap);
const recSlots = SLOTS.map(() => new Float32Array(benchCap)), recTotal = new Float32Array(benchCap);
let nFrame = 0, nGpu = 0, benchOn = false, benchFrom = Infinity, benchStart = 0, finished = false;
const dynChanges: { t: number; from: number; to: number; gpuMedianMs: number }[] = [];
let streamStats: { steps: number; meanMs: number; maxMs: number } | null = null;
let streamStepMs = 0, streamSteps = 0;

const pct = (s: Float32Array | number[], p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
function summarize(values: Float32Array | number[]) {
  const s = Float32Array.from(values).sort();
  let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i];
  return { n: s.length, mean: sum / Math.max(1, s.length), median: s.length ? pct(s, 0.5) : NaN, p95: s.length ? pct(s, 0.95) : NaN, p99: s.length ? pct(s, 0.99) : NaN, max: s.length ? s[s.length - 1] : NaN };
}

// ---------------------------------------------------------------- stream and snapshot playback
interface Snap { buf: ArrayBuffer; world: Float32Array | null }
let worker: Worker;
const queue: Snap[] = [];
let cur: Snap | null = null, curStart = 0, changed = false;
let lastWorld: Float32Array | null = null, pendingWorld: Float32Array | null = null;
let held = 0;
// Takes the next snapshot off the queue. A world change it carries is kept until the next upload, so a snapshot
// that is skipped in a catch-up or dropped from a long queue does not lose a building change.
const take = () => { const s = queue.shift()!; if (s.world) pendingWorld = s.world; return s; };

async function startStream() {
  worker = new Worker(new URL('./stream-worker.ts', import.meta.url), { type: 'module' });
  const ready = new Promise<void>((resolve) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'snapshot') { queue.push({ buf: m.buffer, world: m.world }); streamStepMs += m.stepMs; streamSteps++; }
      else if (m.type === 'stats') streamStats = m;
      else if (m.type === 'ready') resolve();
    };
  });
  worker.postMessage({ type: 'init', config: { enemies: P.enemies, proj: P.proj, shots: P.shots, hits: P.hits, deaths: P.deaths, explosions: P.explosions, seed: P.seed, hz: P.hz } });
  await ready;
}

// ---------------------------------------------------------------- GPU start (the one rebuild path, also used after a lost device)
let gpu: Gpu | null = null, timer: PassTimer | null = null, renderer: Renderer9 | null = null;
let deviceLosses = 0, rebuilds = 0, needUpload = false;
let lastFailure = '';
const errors: string[] = [];

async function startGpu() {
  const g = await initGpu(canvas);
  g.device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; if (errors.length < 20) errors.push(m); console.error(m); });
  const t = new PassTimer(g.device, g.features.timestamp);
  t.onSample = onGpuSample;
  const r = await Renderer9.create(g, t, opts);
  gpu = g; timer = t; renderer = r;
  needUpload = true;
  rebuilds++;
  (window as any).__gpu = { info: g.info, features: g.features, all: [...g.adapter.features], limits: { maxStorageBufferBindingSize: g.device.limits.maxStorageBufferBindingSize, maxBufferSize: g.device.limits.maxBufferSize, maxTextureDimension2D: g.device.limits.maxTextureDimension2D } };
  g.device.lost.then(async (info) => {
    gpu = null; renderer = null; timer = null;
    (window as any).__lost = { reason: info.reason, message: info.message, at: performance.now() };
    if (info.reason === 'destroyed') return;
    deviceLosses++;
    // An adapter can create only one device, so recovery starts from a new adapter. Retry for a minute: right after a GPU
    // process crash no adapter exists yet.
    for (let attempt = 0; attempt < 240; attempt++) {
      try { await startGpu(); (window as any).__recovered = { at: performance.now(), attempt }; return; } catch (e) { lastFailure = String(e); await new Promise((res) => setTimeout(res, 250)); }
    }
    showUnsupported('The GPU device was lost and did not come back.');
  });
}

function onGpuSample(ms: Float64Array, mask: number) {
  let total = 0;
  for (let i = 0; i < SLOTS.length; i++) if (i !== SLOT.overdraw && (mask & (1 << i)) && Number.isFinite(ms[i])) total += ms[i];
  gpuStat.push(total);
  gpuRing[gpuRingN++ % gpuRing.length] = total;
  if (benchOn && nGpu < benchCap) {
    for (let i = 0; i < SLOTS.length; i++) recSlots[i][nGpu] = (mask & (1 << i)) && Number.isFinite(ms[i]) ? ms[i] : 0;
    recTotal[nGpu++] = total;
  }
}

// ---------------------------------------------------------------- dynamic resolution
const gpuRing = new Float32Array(30); let gpuRingN = 0;
const RES_STEPS = [432, 540, 648, 720, 810, 900, 990, 1080].filter((h) => h < P.ires).concat([P.ires]);
let resIdx = RES_STEPS.length - 1, lastResChange = 0, lastResDown = -1e9, lastResUp = -1e9;
// Stage 12 (Stage 9's dynres P1): it flipped between 432p and 540p every 3-7 s. Now a step up must be predicted to fit under
// UP_FRACTION of the budget (0.95 before), and waits upHold after the last step down (3 s after any change before). A step up
// that has to come back down within 5 s doubles upHold, up to 60 s; one that holds for 30 s resets it.
const UP_FRACTION = 0.8, UP_HOLD_MS = 10000;
let upHold = UP_HOLD_MS;
function dynamicResolution(now: number) {
  if (!P.dynres || !renderer || gpuRingN < gpuRing.length) return;
  const med = pct(Float32Array.from(gpuRing).sort(), 0.5);
  let to = resIdx;
  if (med > P.budget && resIdx > 0) to = resIdx - 1;
  else if (resIdx < RES_STEPS.length - 1 && now - lastResChange > 3000 && now - lastResDown > upHold) {
    // Raise only when the next size is predicted to fit (cost taken as proportional to pixels, which overestimates), so it does not flip back and forth.
    const r = RES_STEPS[resIdx + 1] / RES_STEPS[resIdx];
    if (med * r * r < P.budget * UP_FRACTION) to = resIdx + 1;
  }
  if (to !== resIdx) {
    dynChanges.push({ t: (now - (benchStart || now)) / 1000, from: RES_STEPS[resIdx], to: RES_STEPS[to], gpuMedianMs: med });
    if (to < resIdx) { if (now - lastResUp < 5000) upHold = Math.min(60000, upHold * 2); else if (now - lastResUp > 30000) upHold = UP_HOLD_MS; lastResDown = now; }
    else lastResUp = now;
    resIdx = to; lastResChange = now; gpuRingN = 0; // wait for fresh samples at the new size
    renderer.resize(RES_STEPS[to]);
  }
}

// ---------------------------------------------------------------- frame loop
const overlay = new Overlay(() => {
  const f = frameStat.summary(), c = cpuStat.summary(), g = gpuStat.summary();
  return [
    `frame  ${fmt(f.med)} ms  p99 ${fmt(f.p99)}  (${fmt(1000 / f.med, 0)} fps)   cpu ${fmt(c.med)} p99 ${fmt(c.p99)}   draws ${renderer?.drawCalls ?? 0}`,
    `gpu    ${timer?.enabled ? `${fmt(g.med)} ms  p99 ${fmt(g.p99)}` : 'timestamp-query unavailable'}   ires ${renderer?.internal.join('x') ?? '-'}${P.dynres ? ' (dynres)' : ''}`,
    `look   outline ${P.outline}  shadow ${P.shadow}${P.shadow === 'map' ? ' ' + P.shadowres : ''}  grass x${P.grass}  bloom ${P.bloom}  tod ${P.tod}`,
    `load   enemies ${P.enemies}  proj ${P.proj}  particles ${P.particles}  stream ${streamSteps ? fmt(streamStepMs / streamSteps, 2) : '-'} ms/step  queue ${queue.length}`,
    ...(renderer?.overlay?.() ?? []),
    `gpu    ${gpu?.info.vendor ?? ''} ${gpu?.info.architecture ?? ''}  losses ${deviceLosses} rebuilds ${rebuilds}`,
  ];
});

let last = 0, lastDrawn = 0;
function raf(t: number) {
  requestAnimationFrame(raf);
  if (P.cap === 30 && ((raf as any).parity ^= 1)) return;
  const dtFrame = lastDrawn ? t - lastDrawn : 0;
  if (lastDrawn) frameStat.push(dtFrame);
  lastDrawn = t;
  const t0 = performance.now();
  if (!benchOn && P.bench && t0 >= benchFrom) { benchOn = true; benchStart = t0; }

  // Snapshot playback: show the current snapshot, interpolating over one 30 Hz step, then move to the next.
  if (!cur && queue.length >= 2) { cur = take(); curStart = t0; changed = true; }
  while (cur && queue.length && t0 - curStart >= STEP_MS) { cur = take(); curStart += STEP_MS; if (t0 - curStart > 3 * STEP_MS) curStart = t0; changed = true; }
  while (queue.length > 5) take();
  let encode = 0;
  if (gpu && timer && renderer && cur) {
    if (changed || needUpload) {
      if (pendingWorld) { lastWorld = pendingWorld; pendingWorld = null; renderer.setWorld(lastWorld); }
      else if (needUpload && lastWorld) renderer.setWorld(lastWorld);
      renderer.setSnapshot(cur.buf); changed = false; needUpload = false;
    }
    const a = Math.min(1, (t0 - curStart) / STEP_MS);
    const f = new Float32Array(cur.buf, 0, 32);
    const px = f[8] + (f[10] - f[8]) * a, py = f[9] + (f[11] - f[9]) * a;
    const dt = Math.min(0.05, Math.max(0.001, dtFrame / 1000));
    const encoder = gpu.device.createCommandEncoder();
    const te0 = performance.now();
    const after = renderer.render(encoder, gpu.context.getCurrentTexture(), a, t / 1000, dt, px, py);
    gpu.device.queue.submit([encoder.finish()]);
    encode = performance.now() - te0;
    after();
    dynamicResolution(t0);
  }
  const cpu = performance.now() - t0;
  cpuStat.push(cpu);
  if (benchOn && nFrame < benchCap) { recFrame[nFrame] = dtFrame; recCpu[nFrame] = cpu; recEncode[nFrame] = encode; nFrame++; }
  last = t;
  overlay.update(t);
  if (P.bench && benchOn && !finished && t0 - benchStart >= P.dur * 1000) { finished = true; finish(); }
}

function finish() {
  worker.postMessage({ type: 'stats' });
  setTimeout(() => {
    const groups: Record<string, ReturnType<typeof summarize>> = {}, passes: Record<string, ReturnType<typeof summarize>> = {};
    for (const s of SLOTS) passes[s] = summarize(recSlots[SLOT[s as Slot]].subarray(0, nGpu));
    for (const [g, slots] of Object.entries(GROUPS)) {
      const sum = new Float32Array(nGpu);
      for (let i = 0; i < nGpu; i++) for (const s of slots) sum[i] += recSlots[SLOT[s]][i];
      groups[g] = summarize(sum);
    }
    const r = renderer;
    const od = r?.odSamples ?? [];
    (window as any).__result = {
      config: P, url: location.href,
      frameMs: summarize(recFrame.subarray(0, nFrame)),
      mainCpuMs: summarize(recCpu.subarray(0, nFrame)),
      encodeMs: summarize(recEncode.subarray(0, nFrame)),
      framesOver20ms: recFrame.subarray(0, nFrame).reduce((a, v) => a + (v > 20 ? 1 : 0), 0),
      framesOver34ms: recFrame.subarray(0, nFrame).reduce((a, v) => a + (v > 34 ? 1 : 0), 0),
      gpuTotalMs: nGpu ? summarize(recTotal.subarray(0, nGpu)) : null,
      gpuGroupsMs: nGpu ? groups : null, gpuPassesMs: nGpu ? passes : null,
      gpuSamples: nGpu, gpuSamplesSkipped: timer?.skipped ?? 0,
      overdraw: P.overdraw ? { samples: od.length, meanWritesPerPixel: summarize(od.map((x) => x.mean)), p99WritesPerPixel: summarize(od.map((x) => x.p99)), maxWritesPerPixel: summarize(od.map((x) => x.max)) } : null,
      dynres: { enabled: !!P.dynres, budgetMs: P.budget, steps: RES_STEPS, changes: dynChanges, finalInternalHeight: r?.internal[1] ?? null },
      particles: { target: P.particles, alive: summarize(r?.aliveSamples.slice(Math.floor((r?.aliveSamples.length ?? 0) * 0.1)) ?? []), poolCap: r?.info().poolCap, spawnScale: r?.spawnScale },
      drawCalls: r?.drawCalls, internal: r?.internal, render: r?.info(),
      stream: streamStats, streamMeanMsInPage: streamSteps ? streamStepMs / streamSteps : null,
      deviceLosses, rebuilds, errors, lastFailure,
      gpu: (window as any).__gpu, ua: navigator.userAgent, dpr: devicePixelRatio, canvas: [canvas.width, canvas.height], hidden: document.hidden, isolated: crossOriginIsolated,
      timestamps: !!timer?.enabled,
    };
  }, 400);
}

async function main() {
  await startStream();
  try { await startGpu(); } catch (e) { showUnsupported(e instanceof GpuUnavailable ? e.message : String(e)); (window as any).__error = String(e); return; }
  benchFrom = performance.now() + P.warmup * 1000;
  worker.postMessage({ type: 'start' });
  requestAnimationFrame(raf);
  (window as any).__ready = true;
  (window as any).__state = () => ({ deviceLosses, rebuilds, hasGpu: !!gpu, frameMed: frameStat.summary().med, info: renderer?.info() ?? null, internal: renderer?.internal ?? null, errors, lastFailure });
  void last;
}
main().catch((e) => { (window as any).__error = String(e); console.error(e); });
