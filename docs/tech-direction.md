# Technical direction

Vessel is a survival game with 3D visuals where every character moves in a single plane. It runs in the browser on desktop computers, is made for 720p to 1080p screens, and is played with keyboard and mouse or a gamepad. Phones and touch are not targets. Performance is the top priority.

The core idea: run a 2D game, simulated in 2D, and draw it in 3D. Rendering is only a view of the 2D state.

## What this doc covers

This doc records decisions and the reasons for them: what we use, what we ruled out, the rules that follow from our constraints, and the limits we measured. It does not specify protocols or implementation steps. Those are settled by the prototype (see "Prototype first") and then live in code and tests.

When reviewing this doc, a P1 is a decision that is wrong, contradicts another decision, or is missing, or a stated fact that is false. An edge case in how a system will be implemented is not a finding here; it belongs to that system's code and tests.

## Guiding principle: own the runtime

AI agents make writing code cheap, so we prefer control over ready-made features. Code the game runs in the browser is ours wherever it is small enough to own: the simulation, the renderer, the entity storage, the audio mixer, the debug overlay. We keep outside libraries where they hold years of hard-won knowledge rather than just saving typing (a physics solver, mesh and texture encoders), and we use them as build-time tools or an escape hatch. Runtime libraries are the exception, allowed only when they are small and focused on one job. Today there are two: the meshopt decoder and wgpu-matrix.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Simulation | Rust compiled to WASM (with SIMD), running single-threaded in a worker | Steady speed with no garbage collector and no JIT warm-up, and the main thread is left free for rendering. Starting in Rust avoids a port later. SIMD is built in, but the prototype measured no difference either way (single runs, inside noise; the build without SIMD was faster in some rows): only movement is vectorized, and collision, which is 48% of the step at 2,000 entities and 80% at 10,000, is branchy scalar code. Measured on the dev machine: 2,000 entities step in 0.59 ms at the median and 1.06 ms at the 99th percentile; the 4 ms budget breaks between 5,000 and 10,000 entities. With the CPU throttled 4× the 99th percentile at 2,000 entities is 5.28 ms, so the budget is not yet confirmed for the reference device. Those are run 1's movement-only numbers. At combat load (run 2's Stage 8: 2,000 enemies, 1,000 projectiles, buildings and area effects) the sim failed provisionally: p99 4.58 to 5.11 ms throttled 4× on the main thread, over the 4 ms budget, and 2.27 to 2.62 ms unthrottled in a worker. The worker timing has a tail that is not explained yet (its p99 was 3.2 to 4.1 times its median, against about 1.7 times when the same WASM steps in Node), so it is not yet clear whether a miss on the reference device would come from the cost or from jitter. A follow-up found the tail also in Node when steps are paced to 30 Hz, and a busy page next to the worker did not remove it. Stage 8's fallback (cut the push passes, the live projectile count and the area-effect checks, then fewer entities or a lower step rate) is recorded but not applied until the reference device confirms the miss. This is the biggest open risk in the stack. |
| Glue (input, UI, audio, build) | TypeScript + Vite | WebGPU is a JavaScript API, so rendering, input, UI, and audio stay in TypeScript. Types help agents as much as people. Vite loads `.wgsl` files as text and bundles the WASM module. |
| Rendering | Raw WebGPU with WGSL shaders, GPU-driven, no engine or rendering library | Vessel needs a small renderer: one plane, a fixed camera, instanced meshes, almost no post-processing. Owning it lets entity data go from the sim's tables into GPU buffers with two plain copies per step and no conversion (WASM memory into the snapshot buffer in the worker, then the snapshot into a GPU buffer with `writeBuffer` on the main thread), and lets culling, crowd animation, and particles run in compute shaders. See "Rendering" below. |
| Input | Keyboard, mouse, and gamepad (the browser's Gamepad API), no touch | The game targets desktop browsers. Gamepads are read once per frame on the main thread and sent to the sim with the rest of the input, and every menu and UI screen works with a gamepad alone. |
| Math | wgpu-matrix on the TypeScript side | Small, allocation-free vector and matrix math laid out for WebGPU buffers, for the camera and render setup. The sim is 2D and does its own math in Rust. |
| Entity storage | Our own struct-of-arrays tables in WASM memory, no ECS library | No garbage at all, so thousands of entities (enemies, trees, drops) run without stutter. We choose the memory layout, so the render data each table produces matches the GPU buffer it feeds, including padding and grouping. |
| Physics | Custom 2D collision in Rust (AABB and circles plus a spatial hash grid). Rapier 2D only if real rigid bodies are needed. | Characters move in one plane, so 3D physics is never needed. This is the biggest performance win. Rapier is written in Rust, so it would drop straight into the sim if ever needed. In run 2's Stage 8 it was 3.2 times slower than our grid at combat load and missed 7 projectile hits that ours caught. |
| Assets | A build-time pipeline: glTF in, our own binary formats out | See "Asset pipeline" below. Loading becomes "download, then upload to the GPU", with no parsing and no transcoder download. |
| Audio | Web Audio with our own small mixer in an `AudioWorklet` | Every browser with WebGPU has Web Audio, so a library's old-browser fallbacks add nothing. Our mixer controls sound pools and distance-based volume directly. It mixes every voice itself on the audio thread: in run 2's Stage 10 it had no glitches at combat's event rate with the main thread busy, while one Web Audio node chain per sound glitched and clipped (see "Threads and workers"). |
| Debug overlay | Our own frame-time overlay | Shows CPU time per system and GPU time (from `timestamp-query`) side by side, which off-the-shelf counters cannot. |
| Hosting | GitHub Pages | Free static hosting with HTTPS, deployed from this repository. See "Hosting on GitHub Pages" below for what it rules out. |

### The trade-off: WebGPU is required

There is no WebGL fallback. A browser or device without WebGPU (older browser versions, some older GPUs, blocklisted drivers, some Linux setups) cannot run the game. We accept this in exchange for full control and lower overhead.

- At startup, check that WebGPU, an adapter, and a device are all available. If not, show a clear "your browser does not support WebGPU" page with a list of supported browsers, not a blank screen.
- Use only core WebGPU limits. Optional features, such as BC texture compression or `shader-f16`, are picked at runtime from what the adapter offers.
- Anything a library would normally handle (device-specific bugs, lost devices, resizing) is our job. When the GPU device is lost by accident, the game rebuilds everything on a new adapter and device in one code path while the sim keeps running (0.6 to 0.8 s in the prototype after a GPU process crash in Chrome and Edge on the dev machine). After repeated crashes the browser stops offering an adapter: after a second crash within 20 s none came back in 60 s of retrying but a reload got one at once, and after a third crash within 5 minutes a reload did not help either. Waiting does not bring it back, so if no adapter returns within a second or two the game saves and offers a reload, and shows the "not supported" page when the reload does not help.

### Ruled out

- Three.js (either renderer): its scene graph and material system are more than Vessel needs, and every entity would be copied from our arrays into its objects each frame. In the prototype the same scene in Three.js's WebGPU renderer, with static instances uploaded once, cost 3.4 to 7.8 times more main-thread time per frame than our renderer, more as the entity count grows (0.56 against 0.15 ms at 2,000 entities and 1.71 against 0.22 ms at 20,000 on the dev machine; 4.26 against 0.63 ms at 10,000 with the CPU throttled 4×). This is an upper bound: the Three.js version interpolates moving entities on the CPU, and a custom material that does it on the GPU was not built. Its WebGL2 fallback is the main thing we give up.
- Babylon.js: same reasons, and heavier.
- Unity WebGL and Godot web exports: large downloads, slow startup, and heavy memory use in browsers.
- Bevy compiled to WASM: fast, but it brings a whole engine and its own renderer, when we only want Rust for the simulation.
- A TypeScript simulation: the prototype built the same sim in careful typed-array TypeScript. WASM was 1.2 to 2.0 times faster at the median (1.7 times at 2,000 entities), but the 99th percentile was equal at 10,000 entities and TypeScript showed no garbage-collection spikes. So the gain is real but modest; porting a grown sim later still costs more than starting in Rust.
- bitECS: thin and fast, but its storage layout and API are not ours, and matching GPU buffer layouts is the point.
- Howler.js: its main extra is a fallback for browsers that cannot run the game anyway.
- Runtime Basis (KTX2) transcoding: it needs a WASM transcoder download at startup. We encode each GPU texture format at build time instead.

## Threads and workers

GitHub Pages cannot send the headers needed for shared memory (see "Hosting on GitHub Pages"), so threads cannot share one live world. Work is split this way instead:

- Main thread: input, rendering, audio, and UI only. It never runs game logic. For audio it only turns the snapshot's sound events into small messages for the mixer, which mixes on the audio thread. Measured in run 2 (dev machine, page throttled 4×, about 15,400 sound events a second, 100 ms and 500 ms main-thread stalls): the `AudioWorklet` mixer had no late audio and cost the main thread 0.39 ms per frame at the 99th percentile; one Web Audio node chain per sound had 8 to 17 late renders per 5 minutes, cost 1.4 ms, and its compressor let the master clip (peak 1.26, about 144,000 clipped samples per 5 minutes, measured again after later changes to which sounds play). The cost grows with the event rate (0.59 ms at about 30,800 a second), so if the game's rate grows past it, the sim should send only the events near the player. Snapshot events are fired early by the output pipeline delay that the audio context reports, so they reach the speakers with the frame that shows them: without that they came 57 to 75 ms after the frame, with it 9 ms. The prototype read that delay once, from the first valid output timestamp, which can catch the output still filling and misses a later change of output device (Bluetooth adds about 150 ms). The game takes the median over about the first second of valid output timestamps instead, and measures again on `devicechange`. The player's own sounds play straight from input, 59 to 75 ms to the speakers including 48 to 64 ms of the device's output latency.
- Sim worker: one worker runs the Rust/WASM simulation on a fixed timestep. After each step it copies the render data (positions, facing, animation state, and so on) into a snapshot buffer and sends it to the main thread with `postMessage` as a transferable buffer, so nothing is copied in transit. Entities change slots between steps, so each snapshot entry holds the entity's state at both the start and the end of the span it covers, and the vertex shader interpolates inside one snapshot; the CPU never loops over entities to interpolate. The render clock runs a little behind the newest snapshot so the next one is normally ready before it is needed, and if snapshots run late, entities are held where they are, never extrapolated. Snapshot buffers come from a small fixed pool and are never allocated in the game loop. Measured in the prototype: snapshots wait in a short queue and the render clock is steered toward a lag of 2 sim steps (67 ms), with a queue of 3 and a pool of 6 buffers. That gave no pauses or jumps at 60 and 30 fps with up to 20 ms of delivery jitter, recovery within half a second after a 500 ms stall, and a keyboard-to-frame delay of 51 ms at the median and 67 to 98 ms at the 99th percentile. That delay stops at frame submit, so at 30 fps with delivery jitter it is already at the ~100 ms bar before the display adds its share. A lag of 1.5 steps or a pool of 3 is not smooth, and keeping only the newest snapshot without a queue is not smooth at 60 fps. The exact rules live in the code and its tests. Input goes the other way as small messages.
- Job workers: work that does not touch the live world runs as separate jobs, each sent to a worker and returned as a transferable buffer. Good fits are rebuilding flow fields, catching up chunks away from the player, generating new world chunks, and preparing save files.
- GPU: the heavy parallel work that only affects what is drawn (culling, crowd animation, particles) runs in compute shaders. Anything the sim reads, such as flow fields, is built on the CPU, because the GPU device belongs to the main thread and results would have to be read back and forwarded to the sim worker.

The simulation is written as per-chunk jobs even though it runs on one thread today. If the game ever moves to a host that sends the COOP and COEP headers, those jobs can run on several threads with shared memory (for example with Rust's rayon) without redesigning the sim.

## Rendering

- GPU-driven: every instance of every kind lives in a few large GPU buffers. A compute shader culls them and writes the draw counts, and the frame is drawn with indirect draws. The CPU does almost no per-object work, and the number of draw calls does not grow with the number of entities.
- Render bundles: the fixed sequence of indirect draws is recorded once and replayed each frame for almost no CPU cost. Chunks streaming in and out only change buffer contents, never the bundles.
- Fixed internal resolution with an upscale: the world is drawn into a texture at most 1080p tall, and one final pass scales it to the canvas's real size with a sharpening upscale filter in our own shader (in the style of AMD's FSR 1), not with CSS stretching. The UI is drawn after the upscale at full resolution, so text and icons stay sharp. The dynamic resolution scale lowers the internal resolution on the same path. It steps up only well under budget and waits longer after each step down that undoes a step up, because run 2's Stage 9 found a 5% margin made it flip between two sizes every few seconds. The upscale pass also does color grading.
- Measured in the prototype (dev machine): encoding and submitting a frame costs 0.08 to 0.10 ms from 1,000 to 20,000 entities, with 24 draw calls for 20 kinds in three layers. Plain instancing with CPU culling costs 3.5 to 6 times more CPU, but that is only 0.2 to 0.4 ms per frame (about 1 ms with the CPU throttled 4×), and GPU time is the same. That gap is an upper bound: the prototype's plain path culls all 15,913 static instances on the CPU every frame, where a real plain renderer would cull statics per chunk. GPU-driven stays the choice; if the reference device shows no gain either, plain instancing is the simpler fallback. GPU cost on integrated graphics is not measured yet.
- The look (run 2's Stage 9, provisional): cel lighting from a 3-band ramp with a rim light, inverted-hull outlines as an extra instanced pass (no post-processing), a sun shadow map sampled with a hard edge, grass, distance fog, and bloom on bright effects as the only post-processing pass besides the upscale. At 1080p with 2,000 enemies, 1,000 projectiles and 10,000 particles this cost 3.8 ms of GPU time at the median and 6.2 ms at the 99th percentile on an RTX 3060, and 1.8 ms of encoding at the 99th percentile with the CPU throttled 4×. Edge-detection outlines and blob shadows were not cheaper within the spread. Integrated graphics are not measured yet. If the reference device misses the budget, cut in this order: bloom, grass density, particles and overdraw, shadow map resolution, internal resolution, blob shadows instead of the shadow map, then the entity count.
- Effects have an on-screen budget: at combat's event rate about 520 explosions are alive at once and wash the frame out, so only the 64 nearest the player are drawn (run 2's Stage 9 and 12).
- Debugging GPU-driven rendering is harder, because culling happens where it cannot easily be inspected. The debug overlay includes a view of the culled and drawn instance counts per kind.

## Asset pipeline

glTF stays the format artists export. A build script turns it into files the game can upload without parsing.

- Models: converted to our own binary format whose vertex and index layout matches the GPU buffers, with attributes packed into 8- and 16-bit formats instead of 32-bit floats. Vertex and index data are meshopt-encoded and then gzipped, since meshopt's encoding is built to be followed by a general-purpose compressor; in the prototype this came to 40 to 47% of the size of gzip alone. We gzip at build time rather than rely on the host (see "Hosting on GitHub Pages"). The game unpacks them with `DecompressionStream` and then the meshopt decoder, which is about 29 KB raw with its WASM embedded (not the few kilobytes first assumed) and is the only decoder the game loads. What players download is smaller: in the prototype the whole stage 5 page chunk, decoder included, is 39.0 KB, 12.75 KB gzipped, including the loader.
- Textures: encoded at build time to BC7, which every desktop GPU supports (Macs with Apple chips included), with mipmaps, stored in KTX2 containers without Basis, and gzipped. Plain BC7 blocks barely shrink under gzip, so the encoder runs in rate-distortion-optimized (RDO) mode, which trades a little quality for blocks that gzip compresses well. In the prototype, RDO cut the gzipped size to 18 to 34% of plain BC7 at 46 to 48 dB, so gzip is enough and zstd is not needed. The build also writes an uncompressed RGBA8 fallback, used only when the adapter does not offer `texture-compression-bc`. The game downloads only the format the device supports and unpacks it with the browser's built-in `DecompressionStream`, so no extra library or WASM is needed.
- Every output file name includes a content hash, so caches never serve a stale file (see "Hosting on GitHub Pages").
- The encoders (meshopt and BC7) run only at build time and are never shipped.

## How the single plane shapes the design

- Simulation: entities have `x, y` and a facing direction. The sim runs on a fixed timestep at 30 Hz by default, and rendering interpolates between steps.
- Axes: the sim plane is the world's XY plane in both layouts, so sim `x, y` go into shaders unchanged. The world is right-handed like glTF. The third axis, Z, is depth for side-view (with X right and Y up, +Z points toward the viewer, so the camera looks down -Z), or height above the ground for top-down. Only the camera differs between the two. glTF is always Y-up, so the asset pipeline rotates models into these axes at build time (a no-op for side-view, Y-up to Z-up for top-down); nothing is rotated at runtime.
- World: split into chunks along the plane. Chunks near the player are simulated and drawn; the rest are only stored, which makes culling trivial. See "Chunks away from the player" below for how stored chunks catch up.
- Camera: fixed angle. This lets us skip geometry that is never seen and keeps the sun's shadow map small (one 2,048² map covers the view; see "Rendering").
- Lighting: only ambient occlusion is baked into textures or vertex colors, because it does not depend on the time of day. Direct light comes from one directional "sun" whose direction, color, and strength are shader uniforms, so it can follow the day and night cycle. It is shaded in cel bands and casts the one shadow map.
- Depth: background and foreground 3D layers (mountains, trees) are pure decoration with no game logic.

## Performance rules

### Budgets and measuring

1. Measure from the start with our own overlay: CPU time per system and GPU time (the `timestamp-query` feature where available). The reference device is a laptop a few years old with integrated graphics, running Chrome at 1080p; test on it, not only on the dev machine.
2. Every system has a time budget on the reference device (for example: sim step 4 ms, render encoding 2 ms). A system over its budget is fixed before new features are added.
3. Leave headroom. Other tabs and apps share the machine, and thin laptops slow down when they get hot, so aim to use about 60% of the frame time on the reference device, not 100%.
4. Draw calls are capped at 100 per frame on the reference device. GPU-driven rendering and instancing keep the real number far below that.

### GPU

5. Draw repeated objects (trees, rocks, grass, enemies of one type) as instances, and use texture atlases so many objects share one pipeline and bind group.
6. Keep overdraw down: integrated GPUs are limited by how many pixels they can draw, so how many times each pixel is drawn matters more than triangle count. Draw solid objects roughly front to back (by layer, since culling does not sort), keep alpha blending to small areas and draw it last, and keep particles small.
7. Use small data: packed vertex attributes (see "Asset pipeline"), compressed textures with mipmaps, and 16-bit floats in shaders where `shader-f16` is available.
8. Crowd animation uses vertex animation textures (animation on the GPU). Skeletal animation is only for the player and bosses.
9. Draw the world at most 1080p tall and upscale to the screen (see "Rendering"), and add a dynamic resolution scale that lowers the internal resolution when the frame rate drops.
10. The day and night cycle changes a few shader uniforms (sun direction, light color and strength, fog, sky color) instead of adding real lights.
11. At most two post-processing passes: bloom on bright effects, and the upscale pass, which also does color grading (and a vignette if wanted). Bloom is the first thing cut if the GPU budget is missed (run 2's Stage 9).
12. Create every pipeline at load time with `createRenderPipelineAsync` and `createComputePipelineAsync`, so no shader is compiled mid-game.
13. Never wait on GPU data during a frame. Data the CPU needs from the GPU, such as timings, is read a few frames later. Nothing the sim depends on comes from the GPU.
14. Upload only what changed, apart from the sim's per-step instance data, which is uploaded whole once per sim step, not once per frame.

### Simulation

15. No allocations in the game loop, on either side. Pool objects (projectiles, particles, drops), reuse buffers, and write into persistent GPU buffers instead of creating new ones. The small fixed cost of `postMessage` per sim step is the one accepted exception.
16. Keep data in cache-friendly order: sort entities by grid cell so neighbours sit next to each other in memory, which speeds up both collision and AI.
17. Spread work over time: the sim steps at 30 Hz with interpolation, each enemy's AI "thinks" a few times per second staggered so it isn't all on the same frame, and far-away crowds animate less often.
18. Keep the JS/WASM boundary coarse: one call steps the whole sim, never one call per entity.

### Main thread and startup

19. Keep the DOM out of the frame. Draw the in-game UI on the canvas, or update DOM elements only when their value changes, never every frame.
20. Startup cost counts. The only decoder downloaded at startup is the meshopt decoder; textures need none. On Chrome's "Fast 4G" the first frame took about 0.6 s plus 1 s per megabyte of first-chunk assets in the prototype, so the first chunk stays under about 2 MB to start within 3 seconds. The WASM compile, the sim worker, and the first chunk's assets start as early as possible, in parallel with the main code.

## Survival systems that fit this setup

- Resources and building live on a grid along the plane: cheap to store in typed arrays and cheap to collide against.
- Enemy AI uses simple state machines plus flow-field pathfinding on the grid, with one flow field per goal (the player, the base core, and so on), not one per enemy. Fields whose goal rarely moves are rebuilt in job workers; the player's field, which changes constantly, is updated by the sim itself.
- Save state is just 2D grids and entity lists, so saves are small and fast (IndexedDB). A save job worker does the serializing and writing, the sim worker's share of a save is bounded by the size of the active area, and a save on disk is always one consistent tick. Stored chunks are not kept as one buffer per chunk: in the prototype (dev machine, 3.6 MB world) transferring 4,096 separate buffers to the save worker cost the sim 3.5 ms. Two layouts met the 1 ms bar. Transferring 64 slabs cost the sim 0.14 ms (0.26 ms p99), but the sim cannot touch those slabs while the save worker holds them, about 0.6 ms (1.0 ms p99). Copying one 3.2 MB buffer with `postMessage` cost 0.56 ms (0.73 ms p99) and has no such hold window.

### Keeping saves safe

Browsers can delete IndexedDB on their own, and a survival save can hold many hours of play, so we do not rely on IndexedDB alone.

- Safari on macOS deletes all storage a script wrote (IndexedDB, Cache Storage, the service worker) after 7 days of Safari use without the player interacting with the site. A player who takes a week off would lose their save. Whether a web app added to the Dock is exempt is not confirmed and is checked in the prototype; until then, Safari players are pointed to save export.
- Chrome and Firefox store data as "best effort" by default and can delete the whole origin's data, saves included, when the disk runs low. After the first save the game calls `navigator.storage.persist()` to ask for persistent storage. The browser may refuse (Chrome and Edge both refused in the prototype's fresh profiles), so this lowers the risk but does not remove it.
- The game can export a save as a file and import it again, so players can keep a copy outside the browser. Export uses the same format the save job writes, so it adds no second serializer.

### Chunks away from the player

Survival systems keep running while the player is away, so stored chunks must not simply freeze.

- Each stored chunk records the sim tick it was last updated. When it becomes active again, time-based systems (crop growth, smelting, fuel burn, spoilage) fast-forward by the elapsed ticks with a direct calculation, not by replaying every step.
- Catch-up runs as job worker tasks, started before the player arrives where possible. A chunk is never activated with stale state, and a late job result never overwrites newer state; when the player arrives first (fast travel, loading a save), the game waits or catches up inline. The prototype's property test settled two rules: a job result is accepted only if it is newer than the chunk's current state, and an event stamped with the same tick as a stored state still counts as pending. With them, 30 million random operations matched a step-by-step replay exactly; the rules live in that code and test. Catch-up cost depends on the number of events, not on the time away: a week-old chunk takes about 0.2 ms.
- The sim worker is the only writer of stored chunk state. Events that matter while the player is away, such as a raid on the base, are resolved by a coarse summary simulation in the sim worker and recorded with their tick, so catch-up applies them in order.
- Enemies in stored chunks are despawned or kept as a simple count, not simulated one by one.

## Hosting on GitHub Pages

GitHub Pages serves static files only. We cannot set HTTP headers, cache times, or compression, and the rules below follow from that.

- No shared memory between threads. `SharedArrayBuffer`, and so multithreaded WASM, needs the COOP and COEP headers, which Pages cannot send. "Threads and workers" above describes how we work without it. We do not use the service-worker trick that fakes these headers (coi-serviceworker): it reloads the page on the first visit and is fragile.
- Compression is mostly ours. On other public `github.io` sites (not ours, which has not been checked), Pages was observed to gzip text types, `application/wasm`, `model/gltf-binary`, and `application/octet-stream`, and never to send brotli; it did not compress images. The `application/octet-stream` case was a text-like `.ftl` file; a truly binary file with an unknown extension was not observed. So the `.wasm` module ships as it is and Pages is expected to compress it. Our asset files are still gzipped at build time (meshopt plus gzip for models, gzip for textures) at a higher level than the host uses, and so they do not depend on how Pages types our own file extensions, which is not yet checked on our site.
- Caching is short and fixed: Pages tells browsers to keep files for about 10 minutes. Every built file has a content hash in its name, and a small service worker keeps hashed files so returning players load almost instantly, while new releases are still picked up and old files are cleaned out.
- A deploy must not break a game that is already running: a tab on the previous build can still load its files, and a missing file makes the game save and ask the player to reload. In the prototype the deploy workflow copies the previous build's hashed files into the new site, so the current and the previous build are both served, and it stops the deploy rather than publish without them (when the live site cannot be read, other than a first deploy's 404, or a previous file cannot be downloaded); this was tested against a local emulator of Pages, not yet on Pages itself.
- Base path: the site lives under the repository name, so Vite uses `base: '/vessel/'` (or `/` with a custom domain).
- Origin: without a custom domain, the game's origin is `<user>.github.io`, which every other Pages site on the same account shares, including their access to our saves and storage quota. We use a custom domain before any public release, so the game owns its origin.
- Deploys run from a GitHub Actions workflow that builds the Rust sim to WASM, builds the code and the assets, and publishes the output.
- Limits: about 1 GB per site, 100 MB per file, and a soft limit of about 100 GB of bandwidth per month. These are fine for a small game, but they are one more reason to keep assets compact.
- Free Pages requires a public repository; a private one needs a paid GitHub plan.
- HTTPS is built in, which WebGPU requires.

