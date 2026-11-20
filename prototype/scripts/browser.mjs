// Drives a real, headed browser for measurements. Chrome and Edge are the installed stable builds.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BROWSERS = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
export const BASE = process.env.VESSEL_BASE ?? 'http://localhost:4173/vessel/';

export async function launch(browser = 'chrome', { args = [], width = 1920, height = 1080, headless = false } = {}) {
  return puppeteer.launch({
    executablePath: BROWSERS[browser],
    headless,
    protocolTimeout: 900000,
    defaultViewport: null,
    args: [
      `--window-size=${width},${height + 90}`, '--window-position=0,0',
      // Keep timers and rAF at full speed if the window loses focus or is covered during a long run.
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--no-first-run', '--no-default-browser-check',
      ...args,
    ],
  });
}

// Applies Chrome's CPU throttling to the page and to every worker it starts.
export async function throttle(page, rate) {
  if (!rate || rate === 1) return;
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  page.on('workercreated', async (w) => {
    try { await w.client.send('Emulation.setCPUThrottlingRate', { rate }); } catch (e) { console.error('worker throttle failed:', e.message); }
  });
}

export async function runPage(browserName, query, { throttleRate = 1, timeoutMs = 420000, expr = 'window.__result', launchOpts = {}, before } = {}) {
  const browser = await launch(browserName, launchOpts);
  try {
    const page = (await browser.pages())[0] ?? await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await throttle(page, throttleRate);
    if (before) await before(page, browser);
    await page.goto(BASE + query, { waitUntil: 'load' });
    await page.bringToFront();
    // Poll from this side: one long in-page wait would hit the DevTools protocol timeout on 5-minute runs.
    const deadline = Date.now() + timeoutMs;
    let result = null;
    while (!(result = await page.evaluate(expr))) {
      if (Date.now() > deadline) throw new Error('timed out waiting for ' + expr.slice(0, 40));
      await new Promise((r) => setTimeout(r, 1000));
    }
    const version = await browser.version();
    return { result, version, errors, url: BASE + query, throttleRate, measuredAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

export function save(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 1));
}
