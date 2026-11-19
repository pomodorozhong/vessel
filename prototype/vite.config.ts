import { defineConfig } from 'vite';

// COOP/COEP are sent only by the local dev/preview server, and only so that
// performance.now() has 5 µs resolution for measurements. The prototype never
// uses SharedArrayBuffer, because GitHub Pages cannot send these headers.
const isolate = process.env.VESSEL_ISOLATE === '0' ? {} : {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: '/vessel/',
  build: { target: 'es2022', assetsInlineLimit: 0, rollupOptions: { input: { main: 'index.html', stage5: 'stage5.html' } } }, // stage5.html: Stage 5 startup/hosting page
  define: { __BUILD_TAG__: JSON.stringify(process.env.VESSEL_BUILD_TAG ?? 'dev') }, // Stage 5: differs per build so chunk hashes differ
  worker: { format: 'es' },
  server: { headers: isolate },
  preview: { headers: isolate },
});
