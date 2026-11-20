# Stage 2: are snapshots smooth?

Hypothesis: worker snapshots plus interpolation in the vertex shader give smooth motion at 60 fps and at 30 fps, with a fixed buffer pool and no allocation in the game loop.

Verdict: **provisional**. What held on the dev machine, for design A with a lag of 2 sim steps: smooth motion (no pauses or jumps at 60 and 30 fps with 0–20 ms of added delay) and recovery from stalls. Why the whole is provisional: input delay is measured only up to frame submit, and at 30 fps with 20 ms of delay it is already at the ~100 ms bar there (p99 97.6 ms, max 100.2 ms) before display time is added; gamepad input delay is **unmeasured** (no gamepad on the dev machine); "no allocation in the game loop" is **not shown** (the sampled allocation rate was not zero and the harness's own recording could not be separated from the loop, see "Allocations"); and the reference device was not run. The fallback's first fix (drawing the player from its own latest state) is recorded but not applied. "Visible" pauses and jumps were judged by the counters below, not by eye. Rerun steps are at the end.

Output for the tech direction (measured, dev machine):

- Design: **A** (queue plus a render clock steered toward a fixed lag). Design B, the simpler one, lost: at 60 fps it shows 7.8 pauses and 26.6 jumps per minute with no added delay and 89.8 / 145.2 with 0–20 ms of delay.
- Lag: **2 sim steps** (66.7 ms at 30 Hz). 1.5 steps is the limit (0.2–2.2 pauses per minute with 20 ms of delay); 1 step fails (240–294 per minute); 2.5 and 3 steps are just as smooth but push input delay to 100 ms and over.
- Queue: **3 snapshots** on the main thread (never more than 2 waiting in normal running, 3 after a stall).
- Pool: **6 buffers**. The main thread never held more than 3 in normal running and 5 after a stall. A pool of 4 with a queue of 2 was also clean in normal running; a pool of 3 with a queue of 1 fails (137 pauses per minute, 685 snapshots dropped).

## What was built

- Snapshot: an 80-byte header (start tick, end tick, entry count, the input sequence number the step applied, wall-clock times) and one 32-byte entry per entity holding start and end position, start and end facing, kind and radius. Entities are sorted by grid cell every step, so entries change slots; neither design blends entries from two snapshots, and neither extrapolates.
- The worker takes a buffer from the pool, copies the snapshot out of WASM memory, and transfers it. The main thread transfers each buffer back when it is done with it. If the pool is empty the worker skips that snapshot (counted as "skipped by worker"; the main thread sees the tick gap).
- Design A (`src/snapclock.ts`): snapshots wait in a queue; the render clock runs a fixed lag behind a smoothed estimate of sim time, is steered by at most 5% of its speed, and resyncs at once when it is more than 2 steps off. Design B: only the newest snapshot is kept and its playback starts when it arrives.
- Rendering: one instanced mesh per kind, no culling, interpolation between the entry's two states in the vertex shader (`src/render-simple.ts`). The snapshot is uploaded with one `writeBuffer` per sim step.
- Overlay switches: cap at 30 fps, message delay 0/5/10/20 ms, design, lag, stall 100 ms / 500 ms.

## How it was measured

- Dev machine: Intel Core i7-13700, 64 GB, NVIDIA RTX 3060, Windows 11 Pro 10.0.26200, Chrome 156.0.8078.73 (headed, real GPU, 60 Hz display), 1920×1080 canvas. Nothing was throttled.
- Build: commit `682bb07`, `vite build`, served by `vite preview`. 2,000 entities, WASM SIMD sim in the worker at 30 Hz.
- Each row is one 5-minute run after a 5-second warm-up (stall rows: 125 s with one stall every 10 s; the heap row: 60 s). Rerun with `node scripts/stage2.mjs 300`, print the tables with `node scripts/stage2-table.mjs`. URL: `?bench=stage2&n=2000&spawn=40&script=0&design=<A|B>&lag=<steps>&cap=<0|30>&delay=<ms>&stall=<ms>&pool=<n>&maxq=<n>`.
- Pause: a drawn frame where the sim time on screen advanced by less than 0.25× the frame's duration. Jump: more than 1.75×. "Clock error rms" is the root mean square of (advance − frame duration) over all frames.
- "Added delay 0–20" is a uniform random delay on each of the worker's snapshot messages.
- "30 fps" draws every second 60 Hz frame.
- Input delay: puppeteer presses a key through Chrome's input pipeline about once a second. The delay runs from the key event's timestamp to the moment the main thread submits the first frame that shows a snapshot which applied that input, past its start. It **does not include** the keyboard's own hardware delay or the time from submit to light on the display (about one to two more frames).
- Raw data: `results/data/stage2/*.json`, log `results/data/stage2.log`.

## Results (all rows: dev machine, Chrome 156.0.8078.73, 2,000 entities)

| Run | Design | Lag (steps) | Frame rate | Added delay (ms) | Pool / queue | Pauses/min | Jumps/min | Clock error rms (ms) | Max queue | Max buffers held by main | Dropped by main | Skipped by worker | Input→screen median / p99 / max (ms) | Key presses | Frame p99 (ms) | Seconds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-lag1-30fps-delay20 | A | 1 | 30 | 0–20 | 6 / 3 | 240.0 | 240.0 | 17.21 | 2 | 3 | 0 | 0 | 52.4 / 96.5 / 99.8 | 647 | 33.5 | 300 |
| A-lag1-60fps-delay20 | A | 1 | 60 | 0–20 | 6 / 3 | 293.8 | 292.8 | 9.00 | 2 | 3 | 0 | 0 | 47.8 / 79.2 / 83.6 | 660 | 16.8 | 300 |
| A-lag1.5-30fps-delay20 | A | 1.5 | 30 | 0–20 | 6 / 3 | 0.2 | 0.0 | 13.04 | 2 | 3 | 0 | 0 | 55.2 / 97.9 / 100.4 | 659 | 33.5 | 300 |
| A-lag1.5-60fps-delay20 | A | 1.5 | 60 | 0–20 | 6 / 3 | 2.2 | 2.2 | 2.64 | 2 | 3 | 0 | 0 | 49.1 / 79.3 / 83.5 | 662 | 16.8 | 300 |
| A-lag2-30fps-delay0 | A | 2 | 30 | 0–0 | 6 / 3 | 0.0 | 0.0 | 1.71 | 2 | 3 | 0 | 0 | 49.4 / 66.9 / 94.6 | 662 | 33.5 | 300 |
| A-lag2-30fps-delay20 | A | 2 | 30 | 0–20 | 6 / 3 | 0.0 | 0.0 | 3.32 | 2 | 3 | 0 | 0 | 53.7 / 97.6 / 100.2 | 651 | 33.5 | 300 |
| A-lag2-60fps-delay0-heap | A | 2 | 60 | 0–0 | 6 / 3 | 0.0 | 0.0 | 0.01 | 2 | 3 | 0 | 0 | 60.6 / 83.6 / 83.6 | 59 | 16.8 | 60 |
| A-lag2-60fps-delay0 | A | 2 | 60 | 0–0 | 6 / 3 | 0.0 | 0.0 | 0.17 | 2 | 3 | 0 | 0 | 50.6 / 66.8 / 67.2 | 663 | 16.8 | 300 |
| A-lag2-60fps-delay20-main | A | 2 | 60 | 0–20 | 6 / 3 | 0.0 | 0.0 | 0.21 | 2 | 3 | 0 | 0 | 56.7 / 73.2 / 73.9 | 659 | 16.8 | 300 |
| A-lag2-60fps-delay20-pool3 | A | 2 | 60 | 0–20 | 3 / 1 | 137.0 | 137.0 | 4.65 | 1 | 3 | 685 | 0 | 53.4 / 113.1 / 116.8 | 663 | 16.8 | 300 |
| A-lag2-60fps-delay20-pool4 | A | 2 | 60 | 0–20 | 4 / 2 | 0.0 | 0.0 | 0.15 | 2 | 3 | 0 | 0 | 62.5 / 83.5 / 83.8 | 659 | 16.8 | 300 |
| A-lag2-60fps-delay20-pool5 | A | 2 | 60 | 0–20 | 5 / 3 | 0.0 | 0.0 | 0.23 | 2 | 3 | 0 | 0 | 64.5 / 83.1 / 83.7 | 654 | 16.8 | 300 |
| A-lag2-60fps-delay20 | A | 2 | 60 | 0–20 | 6 / 3 | 0.0 | 0.0 | 0.17 | 2 | 3 | 0 | 0 | 60.4 / 82.9 / 83.6 | 653 | 16.8 | 300 |
| A-lag2.5-30fps-delay20 | A | 2.5 | 30 | 0–20 | 6 / 3 | 0.0 | 0.0 | 0.06 | 2 | 3 | 0 | 0 | 82.7 / 100.0 / 101.9 | 659 | 33.5 | 300 |
| A-lag2.5-60fps-delay20 | A | 2.5 | 60 | 0–20 | 6 / 3 | 0.0 | 0.0 | 0.03 | 2 | 3 | 0 | 0 | 82.2 / 99.8 / 100.3 | 658 | 16.8 | 300 |
| A-lag3-30fps-delay20 | A | 3 | 30 | 0–20 | 6 / 3 | 0.0 | 0.0 | 0.05 | 2 | 3 | 0 | 0 | 84.2 / 99.4 / 100.2 | 658 | 33.5 | 300 |
| A-lag3-60fps-delay20 | A | 3 | 60 | 0–20 | 6 / 3 | 0.0 | 0.0 | 0.03 | 3 | 4 | 0 | 0 | 99.1 / 116.4 / 116.7 | 650 | 16.8 | 300 |
| A-stall100 | A | 2 | 60 | 0–20, stall 100 every 10 s | 6 / 3 | 0.5 | 0.5 | 1.55 | 3 | 5 | 6 | 0 | 55.3 / 86.2 / 114.3 | 275 | 16.9 | 125 |
| A-stall500 | A | 2 | 60 | 0–20, stall 500 every 10 s | 6 / 3 | 43.7 | 20.6 | 22.70 | 3 | 5 | 41 | 138 | 68.9 / 532.6 / 566.3 | 266 | 16.8 | 125 |
| B-30fps-delay0 | B | – | 30 | 0–0 | 6 / 3 | 0.0 | 0.0 | 4.68 | 0 | 3 | 30 | 0 | 50.5 / 66.4 / 67.1 | 653 | 33.5 | 300 |
| B-30fps-delay20 | B | – | 30 | 0–20 | 6 / 3 | 0.0 | 0.0 | 8.41 | 0 | 3 | 315 | 0 | 50.2 / 91.3 / 100.3 | 644 | 33.5 | 300 |
| B-60fps-delay0 | B | – | 60 | 0–0 | 6 / 3 | 7.8 | 26.6 | 3.18 | 0 | 3 | 15 | 0 | 34.7 / 65.4 / 66.7 | 656 | 16.8 | 300 |
| B-60fps-delay20 | B | – | 60 | 0–20 | 6 / 3 | 89.8 | 145.2 | 5.84 | 0 | 3 | 104 | 0 | 45.9 / 75.3 / 82.6 | 659 | 16.8 | 300 |
| B-stall100 | B | – | 60 | 0–20, stall 100 every 10 s | 6 / 3 | 123.8 | 174.2 | 6.51 | 0 | 3 | 27 | 0 | 48.0 / 83.5 / 149.7 | 271 | 16.8 | 125 |
| B-stall500 | B | – | 60 | 0–20, stall 500 every 10 s | 6 / 3 | 87.8 | 163.7 | 23.42 | 0 | 3 | 93 | 131 | 46.0 / 525.4 / 576.8 | 264 | 16.8 | 125 |

Stall recovery, in ms from the end of each stall to the last pause or jump before the next stall (one stall every 10 s, 0–20 ms of delay added):

- A-stall100: 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0
- A-stall500: 83, 417, 83, 66, 83, 83, 383, 416, 466, 50, 383
- B-stall100: 9433, 9633, 9517, 9716, 9697, 9783, 9816, 9833, 9867, 9200, 9816, 9767
- B-stall500: 9450, 9250, 9283, 9200, 9367, 9400, 9217, 9467, 8750, 9467, 8517, 9383

## What the numbers say

- **Design A, lag 2**: no pauses and no jumps in 5 minutes at 60 fps and at 30 fps, with 0 and with 0–20 ms of added delay. Nothing dropped, nothing skipped.
- **Design B**: fails at 60 fps even with no added delay (7.8 pauses, 26.6 jumps per minute), because the sim's timer is late by up to about 15 ms (Stage 1) and B has no buffer to hide it. At 30 fps the counters read zero, but B dropped 30 (no delay) and 315 (20 ms) snapshots that were never shown, each one a sim step of motion skipped, and its clock error is 2.5–2.7× design A's. B's input delay is about 15 ms lower at 60 fps (median 34.7 against 50.6 ms). The ruled-in design wins.
- **Lag** (60 fps, 20 ms delay): 1 step 294 pauses/min; 1.5 steps 2.2; 2 steps 0; 2.5 and 3 steps 0. Input delay p99: 79 / 79 / 83 / 100 / 116 ms. So 2 steps is the smallest clean lag and the largest that stays under 100 ms.
- **Input delay, keyboard** (design A, lag 2): median 50.6 ms and p99 66.8 ms at 60 fps with no delay; p99 82.9 ms with 20 ms of delay; at 30 fps with 20 ms of delay the median is 53.7 ms, p99 97.6 ms, and the maximum 100.2 ms. This is inside "about 100 ms" as measured, but the measurement stops at frame submit, so at 30 fps with a delayed worker the delay to the display is over 100 ms in the worst cases. The fallback's first fix (drawing the player from its own latest state) is recorded as the way to buy this back; it was not built.
- **Input delay, gamepad: unmeasured.** The dev machine has no gamepad. Gamepads are polled once per frame, so up to one frame (16.7 ms at 60 fps) is added to the keyboard path before the same code runs.
- **Stalls**: design A recovers from a 100 ms stall with no pause or jump at all in 11 of 12 stalls (16 ms in the other) and from a 500 ms stall within 50–466 ms (pass bar: one second). During a 500 ms stall the pool runs dry and the worker skips snapshots (138 in 12 stalls, about 11 per stall), which is the designed behaviour. Design B never settles between stalls because it pauses and jumps all the time with 20 ms of delay.
- **Pool and queue**: with pool 6 / queue 3 the main thread held at most 3 buffers in normal running (one on screen, up to two waiting) and 5 after a stall. Pool 4 / queue 2 and pool 5 / queue 3 were also clean over 5 minutes at 60 fps with 20 ms of delay (not tested with stalls or at 30 fps). Pool 3 / queue 1 fails.
- **Sim on the main thread** (design A, lag 2, 20 ms delay): also 0 pauses and 0 jumps, input p99 73.2 ms against 82.9 ms. With a 0.6 ms step on this machine the main thread hides nothing; the worker's value is headroom when the step or the frame gets expensive (Stage 1 measured the worker's delivery cost at about 0.06–0.1 ms median).

