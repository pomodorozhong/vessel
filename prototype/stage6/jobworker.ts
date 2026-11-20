// Job worker: runs catch-up (or the replay reference) on chunk buffers it is sent, and returns them as transferables.
import { loadChunks } from './chunks';
import type { ChunksWasm } from './chunks';

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
let wasm: ChunksWasm;

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    wasm = await loadChunks(m.module);
    scope.postMessage({ type: 'ready' });
  } else if (m.type === 'timerres') {
    // Smallest step performance.now() takes in this worker.
    let best = Infinity;
    for (let i = 0; i < 2000; i++) {
      const a = performance.now(); let b = a;
      while (b === a) b = performance.now();
      best = Math.min(best, b - a);
    }
    scope.postMessage({ type: 'timerres', id: m.id, resolutionMs: best, isolated: (self as any).crossOriginIsolated });
  } else if (m.type === 'make') {
    const chunk = wasm.initChunk(m.plots, m.furnaces, m.seed).buffer as ArrayBuffer;
    const events = wasm.genEvents(m.n, m.seed, m.from, m.to).buffer as ArrayBuffer;
    scope.postMessage({ type: 'made', id: m.id, chunk, events }, [chunk, events]);
  } else if (m.type === 'job') {
    const chunk = new Uint8Array(m.chunk as ArrayBuffer);
    const events = new Uint8Array(m.events as ArrayBuffer);
    let amortMs = -1;
    if (m.inner > 1) {
      const t = performance.now();
      wasm.runRepeated(m.mode, chunk, events, m.n, m.to, m.inner);
      amortMs = (performance.now() - t) / m.inner;
    }
    const t0 = performance.now();
    wasm.run(m.mode, chunk, events, m.n, m.to);
    const computeMs = performance.now() - t0;
    scope.postMessage({ type: 'done', id: m.id, chunk: chunk.buffer, events: events.buffer, computeMs, amortMs }, [chunk.buffer as ArrayBuffer, events.buffer as ArrayBuffer]);
  }
};
