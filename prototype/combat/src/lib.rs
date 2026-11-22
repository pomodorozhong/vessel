//! Vessel prototype, Stage 8: the combat sim with three ways to find overlapping pairs.
//!
//! One step: AI, integrate, sort, projectiles (swept against walls, buildings and enemies), area effects,
//! crowd pushing (candidate pairs once, K exact-check + push passes), the wall schedule, obstacle collision,
//! deaths and respawns, the flow field, the snapshot. See `shared.rs` for everything the three methods share.
//!
//! The three methods differ only in how the candidate pairs of a step are gathered and checked:
//!   A  run 1's spatial hash grid, entities physically sorted by cell; candidates gathered by scanning own +
//!      E/NW/N/NE cells; exact checks in scalar code.
//!   B  sort-and-sweep along x over a persistent order array kept sorted by insertion sort (the order is
//!      coherent between steps); the table itself is not reordered. A cell index is still built for the
//!      projectile and area queries (B has no grid otherwise), and its cost is part of B's integrate+sort slot.
//!   C  the grid of A, but the exact distance checks run 4 at a time with wasm simd128 over the flat candidate
//!      arrays; hits are resolved in scalar code. Outside wasm simd the kernel falls back to scalar.
//!
//! The candidate list has a small margin (CAND_MARGIN) so that the K push passes can reuse it; every method
//! uses the same coarse test, so the three candidate sets are identical (see the `pair_sets_equal` test).

#[macro_use]
pub mod shared;
use shared::*;

pub const CAND_MARGIN: f32 = 0.1;
const _: () = assert!(2.0 * LARGE_RADIUS + CAND_MARGIN <= 1.0 + 1e-6, "pair reach must not exceed one grid cell");
const MAX_R: f32 = LARGE_RADIUS; // the largest entity radius, for the sweep break

pub struct Sim {
    pub core: Core,
    method: u32,
    passes: usize,
    indirect: bool, // method B: queries go through `items`
    cell_of: Vec<u32>,
    cell_start: Vec<u32>, // CELLS + 1 entries
    cursor: Vec<u32>,
    items: Vec<u32>, // method B: entity slots grouped by cell
    order: Vec<u32>, // method B: entity slots sorted by x
    cand_i: Vec<u32>,
    cand_j: Vec<u32>,
    hits: Vec<u32>, // indices into the candidate arrays
    pub order_moves: u32,
}

#[inline(always)]
fn coarse(t: &Table, i: usize, j: usize, m: f32) -> bool {
    let dx = t.x[j] - t.x[i];
    let dy = t.y[j] - t.y[i];
    let r = t.radius[i] + t.radius[j] + m;
    dx * dx + dy * dy < r * r
}

impl Sim {
    pub fn create(p: &Params) -> Sim {
        let core = Core::new(p);
        let n = core.n;
        let mut sim = Sim {
            core,
            method: p.method,
            passes: p.passes as usize,
            indirect: p.method == 1,
            cell_of: vec![0; n],
            cell_start: vec![0; CELLS + 1],
            cursor: vec![0; CELLS],
            items: vec![0; n],
            order: (0..n as u32).collect(),
            cand_i: Vec::with_capacity(8 * n),
            cand_j: Vec::with_capacity(8 * n),
            hits: Vec::with_capacity(4 * n),
            order_moves: 0,
        };
        sim.sort_structures();
        sim
    }

    // ---- Sorting and the spatial index ------------------------------------------------------------------

    /// Counting sort by grid cell: neighbours in space become neighbours in memory (methods A and C).
    pub fn sort_by_cell(&mut self) {
        let n = self.core.n;
        self.cell_start.fill(0);
        for i in 0..n {
            let c = cell_index(self.core.a.x[i], self.core.a.y[i]);
            self.cell_of[i] = c;
            self.cell_start[c as usize + 1] += 1;
        }
        for c in 0..CELLS {
            self.cell_start[c + 1] += self.cell_start[c];
        }
        self.cursor.copy_from_slice(&self.cell_start[..CELLS]);
        let mut player = self.core.player_slot;
        {
            let (a, b) = (&self.core.a, &mut self.core.b);
            for i in 0..n {
                let c = self.cell_of[i] as usize;
                let j = self.cursor[c] as usize;
                self.cursor[c] += 1;
                b.put(j, a, i);
                if a.kind[i] == PLAYER_KIND {
                    player = j;
                }
            }
        }
        self.core.player_slot = player;
        core::mem::swap(&mut self.core.a, &mut self.core.b);
    }

