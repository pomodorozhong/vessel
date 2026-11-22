// Stage 10 bench harness. Loaded with a dynamic import so it ends up in its own chunk (harness-bench-*.js):
// the heap sampler (scripts/run2/heap.mjs) tells it apart from the game by script URL. It attaches the
// glitch detector, the optional glitch injector, Chrome's render-capacity reporting and the recorder, and turns the
// probe buffers into window.__result. The game never calls into it per frame, except onBenchStart() once.
import type { Mixer } from './mixer';
import type { Params } from './params';
import type { SoundBank } from './loader';
import { probe } from './probe';
import { D_CLIP, D_HAS_PERF, D_IDLE_EXCESS, D_INJECT, D_LATE, D_MAX_EXCESS, D_PEAK, HIST_EDGES, M_ACTIVE, M_CULLED, M_DROP_LIMIT, M_DROP_TOTAL, M_HIST, M_MAX_ACTIVE, M_MERGED, M_PROC_MAX, M_PROC_MS, M_QUANTA, M_STARTED, M_STOLEN, MSG_DETECTOR, MSG_INJECT } from './layout';

interface Ctx { ctx: AudioContext; mixer: Mixer; params: Params; bank: SoundBank; detectorUrl: string }
let c: Ctx;
let base = new Float64Array(32), detBase = new Float64Array(16), statsBase: Record<string, number> = {};
let evBase = { in: 0, stale: 0, overflow: 0, player: 0 };
let recorder: MediaRecorder | null = null;
const recChunks: Blob[] = [];
let recDone: Promise<void> = Promise.resolve();

export async function setup(x: Ctx) {
  c = x;
  const { ctx, mixer, params } = x;
  await ctx.audioWorklet.addModule(x.detectorUrl);
  const det = new AudioWorkletNode(ctx, 'stage10-detector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  det.port.onmessage = (e) => { const m = e.data as Float64Array; if (m[0] === MSG_DETECTOR) for (let i = 0; i < 8; i++) if (i !== D_INJECT) probe.det[i] = m[1 + i]; };
  mixer.out.connect(det); det.connect(ctx.destination);
  if (params.forceglitch) {
    const inj = new AudioWorkletNode(ctx, 'stage10-injector', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { mode: params.forceglitch } });
    inj.port.onmessage = (e) => { const m = e.data as Float64Array; if (m[0] === MSG_INJECT) probe.det[D_INJECT] = m[1]; };
    inj.connect(ctx.destination);
  }
  const rc = (ctx as any).renderCapacity;
  if (rc) {
    rc.addEventListener('update', (e: any) => { const i = probe.nRc; if (i < probe.rcLoad.length) { probe.rcLoad[i] = e.averageLoad; probe.rcPeak[i] = e.peakLoad; probe.rcUnder[i] = e.underrunRatio; probe.nRc = i + 1; } });
    rc.start({ updateInterval: 1 });
  }
  if (params.record > 0) {
    const dest = ctx.createMediaStreamDestination();
    mixer.out.connect(dest);
    recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48000 });
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  }
}

const playbackNow = (): Record<string, number> => {
  const ps = (c.ctx as any).playbackStats, o: Record<string, number> = {};
  if (!ps) return o;
  for (const k of ['underrunDuration', 'underrunEvents', 'totalDuration', 'averageLatency', 'minimumLatency', 'maximumLatency']) if (typeof ps[k] === 'number') o[k] = ps[k];
  return o;
};

export function onBenchStart() {
  base = probe.mix.slice(); detBase = probe.det.slice(); statsBase = playbackNow();
  // The director's counters run from the first snapshot; only the bench window is reported.
  evBase = { in: probe.eventsIn, stale: probe.eventsStale, overflow: probe.eventsOverflow, player: probe.eventsPlayerIn };
  (c.ctx as any).playbackStats?.resetLatency?.();
  if (recorder) {
    recorder.start();
    recDone = new Promise((res) => {
      setTimeout(() => { recorder!.onstop = () => { void new Blob(recChunks, { type: 'audio/webm' }).arrayBuffer().then((ab) => {
        let s = ''; const u = new Uint8Array(ab); for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
        (window as any).__recording = { mime: 'audio/webm;codecs=opus', bytes: u.length, base64: btoa(s) }; res(); }); }; recorder!.stop(); }, c.params.record * 1000);
    });
  }
}

