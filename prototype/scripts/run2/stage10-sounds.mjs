// Stage 10: generates the placeholder sounds (no downloads) and encodes them with ffmpeg (build-time tool only).
// Output (committed, small): public/stage10/sfx.ogg (mono, all takes in one Ogg Opus file), music.ogg (stereo, the
// layer loops end to end) and manifest.json (offsets in samples at 48 kHz). Deterministic: a seeded PRNG.
// Usage: node scripts/run2/stage10-sounds.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'public', 'stage10');
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'stage10-'));

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const N = (sec) => Math.max(1, Math.round(sec * SR));
const TAU = Math.PI * 2;

// ---- building blocks: every one adds into a Float32Array `out` starting at `at` seconds ----
function noiseBurst(out, r, at, dur, amp, { hp = 0, lp = 1, decay = 4 } = {}) {
  // hp, lp: one-pole coefficients in 0..1 (hp = amount of low end removed, lp = 1 means open)
  const n = N(dur), a = N(at); let lpS = 0, hpS = 0;
  for (let i = 0; i < n && a + i < out.length; i++) {
    const t = i / n, w = r() * 2 - 1;
    lpS += (w - lpS) * lp; hpS += (lpS - hpS) * (hp || 1); const s = hp ? lpS - hpS : lpS;
    out[a + i] += s * amp * Math.exp(-decay * t) * Math.min(1, i / 24);
  }
}
function sweep(out, at, dur, f0, f1, amp, { decay = 4, shape = 'sine', drive = 0 } = {}) {
  const n = N(dur), a = N(at); let ph = 0;
  for (let i = 0; i < n && a + i < out.length; i++) {
    const t = i / n, f = f0 * Math.pow(f1 / f0, t); ph += f / SR;
    let s = shape === 'sine' ? Math.sin(TAU * ph) : shape === 'square' ? (Math.sin(TAU * ph) > 0 ? 0.6 : -0.6) : 2 * (ph % 1) - 1;
    if (drive) s = Math.tanh(s * (1 + drive));
    out[a + i] += s * amp * Math.exp(-decay * t) * Math.min(1, i / 12);
  }
}
function whoosh(out, r, at, dur, f0, f1, amp) { // noise through a one-pole whose cutoff sweeps
  const n = N(dur), a = N(at); let s = 0;
  for (let i = 0; i < n && a + i < out.length; i++) {
    const t = i / n, f = f0 * Math.pow(f1 / f0, t), k = 1 - Math.exp(-TAU * f / SR);
    s += ((r() * 2 - 1) - s) * k;
    out[a + i] += s * amp * Math.sin(Math.PI * t) ** 1.5 * 3;
  }
}
function finish(out, peak) { // fade the last 8 ms and normalise
  const f = N(0.008); for (let i = 0; i < f; i++) out[out.length - 1 - i] *= i / f;
  let m = 0; for (const v of out) m = Math.max(m, Math.abs(v)); const g = m > 0 ? peak / m : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

// ---- the sound set: layered transient + body + tail, each with several takes ----
const jit = (r, v) => 1 + (r() - 0.5) * 2 * v;
const RECIPES = {
  shoot: { takes: 4, make: (r) => { const o = new Float32Array(N(0.22)), p = jit(r, 0.08);
    noiseBurst(o, r, 0, 0.012, 0.9, { hp: 0.05, decay: 5 }); sweep(o, 0, 0.1, 1100 * p, 220 * p, 0.8, { decay: 5, shape: 'saw', drive: 2 });
    sweep(o, 0.004, 0.16, 520 * p, 130 * p, 0.5, { decay: 4 }); noiseBurst(o, r, 0.01, 0.2, 0.25, { lp: 0.25, decay: 6 }); return finish(o, 0.9); } },
  dash: { takes: 3, make: (r) => { const o = new Float32Array(N(0.3)), p = jit(r, 0.1);
    whoosh(o, r, 0, 0.28, 300 * p, 4200 * p, 0.8); sweep(o, 0, 0.2, 140 * p, 420 * p, 0.35, { decay: 3 }); return finish(o, 0.85); } },
  eshoot: { takes: 3, make: (r) => { const o = new Float32Array(N(0.16)), p = jit(r, 0.1);
    sweep(o, 0, 0.12, 640 * p, 300 * p, 0.7, { decay: 5, shape: 'square' }); noiseBurst(o, r, 0, 0.008, 0.5, { hp: 0.1, decay: 5 }); return finish(o, 0.8); } },
  hit_s: { takes: 4, make: (r) => { const o = new Float32Array(N(0.16)), p = jit(r, 0.12);
    noiseBurst(o, r, 0, 0.006, 1, { hp: 0.08, decay: 4 }); sweep(o, 0, 0.09, 320 * p, 110 * p, 0.9, { decay: 5 }); noiseBurst(o, r, 0.004, 0.14, 0.3, { lp: 0.3, decay: 7 }); return finish(o, 0.9); } },
  hit_b: { takes: 3, make: (r) => { const o = new Float32Array(N(0.38)), p = jit(r, 0.1);
    noiseBurst(o, r, 0, 0.01, 1, { hp: 0.05, decay: 4 }); sweep(o, 0, 0.22, 170 * p, 48 * p, 1.0, { decay: 3.5, drive: 1.5 });
    noiseBurst(o, r, 0.005, 0.12, 0.6, { lp: 0.5, decay: 5 }); noiseBurst(o, r, 0.03, 0.32, 0.25, { lp: 0.12, decay: 5 }); return finish(o, 0.95); } },
  death_s: { takes: 3, make: (r) => { const o = new Float32Array(N(0.34)), p = jit(r, 0.12);
    sweep(o, 0, 0.3, 520 * p, 70 * p, 0.8, { decay: 3, shape: 'saw', drive: 1 }); noiseBurst(o, r, 0, 0.18, 0.5, { lp: 0.4, decay: 4 }); noiseBurst(o, r, 0, 0.01, 0.8, { hp: 0.05, decay: 4 }); return finish(o, 0.9); } },
  death_b: { takes: 2, make: (r) => { const o = new Float32Array(N(0.85)), p = jit(r, 0.08);
    sweep(o, 0, 0.5, 100 * p, 32 * p, 1.0, { decay: 2.5, drive: 2 }); noiseBurst(o, r, 0, 0.35, 0.7, { lp: 0.3, decay: 3.5 });
    whoosh(o, r, 0.05, 0.7, 2500, 250, 0.25); noiseBurst(o, r, 0, 0.012, 0.9, { hp: 0.05, decay: 4 }); return finish(o, 0.95); } },
  explosion: { takes: 3, make: (r) => { const o = new Float32Array(N(1.3)), p = jit(r, 0.07);
    noiseBurst(o, r, 0, 0.02, 1, { hp: 0.05, decay: 3 }); sweep(o, 0, 0.9, 120 * p, 28 * p, 1.1, { decay: 2.2, drive: 2.5 });
    noiseBurst(o, r, 0.01, 1.1, 0.55, { lp: 0.08, decay: 2.6 }); for (let k = 0; k < 7; k++) noiseBurst(o, r, 0.08 + r() * 0.5, 0.05 + r() * 0.06, 0.3 * r(), { hp: 0.1, lp: 0.6, decay: 4 });
    return finish(o, 1.0); } },
  pickup: { takes: 3, make: (r) => { const o = new Float32Array(N(0.28)), p = jit(r, 0.05);
    sweep(o, 0, 0.14, 880 * p, 880 * p, 0.6, { decay: 6 }); sweep(o, 0.07, 0.2, 1320 * p, 1320 * p, 0.55, { decay: 6 }); noiseBurst(o, r, 0, 0.004, 0.3, { hp: 0.1, decay: 3 }); return finish(o, 0.8); } },
  hurt: { takes: 2, make: (r) => { const o = new Float32Array(N(0.4)), p = jit(r, 0.05);
    sweep(o, 0, 0.35, 230 * p, 95 * p, 0.9, { decay: 3, shape: 'saw', drive: 1.5 }); noiseBurst(o, r, 0, 0.1, 0.8, { lp: 0.35, decay: 5 }); sweep(o, 0, 0.3, 60, 40, 0.8, { decay: 3 }); return finish(o, 0.95); } },
  wall_built: { takes: 2, make: (r) => { const o = new Float32Array(N(0.3)), p = jit(r, 0.06);
    sweep(o, 0, 0.18, 130 * p, 70 * p, 0.9, { decay: 4 }); noiseBurst(o, r, 0, 0.2, 0.5, { lp: 0.18, decay: 5 }); noiseBurst(o, r, 0, 0.008, 0.6, { hp: 0.05, decay: 3 }); return finish(o, 0.9); } },
  wall_removed: { takes: 2, make: (r) => { const o = new Float32Array(N(0.45));
    for (let k = 0; k < 9; k++) noiseBurst(o, r, k * 0.035 * r() * 2, 0.04 + r() * 0.05, 0.5, { hp: 0.1, lp: 0.4, decay: 5 }); sweep(o, 0, 0.3, 90, 50, 0.6, { decay: 4 }); return finish(o, 0.85); } },
  ui_click: { takes: 2, make: (r) => { const o = new Float32Array(N(0.06)), p = jit(r, 0.05);
    sweep(o, 0, 0.04, 2200 * p, 1800 * p, 0.8, { decay: 5 }); noiseBurst(o, r, 0, 0.003, 0.5, { hp: 0.1, decay: 3 }); return finish(o, 0.7); } },
};

// ---- music: four 8 s layers at 120 bpm, written into a circular buffer so every loop is seamless ----
const LOOP = N(8);
function wrapAdd(buf, at, data, gain = 1) { for (let i = 0; i < data.length; i++) buf[(at + i) % LOOP] += data[i] * gain; }
function note(freq, dur, { shape = 'saw', decay = 3, cutoff = 0.2, amp = 1 } = {}) {
  const n = N(dur), o = new Float32Array(n); let ph = 0, lp = 0;
  for (let i = 0; i < n; i++) { ph += freq / SR; const s = shape === 'saw' ? 2 * (ph % 1) - 1 : shape === 'square' ? ((ph % 1) < 0.5 ? 0.7 : -0.7) : Math.sin(TAU * ph);
    lp += (s - lp) * cutoff; o[i] = lp * amp * Math.exp(-decay * i / n) * Math.min(1, i / 48); }
  return o;
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function musicLayer(k) {
  const L = new Float32Array(LOOP), R = new Float32Array(LOOP), r = rng(900 + k), beat = N(0.5);
  const add = (at, d, pan = 0.5, g = 1) => { wrapAdd(L, at, d, g * Math.cos(pan * Math.PI / 2)); wrapAdd(R, at, d, g * Math.sin(pan * Math.PI / 2)); };
  const roots = [45, 45, 41, 43]; // A, A, F, G, one per 2 s
  if (k === 0) { // pad and bass
    for (let b = 0; b < 4; b++) { const root = roots[b], at = b * 4 * beat;
      add(at, note(hz(root), 2.0, { shape: 'saw', decay: 0.8, cutoff: 0.03, amp: 0.8 }), 0.5);
      for (const iv of [12 + 7, 12 + 12 + 3, 12 + 12 + 7]) { add(at, note(hz(root + iv) * 0.998, 2.1, { shape: 'saw', decay: 0.5, cutoff: 0.05, amp: 0.18 }), 0.3); add(at, note(hz(root + iv) * 1.003, 2.1, { shape: 'saw', decay: 0.5, cutoff: 0.05, amp: 0.18 }), 0.7); } }
  } else if (k === 1) { // kick and hat
    for (let b = 0; b < 16; b++) { const at = b * beat, kick = new Float32Array(N(0.16)); sweep(kick, 0, 0.16, 130, 44, 1, { decay: 5 }); add(at, kick, 0.5, 0.9);
      const h = new Float32Array(N(0.05)); noiseBurst(h, r, 0, 0.05, 0.5, { hp: 0.05, lp: 0.9, decay: 6 }); add(at + beat / 2, h, 0.62, 0.4); }
  } else if (k === 2) { // arpeggio lead
    const scale = [0, 3, 7, 10, 12, 15, 10, 7];
    for (let s = 0; s < 64; s++) { const root = roots[Math.floor(s / 16)] + 24, m = root + scale[(s * 3 + (s >> 3)) % scale.length]; add(s * beat / 4, note(hz(m), 0.22, { shape: 'square', decay: 5, cutoff: 0.35, amp: 0.5 }), s % 2 ? 0.7 : 0.3); }
  } else { // snare and heavy riff
    for (let b = 1; b < 16; b += 2) { const sn = new Float32Array(N(0.22)); noiseBurst(sn, r, 0, 0.2, 0.8, { hp: 0.04, lp: 0.7, decay: 5 }); sweep(sn, 0, 0.1, 220, 150, 0.6, { decay: 6 }); add(b * beat, sn, 0.5, 0.8); }
    for (let s = 0; s < 32; s++) { const root = roots[Math.floor(s / 8)] - 12; if (s % 4 === 3 || s % 8 === 0) add(s * beat / 2, note(hz(root + (s % 8 === 0 ? 0 : 7)), 0.25, { shape: 'saw', decay: 4, cutoff: 0.12, amp: 0.7 }), 0.5); }
  }
  let m = 0; for (let i = 0; i < LOOP; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
  const g = (k === 0 ? 0.45 : 0.5) / m; for (let i = 0; i < LOOP; i++) { L[i] *= g; R[i] *= g; }
  return [L, R];
}

function wav(path, channels, sr) { // 16-bit PCM
  const n = channels[0].length, c = channels.length, data = Buffer.alloc(44 + n * c * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * c * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(c, 22);
  data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * c * 2, 28); data.writeUInt16LE(c * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * c * 2, 40);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < c; ch++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[ch][i] * 32767))), 44 + (i * c + ch) * 2);
  writeFileSync(path, data);
}
const encode = (wavPath, oggPath, kbps) => execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', wavPath, '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'audio', '-vbr', 'on', oggPath]);

