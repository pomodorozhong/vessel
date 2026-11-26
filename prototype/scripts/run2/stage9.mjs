// Run 2, Stage 9 measurement driver: the cel-shaded look at the Stage 8 load.
//
//   node scripts/run2/stage9.mjs                  the whole matrix and the sweeps (long: see --list)
//   node scripts/run2/stage9.mjs --list           print the runs and the time they take, run nothing
//   node scripts/run2/stage9.mjs --only "p10000-i1080"   only runs whose name matches the regex
//   node scripts/run2/stage9.mjs --dur 20 --reps 1 --out /tmp/smoke   a quick smoke run
//   node scripts/run2/stage9.mjs --shots          screenshots of every option (and a recording), no measurement
//   --throttle N   CPU throttling (default 4, the dev-machine stand-in; 1 on the reference device)
//   --extra 'k=v&...'   appended to every screenshot URL (with --shots)
//   node scripts/run2/stage9.mjs --crash          one GPU process crash (Browser.crashGpuProcess), check the look comes back; --crashes 2 adds a second one (Chrome does not recover a second crash within about 150 s, see results/stage-4.md)
//
// Options: --dur <s> (default 300) --reps <n> (default 3) --sweepdur <s> (default 60) --out <dir> --media <dir>
// One headed Chrome window per run on the preview build (VESSEL_BASE, default http://localhost:4173/vessel/;
// the Stage 9 page is built with `vite build -c vite.stage9.config.ts`). Chrome's CPU throttling is 4x on the page only
// (Chrome cannot throttle workers, so the stream worker runs at full speed), the GPU is not slowed, the canvas is 1920x1080. Existing result files are skipped, so a run resumes.
// Nothing else may build or measure on this machine while a measurement runs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, launch, runPage, save, throttle } from '../browser.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const dur = Number(opt('dur', 300)), reps = Number(opt('reps', 3)), sweepDur = Number(opt('sweepdur', 60));
const OUT = opt('out', 'results/run-2/data/stage9'), MEDIA = opt('media', 'results/run-2/media/stage9');
const only = new RegExp(opt('only', '.'));
// --extra 'k=v&...' is appended to every screenshot URL, e.g. low event rates so the base look can be judged without the effects.
const EXTRA = opt('extra', '') ? '&' + opt('extra', '') : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// By default Chrome rounds GPU timestamps to about 100 us, which is too coarse for passes of a fraction of a millisecond.
// This flag turns the rounding off. It is a measurement flag only; it does not change what the GPU does.
const TIMING_ARGS = ['--enable-webgpu-developer-features'];

// ---- the runs
// Every run starts from the full look at 1080p (hull outlines, shadow map, 10,000 particles, 2,000 enemies, 1,000 projectiles)
// and changes only what it names, so no parameter appears twice in a URL.
const Q = (over = {}) => new URLSearchParams(Object.entries({ enemies: 2000, proj: 1000, particles: 10000, ires: 1080, outline: 'hull', shadow: 'map', ...over }).map(([k, v]) => [k, String(v)])).toString();
const runs = [];
for (const p of [0, 10000, 50000]) for (const ires of [720, 1080]) for (const outline of ['hull', 'edge']) for (const shadow of ['map', 'blob'])
  for (let r = 1; r <= reps; r++) runs.push({ name: `main-p${p}-i${ires}-${outline}-${shadow}-r${r}`, q: Q({ particles: p, ires, outline, shadow }), dur, group: 'main' });
// Push-past sweeps, one parameter at a time.
const sweep = (name, vals, mk) => { for (const v of vals) runs.push({ name: `sweep-${name}-${v}`, q: Q(mk(v)), dur: sweepDur, group: 'sweep' }); };
sweep('grass', [2, 4, 8, 16], (v) => ({ grass: v }));
sweep('particles', [100000, 200000, 400000], (v) => ({ particles: v }));
sweep('enemies', [5000, 10000, 20000], (v) => ({ enemies: v }));
// Overdraw and dynamic resolution, one run each.
runs.push({ name: 'overdraw-hull', q: Q({ overdraw: 1 }), dur: sweepDur, group: 'overdraw' });
runs.push({ name: 'overdraw-edge', q: Q({ overdraw: 1, outline: 'edge' }), dur: sweepDur, group: 'overdraw' });
runs.push({ name: 'dynres-p50000-budget10', q: Q({ particles: 50000, dynres: 1, budget: 10 }), dur: sweepDur, group: 'dynres' });
runs.push({ name: 'dynres-p10000-budget6', q: Q({ dynres: 1, budget: 6 }), dur: sweepDur, group: 'dynres' });
// The dev GPU never goes over the 10 ms budget, so these budgets sit inside its normal range to make the controller act.
runs.push({ name: 'dynres-p10000-budget3', q: Q({ dynres: 1, budget: 3 }), dur: sweepDur, group: 'dynres' });
runs.push({ name: 'dynres-p50000-budget4', q: Q({ particles: 50000, dynres: 1, budget: 4 }), dur: sweepDur, group: 'dynres' });

