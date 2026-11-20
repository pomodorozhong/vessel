// Builds the Stage 8 combat sims to WASM, with simd128 and bulk-memory, in release mode:
//   combat/        -> src/wasm/combat.wasm         (pair finding methods A, B and C)
//   combat-rapier/ -> src/wasm/combat-rapier.wasm  (the same scene on Rapier 2D)
// No --allow-undefined or other linker workarounds: the only import is env.now, named in the source.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'wasm');
mkdirSync(out, { recursive: true });

for (const [dir, artifact, name] of [
  ['combat', 'vessel_combat', 'combat'],
  ['combat-rapier', 'vessel_combat_rapier', 'combat-rapier'],
]) {
  const cwd = join(root, dir);
  execFileSync('cargo', ['build', '--release', '--lib', '--target', 'wasm32-unknown-unknown', '--target-dir', join(cwd, 'target')], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128,+bulk-memory' },
  });
  const dst = join(out, `${name}.wasm`);
  copyFileSync(join(cwd, 'target', 'wasm32-unknown-unknown', 'release', `${artifact}.wasm`), dst);
  console.log(`${dst}: ${statSync(dst).size} bytes`);
}
