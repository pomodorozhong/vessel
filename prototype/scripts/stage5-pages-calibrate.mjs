// Calibrates the Pages emulator's gzip level against what real Pages sent (see stage5-pages-headers.mjs):
// downloads the same files uncompressed, gzips them at several levels and compares with the observed
// Content-Length of the gzip response. Writes results/data/stage5-gzip-calibration.json.
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { save } from './browser.mjs';

const observed = JSON.parse(readFileSync(fileURLToPath(new URL('../results/data/stage5-pages-headers.json', import.meta.url)), 'utf8'));
const out = [];
for (const e of observed) {
  const enc = /^content-encoding: gzip/im.test(e.headersGzipBr);
  const len = Number((e.headersGzipBr.match(/^content-length: (\d+)/im) ?? [])[1]);
  if (!enc || !(e.headersGzipBr.startsWith('HTTP/1.1 200'))) continue;
  const r = await fetch(e.url, { headers: { 'accept-encoding': 'identity' } });
  const b = Buffer.from(await r.arrayBuffer());
  const row = { url: e.url, rawBytes: b.length, observedGzipBytes: len };
  for (const l of [1, 4, 5, 6, 9]) row[`level${l}`] = gzipSync(b, { level: l }).length;
  out.push(row);
  console.log(row);
}
save(fileURLToPath(new URL('../results/data/stage5-gzip-calibration.json', import.meta.url)), out);
