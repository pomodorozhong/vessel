# Stage 3: does GPU-driven rendering pay off?

Hypothesis: compute culling, `drawIndirect`, and render bundles keep CPU time per frame small and flat as entity count grows, and stay within the GPU budget on the reference device.

Verdict: **provisional**.

- "CPU time small and flat": **held on the dev machine**. Encoding and submitting a GPU-driven frame costs 0.08–0.10 ms at the median from 1,000 to 20,000 entities (99th percentile under 0.3 ms), and 0.23–0.25 ms median / 0.8 ms p99 with the CPU throttled 4×. The bar is 2 ms.
- "Within the GPU budget on the reference device": **unmeasured**. The dev machine's GPU (RTX 3060) cannot be slowed down, and its numbers say nothing about integrated graphics. On the dev machine the whole frame (main-thread CPU 0.15 ms + GPU 1.3 ms median at 2,000 entities, 1080p) uses about 1.5 ms of the 10 ms target.
- "GPU-driven beats the plain path by a clear margin at the higher counts": **true as a ratio, small in absolute terms**. CPU encoding is 3.5× lower at 2,000 entities and 6× lower at 20,000 (0.08 against 0.49 ms median); this is an upper bound, because the plain path culls every static instance each frame (see "Fairness"). The saving is 0.2–0.4 ms per frame unthrottled and 0.8–1.2 ms throttled 4×. GPU time is the same on both paths within noise. The plain path also stays under 2 ms on the dev machine; throttled 4× its 99th percentile is 2.0 ms at 2,000 entities and 2.4 ms at 10,000, at and over the bar.

Fallback recorded, **not applied**: "if the plain path is as fast, drop compute culling and render bundles and keep plain instancing". The plain path is not as fast on the CPU, so the decision stays, but the margin is a fraction of a millisecond on this machine; the reference-device run decides whether it is worth the extra machinery. If the GPU is the limit there: lower resolution and overdraw first, then the entity target.

Against Three.js (the main ruled-out option): our renderer's main-thread cost per frame is 3.4 to 7.8 times lower, and the gap grows with entity count (0.15 against 0.56 ms median at 2,000 entities; 0.22 against 1.71 ms at 20,000), and 5 to 7 times lower throttled 4× (0.43 against 2.21 ms at 2,000; 0.63 against 4.26 ms at 10,000). These are from the rerun after review, with Three.js's static instances uploaded once. The first version re-uploaded about 1 MB of static matrices every frame and gave 7 to 9 times; that figure was too high and is kept in the table only for reference. **The ruled-out option lost on CPU time**, with the fairness limits listed below.

## What was built

