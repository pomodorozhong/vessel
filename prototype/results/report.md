# Prototype report (run 1)

Everything here was measured on the **dev machine**: Intel Core i7-13700, 64 GB, NVIDIA RTX 3060, Windows 11 Pro 10.0.26200, Chrome 156.0.8078.73 (Edge 157.0.4341.60 where named), on local production builds. "Throttled" means Chrome's 4× CPU throttling, which cannot reach workers. **No number is a reference-device result, and nothing ran on GitHub Pages**: the branch could not be pushed to the repository (see "Blocked"). Details, tables, raw data and rerun steps are in `stage-0.md` to `stage-6.md`.

## Verdicts

| Stage | Hypothesis | Verdict | Numbers behind it (dev machine) |
|---|---|---|---|
| 0 | Skeleton loads from Pages in Chrome, Safari, Firefox | **unclear** | Works locally in Chrome and Edge. Pages, Safari, Firefox, gamepad: unmeasured. |
| 1 | A Rust/WASM sim in one worker steps 2,000 entities in 4 ms (p99) | **provisional** | 2,000 entities: median 0.59 ms, p99 1.06 ms. Throttled 4× (main thread): median 2.59 ms, p99 5.28 ms, which misses 4 ms. |
| 2 | Snapshots are smooth at 60 and 30 fps with a fixed pool | **provisional**: smoothness and stall recovery held (design A, lag 2); input delay at the ~100 ms bar before display time at 30 fps, gamepad unmeasured, zero allocation not shown | 0 pauses and 0 jumps per minute at 60 and 30 fps with 0–20 ms of added delay; recovery after a 500 ms stall in at most 466 ms; keyboard input to frame submit p99 67–98 ms (97.6 ms p99, 100.2 ms max at 30 fps with 20 ms of delay). |
| 3 | GPU-driven rendering keeps CPU small and flat and fits the GPU budget | **provisional** | Encode+submit 0.08–0.10 ms median from 1,000 to 20,000 entities (0.25 ms throttled); 24 draw calls; frame p99 16.8 ms for 5 minutes. GPU 1.3 ms median at 2,000 entities on an RTX 3060, which says nothing about integrated graphics. |
| 4 | Raw WebGPU starts, recovers and fails cleanly | **unclear** | Chrome and Edge on Windows start; a GPU process crash recovers in 0.6–0.8 s without a reload (not a second one within 20 s, nor a third within 5 minutes, even with 60 s of retrying); both "not supported" paths show. macOS, Safari, Firefox, sleep/wake, gamepads: unmeasured. |
| 5 | Fast start from Pages; a deploy does not break a tab | **provisional** | Against a local Pages emulator on Fast 4G: cold first frame 2.04 s (bar 3 s), warm 0.33 s (bar 1 s); a deploy with the previous build kept gives no failed request in 5 of 5 runs. Real Pages: unmeasured. |
| 6 | Direct catch-up equals replay; saves survive the browser | **provisional** | 0 mismatches in 30.5 million property-test operations after 3 protocol fixes; week-old chunk caught up in 4.28 ms p99 against a 12.8 s window; save costs the sim 0.14 ms median / 0.26 ms p99. Eviction, Safari, Firefox: unmeasured. |

No fallback was applied. Stage 1's fallback (cut the entity target or step rate first) is recorded for the case that the reference device confirms the throttled miss.

## Limits found

- **Sim** (WASM, worker): the 4 ms bar breaks between 5,000 (p99 1.85 ms) and 10,000 entities (4.74 ms); 40,000 cannot hold 30 Hz. Throttled 4× it breaks between 1,000 (3.29 ms) and 2,000 (5.28 ms). Collision is 48% of the step at 2,000 entities and 93% at 40,000.
- **Snapshots**: a lag of 1.5 steps is the edge (0.2–2.2 pauses per minute), 1 step fails (240–294). Pool 3 / queue 1 fails (137 pauses per minute); pool 4 / queue 2 is the smallest clean size. At 30 fps with 20 ms of delay, input delay reaches 100 ms before display time is counted.
- **Rendering**: GPU-driven CPU cost did not grow up to 20,000 entities; the limit was not reached. The plain path reaches the 2 ms bar at 2,000 entities when throttled 4× (p99 2.0 ms). The upscale pass costs 0.3 / 0.6 / 0.9 ms to a 1080p / 1440p / 4K canvas on this GPU.
- **Device loss**: a second GPU process crash 20 s after the first is not recovered in 60 s of retrying; a reload then works at once. With 150 s between crashes the second is recovered (0.63 s) and the third is not, even after a reload. Waiting does not help; the game needs a reload prompt.
- **Startup**: the 3 s cold bar on Fast 4G breaks between 2.1 and 2.5 MB of first chunk (about 0.6 s + 1.0 s per MB). Without BC textures the RGBA8 fallback takes 8.8 s cold.
- **Catch-up**: cost depends on events, not age (100 game years costs the same as a week); inline catch-up passes a 33 ms step somewhere between 100,000 and 1,000,000 events per chunk.
- **Saves**: one buffer per stored chunk costs the sim 3.47 ms median (fails 1 ms); 64 transferred slabs cost 0.14 ms, but the sim cannot touch them for about 0.6 ms (1.0 ms p99) while the save worker holds them; one 3.2 MB buffer copied by `postMessage` costs 0.56 ms median / 0.73 ms p99 and has no hold window.

