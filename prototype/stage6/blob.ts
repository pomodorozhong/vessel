// Save blob format (one flat binary blob, little endian), also the export file format:
//   header (48 bytes): magic u32 'VSL6', version u32, tick f64, nStored u32, nActive u32, nEntities u32,
//                      recordBytes u32, activeChunkBytes u32, entityBytes u32, reserved 8 bytes
//   stored chunk records (nStored * recordBytes): chunk bytes, event count u32, 8 event slots of 16 bytes, padding
//   active chunks (nActive * activeChunkBytes), entities (nEntities * entityBytes)
//   checksum u32 (FNV-1a style over every 32-bit word before it)
export const MAGIC = 0x364c5356;
export const VERSION = 1;
export const HEADER = 48;

export interface Layout {
  nStored: number; nActive: number; nEntities: number;
  recordBytes: number; activeChunkBytes: number; entityBytes: number;
}

// The large world measured in the browser: 64 plots + 8 furnaces per chunk.
export const CHUNK_BYTES = 16 + 8 * 64 + 16 * 8; // 656
export const MAX_EVENTS = 8;
export const RECORD_BYTES = 792; // CHUNK_BYTES + 4 + MAX_EVENTS * 16, padded to a multiple of 8
export const WORLD: Layout = { nStored: 4096, nActive: 25, nEntities: 10000, recordBytes: RECORD_BYTES, activeChunkBytes: CHUNK_BYTES, entityBytes: 32 };

export const activeAreaBytes = (l: Layout) => l.nActive * l.activeChunkBytes + l.nEntities * l.entityBytes;
export const blobSize = (l: Layout) => HEADER + l.nStored * l.recordBytes + activeAreaBytes(l) + 4;

export function hash32(buf: ArrayBuffer, bytes: number): number {
  const w = new Uint32Array(buf, 0, bytes >>> 2);
  let h = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 0x01000193);
  return h >>> 0;
}

export function writeHeader(dv: DataView, tick: number, l: Layout) {
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, VERSION, true); dv.setFloat64(8, tick, true);
  dv.setUint32(16, l.nStored, true); dv.setUint32(20, l.nActive, true); dv.setUint32(24, l.nEntities, true);
  dv.setUint32(28, l.recordBytes, true); dv.setUint32(32, l.activeChunkBytes, true); dv.setUint32(36, l.entityBytes, true);
}

export function parseHeader(buf: ArrayBuffer): { tick: number; layout: Layout } {
  if (buf.byteLength < HEADER + 4) throw new Error('save too short');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a save file (bad magic)');
  if (dv.getUint32(4, true) !== VERSION) throw new Error('unsupported save version ' + dv.getUint32(4, true));
  const layout: Layout = {
    nStored: dv.getUint32(16, true), nActive: dv.getUint32(20, true), nEntities: dv.getUint32(24, true),
    recordBytes: dv.getUint32(28, true), activeChunkBytes: dv.getUint32(32, true), entityBytes: dv.getUint32(36, true),
  };
  if (blobSize(layout) !== buf.byteLength) throw new Error('save size does not match its header');
  return { tick: dv.getFloat64(8, true), layout };
}

export function verify(buf: ArrayBuffer): { tick: number; layout: Layout } {
  const h = parseHeader(buf);
  const stored = new DataView(buf).getUint32(buf.byteLength - 4, true);
  if (hash32(buf, buf.byteLength - 4) !== stored) throw new Error('checksum mismatch');
  return h;
}
