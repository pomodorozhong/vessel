// Stage 10: instrumentation buffers. Plain preallocated typed arrays that the game modules write into, so
// recording a number never allocates on the JS heap. The bench harness (harness-bench.ts, loaded only at the end
// of a run) reads them; nothing here computes statistics.
export const CAP_FRAMES = 1 << 16;
export const CAP_TRACK = 1 << 14;
export const CAP_TS = 1 << 12;

export const probe = {
  nFrame: 0,
  frameMs: new Float32Array(CAP_FRAMES),       // time between frame starts
  audioMs: new Float32Array(CAP_FRAMES),       // main-thread time spent on audio work in the frame (incl. input handlers since the previous frame)
  frameSubmit: new Float64Array(CAP_FRAMES),   // performance.now() when the frame's draw calls were issued (frame submit, not display)
  frameTick: new Float64Array(CAP_FRAMES),     // sim tick the render clock showed in the frame
  voices: new Uint8Array(CAP_FRAMES),
  nTrack: 0,
  trKind: new Uint8Array(CAP_TRACK),           // 0 = player input sound, 1 = snapshot event sound
  trT: new Float64Array(CAP_TRACK),            // kind 0: event.timeStamp; kind 1: the event's tick
  trCtx: new Float64Array(CAP_TRACK).fill(NaN), // context time the sound starts at
  trStart: 0,                                  // first tracked index counted in the bench
  nTs: 0,
  tsCtx: new Float64Array(CAP_TS), tsPerf: new Float64Array(CAP_TS), // getOutputTimestamp() samples
  mix: new Float64Array(32),
  det: new Float64Array(16),
  eventsIn: 0, eventsStale: 0, eventsOverflow: 0, // snapshot events decoded / skipped as stale / lost to the per-snapshot capacity
  eventsPlayerIn: 0, // player sounds from key presses
  eventsPlayerSim: 0, // steps whose player shots (fired by the sim) played a shoot voice
  stalls: 0,
  benchFrame: 0, benchTime: 0,
  rcLoad: new Float32Array(1024), rcPeak: new Float32Array(1024), rcUnder: new Float32Array(1024), nRc: 0, // AudioRenderCapacity updates
};
export function track(kind: number, t: number): number {
  const i = probe.nTrack;
  if (i >= CAP_TRACK) return -1;
  probe.nTrack = i + 1; probe.trKind[i] = kind; probe.trT[i] = t; probe.trCtx[i] = NaN;
  return i;
}
