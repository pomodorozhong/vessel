//! Vessel prototype sim (Stage 1): struct-of-arrays entities, movement, circle collision on a
//! spatial hash grid, entities sorted by grid cell every step, one flow field toward the player
//! rebuilt incrementally, staggered AI, and static obstacles.
//!
//! `prototype/src/sim-ts.ts` is the same algorithm in typed-array TypeScript. Keep them in step.

pub const HEADER_BYTES: usize = 80;
pub const ENTRY_BYTES: usize = 32;

pub const GRID: usize = 256; // cells per side; a cell is 1 world unit
pub const CELLS: usize = GRID * GRID;
pub const DT: f32 = 1.0 / 30.0;
pub const THINK_EVERY: u32 = 8; // each enemy thinks every 8th step (3.75 times per second), staggered by id
pub const FLOW_BUDGET: usize = 16384; // flow-field cells expanded per step (a full rebuild takes 4 steps)
pub const KINDS: u32 = 16;
pub const PLAYER_KIND: u32 = 16;
pub const PLAYER_SPEED: f32 = 5.0;
pub const PLAYER_RADIUS: f32 = 0.4;
pub const TURN_RATE: f32 = 0.35; // radians per step
const UNREACHED: u16 = u16::MAX;

// The import module is named explicitly: newer Rust no longer lets undefined symbols through the
// WASM linker, so without it the build fails with "undefined symbol: now".
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
fn clock() -> f64 {
    unsafe { now() }
}

/// One set of entity columns. Two sets exist so the per-step sort scatters from one into the other.
#[derive(Default)]
struct Table {
    x: Vec<f32>,
    y: Vec<f32>,
    px: Vec<f32>,
    py: Vec<f32>,
    vx: Vec<f32>,
    vy: Vec<f32>,
    facing: Vec<f32>,
    pfacing: Vec<f32>,
    tfacing: Vec<f32>,
    radius: Vec<f32>,
    kind: Vec<u32>,
    id: Vec<u32>,
}

impl Table {
    fn new(n: usize) -> Self {
        // Padded to a multiple of 4 so SIMD loops never need a scalar tail.
        let m = (n + 3) & !3;
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
            kind: vec![0; m],
            id: vec![0; m],
        }
    }
}

pub struct Sim {
    n: usize,
    tick: u32,
    a: Table,
    b: Table,
    cell_of: Vec<u32>,
    cell_start: Vec<u32>, // CELLS + 1 entries: entities of cell c are cell_start[c]..cell_start[c + 1]
    cursor: Vec<u32>,
    blocked: Vec<u8>,
    dist: Vec<u16>,      // flow field in use: steps to the player's cell
    dist_back: Vec<u16>, // flow field being rebuilt
    queue: Vec<u32>,
    q_head: usize,
    q_tail: usize,
    building: bool,
    goal_cell: u32,  // goal of the field in use or being built
    player_cell: u32,
    player_slot: usize,
    snapshot: Vec<u8>,
    pub pairs_tested: u32,
    pub pairs_hit: u32,
    pub flow_rebuilds: u32,
}

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 8) as f32 / 16_777_216.0
    }
}

#[inline]
fn hash(a: u32, b: u32) -> u32 {
    let mut h = a.wrapping_mul(0x9E37_79B1) ^ b.wrapping_mul(0x85EB_CA77);
    h ^= h >> 15;
    h = h.wrapping_mul(0xC2B2_AE3D);
    h ^ (h >> 13)
}

#[inline]
fn cell_index(x: f32, y: f32) -> u32 {
    let cx = (x as i32).clamp(0, GRID as i32 - 1) as u32;
    let cy = (y as i32).clamp(0, GRID as i32 - 1) as u32;
    cy * GRID as u32 + cx
}

pub fn kind_radius(kind: u32) -> f32 {
    0.25 + 0.015 * kind as f32
}
pub fn kind_speed(kind: u32) -> f32 {
    2.0 + 0.1 * (kind % 5) as f32
}

