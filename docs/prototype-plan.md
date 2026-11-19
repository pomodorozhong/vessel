# Prototype plan

The prototype is throwaway code that tests the riskiest bets in [tech-direction.md](tech-direction.md) on real hardware. It is not the start of the game: nothing in it has to be clean, and anything it proves gets rewritten properly later. Its output is numbers and a short report, and the tech direction is updated from them.

## Ground rules

- Test on the reference device: a mid-range Android phone a few years old, in Chrome. Also check a desktop in Chrome and an iPhone in Safari for anything that differs by browser.
- Every test records its numbers in the debug overlay and in a results table under `prototype/results/`, so results can be compared across changes.
- Fix the test scene before starting: decide side-view or top-down (the open question in the tech direction). The default is top-down if no decision is made, since it stresses rendering and crowds harder.
- Optimize for findings, not speed. Where a stage can test an alternative cheaply, build both and compare, including options the tech direction ruled out, so each decision rests on a measurement rather than an argument.
- Push every test past its pass bar to find where it breaks (entity count, frame rate, delay), so the doc records the real limit, not just that the target was met.
- A stage that fails its pass bar triggers its fallback decision, not more tuning, unless the miss is small and the cause is obvious.

## How it runs

The whole plan runs in one pass by one agent, from Stage 0 to the Stage 7 review, without stopping for questions. Choices the plan leaves open take their stated defaults.

- Code goes under `prototype/`, results under `prototype/results/` (one `stage-N.md` per stage and a `report.md`), all on one branch, `prototype/run-1`, with a commit after each stage and one PR at the end.
- Independent stages run in parallel as subagents in separate worktrees and are merged back into the branch.
- The agent has no phone. It measures in a real browser with WebGPU on its own machine, and approximates the reference phone with Chrome's CPU throttling (4x to 6x), a 30 fps frame cap, and a lower resolution. Every number is labeled "desktop" or "desktop, throttled", never presented as a phone result.
- A verdict that depends on the real phone (heat, mobile GPU limits, mobile Safari) is marked "provisional", and the results file gives exact steps for a person to rerun it on the phone. Anything that cannot be measured is said to be unmeasured, never guessed.
- Each `stage-N.md` holds the results table, the limits found, the verdict (held, failed, unclear, or provisional), and the fallback that applies if it failed.

## Stage 0: skeleton

Goal: the smallest app that has every moving part connected, so later stages measure real costs.

- Vite + TypeScript app deployed to GitHub Pages from an Actions workflow, with the `/vessel/` base path.
- WebGPU startup check (`navigator.gpu`, adapter, device) and a "not supported" page.
- A Rust crate built to WASM with SIMD, compiled on the main thread from an inline script and sent to a worker.
- The worker steps an empty sim at 30 Hz and sends a snapshot buffer to the main thread; the main thread clears the canvas each frame.
- Debug overlay: frame time, sim step time (reported by the worker), GPU time from `timestamp-query` where available, and the snapshot queue length.

Done when the page loads on all three devices and the overlay shows numbers.

## Stage 1: does the sim fit its budget?

Hypothesis: a single-threaded Rust/WASM sim in one worker steps a few thousand entities within 4 ms per step on the reference phone.

Build:
- Struct-of-arrays entity tables in WASM memory: position, velocity, facing, kind, radius.
- Movement, circle collision with a spatial hash grid, and entities sorted by grid cell each step.
- One flow field toward the player on a grid, rebuilt incrementally when the player crosses a cell.
- Simple AI: each enemy follows the flow field and "thinks" a few times per second, staggered.
- Static obstacles on the grid (walls, trees) that entities collide with.

Measure, at 1,000, 2,000, 5,000, and 10,000 entities:
- Sim step time: median and 99th percentile, after 5 minutes of running (to include heat).
- The share of step time in collision, flow field, AI, and snapshot writing.
- WASM SIMD on versus off, to confirm SIMD is worth it.

Pass: 2,000 entities at a 99th percentile under 4 ms on the reference phone after 5 minutes.

Also compare:
- The same sim written in careful typed-array TypeScript, to measure what Rust/WASM actually buys (the tech direction ruled the TypeScript sim out without numbers).
- The sim on the main thread instead of a worker, to measure what the worker costs in delay and gains in frame time.

If it fails: first cut the entity target or the step rate. If that is not acceptable, the single sim thread is the bottleneck, so reconsider GitHub Pages (a host with COOP and COEP allows a multithreaded sim) before reconsidering Rust.

## Stage 2: are snapshots smooth?

Hypothesis: worker snapshots plus interpolation in the vertex shader give smooth motion at 60 fps and at 30 fps, with a fixed buffer pool and no allocation in the game loop.

