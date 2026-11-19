// Runs the Stage 6 property test configurations (native, release build) and saves the raw output.
// Usage: node scripts/stage6-property.mjs [cases] [threads]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cases = process.argv[2] ?? '100000';
const threads = process.argv[3] ?? '4';
const crate = join(root, 'chunks');
execFileSync('cargo', ['build', '--release', '--example', 'longrun'], { cwd: crate, stdio: 'inherit' });
const exe = join(crate, 'target', 'release', 'examples', 'longrun.exe');
mkdirSync(join(root, 'results', 'data'), { recursive: true });
const configs = (process.argv[4] ?? 'literal,f1only,f2only,nogen,nogen_nomono,dropbytick').split(',');
for (const c of configs) {
  const out = execFileSync(exe, [cases, c, threads, '1'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  writeFileSync(join(root, 'results', 'data', `stage6-property-${c}.json`), out);
  const j = JSON.parse(out);
  console.log(c, `cases=${j.cases} ops=${j.ops} mismatches=${j.mismatches} wall=${j.wall_s}s`);
  if (j.smallest) console.log(j.smallest);
}