if (flag('list')) {
  let total = 0;
  for (const r of runs) { if (!only.test(r.name)) continue; total += r.dur + 40; console.log(r.name.padEnd(44), `${r.dur}s`, r.q); }
  console.log(`\n${runs.filter((r) => only.test(r.name)).length} runs, about ${(total / 3600).toFixed(1)} hours including startup`);
  process.exit(0);
}

const line = (name, x) => {
  const p = x.gpuGroupsMs;
  return `${name}: gpu ${x.gpuTotalMs ? `${x.gpuTotalMs.median.toFixed(2)} / p99 ${x.gpuTotalMs.p99.toFixed(2)}` : '-'} ms | encode ${x.encodeMs.median.toFixed(2)} / ${x.encodeMs.p99.toFixed(2)} | frame ${x.frameMs.median.toFixed(2)} / p99 ${x.frameMs.p99.toFixed(2)} | draws ${x.drawCalls} | internal ${x.internal?.join('x')} | alive ${x.particles.alive.median?.toFixed(0)}${p ? ` | shadow ${p.shadowMap.median.toFixed(2)} grass ${p.grass.median.toFixed(2)} world ${p.world.median.toFixed(2)} outl ${p.outlines.median.toFixed(2)} part ${p.particles.median.toFixed(2)} fx ${p.effects.median.toFixed(2)} bloom ${p.bloom.median.toFixed(2)} up ${p.upscale.median.toFixed(2)} ui ${p.ui.median.toFixed(2)}` : ''}`;
};

async function measure() {
  for (const run of runs) {
    if (!only.test(run.name)) continue;
    const out = join(OUT, `${run.name}${run.dur !== 300 && run.group === 'main' ? `-${run.dur}s` : ''}.json`);
    if (existsSync(out) && !process.env.FORCE) { console.log('skip (exists)', run.name); continue; }
    let r;
    try { r = await runPage('chrome', `stage9.html?${run.q}&bench=stage9&dur=${run.dur}&warmup=5&overlay=0`, { throttleRate: Number(opt('throttle', 4)), timeoutMs: (run.dur + 120) * 1000, expr: 'window.__result ?? window.__error ?? null', launchOpts: { args: TIMING_ARGS } }); }
    catch (e) { console.log('FAILED', run.name, String(e).slice(0, 200)); continue; }
    save(out, { name: run.name, group: run.group, ...r });
    if (typeof r.result === 'string') { console.log('ERROR', run.name, r.result); continue; }
    console.log(line(run.name, r.result), r.errors.filter((e) => !/404/.test(e)).slice(0, 2).join(';'));
    if (r.result.errors?.length) console.log('  GPU errors:', r.result.errors.slice(0, 2).join(' | '));
  }
}

