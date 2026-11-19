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
  script: num('script', q.has('bench') ? 1 : 0), // 1 = scripted player input (benchmarks)
};
export type Params = typeof params;
