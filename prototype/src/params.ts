// URL parameters select the test configuration, so every run can be reproduced from its URL.
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const str = (k: string, d: string) => q.get(k) ?? d;

export const params = {
  n: num('n', 2000),                 // entity count
  seed: num('seed', 1),
  sim: str('sim', 'wasm-simd'),      // wasm-simd | wasm-nosimd | ts
  thread: str('thread', 'worker'),   // worker | main
  hz: num('hz', 30),                 // sim step rate
  bench: str('bench', ''),           // '' | stage name; a bench run ends by setting window.__result
  dur: num('dur', 300),
  warmup: num('warmup', 5),           // seconds before a bench starts recording
  spawn: num('spawn', 0),             // > 0: entities start inside a square of this half-size around the player
  design: str('design', 'A'),        // snapshot design: A (queue + steered render clock) | B (newest only)
  lag: num('lag', 2),                // design A: render clock lag behind the sim, in sim steps
  cap: num('cap', 0),                // 30 = draw every second frame
  delay: num('delay', 0),            // random delay added to each snapshot message, 0..delay ms
  stall: num('stall', 0),            // bench: main-thread stall length in ms, repeated every 10 s
  pool: num('pool', 6),              // snapshot buffers in the fixed pool
  maxq: num('maxq', 3),              // design A: snapshots that may wait on the main thread
  render: str('render', 'simple'),   // simple | plain | gpu
  ires: num('ires', 1080),           // internal render height (world pass), 16:9
  cw: num('cw', 0), ch: num('ch', 0), // canvas size override (default 1920x1080)
  script: num('script', q.has('bench') ? 1 : 0), // 1 = scripted player input (benchmarks)
};
export type Params = typeof params;
