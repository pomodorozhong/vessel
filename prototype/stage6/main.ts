// Stage 6 page: chunk catch-up job timings, save timings, export/import, storage probes.
// Everything is driven from window.stage6 (by scripts/stage6-run.mjs) or by ?run=jobs|saves.
import wasmUrl from '../src/wasm/chunks.wasm?url';
import { WORLD } from './blob';

const out = document.getElementById('out') as HTMLPreElement;
const log = (s: string) => { out.textContent += s + '\n'; };

export function stats(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, min: s[0], median: q(0.5), p99: q(0.99), max: s[s.length - 1] };
}

let modulePromise: Promise<WebAssembly.Module> | null = null;
const getModule = () => (modulePromise ??= WebAssembly.compileStreaming(fetch(wasmUrl)));

let nextId = 1;
function rpc(w: Worker, msg: any, transfer: Transferable[] = []): Promise<any> {
  const id = nextId++;
  return new Promise((res) => {
    const h = (e: MessageEvent) => { if (e.data.id === id) { w.removeEventListener('message', h); res(e.data); } };
    w.addEventListener('message', h);
    w.postMessage({ ...msg, id }, transfer);
  });
}
const once = (w: Worker, type: string) => new Promise<any>((res) => {
  const h = (e: MessageEvent) => { if (e.data.type === type) { w.removeEventListener('message', h); res(e.data); } };
  w.addEventListener('message', h);
});

// ---------------- catch-up jobs ----------------
const TICKS_PER_S = 30;
export const AGES: Record<string, number> = { hour: 3600 * TICKS_PER_S, day: 86400 * TICKS_PER_S, week: 7 * 86400 * TICKS_PER_S };

interface CaseOpts { plots: number; furnaces: number; age: number; events: number; reps: number; warmup?: number; inner?: number; replay?: boolean }

