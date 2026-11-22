# Prototype report (run 2: full load)

Everything here was measured on the **dev machine**: Intel Core i7-13700, 64 GB, NVIDIA RTX 3060, Windows 11 Pro 10.0.26200, Chrome 156.0.8078.73, headed, on local production builds served with COOP/COEP. "Throttled" means Chrome's 4× CPU throttling. It reaches the page's main thread only, not workers or the audio thread, and nothing can slow the GPU. **No reference device was available, so every verdict is provisional**, and each stage file ends with exact steps to rerun it there. Details, tables, raw data, media and rerun steps are in `stage-8.md` to `stage-11.md`.

## Verdicts

| Stage | Hypothesis | Verdict | Numbers behind it (dev machine) |
|---|---|---|---|
| 8 | The sim handles combat (2,000 enemies, 1,000 projectiles, buildings, area effects) in 4 ms p99 per step | **provisional fail** | Throttled 4× on the main thread: p99 5.11 ms (A), 4.58 (B), 4.98 (C), over the bar. In a worker, unthrottled: p99 2.27–2.62 ms. 0 projectiles passed through anything in 3.9 million checked sweeps per method. |
| 9 | The cel-shaded look fits 60% of 16.7 ms at 1080p under combat load, encoding under 2 ms | **provisional pass, GPU half unverified** | Full look, 2,000 enemies, 1,000 projectiles, 10,000 particles: encode p99 1.83 ms throttled; GPU median 3.83 ms, p99 6.17 ms on the RTX 3060, which says nothing about integrated graphics. |
| 10 | Our own mixer plays dense combat sound cleanly, in time, with little main-thread cost | **provisional pass with mixer B** | About 15,400 events/s (labelled 16,400; the stream ran 6% low, see P2), stalls, throttled: B 0 late renders, 0 underruns in every 5-minute run, main-thread p99 0.39 ms. Own sound 59–75 ms after the key press, including 48–64 ms of output latency. Event sound 9 ms after frame submit with the lead, 57–75 ms without. |
| 11 | Everything together stays smooth through a 5,000-enemy wave, every system in budget | **provisional pass for the main thread, GPU and audio; unclear for the sim** | Wave to 5,000 enemies, throttled, 3 × 5 minutes: 0 pauses, 0 jumps, 0 audio late renders, encode p99 1.42 ms, main thread p99 2.0 ms, GPU p99 6.2 ms, input to frame submit p99 17.5 ms. The sim worker cannot be throttled: p99 1.5–1.7 ms at full speed, 3.03 ms with a 2× stand-in slowdown. But the wave loads the sim about half as much as Stage 8 at the same enemy count, for a reason not yet found, so Stage 8's provisional fail is the better guide. |

Fallbacks: none applied. Stage 8's fallback is recorded for the case that the reference device confirms the miss: keep pair finding A, then cut the push passes, the live projectile count and the area-effect checks, then Stage 1's fallback (fewer entities or a lower step rate).

## Limits found

- **Sim** (Stage 8, worker, unthrottled): 4 ms breaks between 5,000 (p99 3.70 ms) and 7,500 enemies (5.80 ms) at 1,000 projectiles, and between 3,000 and 5,000 projectiles at 2,000 enemies. Throttled 4×, the pass load is already over. In Stage 11's wave (worker, unthrottled) the sim was the first budget to break: p99 over 4 ms from about 11,900 enemies, and with the 2× stand-in slowdown from about 7,000–9,000. Encoding (1.2–1.8 ms) and GPU time (5–7 ms on the RTX 3060) stayed flat up to 13,900 enemies, because the renderer culls to the screen.
- **Rendering** (Stage 9, RTX 3060): nothing broke the frame. 20,000 enemies came closest (GPU p99 9.29 ms), because every enemy is drawn into the shadow map, the world pass and the outline pass. 400,000 particles and 16× grass cost under 1 ms more. Encoding has about 10% headroom at 4× (3 of 72 runs over 2 ms, none at the pass load).
- **Effects at Stage 8's event rate** (Stage 9): about 520 explosions alive at once washed the frame out with bloom, with overdraw at a mean of 8.5 and p99 25 writes per pixel. Fixed in Stage 12 (below).
- **Sound** (Stage 10): B's main-thread cost crosses 0.5 ms at 2× Stage 8's event rate (p99 0.59 ms) and reaches 0.98 ms at 4×, from decoding and culling events on the main thread. B's worklet used 1.3% of each quantum at full speed. 40 voices were in use nearly all the time; stacking merged about 14,100 of 15,600 events a second.
- **Snapshots** (Stage 11): 117 KB mean (197 KB max) at 5,000 enemies and 523 KB at 13,900. Copying and transferring one costs under 0.1 ms in the worker. Its arrival on the throttled main thread is up to 13 ms late at the p99, which the render clock's 2-step lag absorbs: no pauses or jumps in any run. A GPU process crash mid-wave was recovered in 621 ms in one rebuild of the full look, with the sim and the audio running on.

