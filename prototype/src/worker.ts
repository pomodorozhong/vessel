// Sim worker: steps the sim on a fixed timestep and sends each snapshot to the main thread as a transferable.
import { SimHost, createBackend } from './simhost';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as { postMessage(m: unknown, t: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

let host: SimHost | null = null;
let lastSkipped = 0;

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const backend = await createBackend(m.sim, m.module, m.n, m.seed);
      host = new SimHost(backend, m.opt, (buffer) => {
        post({ type: 'snapshot', buffer }, [buffer]);
        if (host!.skipped !== lastSkipped) { lastSkipped = host!.skipped; post({ type: 'stats', skipped: lastSkipped }); }
      });
      host.pool.push(...m.pool);
      host.onResult = (result) => post({ type: 'result', result });
      post({ type: 'ready' });
      host.start();
      break;
    }
    case 'input': if (host) host.input = m.input; break;
    case 'return': host?.pool.push(m.buffer); break;
    case 'delay': if (host) host.delayMs = m.ms; break;
    case 'stop': host?.stop(); break;
  }
};
