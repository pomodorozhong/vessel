// Debug helper for the service worker update path.
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { startEmulator } from './pages-emulator.mjs';
import { BASEURL, PORT, root, deploy } from './stage5-lib.mjs';
import { launch } from './browser.mjs';

const site = join(root, 'stage5', '.deploys', '_live-swdebug');
rmSync(site, { recursive: true, force: true });
const emu = await startEmulator({ port: PORT, siteDir: site });
const browser = await launch('chrome');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
try {
  await deploy(emu, join(root, 'stage5', '.deploys', 's5-A'), { keep: true, label: 'A' });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('console:', m.text()));
  await page.goto(`${BASEURL}stage5.html?lazy=0`, { waitUntil: 'load' });
  await page.waitForFunction('window.__s5result');
  await sleep(1500);
  await deploy(emu, join(root, 'stage5', '.deploys', 's5-B'), { keep: true, label: 'B' });
  for (let i = 0; i < 6; i++) {
    const from = emu.requests.length;
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__s5result');
    await sleep(900);
    const st = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); const c = navigator.serviceWorker.controller; return JSON.stringify({ build: window.__s5result.build, active: r.active?.state, waiting: r.waiting?.state, installing: r.installing?.state, hasController: !!c, ver: await new Promise((ok) => { const h = (e) => { if (e.data?.type === 'version') { navigator.serviceWorker.removeEventListener('message', h); ok(e.data.buildId); } }; navigator.serviceWorker.addEventListener('message', h); (c ?? r.active).postMessage({ type: 'version' }); setTimeout(() => ok('timeout'), 2000); }) }); });
    console.log(i, st, JSON.stringify(emu.requests.slice(from).map((r) => r.status + ' ' + r.path.replace('/vessel/', ''))));
  }
} finally { await browser.close(); await emu.stop(); }
