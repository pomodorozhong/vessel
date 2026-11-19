# Stage 6: chunk catch-up and saves

Verdict: **provisional**. On the dev machine the three pass-bar numbers hold: no mismatch in 30.5 million property-test operations (after fixing three holes the test found in the protocol as first written), a week-old chunk catches up in about 0.1 ms of worker time (the player needs 12.8 s under the stated assumption), and a save costs 0.14 ms of work in the sim worker (with the 64-record slab layout; one other layout misses the bar, see below). "Saves survive the browser" is only partly measured: `persist()` was refused in both fresh automation profiles, quota errors behave as described below, but real disk-pressure eviction, Safari's 7-day rule, Firefox and macOS Dock web apps are **unmeasured**. Everything that depends on the reference laptop is provisional until rerun (steps at the end).

Where "dev machine" appears: Intel i7-13700 (16 cores / 24 threads), 64 GB, RTX 3060, Windows 11 Pro 10.0.26200. Browser numbers: Chrome 156.0.8078.73 (and Edge 157.0.4341.60 for storage), headed, production `vite build` served by `vite preview` on port 4176 (COOP/COEP sent, so `performance.now()` resolution was 5 µs), no CPU throttling. Native numbers: Rust 1.94.1, `--release`, 4 threads.

## What was built

