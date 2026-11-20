// Run 2 allocation calibration: the "game" side. Two rAF loops with a known allocation behaviour, used to check
// scripts/run2/heap.mjs. The harness (harness-calib.ts) is a separate chunk that is called every frame and allocates
// on purpose, so the heap sampler has to tell game and harness apart by the script URL.
const mode = new URLSearchParams(location.search).get('calib') ?? 'noalloc';

const a = new Float32Array(1024), b = new Float32Array(1024);
for (let i = 0; i < 1024; i++) b[i] = Math.sin(i);
let sink: number[] | null = null;
const acc = new Float64Array(1); // a module-level `let acc = 0` would box a new HeapNumber on every write

// Typed-array arithmetic only: allocates nothing.
function gameStepNoAlloc() {
  let s = 0;
  for (let i = 0; i < 1024; i++) { a[i] = a[i] * 0.99 + b[i] * 0.5 + 0.001; s += a[i]; }
  acc[0] = s;
}
// The same work plus one 252-element small-integer array kept alive in `sink`: 252 x 4 bytes (pointer compression) of
// elements plus the array headers, about 1.04 KB per frame.
function gameStepAlloc() {
  gameStepNoAlloc();
  sink = new Array(252).fill(1);
}

type Harness = typeof import('./harness-calib');
let harness: Harness | null = null;
function loop(t: number) {
  if (mode === 'alloc') gameStepAlloc(); else gameStepNoAlloc();
  harness?.onFrame(t);
  requestAnimationFrame(loop);
}
void import('./harness-calib').then((h) => { harness = h; h.init(mode, () => acc[0] + (sink ? sink.length : 0)); (window as any).__ready = true; requestAnimationFrame(loop); });
