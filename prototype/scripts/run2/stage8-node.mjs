// Stage 8 vs Stage 11 sim cost in Node: steps the built combat.wasm with the same init arguments, scripted player and
// wave script as the browser drivers, and times every step() call. No browser, no worker, no page: only the sim's work.
//
//   node scripts/run2/stage8-node.mjs [options]      run from prototype/ (needs src/wasm/combat.wasm: scripts/build-combat.mjs)
//
// Options (all optional):
//   --reps <n>      repetitions of each case (default 3); the cases are interleaved within each repetition
//   --only <regex>  run only cases whose name matches
//   --paced         sleep between steps to a 30 Hz schedule, as the browser drivers do (default: full speed, back to back)
//   --out <dir>     output folder (default results/run-2/data/stage8-node)
//
// Cases:
//   s8-A-e5000-p1000     Stage 8 style (src/stage8/runner.ts): 5,000 enemies placed at init, 1,000 projectiles, method A,
//                        5 s warm-up, 60 s recorded (the window of push-A-e5000-p1000-cpu1x-60s-worker-r1)
//   s11-wave-cap20000    Stage 11 wave (src/stage11/sim-worker.ts): 300 -> 5,000 enemies over 240 s, then 60 s held, sim
//                        allocated for 20,000; stats over the 60 s hold (and, separately, the whole wave after the warm-up)
//   s11-wave-cap5000     the same wave with the sim allocated for 5,000
//   s8-{A,B,C}-e2000-p1000  Stage 8 pass load, 5 s warm-up, 300 s recorded (the window of the main-matrix worker runs)
//
// Two step times are recorded per step: `wall`, performance.now() around step() as the drivers' JS sees it (Stage 11's
// sim step), and `inner`, the sim's own timer in the snapshot header (f32[18], Stage 8's step). Percentiles are taken
// from a numerically sorted Float64Array, index floor(n x p) as in the drivers.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const reps = Number(opt('reps', 3));
const only = new RegExp(opt('only', '.'));
const paced = flag('paced');
const outDir = resolve(root, opt('out', 'results/run-2/data/stage8-node'));
const HZ = 30, WARMUP = 5, SEED = 1, SPAWN = 64, EVCAP = 32768, PASSES = 3;
const METHOD = { A: 0, B: 1, C: 2 };

const wasm = readFileSync(join(root, 'src', 'wasm', 'combat.wasm'));
const module = await WebAssembly.compile(wasm);

