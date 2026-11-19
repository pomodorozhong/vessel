// Prints the Stage 1 results tables (markdown) from results/data/stage1/*.json.
import { readFileSync, readdirSync } from 'node:fs';
const dir = 'results/data/stage1/';
const rows = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.replace('.json', ''), ...JSON.parse(readFileSync(dir + f, 'utf8')) }));
const f = (v, d = 2) => v.toFixed(d), pc = (v) => (v * 100).toFixed(0) + '%';
const n = (r) => r.result.config.n;
const order = ['wasm-simd-worker', 'wasm-nosimd-worker', 'ts-worker', 'wasm-simd-main'];
const variant = (r) => r.name.replace(/-n\d+.*/, '');
rows.sort((a, b) => (a.throttleRate - b.throttleRate) || order.indexOf(variant(a)) - order.indexOf(variant(b)) || n(a) - n(b));
console.log('| Variant | CPU | Entities | Step median (ms) | Step p99 (ms) | Step max (ms) | Whole step incl. copy+post p99 (ms) | Collision | Flow field | AI | Snapshot write | Move+sort | Overlapping pairs/step | Step start late p99 (ms) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const s = r.result.sim, sh = s.share;
  console.log(`| ${variant(r)} | ${r.throttleRate > 1 ? `throttled ${r.throttleRate}x` : 'unthrottled'} | ${n(r)} | ${f(s.simMs.median, 3)} | ${f(s.simMs.p99, 3)} | ${f(s.simMs.max)} | ${f(s.hostMs.p99, 3)} | ${pc(sh.collision)} | ${pc(sh.flowField)} | ${pc(sh.ai)} | ${pc(sh.snapshotWrite)} | ${pc(sh.moveAndSort)} | ${f(s.pairsHitPerStep, 0)} | ${f(s.lateMs.p99, 1)} |`);
}
console.log('\n| Variant | CPU | Entities | Frame p99 (ms) | Frames over 20 ms | Main-thread CPU per frame p99 (ms) | Snapshot delivery median (ms) | Snapshot delivery p99 (ms) | Copy+post mean (ms) | Steps | Chrome |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const x = r.result, s = x.sim;
  console.log(`| ${variant(r)} | ${r.throttleRate > 1 ? `throttled ${r.throttleRate}x` : 'unthrottled'} | ${n(r)} | ${f(x.frameMs.p99)} | ${x.framesOver20ms} of ${x.frameMs.n} | ${f(x.mainCpuMs.p99)} | ${f(x.deliveryMs.median, 3)} | ${f(x.deliveryMs.p99, 3)} | ${f(s.meanMs.copyAndPost, 3)} | ${s.steps} | ${r.version.replace('Chrome/', '')} |`);
}
