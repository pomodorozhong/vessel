# Stage 11: does everything fit at once?

Hypothesis: the sim, the snapshot hand-off, the renderer and the audio together keep the game smooth at 60 fps through a worst-case combat wave on the reference device, with every system inside its budget at the same time.

Verdict: **provisional pass for the main thread, the GPU and the audio; provisional fail for the sim, by estimate** (it was not run at the 4× slowdown Stage 8 is judged on; see below). No reference device was available. Every number below is from the dev machine (RTX 3060, Chrome 156), with the page under Chrome's 4× CPU throttling, the run's stand-in for the reference device. In all three five-minute waves up to 5,000 enemies, at the same time:
- **No pauses or jumps** from the Stage 2 render clock, and 3–5 frames over 20 ms out of 18,000.
- **No audio glitches**: 0 late renders and 0 underruns with mixer B.
- **Sim step** p99 1.54 ms [1.36–1.60], under 4 ms. But Chrome cannot throttle workers, so the sim ran at the dev machine's full speed (see below).
- **CPU encoding** p99 1.42 ms [1.38–1.42], under 2 ms.
- **The frame's work**: main thread p99 2.00 ms and GPU p99 6.16 ms, together inside 60% of 16.7 ms (10 ms). The GPU half was measured on the RTX 3060 and holds only for it, as in Stage 9.
- **Input to frame submit**: median 9.3 ms, p99 17.5 ms.

Why the sim half is a provisional fail (first called unclear in the Stage 12 review, see "Stage 12 rerun" below; changed in the PR review):
- Found in the PR review: `simslow=2` understates the slowdown. It came from Stage 8's p99s (5.11 against 2.27–2.62 ms), and the worker's p99 carries the timing tail described below. Stage 8's medians give the real ratio: 2.61–2.81 ms throttled against 0.625–0.710 ms in the worker, about 4×, the same factor as the throttling. At 4×, this wave's sim p99 of 1.52–1.75 ms at 5,000 enemies becomes about 6–7 ms, and even its median at the hold (0.95–0.97 ms in Node, about 1.2× that in the browser) becomes about 4.6 ms. Both are over the 4 ms bar. This is an estimate from scaling; no run used `simslow=4`.
- Chrome cannot throttle the sim worker, so the sim ran at the dev machine's full speed in every run.
- The sim's p99 here was 1.5–1.7 ms at 5,000 enemies, against 3.70 ms in Stage 8's push-past run (both in an unthrottled worker on the dev machine). This was first read as the wave loading the sim about half as much as Stage 8. Spawning the wave's enemies around the player, as Stage 8 does, raised the event rate by a quarter but the step time barely.
- Found in the PR review: the per-step work is the same. Stepping the same `combat.wasm` in Node with each driver's init arguments and script (`scripts/run2/stage8-node.mjs`, `data/stage8-node/`), Stage 8's 5,000-enemy load and this wave's 60 s hold at 5,000 cost the same: p99 1.42 ms against 1.57 ms (cap 20,000) and 1.52 ms (cap 5,000). What differs is a tail in Stage 8's browser-worker run, whose median is near Node's but whose p99 is not. Its cause is not proven (see "Findings for Stage 12").
- Stage 8 already failed provisionally at 2,000 enemies with its sim throttled. Until the reference device runs this wave, that is the better guide to the sim's budget.
- Every run here, the Stage 12 rerun included, started its wave from 300 enemies in one thin band about 62 units from the player, not spread around it (found in the PR review after these runs; fixed in the sim, not rerun; see "Findings for Stage 12").

Two limits on the verdict matter more than the pass:
- **The sim is the budget that breaks first, and its numbers here are optimistic.** Ramping past the bar, the sim step p99 first crossed 4 ms at about 11,900 enemies and stayed over it from about 13,400. That was at the dev machine's full speed. At 5,000 enemies its p99 is 1.5–1.6 ms here. If the step time scaled with a CPU four times slower, it would be about 6 ms, over the bar. So the reference-device rerun decides this stage, and the sim is the system to watch.
- **The wave carried about half of Stage 8's event rate.** The sim produced a mean 293 events per step (about 8,800 a second) at 5,000 enemies, against Stage 8's 16,400 a second at its pass load. The scripted player and the projectile target (0.2 per enemy) set it. Stage 10 measured the mixer at about 15,400 events a second and up to 4× that, so the audio side is covered, but the renderer's effects ran at about half the density of Stage 9's worst case.

