// Builds the Rust sim to WASM twice: with SIMD (shipped) and without (Stage 1 comparison).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'wasm');
mkdirSync(out, { recursive: true });

for (const [name, flags] of [
  ['simd', '-C target-feature=+simd128,+bulk-memory'],
  ['nosimd', '-C target-feature=-simd128,+bulk-memory'],
]) {
  const targetDir = join(root, 'sim', 'target', name);
  execFileSync('cargo', ['build', '--release', '--lib', '--target', 'wasm32-unknown-unknown', '--target-dir', targetDir], {
    cwd: join(root, 'sim'),
    stdio: 'inherit',
    env: { ...process.env, RUSTFLAGS: flags },
  });
  const dst = join(out, `sim-${name}.wasm`);
  copyFileSync(join(targetDir, 'wasm32-unknown-unknown', 'release', 'vessel_sim.wasm'), dst);
  console.log(`${dst}: ${statSync(dst).size} bytes`);
}
