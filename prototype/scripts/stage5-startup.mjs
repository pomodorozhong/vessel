// Stage 5: time to first frame. Serves the built site from the local Pages emulator on port 4175 and drives
// headed Chrome with puppeteer. Every config runs REPS times (default 5); the output has median and range.
//
//   node stage5/build-assets.mjs                      (once)
//   node scripts/stage5-startup.mjs [--groups a,b] [--reps 5] [--pads 0,1,2,3]
// groups: baseline, cold, warm, slow, wasm, preload, scale
//
// All numbers are "dev machine, local Pages emulator" (Chrome, headed, CDP network throttling), not reference-device results.
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startEmulator } from './pages-emulator.mjs';
import { NET, PORT, buildVariant, coldRun, root, stats, warmRuns, BASEURL } from './stage5-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REPS = Number(arg('--reps', 5));
const groups = new Set(arg('--groups', 'baseline,cold,warm,slow,wasm,preload,scale').split(','));
const pads = arg('--pads', '0,1,2,3,4').split(',').map(Number);
const outFile = join(root, 'results', 'data', 'stage5-startup.json');
const data = existsSync(outFile) && process.argv.includes('--merge') ? JSON.parse(readFileSync(outFile, 'utf8')) : {};

const built = buildVariant('s5-main');
const site = join(root, 'stage5', '.deploys', '_live-startup');
rmSync(site, { recursive: true, force: true });
cpSync(built, site, { recursive: true });
const emu = await startEmulator({ port: PORT, siteDir: site, log: console.log });
const meta = { measuredAt: new Date().toISOString(), host: 'dev machine (i7-13700, RTX 3060), local Pages emulator on localhost:' + PORT, reps: REPS, nets: NET, build: 's5-main' };
data.meta = meta;

const row = (r) => {
  const res = r.result;
  if (!res) return { error: r.error };
  const b = res.breakdown;
  return {
    firstFrame: res.firstFrameMs, htmlEnd: b.htmlResponseEnd, jsStart: b.jsStart, wasmCompiled: b.wasmCompiled, assetsDownloaded: b.assetsDownloaded,
    decodeMs: b.decodeMs, uploadMs: b.uploadMs, gpuDone: b.gpuDone, sw: res.swControlled, bc7: res.usedBc7,
  };
};
const summarize = (rows) => {
  const keys = ['firstFrame', 'htmlEnd', 'jsStart', 'wasmCompiled', 'assetsDownloaded', 'decodeMs', 'uploadMs'];
  const o = {}; for (const k of keys) o[k] = stats(rows.map((r) => r[k]));
  o.errors = rows.filter((r) => r.error).length;
  return o;
};
const wire = (reqs) => ({ requests: reqs.length, bytes: reqs.reduce((a, r) => a + (r.status === 200 ? r.bytes : 0), 0), r304: reqs.filter((r) => r.status === 304).length, r404: reqs.filter((r) => r.status === 404).length });
async function cold(name, { path, net, cpu = 1, emuState }) {
  if (emuState) Object.assign(emu.state, emuState);
  const rows = [], reqs = [];
  let version, netInfo;
  for (let i = 0; i < REPS; i++) { const r = await coldRun({ emulator: emu, path, net, cpu }); rows.push(row(r)); reqs.push(wire(r.requests)); version = r.version; netInfo = r.netInfo; }
  const s = summarize(rows);
  data[name] = { config: { path, net: net?.name ?? 'none', cpu, label: cpu > 1 ? 'dev machine, throttled' : 'dev machine', emuState }, browser: version, netInfo, summary: s, wire: reqs[0], rows };
  console.log(name.padEnd(34), 'first frame median', s.firstFrame.median, 'range', s.firstFrame.min, '-', s.firstFrame.max, '| wire', JSON.stringify(reqs[0]));
  if (emuState) Object.assign(emu.state, { gzipWasm: true });
}
async function warm(name, { path, net, cpu = 1, disableHttpCache = false }) {
  const w = await warmRuns({ emulator: emu, path, net, cpu, reps: REPS, disableHttpCache });
  const rows = w.runs.map(row);
  const s = summarize(rows);
  data[name] = { config: { path, net: net?.name ?? 'none', cpu, disableHttpCache, label: cpu > 1 ? 'dev machine, throttled' : 'dev machine' }, browser: w.version, netInfo: w.netInfo, summary: s, wire: wire(w.runs[0].requests), swControlledAll: rows.every((r) => r.sw), rows, requestsRun1: w.runs[0].requests.map((r) => ({ p: r.path, s: r.status, b: r.bytes })) };
  console.log(name.padEnd(34), 'first frame median', s.firstFrame.median, 'range', s.firstFrame.min, '-', s.firstFrame.max, '| sw', data[name].swControlledAll, '| wire', JSON.stringify(data[name].wire));
}

