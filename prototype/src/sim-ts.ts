// The Stage 1 sim in careful typed-array TypeScript: the same algorithm as prototype/sim/src/lib.rs,
// line for line where the languages allow, with no allocation in step(). Keep the two in step.
import { ENTRY_BYTES, HEADER_BYTES } from './protocol';

const GRID = 256;
const CELLS = GRID * GRID;
const DT = 1 / 30;
const THINK_EVERY = 8;
const FLOW_BUDGET = 16384;
const KINDS = 16;
const PLAYER_KIND = 16;
const PLAYER_SPEED = 5;
const PLAYER_RADIUS = 0.4;
const TURN_RATE = 0.35;
const UNREACHED = 0xffff;
const PI = Math.PI, TAU = Math.PI * 2;

// Neighbour offsets as flat typed arrays (no per-step tuples).
const N4X = new Int32Array([1, -1, 0, 0]);
const N4Y = new Int32Array([0, 0, 1, -1]);
const N8X = new Int32Array([1, -1, 0, 0, 1, -1, 1, -1]);
const N8Y = new Int32Array([0, 0, 1, -1, 1, 1, -1, -1]);

class Table {
  x: Float32Array; y: Float32Array; px: Float32Array; py: Float32Array;
  vx: Float32Array; vy: Float32Array; facing: Float32Array; pfacing: Float32Array;
  tfacing: Float32Array; radius: Float32Array; kind: Uint32Array; id: Uint32Array;
  constructor(n: number) {
    const m = (n + 3) & ~3;
    this.x = new Float32Array(m); this.y = new Float32Array(m);
    this.px = new Float32Array(m); this.py = new Float32Array(m);
    this.vx = new Float32Array(m); this.vy = new Float32Array(m);
    this.facing = new Float32Array(m); this.pfacing = new Float32Array(m);
    this.tfacing = new Float32Array(m); this.radius = new Float32Array(m);
    this.kind = new Uint32Array(m); this.id = new Uint32Array(m);
  }
}

function cellIndex(x: number, y: number): number {
  let cx = x | 0, cy = y | 0;
  if (cx < 0) cx = 0; else if (cx > GRID - 1) cx = GRID - 1;
  if (cy < 0) cy = 0; else if (cy > GRID - 1) cy = GRID - 1;
  return cy * GRID + cx;
}

function hash(a: number, b: number): number {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0xc2b2ae3d);
  return (h ^ (h >>> 13)) >>> 0;
}

export class SimTs {
  private n: number;
  private tick = 0;
  private a: Table;
  private b: Table;
  private cellOf: Uint32Array;
  private cellStart = new Uint32Array(CELLS + 1);
  private cursor = new Uint32Array(CELLS);
  blocked = new Uint8Array(CELLS);
  private dist = new Uint16Array(CELLS).fill(UNREACHED);
  private distBack = new Uint16Array(CELLS).fill(UNREACHED);
  private queue = new Uint32Array(CELLS);
  private qHead = 0;
  private qTail = 0;
  private building = false;
  private goalCell = 0;
  private playerSlot = 0;
  private snap: ArrayBuffer;
  private snapF: Float32Array;
  private snapU: Uint32Array;
  private snapBytes: Uint8Array;
  private flowX = 0;
  private flowY = 0;
  pairsTested = 0;
  pairsHit = 0;
  flowRebuilds = 0;

