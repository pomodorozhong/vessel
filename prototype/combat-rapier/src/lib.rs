//! Vessel prototype, Stage 8: the same combat scene on Rapier 2D, for the comparison with our own pair finding.
//!
//! Same as `prototype/combat` (shared through `combat/src/shared.rs`): the scene, buildings and wall schedule,
//! AI, flow field, weapons and the spawn controller, damage, deaths, pickups, events, snapshot, reference check.
//!
//! Different, on purpose:
//!   * Enemies are dynamic ball bodies. Their velocity is set from the AI every step; Rapier integrates them,
//!     finds contacts (broad phase BVH, narrow phase) and solves them (a real contact solver with
//!     `num_solver_iterations = passes`), so crowd pushing, enemy-vs-wall and enemy-vs-building all come out of
//!     one `PhysicsPipeline::step`. The player is a velocity-based kinematic body, so it is never pushed.
//!     Mass classes are set through the density (large = 6 x small), which gives the push priority.
//!   * Walls and buildings are fixed cuboid colliders (map obstacle cells merged into rectangles).
//!   * A projectile finds its first hit with `QueryPipeline::cast_shape` of a ball along the step's path.
//!   * Explosions and auras use `QueryPipeline::intersect_shape`.
//!
//! Timing slot mapping (protocol slots in header f32[18..30]):
//!   19 pair finding   = the whole `PhysicsPipeline::step` (broad phase + narrow phase + islands + solver +
//!                       integration). Rapier does not split this in a way we can read without its profiler
//!                       (which needs `web-time`, not available on bare wasm32), so 20 and 21 are 0.
//!                       Compare it with A/B/C's 19 + 20 + 21 (plus a share of 26 and 28).
//!   26 integrate+sort = setting body velocities, facing, and copying positions back from the bodies.
//!   28 obstacles      = the player's own wall collision only (the player is kinematic, so Rapier would not do it).
//!   29 building updates = wall schedule plus adding and removing the cuboid colliders.
//!   22 projectiles    = spawn + `cast_shape` per projectile + damage + deaths and respawns.
//!   23 area effects   = `intersect_shape` queries for explosions and auras, pickups.

#[macro_use]
#[path = "../../combat/src/shared.rs"]
pub mod shared;
use shared::*;

use rapier2d::parry::query::ShapeCastOptions;
use rapier2d::parry::shape::Ball;
use rapier2d::prelude::*;

const G_ENEMY: Group = Group::GROUP_1;
const G_STATIC: Group = Group::GROUP_2;
const G_PLAYER: Group = Group::GROUP_3;
// Collider user data: an enemy's slot, or one of these tags.
const UD_WALL: u128 = 1 << 64;
const UD_BUILDING: u128 = 1 << 65; // + building index
const UD_PLAYER: u128 = 1 << 66;

pub struct Sim {
    pub core: Core,
    pipeline: PhysicsPipeline,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    soft_bodies: SoftBodySet,
    ccd: CCDSolver,
    params: IntegrationParameters,
    handles: Vec<RigidBodyHandle>, // per entity slot (the table is never reordered here, slot = id)
    building_colliders: Vec<Option<ColliderHandle>>,
    hit_scratch: Vec<u32>,
}

fn static_groups() -> InteractionGroups {
    InteractionGroups::new(G_STATIC, Group::ALL, InteractionTestMode::And)
}

