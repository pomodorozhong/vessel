// Stage 8 bench page. URL parameters (all optional):
//   method=A|B|C|rapier  enemies=2000  proj=1000  passes=3  dur=300 (s)  warmup=5 (s)  seed=1  spawn=64
//   check=0|1 (slow exact reference check)  sweep=1|0 (0 = debug, no sweeping)  thread=main|worker
//   hz=30  evcap=32768  projcap=0
// The run ends by setting window.__result.
import combatUrl from '../wasm/combat.wasm?url';
import rapierUrl from '../wasm/combat-rapier.wasm?url';
import { Stage8Runner } from './runner';
import type { Config } from './runner';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const method = (q.get('method') ?? 'A') as Config['method'];
const cfg: Config = {
  method,
  enemies: num('enemies', 2000),
  proj: num('proj', 1000),
  passes: num('passes', 3),
  dur: num('dur', 300),
  warmup: num('warmup', 5),
  seed: num('seed', 1),
  spawn: num('spawn', 64),
  check: num('check', 0) === 1,
  sweep: num('sweep', 1) === 1,
  hz: num('hz', 30),
  evcap: num('evcap', 32768),
  projcap: num('projcap', 0),
};
const thread = q.get('thread') ?? 'main';

const info = document.getElementById('info')!;
const progress = (tick: number, total: number) => {
  info.textContent = `stage 8  ${method}  ${cfg.enemies} enemies  ${cfg.proj} projectiles  ${thread}\nstep ${tick} / ${total}`;
};
progress(0, Math.round((cfg.warmup + cfg.dur) * cfg.hz));

function done(result: unknown) {
  const r = result as { stepMs: { median: number; p99: number; max: number } };
  info.textContent += `\ndone: median ${r.stepMs.median.toFixed(3)} ms  p99 ${r.stepMs.p99.toFixed(3)} ms  max ${r.stepMs.max.toFixed(2)} ms`;
  (window as any).__result = {
    ...(result as object),
    url: location.href,
    browser: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    hidden: document.hidden,
  };
}

try {
  const module = await WebAssembly.compileStreaming(fetch(method === 'rapier' ? rapierUrl : combatUrl));
  if (thread === 'worker') {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') progress(e.data.tick, e.data.total);
      if (e.data.type === 'result') {
        worker.terminate();
        done(e.data.result);
      }
    };
    worker.postMessage({ cfg, module });
  } else {
    const runner = await Stage8Runner.create(cfg, module, true);
    runner.onProgress = progress;
    runner.onResult = done;
    runner.start();
  }
} catch (err) {
  info.textContent += `\nerror: ${String(err)}`;
  (window as any).__result = { error: String(err), url: location.href };
}
