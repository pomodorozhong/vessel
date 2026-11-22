# Stage 10: does dense combat sound play cleanly?

Hypothesis: our own small mixer on Web Audio plays dense combat sound (hundreds of sound events per second, dozens of voices at once) without glitches and in time with the picture, while the main thread is busy rendering, with little main-thread cost.

Verdict: **provisional pass with mixer B (the AudioWorklet mixer); mixer A fails**. No reference device was available, so every number below is from the dev machine, with the page under Chrome's 4× CPU throttling and 4 ms of busy main thread per frame standing in for rendering.
- **Glitches**: B had none in any five-minute run: 0 late renders and 0 underruns at about Stage 8's pass rate (labelled 16,400 events/s, really about 15,400; see the correction below), at 2× and 4× that, with and without Stage 2's 100 ms and 500 ms main-thread stalls. A had 8–17 late renders per run, with or without stalls, so its glitches come from its own main-thread work, not from the stalls.
- **Main-thread cost**: B costs median 0.02 ms and p99 0.39 ms [0.385–0.405] per frame at the pass rate with stalls, under the 0.5 ms bar. A costs median 0.23–0.41 ms and p99 1.40 ms [1.40–1.44], over the bar.
- **Latency**: **provisional pass with the picture lead on**. The player's own sound reached the speaker a median 59–75 ms after the key press, as the browser's output timestamp maps it. That mapping already includes the device's output latency, which was 48–64 ms here, so the mixer's own share is about 5–20 ms, inside the 30 ms bar. Event sounds started a median 57–75 ms after the frame that shows them was submitted, which is about one output latency late and over the one-frame bar. With the events fired early by the measured pipeline delay (`lead=-1`), B's offset fell to a median 9.1 ms [8.9–10.6] and A's to 24.5 ms. B's p99 with the lead is 28 ms [23.5–29.0], so the tail is still about 1.7 frames. The time from frame submit to the picture on screen was not measured, so the true offset to the picture is somewhat smaller than these numbers.
- **The audio thread is not throttled.** Chrome throttles the page's main thread only, so B's worklet ran at the dev machine's full speed. Its load was 1.3% of each 2.67 ms quantum, which leaves a wide margin even on a CPU four times slower, but the reference-device rerun must confirm it.

Mixer design: **B wins**, which the plan's fallback asks for when A glitches. A also clips: its `DynamicsCompressorNode` set up as a limiter is not a brickwall, so the master peaked at 1.20–1.36 and 147,000–328,000 samples per run were clipped (0.5–1.1% of them). B's look-ahead limiter held the master at its ceiling of 0.891 (−1 dBFS), with no clipped samples.

Fallback: **not needed for B**. The voice limits were never what failed: both mixers ran at their total limit of 40 voices for nearly the whole run without B glitching.

## What was built

All of it is in `src/stage10/` and `stage10.html`.
- **Sound events** come from the v2 snapshot (shots, hits, deaths, explosions, pickups, walls, player hurt) through a ring of the last 64 snapshots. The director (`director.ts`) fires a snapshot's events when the render clock reaches its tick. Events more than 8 steps old when they come due (after a long stall) are skipped instead of played late. The player's own shots and dashes play straight from the key press, without waiting for the sim.
- **Two mixers behind one interface** (`mixer.ts`):
  - A (`mixer-a.ts`): plain Web Audio nodes on the main thread. One `AudioBufferSourceNode` per sound through a gain and a stereo panner. The gain and panner chain is pooled per voice slot. Four bus gains, a master gain and a `DynamicsCompressorNode` as the limiter.
  - B (`mixer-b.ts`, `mixer-b.worklet.ts`): our own mixer in an `AudioWorklet`. It holds the decoded samples (transferred once), mixes every voice itself (pitch by linear resampling, equal-power pan), sums four buses with ducking, and ends in a 64-sample look-ahead limiter. Sound events reach it as small batches in transferred, pooled ArrayBuffers.
