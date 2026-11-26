// Stage 8 bench runner: steps the combat sim (combat.wasm or combat-rapier.wasm) at a fixed rate, records per-step
// total and phase times and the snapshot's counters, and summarises them. Used unchanged by the page (thread=main,
// the mode that throttled runs use) and by the worker (thread=worker).
import { EV_TYPES, V2_ENTITY_BYTES, V2_EVENT_BYTES, V2_HEADER_BYTES, V2_PROJECTILE_BYTES } from '../run2/protocol';

export interface Config {
  method: 'A' | 'B' | 'C' | 'rapier';
  enemies: number;
  proj: number; // target live projectiles
  passes: number; // pushing passes per step (the Rapier build: solver iterations)
  dur: number; // recorded seconds
  warmup: number; // seconds before recording starts
  seed: number;
  spawn: number; // enemies start inside a square of this half-size around the player
  check: boolean; // slow exact reference check of every projectile sweep
  sweep: boolean; // false: debug, test projectiles at their end point only
  hz: number;
  evcap: number; // event capacity
  projcap: number; // projectile pool capacity (0 = max(target, 1000))
}

// Header f32[18 + k]; index 0 is the whole step (without the reference check), 12 is the reference check itself.
export const PHASES = ['step', 'pairFinding', 'exactChecks', 'crowdPushing', 'projectiles', 'areaEffects', 'flowField', 'ai', 'integrateSort', 'snapshotWrite', 'obstacles', 'buildingUpdates', 'referenceCheck'] as const;
export const EVENT_NAMES = ['shot', 'hit', 'death', 'explosion', 'pickup', 'wallBuilt', 'wallRemoved', 'playerHurt'] as const;
const STAT = { passThrough: 0, falseHit: 1, checked: 2, deaths: 3, pairsTested: 4, pairsHit: 5, pairsCand: 6, flowRebuilds: 7, projHits: 8, shots: 9, orderMoves: 11, hitsEnemy: 12, hitsWall: 13, hitsPlayer: 14, explosions: 15, graze: 16 };

const pct = (s: Float32Array, p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
export function summarize(values: ArrayLike<number>) {
  const s = Float32Array.from(values as ArrayLike<number>).sort();
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i];
  return { n: s.length, mean: sum / Math.max(1, s.length), median: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: s.length ? s[s.length - 1] : NaN, min: s.length ? s[0] : NaN };
}

export class Stage8Runner {
  private ex: any;
  private mem: WebAssembly.Memory;
  private period: number;
  private next = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;
  private tick = 0;
  private recStart: number;
  private recEnd: number;
  private recN = 0;
  private lastBuf: ArrayBuffer | null = null;
  private u32!: Uint32Array;
  private f32!: Float32Array;
  private ptr = 0;
  private n = 0;
  // Recordings, one value per recorded step.
  private phase: Float32Array[] = [];
  private wall: Float32Array;
  private late: Float32Array;
  private live: Uint32Array;
  private evTotal: Uint32Array;
  private evType: Uint32Array[] = [];
  private dropped: Uint32Array;
  private snapBytes: Uint32Array;
  private pairsTested: Float32Array;
  private pairsCand: Float32Array;
  private pairsHit: Float32Array;
  private orderMoves: Float32Array;
  private memoryStart = 0;
  private deathsAtStart = 0;
  private statsAtStart: number[] = [];
  private worldChanges = 0;
  private mainThread: boolean;
  onProgress: ((tick: number, total: number) => void) | null = null;
  onResult: ((r: unknown) => void) | null = null;

