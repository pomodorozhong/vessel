//! Stage 8 shared core: everything that is the same in the A/B/C sim (`prototype/combat`) and in the
//! Rapier 2D sim (`prototype/combat-rapier`, which includes this file with `#[path]`).
//!
//! Shared here: the scene (map obstacles, buildings, the wall schedule), entity table, AI, flow field,
//! projectile pool and its spawn controller, damage, deaths and respawns, pickups, events, the snapshot
//! writer (layout v2, see `src/run2/protocol.ts`), the sweep primitives and the slow exact reference
//! check. NOT shared (this is what the stage compares): how overlapping pairs are found and pushed
//! apart, how a projectile finds the first thing along its path, and how area queries find enemies.
#![allow(dead_code)]

pub const GRID: usize = 256; // cells per side; a cell is 1 world unit
pub const CELLS: usize = GRID * GRID;
pub const DT: f32 = 1.0 / 30.0;
pub const THINK_EVERY: u32 = 8;
pub const FLOW_BUDGET: usize = 16384;
pub const KINDS: u32 = 16;
pub const PLAYER_KIND: u32 = 16;
pub const PLAYER_SPEED: f32 = 5.0;
pub const PLAYER_RADIUS: f32 = 0.4;
pub const TURN_RATE: f32 = 0.35;
pub const UNREACHED: u16 = u16::MAX;
pub const INF: f32 = f32::INFINITY;
/// The grid cell is 1 unit, so two entities that overlap (or are within the candidate margin) must have centres
/// in the same or adjacent cells: 2 * LARGE_RADIUS + margin <= 1. lib.rs asserts it.
pub const LARGE_RADIUS: f32 = 0.45;

// Snapshot v2 layout (src/run2/protocol.ts).
pub const V2_HEADER_BYTES: usize = 128;
pub const V2_ENTITY_BYTES: usize = 32;
pub const V2_PROJECTILE_BYTES: usize = 24;
pub const V2_EVENT_BYTES: usize = 16;
pub const EV_SHOT: u32 = 0;
pub const EV_HIT: u32 = 1;
pub const EV_DEATH: u32 = 2;
pub const EV_EXPLOSION: u32 = 3;
pub const EV_PICKUP: u32 = 4;
pub const EV_WALL_BUILT: u32 = 5;
pub const EV_WALL_REMOVED: u32 = 6;
pub const EV_PLAYER_HURT: u32 = 7;
pub const EV_TYPES: usize = 8;
pub const FLAG_HIT: u32 = 1 << 0;
pub const FLAG_SHOOTER: u32 = 1 << 1;
pub const FLAG_AURA: u32 = 1 << 2;
pub const FLAG_LARGE: u32 = 1 << 3;

// Init flags.
pub const INIT_CHECK: u32 = 1; // run the slow exact reference check alongside
pub const INIT_NOSWEEP: u32 = 2; // debug: test projectiles at their end point only, no sweeping

// Timing slots, in the order of header f32[18..30], plus the reference check time (header f32[30]).
pub const T_STEP: usize = 0;
pub const T_PAIRS: usize = 1;
pub const T_EXACT: usize = 2;
pub const T_PUSH: usize = 3;
pub const T_PROJ: usize = 4;
pub const T_AREA: usize = 5;
pub const T_FLOW: usize = 6;
pub const T_AI: usize = 7;
pub const T_INTEGRATE: usize = 8;
pub const T_SNAP: usize = 9;
pub const T_OBST: usize = 10;
pub const T_BUILD: usize = 11;
pub const T_CHECK: usize = 12;

// Stat slots read through the `stat(i)` export.
pub const S_PASS_THROUGH: usize = 0; // reference found an earlier hit (or a hit the fast path missed)
pub const S_FALSE_HIT: usize = 1; // fast path hit something the reference did not (or later)
pub const S_CHECKED: usize = 2; // projectile sweeps checked against the reference
pub const S_DEATHS: usize = 3;
pub const S_PAIRS_TESTED: usize = 4; // last step
pub const S_PAIRS_HIT: usize = 5; // last step, first pass
pub const S_PAIRS_CAND: usize = 6; // last step
pub const S_FLOW_REBUILDS: usize = 7;
pub const S_PROJ_HITS: usize = 8;
pub const S_SHOTS: usize = 9;
pub const S_SNAP_USED: usize = 10; // last step
pub const S_ORDER_MOVES: usize = 11; // method B: insertion sort moves, last step
pub const S_HITS_ENEMY: usize = 12;
pub const S_HITS_WALL: usize = 13;
pub const S_HITS_PLAYER: usize = 14;
pub const S_EXPLOSIONS: usize = 15;
pub const S_GRAZE: usize = 16; // Rapier build: disagreements with the reference that vanish within the check margin
pub const S_COUNT: usize = 24;

// Projectile and weapon tuning.
pub const BULLET: u8 = 0;
pub const ROCKET: u8 = 1;
pub const BOLT: u8 = 2;
pub const ROCKET_EVERY: u32 = 8; // every 8th player shot is an explosive rocket
pub const EXPLOSION_RADIUS: f32 = 2.5;
pub const EXPLOSION_DAMAGE: f32 = 2.0;
pub const AURA_KIND: u32 = 5;
pub const AURA_RADIUS: f32 = 2.0;
pub const PICKUP_CAP: usize = 4096;
pub const PICKUP_RADIUS: f32 = 3.0;
pub const STATIC_BUILDINGS: usize = 160;
pub const DYN_SLOTS: usize = 16;
pub const WALL_PERIOD: u32 = 60; // a player-built wall every 2 s ...
pub const WALL_LIFE: u32 = 300; // ... that stays 10 s

// The import module is named explicitly (newer Rust refuses undefined symbols in the WASM linker).
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn now() -> f64;
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn now() -> f64 {
    0.0
}
#[inline]
pub fn clock() -> f64 {
    unsafe { now() }
}

pub struct Rng(pub u32);
impl Rng {
    #[inline]
    pub fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next() >> 8) as f32 / 16_777_216.0
    }
}

#[inline]
pub fn hash(a: u32, b: u32) -> u32 {
    let mut h = a.wrapping_mul(0x9E37_79B1) ^ b.wrapping_mul(0x85EB_CA77);
    h ^= h >> 15;
    h = h.wrapping_mul(0xC2B2_AE3D);
    h ^ (h >> 13)
}

#[inline]
pub fn cell_index(x: f32, y: f32) -> u32 {
    let cx = (x as i32).clamp(0, GRID as i32 - 1) as u32;
    let cy = (y as i32).clamp(0, GRID as i32 - 1) as u32;
    cy * GRID as u32 + cx
}

// ---- Enemy kinds. Kind 7 and 15 are large, 3 and 11 shoot, 5 carries an aura. -----------------------

#[inline]
pub fn is_large(k: u32) -> bool {
    k < KINDS && k % 8 == 7
}
#[inline]
pub fn is_shooter(k: u32) -> bool {
    k < KINDS && k % 8 == 3
}
#[inline]
pub fn kind_radius(k: u32) -> f32 {
    if k == PLAYER_KIND {
        PLAYER_RADIUS
    } else if is_large(k) {
        LARGE_RADIUS
    } else {
        0.25 + 0.012 * (k % 7) as f32
    }
}
pub fn kind_speed(k: u32) -> f32 {
    (2.0 + 0.1 * (k % 5) as f32) * if is_large(k) { 0.7 } else { 1.0 }
}
pub fn kind_max_hp(k: u32) -> f32 {
    if k == PLAYER_KIND {
        1.0
    } else if is_large(k) {
        15.0
    } else {
        3.0
    }
}
/// Mass class: the lighter body gets pushed further. The player is never pushed at all.
#[inline]
pub fn kind_mass(k: u32) -> f32 {
    if is_large(k) {
        6.0
    } else {
        1.0
    }
}
pub fn kind_flags(k: u32) -> u32 {
    (if is_shooter(k) { FLAG_SHOOTER } else { 0 }) | (if k == AURA_KIND { FLAG_AURA } else { 0 }) | (if is_large(k) { FLAG_LARGE } else { 0 })
}

