// Stage 5 service worker, scope /vessel/. Copied to dist/sw.js by scripts/stage5-postbuild.mjs, which
// replaces __BUILD_ID__ so every build ships a different sw.js and the browser installs it.
//  - content-hashed files: cache first, filled on first fetch; never caches a response that is not a 200
//  - html, builds.json: network first (revalidating past the 10 minute HTTP cache), cache only as the offline fallback
//  - skipWaiting() and clients.claim(), so an update never waits for every tab to close
//  - cleanup: after builds.json arrives from the network, files in no kept build (current + previous) are deleted
const BUILD_ID = '__BUILD_ID__';
const FILES = 'vessel-s5-files';
const PAGES = 'vessel-s5-pages';
const scopeUrl = new URL(self.registration.scope);
const rel = (url) => { const u = new URL(url); return u.origin === scopeUrl.origin && u.pathname.startsWith(scopeUrl.pathname) ? u.pathname.slice(scopeUrl.pathname.length) : null; };
const isHashed = (r) => /^(assets\/.+-[A-Za-z0-9_-]{8}\.\w+|[\w.-]+\.[0-9a-f]{10}\.[\w.]+)$/.test(r);
const isNetworkFirst = (r, req) => req.mode === 'navigate' || r === '' || r.endsWith('.html') || r === 'builds.json';

async function fetchManifest() {
  const res = await fetch(new URL('builds.json', scopeUrl), { cache: 'no-store' });
  if (!res.ok) throw new Error('builds.json ' + res.status);
  return res.json();
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const m = await fetchManifest();
      const cache = await caches.open(FILES);
      // Precache only the critical files. Lazy files are fetched (and then kept) on demand.
      await Promise.all((m.current.critical ?? []).map(async (f) => {
        const res = await fetch(new URL(f, scopeUrl));
        if (res.status === 200) await cache.put(new URL(f, scopeUrl), res);
      }));
    } catch (e) { /* no precache is fine: the page still works from the network */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version') event.source.postMessage({ type: 'version', buildId: BUILD_ID });
  if (event.data && event.data.type === 'cacheKeys') caches.open(FILES).then((c) => c.keys()).then((k) => event.source.postMessage({ type: 'cacheKeys', keys: k.map((r) => r.url) }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    try { await cleanup(await fetchManifest()); } catch (e) { /* offline */ }
  })());
});

async function cleanup(m) {
  const keep = new Set([...(m.current?.files ?? []), ...(m.previous?.files ?? [])].map((f) => new URL(f, scopeUrl).href));
  const cache = await caches.open(FILES);
  for (const req of await cache.keys()) {
    const u = new URL(req.url); u.search = '';
    if (!keep.has(u.href)) await cache.delete(req);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const r = rel(req.url);
  if (r === null) return;
  if (isNetworkFirst(r, req)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (r === 'builds.json' && res.status === 200) {
          const copy = res.clone();
          event.waitUntil(copy.json().then(cleanup).catch(() => {}));
        } else if (res.status === 200 && (req.mode === 'navigate' || r.endsWith('.html'))) {
          const cache = await caches.open(PAGES);
          await cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        const hit = await caches.match(req, { ignoreSearch: false });
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }
  if (isHashed(r)) {
    event.respondWith((async () => {
      const cache = await caches.open(FILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.status === 200) await cache.put(req, res.clone()); // a 404 or any other failure is never stored
      return res;
    })());
  }
});
void BUILD_ID;