    /// Method B: insertion sort of the persistent order by x. A teleport (a respawn) can cost a long run of
    /// moves, so past 16 moves per entity the sort falls back to a full sort (counted in `order_moves`).
    pub fn sort_order_by_x(&mut self) {
        let n = self.core.n;
        // Stage 11's wave changes the live count between steps (Core::set_active): keep the order a permutation of
        // the live slots. Shrinking drops the slots past n, growing appends the new ones (the sort below places them).
        if self.order.len() != n {
            let old = self.order.len();
            if n < old {
                self.order.retain(|&v| (v as usize) < n);
            } else {
                self.order.extend(old as u32..n as u32);
            }
        }
        let x = &self.core.a.x;
        let order = &mut self.order;
        let limit = 16 * n as u32;
        let mut moves = 0u32;
        let mut k = 1;
        while k < n {
            let v = order[k];
            let xv = x[v as usize];
            let mut j = k;
            while j > 0 && x[order[j - 1] as usize] > xv {
                order[j] = order[j - 1];
                j -= 1;
                moves += 1;
            }
            order[j] = v;
            if moves > limit {
                order.sort_unstable_by(|&p, &q| x[p as usize].partial_cmp(&x[q as usize]).unwrap());
                moves = u32::MAX;
                break;
            }
            k += 1;
        }
        self.order_moves = moves;
        self.core.stats[S_ORDER_MOVES] = moves as f64;
    }

    /// Method B: counting sort of entity indices by cell, for the projectile and area queries.
    pub fn build_cell_items(&mut self) {
        let n = self.core.n;
        self.cell_start.fill(0);
        for i in 0..n {
            let c = cell_index(self.core.a.x[i], self.core.a.y[i]);
            self.cell_of[i] = c;
            self.cell_start[c as usize + 1] += 1;
        }
        for c in 0..CELLS {
            self.cell_start[c + 1] += self.cell_start[c];
        }
        self.cursor.copy_from_slice(&self.cell_start[..CELLS]);
        for i in 0..n {
            let c = self.cell_of[i] as usize;
            self.items[self.cursor[c] as usize] = i as u32;
            self.cursor[c] += 1;
        }
    }

    fn sort_structures(&mut self) {
        if self.method == 1 {
            self.sort_order_by_x();
            self.build_cell_items();
        } else {
            self.sort_by_cell();
        }
    }

    #[inline(always)]
    fn item(&self, k: usize) -> usize {
        if self.indirect {
            self.items[k] as usize
        } else {
            k
        }
    }

    // ---- Pair finding (the compared part) --------------------------------------------------------------------