## Alternatives

| Option | Result | Decision |
|---|---|---|
| Pair finding B (sort and sweep) and C (SIMD grid) against A (grid) | Within each other's spread at the pass load (p99 4.58–5.11 ms throttled, 2.27–2.62 ms in the worker) | A kept: the simplest |
| Rapier 2D | Lost: 3.2× slower at the pass load and 7 missed hits, where A, B and C missed none | Own collision kept; the physics decision stands |
| Outlines: inverted hull (A) against edge detection (B) | GPU total within or at the edge of the spread (3.83 against 4.34 ms median at the pass load); A needs no normal target and no post-processing pass | Hull kept, provisionally |
| Shadows: 2,048² shadow map against blob shadows | Total GPU time within the spread; the map's own pass costs 0.65–0.80 ms median, 1.6–2.2 ms p99 | Shadow map kept; blob shadows are the fallback |
| Mixer A (Web Audio nodes) against B (`AudioWorklet`) | A: 8–17 late renders per 5-minute run even without stalls, main-thread p99 1.40 ms, master peak 1.20–1.36 with up to 328,000 clipped samples. B: 0 late renders, p99 0.39 ms, peak held at 0.891 | B kept, as the plan's fallback asks when A glitches |

## Stage 12 review

Reviewed against Stage 7's rules, with the stage files and the tables in `data/`.

P1, fixed in this PR (commit `42dd8de`, verified on the dev machine):

1. **The effects at Stage 8's event rate buried the look** (Stage 9). Now only the 64 explosions nearest the player are drawn, from a fixed ring, and dimmer (core 3.0 → 1.6, ring 2.2 → 1.3). Health bars show only for hurt enemies within 14 units of the player. Rerun at the pass load and full event rate (`data/stage12/stage9/`, screenshots in `media/stage12/`, compare [before](media/stage9/sidebyside-map-day.jpg) and [after](media/stage12/sidebyside-map-day.jpg)): grass, enemies and colors are visible again, and the effects pass fell from 0.64–0.72 to 0.35 ms median. A bright core remains around the player, where the nearest explosions are (P2 below). The one 5-minute regression run had a higher GPU total median (4.23 ms against 3.29–4.01), but the passes the fix did not touch rose with it (shadow 0.99 against 0.64–0.81 ms, grass 1.39 against 0.91–1.14 ms). That points to the GPU's clock changes that Stage 9 already saw at light load, not to the fix. It is one run.
2. **Dynamic resolution flipped between two sizes every 3–7 s** (Stage 9). It now steps up only when the predicted time is under 80% of the budget (was 95%), and only 10 s after the last step down. A step down within 5 s of a step up doubles that wait, up to 60 s. Rerun 180 s at the forced 3 ms and 4 ms budgets: 15 and 17 changes, 7 of them the first descent, against 24 and 20 in 60 s before. After settling at 432p it tried 540p after 25, 45 and 70 s, about 3 changes a minute instead of 20–24.
3. **Event sounds came about one output latency after the picture** (Stage 10: 57–75 ms after frame submit without the lead, 9 ms with it). Stage 11 now fires them early by the measured pipeline delay by default.
4. **Stage 11's wave did not load the sim like Stage 8**: it added enemies at the map edge. They now spawn around the player as in Stage 8, and the wave was rerun with that and with all the fixes above (`data/stage11-dense/`). Every bar held again, and the heap stopped growing (−0.05 MB/min, against +0.52). The step time barely changed, which leaves the P2 below open.

P2 (weaker than it should be; the verdict would likely stand):

