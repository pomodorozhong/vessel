// Prints the Stage 2 results as markdown tables from results/data/stage2/*.json.
import { readdirSync, readFileSync } from 'node:fs';
const dir = 'results/data/stage2/';
const rows = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.replace('.json', ''), ...JSON.parse(readFileSync(dir + f, 'utf8')) }));
const f = (v, d = 1) => (v == null ? '–' : v.toFixed(d));
console.log('| Run | Design | Lag (steps) | Frame rate | Added delay (ms) | Pool / queue | Pauses/min | Jumps/min | Clock error rms (ms) | Max queue | Max buffers held by main | Dropped by main | Skipped by worker | Input→screen median / p99 / max (ms) | Key presses | Frame p99 (ms) | Seconds |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const x = r.result, c = x.clock, g = x.config, l = x.inputLatencyMs;
  console.log(`| ${r.name} | ${g.design} | ${g.design === 'A' ? g.lag : '–'} | ${g.cap || 60} | 0–${g.delay}${g.stall ? `, stall ${g.stall} every 10 s` : ''} | ${g.pool} / ${g.maxq} | ${f(c.pausesPerMin)} | ${f(c.jumpsPerMin)} | ${f(c.rmsErrMs, 2)} | ${c.maxQueue} | ${c.maxOutstanding} | ${c.droppedByMain} | ${x.workerSkipped} | ${f(l.median)} / ${f(l.p99)} / ${f(l.max)} | ${l.n} | ${f(x.frameMs.p99)} | ${g.dur} |`);
}
console.log('\nStall recovery (ms from the end of each stall to the last pause or jump before the next stall):');
for (const r of rows.filter((r) => r.result.config.stall)) console.log(`- ${r.name}: ${r.result.stallRecoveryMs.map((v) => Math.round(v)).join(', ')}`);