- **Voice management** (`policy.ts`), the same code in both mixers (A runs it on the main thread, B on the audio thread):
  - A limit per sound (2–10) and a total of 40 voices, with priority: the player's own sounds first, big hits next, filler last. A new voice steals the quietest lower-priority one, which fades out over 8 ms.
  - Stacking: identical events in one batch merge into one louder voice (volume × (1 + 0.45 log2 n), capped at 1.6×).
- **Variation**: each sound has several takes, and every play gets a random take and a small random change in pitch (±0.2 to ±0.8 semitones) and volume.
- **Buses**: big sound effects, small sound effects, music and UI. Big hits, deaths, explosions and the player getting hurt duck the music and the small effects (fast attack, 120 ms hold, 150 ms release).
- **Music**: four looping layers (pad and bass; kick and hat; arpeggio; snare and riff) that fade in as combat intensity rises past 0, 0.12, 0.38 and 0.68. Intensity is events per second, smoothed over 1.5 s.
- **Placeholder sounds**: generated by `scripts/run2/stage10-sounds.mjs` from a seeded generator (no downloads) and encoded once with ffmpeg as Ogg Opus: `public/stage10/sfx.ogg` (110 KB, mono, all takes in one file), `music.ogg` (200 KB, stereo) and `manifest.json`. The style aims at Hades-like combat: short, punchy hits with a bright transient, low booms for explosions, and a driving drum and synth loop.
- **Harness**:
  - A scripted snapshot stream in a worker (`harness-sim.worker.ts`) at 30 Hz with Stage 8's measured mix of events at its pass load: 48% shots, 46% hits, 5.6% explosions, and a few deaths, pickups, wall changes and player hits (commit `ff7bf79`).
  - A glitch detector (`harness-detector.worklet.ts`), the same for A and B: an `AudioWorklet` that checks every 128-sample render quantum against the wall clock and counts the late ones. `AudioContext.playbackStats` underruns are recorded next to it.
  - An injector that forces glitches to check the detector.

