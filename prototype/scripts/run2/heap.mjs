// Run 2 allocation measurement shared by Stages 9, 10 and 11: separates the game's allocations from the test harness's.
//
// Method: CDP HeapProfiler.startSampling (small sampling interval, objects collected by minor and major GC included) on the
// page target and on every worker target. Each sampled allocation is attributed by its stack: the nearest frame (from the
// allocation site upward) that has a script URL decides. A URL whose file name contains "harness" is the harness
// (harness code lives in files named harness*, which a vite build puts in their own chunks), any other page script is the
// game, and an allocation with no script frame at all (parsing, message deserialisation, DevTools evaluate) is browser/internal.
// Run `node scripts/run2/heap.mjs calib` to check the method on two loops (one allocates nothing, one about 1 KB per frame).
//
// What it cannot see: memory outside the V8 heap. Typed array and ArrayBuffer backing stores larger than a small inline size,
// WASM linear memory growth (check memory.buffer.byteLength before and after instead), native Web Audio objects (only their JS
// wrappers are sampled), and anything inside the AudioWorkletGlobalScope (it is not offered as a target to the profiler here;
// the report lists which targets were found). Sampling is statistical: bytes/s are estimates, good to a few percent at these rates.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, BASE } from '../browser.mjs';

const OWNERS = ['game', 'harness', 'internal'];
export function classify(url) {
  if (!url) return null;
  if (/^(chrome-extension|devtools|extensions)/.test(url) || url.startsWith('chrome://')) return 'internal';
  const file = url.split('?')[0].split('/').pop();
  return /harness/i.test(file) ? 'harness' : 'game';
}

// Splits a sampling profile into the three buckets, with the top functions of each.
export function attribute(profile) {
  const bytes = { game: 0, harness: 0, internal: 0 };
  const top = { game: {}, harness: {}, internal: {} };
  const walk = (node, owner) => {
    const own = classify(node.callFrame.url) ?? owner;
    if (node.selfSize) {
      bytes[own] += node.selfSize;
      const k = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').pop() || '(no url)'}:${node.callFrame.lineNumber}`;
      top[own][k] = (top[own][k] ?? 0) + node.selfSize;
    }
    for (const c of node.children ?? []) walk(c, own);
  };
  walk(profile.head, 'internal');
  const topList = Object.fromEntries(OWNERS.map((o) => [o, Object.entries(top[o]).sort((a, b) => b[1] - a[1]).slice(0, 8)]));
  return { bytes, top: topList };
}

async function metrics(cdp) {
  try { const { metrics: m } = await cdp.send('Performance.getMetrics'); return Object.fromEntries(m.filter((x) => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'JSEventListeners'].includes(x.name)).map((x) => [x.name, x.value])); } catch { return null; }
}

// Starts sampling on the page and its workers. Call stopHeap() with the returned handle after the window to measure.
export async function startHeap(page, browser, { interval = 128 } = {}) {
  const sessions = [];
  const add = async (name, cdp) => {
    try {
      await cdp.send('Performance.enable').catch(() => {});
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: interval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      sessions.push({ name, cdp, metrics0: await metrics(cdp) });
    } catch (e) { sessions.push({ name, cdp: null, error: String(e.message ?? e) }); }
  };
  await add('main', await page.createCDPSession());
  let n = 0;
  for (const w of page.workers()) await add(`worker${n++}:${w.url().split('/').pop()}`, w.client);
  const targets = browser ? browser.targets().map((t) => `${t.type()} ${t.url().split('/').pop().slice(0, 60)}`) : [];
  return { sessions, targets, t0: Date.now() };
}

export async function stopHeap(h) {
  const seconds = (Date.now() - h.t0) / 1000, out = { seconds, targets: h.targets, sessions: {} };
  for (const s of h.sessions) {
    if (!s.cdp) { out.sessions[s.name] = { error: s.error }; continue; }
    const m1 = await metrics(s.cdp);
    const { profile } = await s.cdp.send('HeapProfiler.stopSampling');
    const a = attribute(profile);
    out.sessions[s.name] = {
      bytesPerSecond: Object.fromEntries(OWNERS.map((o) => [o, a.bytes[o] / seconds])),
      sampledBytes: a.bytes, top: a.top,
      metrics: s.metrics0 && m1 ? { start: s.metrics0, end: m1 } : null,
    };
  }
  // Totals over all sessions, per bucket.
  out.totalBytesPerSecond = Object.fromEntries(OWNERS.map((o) => [o, Object.values(out.sessions).reduce((a, x) => a + (x.bytesPerSecond?.[o] ?? 0), 0)]));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calibration: two loops with known behaviour. The method is trusted only if both pass.
async function calibrate(secs, outPath) {
  const results = {};
  for (const mode of ['noalloc', 'alloc']) {
    const browser = await launch('chrome');
    try {
      const page = (await browser.pages())[0];
      await page.goto(BASE + `run2-calib.html?calib=${mode}`, { waitUntil: 'load' });
      await page.bringToFront();
      await page.waitForFunction('window.__ready', { timeout: 30000 });
      await sleep(4000);
      const c0 = await page.evaluate('window.__calib()');
      const h = await startHeap(page, browser);
      await sleep(secs * 1000);
      const c1 = await page.evaluate('window.__calib()');
      const r = await stopHeap(h);
      const fps = (c1.frames - c0.frames) / (c1.seconds - c0.seconds);
      results[mode] = { fps, ...r };
      results[mode].expectedGameBytesPerSecond = mode === 'alloc' ? 1040 * fps : 0;
    } finally { await browser.close(); }
  }
  const na = results.noalloc.sessions.main.bytesPerSecond, al = results.alloc.sessions.main.bytesPerSecond, exp = results.alloc.expectedGameBytesPerSecond;
  results.verdict = {
    noalloc: { gameBytesPerSecond: na.game, harnessBytesPerSecond: na.harness, pass: na.game < 600 },
    alloc: { gameBytesPerSecond: al.game, expected: exp, ratio: al.game / exp, harnessBytesPerSecond: al.harness, pass: al.game / exp > 0.8 && al.game / exp < 1.25 },
    separation: { harnessSeenInBothLoops: na.harness > 0 && al.harness > 0 },
  };
  results.verdict.methodTrusted = results.verdict.noalloc.pass && results.verdict.alloc.pass && results.verdict.separation.harnessSeenInBothLoops;
  if (outPath) { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, JSON.stringify(results, null, 1)); }
  console.log(JSON.stringify(results.verdict, null, 1));
  console.log('fps noalloc/alloc:', results.noalloc.fps.toFixed(1), results.alloc.fps.toFixed(1));
  console.log('top game functions (alloc loop):', results.alloc.sessions.main.top.game.slice(0, 3));
  console.log('targets seen:', results.alloc.targets);
  return results;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop()) && process.argv[2] === 'calib') {
  const si = process.argv.indexOf('--secs'), secs = si > 0 ? Number(process.argv[si + 1]) : 20;
  const outI = process.argv.indexOf('--out');
  await calibrate(secs, outI > 0 ? process.argv[outI + 1] : null);
}
