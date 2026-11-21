# Stage 9: does the cel-shaded look fit the GPU budget?

Hypothesis: the GPU-driven renderer with the cel-shaded look and the combat effects fits about 60% of 16.7 ms at 1080p on the reference device under combat load, and CPU encoding stays under 2 ms.

Verdict: **provisional pass, GPU half unverified**. No reference device was available.
- **CPU encoding** is measured under Chrome's 4× CPU throttling, this run's stand-in for the reference device. At the pass load, encode and submit is median 0.80 ms, p99 1.83 ms [1.47–1.86], under 2 ms in all three five-minute runs. This is the pass load with the full look at 1080p (hull outlines, shadow map, grass, fog, bloom) and 2,000 enemies, 1,000 projectiles and 10,000 particles.
- **GPU time**: total GPU time is median 3.83 ms, p99 6.17 ms, against a budget of 10 ms. That was measured on the dev machine's RTX 3060, and nothing can slow a GPU to stand in for the reference laptop's integrated graphics. So the GPU half of the verdict holds only for this desktop GPU until the rerun below.

Two findings matter more than the pass:
- **The effects at Stage 8's real event rate bury the look.** Stage 8 measured about 16,400 events/s at the pass load. That leaves about 520 explosions alive at once, and with bloom they wash the frame out to near white (screenshots below). Overdraw is high at that rate: mean 8.5 writes per pixel, p99 25. This needs an on-screen effects budget. Stage 12 rates it P1.
- **Dynamic resolution flips back and forth.** It never acted at the planned 10 ms budget, because the dev GPU never went over. Forced with a 3 or 4 ms budget, it stepped down from 1080p to 432p in 7–10 s. Then it flipped between 432p and 540p every 3–7 s, 20–24 changes per minute. Stage 12 rates it P1, because a device near its budget would see the resolution change every few seconds.

Fallback: **not applied**. It applies only if a reference-device run fails. If it does, cut in the plan's order: bloom, grass density, particle counts and overdraw, shadow map resolution, internal resolution, blob shadows, then the entity count.

Outline method: **inverted hull (A)** is kept, provisionally.
- Its total GPU median at 1080p with the shadow map was lower at all three particle counts (3.31 / 3.83 / 4.30 ms against 3.72 / 4.34 / 4.43 ms). Those differences are within or at the edge of the spread.
- It needs no normal target and no extra post-processing pass.
- The edge pass on its own costs the same or less (0.16 ms against 0.16–0.21 ms median at 1080p with the shadow map), but the edge method moves cost into the world pass, which writes the normals.

Shadow method: **shadow map kept**. It costs 0.65–0.80 ms median and 1.6–2.2 ms p99 for its own pass at 1080p. Total GPU time with the map is within the spread of total GPU time with blob shadows. Crisp cast shadows are part of the look.

## What was built

All of it is in `src/stage9/` and `stage9.html`, on top of the Stage 3 GPU-driven renderer. All instances live in big buffers. A compute pass culls them into per-kind visible lists and indirect draw arguments, and render bundles replay the indirect draws.
- **Cel lighting**: a 3-band ramp texture with slightly soft edges, plus a rim light. Sun direction, colors, ramp shift, fog and sky follow a day and night keyframe table (`look.ts`): night, dawn, noon, dusk, night. The moon takes over at night.
- **Outlines, two ways**:
  - A, inverted hull: an extra instanced pass with no post-processing.
  - B, edge detection over depth and normals: needs a normal target and a post-processing pass.
  - Both are 2 internal pixels thick (`olw`). `outline=none` is there for comparison.
- **Cast shadows**: a 2,048² sun shadow map sampled with a hard cel edge, against run 1's blob shadows. Shadow casters are culled per instance.
- **Grass**: 32×32 chunks of 8×8 units over the 256×256 world, 192 clumps per chunk at density 1. The clumps sway in the vertex shader. A small bend texture written from entity positions each frame pushes them away from entities.
- **Atmosphere**: a painted gradient sky, colored distance fog, and bloom on bright effects (bright pass, then a horizontal and a vertical blur at half resolution).
- **Combat effects**:
  - Enemy animation: vertex animation textures with 32 frames for every kind.
  - Projectiles: instances with short trails.
  - Explosions and auras: instanced and blended. The explosion cap is 1,024, sized for Stage 8's pass load.
  - GPU particles: spawned in a compute pass from the snapshot's hit and death events, then moved and culled on the GPU, from a pool of up to 2 million.
