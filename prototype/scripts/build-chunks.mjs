// Builds the Stage 6 chunks crate to WASM (no wasm-bindgen: plain extern "C" exports + exported memory).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'wasm');
mkdirSync(out, { recursive: true });
const targetDir = join(root, 'chunks', 'target', 'wasm');
execFileSync('cargo', ['build', '--release', '--lib', '--target', 'wasm32-unknown-unknown', '--target-dir', targetDir], {
  cwd: join(root, 'chunks'),
  stdio: 'inherit',
});
const dst = join(out, 'chunks.wasm');
copyFileSync(join(targetDir, 'wasm32-unknown-unknown', 'release', 'vessel_chunks.wasm'), dst);
console.log(`${dst}: ${statSync(dst).size} bytes`);
