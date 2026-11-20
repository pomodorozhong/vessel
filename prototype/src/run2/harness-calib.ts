// Run 2 allocation calibration: the harness side (its own chunk, harness-calib-*.js). It counts frames and, on
// purpose, allocates about 180 bytes per frame (a 30-element array) so the "harness" bucket of the heap sampler is not empty.
let frames = 0, t0 = 0, sink: number[] | null = null, mode = '', probe: () => number = () => 0;
export function init(m: string, p: () => number) {
  mode = m; probe = p; t0 = performance.now();
  (window as any).__calib = () => ({ mode, frames, seconds: (performance.now() - t0) / 1000, probe: probe() });
}
export function onFrame(_t: number) {
  frames++;
  sink = new Array(30).fill(1); // harness allocation, about 180 bytes
  if (sink.length === 0) frames--;
  if ((frames & 63) === 0) document.getElementById('out')!.textContent = `${mode}: ${frames} frames`;
}
