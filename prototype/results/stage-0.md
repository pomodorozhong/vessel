# Stage 0: skeleton

Verdict: **unclear** (the skeleton works locally on the dev machine in Chrome; the "loads from GitHub Pages in Chrome, Safari and Firefox" check could not be run, see below).

## What was built

- Vite 8 + TypeScript 7 app under `prototype/`, `base: '/vessel/'`, with a Pages workflow in `.github/workflows/deploy.yml`.
- WebGPU startup check (`navigator.gpu`, adapter, device, canvas context) and a "not supported" page (`src/gpu.ts`).
- Rust crate `prototype/sim` built to WASM twice (with and without `simd128`) by `scripts/build-wasm.mjs`, with no wasm-bindgen: the module exports plain functions and its memory.
- The main thread starts `WebAssembly.compileStreaming` before anything else and posts the compiled module to the sim worker.
- The worker steps the sim at 30 Hz on a self-correcting timer and transfers a snapshot buffer from a fixed pool of 4; the main thread clears a fixed 1920×1080 canvas each frame and returns buffers.
- Keyboard, mouse and gamepad are merged into one input state per frame and sent to the worker when it changes.
- Overlay: frame time, main-thread CPU time, GPU time (`timestamp-query`), sim step time reported by the worker, snapshot queue length, snapshots skipped and dropped.

## Results

| Check | Where measured | Result |
|---|---|---|
| Page loads, overlay shows numbers | dev machine, Chrome 156.0.8078.73, local `vite preview` build | yes: frame 16.67 ms (60 fps), main-thread CPU 0.16 ms median per frame, sim step 0.000 ms median (empty sim), queue length 1, adapter `nvidia ampere` |
| GPU time from `timestamp-query` | dev machine, Chrome 156 | available; a clear-only pass reads 0.00 ms (Chrome quantizes timestamps to 0.1 ms) |
| "Not supported" page with WebGPU turned off | dev machine, Chrome 156 with `--disable-features=WebGPU --disable-gpu` | shown, reason "No GPU adapter is available." |
| Loads from GitHub Pages | – | **unmeasured**: the branch could not be pushed (see "Blocked" below) |
| Edge | dev machine, Edge 157.0.4341.60, local `vite preview` build | loads and renders, overlay shows numbers, adapter `nvidia ampere` (measured in Stage 4, `results/data/stage4-edge.json`) |
| Safari | – | **unmeasured**: the dev machine runs Windows 11 and has no Safari |
| Firefox | – | **unmeasured**: Firefox is not installed on the dev machine |
| Gamepad input reaches the worker | – | **unmeasured**: no gamepad on the dev machine; the code path is the same as keyboard input after `navigator.getGamepads()` |
| Reference device | – | **provisional**: not run |

Raw data: `results/data/stage0-local.json`.

Dev machine: Intel Core i7-13700 (16 cores, 24 threads), 64 GB RAM, NVIDIA GeForce RTX 3060 (driver 32.0.15.6094), Windows 11 Pro 10.0.26200, 2560×1440 display at 60 Hz.

## Blocked

`git push` to `pomodorozhong/vessel` returned 403 for the account signed in on the dev machine (`skymiku39` has read access only), and the GitHub API reports that the repository has no Pages site (`has_pages: false`). So nothing in this run was deployed to or measured on GitHub Pages.

## Rerun steps

1. Push `prototype/run-1` with an account that can write to the repository, enable Pages with "GitHub Actions" as the source, and allow the `prototype/run-1` branch in the `github-pages` environment (or merge first).
2. Open `https://<owner>.github.io/vessel/` in Chrome, Edge, Safari (macOS) and Firefox. Pass: the overlay shows frame, cpu, gpu and sim numbers, or the "not supported" page shows.
3. Press a button on a gamepad: the overlay's `pad` line shows its id and `[standard]`, and the left stick changes the input sent to the worker.
4. Repeat step 2 on the reference device.
