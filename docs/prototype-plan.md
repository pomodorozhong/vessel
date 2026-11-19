# Prototype plan

The prototype is throwaway code that tests the riskiest bets in [tech-direction.md](tech-direction.md) on real hardware. It is not the start of the game: nothing in it has to be clean, and anything it proves gets rewritten properly later. Its output is numbers and a short report, and the tech direction is updated from them.

## Ground rules

- Test on the reference device: a mid-range Android phone a few years old, in Chrome. Also check a desktop in Chrome and an iPhone in Safari for anything that differs by browser.
- Every test records its numbers in the debug overlay and in a results table in this folder, so results can be compared across changes.
- Fix the test scene before starting: decide side-view or top-down (the open question in the tech direction). The default is top-down if no decision is made, since it stresses rendering and crowds harder.
- Time-box each stage. If a stage runs over its box, stop and write down why; that is a result too.
- A stage that fails its pass bar triggers its fallback decision, not more tuning, unless the miss is small and the cause is obvious.

## Stage 0: skeleton (2–3 days)

Goal: the smallest app that has every moving part connected, so later stages measure real costs.

- Vite + TypeScript app deployed to GitHub Pages from an Actions workflow, with the `/vessel/` base path.
- WebGPU startup check (`navigator.gpu`, adapter, device) and a "not supported" page.
- A Rust crate built to WASM with SIMD, compiled on the main thread from an inline script and sent to a worker.
- The worker steps an empty sim at 30 Hz and sends a snapshot buffer to the main thread; the main thread clears the canvas each frame.
- Debug overlay: frame time, sim step time (reported by the worker), GPU time from `timestamp-query` where available, and the snapshot queue length.

Done when the page loads on all three devices and the overlay shows numbers.

## Stage 1: does the sim fit its budget? (1 week)

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

If it fails: first cut the entity target or the step rate. If that is not acceptable, the single sim thread is the bottleneck, so reconsider GitHub Pages (a host with COOP and COEP allows a multithreaded sim) before reconsidering Rust.

## Stage 2: are snapshots smooth? (1 week)

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

## Stage 3: does GPU-driven rendering pay off? (1–2 weeks)

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

If it fails: if the plain path is as fast, drop compute culling and render bundles and keep plain instancing, which is simpler. If the GPU is the limit, lower resolution and overdraw first, then the target entity count.

## Stage 4: is raw WebGPU reliable enough? (3–4 days)

Hypothesis: a raw WebGPU renderer with no fallback starts, recovers, and fails cleanly on the target browsers.

Test:
- Startup on Chrome (desktop and Android), Safari (macOS and iOS), and Firefox, recording which features each adapter offers (compressed texture formats, `shader-f16`, `timestamp-query`).
- A lost device, forced with `device.destroy()` from a debug button and by hiding the tab for a long time on a phone: the game must rebuild and keep running.
- A browser without WebGPU, or with it turned off: the "not supported" page must show.
- A rough count of how many of the people we expect to play have WebGPU, from public browser support data.

Pass: the game runs on current Chrome and Safari on all three test devices, recovers from a lost device without a reload, and shows the "not supported" page everywhere else.

If it fails: if too many target players lack WebGPU, revisit the "no WebGL fallback" decision before writing more renderer code.

## Stage 5: startup and hosting (3–4 days)

Hypothesis: the game starts quickly from GitHub Pages, and a deploy does not break a running tab.

Test:
- Time to first frame on the reference phone over a throttled connection (Chrome's "Fast 4G"), cold and with a warm service worker cache.
- Whether Pages compresses `application/wasm`; if not, the gzipped `.wasm` path with `DecompressionStream`.
- Texture size with and without RDO encoding, gzipped, per GPU format.
- A deploy while a tab is open and loading new chunk assets: no failed requests for the previous build's files, and the save-and-reload prompt for a build two deploys old.

Pass: first frame within about 3 seconds on a cold load over Fast 4G, under 1 second when warm, and no broken tab after one deploy.

If it fails: reconsider the asset formats before reconsidering the host. If deploys cannot be made safe on Pages, that is a reason to move to Cloudflare Pages or Netlify.

## Not in the prototype

These matter but are cheap to change later, or do not depend on the risky choices above: chunk catch-up and the summary simulation, saves and IndexedDB, audio, UI, the full asset pipeline, and gameplay. Chunk catch-up gets a property test (random job orders and events, checked against replaying every step) when it is built for real.

## Order and timing

Stages 0 to 3 run in order, since each builds on the last, and are the ones that can change the direction. Stages 4 and 5 are independent and can run alongside Stage 3. Total: about 4 to 6 weeks.

## Output

- A results table per stage, with numbers from the reference phone.
- A one-page report: which hypotheses held, which failed, and what changes in the tech direction.
- A PR that updates `tech-direction.md` with measured values and any changed decisions.