async function measureCase(w: Worker, o: CaseOpts) {
  const made = await rpc(w, { type: 'make', seed: 1, plots: o.plots, furnaces: o.furnaces, n: o.events, from: 0, to: o.age });
  const chunk0: ArrayBuffer = made.chunk, ev0: ArrayBuffer = made.events;
  const mode = o.replay ? 'replay' : 'catchup';
  const rt: number[] = [], compute: number[] = [], amort: number[] = [];
  let resultSample: Uint8Array | null = null;
  const warm = o.warmup ?? 10;
  for (let i = 0; i < o.reps + warm; i++) {
    const c = chunk0.slice(0), e = ev0.slice(0);
    const t0 = performance.now();
    const r = await rpc(w, { type: 'job', mode, chunk: c, events: e, n: o.events, to: o.age, inner: o.replay ? 1 : (o.inner ?? 20) }, [c, e]);
    const t1 = performance.now();
    if (i === 0) resultSample = new Uint8Array(r.chunk.slice(0));
    if (i >= warm) { rt.push(t1 - t0); compute.push(r.computeMs); if (r.amortMs >= 0) amort.push(r.amortMs); }
  }
  return { ...o, mode, chunkBytes: chunk0.byteLength, eventBytes: ev0.byteLength, roundTripMs: stats(rt), workerComputeMs: stats(compute), workerAmortizedMs: amort.length ? stats(amort) : null, resultSample };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function runJobs(cfg: { replayReps?: Record<string, number>; reps?: number; limits?: boolean } = {}) {
  const w = new Worker(new URL('./jobworker.ts', import.meta.url), { type: 'module' });
  const ready = once(w, 'ready');
  w.postMessage({ type: 'init', module: await getModule() });
  await ready;
  const timer = await rpc(w, { type: 'timerres' });
  const reps = cfg.reps ?? 200;
  const grid: any[] = [];
  for (const [ageName, age] of Object.entries(AGES)) {
    for (const events of [0, 10, 1000]) {
      const base = { plots: 64, furnaces: 8, age, events };
      const cu = await measureCase(w, { ...base, reps });
      const rr = cfg.replayReps?.[ageName] ?? 0;
      let rp: any = null;
      if (rr > 0) {
        rp = await measureCase(w, { ...base, reps: rr, warmup: 2, replay: true });
        rp.agreesWithCatchUp = same(rp.resultSample, cu.resultSample!);
      }
      for (const r of [cu, rp]) if (r) delete r.resultSample;
      grid.push({ age: ageName, ticks: age, events, catchUp: cu, replay: rp });
      log(`${ageName} ev=${events} catch-up rt median ${cu.roundTripMs.median.toFixed(3)} ms p99 ${cu.roundTripMs.p99.toFixed(3)}; compute median ${cu.workerComputeMs.median.toFixed(4)} p99 ${cu.workerComputeMs.p99.toFixed(4)}` + (rp ? `; replay compute median ${rp.workerComputeMs.median.toFixed(2)} (agrees ${rp.agreesWithCatchUp})` : ''));
    }
  }
  const limits: any[] = [];
  if (cfg.limits !== false) {
    const L = async (label: string, o: Omit<CaseOpts, 'reps'>, reps = 50) => {
      const r: any = await measureCase(w, { ...o, reps, inner: 3 });
      delete r.resultSample;
      limits.push({ label, ...r });
      log(`limit ${label}: compute median ${r.workerComputeMs.median.toFixed(3)} p99 ${r.workerComputeMs.p99.toFixed(3)} ms; round trip median ${r.roundTripMs.median.toFixed(3)} p99 ${r.roundTripMs.p99.toFixed(3)} ms`);
    };
    for (const ev of [10_000, 100_000, 1_000_000]) await L(`week, 64 plots + 8 furnaces, ${ev} events`, { plots: 64, furnaces: 8, age: AGES.week, events: ev });
    for (const [p, f] of [[1024, 128], [16384, 2048]]) await L(`week, ${p} plots + ${f} furnaces, 1000 events`, { plots: p, furnaces: f, age: AGES.week, events: 1000 });
    await L('1 game year (946,080,000 ticks), 64+8, 1000 events', { plots: 64, furnaces: 8, age: 365 * 86400 * TICKS_PER_S, events: 1000 });
    await L('100 game years (94,608,000,000 ticks), 64+8, 1000 events', { plots: 64, furnaces: 8, age: 100 * 365 * 86400 * TICKS_PER_S, events: 1000 });
  }
  w.terminate();
  return { timerResolutionMs: timer.resolutionMs, crossOriginIsolated: timer.isolated, reps, grid, limits };
}

// ---------------- saves ----------------
let sim: Worker, save: Worker, simInfo: any;
export async function initSaveWorkers() {
  if (sim) return simInfo;
  sim = new Worker(new URL('./simworker.ts', import.meta.url), { type: 'module' });
  save = new Worker(new URL('./saveworker.ts', import.meta.url), { type: 'module' });
  const ch = new MessageChannel();
  const rs = once(sim, 'ready'), rv = once(save, 'ready');
  const module = await getModule();
  sim.postMessage({ type: 'init', module, port: ch.port1 }, [ch.port1]);
  save.postMessage({ type: 'init', port: ch.port2 }, [ch.port2]);
  simInfo = await rs; await rv;
  return simInfo;
}

export async function saveOnce(tick0 = 1) {
  await initSaveWorkers();
  const r = await rpc(sim, { type: 'saveOnce', tick0 });
  return { ok: r.failures.length === 0, failures: r.failures, bytes: r.bytes, idbMs: r.idbMs[0], totalMs: r.totalMs[0], serializeMs: r.serializeMs[0] };
}
export async function loadSave() {
  await initSaveWorkers();
  const t0 = performance.now();
  const r = await rpc(save, { type: 'load' });
  r.roundTripMs = performance.now() - t0;
  return r;
}
export const shaOfSave = async () => { await initSaveWorkers(); return rpc(save, { type: 'sha' }); };
export const clearSave = async () => { await initSaveWorkers(); return rpc(save, { type: 'clear' }); };
export const putRaw = async (bytes: number) => { await initSaveWorkers(); return rpc(save, { type: 'putraw', bytes }); };

export async function exportSave(download = true) {
  await initSaveWorkers();
  const r = await rpc(save, { type: 'export' });
  if (!r.found) return { found: false };
  if (download) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.blob], { type: 'application/octet-stream' }));
    a.download = 'vessel-save.vsl';
    document.body.appendChild(a); a.click(); a.remove();
  }
  return { found: true, bytes: r.blob.byteLength };
}

