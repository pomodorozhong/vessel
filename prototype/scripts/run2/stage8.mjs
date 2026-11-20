// Stage 8 measurement driver: combat collision (pair finding A/B/C and Rapier 2D).
//
//   node scripts/run2/stage8.mjs [options]          run from prototype/, against `vite preview` (BASE below)
//
// Options (all optional):
//   --dur <s>         recorded seconds per run (default 300)
//   --reps <n>        repetitions of each main-matrix run (default 3)
//   --throttle <n>    Chrome CPU throttling rate (default 4; 1 = none). The sim runs on the main thread by default,
//                     because the throttle does not slow workers (see --thread).
//   --thread <t>      main | worker (default main)
//   --warmup <s>      seconds before recording starts (default 5)
//   --push-dur <s>    recorded seconds of each push-past run (default 60)
//   --push-full       run every point of the push-past sweeps (default: stop a sweep one point after p99 passes the bar)
//   --bar <ms>        p99 bar for the push-past sweeps (default 4)
//   --check-dur <s>   recorded seconds of the pass-through check runs (default 60)
//   --series <list>   comma list of: main, push, check (default all). `check` runs the reference check with sweeping on
//                     (pass-throughs must be 0) and, as calibration, with sweeping off (must be > 0).
//   --methods <list>  default A,B,C,rapier
//   --only <regex>    run only runs whose name matches (the name is printed for each run)
//   --out <dir>       output folder (default results/run-2/data/stage8)
//   --browser <b>     chrome | edge (default chrome)
//   --timeout-scale   multiplies each run's timeout (default 1). Rapier at 10,000+ enemies runs slower than real time
//                     (the sim counts ticks, not seconds), so a 300 s run can take an hour at 4x; use --dur for those.
//   --dry             print the run names and exit
//
// One headed Chrome window per run, sequential, nothing else may run on the machine. Each run writes one JSON file.
// Runs whose JSON exists are skipped, so an interrupted matrix resumes.
//
// The throttle number is part of every file name; a run on the reference device uses --throttle 1.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, runPage, save } from '../browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const dur = Number(opt('dur', 300));
const reps = Number(opt('reps', 3));
const throttleRate = Number(opt('throttle', 4));
const thread = opt('thread', 'main');
const warmup = Number(opt('warmup', 5));
const pushDur = Number(opt('push-dur', 60));
const checkDur = Number(opt('check-dur', 60));
const bar = Number(opt('bar', 4));
const methods = opt('methods', 'A,B,C,rapier').split(',');
const series = opt('series', 'main,push,check').split(',');
const only = new RegExp(opt('only', '.'));
const outDir = resolve(root, opt('out', 'results/run-2/data/stage8')); // relative to prototype/, or absolute
const browser = opt('browser', 'chrome');
const dry = flag('dry');
const timeoutScale = Number(opt('timeout-scale', 1)); // multiplies the per-run timeout

const ENEMIES = [2000, 5000, 10000];
const PROJ = [0, 1000, 5000];
// Push-past sweeps: projectiles at 2,000 enemies, enemies at 1,000 projectiles.
const PUSH_PROJ = [1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000];
const PUSH_ENEMIES = [2000, 3000, 5000, 7500, 10000, 15000, 20000];

const cpu = throttleRate > 1 ? `cpu${throttleRate}x` : 'cpu1x';
const evcap = (proj) => Math.max(32768, 2 ** Math.ceil(Math.log2(proj * 4)));

// One run: a spec is { series, method, enemies, proj, dur, rep, check, sweep }.
const nameOf = (s) => `${s.series}-${s.method}-e${s.enemies}-p${s.proj}${s.check ? (s.sweep ? '-chk' : '-chk-nosweep') : ''}-${cpu}-${s.dur}s${s.thread === 'worker' ? '-worker' : ''}-r${s.rep}`;
const fileOf = (s) => join(outDir, nameOf(s) + '.json');

function queryOf(s) {
  const q = new URLSearchParams({
    method: s.method, enemies: s.enemies, proj: s.proj, dur: s.dur, warmup, thread: s.thread,
    check: s.check ? 1 : 0, sweep: s.sweep ? 1 : 0, evcap: evcap(s.proj),
  });
  return `stage8.html?${q}`;
}

