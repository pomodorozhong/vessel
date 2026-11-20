# Prototype plan

The prototype is throwaway code that tests the riskiest bets in [tech-direction.md](tech-direction.md) on real hardware. It is not the start of the game: nothing in it has to be clean, and anything it proves gets rewritten properly later. Its output is numbers and a short report, and the tech direction is updated from them.

## Ground rules

- Test on the reference device: a laptop a few years old with integrated graphics, in Chrome at 1080p. Also check Safari on a Mac and Firefox for anything that differs by browser.
- Every test records its numbers in the debug overlay and in a results table under `prototype/results/`, so results can be compared across changes.
- Fix the test scene before starting: decide side-view or top-down (the open question in the tech direction). The default is top-down if no decision is made, since it stresses rendering and crowds harder.
- Optimize for findings, not speed. Where a stage can test an alternative cheaply, build both and compare, including options the tech direction ruled out, so each decision rests on a measurement rather than an argument.
- Push every test past its pass bar to find where it breaks (entity count, frame rate, delay), so the doc records the real limit, not just that the target was met.
- Every measurement of steady speed runs for 5 minutes, in every stage, so stage results add up to one frame budget. A short run hides slow problems: a laptop slowing down when hot, memory that keeps growing, stutters that build up.
- A stage that fails its pass bar triggers its fallback decision, not more tuning, unless the miss is small and the cause is obvious.

## How it runs

The whole plan runs in one pass by one agent, from Stage 0 to the Stage 7 review, without stopping for questions. Choices the plan leaves open take their stated defaults.

- Code goes under `prototype/`, results under `prototype/results/` (one `stage-N.md` per stage and a `report.md`), all on one branch, `prototype/run-1`, with a commit after each stage and one PR at the end.
- Independent stages run in parallel as subagents in separate worktrees and are merged back into the branch.
- The agent measures in real browsers with WebGPU on its own machine, which is likely faster than the reference device. It approximates the reference device with Chrome's CPU throttling and a fixed 1080p canvas, but it cannot slow down its GPU. Every number is labeled "dev machine" or "dev machine, throttled", never presented as a reference-device result.
- A verdict that depends on the reference device (its GPU speed, a laptop slowing down when hot) is marked "provisional", and the results file gives exact steps for a person to rerun it on the reference device. Anything that cannot be measured is said to be unmeasured, never guessed.
- A provisional failure records its stage's fallback decision but does not apply it until a run on the reference device confirms the failure. A failure on the dev machine itself applies the fallback right away, since the reference device is slower.
- Each `stage-N.md` holds the results table, the limits found, the verdict (held, failed, unclear, or provisional), and the fallback that applies if it failed.

## Known pitfalls

Facts about the platform found while writing the tech direction. They hold whatever design wins, so check them before building, but they are hints, not a spec.

- WebGPU startup: `requestAdapter()` resolves to null rather than throwing when no adapter is available, and an adapter can create only one device, so recovering from a lost device needs a new adapter. A `device.lost` with reason `"destroyed"` means the game destroyed it on purpose.
- A new adapter may offer different optional features (compressed texture formats, `shader-f16`), so feature choices are made again after a lost device.
- Indirect draws: a non-zero `firstInstance` needs the optional `indirect-first-instance` feature, and without it the draw silently draws nothing.
- Dynamic storage-buffer offsets must be multiples of `minStorageBufferOffsetAlignment` (256 bytes in core WebGPU).
- Culling an interpolated entity has to cover both of its positions, or it pops in and out at the screen edge.
- A page's preloads are not shared with workers. A compiled `WebAssembly.Module` can be sent to a worker with `postMessage`.
- A `<link rel="preload" as="fetch">` needs `crossorigin` to match a later `fetch()`, or the file downloads twice.
- `mapAsync` on the current frame's data makes the CPU wait for the GPU.
- GitHub Pages cannot send COOP and COEP, so there is no `SharedArrayBuffer`, and it tells browsers to cache files for about 10 minutes. Its CDN can serve a stale copy of a file whose name does not change.
- A Pages deploy replaces the whole site, so a tab opened before a deploy loses the previous build's files unless the deploy keeps them.
- A service worker that does not call `skipWaiting` never activates while one tab keeps reloading.
- Without a custom domain, every Pages site on the account shares the `<user>.github.io` origin, and a root-scope service worker from the account's root site can control our pages.
- Safari deletes script-written storage after 7 days of use without visiting the site. On iOS, sites added to the home screen are exempt; whether a web app added to the Dock on macOS is exempt is not confirmed.
- The Gamepad API only reports a gamepad after a button is pressed on the page, and button and axis numbering differs between browsers unless the browser reports the `"standard"` mapping.

