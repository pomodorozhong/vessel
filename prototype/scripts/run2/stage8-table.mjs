// Turns the Stage 8 JSON files into markdown tables: the median over the repetitions of each run,
// with the spread (min to max across the repetitions) next to it.
//
//   node scripts/run2/stage8-table.mjs [--dir results/run-2/data/stage8] [--bar 4] [--out file.md]
//
// Files are grouped by CPU throttle and duration (one section each), because those change the numbers.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const dir = resolve(root, opt('dir', 'results/run-2/data/stage8')); // relative to prototype/, or absolute
const bar = Number(opt('bar', 4));
const outFile = opt('out', '');

const runs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const lines = [];
const out = (s = '') => lines.push(s);

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f = (v, d = 2) => (v === undefined || v === null || Number.isNaN(v) ? '-' : v.toFixed(d));
// "median (min-max)" over the repetitions; just the number when there is one run.
const spread = (vals, d = 2) => (vals.length === 0 ? '-' : vals.length === 1 ? f(vals[0], d) : `${f(median(vals), d)} (${f(Math.min(...vals), d)}-${f(Math.max(...vals), d)})`);
const METHODS = ['A', 'B', 'C', 'rapier'];
const methodName = { A: 'A grid', B: 'B sweep', C: 'C grid+SIMD', rapier: 'Rapier 2D' };
const cpuName = (r) => (r.throttleRate > 1 ? `CPU throttled ${r.throttleRate}x` : 'CPU unthrottled');

