# Stage 5: startup and hosting

Hypothesis: the game starts quickly from GitHub Pages, and a deploy does not break a running tab.

Verdict: **provisional**. Every pass bar is met with margin on the dev machine against a local Pages emulator, and the behaviour of the deploy flow (keep-previous, service worker, save-and-reload prompt) is settled by tests that can fail. Nothing could be run on real Pages (the repository has no Pages site and this account cannot push) or on the reference device, so the timings and the real-CDN behaviour of a deploy are not confirmed. See "What is settled and what is not".

## Where every number comes from

- "dev machine": Intel i7-13700, RTX 3060, 64 GB, Windows 11, headed Chrome 156.0.8078.73, 1920x1080 window, canvas 1280x720, fresh puppeteer profile per cold run.
- "local Pages emulator": `scripts/pages-emulator.mjs` on `http://localhost:4175/vessel/`, built from the real-Pages header check below. It is not GitHub Pages.
- "Fast 4G" is Chrome DevTools' preset as shipped in puppeteer-core 25: 1,012,500 bytes/s down (9 Mbit/s x 0.9), 168,750 bytes/s up, 165 ms latency, applied with CDP `Network.emulateNetworkConditions` to the page and to every service worker target (`swTargets: 1` in the raw data). "Slow 4G" is 180,000 bytes/s down, 84,375 up, 562.5 ms (DevTools' old "Fast 3G").
- "dev machine, throttled": CDP `Emulation.setCPUThrottlingRate` 4x on the page. Chrome refuses it for workers ("only supported for pages"), so the sim worker, which only instantiates the 23 KB module here, runs unthrottled.
- Each configuration ran 5 times (cold: 5 new browsers; warm: one browser, 1 populate visit, then 5 reloads). Median and [min-max] are shown. Raw data is in `results/data/stage5-*.json`.
- The assets are procedural (noise textures, generated meshes). Sizes for real art will differ, in both directions: real textures have more fine detail than these (bigger) but also more repeated and flat areas (smaller).
- Time to first frame is `performance.now()` (from navigation start) in the `requestAnimationFrame` after `queue.submit` and `onSubmittedWorkDone` of the first frame, which shows three textured models and a ground quad.

## What was built

- `stage5/build-assets.mjs` + `stage5/tools/bc7tool` (Rust): procedural character (5,102 vertices), tree (3,000) and rock (1,813) in a 16-byte packed vertex format (snorm16 positions in the bounding box, unorm16 UVs, snorm8 normals plus baked 8-bit AO, u16 indices), meshopt-encoded and gzipped; four BC7 textures (three 1024x1024, one 2048x2048 atlas with flat and detailed regions) with full mip chains in KTX2 without supercompression, at three RDO strengths, gzipped; uncompressed RGBA8 fallbacks; the sim `.wasm` plain and pre-gzipped. Every output file name has a content hash.
- `stage5.html` + `stage5/main.ts`: an inline script starts the WASM compile (pre-gzipped through `DecompressionStream`, or plain) and the first-chunk downloads before the module script arrives; `<link rel="preload" as="fetch" crossorigin>` for each file; `DecompressionStream` + meshopt decoder; BC7 upload (RGBA8 fallback without `texture-compression-bc`); first frame; then service worker registration, `builds.json` fetch, and lazy loading of one code chunk and six assets. A hashed file or chunk that 404s calls a `save()` stub and shows a "new version, reload" prompt.
- `stage5/sw.js`: scope `/vessel/`, cache first for hashed files (filled on first fetch, only 200 responses are stored), network first for html and `builds.json` (revalidating past the 10 minute HTTP cache), precache of the critical files only, `skipWaiting()` and `clients.claim()`, cleanup of files in neither the current nor the previous build after `builds.json` arrives.
- `scripts/stage5-postbuild.mjs` writes `builds.json`; `scripts/stage5-keep-previous.mjs` is wired into `.github/workflows/deploy.yml` before the upload step (it tolerates "no live site yet").
- `scripts/pages-emulator.mjs`, `stage5-startup.mjs`, `stage5-deploy.mjs` (+ `stage5-lib.mjs`, `stage5-pages-headers.mjs`, `stage5-pages-calibrate.mjs`, and two debug helpers `stage5-shot.mjs`, `stage5-swdebug.mjs`).