- **UI pass**: health bars over enemies, floating damage numbers (at most 12 new ones per frame), and the HUD.
- **Dynamic resolution**: steps of 432, 540, 648, 720, 810, 900, 990 and 1080 lines. It takes the median of the last 30 GPU frame times.
  - It steps down when that median goes over the budget.
  - It steps up when the next size is predicted to fit under 95% of the budget, taking cost as proportional to pixels. It waits at least 3 s after a change before stepping up.
- **Overdraw debug view**: counts writes per pixel in the scene passes and reads back a histogram.
- **Device loss**: all GPU resources are created in one place, so building a new renderer after a device loss brings the whole look back.
- **Input**: a scripted snapshot stream (`script-stream.ts`, in a worker at 30 Hz) produces exactly what the combat sim produces: the v2 snapshot and the building list. Stage 11 swaps in the real sim.
  - Its event rates are Stage 8's measured pass load: 7,920 shots, 7,540 hits, 30 deaths and 40 extra explosions per second. With the explosions from explosive hits, that makes Stage 8's 940 explosions per second.
  - Before the full run, the defaults were placeholders of a few hundred events per second (commit `097b3d3`). They were changed so that the limits match across stages, as run 1's lessons ask.

Choices the plan left open, taken as defaults:
- Top-down camera with 58° pitch and distance 34, as in run 1.
- Outline thickness 2 internal pixels, shadow map 2,048².
- Grass density 1 (192 clumps per chunk), bloom at half resolution.
- Dynamic resolution budget 10 ms (60% of 16.7 ms).

## How it was measured

- **Machine**: the dev machine (Intel Core i7-13700, 64 GB, NVIDIA RTX 3060, Windows 11 Pro 10.0.26200) with Chrome 156.0.8078.73, headed and driven by puppeteer-core. The canvas is 1920×1080 and frames are vsync-locked at 60 Hz.
- **Throttling**: Chrome's 4× CPU throttling applies to the page, where encoding runs. Chrome cannot throttle workers, so the stream worker ran at full speed (a harmless warning in the log). Nothing can slow the GPU.
- **GPU time**: measured with timestamp queries, one begin/end pair per pass, read back a few frames later. `--enable-webgpu-developer-features` turns off Chrome's 100 µs rounding of timestamps. "Encode" is the CPU time from the start of the frame callback to `queue.submit`.
- **Build**: `vite build -c vite.stage9.config.ts` at `097b3d3`, served by `vite preview` with COOP/COEP.
- **Main matrix**: 0, 10,000 and 50,000 particles × 720p and 1080p internal resolution × hull and edge outlines × shadow map and blob shadows. Each cell ran 300 s × 3 repetitions after a 5 s warm-up. A cell shows the median over the repetitions, with min–max in brackets, and a difference counts only when it is larger than the spread.
- **Push-past sweeps**: 60 s each, one parameter at a time from the pass load.
  - Grass density 2, 4, 8, 16.
  - Particles 100,000, 200,000, 400,000.
  - Enemies 5,000, 10,000, 20,000.
- **Other runs**:
  - Overdraw: 60 s per outline method.
  - Dynamic resolution: 60 s at budgets of 10 ms and 6 ms. Two forced runs were added after the main run, at 3 ms and 4 ms, because the planned budgets never triggered it.
  - One GPU process crash, through `Browser.crashGpuProcess`.
- **Screenshots and recordings**:
  - Every option at the full event rate, and again at the old placeholder rates: 60 shots, 150 hits, 40 deaths and 10 explosions per second, under `media/stage9/calm/`. The second set is there so that the base look can be judged without the effects covering it.
  - Each set has a 10 s recording.
- **Conditions**: the machine was idle except for the measurement, and the user's own Chrome stayed open in the background.
- **Data**:
  - Raw results: `results/run-2/data/stage9/*.json`. Log: `results/run-2/data/stage9.log`.
  - Full tables, including per-pass p99: [`data/stage9-tables.md`](data/stage9-tables.md).