// ---- screenshots of every option, and a short recording
async function shots() {
  mkdirSync(MEDIA, { recursive: true });
  const browser = await launch('chrome');
  const files = {};
  try {
    const page = (await browser.pages())[0] ?? await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });   // the canvas fills the page, so the screenshots have no letterbox
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    for (const [tod, label] of [[0.45, 'day'], [0.72, 'dusk']]) for (const shadow of ['map', 'blob']) for (const outline of ['hull', 'edge', 'none']) {
      const name = `look-${outline}-${shadow}-${label}`;
      // The same scripted frame for every option: same seed, same time of day, the stream is sampled after the same delay.
      await page.goto(`${BASE}stage9.html?${Q({ outline, shadow })}&tod=${tod}&overlay=0&seed=1${EXTRA}`, { waitUntil: 'load' });
      await page.bringToFront();
      await sleep(9000);
      const path = join(MEDIA, `${name}.jpg`);
      await page.screenshot({ path, type: 'jpeg', quality: 88 });
      files[name] = path; console.log('shot', path, (statSync(path).size / 1024).toFixed(0), 'KB');
    }
    // A low camera shows the sky, the fog and the grass bending away from the crowd.
    for (const [tod, label] of [[0.3, 'dawn'], [0.45, 'day'], [0.72, 'dusk']]) {
      await page.goto(`${BASE}stage9.html?${Q()}&tod=${tod}&pitch=30&dist=40&overlay=0&seed=1${EXTRA}`, { waitUntil: 'load' });
      await sleep(9000);
      const path = join(MEDIA, `lowcam-${label}.jpg`);
      await page.screenshot({ path, type: 'jpeg', quality: 88 }); console.log('shot', path);
    }
    // Side by side with ffmpeg when it is on PATH: outline hull | edge | none, one sheet per shadow method and time of day.
    for (const label of ['day', 'dusk']) for (const shadow of ['map', 'blob']) {
      const ins = ['hull', 'edge', 'none'].map((o) => join(MEDIA, `look-${o}-${shadow}-${label}.jpg`));
      try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...ins.flatMap((f) => ['-i', f]), '-filter_complex', '[0]scale=960:-1[a];[1]scale=960:-1[b];[2]scale=960:-1[c];[a][b][c]hstack=3', '-q:v', '4', join(MEDIA, `sidebyside-${shadow}-${label}.jpg`)]); console.log('sheet', shadow, label); }
      catch (e) { console.log('no side-by-side sheet (ffmpeg):', String(e.message).slice(0, 100)); break; }
    }
    // A recording of the full look in combat, about 10 s.
    await page.goto(`${BASE}stage9.html?${Q()}&tod=0.45&overlay=0&seed=1${EXTRA}`, { waitUntil: 'load' });
    await sleep(6000);
    const rec = join(MEDIA, 'combat.webm');
    try {
      const sc = await page.screencast({ path: rec, scale: 0.5, fps: 30 });
      await sleep(10000);
      await sc.stop();
      console.log('raw recording', rec, (statSync(rec).size / 1024 / 1024).toFixed(1), 'MB');
      // The raw screencast is tens of MB (the scene is full of small moving particles); H.264 at 960x540 keeps the file small.
      const mp4 = join(MEDIA, 'combat.mp4');
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', rec, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '34', '-pix_fmt', 'yuv420p', '-vf', 'scale=960:-2,fps=30', '-movflags', '+faststart', mp4]);
      unlinkSync(rec);
      files.recording = mp4;
      console.log('recording', mp4, (statSync(mp4).size / 1024 / 1024).toFixed(2), 'MB');
    } catch (e) { console.log('page.screencast failed:', String(e).slice(0, 200)); }
    save(join(MEDIA, 'shots.json'), { measuredAt: new Date().toISOString(), version: await browser.version(), files, errors });
  } finally { await browser.close(); }
}

// ---- GPU process crash: the whole look must come back through the one rebuild path
async function crash() {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch('chrome');
  const res = { measuredAt: new Date().toISOString(), version: await browser.version(), url: '', steps: [] };
  try {
    const page = (await browser.pages())[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const q = `stage9.html?${Q()}&overlay=0&seed=1${EXTRA}`;
    res.url = BASE + q;
    await page.goto(BASE + q, { waitUntil: 'load' });
    await page.bringToFront();
    const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { let v = null; try { v = await page.evaluate(expr); } catch {} if (v) return v; await sleep(100); } return null; };
    await until('window.__ready', 30000); await sleep(8000);
    const stats = () => page.evaluate(`(() => { const s = window.__state(); const i = s.info; return { rebuilds: s.rebuilds, deviceLosses: s.deviceLosses, hasGpu: s.hasGpu, visible: i?.visible, grassChunks: i?.grassChunks, alive: i?.alive, shadowCasters: i?.shadowCasters, shadowRes: i?.shadowRes, errors: s.errors }; })()`);
    res.before = await stats();
    await page.screenshot({ path: join(OUT, 'crash-before.jpg'), type: 'jpeg', quality: 80 });
    for (let k = 1; k <= Number(opt("crashes", 1)); k++) {
      await page.evaluate('window.__lost = null; window.__recovered = null');
      const bcdp = await browser.target().createCDPSession();
      const t0 = Date.now();
      await bcdp.send('Browser.crashGpuProcess').catch((e) => { res.crashError = String(e); });
      const lost = await until('window.__lost', 20000);
      const rec = lost ? await until('window.__recovered || window.__unsupported', 80000) : null;
      await sleep(8000);
      const after = await stats();
      await page.screenshot({ path: join(OUT, `crash-after-${k}.jpg`), type: 'jpeg', quality: 80 });
      res.steps.push({ k, lost, recovered: rec, waitedMs: Date.now() - t0, after, lookBack: !!(after.hasGpu && after.visible > 0 && after.grassChunks > 0 && after.alive > 0 && after.shadowCasters > 0) });
      console.log('crash', k, JSON.stringify(res.steps.at(-1)));
      await sleep(6000);
    }
    res.pageErrors = errors;
  } finally { await browser.close(); }
  save(join(OUT, 'crash.json'), res);
}

if (flag('shots')) await shots();
else if (flag('crash')) await crash();
else await measure();
