// Stage 1 measurement matrix. Usage: node scripts/stage1.mjs <dur seconds> <filter regex> [throttle]
// Each run is one headed Chrome window on the local preview build; results go to results/data/stage1/.
import { existsSync } from 'node:fs';
import { runPage, save } from './browser.mjs';

const dur = Number(process.argv[2] ?? 300);
const filter = new RegExp(process.argv[3] ?? '.');
const throttleRate = Number(process.argv[4] ?? 1);
const counts = [1000, 2000, 5000, 10000, 20000, 40000];
const variants = [
  { name: 'wasm-simd-worker', q: 'sim=wasm-simd&thread=worker' },
  { name: 'wasm-nosimd-worker', q: 'sim=wasm-nosimd&thread=worker' },
  { name: 'ts-worker', q: 'sim=ts&thread=worker' },
  { name: 'wasm-simd-main', q: 'sim=wasm-simd&thread=main' },
];
for (const n of counts) {
  for (const v of variants) {
    const name = `${v.name}-n${n}${throttleRate > 1 ? `-cpu${throttleRate}x` : ''}${dur !== 300 ? `-${dur}s` : ''}`;
    if (!filter.test(name)) continue;
    const out = `results/data/stage1/${name}.json`;
    if (existsSync(out) && !process.env.FORCE) { console.log('skip (exists)', name); continue; }
    const r = await runPage('chrome', `?bench=stage1&${v.q}&n=${n}&dur=${dur}`, { throttleRate, timeoutMs: (dur + 60) * 1000 });
    save(out, r);
    const s = r.result.sim;
    console.log(name, `sim med ${s.simMs.median.toFixed(3)} p99 ${s.simMs.p99.toFixed(3)} max ${s.simMs.max.toFixed(2)} | host med ${s.hostMs.median.toFixed(3)} p99 ${s.hostMs.p99.toFixed(3)} | late p99 ${s.lateMs.p99.toFixed(2)} | pairs ${s.pairsHitPerStep.toFixed(0)}/${s.pairsTestedPerStep.toFixed(0)} | chk ${s.checksum?.toFixed(1)} | frame p99 ${r.result.frameMs.p99.toFixed(2)} >20ms ${r.result.framesOver20ms} | delivery med ${r.result.deliveryMs.median.toFixed(3)} p99 ${r.result.deliveryMs.p99.toFixed(3)} | skipped ${s.skipped} hidden ${r.result.hidden} iso ${r.result.isolated}`, r.errors.filter((e) => !/404/.test(e)).join(';'));
  }
}
