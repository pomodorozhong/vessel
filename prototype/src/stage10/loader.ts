// Stage 10: fetches and decodes the two sound packs once at start (Opus in Ogg, built by scripts/run2/stage10-sounds.mjs).
import { NSOUND, SOUNDS, MUSIC_LAYERS } from './soundset';

export interface SoundBank {
  sampleRate: number;
  takeCount: Int16Array;      // per sound
  takeBase: Int32Array;       // per sound: index of its first take in the flat take tables
  takeOff: Int32Array;        // per take: offset in the decoded sfx pack, in context samples
  takeLen: Int32Array;        // per take: length in samples
  takeDur: Float32Array;      // per take: seconds at pitch 1
  sfxPcm: Float32Array<ArrayBuffer>;       // the whole decoded mono pack (mixer B copies it to the worklet; A drops it after slicing)
  musicPcm: Float32Array<ArrayBuffer>;     // planar: layer, channel, sample
  musicLen: number;           // samples per layer
  encodedBytes: { sfx: number; music: number; manifest: number };
  decodeMs: number;
}

export async function loadSounds(ctx: BaseAudioContext, base: string): Promise<SoundBank> {
  const t0 = performance.now();
  const mRes = await fetch(base + 'manifest.json'), mText = await mRes.text();
  const manifest = JSON.parse(mText);
  const [sfxRaw, musRaw] = await Promise.all([fetch(base + manifest.sfx.file).then((r) => r.arrayBuffer()), fetch(base + manifest.music.file).then((r) => r.arrayBuffer())]);
  const encodedBytes = { sfx: sfxRaw.byteLength, music: musRaw.byteLength, manifest: mText.length };
  const [sfx, mus] = await Promise.all([ctx.decodeAudioData(sfxRaw), ctx.decodeAudioData(musRaw)]);
  const k = sfx.sampleRate / manifest.sampleRate;
  const takeCount = new Int16Array(NSOUND), takeBase = new Int32Array(NSOUND);
  const offs: number[] = [], lens: number[] = [];
  for (let s = 0; s < NSOUND; s++) {
    const takes: number[][] = manifest.sfx.sounds[SOUNDS[s].name];
    if (!takes) throw new Error('sound missing in manifest: ' + SOUNDS[s].name);
    takeCount[s] = takes.length; takeBase[s] = offs.length;
    for (const [o, l] of takes) { offs.push(Math.round(o * k)); lens.push(Math.round(l * k)); }
  }
  const takeOff = Int32Array.from(offs), takeLen = Int32Array.from(lens);
  const takeDur = new Float32Array(takeLen.length);
  for (let i = 0; i < takeLen.length; i++) takeDur[i] = takeLen[i] / sfx.sampleRate;
  const sfxPcm = sfx.getChannelData(0).slice();
  const mk = mus.sampleRate / manifest.sampleRate, musicLen = Math.round(manifest.music.layers[0][1] * mk);
  const musicPcm = new Float32Array(MUSIC_LAYERS * 2 * musicLen);
  const ch0 = mus.getChannelData(0), ch1 = mus.numberOfChannels > 1 ? mus.getChannelData(1) : ch0;
  for (let l = 0; l < MUSIC_LAYERS; l++) {
    const at = Math.round(manifest.music.layers[l][0] * mk);
    musicPcm.set(ch0.subarray(at, at + musicLen), (l * 2) * musicLen);
    musicPcm.set(ch1.subarray(at, at + musicLen), (l * 2 + 1) * musicLen);
  }
  return { sampleRate: sfx.sampleRate, takeCount, takeBase, takeOff, takeLen, takeDur, sfxPcm, musicPcm, musicLen, encodedBytes, decodeMs: performance.now() - t0 };
}
