// Stand-in sim worker for the save measurements: it owns the stored chunk buffers and the active area, and per save it only
// copies the active area and posts buffers to the save worker (directly, over a MessageChannel port).
import { loadChunks } from './chunks';
import type { ChunksWasm } from './chunks';
import { CHUNK_BYTES, MAX_EVENTS, RECORD_BYTES, WORLD, activeAreaBytes } from './blob';

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
let wasm: ChunksWasm;
let port: MessagePort;

type Variant = 'slab64' | 'perchunk' | 'copy1';
let records: Uint8Array = new Uint8Array(0); // the whole stored world, canonical copy used to (re)build variants
let stored: ArrayBuffer[] = []; // slab64 / perchunk: buffers the sim holds
let big: ArrayBuffer | null = null; // copy1
let active = new Uint8Array(0);
let variant: Variant = 'slab64';

const waiters = new Map<number, (m: any) => void>();
let adoptMs: number[] = [];

function buildWorld() {
  const L = WORLD;
  records = new Uint8Array(L.nStored * RECORD_BYTES);
  for (let i = 0; i < L.nStored; i++) {
    const o = i * RECORD_BYTES;
    records.set(wasm.initChunk(64, 8, i + 1), o);
    const n = (i * 7 + 3) % (MAX_EVENTS + 1);
    new DataView(records.buffer).setUint32(o + CHUNK_BYTES, n, true);
    records.set(wasm.genEvents(n, i + 1, 0, 100000), o + CHUNK_BYTES + 4);
  }
  active = new Uint8Array(activeAreaBytes(L));
  for (let i = 0; i < L.nActive; i++) active.set(wasm.initChunk(64, 8, 100000 + i), i * CHUNK_BYTES);
  // 10,000 entities x 32 bytes of deterministic filler (positions, velocities, ...).
  const ent = new Uint32Array(active.buffer, L.nActive * CHUNK_BYTES, L.nEntities * 8);
  for (let i = 0; i < ent.length; i++) ent[i] = Math.imul(i + 1, 2654435761) >>> 0;
}

function setVariant(v: Variant) {
  variant = v;
  stored = []; big = null;
  if (v === 'copy1') big = records.slice().buffer as ArrayBuffer;
  else {
    const per = v === 'slab64' ? 64 : 1;
    for (let i = 0; i < WORLD.nStored; i += per) stored.push(records.slice(i * RECORD_BYTES, (i + per) * RECORD_BYTES).buffer as ArrayBuffer);
  }
}

async function bench(saves: number, tick0: number) {
  const out = { simMs: [] as number[], copyMs: [] as number[], adoptMs: [] as number[], serializeMs: [] as number[], holdMs: [] as number[], idbMs: [] as number[], totalMs: [] as number[], e2eMs: [] as number[], bytes: 0, failures: [] as any[], transferred: 0 };
  adoptMs = [];
  for (let i = 0; i < saves; i++) {
    const tick = tick0 + i;
    new DataView(active.buffer).setFloat64(0, tick, true); // the sim keeps changing the active area
    const t0 = performance.now();
    const activeCopy = active.buffer.slice(0) as ArrayBuffer;
    const tc = performance.now();
    const id = tick;
    const msg: any = { type: 'save', id, tick, layout: WORLD, active: activeCopy };
    const transfer: Transferable[] = [activeCopy];
    if (variant === 'copy1') msg.copy = big; // structured clone: copies the buffer
    else { msg.stored = stored; transfer.push(...stored); out.transferred = stored.length; }
    const done = new Promise<any>((res) => waiters.set(id, res));
    port.postMessage(msg, transfer);
    const t1 = performance.now();
    if (variant !== 'copy1') stored = []; // detached until the save worker returns them
    const saved = await done;
    out.e2eMs.push(performance.now() - t1);
    out.simMs.push(t1 - t0); out.copyMs.push(tc - t0);
    out.serializeMs.push(saved.serializeMs); out.holdMs.push(saved.holdMs); out.idbMs.push(saved.idbMs); out.totalMs.push(saved.totalMs);
    out.bytes = saved.bytes;
    if (!saved.ok) out.failures.push(saved.error);
  }
  out.adoptMs = adoptMs;
  return out;
}

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    wasm = await loadChunks(m.module);
    port = m.port as MessagePort;
    port.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === 'returned') {
        const t = performance.now();
        stored = d.stored; // adopt the buffers again
        adoptMs.push(performance.now() - t);
      } else if (d.type === 'saved') waiters.get(d.id)?.(d);
    };
    buildWorld();
    scope.postMessage({ type: 'ready', storedBytes: records.byteLength, activeBytes: active.byteLength });
  } else if (m.type === 'bench') {
    setVariant(m.variant);
    const r = await bench(m.saves, m.tick0);
    scope.postMessage({ type: 'benchDone', id: m.id, variant: m.variant, ...r });
  } else if (m.type === 'saveOnce') {
    setVariant('slab64');
    const r = await bench(1, m.tick0);
    scope.postMessage({ type: 'benchDone', id: m.id, ...r });
  }
};