## Ruled-out options

| Option | Result | Decision |
|---|---|---|
| TypeScript sim | Lost at the median (WASM 1.2–2.0× faster) but tied at the 99th percentile at 10,000 entities (4.63 against 4.74 ms) and showed no GC spikes | Rust kept; the margin is smaller than the doc claimed |
| WASM SIMD off | No measured difference either way (±10–24%, single runs, inside noise; no-SIMD faster in some rows, for example median 0.40 against 0.50 ms at 1,000 entities) | SIMD kept, but it is not shown to be worth it for this sim |
| Sim on the main thread | Same step time; equally smooth at 2,000 entities | Worker kept; its hand-off costs 0.06–0.1 ms median |
| Snapshot design B (newest only, no queue) | Lost: 7.8 pauses and 26.6 jumps per minute at 60 fps with no added delay | Design A kept |
| Plain instancing with CPU culling | Lost on CPU by 3.5–6×, but only 0.2–0.4 ms per frame (0.8–1.2 ms throttled); same GPU time. An upper bound: the plain path culls all 15,913 statics on the CPU every frame, where a real one would cull them per chunk | GPU-driven kept; revisit on the reference device |
| Three.js WebGPURenderer | Lost: main-thread CPU 3.4–7.8× higher, growing with entity count (0.56 against 0.15 ms at 2,000 entities; 1.71 against 0.22 ms at 20,000; 4.26 against 0.63 ms at 10,000 throttled). An upper bound: Three.js interpolates on the CPU; a GPU-side material was not built | Own renderer kept |
| Pre-gzipped `.wasm` | No gain: Pages gzips `application/wasm` (observed on other `github.io` sites, not ours) | Ship the plain `.wasm`; keep the gzipped path as a fallback |
| Generation numbers for catch-up jobs | Redundant once results are only accepted if newer than the chunk's state (0 mismatches in 3 million operations with the check off) | Either rule may be dropped; both left in the prototype |

## Stage 7 review of these results

P1 (a result is missing):

1. **Nothing was pushed or deployed.** `git push` returns 403 for the account on the dev machine (read-only on `pomodorozhong/vessel`; the GitHub API reports `push: false`). The API reported no Pages site when the run started and reports one at the end (`has_pages: true`), but nothing of this branch is on it. So Stage 0's "loads from GitHub Pages" and every real-Pages check in Stage 5 (our own file types' headers, real CDN behaviour during a deploy) are missing. The PR is opened from a fork instead (see "Blocked").
2. **Stage 4's pass bar cannot be judged**: macOS (Chrome, Edge, Safari), Firefox, sleep/wake and gamepads were not run.

P2 (weaker than it should be; the verdict would likely stand):

