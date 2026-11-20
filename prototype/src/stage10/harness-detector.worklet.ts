// Stage 10 measurement worklets (test harness, not part of either mixer).
//
// stage10-detector: a tiny always-on node that sits on the master output of BOTH designs, so the glitch counter is
// identical for A and B. Each render quantum it compares wall-clock time with audio time. The renderer works in bursts
// (one output callback at a time, about 10 ms on this device), so wall minus audio time normally wanders inside a band
// as wide as the burst; a render that falls behind pushes it out of the band by the delay. "excess" is how far wall-minus-
// audio is above its running minimum; a late-render event is counted each time excess rises above LATE_MS (the floor is a rolling minimum over about 1 s; and again only
// after it has fallen below LATE_MS / 2). It also measures the master's peak and clipped samples (|x| >= 1).
// The wall clock is performance.now() where the worklet scope has it, else Date.now() (1 ms steps).
//
// stage10-injector: forces glitches to validate the counter. forceglitch=1: busy-wait 50 ms once every 4 s;
// forceglitch=2: burn 2.2 ms of every quantum for 1.5 s, every 6 s (a heavy worklet load).
import { D_CLIP, D_HAS_PERF, D_IDLE_EXCESS, D_INJECT, D_LATE, D_MAX_EXCESS, D_PEAK, D_QUANTA, MSG_DETECTOR, MSG_INJECT } from './layout';

const HAS_PERF = typeof performance !== 'undefined';
const nowMs: () => number = HAS_PERF ? () => performance.now() : () => Date.now();
const LATE_MS = 25;

class Detector extends AudioWorkletProcessor {
  private curMin = Infinity; private winQ = 0; private ringPos = 0; private ringN = 0; private ring = new Float64Array(8);
  private quanta = 0; private late = 0; private maxExcess = 0; private armed = true; private idleExcess = 0;
  private peak = 0; private clip = 0;
  private warm = 0;
  private msg = new Float64Array(16);
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const wall = nowMs(), lat = wall - currentTime * 1000;
    // The floor of wall-minus-audio time is the minimum over the last 8 windows of 47 quanta (about 1 s). A late render shifts the
    // floor up for good (the renderer is no longer ahead of the device), so a slowly creeping minimum would stay out of band
    // and hide every later glitch; a rolling minimum follows the shift after one second and re-arms the counter.
    if (lat < this.curMin) this.curMin = lat;
    if (++this.winQ === 47) { this.ring[this.ringPos++ & 7] = this.curMin; this.curMin = Infinity; this.winQ = 0; if (this.ringN < 8) this.ringN++; }
    let floor = this.curMin; for (let i = 0; i < this.ringN; i++) if (this.ring[i] < floor) floor = this.ring[i];
    const excess = lat - floor;
    this.quanta++;
    if (this.quanta > 750) { // the first 2 s are warm-up (graph start, JIT)
      if (excess > this.maxExcess) this.maxExcess = excess;
      if (this.armed && excess > LATE_MS) { this.late++; this.armed = false; }
      else if (!this.armed && excess < LATE_MS / 2) this.armed = true;
      if (this.late === 0 && excess > this.idleExcess) this.idleExcess = excess; // band width seen while nothing was late
    }
    const ch = inputs[0];
    if (ch && ch.length) for (let c = 0; c < ch.length; c++) {
      const x = ch[c];
      for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > this.peak) this.peak = a; if (a >= 1) this.clip++; }
    }
    if ((this.quanta & 127) === 0) {
      const m = this.msg;
      m[0] = MSG_DETECTOR; m[1 + D_QUANTA] = this.quanta; m[1 + D_LATE] = this.late; m[1 + D_MAX_EXCESS] = this.maxExcess; m[1 + D_PEAK] = this.peak; m[1 + D_CLIP] = this.clip;
      m[1 + D_IDLE_EXCESS] = this.idleExcess; m[1 + D_HAS_PERF] = HAS_PERF ? 1 : 0;
      this.port.postMessage(m.slice());
    }
    return true;
  }
}

class Injector extends AudioWorkletProcessor {
  private mode = 0; private next = 0; private injected = 0; private burnUntil = 0; private quanta = 0;
  constructor(options: any) { super(); this.mode = options?.processorOptions?.mode ?? 0; this.next = 6; }
  process(): boolean {
    this.quanta++;
    if (this.mode === 1 && currentTime >= this.next) {
      this.next += 4;
      const end = nowMs() + 50; while (nowMs() < end) { /* the audio thread is blocked */ }
      this.injected++;
      this.port.postMessage(new Float64Array([MSG_INJECT, this.injected]));
    } else if (this.mode === 2) {
      if (currentTime >= this.next) { this.next += 6; this.burnUntil = currentTime + 1.5; this.injected++; this.port.postMessage(new Float64Array([MSG_INJECT, this.injected])); }
      if (currentTime < this.burnUntil) { const end = nowMs() + 2.2; while (nowMs() < end) { /* burn */ } }
    }
    return true;
  }
}
registerProcessor('stage10-detector', Detector);
registerProcessor('stage10-injector', Injector);
