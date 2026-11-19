// Runs after `vite build` for the Stage 5 page: copies the hashed assets into dist/a/, writes the lazy files,
// fills the config and preload tags into stage5.html (three variants), stamps and copies the service worker,
// and writes builds.json (current build only; stage5-keep-previous.mjs adds the previous build).
//
//   node scripts/stage5-postbuild.mjs [--dist dist] [--tag <build tag>]
import { createHash, randomFillSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const dist = resolve(root, arg('--dist', 'dist'));
const tag = arg('--tag', process.env.VESSEL_BUILD_TAG ?? 'dev');
const BASE = '/vessel/';
const out = join(root, 'stage5', 'out');
if (!existsSync(join(out, 'assets.json'))) throw new Error('stage5/out/assets.json is missing: run node stage5/build-assets.mjs');
const A = JSON.parse(readFileSync(join(out, 'assets.json'), 'utf8'));

// 1. Assets -> dist/a/
mkdirSync(join(dist, 'a'), { recursive: true });
for (const f of readdirSync(out)) if (f !== 'assets.json') cpSync(join(out, f), join(dist, 'a', f));

// 2. Lazy files: different content (so a different hash) in every build tag.
const lazyFiles = [];
for (let i = 0; i < 6; i++) {
  const buf = Buffer.alloc(24 * 1024);
  let seed = createHash('sha256').update(`${tag}:${i}`).digest();
  for (let o = 0; o < buf.length; o += 32) { seed = createHash('sha256').update(seed).digest(); seed.copy(buf, o); }
  const gz = gzipSync(buf);
  const name = `lazy${i}.${createHash('sha256').update(gz).digest('hex').slice(0, 10)}.bin.gz`;
  writeFileSync(join(dist, 'a', name), gz);
  lazyFiles.push('a/' + name);
}

// 3. File lists. Hashed files only; html, sw.js and builds.json are not hashed.
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const hashedFiles = [...walk(join(dist, 'assets')), ...walk(join(dist, 'a'))].map((p) => relative(dist, p).replaceAll('\\', '/')).sort();
const p = (f) => 'a/' + f;
const firstChunk = A.firstChunk.map(p);
let html = readFileSync(join(dist, 'stage5.html'), 'utf8');
const referenced = [...html.matchAll(/\/vessel\/(assets\/[^"'\s)]+)/g)].map((m) => m[1]);
const critical = [...new Set([...referenced, ...hashedFiles.filter((f) => /assets\/.*worker/.test(f)), ...firstChunk, p(A.wasm.gz)])].sort();
const id = createHash('sha256').update(hashedFiles.join('\n')).digest('hex').slice(0, 8);

// 4. stage5.html variants
const config = {
  base: BASE, tag, buildId: id, wasm: { plain: p(A.wasm.plain), gz: p(A.wasm.gz) }, firstChunk, padFile: p(A.padFile),
  models: A.models.map((m) => ({ ...m, file: p(m.file) })),
  textures: A.textures.map((t) => ({ name: t.name, size: t.size, rgba8: p(t.rgba8), bc7: Object.fromEntries(Object.entries(t.bc7).map(([k, v]) => [k, p(v)])) })),
  lazyFiles, shippedLambda: A.shippedLambda,
};
const preloads = (wasmFile, cors) => [wasmFile, ...firstChunk].map((f) => `  <link rel="preload" as="fetch"${cors ? ' crossorigin' : ''} href="${BASE}${f}">`).join('\n');
const make = (name, wasmFile, cors) => {
  const o = html.replace('<!--S5_PRELOADS-->', preloads(wasmFile, cors)).replace('/*S5_CONFIG*/{}', JSON.stringify(config));
  if (o === html) throw new Error('placeholders not found in stage5.html (did Vite change the page?)');
  writeFileSync(join(dist, name), o);
};
make('stage5.html', p(A.wasm.gz), true);
make('stage5-plain.html', p(A.wasm.plain), true);
make('stage5-nocors.html', p(A.wasm.gz), false); // negative control: a preload without crossorigin downloads twice

// 5. Service worker and manifest
writeFileSync(join(dist, 'sw.js'), readFileSync(join(root, 'stage5', 'sw.js'), 'utf8').replaceAll('__BUILD_ID__', id));
writeFileSync(join(dist, 'builds.json'), JSON.stringify({ version: 1, current: { id, tag, files: hashedFiles, critical }, previous: null }, null, 1));
console.log(`stage5 postbuild: tag=${tag} id=${id} hashed files=${hashedFiles.length} critical=${critical.length}`);
void randomFillSync;