    /// A and C: scan every cell, its own pairs and the pairs with E, NW, N and NE (each cell pair visited once).
    pub fn gather_grid(&mut self, margin: f32) -> u32 {
        self.cand_i.clear();
        self.cand_j.clear();
        let mut tested = 0u32;
        let g = GRID;
        let t = &self.core.a;
        let cs = &self.cell_start;
        let (ci, cj) = (&mut self.cand_i, &mut self.cand_j);
        for cy in 0..g {
            for cx in 0..g {
                let c = cy * g + cx;
                let s = cs[c] as usize;
                let e = cs[c + 1] as usize;
                if s == e {
                    continue;
                }
                for i in s..e {
                    for j in i + 1..e {
                        tested += 1;
                        if coarse(t, i, j, margin) {
                            ci.push(i as u32);
                            cj.push(j as u32);
                        }
                    }
                }
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
                            if coarse(t, i, j, margin) {
                                ci.push(i as u32);
                                cj.push(j as u32);
                            }
                        }
                    }
                }
            }
        }
        tested
    }

    /// B: for every entity, walk forward through the x-sorted order while the x gap can still overlap.
    pub fn gather_sweep(&mut self, margin: f32) -> u32 {
        self.cand_i.clear();
        self.cand_j.clear();
        let mut tested = 0u32;
        let n = self.core.n;
        let t = &self.core.a;
        let order = &self.order;
        let (ci, cj) = (&mut self.cand_i, &mut self.cand_j);
        for a in 0..n {
            let i = order[a] as usize;
            let limit = t.x[i] + t.radius[i] + MAX_R + margin;
            for b in a + 1..n {
                let j = order[b] as usize;
                if t.x[j] > limit {
                    break;
                }
                tested += 1;
                if coarse(t, i, j, margin) {
                    ci.push(i as u32);
                    cj.push(j as u32);
                }
            }
        }
        tested
    }

    // ---- Exact checks over the flat candidate arrays ---------------------------------------------------------

    pub fn exact_scalar(&mut self) {
        self.hits.clear();
        let t = &self.core.a;
        let (ci, cj) = (&self.cand_i, &self.cand_j);
        for k in 0..ci.len() {
            unsafe {
                let i = *ci.get_unchecked(k) as usize;
                let j = *cj.get_unchecked(k) as usize;
                let dx = *t.x.get_unchecked(j) - *t.x.get_unchecked(i);
                let dy = *t.y.get_unchecked(j) - *t.y.get_unchecked(i);
                let r = *t.radius.get_unchecked(i) + *t.radius.get_unchecked(j);
                if dx * dx + dy * dy < r * r {
                    self.hits.push(k as u32);
                }
            }
        }
    }

    /// Four candidate pairs per iteration with simd128: the coordinates are gathered with scalar loads (wasm has
    /// no gather), the distance test runs in vector code, the hit mask is read back and hits are listed.
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    pub fn exact_simd(&mut self) {
        use core::arch::wasm32::*;
        self.hits.clear();
        let t = &self.core.a;
        let (ci, cj) = (&self.cand_i, &self.cand_j);
        let m = ci.len();
        let m4 = m & !3;
        let mut k = 0;
        unsafe {
            while k < m4 {
                let i0 = *ci.get_unchecked(k) as usize;
                let i1 = *ci.get_unchecked(k + 1) as usize;
                let i2 = *ci.get_unchecked(k + 2) as usize;
                let i3 = *ci.get_unchecked(k + 3) as usize;
                let j0 = *cj.get_unchecked(k) as usize;
                let j1 = *cj.get_unchecked(k + 1) as usize;
                let j2 = *cj.get_unchecked(k + 2) as usize;
                let j3 = *cj.get_unchecked(k + 3) as usize;
                let g = |a: &Vec<f32>, p: usize, q: usize, r: usize, s: usize| f32x4(*a.get_unchecked(p), *a.get_unchecked(q), *a.get_unchecked(r), *a.get_unchecked(s));
                let dx = f32x4_sub(g(&t.x, j0, j1, j2, j3), g(&t.x, i0, i1, i2, i3));
                let dy = f32x4_sub(g(&t.y, j0, j1, j2, j3), g(&t.y, i0, i1, i2, i3));
                let r = f32x4_add(g(&t.radius, i0, i1, i2, i3), g(&t.radius, j0, j1, j2, j3));
                let d2 = f32x4_add(f32x4_mul(dx, dx), f32x4_mul(dy, dy));
                let mask = i32x4_bitmask(f32x4_lt(d2, f32x4_mul(r, r)));
                if mask != 0 {
                    for b in 0..4 {
                        if mask >> b & 1 != 0 {
                            self.hits.push((k + b) as u32);
                        }
                    }
                }
                k += 4;
            }
            while k < m {
                let i = *ci.get_unchecked(k) as usize;
                let j = *cj.get_unchecked(k) as usize;
                let dx = *t.x.get_unchecked(j) - *t.x.get_unchecked(i);
                let dy = *t.y.get_unchecked(j) - *t.y.get_unchecked(i);
                let r = *t.radius.get_unchecked(i) + *t.radius.get_unchecked(j);
                if dx * dx + dy * dy < r * r {
                    self.hits.push(k as u32);
                }
                k += 1;
            }
        }
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    pub fn exact_simd(&mut self) {
        self.exact_scalar();
    }

    /// Pushes every hit pair apart (scalar). Weights follow the mass class: the lighter body moves further, the
    /// player does not move at all. Positions are re-read, so a pair that an earlier push already separated is skipped.
    fn resolve(&mut self, first: bool) -> u32 {
        let t = &mut self.core.a;
        let mut contacts = 0u32;
        for h in 0..self.hits.len() {
            let k = self.hits[h] as usize;
            let i = self.cand_i[k] as usize;
            let j = self.cand_j[k] as usize;
            let dx = t.x[j] - t.x[i];
            let dy = t.y[j] - t.y[i];
            let r = t.radius[i] + t.radius[j];
            let d2 = dx * dx + dy * dy;
            if d2 >= r * r {
                continue;
            }
            let d = d2.sqrt();
            let (nx, ny) = if d > 1e-5 { (dx / d, dy / d) } else { (1.0, 0.0) };
            let push = r - d;
            let (ki, kj) = (t.kind[i], t.kind[j]);
            let (wi, wj) = if ki == PLAYER_KIND {
                if first {
                    contacts += 1;
                }
                (0.0, 1.0)
            } else if kj == PLAYER_KIND {
                if first {
                    contacts += 1;
                }
                (1.0, 0.0)
            } else {
                let (mi, mj) = (kind_mass(ki), kind_mass(kj));
                (mj / (mi + mj), mi / (mi + mj))
            };
            t.x[i] -= nx * push * wi;
            t.y[i] -= ny * push * wi;
            t.x[j] += nx * push * wj;
            t.y[j] += ny * push * wj;
        }
        contacts
    }

    // ---- Obstacles and buildings (circle against blocked cells) ------------------------------------------------

    fn collide_obstacles(&mut self) {
        for i in 0..self.core.n {
            self.core.collide_obstacle(i);
        }
    }

    // ---- Projectile sweep: DDA over the grid cells the segment crosses ----------------------------------------------

    #[inline]
    fn visit_cell(&self, cx: i32, cy: i32, x0: f32, y0: f32, dx: f32, dy: f32, r: f32, owner: u8, best: &mut Hit, last_b: &mut u32) {
        if cx < 0 || cy < 0 || cx >= GRID as i32 || cy >= GRID as i32 {
            return;
        }
        let c = cy as usize * GRID + cx as usize;
        let b = self.core.blocked[c];
        if b != 0 {
            if b & 1 != 0 {
                let t = sweep_circle_aabb(x0, y0, dx, dy, r, cx as f32, cy as f32, cx as f32 + 1.0, cy as f32 + 1.0);
                if t < best.t {
                    *best = Hit { t, kind: HitKind::Wall };
                }
            }
            if b & 2 != 0 {
                let bi = self.core.bcell[c] as u32 - 1;
                if bi != *last_b {
                    *last_b = bi;
                    let o = bi as usize * 5;
                    let bb = &self.core.buildings[o..o + 4];
                    let t = sweep_circle_aabb(x0, y0, dx, dy, r, bb[0], bb[1], bb[2], bb[3]);
                    if t < best.t {
                        *best = Hit { t, kind: HitKind::Building(bi) };
                    }
                }
            }
        }
        if owner == 0 {
            let t = &self.core.a;
            for k in self.cell_start[c] as usize..self.cell_start[c + 1] as usize {
                let j = self.item(k);
                if t.kind[j] == PLAYER_KIND {
                    continue;
                }
                let tt = sweep_circle_circle(x0, y0, dx, dy, t.x[j], t.y[j], t.radius[j] + r);
                if tt < best.t {
                    *best = Hit { t: tt, kind: HitKind::Enemy(j as u32) };
                }
            }
        }
    }

    /// Finds the first hit along projectile i's segment. Entities and obstacles reach at most r + radius < 1 cell
    /// from the segment, so the 3x3 cells around each crossed cell hold every candidate; going from one cell to
    /// the next only the three newly covered cells are looked at. The walk stops when the next cell is entered
    /// after the best hit found so far (nothing later along the path can be earlier).
    fn sweep_fast(&self, i: usize, nosweep: bool) -> Hit {
        let pl = &self.core.pool;
        let (x0, y0, dx, dy, r, owner) = (pl.sx[i], pl.sy[i], pl.vx[i], pl.vy[i], pl.r[i], pl.owner[i]);
        let mut best = Hit::NONE;
        let mut last_b = u32::MAX;
        if nosweep {
            // Debug: a point test at the end position only.
            let (ex, ey) = (x0 + dx, y0 + dy);
            let (cx, cy) = (ex as i32, ey as i32);
            if owner == 1 {
                let ps = self.core.player_slot;
                let t = sweep_circle_circle(ex, ey, 0.0, 0.0, self.core.a.x[ps], self.core.a.y[ps], PLAYER_RADIUS + r);
                if t < INF {
                    best = Hit { t: 0.0, kind: HitKind::Player };
                }
            }
            for yy in cy - 1..=cy + 1 {
                for xx in cx - 1..=cx + 1 {
                    self.visit_cell(xx, yy, ex, ey, 0.0, 0.0, r, owner, &mut best, &mut last_b);
                }
            }
            if best.kind != HitKind::None {
                best.t = 1.0;
            }
            return best;
        }
        if owner == 1 {
            let ps = self.core.player_slot;
            let t = sweep_circle_circle(x0, y0, dx, dy, self.core.a.x[ps], self.core.a.y[ps], PLAYER_RADIUS + r);
            if t < best.t {
                best = Hit { t, kind: HitKind::Player };
            }
        }
        let mut cx = x0 as i32;
        let mut cy = y0 as i32;
        let sx = if dx > 0.0 { 1 } else { -1 };
        let sy = if dy > 0.0 { 1 } else { -1 };
        let idx = if dx != 0.0 { 1.0 / dx.abs() } else { INF };
        let idy = if dy != 0.0 { 1.0 / dy.abs() } else { INF };
        let mut tmx = if dx > 0.0 { ((cx + 1) as f32 - x0) * idx } else if dx < 0.0 { (x0 - cx as f32) * idx } else { INF };
        let mut tmy = if dy > 0.0 { ((cy + 1) as f32 - y0) * idy } else if dy < 0.0 { (y0 - cy as f32) * idy } else { INF };
        for yy in cy - 1..=cy + 1 {
            for xx in cx - 1..=cx + 1 {
                self.visit_cell(xx, yy, x0, y0, dx, dy, r, owner, &mut best, &mut last_b);
            }
        }
        for _ in 0..64 {
            let step_x = tmx < tmy;
            let t_next = if step_x { tmx } else { tmy };
            if t_next > 1.0 || t_next >= best.t {
                break;
            }
            if step_x {
                cx += sx;
                tmx += idx;
                for yy in cy - 1..=cy + 1 {
                    self.visit_cell(cx + sx, yy, x0, y0, dx, dy, r, owner, &mut best, &mut last_b);
                }
            } else {
                cy += sy;
                tmy += idy;
                for xx in cx - 1..=cx + 1 {
                    self.visit_cell(xx, cy + sy, x0, y0, dx, dy, r, owner, &mut best, &mut last_b);
                }
            }
        }
        best
    }

    // ---- Area effects ---------------------------------------------------------------------------------------------

    fn area_effects(&mut self) {
        // Explosions: everything within the radius takes damage (no events per damaged enemy; the hit flag shows it).
        for e in 0..self.core.explosions.len() {
            let [x, y, rad, dmg] = self.core.explosions[e];
            let reach = rad + MAX_R;
            let (x0, x1) = (((x - reach) as i32).max(0), ((x + reach) as i32).min(GRID as i32 - 1));
            let (y0, y1) = (((y - reach) as i32).max(0), ((y + reach) as i32).min(GRID as i32 - 1));
            for cy in y0..=y1 {
                for cx in x0..=x1 {
                    let c = cy as usize * GRID + cx as usize;
                    for k in self.cell_start[c] as usize..self.cell_start[c + 1] as usize {
                        let j = self.item(k);
                        let t = &self.core.a;
                        let (dx, dy) = (t.x[j] - x, t.y[j] - y);
                        let rr = rad + t.radius[j];
                        if dx * dx + dy * dy < rr * rr {
                            self.core.damage_enemy(j, dmg);
                        }
                    }
                }
            }
        }
        // Auras, checked every step: hurt the player and slow the enemies close by.
        let (px, py) = (self.core.a.x[self.core.player_slot], self.core.a.y[self.core.player_slot]);
        let mut aura_hurt = 0.0;
        for i in 0..self.core.n {
            if self.core.a.kind[i] != AURA_KIND {
                continue;
            }
            let (x, y) = (self.core.a.x[i], self.core.a.y[i]);
            let (dx, dy) = (px - x, py - y);
            let pr = AURA_RADIUS + PLAYER_RADIUS;
            if dx * dx + dy * dy < pr * pr {
                aura_hurt += 0.004;
            }
            let (cx, cy) = (x as i32, y as i32);
            for yy in (cy - 2).max(0)..=(cy + 2).min(GRID as i32 - 1) {
                for xx in (cx - 2).max(0)..=(cx + 2).min(GRID as i32 - 1) {
                    let c = yy as usize * GRID + xx as usize;
                    for k in self.cell_start[c] as usize..self.cell_start[c + 1] as usize {
                        let j = self.item(k);
                        let t = &mut self.core.a;
                        if j == i || t.kind[j] == PLAYER_KIND {
                            continue;
                        }
                        let (ex, ey) = (t.x[j] - x, t.y[j] - y);
                        if ex * ex + ey * ey < AURA_RADIUS * AURA_RADIUS {
                            t.slow[j] = 0.5;
                        }
                    }
                }
            }
        }
        if aura_hurt > 0.0 {
            self.core.hurt_player(aura_hurt);
        }
        self.core.pickups_and_hurt();
    }

    // ---- The step ---------------------------------------------------------------------------------------------------

    pub fn step(&mut self, move_x: f32, move_y: f32, _buttons: u32) {
        let mut tm = [0.0f32; 13];
        let ms = |a: f64, b: f64| (b - a) as f32;
        let t0 = clock();
        self.core.begin_step();
        self.core.ai(move_x, move_y);
        let t1 = clock();
        tm[T_AI] = ms(t0, t1);

        self.core.integrate();
        self.sort_structures();
        let t2 = clock();
        tm[T_INTEGRATE] = ms(t1, t2);

        // Projectiles: spawn, sweep, damage.
        self.core.projectile_begin();
        let check = self.core.p.flags & INIT_CHECK != 0;
        let nosweep = self.core.p.flags & INIT_NOSWEEP != 0;
        let mut check_ms = 0.0f64;
        for i in 0..self.core.pool.n {
            self.core.projectile_segment(i);
            let hit = self.sweep_fast(i, nosweep);
            if check {
                let c0 = clock();
                self.core.check_projectile(i, hit.t);
                check_ms += clock() - c0;
            }
            self.core.projectile_finish(i, hit);
        }
        let t3 = clock();
        tm[T_PROJ] = ms(t2, t3) - check_ms as f32;
        tm[T_CHECK] = check_ms as f32;

        self.area_effects();
        let t4 = clock();
        tm[T_AREA] = ms(t3, t4);

        // Crowd pushing: candidates once, then K passes of exact check + push.
        let tested = if self.method == 1 { self.gather_sweep(CAND_MARGIN) } else { self.gather_grid(CAND_MARGIN) };
        let t5 = clock();
        tm[T_PAIRS] = ms(t4, t5);
        let mut contacts = 0;
        let (mut t_exact, mut t_push) = (0.0f32, 0.0f32);
        for pass in 0..self.passes {
            let a = clock();
            if self.method == 2 {
                self.exact_simd();
            } else {
                self.exact_scalar();
            }
            let b = clock();
            if pass == 0 {
                self.core.stats[S_PAIRS_HIT] = self.hits.len() as f64;
            }
            contacts += self.resolve(pass == 0);
            let c = clock();
            t_exact += ms(a, b);
            t_push += ms(b, c);
        }
        tm[T_EXACT] = t_exact;
        tm[T_PUSH] = t_push;
        if contacts > 0 {
            self.core.hurt_player(0.0008 * contacts.min(12) as f32);
        }
        self.core.stats[S_PAIRS_TESTED] = tested as f64;
        self.core.stats[S_PAIRS_CAND] = self.cand_i.len() as f64;
        let t6 = clock();

        self.core.update_buildings();
        let t7 = clock();
        tm[T_BUILD] = ms(t6, t7);
        self.collide_obstacles();
        let t8 = clock();
        tm[T_OBST] = ms(t7, t8);

        self.core.process_deaths();
        let t9 = clock();
        tm[T_PROJ] += ms(t8, t9);

        self.core.flow_step();
        let t10 = clock();
        tm[T_FLOW] = ms(t9, t10);

        let start = self.core.tick;
        self.core.tick += 1;
        self.core.timing = tm;
        self.core.write_snapshot(start);
        let t11 = clock();
        tm[T_SNAP] = ms(t10, t11);
        tm[T_STEP] = ms(t0, t11) - check_ms as f32;
        self.core.patch_timing(T_SNAP, tm[T_SNAP]);
        self.core.patch_timing(T_STEP, tm[T_STEP]);
    }
}