// ---- Entity table (struct of arrays). Two sets exist so a per-step sort can scatter from one into the other. --

#[derive(Default)]
pub struct Table {
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub px: Vec<f32>,
    pub py: Vec<f32>,
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    pub facing: Vec<f32>,
    pub pfacing: Vec<f32>,
    pub tfacing: Vec<f32>,
    pub radius: Vec<f32>,
    pub hp: Vec<f32>,
    pub slow: Vec<f32>, // speed multiplier for the next integrate, reset to 1 after it
    pub kind: Vec<u32>,
    pub id: Vec<u32>,
    pub flags: Vec<u32>,
}

impl Table {
    pub fn new(n: usize) -> Self {
        let m = (n + 3) & !3; // padded to a multiple of 4 so SIMD loops never need a scalar tail
        Table {
            x: vec![0.0; m],
            y: vec![0.0; m],
            px: vec![0.0; m],
            py: vec![0.0; m],
            vx: vec![0.0; m],
            vy: vec![0.0; m],
            facing: vec![0.0; m],
            pfacing: vec![0.0; m],
            tfacing: vec![0.0; m],
            radius: vec![0.0; m],
            hp: vec![0.0; m],
            slow: vec![1.0; m],
            kind: vec![0; m],
            id: vec![0; m],
            flags: vec![0; m],
        }
    }
    /// Copies entity `i` of `src` into slot `j` of `self`.
    #[inline]
    pub fn put(&mut self, j: usize, src: &Table, i: usize) {
        self.x[j] = src.x[i];
        self.y[j] = src.y[i];
        self.px[j] = src.px[i];
        self.py[j] = src.py[i];
        self.vx[j] = src.vx[i];
        self.vy[j] = src.vy[i];
        self.facing[j] = src.facing[i];
        self.pfacing[j] = src.pfacing[i];
        self.tfacing[j] = src.tfacing[i];
        self.radius[j] = src.radius[i];
        self.hp[j] = src.hp[i];
        self.slow[j] = src.slow[i];
        self.kind[j] = src.kind[i];
        self.id[j] = src.id[i];
        self.flags[j] = src.flags[i];
    }
}

// ---- Sweep primitives. Used by the fast paths AND by the reference check, so both measure the same shape. --

/// First time t in [0, 1] at which a point moving from (x0, y0) by (dx, dy) is within `rr` of (cx, cy);
/// INF if never. Already inside: 0.
#[inline]
pub fn sweep_circle_circle(x0: f32, y0: f32, dx: f32, dy: f32, cx: f32, cy: f32, rr: f32) -> f32 {
    let px = x0 - cx;
    let py = y0 - cy;
    let c = px * px + py * py - rr * rr;
    if c <= 0.0 {
        return 0.0;
    }
    let a = dx * dx + dy * dy;
    let b = px * dx + py * dy;
    if b >= 0.0 || a <= 1e-12 {
        return INF;
    }
    let disc = b * b - a * c;
    if disc < 0.0 {
        return INF;
    }
    let t = (-b - disc.sqrt()) / a;
    if t <= 1.0 {
        t.max(0.0)
    } else {
        INF
    }
}

/// First time t in [0, 1] at which a circle of radius r, whose centre moves from (x0, y0) by (dx, dy),
/// touches the box. The shape is the exact Minkowski sum (a box with rounded corners).
#[inline]
pub fn sweep_circle_aabb(x0: f32, y0: f32, dx: f32, dy: f32, r: f32, minx: f32, miny: f32, maxx: f32, maxy: f32) -> f32 {
    let qx = x0.clamp(minx, maxx);
    let qy = y0.clamp(miny, maxy);
    let ex = x0 - qx;
    let ey = y0 - qy;
    if ex * ex + ey * ey <= r * r {
        return 0.0;
    }
    let (bx0, by0, bx1, by1) = (minx - r, miny - r, maxx + r, maxy + r);
    let mut t0 = 0.0f32;
    let mut t1 = 1.0f32;
    if dx.abs() < 1e-12 {
        if x0 < bx0 || x0 > bx1 {
            return INF;
        }
    } else {
        let inv = 1.0 / dx;
        let (mut ta, mut tb) = ((bx0 - x0) * inv, (bx1 - x0) * inv);
        if ta > tb {
            core::mem::swap(&mut ta, &mut tb);
        }
        t0 = t0.max(ta);
        t1 = t1.min(tb);
        if t0 > t1 {
            return INF;
        }
    }
    if dy.abs() < 1e-12 {
        if y0 < by0 || y0 > by1 {
            return INF;
        }
    } else {
        let inv = 1.0 / dy;
        let (mut ta, mut tb) = ((by0 - y0) * inv, (by1 - y0) * inv);
        if ta > tb {
            core::mem::swap(&mut ta, &mut tb);
        }
        t0 = t0.max(ta);
        t1 = t1.min(tb);
        if t0 > t1 {
            return INF;
        }
    }
    let hx = x0 + dx * t0;
    let hy = y0 + dy * t0;
    if (hx >= minx && hx <= maxx) || (hy >= miny && hy <= maxy) {
        return t0; // entered through a face
    }
    // Entered through a corner region: only the corner circle can be hit.
    let cx = if hx < minx { minx } else { maxx };
    let cy = if hy < miny { miny } else { maxy };
    sweep_circle_circle(x0, y0, dx, dy, cx, cy, r)
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum HitKind {
    None,
    Wall,
    Building(u32),
    Enemy(u32),
    Player,
}
#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub t: f32,
    pub kind: HitKind,
}
impl Hit {
    pub const NONE: Hit = Hit { t: INF, kind: HitKind::None };
}

// ---- Parameters, projectile pool, flow field state ------------------------------------------------------

#[derive(Clone, Copy)]
pub struct Params {
    pub method: u32, // 0 = A, 1 = B, 2 = C (ignored by the Rapier build)
    pub enemies: u32,
    pub seed: u32,
    pub spawn: f32, // > 0: enemies start inside a square of this half-size around the player
    pub proj_target: u32,
    pub proj_cap: u32,
    pub event_cap: u32,
    pub passes: u32,
    pub flags: u32,
}

pub struct Pool {
    pub cap: usize,
    pub n: usize,
    pub sx: Vec<f32>, // segment start of this step
    pub sy: Vec<f32>,
    pub ex: Vec<f32>, // segment end, or the hit point
    pub ey: Vec<f32>,
    pub vx: Vec<f32>, // displacement per step
    pub vy: Vec<f32>,
    pub r: Vec<f32>,
    pub dmg: Vec<f32>,
    pub kind: Vec<u8>,
    pub owner: Vec<u8>, // 0 player, 1 enemy
    pub life: Vec<i16>, // steps left
    pub state: Vec<u8>, // bit 0 hit this step, bit 1 done (removed before the next step), bit 2 explosive
}