async function runOne(s) {
  const name = nameOf(s);
  const out = fileOf(s);
  if (existsSync(out)) {
    const prior = JSON.parse(readFileSync(out, 'utf8'));
    console.log('skip (exists)', name);
    return prior;
  }
  // A run with the reference check is slower than real time (every projectile is checked against everything),
  // and a throttled one more so; the sim counts ticks, not wall time, so it only takes longer.
  // Rapier at 10,000 enemies needs ~0.14 s per step unthrottled, so a 300 s run (9,000 steps) is far slower than real time.
  const factor = s.method === 'rapier' ? 2 + (s.enemies / 1000) * (Math.max(1, throttleRate) / 2) : 1.5;
  const slow = (s.check ? Math.max(8, factor * 3) : factor) * timeoutScale;
  let r;
  try {
    r = await runPage(browser, queryOf(s), { throttleRate, timeoutMs: (s.dur + warmup) * 1000 * slow * Math.max(1, throttleRate / 2) + 90000 });
  } catch (e) {
    console.log('FAILED', name, String(e).slice(0, 200));
    return null;
  }
  if (r.result.error) { console.log('FAILED', name, r.result.error); return null; }
  save(out, { name, ...s, ...r });
  const x = r.result;
  console.log(
    name, `step med ${x.stepMs.median.toFixed(3)} p99 ${x.stepMs.p99.toFixed(3)} max ${x.stepMs.max.toFixed(2)} | live ${x.liveProjectiles.mean.toFixed(0)} | ev/step ${x.events.total.mean.toFixed(0)} drop ${x.droppedEvents.total}`,
    `| pass-through ${x.passThroughs.total}/${x.passThroughs.checked} | deaths/s ${x.deaths.perSecond.toFixed(0)} | mem ${(x.wasmMemory.start / 1048576).toFixed(1)}->${(x.wasmMemory.end / 1048576).toFixed(1)} MB | late p99 ${x.lateMs.p99.toFixed(1)} | hidden ${x.hidden} iso ${x.crossOriginIsolated}`,
    r.errors.filter((e) => !/404/.test(e)).join(';'),
  );
  return r;
}

const base = (extra) => ({ thread, check: false, sweep: true, rep: 1, ...extra });
const todo = [];

if (series.includes('main')) {
  // Repetition-major, so slow drift of the machine is spread over all configurations.
  for (let rep = 1; rep <= reps; rep++)
    for (const enemies of ENEMIES) for (const proj of PROJ) for (const method of methods)
      todo.push(base({ series: 'main', method, enemies, proj, dur, rep }));
}
if (series.includes('check')) {
  for (const method of methods) {
    todo.push(base({ series: 'check', method, enemies: 2000, proj: 1000, dur: checkDur, check: true, sweep: true }));
    todo.push(base({ series: 'check', method, enemies: 5000, proj: 1000, dur: checkDur, check: true, sweep: true }));
    todo.push(base({ series: 'check', method, enemies: 2000, proj: 1000, dur: Math.min(20, checkDur), check: true, sweep: false }));
  }
}

console.log(`stage 8 driver: ${cpu}, thread ${thread}, dur ${dur}s x ${reps}, ${BASE}, out ${outDir}`);
if (dry) {
  for (const s of todo) if (only.test(nameOf(s))) console.log(nameOf(s));
  if (series.includes('push')) console.log('(push-past runs are chosen while running)');
  process.exit(0);
}
for (const s of todo) if (only.test(nameOf(s))) await runOne(s);

// Push-past: sweep one axis up until the 99th percentile passes the bar, then one more point.
if (series.includes('push')) {
  for (const method of methods) {
    for (const [axis, values] of [['proj', PUSH_PROJ], ['enemies', PUSH_ENEMIES]]) {
      let crossed = false;
      for (const v of values) {
        const s = base({ series: 'push', method, enemies: axis === 'enemies' ? v : 2000, proj: axis === 'proj' ? v : 1000, dur: pushDur });
        if (!only.test(nameOf(s))) continue;
        const r = await runOne(s);
        if (!r) continue;
        const p99 = r.result.stepMs.p99;
        if (crossed && !flag('push-full')) break;
        if (p99 > bar) crossed = true;
      }
    }
  }
}
console.log('done');
