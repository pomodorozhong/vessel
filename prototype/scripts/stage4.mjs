// Stage 4 checks on the installed browsers. Usage: node scripts/stage4.mjs [chrome|edge ...]
// Per browser: startup + adapter features, recovery from a GPU process crash (chrome://gpucrash),
// and the "not supported" page with WebGPU turned off. Results: results/data/stage4-<browser>.json.
import { launch, BASE, save } from './browser.mjs';

const GAP = Number(process.env.GAP ?? 12) * 1000, TAG = process.env.TAG ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (page, expr, ms) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await page.evaluate(expr); } catch { v = null; } if (v) return v; await sleep(100); } return null; };

async function startup(name) {
  const browser = await launch(name);
  try {
    const page = (await browser.pages())[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const t0 = Date.now();
    await page.goto(BASE + '?render=gpu&n=2000&spawn=40', { waitUntil: 'load' });
    const ready = await until(page, 'window.__ready', 30000);
    const readyMs = Date.now() - t0;
    await sleep(5000);
    const out = { version: await browser.version(), ua: await page.evaluate('navigator.userAgent'), ready: !!ready, readyMs, gpu: await page.evaluate('window.__gpu ?? null'), state: await page.evaluate('window.__state?.() ?? null'), unsupported: await page.evaluate('window.__unsupported ?? null'), errors, crashes: [] };
    out.gamepadApi = await page.evaluate('typeof navigator.getGamepads === "function" ? navigator.getGamepads().filter(Boolean).length : null');
    // Crash the GPU process three times, 20 s apart. A loss the game did not cause.
    for (let i = 0; i < 3; i++) {
      await page.evaluate('window.__lost = null; window.__recovered = null');
      const before = await page.evaluate('window.__state()');
      const tCrash = Date.now();
      // chrome://gpucrash is ignored when automation navigates to it; this CDP command does the same thing.
      const bcdp = await browser.target().createCDPSession();
      await bcdp.send('Browser.crashGpuProcess').catch((e) => { out.crashError = String(e); });
      const lost = await until(page, 'window.__lost', 15000);
      const recovered = lost ? await until(page, 'window.__recovered || window.__unsupported', 20000) : null;
      await sleep(5000);
      const after = await page.evaluate('window.__state?.() ?? null');
      const tick1 = after?.tick; await sleep(2000);
      const later = await page.evaluate('window.__state?.() ?? null');
      out.crashes.push({
        lost, recovered, recoveryMs: lost && recovered?.at ? recovered.at - lost.at : null, waitedMs: Date.now() - tCrash,
        before: { deviceLosses: before.deviceLosses, rebuilds: before.rebuilds }, after,
        simKeptRunning: later && tick1 != null ? later.tick > tick1 : null,
        featuresAfter: await page.evaluate('window.__gpu?.features ?? null'), unsupported: await page.evaluate('window.__unsupported ?? null'),
      });
      console.log(name, 'crash', i + 1, JSON.stringify(out.crashes[i]).slice(0, 600));
      if (out.crashes[i].unsupported) {
        // Does a reload bring WebGPU back?
        await page.reload({ waitUntil: 'load' });
        out.afterReload = { ready: !!(await until(page, 'window.__ready', 10000)), unsupported: await page.evaluate('window.__unsupported ?? null') };
        break;
      }
      await sleep(GAP);
    }
    return out;
  } finally { await browser.close(); }
}

async function unsupported(name, args, label) {
  const browser = await launch(name, { args });
  try {
    const page = (await browser.pages())[0];
    // No flag removes navigator.gpu in Chrome 156, so that case is simulated by hiding the property.
    if (!args.length) await page.evaluateOnNewDocument('Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined })');
    await page.goto(BASE + '?render=gpu&n=2000', { waitUntil: 'load' });
    const reason = await until(page, 'window.__unsupported', 15000);
    const visible = await page.evaluate('getComputedStyle(document.getElementById("unsupported")).display !== "none"');
    const text = await page.evaluate('document.getElementById("unsupported").innerText');
    return { label, args, reason, visible, text: text.slice(0, 600), hasNavigatorGpu: await page.evaluate('"gpu" in navigator') };
  } finally { await browser.close(); }
}

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['chrome', 'edge']) {
  const res = { browser: name, measuredAt: new Date().toISOString(), url: BASE };
  try { res.startup = await startup(name); } catch (e) { res.startupError = String(e); }
  res.unsupported = [];
  for (const [label, args] of [['navigator.gpu missing (simulated by hiding the property)', []], ['no adapter (GPU off)', ['--disable-gpu', '--disable-software-rasterizer']]]) {
    try { res.unsupported.push(await unsupported(name, args, label)); } catch (e) { res.unsupported.push({ label, error: String(e) }); }
  }
  save(`results/data/stage4-${name}${TAG}.json`, res);
  const s = res.startup;
  console.log(name, s?.version, 'ready', s?.ready, s?.readyMs, 'ms', JSON.stringify(s?.gpu?.info), JSON.stringify(s?.gpu?.features), 'unsupported pages:', res.unsupported.map((u) => `${u.label}: ${u.visible} (${u.reason})`).join(' | '));
}
