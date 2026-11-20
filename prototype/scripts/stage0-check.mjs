// Stage 0 check: load the page in each installed browser and read the overlay.
import { runPage, save } from './browser.mjs';
const out = {};
for (const b of (process.argv[2] ?? 'chrome,edge').split(',')) {
  const expr = `(window.__ready || window.__unsupported) && performance.now() > 6000 && ({
    ready: !!window.__ready, unsupported: window.__unsupported ?? null, gpu: window.__gpu ?? null,
    overlay: document.getElementById('overlay').textContent, isolated: crossOriginIsolated, ua: navigator.userAgent })`;
  out[b] = await runPage(b, '', { expr, timeoutMs: 30000 });
  console.log(b, out[b].version, '\n' + (out[b].result.overlay ?? ''), '\n', out[b].result.unsupported, out[b].errors);
}
// WebGPU turned off: the "not supported" page must show.
out['chrome-webgpu-disabled'] = await runPage('chrome', '', { expr: `window.__unsupported && ({ unsupported: window.__unsupported, shown: getComputedStyle(document.getElementById('unsupported')).display })`, timeoutMs: 30000, launchOpts: { args: ['--disable-features=WebGPU', '--disable-gpu'] } }).catch((e) => ({ error: String(e) }));
console.log('disabled:', JSON.stringify(out['chrome-webgpu-disabled'].result ?? out['chrome-webgpu-disabled']));
save(process.argv[3] ?? 'results/data/stage0-local.json', out);
