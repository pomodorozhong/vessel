// Debug helper: serve stage5/.deploys/<tag> on the Pages emulator, open stage5.html, save a screenshot.
//   node scripts/stage5-shot.mjs [tag] [query]
import { join } from 'node:path';
import { startEmulator } from './pages-emulator.mjs';
import { BASEURL, PORT, root, waitResult } from './stage5-lib.mjs';
import { launch } from './browser.mjs';

const tag = process.argv[2] ?? 's5-main';
const query = process.argv[3] ?? '';
const emu = await startEmulator({ port: PORT, siteDir: join(root, 'stage5', '.deploys', tag) });
const browser = await launch('chrome');
try {
  const page = (await browser.pages())[0];
  page.on('console', (m) => console.log('console:', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('pageerror:', String(e)));
  await page.goto(`${BASEURL}stage5.html${query}`, { waitUntil: 'load' });
  const r = await waitResult(page);
  console.log(JSON.stringify({ firstFrame: r.result?.firstFrameMs, error: r.error, bc7: r.result?.usedBc7, breakdown: r.result?.breakdown }));
  await new Promise((ok) => setTimeout(ok, 1500));
  await page.screenshot({ path: join(root, 'results', 'data', 'stage5-screenshot.png') });
} finally { await browser.close(); await emu.stop(); }
