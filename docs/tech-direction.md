# Technical direction

Vessel is a survival game with 3D visuals where every character moves in a single plane. It runs in the browser, and performance is the top priority.

The core idea: run a 2D game, simulated in 2D, and draw it in 3D. Rendering is only a view of the 2D state.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language and build | TypeScript + Vite | Fast dev loop and small, tree-shaken production bundles. |
| Rendering | Raw WebGPU with WGSL shaders, no engine or rendering library | Vessel needs a small renderer: one plane, a fixed camera, instanced meshes, almost no post-processing. Owning it lets entity data go straight from typed arrays into GPU buffers, and lets crowds, particles, and flow fields use compute shaders. |
| Math | wgpu-matrix | Small, allocation-free vector and matrix math laid out for WebGPU buffers. |
| Game logic | bitECS (or plain typed arrays) | Data-oriented and almost garbage-free, so thousands of entities (enemies, trees, drops) run without GC stutter. The same arrays feed the GPU buffers. |
| Physics | Custom 2D collision (AABB and circles plus a spatial hash grid). Rapier 2D (WASM) only if real rigid bodies are needed. | Characters move in one plane, so 3D physics is never needed. This is the biggest performance win. |
| Assets | glTF with meshopt compression, KTX2 textures, read by our own small loader | Small downloads, fast GPU upload, low memory use. |
| Audio | Howler.js or plain Web Audio | Light and reliable. |

### The trade-off: WebGPU is required

There is no WebGL fallback. A browser or device without WebGPU (older iPhones, some Android GPUs, blocklisted drivers, some Linux setups) cannot run the game. We accept this in exchange for full control and lower overhead.

- At startup, check `navigator.gpu` and `requestAdapter()`. If either fails, show a clear "your browser does not support WebGPU" page with a list of supported browsers, not a blank screen.
- Use only core WebGPU limits. Optional features, such as a compressed texture format (BC, ETC2, or ASTC), are picked at runtime from what the adapter offers.
- Anything a library would normally handle (device-specific bugs, lost devices, resizing) is our job. Handle `device.lost` by rebuilding GPU resources from the ECS state.

### Ruled out

- Three.js (either renderer): its scene graph and material system are more than Vessel needs, and every entity would be copied from our arrays into its objects each frame. Its WebGL2 fallback is the main thing we give up.
- Babylon.js: same reasons, and heavier.
- Unity WebGL and Godot web exports: large downloads, slow startup, and heavy memory use in browsers.
- Bevy compiled to WASM: fast, but a harder toolchain and slow compiles.

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
7. Startup cost counts. The Basis transcoder (for KTX2) and the meshopt decoder are WASM downloads; self-host them, fetch them in parallel with the first chunk, and let the browser cache them.
8. Measure from the start: keep a frame-time graph (stats.js) and GPU timing (the `timestamp-query` feature where available). The reference device is a mid-range Android phone a few years old; test on it, not only on the dev machine.

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

## Open question

Is the plane side-view (platformer style, with gravity and jumping) or top-down (a ground plane, free movement in two directions)? This decides the camera, the world layout, and whether gravity is part of the simulation. The axis rule above works for both.
