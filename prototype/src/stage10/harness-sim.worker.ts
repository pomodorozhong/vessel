// Stage 10 test harness: a scripted stand-in for Stage 8's combat sim. It posts snapshots in the run 2 (v2)
// layout at a fixed rate, with a configurable number of events per second, until the real sim is ready.
// Entities and projectiles are not generated (N = 1, P = 0): the mixer only needs the header and the event section.
// Buffers come back from the main thread through a pool, as in Stage 2.
import { EV_DEATH, EV_EXPLOSION, EV_HIT, EV_PICKUP, EV_PLAYER_HURT, EV_SHOT, EV_WALL_BUILT, EV_WALL_REMOVED, V2_ENTITY_BYTES, V2_EVENT_BYTES, V2_HEADER_BYTES, v2SnapshotBytes } from '../run2/protocol';

const MAXE = 512;
let rate = 300, hz = 30, seed = 1, tick = 0, acc = 0, t0 = 0;
const pool: ArrayBuffer[] = [];
let s = 1;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
// Event mix per second at rate = 100%: shots (10% of them the player's own), hits, deaths, explosions, pickups, wall events, player hurt.
const W = [[EV_SHOT, 0.15], [EV_HIT, 0.45], [EV_DEATH, 0.14], [EV_EXPLOSION, 0.03], [EV_PICKUP, 0.12], [EV_WALL_BUILT, 0.01], [EV_WALL_REMOVED, 0.01], [EV_PLAYER_HURT, 0.02]] as const;
const pick = () => { let r = rnd(); for (const [t, w] of W) { if ((r -= w) < 0) return t; } return EV_HIT; };

function step() {
  const buf = pool.pop() ?? new ArrayBuffer(v2SnapshotBytes(1, 0, MAXE));
  const u = new Uint32Array(buf), f = new Float32Array(buf), f64 = new Float64Array(buf, 56, 2);
  // Events this step: the mean is rate / hz, with every tenth step three times as busy (waves of hits).
  acc += rate / hz * (rnd() < 0.1 ? 2.2 : 0.8);
  let e = Math.min(MAXE, Math.floor(acc)); acc -= e;
  const px = 40 * Math.cos(tick * 0.01), py = 40 * Math.sin(tick * 0.01);
  u[0] = tick; u[1] = tick + 1; u[2] = 1; u[3] = 0; u[4] = 0; u[5] = e; u[6] = 0; u[7] = 0;
  f[8] = px; f[9] = py; f[10] = px; f[11] = py; f[12] = 1; u[13] = 0;
  f64[0] = performance.timeOrigin + performance.now(); f64[1] = performance.timeOrigin + t0 + (tick + 1) * 1000 / hz;
  // The one entity: the player.
  const eo = V2_HEADER_BYTES; f[eo / 4] = px; f[eo / 4 + 1] = py; f[eo / 4 + 2] = px; f[eo / 4 + 3] = py;
  const o = (V2_HEADER_BYTES + V2_ENTITY_BYTES) / 4;
  for (let i = 0; i < e; i++) {
    const type = pick(), kind = Math.floor(rnd() * 7), owner = type === EV_SHOT ? (rnd() < 0.1 ? 0 : 1) : 0;
    const val = type === EV_HIT ? 1 + rnd() * rnd() * 14 : type === EV_EXPLOSION ? 2 + rnd() * 4 : 0;
    const b = o + i * (V2_EVENT_BYTES / 4);
    u[b] = type | (kind << 8) | (owner << 16);
    f[b + 1] = px + (rnd() + rnd() + rnd() - 1.5) * 40; f[b + 2] = py + (rnd() + rnd() + rnd() - 1.5) * 40; f[b + 3] = val;
  }
  tick++;
  (self as any).postMessage({ type: 'snapshot', buffer: buf }, [buf]);
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    rate = d.rate; hz = d.hz; seed = d.seed; s = (seed * 2654435761) >>> 0 || 1; t0 = performance.now();
    // Drift-corrected timer: wake every few ms and emit every step that is due.
    setInterval(() => { const now = performance.now(); while (t0 + tick * 1000 / hz <= now) step(); }, 4);
  } else if (d.type === 'return') pool.push(d.buffer);
};
