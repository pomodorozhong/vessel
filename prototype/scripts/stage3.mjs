// Stage 3 measurement matrix. Usage: node scripts/stage3.mjs <dur seconds> <filter regex>
// One headed Chrome window per run on the local preview build; results go to results/data/stage3/.
import { existsSync } from 'node:fs';
import { runPage, save } from './browser.mjs';

const dur = Number(process.argv[2] ?? 300);
const filter = new RegExp(process.argv[3] ?? '.');
const page = { gpu: '?render=gpu&', plain: '?render=plain&', three: 'three.html?' };
const runs = [];
for (const n of [1000, 2000, 5000, 10000, 20000]) for (const r of ['gpu', 'plain', 'three']) runs.push({ name: `${r}-n${n}`, r, q: `n=${n}` });
// Resolution: internal 720p and 1080p, upscaled to a 1440p and a 4K canvas.
for (const ires of [720, 1080]) for (const [cw, ch] of [[2560, 1440], [3840, 2160]]) runs.push({ name: `gpu-n2000-i${ires}-c${ch}`, r: 'gpu', q: `n=2000&ires=${ires}&cw=${cw}&ch=${ch}` });
runs.push({ name: 'gpu-n2000-i720-c1080', r: 'gpu', q: 'n=2000&ires=720' });
// CPU throttled 4x (page only; Chrome cannot throttle the sim worker).
for (const r of ['gpu', 'plain', 'three']) for (const n of [2000, 10000]) runs.push({ name: `${r}-n${n}-cpu4x`, r, q: `n=${n}`, throttleRate: 4 });

for (const run of runs) {
  const name = `${run.name}${dur !== 300 ? `-${dur}s` : ''}`;
  if (!filter.test(name)) continue;
  const out = `results/data/stage3/${name}.json`;
  if (existsSync(out) && !process.env.FORCE) { console.log('skip (exists)', name); continue; }
  let r;
  try { r = await runPage('chrome', `${page[run.r]}bench=stage3&spawn=40&${run.q}&dur=${dur}`, { throttleRate: run.throttleRate ?? 1, timeoutMs: (dur + 90) * 1000, expr: 'window.__result ?? window.__error ?? null' }); }
  catch (e) { console.log('FAILED', name, String(e).slice(0, 200)); continue; }
  save(out, r);
  const x = r.result;
  if (typeof x === 'string') { console.log('ERROR', name, x); continue; }
  const g = x.gpuMs, p = x.gpuParts;
  console.log(name, `cpu med ${x.mainCpuMs.median.toFixed(2)} p99 ${x.mainCpuMs.p99.toFixed(2)} | encode med ${x.encodeMs.median.toFixed(2)} p99 ${x.encodeMs.p99.toFixed(2)} | gpu med ${g ? g.median.toFixed(2) : '-'} p99 ${g ? g.p99.toFixed(2) : '-'} ${p ? `(world ${p.worldMs.toFixed(2)} post ${p.upscaleAndUiMs.toFixed(2)} cull ${p.cullComputeMs.toFixed(2)})` : ''} | frame med ${x.frameMs.median.toFixed(2)} p99 ${x.frameMs.p99.toFixed(2)} >20 ${x.framesOver20ms} >34 ${x.framesOver34ms} | draws ${x.render.drawCalls} visible ${x.render.info?.visible} | pauses ${x.clock.pauses} jumps ${x.clock.jumps} | sim p99 ${x.sim.simMs.p99.toFixed(2)}`, r.errors.filter((e) => !/404/.test(e)).slice(0, 2).join(';'));
}
