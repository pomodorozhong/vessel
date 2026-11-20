// Scripted snapshot stream for Stage 9. It produces exactly what the combat sim will produce:
// a v2 snapshot ArrayBuffer (src/run2/protocol.ts) and, when the buildings change, a 'world' Float32Array
// (5 floats per box: x0, y0, x1, y1, active). The renderer sees nothing else, so the real sim replaces this
// file by producing the same two outputs.
import { EV_DEATH, EV_EXPLOSION, EV_HIT, EV_PLAYER_HURT, EV_SHOT, EV_WALL_BUILT, EV_WALL_REMOVED, FLAG_AURA, FLAG_HIT, FLAG_LARGE, FLAG_SHOOTER, V2_ENTITY_BYTES, V2_EVENT_BYTES, V2_HEADER_BYTES, V2_PROJECTILE_BYTES } from '../run2/protocol';

export interface StreamConfig { enemies: number; proj: number; shots: number; hits: number; deaths: number; explosions: number; seed: number; hz: number }
export interface StreamOut { snapshot: ArrayBuffer; world: Float32Array | null }

export const WORLD_BOXES = 300;
export const MAX_EVENTS_PER_STEP = 4096;
const CENTER = 128;

export class ScriptStream {
  private tick = 0;
  private s: number;
  // Enemies, ordered by ring radius so a low index means close to the player.
  private ex: Float32Array; private ey: Float32Array; private er: Float32Array; private ea: Float32Array; private ew: Float32Array; private eMode: Uint8Array; private ehp: Float32Array;
  private ekind: Uint8Array; private eRad: Float32Array;
  private ex0: Float32Array; private ey0: Float32Array; private face0: Float32Array; private face1: Float32Array;
  private px = CENTER; private py = CENTER; private pPrevX = CENTER; private pPrevY = CENTER; private pHp = 1;
  // Projectiles
  private qx: Float32Array; private qy: Float32Array; private qvx: Float32Array; private qvy: Float32Array; private qlife: Int16Array; private qown: Uint8Array; private qexp: Uint8Array;
  private boxes: Float32Array; private wallBase = 0; private nextWall = 0;
  private worldDirty = true;
  readonly buildingCount = WORLD_BOXES;

