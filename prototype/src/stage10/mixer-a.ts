// Stage 10, mixer A: plain Web Audio nodes. One AudioBufferSourceNode per sound through a GainNode and a
// StereoPannerNode (the gain+panner chain is reused per voice slot with pool=1, created per sound with pool=0),
// four bus GainNodes, a master gain and a DynamicsCompressorNode set up as a limiter, ducking by automating bus gains.
// Voice decisions come from the shared VoicePolicy. Everything here runs on the main thread.
import { BUS_MUSIC, DUCK_ATTACK_TC, DUCK_RELEASE_TC, FADE_S, MASTER_PRE, MAX_SLOTS, MUSIC_LAYERS, MUSIC_TC, NBUS, SOUNDS } from './soundset';
import { VoicePolicy } from './policy';
import type { SoundBank } from './loader';
import { probe } from './probe';
import { M_ACTIVE, M_CULLED, M_DROP_LIMIT, M_DROP_TOTAL, M_MAX_ACTIVE, M_MERGED, M_STARTED, M_STOLEN } from './layout';
import type { Mixer } from './mixer';

export class MixerA implements Mixer {
  readonly name = 'A';
  readonly out: AudioNode;
  private policy: VoicePolicy;
  private bus: GainNode[] = [];
  private takes: AudioBuffer[] = [];
  private chainG: (GainNode | null)[] = new Array(MAX_SLOTS).fill(null);
  private chainP: (StereoPannerNode | null)[] = new Array(MAX_SLOTS).fill(null);
  private chainBus = new Int8Array(MAX_SLOTS).fill(-1);
  private src: (AudioBufferSourceNode | null)[] = new Array(MAX_SLOTS).fill(null);
  private musicGain: GainNode[] = [];
  private musicLast = new Float32Array(MUSIC_LAYERS);
  private hasCancelHold: boolean;

  constructor(private ctx: AudioContext, private bank: SoundBank, private pooled: boolean, vol: number) {
    this.policy = new VoicePolicy(bank.takeCount, bank.takeBase, bank.takeDur);
    this.hasCancelHold = typeof AudioParam.prototype.cancelAndHoldAtTime === 'function';
    const pre = ctx.createGain(); pre.gain.value = MASTER_PRE * vol;
    const lim = ctx.createDynamicsCompressor(); // configured as a limiter; it is not a brickwall (see the report)
    lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0; lim.release.value = 0.1;
    pre.connect(lim); lim.connect(ctx.destination);
    for (let b = 0; b < NBUS; b++) { const g = ctx.createGain(); g.connect(pre); this.bus.push(g); }
    this.out = lim;
    for (let i = 0; i < bank.takeLen.length; i++) {
      const buf = ctx.createBuffer(1, bank.takeLen[i], bank.sampleRate);
      buf.copyToChannel(bank.sfxPcm.subarray(bank.takeOff[i], bank.takeOff[i] + bank.takeLen[i]), 0);
      this.takes.push(buf);
    }
    for (let l = 0; l < MUSIC_LAYERS; l++) {
      const buf = ctx.createBuffer(2, bank.musicLen, bank.sampleRate);
      buf.copyToChannel(bank.musicPcm.subarray(l * 2 * bank.musicLen, (l * 2 + 1) * bank.musicLen), 0);
      buf.copyToChannel(bank.musicPcm.subarray((l * 2 + 1) * bank.musicLen, (l * 2 + 2) * bank.musicLen), 1);
      const g = ctx.createGain(); g.gain.value = 0; g.connect(this.bus[BUS_MUSIC]); this.musicGain.push(g);
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(g); this.musicSrc.push(s);
    }
  }
  private musicSrc: AudioBufferSourceNode[] = [];
  start() { const t = this.ctx.currentTime + 0.1; for (const s of this.musicSrc) s.start(t); }

  begin() { this.policy.begin(this.ctx.currentTime); this.releaseReaped(); }
  push(sound: number, pan: number, vol: number, flags: number, seq: number) { this.policy.push(sound, pan, vol, flags, seq); }

  private releaseReaped() {
    if (this.pooled) { for (let i = 0; i < this.policy.nReaped; i++) this.src[this.policy.reaped[i]] = null; return; }
    for (let i = 0; i < this.policy.nReaped; i++) {
      const s = this.policy.reaped[i];
      this.src[s] = null;
      if (this.chainG[s]) { this.chainG[s]!.disconnect(); this.chainP[s]!.disconnect(); this.chainG[s] = null; this.chainP[s] = null; this.chainBus[s] = -1; }
    }
  }

  flush() {
    const p = this.policy, ctx = this.ctx, t = ctx.currentTime;
    p.end(t);
    for (let i = 0; i < p.nSteal; i++) {
      const s = p.outSteal[i], g = this.chainG[s];
      if (g) {
        if (this.hasCancelHold) g.gain.cancelAndHoldAtTime(t); else { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); }
        g.gain.linearRampToValueAtTime(0, t + FADE_S);
      }
      try { this.src[s]?.stop(t + FADE_S + 0.002); } catch { /* already ended */ }
    }
    for (let i = 0; i < p.nStart; i++) {
      const slot = p.outSlot[i], sound = p.outSound[i], bus = SOUNDS[sound].bus;
      let g = this.chainG[slot], pn = this.chainP[slot];
      if (!g) { g = ctx.createGain(); pn = ctx.createStereoPanner(); g.connect(pn); this.chainG[slot] = g; this.chainP[slot] = pn; }
      if (this.chainBus[slot] !== bus) { if (this.chainBus[slot] >= 0) pn!.disconnect(); pn!.connect(this.bus[bus]); this.chainBus[slot] = bus; }
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(p.outGain[i], t);
      pn!.pan.setValueAtTime(p.outPan[i], t);
      const s = ctx.createBufferSource();
      s.buffer = this.takes[this.bank.takeBase[sound] + p.outTake[i]];
      s.playbackRate.value = p.outRate[i];
      s.connect(g); s.start(t);
      this.src[slot] = s;
      const seq = p.outSeq[i]; if (seq >= 0) probe.trCtx[seq] = t;
    }
    for (let i = 0; i < p.nDuck; i++) {
      const prm = this.bus[p.outDuckBus[i]].gain;
      if (this.hasCancelHold) prm.cancelAndHoldAtTime(t); else { prm.cancelScheduledValues(t); prm.setValueAtTime(prm.value, t); } // without the hold the next ramp would start from the last event before t
      prm.setTargetAtTime(p.outDuckTarget[i], t, DUCK_ATTACK_TC);
      prm.setTargetAtTime(1, t + p.outDuckHold[i], DUCK_RELEASE_TC);
    }
  }

  setMusic(levels: Float32Array) {
    const t = this.ctx.currentTime;
    for (let l = 0; l < MUSIC_LAYERS; l++) {
      if (Math.abs(levels[l] - this.musicLast[l]) > 0.02) { this.musicLast[l] = levels[l]; this.musicGain[l].gain.setTargetAtTime(levels[l], t, MUSIC_TC); }
    }
  }

  poll() {
    const p = this.policy, m = probe.mix;
    m[M_STARTED] = p.started; m[M_MERGED] = p.merged; m[M_DROP_LIMIT] = p.dropLimit; m[M_DROP_TOTAL] = p.dropTotal; m[M_STOLEN] = p.stolen;
    m[M_CULLED] = p.culled; m[M_ACTIVE] = p.active; m[M_MAX_ACTIVE] = p.maxActive;
  }
}
