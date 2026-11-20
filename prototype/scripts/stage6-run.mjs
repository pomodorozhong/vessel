// Stage 6 browser measurements. Usage: VESSEL_BASE=http://localhost:4176/vessel/ node scripts/stage6-run.mjs <jobs|saves|roundtrip|storage> [chrome|edge]
import { launch, save, BASE } from './browser.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const what = process.argv[2] ?? 'jobs';
const browserName = process.argv[3] ?? 'chrome';
const dataPath = (n) => join(root, 'results', 'data', `stage6-${n}.json`);
const origin = new URL(BASE).origin;

async function open(extraArgs = []) {
  const browser = await launch(browserName, { args: extraArgs });
  const page = (await browser.pages())[0] ?? await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + 'stage6.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  await page.bringToFront();
  return { browser, page, errors, version: await browser.version() };
}
const meta = (version, errors) => ({ browser: browserName, version, url: BASE + 'stage6.html', measuredAt: new Date().toISOString(), errors,
  machine: 'dev machine: i7-13700, RTX 3060, 64 GB, Windows 11; production vite build, headed, no CPU throttling' });

if (what === 'jobs') {
  const { browser, page, errors, version } = await open();
  try {
    const replayReps = JSON.parse(process.argv[4] ?? '{"hour":200,"day":30,"week":5}');
    // Started in the page and polled, because a single evaluate longer than puppeteer's protocolTimeout (180 s) fails.
    await page.evaluate((r) => { window.stage6.runJobs({ replayReps: r }).then((x) => { window.__jobsResult = x; }, (e) => { window.__jobsResult = { error: String(e) }; }); }, replayReps);
    let result = null;
    for (let t = 0; t < 900 && !result; t++) { // short polls; waitForFunction is one long call and hits protocolTimeout too
      await new Promise((r) => setTimeout(r, 2000));
      result = await page.evaluate(() => window.__jobsResult ?? null);
    }
    if (!result || result.error) throw new Error('jobs failed: ' + JSON.stringify(result));
    save(dataPath(`jobs-${browserName}`), { ...meta(version, errors), replayReps, result });
    console.log(JSON.stringify(result.grid.map((g) => [g.age, g.events, g.catchUp.workerComputeMs.median, g.catchUp.roundTripMs.p99, g.replay?.workerComputeMs.median])));
  } finally { await browser.close(); }
} else if (what === 'saves') {
  const { browser, page, errors, version } = await open();
  try {
    await page.evaluate(() => window.stage6.saveOnce());
    const result = await page.evaluate(() => window.stage6.runSaves(110, 10));
    save(dataPath(`saves-${browserName}`), { ...meta(version, errors), result });
    for (const [v, r] of Object.entries(result.variants)) console.log(v, 'sim-side median', r.simSideMs.median, 'p99', r.simSideMs.p99, 'save total median', r.saveWorkerTotalMs.median, 'bytes', r.bytes);
    console.log('load', JSON.stringify(result.load));
  } finally { await browser.close(); }
} else if (what === 'roundtrip') {
  // Export downloads the blob as a file; import reads it back. Compares sha-256 of IDB blob, file, and IDB blob after import.
  const dl = join(tmpdir(), 'vessel-stage6-dl');
  rmSync(dl, { recursive: true, force: true }); mkdirSync(dl, { recursive: true });
  const { browser, page, errors, version } = await open();
  try {
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
    await page.evaluate(() => window.stage6.saveOnce(5000));
    const shaBefore = await page.evaluate(() => window.stage6.shaOfSave());
    await page.evaluate(() => window.stage6.exportSave(true));
    let file;
    for (let i = 0; i < 100 && !file; i++) { await new Promise((r) => setTimeout(r, 100)); file = readdirSync(dl).find((f) => f.endsWith('.vsl')); }
    const path = join(dl, file);
    const bytes = readFileSync(path);
    const shaFile = createHash('sha256').update(bytes).digest('hex');
    await page.evaluate(() => window.stage6.clearSave());
    const afterClear = await page.evaluate(() => window.stage6.loadSave().then((r) => r.found));
    const input = await page.$('#imp');
    await input.uploadFile(path);
    await page.waitForFunction('window.__importResult', { timeout: 30000 });
    const imp = await page.evaluate(() => window.__importResult);
    const shaAfter = await page.evaluate(() => window.stage6.shaOfSave());
    const load = await page.evaluate(() => window.stage6.loadSave().then((r) => ({ found: r.found, tick: r.tick, bytes: r.bytes })));
    // A corrupted file must be rejected.
    const bad = Buffer.from(bytes); bad[bad.length >> 1] ^= 0xff;
    const badPath = join(dl, 'bad.vsl'); (await import('node:fs')).writeFileSync(badPath, bad);
    await page.evaluate(() => { delete window.__importResult; });
    await input.uploadFile(badPath);
    await page.waitForFunction('window.__importResult', { timeout: 30000 });
    const badImp = await page.evaluate(() => window.__importResult);
    const result = { fileBytes: bytes.length, shaBefore: shaBefore.sha, shaFile, shaAfterImport: shaAfter.sha, byteIdentical: shaBefore.sha === shaFile && shaFile === shaAfter.sha,
      foundAfterClear: afterClear, import: { ok: imp.ok, bytes: imp.bytes, tick: imp.tick }, loadAfterImport: load, corruptedFileImport: { ok: badImp.ok, error: badImp.error } };
    save(dataPath(`roundtrip-${browserName}`), { ...meta(version, errors), result });
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
} else if (what === 'storage') {
  const { browser, page, errors, version } = await open();
  try {
    const cdp = await page.createCDPSession();
    const usage = async () => (await cdp.send('Storage.getUsageAndQuota', { origin })).usage;
    const r = { steps: {} };
    r.steps.info = await page.evaluate(() => window.stage6.storageInfo());
    r.steps.writeNormal = await page.evaluate(() => window.stage6.saveOnce(7000));
    r.steps.shaAfterWrite = await page.evaluate(() => window.stage6.shaOfSave());
    r.steps.estimateAfterWrite = await page.evaluate(() => window.stage6.estimate());
    r.steps.cdpUsageAfterWrite = await cdp.send('Storage.getUsageAndQuota', { origin });
    const reload = async () => { await page.reload({ waitUntil: 'load' }); await page.waitForFunction('window.__ready === true'); };
    const okStep = (x) => ({ ok: x.ok, failures: x.failures, bytes: x.bytes, totalMs: x.totalMs });
    const existing = async () => ({ sha: (await page.evaluate(() => window.stage6.shaOfSave())).sha, load: await page.evaluate(() => window.stage6.loadSave().then((x) => ({ found: x.found, tick: x.tick, bytes: x.bytes, error: x.error ?? null }))) });
    // Quota (1 MB) below the existing data (1.8 MB stored) and below the new save (3.6 MB raw).
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 });
    r.steps.quota1MB_override = await cdp.send('Storage.getUsageAndQuota', { origin });
    r.steps.quota1MB_estimate = await page.evaluate(() => window.stage6.estimate());
    r.steps.quota1MB_writeSameSession = okStep(await page.evaluate(() => window.stage6.saveOnce(7001)));
    await reload();
    r.steps.quota1MB_estimateAfterReload = await page.evaluate(() => window.stage6.estimate());
    r.steps.quota1MB_writeAfterReload = okStep(await page.evaluate(() => window.stage6.saveOnce(7002)));
    r.steps.quota1MB_existingData = await existing();
    r.steps.quota1MB_smallWrite100KB = await page.evaluate(() => window.stage6.putRaw(100 * 1024));
    // Quota (4 MB) above the stored size (compressed) but about the raw save size.
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 4 * 1024 * 1024 });
    await reload();
    r.steps.quota4MB_writeAfterReload = okStep(await page.evaluate(() => window.stage6.saveOnce(7003)));
    r.steps.quota4MB_existingData = await existing();
    // Quota override removed.
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });
    await reload();
    r.steps.restored_write = okStep(await page.evaluate(() => window.stage6.saveOnce(7004)));
    // Simulated deletion (NOT a measurement of browser eviction): what the game sees when its IndexedDB is gone.
    await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
    await reload();
    r.steps.afterClearData_load = await page.evaluate(() => window.stage6.loadSave().then((x) => ({ found: x.found, error: x.error ?? null })));
    // First write into an empty origin whose quota (1 MB) is below the save: what error does the game get?
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 });
    await reload();
    r.steps.emptyOrigin_quota1MB_write = okStep(await page.evaluate(() => window.stage6.saveOnce(7005)));
    r.steps.emptyOrigin_quota1MB_afterFailedWrite_load = await page.evaluate(() => window.stage6.loadSave().then((x) => ({ found: x.found, error: x.error ?? null })));
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });
    save(dataPath(`storage-${browserName}`), { ...meta(version, errors), profile: 'fresh automation profile (puppeteer temp user-data-dir)', result: r });
    console.log(JSON.stringify(r, null, 1));
  } finally { await browser.close(); }
}