## 1. What real GitHub Pages does (measured against public `*.github.io` sites, 2026-11-19)

`curl -sI -H "Accept-Encoding: gzip, br"` plus an identity download for the raw size. Raw headers are in `results/data/stage5-pages-headers.json`.

| URL (all on github.io) | Content-Type | Content-Encoding | Cache-Control | raw bytes | bytes sent |
|---|---|---|---|---|---|
| mozilla.github.io/pdf.js/web/wasm/openjpeg.wasm | application/wasm | **gzip** | max-age=600 | 220,817 | 71,367 |
| kripken.github.io/ammo.js/builds/ammo.wasm.wasm | application/wasm | **gzip** | max-age=600 | 750,028 | 293,048 |
| mdn.github.io/webassembly-examples/js-api-examples/simple.wasm | application/wasm | none (83 bytes) | max-age=600 | 83 | 83 |
| mozilla.github.io/pdf.js/build/pdf.mjs | text/javascript; charset=utf-8 | gzip | max-age=600 | 895,400 | 190,311 |
| mozilla.github.io/pdf.js/web/viewer.css | text/css | gzip | max-age=600 | 215,041 | 34,544 |
| mozilla.github.io/pdf.js/web/locale/en-US/viewer.ftl (unknown extension) | application/octet-stream | **gzip** | max-age=600 | 33,897 | 8,122 |
| webgpu.github.io/webgpu-samples/assets/gltf/whale.glb | model/gltf-binary | **gzip** | max-age=600 | 143,908 | 79,576 |
| webgpu.github.io/webgpu-samples/assets/img/Di-3d.png | image/png | none | max-age=600 | 243,533 | 243,533 |
| mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf | application/pdf | none | max-age=600 | 1,016,315 | 1,016,315 |
| mozilla.github.io/pdf.js/web/images/loading-icon.gif | image/gif | none | max-age=600 | 2,545 | 2,545 |
| webgpu.github.io/webgpu-samples/sample/helloTriangle/main.ts (typed video/mp2t by Pages) | video/mp2t | none | max-age=600 | 1,844 | 1,844 |

Findings:

- **Pages does gzip `application/wasm`**, for two unrelated sites (an 83-byte file was not compressed, so there is a size threshold). It also gzips `model/gltf-binary` and `application/octet-stream`. It never sent brotli although the request offered it. It does not compress png, gif, pdf or `video/mp2t`. This contradicts the tech direction's "Pages does not gzip our binary types", at least for wasm.
- Gzip level: the observed sizes match zlib level 5 within 1% for the wasm and text files (`results/data/stage5-gzip-calibration.json`); `whale.glb` came out 2% smaller than zlib 9, so Pages' compressor is not zlib. The emulator uses level 5.
- Every file has `Cache-Control: max-age=600`, an `ETag` (weak when compressed) and `Last-Modified`, with `Vary: Accept-Encoding`.
- **Not observed** (no public site found that serves them): a truly binary file with an unknown extension (only the text-like `.ftl` was octet-stream), and how Pages types a `.gz` file. The assets here are shipped as `.gz` files (type assumed `application/gzip`, not compressed again). See the rerun steps.

The emulator follows these observations: static files under `/vessel/`, max-age=600 + Expires, ETag/Last-Modified and 304s, gzip (level 5, only above 150 bytes) for text types, wasm, glb and octet-stream but not for png, gif, pdf, gzip or video, never brotli, no COOP/COEP, a 404 page, and `deploy()` that swaps the whole site directory at once. Not emulated: Range requests, CDN edge staleness, HTTP/2.

## 2. Sizes (procedural assets; gzip level 9; BC7 by mipple 0.9.102, effort 5)

Models (`results/data/stage5-sizes.json`):