try {
  if (groups.has('baseline')) await cold('cold-nothrottle-cpu1', { path: 'stage5.html', net: null });
  if (groups.has('cold')) {
    await cold('cold-fast4g-cpu1', { path: 'stage5.html', net: NET.fast4g });
    await cold('cold-fast4g-cpu4', { path: 'stage5.html', net: NET.fast4g, cpu: 4 });
  }
  if (groups.has('warm')) {
    await warm('warm-fast4g-cpu1', { path: 'stage5.html', net: NET.fast4g });
    await warm('warm-fast4g-cpu4', { path: 'stage5.html', net: NET.fast4g, cpu: 4 });
    await warm('warm-swonly-fast4g-cpu1', { path: 'stage5.html', net: NET.fast4g, disableHttpCache: true });
  }
  if (groups.has('slow')) {
    await cold('cold-slow4g-cpu1', { path: 'stage5.html', net: NET.slow4g });
    await warm('warm-slow4g-cpu1', { path: 'stage5.html', net: NET.slow4g });
  }
  if (groups.has('wasm')) {
    // Fast 4G, cold. gz = our pre-gzipped file through DecompressionStream; plain = .wasm served gzipped by the host
    // (what real Pages does, observed); plain-uncompressed = hypothetical host that does not compress application/wasm.
    await cold('wasm-gz-prezipped', { path: 'stage5.html?wasm=gz', net: NET.fast4g });
    await cold('wasm-plain-hostgzip', { path: 'stage5-plain.html?wasm=plain', net: NET.fast4g });
    await cold('wasm-plain-uncompressed', { path: 'stage5-plain.html?wasm=plain', net: NET.fast4g, emuState: { gzipWasm: false } });
  }
  if (groups.has('fallback')) {
    // No texture-compression-bc (forced with ?bc=0): the page fetches the uncompressed RGBA8 files. The early script has
    // already started the BC7 downloads (it cannot know the adapter yet), so this also shows that waste.
    await cold('fallback-rgba8-fast4g', { path: 'stage5.html?bc=0', net: NET.fast4g });
  }
  if (groups.has('preload')) {
    // Single-download check: a preload with crossorigin is used by the later fetch(); without it the file is fetched twice.
    for (const [name, path] of [['preload-crossorigin', 'stage5.html'], ['preload-no-crossorigin', 'stage5-nocors.html']]) {
      const r = await coldRun({ emulator: emu, path, net: NET.fast4g, waitAfterMs: 4000 });
      const count = {};
      for (const q of r.requests) if (q.method === 'GET' && q.path.startsWith('/vessel/a/')) count[q.path] = (count[q.path] ?? 0) + 1;
      const dup = Object.entries(count).filter(([, n]) => n > 1);
      // What the browser did (Resource Timing): one entry per request it made, including ones answered from its own cache.
      const perName = {};
      for (const e of r.result?.resources ?? []) if (e.name.includes('/vessel/a/')) { const k = e.name.replace(/^.*\/vessel\//, ''); (perName[k] ??= []).push({ type: e.type, transfer: e.transfer, body: e.body }); }
      const browserDup = Object.entries(perName).filter(([, v]) => v.length > 1).length;
      data[name] = { path, firstFrame: r.result?.firstFrameMs, serverGetsPerAssetPath: count, serverSawMoreThanOne: dup.length, totalServerAssetGets: Object.values(count).reduce((a, b) => a + b, 0), browserRequestsPerAsset: perName, browserMadeMoreThanOne: browserDup, consoleWarnings: r.consoleWarnings, wire: wire(r.requests), browser: r.version };
      console.log(name, 'asset paths', Object.keys(count).length, 'server saw >1 GET:', dup.length, '| browser made >1 request:', browserDup, '| warnings', r.consoleWarnings?.length, '| first frame', r.result?.firstFrameMs?.toFixed(0));
    }
  }
  if (groups.has('scale')) {
    // How big can the first chunk get before the 3 s cold bar breaks on Fast 4G? Pads add copies of a 2048x2048 BC7 texture.
    for (const n of pads) await cold(`scale-pad${n}`, { path: `stage5.html?pad=${n}`, net: NET.fast4g });
    // Table over every scale-pad entry in the file (earlier invocations with --merge included).
    data.scale = Object.keys(data).filter((k) => k.startsWith('scale-pad')).map((k) => ({ pad: Number(k.slice(9)), wireBytesAllRequests: data[k].wire.bytes, median: data[k].summary.firstFrame.median, min: data[k].summary.firstFrame.min, max: data[k].summary.firstFrame.max })).sort((a, b) => a.pad - b.pad);
  }
} finally {
  mkdirSync(join(root, 'results', 'data'), { recursive: true });
  writeFileSync(outFile, JSON.stringify(data, null, 1));
  await emu.stop();
}
