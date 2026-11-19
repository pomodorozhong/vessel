# Stage 1: does the sim fit its budget?

Hypothesis: a single-threaded Rust/WASM sim in one worker steps a few thousand entities within 4 ms per step on the reference device.

Verdict: **provisional**. On the dev machine the bar is met with a wide margin (2,000 entities: 99th percentile 1.06 ms). With Chrome's 4× CPU throttling, which is this run's only stand-in for the reference device, the median fits (2.59 ms) but the 99th percentile does not (5.28 ms against 4 ms). The reference device was not measured, so this is a provisional result with a recorded risk, not a confirmed pass or failure.

Fallback recorded, **not applied** (it applies only if a reference-device run fails): first cut the entity target or the step rate; if that is not acceptable, reconsider GitHub Pages (a host with COOP and COEP allows a multithreaded sim) before reconsidering Rust.

## What was built

- `prototype/sim/src/lib.rs` (Rust, built to WASM with and without `simd128`) and `prototype/src/sim-ts.ts` (the same algorithm in typed-array TypeScript, no allocation in the step).
- Struct-of-arrays tables (position, previous position, velocity, facing, kind, radius, id), a counting sort by grid cell every step, circle collision on a 256×256 spatial hash grid (cell = 1 unit), static obstacles on the same grid, one flow field toward the player rebuilt incrementally (a breadth-first flood, 16,384 cells per step, restarted when the player crosses a cell), and enemies that think every 8th step, staggered by id.
- One driver (`src/simhost.ts`) runs either sim in the worker or on the main thread, at 30 Hz, with a scripted player walking a circle so the flow field is rebuilt constantly.

## How it was measured

- Dev machine: Intel Core i7-13700, 64 GB, NVIDIA RTX 3060, Windows 11 Pro 10.0.26200, Chrome 156.0.8078.73 (headed, real GPU), 1920×1080 canvas, clear-only rendering.
- Build: commit `de9501e`, `vite build`, served by `vite preview` with COOP/COEP headers so `performance.now()` has 5 µs resolution (the prototype does not use `SharedArrayBuffer`).
- Each row is one 5-minute run: 9,000 steps at 30 Hz after a 5-second warm-up. URL: `?bench=stage1&sim=<wasm-simd|wasm-nosimd|ts>&thread=<worker|main>&n=<count>&dur=300`. Rerun everything with `node scripts/stage1.mjs 300` and print the tables with `node scripts/stage1-table.mjs`.
- "Step" is the time inside the sim's step call. "Whole step" adds the copy into the pool buffer and `postMessage`.
- Enemies start spread over the whole map and converge on the player during the run, so the 99th percentile comes from the dense late phase.
- "dev machine, throttled" rows use Chrome's CPU throttling at 4×. **Chrome refuses CPU throttling for workers** ("Operation is only supported for pages, not workers"), so throttled rows run the sim on the main thread. Unthrottled, main-thread and worker step times are the same (see below), so this is a fair stand-in for a throttled worker.
- Raw data: `results/data/stage1/*.json`.

## Results (all rows: dev machine, Chrome 156.0.8078.73)