impl Sim {
    pub fn new(n: usize, seed: u32, spawn_radius: f32) -> Sim {
        let mut rng = Rng(seed.wrapping_mul(2_654_435_761).max(1));
        // Obstacles: a border wall, single "trees" and short wall segments. The centre stays clear.
        let mut blocked = vec![0u8; CELLS];
        for i in 0..GRID {
            blocked[i] = 1;
            blocked[(GRID - 1) * GRID + i] = 1;
            blocked[i * GRID] = 1;
            blocked[i * GRID + GRID - 1] = 1;
        }
        let centre = (GRID / 2) as i32;
        let mut block = |blocked: &mut Vec<u8>, cx: i32, cy: i32| {
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

        let mut a = Table::new(n);
        // Entity 0 is the player, at the centre.
        a.x[0] = centre as f32 + 0.5;
        a.y[0] = centre as f32 + 0.5;
        a.radius[0] = PLAYER_RADIUS;
        a.kind[0] = PLAYER_KIND;
        a.id[0] = 0;
        for i in 1..n {
            loop {
                let mut x = 1.0 + rng.unit() * (GRID as f32 - 2.0);
                let mut y = 1.0 + rng.unit() * (GRID as f32 - 2.0);
                if spawn_radius > 0.0 {
                    // Dense start for render tests: spawn inside a square around the player.
                    x = centre as f32 + (x / GRID as f32 - 0.5) * 2.0 * spawn_radius;
                    y = centre as f32 + (y / GRID as f32 - 0.5) * 2.0 * spawn_radius;
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
        let mut sim = Sim {
            n,
            tick: 0,
            a,
            b: Table::new(n),
            cell_of: vec![0; n],
            cell_start: vec![0; CELLS + 1],
            cursor: vec![0; CELLS],
            blocked,
            dist: vec![UNREACHED; CELLS],
            dist_back: vec![UNREACHED; CELLS],
            queue: vec![0; CELLS],
            q_head: 0,
            q_tail: 0,
            building: false,
            goal_cell: player_cell,
            player_cell,
            player_slot: 0,
            snapshot: vec![0u8; HEADER_BYTES + ENTRY_BYTES * n],
            pairs_tested: 0,
            pairs_hit: 0,
            flow_rebuilds: 0,
        };
        // The first field is built in full so enemies have a direction from step 0.
        sim.flow_start(player_cell);
        sim.flow_advance(usize::MAX);
        sim.sort_by_cell();
        sim
    }

    fn flow_start(&mut self, goal: u32) {
        self.dist_back.fill(UNREACHED);
        self.dist_back[goal as usize] = 0;
        self.queue[0] = goal;
        self.q_head = 0;
        self.q_tail = 1;
        self.building = true;
        self.goal_cell = goal;
    }

    /// Expands up to `budget` cells of the breadth-first flood. Swaps the field in when it is complete.
    fn flow_advance(&mut self, budget: usize) {
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

    /// Direction of steepest descent of the field at a cell, over 8 neighbours, no corner cutting.
    #[inline]
    fn flow_dir(&self, c: usize) -> (f32, f32) {
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
            if dx != 0 && dy != 0 {
                // A diagonal step must not cut a blocked corner.
                if self.blocked[(cy * g + nx) as usize] != 0 || self.blocked[(ny * g + cx) as usize] != 0 {
                    continue;
                }
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

    fn ai(&mut self, move_x: f32, move_y: f32) {
        let phase = self.tick % THINK_EVERY;
        let (px, py) = (self.a.x[self.player_slot], self.a.y[self.player_slot]);
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
                // Next to the player (or no path): head straight for the player.
                let inv = 1.0 / d2.sqrt().max(1e-3);
                dx = to_px * inv;
                dy = to_py * inv;
            }
            // A small per-think wobble so a crowd does not move as one rigid block.
            let h = hash(id, self.tick);
            let wobble = ((h & 0xffff) as f32 / 65535.0 - 0.5) * 0.6;
            let (wx, wy) = (dx - dy * wobble, dy + dx * wobble);
            let speed = kind_speed(self.a.kind[i]) * (0.85 + 0.3 * ((h >> 16) & 0xff) as f32 / 255.0);
            self.a.vx[i] = wx * speed;
            self.a.vy[i] = wy * speed;
            self.a.tfacing[i] = wy.atan2(wx);
        }
    }

    fn integrate(&mut self) {
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
                v128_store(t.x.as_mut_ptr().add(i) as *mut v128, f32x4_add(x, f32x4_mul(vx, dt)));
                v128_store(t.y.as_mut_ptr().add(i) as *mut v128, f32x4_add(y, f32x4_mul(vy, dt)));
                // Turn toward the target facing by at most TURN_RATE, the short way round.
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
                t.x[i] += t.vx[i] * DT;
                t.y[i] += t.vy[i] * DT;
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
    }

    /// Counting sort by grid cell: neighbours in space become neighbours in memory.
    fn sort_by_cell(&mut self) {
        let n = self.n;
        self.cell_start.fill(0);
        for i in 0..n {
            let c = cell_index(self.a.x[i], self.a.y[i]);
            self.cell_of[i] = c;
            self.cell_start[c as usize + 1] += 1;
        }
        for c in 0..CELLS {
            self.cell_start[c + 1] += self.cell_start[c];
        }
        self.cursor.copy_from_slice(&self.cell_start[..CELLS]);
        let (a, b) = (&self.a, &mut self.b);
        for i in 0..n {
            let c = self.cell_of[i] as usize;
            let j = self.cursor[c] as usize;
            self.cursor[c] += 1;
            b.x[j] = a.x[i];
            b.y[j] = a.y[i];
            b.px[j] = a.px[i];
            b.py[j] = a.py[i];
            b.vx[j] = a.vx[i];
            b.vy[j] = a.vy[i];
            b.facing[j] = a.facing[i];
            b.pfacing[j] = a.pfacing[i];
            b.tfacing[j] = a.tfacing[i];
            b.radius[j] = a.radius[i];
            b.kind[j] = a.kind[i];
            b.id[j] = a.id[i];
            if a.id[i] == 0 {
                self.player_slot = j;
            }
        }
        core::mem::swap(&mut self.a, &mut self.b);
    }

    #[inline]
    fn collide_pair(t: &mut Table, i: usize, j: usize, hit: &mut u32) {
        let dx = t.x[j] - t.x[i];
        let dy = t.y[j] - t.y[i];
        let r = t.radius[i] + t.radius[j];
        let d2 = dx * dx + dy * dy;
        if d2 >= r * r {
            return;
        }
        *hit += 1;
        let d = d2.sqrt();
        let (nx, ny) = if d > 1e-5 { (dx / d, dy / d) } else { (1.0, 0.0) };
        let push = r - d;
        // The player is never pushed, so a scripted run follows the same path in every sim variant.
        let (wi, wj) = if t.id[i] == 0 {
            (0.0, 1.0)
        } else if t.id[j] == 0 {
            (1.0, 0.0)
        } else {
            (0.5, 0.5)
        };
        t.x[i] -= nx * push * wi;
        t.y[i] -= ny * push * wi;
        t.x[j] += nx * push * wj;
        t.y[j] += ny * push * wj;
    }

    fn collide(&mut self) {
        let mut tested = 0u32;
        let mut hit = 0u32;
        let g = GRID;
        let t = &mut self.a;
        let cs = &self.cell_start;
        for cy in 0..g {
            for cx in 0..g {
                let c = cy * g + cx;
                let s = cs[c] as usize;
                let e = cs[c + 1] as usize;
                if s == e {
                    continue;
                }
                // Pairs inside the cell.
                for i in s..e {
                    for j in i + 1..e {
                        tested += 1;
                        Self::collide_pair(t, i, j, &mut hit);
                    }
                }
                // Pairs with half of the neighbours (E, NW, N, NE), so each cell pair is visited once.
                let mut neighbours = [usize::MAX; 4];
                if cx + 1 < g {
                    neighbours[0] = c + 1;
                }
                if cy + 1 < g {
                    if cx > 0 {
                        neighbours[1] = c + g - 1;
                    }
                    neighbours[2] = c + g;
                    if cx + 1 < g {
                        neighbours[3] = c + g + 1;
                    }
                }
                for nc in neighbours {
                    if nc == usize::MAX {
                        continue;
                    }
                    let ns = cs[nc] as usize;
                    let ne = cs[nc + 1] as usize;
                    for i in s..e {
                        for j in ns..ne {
                            tested += 1;
                            Self::collide_pair(t, i, j, &mut hit);
                        }
                    }
                }
            }
        }
        self.pairs_tested = tested;
        self.pairs_hit = hit;
    }

    fn collide_obstacles(&mut self) {
        let g = GRID as i32;
        let max = GRID as f32 - 1.0;
        for i in 0..self.n {
            let r = self.a.radius[i];
            let mut x = self.a.x[i];
            let mut y = self.a.y[i];
            let cx = x as i32;
            let cy = y as i32;
            for ny in cy - 1..=cy + 1 {
                for nx in cx - 1..=cx + 1 {
                    if nx < 0 || ny < 0 || nx >= g || ny >= g || self.blocked[(ny * g + nx) as usize] == 0 {
                        continue;
                    }
                    // Circle against the cell's square.
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
                        // Centre inside the square: leave by the nearest face.
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
            self.a.x[i] = x.clamp(1.0, max);
            self.a.y[i] = y.clamp(1.0, max);
        }
    }

    fn write_snapshot(&mut self) {
        let t = &self.a;
        let out = &mut self.snapshot[HEADER_BYTES..];
        for i in 0..self.n {
            let e = &mut out[i * ENTRY_BYTES..(i + 1) * ENTRY_BYTES];
            e[0..4].copy_from_slice(&t.px[i].to_le_bytes());
            e[4..8].copy_from_slice(&t.py[i].to_le_bytes());
            e[8..12].copy_from_slice(&t.x[i].to_le_bytes());
            e[12..16].copy_from_slice(&t.y[i].to_le_bytes());
            e[16..20].copy_from_slice(&t.pfacing[i].to_le_bytes());
            e[20..24].copy_from_slice(&t.facing[i].to_le_bytes());
            e[24..28].copy_from_slice(&t.kind[i].to_le_bytes());
            e[28..32].copy_from_slice(&t.radius[i].to_le_bytes());
        }
    }

    pub fn step(&mut self, move_x: f32, move_y: f32, _buttons: u32) {
        let t0 = clock();
        self.ai(move_x, move_y);
        let t1 = clock();
        self.integrate();
        self.sort_by_cell();
        let t2 = clock();
        self.collide();
        self.collide_obstacles();
        let t3 = clock();
        let pc = cell_index(self.a.x[self.player_slot], self.a.y[self.player_slot]);
        self.player_cell = pc;
        if !self.building && pc != self.goal_cell {
            self.flow_start(pc);
        }
        self.flow_advance(FLOW_BUDGET);
        let t4 = clock();
        let start = self.tick;
        self.tick += 1;
        self.write_snapshot();
        let t5 = clock();

        let (plx, ply) = (self.a.x[self.player_slot], self.a.y[self.player_slot]);
        let h = &mut self.snapshot;
        h[0..4].copy_from_slice(&start.to_le_bytes());
        h[4..8].copy_from_slice(&self.tick.to_le_bytes());
        h[8..12].copy_from_slice(&(self.n as u32).to_le_bytes());
        let f = |h: &mut Vec<u8>, slot: usize, v: f32| h[slot * 4..slot * 4 + 4].copy_from_slice(&v.to_le_bytes());
        f(h, 4, (t5 - t0) as f32);
        f(h, 5, (t3 - t2) as f32);
        f(h, 6, (t4 - t3) as f32);
        f(h, 7, (t1 - t0) as f32);
        f(h, 8, (t5 - t4) as f32);
        f(h, 9, (t2 - t1) as f32);
        f(h, 10, plx);
        f(h, 11, ply);
        f(h, 16, self.a.px[self.player_slot]);
        f(h, 17, self.a.py[self.player_slot]);
    }

    pub fn snapshot(&self) -> &[u8] {
        &self.snapshot
    }
    pub fn blocked(&self) -> &[u8] {
        &self.blocked
    }
    /// Sum of all positions: a cheap fingerprint to compare sim variants.
    pub fn checksum(&self) -> f64 {
        let mut s = 0.0f64;
        for i in 0..self.n {
            s += self.a.x[i] as f64 + self.a.y[i] as f64;
        }
        s
    }
}

static mut SIM: Option<Sim> = None;

#[allow(static_mut_refs)]
fn sim() -> &'static mut Sim {
    unsafe { SIM.as_mut().expect("init not called") }
}

#[no_mangle]
pub extern "C" fn init(n: u32, seed: u32, spawn_radius: f32) {
    unsafe { SIM = Some(Sim::new(n as usize, seed, spawn_radius)) };
}

/// Steps the whole sim once. One coarse call per step, never one per entity.
#[no_mangle]
pub extern "C" fn step(move_x: f32, move_y: f32, buttons: u32) {
    sim().step(move_x, move_y, buttons);
}

#[no_mangle]
pub extern "C" fn snapshot_ptr() -> *const u8 {
    sim().snapshot.as_ptr()
}

#[no_mangle]
pub extern "C" fn snapshot_len() -> u32 {
    sim().snapshot.len() as u32
}

#[no_mangle]
pub extern "C" fn blocked_ptr() -> *const u8 {
    sim().blocked.as_ptr()
}

#[no_mangle]
pub extern "C" fn pairs_tested() -> u32 {
    sim().pairs_tested
}

#[no_mangle]
pub extern "C" fn pairs_hit() -> u32 {
    sim().pairs_hit
}

#[no_mangle]
pub extern "C" fn flow_rebuilds() -> u32 {
    sim().flow_rebuilds
}

#[no_mangle]
pub extern "C" fn checksum() -> f64 {
    sim().checksum()
}