  constructor(n: number, seed: number, spawnRadius = 0) {
    this.n = n;
    let rs = Math.max(1, Math.imul(seed, 2654435761) >>> 0);
    const next = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs; };
    const unit = () => Math.fround((next() >>> 8) / 16777216);
    const blocked = this.blocked;
    for (let i = 0; i < GRID; i++) {
      blocked[i] = 1; blocked[(GRID - 1) * GRID + i] = 1; blocked[i * GRID] = 1; blocked[i * GRID + GRID - 1] = 1;
    }
    const centre = GRID / 2;
    const block = (cx: number, cy: number) => {
      if (cx < 1 || cy < 1 || cx >= GRID - 1 || cy >= GRID - 1) return;
      if (Math.abs(cx - centre) < 4 && Math.abs(cy - centre) < 4) return;
      blocked[cy * GRID + cx] = 1;
    };
    for (let k = 0; k < 1800; k++) {
      const cx = Math.fround(unit() * GRID) | 0;
      const cy = Math.fround(unit() * GRID) | 0;
      block(cx, cy);
    }
    for (let k = 0; k < 120; k++) {
      const cx = Math.fround(unit() * GRID) | 0;
      const cy = Math.fround(unit() * GRID) | 0;
      const len = 3 + (next() % 8);
      const horizontal = (next() & 1) === 0;
      for (let j = 0; j < len; j++) { if (horizontal) block(cx + j, cy); else block(cx, cy + j); }
    }
    const a = this.a = new Table(n);
    this.b = new Table(n);
    a.x[0] = centre + 0.5; a.y[0] = centre + 0.5; a.radius[0] = PLAYER_RADIUS; a.kind[0] = PLAYER_KIND; a.id[0] = 0;
    for (let i = 1; i < n; i++) {
      for (;;) {
        let x = Math.fround(1 + Math.fround(unit() * (GRID - 2)));
        let y = Math.fround(1 + Math.fround(unit() * (GRID - 2)));
        if (spawnRadius > 0) {
          x = Math.fround(centre + (x / GRID - 0.5) * 2 * spawnRadius);
          y = Math.fround(centre + (y / GRID - 0.5) * 2 * spawnRadius);
        }
        if (blocked[cellIndex(x, y)] === 0) { a.x[i] = x; a.y[i] = y; break; }
      }
      const kind = i % KINDS;
      a.kind[i] = kind;
      a.radius[i] = 0.25 + 0.015 * kind;
      a.id[i] = i;
      a.facing[i] = unit() * 6.2831853;
      a.tfacing[i] = a.facing[i];
    }
    for (let i = 0; i < n; i++) { a.px[i] = a.x[i]; a.py[i] = a.y[i]; a.pfacing[i] = a.facing[i]; }
    this.cellOf = new Uint32Array(n);
    this.snap = new ArrayBuffer(HEADER_BYTES + ENTRY_BYTES * n);
    this.snapF = new Float32Array(this.snap);
    this.snapU = new Uint32Array(this.snap);
    this.snapBytes = new Uint8Array(this.snap);
    const pc = cellIndex(a.x[0], a.y[0]);
    this.flowStart(pc);
    this.flowAdvance(0x7fffffff);
    this.sortByCell();
  }

  private flowStart(goal: number) {
    this.distBack.fill(UNREACHED);
    this.distBack[goal] = 0;
    this.queue[0] = goal;
    this.qHead = 0; this.qTail = 1;
    this.building = true;
    this.goalCell = goal;
  }

  private flowAdvance(budget: number) {
    if (!this.building) return;
    const queue = this.queue, distBack = this.distBack, blocked = this.blocked;
    let head = this.qHead, tail = this.qTail, done = 0;
    while (head < tail && done < budget) {
      const c = queue[head++];
      done++;
      const d = distBack[c] + 1;
      const cx = c % GRID, cy = (c / GRID) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + N4X[k], ny = cy + N4Y[k];
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const nc = ny * GRID + nx;
        if (blocked[nc] !== 0 || distBack[nc] !== UNREACHED) continue;
        distBack[nc] = d;
        queue[tail++] = nc;
      }
    }
    this.qHead = head; this.qTail = tail;
    if (head === tail) {
      const t = this.dist; this.dist = this.distBack; this.distBack = t;
      this.building = false;
      this.flowRebuilds++;
    }
  }

  // Writes the direction into flowX/flowY (no tuple allocation).
  private flowDir(c: number) {
    const dist = this.dist, blocked = this.blocked;
    const cx = c % GRID, cy = (c / GRID) | 0;
    let best = dist[c], bx = 0, by = 0;
    for (let k = 0; k < 8; k++) {
      const dx = N8X[k], dy = N8Y[k];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const d = dist[ny * GRID + nx];
      if (d >= best) continue;
      if (dx !== 0 && dy !== 0) {
        if (blocked[cy * GRID + nx] !== 0 || blocked[ny * GRID + cx] !== 0) continue;
      }
      best = d; bx = dx; by = dy;
    }
    if (bx !== 0 && by !== 0) { this.flowX = bx * 0.70710678; this.flowY = by * 0.70710678; }
    else { this.flowX = bx; this.flowY = by; }
  }

  private ai(moveX: number, moveY: number) {
    const a = this.a, n = this.n;
    const phase = this.tick % THINK_EVERY;
    const px = a.x[this.playerSlot], py = a.y[this.playerSlot];
    const x_ = a.x, y_ = a.y, vx = a.vx, vy = a.vy, tf = a.tfacing, ids = a.id, kinds = a.kind;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      if (id === 0) {
        vx[i] = moveX * PLAYER_SPEED; vy[i] = moveY * PLAYER_SPEED;
        if (moveX !== 0 || moveY !== 0) tf[i] = Math.atan2(moveY, moveX);
        continue;
      }
      if (id % THINK_EVERY !== phase) continue;
      const x = x_[i], y = y_[i];
      this.flowDir(cellIndex(x, y));
      let dx = this.flowX, dy = this.flowY;
      const toPx = px - x, toPy = py - y;
      const d2 = toPx * toPx + toPy * toPy;
      if (d2 < 2.25 || (dx === 0 && dy === 0)) {
        const inv = 1 / Math.max(Math.sqrt(d2), 1e-3);
        dx = toPx * inv; dy = toPy * inv;
      }
      const h = hash(id, this.tick);
      const wobble = ((h & 0xffff) / 65535 - 0.5) * 0.6;
      const wx = dx - dy * wobble, wy = dy + dx * wobble;
      const speed = (2 + 0.1 * (kinds[i] % 5)) * (0.85 + 0.3 * ((h >>> 16) & 0xff) / 255);
      vx[i] = wx * speed; vy[i] = wy * speed;
      tf[i] = Math.atan2(wy, wx);
    }
  }

  private integrate() {
    const a = this.a;
    const n4 = (this.n + 3) & ~3;
    a.px.set(a.x); a.py.set(a.y); a.pfacing.set(a.facing);
    const x = a.x, y = a.y, vx = a.vx, vy = a.vy, f = a.facing, tf = a.tfacing;
    for (let i = 0; i < n4; i++) {
      x[i] += vx[i] * DT;
      y[i] += vy[i] * DT;
      let d = tf[i] - f[i];
      if (d > PI) d -= TAU;
      if (d < -PI) d += TAU;
      f[i] += d > TURN_RATE ? TURN_RATE : d < -TURN_RATE ? -TURN_RATE : d;
    }
  }

  private sortByCell() {
    const n = this.n, a = this.a, b = this.b, cellStart = this.cellStart, cellOf = this.cellOf, cursor = this.cursor;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const c = cellIndex(a.x[i], a.y[i]);
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < CELLS; c++) cellStart[c + 1] += cellStart[c];
    cursor.set(cellStart.subarray(0, CELLS));
    for (let i = 0; i < n; i++) {
      const j = cursor[cellOf[i]]++;
      b.x[j] = a.x[i]; b.y[j] = a.y[i]; b.px[j] = a.px[i]; b.py[j] = a.py[i];
      b.vx[j] = a.vx[i]; b.vy[j] = a.vy[i];
      b.facing[j] = a.facing[i]; b.pfacing[j] = a.pfacing[i]; b.tfacing[j] = a.tfacing[i];
      b.radius[j] = a.radius[i]; b.kind[j] = a.kind[i]; b.id[j] = a.id[i];
      if (a.id[i] === 0) this.playerSlot = j;
    }
    this.a = b; this.b = a;
  }

  private collide() {
    const t = this.a, cs = this.cellStart;
    const x = t.x, y = t.y, radius = t.radius, ids = t.id;
    let tested = 0, hit = 0;
    for (let cy = 0; cy < GRID; cy++) {
      for (let cx = 0; cx < GRID; cx++) {
        const c = cy * GRID + cx;
        const s = cs[c], e = cs[c + 1];
        if (s === e) continue;
        // Pass 0 is the cell itself; passes 1..4 are the neighbours E, NW, N, NE.
        for (let pass = 0; pass < 5; pass++) {
          let ns: number, ne: number;
          if (pass === 0) { ns = s; ne = e; }
          else {
            let nc = -1;
            if (pass === 1) { if (cx + 1 < GRID) nc = c + 1; }
            else if (cy + 1 < GRID) {
              if (pass === 2) { if (cx > 0) nc = c + GRID - 1; }
              else if (pass === 3) nc = c + GRID;
              else if (cx + 1 < GRID) nc = c + GRID + 1;
            }
            if (nc < 0) continue;
            ns = cs[nc]; ne = cs[nc + 1];
          }
          for (let i = s; i < e; i++) {
            for (let j = pass === 0 ? i + 1 : ns; j < ne; j++) {
              tested++;
              const dx = x[j] - x[i], dy = y[j] - y[i];
              const r = radius[i] + radius[j];
              const d2 = dx * dx + dy * dy;
              if (d2 >= r * r) continue;
              hit++;
              const d = Math.sqrt(d2);
              let nx = 1, ny = 0;
              if (d > 1e-5) { nx = dx / d; ny = dy / d; }
              const push = r - d;
              let wi = 0.5, wj = 0.5;
              if (ids[i] === 0) { wi = 0; wj = 1; } else if (ids[j] === 0) { wi = 1; wj = 0; }
              x[i] -= nx * push * wi; y[i] -= ny * push * wi;
              x[j] += nx * push * wj; y[j] += ny * push * wj;
            }
          }
        }
      }
    }
    this.pairsTested = tested; this.pairsHit = hit;
  }

  private collideObstacles() {
    const a = this.a, n = this.n, blocked = this.blocked;
    const max = GRID - 1;
    for (let i = 0; i < n; i++) {
      const r = a.radius[i];
      let x = a.x[i], y = a.y[i];
      const cx = x | 0, cy = y | 0;
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        for (let nx = cx - 1; nx <= cx + 1; nx++) {
          if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID || blocked[ny * GRID + nx] === 0) continue;
          const qx = x < nx ? nx : x > nx + 1 ? nx + 1 : x;
          const qy = y < ny ? ny : y > ny + 1 ? ny + 1 : y;
          const dx = x - qx, dy = y - qy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2);
            x += dx / d * (r - d); y += dy / d * (r - d);
          } else {
            const l = x - nx, rr = nx + 1 - x, b = y - ny, tt = ny + 1 - y;
            const m = Math.min(l, rr, b, tt);
            if (m === l) x = nx - r; else if (m === rr) x = nx + 1 + r; else if (m === b) y = ny - r; else y = ny + 1 + r;
          }
        }
      }
      a.x[i] = x < 1 ? 1 : x > max ? max : x;
      a.y[i] = y < 1 ? 1 : y > max ? max : y;
    }
  }

  private writeSnapshot() {
    const a = this.a, n = this.n, f = this.snapF, u = this.snapU;
    let o = HEADER_BYTES / 4;
    for (let i = 0; i < n; i++, o += 8) {
      f[o] = a.px[i]; f[o + 1] = a.py[i]; f[o + 2] = a.x[i]; f[o + 3] = a.y[i];
      f[o + 4] = a.pfacing[i]; f[o + 5] = a.facing[i]; u[o + 6] = a.kind[i]; f[o + 7] = a.radius[i];
    }
  }

  step(moveX: number, moveY: number, _buttons: number) {
    const t0 = performance.now();
    this.ai(moveX, moveY);
    const t1 = performance.now();
    this.integrate();
    this.sortByCell();
    const t2 = performance.now();
    this.collide();
    this.collideObstacles();
    const t3 = performance.now();
    const pc = cellIndex(this.a.x[this.playerSlot], this.a.y[this.playerSlot]);
    if (!this.building && pc !== this.goalCell) this.flowStart(pc);
    this.flowAdvance(FLOW_BUDGET);
    const t4 = performance.now();
    const start = this.tick;
    this.tick++;
    this.writeSnapshot();
    const t5 = performance.now();
    const f = this.snapF, u = this.snapU;
    u[0] = start; u[1] = this.tick; u[2] = this.n;
    f[4] = t5 - t0; f[5] = t3 - t2; f[6] = t4 - t3; f[7] = t1 - t0; f[8] = t5 - t4; f[9] = t2 - t1;
    f[10] = this.a.x[this.playerSlot]; f[11] = this.a.y[this.playerSlot];
    f[16] = this.a.px[this.playerSlot]; f[17] = this.a.py[this.playerSlot];
  }

  snapshot(): Uint8Array { return this.snapBytes; }

  checksum(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.a.x[i] + this.a.y[i];
    return s;
  }
}