| Model | Vertices | Raw packed | meshopt | meshopt + gzip (shipped) | gzip only (no meshopt) | shipped vs gzip only |
|---|---|---|---|---|---|---|
| character | 5,102 | 138,896 | 66,773 | **43,587** | 109,462 | 40% |
| tree | 3,000 | 81,456 | 42,151 | **29,075** | 61,878 | 47% |
| rock | 1,813 | 49,792 | 24,728 | **16,826** | 37,713 | 45% |

Textures: BC7 + mipmaps in KTX2 (no supercompression), then gzip. PSNR is RGB of mip level 0 decoded from the BC7 blocks versus the source. lambda 0 is plain BC7 (no RDO); lambda 1 and 3 are mipple's rate-distortion strengths.

| Texture | RGBA8 fallback raw / gzip | BC7 raw KTX2 | lambda 0 gzip (PSNR) | lambda 1 gzip (PSNR) | lambda 3 gzip (PSNR) |
|---|---|---|---|---|---|
| ground 1024 | 5,592,416 / 1,953,204 | 1,398,592 | 1,068,060 (53.9 dB) | **364,634** (46.3 dB), 34% of lambda 0 | 256,227 (42.8 dB), 24% |
| bark 1024 | 5,592,416 / 1,041,421 | 1,398,592 | 775,855 (55.2 dB) | **141,416** (47.3 dB), 18% | 87,862 (44.2 dB), 11% |
| rock 1024 | 5,592,416 / 1,808,479 | 1,398,592 | 998,123 (54.1 dB) | **319,498** (46.2 dB), 32% | 215,597 (42.5 dB), 22% |
| atlas 2048 | 22,369,632 / 1,705,997 | 5,592,912 | 1,333,364 (54.1 dB) | **385,571** (47.6 dB), 29% | 273,425 (44.6 dB), 21% |

Is RDO worth it? On these textures yes, clearly: plain BC7 barely shrinks under gzip (55% to 76% of raw for the noisy textures, 24% for the flat-heavy atlas), while lambda 1 cuts the gzipped size by 66% to 82% for a 6.9 to 7.5 dB PSNR drop (still 46 to 48 dB), and lambda 3 by 76% to 89% for about 10 dB. The RGBA8 fallback gzips to 1.0 to 1.95 MB per 1024 texture, which is 3 to 7 times the lambda 1 BC7 file and 4 times the raw size in memory; the fallback costs a cold start of 8.8 s (section 3). Whether 46 dB is invisible on real art is not measured; that needs a visual check on real textures. Encode time on this machine (mipple built unoptimized, see limits): 0.7 to 3 s plain, 6 to 15 s with RDO per texture.

The meshopt decoder that ships is about 29 KB of JavaScript with its WASM embedded (the stage 5 page chunk is 39.0 KB, 12.75 KB gzipped, including the loader). The tech direction's "a few kilobytes" is too low by that measure.

The sim `.wasm` from stage 0 is only 22,998 bytes (10,000 gzipped), so the wasm questions below have little to show at this size.

## 3. Time to first frame (dev machine, local Pages emulator, Chrome 156.0.8078.73, 5 runs each, ms)

First chunk = 3 models + 4 BC7 lambda 1 textures + the gzipped wasm: 1,300,607 bytes of assets, 1,329,797 bytes on the wire for 17 requests (with html, js, favicon 404).