impl Sim {
    pub fn create(p: &Params) -> Sim {
        let mut core = Core::new(p);
        // cast_shape's time of impact is only accurate to about 2e-3, and a graze can resolve either way; the
        // reference check counts a disagreement only if it holds with the projectile 5 mm smaller or larger.
        core.check_eps = 2e-3;
        core.check_margin = 5e-3;
        let n = core.n;
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut handles = Vec::with_capacity(n);
        for i in 0..n {
            let (x, y, k) = (core.a.x[i], core.a.y[i], core.a.kind[i]);
            let r = kind_radius(k);
            if k == PLAYER_KIND {
                let h = bodies.insert(RigidBodyBuilder::kinematic_velocity_based().translation(Vector::new(x, y)));
                colliders.insert_with_parent(
                    ColliderBuilder::ball(r).collision_groups(InteractionGroups::new(G_PLAYER, Group::ALL, InteractionTestMode::And)).user_data(UD_PLAYER),
                    h,
                    &mut bodies,
                );
                handles.push(h);
            } else {
                let h = bodies.insert(RigidBodyBuilder::dynamic().translation(Vector::new(x, y)).lock_rotations().linear_damping(0.0).can_sleep(false));
                let density = kind_mass(k) / (core::f32::consts::PI * r * r);
                colliders.insert_with_parent(
                    ColliderBuilder::ball(r)
                        .density(density)
                        .friction(0.0)
                        .restitution(0.0)
                        .collision_groups(InteractionGroups::new(G_ENEMY, Group::ALL, InteractionTestMode::And))
                        .user_data(i as u128),
                    h,
                    &mut bodies,
                );
                handles.push(h);
            }
        }
        // Map obstacle cells (bit 0), merged into rectangles: horizontal runs first, then equal runs of
        // consecutive rows are joined.
        let mut rects: Vec<(usize, usize, usize, usize)> = Vec::new(); // x0, x1 (exclusive), y0, y1 (exclusive)
        for y in 0..GRID {
            let mut x = 0;
            while x < GRID {
                if core.blocked[y * GRID + x] & 1 == 0 {
                    x += 1;
                    continue;
                }
                let x0 = x;
                while x < GRID && core.blocked[y * GRID + x] & 1 != 0 {
                    x += 1;
                }
                if let Some(r) = rects.iter_mut().rev().take(GRID).find(|r| r.0 == x0 && r.1 == x && r.3 == y) {
                    r.3 = y + 1;
                } else {
                    rects.push((x0, x, y, y + 1));
                }
            }
        }
        for &(x0, x1, y0, y1) in &rects {
            let (hx, hy) = ((x1 - x0) as f32 * 0.5, (y1 - y0) as f32 * 0.5);
            colliders.insert(ColliderBuilder::cuboid(hx, hy).translation(Vector::new(x0 as f32 + hx, y0 as f32 + hy)).collision_groups(static_groups()).user_data(UD_WALL));
        }
        let mut building_colliders = vec![None; core.buildings.len() / 5];
        for b in 0..core.static_count {
            building_colliders[b] = Some(Self::insert_building(&mut colliders, &core.buildings, b));
        }
        let mut params = IntegrationParameters::default();
        params.dt = DT;
        params.num_solver_iterations = p.passes.max(1) as usize;
        Sim {
            core,
            pipeline: PhysicsPipeline::new(),
            islands: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            bodies,
            colliders,
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            soft_bodies: SoftBodySet::new(),
            ccd: CCDSolver::new(),
            params,
            handles,
            building_colliders,
            hit_scratch: Vec::with_capacity(256),
        }
    }

    fn insert_building(colliders: &mut ColliderSet, buildings: &[f32], b: usize) -> ColliderHandle {
        let o = b * 5;
        let (hx, hy) = ((buildings[o + 2] - buildings[o]) * 0.5, (buildings[o + 3] - buildings[o + 1]) * 0.5);
        colliders.insert(
            ColliderBuilder::cuboid(hx, hy).translation(Vector::new(buildings[o] + hx, buildings[o + 1] + hy)).collision_groups(static_groups()).user_data(UD_BUILDING + b as u128),
        )
    }

