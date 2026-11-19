// Runs the sim behind one interface, so the same driver works in the worker and on the main thread.
import { HEADER_BYTES, wallNow } from './protocol';
import type { InputState } from './protocol';
import { SimTs } from './sim-ts';

export interface Backend {
  step(moveX: number, moveY: number, buttons: number): void;
  snapshot(): Uint8Array; // view of the current snapshot (header + entries); valid until the next step
  blocked(): Uint8Array; // copy of the obstacle grid (256 x 256 cells)
  stats?(): { pairsTested: number; pairsHit: number; flowRebuilds: number; checksum: number };
}

export async function createBackend(kind: string, module: WebAssembly.Module | null, n: number, seed: number, spawn = 0): Promise<Backend> {
  if (kind === 'ts') {
    const s = new SimTs(n, seed, spawn);
    return { blocked: () => s.blocked.slice(), step: (x, y, b) => s.step(x, y, b), snapshot: () => s.snapshot(), stats: () => ({ pairsTested: s.pairsTested, pairsHit: s.pairsHit, flowRebuilds: s.flowRebuilds, checksum: s.checksum() }) };
  }
  const instance = await WebAssembly.instantiate(module!, { env: { now: () => performance.now() } });
  const ex = instance.exports as any;
  ex.init(n, seed, spawn);
  const memory = ex.memory as WebAssembly.Memory;
  let view = new Uint8Array(memory.buffer, ex.snapshot_ptr(), ex.snapshot_len());
  return {
    blocked: () => new Uint8Array(memory.buffer, ex.blocked_ptr(), 65536).slice(),
    step: (x, y, b) => ex.step(x, y, b),
    // The view is reused; it is only rebuilt if WASM memory grew (it never does after init).
    snapshot: () => (view.buffer === memory.buffer ? view : (view = new Uint8Array(memory.buffer, ex.snapshot_ptr(), ex.snapshot_len()))),
    stats: () => ({ pairsTested: ex.pairs_tested(), pairsHit: ex.pairs_hit(), flowRebuilds: ex.flow_rebuilds(), checksum: ex.checksum() }),
  };
}

export interface HostOptions { n: number; hz: number; script: number; bench: boolean; dur: number; warmup: number }

const pct = (sorted: Float32Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
export function summarize(values: Float32Array) {
  const s = values.slice().sort();
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i];
  return { n: s.length, mean: sum / Math.max(1, s.length), median: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), p999: pct(s, 0.999), max: s.length ? s[s.length - 1] : NaN };
}

// Steps the sim on a fixed timestep from a timer and hands each snapshot to `emit`.
// Used unchanged by the worker and by the main-thread comparison mode.
export class SimHost {
  tick = 0;
  input: InputState = { seq: 0, moveX: 0, moveY: 0, buttons: 0, t: 0 };
  skipped = 0;
  delayMs = 0;
  pool: ArrayBuffer[] = [];
  onResult: ((r: unknown) => void) | null = null;
  private period: number;
  private next = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;
  // Bench recording: preallocated, so recording does not allocate in the loop.
  private recSim: Float32Array;   // step time measured inside the sim
  private recHost: Float32Array;  // whole cost per step on this thread: step + copy into the pool buffer + postMessage
  private recLate: Float32Array;  // how late the step started against its due time
  private recN = 0;
  private sums = new Float64Array(8); // collision, flow, ai, snapshot write, move+sort, pairs tested, pairs hit, copy+post
  private benchStartTick = -1;
  private benchEndTick = -1;

  constructor(public backend: Backend, public opt: HostOptions, private emit: (buffer: ArrayBuffer) => void, private scheduleLate: (fn: () => void, ms: number) => void = (fn, ms) => setTimeout(fn, ms)) {
    this.period = 1000 / opt.hz;
    const cap = opt.bench ? Math.ceil(opt.dur * opt.hz) + 16 : 1;
    this.recSim = new Float32Array(cap); this.recHost = new Float32Array(cap); this.recLate = new Float32Array(cap);
    if (opt.bench) { this.benchStartTick = Math.round(opt.warmup * opt.hz); this.benchEndTick = this.benchStartTick + Math.round(opt.dur * opt.hz); }
  }

  start() { this.running = true; this.next = performance.now(); this.loop(); }
  stop() { this.running = false; clearTimeout(this.timer as any); }

  private loop = () => {
    if (!this.running) return;
    let now = performance.now();
    if (now - this.next > this.period * 4) this.next = now; // fell far behind (a stall): drop the lost time, never spiral
    if (now >= this.next) {
      const due = this.next;
      this.next += this.period;
      this.stepOnce(now, due);
      now = performance.now();
    }
    this.timer = setTimeout(this.loop, Math.max(0, this.next - now));
  };

  private stepOnce(now: number, due: number) {
    let { moveX, moveY, buttons } = this.input;
    if (this.opt.script) {
      // Scripted player: walks a circle so the flow field keeps being rebuilt. Same for every sim variant.
      const a = this.tick * (Math.PI * 2 / (this.opt.hz * 40));
      moveX = Math.cos(a); moveY = Math.sin(a); buttons = 0;
    }
    this.backend.step(moveX, moveY, buttons);
    const tStep = performance.now();
    this.tick++;
    const snap = this.backend.snapshot();
    const target = this.pool.pop();
    if (target) {
      new Uint8Array(target).set(snap);
      const dv = new DataView(target);
      dv.setUint32(12, this.input.seq, true);
      dv.setFloat64(48, wallNow(), true);
      dv.setFloat64(56, performance.timeOrigin + due, true);
      if (this.delayMs > 0) this.scheduleLate(() => this.emit(target), Math.random() * this.delayMs);
      else this.emit(target);
    } else this.skipped++;
    const tEnd = performance.now();

    if (this.tick > this.benchStartTick && this.tick <= this.benchEndTick) {
      const f = new Float32Array(snap.buffer, snap.byteOffset, HEADER_BYTES / 4);
      const i = this.recN++;
      this.recSim[i] = f[4]; this.recHost[i] = tEnd - now; this.recLate[i] = now - due;
      const s = this.sums, st = this.backend.stats?.();
      s[0] += f[5]; s[1] += f[6]; s[2] += f[7]; s[3] += f[8]; s[4] += f[9];
      if (st) { s[5] += st.pairsTested; s[6] += st.pairsHit; }
      s[7] += tEnd - tStep;
      if (this.tick === this.benchEndTick) this.finish();
    }
  }

  private finish() {
    const n = this.recN, s = this.sums;
    const sim = summarize(this.recSim.subarray(0, n));
    const total = sim.mean * n;
    const st = this.backend.stats?.();
    this.onResult?.({
      steps: n, hz: this.opt.hz, entities: this.opt.n, skipped: this.skipped,
      simMs: sim,
      hostMs: summarize(this.recHost.subarray(0, n)),
      lateMs: summarize(this.recLate.subarray(0, n)),
      share: { collision: s[0] / total, flowField: s[1] / total, ai: s[2] / total, snapshotWrite: s[3] / total, moveAndSort: s[4] / total },
      meanMs: { collision: s[0] / n, flowField: s[1] / n, ai: s[2] / n, snapshotWrite: s[3] / n, moveAndSort: s[4] / n, copyAndPost: s[7] / n },
      pairsTestedPerStep: s[5] / n, pairsHitPerStep: s[6] / n,
      flowRebuilds: st?.flowRebuilds, checksum: st?.checksum,
    });
  }
}
