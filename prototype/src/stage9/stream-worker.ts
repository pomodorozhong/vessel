// Runs the scripted stream at 30 Hz in a worker, so the main thread receives snapshots the same way it will from the real sim.
import { ScriptStream } from './script-stream';
import type { StreamConfig } from './script-stream';

let stream: ScriptStream | null = null;
const period = 1000 / 30;
let next = 0, running = false;
let steps = 0, sumMs = 0, maxMs = 0;

function loop() {
  if (!running || !stream) return;
  const t0 = performance.now();
  const out = stream.step();
  const dt = performance.now() - t0;
  steps++; sumMs += dt; if (dt > maxMs) maxMs = dt;
  const transfer: Transferable[] = [out.snapshot];
  if (out.world) transfer.push(out.world.buffer);
  (self as unknown as Worker).postMessage({ type: 'snapshot', buffer: out.snapshot, world: out.world, stepMs: dt }, transfer);
  next += period;
  const now = performance.now();
  if (next < now - 250) next = now; // do not try to catch up after a long stall
  setTimeout(loop, Math.max(0, next - now));
}

self.onmessage = (e: MessageEvent<{ type: string; config?: StreamConfig }>) => {
  if (e.data.type === 'init') { stream = new ScriptStream(e.data.config!); (self as unknown as Worker).postMessage({ type: 'ready' }); }
  else if (e.data.type === 'start') { running = true; next = performance.now(); loop(); }
  else if (e.data.type === 'stats') (self as unknown as Worker).postMessage({ type: 'stats', steps, meanMs: sumMs / Math.max(1, steps), maxMs });
};
