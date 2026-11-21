# Stage 8: does combat collision fit the sim budget?

Hypothesis: the single sim thread handles combat (2,000 enemies, 1,000 live projectiles, buildings, and area effects) within 4 ms per step at the 99th percentile on the reference device.

Verdict: **provisional fail**. With Chrome's 4× CPU throttling (this run's stand-in for the reference device; no reference device was available), the pass load misses the bar with every pair-finding method: p99 4.58 ms (B), 4.98 ms (C), 5.11 ms (A) against 4 ms, median of 3 five-minute runs each. On the dev machine without throttling, with the sim in a worker as the game would run it, the same load passes: p99 2.27–2.62 ms. No projectile passed through anything with A, B or C (0 in 3.9 million checked sweeps per method). Rapier 2D fails on its own: 3.2× slower and 7 missed hits.

Fallback recorded, **not applied** (it applies only if a reference-device run confirms the failure, see "How it runs"): A, B and C are within each other's spread at the pass load, so there is no faster method to take; keep A (run 1's grid, the simplest). Then, in this order, cut the crowd-pushing passes (3 now), the live projectile count, and how often area effects are checked. If that does not fit, follow Stage 1's fallback (cut the entity target or the step rate; then reconsider the host for a multithreaded sim). Rapier 2D did not win, so the physics decision stays.

## What was built

- `prototype/combat/` (Rust, WASM with `simd128`): the combat sim. It reuses run 1's sim design: struct-of-arrays tables, a counting sort by cell on a 256×256 grid of 1-unit cells, a flow field toward the player, and AI that thinks every 8th step. One step runs AI, integrate and sort, projectiles, area effects, crowd pushing, the wall schedule, obstacle collision, deaths and respawns, the flow field, and the snapshot (layout v2, `src/run2/protocol.ts`). The scene and everything outside pair finding is in `combat/src/shared.rs`, which both builds share.
  - Projectiles: a pool that holds the live count at its target. The player fires bullets, and every 8th player shot is an explosive rocket (radius 2.5). Enemy kinds 3 and 11 shoot bolts. Each projectile is swept along its path each step, as a moving circle against the rounded-box shape of walls and buildings and against the enemies it can reach, and it hits the first thing along the path.
  - Buildings: 160 static boxes of several sizes, plus player-built walls that appear near the player every 2 s and last 10 s (16 slots). Each change updates the grid and the flow field and raises the snapshot's "buildings changed" flag.
  - Crowd pushing: candidate pairs are gathered once per step with a 0.1 margin. Then come 3 passes of exact checks and pushes, with a push priority by mass class: the player is never pushed, and large enemies push small ones.
  - Area effects: explosion damage in a radius, auras on kind 5 checked every step (radius 2), and a pickup radius of 3 around the player.
  - Events written into the snapshot each step: shot, hit, death, explosion, pickup, wall built and wall removed, player hurt.
  - Pair finding, chosen at init: **A**, run 1's grid with entities sorted by cell; **B**, sort-and-sweep along x over an order array kept sorted by insertion sort between steps; **C**, A's grid with the exact distance checks run 4 at a time with SIMD. The three gather the same candidate set, which the `pair_sets_equal` test checks. They differ only in how they find it.
  - A slow exact reference check can run alongside. It sweeps every projectile against every wall, building and enemy by brute force, and counts any earlier hit the fast path missed (a pass-through) or any hit it made that the reference does not (a false hit).
