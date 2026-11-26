// Stage 10 page: a scripted snapshot stream (a Worker standing in for Stage 8's sim) drives the sound events,
// the render clock from run 1 decides when the picture shows each tick, and one of two mixers plays the sounds.
// Everything the harness needs is written into probe.ts buffers; the harness itself (harness-bench.ts) is a separate chunk.
import workletUrl from './mixer-b.worklet.ts?worker&url';
import detectorUrl from './harness-detector.worklet.ts?worker&url';
import { SnapClock } from '../snapclock';
import { params } from './params';
import { probe } from './probe';
import { loadSounds } from './loader';
import { MixerA } from './mixer-a';
import { MixerB } from './mixer-b';
import type { Mixer } from './mixer';
import { Director } from './director';
import { SND } from './soundset';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const g2 = canvas.getContext('2d')!;
const status = document.getElementById('status')!;
const W = canvas.width, H = canvas.height, SCALE = 6;

let ctx: AudioContext, mixer: Mixer, director: Director, clock: SnapClock, worker: Worker;
let harness: typeof import('./harness-bench') | null = null;
let inputAudioMs = 0, lastT = 0, benchStart = Infinity, benchOn = false, ended = false, nextStall = Infinity, stallCount = 0;
let ownAcc = 0, lastTs = 0, nextStatus = 0;
const COLORS = ['#8cf', '#fc6', '#f66', '#fa4', '#6f8', '#ccc', '#ccc', '#f4f'];

const burn = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* main thread busy */ } };

async function boot() {
  ctx = new AudioContext({ latencyHint: params.hint as AudioContextLatencyCategory });
  const bank = await loadSounds(ctx, import.meta.env.BASE_URL + 'stage10/');
  mixer = params.mixer === 'B' ? await MixerB.create(ctx, bank, workletUrl, params.vol) : new MixerA(ctx, bank, params.pool === 1, params.vol);
  if (ctx.state !== 'running') await ctx.resume();
  if (params.bench) {
    harness = await import('./harness-bench');
    await harness.setup({ ctx, mixer, params, bank, detectorUrl });
  }
  (window as any).__s10 = { ctx, mixer, bank, probe, params };
  director = new Director(mixer);
  director.setLead(params.lead, params.hz);
  clock = new SnapClock({ design: 'A', lag: params.lag, hz: params.hz, maxQueue: 3 }, (b) => worker.postMessage({ type: 'return', buffer: b }, [b]));
  worker = new Worker(new URL('./harness-sim.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const b = e.data.buffer as ArrayBuffer;
    director.onSnapshot(b);
    clock.onSnapshot(b, performance.now());
  };
  worker.postMessage({ type: 'start', rate: params.rate, hz: params.hz, seed: params.seed });
  mixer.start();
  installInput();
  benchStart = performance.now() + params.warmup * 1000;
  (window as any).__ready = true;
  requestAnimationFrame(frame);
}

function installInput() {
  // Space = shoot, F = dash. The driver sends real key presses through the browser's input pipeline.
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const a0 = performance.now();
    if (e.code === 'Space') director.own(SND.shoot, e.timeStamp);
    else if (e.code === 'KeyF') director.own(SND.dash, e.timeStamp);
    inputAudioMs += performance.now() - a0;
  });
}

function frame(t: number) {
  if (ended) return;
  const now = performance.now(), dt = lastT ? now - lastT : 16.7;
  lastT = now;
  const n = probe.nFrame;
  if (!benchOn && now >= benchStart) {
    benchOn = true; probe.benchFrame = n; probe.trStart = probe.nTrack; probe.benchTime = now;
    if (params.stalls) nextStall = now + 5000;
    harness?.onBenchStart();
  }
  if (benchOn && now >= nextStall) { nextStall = now + 10000; burn(stallCount++ % 2 === 0 ? 100 : 500); probe.stalls++; }
  if (params.busy > 0) burn(params.busy);
  const now2 = performance.now();
  clock.frame(now2, dt);
  // Audio work for this frame.
  const a0 = performance.now();
  director.measureLead(ctx);
  director.pump(clock.displayed, n);
  ownAcc += dt * params.own / 1000;
  while (ownAcc >= 1) { ownAcc -= 1; director.own(SND.shoot, -1); }
  director.updateMusic(now2);
  mixer.poll();
  if (now2 - lastTs > 500 && probe.nTs < probe.tsCtx.length) { lastTs = now2; const o = ctx.getOutputTimestamp(); probe.tsCtx[probe.nTs] = o.contextTime ?? 0; probe.tsPerf[probe.nTs++] = o.performanceTime ?? 0; }
  const audioMs = performance.now() - a0 + inputAudioMs; inputAudioMs = 0;
  draw(now2, n);
  if (n < probe.frameMs.length) {
    probe.frameMs[n] = dt; probe.frameTick[n] = clock.displayed; probe.audioMs[n] = audioMs; probe.frameSubmit[n] = performance.now(); probe.voices[n] = probe.mix[6];
    probe.nFrame = n + 1;
  }
  if (!params.bench && now2 > nextStatus) { nextStatus = now2 + 250; status.textContent = `mixer ${mixer.name}  voices ${probe.mix[6]}  intensity ${director.intensity.toFixed(2)}  rate ${params.rate}/s  audio ${audioMs.toFixed(2)} ms  ctx ${ctx.state}`; }
  if (benchOn && now2 - benchStart >= params.dur * 1000) { ended = true; void harness!.finish().then(() => { (window as any).__done = true; }); return; }
  requestAnimationFrame(frame);
  void t;
}

function draw(now: number, frameIdx: number) {
  g2.fillStyle = '#10141c'; g2.fillRect(0, 0, W, H);
  g2.fillStyle = '#fff'; g2.fillRect(W / 2 - 4, H / 2 - 4, 8, 8);
  const px = director.playerX, py = director.playerY;
  for (let i = 0; i < 256; i++) {
    const age = frameIdx - director.flash[i * 4 + 3];
    if (age < 0 || age > 12) continue;
    const type = director.flash[i * 4 + 2];
    g2.fillStyle = COLORS[type] ?? '#fff'; g2.globalAlpha = 1 - age / 12;
    const r = 3 + age * (type === 3 ? 4 : 1);
    g2.beginPath(); g2.arc(W / 2 + (director.flash[i * 4] - px) * SCALE, H / 2 + (director.flash[i * 4 + 1] - py) * SCALE, r, 0, 6.2832); g2.fill();
  }
  g2.globalAlpha = 1;
  void now;
}

if (params.bench) void boot();
else {
  status.textContent = 'click or press a key to start audio';
  const go = () => { removeEventListener('pointerdown', go); removeEventListener('keydown', go); void boot(); };
  addEventListener('pointerdown', go); addEventListener('keydown', go);
}
