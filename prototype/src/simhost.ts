// Runs the sim behind one interface, so the same driver works in the worker and on the main thread.
import { HEADER_BYTES, wallNow } from './protocol';
import type { InputState } from './protocol';

export interface Backend {
  step(moveX: number, moveY: number, buttons: number): void;
  snapshot(): Uint8Array; // view of the current snapshot (header + entries); valid until the next step
}

export async function createWasmBackend(module: WebAssembly.Module, n: number, seed: number): Promise<Backend> {
  const instance = await WebAssembly.instantiate(module, { env: { now: () => performance.now() } });
  const ex = instance.exports as any;
  ex.init(n, seed);
  const memory = ex.memory as WebAssembly.Memory;
  return {
    step: (x, y, b) => ex.step(x, y, b),
    snapshot: () => new Uint8Array(memory.buffer, ex.snapshot_ptr(), ex.snapshot_len()),
  };
}

export interface HostOptions { n: number; hz: number; script: number; bench: boolean; dur: number }

export class SimHost {
  tick = 0;
  input: InputState = { seq: 0, moveX: 0, moveY: 0, buttons: 0, t: 0 };
  skipped = 0;
  constructor(public backend: Backend, public opt: HostOptions) {}

  // Steps once and copies the snapshot into `target` (a pool buffer). Returns bytes written, or 0 if target is null.
  step(target: ArrayBuffer | null, dueWall: number): number {
    let { moveX, moveY, buttons } = this.input;
    if (this.opt.script) {
      // Scripted player: walks a circle so the flow field keeps being rebuilt. Same for every sim variant.
      const a = this.tick * (Math.PI * 2 / (this.opt.hz * 40));
      moveX = Math.cos(a); moveY = Math.sin(a); buttons = 0;
    }
    this.backend.step(moveX, moveY, buttons);
    this.tick++;
    if (!target) { this.skipped++; return 0; }
    const snap = this.backend.snapshot();
    new Uint8Array(target).set(snap);
    const dv = new DataView(target);
    dv.setUint32(12, this.input.seq, true);
    dv.setFloat64(48, wallNow(), true);
    dv.setFloat64(56, dueWall, true);
    return Math.max(snap.byteLength, HEADER_BYTES);
  }
}