### Why not Cloudflare Pages or Netlify

Both are free, deploy from the same repository, and let us set headers. With COOP and COEP they would allow multithreaded WASM, and they compress files and allow long cache times, which would remove several of the rules above. We stay on GitHub Pages anyway: one sim thread plus job workers and the GPU should fit our budgets, and keeping hosting in GitHub keeps the setup simple. Because the sim is written as per-chunk jobs, moving to such a host later is a small change, made only if measurements show the single sim thread going over its budget.

## Prototype first

Several parts of this direction rest on guesses that only running code can settle. Before building the game, a throwaway prototype tests them on the reference device, and its results update this doc. [prototype-plan.md](prototype-plan.md) has the stages, measurements, and pass bars. The first run's results are in [prototype/results/report.md](../prototype/results/report.md); it ran on the dev machine only, so the numbers quoted in this doc are dev-machine numbers and the reference-device runs are still open. The second run (combat collision, the look, combat sound, and everything at once) is in [prototype/results/run-2/report.md](../prototype/results/run-2/report.md), also on the dev machine only. The hypotheses it tests:

1. A Rust/WASM sim in one worker steps a few thousand entities (movement, spatial-hash collision, one flow field) within its budget at 30 Hz.
2. Worker snapshots plus vertex-shader interpolation look smooth at 60 fps and at 30 fps, with jitter and stalls, and the measured lag, queue, and pool sizes replace guesses.
3. GPU-driven rendering (compute culling, `drawIndirect`, render bundles) of that crowd stays within the GPU budget, and the draw count stays low with all kinds and layers.
4. Raw WebGPU starts, recovers from a lost device, and shows the "not supported" page correctly on the target browsers.
5. Startup (WASM compile, first chunk's assets, gzipped textures) and the GitHub Pages deploy, including a deploy while a tab is open, behave as described.
6. Chunk catch-up by direct calculation in job workers matches replaying every step, and saves survive the browser.

## Open question

Is the plane side-view (platformer style, with gravity and jumping) or top-down (a ground plane, free movement in two directions)? This decides the camera, the world layout, and whether gravity is part of the simulation. The axis rule above works for both.
