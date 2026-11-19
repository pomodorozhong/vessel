// Save job worker: serializes what the sim worker sends into one blob, returns the sim's buffers as soon as they are
// copied, then writes the blob to IndexedDB in one transaction (so what is on disk is always one consistent tick).
import { HEADER, WORLD, activeAreaBytes, blobSize, hash32, verify, writeHeader } from './blob';
import type { Layout } from './blob';

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
let simPort: MessagePort;

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('vessel-stage6', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('saves');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function errInfo(e: any) { return { name: e?.name ?? 'Error', message: String(e?.message ?? e) }; }

async function putBlob(blob: ArrayBuffer, key = 'current'): Promise<{ ok: true; ms: number } | { ok: false; error: { name: string; message: string } }> {
  const t0 = performance.now();
  try {
    const db = await openDb();
    const out = await new Promise<{ ok: true } | { ok: false; error: { name: string; message: string } }>((res) => {
      let tx: IDBTransaction;
      try { tx = db.transaction('saves', 'readwrite'); } catch (e) { res({ ok: false, error: errInfo(e) }); return; }
      tx.oncomplete = () => res({ ok: true });
      tx.onerror = () => res({ ok: false, error: errInfo(tx.error ?? (tx as any).error) });
      tx.onabort = () => res({ ok: false, error: errInfo(tx.error) });
      try { tx.objectStore('saves').put(blob, key); } catch (e) { res({ ok: false, error: errInfo(e) }); }
    });
    db.close();
    return out.ok ? { ok: true, ms: performance.now() - t0 } : out;
  } catch (e) {
    return { ok: false, error: errInfo(e) };
  }
}

async function getBlob(): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  const v = await new Promise<ArrayBuffer | undefined>((res, rej) => {
    const r = db.transaction('saves', 'readonly').objectStore('saves').get('current');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return v;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function onSave(m: any) {
  const t0 = performance.now();
  const l: Layout = m.layout;
  const blob = new ArrayBuffer(blobSize(l));
  const u8 = new Uint8Array(blob);
  writeHeader(new DataView(blob), m.tick, l);
  let o = HEADER;
  const returned: ArrayBuffer[] = [];
  if (m.copy) {
    u8.set(new Uint8Array(m.copy as ArrayBuffer), o);
    o += l.nStored * l.recordBytes;
  } else {
    for (const b of m.stored as ArrayBuffer[]) { u8.set(new Uint8Array(b), o); o += b.byteLength; returned.push(b); }
  }
  // The sim's buffers go back right after the copy, before the checksum and the disk write.
  const tCopied = performance.now();
  if (returned.length) simPort.postMessage({ type: 'returned', id: m.id, stored: returned }, returned);
  const holdMs = tCopied - t0;
  u8.set(new Uint8Array(m.active as ArrayBuffer), o);
  o += activeAreaBytes(l);
  new DataView(blob).setUint32(o, hash32(blob, o), true);
  const serializeMs = performance.now() - t0;
  const put = await putBlob(blob);
  const totalMs = performance.now() - t0;
  simPort.postMessage({ type: 'saved', id: m.id, ok: put.ok, error: put.ok ? null : put.error, serializeMs, holdMs, idbMs: put.ok ? put.ms : -1, totalMs, bytes: blob.byteLength });
}

async function onMain(m: any) {
  const reply = (o: any, t: Transferable[] = []) => scope.postMessage({ id: m.id, ...o }, t);
  try {
    if (m.type === 'load') {
      const t0 = performance.now();
      const blob = await getBlob();
      const t1 = performance.now();
      if (!blob) { reply({ found: false, readMs: t1 - t0 }); return; }
      const { tick, layout } = verify(blob);
      const t2 = performance.now();
      // Split into the sim's in-memory form: 64-record slabs, plus the active area.
      const slabs: ArrayBuffer[] = [];
      let o = HEADER;
      for (let i = 0; i < layout.nStored; i += 64) {
        const n = Math.min(64, layout.nStored - i) * layout.recordBytes;
        slabs.push(blob.slice(o, o + n)); o += n;
      }
      const active = blob.slice(o, o + activeAreaBytes(layout));
      const t3 = performance.now();
      reply({ found: true, tick, bytes: blob.byteLength, readMs: t1 - t0, verifyMs: t2 - t1, splitMs: t3 - t2, slabs: slabs.length }, [...slabs, active]);
    } else if (m.type === 'export') {
      const blob = await getBlob();
      if (!blob) reply({ found: false });
      else reply({ found: true, blob }, [blob]);
    } else if (m.type === 'import') {
      const info = verify(m.blob as ArrayBuffer);
      const bytes = (m.blob as ArrayBuffer).byteLength;
      const put = await putBlob(m.blob);
      reply({ ok: put.ok, error: put.ok ? null : put.error, bytes, tick: info.tick, layout: info.layout });
    } else if (m.type === 'sha') {
      const blob = await getBlob();
      reply({ found: !!blob, sha: blob ? hex(await crypto.subtle.digest('SHA-256', blob)) : null, bytes: blob?.byteLength ?? 0 });
    } else if (m.type === 'clear') {
      const db = await openDb();
      await new Promise<void>((res, rej) => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      db.close();
      reply({ ok: true });
    } else if (m.type === 'putraw') {
      // Writes `bytes` of filler as a save-sized record, to test quota errors without the sim.
      const put = await putBlob(new ArrayBuffer(m.bytes), 'filler');
      reply({ ok: put.ok, error: put.ok ? null : put.error });
    }
  } catch (e) {
    reply({ error: errInfo(e), ok: false });
  }
}

scope.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    simPort = m.port as MessagePort;
    simPort.onmessage = (ev) => { if (ev.data.type === 'save') void onSave(ev.data); };
    scope.postMessage({ type: 'ready' });
  } else void onMain(m);
};
void WORLD;