| Config | First frame median [min-max] | html end | js start | wasm compiled | assets done | decode | GPU upload |
|---|---|---|---|---|---|---|---|
| cold, no network throttle, cpu 1x | 666 [636-694] | 216 | 256 | 230 | 279 | 26 | 5 |
| **cold, Fast 4G, cpu 1x (dev machine)** | **2,039 [2,002-2,153]** | 408 | 988 | 652 | 1,961 | 24 | 5 |
| **cold, Fast 4G, cpu 4x (dev machine, throttled)** | **2,127 [2,108-2,193]** | 401 | 1,000 | 654 | 1,961 | 94 | 24 |
| **warm (SW cache + HTTP cache), Fast 4G, cpu 1x** | **329 [319-464]** | 201 | 225 | 226 | 226 | 23 | 5 |
| warm, Fast 4G, cpu 4x (dev machine, throttled) | 467 [451-580] | 192 | 261 | 258 | 258 | 89 | 22 |
| warm, SW cache only (HTTP cache disabled), Fast 4G | 332 [331-451] | 203 | 230 | 232 | 232 | 23 | 5 |
| cold, Slow 4G, cpu 1x | 8,911 [8,859-9,078] | 805 | 3,161 | 1,683 | 8,825 | 21 | 5 |
| warm, Slow 4G, cpu 1x | 729 [716-1,254] | 590 | 616 | 618 | 618 | 24 | 5 |
| cold, Fast 4G, no BC7 (RGBA8 fallback forced, `?bc=0`) | 8,850 [8,797-8,861] | 353 | 937 | 570 | 1,909 (BC7 files that are then not used) | 86 | 16 |

Pass bars: cold within about 3 s on Fast 4G: **met (2.04 s)**; warm under 1 s: **met (0.33 s; 0.47 s with 4x CPU)**. In the warm case only 3 requests reach the server (html revalidation answered 304, `builds.json`, `sw.js`); the first frame waits for the network-first html (about 0.2 s at 165 ms latency), the cache-first files cost nothing.

Where the cold time goes: the first frame lands about 80 to 100 ms after the last asset arrives (decode 24 ms, upload 5 ms, GPU work). It is bandwidth bound: the page's JS only arrives at about 1 s because it shares the 1 MB/s with the 1.3 MB of assets that the inline script starts at 0.2 s. Decode and upload are small (a few tens of ms), and CPU 4x moves cold by only 90 ms; it hurts the warm path more in relative terms (decode 89 ms, upload 22 ms).

Headroom, cold on Fast 4G (extra copies of the 2048 atlas added to the first chunk, `?pad=N`):

| Extra atlas copies | Wire bytes (all requests) | First frame median [min-max] |
|---|---|---|
| 0 | 1,329,797 | 1,978 [1,920-2,033] |
| 1 | 1,715,368 | 2,365 [2,350-2,405] |
| 2 | 2,100,939 | **2,775 [2,744-2,804]** (under 3 s) |
| 3 | 2,486,510 | **3,112 [3,055-3,163]** (over 3 s) |
| 4 | 2,872,081 | 3,588 [3,523-3,674] |
| 6 | 3,643,223 | 4,333 [4,308-4,375] |

So the 3 s cold bar breaks between 2.1 MB and 2.5 MB of first chunk on Fast 4G (about 1.0 s per extra MB). Doubling the current first chunk is fine, tripling is not. For comparison the same four textures at lambda 0 plus models are 4.26 MB, past the largest size measured here (3.64 MB: 4.3 s); that exact set was not run.

Compressed wasm path (cold, Fast 4G, cpu 1x, 5 runs each; the wasm is only 10 KB gzipped, so differences are within the 2% noise):

| Variant | First frame median [min-max] | wasm compiled at |
|---|---|---|
| pre-gzipped `sim.wasm.gz` through `DecompressionStream` into `compileStreaming` | 2,141 [2,007-2,249] | 756 |
| plain `.wasm`, gzipped by the host (what real Pages does) | 1,989 [1,979-1,993] | 601 |
| plain `.wasm`, host does not compress (hypothetical; emulator switch `--no-wasm-gzip`) | 2,020 [2,008-2,057] | 696 |

Since real Pages gzips wasm, the plain `.wasm` is the simpler path and the pre-gzipped path buys nothing; it stays as a fallback if Pages stops compressing it. The compile itself is a few ms at this size; a measurement with the real sim wasm (hundreds of KB) is still needed.

Preload check (cold, Fast 4G, `waitAfterMs` 4 s, Resource Timing of the browser): with `<link rel="preload" as="fetch" crossorigin>` each of the 8 asset files had one browser request and one server GET. With the same preload **without** `crossorigin` (negative control, `stage5-nocors.html`) the browser made two requests for all 8 files (one `link`, one `fetch`). The server still saw one GET each, because the second request was answered from the browser's HTTP cache (the files are cacheable, max-age=600), so the double download is hidden here and would show on the wire for an uncacheable response or when the first request is still in flight on a slower link. Chrome printed no "preloaded but not used" warning in either case.