- `prototype/combat-rapier/`: the same scene, AI, projectiles and events, with Rapier 2D 0.36.1 doing pair finding, pushing and projectile hits. Enemies are dynamic ball bodies whose velocity the AI sets each step, and Rapier's contact solver does the pushing (solver iterations = push passes, large enemies 6× denser). Walls and buildings are fixed cuboids. Projectiles find their first hit with `cast_shape` and area effects use `intersect_shape`. A new dependency, approved for this run.
- `src/stage8/` and `stage8.html` drive either build on the main thread or in a worker at 30 Hz, with a scripted player walking a circle (run 1's script). The driver is `scripts/run2/stage8.mjs` and the tables come from `scripts/run2/stage8-table.mjs`.

Choices the plan left open, taken as defaults and noted here: top-down scene (run 1's default); enemies spawn in a ±64-unit square around the player; large enemy radius 0.45, the largest that keeps a pair within one grid cell; 3 push passes; candidate margin 0.1 for every method; snapshot event capacity at least 32,768, or 4× the projectile count, so no event is ever dropped at the measured loads.

## How it was measured

- Dev machine: Intel Core i7-13700, 64 GB, NVIDIA RTX 3060, Windows 11 Pro 10.0.26200, Chrome 156.0.8078.73 (headed), driven by puppeteer-core.
- Build: branch `prototype/run-2` at `f52a8f9`, `vite build` with Rust 1.94.1 (the pinned `rust-toolchain.toml`), served by `vite preview` with COOP/COEP so `performance.now()` has 5 µs resolution.
- "Dev machine, throttled" rows use Chrome's 4× CPU throttling. Chrome cannot throttle workers, so those rows run the sim **on the main thread**; what was slowed is the sim's own thread. "Dev machine" rows are unthrottled with the sim **in a worker**.
- Main matrix: 2,000, 5,000 and 10,000 enemies × 0, 1,000 and 5,000 live projectiles × A, B, C, each **300 s × 3 repetitions** after a 5 s warm-up (9,000 steps per run). Rapier 2D at 2,000 enemies: 300 s × 3. At 5,000 and 10,000 enemies Rapier runs far slower than real time (the sim counts steps, not seconds), so those cells are **60 s × 1** (P2, see below).
- Cells are the median over the repetitions, with min–max in brackets. A difference counts only when it is larger than the spread.
- Pass-through check: 60 s runs with the reference check on, plus a 20 s calibration with sweeping off, which must find pass-throughs.
- Push past the bar: 60 s runs, raising projectiles at 2,000 enemies and enemies at 1,000 projectiles until the p99 crosses 4 ms.
- The machine was idle except for the measurement; the user's own Chrome stayed open in the background.
- Raw data: `results/run-2/data/stage8/*.json`, logs `results/run-2/data/stage8.log` and `stage8-cpu1.log`. Full tables, including per-phase shares at every load: [`data/stage8-tables.md`](data/stage8-tables.md).

## Results

### Pass load: 2,000 enemies, 1,000 live projectiles

| Where | Method | Step median (ms) | Step p99 (ms) | Step max (ms) | Pass-throughs |
|---|---|---|---|---|---|
| dev machine, throttled 4× (main thread) | A grid | 2.640 (2.630–2.805) | **5.11** (4.47–5.68) | 11.2 | 0 / 1,950,000 |
| dev machine, throttled 4× (main thread) | B sweep | 2.615 (2.615–2.635) | **4.58** (4.40–4.87) | 8.1 | 0 / 1,950,000 |
| dev machine, throttled 4× (main thread) | C grid+SIMD | 2.620 (2.610–2.620) | **4.98** (4.22–5.27) | 8.2 | 0 / 1,950,000 |
| dev machine, throttled 4× (main thread) | Rapier 2D | 8.875 (8.700–9.040) | 17.09 (14.57–20.03) | 29.4 | **4** / 1,950,000 |
| dev machine (worker) | A grid | 0.645 (0.645–0.675) | 2.62 (2.09–2.74) | 5.0 | – |
| dev machine (worker) | B sweep | 0.645 (0.645–0.670) | 2.27 (2.12–2.73) | 4.3 | – |
| dev machine (worker) | C grid+SIMD | 0.645 (0.625–0.710) | 2.42 (2.36–2.82) | 6.0 | – |
| dev machine (worker) | Rapier 2D | 2.080 (2.050–2.175) | 6.33 (5.85–6.49) | 21.4 | – |

The throttled p99 spreads of A, B and C overlap (4.22–5.68 ms), so no method is faster at the pass load. All three pass on the dev machine and fail throttled. For comparison, run 1's sim without combat had a p99 of 1.06 ms at 2,000 entities on the dev machine, so at the pass load combat roughly doubles the tail.

Where the step goes at the pass load (A, throttled; mean 2.80 ms): projectiles 26%, integrate and sort 25%, pair finding 14%, flow field 10%, obstacle collision 9%, AI 5%, area effects 4%, snapshot write 4%, exact checks 2%, pushing 1%. Most of the step is projectiles plus the per-step sort. At this load, killing enemies thins the crowd at the player (30 deaths/s; the dead respawn out at the edge), so pushing is cheap, and 2,000 enemies with no projectiles is *slower* (pushing 12%, pair finding 24%).

### Whole matrix, dev machine, throttled 4×: step p99 (ms)

| Enemies | Projectiles | A grid | B sweep | C grid+SIMD | Rapier 2D |
|---|---|---|---|---|---|
| 2000 | 0 | 5.32 (5.30–6.32) | 6.22 (5.73–7.34) | 4.92 (4.86–5.04) | 24.78 (21.94–28.09) |
| 2000 | 1000 | 5.11 (4.47–5.68) | 4.58 (4.40–4.87) | 4.98 (4.22–5.27) | 17.09 (14.57–20.03) |
| 2000 | 5000 | 9.45 (9.14–10.36) | 9.59 (8.73–9.65) | 9.77 (8.73–11.51) | 40.74 (33.93–49.67) |
| 5000 | 0 | 10.18 (9.16–11.62) | 20.86 (17.73–21.07) | 10.49 (9.35–13.05) | 78.29 ¹ |
| 5000 | 1000 | 9.13 (8.66–10.53) | 9.16 (8.30–11.14) | 7.66 (7.33–8.13) | 50.02 ¹ |
| 5000 | 5000 | 11.40 (10.18–14.06) | 10.80 (10.76–14.74) | 12.60 (9.60–12.99) | 129.65 ¹ |
| 10000 | 0 | 19.14 (18.76–22.06) | 53.72 (44.65–60.53) | 22.41 (19.24–28.27) | 97.28 ¹ |
| 10000 | 1000 | 10.98 (10.50–13.82) | 17.41 (17.06–18.35) | 11.32 (10.77–15.11) | 163.37 ¹ |
| 10000 | 5000 | 19.53 (19.31–20.51) | 29.35 (27.11–35.16) | 15.87 (14.49–19.94) | 249.65 ¹ |

¹ 60 s × 1 run. Medians, the max and the per-phase split for every cell are in [`data/stage8-tables.md`](data/stage8-tables.md).

- **A vs C (SIMD exact checks):** C's exact checks are 12–18% faster (for example 2.46 → 2.17 ms at 10,000 enemies, no projectiles), but exact checks are at most 18% of the step, so the whole step differs by under 4% and within the spread in every cell but one: at 5,000 enemies and 1,000 projectiles, C's p99 is 7.66 (7.33–8.13) against A's 9.13 (8.66–10.53). That is one cell out of nine, so it is not counted as a win. Like run 1's SIMD result, the gain is real but too small to matter.
- **B (sort-and-sweep)** ties at 2,000 enemies and loses badly in dense crowds. It tests 9× to 12× more pairs in the gather (22,129 against A's 2,069 at 2,000 enemies; 497,466 against 40,001 at 10,000), because a 1-D sweep cannot reject pairs that are far apart in y. At 10,000 enemies with no projectiles its median is 32.5 ms against A's 14.2 ms.
- **Rapier 2D** is 3.2× to 7× slower at every load (median step). Its own physics step is 52–84% of its step, and its projectile shape casts take 3.2 ms at 1,000 projectiles against 0.7 ms for A.

### Projectiles that passed through something (must be 0)

| Method | Enemies | Sweeping | Sweeps checked | Pass-throughs | False hits |
|---|---|---|---|---|---|
| A, B, C | 2,000 and 5,000 | on | 1,950,000 each | **0** | 0 |
| A / B / C | 2,000 | off (calibration) | 750,000 | 140,438 / 141,115 / 140,438 | 0 / 1 / 0 |
| Rapier 2D | 2,000 | on | 1,950,000 | **4** | 0 |
| Rapier 2D | 5,000 | on | 1,950,000 | **3** | 0 |
| Rapier 2D | 2,000 | off (calibration) | 750,000 | 149,225 | 0 |

The calibration shows that the check catches pass-throughs: with sweeping off, about 19% of sweeps pass through something. Rapier's 7 misses (plus 88 "grazes" that disagree by under 5 mm) come from its shape cast against a rounded box corner. This matches the 3 corner misses in 1.5 million sweeps seen in a node test while building it. B's single false hit happened with sweeping off, a debug mode the game never uses; its cause was not looked into.

### Events per step, for Stages 9 and 10

| Enemies | Projectiles | Events per step: mean / p99 / max | of which shots / hits / explosions / deaths (mean) | Deaths/s | Snapshot mean / max | Dropped |
|---|---|---|---|---|---|---|
| 2000 | 1000 | **548 / 1,337 / 1,816** | 264 / 251 / 31 / 1.0 | 30 | 95 / 114 KB | 0 |
| 2000 | 5000 | 2,521 / 5,652 / 6,918 | 1,224 / 1,151 / 144 / 1.0 | 29 | 219 / 288 KB | 0 |
| 5000 | 1000 | 544 / 1,592 / 1,692 | 261 / 250 / 31 / 2.1 | 63 | 188 / 206 KB | 0 |
| 10000 | 5000 | 2,727 / 8,310 / 8,507 | 1,313 / 1,254 / 156 / 3.5 | 105 | 472 / 563 KB | 0 |

At the pass load the sim produces about 16,400 events per second (548 per step at 30 Hz): about 7,900 shots, 7,500 hits, 940 explosions and 30 deaths per second. This is far more than the "hundreds of sound events per second" Stage 10's hypothesis names, so Stage 10 is measured with this stream, and the voice limits and stacking have to cut it down. The snapshot event capacity (32,768) holds the largest step seen (8,507) with room to spare.

### Memory

WASM memory does not grow in A, B or C over 5 minutes (3.9 → 3.9 MB at the pass load; at most +0.1 MB at 10,000 enemies and 5,000 projectiles). Rapier's does: 5.6 → 17.9 MB over 5 minutes at 2,000 enemies with no projectiles, and 19.6 → 76.0 MB in 60 s at 10,000.

## Limits found

Push past the bar, 60 s runs, one run per point, method A (B and C are within a few tenths of a millisecond; full table in `data/stage8-tables.md`):

| Where | Raising | Last point under 4 ms | First point over |
|---|---|---|---|
| dev machine (worker) | projectiles, at 2,000 enemies | 3,000 (p99 3.43 ms) | 5,000 (4.03 ms; C 4.64, B 4.43) |
| dev machine (worker) | enemies, at 1,000 projectiles | 5,000 (p99 3.70 ms) | 7,500 (5.80 ms) |
| dev machine, throttled 4× | either | none: the pass load is already over | 2,000 enemies, 1,000 projectiles |

So on the dev machine the headroom is about 3× the projectiles or 2.5× the enemies of the pass load. Throttled, nothing at or above the pass load fits. The throttled sweep stops one point past the first failure, which here is the starting point, so it did not search *below* the pass load (P2).

## Problems in this measurement (rated as in Stage 12)

- P2: Rapier 2D at 5,000 and 10,000 enemies ran 60 s × 1 instead of 300 s × 3, because at 4× it runs up to 30× slower than real time. Its loss is 3× to 7× at every load, far outside any spread, so the verdict would stand.
- P2: "step start late" sits at a p99 of about 130 ms in every throttled run and about 14 ms unthrottled. It is a sawtooth from the test driver, not the sim. The driver's `setTimeout` loop runs at most one step per wake-up, so lateness builds up until it passes 4 periods (133 ms) and the driver drops the lost time. The step-time numbers are measured inside the step and are not affected, but the effective rate under throttling was somewhat below 30 Hz and was not recorded. Stage 11's driver has to catch up instead.
- P2: the throttled push-past sweep did not look below the pass load, so the throttled limit (the load that does fit at 4×) is unmeasured.
- Bias in the Rapier comparison, pointing against Rapier: it runs a real solver (contact manifolds, islands) where A, B and C do positional pushes, so it does more work per pair. It also has 3 corner misses that A, B and C do not. Its broad phase and query pipeline were used as documented, with no tuning beyond the integration parameters.

## Rerun on the reference device

From `prototype/`, on the reference laptop (Chrome, 1080p, plugged in, nothing else running), with Rust 1.94.1 and Node 22:

1. `pnpm install`, then `pnpm run build` (builds `sim`, `combat`, `combat-rapier`, the chunks, then `vite build`).
2. `node node_modules/vite/bin/vite.js preview --port 4173 --strictPort` in one terminal.
3. Main load, sim in a worker, no throttling: `node scripts/run2/stage8.mjs --throttle 1 --thread worker --series main --methods A,B,C,rapier --out results/run-2/data/stage8-ref`. That is 36 runs of 5 min each, about 3.5 h; add `--only "e2000-p1000-"` for the pass load alone (12 runs, about 1 h).
4. Pass-through check and limits: `node scripts/run2/stage8.mjs --throttle 1 --thread worker --series check,push --out results/run-2/data/stage8-ref`.
5. Tables: `node scripts/run2/stage8-table.mjs --dir results/run-2/data/stage8-ref --out results/run-2/data/stage8-ref-tables.md`.

The verdict is a pass if A, B or C has a p99 under 4 ms at `e2000-p1000` in all three repetitions, with 0 pass-throughs. A fail applies the fallback above.