- **No reference device.** Every verdict is provisional. Throttling did not reach the sim worker, the audio worklet or the GPU, so those numbers are the dev machine's at full speed.
- **Stage 11 loads the sim about half as much as Stage 8** at the same enemy count (p99 1.66 against 3.70 ms at 5,000 enemies, unthrottled worker), even with Stage 8's spawn. Not explained yet: Stage 8 places every enemy at once while the wave adds them over 4 minutes, and the wave allocates the sim for 20,000. Stage 11's sim verdict stays unclear until this is explained or the reference device runs it.
- **A bright core remains around the player** at the full event rate, because the 64 nearest explosions are all there. Tune the count, size and bloom threshold with real art.
- **Dynamic resolution still probes**: after settling, it tries one step up every 25–70 s and drops back within 2–6 s. That is far better than before, but a device right at its budget will still see an occasional change.
- **The renderer allocates about 2.5 MB/s in `render()`** at 5,000 enemies (Stage 11's first run). The explosion fix removed part of it and the heap stopped growing, but the allocations were not sampled again.
- **Stage 10's runs carried about 6% fewer events than labelled** (found in the PR review): the r16400 runs were about 15,400 events/s, 2× about 30,800 and 4× about 61,700. B passed at all three, so the verdict stands. The stream is fixed; the runs were not repeated.
- **The mixer's main-thread cost grows with the event rate** (B over 0.5 ms from the 2× runs, about 30,800 events/s). Cull events by distance in the sim if the rate grows.
- **Stage 10's latency tracking found nothing in the first full run** (the tracking buffer filled during warm-up). Only the pass-rate runs were rerun with the fix, not the 2× and 4× runs.
- **Stage 8's throttled push-past sweep did not look below the pass load**, so the load that fits at 4× is unmeasured. Rapier 2D at 5,000 and 10,000 enemies ran 60 s × 1 instead of 300 s × 3.
- **Stage 9's push-past sweeps did not break the frame** on the RTX 3060, so the GPU breaking points are unmeasured.
- **Nobody listened to the Stage 10 recordings.** Whether A's clipping is audible, and how the mix sounds, is left to a person.
- Found and fixed during the run, not counted as findings: Stage 9 and 10 first used placeholder event rates instead of Stage 8's measured ones and were rerun; Stage 11's first smoke runs logged 39 false pauses after the bench and a 5 s input latency carried over from the warm-up; the Stage 10 `--busy` stand-in, not the mixer, made the 2.7 MB/s of allocations (60 to 73 KB/s without it).

Builds: a clean checkout of `42dd8de` built with `pnpm run build` and passed `cargo test` for both combat crates on Rust 1.94.1 (the pinned toolchain) and on stable 1.100.0, with no workarounds. The only warning (an unneeded `mut` in run 1's `sim/src/lib.rs`) is removed in this PR.

## Changes made to `tech-direction.md`, each from a result

- Stack, audio: our own mixer in an `AudioWorklet`, not one Web Audio node chain per sound. Stage 10: B had 0 late renders and a main-thread p99 of 0.39 ms; A had 8–17 late renders per 5 minutes, a p99 of 1.40 ms, and clipped.
- Threads and workers, main thread: audio only turns snapshot events into messages; the measured costs; event sounds fire early by the output pipeline delay (Stage 10: 57–75 ms late without it, 9 ms with it); the player's own sound latency (Stage 10).
- Stack, physics: Rapier 2D's measured loss (Stage 8: 3.2× slower, 7 missed hits). The decision is unchanged.
- Rendering: the look (cel ramp and rim, inverted-hull outlines, sun shadow map, grass, fog, bloom), its cost, and the cut order if the reference device misses (Stage 9); an on-screen effects budget of the 64 nearest explosions (Stages 9 and 12); dynamic resolution steps up with a wide margin and a growing hold (Stages 9 and 12).
- Single plane, camera and lighting: the shadow map replaces "blob shadows instead of shadow maps" (Stage 9: the map's pass costs 0.65–0.80 ms median, and the total was not higher than with blob shadows within the spread); the sun is cel-shaded and casts the one shadow map.
- Performance rule 11: at most two post-processing passes, bloom and the upscale; bloom is cut first (Stage 9).
- Prototype first: a pointer to this report.

The core decisions (raw WebGPU, Rust/WASM sim in a worker, GitHub Pages, owning the runtime) are unchanged. The sim budget is not changed either: Stage 8's miss is provisional, so its fallback is recorded, not applied.

## Reference-device and other runs still needed

On the reference device, each with the steps at the end of its stage file:

1. **Stage 8**: the pass load with the sim in a worker at the device's speed, A against B and C (`stage-8.md`). This decides whether Stage 8's fallback applies.
2. **Stage 11**: the wave, three times, plus the crash and past-the-bar runs, without `simslow` (`stage-11.md`). With item 1, this settles the sim.
3. **Stage 9**: GPU time on integrated graphics at the pass load, the outline and shadow comparisons there, and dynamic resolution at the real 10 ms budget (`stage-9.md`).
4. **Stage 10**: the full matrix with `--throttle 1` (`stage-10.md`), including the latency on the device's own output and B's worklet load on its CPU.
5. **Run 1's Stage 1**, at its original settings: in `prototype/`, `pnpm install`, `pnpm run build`, `pnpm exec vite preview --port 4173`; open `http://localhost:4173/vessel/?bench=stage1&sim=wasm-simd&thread=worker&n=2000&dur=300` in Chrome at 1080p and leave it in front for 5 minutes 10 seconds; read `__result.sim.hostMs` in the console. Pass: `hostMs.p99 < 4`. Repeat with `n=1000`, `5000` and `10000`, and with `sim=ts` (`../stage-1.md`).
6. **Run 1's Stage 3**, at its original settings: in `prototype/`, after the build, `pnpm exec vite preview` and `node scripts/stage3.mjs 300` in Chrome at 1080p, about 2 h 15 min (`node scripts/stage3.mjs 300 "^(gpu|plain)-n(2000|10000)$"` for the four rows that decide it). Pass: at 2,000 entities, main-thread CPU plus GPU p99 within about 10 ms, encode under 2 ms, frame time at 16.7 ms for 5 minutes. If plain instancing is within noise of the GPU-driven path at 10,000 entities, apply its fallback (`../stage-3.md`).

On any machine:

7. Explain why Stage 11's wave costs the sim half of Stage 8's at the same count (for example, run Stage 8 with its enemies added over time, or Stage 11 with all of them at the start).
8. Sample allocations again in Stage 11 after the explosion fix, and run a 30-minute hold at 5,000 enemies for memory.
9. Rerun Stage 10's 2× and 4× runs for latency, and have a person listen to the recordings.
10. Stage 11 with more projectiles (`ppe=0.4`) to bring the effects to Stage 9's worst-case density together with everything else.
11. Run 1's remaining items: Stage 2 with a gamepad, Stage 4 on macOS, Safari and Firefox, Stage 5 on real Pages, Stage 6's eviction and browser checks (run 1's `report.md`).

## Assumptions made where the plan was silent

- No reference device: Chrome's 4× CPU throttling stood in for it, as the plan allows, and every verdict is provisional.
- Stage 8: top-down scene (run 1's default); enemies start within ±64 units of the player; large enemy radius 0.45; 3 push passes; a candidate margin of 0.1 for every method; an event capacity of at least 32,768. Rapier 2D 0.36.1 was added as a dependency for the comparison, with the user's approval.
- Stage 9: inverted-hull outlines 2 internal pixels thick; a 2,048² shadow map; Stage 8's measured event rates drive the effects; dynamic resolution steps of 432–1080p. The forced 3 ms and 4 ms dynamic-resolution budgets were added because the planned ones never triggered on the dev GPU.
- Stage 10: Hades-style placeholder sounds generated by a seeded script (`scripts/run2/stage10-sounds.mjs`); a 40-voice total limit with per-sound limits and stacking; mixer B's look-ahead limiter at −1 dBFS; `--busy 4` (4 ms of main thread per frame) as the stand-in for rendering; events more than 8 steps old are skipped after a stall; the lead is the context's `currentTime − getOutputTimestamp().contextTime`, measured at start.
- Stage 11: the wave ramps from 300 to 5,000 enemies over 240 s and holds for 60 s; projectiles are 0.2 per enemy (1,000 at the peak, Stage 8's pass load); key presses about twice a second; mixer B; 2 steps of render-clock lag. The scheduler catches up at most 4 steps after a late wake-up. `simslow=2` follows Stage 8's measured ratio between the throttled main-thread sim and the unthrottled worker.
- Stage 12: the effects budget of 64 explosions and the 14-unit health-bar radius were picked by eye from the screenshots; the dynamic-resolution margins (80%, 10 s, doubling to 60 s) were picked to stop the measured 3–7 s flipping.
