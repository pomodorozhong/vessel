// Stage 11 sim worker: Stage 8's combat sim (combat.wasm, pair finding A) stepped at 30 Hz with a scheduler that catches up
// after a late wake-up instead of dropping the time (Stage 8 found its one-step-per-wake driver fell behind under load).
// The wave script sets the live enemy and projectile counts each step. Each step's snapshot is copied out of WASM memory into
// a pooled ArrayBuffer and transferred to the main thread; the buildings list follows in a 'world' message when it changes.
// Everything recorded here is per step in preallocated arrays; the summary is computed only when the page asks for it.
export {};
const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

interface Cfg { mode: 'wave' | 'past'; start: number; peak: number; ramp: number; past: number; cap: number; projPerEnemy: number; method: number; passes: number; hz: number; seed: number; warmup: number; dur: number; simslow: number }
let cfg: Cfg;
let ex: any, mem: WebAssembly.Memory, ptr = 0, bptr = 0, blen = 0;
const pool: ArrayBuffer[] = [];
let period = 1000 / 30, next = 0, tick = 0, running = false, timer: ReturnType<typeof setTimeout> | 0 = 0;
const MAX_CATCHUP = 4;          // steps run back to back after a late wake-up
const DROP_AFTER = 8;           // more than this many steps behind: the lost time is dropped and counted

// Per-step records (capacity for the run plus margin).
let cap = 0, n = 0;
let stepMs: Float32Array, copyMs: Float32Array, postMs: Float32Array, lateMs: Float32Array, bytes: Uint32Array, enemiesRec: Uint32Array, projRec: Uint32Array, eventsRec: Uint32Array;
let wakes = 0, catchupSteps = 0, droppedSteps = 0, worldMsgs = 0, poolMisses = 0;
let memStart = 0;

// The map obstacles (blocked bit 0: the border, scattered cells and wall lines) never change, but the building list does not
// hold them, so the renderer would draw none of the walls the sim collides with. They are merged once into rectangles (greedy:
// widest run, then as many rows down as stay fully blocked) and appended after the buildings in every world message, so the
// building indices that EV_WALL_* carry stay valid.
const GRID = 256;
let obstacles: Float32Array = new Float32Array(0);
function obstacleBoxes(blocked: Uint8Array): Float32Array {
  const used = new Uint8Array(GRID * GRID), out: number[] = [];
  const free = (x: number, y: number) => (blocked[y * GRID + x] & 1) !== 0 && !used[y * GRID + x];
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    if (!free(x, y)) continue;
    let w = 1; while (x + w < GRID && free(x + w, y)) w++;
    let h = 1;
    for (; y + h < GRID; h++) { let ok = true; for (let k = 0; k < w; k++) if (!free(x + k, y + h)) { ok = false; break; } if (!ok) break; }
    for (let j = 0; j < h; j++) used.fill(1, (y + j) * GRID + x, (y + j) * GRID + x + w);
    out.push(x, y, x + w, y + h, 1);
  }
  return Float32Array.from(out);
}
function worldBoxes(): Float32Array {
  const w = new Float32Array(blen + obstacles.length);
  w.set(new Float32Array(mem.buffer, bptr, blen)); w.set(obstacles, blen);
  return w;
}

function waveEnemies(t: number): number {
  const c = cfg;
  if (t <= 0) return c.start;
  if (t < c.ramp) return Math.round(c.start + (c.peak - c.start) * (t / c.ramp));
  if (c.mode === 'past') return Math.min(c.cap, Math.round(c.peak + (t - c.ramp) * c.past / 60));
  return c.peak;
}

function stepOnce(due: number) {
  const t = tick / cfg.hz - cfg.warmup; // wave time: 0 when the bench starts
  const enemies = waveEnemies(t);
  ex.set_enemies(enemies);
  ex.set_target(Math.max(200, Math.round(enemies * cfg.projPerEnemy)));
  // Scripted player: walks a circle (Stage 8's script).
  const a = tick * ((Math.PI * 2) / (cfg.hz * 40));
  const t0 = performance.now();
  ex.step(Math.cos(a), Math.sin(a), 0);
  let t1 = performance.now();
  // simslow > 1 stands in for a slower CPU, which Chrome cannot emulate for workers: busy-wait (simslow - 1) x the step time.
  if (cfg.simslow > 1) { const until = t0 + (t1 - t0) * cfg.simslow; while (performance.now() < until) { /* spin */ } t1 = performance.now(); }
  tick++;
  // Copy the used part of the snapshot into a pooled buffer and send it.
  const used = ex.snapshot_used() as number;
  let buf = pool.pop();
  if (!buf || buf.byteLength < used) { if (buf) poolMisses++; buf = new ArrayBuffer(Math.max(used, 1 << 20)); }
  new Uint8Array(buf, 0, used).set(new Uint8Array(mem.buffer, ptr, used));
  const f64 = new Float64Array(buf, 56, 2);
  f64[1] = performance.timeOrigin + due;
  const u = new Uint32Array(buf, 0, 8), p = u[4], ev = u[5];
  const t2 = performance.now();
  f64[0] = performance.timeOrigin + t2; // step end as the main thread sees it: when it was sent
  let world: Float32Array | null = null;
  if (u[7] & 1) { world = worldBoxes(); worldMsgs++; }
  scope.postMessage({ type: 'snapshot', buffer: buf, world, enemies }, world ? [buf, world.buffer] : [buf]);
  const t3 = performance.now();
  if (n < cap) {
    stepMs[n] = t1 - t0; copyMs[n] = t2 - t1; postMs[n] = t3 - t2; lateMs[n] = t0 - due; bytes[n] = used;
    enemiesRec[n] = enemies; projRec[n] = p; eventsRec[n] = ev; n++;
  }
}

