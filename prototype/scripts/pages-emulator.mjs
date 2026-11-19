// A local stand-in for GitHub Pages, built from what was observed on real Pages (see
// results/data/stage5-pages-headers.json and stage5-gzip-calibration.json) and from the documented behaviour:
//   - static files only, served under /vessel/ (404 page for anything else, no directory listings)
//   - Cache-Control: max-age=600 and a matching Expires, ETag and Last-Modified, 304 on a matching validator
//   - gzip (never brotli) for a fixed list of content types, NOT for already-compressed types (png, gif,
//     pdf, gzip, video/*). Observed: application/wasm, model/gltf-binary, application/octet-stream,
//     text/*, javascript, json, svg are gzipped; they are gzipped only when the file is larger than a
//     small threshold (an 83-byte .wasm was not). Gzip level 5 matches the observed sizes within 1%.
//   - no COOP/COEP, no CORS restrictions beyond Access-Control-Allow-Origin: *
//   - "deploy" replaces the whole site directory at once; files that are not in the new build disappear.
//   - NOT emulated: Range requests, the Fastly CDN's per-edge stale copies, HTTP/2 multiplexing.
// Unobserved on real Pages: how a ".gz" file is typed (assumed application/gzip, not compressed again).
//
// CLI:  node scripts/pages-emulator.mjs --port 4175 --site <dir> [--no-wasm-gzip] [--base /vessel/]
// API:  const e = await startEmulator({ port, siteDir }); await e.deploy(buildDir); await e.stop();
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, cpSync, renameSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.gz': 'application/gzip', '.ts': 'video/mp2t', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|wasm|octet-stream|xml)|image\/svg\+xml|model\/gltf-binary)/;
const GZIP_MIN_BYTES = 150; // observed: 83 bytes was not compressed, 408 bytes was (html)
const NOT_FOUND = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page not found &middot; GitHub Pages</title></head><body><h1>404</h1><p>File not found</p></body></html>';

export async function startEmulator(opts = {}) {
  let { port = 4175, siteDir, base = '/vessel/', gzipWasm = true, log = null } = opts;
  siteDir = resolve(siteDir);
  const parent = resolve(siteDir, '..');
  mkdirSync(siteDir, { recursive: true });
  let current = siteDir; // the live directory; deploy() swaps it atomically
  let version = 0;
  const gzCache = new Map();
  const requests = []; // request log: { t, method, path, status, bytes, encoding, version }
  const state = { gzipWasm };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let status = 200, bytes = 0, encoding = '';
    const finish = () => requests.push({ t: Date.now(), method: req.method, path: url.pathname, status, bytes, encoding, version });
    res.on('close', finish);
    const send = (code, headers, body) => { status = code; res.writeHead(code, headers); bytes = body ? body.length : 0; res.end(body); };
    const notFound = () => {
      const body = Buffer.from(NOT_FOUND);
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
      encoding = gz ? 'gzip' : '';
      send(404, { 'Content-Type': 'text/html; charset=utf-8', 'Server': 'GitHub.com', 'Vary': 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) }, gz ? gzipSync(body, { level: 5 }) : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, {}, Buffer.alloc(0));
    if (!url.pathname.startsWith(base)) return notFound();
    let rel = decodeURIComponent(url.pathname.slice(base.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(current, rel));
    if (!file.startsWith(current + sep) || !existsSync(file) || !statSync(file).isFile()) return notFound();
    const st = statSync(file);
    const ext = extname(file).toLowerCase();
    const type = TYPES[ext] ?? 'application/octet-stream';
    const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const canGzip = accepts && COMPRESSIBLE.test(type) && st.size >= GZIP_MIN_BYTES && !(ext === '.wasm' && !state.gzipWasm);
    const mtime = st.mtime.toUTCString();
    const etagBase = createHash('md5').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 8) + '-' + st.size.toString(16);
    const etag = canGzip ? `W/"${etagBase}"` : `"${etagBase}"`;
    const headers = {
      'Server': 'GitHub.com', 'Content-Type': type, 'Last-Modified': mtime, 'Access-Control-Allow-Origin': '*', 'ETag': etag,
      'Expires': new Date(Date.now() + 600e3).toUTCString(), 'Cache-Control': 'max-age=600', 'Accept-Ranges': 'none', 'Vary': 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) return send(304, headers, Buffer.alloc(0));
    let body = readFileSync(file);
    if (canGzip) {
      const key = `${file}|${st.mtimeMs}`;
      if (!gzCache.has(key)) gzCache.set(key, gzipSync(body, { level: 5 }));
      body = gzCache.get(key);
      headers['Content-Encoding'] = 'gzip'; encoding = 'gzip';
    }
    headers['Content-Length'] = body.length;
    status = 200; res.writeHead(200, headers); bytes = body.length;
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', ok); });

  return {
    port, base, requests, state,
    get version() { return version; },
    get siteDir() { return current; },
    // Replaces the whole site with a copy of buildDir. The swap is one directory rename, so a request sees
    // either the old site or the new one, never a mix. The old site is deleted (as Pages does).
    async deploy(buildDir) {
      const next = join(parent, `.site-${++version}-${Date.now()}`);
      cpSync(buildDir, next, { recursive: true });
      const old = current;
      current = next; // atomic pointer swap
      log?.(`deploy #${version} from ${buildDir}`);
      if (old === siteDir && !opts.deleteInitial) return; // never delete a directory the caller gave us, unless asked
      setTimeout(() => { try { rmSync(old, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still open */ } }, 500);
    },
    async stop() { await new Promise((ok) => server.close(ok)); server.closeAllConnections?.(); if (current.includes(`${sep}.site-`)) try { rmSync(current, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const e = await startEmulator({ port: Number(arg('--port', 4175)), siteDir: arg('--site', 'dist'), base: arg('--base', '/vessel/'), gzipWasm: !process.argv.includes('--no-wasm-gzip'), log: console.log });
  console.log(`Pages emulator on http://localhost:${e.port}${e.base} serving ${e.siteDir}`);
}
void readdirSync; void renameSync;
