// Keeps the previous build's hashed files available after a Pages deploy (which replaces the whole site).
// Run after the build and stage5-postbuild.mjs, before the artifact is uploaded:
//
//   node scripts/stage5-keep-previous.mjs --dist dist --site https://<owner>.github.io/vessel/
//
// 1. fetch <site>/builds.json (the live manifest); only a 404 means "no previous build" (first deploy)
// 2. download the live build's hashed files into dist/ (files the new build already has are skipped)
// 3. write dist/builds.json = { current: <this build>, previous: <the live build> }. Builds older than that are
//    dropped: they are not in the new manifest and their files are not copied.
// Fails the deploy (exit 1) when the live site cannot be read for any reason other than a 404, or when one of
// the previous build's files cannot be downloaded: publishing without them would break tabs that are already
// open. --allow-missing turns both into warnings, for the case where the live site is known to be broken.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const dist = arg('--dist', 'dist');
let site = arg('--site', '');
if (!site) { console.log('keep-previous: no --site given, writing a manifest without a previous build'); }
if (site && !site.endsWith('/')) site += '/';

const manifestPath = join(dist, 'builds.json');
const mine = JSON.parse(readFileSync(manifestPath, 'utf8'));
const stats = { site, liveFound: false, liveId: null, downloaded: 0, skipped: 0, failed: [], bytes: 0 };

async function get(path, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      // The query string is a cache buster: Pages' CDN may serve a stale copy of a URL for up to ~10 minutes.
      const r = await fetch(`${site}${path}${path === 'builds.json' ? `?cb=${Date.now()}` : ''}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (r.status === 404) return { status: 404 };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { status: 200, body: Buffer.from(await r.arrayBuffer()) };
    } catch (e) { last = e; await new Promise((ok) => setTimeout(ok, 500 * (i + 1))); }
  }
  throw last;
}

let previous = null;
if (site) {
  try {
    const r = await get('builds.json');
    if (r.status === 200) {
      const live = JSON.parse(r.body.toString('utf8'));
      if (!live?.current?.files) throw new Error('live builds.json has no current.files');
      stats.liveFound = true; stats.liveId = live.current.id;
      // Redeploying the same build: the one to keep is the live site's previous build.
      const keep = live.current.id === mine.current.id ? live.previous : live.current;
      if (keep) {
        const kept = [];
        for (const f of keep.files) {
          const dst = join(dist, f);
          if (existsSync(dst)) { stats.skipped++; kept.push(f); continue; }
          try {
            const g = await get(f);
            if (g.status !== 200) { stats.failed.push(`${f}: HTTP ${g.status}`); continue; }
            mkdirSync(dirname(dst), { recursive: true });
            writeFileSync(dst, g.body);
            stats.downloaded++; stats.bytes += g.body.length; kept.push(f);
          } catch (e) { stats.failed.push(`${f}: ${e.message}`); }
        }
        previous = { id: keep.id, tag: keep.tag, files: kept };
      }
    } else {
      console.log('keep-previous: no live builds.json (HTTP 404): first deploy, or the site does not exist yet');
    }
  } catch (e) {
    stats.error = String(e);
    // Only a 404 means "no previous build". Anything else (outage, timeout, bad JSON) would publish a site
    // without the previous build's files and break tabs that are already open, so the deploy stops here.
    console.error(`keep-previous: could not read the live site (${e.message}); refusing to deploy without the previous build. Rerun the deploy, or pass --allow-missing to go on without it.`);
    if (!process.argv.includes('--allow-missing')) process.exit(1);
  }
}
writeFileSync(manifestPath, JSON.stringify({ version: 1, current: mine.current, previous }, null, 1));
console.log('keep-previous:', JSON.stringify(stats), 'previous =', previous ? `${previous.id} (${previous.files.length} files)` : 'none');
if (stats.failed.length) {
  console.error('keep-previous: some previous files could not be downloaded:\n  ' + stats.failed.join('\n  '));
  if (!process.argv.includes('--allow-missing')) process.exit(1);
}