impl Pool {
    fn new(cap: usize) -> Pool {
        Pool {
            cap,
            n: 0,
            sx: vec![0.0; cap],
            sy: vec![0.0; cap],
            ex: vec![0.0; cap],
            ey: vec![0.0; cap],
            vx: vec![0.0; cap],
            vy: vec![0.0; cap],
            r: vec![0.0; cap],
            dmg: vec![0.0; cap],
            kind: vec![0; cap],
            owner: vec![0; cap],
            life: vec![0; cap],
            state: vec![0; cap],
        }
    }
    fn compact(&mut self) {
        let mut w = 0;
        for i in 0..self.n {
            if self.state[i] & 2 != 0 {
                continue;
            }
            if w != i {
                self.sx[w] = self.sx[i];
                self.sy[w] = self.sy[i];
                self.ex[w] = self.ex[i];
                self.ey[w] = self.ey[i];
                self.vx[w] = self.vx[i];
                self.vy[w] = self.vy[i];
                self.r[w] = self.r[i];
                self.dmg[w] = self.dmg[i];
                self.kind[w] = self.kind[i];
                self.owner[w] = self.owner[i];
                self.life[w] = self.life[i];
                self.state[w] = self.state[i];
            }
            self.state[w] &= !1;
            w += 1;
        }
        self.n = w;
    }
}

pub struct Core {
    pub p: Params,
    pub n: usize,
    pub n_cap: usize, // entities allocated at init; set_active moves n within it
    pub tick: u32,
    pub rng: Rng,
    pub a: Table,
    pub b: Table,
    pub player_slot: usize,
    // World.
    pub blocked: Vec<u8>, // bit 0 map obstacle, bit 1 building
    pub bcell: Vec<u16>,  // building index + 1 per cell
    pub buildings: Vec<f32>, // 5 floats per box: x0, y0, x1, y1, active
    pub static_count: usize,
    pub dyn_expire: Vec<u32>, // per dynamic slot: 0 = free, else the tick it is removed
    pub walls: Vec<[f32; 4]>, // map obstacle cells as boxes (for the reference check)
    pub wall_changes: Vec<(u32, bool)>, // building index, added; consumed by the Rapier build
    pub world_changed: bool,
    // Flow field.
    pub dist: Vec<u16>,
    pub dist_back: Vec<u16>,
    pub queue: Vec<u32>,
    pub q_head: usize,
    pub q_tail: usize,
    pub building: bool,
    pub goal_cell: u32,
    pub player_cell: u32,
    pub flow_rebuilds: u32,
    // Combat.
    pub pool: Pool,
    pub enemy_shots: Vec<[f32; 2]>,
    pub explosions: Vec<[f32; 4]>, // x, y, radius, damage
    pub dead: Vec<u32>,
    pub pickups: Vec<[f32; 2]>,
    pub player_hurt: f32, // damage taken this step (one EV_PLAYER_HURT per step)
    pub shot_count: u32,
    // Output.
    pub events: Vec<u32>, // 4 words per event
    pub ev_n: usize,
    pub ev_dropped: u32,
    pub snapshot: Vec<u8>,
    pub snapshot_used: usize,
    pub timing: [f32; 13],
    pub stats: [f64; S_COUNT],
    pub check_eps: f32, // tolerance of the reference check in time (the Rapier build needs a looser one)
    pub check_margin: f32, // tolerance in distance: the Rapier build only counts clear disagreements
}

impl Core {
    pub fn new(p: &Params) -> Core {
        let n = p.enemies as usize + 1;
        let mut rng = Rng(p.seed.wrapping_mul(2_654_435_761).max(1));
        let centre = (GRID / 2) as i32;
        let mut blocked = vec![0u8; CELLS];
        for i in 0..GRID {
            blocked[i] = 1;
            blocked[(GRID - 1) * GRID + i] = 1;
            blocked[i * GRID] = 1;
            blocked[i * GRID + GRID - 1] = 1;
        }
        let block = |blocked: &mut Vec<u8>, cx: i32, cy: i32| {
            if cx < 1 || cy < 1 || cx >= GRID as i32 - 1 || cy >= GRID as i32 - 1 {
                return;
            }
            if (cx - centre).abs() < 4 && (cy - centre).abs() < 4 {
                return;
            }
            blocked[cy as usize * GRID + cx as usize] = 1;
        };
        for _ in 0..1800 {
            let cx = (rng.unit() * GRID as f32) as i32;
            let cy = (rng.unit() * GRID as f32) as i32;
            block(&mut blocked, cx, cy);
        }
        for _ in 0..120 {
            let cx = (rng.unit() * GRID as f32) as i32;
            let cy = (rng.unit() * GRID as f32) as i32;
            let len = 3 + (rng.next() % 8) as i32;
            let horizontal = rng.next() & 1 == 0;
            for k in 0..len {
                if horizontal {
                    block(&mut blocked, cx + k, cy);
                } else {
                    block(&mut blocked, cx, cy + k);
                }
            }
        }
        let mut walls = Vec::new();
        for c in 0..CELLS {
            if blocked[c] & 1 != 0 {
                let (cx, cy) = ((c % GRID) as f32, (c / GRID) as f32);
                walls.push([cx, cy, cx + 1.0, cy + 1.0]);
            }
        }

        // Static buildings: boxes of several sizes on free cells, never in the clear centre.
        let sizes: [(i32, i32); 8] = [(2, 2), (3, 3), (4, 2), (2, 4), (6, 1), (1, 6), (5, 5), (8, 2)];
        let mut bcell = vec![0u16; CELLS];
        let mut buildings: Vec<f32> = Vec::new();
        for _ in 0..STATIC_BUILDINGS {
            for _try in 0..20 {
                let (w, h) = sizes[(rng.next() % 8) as usize];
                let cx = 2 + (rng.unit() * (GRID as i32 - 4 - w) as f32) as i32;
                let cy = 2 + (rng.unit() * (GRID as i32 - 4 - h) as f32) as i32;
                if (cx + w > centre - 6) && (cx < centre + 6) && (cy + h > centre - 6) && (cy < centre + 6) {
                    continue;
                }
                let mut free = true;
                'scan: for yy in cy - 1..cy + h + 1 {
                    for xx in cx - 1..cx + w + 1 {
                        if blocked[yy as usize * GRID + xx as usize] != 0 {
                            free = false;
                            break 'scan;
                        }
                    }
                }
                if !free {
                    continue;
                }
                let idx = buildings.len() / 5;
                for yy in cy..cy + h {
                    for xx in cx..cx + w {
                        blocked[yy as usize * GRID + xx as usize] |= 2;
                        bcell[yy as usize * GRID + xx as usize] = idx as u16 + 1;
                    }
                }
                buildings.extend_from_slice(&[cx as f32, cy as f32, (cx + w) as f32, (cy + h) as f32, 1.0]);
                break;
            }
        }
        let static_count = buildings.len() / 5;
        buildings.resize((static_count + DYN_SLOTS) * 5, 0.0); // dynamic slots start inactive