  constructor(private c: StreamConfig) {
    this.s = (c.seed * 2654435761) >>> 0 || 1;
    const N = c.enemies;
    this.ex = new Float32Array(N); this.ey = new Float32Array(N); this.er = new Float32Array(N); this.ea = new Float32Array(N); this.ew = new Float32Array(N);
    this.eMode = new Uint8Array(N); this.ehp = new Float32Array(N); this.ekind = new Uint8Array(N); this.eRad = new Float32Array(N);
    this.ex0 = new Float32Array(N); this.ey0 = new Float32Array(N); this.face0 = new Float32Array(N); this.face1 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = 3 + 42 * Math.sqrt(i / Math.max(1, N)), a = this.rnd() * 6.2832;
      this.er[i] = r; this.ea[i] = a;
      this.ew[i] = (this.rnd() < 0.5 ? -1 : 1) * (2.5 + this.rnd() * 3.5) / 30 / Math.max(6, r); // rad per step, 2.5 to 6 units/s along the ring
      this.eMode[i] = this.rnd() < 0.6 ? 0 : 1;                                                          // 0 orbit, 1 chase
      this.ekind[i] = i % 16;
      const large = this.ekind[i] >= 12;
      this.eRad[i] = large ? 0.75 : 0.36 + (this.ekind[i] % 5) * 0.04;
      this.ehp[i] = 0.3 + this.rnd() * 0.7;
      this.ex[i] = CENTER + Math.cos(a) * r; this.ey[i] = CENTER + Math.sin(a) * r;
      this.ex0[i] = this.ex[i]; this.ey0[i] = this.ey[i];
    }
    const P = c.proj;
    this.qx = new Float32Array(P); this.qy = new Float32Array(P); this.qvx = new Float32Array(P); this.qvy = new Float32Array(P);
    this.qlife = new Int16Array(P); this.qown = new Uint8Array(P); this.qexp = new Uint8Array(P);
    for (let i = 0; i < P; i++) { this.respawnProjectile(i); this.qlife[i] = Math.floor(this.rnd() * 40); }
    // Buildings: most near the play area, a few walls that appear and disappear.
    this.boxes = new Float32Array(WORLD_BOXES * 5);
    const walls = 12;
    for (let i = 0; i < WORLD_BOXES - walls; i++) {
      const near = i < 200;
      const w = 1 + Math.floor(this.rnd() * 4) + this.rnd(), h = 1 + Math.floor(this.rnd() * 4) + this.rnd();
      const x = near ? 88 + this.rnd() * 80 : 8 + this.rnd() * 240, y = near ? 88 + this.rnd() * 80 : 8 + this.rnd() * 240;
      this.boxes.set([x, y, x + w, y + h, 1], i * 5);
    }
    this.wallBase = WORLD_BOXES - walls;
    for (let i = 0; i < walls; i++) {
      const horiz = i % 2 === 0, x = 100 + this.rnd() * 56, y = 100 + this.rnd() * 56;
      this.boxes.set(horiz ? [x, y, x + 6, y + 0.8, i % 3 === 0 ? 1 : 0] : [x, y, x + 0.8, y + 6, i % 3 === 0 ? 1 : 0], (this.wallBase + i) * 5);
    }
  }

  private rnd() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 4294967296; }
  private poisson(mean: number) {
    if (mean <= 0) return 0;
    if (mean > 30) return Math.max(0, Math.round(mean + (this.rnd() + this.rnd() + this.rnd() - 1.5) * 2 * Math.sqrt(mean)));
    const L = Math.exp(-mean); let k = 0, p = 1;
    do { k++; p *= this.rnd(); } while (p > L);
    return k - 1;
  }
  // An enemy index biased towards the player, so most events happen where the camera looks.
  private nearEnemy() { return Math.min(this.c.enemies - 1, Math.floor(this.c.enemies * Math.pow(this.rnd(), 1.6))); }

  private respawnProjectile(i: number) {
    const enemyOwned = this.c.enemies > 0 && this.rnd() < 0.3;
    const speed = 2 + this.rnd() * 2; // units per step
    let x = this.px, y = this.py, a = this.rnd() * 6.2832;
    if (enemyOwned) { const e = this.nearEnemy(); x = this.ex[e]; y = this.ey[e]; a = Math.atan2(this.py - y, this.px - x) + (this.rnd() - 0.5) * 0.4; }
    this.qx[i] = x; this.qy[i] = y; this.qvx[i] = Math.cos(a) * speed; this.qvy[i] = Math.sin(a) * speed;
    this.qlife[i] = 20 + Math.floor(this.rnd() * 30); // 20 to 50 steps of travel
    this.qown[i] = enemyOwned ? 1 : 0; this.qexp[i] = this.rnd() < 0.12 ? 1 : 0;
  }

  // One 30 Hz step.
  step(): StreamOut {
    const { c } = this;
    const t = this.tick++, N = c.enemies, P = c.proj;
    // Player: a slow figure of eight.
    this.pPrevX = this.px; this.pPrevY = this.py;
    const u = t * 0.012;
    this.px = CENTER + Math.sin(u) * 28; this.py = CENTER + Math.sin(u * 2) * 14;
    this.pHp = 0.6 + 0.4 * Math.sin(t * 0.01);

    // Enemies: orbiters circle the player; chasers close in with a wobble and wrap back to a far ring when they arrive.
    for (let i = 0; i < N; i++) {
      this.ex0[i] = this.ex[i]; this.ey0[i] = this.ey[i];
      if (this.eMode[i] === 0) {
        this.ea[i] += this.ew[i];
        const r = this.er[i] + Math.sin(t * 0.05 + i) * 1.2;
        this.ex[i] = this.px + Math.cos(this.ea[i]) * r; this.ey[i] = this.py + Math.sin(this.ea[i]) * r;
      } else {
        const dx = this.px - this.ex[i], dy = this.py - this.ey[i], d = Math.hypot(dx, dy) || 1;
        if (d < 2.2) { const a = this.rnd() * 6.2832, r = 38 + this.rnd() * 8; this.ex[i] = this.px + Math.cos(a) * r; this.ey[i] = this.py + Math.sin(a) * r; this.ex0[i] = this.ex[i]; this.ey0[i] = this.ey[i]; }
        else { const sp = 0.1 + (i % 7) * 0.01, wob = Math.sin(t * 0.1 + i) * 0.04; this.ex[i] += dx / d * sp - dy / d * wob; this.ey[i] += dy / d * sp + dx / d * wob; }
      }
      this.ehp[i] = Math.min(1, this.ehp[i] + 0.004);
      const dxm = this.ex[i] - this.ex0[i], dym = this.ey[i] - this.ey0[i];
      this.face0[i] = this.face1[i];
      if (dxm * dxm + dym * dym > 1e-8) this.face1[i] = Math.atan2(dym, dxm);
    }

    // Events (flat: packed, x, y, value)
    const events: number[] = [];
    const pushEv = (type: number, kind: number, flags: number, x: number, y: number, v: number) => { if (events.length / 4 < MAX_EVENTS_PER_STEP) events.push(type | (kind << 8) | (flags << 16), x, y, v); };
    const hitFlag = new Uint8Array(N);
    const nShots = this.poisson(c.shots / c.hz);
    for (let k = 0; k < nShots; k++) { if (this.rnd() < 0.7) pushEv(EV_SHOT, 16, 0, this.px, this.py, 0); else { const e = this.nearEnemy(); pushEv(EV_SHOT, this.ekind[e], 1, this.ex[e], this.ey[e], 0); } }
    const nDeaths = N > 0 ? this.poisson(c.deaths / c.hz) : 0;
    for (let k = 0; k < nDeaths; k++) {
      const e = this.nearEnemy(); pushEv(EV_DEATH, this.ekind[e], 0, this.ex[e], this.ey[e], 0);
      // The dead enemy is replaced on a far ring position.
      const a = this.rnd() * 6.2832, r = 36 + this.rnd() * 10; this.ex[e] = this.px + Math.cos(a) * r; this.ey[e] = this.py + Math.sin(a) * r; this.ex0[e] = this.ex[e]; this.ey0[e] = this.ey[e]; this.ehp[e] = 1;
    }
    const nExpl = N > 0 ? this.poisson(c.explosions / c.hz) : 0;
    for (let k = 0; k < nExpl; k++) { const e = this.nearEnemy(); pushEv(EV_EXPLOSION, 0, 0, this.ex[e], this.ey[e], 3 + this.rnd() * 4); }
    if (this.rnd() < 0.02) pushEv(EV_PLAYER_HURT, 16, 0, this.px, this.py, 5);

    // Projectiles fly 2 to 4 units per step; some hit this step (the configured hit rate), the rest fly on until their range ends.
    const wantHits = N > 0 ? this.poisson(c.hits / c.hz) : 0;
    const pb = new Float32Array(P * 6), pu = new Uint32Array(pb.buffer);
    let hitsLeft = Math.min(wantHits, P);
    for (let i = 0; i < P; i++) {
      if (this.qlife[i] <= 0) this.respawnProjectile(i);
      const x0 = this.qx[i], y0 = this.qy[i];
      let x1 = x0 + this.qvx[i], y1 = y0 + this.qvy[i], hit = 0;
      if (hitsLeft > 0 && this.rnd() < (wantHits + 1) / P) {
        hit = 1; hitsLeft--;
        const f = 0.3 + this.rnd() * 0.7; x1 = x0 + this.qvx[i] * f; y1 = y0 + this.qvy[i] * f;
        const dmg = 5 + Math.floor(this.rnd() * 95);
        const e = this.nearEnemy();
        // The hit event is placed on an enemy near the player so the effect and the number are on screen.
        pushEv(EV_HIT, this.ekind[e], this.qown[i], this.ex[e], this.ey[e], dmg);
        if (!hitFlag[e]) { hitFlag[e] = 1; this.ehp[e] = Math.max(0.05, this.ehp[e] - dmg / 400); }
        if (this.qexp[i]) pushEv(EV_EXPLOSION, 0, 0, this.ex[e], this.ey[e], 2 + this.rnd() * 2);
        this.qlife[i] = 0;
      } else this.qlife[i]--;
      pb[i * 6] = x0; pb[i * 6 + 1] = y0; pb[i * 6 + 2] = x1; pb[i * 6 + 3] = y1;
      pu[i * 6 + 4] = (this.qown[i] << 8) | (hit << 9) | (this.qexp[i] << 10);
      pb[i * 6 + 5] = this.qexp[i] ? 0.4 : 0.22;
      this.qx[i] = x1; this.qy[i] = y1;
    }

    // Buildings: a wall appears or disappears every 2.5 s.
    let world: Float32Array | null = null;
    let flags = 0;
    if (t % 75 === 74) {
      const wi = this.wallBase + (this.nextWall++ % 12), was = this.boxes[wi * 5 + 4] > 0.5;
      this.boxes[wi * 5 + 4] = was ? 0 : 1;
      pushEv(was ? EV_WALL_REMOVED : EV_WALL_BUILT, 0, 0, (this.boxes[wi * 5] + this.boxes[wi * 5 + 2]) / 2, (this.boxes[wi * 5 + 1] + this.boxes[wi * 5 + 3]) / 2, wi);
      this.worldDirty = true;
    }
    if (this.worldDirty) { world = this.boxes.slice(); this.worldDirty = false; flags |= 1; }

    // Write the snapshot.
    const E = events.length / 4;
    const entBase = V2_HEADER_BYTES, projBase = entBase + V2_ENTITY_BYTES * (N + 1), evBase = projBase + V2_PROJECTILE_BYTES * P;
    const buf = new ArrayBuffer(evBase + V2_EVENT_BYTES * E), hu = new Uint32Array(buf, 0, 32), hf = new Float32Array(buf, 0, 32);
    hu[0] = t; hu[1] = t + 1; hu[2] = N + 1; hu[3] = 0; hu[4] = P; hu[5] = E; hu[6] = 0; hu[7] = flags;
    hf[8] = this.pPrevX; hf[9] = this.pPrevY; hf[10] = this.px; hf[11] = this.py; hf[12] = this.pHp;
    const wall = performance.timeOrigin + performance.now();
    new Float64Array(buf, 56, 2).set([wall, wall]);
    const ef = new Float32Array(buf, entBase, (N + 1) * 8), eu = new Uint32Array(buf, entBase, (N + 1) * 8);
    {
      const f = Math.atan2(this.py - this.pPrevY, this.px - this.pPrevX); // entity 0 is the player
      ef[0] = this.pPrevX; ef[1] = this.pPrevY; ef[2] = this.px; ef[3] = this.py; ef[4] = f; ef[5] = f;
      eu[6] = 16 | (Math.round(this.pHp * 255) << 8); ef[7] = 0.55;
    }
    for (let i = 0; i < N; i++) {
      const o = (i + 1) * 8, k = this.ekind[i];
      ef[o] = this.ex0[i]; ef[o + 1] = this.ey0[i]; ef[o + 2] = this.ex[i]; ef[o + 3] = this.ey[i]; ef[o + 4] = this.face0[i]; ef[o + 5] = this.face1[i];
      const fl = (hitFlag[i] ? FLAG_HIT : 0) | (k % 4 === 0 ? FLAG_SHOOTER : 0) | (k % 8 === 3 ? FLAG_AURA : 0) | (k >= 12 ? FLAG_LARGE : 0);
      eu[o + 6] = k | (Math.round(this.ehp[i] * 255) << 8) | (fl << 16); ef[o + 7] = this.eRad[i];
    }
    new Float32Array(buf, projBase, P * 6).set(pb);
    const evU = new Uint32Array(buf, evBase, E * 4), evF = new Float32Array(buf, evBase, E * 4);
    for (let i = 0; i < E; i++) { evU[i * 4] = events[i * 4]; evF[i * 4 + 1] = events[i * 4 + 1]; evF[i * 4 + 2] = events[i * 4 + 2]; evF[i * 4 + 3] = events[i * 4 + 3]; }
    return { snapshot: buf, world };
  }
}
