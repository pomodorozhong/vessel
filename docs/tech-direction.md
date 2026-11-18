# Technical direction

Vessel is a survival game with 3D visuals where every character moves in a single plane. It runs in the browser, and performance is the top priority.

The core idea: run a 2D game, simulated in 2D, and draw it in 3D. Rendering is only a view of the 2D state.

## Guiding principle: own the runtime

AI agents make writing code cheap, so we prefer control over ready-made features. Code the game runs in the browser is ours wherever it is small enough to own: the simulation, the renderer, the entity storage, the audio mixer, the debug overlay. We keep outside libraries where they hold years of hard-won knowledge rather than just saving typing (a physics solver, mesh and texture encoders), and we use them as build-time tools or an escape hatch. Runtime libraries are the exception, allowed only when they are small and focused on one job. Today there are two: the meshopt decoder and wgpu-matrix.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Simulation | Rust compiled to WASM (with SIMD), running single-threaded in a worker | Steady speed with no garbage collector and no JIT warm-up, SIMD for the hot loops (collision, AI, movement), and the main thread is left free for rendering. Starting in Rust avoids a port later. |
| Glue (input, UI, audio, build) | TypeScript + Vite | WebGPU is a JavaScript API, so rendering, input, UI, and audio stay in TypeScript. Types help agents as much as people. Vite loads `.wgsl` files as text and bundles the WASM module. |
| Rendering | Raw WebGPU with WGSL shaders, GPU-driven, no engine or rendering library | Vessel needs a small renderer: one plane, a fixed camera, instanced meshes, almost no post-processing. Owning it lets entity data go from the sim's tables into GPU buffers with one copy per step, and lets culling, crowd animation, and particles run in compute shaders. See "Rendering" below. |
| Math | wgpu-matrix on the TypeScript side | Small, allocation-free vector and matrix math laid out for WebGPU buffers, for the camera and render setup. The sim is 2D and does its own math in Rust. |
| Entity storage | Our own struct-of-arrays tables in WASM memory, no ECS library | No garbage at all, so thousands of entities (enemies, trees, drops) run without stutter. We choose the memory layout, so the render data each table produces matches the GPU buffer it feeds, including padding and grouping. |
| Physics | Custom 2D collision in Rust (AABB and circles plus a spatial hash grid). Rapier 2D only if real rigid bodies are needed. | Characters move in one plane, so 3D physics is never needed. This is the biggest performance win. Rapier is written in Rust, so it would drop straight into the sim if ever needed. |
| Assets | A build-time pipeline: glTF in, our own binary formats out | See "Asset pipeline" below. Loading becomes "download, then upload to the GPU", with no parsing and no transcoder download. |
| Audio | Plain Web Audio with our own small mixer | Every browser with WebGPU has Web Audio, so a library's old-browser fallbacks add nothing. Our mixer controls sound pools and distance-based volume directly. |
| Debug overlay | Our own frame-time overlay | Shows CPU time per system and GPU time (from `timestamp-query`) side by side, which off-the-shelf counters cannot. |
| Hosting | GitHub Pages | Free static hosting with HTTPS, deployed from this repository. See "Hosting on GitHub Pages" below for what it rules out. |

### The trade-off: WebGPU is required

There is no WebGL fallback. A browser or device without WebGPU (older iPhones, some Android GPUs, blocklisted drivers, some Linux setups) cannot run the game. We accept this in exchange for full control and lower overhead.

- At startup, check three things: `navigator.gpu` exists, `requestAdapter()` returns an adapter (it resolves to null rather than throwing when none is available), and `requestDevice()` does not reject. If any check fails, show a clear "your browser does not support WebGPU" page with a list of supported browsers, not a blank screen.
- Use only core WebGPU limits. Optional features, such as a compressed texture format (BC, ETC2, or ASTC) or `shader-f16`, are picked at runtime from what the adapter offers.
- Anything a library would normally handle (device-specific bugs, lost devices, resizing) is our job. Handle `device.lost` by requesting a new device and rebuilding everything on it: re-upload meshes and textures (the service worker cache makes re-fetching them cheap), recreate pipelines, re-record render bundles, and refill the instance buffers from the latest sim snapshot. The renderer keeps a list of what it has loaded so this is one code path, not a special case.

### Ruled out