## Stage 0: skeleton

Goal: the smallest app that has every moving part connected, so later stages measure real costs.

- Vite + TypeScript app deployed to GitHub Pages from an Actions workflow, with the `/vessel/` base path.
- WebGPU startup check (`navigator.gpu`, adapter, device) and a "not supported" page.
- A Rust crate built to WASM with SIMD, loaded as early as possible and run in a worker.
- The worker steps an empty sim at 30 Hz and sends a snapshot buffer to the main thread; the main thread clears the canvas each frame.
- Keyboard, mouse, and gamepad input reach the worker as input messages.
- Debug overlay: frame time, sim step time (reported by the worker), GPU time from `timestamp-query` where available, and the snapshot queue length.

Done when the page loads from GitHub Pages in Chrome, Safari, and Firefox on the dev machine (or shows the "not supported" page where WebGPU is missing), and the overlay shows numbers. The check on the reference device is provisional, like any other.

## Stage 1: does the sim fit its budget?

Hypothesis: a single-threaded Rust/WASM sim in one worker steps a few thousand entities within 4 ms per step on the reference device.

Build:
- Struct-of-arrays entity tables in WASM memory: position, velocity, facing, kind, radius.
- Movement, circle collision with a spatial hash grid, and entities sorted by grid cell each step.
- One flow field toward the player on a grid, rebuilt incrementally when the player crosses a cell.
- Simple AI: each enemy follows the flow field and "thinks" a few times per second, staggered.
- Static obstacles on the grid (walls, trees) that entities collide with.

Measure, at 1,000, 2,000, 5,000, and 10,000 entities:
- Sim step time: median and 99th percentile, over a 5-minute run.
- The share of step time in collision, flow field, AI, and snapshot writing.
- WASM SIMD on versus off, to confirm SIMD is worth it.