        let mut a = Table::new(n);
        a.x[0] = centre as f32 + 0.5;
        a.y[0] = centre as f32 + 0.5;
        a.radius[0] = PLAYER_RADIUS;
        a.kind[0] = PLAYER_KIND;
        a.hp[0] = 1.0;
        for i in 1..n {
            loop {
                let mut x = 1.0 + rng.unit() * (GRID as f32 - 2.0);
                let mut y = 1.0 + rng.unit() * (GRID as f32 - 2.0);
                if p.spawn > 0.0 {
                    x = centre as f32 + (x / GRID as f32 - 0.5) * 2.0 * p.spawn;
                    y = centre as f32 + (y / GRID as f32 - 0.5) * 2.0 * p.spawn;
                }
                if blocked[cell_index(x, y) as usize] == 0 {
                    a.x[i] = x;
                    a.y[i] = y;
                    break;
                }
            }
            let kind = i as u32 % KINDS;
            a.kind[i] = kind;
            a.radius[i] = kind_radius(kind);
            a.hp[i] = kind_max_hp(kind);
            a.id[i] = i as u32;
            a.facing[i] = rng.unit() * 6.2831853;
            a.tfacing[i] = a.facing[i];
        }
        for i in 0..n {
            a.px[i] = a.x[i];
            a.py[i] = a.y[i];
            a.pfacing[i] = a.facing[i];
        }
        let player_cell = cell_index(a.x[0], a.y[0]);
        let cap = p.proj_cap as usize;
        let ev_cap = p.event_cap as usize;
        let snap_bytes = V2_HEADER_BYTES + V2_ENTITY_BYTES * n + V2_PROJECTILE_BYTES * cap + V2_EVENT_BYTES * ev_cap;
        let mut core = Core {
            p: *p,
            n,
            n_cap: n,
            tick: 0,
            rng,
            a,
            b: Table::new(n),
            player_slot: 0,
            blocked,
            bcell,
            buildings,
            static_count,
            dyn_expire: vec![0; DYN_SLOTS],
            walls,
            wall_changes: Vec::new(),
            world_changed: false,
            dist: vec![UNREACHED; CELLS],
            dist_back: vec![UNREACHED; CELLS],
            queue: vec![0; CELLS],
            q_head: 0,
            q_tail: 0,
            building: false,
            goal_cell: player_cell,
            player_cell,
            flow_rebuilds: 0,
            pool: Pool::new(cap),
            enemy_shots: Vec::with_capacity(1024),
            explosions: Vec::with_capacity(1024),
            dead: Vec::with_capacity(1024),
            pickups: Vec::with_capacity(PICKUP_CAP),
            player_hurt: 0.0,
            shot_count: 0,
            events: vec![0; ev_cap * 4],
            ev_n: 0,
            ev_dropped: 0,
            snapshot: vec![0u8; snap_bytes],
            snapshot_used: 0,
            timing: [0.0; 13],
            stats: [0.0; S_COUNT],
            check_eps: 1e-4,
            check_margin: 0.0,
        };
        core.flow_start(player_cell);
        core.flow_advance(usize::MAX);
        core
    }

    // ---- Flow field -----------------------------------------------------------------------------------

    pub fn flow_start(&mut self, goal: u32) {
        self.dist_back.fill(UNREACHED);
        self.dist_back[goal as usize] = 0;
        self.queue[0] = goal;
        self.q_head = 0;
        self.q_tail = 1;
        self.building = true;
        self.goal_cell = goal;
    }

    pub fn flow_advance(&mut self, budget: usize) {
        if !self.building {
            return;
        }
        let g = GRID as i32;
        let mut done = 0;
        while self.q_head < self.q_tail && done < budget {
            let c = self.queue[self.q_head] as usize;
            self.q_head += 1;
            done += 1;
            let d = self.dist_back[c] + 1;
            let cx = (c % GRID) as i32;
            let cy = (c / GRID) as i32;
            for (dx, dy) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                let nx = cx + dx;
                let ny = cy + dy;
                if nx < 0 || ny < 0 || nx >= g || ny >= g {
                    continue;
                }
                let nc = (ny * g + nx) as usize;
                if self.blocked[nc] != 0 || self.dist_back[nc] != UNREACHED {
                    continue;
                }
                self.dist_back[nc] = d;
                self.queue[self.q_tail] = nc as u32;
                self.q_tail += 1;
            }
        }
        if self.q_head == self.q_tail {
            core::mem::swap(&mut self.dist, &mut self.dist_back);
            self.building = false;
            self.flow_rebuilds += 1;
        }
    }

    #[inline]
    pub fn flow_dir(&self, c: usize) -> (f32, f32) {
        let g = GRID as i32;
        let cx = (c % GRID) as i32;
        let cy = (c / GRID) as i32;
        let mut best = self.dist[c];
        let mut bx = 0i32;
        let mut by = 0i32;
        for (dx, dy) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)] {
            let nx = cx + dx;
            let ny = cy + dy;
            if nx < 0 || ny < 0 || nx >= g || ny >= g {
                continue;
            }
            let d = self.dist[(ny * g + nx) as usize];
            if d >= best {
                continue;
            }
            if dx != 0 && dy != 0 && (self.blocked[(cy * g + nx) as usize] != 0 || self.blocked[(ny * g + cx) as usize] != 0) {
                continue; // no corner cutting
            }
            best = d;
            bx = dx;
            by = dy;
        }
        if bx != 0 && by != 0 {
            (bx as f32 * 0.70710678, by as f32 * 0.70710678)
        } else {
            (bx as f32, by as f32)
        }
    }

    /// Flow field work of one step: restart toward the player's new cell, then expand a budget of cells.
    pub fn flow_step(&mut self) {
        let pc = cell_index(self.a.x[self.player_slot], self.a.y[self.player_slot]);
        self.player_cell = pc;
        if !self.building && pc != self.goal_cell {
            self.flow_start(pc);
        }
        self.flow_advance(FLOW_BUDGET);
    }

    // ---- Per step bookkeeping, AI, integrate -----------------------------------------------------------

    pub fn begin_step(&mut self) {
        self.ev_n = 0;
        self.ev_dropped = 0;
        self.world_changed = false;
        self.explosions.clear();
        self.dead.clear();
        self.enemy_shots.clear();
        self.player_hurt = 0.0;
        let n = self.n;
        self.a.flags[..n].fill(0);
        let ps = self.player_slot;
        self.a.hp[ps] = (self.a.hp[ps] + 0.0015).min(1.0);
    }

    pub fn ai(&mut self, move_x: f32, move_y: f32) {
        let phase = self.tick % THINK_EVERY;
        let (px, py) = (self.a.x[self.player_slot], self.a.y[self.player_slot]);
        let shoot = self.p.proj_target > 0;
        for i in 0..self.n {
            let id = self.a.id[i];
            if id == 0 {
                self.a.vx[i] = move_x * PLAYER_SPEED;
                self.a.vy[i] = move_y * PLAYER_SPEED;
                if move_x != 0.0 || move_y != 0.0 {
                    self.a.tfacing[i] = move_y.atan2(move_x);
                }
                continue;
            }
            if id % THINK_EVERY != phase {
                continue;
            }
            let x = self.a.x[i];
            let y = self.a.y[i];
            let c = cell_index(x, y) as usize;
            let (mut dx, mut dy) = self.flow_dir(c);
            let to_px = px - x;
            let to_py = py - y;
            let d2 = to_px * to_px + to_py * to_py;
            if d2 < 2.25 || (dx == 0.0 && dy == 0.0) {
                let inv = 1.0 / d2.sqrt().max(1e-3);
                dx = to_px * inv;
                dy = to_py * inv;
            }
            let h = hash(id, self.tick);
            let wobble = ((h & 0xffff) as f32 / 65535.0 - 0.5) * 0.6;
            let (wx, wy) = (dx - dy * wobble, dy + dx * wobble);
            let kind = self.a.kind[i];
            let speed = kind_speed(kind) * (0.85 + 0.3 * ((h >> 16) & 0xff) as f32 / 255.0);
            self.a.vx[i] = wx * speed;
            self.a.vy[i] = wy * speed;
            self.a.tfacing[i] = wy.atan2(wx);
            // Shooters fire at the player when they think and are in range.
            if shoot && is_shooter(kind) && d2 < 28.0 * 28.0 && (h >> 8) & 3 != 0 {
                self.enemy_shots.push([x, y]);
            }
        }
    }

    pub fn integrate(&mut self) {
        let n4 = (self.n + 3) & !3;
        let t = &mut self.a;
        t.px[..n4].copy_from_slice(&t.x[..n4]);
        t.py[..n4].copy_from_slice(&t.y[..n4]);
        t.pfacing[..n4].copy_from_slice(&t.facing[..n4]);
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        unsafe {
            use core::arch::wasm32::*;
            let dt = f32x4_splat(DT);
            let pi = f32x4_splat(core::f32::consts::PI);
            let tau = f32x4_splat(core::f32::consts::TAU);
            let turn = f32x4_splat(TURN_RATE);
            let nturn = f32x4_splat(-TURN_RATE);
            let mut i = 0;
            while i < n4 {
                let x = v128_load(t.x.as_ptr().add(i) as *const v128);
                let y = v128_load(t.y.as_ptr().add(i) as *const v128);
                let vx = v128_load(t.vx.as_ptr().add(i) as *const v128);
                let vy = v128_load(t.vy.as_ptr().add(i) as *const v128);
                let s = f32x4_mul(v128_load(t.slow.as_ptr().add(i) as *const v128), dt);
                v128_store(t.x.as_mut_ptr().add(i) as *mut v128, f32x4_add(x, f32x4_mul(vx, s)));
                v128_store(t.y.as_mut_ptr().add(i) as *mut v128, f32x4_add(y, f32x4_mul(vy, s)));
                let f = v128_load(t.facing.as_ptr().add(i) as *const v128);
                let tf = v128_load(t.tfacing.as_ptr().add(i) as *const v128);
                let mut d = f32x4_sub(tf, f);
                d = f32x4_sub(d, v128_and(f32x4_gt(d, pi), tau));
                d = f32x4_add(d, v128_and(f32x4_lt(d, f32x4_neg(pi)), tau));
                d = f32x4_max(nturn, f32x4_min(turn, d));
                v128_store(t.facing.as_mut_ptr().add(i) as *mut v128, f32x4_add(f, d));
                i += 4;
            }
        }
        #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
        {
            use core::f32::consts::{PI, TAU};
            for i in 0..n4 {
                let s = t.slow[i] * DT;
                t.x[i] += t.vx[i] * s;
                t.y[i] += t.vy[i] * s;
                let mut d = t.tfacing[i] - t.facing[i];
                if d > PI {
                    d -= TAU;
                }
                if d < -PI {
                    d += TAU;
                }
                t.facing[i] += d.clamp(-TURN_RATE, TURN_RATE);
            }
        }
        t.slow[..n4].fill(1.0);
    }

    /// Pushes entity i out of the blocked cells (map obstacles and buildings) around it: circle against the
    /// cell squares, the nearest face if the centre is inside one. Keeps it inside the map border.
    pub fn collide_obstacle(&mut self, i: usize) {
        let g = GRID as i32;
        let max = GRID as f32 - 1.0;
        let blocked = &self.blocked;
        let t = &mut self.a;
        let r = t.radius[i];
        let mut x = t.x[i];
        let mut y = t.y[i];
        let cx = x as i32;
        let cy = y as i32;
        for ny in cy - 1..=cy + 1 {
            for nx in cx - 1..=cx + 1 {
                if nx < 0 || ny < 0 || nx >= g || ny >= g || blocked[(ny * g + nx) as usize] == 0 {
                    continue;
                }
                let qx = x.clamp(nx as f32, nx as f32 + 1.0);
                let qy = y.clamp(ny as f32, ny as f32 + 1.0);
                let dx = x - qx;
                let dy = y - qy;
                let d2 = dx * dx + dy * dy;
                if d2 >= r * r {
                    continue;
                }
                if d2 > 1e-10 {
                    let d = d2.sqrt();
                    x += dx / d * (r - d);
                    y += dy / d * (r - d);
                } else {
                    let l = x - nx as f32;
                    let rr = nx as f32 + 1.0 - x;
                    let b = y - ny as f32;
                    let tt = ny as f32 + 1.0 - y;
                    let m = l.min(rr).min(b).min(tt);
                    if m == l {
                        x = nx as f32 - r;
                    } else if m == rr {
                        x = nx as f32 + 1.0 + r;
                    } else if m == b {
                        y = ny as f32 - r;
                    } else {
                        y = ny as f32 + 1.0 + r;
                    }
                }
            }
        }
        t.x[i] = x.clamp(1.0, max);
        t.y[i] = y.clamp(1.0, max);
    }

    // ---- Events ------------------------------------------------------------------------------------------

    #[inline]
    pub fn event(&mut self, ty: u32, kind: u32, flags: u32, x: f32, y: f32, v: f32) {
        if self.ev_n >= self.p.event_cap as usize {
            self.ev_dropped += 1;
            return;
        }
        let o = self.ev_n * 4;
        self.events[o] = ty | (kind & 0xff) << 8 | (flags & 0xff) << 16;
        self.events[o + 1] = x.to_bits();
        self.events[o + 2] = y.to_bits();
        self.events[o + 3] = v.to_bits();
        self.ev_n += 1;
    }

    // ---- Damage, deaths, pickups -------------------------------------------------------------------------

    #[inline]
    pub fn damage_enemy(&mut self, slot: usize, dmg: f32) {
        let t = &mut self.a;
        if t.kind[slot] == PLAYER_KIND {
            return;
        }
        let before = t.hp[slot];
        t.hp[slot] = before - dmg;
        t.flags[slot] |= FLAG_HIT;
        if before > 0.0 && before - dmg <= 0.0 {
            self.dead.push(slot as u32);
        }
    }

    pub fn hurt_player(&mut self, dmg: f32) {
        let ps = self.player_slot;
        self.a.hp[ps] -= dmg;
        if self.a.hp[ps] <= 0.0 {
            self.a.hp[ps] = 1.0; // the scripted player never dies, it just restarts at full health
        }
        self.player_hurt += dmg;
        self.a.flags[ps] |= FLAG_HIT;
    }

    /// Stage 11's wave: sets the live entity count (player + enemies), at most the count given at init. New enemies
    /// enter at the map edge. Slots past the live count hold stale data from the table swap, so every field of a new
    /// slot is set here. Shrinking keeps the player (moved into the last live slot if needed). The grid builds (A and C)
    /// only: B's persistent order and Rapier's bodies are sized at init.
    pub fn set_active(&mut self, n: usize) {
        let n = n.min(self.n_cap).max(1);
        if n < self.n {
            let ps = self.player_slot;
            if ps >= n {
                self.b.put(0, &self.a, ps);
                self.a.put(n - 1, &self.b, 0);
                self.player_slot = n - 1;
            }
            self.n = n;
            return;
        }
        for i in self.n..n {
            let kind = i as u32 % KINDS;
            let f = self.rng.unit() * 6.2831853;
            let t = &mut self.a;
            t.kind[i] = kind;
            t.radius[i] = kind_radius(kind);
            t.id[i] = i as u32; // never 0 (the player). A repeated id after a shrink only shares an AI think phase.
            t.flags[i] = 0;
            t.slow[i] = 1.0;
            t.facing[i] = f;
            t.pfacing[i] = f;
            t.tfacing[i] = f;
            self.respawn(i);
        }
        if n > self.n {
            self.n = n;
        }
    }

    /// Moves an enemy to a random free spot at the map edge with full health.
    pub fn respawn(&mut self, slot: usize) {
        let (mut x, mut y) = (3.0, 3.0);
        for _ in 0..24 {
            let side = self.rng.next() & 3;
            let along = 2.0 + self.rng.unit() * (GRID as f32 - 4.0);
            let off = 1.5 + self.rng.unit() * 4.0;
            let far = GRID as f32 - off;
            (x, y) = match side {
                0 => (along, off),
                1 => (along, far),
                2 => (off, along),
                _ => (far, along),
            };
            if self.blocked[cell_index(x, y) as usize] == 0 {
                break;
            }
        }
        let t = &mut self.a;
        t.x[slot] = x;
        t.y[slot] = y;
        t.px[slot] = x;
        t.py[slot] = y;
        t.vx[slot] = 0.0;
        t.vy[slot] = 0.0;
        t.hp[slot] = kind_max_hp(t.kind[slot]);
    }

    /// Deaths of this step: event, pickup drop, respawn at the edge so the enemy count stays constant.
    pub fn process_deaths(&mut self) {
        for k in 0..self.dead.len() {
            let slot = self.dead[k] as usize;
            let (x, y, kind) = (self.a.x[slot], self.a.y[slot], self.a.kind[slot]);
            self.event(EV_DEATH, kind, 0, x, y, 0.0);
            self.stats[S_DEATHS] += 1.0;
            if self.rng.next() % 100 < 35 {
                if self.pickups.len() < PICKUP_CAP {
                    self.pickups.push([x, y]);
                } else {
                    let i = (self.tick as usize + k) % PICKUP_CAP;
                    self.pickups[i] = [x, y];
                }
            }
            self.respawn(slot);
        }
    }

    /// Pickup radius around the player, and the one EV_PLAYER_HURT of the step.
    pub fn pickups_and_hurt(&mut self) {
        let (px, py) = (self.a.x[self.player_slot], self.a.y[self.player_slot]);
        let r2 = PICKUP_RADIUS * PICKUP_RADIUS;
        let mut i = 0;
        while i < self.pickups.len() {
            let [x, y] = self.pickups[i];
            let (dx, dy) = (x - px, y - py);
            if dx * dx + dy * dy < r2 {
                self.pickups.swap_remove(i);
                self.event(EV_PICKUP, 0, 0, x, y, 1.0);
            } else {
                i += 1;
            }
        }
        if self.player_hurt > 0.0 {
            let v = self.player_hurt;
            self.event(EV_PLAYER_HURT, 0, 0, px, py, v);
        }
    }

    // ---- Buildings: the wall schedule ---------------------------------------------------------------------

    fn set_building(&mut self, idx: usize, on: bool) {
        let o = idx * 5;
        let (x0, y0, x1, y1) = (self.buildings[o] as i32, self.buildings[o + 1] as i32, self.buildings[o + 2] as i32, self.buildings[o + 3] as i32);
        for yy in y0..y1 {
            for xx in x0..x1 {
                let c = yy as usize * GRID + xx as usize;
                if on {
                    self.blocked[c] |= 2;
                    self.bcell[c] = idx as u16 + 1;
                } else {
                    self.blocked[c] &= !2;
                    self.bcell[c] = 0;
                }
            }
        }
        self.buildings[o + 4] = if on { 1.0 } else { 0.0 };
    }

    /// Player-built walls appear every WALL_PERIOD steps near the player and go away after WALL_LIFE.
    /// Each change updates the blocked grid, sets the world-changed flag, emits an event and restarts the flow field.
    pub fn update_buildings(&mut self) {
        let mut changed = false;
        for s in 0..DYN_SLOTS {
            if self.dyn_expire[s] != 0 && self.tick >= self.dyn_expire[s] {
                let idx = self.static_count + s;
                self.set_building(idx, false);
                self.dyn_expire[s] = 0;
                let o = idx * 5;
                let (cx, cy) = ((self.buildings[o] + self.buildings[o + 2]) * 0.5, (self.buildings[o + 1] + self.buildings[o + 3]) * 0.5);
                self.event(EV_WALL_REMOVED, 0, 0, cx, cy, idx as f32);
                self.wall_changes.push((idx as u32, false));
                changed = true;
            }
        }
        if self.tick % WALL_PERIOD == WALL_PERIOD / 2 {
            if let Some(s) = (0..DYN_SLOTS).find(|&s| self.dyn_expire[s] == 0) {
                let sizes: [(i32, i32); 5] = [(3, 1), (1, 3), (4, 1), (1, 4), (2, 2)];
                let (px, py) = (self.a.x[self.player_slot], self.a.y[self.player_slot]);
                for _try in 0..6 {
                    let (w, h) = sizes[(self.rng.next() % 5) as usize];
                    let ang = self.rng.unit() * core::f32::consts::TAU;
                    let dist = 4.0 + self.rng.unit() * 5.0;
                    let cx = (px + ang.cos() * dist) as i32;
                    let cy = (py + ang.sin() * dist) as i32;
                    if cx < 2 || cy < 2 || cx + w > GRID as i32 - 3 || cy + h > GRID as i32 - 3 {
                        continue;
                    }
                    let mut free = true;
                    for yy in cy..cy + h {
                        for xx in cx..cx + w {
                            if self.blocked[yy as usize * GRID + xx as usize] != 0 {
                                free = false;
                            }
                        }
                    }
                    let (bx, by) = (cx as f32 + w as f32 * 0.5, cy as f32 + h as f32 * 0.5);
                    if !free || (bx - px).abs() < w as f32 * 0.5 + 1.2 && (by - py).abs() < h as f32 * 0.5 + 1.2 {
                        continue;
                    }
                    let idx = self.static_count + s;
                    let o = idx * 5;
                    self.buildings[o..o + 4].copy_from_slice(&[cx as f32, cy as f32, (cx + w) as f32, (cy + h) as f32]);
                    self.set_building(idx, true);
                    self.dyn_expire[s] = self.tick + WALL_LIFE;
                    self.event(EV_WALL_BUILT, 0, 0, bx, by, idx as f32);
                    self.wall_changes.push((idx as u32, true));
                    changed = true;
                    break;
                }
            }
        }
        if changed {
            self.world_changed = true;
            let pc = cell_index(self.a.x[self.player_slot], self.a.y[self.player_slot]);
            self.flow_start(pc); // the field restarts (an unfinished rebuild is abandoned)
        }
    }

    // ---- Projectiles: pool, spawn controller, finishing a sweep, the reference check ---------------------------

    /// Best of four random enemies within 25 units of the player (an approximation of "nearest").
    fn pick_target(&mut self) -> Option<(f32, f32)> {
        let (px, py) = (self.a.x[self.player_slot], self.a.y[self.player_slot]);
        let mut best = 25.0f32 * 25.0;
        let mut found = None;
        for _ in 0..4 {
            let j = (self.rng.next() as usize) % self.n;
            if self.a.kind[j] == PLAYER_KIND || self.a.hp[j] <= 0.0 {
                continue;
            }
            let (dx, dy) = (self.a.x[j] - px, self.a.y[j] - py);
            let d2 = dx * dx + dy * dy;
            if d2 < best {
                best = d2;
                found = Some((self.a.x[j], self.a.y[j]));
            }
        }
        found
    }

    fn add_projectile(&mut self, x: f32, y: f32, dirx: f32, diry: f32, speed: f32, r: f32, dmg: f32, kind: u8, owner: u8, explosive: bool) {
        let pl = &mut self.pool;
        if pl.n >= pl.cap {
            return;
        }
        let i = pl.n;
        pl.n += 1;
        pl.sx[i] = x;
        pl.sy[i] = y;
        pl.ex[i] = x;
        pl.ey[i] = y;
        pl.vx[i] = dirx * speed;
        pl.vy[i] = diry * speed;
        pl.r[i] = r;
        pl.dmg[i] = dmg;
        pl.kind[i] = kind;
        pl.owner[i] = owner;
        pl.life[i] = (36.0 / speed).ceil() as i16; // range of about 36 cells
        pl.state[i] = if explosive { 4 } else { 0 };
        self.stats[S_SHOTS] += 1.0;
        self.shot_count += 1;
        self.event(EV_SHOT, kind as u32, owner as u32, x, y, 0.0);
    }

    /// Removes finished projectiles, then spawns: queued enemy shots first, then player weapons at whatever
    /// rate keeps the live count at the target. After this `pool.n` is the number swept this step.
    pub fn projectile_begin(&mut self) {
        self.pool.compact();
        let target = self.p.proj_target as usize;
        if target == 0 {
            return;
        }
        let (px, py) = (self.a.x[self.player_slot], self.a.y[self.player_slot]);
        for k in 0..self.enemy_shots.len() {
            let [x, y] = self.enemy_shots[k];
            let (dx, dy) = (px - x, py - y);
            let inv = 1.0 / (dx * dx + dy * dy).sqrt().max(1e-3);
            let s = (self.rng.unit() - 0.5) * 0.2;
            let (dirx, diry) = (dx * inv - dy * inv * s, dy * inv + dx * inv * s);
            self.add_projectile(x, y, dirx, diry, 2.0, 0.12, 0.03, BOLT, 1, false);
        }
        let want = target.saturating_sub(self.pool.n);
        for _ in 0..want {
            if self.pool.n >= self.pool.cap {
                break;
            }
            let (dirx, diry) = match self.pick_target() {
                Some((tx, ty)) => {
                    let (dx, dy) = (tx - px, ty - py);
                    let inv = 1.0 / (dx * dx + dy * dy).sqrt().max(1e-3);
                    let s = (self.rng.unit() - 0.5) * 0.1;
                    (dx * inv - dy * inv * s, dy * inv + dx * inv * s)
                }
                None => {
                    let (sn, cs) = (self.rng.unit() * core::f32::consts::TAU).sin_cos();
                    (cs, sn)
                }
            };
            let rocket = self.shot_count % ROCKET_EVERY == ROCKET_EVERY - 1;
            let (sx, sy) = (px + dirx * 0.6, py + diry * 0.6);
            if rocket {
                self.add_projectile(sx, sy, dirx, diry, 2.0, 0.15, 3.0, ROCKET, 0, true);
            } else {
                let speed = 2.0 + 2.0 * self.rng.unit(); // 2 to 4 cells per step
                let r = 0.08 + 0.04 * self.rng.unit();
                self.add_projectile(sx, sy, dirx, diry, speed, r, 1.0, BULLET, 0, false);
            }
        }
    }

    /// Segment of projectile i for this step: (x0, y0, dx, dy). The start is the end of the last step.
    #[inline]
    pub fn projectile_segment(&mut self, i: usize) -> (f32, f32, f32, f32) {
        let pl = &mut self.pool;
        pl.sx[i] = pl.ex[i];
        pl.sy[i] = pl.ey[i];
        (pl.sx[i], pl.sy[i], pl.vx[i], pl.vy[i])
    }

    /// Applies the result of a sweep: moves the projectile to its end or hit point, damages, emits events.
    pub fn projectile_finish(&mut self, i: usize, hit: Hit) {
        let (sx, sy, vx, vy) = (self.pool.sx[i], self.pool.sy[i], self.pool.vx[i], self.pool.vy[i]);
        let (kind, owner, dmg) = (self.pool.kind[i] as u32, self.pool.owner[i] as u32, self.pool.dmg[i]);
        if hit.kind == HitKind::None {
            self.pool.ex[i] = sx + vx;
            self.pool.ey[i] = sy + vy;
            self.pool.life[i] -= 1;
            if self.pool.life[i] <= 0 {
                self.pool.state[i] |= 2;
            }
            return;
        }
        let (ex, ey) = (sx + vx * hit.t, sy + vy * hit.t);
        self.pool.ex[i] = ex;
        self.pool.ey[i] = ey;
        self.pool.state[i] |= 3; // hit this step, and gone before the next
        self.stats[S_PROJ_HITS] += 1.0;
        match hit.kind {
            HitKind::Enemy(slot) => {
                let k = self.a.kind[slot as usize];
                self.damage_enemy(slot as usize, dmg);
                self.event(EV_HIT, k, owner, ex, ey, dmg);
                self.stats[S_HITS_ENEMY] += 1.0;
            }
            HitKind::Player => {
                self.hurt_player(dmg);
                self.stats[S_HITS_PLAYER] += 1.0;
            }
            _ => {
                self.event(EV_HIT, 255, owner, ex, ey, dmg);
                self.stats[S_HITS_WALL] += 1.0;
            }
        }
        if self.pool.state[i] & 4 != 0 {
            self.explosions.push([ex, ey, EXPLOSION_RADIUS, EXPLOSION_DAMAGE]);
            self.event(EV_EXPLOSION, kind, owner, ex, ey, EXPLOSION_RADIUS);
            self.stats[S_EXPLOSIONS] += 1.0;
        }
    }

    /// Slow exact reference: the first hit of projectile i's segment against EVERY map wall cell, EVERY active
    /// building and EVERY enemy (or the player, for enemy shots), with the same primitives as the fast path.
    pub fn reference_hit(&self, i: usize, dr: f32) -> f32 {
        let pl = &self.pool;
        // `dr` grows or shrinks the projectile radius (used for the grazing tolerance of the Rapier build).
        let (x0, y0, dx, dy, r) = (pl.sx[i], pl.sy[i], pl.vx[i], pl.vy[i], pl.r[i] + dr);
        let (minx, maxx) = (x0.min(x0 + dx) - r, x0.max(x0 + dx) + r);
        let (miny, maxy) = (y0.min(y0 + dy) - r, y0.max(y0 + dy) + r);
        let mut best = INF;
        for w in &self.walls {
            if w[2] < minx || w[0] > maxx || w[3] < miny || w[1] > maxy {
                continue;
            }
            best = best.min(sweep_circle_aabb(x0, y0, dx, dy, r, w[0], w[1], w[2], w[3]));
        }
        for b in 0..self.buildings.len() / 5 {
            let o = b * 5;
            if self.buildings[o + 4] < 0.5 {
                continue;
            }
            let bb = &self.buildings[o..o + 4];
            if bb[2] < minx || bb[0] > maxx || bb[3] < miny || bb[1] > maxy {
                continue;
            }
            best = best.min(sweep_circle_aabb(x0, y0, dx, dy, r, bb[0], bb[1], bb[2], bb[3]));
        }
        if pl.owner[i] == 0 {
            let t = &self.a;
            for j in 0..self.n {
                if t.kind[j] == PLAYER_KIND {
                    continue;
                }
                let rr = t.radius[j] + r;
                if t.x[j] < minx - rr || t.x[j] > maxx + rr || t.y[j] < miny - rr || t.y[j] > maxy + rr {
                    continue;
                }
                best = best.min(sweep_circle_circle(x0, y0, dx, dy, t.x[j], t.y[j], rr));
            }
        } else {
            let ps = self.player_slot;
            best = best.min(sweep_circle_circle(x0, y0, dx, dy, self.a.x[ps], self.a.y[ps], PLAYER_RADIUS + r));
        }
        best
    }

    /// Compares the fast path's result for projectile i with the reference and counts the differences.
    /// `check_margin` is 0 for our own build: any disagreement counts. For the Rapier build (margin > 0) a
    /// disagreement counts as a pass-through (or false hit) only if it also holds with the projectile `check_margin`
    /// smaller (larger); one that only holds at the exact radius is a graze, counted separately in `S_GRAZE`,
    /// because Rapier's shape cast does not resolve contacts shallower than a few mm.
    pub fn check_projectile(&mut self, i: usize, fast_t: f32) {
        self.stats[S_CHECKED] += 1.0;
        let eps = self.check_eps;
        let exact = self.reference_hit(i, 0.0);
        let (lo, hi) = if self.check_margin > 0.0 { (self.reference_hit(i, -self.check_margin), self.reference_hit(i, self.check_margin)) } else { (exact, exact) };
        if lo < fast_t - eps {
            self.stats[S_PASS_THROUGH] += 1.0;
        } else if fast_t < hi - eps {
            self.stats[S_FALSE_HIT] += 1.0;
        } else if exact < fast_t - eps || fast_t < exact - eps {
            self.stats[S_GRAZE] += 1.0;
        }
    }

    // ---- Snapshot ----------------------------------------------------------------------------------------------

    pub fn write_snapshot(&mut self, start: u32) {
        let n = self.n;
        let pn = self.pool.n;
        let en = self.ev_n;
        let t = &self.a;
        let s = &mut self.snapshot;
        let mut o = V2_HEADER_BYTES;
        macro_rules! put {
            ($v:expr) => {{
                s[o..o + 4].copy_from_slice(&$v.to_le_bytes());
                o += 4;
            }};
        }
        for i in 0..n {
            put!(t.px[i]);
            put!(t.py[i]);
            put!(t.x[i]);
            put!(t.y[i]);
            put!(t.pfacing[i]);
            put!(t.facing[i]);
            let k = t.kind[i];
            let hp8 = ((t.hp[i] / kind_max_hp(k)).clamp(0.0, 1.0) * 255.0) as u32;
            let packed = (k & 0xff) | hp8 << 8 | ((t.flags[i] & FLAG_HIT) | kind_flags(k)) << 16;
            put!(packed);
            put!(t.radius[i]);
        }
        let pl = &self.pool;
        for i in 0..pn {
            put!(pl.sx[i]);
            put!(pl.sy[i]);
            put!(pl.ex[i]);
            put!(pl.ey[i]);
            let packed = pl.kind[i] as u32 | (pl.owner[i] as u32) << 8 | ((pl.state[i] & 1) as u32) << 9 | (((pl.state[i] >> 2) & 1) as u32) << 10;
            put!(packed);
            put!(pl.r[i]);
        }
        for w in 0..en * 4 {
            put!(self.events[w]);
        }
        self.snapshot_used = o;
        let ps = self.player_slot;
        let tm = self.timing;
        let h = &mut self.snapshot;
        let u = |h: &mut Vec<u8>, slot: usize, v: u32| h[slot * 4..slot * 4 + 4].copy_from_slice(&v.to_le_bytes());
        let f = |h: &mut Vec<u8>, slot: usize, v: f32| h[slot * 4..slot * 4 + 4].copy_from_slice(&v.to_le_bytes());
        u(h, 0, start);
        u(h, 1, self.tick);
        u(h, 2, n as u32);
        u(h, 4, pn as u32);
        u(h, 5, en as u32);
        u(h, 6, self.ev_dropped);
        u(h, 7, self.world_changed as u32);
        f(h, 8, self.a.px[ps]);
        f(h, 9, self.a.py[ps]);
        f(h, 10, self.a.x[ps]);
        f(h, 11, self.a.y[ps]);
        f(h, 12, self.a.hp[ps]);
        u(h, 13, self.pickups.len() as u32);
        for k in 0..13 {
            f(h, 18 + k, tm[k]);
        }
        self.stats[S_SNAP_USED] = o as f64;
    }

    /// Overwrites one timing slot in the header of the snapshot already written (the snapshot write and
    /// the whole step can only be timed after the snapshot exists).
    pub fn patch_timing(&mut self, slot: usize, ms: f32) {
        let o = (18 + slot) * 4;
        self.snapshot[o..o + 4].copy_from_slice(&ms.to_le_bytes());
    }

    pub fn checksum(&self) -> f64 {
        let mut s = 0.0f64;
        for i in 0..self.n {
            s += self.a.x[i] as f64 + self.a.y[i] as f64;
        }
        s
    }
}