## Allocations

Chrome's sampling heap profiler (256-byte sampling interval, objects collected by GC included) over 30 s of steady running, design A, lag 2, 60 fps, dev machine:

| Thread | Sampled allocation | Largest sources |
|---|---|---|
| Main | 111 KB/s (3.33 MB in 30 s) | the frame function 1.02 MB (it holds the bench's growing frame-time arrays and builds the input message), message handlers 0.51 MB, renderer `render` 0.16 MB, clock 0.24 MB, overlay text 0.10 MB |
| Sim worker | 30.5 KB/s (0.92 MB in 30 s) | `onmessage` 0.30 MB (input and buffer-return messages), the step wrapper 0.30 MB, the timer loop 0.07 MB |

This is **not zero**, and it is more than the `postMessage` cost alone. The prototype's measuring code (growing arrays of samples, overlay strings, input message objects) allocates inside the same functions as the loop, and the bundle is minified, so the game loop's own share could not be separated. The pool itself works as intended: no `ArrayBuffer` for snapshots is created after startup, and frame time shows no garbage-collection spikes (frame p99 16.8 ms, no frame over 34 ms in any 60 fps run without stalls). So the fixed pool is confirmed and "zero allocation" is not; the real game needs its own allocation check with the measuring code off.

## Limits found

- Lag below 2 steps is not smooth with a worker whose messages arrive up to 20 ms late.
- Queue 1 / pool 3 is too small. Queue 2 / pool 4 is the smallest size that was clean.
- A 500 ms main-thread stall costs about 11 skipped snapshots and up to 0.47 s of uneven motion afterwards.
- At 30 fps with 20 ms of worker delay the input delay is at the 100 ms line before display time is added.

## Fallback

Not triggered. Recorded for the reference-device run: if input delay there is over about 100 ms, draw the player from its own latest state instead of the interpolated snapshot; if motion is not smooth, consider running the sim on the main thread for the player only.

## Rerun steps (reference device, and a gamepad)

1. On the reference device, build at this commit (`npx pnpm@10 install && npx pnpm@10 build && npx pnpm@10 preview` in `prototype/`) and run `node scripts/stage2.mjs 300` (needs Chrome; set `VESSEL_BASE` if the port differs).
2. Pass: the rows `A-lag2-60fps-delay0`, `A-lag2-60fps-delay20`, `A-lag2-30fps-delay0`, `A-lag2-30fps-delay20` show 0 pauses and 0 jumps per minute, `A-stall100` and `A-stall500` recover within 1,000 ms, and the input p99 is under about 100 ms.
3. Gamepad: open `?n=2000&design=A&lag=2`, press a button so the overlay's `pad` line shows the gamepad, flick the left stick about once a second for 5 minutes, and read the overlay's `input to screen` line (median and maximum).
4. For true end-to-end delay, film the screen and the key or stick with a high-speed camera (240 fps or more) and count frames; the numbers above stop at frame submit.
