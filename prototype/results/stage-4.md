# Stage 4: is raw WebGPU reliable enough?

Hypothesis: a raw WebGPU renderer with no fallback starts, recovers, and fails cleanly on the target browsers.

Verdict: **unclear**. Everything that could be run on the dev machine passed with one limit found (Chrome and Edge on Windows: startup, recovery from a GPU process crash without a reload, both "not supported" paths). But the pass bar also names Chrome and Edge on macOS and Safari on macOS, and those, Firefox, sleep and wake, and every gamepad check are **unmeasured**: the dev machine is a Windows desktop with only Chrome and Edge installed and no gamepad. Half of the bar is missing, so the hypothesis is neither held nor failed.

No fallback is applied. The fallback ("if too many target players lack WebGPU, revisit the no-WebGL-fallback decision") depends on the support count below, which has no threshold in the plan; the number is recorded for a person to judge.

## Results

All rows: dev machine (Intel Core i7-13700, NVIDIA RTX 3060, driver 32.0.15.6094, Windows 11 Pro 10.0.26200), local production build served by `vite preview`, page `?render=gpu&n=2000&spawn=40` (the Stage 3 GPU-driven renderer). Rerun with `node scripts/stage4.mjs chrome edge` and `GAP=150 TAG=-gap150 node scripts/stage4.mjs chrome`. Raw data: `results/data/stage4-chrome.json`, `stage4-edge.json`, `stage4-chrome-gap150.json` (rerun after review, 60 s retry) and the `-retry5s` files (first version), log `results/data/stage4.log`.

### Startup and adapter features

| Browser | Starts and renders | Time to ready (ms, local server, one run) | Adapter | `texture-compression-bc` | `shader-f16` | `timestamp-query` | `indirect-first-instance` |
|---|---|---|---|---|---|---|---|
| Chrome 156.0.8078.73, Windows 11 | yes | 861 | nvidia, ampere | yes | yes | yes | yes |
| Edge 157.0.4341.60, Windows 11 | yes | 1,042 | nvidia, ampere | yes | yes | yes | yes |
| Chrome, macOS | **unmeasured** | | | | | | |
| Edge, macOS | **unmeasured** | | | | | | |
| Safari, macOS | **unmeasured** | | | | | | |
| Firefox (any OS) | **unmeasured** (not installed; see "Where Firefox stands") | | | | | | |

Full feature lists are in the raw data (21 features in Chrome, 22 in Edge, which adds `atomic-vec2u-min-max`). `timestamp-query` needed no flag in either browser. The prototype's renderer uses none of the optional features for drawing: indirect draws keep `firstInstance` at 0, and BC textures are only used by the Stage 5 page.

### A lost device the game did not cause

The GPU process was crashed with the DevTools protocol command `Browser.crashGpuProcess`, which is what `chrome://gpucrash` does (the browser ignores that URL when automation navigates to it, which is why the first attempt at this test crashed nothing). The page gets `device.lost` with reason `unknown` and message "A valid external Instance reference no longer exists." The game then asks for a new adapter and device, chooses optional features again, and rebuilds every pipeline and buffer in one code path, retrying every 250 ms for 60 s; the sim worker is not touched.

| Browser | Crash | Result | Time from `device.lost` to drawing again (ms) | Sim kept running | Features on the new adapter |
|---|---|---|---|---|---|
| Chrome 156 | 1st | recovered without a reload, first attempt | 703 | yes | same four |
| Chrome 156 | 2nd, 20 s after the 1st | **not recovered**: no adapter for 60 s (240 tries), "not supported" page shown ("The GPU device was lost and did not come back."); a page reload then brought the game back | – | yes | – |
| Edge 157 | 1st | recovered without a reload, first attempt | 818 | yes | same four |
| Edge 157 | 2nd, 20 s after the 1st | **not recovered** for 60 s, same as Chrome; a reload then brought the game back | – | yes | – |
| Chrome 156, second run with 150 s between crashes | 1st | recovered without a reload, first attempt | 664 | yes | same four |
| Chrome 156, same run | 2nd, 150 s after the 1st | recovered without a reload, first attempt | 632 | yes | same four |
| Chrome 156, same run | 3rd, 150 s after the 2nd | **not recovered** for 60 s, and **a reload did not help**: the reloaded page shows "No GPU adapter is available." | – | yes | – |

These rows are from the rerun after review, where the game retries for 60 s (240 tries, 250 ms apart). The first version retried for only 5 s, which could not tell "no adapter for 5 s" from "no adapter until a reload"; its results were the same in kind (six recoveries in 612–694 ms; second crash at 20 s and third at 150 s not recovered) and are kept in `results/data/stage4-*-retry5s.json`. Every recovery that happened took the first attempt; none came after a wait.

The snapshot clock counted 2 pauses and 1 jump in both browsers across the first crash (the canvas shows nothing for about 0.7 s).

- **Sleep and wake with the tab open: unmeasured.** Putting the dev machine to sleep would have stopped this unattended run.
- A loss from `device.destroy()` is treated as on purpose (reason `destroyed`) and does not start recovery; it was not used as a recovery test.

### "Not supported" page

