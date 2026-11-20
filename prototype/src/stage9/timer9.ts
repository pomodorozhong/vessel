// GPU time per pass from timestamp-query: one begin/end pair per pass, resolved at the end of the frame and read back a few
// frames later, so the CPU never waits on the GPU. Each finished frame is handed to onSample with the passes that ran.
import { SLOTS } from './look';

export class PassTimer {
  private qs: GPUQuerySet | null = null;
  private resolve: GPUBuffer | null = null;
  private free: GPUBuffer[] = [];
  private mask = 0;
  skipped = 0;
  onSample: ((ms: Float64Array, mask: number) => void) | null = null;
  constructor(private device: GPUDevice, enabled: boolean) {
    if (!enabled) return;
    const n = SLOTS.length;
    this.qs = device.createQuerySet({ type: 'timestamp', count: n * 2 });
    this.resolve = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let i = 0; i < 8; i++) this.free.push(device.createBuffer({ size: n * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  }
  get enabled() { return !!this.qs; }
  begin() { this.mask = 0; }
  // Timestamp writes for the pass in this slot (undefined when timestamp-query is not available).
  writes(slot: number): { querySet: GPUQuerySet; beginningOfPassWriteIndex: number; endOfPassWriteIndex: number } | undefined {
    if (!this.qs) return undefined;
    this.mask |= 1 << slot;
    return { querySet: this.qs, beginningOfPassWriteIndex: slot * 2, endOfPassWriteIndex: slot * 2 + 1 };
  }
  // After all passes, before finish(). The returned function starts the readback and is called after submit.
  end(encoder: GPUCommandEncoder): (() => void) | null {
    if (!this.qs || !this.resolve) return null;
    const buf = this.free.pop();
    if (!buf) { this.skipped++; return null; }
    const n = SLOTS.length, mask = this.mask;
    encoder.resolveQuerySet(this.qs, 0, n * 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, buf, 0, n * 16);
    return () => {
      buf.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(buf.getMappedRange());
        const ms = new Float64Array(n);
        for (let i = 0; i < n; i++) if (mask & (1 << i)) { const d = Number(t[i * 2 + 1] - t[i * 2]) / 1e6; ms[i] = d >= 0 && d < 1000 ? d : NaN; }
        buf.unmap();
        this.free.push(buf);
        this.onSample?.(ms, mask);
      }).catch(() => { /* device lost */ });
    };
  }
}
