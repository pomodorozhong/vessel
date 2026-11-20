// Debug overlay. The DOM is touched a few times per second, never every frame.
export class Stat {
  private buf: Float32Array;
  private i = 0;
  private n = 0;
  constructor(size = 240) { this.buf = new Float32Array(size); }
  push(v: number) { this.buf[this.i] = v; this.i = (this.i + 1) % this.buf.length; if (this.n < this.buf.length) this.n++; }
  summary(): { med: number; p99: number; max: number } {
    if (!this.n) return { med: NaN, p99: NaN, max: NaN };
    const s = this.buf.slice(0, this.n).sort();
    return { med: s[s.length >> 1], p99: s[Math.min(s.length - 1, Math.floor(s.length * 0.99))], max: s[s.length - 1] };
  }
}

export const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');

export class Overlay {
  private el = document.getElementById('overlay')!;
  private last = 0;
  private text = '';
  constructor(private lines: () => string[]) {}
  update(now: number) {
    if (now - this.last < 250) return;
    this.last = now;
    const t = this.lines().join('\n');
    if (t !== this.text) { this.text = t; this.el.textContent = t; }
  }
}
