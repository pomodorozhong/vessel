// Stage 5 asset build. There is no art yet, so this generates procedural models and textures, then runs the
// real pipeline over them: pack -> meshopt -> gzip for models, BC7 (+ RDO) in KTX2 -> gzip for textures,
// every output named by a content hash.
//
//   node stage5/build-assets.mjs            writes stage5/out/ (hashed files + assets.json) and
//                                            results/data/stage5-sizes.json
//
// Procedural noise compresses differently from real art. Sizes here are for these generated assets only.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { MeshoptEncoder } from 'meshoptimizer/encoder';

const here = dirname(fileURLToPath(import.meta.url));
const proto = join(here, '..');
const OUT = join(here, 'out');
const WORK = join(here, 'work');
const LAMBDAS = [0, 1, 3]; // 0 = plain BC7, 1 and 3 = RDO strengths
const GZ = { level: 9 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);
const files = {}; // logical name -> { file, bytes }
function emit(logical, ext, buf) {
  const file = `${logical}.${hash(buf)}.${ext}`;
  writeFileSync(join(OUT, file), buf);
  files[logical] = { file, bytes: buf.length };
  return file;
}

// ---------- random + noise ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const sm = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function fbm(x, y, oct = 5, s = 0) {
  let v = 0, amp = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { v += amp * vnoise(x * f, y * f, s + i * 17); n += amp; amp *= 0.5; f *= 2; }
  return v / n;
}
function vnoise3(x, y, z, s = 0) {
  const zi = Math.floor(z), zf = sm(z - zi);
  return vnoise(x + zi * 37.1, y + zi * 11.7, s) * (1 - zf) + vnoise(x + (zi + 1) * 37.1, y + (zi + 1) * 11.7, s) * zf;
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

// ---------- textures (layered noise with structure; flat and detailed regions in the atlas) ----------
function makeTexture(name, size, pixelFn) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = pixelFn(x / size, y / size, x, y);
      const o = (y * size + x) * 4;
      px[o] = Math.round(clamp01(c[0]) * 255); px[o + 1] = Math.round(clamp01(c[1]) * 255); px[o + 2] = Math.round(clamp01(c[2]) * 255); px[o + 3] = 255;
    }
  }
  return { name, size, px };
}
const pebbles = (() => { const r = rng(7); return Array.from({ length: 260 }, () => ({ x: r(), y: r(), r: 0.004 + r() * 0.012, t: r() })); })();
function ground(u, v) {
  const patch = fbm(u * 6, v * 6, 4, 3);
  const grass = sm(clamp01((patch - 0.45) * 5));
  const dirt = mix3([0.36, 0.27, 0.18], [0.50, 0.40, 0.28], fbm(u * 24, v * 24, 5, 9));
  const green = mix3([0.20, 0.33, 0.12], [0.34, 0.50, 0.18], fbm(u * 40, v * 40, 5, 21));
  let c = mix3(dirt, green, grass);
  const ridge = 1 - Math.abs(fbm(u * 10, v * 10, 4, 33) * 2 - 1);
  c = mix3(c, [0.12, 0.09, 0.06], clamp01((ridge - 0.9) * 8) * (1 - grass * 0.7));
  for (const p of pebbles) {
    const d = Math.hypot(u - p.x, v - p.y) / p.r;
    if (d < 1) { const sh = 0.55 + 0.45 * (1 - d) - 0.25 * (u - p.x) / p.r; c = mix3(c, [0.45 * sh + p.t * 0.2, 0.43 * sh + p.t * 0.15, 0.40 * sh], 0.9); }
  }
  return c;
}
function bark(u, v) {
  const streak = fbm(u * 14, v * 1.6, 5, 5);
  const groove = 1 - Math.abs(fbm(u * 9 + streak, v * 2.2, 4, 12) * 2 - 1);
  let c = mix3([0.22, 0.14, 0.09], [0.45, 0.31, 0.20], streak);
  c = mix3(c, [0.07, 0.045, 0.03], clamp01((groove - 0.7) * 3.3));
  return mix3(c, [0.5, 0.52, 0.3], clamp01((fbm(u * 5, v * 5, 3, 44) - 0.62) * 5) * 0.5);
}
const vor = (() => { const r = rng(99); return Array.from({ length: 70 }, () => ({ x: r(), y: r(), t: r() })); })();
function rock(u, v) {
  let d1 = 9, d2 = 9, t = 0;
  for (const p of vor) for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) {
    const d = Math.hypot(u - (p.x + ox), v - (p.y + oy));
    if (d < d1) { d2 = d1; d1 = d; t = p.t; } else if (d < d2) d2 = d;
  }
  const edge = clamp01((d2 - d1) * 40);
  let c = mix3([0.30, 0.30, 0.32], [0.55, 0.54, 0.52], fbm(u * 30, v * 30, 5, 2) * 0.7 + t * 0.3);
  c = mix3([0.08, 0.08, 0.09], c, edge);
  return mix3(c, [0.28, 0.42, 0.18], clamp01((fbm(u * 8, v * 8, 4, 61) - 0.58) * 6) * 0.6);
}
function atlas(u, v) {
  const tx = Math.floor(u * 4), ty = Math.floor(v * 4), lu = u * 4 - tx, lv = v * 4 - ty, k = ty * 4 + tx;
  switch (k % 8) {
    case 0: return lu > 0.15 && lu < 0.6 && lv > 0.2 && lv < 0.7 ? [0.85, 0.7, 0.2] : [0.6, 0.15, 0.12]; // flat with a rectangle
    case 1: return mix3([0.1, 0.2, 0.5], [0.6, 0.8, 0.95], lv); // gradient
    case 2: return mix3([0.4, 0.3, 0.5], [0.8, 0.7, 0.6], fbm(lu * 18, lv * 18, 6, 14 + k)); // cloth, detailed
    case 3: { const row = Math.floor(lv * 8), off = (row % 2) * 0.5; const bx = (lu * 4 + off) % 1; const m = bx < 0.06 || (lv * 8) % 1 < 0.08; return m ? [0.75, 0.72, 0.66] : mix3([0.55, 0.22, 0.16], [0.7, 0.35, 0.22], hash2(Math.floor(lu * 4 + off), row, k)); } // bricks
    case 4: return [0.18, 0.32, 0.24]; // flat
    case 5: { const g = fbm(lu * 3, lv * 40, 5, 70 + k); return mix3([0.5, 0.33, 0.18], [0.72, 0.52, 0.3], g); } // wood grain
    case 6: { const s = Math.floor(lu * 12) % 2; return s ? [0.85, 0.85, 0.88] : [0.15, 0.15, 0.18]; } // hard stripes
    default: { const c = mix3([0.5, 0.5, 0.55], [0.75, 0.76, 0.8], fbm(lu * 6, lv * 6, 3, 90)); const scratch = Math.abs(Math.sin((lu + lv * 0.3) * 160 + fbm(lu * 4, lv * 4, 2, 3) * 20)) > 0.985; return scratch ? [0.95, 0.95, 0.97] : c; } // metal
  }
}
const TEXTURES = [
  ['ground1024', 1024, ground], ['bark1024', 1024, bark], ['rock1024', 1024, rock], ['atlas2048', 2048, atlas],
];

