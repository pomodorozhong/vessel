// Records what real GitHub Pages sends for the file types we ship, using curl -sI against public sites.
// Usage: node scripts/stage5-pages-headers.mjs [extra urls]   (needs curl on PATH).
// Writes results/data/stage5-pages-headers.json.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { save } from './browser.mjs';

const urls = [
  'https://mozilla.github.io/pdf.js/web/wasm/openjpeg.wasm',
  'https://mozilla.github.io/pdf.js/build/pdf.mjs',
  'https://mozilla.github.io/pdf.js/web/viewer.css',
  'https://mozilla.github.io/pdf.js/web/locale/en-US/viewer.ftl', // unknown extension, served as application/octet-stream
  'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf',
  'https://mdn.github.io/webassembly-examples/js-api-examples/simple.wasm', // tiny: shows no gzip below a size threshold
  'https://kripken.github.io/ammo.js/builds/ammo.wasm.wasm',
  'https://webgpu.github.io/webgpu-samples/assets/gltf/whale.glb', // binary model
  'https://webgpu.github.io/webgpu-samples/assets/img/Di-3d.png', // already-compressed image
  'https://webgpu.github.io/webgpu-samples/sample/helloTriangle/main.ts', // mapped to video/mp2t by Pages
  'https://mozilla.github.io/pdf.js/web/images/loading-icon.gif',
  ...process.argv.slice(2),
];
const head = (u, enc) => execFileSync('curl', ['-sI', '--max-time', '30', '-H', `Accept-Encoding: ${enc}`, u], { encoding: 'utf8' }).replace(/\r/g, '');
const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
const size = (u) => execFileSync('curl', ['-s', '--max-time', '60', '-H', 'Accept-Encoding: identity', '-o', nul, '-w', '%{size_download}', u], { encoding: 'utf8' });
const pick = (h, k) => (h.match(new RegExp(`^${k}: (.*)$`, 'im')) ?? [])[1];
const out = [];
for (const url of urls) {
  const e = { url, measuredAt: new Date().toISOString() };
  e.headersGzipBr = head(url, 'gzip, br');
  e.headersIdentity = head(url, 'identity');
  e.identityBytes = Number(size(url));
  out.push(e);
  const h = e.headersGzipBr;
  console.log(url, '|', h.split('\n')[0], '| type', pick(h, 'content-type'), '| enc', pick(h, 'content-encoding'), '| len', pick(h, 'content-length'), '| identity bytes', e.identityBytes, '| cc', pick(h, 'cache-control'));
}
save(fileURLToPath(new URL('../results/data/stage5-pages-headers.json', import.meta.url)), out);