  private constructor(private cfg: Config, ex: any, mainThread: boolean) {
    this.ex = ex;
    this.mem = ex.memory;
    this.mainThread = mainThread;
    this.period = 1000 / cfg.hz;
    this.recStart = Math.round(cfg.warmup * cfg.hz);
    this.recEnd = this.recStart + Math.round(cfg.dur * cfg.hz);
    const cap = this.recEnd - this.recStart + 4;
    for (let k = 0; k < PHASES.length; k++) this.phase.push(new Float32Array(cap));
    for (let t = 0; t < EV_TYPES; t++) this.evType.push(new Uint32Array(cap));
    this.wall = new Float32Array(cap);
    this.late = new Float32Array(cap);
    this.live = new Uint32Array(cap);
    this.evTotal = new Uint32Array(cap);
    this.dropped = new Uint32Array(cap);
    this.snapBytes = new Uint32Array(cap);
    this.pairsTested = new Float32Array(cap);
    this.pairsCand = new Float32Array(cap);
    this.pairsHit = new Float32Array(cap);
    this.orderMoves = new Float32Array(cap);
  }

  static async create(cfg: Config, module: WebAssembly.Module, mainThread: boolean): Promise<Stage8Runner> {
    const instance = await WebAssembly.instantiate(module, { env: { now: () => performance.now() } });
    const ex = instance.exports as any;
    const flags = (cfg.check ? 1 : 0) | (cfg.sweep ? 0 : 2);
    const method = cfg.method === 'B' ? 1 : cfg.method === 'C' ? 2 : 0; // the Rapier build ignores it
    // method, enemies, seed, spawn, proj target, proj cap, event cap, passes, flags
    ex.init(method, cfg.enemies, cfg.seed, cfg.spawn, cfg.proj, cfg.projcap || Math.max(cfg.proj, 1000), cfg.evcap, cfg.passes, flags);
    const r = new Stage8Runner(cfg, ex, mainThread);
    r.n = cfg.enemies + 1;
    r.ptr = ex.snapshot_ptr();
    r.memoryStart = (ex.memory as WebAssembly.Memory).buffer.byteLength;
    return r;
  }

  start() {
    this.running = true;
    this.next = performance.now();
    this.loop();
  }
  stop() {
    this.running = false;
    clearTimeout(this.timer as any);
  }

  private loop = () => {
    if (!this.running) return;
    let now = performance.now();
    if (now - this.next > this.period * 4) this.next = now; // fell far behind: drop the lost time, never spiral
    if (now >= this.next) {
      const due = this.next;
      this.next += this.period;
      this.stepOnce(now, due);
      now = performance.now();
    }
    if (this.running) this.timer = setTimeout(this.loop, Math.max(0, this.next - now));
  };

  private views() {
    const buf = this.mem.buffer;
    if (buf !== this.lastBuf) {
      this.lastBuf = buf;
      this.u32 = new Uint32Array(buf, this.ptr, this.ex.snapshot_len() >> 2);
      this.f32 = new Float32Array(buf, this.ptr, this.ex.snapshot_len() >> 2);
    }
  }

  private stepOnce(now: number, due: number) {
    // Scripted player: walks a circle so the flow field keeps being rebuilt (the same script as run 1).
    const a = this.tick * ((Math.PI * 2) / (this.cfg.hz * 40));
    const t0 = performance.now();
    this.ex.step(Math.cos(a), Math.sin(a), 0);
    const t1 = performance.now();
    this.tick++;
    if (this.tick === this.recStart) {
      this.deathsAtStart = this.ex.stat(STAT.deaths);
      this.statsAtStart = [STAT.shots, STAT.projHits, STAT.hitsEnemy, STAT.hitsWall, STAT.hitsPlayer, STAT.explosions].map((i) => this.ex.stat(i));
    }
    if (this.tick > this.recStart && this.tick <= this.recEnd) {
      this.views();
      const u = this.u32, f = this.f32;
      const i = this.recN++;
      for (let k = 0; k < PHASES.length; k++) this.phase[k][i] = f[18 + k];
      this.wall[i] = t1 - t0;
      this.late[i] = now - due;
      const p = u[4], e = u[5];
      this.live[i] = p;
      this.evTotal[i] = e;
      this.dropped[i] = u[6];
      if (u[7] & 1) this.worldChanges++;
      this.snapBytes[i] = this.ex.snapshot_used();
      // Events by type.
      const w0 = (V2_HEADER_BYTES + V2_ENTITY_BYTES * this.n + V2_PROJECTILE_BYTES * p) >> 2;
      const counts = [0, 0, 0, 0, 0, 0, 0, 0];
      const step = V2_EVENT_BYTES >> 2;
      for (let q = 0; q < e; q++) {
        const ty = u[w0 + q * step] & 0xff;
        if (ty < EV_TYPES) counts[ty]++;
      }
      for (let t = 0; t < EV_TYPES; t++) this.evType[t][i] = counts[t];
      this.pairsTested[i] = this.ex.stat(STAT.pairsTested);
      this.pairsCand[i] = this.ex.stat(STAT.pairsCand);
      this.pairsHit[i] = this.ex.stat(STAT.pairsHit);
      this.orderMoves[i] = this.ex.stat(STAT.orderMoves);
      if (this.tick % 150 === 0) this.onProgress?.(this.tick, this.recEnd);
      if (this.tick === this.recEnd) {
        this.stop();
        this.onResult?.(this.finish());
      }
    }
  }

