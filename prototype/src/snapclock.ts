// The snapshot hand-off on the main thread, in two designs that share one interface and one set of
// metrics, so they can be compared on numbers.
//   A: snapshots wait in a queue; a render clock runs a fixed lag behind the sim and is steered gently.
//   B: only the newest snapshot is kept; playback of it starts when it arrives.
// Neither design ever blends entries from two snapshots (entities change slots every step), and
// neither extrapolates: when the next snapshot is late, entities hold at the end of the current one.
import { HEADER_BYTES } from './protocol';

export interface ClockOptions { design: string; lag: number; hz: number; maxQueue: number }

const startTick = (b: ArrayBuffer) => new Uint32Array(b, 0, 2)[0];
const endTick = (b: ArrayBuffer) => new Uint32Array(b, 0, 2)[1];
void HEADER_BYTES;

export class SnapClock {
  current: ArrayBuffer | null = null;
  alpha = 0;
  changed = false;        // current was replaced this frame: the renderer must upload it
  displayed = 0;          // sim time on screen, in steps
  // Metrics.
  frames = 0; pauses = 0; jumps = 0; dropped = 0; maxQueue = 0; snapshots = 0; gaps = 0;
  sumSqErr = 0;           // sum of (advance - expected)^2 in steps^2
  lastAnomaly = -1;       // performance.now() of the last pause or jump frame
  private queue: ArrayBuffer[] = [];
  private rt = NaN;       // render time in steps (design A)
  private offset = NaN;   // estimate of (sim steps - wall steps), smoothed (design A)
  private arrival = 0;    // when the current snapshot arrived (design B)
  private curStart = 0; private curEnd = 0;
  private prevDisplayed = NaN;
  private lastEnd = -1;

  constructor(private opt: ClockOptions, private release: (b: ArrayBuffer) => void) {}

  get queueLength() { return this.queue.length; }

  onSnapshot(buffer: ArrayBuffer, now: number) {
    const end = endTick(buffer);
    this.snapshots++;
    if (this.lastEnd >= 0 && startTick(buffer) !== this.lastEnd) this.gaps++; // the worker skipped a snapshot
    this.lastEnd = end;
    if (this.opt.design === 'B') {
      if (this.queue.length) { this.release(this.queue.pop()!); this.dropped++; } // an unshown snapshot was superseded
      this.queue.push(buffer);
      this.arrival = now;
      return;
    }
    const sample = end - now * this.opt.hz / 1000;
    this.offset = Number.isNaN(this.offset) ? sample : this.offset + (sample - this.offset) * 0.05;
    this.queue.push(buffer);
    if (this.queue.length > this.opt.maxQueue) { this.release(this.queue.shift()!); this.dropped++; }
    if (this.queue.length > this.maxQueue) this.maxQueue = this.queue.length;
  }

  private take(b: ArrayBuffer) {
    if (this.current) this.release(this.current);
    this.current = b; this.changed = true;
    this.curStart = startTick(b); this.curEnd = endTick(b);
  }

  // Advances the clock for one drawn frame. dt is the time since the previous drawn frame.
  frame(now: number, dt: number) {
    this.changed = false;
    const hz = this.opt.hz;
    if (this.opt.design === 'B') {
      if (this.queue.length) this.take(this.queue.pop()!);
      if (!this.current) return;
      this.alpha = Math.max(0, Math.min(1, (now - this.arrival) * hz / 1000));
    } else {
      if (Number.isNaN(this.offset)) return;
      const target = this.offset + now * hz / 1000 - this.opt.lag;
      const err = target - this.rt;
      if (Number.isNaN(this.rt) || Math.abs(err) > 2) this.rt = target;            // far off (start, stall): resync at once
      else this.rt += dt * hz / 1000 * (1 + Math.max(-0.05, Math.min(0.05, err * 0.1))); // steer by at most 5% of speed
      while ((!this.current || this.rt >= this.curEnd) && this.queue.length) this.take(this.queue.shift()!);
      if (!this.current) return;
      this.alpha = Math.max(0, Math.min(1, (this.rt - this.curStart) / (this.curEnd - this.curStart)));
    }
    this.displayed = this.curStart + this.alpha * (this.curEnd - this.curStart);
    if (!Number.isNaN(this.prevDisplayed) && dt > 0) {
      const expected = dt * hz / 1000, advance = this.displayed - this.prevDisplayed;
      this.frames++;
      this.sumSqErr += (advance - expected) * (advance - expected);
      if (advance < expected * 0.25) { this.pauses++; this.lastAnomaly = now; }
      else if (advance > expected * 1.75) { this.jumps++; this.lastAnomaly = now; }
    }
    this.prevDisplayed = this.displayed;
  }

  releaseAll() { for (const b of this.queue) this.release(b); this.queue.length = 0; if (this.current) this.release(this.current); this.current = null; }

  resetMetrics() { this.frames = this.pauses = this.jumps = this.dropped = this.maxQueue = this.snapshots = this.gaps = 0; this.sumSqErr = 0; this.lastAnomaly = -1; }
}