// ---------- models ----------
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function surface(nu, nv, fn, uvRect, wrapU = true) {
  const pos = [], nor = [], uv = [], idx = [];
  const e = 1e-3;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv, p = fn(u, v);
    const pu = sub(fn(Math.min(1, u + e), v), fn(Math.max(0, u - e), v));
    const pv = sub(fn(u, Math.min(1, v + e)), fn(u, Math.max(0, v - e)));
    let n = cross(pu, pv);
    if (Math.hypot(...n) < 1e-9) n = [0, j < nv / 2 ? 1 : -1, 0];
    pos.push(p); nor.push(norm(n)); uv.push([uvRect[0] + u * uvRect[2], uvRect[1] + v * uvRect[3]]);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  return { pos, nor, uv, idx };
}
const spheroid = (c, r, noiseAmp = 0, seed = 0, noiseFreq = 2) => (u, v) => {
  const th = v * Math.PI, ph = u * Math.PI * 2;
  let d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
  const k = noiseAmp ? 1 + noiseAmp * (vnoise3(d[0] * noiseFreq + 5, d[1] * noiseFreq + 5, d[2] * noiseFreq + 5, seed) * 2 - 1) : 1;
  return [c[0] + d[0] * r[0] * k, c[1] + d[1] * r[1] * k, c[2] + d[2] * r[2] * k];
};
const tube = (a, b, ra, rb, wob = 0, seed = 0) => (u, v) => {
  const ph = u * Math.PI * 2, r = mix(ra, rb, v) * (1 + (wob ? wob * (vnoise(Math.cos(ph) * 3 + 9, v * 6 + Math.sin(ph) * 3, seed) - 0.5) : 0));
  const ax = sub(b, a), len = Math.hypot(...ax), w = norm(ax);
  const t = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], s = norm(cross(w, t)), q = cross(w, s);
  return [a[0] + ax[0] * v + (s[0] * Math.cos(ph) + q[0] * Math.sin(ph)) * r, a[1] + ax[1] * v + (s[1] * Math.cos(ph) + q[1] * Math.sin(ph)) * r, a[2] + ax[2] * v + (s[2] * Math.cos(ph) + q[2] * Math.sin(ph)) * r];
};
// Analytic sphere-occluder AO per vertex: parts are approximated by spheres. Cheap, smooth, plausible 8-bit data.
function bakeAo(parts, spheres) {
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    part.ao = part.pos.map((p, i) => {
      const n = part.nor[i];
      let occ = 0;
      spheres.forEach((s, si) => {
        if (si === pi) return;
        const d = sub(s.c, p), dist = Math.hypot(...d), w = Math.max(0, (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / (dist || 1));
        occ += (s.r * s.r) / (dist * dist + 1e-4) * w;
      });
      const sky = 0.6 + 0.4 * (n[1] * 0.5 + 0.5);
      return clamp01(sky * (1 - Math.min(0.7, occ)));
    });
  }
}
function merge(parts) {
  const m = { pos: [], nor: [], uv: [], ao: [], idx: [] };
  for (const p of parts) {
    const base = m.pos.length;
    m.pos.push(...p.pos); m.nor.push(...p.nor); m.uv.push(...p.uv); m.ao.push(...(p.ao ?? p.pos.map(() => 1)));
    for (const i of p.idx) m.idx.push(base + i);
  }
  return m;
}
function character() {
  const parts = [], sph = [];
  const add = (s, c, r) => { parts.push(s); sph.push({ c, r }); };
  add(surface(40, 28, spheroid([0, 1.62, 0], [0.16, 0.19, 0.17], 0.05, 1), [0.0, 0.0, 0.25, 0.25]), [0, 1.62, 0], 0.19);
  add(surface(48, 36, tube([0, 0.95, 0], [0, 1.45, 0], 0.17, 0.22, 0.06, 2), [0.25, 0, 0.25, 0.5]), [0, 1.2, 0], 0.3);
  add(surface(24, 20, tube([-0.28, 1.4, 0], [-0.5, 0.95, 0.1], 0.06, 0.05, 0.1, 3), [0.5, 0, 0.25, 0.25]), [-0.4, 1.2, 0.05], 0.2);
  add(surface(24, 20, tube([0.28, 1.4, 0], [0.5, 0.95, 0.1], 0.06, 0.05, 0.1, 4), [0.5, 0.25, 0.25, 0.25]), [0.4, 1.2, 0.05], 0.2);
  add(surface(24, 20, tube([-0.1, 0.95, 0], [-0.12, 0.05, 0], 0.09, 0.06, 0.1, 5), [0.75, 0, 0.25, 0.25]), [-0.11, 0.5, 0], 0.3);
  add(surface(24, 20, tube([0.1, 0.95, 0], [0.12, 0.05, 0], 0.09, 0.06, 0.1, 6), [0.75, 0.25, 0.25, 0.25]), [0.11, 0.5, 0], 0.3);
  bakeAo(parts, sph);
  return merge(parts);
}
function tree() {
  const parts = [], sph = [];
  const add = (s, c, r) => { parts.push(s); sph.push({ c, r }); };
  add(surface(20, 24, tube([0, 0, 0], [0, 1.6, 0], 0.22, 0.1, 0.35, 11), [0, 0, 1, 1]), [0, 0.8, 0], 0.4);
  add(surface(32, 24, spheroid([0, 1.9, 0], [0.9, 0.7, 0.9], 0.35, 12, 2.2), [0, 0, 1, 1]), [0, 1.9, 0], 0.9);
  add(surface(32, 24, spheroid([0, 2.6, 0], [0.7, 0.55, 0.7], 0.35, 13, 2.2), [0, 0, 1, 1]), [0, 2.6, 0], 0.7);
  add(surface(32, 24, spheroid([0, 3.2, 0], [0.45, 0.45, 0.45], 0.35, 14, 2.2), [0, 0, 1, 1]), [0, 3.2, 0], 0.45);
  bakeAo(parts, sph);
  return merge(parts);
}
function rockModel() {
  const s = surface(48, 36, (u, v) => { const p = spheroid([0, 0.4, 0], [0.8, 0.5, 0.65], 0.55, 21, 1.8)(u, v); p[1] = Math.max(p[1], 0.02); return p; }, [0, 0, 1, 1]);
  bakeAo([s], [{ c: [0, 0.4, 0], r: 0.6 }]);
  return merge([s]);
}