    fn query_filter(owner: u8) -> QueryFilter<'static> {
        // Player shots hit enemies and static geometry; enemy shots hit the player and static geometry.
        let target = if owner == 0 { G_ENEMY } else { G_PLAYER };
        QueryFilter::default().groups(InteractionGroups::new(Group::ALL, target | G_STATIC, InteractionTestMode::And))
    }

    fn classify(ud: u128) -> HitKind {
        if ud == UD_WALL {
            HitKind::Wall
        } else if ud == UD_PLAYER {
            HitKind::Player
        } else if ud >= UD_BUILDING {
            HitKind::Building((ud - UD_BUILDING) as u32)
        } else {
            HitKind::Enemy(ud as u32)
        }
    }

    fn sweep(&self, i: usize, nosweep: bool) -> Hit {
        let pl = &self.core.pool;
        let (x0, y0, dx, dy, r, owner) = (pl.sx[i], pl.sy[i], pl.vx[i], pl.vy[i], pl.r[i], pl.owner[i]);
        let qp = self.broad_phase.as_query_pipeline(self.narrow_phase.query_dispatcher(), &self.bodies, &self.colliders, Self::query_filter(owner));
        let ball = Ball::new(r);
        if nosweep {
            // Debug: an intersection test at the end position only.
            let found = qp.intersect_shape(Pose::translation(x0 + dx, y0 + dy), &ball).next();
            return match found {
                Some((_, c)) => Hit { t: 1.0, kind: Self::classify(c.user_data) },
                None => Hit::NONE,
            };
        }
        let opts = ShapeCastOptions { max_time_of_impact: 1.0, target_distance: 0.0, stop_at_penetration: true, compute_impact_geometry_on_penetration: false };
        match qp.cast_shape(&Pose::translation(x0, y0), Vector::new(dx, dy), &ball, opts) {
            Some((h, hit)) => Hit { t: hit.time_of_impact.clamp(0.0, 1.0), kind: Self::classify(self.colliders[h].user_data) },
            None => Hit::NONE,
        }
    }

    fn area_effects(&mut self) {
        let enemy_only = QueryFilter::default().groups(InteractionGroups::new(Group::ALL, G_ENEMY, InteractionTestMode::And));
        // Explosions.
        for e in 0..self.core.explosions.len() {
            let [x, y, rad, dmg] = self.core.explosions[e];
            self.hit_scratch.clear();
            let qp = self.broad_phase.as_query_pipeline(self.narrow_phase.query_dispatcher(), &self.bodies, &self.colliders, enemy_only);
            for (_, c) in qp.intersect_shape(Pose::translation(x, y), &Ball::new(rad)) {
                self.hit_scratch.push(c.user_data as u32);
            }
            for k in 0..self.hit_scratch.len() {
                self.core.damage_enemy(self.hit_scratch[k] as usize, dmg);
            }
        }
        // Auras, every step. The query shape is the aura circle; neighbours count when their centre is inside it,
        // like in the grid build.
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
            self.hit_scratch.clear();
            let qp = self.broad_phase.as_query_pipeline(self.narrow_phase.query_dispatcher(), &self.bodies, &self.colliders, enemy_only);
            for (_, c) in qp.intersect_shape(Pose::translation(x, y), &Ball::new(AURA_RADIUS)) {
                self.hit_scratch.push(c.user_data as u32);
            }
            for k in 0..self.hit_scratch.len() {
                let j = self.hit_scratch[k] as usize;
                let (ex, ey) = (self.core.a.x[j] - x, self.core.a.y[j] - y);
                if j != i && ex * ex + ey * ey < AURA_RADIUS * AURA_RADIUS {
                    self.core.a.slow[j] = 0.5;
                }
            }
        }
        if aura_hurt > 0.0 {
            self.core.hurt_player(aura_hurt);
        }
        self.core.pickups_and_hurt();
    }

    pub fn step(&mut self, move_x: f32, move_y: f32, _buttons: u32) {
        let mut tm = [0.0f32; 13];
        let ms = |a: f64, b: f64| (b - a) as f32;
        let t0 = clock();
        self.core.begin_step();
        self.core.ai(move_x, move_y);
        let t1 = clock();
        tm[T_AI] = ms(t0, t1);

        // Velocities from the AI (and the aura slow), facing, previous positions.
        {
            let n = self.core.n;
            let c = &mut self.core;
            for i in 0..n {
                let s = c.a.slow[i];
                c.a.slow[i] = 1.0;
                c.a.px[i] = c.a.x[i];
                c.a.py[i] = c.a.y[i];
                c.a.pfacing[i] = c.a.facing[i];
                let mut d = c.a.tfacing[i] - c.a.facing[i];
                if d > core::f32::consts::PI {
                    d -= core::f32::consts::TAU;
                }
                if d < -core::f32::consts::PI {
                    d += core::f32::consts::TAU;
                }
                c.a.facing[i] += d.clamp(-TURN_RATE, TURN_RATE);
                self.bodies[self.handles[i]].set_linvel(Vector::new(c.a.vx[i] * s, c.a.vy[i] * s), true);
            }
        }
        let t2 = clock();
        tm[T_INTEGRATE] = ms(t1, t2);

        self.pipeline.step(
            Vector::ZERO,
            &self.params,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.soft_bodies,
            &mut self.ccd,
            &(),
            &(),
        );
        let t3 = clock();
        tm[T_PAIRS] = ms(t2, t3);

        // Positions back from the bodies; the player is collided against the map by hand.
        for i in 0..self.core.n {
            let p = self.bodies[self.handles[i]].translation();
            self.core.a.x[i] = p.x;
            self.core.a.y[i] = p.y;
        }
        let t3b = clock();
        tm[T_INTEGRATE] += ms(t3, t3b);
        let ps = self.core.player_slot;
        self.core.collide_obstacle(ps);
        let pp = Vector::new(self.core.a.x[ps], self.core.a.y[ps]);
        let player = &mut self.bodies[self.handles[ps]];
        player.set_translation(pp, true);
        // The collider would only follow at the next step; the queries below must see the corrected position.
        for &ch in player.colliders() {
            self.colliders[ch].set_translation(pp);
        }
        let t4 = clock();
        tm[T_OBST] = ms(t3b, t4);

        // Projectiles.
        self.core.projectile_begin();
        let check = self.core.p.flags & INIT_CHECK != 0;
        let nosweep = self.core.p.flags & INIT_NOSWEEP != 0;
        let mut check_ms = 0.0f64;
        for i in 0..self.core.pool.n {
            self.core.projectile_segment(i);
            let hit = self.sweep(i, nosweep);
            if check {
                let c0 = clock();
                self.core.check_projectile(i, hit.t);
                check_ms += clock() - c0;
            }
            self.core.projectile_finish(i, hit);
        }
        let t5 = clock();
        tm[T_PROJ] = ms(t4, t5) - check_ms as f32;
        tm[T_CHECK] = check_ms as f32;

        self.area_effects();
        let t6 = clock();
        tm[T_AREA] = ms(t5, t6);

        // Wall schedule: the blocked grid and the flow field are updated by the core, the colliders here.
        self.core.update_buildings();
        for k in 0..self.core.wall_changes.len() {
            let (idx, on) = self.core.wall_changes[k];
            let idx = idx as usize;
            if on {
                self.building_colliders[idx] = Some(Self::insert_building(&mut self.colliders, &self.core.buildings, idx));
            } else if let Some(h) = self.building_colliders[idx].take() {
                self.colliders.remove(h, &mut self.islands, &mut self.bodies, &mut self.soft_bodies, true);
            }
        }
        self.core.wall_changes.clear();
        let t7 = clock();
        tm[T_BUILD] = ms(t6, t7);

        // Deaths: the core respawns the table entry, the body follows.
        self.core.process_deaths();
        for k in 0..self.core.dead.len() {
            let s = self.core.dead[k] as usize;
            let b = &mut self.bodies[self.handles[s]];
            b.set_translation(Vector::new(self.core.a.x[s], self.core.a.y[s]), true);
            b.set_linvel(Vector::ZERO, true);
        }
        let t8 = clock();
        tm[T_PROJ] += ms(t7, t8);

        self.core.flow_step();
        let t9 = clock();
        tm[T_FLOW] = ms(t8, t9);

        let start = self.core.tick;
        self.core.tick += 1;
        self.core.stats[S_PAIRS_HIT] = self.narrow_phase.contact_pairs().count() as f64;
        self.core.timing = tm;
        self.core.write_snapshot(start);
        let t10 = clock();
        tm[T_SNAP] = ms(t9, t10);
        tm[T_STEP] = ms(t0, t10) - check_ms as f32;
        self.core.patch_timing(T_SNAP, tm[T_SNAP]);
        self.core.patch_timing(T_STEP, tm[T_STEP]);
    }
}

