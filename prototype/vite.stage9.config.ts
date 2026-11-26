// Builds only the Stage 9 page (no WASM sim and no chunk crates needed) into dist-stage9/ (gitignored).
// Used for the Stage 9 measurement runs and smoke tests:
//   node node_modules/vite/bin/vite.js build -c vite.stage9.config.ts
//   node node_modules/vite/bin/vite.js preview -c vite.stage9.config.ts --port 4183 --strictPort
import { defineConfig } from 'vite';

// The same headers as vite.config.ts: only so that performance.now() has 5 µs resolution.
const isolate = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  base: '/vessel/',
  build: { target: 'es2022', assetsInlineLimit: 0, outDir: 'dist-stage9', emptyOutDir: true, rollupOptions: { input: { stage9: 'stage9.html' } } },
  worker: { format: 'es' },
  server: { headers: isolate },
  preview: { headers: isolate },
});