// Packed binary format (all little endian). Header 48 bytes:
//   u32 magic ('VMS1' raw / 'VMO1' meshopt), u32 vertexCount, u32 indexCount, u32 stride (16),
//   u32 vertexBytes, u32 indexBytes  (stored lengths of the two sections: raw or meshopt-encoded),
//   f32 center[3], f32 half[3]       (positions are snorm16 relative to the bounding box)
// Vertex (16 bytes): i16 x,y,z, i16 pad | u16 u, u16 v | i8 nx, ny, nz, ao (ao 0..127 in the w byte)
// Indices: u16.
function pack(m) {
  const n = m.pos.length;
  const mn = [1e9, 1e9, 1e9], mxv = [-1e9, -1e9, -1e9];
  for (const p of m.pos) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mxv[k] = Math.max(mxv[k], p[k]); }
  const center = mn.map((v, k) => (v + mxv[k]) / 2), half = mn.map((v, k) => Math.max(1e-4, (mxv[k] - v) / 2));
  const vb = Buffer.alloc(n * 16), dv = new DataView(vb.buffer, vb.byteOffset, vb.byteLength);
  for (let i = 0; i < n; i++) {
    const o = i * 16, p = m.pos[i], nn = m.nor[i];
    for (let k = 0; k < 3; k++) dv.setInt16(o + k * 2, Math.round(clamp01((p[k] - center[k]) / half[k] * 0.5 + 0.5) * 65535 - 32768), true);
    dv.setUint16(o + 8, Math.round(clamp01(m.uv[i][0]) * 65535), true);
    dv.setUint16(o + 10, Math.round(clamp01(m.uv[i][1]) * 65535), true);
    for (let k = 0; k < 3; k++) dv.setInt8(o + 12 + k, Math.round(nn[k] * 127));
    dv.setInt8(o + 15, Math.round(m.ao[i] * 127));
  }
  return { vb, idx: Uint32Array.from(m.idx), n, center, half };
}
function header(magic, n, ni, vlen, ilen, center, half) {
  const h = Buffer.alloc(48);
  h.write(magic, 0, 'latin1');
  h.writeUInt32LE(n, 4); h.writeUInt32LE(ni, 8); h.writeUInt32LE(16, 12); h.writeUInt32LE(vlen, 16); h.writeUInt32LE(ilen, 20);
  center.forEach((v, k) => h.writeFloatLE(v, 24 + k * 4)); half.forEach((v, k) => h.writeFloatLE(v, 36 + k * 4));
  return h;
}
await MeshoptEncoder.ready;
function buildModel(name, m, texName) {
  const p = pack(m);
  // Raw packed and gzip-only (no meshopt) use the input order; meshopt uses the cache-optimized order.
  const i16 = Buffer.alloc(p.idx.length * 2);
  p.idx.forEach((v, k) => i16.writeUInt16LE(v, k * 2));
  const rawPacked = Buffer.concat([header('VMS1', p.n, p.idx.length, p.vb.length, i16.length, p.center, p.half), p.vb, i16]);
  const gzipOnly = gzipSync(rawPacked, GZ);

  const idx = Uint32Array.from(p.idx);
  const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, false);
  const vb2 = Buffer.alloc(unique * 16);
  for (let old = 0; old < p.n; old++) if (remap[old] !== 0xffffffff && remap[old] < unique) p.vb.copy(vb2, remap[old] * 16, old * 16, old * 16 + 16);
  const ib = new Uint8Array(idx.length * 2), ibv = new DataView(ib.buffer);
  idx.forEach((v, k) => ibv.setUint16(k * 2, v, true));
  const evb = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(vb2), unique, 16);
  const eib = MeshoptEncoder.encodeIndexBuffer(ib, idx.length, 2);
  const meshoptBuf = Buffer.concat([header('VMO1', unique, idx.length, evb.length, eib.length, p.center, p.half), evb, eib]);
  const meshoptGz = gzipSync(meshoptBuf, GZ);
  const file = emit(`${name}.mesh`, 'bin.gz', meshoptGz); // shipped form
  return { name, texture: texName, vertices: p.n, uniqueVerticesAfterReorder: unique, indices: idx.length, rawPackedBytes: rawPacked.length, meshoptBytes: meshoptBuf.length, meshoptGzipBytes: meshoptGz.length, gzipOnlyBytes: gzipOnly.length, file };
}
const models = [
  buildModel('character', character(), 'atlas2048'),
  buildModel('tree', tree(), 'bark1024'),
  buildModel('rock', rockModel(), 'rock1024'),
];
console.log('models', models.map((m) => `${m.name}: ${m.vertices}v raw ${m.rawPackedBytes} meshopt ${m.meshoptBytes} meshopt+gz ${m.meshoptGzipBytes} gz-only ${m.gzipOnlyBytes}`).join('\n  '));

