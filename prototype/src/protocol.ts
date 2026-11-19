// Snapshot buffer layout, shared by the worker, the main thread and the Rust sim.
// Header (80 bytes):
//   u32[0] tickStart   u32[1] tickEnd   u32[2] entity count   u32[3] input seq applied
//   f32[4] step ms     f32[5] collision ms   f32[6] flow field ms   f32[7] AI ms   f32[8] snapshot write ms
//   f32[9] movement+sort ms   f32[10] player x   f32[11] player y
//   f64 @48 time the step ended (performance.timeOrigin + now, comparable across threads)
//   f64 @56 time the step was due
//   f32[16] player x at the start of the step   f32[17] player y at the start
// Entries (32 bytes each): f32 x0, y0, x1, y1, facing0, facing1, u32 kind, f32 radius
export const HEADER_BYTES = 80;
export const ENTRY_BYTES = 32;
export const snapshotBytes = (maxEntities: number) => HEADER_BYTES + ENTRY_BYTES * maxEntities;

export interface InputState { seq: number; moveX: number; moveY: number; buttons: number; t: number }

export type ToWorker =
  | { type: 'init'; module: WebAssembly.Module | null; n: number; seed: number; sim: string; spawn: number; opt: { n: number; hz: number; script: number; bench: boolean; dur: number; warmup: number }; pool: ArrayBuffer[] }
  | { type: 'input'; input: InputState }
  | { type: 'return'; buffer: ArrayBuffer }
  | { type: 'delay'; ms: number }
  | { type: 'start' }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready'; blocked: Uint8Array }
  | { type: 'snapshot'; buffer: ArrayBuffer }
  | { type: 'stats'; skipped: number }
  | { type: 'result'; result: unknown };

export const wallNow = () => performance.timeOrigin + performance.now();