const pct = (s, p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
function summ(a) {
  const s = Float64Array.from(a).sort(); // typed-array sort is numeric
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i];
  return { n: s.length, mean: sum / Math.max(1, s.length), median: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: s[s.length - 1] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function instance() {
  const inst = await WebAssembly.instantiate(module, { env: { now: () => performance.now() } });
  return inst.exports;
}

// The sim's own step time: f32[18] of the snapshot header (src/stage8/runner.ts, PHASES[0]).
function innerReader(ex) {
  let buf = null, f32 = null;
  const ptr = ex.snapshot_ptr();
  return () => {
    if (ex.memory.buffer !== buf) { buf = ex.memory.buffer; f32 = new Float32Array(buf, ptr, 32); }
    return f32[18];
  };
}

// Steps `total` times; before(tick) sets the load for that step; record(tick) says whether to keep it and in which sets.
async function drive(ex, total, before, sets) {
  const inner = innerReader(ex);
  const rec = Object.fromEntries(Object.keys(sets).map((k) => [k, { wall: [], inner: [] }]));
  const period = 1000 / HZ;
  let next = performance.now();
  for (let tick = 0; tick < total; tick++) {
    if (paced) { const w = next - performance.now(); if (w > 0) await sleep(w); next += period; }
    before?.(tick);
    // Scripted player: walks a circle (both drivers' script).
    const a = tick * ((Math.PI * 2) / (HZ * 40));
    const t0 = performance.now();
    ex.step(Math.cos(a), Math.sin(a), 0);
    const t1 = performance.now();
    for (const [k, keep] of Object.entries(sets)) if (keep(tick)) { rec[k].wall.push(t1 - t0); rec[k].inner.push(inner()); }
  }
  return Object.fromEntries(Object.entries(rec).map(([k, r]) => [k, { wall: summ(r.wall), inner: summ(r.inner) }]));
}

// Stage 8 (src/stage8/runner.ts): init(method, enemies, seed, spawn, proj, max(proj, 1000), evcap, passes, flags=0 sweep on).
// Recorded steps are ticks recStart+1 .. recEnd after the increment, i.e. step indices recStart .. recEnd-1.
async function stage8(method, enemies, proj, dur) {
  const ex = await instance();
  ex.init(METHOD[method], enemies, SEED, SPAWN, proj, Math.max(proj, 1000), EVCAP, PASSES, 0);
  const recStart = WARMUP * HZ, recEnd = recStart + dur * HZ;
  return drive(ex, recEnd, null, { window: (i) => i >= recStart && i < recEnd });
}

// Stage 11 (src/stage11/sim-worker.ts): init(method, cap, seed, 64, 200, projCap, 32768, passes, 0), set_enemies(start),
// then set_enemies / set_target before every step from the wave script. Wave time t = tick / hz - warmup.
async function stage11(cap) {
  const c = { start: 300, peak: 5000, ramp: 240, dur: 300, ppe: 0.2 };
  const ex = await instance();
  const projCap = Math.max(1000, Math.ceil(cap * c.ppe));
  ex.init(0, cap, SEED, 64, 200, projCap, EVCAP, PASSES, 0);
  ex.set_enemies(c.start);
  const waveT = (tick) => tick / HZ - WARMUP;
  const enemiesAt = (t) => (t <= 0 ? c.start : t < c.ramp ? Math.round(c.start + (c.peak - c.start) * (t / c.ramp)) : c.peak);
  const total = (WARMUP + c.dur) * HZ;
  return drive(ex, total, (tick) => {
    const e = enemiesAt(waveT(tick));
    ex.set_enemies(e);
    ex.set_target(Math.max(200, Math.round(e * c.ppe)));
  }, {
    hold: (i) => waveT(i) >= c.ramp,      // the last 60 s, at 5,000
    wave: (i) => i >= WARMUP * HZ,       // the whole bench after the warm-up, as Stage 11's sim step p99
  });
}

const cases = [
  { name: 's8-A-e5000-p1000', run: () => stage8('A', 5000, 1000, 60), main: 'window' },
  { name: 's11-wave-cap20000', run: () => stage11(20000), main: 'hold' },
  { name: 's11-wave-cap5000', run: () => stage11(5000), main: 'hold' },
  { name: 's8-A-e2000-p1000', run: () => stage8('A', 2000, 1000, 300), main: 'window' },
  { name: 's8-B-e2000-p1000', run: () => stage8('B', 2000, 1000, 300), main: 'window' },
  { name: 's8-C-e2000-p1000', run: () => stage8('C', 2000, 1000, 300), main: 'window' },
].filter((c) => only.test(c.name));

let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); } catch { /* not a repo */ }
const machine = { cpu: cpus()[0].model.trim(), logicalCpus: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), platform: process.platform, node: process.version };

const runs = [];
for (let r = 1; r <= reps; r++) {
  for (const c of cases) {
    const t = performance.now();
    const res = await c.run();
    runs.push({ case: c.name, rep: r, seconds: (performance.now() - t) / 1000, ...res });
    const m = res[c.main].wall;
    console.error(`${c.name} r${r}: wall median ${m.median.toFixed(3)} p99 ${m.p99.toFixed(3)} ms (${((performance.now() - t) / 1000).toFixed(1)} s)`);
  }
}

// Table: per case, median over the repetitions with min-max, of the main window's wall and inner step times.
const f = (x) => x.toFixed(2);
const cell = (vals) => { const s = [...vals].sort((a, b) => a - b); return `${f(s[Math.floor(s.length / 2)])} (${f(s[0])}–${f(s[s.length - 1])})`; };
const lines = [
  `Node ${machine.node}, ${machine.cpu} (${machine.logicalCpus} logical CPUs), commit ${commit}, ${paced ? 'paced to 30 Hz' : 'full speed, no 30 Hz pacing'}, ${reps} reps; median (min–max) over reps, ms`,
  '',
  '| Case | Window | Timer | Median | p95 | p99 | Max |',
  '|---|---|---|---|---|---|---|',
];
for (const c of cases) {
  const rs = runs.filter((x) => x.case === c.name);
  for (const win of Object.keys(rs[0])) {
    if (['case', 'rep', 'seconds'].includes(win)) continue;
    for (const timer of ['wall', 'inner']) {
      const g = (k) => cell(rs.map((x) => x[win][timer][k]));
      lines.push(`| ${c.name} | ${win} (${rs[0][win][timer].n} steps) | ${timer} | ${g('median')} | ${g('p95')} | ${g('p99')} | ${g('max')} |`);
    }
  }
}
const table = lines.join('\n');
console.log(table);

mkdirSync(outDir, { recursive: true });
const stamp = paced ? 'paced' : 'full';
writeFileSync(join(outDir, `stage8-node-${stamp}.json`), JSON.stringify({ commit, machine, paced, reps, hz: HZ, warmup: WARMUP, runs }, null, 1));
writeFileSync(join(outDir, `stage8-node-${stamp}.md`), table + '\n');
console.error(`wrote ${join(outDir, `stage8-node-${stamp}.json`)}`);