- Three.js (either renderer): its scene graph and material system are more than Vessel needs, and every entity would be copied from our arrays into its objects each frame. Its WebGL2 fallback is the main thing we give up.
- Babylon.js: same reasons, and heavier.
- Unity WebGL and Godot web exports: large downloads, slow startup, and heavy memory use in browsers.
- Bevy compiled to WASM: fast, but it brings a whole engine and its own renderer, when we only want Rust for the simulation.
- A TypeScript simulation: careful typed-array TypeScript gets close to WASM, but not to its steady timing and SIMD, and porting a grown sim later costs more than starting in Rust.
- bitECS: thin and fast, but its storage layout and API are not ours, and matching GPU buffer layouts is the point.
- Howler.js: its main extra is a fallback for browsers that cannot run the game anyway.
- Runtime Basis (KTX2) transcoding: it needs a WASM transcoder download at startup. We encode each GPU texture format at build time instead.

## Threads and workers

GitHub Pages cannot send the headers needed for shared memory (see "Hosting on GitHub Pages"), so threads cannot share one live world. Work is split this way instead:

- Main thread: input, rendering, audio, and UI only. It never runs game logic.
- Sim worker: one worker runs the Rust/WASM simulation on a fixed timestep. After each step it copies the render data (positions, facing, animation state, and so on) into a snapshot buffer and sends it to the main thread with `postMessage` as a transferable buffer, so nothing is copied in transit. A pool of four snapshot buffers rotates between the threads: the main thread keeps the latest two to interpolate between and sends older ones back for reuse, which leaves the worker one buffer to write into and one spare in transit. If the main thread stalls and no buffer is free, the worker skips that step's snapshot and never allocates a new one. If the render clock passes the newest snapshot, the main thread holds entities at that snapshot rather than extrapolating, so nothing is drawn through a wall or past where it stopped. Input goes the other way as small messages.
- Job workers: work that does not touch the live world runs as separate jobs, each sent to a worker and returned as a transferable buffer. Good fits are rebuilding flow fields, catching up chunks away from the player, generating new world chunks, and preparing save files.
- GPU: the heavy parallel work that only affects what is drawn (culling, crowd animation, particles) runs in compute shaders. Anything the sim reads, such as flow fields, is built on the CPU, because the GPU device belongs to the main thread and results would have to be read back and forwarded to the sim worker.

