// WebGPU startup. Every failure path ends on the "not supported" page, never a blank screen.
export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  features: { bc: boolean; f16: boolean; timestamp: boolean; indirectFirstInstance: boolean };
  info: { vendor: string; architecture: string; device: string; description: string };
}

export class GpuUnavailable extends Error {}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!('gpu' in navigator) || !navigator.gpu) throw new GpuUnavailable('navigator.gpu is missing.');
  // requestAdapter resolves to null (it does not throw) when no adapter is available.
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new GpuUnavailable('No GPU adapter is available.');
  // Optional features are chosen again for every adapter: a new adapter may offer a different set.
  const features = {
    bc: adapter.features.has('texture-compression-bc'),
    f16: adapter.features.has('shader-f16'),
    timestamp: adapter.features.has('timestamp-query'),
    indirectFirstInstance: adapter.features.has('indirect-first-instance'),
  };
  const requiredFeatures: GPUFeatureName[] = [];
  if (features.bc) requiredFeatures.push('texture-compression-bc');
  if (features.timestamp) requiredFeatures.push('timestamp-query');
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredFeatures });
  } catch (e) {
    throw new GpuUnavailable(`The GPU device could not be created (${(e as Error).message}).`);
  }
  const context = canvas.getContext('webgpu');
  if (!context) throw new GpuUnavailable('The canvas has no WebGPU context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const i = adapter.info;
  return { adapter, device, context, format, features, info: { vendor: i?.vendor ?? '', architecture: i?.architecture ?? '', device: i?.device ?? '', description: i?.description ?? '' } };
}

export function showUnsupported(reason: string) {
  document.getElementById('unsupported')!.style.display = 'block';
  document.getElementById('unsupported-reason')!.textContent = reason;
  document.getElementById('overlay')!.style.display = 'none';
  document.getElementById('switches')!.style.display = 'none';
  (window as any).__unsupported = reason;
}

// GPU time from timestamp-query, read back a few frames later so the CPU never waits on the GPU.
export class GpuTimer {
  private querySet: GPUQuerySet | null = null;
  private resolve: GPUBuffer | null = null;
  private free: GPUBuffer[] = [];
  private slots: number;
  ms: number[];
  constructor(private device: GPUDevice, enabled: boolean, slots = 4) {
    this.slots = slots;
    this.ms = new Array(slots).fill(NaN);
    if (!enabled) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: slots * 2 });
    this.resolve = device.createBuffer({ size: slots * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let i = 0; i < 4; i++) this.free.push(device.createBuffer({ size: slots * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  }
  get enabled() { return !!this.querySet; }
  writes(slot: number): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    return { querySet: this.querySet, beginningOfPassWriteIndex: slot * 2, endOfPassWriteIndex: slot * 2 + 1 };
  }
  // Call once per frame after the passes, before finish(). used = slots written this frame.
  endFrame(encoder: GPUCommandEncoder, used: number): (() => void) | null {
    if (!this.querySet || !this.resolve) return null;
    const buf = this.free.pop();
    if (!buf) return null; // all readback buffers are still in flight; skip this frame
    encoder.resolveQuerySet(this.querySet, 0, used * 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, buf, 0, used * 16);
    return () => {
      buf.mapAsync(GPUMapMode.READ, 0, used * 16).then(() => {
        const t = new BigInt64Array(buf.getMappedRange(0, used * 16));
        for (let i = 0; i < used; i++) {
          const d = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
          if (d >= 0 && d < 1000) this.ms[i] = d;
        }
        buf.unmap();
        this.free.push(buf);
      }).catch(() => { /* device lost */ });
    };
  }
}
