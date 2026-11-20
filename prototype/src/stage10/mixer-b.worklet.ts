// Stage 10, mixer B: our own mixer in an AudioWorklet. It holds the decoded sample data (transferred once),
// runs the shared VoicePolicy on the audio thread, mixes every voice itself (pitch by linear resampling, equal-power
// pan, gain), sums four buses with ducking, and ends in a look-ahead limiter on the master. The music layers
// are four looping stereo voices with their own smoothed gains. Events arrive as batches (transferred ArrayBuffers).
import {
  BUS_MUSIC, DUCK_ATTACK_TC, DUCK_RELEASE_TC, EV_STRIDE, FADE_S, LIMIT_CEIL, LIMIT_LOOKAHEAD, MASTER_PRE, MAX_SLOTS, MUSIC_CMD, MUSIC_LAYERS, MUSIC_TC, NBUS, SOUNDS,
} from './soundset';
import { VoicePolicy } from './policy';
import { HIST_EDGES, MSG_MIXER_STATS, MSG_STARTS } from './layout';

const QN = 128;
const LA = LIMIT_LOOKAHEAD;
const nowMs: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
const HAS_PERF = typeof performance !== 'undefined';
void HAS_PERF;

class Stage10Mixer extends AudioWorkletProcessor {
  private ready = false;
  private pending: ArrayBuffer[] = [];
  private policy!: VoicePolicy;
  private sfx!: Float32Array;
  private music!: Float32Array;
  private musicLen = 0;
  private takeBase!: Int32Array; private takeOff!: Int32Array; private takeLen!: Int32Array;
  private vol = 1;
  // Voices, indexed by the policy's slots.
  private on = new Uint8Array(MAX_SLOTS);
  private pos = new Float64Array(MAX_SLOTS);
  private step = new Float32Array(MAX_SLOTS);
  private gl = new Float32Array(MAX_SLOTS);
  private gr = new Float32Array(MAX_SLOTS);
  private off = new Int32Array(MAX_SLOTS);
  private len = new Int32Array(MAX_SLOTS);
  private bus = new Int8Array(MAX_SLOTS);
  private fade = new Int32Array(MAX_SLOTS);
  private fadeTotal = 0;
  // Buses and ducking.
  private busL = new Float32Array(NBUS * QN);
  private busR = new Float32Array(NBUS * QN);
  private busGain = new Float32Array(NBUS).fill(1);
  private duckTarget = new Float32Array(NBUS).fill(1);
  private duckRelease = new Float64Array(NBUS);
  private kAttack = 0; private kRelease = 0;
  // Music.
  private mPos = 0;
  private mGain = new Float32Array(MUSIC_LAYERS);
  private mTarget = new Float32Array(MUSIC_LAYERS);
  private kMusic = 0;
  // Limiter.
  private dl = new Float32Array(LA); private dr = new Float32Array(LA);
  private reqRing = new Float32Array(LA).fill(1);
  private mRing = new Float32Array(LA).fill(1);
  private mSum = LA;
  private lw = 0;
  private gPrev = 1;
  private relStep = 0;
  // Stats.
  private quanta = 0; private procSum = 0; private procMax = 0;
  private hist = new Float64Array(8);
  private mixVoices = 0;
  private statsMsg = new Float64Array(21);
  private starts = new Float64Array(2 + 2 * 64);
  private nStarts = 0;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) { this.pending.push(d); return; }
      if (d.type === 'init') this.init(d);
    };
  }

  private init(d: any) {
    this.sfx = d.sfx; this.music = d.music; this.musicLen = d.musicLen; this.vol = d.vol;
    this.takeBase = d.takeBase; this.takeOff = d.takeOff; this.takeLen = d.takeLen;
    this.policy = new VoicePolicy(d.takeCount, d.takeBase, d.takeDur);
    this.fadeTotal = Math.max(1, Math.round(FADE_S * sampleRate));
    this.kAttack = 1 - Math.exp(-1 / (DUCK_ATTACK_TC * sampleRate));
    this.kRelease = 1 - Math.exp(-1 / (DUCK_RELEASE_TC * sampleRate));
    this.kMusic = 1 - Math.exp(-QN / (MUSIC_TC * sampleRate));
    this.relStep = 1 / (0.1 * sampleRate);
    this.ready = true;
  }

  private handleBatch(buf: ArrayBuffer, now: number) {
    const f = new Float32Array(buf), n = f[0] | 0, p = this.policy;
    p.begin(now);
    for (let i = 0; i < n; i++) {
      const o = 1 + i * EV_STRIDE, s = f[o] | 0;
      if (s >= MUSIC_CMD) this.mTarget[s - MUSIC_CMD] = f[o + 2];
      else p.push(s, f[o + 1], f[o + 2], f[o + 3] | 0, f[o + 4]);
    }
    p.end(now);
    for (let i = 0; i < p.nSteal; i++) { const s = p.outSteal[i]; this.on[s] = 2; this.fade[s] = this.fadeTotal; }
    for (let i = 0; i < p.nStart; i++) {
      const slot = p.outSlot[i], sound = p.outSound[i], gi = this.takeBase[sound] + p.outTake[i];
      const x = (p.outPan[i] + 1) * 0.5 * Math.PI * 0.5, g = p.outGain[i];
      this.on[slot] = 1; this.pos[slot] = 0; this.step[slot] = p.outRate[i]; this.gl[slot] = Math.cos(x) * g; this.gr[slot] = Math.sin(x) * g;
      this.off[slot] = this.takeOff[gi]; this.len[slot] = this.takeLen[gi]; this.bus[slot] = SOUNDS[sound].bus; this.fade[slot] = 0;
      const seq = p.outSeq[i];
      if (seq >= 0 && this.nStarts < 64) { this.starts[2 + this.nStarts * 2] = seq; this.starts[3 + this.nStarts * 2] = currentFrame; this.nStarts++; }
    }
    for (let i = 0; i < p.nDuck; i++) { const b = p.outDuckBus[i]; this.duckTarget[b] = p.outDuckTarget[i]; this.duckRelease[b] = now + p.outDuckHold[i]; }
    this.port.postMessage(buf, [buf]); // hand the buffer back to the main thread's pool
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0], oL = out[0], oR = out[1];
    if (!this.ready) return true;
    const t0 = nowMs(), now = currentFrame / sampleRate;
    // 1. events
    while (this.pending.length) this.handleBatch(this.pending.shift()!, now);
    for (let b = 0; b < NBUS; b++) if (now >= this.duckRelease[b]) this.duckTarget[b] = 1;
    this.busL.fill(0); this.busR.fill(0);
    // 2. SFX voices
    const sfx = this.sfx;
    let mixed = 0;
    for (let v = 0; v < MAX_SLOTS; v++) {
      const st = this.on[v];
      if (st === 0) continue;
      mixed++;
      const bo = this.bus[v] * QN, L = this.busL, R = this.busR, step = this.step[v], gl = this.gl[v], gr = this.gr[v], off = this.off[v], end = this.len[v] - 1;
      let pos = this.pos[v], fade = this.fade[v];
      const ft = this.fadeTotal;
      let i = 0;
      for (; i < QN; i++) {
        const ip = pos | 0;
        if (ip >= end) { this.on[v] = 0; break; }
        const fr = pos - ip, s = sfx[off + ip] * (1 - fr) + sfx[off + ip + 1] * fr;
        let a = 1;
        if (st === 2) { if (fade <= 0) { this.on[v] = 0; break; } a = fade / ft; fade--; }
        L[bo + i] += s * gl * a; R[bo + i] += s * gr * a;
        pos += step;
      }
      this.pos[v] = pos; this.fade[v] = fade;
    }
    this.mixVoices = mixed;
    // 3. music layers (stereo loops)
    const mb = BUS_MUSIC * QN, ml = this.musicLen, mus = this.music;
    for (let l = 0; l < MUSIC_LAYERS; l++) {
      const g0 = this.mGain[l], g1 = g0 + (this.mTarget[l] - g0) * this.kMusic;
      this.mGain[l] = g1;
      if (g0 < 0.0005 && g1 < 0.0005) continue;
      const lo = (l * 2) * ml, ro = lo + ml, dg = (g1 - g0) / QN;
      let p = this.mPos, g = g0;
      for (let i = 0; i < QN; i++) { this.busL[mb + i] += mus[lo + p] * g; this.busR[mb + i] += mus[ro + p] * g; g += dg; if (++p === ml) p = 0; }
    }
    this.mPos = (this.mPos + QN) % ml;
    // 4. buses with ducking, master gain, look-ahead limiter
    const bg = this.busGain, dt = this.duckTarget, ka = this.kAttack, kr = this.kRelease, pre = MASTER_PRE * this.vol;
    const dl = this.dl, dr = this.dr, rq = this.reqRing, mr = this.mRing;
    let w = this.lw, mSum = this.mSum, gPrev = this.gPrev;
    for (let i = 0; i < QN; i++) {
      let l = 0, r = 0;
      for (let b = 0; b < NBUS; b++) {
        const t = dt[b], g = bg[b] + (t - bg[b]) * (t < bg[b] ? ka : kr);
        bg[b] = g; l += this.busL[b * QN + i] * g; r += this.busR[b * QN + i] * g;
      }
      l *= pre; r *= pre;
      const peak = Math.max(Math.abs(l), Math.abs(r)), req = peak > LIMIT_CEIL ? LIMIT_CEIL / peak : 1;
      gPrev = Math.min(req, gPrev + this.relStep, 1);
      rq[w] = gPrev;
      let m = 1; for (let k = 0; k < LA; k++) if (rq[k] < m) m = rq[k];
      mSum += m - mr[w]; mr[w] = m;
      dl[w] = l; dr[w] = r;
      const rd = w + 1 === LA ? 0 : w + 1, g = mSum / LA; // the sample written LA-1 samples ago
      oL[i] = dl[rd] * g; oR[i] = dr[rd] * g;
      w = rd;
    }
    this.lw = w; this.mSum = mSum; this.gPrev = gPrev;
    // 5. stats
    const el = nowMs() - t0;
    this.quanta++; this.procSum += el; if (el > this.procMax) this.procMax = el;
    let hb = 7; for (let k = 0; k < 7; k++) if (el <= HIST_EDGES[k]) { hb = k; break; }
    this.hist[hb]++;
    if (this.nStarts > 0 && (this.quanta & 15) === 0) { this.starts[0] = MSG_STARTS; this.starts[1] = this.nStarts; this.port.postMessage(this.starts.slice(0, 2 + this.nStarts * 2)); this.nStarts = 0; }
    if ((this.quanta & 127) === 0) {
      const m = this.statsMsg, p = this.policy;
      m[0] = MSG_MIXER_STATS; m[1] = p.started; m[2] = p.merged; m[3] = p.dropLimit; m[4] = p.dropTotal; m[5] = p.stolen; m[6] = p.culled; m[7] = p.active; m[8] = p.maxActive;
      m[9] = this.quanta; m[10] = this.procSum; m[11] = this.procMax; for (let k = 0; k < 8; k++) m[12 + k] = this.hist[k]; m[20] = this.mixVoices;
      this.port.postMessage(m.slice());
    }
    return true;
  }
}
registerProcessor('stage10-mixer', Stage10Mixer);