// ---------- textures ----------
const bc7tool = join(here, 'tools', 'bc7tool', 'target', 'release', process.platform === 'win32' ? 'bc7tool.exe' : 'bc7tool');
if (!existsSync(bc7tool)) execFileSync('cargo', ['build', '--release'], { cwd: join(here, 'tools', 'bc7tool'), stdio: 'inherit' });
const runTool = (args) => new Promise((resolve, reject) => {
  const c = spawn(bc7tool, args, { env: { ...process.env, RUST_MIN_STACK: '536870912' } }), out = [];
  c.stdout.on('data', (d) => out.push(d));
  c.stderr.on('data', (d) => process.stderr.write(d));
  c.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString().trim().split('\n').map((l) => JSON.parse(l))) : reject(new Error(`bc7tool exit ${code}`))));
});
const texJobs = TEXTURES.map(async ([name, size, fn]) => {
  const t0 = Date.now();
  const tex = makeTexture(name, size, fn);
  const hdr = Buffer.alloc(8); hdr.writeUInt32LE(size, 0); hdr.writeUInt32LE(size, 4);
  writeFileSync(join(WORK, `${name}.rgba`), Buffer.concat([hdr, tex.px]));
  const genMs = Date.now() - t0;
  const results = await runTool([join(WORK, `${name}.rgba`), join(WORK, name), LAMBDAS.join(',')]);
  return { name, size, genMs, results };
});
const texResults = await Promise.all(texJobs);
const textures = [];
for (const t of texResults) {
  const entry = { name: t.name, size: t.size, generateMs: t.genMs, rgba8: null, bc7: [] };
  const fb = readFileSync(join(WORK, `${t.name}.rgba8`));
  const fbGz = gzipSync(fb, GZ);
  entry.rgba8 = { rawBytes: fb.length, gzipBytes: fbGz.length, file: emit(`${t.name}.rgba8`, 'bin.gz', fbGz) };
  for (const r of t.results) {
    const raw = readFileSync(r.file);
    const gz = gzipSync(raw, GZ);
    entry.bc7.push({ lambda: r.lambda, ktx2Bytes: raw.length, gzipBytes: gz.length, psnrRgbDb: r.psnrRgbDb, encodeSecs: r.encodeSecs, effort: r.effort, levels: r.levels, file: emit(`${t.name}.bc7-l${r.lambda}`, 'ktx2.gz', gz) });
  }
  textures.push(entry);
  console.log(t.name, entry.bc7.map((b) => `l${b.lambda}: ${b.ktx2Bytes}->gz ${b.gzipBytes} ${b.psnrRgbDb}dB`).join(' | '), `rgba8 ${entry.rgba8.rawBytes}->gz ${entry.rgba8.gzipBytes}`);
}

