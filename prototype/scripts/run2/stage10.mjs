// Stage 10 measurement driver (sequential, resumable). Real key presses are sent through the browser's input pipeline about
// twice a second (Space = shoot, F = dash) so input-to-sound latency has real event.timeStamp values.
// Chrome runs headed with --autoplay-policy=no-user-gesture-required (an AudioContext needs a user gesture, and the key
// presses only start after the page is ready), and with the real audio device unless --mute is given
// (--mute-audio swaps the output for a fake stream, so latency and underrun numbers are then not meaningful).
//
// node scripts/run2/stage10.mjs [--only <regex>] [--dur 300] [--reps 3] [--pass 16400] [--throttle 4] [--busy 4] [--out <dir>] [--media <dir>] [--vol 1] [--mute] [--validate] [--warmup 10]
//   --pass is Stage 8's events per second at its pass load; --throttle is Chrome's CPU throttling of the page (1 on the reference
//   device); --busy burns that many ms of main thread per frame as a stand-in for rendering and snapshot handling.
//   mixers A,B x rates (pass, 2x, 4x) with stalls on, plus the pass rate without stalls, plus a 60 s heap run and a 15 s recording
//   per mixer. --validate adds the glitch-counter validation runs (idle, forceglitch=1, forceglitch=2) per mixer.
// Run it on an idle machine; nothing else may build or measure meanwhile. Results: <out>/<name>-rep<k>.json (default results/run-2/data/stage10).
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch, BASE, save, throttle } from '../browser.mjs';
import { startHeap, stopHeap } from './heap.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const dur = Number(arg('dur', 300)), reps = Number(arg('reps', 3)), pass = Number(arg('pass', 16400)), thr = Number(arg('throttle', 4)), busy = Number(arg('busy', 4)), warmup = Number(arg('warmup', 10)), vol = Number(arg('vol', 1));
const only = new RegExp(arg('only', '.'));
const out = arg('out', 'results/run-2/data/stage10/'), media = arg('media', 'results/run-2/media/stage10/');
const heapSecs = Number(arg('heapsecs', 60)), recSecs = Number(arg('recsecs', 15));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runs = [];
for (const mixer of ['A', 'B']) {
  const q = (rate, extra = '') => `bench=stage10&mixer=${mixer}&rate=${rate}&dur=${dur}&warmup=${warmup}&vol=${vol}&busy=${busy}${extra}`;
  for (const k of [1, 2, 4]) runs.push({ name: `${mixer}-r${pass * k}-stall`, query: q(pass * k, '&stalls=1'), reps, secs: dur });
  runs.push({ name: `${mixer}-r${pass}-nostall`, query: q(pass), reps, secs: dur });
  runs.push({ name: `${mixer}-r${pass}-lead`, query: q(pass, '&lead=-1'), reps, secs: dur }); // event sounds fired early by the pipeline delay
  runs.push({ name: `${mixer}-heap`, query: `bench=stage10&mixer=${mixer}&rate=${pass}&dur=${warmup + 5 + heapSecs + 5}&warmup=${warmup}&vol=${vol}&busy=${busy}`, reps: 1, secs: warmup + 5 + heapSecs + 5, heap: true });
  runs.push({ name: `${mixer}-rec`, query: `bench=stage10&mixer=${mixer}&rate=${pass}&dur=${recSecs + 8}&warmup=${warmup}&vol=${vol}&busy=${busy}&record=${recSecs}`, reps: 1, secs: recSecs + 8, rec: true });
  if (flag('validate')) {
    const vd = Number(arg('vdur', 40));
    runs.push({ name: `${mixer}-validate-idle`, query: `bench=stage10&mixer=${mixer}&rate=0&own=0&dur=${vd}&warmup=${warmup}&vol=${vol}&busy=${busy}`, reps: 1, secs: vd });
    runs.push({ name: `${mixer}-validate-fg1`, query: `bench=stage10&mixer=${mixer}&rate=${pass}&dur=${vd}&warmup=${warmup}&vol=${vol}&busy=${busy}&forceglitch=1`, reps: 1, secs: vd });
    runs.push({ name: `${mixer}-validate-fg2`, query: `bench=stage10&mixer=${mixer}&rate=${pass}&dur=${vd}&warmup=${warmup}&vol=${vol}&busy=${busy}&forceglitch=2`, reps: 1, secs: vd });
  }
}

async function runOne(run) {
  const browser = await launch('chrome', { args: ['--autoplay-policy=no-user-gesture-required', ...(flag('mute') ? ['--mute-audio'] : [])] });
  try {
    const page = (await browser.pages())[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE + 'stage10.html?' + run.query, { waitUntil: 'load' });
    if (thr > 1) await throttle(page, thr); // the page only: Chrome cannot throttle workers or the audio thread
    await page.bringToFront();
    await page.waitForFunction('window.__ready', { timeout: 60000 });
    const t0 = Date.now(), end = t0 + (run.secs + 90) * 1000;
    let heap = null, heapStarted = false, result = null;
    while (Date.now() < end) {
      result = await page.evaluate('window.__result ?? null');
      if (result) break;
      if (run.heap && !heapStarted && Date.now() - t0 > (warmup + 5) * 1000) { heapStarted = true; heap = await startHeap(page, browser); heap.begun = Date.now(); }
      if (heap && heap.begun && !heap.done && Date.now() - heap.begun > heapSecs * 1000) { heap.done = true; heap.result = await stopHeap(heap); }
      await page.keyboard.down(Math.random() < 0.6 ? 'Space' : 'KeyF');
      await sleep(40);
      await page.keyboard.up('Space'); await page.keyboard.up('KeyF');
      await sleep(250 + Math.random() * 350);
    }
    if (!result) throw new Error('timed out');
    let recording = null;
    if (run.rec) recording = await page.evaluate('window.__recording ?? null');
    return { result, heap: heap?.result ?? null, recording, version: await browser.version(), errors, url: BASE + 'stage10.html?' + run.query, measuredAt: new Date().toISOString() };
  } finally { await browser.close(); }
}

for (const run of runs) {
  if (!only.test(run.name)) continue;
  for (let k = 1; k <= run.reps; k++) {
    const path = `${out}${run.name}-rep${k}.json`;
    if (existsSync(path)) { console.log('skip', path); continue; }
    console.log(new Date().toISOString(), run.name, 'rep', k, `(${run.secs} s)`);
    let r;
    try { r = await runOne(run); } catch (e) { console.error('failed:', e.message); continue; }
    if (r.recording) {
      mkdirSync(media, { recursive: true });
      const file = `${media}${run.name}.webm`;
      writeFileSync(file, Buffer.from(r.recording.base64, 'base64'));
      r.recording = { file, bytes: r.recording.bytes, mime: r.recording.mime };
    }
    save(path, { name: run.name, rep: k, ...r });
    const g = r.result.glitches;
    console.log(`  late ${g.detectorLate}, underruns ${g.playbackUnderrunEvents}, audio ms/frame p99 ${r.result.mainThreadAudioMsPerFrame.p99?.toFixed(3)}, errors ${r.errors.length}`);
  }
}
