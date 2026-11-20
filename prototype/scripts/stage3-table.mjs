// Prints the Stage 3 results as markdown tables from results/data/stage3/*.json.
import { readdirSync, readFileSync } from 'node:fs';
const dir = 'results/data/stage3/';
const all = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.replace('.json', ''), ...JSON.parse(readFileSync(dir + f, 'utf8')) })).filter((r) => typeof r.result === 'object');
const f = (v, d = 2) => (v == null ? '–' : v.toFixed(d));
const order = { gpu: 0, plain: 1, three: 2, threecull: 3 };
const key = (r) => [/cpu4x/.test(r.name) ? 1 : 0, r.result.config.n, order[r.name.split('-')[0]]];
const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const label = { gpu: 'GPU-driven', plain: 'plain', three: 'Three.js, statics uploaded once', threecull: 'Three.js, statics re-uploaded every frame (first version)' };

console.log('| Path | CPU | Entities | Main-thread CPU per frame median / p99 (ms) | Encode+submit median / p99 (ms) | GPU median / p99 (ms) | Draw calls | Visible instances (last frame) | Frame median / p99 (ms) | Frames > 20 ms | Frames > 34 ms | Pauses | Jumps | Sim step p99 (ms) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of all.filter((r) => !/-i\d+-c/.test(r.name)).sort(cmp)) {
  const x = r.result;
  console.log(`| ${label[r.name.split('-')[0]]} | ${r.throttleRate > 1 ? `throttled ${r.throttleRate}×` : 'unthrottled'} | ${x.config.n} | ${f(x.mainCpuMs.median)} / ${f(x.mainCpuMs.p99)} | ${f(x.encodeMs.median)} / ${f(x.encodeMs.p99)} | ${f(x.gpuMs?.median)} / ${f(x.gpuMs?.p99)} | ${x.render.drawCalls} | ${x.render.info?.visible ?? '–'} | ${f(x.frameMs.median)} / ${f(x.frameMs.p99)} | ${x.framesOver20ms ?? '–'} | ${x.framesOver34ms ?? '–'} | ${x.clock.pauses} | ${x.clock.jumps} | ${f(x.sim?.simMs?.p99)} |`);
}
console.log('\n| Internal resolution | Canvas | GPU total median / p99 (ms) | World pass mean (ms) | Upscale + grading + UI pass mean (ms) | Cull compute mean (ms) | Frame p99 (ms) |');
console.log('|---|---|---|---|---|---|---|');
for (const r of all.filter((r) => /-i\d+-c/.test(r.name) || r.name === 'gpu-n2000').sort((a, b) => a.name.localeCompare(b.name))) {
  const x = r.result, p = x.gpuParts ?? {}, c = x.config;
  console.log(`| ${c.ires || 1080}p | ${c.cw || 1920}×${c.ch || 1080} | ${f(x.gpuMs?.median)} / ${f(x.gpuMs?.p99)} | ${f(p.worldMs)} | ${f(p.upscaleAndUiMs)} | ${f(p.cullComputeMs)} | ${f(x.frameMs.p99)} |`);
}