- One run per configuration in Stages 1 to 3. Stage 1 ran while the Stage 5 and 6 builds used the same machine.
- CPU throttling does not reach workers, so throttled sim numbers come from the main thread, and throttled Stage 3 rows have an unthrottled sim.
- Stage 2: allocations were not zero in the heap sample (main 111 KB/s, worker 31 KB/s) and the harness's share could not be separated; input delay stops at frame submit; pool 4 and 5 were not tested with stalls or at 30 fps.
- Stage 3: the Three.js scene has no vertex animation texture, upscale pass or UI pass, interpolates moving entities on the CPU (a custom GPU-side material was not built) and draws its statics without culling. GPU times on this machine are noisy and not monotonic in entity count.
- Stage 4: the crash test is a handful of runs (per retry length: one per browser at a 20 s gap and one in Chrome at 150 s; five first-crash recoveries with the 5 s retry, three with the 60 s retry), so where the browser's limit on repeated crashes lies is only roughly known.
- Stage 5: timings are against an emulator with procedural assets; startup runs are 5 repeats, not 5-minute runs (they are one-shot measurements, like Stage 6's jobs).
- Stage 6: a week of replay was timed 20 times, not 200; `persist()` was only tried in fresh automation profiles; the save format holds at most 8 pending events per stored chunk while catch-up was measured with up to 1,000, so the 3.6 MB save size and save timings assume at most 8.
- Found and fixed during the review: the first Stage 4 crash test crashed nothing (`chrome://gpucrash` is ignored under automation) and was redone with `Browser.crashGpuProcess`; four Stage 2 rows (30 fps at lag 2.5 and 3, pool 4 and 5) were missing and were run.

## Changes made to `tech-direction.md`, each from a result

- Threads and workers: the measured snapshot design, lag (2 steps), queue (3) and pool (6), and that the input delay stops at frame submit and is at the ~100 ms bar at 30 fps (Stage 2).
- Ruled out: measured numbers for Three.js (Stage 3) and the TypeScript sim (Stage 1); the SIMD claim in the stack table is reduced to what was measured, no difference either way (Stage 1).
- Rendering: measured CPU cost and draw count, and that the plain path's gap is small and an upper bound, since the prototype's plain path culls every static instance each frame (Stage 3).
- WebGPU trade-off: after repeated crashes a lost device does not come back however long the game retries, at first until a reload and then not even after one, so the game offers a reload (Stage 4).
- Asset pipeline and hosting: on other `github.io` sites (not ours) Pages gzipped `application/wasm` and `application/octet-stream` (the latter only seen for a text-like `.ftl` file); the meshopt decoder is about 29 KB raw, not a few KB, and the whole stage 5 page chunk including it and the loader is 39.0 KB, 12.75 KB gzipped; measured meshopt and RDO gains; first-chunk size limit (Stage 5).
- Chunks and saves: the two catch-up rules the property test forced, the save layout rule (not one buffer per chunk; 64 transferred slabs with their hold window, or one copied buffer), and that `persist()` was refused (Stage 6).
- Hosting: the deploy keeps the previous build's files and stops rather than publish without them (Stage 5).
- Prototype first: a pointer to this report and a note that all quoted numbers are dev-machine numbers.

The core decisions (raw WebGPU, Rust/WASM sim in a worker, GitHub Pages, owning the runtime) are unchanged: no result showed one failing.

## Reference-device and other runs still needed

1. Stage 1: 2,000 entities, 5 minutes, p99 under 4 ms (`stage-1.md`). This is the result most likely to change the direction.
2. Stage 3: GPU time at 1080p on integrated graphics, and GPU-driven against plain there (`stage-3.md`).
3. Stage 2: the four pass rows, plus a gamepad (`stage-2.md`).
4. Stage 4: macOS Chrome, Edge and Safari; Firefox; sleep/wake; gamepads in each browser (`stage-4.md`).
5. Stage 5 on real Pages after a push with write access and a deploy run by hand from the Actions tab: headers of our file types, cold and warm first frame, a deploy with a tab open (`stage-5.md`); Stage 0's page in each browser (`stage-0.md`).
6. Stage 6: storage eviction, real-profile `persist()`, Safari's 7-day rule, a Dock web app, Firefox (`stage-6.md`).

## Blocked

- `git push -u origin prototype/run-1` fails with 403: the signed-in account (`skymiku39`) has read access only. With the owner's agreement the branch was then pushed to a fork (`skymiku39/vessel`) and the PR to `main` is opened from there.
- There is still no Pages deploy of this branch: the workflow (`.github/workflows/deploy.yml`) runs only by hand (`workflow_dispatch`), so neither a push nor merging the PR publishes the throwaway prototype as the live site, and it has never run in the repository itself. To finish: push the branch to `pomodorozhong/vessel` with an account that can write (or merge the PR), check that Pages uses "GitHub Actions" as its source and that the `github-pages` environment allows the branch, run "Deploy prototype to GitHub Pages" by hand from the Actions tab on that branch, and run the Pages steps above.

## Changes after the first review

- Stage 2's verdict is provisional, not held: input delay stops at frame submit and is at the ~100 ms bar at 30 fps, gamepad is unmeasured, zero allocation is not shown, and the reference device was not run (`stage-2.md`, verdict table, `tech-direction.md`).
- SIMD: "free" replaced by "no measured difference either way" (single runs, inside noise) in the stack table and the ruled-out table.
- Pages gzip: the observed types are from other `github.io` sites, not ours, and the `application/octet-stream` case was a text-like `.ftl` file.
- Plain instancing: the 3.5–6× CPU gap is an upper bound, because the plain path culls all 15,913 statics every frame (`stage-3.md`, this report, `tech-direction.md`).
- meshopt decoder: 29 KB raw, and the whole stage 5 page chunk including it is 12.75 KB gzipped.
- Saves: one 3.2 MB buffer copied by `postMessage` (0.56 ms median, 0.73 ms p99) is named as a second layout that meets the bar, and the slabs' hold window (about 0.6 ms, 1.0 ms p99) is stated.
- Saves: the save format holds at most 8 pending events per stored chunk while catch-up was measured with up to 1,000, so the save size and timings assume at most 8 (`stage-6.md`).
- Deploy: `stage5-keep-previous.mjs` now fails the deploy when the live manifest cannot be read for any reason other than a 404, or a previous file cannot be downloaded (`--allow-missing` to override); the new exits were checked by hand, the emulator scenarios were not rerun.
- Deploy workflow: runs only by hand from the Actions tab (`workflow_dispatch`), so merging does not publish the prototype; it installs the pinned Rust toolchain and caches Rust builds.
- The sim's WASM import now names its module (`#[link(wasm_import_module = "env")]`), because the build failed to link on Rust 1.99.1 (`rust-lld: undefined symbol: now`, reported by the reviewer; not reproduced here, where Rust 1.94.1 is installed), and the toolchain is pinned to 1.94.1 in `prototype/rust-toolchain.toml`.
- Three.js comparison rerun with static instances uploaded once (the first version re-uploaded about 1 MB of static matrices every frame): the gap is 3.4–7.8×, not 7–9×, and is stated as an upper bound (`stage-3.md`, this report, `tech-direction.md`). The first version's data is kept as `threecull-*`.
- Device recovery rerun with a 60 s retry instead of 5 s: the outcome is the same (second crash within 20 s not recovered until a reload, third within 5 minutes not even then), so the doc's "until the page is reloaded" now rests on 60 s of retrying (`stage-4.md`, `tech-direction.md`).

## Assumptions made where the plan was silent

- Scene: top-down (the plan's default). One seed, 256×256 grid, 16 enemy kinds, enemies converging on a scripted player.
- "Dev machine, throttled" is Chrome's 4× CPU throttling; it is a stand-in, not a model of the reference device. Throttled sim numbers run the sim on the main thread, since Chrome will not throttle workers.
- The local preview server sends COOP and COEP only to get 5 µs timer resolution; the prototype uses no `SharedArrayBuffer`.
- "Rebuilt incrementally" (flow field) means time-sliced: 16,384 cells per step.
- A pause is a frame whose on-screen sim time advanced by less than 0.25× the frame time; a jump is more than 1.75×. "Visible" was judged by these counters, not by eye.
- Key presses were sent through Chrome's input pipeline by automation; input delay ends at frame submit.
- Stage 3's dense start (`spawn=40`), its 20 kinds and its three layers are my choice of "realistic content"; assets in Stages 3 and 5 are procedural.
- GPU process crashes were triggered with the DevTools protocol; `navigator.gpu` missing was simulated by hiding the property.
- Stage 5 measured against a local emulator built from headers observed on other public `github.io` sites; "Fast 4G" is Chrome's preset (9 Mbit/s down, 165 ms latency).
- Stage 6: chunks of 64 plots and 8 furnaces, a 4,096-chunk world, player speed 5 units/s, 32-unit chunks, jobs started 2 chunks out (the 12.8 s window).
- The 5-minute rule was applied to steady-speed runs (Stages 1 to 3); one-shot measurements (startup, catch-up jobs, saves, crash recovery) were repeated instead.
- Stages 5 and 6 ran as subagents in worktrees and were merged; Stages 1 to 4 ran one at a time in the main checkout. Stage 1 overlapped with the subagents' builds (see P2); Stages 2 to 4 ran with nothing else measuring.
- Dependencies added without asking, because the task said not to stop: dev tools `puppeteer-core`, `@webgpu/types`, `three` and `@types/three` (comparison only); runtime `wgpu-matrix` and `meshoptimizer` (both named in the tech direction); and the Rust crate `mipple` 0.9.102 as a build-time BC7 RDO encoder, which should be reviewed before the real pipeline adopts it (it only compiled unoptimized in reasonable time).
