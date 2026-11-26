Glitches (late = detector, same for A and B; underruns = AudioContext.playbackStats; both counted from the bench start)

| Run | Reps | Late renders (detector) | Underrun events (playbackStats) | Underrun ms | Idle band (ms) | Max excess (ms) | Stalls | Master peak | Clipped samples |
|---|---|---|---|---|---|---|---|---|---|
| A-r16400-stall | 3 | 10 [10–40] | 0 [0–0] | 0.0 [0.0–0.0] | 20.3 [18.3–21.3] | 68.3 [64.0–80.3] | 30 [30–30] | 1.262 [1.255–1.267] | 144452 [141392–146203] |
| B-r16400-stall | 3 | 0 [0–0] | 0 [0–0] | 0.0 [0.0–0.0] | 11.7 [11.3–20.3] | 11.7 [11.3–20.3] | 30 [30–30] | 0.891 [0.891–0.891] | 0 [0–0] |

Latency and offset to the picture (ms; "mapped" = getOutputTimestamp mapping, which includes the output latency; "+outLat" adds ctx.outputLatency on top)

| Run | Input to sound median (mapped) | p99 | max | Input to sound median (+outLat) | Event sound vs frame submit median (mapped) | p99 | Event offset median (+outLat) | Output latency | Base latency | Key presses |
|---|---|---|---|---|---|---|---|---|---|---|
| A-r16400-stall | 59.3 [58.9–64.5] | 70.3 [66.8–72.3] | 73.5 [70.5–75.3] | 115.3 [106.9–120.5] | 57.2 [57.1–62.4] | 67.4 [62.0–69.5] | 113.1 [105.2–118.4] | 56 [48–56] | 10 [10–10] | 617 [608–617] |
| B-r16400-stall | 73.8 [59.1–75.4] | 80.2 [72.1–83.2] | 84.2 [76.2–84.4] | 137.8 [123.1–147.4] | 72.6 [58.9–75.2] | 77.6 [71.9–80.8] | 136.6 [122.9–147.2] | 64 [64–72] | 10 [10–10] | 614 [612–619] |

Cost and voices

| Run | Main-thread audio ms/frame median | p99 | max | Frame ms p99 | B process() mean ms | B load (of a 2.67 ms quantum) | Voices median | Voices max | Started /s | Merged /s | Dropped (per-sound limit) /s | Dropped (total limit) /s | Stolen /s | Snapshot events /s | Stale events skipped |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-r16400-stall | 0.230 [0.230–0.405] | 1.410 [1.405–2.175] | 4.32 [2.89–6.28] | 17.3 [17.2–17.3] | – | – | 39 [39–39] | 40 [40–40] | 202 [202–202] | 15380 [15369–15385] | 4.0 [4.0–4.0] | 27.7 [27.6–28.0] | 131 [131–131] | 16372 [16359–16376] | 15673 [14274–19375] |
| B-r16400-stall | 0.020 [0.020–0.025] | 0.405 [0.405–0.410] | 1.96 [1.60–2.00] | 17.3 [17.3–17.3] | 0.037 [0.035–0.037] | 0.014 [0.013–0.014] | 40 [40–40] | 40 [40–40] | 202 [201–202] | 15345 [15322–15349] | 4.0 [3.9–4.1] | 27.9 [27.8–27.9] | 131 [130–132] | 16362 [16337–16366] | 19010 [17252–26054] |