Pass: 2,000 entities at a 99th percentile under 4 ms on the reference device over a 5-minute run.

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
- Display delay from input to the player moving on screen, with keyboard and with a gamepad.
- Snapshots skipped by the worker and dropped by the main thread.
- Allocations during the game loop (Chrome's memory tools), which should be zero apart from the `postMessage` cost.

Try at least two designs and compare them on the numbers:
- A: the tech direction's design (queued snapshots, render clock steered toward a fixed lag).
- B: a simpler one (no queue: the main thread keeps only the newest snapshot, whose entries already hold start and end state, and the render clock follows it). Entities change slots every step, so no design may blend entries from two different snapshots.

Pass: no visible pauses or jumps at 60 fps or 30 fps with up to 20 ms of delay added, recovery within one second after a stall, and an input-to-screen delay under about 100 ms.

Output: the lag, queue size, and pool size to use, and which design wins. These go back into the tech direction as measured values.

If it fails: rendering the player character from its own latest state instead of the interpolated snapshot is the first fix for delay. If motion is still not smooth, consider running the sim on the main thread for the player only.

## Stage 3: does GPU-driven rendering pay off?

Hypothesis: compute culling, `drawIndirect`, and render bundles keep CPU time per frame small and flat as entity count grows, and stay within the GPU budget on the reference device.

Build:
- All instances in a few large GPU buffers, uploaded once per snapshot.
- A compute pass that culls against the camera and writes per-kind, per-layer ranges and draw counts, with `firstInstance` kept at 0.
- Render bundles that replay the fixed list of indirect draws.
- Realistic content: 10–20 kinds, three layers (foreground, play plane, background), packed vertex attributes, one texture atlas, baked ambient occlusion plus one sun, blob shadows.
- A crowd animation using vertex animation textures for one enemy kind.
- The upscale pass: the world drawn at 1080p internal resolution, then upscaled to the canvas with a sharpening filter and color grading in one pass, with the UI drawn after it.
- For comparison: a plain path that draws the same scene with one instanced draw per kind and CPU culling.

Measure, at the Stage 1 entity counts:
- CPU time to encode and submit a frame, GPU-driven versus plain.
- GPU time per frame at 720p and 1080p internal resolution, and the cost of the upscale pass to a 1440p and a 4K canvas.
- The real draw-call count with every kind and layer present.
- Frame time over a 5-minute run.

Pass: the frame fits about 60% of 16.7 ms (60 fps) on the reference device at 1080p with 2,000 entities, CPU encoding stays under 2 ms, and GPU-driven rendering beats the plain path by a clear margin at the higher counts.

Also compare the same scene in Three.js with its WebGPU renderer and instancing, to measure what owning the renderer gains over the main ruled-out option.

If it fails: if the plain path is as fast, drop compute culling and render bundles and keep plain instancing, which is simpler. If the GPU is the limit, lower resolution and overdraw first, then the target entity count.

## Stage 4: is raw WebGPU reliable enough?

Hypothesis: a raw WebGPU renderer with no fallback starts, recovers, and fails cleanly on the target browsers.

Test:
- Startup on Chrome and Edge (Windows and macOS), Safari (macOS), and Firefox, recording which features each adapter offers (`texture-compression-bc`, `shader-f16`, `timestamp-query`).
- A gamepad in each browser: it is detected, and its buttons and sticks map correctly.
- A lost device that the game did not cause: crash the GPU process (`chrome://gpucrash` in Chrome) and put the computer to sleep and wake it with the tab open. The game must rebuild and keep running. A loss from `device.destroy()` is on purpose and does not test recovery.
- A browser without WebGPU, or with it turned off: the "not supported" page must show.
- A rough count of how many of the people we expect to play have WebGPU, from public browser support data.

Pass: the game runs on current Chrome and Edge on Windows and macOS and on Safari on macOS, records where Firefox stands, recovers from a lost device without a reload, and shows the "not supported" page everywhere else.

If it fails: if too many target players lack WebGPU, revisit the "no WebGL fallback" decision before writing more renderer code.

## Stage 5: startup and hosting

Hypothesis: the game starts quickly from GitHub Pages, and a deploy does not break a running tab.

Build (this stage builds its own pieces, so it does not wait for other stages):
- A small asset set: a few models in the packed binary format, meshopt-encoded and gzipped, and a few textures encoded to BC7 with and without RDO, gzipped.
- A service worker that keeps hashed files and cleans up old ones.
- A deploy workflow that keeps the previous build's files available, and the save-and-reload prompt on a missing file.

Test:
- Time to first frame on the reference device over a throttled connection (Chrome's "Fast 4G"), cold and with a warm service worker cache.
- Whether Pages compresses `application/wasm`; if not, the gzipped `.wasm` path with `DecompressionStream`.
- Texture size with and without RDO encoding, gzipped, and model size meshopt-encoded with and without gzip.
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
- Whether `navigator.storage.persist()` is granted on each test browser, and how storage eviction behaves (Chrome's storage pressure tools, Safari's 7-day rule with a shifted clock where possible, and whether a web app added to the Dock on macOS keeps its storage).

Pass: the property test finds no mismatch over a long run, catch-up for a week-old chunk finishes before the player can reach it at full speed, and a save takes under 1 ms of work in the sim worker.

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
- Every number names the machine it was measured on ("dev machine", "dev machine, throttled", or the reference device), with the build, browser version, entity count, and test settings next to it, so anyone can rerun it.
- Each hypothesis has a verdict (held, failed, unclear, or provisional), and the verdict follows from the numbers and the pass bar, not from impressions. A provisional verdict comes with the steps to rerun it on the reference device.
- A failed hypothesis leads to the fallback decision written in its stage, or the PR says why it does not. A provisional failure records the fallback without applying it (see "How it runs").
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
- `prototype/results/report.md`, one page: each hypothesis's verdict and the numbers behind it, the limits found, which ruled-out options won or lost, the P1 and P2 findings from Stage 7, and the reference-device runs still needed.
- One PR from `prototype/run-1` with the prototype, the results, and the updates to `tech-direction.md` that the results call for.

# Run 2: full load

Run 1 measured each system on its own: the sim without combat, the renderer without effects, and the hand-off between them with a light scene. It did not show that everything fits in one frame at the same time, and every number came from one fast dev machine. Run 2 loads the sim with combat collision, the renderer with the game's intended look, and the audio with dense combat sound, then runs them all together through a worst-case wave, on the reference device.

The owner has set the targets that run 2 builds toward:

- Look: cel shading, with Breath of the Wild as the reference (banded light, outlines, crisp cast shadows, painterly color, grass fields, soft atmospheric fog). This puts three rules of the tech direction in question: blob shadows instead of shadow maps, only baked ambient occlusion, and at most one post-processing pass. Run 2 measures what the look costs instead of assuming those rules hold.
- Sound: combat sound in the style of Hades, where every shot, hit, and death gives punchy, layered feedback, many sounds play at once, and the mix stays clear.

The ground rules, "How it runs", and "Known pitfalls" above apply to run 2 as well, with these changes:

- Run 2 builds on run 1's code in `prototype/`, on a new branch `prototype/run-2` from `main`, with one PR at the end. Results go under `prototype/results/run-2/` (one `stage-N.md` per stage and a `report.md`), next to run 1's.
- Stages 8 to 11 run on the reference device. If none is available, they run on the dev machine with Chrome's 4× CPU throttling, every verdict is provisional, and each results file gives the steps to rerun on the reference device.
- On the reference device, also rerun run 1's Stages 1 and 3 at their original settings (step 2 of issue #3), so run 1's provisional verdicts can be settled.
- "Combat collision" means projectiles, building shapes, and crowd pushing, with projectiles weighted most, since they are the newest and likely the most costly.
- Art and sound are placeholders made for the test (simple models, generated or freely licensed sounds). Run 2 measures cost and checks that the look and the mix can be reached, not final quality. Screenshots and short recordings go into the results so the look can be judged.

## Lessons from run 1

Run 1's results and its review found problems that run 2 must not repeat. Each one becomes a rule here.

- Make comparisons fair before measuring them. The first review found two comparisons that favoured our renderer: the Three.js version re-uploaded about 1 MB of static matrices every frame (the 7 to 9 times gap became 3.4 to 7.8 after the fix), and the plain path culled every static instance on the CPU each frame. Before any 5-minute run, check that both sides of every comparison (pair finding, Rapier 2D, outline methods, shadow methods, mixer designs) were built with the same care and do the same work, and say which way any remaining bias points.
- Repeat comparisons whose differences are small. Run 1 ran each configuration once, and SIMD's ±10 to 24% was inside the noise. Run each compared configuration at least three times and report the spread, and call a difference real only when it is larger than the spread.
- Measure on an idle machine. Run 1's Stage 1 ran while other stages' builds used the same machine. Nothing else builds or measures during a run 2 measurement.
- Say where each measurement stops. Run 1's input delay stopped at frame submit, so Stage 2 could only be provisional. Measure to the screen and the speakers where possible (for audio, include the device's output latency), and otherwise state the end point next to the number.
- Measure allocations with a method that separates the game from the test harness. Run 1's heap sample showed 111 KB/s on the main thread and 31 KB/s in the worker, and could not tell which was the game's. Pick the method before building, and check it on a loop known to allocate nothing.
- Know what throttling reaches. Chrome's CPU throttling does not slow workers, so on the dev machine throttled sim numbers come from running the sim on the main thread, and audio worklet numbers are not throttled at all. Label each throttled number with what was slowed.
- Make tests able to tell outcomes apart. Run 1's 5-second recovery retry could not tell "no adapter for 5 s" from "no adapter until a reload", and its first crash test crashed nothing because the browser ignores `chrome://gpucrash` under automation. Check that every test can produce each outcome it is meant to detect (a projectile that should pass through a wall must be caught by the exact check; a glitch counter must count a forced glitch) before trusting it.
- Check limits across stages. Run 1's save format held at most 8 pending events per chunk while catch-up was measured with up to 1,000. Check that buffer sizes and formats (snapshot capacity, event slots, particle pools, voice limits) fit the loads other stages measure.
- Draw only what is seen. Drawing all 15,913 static instances without culling more than doubled Three.js's GPU time (3.0 against 1.3 ms at 2,000 entities). Grass, shadow casters, and outlines are culled per chunk like everything else.
- New GPU resources join the one rebuild path. Recovery after a lost device rebuilds everything in one code path. The shadow map, grass buffers, outline pass, and bloom targets must be rebuilt there too, and Stage 11 crashes the GPU process once during the wave to check it.
- Startup has a budget. The first chunk stays under about 2 MB to start within 3 seconds. Sounds, the cel ramp, and grass assets count toward it, so report how much each stage adds to the first chunk.
- Pin and build the toolchain. Run 1's sim failed to link on newer Rust. Run 2 keeps `prototype/rust-toolchain.toml` and checks that a clean build passes on the pinned version and on current stable Rust before the PR. Pushes to `main` now deploy to GitHub Pages, so run 2 can also check its pages there.

## Stage 8: does combat collision fit the sim budget?

Hypothesis: the single sim thread handles combat (2,000 enemies, 1,000 live projectiles, buildings, and area effects) within 4 ms per step at the 99th percentile on the reference device.

Run 1 found collision is already 48% of the step at 2,000 entities and 80% at 10,000, and the 4 ms budget breaks between 5,000 and 10,000 entities with circles and static obstacles only. This stage adds what combat needs.

Build:
- Projectiles: pooled, small circles that move up to several grid cells per step. Each one is swept along its path against walls, buildings, and enemies, so it cannot pass through a thin wall or a small enemy, and it hits the first thing along the path. Some come from the player's weapons and some from enemy shooters.
- Buildings and walls: axis-aligned boxes of several sizes on the grid, including player-built walls that appear and disappear during the run, which update the grid and the flow field.
- Crowd pushing: overlaps are resolved in several passes per step, with a push priority (the player, then large enemies, then small ones), so crowds pile up against walls and around the player.
- Area effects: explosions that damage everything in a radius, auras on some enemies checked every step, and a pickup radius around the player.
- Events for the renderer and the audio (shots, hits, deaths, explosions), written into the snapshot each step.

Try at least three ways of finding nearby pairs and compare them on the numbers:
- A: run 1's spatial hash grid with entities sorted by cell.
- B: sort-and-sweep along one axis.
- C: the grid from A, with the exact checks batched with SIMD.
- Also Rapier 2D on the same scene, which the tech direction keeps as the escape hatch for real rigid bodies but never measured.

Measure, over 5-minute runs:
- Sim step time, median and 99th percentile, at 2,000, 5,000, and 10,000 enemies, each with 0, 1,000, and 5,000 live projectiles.
- The share of the step in finding pairs, exact checks, crowd pushing, projectiles, area effects, and the flow field.
- Projectiles that passed through something they should have hit, counted by a slower exact check run alongside (must be 0).
- Events per step at each load, which Stages 9 and 10 use.
- Push the projectile count and the enemy count past the pass bar to find where 4 ms breaks.

Pass: 2,000 enemies with 1,000 live projectiles at a 99th percentile under 4 ms on the reference device over a 5-minute run, with no projectile passing through anything.

If it fails: first take the fastest of A, B, and C, then cut the pushing passes, the projectile count, or how often area effects are checked. If none of that fits, follow Stage 1's fallback. If Rapier 2D wins, change the physics decision in the tech direction and say what number changed it.

## Stage 9: does the cel-shaded look fit the GPU budget?

Hypothesis: the GPU-driven renderer with the cel-shaded look and the combat effects fits about 60% of 16.7 ms at 1080p on the reference device under combat load, and CPU encoding stays under 2 ms.

Build, on top of the Stage 3 renderer:
- Cel lighting: the sun's light stepped into two or three bands through a small ramp texture, with slightly soft band edges, plus a rim light. Sun direction, color, and ramp follow the day and night cycle as shader uniforms.
- Outlines, two ways to compare: A, inverted-hull outlines drawn as an extra instanced pass with no post-processing; B, an edge-detection pass over depth and normals, which needs a normal target and a second post-processing pass.
- Cast shadows: a shadow map from the sun, sampled with a hard cel edge, against run 1's blob shadows. Crisp cast shadows are part of the look, so this decides whether blob shadows are enough.
- A grass field: dense instanced grass clumps that sway in the wind in the vertex shader and bend away from entities, the most GPU-heavy part of this look on integrated graphics.
- Atmosphere: a painted gradient sky and colored distance fog, plus bloom on bright effects (explosions, projectiles) as a second post-processing pass.
- Combat effects: vertex animation textures for every enemy kind, projectiles drawn as instances with short trails, and GPU particles spawned in a compute shader from the snapshot's hit and death events, then moved and culled on the GPU, up to 50,000 alive.
- Overdraw: alpha-tested foliage and blended effects (explosions, auras), which is what limits integrated GPUs.
- A busy UI pass: health bars over enemies, floating damage numbers, and the HUD.
- Dynamic resolution: lower the internal resolution when GPU time goes over budget and raise it again when there is room.

Measure, at the Stage 8 counts with 0, 10,000, and 50,000 particles:
- CPU time to encode and submit a frame.
- GPU time per pass (shadow map, grass, world with cel lighting, outlines, particles, effects, bloom, upscale, UI) at 720p and 1080p internal resolution, for each outline method and each shadow method.
- Overdraw, from a debug view that counts how many times each pixel is written.
- Frame time over a 5-minute run, and how often and how quickly dynamic resolution changes.
- Screenshots of each option side by side, so the look can be judged against the reference.
- Push the grass density, particle count, and enemy count past the pass bar to find where the frame breaks.

Pass: the frame fits about 60% of 16.7 ms at 1080p on the reference device with the full look (cel lighting, outlines, cast shadows, grass, fog, bloom), 2,000 enemies, 1,000 projectiles, and 10,000 particles, and CPU encoding stays under 2 ms.

If it fails: cut in this order, checking the look after each step: bloom, grass density, particle counts and overdraw, shadow map resolution, then the internal resolution, then blob shadows instead of a shadow map, then the entity count. Take the cheaper outline method unless the other one is needed for the look. Whatever is kept updates the tech direction's lighting, shadow, and post-processing rules, with the numbers that changed them.

## Stage 10: does dense combat sound play cleanly?

Hypothesis: our own small mixer on Web Audio plays dense combat sound (hundreds of sound events per second, dozens of voices at once) without glitches and in time with the picture, while the main thread is busy rendering, with little main-thread cost.

Build:
- Sound events come from the snapshot (shots, hits, deaths, explosions from Stage 8) and from the player's own input. The player's own sounds (shooting, dashing) play straight from input, without waiting for the sim, so they are not delayed by the snapshot lag.
- Two mixer designs to compare: A, plain Web Audio nodes, one buffer source per sound through gain and stereo panner nodes; B, our own mixer in an `AudioWorklet`, which mixes every voice itself on the audio thread and gets sound events as small messages.
- Voice management: a limit per sound and in total, priority (the player's sounds first), and stacking, so many identical hits in one frame play as one louder hit instead of a wall of copies.
- Variation: each sound has several takes and a small random change in pitch and volume, so repeated hits do not sound the same.
- Buses: sound effects, music, and UI, with music and smaller sounds ducking under big hits, and a limiter on the master so a crowd never clips.
- Music in layers that fade in and out with combat intensity.

Measure, with Stage 8's events at its pass load and past it, over 5-minute runs:
- Audio glitches (dropouts), counted from the audio thread, including during Stage 2's 100 ms and 500 ms main-thread stalls.
- Delay from input to sound for the player's own sounds, and the offset between a sim event's sound and the frame that shows it.
- Main-thread time per frame spent on audio, and the audio thread's load.
- Allocations in the game loop (node design A creates nodes per sound).
- Voices playing at once, and events merged or dropped by the limits.

Pass: no glitches over 5 minutes at the pass load, stalls included; the player's own sounds within about 30 ms of input plus the device's output latency; event sounds within one frame of the picture; audio under 0.5 ms of main-thread time per frame.

If it fails: lower the voice limits and stack more aggressively first. If design A glitches or allocates too much, use design B. If B glitches, raise its buffer size and say what latency that adds.

## Stage 11: does everything fit at once?

Hypothesis: the sim, the snapshot hand-off, the renderer, and the audio together keep the game smooth at 60 fps through a worst-case combat wave on the reference device, with every system inside its budget at the same time.

Build: a scripted 5-minute wave using the Stage 8 sim, the Stage 9 renderer with the full look, and the Stage 10 mixer. Enemies ramp up to 5,000, with heavy shooting, explosions, particles, and walls being built and destroyed. Snapshots now carry projectiles and events, so they grow, and the hand-off from Stage 2 is measured again under that load.

Measure:
- Frame time, and pauses and jumps from the Stage 2 render clock.
- Snapshot size and the cost of copying and sending it.
- Sim step time, median and 99th percentile.
- Main-thread time split into snapshot upload, encoding, audio, UI, and everything else, and GPU time.
- Audio glitches, and keyboard input to frame submit.
- Memory over the 5 minutes (it must not keep growing), and allocations in the game loop.
- One GPU process crash during the wave: the full look comes back in one rebuild, and the sim and the audio keep running.
- Keep ramping the wave past the pass bar and record which budget breaks first.

Pass: no pauses or jumps at 60 fps and no audio glitches through the wave, the sim step under 4 ms and CPU encoding under 2 ms at the 99th percentile, and the frame within about 60% of 16.7 ms, all in the same run on the reference device.

If it fails: the system that breaks first applies its own stage's fallback (Stage 8, 9, 10, or 2).

## Stage 12: review the results

Same as Stage 7, with run 2's report and results. Changes to the tech direction's lighting, shadow, post-processing, and audio rules must trace back to a Stage 9 or 10 result.

## Run 2 order

Stages 8, 9, and 10 are independent and run at the same time: Stages 9 and 10 use a scripted stream of projectiles and events until Stage 8's sim is ready. Stage 11 needs all three. The reference-device reruns of run 1's Stages 1 and 3 can run whenever the device is free. Stage 12 runs last.

Steps 3 (macOS, Safari, and Firefox) and 4 (a gamepad) of issue #3 are not part of run 2 and can run alongside it.

## Run 2 output

- A results file per stage in `prototype/results/run-2/`, with every number labeled by where it was measured, and screenshots and recordings for Stages 9 and 10.
- `prototype/results/run-2/report.md`, one page: each hypothesis's verdict and the numbers behind it, the limits found and which budget breaks first, which alternatives won or lost (pair finding, Rapier 2D, outline method, shadow method, mixer design), the reference-device reruns of run 1, the P1 and P2 findings from Stage 12, and the runs still needed.
- One PR from `prototype/run-2` with the prototype changes, the results, and the updates to `tech-direction.md` that the results call for.