| Variant | CPU | Entities | Step median (ms) | Step p99 (ms) | Step max (ms) | Whole step incl. copy+post p99 (ms) | Collision | Flow field | AI | Snapshot write | Move+sort | Overlapping pairs/step | Step start late p99 (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wasm-simd-worker | unthrottled | 1000 | 0.495 | 0.895 | 53.31 | 0.990 | 36% | 23% | 4% | 1% | 36% | 1550 | 15.7 |
| wasm-simd-worker | unthrottled | 2000 | 0.585 | 1.060 | 2.69 | 1.150 | 48% | 16% | 5% | 1% | 29% | 3884 | 15.2 |
| wasm-simd-worker | unthrottled | 5000 | 1.115 | 1.845 | 2.68 | 1.915 | 67% | 7% | 4% | 2% | 20% | 13805 | 13.9 |
| wasm-simd-worker | unthrottled | 10000 | 2.500 | 4.740 | 6.21 | 4.850 | 80% | 4% | 4% | 2% | 11% | 39363 | 5.7 |
| wasm-simd-worker | unthrottled | 20000 | 6.365 | 12.150 | 126.96 | 12.305 | 88% | 1% | 3% | 1% | 7% | 115552 | 5.8 |
| wasm-simd-worker | unthrottled | 40000 | 19.850 | 75.775 | 180.84 | 76.000 | 93% | 0% | 2% | 1% | 4% | 340752 | 114.4 |
| wasm-nosimd-worker | unthrottled | 1000 | 0.400 | 0.740 | 1.77 | 0.805 | 35% | 21% | 4% | 1% | 39% | 1550 | 14.5 |
| wasm-nosimd-worker | unthrottled | 2000 | 0.650 | 1.110 | 3.09 | 1.205 | 48% | 17% | 5% | 2% | 29% | 3884 | 15.5 |
| wasm-nosimd-worker | unthrottled | 5000 | 1.215 | 2.050 | 3.05 | 2.135 | 66% | 7% | 5% | 2% | 20% | 13805 | 10.8 |
| wasm-nosimd-worker | unthrottled | 10000 | 2.330 | 4.255 | 5.54 | 4.335 | 78% | 3% | 4% | 1% | 13% | 39363 | 5.9 |
| ts-worker | unthrottled | 1000 | 1.005 | 1.750 | 16.41 | 1.845 | 38% | 32% | 4% | 1% | 25% | 1552 | 15.5 |
| ts-worker | unthrottled | 2000 | 1.015 | 1.735 | 5.19 | 1.805 | 46% | 24% | 4% | 1% | 24% | 3883 | 15.4 |
| ts-worker | unthrottled | 5000 | 1.430 | 2.150 | 3.54 | 2.215 | 62% | 12% | 4% | 2% | 20% | 13816 | 6.4 |
| ts-worker | unthrottled | 10000 | 3.055 | 4.630 | 6.72 | 4.710 | 73% | 7% | 4% | 2% | 15% | 39373 | 5.8 |
| wasm-simd-main | unthrottled | 1000 | 0.400 | 0.720 | 1.87 | 0.750 | 34% | 20% | 4% | 1% | 41% | 1550 | 5.6 |
| wasm-simd-main | unthrottled | 2000 | 0.655 | 1.060 | 5.09 | 1.085 | 51% | 17% | 4% | 2% | 26% | 3884 | 16.2 |
| wasm-simd-main | unthrottled | 5000 | 1.135 | 2.020 | 3.62 | 2.055 | 67% | 8% | 4% | 2% | 19% | 13805 | 4.9 |
| wasm-simd-main | unthrottled | 10000 | 2.350 | 4.085 | 5.30 | 4.145 | 79% | 3% | 4% | 1% | 12% | 39363 | 4.7 |
| wasm-simd-main | throttled 4x | 1000 | 1.625 | 3.290 | 7.93 | 3.450 | 36% | 21% | 3% | 1% | 40% | 1550 | 13.2 |
| wasm-simd-main | throttled 4x | 2000 | 2.585 | 5.280 | 49.53 | 5.440 | 50% | 16% | 4% | 2% | 29% | 3884 | 16.6 |
| wasm-simd-main | throttled 4x | 5000 | 5.275 | 9.345 | 14.11 | 9.520 | 68% | 8% | 4% | 2% | 18% | 13805 | 5.6 |
| wasm-simd-main | throttled 4x | 10000 | 10.475 | 17.790 | 27.38 | 18.040 | 79% | 4% | 4% | 2% | 12% | 39363 | 4.3 |

| Variant | CPU | Entities | Frame p99 (ms) | Frames over 20 ms | Main-thread CPU per frame p99 (ms) | Snapshot delivery median (ms) | Snapshot delivery p99 (ms) | Copy+post mean (ms) | Steps | Chrome |
|---|---|---|---|---|---|---|---|---|---|---|
| wasm-simd-worker | unthrottled | 1000 | 16.76 | 3 of 18030 | 0.28 | 0.095 | 0.395 | 0.052 | 9000 | 156.0.8078.73 |
| wasm-simd-worker | unthrottled | 2000 | 16.76 | 0 of 18019 | 0.26 | 0.075 | 0.255 | 0.045 | 9000 | 156.0.8078.73 |
| wasm-simd-worker | unthrottled | 5000 | 16.76 | 2 of 18017 | 0.24 | 0.060 | 0.210 | 0.044 | 9000 | 156.0.8078.73 |
| wasm-simd-worker | unthrottled | 10000 | 16.75 | 1 of 18017 | 0.24 | 0.090 | 0.165 | 0.069 | 9000 | 156.0.8078.73 |
| wasm-simd-worker | unthrottled | 20000 | 16.75 | 3 of 18053 | 0.25 | 0.085 | 0.245 | 0.081 | 9000 | 156.0.8078.73 |
| wasm-simd-worker | unthrottled | 40000 | 16.76 | 7 of 19277 | 0.26 | 0.075 | 0.215 | 0.151 | 9000 | 156.0.8078.73 |
| wasm-nosimd-worker | unthrottled | 1000 | 16.75 | 2 of 18020 | 0.24 | 0.070 | 0.165 | 0.037 | 9000 | 156.0.8078.73 |
| wasm-nosimd-worker | unthrottled | 2000 | 16.76 | 2 of 18027 | 0.25 | 0.095 | 0.375 | 0.051 | 9000 | 156.0.8078.73 |
| wasm-nosimd-worker | unthrottled | 5000 | 16.76 | 6 of 18014 | 0.25 | 0.080 | 0.260 | 0.051 | 9000 | 156.0.8078.73 |
| wasm-nosimd-worker | unthrottled | 10000 | 16.76 | 1 of 18018 | 0.21 | 0.060 | 0.125 | 0.050 | 9000 | 156.0.8078.73 |
| ts-worker | unthrottled | 1000 | 16.76 | 3 of 18021 | 0.28 | 0.090 | 0.390 | 0.051 | 9000 | 156.0.8078.73 |
| ts-worker | unthrottled | 2000 | 16.76 | 0 of 18018 | 0.26 | 0.080 | 0.225 | 0.044 | 9000 | 156.0.8078.73 |
| ts-worker | unthrottled | 5000 | 16.76 | 3 of 18016 | 0.24 | 0.070 | 0.145 | 0.044 | 9000 | 156.0.8078.73 |
| ts-worker | unthrottled | 10000 | 16.75 | 1 of 18018 | 0.24 | 0.065 | 0.445 | 0.058 | 9000 | 156.0.8078.73 |
| wasm-simd-main | unthrottled | 1000 | 16.76 | 2 of 18018 | 0.22 | 0.000 | 0.010 | 0.009 | 9000 | 156.0.8078.73 |
| wasm-simd-main | unthrottled | 2000 | 16.76 | 2 of 18019 | 0.25 | 0.000 | 0.010 | 0.014 | 9000 | 156.0.8078.73 |
| wasm-simd-main | unthrottled | 5000 | 16.76 | 7 of 18012 | 0.22 | 0.000 | 0.010 | 0.018 | 9000 | 156.0.8078.73 |
| wasm-simd-main | unthrottled | 10000 | 16.75 | 2 of 18016 | 0.19 | 0.000 | 0.010 | 0.025 | 9000 | 156.0.8078.73 |
| wasm-simd-main | throttled 4x | 1000 | 16.75 | 4 of 18017 | 0.81 | 0.000 | 0.160 | 0.032 | 9000 | 156.0.8078.73 |
| wasm-simd-main | throttled 4x | 2000 | 16.77 | 16 of 18010 | 0.83 | 0.000 | 0.160 | 0.045 | 9000 | 156.0.8078.73 |
| wasm-simd-main | throttled 4x | 5000 | 16.78 | 21 of 18017 | 1.01 | 0.000 | 0.160 | 0.077 | 9000 | 156.0.8078.73 |
| wasm-simd-main | throttled 4x | 10000 | 16.76 | 5 of 18017 | 0.99 | 0.000 | 0.160 | 0.107 | 9000 | 156.0.8078.73 |

The "overlapping pairs" column and a position checksum are equal across WASM variants and within 0.02% for TypeScript (f32 against f64 arithmetic), so every variant did the same work.

## Findings

**Pass bar (2,000 entities, 99th percentile under 4 ms).**

| Where measured | Median | 99th percentile | Against 4 ms |
|---|---|---|---|
| dev machine, worker | 0.585 ms | 1.060 ms (whole step 1.150 ms) | met, 3.8× headroom |
| dev machine, throttled 4× (main thread) | 2.585 ms | 5.280 ms (whole step 5.440 ms) | median fits, 99th percentile misses by 32% |
| reference device | unmeasured | unmeasured | provisional |

**Limits (dev machine, WASM with SIMD, worker).** The 4 ms bar breaks between 5,000 entities (99th percentile 1.85 ms) and 10,000 (4.74 ms). At 20,000 the 99th percentile is 12.2 ms, still inside the 33.3 ms step. At 40,000 the median is 19.9 ms and the 99th percentile 75.8 ms: steps start up to 114 ms late, so the sim no longer holds 30 Hz. Collision is what grows: 36% of the step at 1,000 entities, 80% at 10,000, 93% at 40,000. Throttled 4×, the bar breaks between 1,000 entities (3.29 ms) and 2,000 (5.28 ms).

**SIMD on against off.** No measurable gain. With SIMD the median is 10% faster at 2,000 and 8% faster at 5,000, but 24% slower at 1,000 and 7% slower at 10,000; the differences are inside run-to-run noise. Only movement and turning are vectorized (by hand), and they sit in the "move+sort" share with the scalar sort; collision, the dominant cost, is branchy scalar code in both builds. SIMD costs nothing to keep, but this sim does not show that it is worth it. To benefit, collision would need a SIMD-friendly layout (batched narrow phase).

**Rust/WASM against typed-array TypeScript.** WASM is faster at the median at every count, by 2.0× at 1,000, 1.7× at 2,000, 1.3× at 5,000 and 1.2× at 10,000. At the 99th percentile the gap is 2.0×, 1.6×, 1.2× and none (4.63 ms TypeScript against 4.74 ms WASM at 10,000). TypeScript also meets the 4 ms bar at 2,000 entities on the dev machine (1.74 ms). The ruled-out option did not win, so the decision stands, but the measured margin is smaller than "steady timing" suggests: worst cases were similar, and TypeScript showed no garbage-collection spikes (it allocates nothing per step).

**Worker against main thread.** Step time is the same on either thread (2,000 entities: median 0.585 against 0.655 ms, 99th percentile 1.06 against 1.06 ms). The worker's cost is the hand-off: 0.045 to 0.15 ms per step to copy and post the snapshot, and 0.06 to 0.1 ms median (0.45 ms worst 99th percentile) from the end of a step until the main thread has the snapshot. What the worker gains in frame time cannot be seen in this stage, because frames only clear the canvas and have 16 ms of slack; Stage 2 repeats the comparison with rendering.

**Step timing.** Steps start late by up to 16 ms at the 99th percentile in most runs, in the worker and on the main thread alike. This is timer jitter (`setTimeout`), not sim cost, and it is input to Stage 2's choice of render-clock lag.

## Weaknesses (for the Stage 7 review)

- Two measurement streams ran at the same time (two Chrome windows), and the Stage 5 and Stage 6 subagents were building and measuring on the same machine. The machine has 16 cores, but this adds noise, most visibly in the SIMD comparison and in isolated maxima (53 ms at 1,000 entities, 127 ms at 20,000).
- One run per configuration.
- The scene is one seed and one crowd shape (everything converging on the player).
- 4× throttling is a guess at the reference device, not a measurement of it.

## Assumptions

- Top-down plane (the plan's default for the open question).
- "Rebuilt incrementally" is read as a time-sliced rebuild: 16,384 cells per step, so a full rebuild of the 65,536-cell field takes 4 steps.
- Collision resolves each overlapping pair once per step by pushing both apart; the player is never pushed, so the scripted path is identical in every variant.
- 16 enemy kinds with radii 0.25 to 0.475 units and speeds 2.0 to 2.4 units/s; player speed 5 units/s; about 3% of cells are obstacles.

## Rerun on the reference device

1. Check out the commit, then in `prototype/`: `pnpm install`, `pnpm run build`, `pnpm exec vite preview --port 4173`.
2. In Chrome at 1080p open `http://localhost:4173/vessel/?bench=stage1&sim=wasm-simd&thread=worker&n=2000&dur=300` and leave the tab in front for 5 minutes 10 seconds on battery-independent power.
3. In the console read `__result.sim.simMs` and `__result.sim.hostMs`. Pass: `hostMs.p99 < 4`.
4. Repeat with `n=1000`, `5000`, `10000` to find the limit, and with `sim=ts` for the comparison.