## 4. A deploy while a tab is open (dev machine, local Pages emulator, no throttling, 5 runs each, fresh browser profile per run)

Setup: builds A, B, C (different build tags, so different chunk and lazy-asset hashes). Tab on A loads lazily (`?lazy=manual`, driven one item at a time: one code chunk and six assets). The workflow script `stage5-keep-previous.mjs` runs against the emulator before each deploy; the emulator swaps the whole site directory.

| Scenario | Result (runs passing) |
|---|---|
| deploy B with keep-previous while the A tab is open: next 3 lazy loads of A files, service worker off | no failed request, no prompt (5/5) |
| same, service worker on | no failed request, no prompt (5/5) |
| new visitor (no cache) after deploy B gets build B | 5/5 (both sw modes) |
| new tab in the same browser after deploy B, **service worker off** | still gets build A in 5/5 (the html is cached for 10 minutes, as Pages tells browsers); with the service worker on it gets B in 5/5 |
| deploy C: the B tab (one deploy old) keeps working | no failed request (5/5, both modes) |
| deploy C: the A tab (two deploys old), next lazy loads | 404 on `lazy4`, `lazy5` (A's files are gone), `save()` called once, prompt shown (5/5, both modes) |
| negative control: deploy B **without** keep-previous | the A tab's next 3 lazy loads all 404 (`lazy1`, `lazy2`, `lazy3`) in 5/5; the prompt appears (so a tab does not silently break, but it loses its files) |

keep-previous on the second deploy downloaded the 8 hashed files of A that B does not share (186,675 bytes) and skipped 27 shared ones; after deploy C the live manifest listed C as current and B as previous, with A dropped.

Service worker update path (a tab reloading every 2.5 s across a deploy, 8 reloads, deploy of B before reload 2; 5 runs):

| Variant | Result |
|---|---|
| shipped worker (`skipWaiting()` + `clients.claim()`, page calls `registration.update()`) | page shows B from the first reload after the deploy (html network first), and the active worker's build id is B's at that same reload in 5/5 |
| negative control: `skipWaiting()` removed | the active worker stays on A's build for all 8 reloads in 5/5 (the new one waits, as the plan's pitfall says) |
| reloading every 0.9 s instead of 2.5 s (shipped worker) | the active worker stays on A for all 8 reloads in 5/5: the update started by a page is lost when the page reloads before it finishes (the update needs about 1 to 2 s here). A real user does not reload every second, but a development loop does. Data: `stage5-deploy-swfast.json` |

The page calls `registration.update()` explicitly after registering (the service worker spec only requires a navigation-triggered update check when the last one is over 24 hours old). Whether that call is needed, versus the browser's own check, was not tested separately: the only run without it used the 0.9 s reload interval, which fails for the reason above.

## 5. Limits found

- First chunk size: the 3 s cold bar on Fast 4G breaks between 2.1 and 2.5 MB (above). Slow 4G cold is 8.9 s for the 1.3 MB chunk, so a Slow 4G player does not meet the bar with this chunk (needs about 0.3 MB or a loading screen).
- The cold path is bandwidth bound; the JS arrives late (about 1 s) because it shares the link with the assets. Starting the assets from the inline script is what keeps the total low, but a larger JS bundle than this 13 KB would be on the same link.
- The fallback without `texture-compression-bc` costs 8.8 s cold on Fast 4G (7.8 MB). The early inline script cannot know the adapter, so it also downloaded the BC7 files that went unused. A game that needs the fallback should detect `texture-compression-bc` before choosing, or accept that cost; desktop GPUs normally have BC (Stage 4 covers which adapters do not).
- A deploy plus a 10 minute browser cache: without a service worker a new tab in the same browser can show the previous build's html for 10 minutes. That is safe only because the previous build's files are kept; it also means a tab can be two builds old without any user action.
- Only the last two builds are kept. A tab two deploys old gets a 404 and relies on the prompt.
- The 404 path was exercised with lazy assets only, because the code chunk loaded before deploy B in the test. The dynamic-import failure path (`import()` rejecting, `vite:preloadError`) is wired to the same prompt but was not exercised.
- CPU throttling does not reach workers (Chrome limitation).
- The startup groups were measured over several invocations (each rebuilt the site); the `registration.update()` call was added to `stage5/main.ts` between the first and the last of them. It runs after the first frame and does not change the numbers.
- mipple's compile: at opt-level 1, 2 and 3 rustc did not finish the crate in over 30 minutes of CPU time on this machine (it ran, single-threaded, in LLVM), and at 0 it builds in about 3 minutes. It is built unoptimized, so the encode times above are for an unoptimized encoder. Sizes and PSNR are identical. This only costs build time (the CI deploy workflow compiles the tool, about 3 minutes). A first attempt had stalled for another reason: Windows throttled background rustc processes (EcoQoS); that was worked around while measuring and does not affect results.