const groups = new Map();
for (const r of runs) {
  const key = `${cpuName(r)}, ${r.thread === 'worker' ? 'sim in a worker' : 'sim on the main thread'}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const pick = (rs, pred) => rs.filter(pred);
const get = (rs, method, enemies, proj, fn) => rs.filter((r) => r.method === method && r.enemies === enemies && r.proj === proj).map((r) => fn(r.result));

for (const [key, all] of groups) {
  out(`## ${key}`);
  out();
  const main = pick(all, (r) => r.series === 'main');
  const durs = [...new Set(main.map((r) => r.dur))];
  if (main.length) {
    const enemiesList = [...new Set(main.map((r) => r.enemies))].sort((a, b) => a - b);
    const projList = [...new Set(main.map((r) => r.proj))].sort((a, b) => a - b);
    const reps = Math.max(...METHODS.flatMap((m) => enemiesList.flatMap((e) => projList.map((p) => get(main, m, e, p, () => 0).length))));
    out(`Main matrix: ${durs.join('/')} s runs, up to ${reps} repetition(s) per cell. Cells are median (min-max) over the repetitions. A difference counts only if it is larger than the spread.`);
    out();
    const metrics = [
      ['Step time, 99th percentile (ms)', (x) => x.stepMs.p99, 2],
      ['Step time, median (ms)', (x) => x.stepMs.median, 3],
      ['Step time, max (ms)', (x) => x.stepMs.max, 1],
      ['Step start late, 99th percentile (ms)', (x) => x.lateMs.p99, 1],
    ];
    for (const [title, fn, d] of metrics) {
      out(`### ${title}`);
      out();
      out(`| Enemies | Live projectiles | ${METHODS.map((m) => methodName[m]).join(' | ')} |`);
      out(`|---|---|${METHODS.map(() => '---').join('|')}|`);
      for (const e of enemiesList) for (const p of projList) {
        out(`| ${e} | ${p} | ${METHODS.map((m) => spread(get(main, m, e, p, fn), d)).join(' | ')} |`);
      }
      out();
    }

    out('### Share of the step per phase (median over repetitions of the mean ms; share of the mean step in brackets)');
    out();
    out('Phase slots: pair finding, exact checks, crowd pushing (A, B, C: per pass sum); projectiles include spawn, sweep, damage, deaths and respawns; Rapier puts its whole physics step into pair finding (exact checks and pushing are 0) and keeps obstacle collision and building updates inside it or in their own slots, see `combat-rapier/src/lib.rs`.');
    out();
    const ph = [['pairFinding', 'Pair finding'], ['exactChecks', 'Exact checks'], ['crowdPushing', 'Pushing'], ['projectiles', 'Projectiles'], ['areaEffects', 'Area effects'], ['flowField', 'Flow field'], ['ai', 'AI'], ['integrateSort', 'Integrate + sort'], ['snapshotWrite', 'Snapshot write'], ['obstacles', 'Obstacles'], ['buildingUpdates', 'Buildings']];
    out(`| Enemies | Proj | Method | ${ph.map((p) => p[1]).join(' | ')} | Step mean |`);
    out(`|---|---|---|${ph.map(() => '---').join('|')}|---|`);
    for (const e of enemiesList) for (const p of projList) for (const m of METHODS) {
      const rs = main.filter((r) => r.method === m && r.enemies === e && r.proj === p);
      if (!rs.length) continue;
      const cells = ph.map(([k]) => `${f(median(rs.map((r) => r.result.phases[k].mean)), 3)} (${f(median(rs.map((r) => r.result.phases[k].share)) * 100, 0)}%)`);
      out(`| ${e} | ${p} | ${methodName[m]} | ${cells.join(' | ')} | ${f(median(rs.map((r) => r.result.stepMs.mean)), 3)} |`);
    }
    out();

    out('### Live projectiles, events per step, deaths and snapshot size (method A; the other methods differ only through crowd motion)');
    out();
    out('Events are per step: mean / 99th percentile / max, the median over repetitions of each.');
    out();
    out(`| Enemies | Proj | Live proj mean (min-max) | Events total | shots | hits | deaths | explosions | pickups | walls (built+removed) | player hurt | Dropped events | Deaths/s | Snapshot mean / max KB | WASM memory MB start -> end |`);
    out(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const e of enemiesList) for (const p of projList) {
      const rs = main.filter((r) => r.method === 'A' && r.enemies === e && r.proj === p);
      if (!rs.length) continue;
      const ev = (k) => `${f(median(rs.map((r) => r.result.events[k].mean)), 1)} / ${f(median(rs.map((r) => r.result.events[k].p99)), 0)} / ${f(median(rs.map((r) => r.result.events[k].max)), 0)}`;
      const walls = `${f(median(rs.map((r) => r.result.events.wallBuilt.mean + r.result.events.wallRemoved.mean)), 2)}`;
      out(`| ${e} | ${p} | ${f(median(rs.map((r) => r.result.liveProjectiles.mean)), 0)} (${f(Math.min(...rs.map((r) => r.result.liveProjectiles.min)), 0)}-${f(Math.max(...rs.map((r) => r.result.liveProjectiles.max)), 0)}) | ${ev('total')} | ${ev('shot')} | ${ev('hit')} | ${ev('death')} | ${ev('explosion')} | ${ev('pickup')} | ${walls} | ${ev('playerHurt')} | ${rs.reduce((s, r) => s + r.result.droppedEvents.total, 0)} | ${f(median(rs.map((r) => r.result.deaths.perSecond)), 0)} | ${f(median(rs.map((r) => r.result.snapshotBytes.mean)) / 1024, 0)} / ${f(Math.max(...rs.map((r) => r.result.snapshotBytes.max)) / 1024, 0)} | ${f(rs[0].result.wasmMemory.start / 1048576, 1)} -> ${f(Math.max(...rs.map((r) => r.result.wasmMemory.end)) / 1048576, 1)} |`);
    }
    out();

    out('### Candidate pairs per step (A, B, C find the same pairs; the cost is in how they find them)');
    out();
    out(`| Enemies | Proj | Method | Pairs tested in the gather | Candidates (within margin) | Overlapping (first pass) |`);
    out(`|---|---|---|---|---|---|`);
    for (const e of enemiesList) {
      const p = projList.includes(1000) ? 1000 : projList[0];
      for (const m of ['A', 'B', 'C']) {
        const rs = main.filter((r) => r.method === m && r.enemies === e && r.proj === p);
        if (!rs.length) continue;
        out(`| ${e} | ${p} | ${methodName[m]} | ${f(median(rs.map((r) => r.result.pairs.tested)), 0)} | ${f(median(rs.map((r) => r.result.pairs.candidates)), 0)} | ${f(median(rs.map((r) => r.result.pairs.hit)), 0)} |`);
      }
    }
    out();
  }

  // Pass-through checks.
  const checks = pick(all, (r) => r.series === 'check');
  if (checks.length) {
    out('### Pass-through check (slow exact reference run alongside)');
    out();
    out('With sweeping on the count must be 0. With sweeping off (the calibration) it must be above 0, which shows the check can detect a pass-through.');
    out();
    out(`| Method | Enemies | Live proj | Sweeping | Projectile sweeps checked | Pass-throughs | False hits (fast path hit what the reference did not) | Grazes (Rapier only: disagreement within 5 mm of contact) | Steps |`);
    out(`|---|---|---|---|---|---|---|---|---|`);
    for (const r of checks.sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method) || a.enemies - b.enemies || b.sweep - a.sweep)) {
      const x = r.result;
      out(`| ${methodName[r.method]} | ${r.enemies} | ${r.proj} | ${r.sweep ? 'on' : 'off'} | ${x.passThroughs.checked} | ${x.passThroughs.total} | ${x.passThroughs.falseHits} | ${x.passThroughs.grazes ?? 0} | ${x.steps} |`);
    }
    out();
  }

  // Push-past sweeps.
  const push = pick(all, (r) => r.series === 'push');
  if (push.length) {
    out(`### Push past the pass bar (99th percentile of the step, ms; bar ${bar} ms; runs of ${[...new Set(push.map((r) => r.dur))].join('/')} s)`);
    out();
    for (const [axis, title, fixed] of [['proj', 'Live projectiles, at 2000 enemies', 'enemies'], ['enemies', 'Enemies, at 1000 live projectiles', 'proj']]) {
      const rs = push.filter((r) => (axis === 'proj' ? r.enemies === 2000 : r.proj === 1000));
      const values = [...new Set(rs.map((r) => r[axis]))].sort((a, b) => a - b);
      out(`**${title}**`);
      out();
      out(`| ${axis === 'proj' ? 'Live projectiles' : 'Enemies'} | ${METHODS.map((m) => methodName[m]).join(' | ')} |`);
      out(`|---|${METHODS.map(() => '---').join('|')}|`);
      for (const v of values) {
        out(`| ${v} | ${METHODS.map((m) => { const x = rs.find((r) => r.method === m && r[axis] === v); return x ? `${f(x.result.stepMs.p99, 2)}${x.result.stepMs.p99 > bar ? ' !' : ''}` : '-'; }).join(' | ')} |`);
      }
      out();
      const cross = METHODS.map((m) => {
        const over = rs.filter((r) => r.method === m && r.result.stepMs.p99 > bar).sort((a, b) => a[axis] - b[axis])[0];
        const under = rs.filter((r) => r.method === m && r.result.stepMs.p99 <= bar).sort((a, b) => b[axis] - a[axis])[0];
        return `${methodName[m]}: ${under ? `last under ${under[axis]}` : 'none under'}, ${over ? `first over ${over[axis]}` : 'none over'}`;
      });
      out(`Where the bar is crossed (!): ${cross.join('; ')}.`);
      out();
    }
  }
  out(`Browser: ${[...new Set(all.map((r) => r.version))].join(', ')}.`);
  out();
}

const text = lines.join('\n') + '\n';
if (outFile) writeFileSync(resolve(root, outFile), text);
else process.stdout.write(text);
