// Stage 11 bench summary. Loaded with a dynamic import at the end of a run, so it sits in its own chunk (harness11-*.js) and
// the allocation measurement (scripts/run2/heap.mjs) counts it as harness, not game.
import { rec } from './rec11';
import { P11 } from './params11';

const BAR = { simP99: 4, encodeP99: 2, gpuP99: 10 }; // ms: the plan's pass bars (60% of 16.7 ms for the frame's GPU time)

function summ(a: ArrayLike<number>) {
  const s = Float64Array.from(a as ArrayLike<number>).filter((v) => Number.isFinite(v)).sort();
  if (!s.length) return { n: 0, mean: NaN, median: NaN, p99: NaN, max: NaN };
  let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i];
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, mean: sum / s.length, median: q(0.5), p99: q(0.99), max: s[s.length - 1] };
}
const pick = <T extends Float32Array | Float64Array | Uint32Array | Uint8Array>(a: T, n: number, keep: (i: number) => boolean) => { const o: number[] = []; for (let i = 0; i < n; i++) if (keep(i)) o.push(a[i]); return o; };

// Least-squares slope in units per minute.
function slopePerMin(t: ArrayLike<number>, v: ArrayLike<number>, n: number) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
  for (let i = 0; i < n; i++) { const x = t[i] / 60, y = v[i]; if (!Number.isFinite(y)) continue; sx += x; sy += y; sxx += x * x; sxy += x * y; k++; }
  return k > 2 ? (k * sxy - sx * sy) / (k * sxx - sx * sx) : NaN;
}

export function summarize(x: Record<string, any>) {
  const r = rec, nF = r.nF, nS = r.nS, nG = r.nG;
  const all = () => true;
  const frames = {
    frameMs: summ(r.fDt.subarray(1, nF)),
    framesOver20ms: pick(r.fDt, nF, all).filter((v) => v > 20).length,
    framesOver34ms: pick(r.fDt, nF, all).filter((v) => v > 34).length,
    count: nF,
  };
  const inputs = pick(r.fInput, nF, (i) => r.fInput[i] >= 0);
  const mainThread = {
    total: summ(r.fCpu.subarray(0, nF)),
    snapshotReceive: summ(r.fRecv.subarray(0, nF)),
    snapshotUpload: summ(r.fUpload.subarray(0, nF)),
    encode: summ(r.fEncode.subarray(0, nF)),
    audio: summ(r.fAudio.subarray(0, nF)),
    ui: summ(r.fUi.subarray(0, nF)),
    other: summ(Array.from({ length: nF }, (_, i) => r.fCpu[i] - r.fUpload[i] - r.fEncode[i] - r.fAudio[i] - r.fUi[i])),
    note: 'per frame; snapshotReceive is the onmessage handling between frames (director copy + clock queue), outside the frame total; ui is the debug overlay DOM only (HUD, health bars and damage numbers are GPU passes)',
  };
  const gpu = summ(r.gMs.subarray(0, nG));
  const heapMB = Array.from(r.mHeap.subarray(0, r.nM), (v) => v / 1048576);
  const memory = {
    heapStartMB: heapMB[0], heapEndMB: heapMB[heapMB.length - 1], heapMaxMB: Math.max(...heapMB), samples: heapMB.length,
    heapSlopeMBPerMin: slopePerMin(r.mT, heapMB, heapMB.length),
    // The first and last minute's median, which ignores the GC sawtooth.
    heapFirstMinMedianMB: summ(heapMB.filter((_, i) => r.mT[i] < 60)).median, heapLastMinMedianMB: summ(heapMB.filter((_, i) => r.mT[i] >= (x.config.dur - 60))).median,
  };
  const handoff = {
    transitMs: summ(r.sTransit.subarray(0, nS)), snapshots: nS, worldMessages: pick(r.sWorld, nS, all).filter((v) => v).length,
    simStepMsSeenByPage: summ(r.sStep.subarray(0, nS)),
    projectiles: summ(r.sP.subarray(0, nS)), events: summ(r.sE.subarray(0, nS)),
  };
  // Windows: every budget per window, for the ramp record and to find which budget breaks first.
  const W = P11.window, nW = Math.ceil(P11.dur / W);
  const windows: Record<string, number>[] = [];
  const first: Record<string, number | null> = { sim: null, encode: null, gpu: null, pausesJumps: null, audio: null };
  let lateBefore = r.nF ? r.fLate[0] : 0;
  for (let w = 0; w < nW; w++) {
    const a = w * W, b = a + W;
    const fin = (t: number) => t >= a && t < b;
    const fi = pick(Float32Array.from({ length: nF }, (_, i) => i), nF, (i) => fin(r.fT[i]));
    if (!fi.length) continue;
    const si = pick(Float32Array.from({ length: nS }, (_, i) => i), nS, (i) => fin(r.sT[i]));
    const gi = pick(Float32Array.from({ length: nG }, (_, i) => i), nG, (i) => fin(r.gT[i]));
    const lateEnd = r.fLate[fi[fi.length - 1]];
    const row = {
      t: a,
      enemies: summ(si.map((i) => r.sEnemies[i])).median,
      projectiles: summ(si.map((i) => r.sP[i])).median,
      events: summ(si.map((i) => r.sE[i])).mean,
      simP99: summ(si.map((i) => r.sStep[i])).p99,
      encodeP99: summ(fi.map((i) => r.fEncode[i])).p99,
      cpuP99: summ(fi.map((i) => r.fCpu[i])).p99,
      gpuP99: summ(gi.map((i) => r.gMs[i])).p99,
      frameP99: summ(fi.map((i) => r.fDt[i])).p99,
      pausesJumps: fi.filter((i) => r.fAnom[i] > 0).length,
      audioLate: lateEnd - lateBefore,
    };
    lateBefore = lateEnd;
    windows.push(row);
    if (first.sim === null && row.simP99 > BAR.simP99) first.sim = a;
    if (first.encode === null && row.encodeP99 > BAR.encodeP99) first.encode = a;
    if (first.gpu === null && row.gpuP99 > BAR.gpuP99) first.gpu = a;
    if (first.pausesJumps === null && row.pausesJumps > 0) first.pausesJumps = a;
    if (first.audio === null && row.audioLate > 0) first.audio = a;
  }
  const order = Object.entries(first).filter(([, v]) => v !== null).sort((p, q) => (p[1] as number) - (q[1] as number));
  return {
    ...x, url: location.href, frames, mainThread, gpuMs: gpu, gpuSamples: nG, memory, handoff,
    inputToSubmitMs: summ(inputs), inputSamples: inputs.length,
    windows, firstBreak: { bars: BAR, firstWindowStart: first, order: order.map(([k, v]) => ({ budget: k, at: v, enemies: windows.find((wr) => wr.t === v)?.enemies ?? null })) },
    gpuUpFrames: pick(r.fGpuUp, nF, all).filter((v) => v).length,
  };
}