const num = (a: ArrayLike<number>) => Array.from(a as any as number[]).filter((v) => Number.isFinite(v));
function summ(arr: number[]) {
  if (!arr.length) return { n: 0 };
  const s = arr.slice().sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: q(0.5), p99: q(0.99), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

// Maps a context time to performance time with the getOutputTimestamp() pair sampled closest to `near`.
function perfOf(ctxT: number, near: number): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < probe.nTs; i++) { const d = Math.abs(probe.tsPerf[i] - near); if (d < bd) { bd = d; best = i; } }
  return best < 0 ? NaN : probe.tsPerf[best] + (ctxT - probe.tsCtx[best]) * 1000;
}

export async function finish() {
  const { ctx, mixer, params } = c;
  // The director's counters and the bench length, taken before waiting for the worklet (Stage 11's frame loop keeps pumping).
  const evEnd = { in: probe.eventsIn, stale: probe.eventsStale, overflow: probe.eventsOverflow, player: probe.eventsPlayerIn };
  const benchSecs = (performance.now() - probe.benchTime) / 1000;
  if (mixer.name === 'B') await new Promise((r) => setTimeout(r, 700)); // the worklet reports every ~0.35 s
  await recDone;
  const m = probe.mix, d = probe.det, f0 = probe.benchFrame, f1 = probe.nFrame;
  const outLat = ctx.outputLatency * 1000;
  const lIn: number[] = [], lInRaw: number[] = [], lEv: number[] = [], lEvRaw: number[] = [];
  let missing = 0;
  for (let i = probe.trStart; i < probe.nTrack; i++) {
    const ct = probe.trCtx[i];
    if (!Number.isFinite(ct)) { missing++; continue; }
    if (probe.trKind[i] === 0) { const p = perfOf(ct, probe.trT[i]); if (Number.isFinite(p)) { lInRaw.push(p - probe.trT[i]); lIn.push(p - probe.trT[i] + outLat); } }
    else {
      // The frame that first shows the event: the first frame whose displayed tick reached the event's tick.
      let lo = f0, hi = f1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (probe.frameTick[mid] >= probe.trT[i] - 1e-6) hi = mid; else lo = mid + 1; }
      if (lo >= f1) { missing++; continue; }
      const fs = probe.frameSubmit[lo], p = perfOf(ct, fs);
      if (Number.isFinite(p)) { lEvRaw.push(p - fs); lEv.push(p - fs + outLat); }
    }
  }
  const frameMs = num(probe.frameMs.subarray(f0 + 1, f1)), audioMs = num(probe.audioMs.subarray(f0 + 1, f1)), voices = num(probe.voices.subarray(f0, f1));
  // Seconds of the bench: B counts audio quanta (its counters arrive by message), A uses the wall clock.
  const wallSecs = (performance.now() - probe.benchTime) / 1000;
  const bQuanta = m[M_QUANTA] - base[M_QUANTA];
  const secs = mixer.name === 'B' && bQuanta > 0 ? bQuanta * 128 / ctx.sampleRate : wallSecs;
  const dlt = (i: number) => m[i] - base[i];
  const quantumMs = 128 / ctx.sampleRate * 1000;
  const audioThread = mixer.name === 'B' ? {
    procMeanMs: bQuanta > 0 ? dlt(M_PROC_MS) / bQuanta : null, loadMean: bQuanta > 0 ? dlt(M_PROC_MS) / bQuanta / quantumMs : null, procMaxMsSinceStart: m[M_PROC_MAX], quantumMs,
    histEdgesMs: HIST_EDGES, hist: Array.from({ length: 8 }, (_, k) => m[M_HIST + k] - base[M_HIST + k]), clockHasPerformanceNow: !!d[D_HAS_PERF],
    note: d[D_HAS_PERF] ? 'process() timed with performance.now() inside the worklet' : 'performance.now() is not available in the worklet scope: process() timed with Date.now() (1 ms steps), so the mean is unbiased but the histogram is coarse',
    extraBatches: (mixer as any).extraBatches ?? 0,
  } : null;
  const rcL = Array.from(probe.rcLoad.subarray(0, probe.nRc)), rcP = Array.from(probe.rcPeak.subarray(0, probe.nRc)), rcU = Array.from(probe.rcUnder.subarray(0, probe.nRc));
  const ps = playbackNow();
  const ev = (i: number) => dlt(i) / secs;
  (window as any).__result = {
    config: params, url: location.href, userAgent: navigator.userAgent, measuredAt: new Date().toISOString(),
    audio: {
      sampleRate: ctx.sampleRate, baseLatencyMs: ctx.baseLatency * 1000, outputLatencyMs: outLat, state: ctx.state,
      hasPlaybackStats: !!(ctx as any).playbackStats, hasRenderCapacity: !!(ctx as any).renderCapacity,
      soundBytes: { ...c.bank.encodedBytes, decodeMs: c.bank.decodeMs },
    },
    glitches: {
      detectorLate: d[D_LATE] - detBase[D_LATE], detectorLateSinceStart: d[D_LATE], detectorMaxExcessMs: d[D_MAX_EXCESS], detectorIdleBandMs: d[D_IDLE_EXCESS],
      playbackUnderrunEvents: ps.underrunEvents !== undefined ? ps.underrunEvents - (statsBase.underrunEvents ?? 0) : null,
      playbackUnderrunMs: ps.underrunDuration !== undefined ? (ps.underrunDuration - (statsBase.underrunDuration ?? 0)) * 1000 : null,
      playbackStats: ps, injected: d[D_INJECT] - detBase[D_INJECT], masterPeak: d[D_PEAK], clippedSamples: d[D_CLIP] - detBase[D_CLIP],
      renderCapacity: probe.nRc ? { n: probe.nRc, averageLoad: summ(rcL), peakLoadMax: Math.max(...rcP), underrunRatioMax: Math.max(...rcU) } : null,
    },
    latencyMs: {
      outputLatencyMs: outLat, pipelineDelayMs: (ctx.currentTime - (ctx.getOutputTimestamp().contextTime ?? 0)) * 1000,
      inputToSound: summ(lInRaw), inputToSoundPlusOutputLatency: summ(lIn),
      eventSoundVsFrameSubmit: summ(lEvRaw), eventSoundVsFrameSubmitPlusOutputLatency: summ(lEv),
      trackedMissing: missing,
      note: 'input: event.timeStamp to the start of the sound; the sound start is a context time mapped to performance time with the getOutputTimestamp() pair (the pair describes the sample at the device, so the mapped time already includes the render-ahead and the output latency: currentTime minus contextTime is pipelineDelayMs). PlusOutputLatency adds ctx.outputLatency on top, as the plan words it, which double counts if the mapping already includes it (an upper bound). event offset: the same sound time minus the submit time of the frame that first showed the event tick (frame submit, not display); positive = sound after picture.',
    },
    mainThreadAudioMsPerFrame: summ(audioMs), frameMs: summ(frameMs), frames: f1 - f0,
    audioThread,
    voices: { perFrame: summ(voices), maxActive: m[M_MAX_ACTIVE] },
    eventsPerSec: {
      voicesStarted: ev(M_STARTED), merged: ev(M_MERGED), droppedByVoiceLimit: ev(M_DROP_LIMIT), droppedByTotalLimit: ev(M_DROP_TOTAL), stolen: ev(M_STOLEN), culledQuiet: ev(M_CULLED),
      snapshotEventsDecoded: (evEnd.in - evBase.in) / benchSecs, playerInputSounds: (evEnd.player - evBase.player) / benchSecs,
    },
    eventsSkipped: { stale: evEnd.stale - evBase.stale, overCapacity: evEnd.overflow - evBase.overflow },
    stalls: probe.stalls, seconds: secs, wallSeconds: wallSecs,
    activeNow: m[M_ACTIVE],
    recording: (window as any).__recording ? { bytes: (window as any).__recording.bytes, mime: (window as any).__recording.mime } : null,
  };
}
