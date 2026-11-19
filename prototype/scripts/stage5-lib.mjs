// Shared helpers for the Stage 5 test scripts.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, throttle } from './browser.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.STAGE5_PORT ?? 4175);
export const ORIGIN = `http://localhost:${PORT}`;
export const BASEURL = `${ORIGIN}/vessel/`;

// DevTools / puppeteer presets (bytes per second and milliseconds): Fast 4G = 9 Mbit/s x 0.9 down, 1.5 Mbit/s x 0.9 up, 60 ms x 2.75 latency.
// Slow 4G (DevTools' former "Fast 3G") = 1.6 Mbit/s x 0.9 down, 750 kbit/s x 0.9 up, 150 ms x 3.75 latency.
export const NET = {
  none: null,
  fast4g: { name: 'Fast 4G', downloadThroughput: 1012500, uploadThroughput: 168750, latency: 165 },
  slow4g: { name: 'Slow 4G', downloadThroughput: 180000, uploadThroughput: 84375, latency: 562.5 },
};

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: NaN, min: NaN, max: NaN, values };
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { n: v.length, median: +median.toFixed(1), min: +v[0].toFixed(1), max: +v[v.length - 1].toFixed(1), values: values.map((x) => +x.toFixed(1)) };
}

// Runs a command in prototype/ and returns its output.
export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

// Builds one variant of the site (vite build with a build tag, then the Stage 5 postbuild) into stage5/.deploys/<tag>.
// Assets must exist already (node stage5/build-assets.mjs).
export function buildVariant(tag) {
  const dir = join(root, 'stage5', '.deploys', tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, env: { ...process.env, VESSEL_BUILD_TAG: tag }, stdio: 'inherit' });
  execFileSync(process.execPath, [join(root, 'scripts', 'stage5-postbuild.mjs'), '--dist', dir, '--tag', tag], { cwd: root, stdio: 'inherit' });
  return dir;
}

// Copies a built variant, optionally runs keep-previous against the live site, then deploys it.
export async function deploy(emulator, builtDir, { keep, label }) {
  const stage = `${builtDir}.stage-${Date.now()}`;
  cpSync(builtDir, stage, { recursive: true });
  let keepLog = '';
  // Async on purpose: the emulator runs in this process, so a blocking child that fetches from it would deadlock.
  const run = (args) => promisify(execFile)(process.execPath, [join(root, 'scripts', 'stage5-keep-previous.mjs'), ...args], { cwd: root });
  if (keep) keepLog = (await run(['--dist', stage, '--site', BASEURL])).stdout;
  else await run(['--dist', stage]); // manifest without previous
  await emulator.deploy(stage);
  setTimeout(() => rmSync(stage, { recursive: true, force: true }), 2000);
  return { label, keep, keepLog: keepLog.trim() };
}

// Applies network throttling to the page and to every service worker target the browser creates.
export async function applyNetwork(browser, page, net) {
  const out = { net: net?.name ?? 'none', pageSession: false, swTargets: 0 };
  if (!net) return out;
  const params = { offline: false, latency: net.latency, downloadThroughput: net.downloadThroughput, uploadThroughput: net.uploadThroughput };
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', params);
  out.pageSession = true;
  browser.on('targetcreated', async (t) => {
    if (t.type() !== 'service_worker') return;
    try {
      const s = await t.createCDPSession();
      await s.send('Network.enable');
      await s.send('Network.emulateNetworkConditions', params);
      out.swTargets++;
    } catch (e) { out.swError = String(e); }
  });
  return out;
}

export async function waitResult(page, timeout = 90000) {
  await page.waitForFunction('window.__s5result || window.__s5error', { timeout, polling: 100 });
  return page.evaluate(() => ({ result: window.__s5result ?? null, error: window.__s5error ?? null }));
}

// One cold measurement: a new browser with a new empty profile.
export async function coldRun({ emulator, path, net, cpu = 1, waitAfterMs = 300 }) {
  const browser = await launch('chrome');
  try {
    const page = (await browser.pages())[0] ?? await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const consoleWarnings = [];
    page.on('console', (m) => { if (m.type() === 'warning' && !/powerPreference/.test(m.text())) consoleWarnings.push(m.text()); });
    const netInfo = await applyNetwork(browser, page, net);
    await throttle(page, cpu);
    const from = emulator.requests.length;
    await page.goto(BASEURL + path, { waitUntil: 'load' });
    await page.bringToFront();
    const r = await waitResult(page);
    // Preload warnings ("preloaded but not used") come a few seconds after load, so wait for them when asked.
    await new Promise((ok) => setTimeout(ok, waitAfterMs));
    return { ...r, requests: emulator.requests.slice(from), errors, consoleWarnings, netInfo, version: await browser.version() };
  } finally { await browser.close(); }
}

// Warm runs: one browser; visit once to populate the caches, then measure `reps` reloads.
export async function warmRuns({ emulator, path, net, cpu = 1, reps = 5, disableHttpCache = false }) {
  const browser = await launch('chrome');
  try {
    const page = (await browser.pages())[0] ?? await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const netInfo = await applyNetwork(browser, page, net);
    await throttle(page, cpu);
    // Populate: first visit, wait for the service worker to be active and its precache to land.
    await page.goto(BASEURL + path, { waitUntil: 'load' });
    await page.bringToFront();
    await waitResult(page);
    await page.waitForFunction(async () => { const r = await navigator.serviceWorker?.getRegistration(); if (!r?.active) return false; const ks = await caches.keys(); if (!ks.length) return false; const c = await caches.open(ks.find((k) => k.includes('files')) ?? ks[0]); return (await c.keys()).length >= 8; }, { timeout: 90000, polling: 200 });
    if (disableHttpCache) { const c = await page.createCDPSession(); await c.send('Network.setCacheDisabled', { cacheDisabled: true }); }
    const runs = [];
    for (let i = 0; i < reps; i++) {
      const from = emulator.requests.length;
      await page.goto(BASEURL + path, { waitUntil: 'load' });
      const r = await waitResult(page);
      await new Promise((ok) => setTimeout(ok, 300));
      runs.push({ ...r, requests: emulator.requests.slice(from) });
    }
    return { runs, errors, netInfo, version: await browser.version() };
  } finally { await browser.close(); }
}
void resolve; void existsSync;
