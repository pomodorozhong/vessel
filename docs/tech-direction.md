# Technical direction

Vessel is a survival game with 3D visuals where every character moves in a single plane. It runs in the browser, and performance is the top priority.

The core idea: run a 2D game, simulated in 2D, and draw it in 3D. Rendering is only a view of the 2D state.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language and build | TypeScript + Vite | Fast dev loop and small, tree-shaken production bundles. |
| Rendering | Three.js, starting with `WebGLRenderer` | Small, fast, full control, biggest ecosystem. Its `WebGPURenderer` falls back to WebGL2 automatically, so we can switch later without a rewrite. |
| Game logic | bitECS (or plain typed arrays) | Data-oriented and almost garbage-free, so thousands of entities (enemies, trees, drops) run without GC stutter. |
| Physics | Custom 2D collision (AABB and circles plus a spatial hash grid). Rapier 2D (WASM) only if real rigid bodies are needed. | Characters move in one plane, so 3D physics is never needed. This is the biggest performance win. |
| Assets | glTF with meshopt compression, KTX2 textures | Small downloads, fast GPU upload, low memory use. |
| Audio | Howler.js or plain Web Audio | Light and reliable. |

### Ruled out

- Unity WebGL and Godot web exports: large downloads, slow startup, and heavy memory use in browsers.
- Babylon.js: fine, but heavier than we need.
- Bevy compiled to WASM: fast, but a harder toolchain and slow compiles.

## How the single plane shapes the design

- Simulation: entities have `x, y` and a facing direction. The sim runs on a fixed timestep (30–60 Hz), and rendering interpolates between steps.
- World: split into chunks along the plane. Only chunks near the player are simulated and drawn, which makes culling trivial.
- Camera: fixed angle. This lets us bake lighting into textures or vertex colors, skip geometry that is never seen, and use blob shadows instead of real shadow maps (or one small shadow map at most).
- Depth: background and foreground 3D layers (mountains, trees) are pure decoration with no game logic.

## Performance rules

1. Draw calls are the budget. Use `InstancedMesh` for repeated objects (trees, rocks, grass, enemies of one type) and texture atlases so many objects share one material. Target fewer than 100–200 draw calls.
2. No allocations in the game loop. Pool objects (projectiles, particles, drops) and reuse vectors.
3. Crowd animation uses vertex animation textures (animation on the GPU). Skeletal animation is only for the player and bosses.
4. Cap the pixel ratio at `Math.min(devicePixelRatio, 1.5)`, and add a dynamic resolution scale that drops when the frame rate drops.
5. Day and night cycle animates a few shader uniforms (light color, fog) instead of adding real lights.
6. At most one cheap post-processing pass (color grading or vignette), or none.
7. Measure from the start: keep a frame-time graph (stats.js) and test on a mid-range phone or laptop, not only the dev machine.

## Survival systems that fit this setup

- Resources and building live on a grid along the plane: cheap to store in typed arrays and cheap to collide against.
- Enemy AI uses simple state machines plus flow-field pathfinding on the grid. One flow field serves every enemy chasing the player, so it scales to hundreds of enemies.
- Save state is just 2D grids and entity lists, so saves are small and fast (IndexedDB).

## Open question

Is the plane side-view (platformer style, with gravity and jumping) or top-down (a ground plane, free movement in two directions)? This decides the camera, the world layout, and whether gravity is part of the simulation.
