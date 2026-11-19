// Thin wrapper over the chunks WASM exports (plain extern "C", exported memory). Works in a worker or on the main thread.
export interface ChunksWasm {
  chunkLen(plots: number, furnaces: number): number;
  /** Writes a random valid game-parameter chunk and returns its bytes (a copy). */
  initChunk(plots: number, furnaces: number, seed: number): Uint8Array;
  /** `n` sorted random events with ticks in (from, to], 16 bytes each (a copy). */
  genEvents(n: number, seed: number, from: number, to: number): Uint8Array;
  /** In place: copies `chunk` in, runs, copies the result back into `chunk`. */
  run(mode: 'catchup' | 'replay', chunk: Uint8Array, events: Uint8Array, nEvents: number, to: number): void;
  /** Same as run but only the WASM call is repeated `reps` times on the already-copied input (amortized timing). */
  runRepeated(mode: 'catchup' | 'replay', chunk: Uint8Array, events: Uint8Array, nEvents: number, to: number, reps: number): void;
  memoryBytes(): number;
}

export async function loadChunks(module: WebAssembly.Module): Promise<ChunksWasm> {
  const inst = await WebAssembly.instantiate(module, {});
  const ex = inst.exports as any;
  const mem = ex.memory as WebAssembly.Memory;
  const u8 = () => new Uint8Array(mem.buffer);
  const withBuf = <T>(len: number, f: (p: number) => T): T => {
    const p = ex.alloc(len) as number;
    try { return f(p); } finally { ex.dealloc(p, len); }
  };
  return {
    chunkLen: (p, f) => ex.chunk_len(p, f),
    initChunk(plots, furnaces, seed) {
      const len = ex.chunk_len(plots, furnaces) as number;
      return withBuf(len, (p) => { ex.init_chunk(p, plots, furnaces, seed); return u8().slice(p, p + len); });
    },
    genEvents(n, seed, from, to) {
      const len = n * 16;
      return withBuf(len, (p) => { ex.gen_events(p, n, seed, from, to); return u8().slice(p, p + len); });
    },
    run(mode, chunk, events, n, to) {
      const cl = chunk.byteLength, el = events.byteLength;
      withBuf(cl, (cp) => withBuf(Math.max(el, 1), (ep) => {
        let m = u8(); m.set(chunk, cp); m.set(events.subarray(0, el), ep);
        (mode === 'catchup' ? ex.catch_up_chunk : ex.replay_chunk)(cp, cl, ep, n, to);
        m = u8(); chunk.set(m.subarray(cp, cp + cl));
      }));
    },
    runRepeated(mode, chunk, events, n, to, reps) {
      const cl = chunk.byteLength, el = events.byteLength;
      withBuf(cl, (cp) => withBuf(Math.max(el, 1), (ep) => {
        const m = u8(); m.set(events.subarray(0, el), ep);
        const f = mode === 'catchup' ? ex.catch_up_chunk : ex.replay_chunk;
        for (let i = 0; i < reps; i++) { u8().set(chunk, cp); f(cp, cl, ep, n, to); }
      }));
    },
    memoryBytes: () => mem.buffer.byteLength,
  };
}
