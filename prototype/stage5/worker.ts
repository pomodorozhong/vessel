// Minimal sim worker for the Stage 5 page: instantiates the compiled module it is sent and steps it a few times.
const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
scope.onmessage = async (e: MessageEvent) => {
  if (e.data.type !== 'init') return;
  const t0 = performance.now();
  const inst = await WebAssembly.instantiate(e.data.module as WebAssembly.Module, { env: { now: () => performance.now() } });
  const ex = inst.exports as any;
  ex.init(100, 1);
  for (let i = 0; i < 10; i++) ex.step(0, 0, 0);
  scope.postMessage({ type: 'ready', stepMs: performance.now() - t0 });
};