- `src/render-world.ts` + `src/shaders.ts`, one renderer with two modes on the same scene:
  - **GPU-driven**: all instances (15,913 static + the dynamic entities) in one storage buffer, statics uploaded once and the dynamic part once per snapshot (`writeBuffer` of the snapshot's entries, no conversion). A compute pass culls every instance against the camera's ground rectangle (a box around both interpolated positions) and appends its index to a per-kind range of a `visible` buffer with atomics, which also fills the instance counts of the indirect draw buffer. `firstInstance` stays 0; each draw gets its range base from a small uniform at a dynamic offset. The 20 indirect draws and the shadow draw are recorded once in a render bundle.
  - **Plain**: the CPU culls every instance each frame, writes the visible indices, and issues one direct instanced draw per kind.
- Content: 20 kinds (16 enemy kinds and the player on the play plane, walls on the play plane, grass in the background layer, trees in the foreground layer), drawn by layer front to back; 16-byte packed vertices (snorm16 position, snorm8 normal, unorm16 UV, baked ambient occlusion in position.w); one 1024×1024 atlas; ambient plus one sun; blob shadows (one alpha-blended instanced quad per visible moving entity); a vertex animation texture (32 frames) for enemy kind 0.
- Upscale pass: the world is drawn at the internal resolution, then one full-screen pass does bilinear upscale, contrast-adaptive sharpening (in the style of FSR 1's RCAS), colour grading and a vignette; three UI rectangles are drawn after it at canvas resolution.
- `src/three-main.ts` / `three.html`: the same sim worker, snapshots, render clock, meshes, atlas, camera and static layout in Three.js r187 with `WebGPURenderer` (`three/webgpu`), one `InstancedMesh` per kind plus one for blob shadows. Static kinds are filled and uploaded once and always drawn whole (15,913 instances, no culling), the way our renderer uploads statics once; moving entities are culled and interpolated on the CPU into the instance matrices each frame. `three.html?statics=cull` is the first version, which also re-culled and re-uploaded every static instance each frame.

## How it was measured

- Dev machine: Intel Core i7-13700, 64 GB, NVIDIA RTX 3060 (driver 32.0.15.6094), Windows 11 Pro 10.0.26200, Chrome 156.0.8078.73 (headed, 60 Hz display, vsync on). Canvas 1920×1080 and internal resolution 1920×1080 unless the row says otherwise.
- Build: commit `99f1571`, `vite build`, served by `vite preview`. WASM SIMD sim in the worker at 30 Hz, snapshot design A with lag 2 (Stage 2's result), `spawn=40` (enemies start within 40 units of the player, so the crowd on screen is dense from the start; this also makes the sim step slower than Stage 1's spread-out start).
- Each row is one 5-minute run after a 5-second warm-up (about 18,000 frames). Rerun with `node scripts/stage3.mjs 300`; print the tables with `node scripts/stage3-table.mjs`. URLs: `?render=<gpu|plain>&bench=stage3&spawn=40&n=<count>&ires=<720|1080>&cw=<canvas width>&ch=<canvas height>&dur=300` and `three.html?bench=stage3&spawn=40&n=<count>&dur=300`.
- "Main-thread CPU per frame": time inside the `requestAnimationFrame` callback (clock, snapshot upload on the frames that have one, culling where it is on the CPU, encoding, submit, overlay). "Encode+submit": for our renderer, from before the first pass is encoded to after `queue.submit`; for Three.js, **only** the culling and instance-matrix update (its `renderer.render` call cannot be split the same way, so compare the "main-thread CPU" column across renderers, not this one).
- "GPU": the sum of `timestamp-query` pass times (cull compute + world + upscale/UI), read back a few frames later. Chrome quantizes timestamps to 0.1 ms. For Three.js it is the renderer's own timestamp total for its render pass.
- "dev machine, throttled" rows use Chrome's CPU throttling at 4× on the page. Chrome refuses to throttle workers, so the sim worker runs unthrottled in those rows.
- Raw data: `results/data/stage3/*.json`, log `results/data/stage3.log`.
- The "Three.js, statics uploaded once" rows were measured after review on a later build (the commit that adds `statics=once`), same machine, browser and settings; the GPU-driven, plain and first-version Three.js rows are from commit `99f1571` and were not rerun. `three-*.json` is the new version, `threecull-*.json` the first one (`three.html?statics=cull`).

## Results (all rows: dev machine, Chrome 156.0.8078.73, 1080p internal, 1920×1080 canvas)

| Path | CPU | Entities | Main-thread CPU per frame median / p99 (ms) | Encode+submit median / p99 (ms) | GPU median / p99 (ms) | Draw calls | Visible instances (last frame) | Frame median / p99 (ms) | Frames > 20 ms | Frames > 34 ms | Pauses | Jumps | Sim step p99 (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GPU-driven | unthrottled | 1000 | 0.14 / 0.40 | 0.10 / 0.28 | 1.18 / 4.39 | 24 | 1183 | 16.67 / 16.81 | 2 | 0 | 0 | 0 | 1.88 |
| plain | unthrottled | 1000 | 0.35 / 1.05 | 0.29 / 0.92 | 1.57 / 5.64 | 24 | 1261 | 16.67 / 16.80 | 0 | 0 | 0 | 0 | 1.45 |
| Three.js, statics uploaded once | unthrottled | 1000 | 0.48 / 1.37 | 0.08 / 0.34 | 2.88 / 7.80 | 22 | 16437 | 16.67 / 16.81 | 1 | 0 | 0 | 0 | 1.84 |
| Three.js, statics re-uploaded every frame (first version) | unthrottled | 1000 | 0.98 / 2.99 | 0.28 / 0.89 | 1.18 / 3.80 | 22 | 1261 | 16.67 / 16.80 | 1 | 0 | 0 | 0 | 1.65 |
| GPU-driven | unthrottled | 2000 | 0.15 / 0.45 | 0.09 / 0.27 | 1.31 / 4.92 | 24 | 1535 | 16.67 / 16.81 | 1 | 0 | 0 | 0 | 2.22 |
| plain | unthrottled | 2000 | 0.37 / 1.13 | 0.32 / 0.97 | 1.90 / 5.24 | 23 | 1643 | 16.67 / 16.80 | 2 | 0 | 0 | 0 | 1.90 |
| Three.js, statics uploaded once | unthrottled | 2000 | 0.56 / 1.71 | 0.12 / 0.53 | 3.01 / 7.54 | 21 | 16819 | 16.67 / 16.81 | 0 | 0 | 0 | 0 | 2.45 |
| Three.js, statics re-uploaded every frame (first version) | unthrottled | 2000 | 1.03 / 3.23 | 0.31 / 1.06 | 1.38 / 4.59 | 21 | 1643 | 16.67 / 16.80 | 0 | 0 | 0 | 0 | 2.23 |
| GPU-driven | unthrottled | 5000 | 0.16 / 0.54 | 0.09 / 0.25 | 2.82 / 5.77 | 24 | 2690 | 16.67 / 16.80 | 0 | 0 | 0 | 0 | 3.83 |
| plain | unthrottled | 5000 | 0.44 / 1.31 | 0.38 / 1.09 | 2.75 / 5.70 | 24 | 2871 | 16.67 / 16.80 | 0 | 0 | 0 | 0 | 3.37 |
| Three.js, statics uploaded once | unthrottled | 5000 | 0.75 / 2.38 | 0.23 / 0.98 | 3.34 / 7.80 | 22 | 18047 | 16.67 / 16.78 | 1 | 0 | 0 | 0 | 3.50 |
| Three.js, statics re-uploaded every frame (first version) | unthrottled | 5000 | 1.18 / 3.57 | 0.42 / 1.36 | 2.23 / 5.24 | 22 | 2873 | 16.67 / 16.79 | 0 | 0 | 0 | 0 | 4.29 |
| GPU-driven | unthrottled | 10000 | 0.18 / 0.62 | 0.08 / 0.24 | 2.36 / 5.77 | 24 | 4668 | 16.67 / 16.78 | 2 | 0 | 0 | 0 | 7.75 |
| plain | unthrottled | 10000 | 0.55 / 1.86 | 0.46 / 1.47 | 2.42 / 5.77 | 24 | 4950 | 16.67 / 16.78 | 0 | 0 | 0 | 0 | 7.48 |
| Three.js, statics uploaded once | unthrottled | 10000 | 1.17 / 3.35 | 0.44 / 1.41 | 3.15 / 6.75 | 22 | 20129 | 16.67 / 16.78 | 1 | 0 | 0 | 0 | 7.54 |
| Three.js, statics re-uploaded every frame (first version) | unthrottled | 10000 | 1.50 / 3.82 | 0.61 / 1.81 | 2.75 / 5.37 | 22 | 4950 | 16.67 / 16.78 | 1 | 0 | 0 | 0 | 6.07 |
| GPU-driven | unthrottled | 20000 | 0.22 / 0.69 | 0.08 / 0.19 | 3.41 / 6.75 | 24 | 8723 | 16.67 / 16.78 | 1 | 0 | 0 | 0 | 11.05 |
| plain | unthrottled | 20000 | 0.63 / 1.42 | 0.49 / 1.11 | 3.47 / 6.29 | 24 | 9175 | 16.67 / 16.77 | 1 | 0 | 0 | 0 | 9.91 |
| Three.js, statics uploaded once | unthrottled | 20000 | 1.71 / 3.34 | 0.75 / 1.65 | 3.80 / 6.03 | 22 | 24341 | 16.67 / 16.76 | 1 | 0 | 0 | 0 | 9.30 |
| Three.js, statics re-uploaded every frame (first version) | unthrottled | 20000 | 2.03 / 3.93 | 0.88 / 2.04 | 3.34 / 5.37 | 22 | 9173 | 16.67 / 16.77 | 0 | 0 | 0 | 0 | 8.50 |
| GPU-driven | throttled 4× | 2000 | 0.43 / 1.20 | 0.25 / 0.82 | 1.97 / 6.09 | 24 | 1530 | 16.67 / 16.76 | 2 | 0 | 0 | 0 | 0.89 |
| plain | throttled 4× | 2000 | 1.22 / 2.24 | 1.03 / 2.00 | 1.31 / 5.24 | 23 | 1643 | 16.67 / 16.76 | 1 | 0 | 0 | 0 | 0.88 |
| Three.js, statics uploaded once | throttled 4× | 2000 | 2.21 / 4.89 | 0.43 / 1.19 | 1.51 / 4.98 | 21 | 16819 | 16.67 / 16.75 | 1 | 0 | 0 | 0 | 0.99 |
| Three.js, statics re-uploaded every frame (first version) | throttled 4× | 2000 | 3.43 / 4.95 | 1.02 / 2.03 | 1.05 / 3.28 | 21 | 1642 | 16.67 / 16.76 | 4 | 0 | 0 | 0 | 0.96 |
| GPU-driven | throttled 4× | 10000 | 0.63 / 1.59 | 0.23 / 0.80 | 2.95 / 5.96 | 24 | 4664 | 16.67 / 16.76 | 1 | 0 | 0 | 0 | 2.94 |
| plain | throttled 4× | 10000 | 1.82 / 2.89 | 1.43 / 2.41 | 2.69 / 5.31 | 24 | 4950 | 16.67 / 16.76 | 1 | 0 | 0 | 0 | 3.00 |
| Three.js, statics uploaded once | throttled 4× | 10000 | 4.26 / 7.73 | 1.62 / 3.07 | 2.49 / 4.72 | 22 | 20128 | 16.67 / 16.75 | 0 | 0 | 0 | 0 | 3.58 |
| Three.js, statics re-uploaded every frame (first version) | throttled 4× | 10000 | 5.63 / 7.66 | 2.18 / 3.43 | 2.62 / 4.39 | 22 | 4950 | 16.67 / 16.75 | 2 | 0 | 0 | 0 | 2.96 |

Resolution and the upscale pass (GPU-driven, 2,000 entities, dev machine, unthrottled; pass times are means over the run):

| Internal resolution | Canvas | GPU total median / p99 (ms) | World pass mean (ms) | Upscale + grading + UI pass mean (ms) | Cull compute mean (ms) | Frame p99 (ms) |
|---|---|---|---|---|---|---|
| 1080p | 1920×1080 | 1.31 / 4.92 | 1.27 | 0.27 | 0.04 | 16.81 |
| 1080p | 2560×1440 | 2.56 / 5.70 | 1.89 | 0.60 | 0.06 | 16.81 |
| 1080p | 3840×2160 | 2.23 / 5.05 | 1.31 | 0.87 | 0.04 | 16.80 |
| 720p | 1920×1080 | 1.70 / 5.77 | 1.34 | 0.40 | 0.05 | 16.81 |
| 720p | 2560×1440 | 1.90 / 5.24 | 1.22 | 0.59 | 0.05 | 16.81 |
| 720p | 3840×2160 | 1.97 / 4.85 | 0.92 | 0.95 | 0.04 | 16.81 |

## What the numbers say

- **CPU encode, GPU-driven against plain** (median ms, unthrottled): 1,000: 0.10 / 0.29; 2,000: 0.09 / 0.32; 5,000: 0.09 / 0.38; 10,000: 0.08 / 0.46; 20,000: 0.08 / 0.49. The GPU-driven path is flat; the plain path grows slowly, because its CPU culling loop walks every instance (15,913 statics dominate until the entity count is large). Throttled 4×: 0.25 / 1.03 at 2,000 and 0.23 / 1.43 at 10,000; the plain path's 99th percentile is 2.00 and 2.41 ms.
- **GPU time** is the same for both paths within the run-to-run noise of this GPU (1.2–3.5 ms median, 4–7 ms at the 99th percentile). The compute culling pass costs 0.04–0.06 ms. GPU time does not rise steadily with entity count here (2.82 ms at 5,000 against 2.36 ms at 10,000), which suggests the GPU changes its clock speed under this light load; these numbers are not a measure of the content's real cost. That needs the reference device.
- **Resolution**: on this GPU the world pass costs about the same at 720p and 1080p internal resolution (0.9–1.9 ms, inside the noise). The upscale + grading + UI pass costs 0.27 ms to a 1080p canvas, 0.6 ms to 1440p and 0.9 ms to 4K, at either internal resolution. The 4K canvas is larger than the dev machine's 1440p display, so the browser scales it down afterwards; the pass itself still runs at 4K.
- **Draw calls**: 24 per frame with every kind and layer present (20 kind draws, blob shadows, ground, the upscale pass, UI), the same at 1,000 and 20,000 entities, against the cap of 100. (The plain path skips a kind with nothing visible, hence 23 in two rows.)
- **Frame time**: every run held 60 fps for 5 minutes: median 16.67 ms, 99th percentile 16.75–16.81 ms, at most 4 frames over 20 ms and none over 34 ms in about 18,000, and no pauses or jumps from the snapshot clock in any run, including 20,000 entities where the sim step's 99th percentile is 8.5–11 ms.
- **Three.js** (statics uploaded once): main-thread CPU 0.48 → 1.71 ms median from 1,000 to 20,000 entities (99th percentile 1.4–3.4 ms), against 0.14 → 0.22 ms. Throttled 4× it is 2.21 ms (p99 4.89) at 2,000 and 4.26 ms (p99 7.73) at 10,000: over the 2 ms encoding budget before anything else runs on the main thread. Its cost grows with entity count because every visible moving entity is interpolated and written on the CPU each frame. Its GPU time is higher than ours in this version (3.0 against 1.3 ms median at 2,000 entities), because it draws all 15,913 static instances every frame without culling; with CPU culling of statics (the first version) GPU time was about equal and CPU time was 0.3 to 0.5 ms higher unthrottled, 1.2 to 1.4 ms throttled.
- **Sim step in these runs**: the step's 99th percentile is 2.2 ms at 2,000 entities here against 1.06 ms in Stage 1, because of the dense `spawn=40` start. In the throttled rows it reads lower (0.89 ms) although the worker is not throttled; the likely cause is that Chrome's throttling keeps the main thread spinning and so keeps the CPU at a high clock speed, which was not verified. It is a reminder that an almost idle dev machine is not a steady clock.

## Fairness of the comparisons

- GPU-driven and plain are the same renderer, shaders, meshes and scene; only culling and draw submission differ. Fair, with one bias against the plain path: it culls all 15,913 static instances on the CPU every frame, where a real plain renderer would cull statics per chunk. So the 3.5–6× CPU gap is an upper bound, which matters for the fallback decision on the reference device.
- The visible instance counts differ slightly between paths (for example 1,535 against 1,643 at 2,000 entities): the GPU-driven count is read back from the GPU a few frames late and both are a single last-frame sample of a moving crowd. The culling test is the same.
- Three.js draws the same meshes, instances, atlas, camera, lighting model, ground and blob shadows, **without** the vertex animation texture for kind 0, the upscale/sharpen/grading pass, and the UI pass (so 21–22 draw calls against 24). It interpolates moving entities on the CPU and writes their instance matrices every frame, which is the idiomatic `InstancedMesh` use and is exactly the "copy from our arrays into its objects each frame" cost the tech direction named; a custom node material that interpolates on the GPU was not built and would lower Three.js's CPU time. Statics are uploaded once and not culled, so its GPU does more vertex work than ours; culling statics per chunk with one `InstancedMesh` per chunk was not built. So the measured gap is "our renderer against straightforward Three.js", not against the best possible Three.js, and the ratio should be read as an upper bound.
- One run per configuration. The CPU-time gaps (3–9×) are far larger than the spread between neighbouring rows; the GPU-time differences are not, and no conclusion is drawn from them.

## Limits found

- GPU-driven CPU cost did not grow up to 20,000 entities (17,913 → 35,913 instances in the buffers). The limit was not reached; the sim (Stage 1) runs out first.
- Plain path: reaches the 2 ms CPU bar at 2,000 entities when throttled 4× (p99), with every static instance culled on the CPU each frame (a per-chunk cull of statics would cost less).
- Three.js (statics uploaded once): main-thread CPU is over 2 ms at the median when throttled 4× (2.21 ms at 2,000 entities), and at the 99th percentile from 5,000 entities up unthrottled.
- The GPU limit is unknown: it needs the reference device.

## Rerun steps (reference device)

1. In `prototype/`: `npx pnpm@10 install && npx pnpm@10 build && npx pnpm@10 preview`, then `node scripts/stage3.mjs 300` in Chrome at 1080p (about 2 h 15 min; `node scripts/stage3.mjs 300 "^(gpu|plain)-n(2000|10000)$"` for the four rows that decide the verdict).
2. Pass: at 2,000 entities, main-thread CPU + GPU 99th percentile fits about 10 ms, encode+submit stays under 2 ms, and frame time holds 16.7 ms for the 5 minutes (watch the last minute for thermal slowdown).
3. Compare `gpu-n10000` and `plain-n10000`: if the plain path's CPU and GPU times are within noise of the GPU-driven path there too, apply the fallback (plain instancing).
4. Read the `gpu-n2000-i720-*` and `gpu-n2000-i1080-*` rows for the cost of resolution and of the upscale pass on integrated graphics.
