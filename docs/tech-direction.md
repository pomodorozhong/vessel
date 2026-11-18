# Technical direction

Vessel is a survival game with 3D visuals where every character moves in a single plane. It runs in the browser, and performance is the top priority.

The core idea: run a 2D game, simulated in 2D, and draw it in 3D. Rendering is only a view of the 2D state.

## Guiding principle: own the runtime

AI agents make writing code cheap, so we prefer control over ready-made features. Code the game runs in the browser is ours wherever it is small enough to own: the renderer, the entity storage, the audio mixer, the debug overlay. We keep outside libraries where they hold years of hard-won knowledge rather than just saving typing (a physics solver, mesh and texture encoders), and we use them as build-time tools or an escape hatch, not as code the game runs.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language and build | TypeScript + Vite | Fast dev loop and small, tree-shaken production bundles. Types help agents as much as people. Vite loads `.wgsl` files as text with no extra tools. |
| Rendering | Raw WebGPU with WGSL shaders, no engine or rendering library | Vessel needs a small renderer: one plane, a fixed camera, instanced meshes, almost no post-processing. Owning it lets entity data go straight from typed arrays into GPU buffers, and lets crowds, particles, and flow fields use compute shaders. |
| Math | wgpu-matrix | Small, allocation-free vector and matrix math laid out for WebGPU buffers. Writing our own would gain nothing. |
| Game logic | Our own struct-of-arrays tables (typed arrays), no ECS library | Almost garbage-free, so thousands of entities (enemies, trees, drops) run without GC stutter. We choose the memory layout, so each table can match the GPU buffer it feeds, including padding and grouping. |
| Physics | Custom 2D collision (AABB and circles plus a spatial hash grid). Rapier 2D (WASM) only if real rigid bodies are needed. | Characters move in one plane, so 3D physics is never needed. This is the biggest performance win. |
| Assets | A build-time pipeline: glTF in, our own binary formats out | See "Asset pipeline" below. Loading becomes "download, then upload to the GPU", with no parsing and no transcoder download. |
| Audio | Plain Web Audio with our own small mixer | Every browser with WebGPU has Web Audio, so a library's old-browser fallbacks add nothing. Our mixer controls sound pools and distance-based volume directly. |
| Debug overlay | Our own frame-time overlay | Shows CPU time and GPU time (from `timestamp-query`) side by side, which off-the-shelf counters cannot. |
| Hosting | GitHub Pages | Free static hosting with HTTPS. See "Hosting on GitHub Pages" below for what it rules out. |

### The trade-off: WebGPU is required

There is no WebGL fallback. A browser or device without WebGPU (older iPhones, some Android GPUs, blocklisted drivers, some Linux setups) cannot run the game. We accept this in exchange for full control and lower overhead.

- At startup, check `navigator.gpu` and `requestAdapter()`. If either fails, show a clear "your browser does not support WebGPU" page with a list of supported browsers, not a blank screen.
- Use only core WebGPU limits. Optional features, such as a compressed texture format (BC, ETC2, or ASTC), are picked at runtime from what the adapter offers.
- Anything a library would normally handle (device-specific bugs, lost devices, resizing) is our job. Handle `device.lost` by rebuilding GPU resources from the entity tables.

### Ruled out

- Three.js (either renderer): its scene graph and material system are more than Vessel needs, and every entity would be copied from our arrays into its objects each frame. Its WebGL2 fallback is the main thing we give up.
- Babylon.js: same reasons, and heavier.
- Unity WebGL and Godot web exports: large downloads, slow startup, and heavy memory use in browsers.
- Bevy compiled to WASM: fast, but a harder toolchain and slow compiles.
- bitECS: thin and fast, but its storage layout and API are not ours, and matching GPU buffer layouts is the point.
- Howler.js: its main extra is a fallback for browsers that cannot run the game anyway.
- Runtime Basis (KTX2) transcoding: it needs a WASM transcoder download at startup. We encode each GPU texture format at build time instead.

## Asset pipeline

glTF stays the format artists export. A build script turns it into files the game can upload without parsing.

- Models: converted to our own binary format whose vertex and index layout matches the GPU buffers. Vertex and index data stay meshopt-encoded, which shrinks them on its own; the meshopt decoder is a few kilobytes and is the only decoder the game loads.
- Textures: encoded at build time into each GPU format (BC7 for desktop, ASTC and ETC2 for phones), stored in KTX2 containers without Basis, and gzipped. The game downloads only the format the device supports and unpacks it with the browser's built-in `DecompressionStream`, so no extra library or WASM is needed.
- Every output file name includes a content hash, so caches never serve a stale file (see "Hosting on GitHub Pages").
- The encoders (meshopt, BC7, ASTC, and ETC2 encoders) run only at build time and are never shipped.

## How the single plane shapes the design

