// Stage 5: what a deploy does to open tabs. Local Pages emulator on port 4175 + headed Chrome (puppeteer).
//
//   node stage5/build-assets.mjs                       (once)
//   node scripts/stage5-deploy.mjs [--reps 5]
//
// Scenarios, each repeated REPS times in a fresh browser profile:
//   keep-sw0 / keep-sw1   build A open and lazily loading -> deploy B with keep-previous -> A keeps working, a new tab gets B
//                         -> deploy C -> the A tab (two deploys old) gets a 404 and shows the save-and-reload prompt;
//                         the B tab (one deploy old) still works. sw0: service worker off; sw1: service worker on.
//   nokeep-sw0            negative control: deploy B WITHOUT keep-previous -> the A tab's next lazy request fails
//   sw-update             a tab that keeps reloading across a deploy still ends up on the new build and the new service worker
//   sw-update-noskip      negative control: the same with skipWaiting() removed from the service worker
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEmulator } from './pages-emulator.mjs';
import { BASEURL, PORT, buildVariant, deploy, root } from './stage5-lib.mjs';
import { launch } from './browser.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REPS = Number(arg('--reps', 5));
const only = arg('--only', '');
const T = (m) => { if (process.env.S5_TRACE) console.log(new Date().toISOString().slice(11, 19), m); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const dirs = { A: buildVariant('s5-A'), B: buildVariant('s5-B'), C: buildVariant('s5-C') };
const noskipDir = (tag) => { const d = `${dirs[tag]}-noskip`; rmSync(d, { recursive: true, force: true }); cpSync(dirs[tag], d, { recursive: true }); const f = join(d, 'sw.js'); writeFileSync(f, readFileSync(f, 'utf8').replace('await self.skipWaiting();', '/* skipWaiting removed (negative control) */')); return d; };

const newSite = async (name) => {
  const site = join(root, 'stage5', '.deploys', `_live-${name}`);
  rmSync(site, { recursive: true, force: true });
  return startEmulator({ port: PORT, siteDir: site });
};
const lazyPhase = async (page, n) => { for (let i = 0; i < n; i++) await page.evaluate(() => window.__s5next()); };
const lazyLog = (page) => page.evaluate(() => (window.__s5log ?? []).filter((l) => ['chunk', 'asset', 'missing'].includes(l.kind)).map((l) => ({ kind: l.kind, url: l.url, ok: l.ok, status: l.status, note: l.note })));
const state = (page) => page.evaluate(() => ({ prompt: !!window.__s5prompt, saved: window.__s5saved ?? 0, build: window.__s5result?.build, visible: getComputedStyle(document.getElementById('reload')).display !== 'none' }));
const failed = (emu, from) => emu.requests.slice(from).filter((r) => r.status >= 400 && !/favicon/.test(r.path)).map((r) => `${r.status} ${r.path}`);
const openTab = async (browser, query) => {
  const page = await browser.newPage();
  await page.goto(`${BASEURL}stage5.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__s5result || window.__s5error', { timeout: 60000, polling: 100 });
  await page.waitForFunction('window.__s5manualReady', { timeout: 30000, polling: 100 });
  return page;
};

async function keepScenario(sw, rep) {
  const emu = await newSite(`keep${sw}`);
  const browser = await launch('chrome');
  const rec = { sw, rep, steps: [] };
  try {
    T('deploy A'); rec.deployA = await deploy(emu, dirs.A, { keep: true, label: 'A' }); T('open tab');
    const t1 = await openTab(browser, `lazy=manual&sw=${sw}`);
    if (sw) await t1.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 30000, polling: 100 });
    T('tab open'); rec.tabA = { build: (await state(t1)).build };
    let from = emu.requests.length;
    await lazyPhase(t1, 2);
    rec.steps.push({ step: 'A tab: 2 lazy loads before deploy', failed: failed(emu, from), log: await lazyLog(t1) });
    // Deploy B while the A tab is open.
    T('deploy B'); rec.deployB = await deploy(emu, dirs.B, { keep: true, label: 'B' }); T('deployed B');
    from = emu.requests.length;
    await lazyPhase(t1, 3); // lazy1, lazy2, lazy3 (A's files, requested after B went live)
    const sA = await state(t1);
    rec.steps.push({ step: 'A tab after deploy B: 3 more lazy loads', failed: failed(emu, from), prompt: sA.prompt, log: (await lazyLog(t1)).slice(2) });
    // A new tab in the same browser: Pages sends max-age=600, so without a service worker the browser may reuse the cached A html.
    const tSame = await openTab(browser, `lazy=manual&sw=${sw}`);
    rec.sameBrowserNewTabBuild = (await state(tSame)).build;
    await tSame.close();
    // A new visitor (no cache) gets B.
    from = emu.requests.length;
    const ctx = await browser.createBrowserContext();
    const t2 = await openTab(ctx, `lazy=manual&sw=${sw}`);
    await lazyPhase(t2, 2);
    rec.steps.push({ step: 'new visitor (no cache) after deploy B', build: (await state(t2)).build, failed: failed(emu, from), log: await lazyLog(t2) });
    // Deploy C: A is now two deploys old, B one.
    rec.deployC = await deploy(emu, dirs.C, { keep: true, label: 'C' });
    from = emu.requests.length;
    await lazyPhase(t2, 2);
    rec.steps.push({ step: 'B tab (one deploy old) after deploy C', failed: failed(emu, from), prompt: (await state(t2)).prompt, log: (await lazyLog(t2)).slice(2) });
    from = emu.requests.length;
    await lazyPhase(t1, 2);
    const sA2 = await state(t1);
    rec.steps.push({ step: 'A tab (two deploys old) after deploy C', failed: failed(emu, from), prompt: sA2.prompt, savedCalls: sA2.saved, promptVisible: sA2.visible, log: (await lazyLog(t1)).slice(5) });
    rec.liveManifest = JSON.parse(readFileSync(join(emu.siteDir, 'builds.json'), 'utf8'));
    rec.liveManifest = { currentId: rec.liveManifest.current.id, currentTag: rec.liveManifest.current.tag, previousId: rec.liveManifest.previous?.id, previousTag: rec.liveManifest.previous?.tag, currentFiles: rec.liveManifest.current.files.length, previousFiles: rec.liveManifest.previous?.files.length };
    rec.pass = {
      aKeepsWorkingAfterB: rec.steps[1].failed.length === 0 && !rec.steps[1].prompt,
      freshTabGetsB: rec.steps[2].build === 's5-B' && rec.steps[2].failed.length === 0,
      oneDeployOldTabFine: rec.steps[3].failed.length === 0 && !rec.steps[3].prompt,
      twoDeploysOldTabPrompts: rec.steps[4].failed.length > 0 && rec.steps[4].prompt && rec.steps[4].promptVisible && rec.steps[4].savedCalls >= 1,
    };
  } catch (e) { rec.error = String(e); }
  finally { await browser.close(); await emu.stop(); }
  return rec;
}

async function nokeepScenario(rep) {
  const emu = await newSite('nokeep');
  const browser = await launch('chrome');
  const rec = { sw: 0, rep, steps: [] };
  try {
    rec.deployA = await deploy(emu, dirs.A, { keep: false, label: 'A' });
    const t1 = await openTab(browser, 'lazy=manual&sw=0');
    await lazyPhase(t1, 2);
    rec.deployB = await deploy(emu, dirs.B, { keep: false, label: 'B (no keep-previous)' });
    const from = emu.requests.length;
    await lazyPhase(t1, 3);
    const s = await state(t1);
    rec.steps.push({ step: 'A tab after deploy B without keep-previous', failed: failed(emu, from), prompt: s.prompt, log: (await lazyLog(t1)).slice(2) });
    rec.pass = { testCanFail: rec.steps[0].failed.length > 0 };
  } catch (e) { rec.error = String(e); }
  finally { await browser.close(); await emu.stop(); }
  return rec;
}

async function swUpdateScenario(rep, noskip) {
  const emu = await newSite(noskip ? 'swnoskip' : 'swupdate');
  const browser = await launch('chrome');
  const rec = { rep, noskip, reloads: [] };
  const swVersion = (page) => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const target = navigator.serviceWorker.controller ?? reg?.active;
    const buildId = target ? await new Promise((ok) => { const h = (e) => { if (e.data?.type === 'version') { navigator.serviceWorker.removeEventListener('message', h); ok(e.data.buildId); } }; navigator.serviceWorker.addEventListener('message', h); target.postMessage({ type: 'version' }); setTimeout(() => ok(null), 2000); }) : null;
    return { activeBuildId: buildId, controlled: !!navigator.serviceWorker.controller, waiting: !!reg?.waiting, installing: !!reg?.installing };
  });
  try {
    await deploy(emu, dirs.A, { keep: true, label: 'A' });
    const page = await browser.newPage();
    await page.goto(`${BASEURL}stage5.html?lazy=0`, { waitUntil: 'load' });
    await page.waitForFunction('window.__s5result', { timeout: 60000, polling: 100 });
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, { timeout: 30000, polling: 100 });
    const idA = JSON.parse(readFileSync(join(dirs.A, 'builds.json'), 'utf8')).current.id;
    const idB = JSON.parse(readFileSync(join(dirs.B, 'builds.json'), 'utf8')).current.id;
    rec.ids = { A: idA, B: idB };
    for (let i = 0; i < 8; i++) {
      if (i === 2) rec.deployedAtReload = i, await deploy(emu, noskip ? noskipDir('B') : dirs.B, { keep: true, label: 'B' });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction('window.__s5result', { timeout: 60000, polling: 100 });
      await sleep(Number(process.env.S5_SLEEP ?? 2500));
      const v = await swVersion(page);
      rec.reloads.push({ i, pageBuild: await page.evaluate(() => window.__s5result.build), pageErrors: await page.evaluate(() => window.__s5result.errors), swReg: await page.evaluate(() => window.__s5sw), ...v });
    }
    const firstB = rec.reloads.findIndex((r) => r.pageBuild === 's5-B');
    const firstSwB = rec.reloads.findIndex((r) => r.activeBuildId === idB);
    rec.pass = { pageOnBAfterDeploy: firstB === rec.deployedAtReload, firstReloadWithPageB: firstB, firstReloadWithSwB: firstSwB, swReachedB: firstSwB >= 0 };
  } catch (e) { rec.error = String(e); }
  finally { await browser.close(); await emu.stop(); }
  return rec;
}

const outPath = join(root, 'results', 'data', arg('--out', 'stage5-deploy.json'));
const prev = process.argv.includes('--merge') ? (() => { try { return JSON.parse(readFileSync(outPath, 'utf8')); } catch { return {}; } })() : {};
const out = { ...prev, meta: { measuredAt: new Date().toISOString(), host: 'dev machine, local Pages emulator on localhost:' + PORT, reps: REPS, note: 'No network throttling in these runs; they check correctness, not speed.' } };
const want = (n) => !only || only.split(',').includes(n);
for (const [name, fn] of [
  ['keep-sw0', (i) => keepScenario(0, i)], ['keep-sw1', (i) => keepScenario(1, i)], ['nokeep-sw0', (i) => nokeepScenario(i)],
  ['sw-update', (i) => swUpdateScenario(i, false)], ['sw-update-noskip', (i) => swUpdateScenario(i, true)],
]) {
  if (!want(name)) continue;
  out[name] = [];
  for (let i = 0; i < REPS; i++) {
    const r = await fn(i);
    out[name].push(r);
    console.log(name, i, r.error ? 'ERROR ' + r.error : JSON.stringify(r.pass));
  }
}
mkdirSync(join(root, 'results', 'data'), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 1));