export_ffi!(Sim);

// ---- Pair set equality: A, B and C must find the same pairs for the same positions ---------------------------------

use std::collections::BTreeSet;

fn id_pairs(sim: &Sim) -> BTreeSet<(u32, u32)> {
    let t = &sim.core.a;
    (0..sim.cand_i.len())
        .map(|k| {
            let (a, b) = (t.id[sim.cand_i[k] as usize], t.id[sim.cand_j[k] as usize]);
            (a.min(b), a.max(b))
        })
        .collect()
}
fn hit_pairs(sim: &Sim) -> BTreeSet<(u32, u32)> {
    let t = &sim.core.a;
    sim.hits
        .iter()
        .map(|&k| {
            let (a, b) = (t.id[sim.cand_i[k as usize] as usize], t.id[sim.cand_j[k as usize] as usize]);
            (a.min(b), a.max(b))
        })
        .collect()
}
fn brute_pairs(t: &Table, n: usize, m: f32) -> BTreeSet<(u32, u32)> {
    let mut s = BTreeSet::new();
    for i in 0..n {
        for j in i + 1..n {
            if coarse(t, i, j, m) {
                s.insert((t.id[i].min(t.id[j]), t.id[i].max(t.id[j])));
            }
        }
    }
    s
}

/// Runs a dense fixed-seed sim for a few steps, freezes it, and compares on that one state: the candidate sets of
/// A (grid), B (sweep) and a brute-force O(n^2) reference, at margin 0 and at CAND_MARGIN, and the overlapping
/// pairs found by the scalar and the SIMD exact check (the SIMD kernel only runs for real in the wasm build).
/// Returns (code, overlapping pairs, candidate pairs); code 0 = all equal.
pub fn pair_selftest(seed: u32, enemies: u32) -> (u32, usize, usize) {
    let p = Params { method: 2, enemies, seed, spawn: 24.0, proj_target: 0, proj_cap: 0, event_cap: 16, passes: 3, flags: 0 };
    let mut sim = Sim::create(&p);
    for k in 0..30 {
        let a = k as f32 * 0.1;
        sim.step(a.cos(), a.sin(), 0);
    }
    let n = sim.core.n;
    sim.sort_by_cell(); // A and C structures; the table is now sorted by cell
    sim.sort_order_by_x(); // B structure over the same frozen positions
    let mut candidates = 0;
    for (m, code) in [(0.0f32, 1u32), (CAND_MARGIN, 2)] {
        let brute = brute_pairs(&sim.core.a, n, m);
        sim.gather_grid(m);
        let a = id_pairs(&sim);
        sim.gather_sweep(m);
        let b = id_pairs(&sim);
        if a != brute {
            return (code * 10 + 1, brute.len(), a.len());
        }
        if b != brute {
            return (code * 10 + 2, brute.len(), b.len());
        }
        candidates = brute.len();
    }
    // Exact checks on the margin candidates: scalar and SIMD against the brute-force overlap set.
    let overlap = brute_pairs(&sim.core.a, n, 0.0);
    sim.gather_grid(CAND_MARGIN);
    sim.exact_scalar();
    if hit_pairs(&sim) != overlap {
        return (31, overlap.len(), candidates);
    }
    sim.exact_simd();
    if hit_pairs(&sim) != overlap {
        return (32, overlap.len(), candidates);
    }
    sim.gather_sweep(CAND_MARGIN);
    sim.exact_scalar();
    if hit_pairs(&sim) != overlap {
        return (33, overlap.len(), candidates);
    }
    (0, overlap.len(), candidates)
}

