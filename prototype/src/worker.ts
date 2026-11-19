
// Sim worker: steps the sim on a fixed timestep and sends each snapshot to the main thread as a transferable.
import { SimHost, createWasmBackend } from './simhost';
import type { FromWorker, ToWorker } from './protocol';
import { wallNow } from './protocol';

const scope = self as unknown as { postMessage(m: unknown, t: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

let host: SimHost | null = null;
const pool: ArrayBuffer[] = [];
let period = 1000 / 30;
let next = 0;
let delayMs = 0;
let running = false;
let lastSkipped = 0;

function loop() {
  if (!running || !host) return;
  let now = performance.now();
  if (now - next > period * 4) next = now; // fell far behind (a stall): drop the lost time, never spiral
  if (now >= next) {
    const due = performance.timeOrigin + next;
    next += period;
    const buf = pool.pop() ?? null;
    host.step(buf, due);
    if (buf) {
      if (delayMs > 0) setTimeout(() => post({ type: 'snapshot', buffer: buf }, [buf]), Math.random() * delayMs);
      else post({ type: 'snapshot', buffer: buf }, [buf]);
    }
    if (host.skipped !== lastSkipped) { lastSkipped = host.skipped; post({ type: 'stats', skipped: lastSkipped }); }
    now = performance.now();
  }
  setTimeout(loop, Math.max(0, next - now));
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const backend = await createWasmBackend(m.module!, m.n, m.seed);
      host = new SimHost(backend, { n: m.n, hz: m.hz, script: m.script, bench: m.bench, dur: m.dur });
      pool.push(...m.pool);
      period = 1000 / m.hz;
      next = performance.now();
      running = true;
      post({ type: 'ready' });
      loop();
      break;
    }
    case 'input': if (host) host.input = m.input; break;
    case 'return': pool.push(m.buffer); break;
    case 'delay': delayMs = m.ms; break;
    case 'stop': running = false; break;
  }
};
void wallNow;