function loop() {
  if (!running) return;
  wakes++;
  let now = performance.now();
  if (now - next > DROP_AFTER * period) { droppedSteps += Math.floor((now - next) / period); next = now; }
  let k = 0;
  while (now >= next && k < MAX_CATCHUP) {
    const due = next;
    next += period;
    stepOnce(due);
    if (k > 0) catchupSteps++;
    k++;
    now = performance.now();
  }
  timer = setTimeout(loop, Math.max(0, next - performance.now()));
}

const pct = (s: Float32Array, p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
function summ(a: Float32Array | Uint32Array) {
  const s = Float32Array.from(a).sort();
  let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i];
  return { n: s.length, mean: sum / Math.max(1, s.length), median: s.length ? pct(s, 0.5) : NaN, p99: s.length ? pct(s, 0.99) : NaN, max: s.length ? s[s.length - 1] : NaN };
}

scope.onmessage = async (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'init') {
    cfg = d.cfg;
    period = 1000 / cfg.hz;
    const inst = await WebAssembly.instantiate(d.module as WebAssembly.Module, { env: { now: () => performance.now() } });
    ex = inst.exports; mem = ex.memory;
    // method, enemies (allocated), seed, spawn (0: the whole map), projectile target, projectile cap, event cap, passes, flags
    const projCap = Math.max(1000, Math.ceil(cfg.cap * cfg.projPerEnemy));
    ex.init(cfg.method, cfg.cap, cfg.seed, 64, 200, projCap, 32768, cfg.passes, 0);
    ex.set_enemies(cfg.start);
    ptr = ex.snapshot_ptr(); bptr = ex.buildings_ptr(); blen = ex.buildings_len();
    obstacles = obstacleBoxes(new Uint8Array(mem.buffer, ex.blocked_ptr(), GRID * GRID));
    memStart = mem.buffer.byteLength;
    cap = Math.ceil((cfg.warmup + cfg.dur + 30) * cfg.hz);
    stepMs = new Float32Array(cap); copyMs = new Float32Array(cap); postMs = new Float32Array(cap); lateMs = new Float32Array(cap);
    bytes = new Uint32Array(cap); enemiesRec = new Uint32Array(cap); projRec = new Uint32Array(cap); eventsRec = new Uint32Array(cap);
    // The first world message: the static buildings.
    const world = worldBoxes();
    scope.postMessage({ type: 'ready', world, maxEntities: cfg.cap + 1, maxProj: projCap, maxBuildings: world.length / 5, obstacleBoxes: obstacles.length / 5 });
  } else if (d.type === 'start') {
    running = true; next = performance.now(); loop();
  } else if (d.type === 'return') {
    pool.push(d.buffer);
  } else if (d.type === 'finish') {
    running = false; clearTimeout(timer as any);
    // Steps recorded from the bench start (the first warmup x hz steps are the warm-up).
    const s0 = Math.min(n, Math.round(cfg.warmup * cfg.hz));
    const sl = <T extends Float32Array | Uint32Array>(a: T) => a.subarray(s0, n) as T;
    scope.postMessage({ type: 'result', result: {
      steps: n - s0,
      stepMs: summ(sl(stepMs)), copyMs: summ(sl(copyMs)), postMs: summ(sl(postMs)), lateMs: summ(sl(lateMs)), snapshotBytes: summ(sl(bytes)),
      projectiles: summ(sl(projRec)), events: summ(sl(eventsRec)), enemies: summ(sl(enemiesRec)),
      wakes, catchupSteps, droppedSteps, worldMsgs, poolMisses,
      wasmMemory: { start: memStart, end: mem.buffer.byteLength },
    } });
  }
};