## Results

### Pass load: 1080p, full look, 2,000 enemies, 1,000 projectiles, 10,000 particles

| Outline | Shadow | GPU total median (ms) | GPU total p99 (ms) | Encode median (ms) | Encode p99 (ms) | Frame p99 (ms) | Draw calls |
|---|---|---|---|---|---|---|---|
| hull | map | 3.83 [3.29–4.01] | 6.17 [5.60–6.22] | 0.80 [0.65–0.82] | 1.83 [1.47–1.86] | 16.77 | 77 |
| edge | map | 4.34 [4.24–4.40] | 6.26 [6.14–6.31] | 0.65 [0.64–0.79] | 1.47 [1.43–1.64] | 16.76 | 58 |
| hull | blob | 3.96 [3.35–3.97] | 6.21 [5.74–6.41] | 0.66 [0.64–0.77] | 1.45 [1.44–1.53] | 16.76 | 59 |
| edge | blob | 3.94 [3.24–4.26] | 6.09 [5.87–6.40] | 0.64 [0.63–0.77] | 1.63 [1.44–1.82] | 16.76 | 41 |

The bar is 10 ms of GPU time and 2 ms of encode. Every cell of the main matrix stayed vsync-locked, with frame p99 at 16.76–16.77 ms over 5 minutes. Across all 72 main runs, the highest single-run encode p99 was 2.48 ms (0 particles, 720p, edge, map). 3 of the 72 runs went over 2 ms, none of them at the pass load. So encoding has about 10% headroom at 4×, and Stage 11, which adds the sim on the same thread, has to watch it.

### GPU time per pass at the pass load (1080p, 10,000 particles), median (p99), ms

| Outline / shadow | Shadow map | Grass | World | Outlines | Particles | Effects | Bloom | Upscale | UI |
|---|---|---|---|---|---|---|---|---|---|
| hull / map | 0.78 (2.16) | 1.08 (2.39) | 0.39 (1.18) | 0.19 (0.26) | 0.06 (0.09) | 0.69 (1.46) | 0.20 (0.25) | 0.14 (0.17) | 0.02 (0.05) |
| edge / map | 0.76 (1.78) | 1.43 (2.81) | 0.56 (1.20) | 0.16 (0.18) | 0.06 (0.09) | 0.74 (1.50) | 0.19 (0.23) | 0.14 (0.16) | 0.02 (0.05) |
| hull / blob | – | 1.47 (3.11) | 0.78 (1.84) | 0.23 (0.41) | 0.06 (0.10) | 0.75 (1.55) | 0.22 (0.27) | 0.16 (0.20) | 0.02 (0.05) |
| edge / blob | – | 1.71 (3.29) | 0.72 (1.65) | 0.17 (0.27) | 0.07 (0.10) | 0.75 (1.59) | 0.21 (0.26) | 0.15 (0.18) | 0.02 (0.05) |

Culling costs 0.02 ms everywhere. Grass and effects are the largest passes, followed by the shadow map. The effects pass covers blended explosions and auras. Grass and effects are also the passes the plan expects to limit integrated GPUs.

**Read these with care.** The RTX 3060 is lightly loaded at every cell, about a quarter of the frame. Its clocks follow the load, so per-pass and total GPU times on this card do not scale cleanly with work:
- 720p is not reliably cheaper than 1080p.
- Blob-shadow runs show more grass and world time than shadow-map runs, though they draw less.

Only large differences are real here: the shadow map's own cost, and the edge method's normal writes. The reference device's integrated GPU will be fully loaded, where the costs add up as expected. That is another reason the GPU half needs the rerun.

### Particles: 0, 10,000, 50,000 (1080p, hull, map)

GPU total median is 3.31, 3.83 and 4.30 ms; p99 is 5.93, 6.17 and 6.37 ms. The particle passes cost 0.06 ms median at 10,000 and 0.24 ms at 50,000. Encode does not change with the particle count, because particles never leave the GPU.

### Overdraw (pass load, 1080p)

