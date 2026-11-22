// Stage 10, mixer B, main-thread side: sends sound events to the mixer running in an AudioWorklet as small
// batches (one transferred ArrayBuffer per flush, taken from a pool and returned by the worklet), and receives
// the worklet's counters and the start frames of tracked sounds. The sample data is transferred once at start.
import { EV_STRIDE, MUSIC_CMD, MUSIC_LAYERS } from './soundset';
import type { SoundBank } from './loader';
import { probe } from './probe';
import { HIST_EDGES, M_ACTIVE, M_DROP_LIMIT, M_DROP_TOTAL, M_HIST, M_MAX_ACTIVE, M_MERGED, M_MIXVOICES, M_PROC_MAX, M_PROC_MS, M_QUANTA, M_STARTED, M_STOLEN, M_CULLED, MSG_MIXER_STATS, MSG_STARTS } from './layout';
import type { Mixer } from './mixer';

const CAP_EVENTS = 512;
const BATCH_FLOATS = 1 + CAP_EVENTS * EV_STRIDE;
void HIST_EDGES;

export class MixerB implements Mixer {
  readonly name = 'B';
  readonly out: AudioNode;
  private node: AudioWorkletNode;
  private pool: ArrayBuffer[] = [];
  private cur: Float32Array | null = null;
  private n = 0;
  private continued = false; // a full chunk of this frame's batch was sent and the worklet waits for the rest
  extraBatches = 0; // batches that had to allocate because the pool was empty

  private constructor(private ctx: AudioContext, node: AudioWorkletNode) {
    this.node = node; this.out = node;
    for (let i = 0; i < 4; i++) this.pool.push(new ArrayBuffer(BATCH_FLOATS * 4));
    node.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) { if (this.pool.length < 8) this.pool.push(d); return; }
      const f = d as Float64Array, kind = f[0];
      if (kind === MSG_MIXER_STATS) {
        const m = probe.mix;
        m[M_STARTED] = f[1]; m[M_MERGED] = f[2]; m[M_DROP_LIMIT] = f[3]; m[M_DROP_TOTAL] = f[4]; m[M_STOLEN] = f[5]; m[M_CULLED] = f[6]; m[M_ACTIVE] = f[7]; m[M_MAX_ACTIVE] = f[8];
        m[M_QUANTA] = f[9]; m[M_PROC_MS] = f[10]; m[M_PROC_MAX] = f[11]; m[M_MIXVOICES] = f[20];
        for (let i = 0; i < 8; i++) m[M_HIST + i] = f[12 + i];
      } else if (kind === MSG_STARTS) {
        const cnt = f[1];
        for (let i = 0; i < cnt; i++) probe.trCtx[f[2 + i * 2]] = f[3 + i * 2] / ctx.sampleRate;
      }
    };
  }

  static async create(ctx: AudioContext, bank: SoundBank, moduleUrl: string, vol: number): Promise<MixerB> {
    await ctx.audioWorklet.addModule(moduleUrl);
    const node = new AudioWorkletNode(ctx, 'stage10-mixer', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    // The data is copied once so the bank stays usable; the copies are transferred to the audio thread.
    const sfx = bank.sfxPcm.slice(), music = bank.musicPcm.slice();
    node.port.postMessage({
      type: 'init', vol, sfx, music, musicLen: bank.musicLen, takeCount: bank.takeCount, takeBase: bank.takeBase, takeOff: bank.takeOff, takeLen: bank.takeLen, takeDur: bank.takeDur,
    }, [sfx.buffer, music.buffer]);
    return new MixerB(ctx, node);
  }

  start() { /* the worklet starts its music loops when it receives the sample data */ }
  begin() { /* batching is by flush */ }

  push(sound: number, pan: number, vol: number, flags: number, seq: number) {
    if (!this.cur) { const b = this.pool.pop(); if (!b) this.extraBatches++; this.cur = new Float32Array(b ?? new ArrayBuffer(BATCH_FLOATS * 4)); this.n = 0; }
    const f = this.cur, o = 1 + this.n * EV_STRIDE;
    f[o] = sound; f[o + 1] = pan; f[o + 2] = vol; f[o + 3] = flags; f[o + 4] = seq; f[o + 5] = 0;
    if (++this.n === CAP_EVENTS) this.send(true);
  }

  // Ends the frame's batch. A batch larger than one chunk goes out as several chunks; every chunk but the last has
  // a negative count, and the worklet runs the voice policy once over all of them, as mixer A does over the frame.
  flush() {
    if (this.n === 0 && !this.continued) return;
    this.send(false);
  }

  private send(more: boolean) {
    if (!this.cur) { const b = this.pool.pop(); if (!b) this.extraBatches++; this.cur = new Float32Array(b ?? new ArrayBuffer(BATCH_FLOATS * 4)); this.n = 0; }
    const f = this.cur;
    f[0] = more ? -this.n : this.n;
    this.node.port.postMessage(f.buffer, [f.buffer]);
    this.cur = null; this.n = 0; this.continued = more;
  }

  private music = new Float32Array(MUSIC_LAYERS);
  setMusic(levels: Float32Array) {
    let changed = false;
    for (let l = 0; l < MUSIC_LAYERS; l++) if (Math.abs(levels[l] - this.music[l]) > 0.02) { this.music[l] = levels[l]; this.push(MUSIC_CMD + l, 0, levels[l], 0, -1); changed = true; }
    if (changed) this.flush();
  }

  poll() { /* counters arrive by message */ }
}