export_ffi!(Sim);

#[cfg(test)]
mod tests {
    use super::*;

    fn run(flags: u32) -> (f64, f64, f64) {
        let p = Params { method: 0, enemies: 1000, seed: 3, spawn: 40.0, proj_target: 500, proj_cap: 1000, event_cap: 8192, passes: 3, flags };
        let mut sim = Sim::create(&p);
        for k in 0..120 {
            let a = k as f32 * 0.05;
            sim.step(a.cos(), a.sin(), 0);
        }
        (sim.core.stats[S_PASS_THROUGH], sim.core.stats[S_CHECKED], sim.core.stats[S_FALSE_HIT])
    }

    #[test]
    #[ignore]
    fn long_check_run() {
        let p = Params { method: 0, enemies: 2000, seed: 1, spawn: 64.0, proj_target: 1000, proj_cap: 1000, event_cap: 32768, passes: 3, flags: INIT_CHECK };
        let mut sim = Sim::create(&p);
        for k in 0..1500 {
            let a = k as f32 * (core::f32::consts::TAU / 1200.0);
            sim.step(a.cos(), a.sin(), 0);
        }
        println!("pass-through {} false {}", sim.core.stats[S_PASS_THROUGH], sim.core.stats[S_FALSE_HIT]);
    }

    #[test]
    fn passthrough_counter_calibration() {
        let (on, checked, false_hits) = run(INIT_CHECK);
        let (off, _, _) = run(INIT_CHECK | INIT_NOSWEEP);
        println!("rapier: sweep on {on} pass-throughs in {checked} checks ({false_hits} false hits); sweep off {off}");
        assert_eq!(on, 0.0);
        assert!(off > 0.0);
    }
}