- Simulation: entities have `x, y` and a facing direction. The sim runs on a fixed timestep (30–60 Hz), and rendering interpolates between steps.
- Axes: the sim plane is the world's XY plane in both layouts, so sim `x, y` go into shaders unchanged. The third axis, Z, is depth (into the screen) for side-view, or height above the ground for top-down. Only the camera differs between the two.
- World: split into chunks along the plane. Chunks near the player are simulated and drawn; the rest are only stored, which makes culling trivial. See "Chunks away from the player" below for how stored chunks catch up.
- Camera: fixed angle. This lets us skip geometry that is never seen and use blob shadows instead of shadow maps.
- Lighting: only ambient occlusion is baked into textures or vertex colors, because it does not depend on the time of day. Direct light comes from one directional "sun" whose direction, color, and strength are shader uniforms, so it can follow the day and night cycle.
- Depth: background and foreground 3D layers (mountains, trees) are pure decoration with no game logic.

## Performance rules

1. Draw calls are the budget: at most 100 per frame on the reference phone (see rule 8). Draw repeated objects (trees, rocks, grass, enemies of one type) as one instanced draw each, and use texture atlases so many objects share one pipeline and bind group.
2. No allocations in the game loop. Pool objects (projectiles, particles, drops), reuse vectors, and write into persistent GPU buffers instead of creating new ones.
3. Crowd animation uses vertex animation textures (animation on the GPU). Skeletal animation is only for the player and bosses.
4. Cap the pixel ratio at `Math.min(devicePixelRatio, 1.5)`, and add a dynamic resolution scale that drops when the frame rate drops.
5. The day and night cycle changes a few shader uniforms (sun direction, light color and strength, fog, sky color) instead of adding real lights.
6. At most one cheap post-processing pass (color grading or vignette), or none.
7. Startup cost counts. The only decoder downloaded at startup is the small meshopt decoder; textures need none (see "Asset pipeline"). Fetch the first chunk's assets in parallel with the code.
8. Measure from the start with our own overlay: CPU frame time and GPU time (the `timestamp-query` feature where available). The reference device is a mid-range Android phone a few years old; test on it, not only on the dev machine.

## Survival systems that fit this setup

- Resources and building live on a grid along the plane: cheap to store in typed arrays and cheap to collide against.
- Enemy AI uses simple state machines plus flow-field pathfinding on the grid. One flow field serves every enemy with the same goal, so there is one field per goal (the player, the base core, and so on), not one per enemy. A field is rebuilt when its goal moves to a new cell or the grid changes. If the number of goals grows, fields can be built in a compute shader.
- Save state is just 2D grids and entity lists, so saves are small and fast (IndexedDB).

### Chunks away from the player

Survival systems keep running while the player is away, so stored chunks must not simply freeze.

- Each stored chunk records the sim tick it was last updated.
- When a chunk becomes active again, time-based systems (crop growth, smelting, fuel burn, spoilage) fast-forward by the elapsed ticks with a direct calculation, not by replaying every step.
- Enemies in stored chunks are despawned or kept as a simple count, not simulated one by one.
- Events that matter while the player is away, such as a raid on the base, are resolved by a coarse summary simulation at a low rate.

## Hosting on GitHub Pages

GitHub Pages serves static files only. We cannot set HTTP headers, cache times, or compression, and the rules below follow from that.

- No shared memory between threads. `SharedArrayBuffer` needs the COOP and COEP headers, which Pages cannot send. We do not use the service-worker trick that fakes these headers (coi-serviceworker): it reloads the page on the first visit and is fragile.
- Compression is ours. Pages gzips common text types (JS, CSS, JSON) but not our binary formats, so the asset pipeline compresses them itself (meshopt for models, gzip for textures).
- Caching is short and fixed: Pages tells browsers to keep files for about 10 minutes. Every built file has a content hash in its name, and a small service worker stores hashed files permanently, so returning players load almost instantly. The service worker never caches `index.html` permanently, so new releases are picked up.
- Base path: the site lives under the repository name, so Vite uses `base: '/vessel/'` (or `/` with a custom domain).
- Deploys run from a GitHub Actions workflow that builds the code and the assets and publishes the output.
- Limits: about 1 GB per site, 100 MB per file, and a soft limit of about 100 GB of bandwidth per month. These are fine for a small game, but they are one more reason to keep assets compact.
- Free Pages requires a public repository; a private one needs a paid GitHub plan.
- HTTPS is built in, which WebGPU requires.

## Later

- Run the simulation in a Web Worker so it never competes with rendering for the main thread. Without shared memory (see "Hosting on GitHub Pages"), the worker sends its finished state arrays to the main thread with `postMessage` as transferable buffers, so nothing is copied, and gets them back for the next step. This is a real gain on phones but adds complexity, so it is not a day-one rule.

## Open question

Is the plane side-view (platformer style, with gravity and jumping) or top-down (a ground plane, free movement in two directions)? This decides the camera, the world layout, and whether gravity is part of the simulation. The axis rule above works for both.