| Case | Browser | Page shown | Reason text |
|---|---|---|---|
| No adapter: `--disable-gpu --disable-software-rasterizer` (`requestAdapter()` resolves to null) | Chrome 156, Edge 157 | yes | "No GPU adapter is available." |
| `navigator.gpu` missing, **simulated** by hiding the property before the page's scripts run (no Chrome 156 flag removes it: `--disable-features=WebGPU` and `--disable-blink-features=WebGPU` both left WebGPU working) | Chrome 156, Edge 157 | yes | "navigator.gpu is missing." |
| Device lost and no adapter comes back | Chrome 156, Edge 157 | yes (see above) | "The GPU device was lost and did not come back." |
| A real browser without WebGPU (old Safari, Firefox on Linux) | – | **unmeasured** | |

The page names the supported browsers and suggests checking hardware acceleration and the graphics driver.

### Gamepad

**Unmeasured in every browser**: no gamepad is connected to the dev machine. The code reads `navigator.getGamepads()` once per frame, uses button and axis numbers only when `mapping === "standard"`, and shows the gamepad's id and mapping in the overlay's `pad` line.

### How many players have WebGPU (public data, read on 2026-11-19)

| Source | Figure |
|---|---|
| caniuse.com, "WebGPU", global usage, all devices | 86.83% full support + 1.8% partial = 88.63% |
| web3dsurvey.com, WebGPU, all sampled visits | 84.24% |
| web3dsurvey.com by OS | Windows 88.41%, macOS 91.05%, ChromeOS 92.81%, Linux 19.01% |
| web3dsurvey.com by browser | Edge 93.25%, Chrome 85.3%, Safari 82.64%, Firefox 63.82% |
| web3dsurvey.com, of WebGPU adapters | `texture-compression-bc` 87.22% (all platforms, phones included), `shader-f16` 94.15%, `timestamp-query` 98.88%, `indirect-first-instance` 99.97% |

- A rough count for our target (desktop, Windows and macOS): **about 9 in 10 visitors have WebGPU, about 1 in 10 does not**. Linux desktop is mostly without it (about 1 in 5 has it).
- Both sources count visits to sites that sample their audience, not our players, and both include phones in the global figures. One search-result summary quoted 73.97% for web3dsurvey's overall figure, which does not match the 84.24% read from the page itself; the page figure is used here.
- Whether 1 in 10 is "too many" is a product decision the plan gives no threshold for. It is recorded, and the no-fallback decision is left as it is.

### Where Firefox stands (from the gpuweb implementation status wiki, read on 2026-11-19; not measured here)

- Firefox ships WebGPU on Windows from version 141 and on macOS (Apple Silicon) from 145 to 147; Linux is Nightly only.
- Chromium ships it on Windows, macOS and ChromeOS from 113, and on Linux for Intel Gen12+ from 144 and NVIDIA from 147.
- Safari ships it from Safari 26.

## Limits found

- **A GPU process crash is recovered in about 0.6–0.8 s, but only so many times.** A second crash 20 s after the first is not recovered: no adapter comes back in 60 s of retrying, and a page reload then gets one at once. With 150 s between crashes the second one is recovered too, and the third is not, even after a reload: the browser stops offering an adapter for that session (the test did not find when, or whether, it comes back short of restarting the browser). So waiting longer does not help and the game does need a reload prompt: it should keep the sim running, save, and offer a reload when the device does not come back within a second or two, and show "not supported" when the reload does not help.
- No command-line flag turns WebGPU off in Chrome 156 short of disabling the GPU, so the "`navigator.gpu` missing" path can only be tested by simulation or on a browser that really lacks it.

## Rerun steps

1. **macOS** (Chrome, Edge, Safari 26+): open the deployed page (or `npx pnpm@10 preview` locally) at `?render=gpu&n=2000&spawn=40`. Pass: the scene draws and the overlay shows numbers. In the console read `__gpu.features` and `__gpu.all` and add a row to the table. With Chrome and Edge installed, `node scripts/stage4.mjs chrome edge` works after changing the two paths in `scripts/browser.mjs`.
2. **Firefox** (Windows 141+, macOS 145+): same page; record whether it draws or shows the "not supported" page, and the feature list.
3. **Lost device**: in Chrome and Edge open `chrome://gpucrash` (or `edge://gpucrash`) in a second tab by typing it. Pass: the game tab draws again within a few seconds without a reload and the overlay shows `losses 1`. In Safari there is no such page; use sleep and wake.
4. **Sleep and wake**: with the game tab open, put the computer to sleep for a minute and wake it. Pass: the game is drawing, and the overlay's `losses` count shows whether a device was lost.
5. **Gamepad**, in each browser: press a button on the page. Pass: the overlay's `pad` line shows the gamepad's id and `[standard]`; the left stick moves the player in the stick's direction, and Stage 2's rerun step 3 gives the input delay.
6. **A browser without WebGPU** (Firefox on Linux, Safari 18 or older): the "not supported" page must show.
7. On the **reference device**, repeat step 1 in Chrome and note the adapter and whether `texture-compression-bc`, `shader-f16` and `timestamp-query` are offered by its integrated GPU.