## 6. What is settled and what is not

Settled (does not depend on the reference device or on whether Pages behaves as observed):

- Real Pages gzips `application/wasm`, `model/gltf-binary` and `application/octet-stream`, never brotli, caches for 600 s (11 URLs, 4 sites).
- Meshopt sizes (40 to 47% of gzip-only) and the BC7 plain/RDO sizes and PSNR for these assets.
- The deploy logic: keep-previous keeps exactly the current and previous builds; the service worker never stores a failed response, cleans up, activates at once; the prompt appears on a 404; each test can fail (negative controls fail as expected).
- The first-chunk size model on the dev machine: about 0.6 s fixed + 1.0 s per MB on Fast 4G.

Provisional:

- All timings: they are dev-machine numbers against an emulator with CDP throttling, which models bandwidth and latency but not Pages' CDN (Fastly edge, TLS, HTTP/2, real RTT variation). The reference device is slower at decode and upload (see the 4x CPU rows: +90 ms cold, +140 ms warm), which the margins (0.9 s cold, 0.67 s warm) cover, but a laptop with integrated graphics was not tried.
- Whether real Pages swaps a deploy atomically at every edge: a CDN edge could serve an old `builds.json` or html for up to 10 minutes while new files exist, or the reverse. The keep-previous design tolerates old-html-with-old-files; it was not tested against real propagation. keep-previous itself fetches `builds.json` with a cache-busting query string for this reason.
- How Pages types and compresses a `.gz` file and a truly binary unknown extension.
- Safari and Firefox (`DecompressionStream`, service workers, WebGPU BC support): not run, neither is installed.

So: the hypothesis **holds on the dev machine against the emulator and is provisional for real Pages and the reference device**. No pass bar was missed, so no fallback is applied.

## 7. Fallback if it fails on the real run

If the cold start misses 3 s on the reference device: reconsider the asset formats before the host (higher RDO lambda, smaller first chunk, fewer first-frame textures, a lower mip count in the first chunk, a loading frame before the heavy textures). If a deploy on real Pages leaves a running tab without its files (stale CDN, a missing previous file), or keep-previous cannot be made reliable: that is the reason to move to Cloudflare Pages or Netlify, which allow long cache times and headers.

## 8. Dependencies added

- npm `meshoptimizer` 1.3.0 (MIT). Runtime: only `meshoptimizer/decoder` is bundled into the page; the encoder is used by `build-assets.mjs` only. Added to `prototype/package.json` and `pnpm-lock.yaml`.
- Rust crate `mipple` =0.9.102 (MIT-0), library only (`default-features = false`: no CLI, no wgpu), in `stage5/tools/bc7tool`, which is a build-time tool and is not shipped. It is a pure-Rust BC7 encoder with RDO (lambda), a KTX2 writer, a BC7 decoder and PSNR. Its dependencies (57 packages in `stage5/tools/bc7tool/Cargo.lock`) include `image`, `zstd`, `flate2`, `rayon`, `anyhow`, `web-time`. A BC7 RDO encoder (bc7enc_rdo style) was found and built, so the RDO measurement is measured, not skipped. Tried before it: `ctt-bc7enc-rdo` only contains the non-RDO ISPC `bc7e` encoder, so it was not used.
- No other dependency. `curl` and Node 22's `fetch` are used by the scripts.

