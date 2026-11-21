# Stage 11: does everything fit at once?

Hypothesis: the sim, the snapshot hand-off, the renderer and the audio together keep the game smooth at 60 fps through a worst-case combat wave on the reference device, with every system inside its budget at the same time.

Verdict: **provisional pass**. No reference device was available. Every number below is from the dev machine (RTX 3060, Chrome 156), with the page under Chrome's 4× CPU throttling, the run's stand-in for the reference device. In all three five-minute waves up to 5,000 enemies, at the same time:
- **No pauses or jumps** from the Stage 2 render clock, and 3–5 frames over 20 ms out of 18,000.
- **No audio glitches**: 0 late renders and 0 underruns with mixer B.
- **Sim step** p99 1.54 ms [1.36–1.60], under 4 ms. But Chrome cannot throttle workers, so the sim ran at the dev machine's full speed (see below).
- **CPU encoding** p99 1.42 ms [1.38–1.42], under 2 ms.
- **The frame's work**: main thread p99 2.00 ms and GPU p99 6.16 ms, together inside 60% of 16.7 ms (10 ms). The GPU half was measured on the RTX 3060 and holds only for it, as in Stage 9.
- **Input to frame submit**: median 9.3 ms, p99 17.5 ms.

Two limits on the verdict matter more than the pass:
- **The sim is the budget that breaks first, and its numbers here are optimistic.** Ramping past the bar, the sim step p99 first crossed 4 ms at about 11,900 enemies and stayed over it from about 13,400. That was at the dev machine's full speed. At 5,000 enemies its p99 is 1.5–1.6 ms here. If the step time scaled with a CPU four times slower, it would be about 6 ms, over the bar. So the reference-device rerun decides this stage, and the sim is the system to watch.
- **The wave carried about half of Stage 8's event rate.** The sim produced a mean 293 events per step (about 8,800 a second) at 5,000 enemies, against Stage 8's 16,400 a second at its pass load. The scripted player and the projectile target (0.2 per enemy) set it. Stage 10 measured the mixer at 16,400 events a second and up to 4× that, so the audio side is covered, but the renderer's effects ran at about half the density of Stage 9's worst case.

Fallback: **not applied**. If the reference-device run fails, the first system over its budget applies its own stage's fallback. Going by this run, that is the sim (Stage 8: fewer passes, a lower enemy cap, or a cheaper pair finding at the peak).

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

## Findings for Stage 12

- **P2: the sim is the first budget to break, and the dev machine could not slow it down.** Its p99 is 1.5–1.6 ms at 5,000 enemies at full speed. The reference-device rerun is the only real test. If it fails, Stage 8's fallback applies.
- **P2: the renderer allocates about 2.5 MB/s in `render()` at the peak.** Move the per-frame arrays and lists to preallocated typed arrays. Stage 12's P1 fix for explosions (a fixed ring and a fixed-size nearest set) removes the explosion part of it.
- **P2: the director's event decode allocates per snapshot** (0.2 MB/s). Decode into a reused buffer.
- **P2: memory over a longer hold.** Run the wave for 30 minutes at a fixed 5,000 enemies to tell a slow leak from load growth.
- **P2: the wave carried half of Stage 8's event rate.** A rerun with more projectiles (`ppe=0.4`) would bring the effects to Stage 9's worst-case density together with everything else.
- **P1, from Stage 10: event sounds are not fired early here.** Stage 11 used the director without the lead, so its event sounds land about one output latency (50–60 ms) after the picture. Stage 12 sets it on.

## Rerun on the reference device

1. Build and serve as in run 1's notes: `node scripts/build-wasm.mjs`, `node scripts/build-combat.mjs`, `node scripts/build-chunks.mjs`, `node node_modules/vite/bin/vite.js build`, then `node node_modules/vite/bin/vite.js preview --port 4173 --strictPort`. Nothing else may run on the device meanwhile.
2. Use the device's built-in display at 60 Hz and its default audio output.
3. Run `node scripts/run2/stage11.mjs --throttle 1 --out results/run-2/data/stage11-ref/`. It takes about 40 minutes. On the device, the sim worker and the audio thread run at the device's real speed, which this run could not show.
4. Print the tables with `node scripts/run2/stage11-table.mjs results/run-2/data/stage11-ref/`.
5. Pass: in all three `wave-r` runs, no pauses or jumps, 0 audio late renders and underruns, sim step p99 under 4 ms, encode p99 under 2 ms, and main thread plus GPU p99 under 10 ms. In `crash`, the look comes back in one rebuild, with snapshots and audio continuing. In `past`, record the first budget to cross its bar for two windows in a row.