// ---------- wasm: plain and pre-gzipped ----------
const wasmSrc = join(proto, 'src', 'wasm', 'sim-simd.wasm');
if (!existsSync(wasmSrc)) throw new Error('src/wasm/sim-simd.wasm is missing: run `pnpm run wasm` first');
const wasm = readFileSync(wasmSrc), wasmGz = gzipSync(wasm, GZ);
const wasmHash = hash(wasm);
writeFileSync(join(OUT, `sim.${wasmHash}.wasm`), wasm); files['sim.wasm'] = { file: `sim.${wasmHash}.wasm`, bytes: wasm.length };
writeFileSync(join(OUT, `sim.${wasmHash}.wasm.gz`), wasmGz); files['sim.wasm.gz'] = { file: `sim.${wasmHash}.wasm.gz`, bytes: wasmGz.length };

// ---------- manifest ----------
const SHIPPED_LAMBDA = 1;
const pick = (texName, lambda = SHIPPED_LAMBDA) => textures.find((t) => t.name === texName).bc7.find((b) => b.lambda === lambda);
const manifest = {
  generatedAt: new Date().toISOString(),
  wasm: { plain: files['sim.wasm'].file, gz: files['sim.wasm.gz'].file, plainBytes: wasm.length, gzBytes: wasmGz.length },
  models: models.map((m) => ({ name: m.name, file: m.file, texture: m.texture, vertices: m.vertices, indices: m.indices })),
  textures: textures.map((t) => ({ name: t.name, size: t.size, rgba8: t.rgba8.file, bc7: Object.fromEntries(t.bc7.map((b) => [`l${b.lambda}`, b.file])) })),
  shippedLambda: SHIPPED_LAMBDA,
  // The first chunk: what the page needs to draw its first frame (shipped RDO strength).
  firstChunk: ['character', 'tree', 'rock'].map((n) => models.find((m) => m.name === n).file)
    .concat(['atlas2048', 'bark1024', 'rock1024', 'ground1024'].map((n) => pick(n).file)),
  // Larger texture used only to pad the first chunk in the "how big can it get" test.
  padFile: pick('atlas2048').file,
};
writeFileSync(join(OUT, 'assets.json'), JSON.stringify(manifest, null, 1));

const sizes = {
  measuredAt: new Date().toISOString(),
  note: 'Procedural assets: noise-based textures and generated meshes. Sizes for real art will differ. Gzip level 9 (node zlib). BC7 by mipple 0.9.102 (CPU, effort 5), PSNR is RGB of mip level 0 vs the source.',
  models, textures, wasm: manifest.wasm,
  firstChunkBytes: manifest.firstChunk.map((f) => ({ file: f, bytes: statSync(join(OUT, f)).size })),
};
mkdirSync(join(proto, 'results', 'data'), { recursive: true });
writeFileSync(join(proto, 'results', 'data', 'stage5-sizes.json'), JSON.stringify(sizes, null, 1));
console.log('first chunk bytes', sizes.firstChunkBytes.reduce((a, b) => a + b.bytes, 0), 'files in out:', readdirSync(OUT).length);