/// Exports shared by both builds. The sim type needs `create(&Params) -> Sim`, `step(&mut self, f32, f32, u32)`,
/// and a `core: Core` field.
#[macro_export]
macro_rules! export_ffi {
    ($sim:ty) => {
        static mut SIM: Option<$sim> = None;

        #[allow(static_mut_refs)]
        fn sim() -> &'static mut $sim {
            unsafe { SIM.as_mut().expect("init not called") }
        }

        #[no_mangle]
        pub extern "C" fn init(method: u32, enemies: u32, seed: u32, spawn: f32, proj_target: u32, proj_cap: u32, event_cap: u32, passes: u32, flags: u32) {
            let p = $crate::shared::Params { method, enemies, seed, spawn, proj_target, proj_cap: proj_cap.max(proj_target), event_cap, passes: passes.max(1), flags };
            unsafe { SIM = Some(<$sim>::create(&p)) };
        }
        #[no_mangle]
        pub extern "C" fn step(move_x: f32, move_y: f32, buttons: u32) {
            sim().step(move_x, move_y, buttons);
        }
        /// Stage 11: the live enemy count, within the count given at init (grid builds only, see Core::set_active).
        #[no_mangle]
        pub extern "C" fn set_enemies(e: u32) {
            sim().core.set_active(e as usize + 1);
        }
        /// Changes the target live projectile count (push-past sweeps). The pool capacity is fixed at init.
        #[no_mangle]
        pub extern "C" fn set_target(t: u32) {
            let c = &mut sim().core;
            c.p.proj_target = t.min(c.pool.cap as u32);
        }
        #[no_mangle]
        pub extern "C" fn snapshot_ptr() -> *const u8 {
            sim().core.snapshot.as_ptr()
        }
        #[no_mangle]
        pub extern "C" fn snapshot_len() -> u32 {
            sim().core.snapshot.len() as u32
        }
        /// Bytes of the snapshot used by the last step (it varies with the projectile and event counts).
        #[no_mangle]
        pub extern "C" fn snapshot_used() -> u32 {
            sim().core.snapshot_used as u32
        }
        #[no_mangle]
        pub extern "C" fn blocked_ptr() -> *const u8 {
            sim().core.blocked.as_ptr()
        }
        /// The building list: 5 floats per box (x0, y0, x1, y1, active).
        #[no_mangle]
        pub extern "C" fn buildings_ptr() -> *const f32 {
            sim().core.buildings.as_ptr()
        }
        #[no_mangle]
        pub extern "C" fn buildings_len() -> u32 {
            sim().core.buildings.len() as u32
        }
        #[no_mangle]
        pub extern "C" fn stat(i: u32) -> f64 {
            let c = &mut sim().core;
            if i as usize == $crate::shared::S_FLOW_REBUILDS {
                return c.flow_rebuilds as f64;
            }
            c.stats[i as usize]
        }
        #[no_mangle]
        pub extern "C" fn checksum() -> f64 {
            sim().core.checksum()
        }
    };
}