/// For the WASM build: 0 if the pair sets are equal and non-empty, else a failure code.
#[no_mangle]
pub extern "C" fn selftest(seed: u32, enemies: u32) -> u32 {
    let (code, pairs, _) = pair_selftest(seed, enemies);
    if code == 0 && pairs == 0 {
        99
    } else {
        code
    }
}
#[no_mangle]
pub extern "C" fn selftest_pairs(seed: u32, enemies: u32) -> u32 {
    pair_selftest(seed, enemies).1 as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_sets_equal() {
        for seed in [1u32, 7, 42] {
            let (code, pairs, cands) = pair_selftest(seed, 3000);
            assert_eq!(code, 0, "seed {seed}: mismatch code {code}");
            assert!(pairs > 100, "seed {seed}: the frozen state has too few overlapping pairs ({pairs}) to prove anything");
            assert!(cands >= pairs);
            println!("seed {seed}: {pairs} overlapping pairs, {cands} candidates, A = B = brute force");
        }
    }

    /// Method B after Stage 11's live-count changes: the sweep over the persistent order must still find exactly the
    /// brute-force pairs of the live slots, after shrinking (player moved) and after growing again.
    #[test]
    fn sweep_follows_set_active() {
        let p = Params { method: 1, enemies: 3000, seed: 5, spawn: 24.0, proj_target: 0, proj_cap: 0, event_cap: 64, passes: 3, flags: 0 };
        let mut sim = Sim::create(&p);
        // Swap the player into slot 2500, past the first shrink's live count, so the shrink has to move it.
        {
            let c = &mut sim.core;
            c.b.put(0, &c.a, 0);
            c.b.put(1, &c.a, 2500);
            c.a.put(0, &c.b, 1);
            c.a.put(2500, &c.b, 0);
            c.player_slot = 2500;
        }
        for (k, live) in [1200usize, 400, 2800, 3001].into_iter().enumerate() {
            sim.core.set_active(live);
            for s in 0..5 {
                let a = (k * 5 + s) as f32 * 0.1;
                sim.step(a.cos(), a.sin(), 0);
            }
            let n = sim.core.n;
            assert_eq!(n, live);
            assert_eq!(sim.order.len(), n);
            assert!(sim.order.iter().all(|&v| (v as usize) < n));
            sim.sort_order_by_x();
            sim.gather_sweep(CAND_MARGIN);
            let brute = brute_pairs(&sim.core.a, n, CAND_MARGIN);
            assert_eq!(id_pairs(&sim), brute, "live {live}");
            assert!(!brute.is_empty());
        }
    }

    /// Stage 11 inits with the cap and shrinks to the wave's start. Method A's table is sorted by cell at init, so the
    /// shrink must keep a sample spread over the spawn square, not the lowest rows, and must keep the player.
    #[test]
    fn shrink_keeps_a_spread_sample() {
        for method in [0u32, 1, 2] {
            let p = Params { method, enemies: 20000, seed: 1, spawn: 64.0, proj_target: 0, proj_cap: 0, event_cap: 64, passes: 3, flags: 0 };
            let mut sim = Sim::create(&p);
            sim.core.set_active(301);
            let c = &sim.core;
            assert_eq!(c.n, 301);
            assert_eq!(c.a.kind[c.player_slot], PLAYER_KIND);
            assert_eq!((0..c.n).filter(|&i| c.a.kind[i] == PLAYER_KIND).count(), 1);
            let centre = (GRID / 2) as f32;
            let (mut below, mut above) = (0, 0);
            let (mut ymin, mut ymax) = (f32::MAX, f32::MIN);
            for i in (0..c.n).filter(|&i| i != c.player_slot) {
                let y = c.a.y[i];
                ymin = ymin.min(y);
                ymax = ymax.max(y);
                if y < centre { below += 1 } else { above += 1 }
            }
            assert!(ymax - ymin > 100.0, "method {method}: kept enemies span only y {ymin}..{ymax}");
            assert!(below > 100 && above > 100, "method {method}: {below} below and {above} above the player");
            // The sim still steps and stays consistent after the shrink.
            for k in 0..10 {
                let a = k as f32 * 0.1;
                sim.step(a.cos(), a.sin(), 0);
            }
            assert_eq!(sim.core.a.kind[sim.core.player_slot], PLAYER_KIND);
        }
    }

    #[test]
    fn sweep_primitives() {
        // A wall cell [5,6]x[5,6] and a circle of r = 0.1 moving 3 cells right along y = 5.5 from x = 3.
        let t = sweep_circle_aabb(3.0, 5.5, 3.0, 0.0, 0.1, 5.0, 5.0, 6.0, 6.0);
        assert!((t - (5.0 - 0.1 - 3.0) / 3.0).abs() < 1e-5, "t = {t}");
        // Missing the corner: passes below.
        assert!(sweep_circle_aabb(3.0, 4.0, 3.0, 0.0, 0.1, 5.0, 5.0, 6.0, 6.0) == INF);
        // Random segments against dense sampling: the analytic first-hit time must agree with the sampled one.
        let mut rng = Rng(12345);
        let dist_to_box = |x: f32, y: f32| {
            let (qx, qy) = (x.clamp(5.0, 6.0), y.clamp(5.0, 6.0));
            ((x - qx).powi(2) + (y - qy).powi(2)).sqrt()
        };
        let mut hits = 0;
        for _ in 0..3000 {
            let (x0, y0) = (2.0 + rng.unit() * 8.0, 2.0 + rng.unit() * 8.0);
            let (dx, dy) = ((rng.unit() - 0.5) * 8.0, (rng.unit() - 0.5) * 8.0);
            let r = 0.05 + rng.unit() * 0.2;
            let analytic = sweep_circle_aabb(x0, y0, dx, dy, r, 5.0, 5.0, 6.0, 6.0);
            let mut sampled = INF;
            for s in 0..=8000 {
                let t = s as f32 / 8000.0;
                if dist_to_box(x0 + dx * t, y0 + dy * t) <= r {
                    sampled = t;
                    break;
                }
            }
            if sampled == INF && analytic == INF {
                continue;
            }
            hits += 1;
            assert!((analytic - sampled).abs() < 2e-3, "segment ({x0},{y0}) + ({dx},{dy}) r {r}: analytic {analytic}, sampled {sampled}");
        }
        assert!(hits > 200, "only {hits} segments hit the box");
    }

    /// With sweeping on, the reference finds nothing the fast path missed; with it off, it does.
    #[test]
    fn passthrough_counter_calibration() {
        let run = |flags: u32| {
            let p = Params { method: 0, enemies: 2000, seed: 3, spawn: 40.0, proj_target: 1000, proj_cap: 2000, event_cap: 8192, passes: 3, flags };
            let mut sim = Sim::create(&p);
            for k in 0..120 {
                let a = k as f32 * 0.05;
                sim.step(a.cos(), a.sin(), 0);
            }
            (sim.core.stats[S_PASS_THROUGH], sim.core.stats[S_CHECKED], sim.core.stats[S_FALSE_HIT])
        };
        let (on, checked_on, false_on) = run(INIT_CHECK);
        let (off, checked_off, _) = run(INIT_CHECK | INIT_NOSWEEP);
        println!("sweep on: {on} pass-throughs in {checked_on} checks ({false_on} false hits); sweep off: {off} in {checked_off}");
        assert_eq!(on, 0.0);
        assert_eq!(false_on, 0.0);
        assert!(off > 0.0);
    }
}
