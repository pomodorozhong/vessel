// Stage 8 worker: runs the bench runner off the main thread (thread=worker).
import { Stage8Runner } from './runner';
import type { Config } from './runner';

const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };

scope.onmessage = async (e: MessageEvent<{ cfg: Config; module: WebAssembly.Module }>) => {
  const runner = await Stage8Runner.create(e.data.cfg, e.data.module, false);
  runner.onProgress = (tick, total) => scope.postMessage({ type: 'progress', tick, total });
  runner.onResult = (result) => scope.postMessage({ type: 'result', result });
  scope.postMessage({ type: 'ready' });
  runner.start();
};
