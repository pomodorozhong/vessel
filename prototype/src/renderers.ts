import type { Gpu, GpuTimer } from './gpu';
import { SimpleRenderer } from './render-simple';
import { WorldRenderer } from './render-world';
import { params } from './params';

export interface Renderer {
  name: string;
  drawCalls: number;
  setSnapshot(buffer: ArrayBuffer): void;
  // Returns the number of timestamp slots used.
  render(encoder: GPUCommandEncoder, target: GPUTexture, alpha: number, time: number, playerX: number, playerY: number): number;
  overlay?(): string[];
  info?(): unknown;
  gpuParts?(): unknown;
}

export async function createRenderer(kind: string, gpu: Gpu, timer: GpuTimer, maxEntities: number, blocked: Uint8Array, canvas: HTMLCanvasElement): Promise<Renderer> {
  if (kind === 'gpu' || kind === 'plain') return WorldRenderer.create(kind, gpu, timer, maxEntities, blocked, params.ires);
  return SimpleRenderer.create(gpu, timer, maxEntities, blocked, canvas);
}