// SFX pack: every take end to end with a 50 ms gap.
const GAP = N(0.05), manifest = { sampleRate: SR, sfx: { file: 'sfx.ogg', sounds: {} }, music: { file: 'music.ogg', channels: 2, layers: [] } };
const takes = []; let pos = 0;
for (const [name, rec] of Object.entries(RECIPES)) {
  const r = rng(name.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)); manifest.sfx.sounds[name] = [];
  for (let t = 0; t < rec.takes; t++) { const d = rec.make(r); takes.push({ at: pos, d }); manifest.sfx.sounds[name].push([pos, d.length]); pos += d.length + GAP; }
}
const pack = new Float32Array(pos); for (const t of takes) pack.set(t.d, t.at);
wav(join(work, 'sfx.wav'), [pack], SR); encode(join(work, 'sfx.wav'), join(outDir, 'sfx.ogg'), 48);
// Music pack: layers end to end, stereo.
const layers = [0, 1, 2, 3].map(musicLayer), total = LOOP * 4 + GAP * 3, ML = new Float32Array(total), MR = new Float32Array(total);
layers.forEach(([l, rr], k) => { const at = k * (LOOP + GAP); ML.set(l, at); MR.set(rr, at); manifest.music.layers.push([at, LOOP]); });
wav(join(work, 'music.wav'), [ML, MR], SR); encode(join(work, 'music.wav'), join(outDir, 'music.ogg'), 40);
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest));
rmSync(work, { recursive: true, force: true });
const sz = (f) => statSync(join(outDir, f)).size;
console.log(`sfx.ogg ${sz('sfx.ogg')} B (${takes.length} takes, ${(pos / SR).toFixed(1)} s)\nmusic.ogg ${sz('music.ogg')} B (4 layers x 8 s stereo)\nmanifest.json ${sz('manifest.json')} B\ntotal ${sz('sfx.ogg') + sz('music.ogg') + sz('manifest.json')} B`);