export async function importFile(file: File) {
  await initSaveWorkers();
  const blob = await file.arrayBuffer();
  return rpc(save, { type: 'import', blob }, [blob]);
}

export async function runSaves(saves = 110, warm = 10) {
  const info = await initSaveWorkers();
  const variants: any = {};
  let tick0 = 1000;
  for (const v of ['slab64', 'perchunk', 'copy1']) {
    const r = await rpc(sim, { type: 'bench', variant: v, saves: saves + warm, tick0 });
    tick0 += saves + warm;
    const cut = (a: number[]) => a.slice(warm);
    variants[v] = {
      saves, bytes: r.bytes, buffersTransferredPerSave: r.transferred, failures: r.failures,
      simSideMs: stats(cut(r.simMs)), activeCopyMs: stats(cut(r.copyMs)), adoptMs: r.adoptMs.length ? stats(r.adoptMs.slice(warm)) : null,
      saveWorkerSerializeMs: stats(cut(r.serializeMs)), bufferHoldMs: stats(cut(r.holdMs)), idbWriteMs: stats(cut(r.idbMs)),
      saveWorkerTotalMs: stats(cut(r.totalMs)), simObservedEndToEndMs: stats(cut(r.e2eMs)),
    };
    log(`${v}: sim-side median ${variants[v].simSideMs.median.toFixed(4)} p99 ${variants[v].simSideMs.p99.toFixed(4)} ms; save worker total median ${variants[v].saveWorkerTotalMs.median.toFixed(1)} ms; bytes ${r.bytes}`);
  }
  const loads: any[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await loadSave();
    loads.push({ readMs: r.readMs, verifyMs: r.verifyMs, splitMs: r.splitMs, roundTripMs: r.roundTripMs, found: r.found });
  }
  const loadStats = {
    n: loads.length, readMs: stats(loads.map((x) => x.readMs)), verifyMs: stats(loads.map((x) => x.verifyMs)), splitMs: stats(loads.map((x) => x.splitMs)), roundTripMs: stats(loads.map((x) => x.roundTripMs)),
  };
  log(`load: read median ${loadStats.readMs.median.toFixed(1)} ms, verify ${loadStats.verifyMs.median.toFixed(1)} ms, split ${loadStats.splitMs.median.toFixed(1)} ms`);
  return { world: { ...WORLD, storedBytes: info.storedBytes, activeAreaBytes: info.activeBytes }, variants, load: loadStats };
}

// ---------------- storage ----------------
export async function storageInfo() {
  const s = navigator.storage;
  const r: any = { secureContext: isSecureContext };
  r.persistedBefore = await s.persisted();
  try { r.persistResult = await s.persist(); } catch (e: any) { r.persistError = String(e); }
  r.persistedAfter = await s.persisted();
  const est: any = await s.estimate();
  r.estimate = { quota: est.quota, usage: est.usage, usageDetails: est.usageDetails ?? null };
  return r;
}
export async function estimate() { const e: any = await navigator.storage.estimate(); return { quota: e.quota, usage: e.usage, usageDetails: e.usageDetails ?? null }; }

// ---------------- page wiring ----------------
(window as any).stage6 = { runJobs, runSaves, saveOnce, loadSave, shaOfSave, clearSave, putRaw, exportSave, importFile, storageInfo, estimate, initSaveWorkers, stats };
(window as any).__ready = true;

document.getElementById('imp')!.addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const r = await importFile(f);
  (window as any).__importResult = r;
  log('import: ' + JSON.stringify({ ok: r.ok, bytes: r.bytes, tick: r.tick, error: r.error }));
});
document.getElementById('bjobs')!.onclick = async () => { log(JSON.stringify(await runJobs({ replayReps: { hour: 20 }, reps: 50, limits: false }))); };
document.getElementById('bsaves')!.onclick = async () => { log(JSON.stringify(await runSaves(30, 3))); };
document.getElementById('bexp')!.onclick = async () => { log(JSON.stringify(await exportSave())); };

const run = new URLSearchParams(location.search).get('run');
if (run === 'jobs') runJobs({ replayReps: { hour: 200, day: 30, week: 5 } }).then((r) => ((window as any).__result = r));
else if (run === 'saves') saveOnce().then(() => runSaves()).then((r) => ((window as any).__result = r));