- `prototype/chunks` (Rust, `["cdylib","rlib"]`, no dependencies): chunk state (64 crop plots with 4 stages and spoilage, 8 furnaces with fuel, input, output cap and smelting progress), three event kinds from a stub summary sim (raid: destroys crops at even plot indexes, steals half of each furnace's output, adds fuel and input to one furnace; replant; supply), `replay` (every tick) and `catch_up` (closed form per span between events, O(events + plots + furnaces)), all integer math. `world.rs` is the catch-up protocol as a state machine driven by explicit operations (`start_job`, `finish_job`, `activate`, `deactivate`, `record_event`, `advance`). `harness.rs` is the property test with a hand-written delta-debugging shrinker. `ffi.rs` exports plain `extern "C"` functions plus memory (no wasm-bindgen); 38 KB `.wasm`.
- `prototype/stage6/` + `stage6.html`: job worker (catch-up and replay on transferred buffers), stand-in sim worker (owns stored chunk buffers and the active area), save worker (one blob, one IndexedDB transaction), blob format with a checksum, export (download of the same blob) and import (file back, validated), storage probes. Scripts: `scripts/build-chunks.mjs`, `scripts/stage6-property.mjs`, `scripts/stage6-run.mjs`.
- Tests: `cd prototype/chunks && cargo test --release` (7 property tests + 2 model tests + 3 hand-written minimal cases for the holes, about 5 s; `PROP_CASES` / `PROP_SEED` scale it). Long run: `node scripts/stage6-property.mjs 1000000 4 fixed`.

## 1. Property test (native, dev machine, Rust 1.94.1 release, 4 threads)

The test: random operation sequences (advance time by 1 to 22,000 ticks, start job, deliver a pending job result in random order, record event, activate, deactivate, player jump activating several chunks at once) over 1 to 6 chunks of 4 plots and 2 furnaces with tiny durations (stages 5/9/13 ticks, spoil 17, smelt 4, cap 6) so every transition is hit often. The reference is a world that steps every tick of every chunk. After every activation the chunk is compared with the reference (whole struct, exact); at the end of a case every chunk is activated and compared. Failing cases are shrunk (drop operation chunks, shrink numbers and chunk count, smallest initial-state seed).

| Configuration | Cases | Operations | Mismatches | Wall | Smallest failing case (operations) |
|---|---|---|---|---|---|
| **Fixed protocol, long run** (`stage6-property-fixed.json`) | 1,000,000 | 30,512,704 | **0** | 62.5 s | none |
| Protocol as first written ("literal") | 100,000 | 3,050,638 | 36,847 | 4.5 s | 1 op: record an event at tick 0, then wake the chunk |
| Only fix 1 on (hole 3 left) | 100,000 | 3,050,638 | 792 | 5.4 s | 6 ops: `Advance(1) StartJob(0) Event(supply) StartJob(0) Deliver(5) Deliver(0)` |
| Only fix 2 on (holes 1 and 2 left) | 100,000 | 3,050,638 | 36,744 | 4.1 s | 1 op, as in "literal" |
| Mutation: generation check off, everything else fixed | 100,000 | 3,050,638 | 0 | 5.2 s | none (see finding below) |
| Mutation: generation check and monotonic accept both off | 100,000 | 3,050,638 | 2,461 | 5.7 s | 6 ops: `Advance(1) StartJob(0) Jump([2]) Event(raid) Jump([1]) Deliver(0)` on 2 chunks (a stale result from before an activation and deactivation is accepted and wipes out the live event) |
| Mutation: accept drops every event up to `to_tick` instead of the consumed ones | 100,000 | 3,050,638 | 6,273 | 5.4 s | 4 ops: `Advance(1) StartJob(0) Event(supply) Deliver(0)` |

Raw output: `results/data/stage6-property-*.json` (the initial chunk states and every operation of each smallest case are in the `smallest` field). Seeds are `1 ..` per run, split into per-thread blocks. The mutation checks prove the test can fail: both mutations are found and shrunk, and `cargo test --release` asserts that.

### Holes found in the protocol as specified, and the fixes

The protocol as first written: a job copies the chunk and the events with `last_tick < tick <= now`; an accepted result (generation equal, chunk still stored) replaces the state, sets `last_tick = to_tick` and drops the events it consumed; `deactivate` stores the chunk with `last_tick = now`. Tick order is: step, then apply events stamped with that tick.

1. **Event stamped with the same tick as a captured state is lost.** Smallest case (hand-written in `tests/prop.rs`): advance to tick 3, start a job (to_tick 3), record a raid stamped 3, deliver the job, advance, wake the chunk. The job did not take the raid (it arrived after the copy), and afterwards `last_tick = 3`, so the next catch-up's `last_tick < tick` filter skips it. Fix (`inclusive_bound`): take events with `last_tick <= tick`. This is safe because consumed events are removed by identity, so nothing is applied twice.
2. **Same cause through `deactivate`.** Wake a chunk at tick 3, deactivate it (`last_tick = 3`), then record an event stamped 3: lost the same way. Same fix. (The 1-operation case above is the same hole at tick 0.)
3. **A late, older job result rolls the chunk back.** Job A starts at tick 2, job B at tick 4 after a raid; B is delivered first and accepted, then A (same generation) is accepted and replaces the state with the older one, so the raid is gone. Fix (`monotonic_accept`): accept only if `to_tick > last_tick`.

**Finding: once fix 3 is in, the generation number is redundant in this model.** With the generation check disabled and everything else fixed, 3 million operations find no mismatch: `activate` and `deactivate` always move `last_tick` to the current tick, so any older job's `to_tick` is at or below `last_tick` and is already rejected. The generation check matters only if the monotonic rule is absent (the last-but-one mutation row). I kept both in the code; the real game may keep both as belt and braces or drop one. This holds for this protocol only (all events are routed through the single writer).

## 2. Catch-up job times (browser, dev machine)

Chunk: 64 plots + 8 furnaces (656 bytes) with game-scale durations (crop stages 5/10/15 min, spoil 30 min, 10 s per item, 30 ticks/s). Events spread uniformly over the age. One job worker, 10 warm-up runs discarded, then 200 runs per catch-up case (n = 200), median and 99th percentile. "Worker compute" = copy the chunk and events into WASM memory, run, copy back, timed inside the worker with `performance.now()` (5 µs resolution, so values of 0.000 mean "under the timer step"; the "amortized" column repeats only the WASM call 20 times and divides, to see below the timer step). "Round trip" = main thread `postMessage` with transferred chunk and event buffers to the job worker and the transferred reply received back. Raw: `results/data/stage6-jobs-chrome.json`.

| Age (ticks) | Events | Catch-up compute median / p99 (ms) | Amortized WASM call (ms) | Catch-up round trip median / p99 (ms) | Replay compute median / p99 (ms), runs | Replay = catch-up result |
|---|---|---|---|---|---|---|
| hour (108,000) | 0 | 0.000 / 0.010 | 0.0005 | 0.045 / 0.160 | 5.36 / 6.25, n=200 | yes |
| hour | 10 | 0.000 / 0.010 | 0.0018 | 0.065 / 0.165 | 6.05 / 6.65, n=200 | yes |
| hour | 1,000 | 0.140 / 0.170 | 0.141 | 3.03 / 3.70 | 6.32 / 7.69, n=200 | yes |
| day (2,592,000) | 0 | 0.000 / 0.005 | 0.0005 | 0.035 / 0.080 | 108 / 115, n=200 | yes |
| day | 10 | 0.000 / 0.005 | 0.0015 | 0.060 / 0.265 | 117 / 123, n=200 | yes |
| day | 1,000 | 0.140 / 0.200 | 0.139 | 2.96 / 3.52 | 144 / 153, n=200 | yes |
| week (18,144,000) | 0 | 0.000 / 0.005 | 0.0005 | 0.035 / 0.275 | 759 / 807, **n=20** | yes |
| week | 10 | 0.000 / 0.005 | 0.0015 | 0.060 / 0.150 | 794 / 883, **n=20** | yes |
| week | 1,000 | 0.115 / 0.210 | 0.114 | 2.46 / 4.28 | 992 / 1,192, **n=20** | yes |

- Replay of a week was run 20 times, not 200: one run takes about a second, and 200 runs x 3 cases would have cost 10 minutes of a window on a shared machine. The p99 of 20 runs is effectively the maximum.
- Replay in the browser is the same Rust code compiled to WASM, so the comparison is fair on the language, and every replay result matched its catch-up result byte for byte (9 of 9 cases, n = 20 to 200 each).
- Round trips with 1,000 events are about 3 ms and not the 0.14 ms of compute; I did not investigate where the remaining 2.8 ms goes (messaging of the 16 KB events buffer is the likely part). It is irrelevant to the bar.

**Pass-bar check, with the assumptions stated here:** player speed 5 units/s, chunks 32 units wide, jobs start when a chunk is 2 chunks outside the active radius, so a job has 2 x 32 / 5 = **12.8 s** before the player can reach the chunk. The slowest measured week-old catch-up round trip is a 4.28 ms p99 (1,000 events), 3,000 times under 12.8 s. Fast travel and save loading catch up inline in the sim worker: the same compute, with no message, is 0.21 ms at p99 for a week-old chunk with 1,000 events, against the 33 ms step budget. What replay would cost: about 1 s per week-old chunk in a worker (that also fits 12.8 s for one chunk, so direct calculation is not needed for a single chunk, it is needed for scale: waking 4,096 stored chunks after a week would be about 4,096 x 1 s = 68 minutes of worker time by replay (computed from the median above, not measured) versus about 4,096 x 0.12 ms = 0.5 s by catch-up (computed the same way)).

## 3. Limits found (pushing past the bars; browser, dev machine, n = 50 runs each, `stage6-jobs-chrome.json` `limits`)

| Case | Worker compute median / p99 (ms) | Round trip median / p99 (ms) |
|---|---|---|
| week, 64+8, 10,000 events | 1.17 / 2.19 | 4.82 / 8.40 |
| week, 64+8, 100,000 events | 15.5 / 22.1 | 61.6 / 80.2 |
| week, 64+8, 1,000,000 events | 142 / 166 | 572 / 652 |
| week, 1,024 plots + 128 furnaces, 1,000 events | 1.33 / 2.26 | 5.43 / 11.1 |
| week, 16,384 plots + 2,048 furnaces, 1,000 events | 21.2 / 38.6 | 85.8 / 118 |
| 1 game year (946,080,000 ticks), 64+8, 1,000 events | 0.080 / 0.135 | 0.365 / 0.620 |
| 100 game years (94,608,000,000 ticks), 64+8, 1,000 events | 0.080 / 0.105 | 0.340 / 0.395 |

- Age does not matter: a hundred game years costs the same as a week (the cost is O(events + plots + furnaces)). The only limit is the integer range (u64 ticks, u32 fuel and item counts).
- Cost is about 0.14 microseconds per event; the inline 33 ms step budget breaks somewhere between 100,000 events (22 ms p99) and 1,000,000 (142 ms), not located more exactly. A realistic raid log is far below this. The 12.8 s window is never close to breaking, even with a million events (652 ms round trip p99).
- Chunk size: a 16,384-plot chunk with 2,048 furnaces (about 0.3 MB) costs 38.6 ms p99 inline, which is over the 33 ms step budget, though still tiny against 12.8 s. Chunks in the game should stay far below this.
- The 5-minute steady-speed rule from the plan targets frame and sim-step time; a catch-up job is a one-shot computation, so these runs are counts of repeated jobs (n above) and not 5-minute runs.

## 4. Saves (browser, dev machine)

Large world (my choice): 4,096 stored chunks (64 plots + 8 furnaces, each record 792 bytes: chunk, up to 8 pending events) = 3,244,032 bytes; 25 active chunks (656 bytes each) and 10,000 entities x 32 bytes = 336,400 bytes of active area; the whole blob is **3,580,484 bytes**. Per save the sim worker copies the active area and posts buffers to the save worker over a `MessageChannel` (the main thread is not involved); the save worker copies everything into one blob, returns the sim's buffers, computes a checksum and writes the blob in one IndexedDB transaction (default durability). 110 saves per layout after 10 warm-ups. Raw: `results/data/stage6-saves-chrome.json`.

How the sim holds its stored chunks changes the sim-side cost, so three layouts were measured:

| Layout (what the sim posts) | Sim-side work per save, median / p99 (ms) | Save worker: copy+checksum median / p99 (ms) | Buffers held by the save worker, median / p99 (ms) | IndexedDB write median / p99 (ms) | Save worker total median / p99 (ms) |
|---|---|---|---|---|---|
| **64 slabs of 64 records, transferred (returned after the copy)** | **0.14 / 0.26** | 1.56 / 2.05 | 0.64 / 1.02 | 14.2 / 35.3 | 15.9 / 36.7 |
| 4,096 one-record buffers, transferred | 3.47 / 5.06 (fails the 1 ms bar) | 5.66 / 6.86 | 0.73 / 1.10 | 14.6 / 25.0 | 20.3 / 31.3 |
| one 3.2 MB buffer, copied by `postMessage` (no transfer) | 0.56 / 0.73 | 1.35 / 1.67 | 0.47 / 0.73 | 14.2 / 23.7 | 15.5 / 25.1 |

(In every layout 0.04 to 0.08 ms of the sim-side figure is the copy of the 336 KB active area.) The sim-side bar (< 1 ms) holds for the slab layout and the single copied buffer and fails for one buffer per chunk: the cost of detaching thousands of transferables dominates. So the design rule that comes out of this: keep stored chunks in a few slabs (64 here), not one buffer per chunk. While a save runs, the sim cannot touch the slabs the save worker holds; they come back after about 0.6 ms (p99 1.0 ms), before the disk write starts, so an accepted job result only has to wait that long. I did not build that deferral in the stand-in sim.

- **Load** (20 loads, save worker): IndexedDB read 4.84 ms median / 9.35 ms p99, checksum verify 0.83 / 0.91 ms, split into 64 slabs + active area 1.13 / 1.75 ms; main-thread round trip including transferring the result 7.10 / 11.9 ms.
- **Export / import round trip** (`stage6-roundtrip-chrome.json`): the exported file is the same blob (3,580,484 bytes). SHA-256 of the blob in IndexedDB before export, of the downloaded file, and of the IndexedDB blob after clearing the database and importing the file are **identical** (byte-identical round trip). An import of a copy with one flipped byte is rejected ("checksum mismatch") and does not overwrite anything.
- Sizes: the 3.58 MB blob occupied 1.81 MB in Chrome's storage estimate (Chrome compresses it; the filler entity data and zeros are compressible, so a real save would compress less).

## 5. Storage (browser, dev machine; fresh automation profiles)

| Check | Chrome 156.0.8078.73 | Edge 157.0.4341.60 |
|---|---|---|
| `navigator.storage.persisted()` before | false | false |
| `navigator.storage.persist()` result | **false** (not granted) | **false** |
| `estimate()` quota / usage before any write | 10,737,418,240 / 0 | 10,737,418,240 / 0 |
| usage after one save (3,580,484-byte blob) | 1,811,223 | 1,811,225 |
| Empty origin, quota forced to 1 MB (CDP `Storage.overrideQuotaForOrigin`), save written | fails: transaction error `QuotaExceededError` (empty message); no record written, load finds nothing | same |
| Origin already holding a save, quota then forced to 1 MB (below the stored 1.8 MB), same-key overwrite with a new 3.6 MB save (same session, after reload) | succeeds both times; the old record is replaced; existing data stays readable | same |
| Same, quota 4 MB | succeeds | same |
| `Storage.clearDataForOrigin` (indexeddb) then load | save not found, no error (what the game would see after its database was deleted) | same |

Notes: both profiles are fresh automation profiles, and Chrome's `persist()` decision is heuristic (site engagement, bookmarks, installation), so "refused" here says nothing about real players; it only confirms the game cannot count on being granted. The override was applied in a fresh session; an overwrite that does not increase usage was not blocked, a first write into a too-small quota was. `estimate().quota` did not reflect the override (it stayed 10.7 GB while `Storage.getUsageAndQuota` showed the override), so the game must rely on write errors, not on `estimate()`. `clearDataForOrigin` is a simulated deletion, **not** a measurement of browser eviction. The `404` the page reports once per run is the missing favicon. Raw: `stage6-storage-chrome.json`, `stage6-storage-edge.json`.

Unmeasured, with rerun steps below: real eviction under disk pressure (Chrome, Firefox), `persist()` on a real profile, Safari's 7-day rule, Firefox, whether a macOS Dock web app keeps its storage.

## Assumptions

- 30 ticks/s; game-scale durations as listed above; 64 plots + 8 furnaces per realistic chunk; events uniform over the age.
- Player speed 5 units/s, chunks 32 units wide, job started at 2 chunks outside the active radius: 12.8 s window. Fast travel = inline catch-up in the sim worker, compared to a 33 ms step budget.
- The large world and the blob layout are mine; the summary sim is a stub with three event kinds; stored events live in a fixed 8-slot record in the save layout (the in-memory protocol has an unbounded list).
- One writer (the sim worker) routes every event and every job result; job workers only compute on copies.
- Tick order: step, then events stamped with the tick; an event for an active chunk is applied immediately after the current step.

## Verdict and fallback

Hypothesis: "catch-up by direct calculation in job workers gives the same result as replaying every step, and saves survive the browser."

- Same result as replay: **held** on the dev machine (0 mismatches over 30.5 M operations; exact comparison against a tick-by-tick reference; 9 of 9 browser WASM cases agree). The protocol as first written failed (3 holes), and the fixed one holds. This part does not depend on hardware.
- Week-old chunk finishes before the player can reach it: **held** on the dev machine (4.28 ms p99 round trip against 12.8 s). Provisional only in the sense that the reference laptop is slower; the margin is more than 2,000x.
- Save under 1 ms in the sim worker: **held** on the dev machine for the slab layout (0.14 ms median, 0.26 ms p99) and the single-buffer copy (0.73 ms p99), **failed** for one buffer per chunk (5.06 ms p99). The layout rule above is the result.
- "Saves survive the browser": **unclear**: export/import round trip works and `QuotaExceededError` is observable, but `persist()` was not granted in the automation profiles, and eviction, Safari, Firefox and the Dock web app were not measured.

Overall: **provisional**. No fallback is triggered (none of the measured bars failed except the one-buffer-per-chunk layout, which is a design choice). If a reference-device rerun failed the catch-up or save bars, the fallback is the plan's: simplify the catch-up rules, for example freeze chunks that have pending events until they are activated (that would remove job results and events from the protocol, at the cost of crops and furnaces in raided chunks not progressing while away).

## Rerun steps for everything unmeasured or provisional

Reference-device run (all numbers above): on the laptop, `cd prototype && npx -y pnpm@10 install && npx -y pnpm@10 run build && npx -y pnpm@10 exec vite preview --port 4176 --strictPort`, then `VESSEL_BASE=http://localhost:4176/vessel/ node scripts/stage6-run.mjs jobs chrome`, `... saves chrome`, `... roundtrip chrome`, `... storage chrome` (adjust the Chrome path in `scripts/browser.mjs` if needed), and `cd chunks && cargo test --release` plus `node scripts/stage6-property.mjs 1000000 4 fixed`. Compare with `results/data/stage6-*.json`. To check the throttled case, repeat the browser runs with Chrome's CPU throttling (the page and workers; `scripts/browser.mjs` has `throttle()`).

- **Safari 7-day rule (macOS):** open `stage6.html` served over https or localhost in Safari, press "Saves (short)" once so a save exists, then move the system date forward 8 days (System Settings, Date and Time, turn off automatic) while keeping Safari open or restarting it, open the page again without interacting in between, and press nothing before checking whether a load finds the save (`stage6.loadSave()` in the console returns `found`). Record `found` and `navigator.storage.persisted()`.
- **macOS Dock web app:** in Safari, File, Add to Dock for the page, write a save in the Dock app, shift the date forward 8 days, open the Dock app and check `found`.
- **Firefox:** run steps `storage` and `roundtrip` by opening the page by hand (puppeteer is Chrome-based here): record `persist()` result (it shows a permission prompt), `estimate()`, save, export, import and checksum rejection of a corrupted file.
- **Real eviction (Chrome, Firefox):** fill the disk of a test machine until under about 10 % free (or use a VM with a small disk), keep the page's save as best-effort (do not call `persist()`), close the browser, fill more, reopen and check `found`; repeat after a granted `persist()` to see that it survives.
- **Real-profile `persist()`:** in a normal Chrome profile with the site used for a few days, call `await navigator.storage.persist()` from the console on the page.

## Added dependencies and shared files

No new dependencies (Rust: none; Node: none; the shrinker is hand-written). Shared files touched with one-line edits: `prototype/vite.config.ts` (second Rollup input `stage6.html`), `prototype/package.json` (`build` also runs `scripts/build-chunks.mjs`), `prototype/tsconfig.json` (`include` adds `stage6`), `prototype/.gitignore` (`chunks/target`).
