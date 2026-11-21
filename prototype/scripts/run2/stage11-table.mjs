// Prints the Stage 11 results as markdown tables from <dir>/*.json (default results/run-2/data/stage11/).
// The wave runs (wave-r1..) are summarized as median over the repetitions with the min-max spread in brackets; the other runs
// (wave-cpu1, crash, heap, past) are shown one by one. The ramp tables list every 5 s window of one run.
// node scripts/run2/stage11-table.mjs [dir]
import { readdirSync, readFileSync } from 'node:fs';

const dir = (process.argv[2] ?? 'results/run-2/data/stage11/').replace(/\/?$/, '/');
const runs = new Map();
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) { const r = JSON.parse(readFileSync(dir + f, 'utf8')); runs.set(r.name, r); }
const get = (r, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), r.result);
const med = (a) => { const s = a.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const cell = (rs, path, d = 2) => {
  const v = rs.map((r) => get(r, path)).filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return '–';
  const m = med(v), lo = Math.min(...v), hi = Math.max(...v);
  return rs.length > 1 ? `${m.toFixed(d)} [${lo.toFixed(d)}–${hi.toFixed(d)}]` : m.toFixed(d);
};
const waves = [...runs.keys()].filter((n) => /^wave-r\d+$/.test(n)).sort().map((n) => runs.get(n));
const groups = [];
if (waves.length) groups.push(['wave (x' + waves[0].throttleRate + ')', waves]);
for (const n of ['wave-cpu1', 'crash', 'heap', 'past']) if (runs.has(n)) groups.push([n + ' (x' + runs.get(n).throttleRate + ')', [runs.get(n)]]);

const cols = [
  ['Frame p99 (ms)', 'frames.frameMs.p99', 2], ['Frames >20 ms', 'frames.framesOver20ms', 0], ['Pauses', 'clock.pauses', 0], ['Jumps', 'clock.jumps', 0],
  ['Sim step median', 'sim.stepMs.median', 2], ['Sim step p99', 'sim.stepMs.p99', 2], ['Encode p99', 'mainThread.encode.p99', 2], ['GPU median', 'gpuMs.median', 2], ['GPU p99', 'gpuMs.p99', 2],
  ['Audio late renders', 'audio.glitches.detectorLate', 0], ['Underruns', 'audio.glitches.playbackUnderrunEvents', 0], ['Input to submit median', 'inputToSubmitMs.median', 1], ['p99', 'inputToSubmitMs.p99', 1],
];
console.log('Pass bars per run (ms unless said; sim step is measured in the worker, which Chrome cannot throttle)\n');
console.log('| Run | Reps | ' + cols.map((c) => c[0]).join(' | ') + ' |');
console.log('|' + '---|'.repeat(cols.length + 2));
for (const [name, rs] of groups) console.log(`| ${name} | ${rs.length} | ` + cols.map(([, p, d]) => cell(rs, p, d)).join(' | ') + ' |');

const split = ['total', 'snapshotReceive', 'snapshotUpload', 'encode', 'audio', 'ui', 'other'];
console.log('\nMain thread per frame, median / p99 (ms; snapshotReceive is the message handling between frames, outside total)\n');
console.log('| Run | ' + split.join(' | ') + ' |');
console.log('|' + '---|'.repeat(split.length + 1));
for (const [name, rs] of groups) console.log(`| ${name} | ` + split.map((k) => `${cell(rs, `mainThread.${k}.median`, 2)} / ${cell(rs, `mainThread.${k}.p99`, 2)}`).join(' | ') + ' |');

const hand = [
  ['Snapshot KB mean', (r) => r.result.sim.snapshotBytes.mean / 1024, 1], ['Snapshot KB max', (r) => r.result.sim.snapshotBytes.max / 1024, 1],
  ['Copy ms p99', (r) => r.result.sim.copyMs.p99, 3], ['postMessage ms p99', (r) => r.result.sim.postMs.p99, 3], ['Transit median', (r) => r.result.handoff.transitMs.median, 2], ['Transit p99', (r) => r.result.handoff.transitMs.p99, 2],
  ['Wake late p99', (r) => r.result.sim.lateMs.p99, 2], ['Catch-up steps', (r) => r.result.sim.catchupSteps, 0], ['Dropped steps', (r) => r.result.sim.droppedSteps, 0],
  ['Enemies max', (r) => r.result.sim.enemies.max, 0], ['Projectiles max', (r) => r.result.sim.projectiles.max, 0], ['Events/step mean', (r) => r.result.sim.events.mean, 0], ['World msgs', (r) => r.result.handoff.worldMessages, 0],
];
const fcell = (rs, f, d) => { const v = rs.map((r) => { try { return f(r); } catch { return null; } }).filter((x) => x != null && Number.isFinite(x)); if (!v.length) return '–'; const m = med(v); return rs.length > 1 ? `${m.toFixed(d)} [${Math.min(...v).toFixed(d)}–${Math.max(...v).toFixed(d)}]` : m.toFixed(d); };
console.log('\nSnapshot hand-off and sim scheduling\n');
console.log('| Run | ' + hand.map((c) => c[0]).join(' | ') + ' |');
console.log('|' + '---|'.repeat(hand.length + 1));
for (const [name, rs] of groups) console.log(`| ${name} | ` + hand.map(([, f, d]) => fcell(rs, f, d)).join(' | ') + ' |');

const mem = [
  ['Heap first min (MB)', (r) => r.result.memory.heapFirstMinMedianMB, 1], ['Heap last min (MB)', (r) => r.result.memory.heapLastMinMedianMB, 1], ['Heap max (MB)', (r) => r.result.memory.heapMaxMB, 1],
  ['Slope (MB/min)', (r) => r.result.memory.heapSlopeMBPerMin, 3], ['WASM memory end (MB)', (r) => r.result.sim.wasmMemory.end / 1048576, 1],
];
console.log('\nMemory over the run (JS heap of the page, sampled once a second; the first and last minute medians ignore the GC sawtooth)\n');
console.log('| Run | ' + mem.map((c) => c[0]).join(' | ') + ' |');
console.log('|' + '---|'.repeat(mem.length + 1));
for (const [name, rs] of groups) console.log(`| ${name} | ` + mem.map(([, f, d]) => fcell(rs, f, d)).join(' | ') + ' |');

const heap = runs.get('heap')?.heap;
if (heap) {
  console.log(`\nAllocations at the peak (heap run, ${heap.seconds.toFixed(0)} s of sampling; V8 sampling heap profiler, attributed by script URL; typed array backing stores and GPU objects are not visible)\n`);
  console.log('| Target | Game B/s | Harness B/s | Browser/internal B/s | Top game allocators (bytes sampled) |');
  console.log('|---|---|---|---|---|');
  for (const [t, s] of Object.entries(heap.sessions)) console.log(`| ${t} | ${s.bytesPerSecond.game.toFixed(0)} | ${s.bytesPerSecond.harness.toFixed(0)} | ${s.bytesPerSecond.internal.toFixed(0)} | ${s.top.game.slice(0, 4).map(([k, v]) => `${k.replace(/\|/g, '/')} ${(v / 1e6).toFixed(1)} MB`).join('; ')} |`);
}

const crash = runs.get('crash');
if (crash?.crash) {
  const c = crash.crash, lost = c.lost, rec = c.recovered;
  console.log('\nGPU process crash\n');
  console.log(`- Crashed ${c.at.toFixed(1)} s into the bench at ${c.before?.enemies} enemies; device lost: ${lost ? `"${lost.message}"` : 'not reported'}${c.error ? ` (crash error: ${c.error})` : ''}.`);
  if (lost && rec) console.log(`- Look back after ${(rec.at - lost.at).toFixed(0)} ms (attempt ${rec.attempt}); ${rec.snapshotsDuringOutage} snapshots arrived during the outage; rebuilds ${crash.result.rebuilds}.`);
  if (c.after) console.log(`- 20 s later: enemies ${c.after.enemies}, snapshots ${c.after.snapshots} (from ${c.before?.snapshots}), audio late renders ${c.after.late} (from ${c.before?.late}), pauses ${c.after.pauses}, jumps ${c.after.jumps}, hasGpu ${c.after.hasGpu}.`);
}

for (const n of ['wave-r1', 'past']) {
  const r = runs.get(n); if (!r) continue;
  const fb = r.result.firstBreak;
  console.log(`\nRamp of ${n} (5 s windows; bars sim ${fb.bars.simP99}, encode ${fb.bars.encodeP99}, GPU ${fb.bars.gpuP99} ms p99). First break: ${fb.order.map((o) => `${o.budget} at ${o.at} s (${o.enemies} enemies)`).join(', ') || 'none'}\n`);
  console.log('| t (s) | Enemies | Projectiles | Events/step | Sim p99 | Encode p99 | CPU p99 | GPU p99 | Frame p99 | Pause/jump frames | Audio late |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of r.result.windows) console.log(`| ${w.t} | ${w.enemies} | ${w.projectiles} | ${w.events.toFixed(0)} | ${w.simP99.toFixed(2)} | ${w.encodeP99.toFixed(2)} | ${w.cpuP99.toFixed(2)} | ${w.gpuP99.toFixed(2)} | ${w.frameP99.toFixed(1)} | ${w.pausesJumps} | ${w.audioLate} |`);
}