## 9. Rerun steps

### On real GitHub Pages (after the branch is pushed and Pages is enabled with "GitHub Actions" as the source)

1. Check the deploy workflow log: the "Keep the previous build's files" step prints `no live builds.json (HTTP 404)` on the first deploy and `previous = <id> (<n> files)` afterwards. Open `https://<owner>.github.io/vessel/builds.json`.
2. Headers of our own file types, which were not observable on other sites: `node scripts/stage5-pages-headers.mjs https://<owner>.github.io/vessel/a/<character...>.bin.gz https://<owner>.github.io/vessel/a/<ground...>.ktx2.gz https://<owner>.github.io/vessel/a/sim.<hash>.wasm https://<owner>.github.io/vessel/a/sim.<hash>.wasm.gz` (file names from `builds.json`). Check `Content-Type` and `Content-Encoding` of the `.gz` files (expect no re-compression) and that `.wasm` is gzipped. Copy the raw output to `results/data/stage5-pages-headers-own.json`.
3. Time to first frame, cold: in Chrome DevTools, Network tab: Disable cache on, throttle to "Fast 4G" (and "Slow 4G" as a custom profile: 1.6 Mbit/s, 150 ms x 3.75 latency), open `https://<owner>.github.io/vessel/stage5.html` in a new Incognito window, then read `window.__s5result.firstFrameMs` and `window.__s5result.breakdown` in the console. Repeat 5 times with a new Incognito window each time; record median and range. Warm: in a normal window load the page once, wait 5 s, reload with Fast 4G selected and cache enabled, read the same value, 5 reloads. Repeat with Performance, CPU "4x slowdown" for the throttled rows. Compare with section 3.
4. Headroom: `.../stage5.html?pad=2` and `?pad=3` cold on Fast 4G, 5 runs each.
5. Wasm paths: `.../stage5.html?wasm=gz` and `.../stage5-plain.html?wasm=plain` cold on Fast 4G.
6. Deploy test: push build A, open `.../stage5.html?lazy=manual&sw=0` in a tab (add `sw=1` or omit for the service worker), run `await __s5next(); await __s5next();` in the console; push build B (any commit that changes a source file, wait for the deploy), then `await __s5next(); await __s5next(); await __s5next();` and check the Network tab for 404s (expect none) and that no prompt appears; push build C and run `await __s5next()` until the end: the remaining A files 404 and the prompt appears (`window.__s5prompt`, `window.__s5saved`). Negative control: temporarily remove the keep-previous step from the workflow and repeat with B.
7. A new tab in the same browser within 10 minutes of a deploy without the service worker: which build it shows (`window.__s5result.build`).

### On the reference device (a laptop a few years old, integrated graphics, Chrome at 1080p)

Repeat steps 3 to 5 of the list above on the device, on real Pages, on a real network and with DevTools "Fast 4G". Also run `https://<owner>.github.io/vessel/stage5.html?bc=0` to see the RGBA8 fallback there, and check that the first frame looks right (three textured models on a ground plane). A Safari and a Firefox run of steps 3 and 6 are missing too.

### Locally (this machine)

```
cd prototype
npx -y pnpm@10 install
node scripts/build-wasm.mjs              # once: src/wasm/sim-simd.wasm
node stage5/build-assets.mjs             # assets, sizes (builds stage5/tools/bc7tool, about 3 minutes the first time)
node scripts/stage5-startup.mjs          # all startup groups (run groups one at a time with --groups, --merge)
node scripts/stage5-deploy.mjs           # deploy scenarios, S5_SLEEP=900 for the fast-reload variant
node scripts/stage5-pages-headers.mjs    # real Pages headers (needs network), then stage5-pages-calibrate.mjs
```

The emulator uses port 4175 (`STAGE5_PORT` to change it). The scripts launch one headed Chrome at a time and close only the browser they started.