| Outline | Mean writes/pixel | p99 writes/pixel | Max |
|---|---|---|---|
| hull | 8.51 | 24 | 127 (the counter's cap) |
| edge | 8.65 | 25 | 127 |

That is high. Most of it is blended explosions and auras stacked at Stage 8's event rate, plus alpha-tested grass. On an integrated GPU, this is the number most likely to fail the pass.

### The look

Screenshots are at 1920×1080, all from the same seed and time. Each side-by-side sheet shows hull | edge | none:

- [Full event rate, day, shadow map](media/stage9/sidebyside-map-day.jpg) and [dusk](media/stage9/sidebyside-map-dusk.jpg). Blob shadows: [day](media/stage9/sidebyside-blob-day.jpg), [dusk](media/stage9/sidebyside-blob-dusk.jpg).
- [Low event rate, day, shadow map](media/stage9/calm/sidebyside-map-day.jpg), [dusk](media/stage9/calm/sidebyside-map-dusk.jpg). Blob shadows: [day](media/stage9/calm/sidebyside-blob-day.jpg), [dusk](media/stage9/calm/sidebyside-blob-dusk.jpg).
- Low camera (sky, fog, grass bending), full rate: [dawn](media/stage9/lowcam-dawn.jpg), [day](media/stage9/lowcam-day.jpg), [dusk](media/stage9/lowcam-dusk.jpg). Low rate: [dawn](media/stage9/calm/lowcam-dawn.jpg), [day](media/stage9/calm/lowcam-day.jpg), [dusk](media/stage9/calm/lowcam-dusk.jpg).
- 10 s recordings: [full rate](media/stage9/combat.mp4), [low rate](media/stage9/calm/combat.mp4).

Judged against the reference (Breath of the Wild's look), with placeholder art:
- **At the low event rate** the look reads as intended.
  - Lighting: stepped cel bands and a rim light.
  - Grass: a dense lawn that sways and parts around the crowd.
  - Shadows: crisp cast shadows from buildings and trees.
  - Atmosphere: warm fog and sky at dawn and dusk, with bloom limited to effects.
  - Outlines: hull outlines give clean silhouettes on buildings and characters. Edge outlines are slightly thinner and also catch creases inside the buildings. At this camera distance, "none" loses the separation between overlapping enemies.
- **At Stage 8's full rate** the frame is washed out: about 520 explosions alive and 7,500 hit sparks per second, all bloomed. On top of that come 2,000 health bars and their black backgrounds. The scene, the crowd and the outlines are mostly gone.
  - This is not a GPU cost problem; the dev GPU holds 60 fps through it.
  - It is a look and readability problem: the game needs a budget for what is on screen, not only for what is simulated.
  - Stage 12 rates it **P1**. The likely fix is a cap on the explosions drawn, nearest the player first, lower bloom from explosions, and health bars only for damaged or nearby enemies.

### Limits found (dev GPU, one 60 s run each)

| Push | GPU total median / p99 (ms) | Frames > 20 ms | Notes |
|---|---|---|---|
| Grass 2× / 4× / 8× / 16× | 4.37 / 6.16, 4.54 / 6.26, 4.96 / 6.40, 5.29 / 6.45 | 0, 1, 1, 0 | 16× draws 138,240 visible clumps |
| Particles 100k / 200k / 400k | 4.32 / 6.14, 4.31 / 6.14, 4.57 / 6.21 | 0 | about 400,700 alive at the top |
| Enemies 5k / 10k / 20k | 4.76 / 6.20, 5.16 / 6.32, 7.73 / 9.29 | 0, 0, 2 | 12,046 visible instances at 20k; shadow map 2.95 ms, world 2.24 ms |

The frame did not break on the dev GPU at any pushed value: every p99 stayed under 10 ms. The enemy count is the steepest cost, because every enemy is drawn into the shadow map, the world pass and the outline pass. It is the closest to the bar: p99 9.29 ms at 10× the pass load. Particles barely cost anything. These limits say nothing about the integrated GPU.

### Dynamic resolution

| Budget | Particles | Changes in 60 s | Final height | GPU median / p99 (ms) |
|---|---|---|---|---|
| 10 ms | 50,000 | 0 | 1080 | 4.30 / 6.20 |
| 6 ms | 10,000 | 0 | 1080 | 3.90 / 5.83 |
| 3 ms (forced) | 10,000 | 24 | 540 | 2.83 / 6.78 |
| 4 ms (forced) | 50,000 | 20 | 540 | 3.41 / 6.66 |

**Stepping down** works. One step comes per fresh 30-frame window (about 0.5–3 s), and 1080p reached 432p in 6.8 s at a 3 ms budget and 10.3 s at 4 ms.

**After that it oscillates.** The pattern repeats:
1. At 432p the GPU median falls to 1.0–2.4 ms.
2. The pixel-proportional prediction says 540p fits under 95% of the budget, so it steps up.
3. At 540p the median comes in just over the budget (3.0–4.4 ms), so it steps back down.

It flips every 3–7 s, the minimum hold plus one window. The 5% margin is too thin for frame-time noise. On this card, the clock drop at light load makes the jump between sizes larger than the pixel ratio predicts.

Stage 12 rates it **P1**: a device that sits near its budget would see the resolution change every few seconds. The fix is a wider gap between the step-down and step-up thresholds, and a longer hold after a step down.

### GPU process crash

One forced GPU process crash at the pass load:
- The device was lost at 9.50 s, with reason "unknown".
- The renderer was rebuilt and drawing again 602 ms later, on the first attempt.
- Afterwards everything was back: 1,248 visible instances, 50 grass chunks, 10,323 particles, 2,429 shadow casters, the 2,048² shadow map, and no errors.
- As in run 1's Stage 4, a second crash within about 150 s is not recovered, so only one was forced.

Raw data: `data/stage9/crash.json`.

### First-load cost

The Stage 9 page's JS is 117 KB, 35.1 KB gzipped, plus a 6.8 KB worker (2.5 KB gzipped). Shaders are generated at runtime and the art is placeholder, so there are no asset downloads. The real art and sound will be what costs first-load time.

## Problems in this measurement (rated as in Stage 12)

- **P1, look**: at Stage 8's event rate, the effects and health bars bury the scene (above). The pass load's GPU numbers include this worst case, so a fix can only lower them.
- **P1, dynamic resolution** oscillates between two sizes every 3–7 s once it acts (above).
- **P2**: the GPU is not slowed by anything, so all GPU results are for an RTX 3060, not integrated graphics. On this card, per-pass and per-resolution comparisons are blurred by clock changes at light load.
- **P2**: the push-past sweeps did not break the frame on the dev GPU, so the breaking points are unmeasured.
- **P2**: the stream worker is not throttled, so a slower worker's effect on snapshot timing is untested here. Stage 11 runs the real sim instead.
- **P2**: shadow casters are culled per instance, not per chunk. At 20,000 enemies the shadow map is the largest pass (2.95 ms). Culling by chunk or by distance from the camera would cut it.
- **P2**: health bars are drawn for every visible enemy, which is clutter at 2,000 enemies (part of the P1 above).

## Rerun on the reference device

From `prototype/`, on the reference laptop (Chrome, plugged in, display at 1080p, nothing else running), with Node 22:

1. `pnpm install`, then `node node_modules/vite/bin/vite.js build -c vite.stage9.config.ts`.
2. In one terminal: `node node_modules/vite/bin/vite.js preview -c vite.stage9.config.ts --port 4183 --strictPort`.
3. In a second terminal, set `VESSEL_BASE=http://localhost:4183/vessel/` and run the pass load without throttling: `node scripts/run2/stage9.mjs --throttle 1 --only "main-p10000-i1080" --out results/run-2/data/stage9-ref`. That is 12 runs of 5 min, about 1.2 h. Drop `--only` for the whole matrix (72 runs, about 7 h).
4. Limits and dynamic resolution: `node scripts/run2/stage9.mjs --throttle 1 --only "sweep-|overdraw-|dynres-" --out results/run-2/data/stage9-ref`.
5. Tables: `node scripts/run2/stage9-table.mjs results/run-2/data/stage9-ref/`.

The verdict is a pass if `main-p10000-i1080-hull-map` (the full look) has a GPU total p99 under 10 ms and an encode p99 under 2 ms in all three repetitions. If it fails, apply the fallback above, checking the look after each cut. On the reference device, dynamic resolution should act at the 10 ms budget. Check whether it oscillates once Stage 12's fix is in.