Choices the plan left open, taken as defaults:
- 40 voices in total, 64 voice slots, 8 ms steal fade.
- `latencyHint: 'interactive'` (Chrome gave 10 ms base latency and 48–72 ms output latency on this machine's default output).
- The pass rate is Stage 8's events at its pass load, 16,400 events/s. Run with 2× and 4× that rate for "past it".
  - Correction after the PR review: the stream's per-step multiplier (2.2 on one step in ten, 0.8 on the rest) averaged 0.94, so every run in these tables carried about 6% fewer events than its label (r16400 ≈ 15,400 events/s, 2× ≈ 30,800, 4× ≈ 61,700), and the busy steps were 2.75× the quiet ones. The stream now uses 3 and 7/9, which average 1. The runs here were not repeated.
  - Also found in the review: mixer B sent a frame's events in chunks of 512 and ran the voice policy once per chunk, so on busy steps it could stack more voices per sound than mixer A. The worklet now runs the policy once over all chunks of a frame. The B counters in these tables come from the old behaviour.
- Main-thread stalls as in Stage 2: 100 ms and 500 ms alternately, every 10 s, 30 per five-minute run.
- `--busy 4`: the frame callback busy-waits 4 ms on the clock (so throttling does not stretch it) as a stand-in for rendering and the snapshot hand-off. Stage 11 replaces it with the real renderer and sim.

## How it was measured

- **Machine**: the dev machine (Intel Core i7-13700, 64 GB, NVIDIA RTX 3060, Windows 11 Pro 10.0.26200) with Chrome 156.0.8078.73, headed, driven by puppeteer-core with `--autoplay-policy=no-user-gesture-required`, through the real default audio output at 48 kHz.
- **Throttling**: 4× CPU throttling of the page. Chrome cannot throttle workers or the audio thread, so the stream worker, the detector and mixer B ran at full speed (a harmless "worker throttle failed" line in the log).
- **Input**: the driver sends real key presses through Chrome's input pipeline about twice a second (Space shoots, F dashes), so input latency starts from the real `event.timeStamp`.
- **Build**: `vite build` at `ff7bf79`, served by `vite preview` with COOP/COEP (for 5 µs `performance.now()`). The latency reruns used `78941f7` (below).
- **Runs**: each mixer × the pass rate, 2× and 4× with stalls, the pass rate without stalls, and the pass rate with event sounds fired early by the measured pipeline delay (`lead=-1`). Each ran 300 s × 3 repetitions after a 10 s warm-up. A cell shows the median over the repetitions, with min–max in brackets. Plus a 60 s allocation run and a 15 s recording per mixer, and three 40 s detector checks.
- **Allocations**: `scripts/run2/heap.mjs`, V8's sampling heap profiler over CDP on the page and every worker, attributed by script file. Files whose name starts with "harness" count as harness, not game. Typed array backing stores, native Web Audio objects and the worklet scope are not visible to it.
- **The latency samples of the first full run are missing.** The tracking buffer (8,192 entries) was sampled every 16th event sound, which at Stage 8's rate filled it during the 10 s warm-up, so none of the five-minute runs recorded a latency sample. Commit `78941f7` tracks one event sound every 4 frames instead and doubles the buffer. The pass-rate runs (stalls, no stalls, lead) were then rerun for both mixers into `data/stage10-latency/`. The glitch, cost and voice numbers are from the first run; the tracking change does not touch them.

Raw results: `data/stage10/*.json` and `data/stage10-latency/*.json`, tables in `data/stage10-tables.md` and `data/stage10-latency-tables.md` (from `node scripts/run2/stage10-table.mjs [dir]`), logs in `data/stage10.log` and `data/stage10-latency.log`. Recordings: `media/stage10/A-rec.webm` and `B-rec.webm`, 15 s of the master output at the pass rate.

## Results

### Glitches

| Run | Late renders (detector) | Underrun events | Max excess (ms) | Master peak | Clipped samples |
|---|---|---|---|---|---|
| A, pass rate, stalls | 9 [8–9] | 0 | 58.7 [49.7–79.3] | 1.237 | 147,070 |
| A, pass rate, no stalls | 8 [8–8] | 0 | 58.3 [58.0–59.0] | 1.202 | 148,921 |
| A, 2×, stalls | 12 [11–13] | 0 | 59.0 [58.0–98.0] | 1.327 | 200,993 |
| A, 4×, stalls | 14 [14–17] | 0 | 68.7 [68.3–69.7] | 1.332 | 324,490 |
| B, pass rate, stalls | **0** [0–0] | 0 | 11.7 [11.3–12.3] | 0.891 | 0 |
| B, pass rate, no stalls | 0 [0–0] | 0 | 12.3 [12.3–13.3] | 0.891 | 0 |
| B, 2×, stalls | 0 [0–0] | 0 | 12.7 [12.7–20.3] | 0.891 | 0 |
| B, 4×, stalls | 0 [0–0] | 0 | 12.3 [11.3–13.3] | 0.891 | 0 |

- "Max excess" is the largest delay of a render quantum past its due time. With nothing wrong, it stays in an idle band of about 11–13 ms (B) or 18–24 ms (A, whose main-thread node work delays the detector's own messages). A late render is one over the idle band plus a margin.
- `playbackStats` counted 7–8 underruns in each run, all before the bench started (while the page loaded). None happened during a measured run.

The detector checks (40 s each, pass rate):

| Run | Injected | Late renders counted | Underrun events |
|---|---|---|---|
| A, idle | 0 | 0 | 0 |
| A, 50 ms audio-thread block every 4 s | 10 | 10 | 53 |
| A, heavy worklet load 1.5 s every 6 s | 7 | 8 | 564 |
| B, idle | 0 | 0 | 0 |
| B, 50 ms audio-thread block every 4 s | 10 | 39 | 52 |
| B, heavy worklet load 1.5 s every 6 s | 7 | 7 | 511 |

The detector found every injected glitch and none when idle. With B, a 50 ms block counts several late quanta, because B's mixing shares the blocked thread and catches up over several quanta. So the count is a count of late quanta, not of separate glitches. For the pass bar, which is zero, that does not matter.

### Latency and sync

Rerun after the tracking fix: pass rate, 300 s × 3 repetitions each, in `data/stage10-latency/` (full tables in `data/stage10-latency-tables.md`). All times in ms, median [min–max] over the repetitions.

| Run | Input to sound median | p99 | Event sound after frame submit, median | p99 | Output latency | Late renders |
|---|---|---|---|---|---|---|
| A, stalls | 63.6 [58.9–72.9] | 76.0 | 62.6 [56.6–72.9] | 73.2 | 56 | 8 [7–22] |
| A, no stalls | 62.1 [58.5–71.2] | 70.4 | 60.9 [57.2–70.2] | 70.2 | 56 | 8 [7–19] |
| A, lead | 74.6 [73.3–77.3] | 81.2 | 24.5 [24.0–40.2] | 44.6 | 64 | 9 [7–9] |
| B, stalls | 59.2 [59.0–65.0] | 67.6 | 57.4 [57.4–64.3] | 64.6 | 56 | 0 |
| B, no stalls | 74.8 [71.6–75.4] | 80.7 | 74.9 [70.7–74.9] | 78.1 | 64 | 0 |
| B, lead | 60.2 [59.3–61.1] | 70.9 | **9.1** [8.9–10.6] | 28.2 | 48 | 0 |

- "Input to sound" runs from the key event's timestamp to the moment the first sample of the player's sound reaches the output, mapped through `AudioContext.getOutputTimestamp()`. Chrome's mapping includes the device's output latency, so the numbers move with it: the runs with 64 ms output latency are the slow ones. The generated tables also show a "+outLat" column that adds `outputLatency` once more; it counts the latency twice and is shown only for comparison.
- "Event sound after frame submit" runs from the `requestAnimationFrame` in which the render clock reached the event's tick to the event's first sample at the output.
- The lead fires each snapshot's events `currentTime − getOutputTimestamp().contextTime` earlier (about one output latency, measured at start). It moves the event sounds, not the player's own sounds, which still play straight from the key press.
- The lead and the stalls work together: events fired early still come from the snapshot ring, so a 500 ms stall skips the same stale events as without the lead.
- The output latency was 48–64 ms, high for Windows' shared-mode audio, and it varied between runs of the same settings. The reference-device rerun must report its own.
- Every run logged two 404s for resource loads; they are in the JSON files and were not looked into further.

### Main-thread cost and the audio thread

| Run | Audio ms/frame median | p99 | max | Frame p99 (ms) |
|---|---|---|---|---|
| A, pass rate, stalls | 0.225 | 1.425 [1.395–1.435] | 4.47 | 17.2 |
| A, pass rate, no stalls | 0.410 | 1.440 [1.400–2.020] | 4.73 | 17.2 |
| A, 2×, stalls | 0.250 | 1.970 [1.770–2.040] | 6.36 | 17.3 |
| A, 4×, stalls | 0.235 | 2.440 [2.415–2.480] | 7.65 | 17.3 |
| B, pass rate, stalls | 0.020 | **0.390** [0.385–0.405] | 2.24 | 17.2 |
| B, pass rate, no stalls | 0.020 | 0.380 [0.380–0.395] | 1.81 | 17.1 |
| B, 2×, stalls | 0.050 | 0.590 [0.585–0.600] | 3.26 | 17.2 |
| B, 4×, stalls | 0.175 | 0.975 [0.890–1.015] | 4.44 | 17.2 |

- Main-thread audio time is everything the frame spends in the director and the mixer: decoding the snapshot's events, the voice policy (A only), node creation and scheduling (A) or filling and posting a batch (B), and the music update. Key-press handling is added to the next frame.
- B's p99 is under the 0.5 ms bar at the pass rate and over it at 2× (0.59 ms) and 4× (0.98 ms). The cost there is decoding and distance-culling the events on the main thread, which grows with the event rate.
- B's `process()` took 0.034 ms [0.032–0.036] on average per 2.67 ms quantum, a load of 1.3%, at the pass rate. At 4× it took 0.040 ms. `performance.now()` is not available in the worklet scope, so it was timed with `Date.now()` (1 ms steps). The mean is unbiased, but the per-quantum maximum is not measurable.
- `AudioRenderCapacity` is not available in this Chrome.

### Voices, merging and limits (per second, pass rate with stalls)

| Mixer | Voices median | max | Started | Merged by stacking | Dropped, per-sound limit | Dropped, total limit | Stolen | Snapshot events |
|---|---|---|---|---|---|---|---|---|
| A | 39 | 40 | 191 | 14,205 | 6.1 | 13.1 | 102 | 15,644 |
| B | 40 | 40 | 212 | 14,131 | 7.0 | 23.4 | 123 | 15,594 |

- Stacking does nearly all the work: of 15,600 events a second, about 14,100 merge into a louder copy of a sound already starting in the same batch. About 200 voices a second actually start.
- Of the events the director sees, those more than 70 units from the player are not played at all, before the mixer.
- Both mixers sit at the 40-voice limit almost all the time. At 4× the rate, B drops 263 events a second at the total limit and steals 431 voices a second, still without glitches.
- After the 500 ms stalls, events more than 8 steps old when they came due were skipped instead of played in a burst: 13,800–17,600 per run with stalls, about 0.3% of the events.

### Allocations (60 s at the pass rate, bytes per second)

| Mixer | Main thread, game | Main thread, harness | Stream worker (harness) |
|---|---|---|---|
| A | 2,814,104 | 690 | 3,127,892 |
| B | 2,711,849 | 693 | 3,105,572 |

- Both mixers' "game" allocations came from the same minified function, and it was the `--busy` stand-in, not the sound code. A 60 s rerun per mixer with `--busy 0` (`data/stage10-busy0/`, same build as Stage 11) measured A at 72,885 B/s and B at 56,560 B/s. The rest is mostly A's `flush` and B's message handler for the worklet's reports, plus the snapshot `onmessage`.
- The stream worker's 3 MB/s is the harness sim that stands in for Stage 8, which the game will not ship.
- A had 3 late renders in its 80 s `--busy 0` run too, so its glitches do not need a busy main thread.

### Listening

The recordings (`media/stage10/A-rec.webm`, `B-rec.webm`) are 15 s of the master output at the pass rate, at the player's position in the middle of the fight. They have not been listened to by a person in this run: judging the mix by ear, and whether A's clipped samples are audible, is left to the review.

## Findings for Stage 12

- **P2: A's limiter clips.** It does not matter once B is chosen, but any later use of plain Web Audio nodes needs a real limiter.
- **P2: the main-thread event decode grows with the event rate.** B is over the 0.5 ms bar from 2× the pass rate. If the game's event rate grows past Stage 8's, filter by distance in the sim or the snapshot (only events near the player carry sound) instead of on the main thread.
- **P2: voices always at the limit.** 40 voices are enough to avoid glitches, but the mix at the pass rate is saturated. A sound designer should tune the per-sound limits and priorities against real sounds.
- **P2: the detector counts late quanta, not glitches**, so B's count after a forced 50 ms block is 3–4 per block. Report it as quanta.
- **P2: the audio thread could not be throttled**, so B's audio-thread margin is unverified on a slower CPU.

## Rerun on the reference device

1. Build and serve the prototype as in run 1's notes: `node scripts/build-wasm.mjs`, `node scripts/build-combat.mjs`, `node scripts/build-chunks.mjs`, `node node_modules/vite/bin/vite.js build`, then `node node_modules/vite/bin/vite.js preview --port 4173 --strictPort`. Nothing else may run on the device meanwhile.
2. Use the device's built-in speakers or a wired headset as the default output, at 48 kHz.
3. Run `node scripts/run2/stage10.mjs --validate --throttle 1 --out results/run-2/data/stage10-ref/`. It takes about 2.8 hours. Keep `--busy 4`: on the reference device it stands for 4 ms of rendering and snapshot work per frame, which is more than Stage 11's measured main-thread time per frame at 4× (p99 about 2 ms).
4. Print the tables with `node scripts/run2/stage10-table.mjs results/run-2/data/stage10-ref/`.
5. Pass: B with 0 late renders and 0 underruns at the pass rate with stalls, B's main-thread p99 under 0.5 ms, the latency bars as above, and B's `process()` load (column "B load") well under 0.5 of a quantum.
