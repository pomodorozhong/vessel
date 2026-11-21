// Stage 10 URL parameters, so every run can be reproduced from its URL.
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const str = (k: string, d: string) => q.get(k) ?? d;

export const params = {
  mixer: str('mixer', 'A'),          // A (Web Audio nodes) | B (AudioWorklet mixer)
  rate: num('rate', 16400),          // sound events per second in the scripted snapshot stream (Stage 8's pass load)
  hz: num('hz', 30),                 // sim step rate of the scripted stream
  own: num('own', 8),                // scripted player shots per second (unmeasured; the driver's key presses are the measured ones)
  bench: str('bench', ''),           // '' | 'stage10'; a bench run ends by setting window.__result
  dur: num('dur', 300),
  warmup: num('warmup', 10),
  stalls: num('stalls', 0),          // 1: main-thread stalls of 100 ms and 500 ms alternately, every 10 s
  busy: num('busy', 0),              // ms of main-thread work burned per frame, to imitate rendering load
  forceglitch: num('forceglitch', 0), // 1: audio thread busy-waits 50 ms every 4 s; 2: heavy worklet load (2.2 ms per quantum for 1.5 s every 6 s)
  record: num('record', 0),          // seconds of master output to record with MediaRecorder (starts when the bench starts)
  pool: num('pool', 1),              // mixer A: 1 = reuse gain+panner chains per voice slot, 0 = create them per sound
  vol: num('vol', 1),                // master volume (smoke tests use a low value; measurements use 1)
  seed: num('seed', 1),
  lag: num('lag', 2),                // render clock lag in sim steps
  lead: num('lead', 0),              // ms: snapshot events fire this much before the frame that shows them (-1 = the measured pipeline delay), to line the sound up with the picture
  hint: str('hint', 'interactive'),  // AudioContext latencyHint
};
export type Params = typeof params;
