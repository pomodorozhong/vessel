// Stage 11 measurement driver: the 5-minute wave with everything at once (sequential, resumable).
//
//   node scripts/run2/stage11.mjs                 every run below (about 45 min)
//   node scripts/run2/stage11.mjs --list          print the runs, run nothing
//   node scripts/run2/stage11.mjs --only "wave-"  only runs whose name matches the regex
//   Options: --dur <s> (default 300) --reps <n> (default 3) --throttle <n> (default 4; 1 on the reference device) --out <dir> --vol <0..1>
//            --extra 'k=v&...' appended to every run's URL (e.g. simslow=2)
//
// Runs: the wave (enemies 300 -> 5,000 over 240 s, then held) x reps at the throttle; one wave unthrottled (the dev machine
// as it is); one wave with a GPU process crash 150 s in; one wave with 60 s of allocation sampling at the peak; and the
// ramp past the bar (5,000 by 120 s, then +3,000 enemies a minute) to see which budget breaks first.
// Real key presses go through the browser's input pipeline about twice a second (Space = shoot, F = dash), as in Stage 10.
// Chrome's CPU throttling applies to the page only: it cannot throttle workers, so the sim worker runs at full speed.
// Headed Chrome, real audio device, 1920x1080 canvas. Nothing else may build or measure on this machine meanwhile.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, launch, save, throttle } from '../browser.mjs';
import { startHeap, stopHeap } from './heap.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const dur = Number(opt('dur', 300)), reps = Number(opt('reps', 3)), thr = Number(opt('throttle', 4)), vol = Number(opt('vol', 1));
const OUT = opt('out', 'results/run-2/data/stage11');
const only = new RegExp(opt('only', '.'));
const EXTRA = opt('extra', '') ? '&' + opt('extra', '') : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARGS = ['--autoplay-policy=no-user-gesture-required', '--enable-webgpu-developer-features', '--enable-precise-memory-info'];

const q = (extra = '') => `stage11.html?bench=stage11&dur=${dur}&overlay=0&vol=${vol}${extra}${EXTRA}`;
const runs = [];
for (let r = 1; r <= reps; r++) runs.push({ name: `wave-r${r}`, query: q(), thr });
runs.push({ name: 'wave-cpu1', query: q(), thr: 1 });
runs.push({ name: 'crash', query: q(), thr, crashAt: Math.min(150, dur / 2) });
const heapSecs = Math.min(60, dur - 10);
runs.push({ name: 'heap', query: q(), thr, heapAt: dur - heapSecs - 5, heapSecs });
runs.push({ name: 'past', query: q('&mode=past&ramp=120&past=3000'), thr });

if (flag('list')) { for (const r of runs) if (only.test(r.name)) console.log(r.name.padEnd(12), `x${r.thr}`, r.query); process.exit(0); }

async function runOne(run) {
  const browser = await launch('chrome', { args: ARGS });
  try {
    const page = (await browser.pages())[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url ?? '')) errors.push(m.text()); });
    await throttle(page, run.thr);
    await page.goto(BASE + run.query, { waitUntil: 'load' });
    await page.bringToFront();
    await page.waitForFunction('window.__ready || window.__error', { timeout: 120000 });
    const err = await page.evaluate('window.__error ?? null');
    if (err) throw new Error(err);
    const t0 = Date.now(), warm = 5000, end = t0 + (dur + 120) * 1000;
    let heap = null, crash = null, result = null;
    while (Date.now() < end) {
      result = await page.evaluate('window.__result11 ?? null');
      if (result) break;
      const at = (Date.now() - t0 - warm) / 1000;
      if (run.crashAt && !crash && at >= run.crashAt) {
        crash = { at, before: await page.evaluate('window.__state()') };
        const bcdp = await browser.target().createCDPSession();
        await bcdp.send('Browser.crashGpuProcess').catch((e) => { crash.error = String(e); });
      }
      if (crash && !crash.after && at >= run.crashAt + 20) crash.after = await page.evaluate('window.__state()');
      if (run.heapAt && !heap && at >= run.heapAt) { heap = await startHeap(page, browser); heap.begun = Date.now(); }
      if (heap && heap.begun && !heap.done && Date.now() - heap.begun >= run.heapSecs * 1000) { heap.done = true; heap.result = await stopHeap(heap); }
      await page.keyboard.down(Math.random() < 0.6 ? 'Space' : 'KeyF');
      await sleep(40);
      await page.keyboard.up('Space'); await page.keyboard.up('KeyF');
      await sleep(250 + Math.random() * 350);
    }
    if (!result) throw new Error('timed out');
    if (crash) { crash.lost = result.lost; crash.recovered = result.recovered; }
    return { result, heap: heap?.result ?? null, crash, version: await browser.version(), errors, throttleRate: run.thr, url: BASE + run.query, measuredAt: new Date().toISOString() };
  } finally { await browser.close(); }
}

const line = (n, x) => {
  const r = x.result, s = r.sim;
  return `${n}: sim p99 ${s.stepMs.p99.toFixed(2)} | encode p99 ${r.mainThread.encode.p99.toFixed(2)} | gpu p99 ${r.gpuMs.p99.toFixed(2)} | frame p99 ${r.frames.frameMs.p99.toFixed(2)} | pauses ${r.clock.pauses} jumps ${r.clock.jumps} | audio late ${r.audio?.glitches?.detectorLate} | main p99 ${r.mainThread.total.p99.toFixed(2)} | snap ${(s.snapshotBytes.mean / 1024).toFixed(0)} KB | heap ${r.memory.heapFirstMinMedianMB?.toFixed(1)}->${r.memory.heapLastMinMedianMB?.toFixed(1)} MB | first break ${r.firstBreak.order.map((o) => `${o.budget}@${o.at}s/${o.enemies}`).join(', ') || 'none'}`;
};

for (const run of runs) {
  if (!only.test(run.name)) continue;
  const path = join(OUT, `${run.name}.json`);
  if (existsSync(path)) { console.log('skip', path); continue; }
  console.log(new Date().toISOString(), run.name);
  let r;
  try { r = await runOne(run); } catch (e) { console.error('failed:', run.name, e.message); continue; }
  save(path, { name: run.name, ...r });
  console.log(line(run.name, r), r.errors.length ? `errors ${r.errors.length}` : '');
}