The simulation is written as per-chunk jobs even though it runs on one thread today. If the game ever moves to a host that sends the COOP and COEP headers, those jobs can run on several threads with shared memory (for example with Rust's rayon) without redesigning the sim.

## Rendering

- GPU-driven: every instance of every kind lives in a few large GPU buffers. A compute shader culls them and writes the draw counts, and the frame is drawn with `drawIndirect`. The CPU does almost no per-object work, and the number of draw calls does not grow with the number of entities.
- Render bundles: the fixed sequence of draw commands (pipelines, bind groups, and the `drawIndirect` calls over the culled buffers) is recorded once into render bundles and replayed each frame for almost no CPU cost. Bundles hold no per-chunk or per-entity draws, so chunks streaming in and out only change buffer contents, and everything in a bundle still goes through compute culling.
- Debugging GPU-driven rendering is harder, because culling happens where it cannot easily be inspected. The debug overlay includes a view of the culled and drawn instance counts per kind.

## Asset pipeline

glTF stays the format artists export. A build script turns it into files the game can upload without parsing.

- Models: converted to our own binary format whose vertex and index layout matches the GPU buffers, with attributes packed into 8- and 16-bit formats instead of 32-bit floats. Vertex and index data stay meshopt-encoded, which shrinks them on its own; the meshopt decoder is a few kilobytes and is the only decoder the game loads.
- Textures: encoded at build time into each GPU format (BC7 for desktop, ASTC and ETC2 for phones), with mipmaps, stored in KTX2 containers without Basis, and gzipped. Plain BC7 and ASTC blocks barely shrink under gzip, so the encoders run in rate-distortion-optimized (RDO) mode, which trades a little quality for blocks that gzip compresses well. We measure the size gain per format; if it is still poor, we look at zstd with our own small decoder. The build also writes an uncompressed RGBA8 fallback, used only when the adapter offers none of `texture-compression-bc`, `-astc`, or `-etc2`. The game downloads only the format the device supports and unpacks it with the browser's built-in `DecompressionStream`, so no extra library or WASM is needed.
- Every output file name includes a content hash, so caches never serve a stale file (see "Hosting on GitHub Pages").
- The encoders (meshopt, BC7, ASTC, and ETC2 encoders) run only at build time and are never shipped.

## How the single plane shapes the design

- Simulation: entities have `x, y` and a facing direction. The sim runs on a fixed timestep at 30 Hz by default, and rendering interpolates between steps.
- Axes: the sim plane is the world's XY plane in both layouts, so sim `x, y` go into shaders unchanged. The world is right-handed like glTF. The third axis, Z, is depth for side-view (with X right and Y up, +Z points toward the viewer, so the camera looks down -Z), or height above the ground for top-down. Only the camera differs between the two. glTF is always Y-up, so the asset pipeline rotates models into these axes at build time (a no-op for side-view, Y-up to Z-up for top-down); nothing is rotated at runtime.
- World: split into chunks along the plane. Chunks near the player are simulated and drawn; the rest are only stored, which makes culling trivial. See "Chunks away from the player" below for how stored chunks catch up.
- Camera: fixed angle. This lets us skip geometry that is never seen and use blob shadows instead of shadow maps.
- Lighting: only ambient occlusion is baked into textures or vertex colors, because it does not depend on the time of day. Direct light comes from one directional "sun" whose direction, color, and strength are shader uniforms, so it can follow the day and night cycle.
- Depth: background and foreground 3D layers (mountains, trees) are pure decoration with no game logic.

## Performance rules

### Budgets and measuring

1. Measure from the start with our own overlay: CPU time per system and GPU time (the `timestamp-query` feature where available). The reference device is a mid-range Android phone a few years old; test on it, not only on the dev machine.
2. Every system has a time budget on the reference phone (for example: sim step 4 ms, render encoding 2 ms). A system over its budget is fixed before new features are added.
3. Leave headroom for heat. Phones slow down when they get hot, so aim to use about 60% of the frame time on the reference phone, not 100%.
4. Draw calls are capped at 100 per frame on the reference phone. GPU-driven rendering and instancing keep the real number far below that.

### GPU

5. Draw repeated objects (trees, rocks, grass, enemies of one type) as instances, and use texture atlases so many objects share one pipeline and bind group.
6. Keep overdraw down: phones are limited by how many pixels they can draw, so how many times each pixel is drawn matters more than triangle count. Draw solid objects front to back, keep alpha blending to small areas, and keep particles small.
7. Use small data: packed vertex attributes (see "Asset pipeline"), compressed textures with mipmaps, and 16-bit floats in shaders where `shader-f16` is available.
8. Crowd animation uses vertex animation textures (animation on the GPU). Skeletal animation is only for the player and bosses.
9. Cap the pixel ratio at `Math.min(devicePixelRatio, 1.5)`, and add a dynamic resolution scale that drops when the frame rate drops.
10. The day and night cycle changes a few shader uniforms (sun direction, light color and strength, fog, sky color) instead of adding real lights.
11. At most one cheap post-processing pass (color grading or vignette), or none.
12. Create every pipeline at load time with `createRenderPipelineAsync` and `createComputePipelineAsync`, so no shader is compiled mid-game.
13. Never wait on GPU data during a frame. A `mapAsync` on the current frame's data makes the CPU wait for the GPU. Data the CPU does need, such as `timestamp-query` results and the overlay's instance counts, is copied into a small ring of map buffers and read a few frames later, without blocking. Nothing the sim depends on comes from the GPU.
14. Upload only what changed. Per buffer per frame, upload the changed data in as few `writeBuffer` calls as possible: one call over the contiguous dirty span when changes are close together, or one call per dirty range when they are far apart. Each call writes one contiguous range, so never upload a whole buffer just to keep to a single call.

### Simulation

15. No allocations in the game loop, on either side. Pool objects (projectiles, particles, drops), reuse buffers, and write into persistent GPU buffers instead of creating new ones. The one accepted exception is the small, fixed cost of `postMessage` per sim step (the message event and its wrapper); it cannot be removed without shared memory, and the snapshot data itself is never allocated.
16. Keep data in cache-friendly order: sort entities by grid cell so neighbours sit next to each other in memory, which speeds up both collision and AI.
17. Spread work over time: the sim steps at 30 Hz with interpolation, each enemy's AI "thinks" a few times per second staggered so it isn't all on the same frame, and far-away crowds animate less often.
18. Keep the JS/WASM boundary coarse: one call steps the whole sim, never one call per entity.

### Main thread and startup

19. Keep the DOM out of the frame. Draw the in-game UI on the canvas, or update DOM elements only when their value changes, never every frame.
20. Startup cost counts. The only decoder downloaded at startup is the small meshopt decoder; textures need none (see "Asset pipeline"). Fetch the WASM module (with `WebAssembly.instantiateStreaming`) and the first chunk's assets in parallel with the code.

## Survival systems that fit this setup

- Resources and building live on a grid along the plane: cheap to store in typed arrays and cheap to collide against.
- Enemy AI uses simple state machines plus flow-field pathfinding on the grid. One flow field serves every enemy with the same goal, so there is one field per goal (the player, the base core, and so on), not one per enemy. Fields whose goal rarely moves (the base core, a camp) are rebuilt as job worker tasks when the grid changes, and the sim swaps in the new field when the job returns. The player's field changes every time the player crosses a cell, and a job would have to copy the grid out each time and would return an already stale field, so the sim builds it itself, limited to the active chunks and updated incrementally from the previous field.
- Save state is just 2D grids and entity lists, so saves are small and fast (IndexedDB). A job worker prepares the save data so the sim never pauses for it.

### Chunks away from the player

Survival systems keep running while the player is away, so stored chunks must not simply freeze.

- Each stored chunk records the sim tick it was last updated.
- When a chunk becomes active again, time-based systems (crop growth, smelting, fuel burn, spoilage) fast-forward by the elapsed ticks with a direct calculation, not by replaying every step. This runs as a job worker task, so it has to finish before the chunk is needed: the sim keeps a ring of chunks just outside the active area, starts catch-up when a chunk enters that ring, and activates it only once the job has returned. The job reports the tick it caught up to, and on activation the sim applies the short remaining gap with the same direct calculation, which is cheap enough to run inline. A chunk is never activated with stale state.
- Enemies in stored chunks are despawned or kept as a simple count, not simulated one by one.
- Events that matter while the player is away, such as a raid on the base, are resolved by a coarse summary simulation at a low rate.

## Hosting on GitHub Pages

GitHub Pages serves static files only. We cannot set HTTP headers, cache times, or compression, and the rules below follow from that.

- No shared memory between threads. `SharedArrayBuffer`, and so multithreaded WASM, needs the COOP and COEP headers, which Pages cannot send. "Threads and workers" above describes how we work without it. We do not use the service-worker trick that fakes these headers (coi-serviceworker): it reloads the page on the first visit and is fragile.
- Compression is ours. Pages gzips common text types (JS, CSS, JSON) but not our binary formats, so the asset pipeline compresses them itself (meshopt for models, gzip for textures). The sim's `.wasm` module is one of the largest files at startup, so the first deploy checks whether Pages compresses `application/wasm`. If it does not, the build gzips the module, and the loader pipes the download through `DecompressionStream` into a `Response` with the `application/wasm` type, so `WebAssembly.instantiateStreaming` still works.
- Caching is short and fixed: Pages tells browsers to keep files for about 10 minutes. Every built file has a content hash in its name, and a small service worker stores hashed files permanently, so returning players load almost instantly. The service worker never caches `index.html` permanently, so new releases are picked up. Each build writes a manifest of its hashed files, and when a new service worker activates it deletes cached files that are not in that manifest, so storage does not grow with every release and does not put the IndexedDB saves at risk of eviction.
- Base path: the site lives under the repository name, so Vite uses `base: '/vessel/'` (or `/` with a custom domain).
- Deploys run from a GitHub Actions workflow that builds the Rust sim to WASM, builds the code and the assets, and publishes the output.
- Limits: about 1 GB per site, 100 MB per file, and a soft limit of about 100 GB of bandwidth per month. These are fine for a small game, but they are one more reason to keep assets compact.
- Free Pages requires a public repository; a private one needs a paid GitHub plan.
- HTTPS is built in, which WebGPU requires.

### Why not Cloudflare Pages or Netlify

Both are free, deploy from the same repository, and let us set headers. With COOP and COEP they would allow multithreaded WASM, and they compress files and allow long cache times, which would remove several of the rules above. We stay on GitHub Pages anyway: one sim thread plus job workers and the GPU should fit our budgets, and keeping hosting in GitHub keeps the setup simple. Because the sim is written as per-chunk jobs, moving to such a host later is a small change, made only if measurements show the single sim thread going over its budget.

## Open question

Is the plane side-view (platformer style, with gravity and jumping) or top-down (a ground plane, free movement in two directions)? This decides the camera, the world layout, and whether gravity is part of the simulation. The axis rule above works for both.