Build:
- Snapshot entries with start and end positions and facing, and start and end ticks per snapshot.
- Transfer of snapshot buffers with a fixed pool, a waiting queue, and a render clock that runs behind the newest snapshot.
- Simple instanced rendering of the Stage 1 entities (one mesh per kind, no culling yet) so motion can be seen.
- Test switches in the overlay: cap the frame rate at 30 fps, add random delay to the worker's messages (0–20 ms), and force a main-thread stall (100 ms, 500 ms).

Measure:
- Pauses (frames where entities hold at the end of a snapshot) and jumps per minute, in each test setting.
- Display delay from input to the player moving on screen.
- Snapshots skipped by the worker and dropped by the main thread.
- Allocations during the game loop (Chrome's memory tools), which should be zero apart from the `postMessage` cost.

Try at least two designs and compare them on the numbers:
- A: the tech direction's design (queued snapshots, render clock steered toward a fixed lag).
- B: a simpler one (the main thread keeps only the latest two snapshots and interpolates between them, with the clock following the newest).

Pass: no visible pauses or jumps at 60 fps or 30 fps with up to 20 ms of delay added, recovery within one second after a stall, and an input-to-screen delay under about 100 ms.

Output: the lag, queue size, and pool size to use, and which design wins. These go back into the tech direction as measured values.

If it fails: rendering the player character from its own latest state instead of the interpolated snapshot is the first fix for delay. If motion is still not smooth, consider running the sim on the main thread for the player only.

## Stage 3: does GPU-driven rendering pay off?

Hypothesis: compute culling, `drawIndirect`, and render bundles keep CPU time per frame small and flat as entity count grows, and stay within the GPU budget on the reference phone.

Build:
- All instances in a few large GPU buffers, uploaded once per snapshot.
- A compute pass that culls against the camera and writes per-kind, per-layer ranges and draw counts, with `firstInstance` kept at 0.
- Render bundles that replay the fixed list of indirect draws.
- Realistic content: 10–20 kinds, three layers (foreground, play plane, background), packed vertex attributes, one texture atlas, baked ambient occlusion plus one sun, blob shadows.
- A crowd animation using vertex animation textures for one enemy kind.
- For comparison: a plain path that draws the same scene with one instanced draw per kind and CPU culling.

Measure, at the Stage 1 entity counts:
- CPU time to encode and submit a frame, GPU-driven versus plain.
- GPU time per frame, and frame time at the device's native resolution and at the pixel-ratio cap.
- The real draw-call count with every kind and layer present.
- Frame time after 10 minutes, to include heat.

Pass: the frame fits about 60% of 16.7 ms (60 fps) on the reference phone with 2,000 entities, CPU encoding stays under 2 ms, and GPU-driven rendering beats the plain path by a clear margin at the higher counts.

Also compare the same scene in Three.js with its WebGPU renderer and instancing, to measure what owning the renderer gains over the main ruled-out option.

If it fails: if the plain path is as fast, drop compute culling and render bundles and keep plain instancing, which is simpler. If the GPU is the limit, lower resolution and overdraw first, then the target entity count.

## Stage 4: is raw WebGPU reliable enough?

Hypothesis: a raw WebGPU renderer with no fallback starts, recovers, and fails cleanly on the target browsers.

Test:
- Startup on Chrome (desktop and Android), Safari (macOS and iOS), and Firefox, recording which features each adapter offers (compressed texture formats, `shader-f16`, `timestamp-query`).
- A lost device, forced with `device.destroy()` from a debug button and by hiding the tab for a long time on a phone: the game must rebuild and keep running.
- A browser without WebGPU, or with it turned off: the "not supported" page must show.
- A rough count of how many of the people we expect to play have WebGPU, from public browser support data.

Pass: the game runs on current Chrome and Safari on all three test devices, recovers from a lost device without a reload, and shows the "not supported" page everywhere else.

If it fails: if too many target players lack WebGPU, revisit the "no WebGL fallback" decision before writing more renderer code.

## Stage 5: startup and hosting

Hypothesis: the game starts quickly from GitHub Pages, and a deploy does not break a running tab.

Test:
- Time to first frame on the reference phone over a throttled connection (Chrome's "Fast 4G"), cold and with a warm service worker cache.
- Whether Pages compresses `application/wasm`; if not, the gzipped `.wasm` path with `DecompressionStream`.
- Texture size with and without RDO encoding, gzipped, per GPU format.
- A deploy while a tab is open and loading new chunk assets: no failed requests for the previous build's files, and the save-and-reload prompt for a build two deploys old.

Pass: first frame within about 3 seconds on a cold load over Fast 4G, under 1 second when warm, and no broken tab after one deploy.

If it fails: reconsider the asset formats before reconsidering the host. If deploys cannot be made safe on Pages, that is a reason to move to Cloudflare Pages or Netlify.

## Stage 6: chunk catch-up and saves

Hypothesis: catch-up by direct calculation in job workers gives the same result as replaying every step, and saves survive the browser.

Build:
- Stored chunks with time-based systems (crop growth, smelting, fuel), an event list from a stub summary simulation (raids), and catch-up jobs in job workers.
- A property test that runs random orders of job starts, job returns, events, chunk activations, and player jumps, and checks every activated chunk against a reference that replays every step.
- Saves through a save job worker to IndexedDB, with export and import.

Measure:
- Mismatches found by the property test, and the smallest failing case for each.
- Catch-up job time for a chunk left alone for an hour, a day, and a week of game time.
- Save time and size for a large world.
- Whether `navigator.storage.persist()` is granted on each test browser, and how storage eviction behaves (Chrome's storage pressure tools, Safari's 7-day rule with a shifted clock where possible).

Pass: the property test finds no mismatch over a long run, catch-up for a week-old chunk finishes before the player can reach it at full speed, and a save takes under one sim step of work in the sim worker.

If it fails: simplify the catch-up rules (for example, freeze chunks that have pending events until activated) before adding more machinery.

## Stage 7: review the results

Once every other stage is done, the agent reviews its own results against these rules (and a person can review the PR the same way), so reviews settle decisions instead of going in circles the way prose-only reviews of the tech direction did.

Why the prototype exists, which the review and the tech direction update should keep in mind:
- The tech direction went through about eight rounds of review, and every round found two or more P1s. Almost all of them were in three areas: the snapshot hand-off between the sim worker and the main thread, chunk catch-up, and deploys on GitHub Pages.
- Each fix added rules (generation numbers, more queue slots and buffers, extra deploy steps), and the next review found an edge case in those new rules. One fix was later reversed (keeping old builds on a branch).
- The core decisions held steady through every round: raw WebGPU, a Rust/WASM sim in a worker, GitHub Pages, and owning the runtime. The loop came from writing concurrent protocols in prose, which cannot be checked, and from reviews with no clear bar for P1.
- So the tech direction was cut back to decisions and intent, and the prototype settles the protocols and the riskiest bets with measurements, including against the options the doc ruled out.

When updating the tech direction from the results:
- Record decisions, measured limits, and the reason for each, not protocols. A protocol that was settled in the prototype is described in a sentence or two, and its exact rules live in code and tests.
- Keep the core decisions unless a result shows they fail; do not reopen them on argument alone.
- Where a ruled-out option won, change the decision and say what number changed it.

What to check:
- Every number comes from the reference phone (or the named device), with the build, browser version, entity count, and test settings next to it, so anyone can rerun it.
- Each hypothesis has a verdict (held, failed, or unclear), and the verdict follows from the numbers and the pass bar, not from impressions.
- A failed hypothesis leads to the fallback decision written in its stage, or the PR says why it does not.
- Comparisons are fair: both sides were built with the same care, measured the same way, and on the same scene. A ruled-out option that wins should change the decision.
- Each change to `tech-direction.md` traces back to a result in the report. Nothing else in the doc changes in this PR.
- Limits found by pushing past the pass bars are recorded, so later work knows the headroom.

How to rate findings:
- P1: a result is missing, wrong, or not reproducible, or a decision in the tech direction is kept or changed against what the numbers show. These block the PR.
- P2: a measurement is weaker than it should be (too short, too few runs, missing a device), but the verdict would likely stand. Fix it if cheap, otherwise note it.
- Not a finding: edge cases in how the real game will implement a system. Those belong in that system's own code and tests, not in this review or the tech direction.

How to run the review:
- Give the reviewer this section, the report, and the results tables, not just the diff.
- A finding must name the result or decision it is about and what would change if it were fixed.
- If a second review finds P1s only in areas the first review's fixes touched, stop reviewing and rerun the measurement instead.

## Order

Stage 0 comes first, since every other stage builds on it. After that, run every stage that does not need another's result at the same time: Stages 1, 4, 5, and 6 are independent, Stage 2 needs Stage 1's entities, and Stage 3 needs Stage 2's snapshots. Stages 1 to 3 are the ones most likely to change the direction. Stage 7 runs last, once every other stage has results.

## Output

- A results file per stage in `prototype/results/`, with every number labeled by where it was measured.
- `prototype/results/report.md`, one page: each hypothesis's verdict and the numbers behind it, the limits found, which ruled-out options won or lost, the P1 and P2 findings from Stage 7, and the phone runs still needed.
- One PR from `prototype/run-1` with the prototype, the results, and the updates to `tech-direction.md` that the results call for.