Fallback: **not applied**. If the reference-device run fails, the first system over its budget applies its own stage's fallback. Going by this run, that is the sim (Stage 8: fewer passes, a lower enemy cap, or a cheaper pair finding at the peak). The other way out for the sim is a host that sends COOP and COEP, so its per-chunk jobs can run on several threads; `docs/tech-direction.md` ("Hosting on GitHub Pages") names an over-budget sim thread as the trigger for that move.

## What was built

All of it is in `src/stage11/` and `stage11.html`, putting together the parts the earlier stages built and measured on their own:
- **The sim** (`sim-worker.ts`): Stage 8's combat sim (`combat.wasm`, pair finding A, 3 passes) in a worker at 30 Hz. The scheduler runs up to 4 steps back to back after a late wake-up, instead of Stage 8's one step per wake, which fell behind under load. It drops the lost time and counts it only when more than 8 steps behind. The wave script sets the live enemy count each step: 300 to 5,000 over 240 s, then held. The projectile target is 0.2 per enemy (1,000 at the peak).
- **The hand-off**: each step's snapshot is copied out of WASM memory into a pooled `ArrayBuffer` and transferred to the main thread. The buildings follow in a separate message only when walls change (about every 2 s). The main thread runs Stage 2's render clock (design A, run 1's choice, 2 steps of lag).
- **The renderer**: Stage 9's renderer with the full look at 1080p (hull outlines, 2,048² shadow map, grass, fog, bloom), with up to 10,000 particles. Snapshot entities, projectiles and events go to it each frame.
- **The sound**: Stage 10's director and mixer B (the AudioWorklet mixer). It fires the snapshot's events from the render clock and plays the player's own sounds straight from the key press.
- **The one rebuild path**: a lost device rebuilds the GPU device, the pass timer and the whole renderer (shadow map, grass, outline pass, bloom targets) in one function, which is also the start-up path. The sim and the audio do not depend on the GPU and keep running.
- **The recording** (`rec11.ts`, `harness11.ts`): per-frame timings into preallocated arrays, 5 s windows for the ramp, the JS heap once a second, and Stage 10's glitch detector.

## How it was measured

- **Where**: the dev machine (Windows 11, RTX 3060, Chrome 156.0.8078.73 headed, the real default audio device), 1920×1080 canvas, Chrome's CPU throttling at 4×. Nothing else ran on the machine.
- **Throttling reaches the page only.** `Emulation.setCPUThrottlingRate` is refused for workers and does not reach the audio thread. So the sim worker and B's worklet ran at full speed, and only the main-thread numbers stand in for the reference device.
- **Input**: real key presses through the browser's input pipeline about twice a second (Space = shoot, F = dash), as in Stage 10.
- **Runs** (`scripts/run2/stage11.mjs`), each 300 s after a 5 s warm-up, one browser each:
  - the wave × 3 at 4×;
  - the wave unthrottled (`wave-cpu1`);
  - the wave with a GPU process crash 150 s in (`Browser.crashGpuProcess`);
  - the wave with 60 s of allocation sampling at the peak (`heap`, V8's sampling heap profiler);
  - the ramp past the bar (`past`): 5,000 by 120 s, then 3,000 more enemies a minute, to about 13,900 at 300 s.
- The `heap` run's own timings are not used for the pass bars: the profiler caused its 60 pauses and 10 jumps and raised its encode p99 to 2.84 ms.
- A cell with three repetitions shows the median, with min–max in brackets. The data is in `data/stage11/`, the full tables in `data/stage11-tables.md`, the log in `data/stage11.log`.
- **Two measurement bugs were found and fixed in the smoke runs before the full run**:
  - The render clock was still counted while the page waited for the worker's summary after the bench, which logged 39 false pauses.
  - The input timestamp carried over from the warm-up, which logged one 5 s input latency.

## Results

### Pass bars

| Run | Frame p99 (ms) | Frames >20 ms | Pauses | Jumps | Sim step p99 | Encode p99 | Main thread p99 | GPU p99 | Audio late | Underruns | Input to submit median / p99 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Wave, 4× (3 reps) | 17.25 | 5 [3–5] | 0 | 0 | **1.54** [1.36–1.60] | **1.42** [1.38–1.42] | 2.00 [1.91–2.03] | 6.16 [6.11–6.20] | 0 | 0 | 9.3 / 17.5 |
| Wave, unthrottled | 17.02 | 3 | 0 | 0 | 2.41 | 0.44 | 0.71 | 6.48 | 0 | 0 | 8.9 / 16.7 |
| Wave with GPU crash, 4× | 17.25 | 7 | 0 | 1 | 1.32 | 1.41 | 2.02 | 5.83 | 0 | 0 | 9.6 / 17.8 |
| Past the bar, 4× | 17.25 | 5 | 0 | 0 | 3.32 | 1.43 | 2.27 | 6.07 | 0 | 0 | 9.4 / 17.5 |

- Frame p99 is the `requestAnimationFrame` interval, which sits at the 60 Hz display's 16.7 ms. The frame's own work is the main thread plus the GPU.
- Sim step median was 0.75 ms [0.71–0.77] over the whole wave. The unthrottled run's higher sim p99 (2.41 ms) came from a few windows at the peak. The worker is not throttled in either run, so the difference is scheduling noise on the dev machine, not a throttling effect.
- Input to submit runs from the key event's timestamp to the end of the next frame's `queue.submit`.

### Main thread per frame (median / p99, ms)

| Run | Total | Snapshot upload | Encode | Audio | UI | Other | Snapshot receive (between frames) |
|---|---|---|---|---|---|---|---|
| Wave, 4× | 0.99 / 2.00 | 0.02 / 0.58 | 0.62 / 1.42 | 0.02 / 0.36 | 0.00 / 0.36 | 0.06 / 0.43 | 0.00 / 0.17 |
| Wave, unthrottled | 0.25 / 0.71 | 0.02 / 0.18 | 0.17 / 0.44 | 0.01 / 0.09 | 0.00 / 0.11 | 0.03 / 0.13 | 0.00 / 0.02 |
| Past the bar, 4× | 1.02 / 2.27 | 0.02 / 0.84 | 0.63 / 1.43 | 0.02 / 0.38 | 0.00 / 0.36 | 0.04 / 0.44 | 0.00 / 0.17 |

Encoding is most of the main thread's time. Audio stays at Stage 10's numbers (p99 0.36 ms, under its 0.5 ms bar). The p99s do not add up to the total's p99, because they fall on different frames.

### Snapshot hand-off and sim scheduling

| Run | Snapshot KB mean / max | Copy p99 (ms) | postMessage p99 (ms) | Transit median / p99 (ms) | Wake late p99 (ms) | Catch-up steps | Dropped steps | Events per step |
|---|---|---|---|---|---|---|---|---|
| Wave, 4× | 117 / 197 | 0.035 | 0.070 | 0.64 / 13.1 | 6.0 [5.8–14.3] | 0 | 0 | 293 |
| Past the bar, 4× | 255 / 534 | 0.075 | 0.065 | 0.19 / 3.7 | 5.9 | 0 | 0 | 770 |

- The snapshot grew from run 1's few KB to 117 KB mean at 5,000 enemies and 534 KB at 13,900. Copying it out of WASM memory and transferring it still costs under 0.1 ms in the worker.
- Transit is from the worker's send to the main thread's `onmessage`. Its p99 of about 13 ms at 4× is the throttled main thread being busy when the message arrives, not the transfer. The render clock's 2 steps of lag absorb it: no pauses.
- The scheduler never needed to catch up or drop a step. Steps started up to 14 ms after they were due at the p99 in some runs, which matches Windows' default timer resolution of about 15.6 ms for `setTimeout`. That is under one 33 ms step, so the scheduler did not need to catch up, and the render clock's lag absorbed it.

### Which budget breaks first

The ramp past the bar (`past`, 5 s windows, p99 per window; full table in `data/stage11-tables.md`):

| t (s) | Enemies | Projectiles | Events/step | Sim p99 | Encode p99 | Main thread p99 | GPU p99 |
|---|---|---|---|---|---|---|---|
| 60 | 2,748 | 550 | 238 | 1.08 | 1.21 | 1.51 | 6.25 |
| 120 | 5,125 | 1,025 | 1,284 | 1.32 | 1.40 | 2.22 | 6.18 |
| 180 | 8,127 | 1,625 | 726 | 2.23 | 1.42 | 2.34 | 5.00 |
| 230 | 10,625 | 2,125 | 841 | 3.49 | 1.63 | 2.23 | 6.29 |
| 255 | 11,875 | 2,375 | 1,693 | **4.01** | 1.65 | 3.08 | 6.03 |
| 285 | 13,375 | 2,675 | 1,423 | **4.44** | 1.62 | 3.04 | 6.22 |
| 295 | 13,875 | 2,775 | 1,962 | 3.77 | 1.36 | 2.42 | 6.22 |

- **The sim breaks first**: its p99 grows about with the enemy count (0.7 ms at 1,000, 1.6 ms at 5,000, 3.5–4.4 ms at 11,000–13,900) and crossed 4 ms at 11,875 enemies.
- Encoding stays flat at 1.2–1.8 ms because the renderer culls to what is on screen. It crossed 2 ms in single windows (2.05 ms at 80 s here, and once in the first window of one wave run), but never in two windows in a row. That is noise at the edge of the bar, not a trend.
- GPU time stays at 5–7 ms p99 on the RTX 3060 at every count, for the same reason.
- Audio had no late renders at any count, and frames had no pauses or jumps.

### GPU process crash

- Chrome's GPU process was crashed 150 s into the wave, at 3,241 enemies. The device was lost ("A valid external Instance reference no longer exists.").
- The look was back **621 ms later on the first attempt, in one rebuild** (the counter shows 2, including the start). After the crash the renderer reported the full look again: the 2,048² shadow map and 45 grass chunks at 1080p, built from the same options as at start-up (hull outlines, bloom). No screenshot was taken after the crash.
- During the outage, 20 snapshots arrived and the sim kept stepping. 20 s later it was at 3,630 enemies and 597 more snapshots.
- Audio had 0 late renders before and after. The render clock logged one jump for the 621 ms without frames, as expected.

### Memory

| Run | JS heap first minute (MB) | Last minute (MB) | Max (MB) | Slope (MB/min) | WASM memory (MB) |
|---|---|---|---|---|---|
| Wave, 4× | 35.9 | 38.0 [38.0–38.2] | 41.2 | 0.52 [0.51–0.57] | 8.3 |
| Past the bar, 4× | 36.0 | 41.0 | 47.5 | 1.22 | 8.3 |

- The heap grows by about 2 MB over the wave while the enemy count grows 17×, and 5 MB past the bar. The first- and last-minute values are medians, so the GC sawtooth does not move them.
- The wave holds its peak only for the last 60 s, so this run cannot tell growth from the load from a slow leak. A longer run at a fixed count is listed for the next run.
- WASM memory stayed at 8.3 MB: the sim allocates everything at start-up for the cap.

### Allocations in the game loop (`heap` run, 60 s at the peak)

| Target | Game (B/s) | Top allocators |
|---|---|---|
| Main thread | 3,116,713 | Stage 9 renderer `render()` 151.8 MB (2.5 MB/s); director `decode` 11.6 MB; renderer `setSnapshot` 5.4 MB |
| Sim worker | 34,050 | small: the scheduler and the message handler |

- **The renderer allocates about 2.5 MB a second at 5,000 enemies**, from `render()`: per-frame arrays, `filter` over the live explosions and particles, and small objects for the frame's draw lists. In the 30 s smoke run at about 900 enemies it was 1.36 MB/s, so it grows with the load.
- It has not caused visible pauses yet: 3–5 frames over 20 ms in 18,000, and no render-clock pauses. But at this rate V8's young-generation collections run every second or two, and each one is a frame-time risk on a slower device.
- The director's `decode` (0.2 MB/s) is the event list built per snapshot.
- Typed-array backing stores and GPU objects are not visible to the sampling profiler.

## Stage 12 rerun: a denser wave, a slower sim, and the fixes

The Stage 12 review found that the wave added its enemies at the map edge (the sim's respawn rule), not in Stage 8's square of ±64 units around the player. Stage 12 changed that (`set_active` in `combat/src/shared.rs` now places new enemies like Stage 8's start; deaths still respawn at the edge in both). It added `simslow`, which makes the sim worker busy-wait (simslow − 1) × each step's time, as a stand-in for a slower CPU. Stage 8 measured its sim about 2× slower throttled on the main thread than unthrottled in a worker (p99 5.11 against 2.27–2.62 ms), so `simslow=2` was run. (Found in the PR review: that ratio compares p99s, and the worker's p99 carries a timing tail. Stage 8's medians give about 4×; see the verdict at the top.) The build also had the Stage 12 fixes: the event-sound lead, the 64 nearest explosions and the dynamic-resolution hysteresis.

Data: `data/stage11-dense/` and `data/stage11-dense-slow2/`, tables in `data/stage11-dense-tables.md` and `data/stage11-dense-slow2-tables.md`, log `data/stage11-dense.log`. Same machine and settings as above.

| Run | Frames >20 ms | Pauses / jumps | Sim step p99 (worker) | Encode p99 | Main thread p99 | GPU p99 | Audio late | Events per step | Heap first → last minute (MB) |
|---|---|---|---|---|---|---|---|---|---|
| Dense wave, 4× (3 reps) | 10 [4–16] | 0 / 0 | 1.66 [1.52–1.75] | 1.44 [1.41–1.67] | 2.04 [2.01–2.40] | 6.23 [6.18–6.42] | 0 | 371 | 34.2 → 34.2 |
| Dense past the bar, 4× | 9 | 0 / 0 | 3.71 | 1.64 | 2.61 | 5.83 | 0 | 579 | 35.1 → 35.1 |
| Dense wave, 4×, simslow=2 | 2 | 0 / 0 | **3.03** | 1.38 | 1.86 | 6.30 | 0 | 371 | 35.2 → 35.1 |
| Dense past the bar, 4×, simslow=2 | 7 | 0 / 0 | **6.10** | 1.29 | 2.00 | 6.52 | 0 | 579 | 35.2 → 34.9 |

- Every pass bar held again, including at simslow=2: the sim's p99 with the stand-in slowdown was 3.03 ms at 5,000 enemies, under 4 ms. But simslow=2 understates the slowdown (about 4× by Stage 8's medians), so this does not show that the sim fits. Past the bar, the per-window step time (measured inside WASM, without the busy-wait) passed 2 ms between about 6,900 and 8,900 enemies, so at simslow=2 the sim crosses 4 ms there. The ramp's "first break" column uses the WASM step time, so it does not show the slowdown.
- The denser spawn raised events per step from 293 to 371 at the peak, not to Stage 8's level, and the sim's p99 from 1.54 to 1.66 ms. Why Stage 8's sim cost about twice as much at the same counts is open (see the findings). Later found: in Node the per-step work is the same, and the gap is in the tail of Stage 8's browser-worker timing.
- **The heap no longer grows**: −0.05 MB/min over the wave, against +0.52 before. The first run's growth most likely came from the renderer's explosion list, which the Stage 12 fix replaced with a fixed ring. Allocations were not sampled again.
- More frames went over 20 ms (4–16 against 3–5 per 18,000). They are single frames with no render-clock pause or jump.
- Event sounds now fire early by the output pipeline delay, as Stage 10's `lead=-1`. Stage 11 does not measure the event-to-picture offset, so Stage 10's 9 ms median is the number for it.

## Findings for Stage 12

- **P1 (raised from P2 in the PR review): the sim is the first budget to break, and the dev machine could not slow it down.** Its p99 is 1.5–1.7 ms at 5,000 enemies at full speed and 3.03 ms with simslow=2, but simslow=2 understates the slowdown: at the 4× that Stage 8's medians give, the estimate is about 6–7 ms. The reference-device rerun is the only real test. If it confirms the miss, either Stage 8's fallback applies or the sim moves to several threads on a host that allows them.
- **P2: the wave's sim p99 is about half of Stage 8's at the same enemy count, but the sim's work is not.** Measured in the browser: p99 1.66 against 3.70 ms at 5,000 enemies, unthrottled worker, dev machine, even with Stage 8's spawn. This was first read as the wave loading the sim about half as much. A Node run of the built `combat.wasm` (PR review; `scripts/run2/stage8-node.mjs`, data in `data/stage8-node/`) shows the per-step work is the same:

  | Where | Load | Step median (ms) | p95 | p99 |
  |---|---|---|---|---|
  | Node, full speed | Stage 8 style: 5,000 enemies placed at init, 1,000 projectiles, A, 5–65 s | 0.91 (0.91–0.93) | 1.10 (1.06–1.13) | 1.42 (1.36–1.47) |
  | Node, full speed | this wave, cap 20,000, the 60 s hold at 5,000 | 0.97 (0.96–0.97) | 1.24 (1.16–1.28) | 1.57 (1.40–1.70) |
  | Node, full speed | this wave, cap 5,000, the 60 s hold at 5,000 | 0.95 (0.94–1.00) | 1.17 (1.10–1.33) | 1.52 (1.43–1.60) |
  | Node, full speed | this wave, cap 20,000, the whole 300 s | 0.61 (0.61–0.63) | 1.04 (1.04–1.06) | 1.38 (1.29–1.42) |
  | Node, paced to 30 Hz | Stage 8 style, as the first row (3 runs) | 1.68 (1.52–1.88) | 3.82 (3.53–3.92) | 4.57 (4.37–4.66) |
  | dev machine, Chrome worker | Stage 8 `push-A-e5000-p1000-cpu1x-60s-worker-r1` | 1.08 | 2.82 | 3.70 |
  | dev machine, Chrome worker | this wave, whole 300 s (3 reps, first run) | 0.75 (0.71–0.77) | – | 1.54 (1.36–1.60) |

  The Node rows are median (min–max) over 5 runs each, at commit `9669f12`, Node 22.19.0, on a 13th Gen Intel Core i7-13700 with 64 GB (the dev machine's CPU model; not confirmed to be the same machine). Steps ran back to back, without 30 Hz pacing. The sim changed after the browser runs (`e4924dd` changed how the live count shrinks at the wave's start), so the Node rows compare the cases with each other, not with the browser rows one to one. At 2,000 enemies and 1,000 projectiles (300 s), Node's p99 was 0.89–0.92 ms for A, B and C, while every Stage 8 browser-worker run there was 2.09–2.82 ms.
  - So the two loads cost the same, and the wave's allocation for 20,000 changes little. In the browser, both medians are about 1.2× Node's (1.08 against 0.91, 0.75 against 0.61). The p99s are not: Stage 11's is about 1.1× Node's, Stage 8's about 2.6×. The gap is a tail in Stage 8's browser-worker timing that neither Node nor Stage 11's in-browser windows show.
  - The cause is not proven. A likely one: Stage 8's worker does about 1 ms of work every 33 ms on an otherwise idle page, so Windows parks it on efficiency cores or at low clock speeds, while Stage 11's busy page (rendering, audio) keeps the cores up. One check points that way: paced to 30 Hz with a sleep between steps, the same Node run showed a tail like the browser's and a higher median (the "paced" row above). It does not show which part (core parking, clock speed, timer wake-up) causes it.
  - Stage 11's sim verdict is a provisional fail by estimate (see the verdict at the top); the reference device decides it. Stage 8's provisional fail comes from its throttled main-thread runs, whose p99 is 1.6–2.0× their median, close to Node's ratio, so it looks like cost under the 4× stand-in and is still the better guide to the sim on a slow CPU. A miss on the device, where the sim runs in a worker, may be jitter instead (`stage-8.md`).
- **Fixed in Stage 12: the wave added enemies at the map edge**, not around the player as Stage 8 does (rerun above).
- **P1, found in the PR review, fixed in the sim but not rerun: the wave's first 300 enemies started in one thin band.** The worker allocates the sim for `cap` (20,000) enemies and then sets the live count to the wave's start. Pair finding A sorts the table by grid cell at init, and shrinking the live count kept the first 300 slots: the lowest rows of the ±64 spawn square, y of about 64 to 67, 62 units south of the player. So every run above, the Stage 12 rerun included, began with a line of enemies pulled in by the flow field. Enemies added later were placed as described (at the edge in the first run, around the player in the rerun). Those 300 are 6% of the crowd at 5,000, so the peak numbers should move little, but the early-ramp windows measured a different scene, and the band was first thought to be part of why the wave's sim p99 was lower than Stage 8's (the Node run above, made with the fix, has since shown the per-step work at the hold is the same). With method B, which never reorders the table, the same URL started spread out, so A and B did not start from the same scene. `set_active` now keeps the player and a random sample of the enemies where they are (test `shrink_keeps_a_spread_sample` in `combat/src/lib.rs`). Rerun the three waves and `past` before quoting the early-ramp windows, or the sim's load against Stage 8.
- **P1, found in the PR review, fixed in the director but not rerun: the audio numbers were measured with a heavier mix of big sounds than the current code plays.** Every run in this file (both builds predate `d85615d`) used a director that treated any hit or death with `kind >= 4` as a large enemy. The sim numbers its enemy kinds 0–15, with only 7 and 15 large (`is_large` in `combat/src/shared.rs`), and gives a hit on a wall or building kind 255. So hits and deaths on 12 of the 16 kinds, and every wall hit, played `hit_b` or `death_b`. Those are priority 2 on the big bus and duck the music and small-effects buses. `d85615d` fixed it (see `git show d85615d`). After the runs, `43171bb` also made every step with player shots play one `shoot` voice (priority 3), up to 30 a second, which these runs did not have.
  - What this touches: the voice counts in `data/stage11/`, `data/stage11-dense/` and `data/stage11-dense-slow2/` (voices per frame: median 20, p99 30–32 in the waves, 26 and 34 past the bar; voices started: 97–104 a second in the waves, 122–135 past the bar; voices dropped by the limit: 0.2–1.7 a second), and the audio share of the main thread (0.02 / 0.36 ms median / p99). Stage 11 reports no loudness figures.
  - What it most likely does not touch: 0 late renders and 0 underruns with mixer B. Stage 10 ran B at its 40-voice limit nearly all the time without a late render, so a different mix of sounds is unlikely to change that.
  - Rerun the three waves at the current commit (listed below).
- **P2: the renderer allocates about 2.5 MB/s in `render()` at the peak** (first run). Move the per-frame arrays and lists to preallocated typed arrays. Stage 12's explosion fix (a fixed ring and a fixed-size nearest set) removes the explosion part of it, and the heap stopped growing, but allocations were not sampled again.
- **P2: the director's event decode allocates per snapshot** (0.2 MB/s). Decode into a reused buffer.
- **P2: memory over a longer hold.** The heap was flat after the Stage 12 fix, but only for 5 minutes. A 30-minute hold at 5,000 enemies would rule out a slow leak.
- **P2: the wave carried half of Stage 8's event rate.** A rerun with more projectiles (`ppe=0.4`) would bring the effects to Stage 9's worst-case density together with everything else.
- **P1, from Stage 10, fixed: event sounds were not fired early here.** The first run used the director without the lead, so its event sounds landed about one output latency (50–60 ms) after the picture. Stage 12 turned it on (`lead`, default −1, the measured pipeline delay), and the rerun above includes it.

## Rerun on the reference device

1. Build and serve as in run 1's notes: `node scripts/build-wasm.mjs`, `node scripts/build-combat.mjs`, `node scripts/build-chunks.mjs`, `node node_modules/vite/bin/vite.js build`, then `node node_modules/vite/bin/vite.js preview --port 4173 --strictPort`. Nothing else may run on the device meanwhile.
2. Use the device's built-in display at 60 Hz and its default audio output.
3. Run `node scripts/run2/stage11.mjs --throttle 1 --out results/run-2/data/stage11-ref/`. It takes about 40 minutes. Do not pass `--extra simslow=…`: on the device the sim runs at its real speed. On the device, the sim worker and the audio thread run at the device's real speed, which this run could not show.
4. Print the tables with `node scripts/run2/stage11-table.mjs results/run-2/data/stage11-ref/`.
5. Run it at a commit with `d85615d` and `43171bb` (any commit after them). This also reruns the audio side with the director's current choice of big sounds and the player's `shoot` voices, which the dev-machine runs above did not have. Until then, rerun the three waves on the dev machine too (`node scripts/run2/stage11.mjs --only "wave-r" --out results/run-2/data/stage11-audio`) to replace the voice counts.
6. Pass: in all three `wave-r` runs, no pauses or jumps, 0 audio late renders and underruns, sim step p99 under 4 ms, encode p99 under 2 ms, and main thread plus GPU p99 under 10 ms. In `crash`, the look comes back in one rebuild, with snapshots and audio continuing. In `past`, record the first budget to cross its bar for two windows in a row.
