// Prints the Stage 9 results as markdown tables from results/run-2/data/stage9/*.json.
//   node scripts/run2/stage9-table.mjs [dir]
// Repeats of one configuration (name ending in -rN) are combined: each cell shows the median of the repeats and, in
// brackets, the min to max across repeats. Compare two configurations only when their difference is larger than that spread.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const dir = process.argv[2] ?? 'results/run-2/data/stage9/';
const all = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'crash.json').map((f) => ({ file: f, ...JSON.parse(readFileSync(dir + '/' + f, 'utf8')) }))
  .filter((r) => r.result && typeof r.result === 'object');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
// "median [min–max]" over the repeats, or just the value for one run.
const cell = (vals, d = 2) => { const v = vals.filter((x) => x != null && Number.isFinite(x)); if (!v.length) return '–'; return v.length === 1 ? f(v[0], d) : `${f(med(v), d)} [${f(Math.min(...v), d)}–${f(Math.max(...v), d)}]`; };
const base = (r) => (r.name ?? r.file.replace('.json', '')).replace(/-r\d+(-\d+s)?$/, '');
const groups = new Map();
for (const r of all) { const k = base(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
const x = (rs, fn, d) => cell(rs.map((r) => fn(r.result)), d);
const GROUPS = ['cull', 'shadowMap', 'grass', 'world', 'outlines', 'particles', 'effects', 'bloom', 'upscale', 'ui'];

const main = [...groups.entries()].filter(([k]) => k.startsWith('main-')).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
const cfg = (r) => r.result.config;
if (main.length) {
  console.log(`Throttle: ${[...new Set(all.map((r) => r.throttleRate))].join(', ')}x CPU (the page only: Chrome cannot throttle the stream worker, and the GPU is not slowed). Chrome ${all[0].version}. Runs of ${[...new Set(all.map((r) => r.result.config.dur))].join('/')} s.\n`);
  console.log('| Particles | Internal | Outline | Shadow | Reps | GPU total median (ms) | GPU total p99 (ms) | Encode+submit median (ms) | Encode+submit p99 (ms) | Frame median (ms) | Frame p99 (ms) | Draw calls | Alive particles (median) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [, rs] of main) {
    const c = cfg(rs[0]);
    console.log(`| ${c.particles} | ${c.ires}p | ${c.outline} | ${c.shadow} | ${rs.length} | ${x(rs, (r) => r.gpuTotalMs?.median)} | ${x(rs, (r) => r.gpuTotalMs?.p99)} | ${x(rs, (r) => r.encodeMs.median)} | ${x(rs, (r) => r.encodeMs.p99)} | ${x(rs, (r) => r.frameMs.median)} | ${x(rs, (r) => r.frameMs.p99)} | ${rs[0].result.drawCalls} | ${x(rs, (r) => r.particles.alive.median, 0)} |`);
  }
  console.log('\nGPU time per pass, median over frames (ms), median of repeats [min–max]:\n');
  console.log(`| Particles | Internal | Outline | Shadow | ${GROUPS.join(' | ')} |`);
  console.log(`|---|---|---|---|${GROUPS.map(() => '---').join('|')}|`);
  for (const [, rs] of main) {
    const c = cfg(rs[0]);
    console.log(`| ${c.particles} | ${c.ires}p | ${c.outline} | ${c.shadow} | ${GROUPS.map((g) => x(rs, (r) => r.gpuGroupsMs?.[g]?.median)).join(' | ')} |`);
  }
  console.log('\nGPU time per pass, 99th percentile (ms):\n');
  console.log(`| Particles | Internal | Outline | Shadow | ${GROUPS.join(' | ')} |`);
  console.log(`|---|---|---|---|${GROUPS.map(() => '---').join('|')}|`);
  for (const [, rs] of main) {
    const c = cfg(rs[0]);
    console.log(`| ${c.particles} | ${c.ires}p | ${c.outline} | ${c.shadow} | ${GROUPS.map((g) => x(rs, (r) => r.gpuGroupsMs?.[g]?.p99)).join(' | ')} |`);
  }
}

const rest = [...groups.entries()].filter(([k]) => !k.startsWith('main-'));
const sweeps = rest.filter(([k]) => k.startsWith('sweep-'));
if (sweeps.length) {
  console.log('\nPush-past sweeps (one run each, full look otherwise):\n');
  console.log('| Run | Visible grass clumps | Visible instances | GPU total median / p99 (ms) | Encode median / p99 (ms) | Frame median / p99 (ms) | Frames > 20 ms | Alive particles |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [k, rs] of sweeps) {
    const r = rs[0].result;
    console.log(`| ${k.replace('sweep-', '')} | ${r.render?.grassClumps} | ${r.render?.visible} | ${f(r.gpuTotalMs?.median)} / ${f(r.gpuTotalMs?.p99)} | ${f(r.encodeMs.median)} / ${f(r.encodeMs.p99)} | ${f(r.frameMs.median)} / ${f(r.frameMs.p99)} | ${r.framesOver20ms} | ${f(r.particles.alive.median, 0)} |`);
  }
}
const od = rest.filter(([k]) => k.startsWith('overdraw-'));
if (od.length) {
  console.log('\nOverdraw (writes per pixel, scene passes only, internal resolution; mean and 99th percentile over the sampled frames):\n');
  console.log('| Run | Outline | Mean writes/pixel | p99 writes/pixel | Max writes/pixel | Samples |');
  console.log('|---|---|---|---|---|---|');
  for (const [k, rs] of od) { const o = rs[0].result.overdraw; console.log(`| ${k} | ${rs[0].result.config.outline} | ${f(o?.meanWritesPerPixel.median)} | ${f(o?.p99WritesPerPixel.median, 0)} | ${f(o?.maxWritesPerPixel.max, 0)} | ${o?.samples} |`); }
}
const dyn = rest.filter(([k]) => k.startsWith('dynres-'));
if (dyn.length) {
  console.log('\nDynamic resolution:\n');
  console.log('| Run | Budget (ms) | Changes | Changes per minute | Final internal height | GPU total median / p99 (ms) | Frame p99 (ms) | First changes (s: from to) |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [k, rs] of dyn) {
    const r = rs[0].result, ch = r.dynres.changes;
    console.log(`| ${k} | ${r.dynres.budgetMs} | ${ch.length} | ${f(ch.length / (r.config.dur / 60), 1)} | ${r.dynres.finalInternalHeight} | ${f(r.gpuTotalMs?.median)} / ${f(r.gpuTotalMs?.p99)} | ${f(r.frameMs.p99)} | ${ch.slice(0, 4).map((c) => `${c.t.toFixed(1)}: ${c.from}→${c.to}`).join(', ')} |`);
  }
}
if (existsSync(dir + '/crash.json')) {
  const c = JSON.parse(readFileSync(dir + '/crash.json', 'utf8'));
  console.log('\nGPU process crash:\n');
  console.log('| Crash | Lost | Recovered after (ms) | Look back (visible, grass, particles, shadow casters) |');
  console.log('|---|---|---|---|');
  for (const s of c.steps) console.log(`| ${s.k} | ${s.lost?.reason ?? 'no'} | ${s.recovered?.at && s.lost?.at ? Math.round(s.recovered.at - s.lost.at) : '–'} | ${s.lookBack} (${s.after.visible}, ${s.after.grassChunks}, ${s.after.alive}, ${s.after.shadowCasters}) |`);
}
