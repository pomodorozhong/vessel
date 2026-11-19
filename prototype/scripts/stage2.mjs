// Stage 2 measurement matrix. Usage: node scripts/stage2.mjs <dur seconds> <filter regex>
// Each run: headed Chrome, local preview build, 2,000 entities, real key presses sent through the
// browser's input pipeline about once a second (for input-to-screen delay).
import { existsSync } from 'node:fs';
import { launch, BASE, save } from './browser.mjs';

const dur = Number(process.argv[2] ?? 300);
const filter = new RegExp(process.argv[3] ?? '.');
const runs = [];
for (const [design, lag] of [['A', 2], ['B', 0]]) for (const cap of [0, 30]) for (const delay of [0, 20])
  runs.push({ name: `${design}${design === 'A' ? `-lag${lag}` : ''}-${cap || 60}fps-delay${delay}`, q: `design=${design}&lag=${lag}&cap=${cap}&delay=${delay}` });
for (const lag of [1, 1.5, 2.5, 3]) for (const cap of [0, 30]) runs.push({ name: `A-lag${lag}-${cap || 60}fps-delay20`, q: `design=A&lag=${lag}&cap=${cap}&delay=20` });
for (const design of ['A', 'B']) for (const stall of [100, 500]) runs.push({ name: `${design}-stall${stall}`, q: `design=${design}&lag=2&delay=20&stall=${stall}`, dur: 125 });
runs.push({ name: 'A-lag2-60fps-delay20-pool3', q: 'design=A&lag=2&delay=20&pool=3&maxq=1' });
runs.push({ name: 'A-lag2-60fps-delay0-heap', q: 'design=A&lag=2&delay=0', dur: 60 });
runs.push({ name: 'A-lag2-60fps-delay20-main', q: 'design=A&lag=2&delay=20&thread=main' });

export async function runOne(query, seconds, { heap = false } = {}) {
  const browser = await launch('chrome');
  try {
    const page = (await browser.pages())[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let workerClient = null;
    page.on('workercreated', (w) => { workerClient = w.client; });
    await page.goto(BASE + query, { waitUntil: 'load' });
    await page.bringToFront();
    await page.waitForFunction('window.__ready', { timeout: 30000 });
    await page.click('#game');
    let heapResult = null;
    if (heap) {
      // Sampling heap profiler on the page and the worker for 30 s of steady running.
      const cdp = await page.createCDPSession();
      await new Promise((r) => setTimeout(r, 8000));
      const clients = [['main', cdp], ['worker', workerClient]].filter(([, c]) => c);
      for (const [, c] of clients) await c.send('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      await new Promise((r) => setTimeout(r, 30000));
      heapResult = {};
      for (const [name, c] of clients) {
        const { profile } = await c.send('HeapProfiler.stopSampling');
        const byFn = {};
        const walk = (node) => { if (node.selfSize) { const k = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber}`; byFn[k] = (byFn[k] ?? 0) + node.selfSize; } node.children?.forEach(walk); };
        walk(profile.head);
        const total = Object.values(byFn).reduce((a, b) => a + b, 0);
        heapResult[name] = { seconds: 30, sampledBytes: total, bytesPerSecond: total / 30, top: Object.entries(byFn).sort((a, b) => b[1] - a[1]).slice(0, 12) };
      }
    }
    // Tap D about once a second until the bench ends.
    const end = Date.now() + (seconds + 40) * 1000;
    let result = null;
    while (Date.now() < end) {
      result = await page.evaluate('window.__result ?? null');
      if (result) break;
      await page.keyboard.down('KeyD');
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
      await page.keyboard.up('KeyD');
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
    }
    return { result, heap: heapResult, version: await browser.version(), errors, url: BASE + query, measuredAt: new Date().toISOString() };
  } finally { await browser.close(); }
}

if (process.argv[1].endsWith('stage2.mjs')) {
  for (const r of runs) {
    const d = r.dur && dur === 300 ? r.dur : dur;
    const name = `${r.name}${d !== 300 && !r.dur ? `-${d}s` : ''}`;
    if (!filter.test(name)) continue;
    const out = `results/data/stage2/${name}.json`;
    if (existsSync(out) && !process.env.FORCE) { console.log('skip (exists)', name); continue; }
    const res = await runOne(`?bench=stage2&n=2000&spawn=40&script=0&${r.q}&dur=${d}`, d, { heap: /heap/.test(name) });
    save(out, res);
    const c = res.result?.clock, l = res.result?.inputLatencyMs;
    console.log(name, c ? `pauses/min ${c.pausesPerMin.toFixed(1)} jumps/min ${c.jumpsPerMin.toFixed(1)} rms ${c.rmsErrMs.toFixed(2)}ms | maxQ ${c.maxQueue} held ${c.maxOutstanding} gaps ${c.gaps} dropped ${c.droppedByMain} skipped ${res.result.workerSkipped} | input med ${l?.median.toFixed(1)} p99 ${l?.p99.toFixed(1)} max ${l?.max.toFixed(1)} n=${l?.n} | frame p99 ${res.result.frameMs.p99.toFixed(1)} >34ms ${res.result.framesOver34ms} | late p99 ${res.result.sim.lateMs.p99.toFixed(1)} | recovery ${JSON.stringify(res.result.stallRecoveryMs.map((v) => Math.round(v)))}` : 'NO RESULT', res.errors.join(';'));
  }
}