  private finish() {
    const n = this.recN;
    const sl = (a: Float32Array | Uint32Array) => a.subarray(0, n);
    const stepSum = summarize(sl(this.phase[0]));
    const phases: Record<string, unknown> = {};
    for (let k = 1; k < PHASES.length; k++) {
      const s = summarize(sl(this.phase[k]));
      phases[PHASES[k]] = { ...s, share: k === PHASES.length - 1 ? undefined : s.mean / stepSum.mean };
    }
    const events: Record<string, unknown> = { total: summarize(sl(this.evTotal)) };
    for (let t = 0; t < EV_TYPES; t++) events[EVENT_NAMES[t]] = summarize(sl(this.evType[t]));
    const ex = this.ex;
    const d = (i: number, k: number) => ex.stat(i) - this.statsAtStart[k];
    const dropped = this.dropped.subarray(0, n);
    let dropSum = 0, dropSteps = 0, dropMax = 0;
    for (let i = 0; i < n; i++) {
      dropSum += dropped[i];
      if (dropped[i] > 0) dropSteps++;
      if (dropped[i] > dropMax) dropMax = dropped[i];
    }
    return {
      config: this.cfg,
      thread: this.mainThread ? 'main' : 'worker',
      steps: n,
      stepMs: stepSum, // time inside the sim, reference check excluded
      wallStepMs: summarize(sl(this.wall)), // as seen from JS around step(), reference check included
      lateMs: summarize(sl(this.late)),
      phases,
      liveProjectiles: summarize(sl(this.live)),
      events,
      droppedEvents: { total: dropSum, stepsWithDrops: dropSteps, max: dropMax },
      passThroughs: { total: ex.stat(STAT.passThrough), falseHits: ex.stat(STAT.falseHit), grazes: ex.stat(STAT.graze), checked: ex.stat(STAT.checked), checkEnabled: this.cfg.check, sweep: this.cfg.sweep },
      pairs: { tested: summarize(sl(this.pairsTested)).mean, candidates: summarize(sl(this.pairsCand)).mean, hit: summarize(sl(this.pairsHit)).mean },
      orderMoves: summarize(sl(this.orderMoves)),
      deaths: { inWindow: ex.stat(STAT.deaths) - this.deathsAtStart, perSecond: (ex.stat(STAT.deaths) - this.deathsAtStart) / this.cfg.dur },
      projectileOutcomes: { shots: d(STAT.shots, 0), hits: d(STAT.projHits, 1), hitsEnemy: d(STAT.hitsEnemy, 2), hitsWall: d(STAT.hitsWall, 3), hitsPlayer: d(STAT.hitsPlayer, 4), explosions: d(STAT.explosions, 5) },
      snapshotBytes: summarize(sl(this.snapBytes)),
      worldChanges: this.worldChanges,
      flowRebuilds: ex.stat(STAT.flowRebuilds),
      wasmMemory: { start: this.memoryStart, end: this.mem.buffer.byteLength },
      checksum: ex.checksum(),
    };
  }
}
