// Stage 10: voice policy shared by both mixers: stacking, per-sound and total voice limits, priority and
// stealing, take and pitch variation, ducking decisions. It never touches audio; it turns a batch of
// sound events into "start these voices, fade out these, move these bus gains" lists in preallocated arrays.
// Mixer A runs it on the main thread, mixer B runs the same code inside the AudioWorklet, so the two
// designs make the same decisions from the same events. Time is in seconds (A: context time).
import {
  BUS_MUSIC, BUS_SMALL, CULL_VOL, DUCK_HOLD_S, END_MARGIN_S, FADE_S, MAX_ACTIVE, MAX_SLOTS, NBUS, NSOUND, SOUNDS, STACK_CAP, STACK_LOG,
  EV_STRIDE, EF_OWN, EF_TRACK,
} from './soundset';

const MAX_OWN = 32;

export class VoicePolicy {
  // Slot table.
  vSound = new Int16Array(MAX_SLOTS);
  vState = new Uint8Array(MAX_SLOTS);     // 0 free, 1 playing, 2 fading out (after a steal)
  vPrio = new Int8Array(MAX_SLOTS);
  vStart = new Float64Array(MAX_SLOTS);
  vEnd = new Float64Array(MAX_SLOTS);
  vVol = new Float32Array(MAX_SLOTS);
  private freeStack = new Int16Array(MAX_SLOTS);
  private nFree = 0;
  private perSound = new Int16Array(NSOUND);   // playing voices per sound
  active = 0;                                  // playing voices (not counting fading ones)
  // Batch accumulators.
  private gCount = new Int32Array(NSOUND);
  private gMax = new Float32Array(NSOUND);
  private gPanW = new Float32Array(NSOUND);
  private gVolSum = new Float32Array(NSOUND);
  private gSeq = new Float32Array(NSOUND);
  private gTrack = new Uint8Array(NSOUND);
  private own = new Float32Array(MAX_OWN * EV_STRIDE);
  private nOwn = 0;
  private order: Int16Array;                   // sound ids, highest priority first
  private lastTake: Int16Array;
  // Output of the last batch.
  nStart = 0;
  outSlot = new Int16Array(MAX_SLOTS);
  outSound = new Int16Array(MAX_SLOTS);
  outTake = new Int16Array(MAX_SLOTS);
  outGain = new Float32Array(MAX_SLOTS);
  outPan = new Float32Array(MAX_SLOTS);
  outRate = new Float32Array(MAX_SLOTS);
  outSeq = new Float32Array(MAX_SLOTS);        // -1 when not tracked
  nSteal = 0;
  outSteal = new Int16Array(MAX_SLOTS);
  nDuck = 0;
  outDuckBus = new Int8Array(NBUS);
  outDuckTarget = new Float32Array(NBUS);
  outDuckHold = new Float32Array(NBUS);
  private duckDepth = new Float32Array(NBUS);
  private duckUntil = new Float64Array(NBUS);
  // Counters.
  started = 0; merged = 0; dropLimit = 0; dropTotal = 0; stolen = 0; culled = 0; maxActive = 0;
  private seedBox = Uint32Array.of(0x9e3779b9); // a typed array: a number field that changes every call would allocate a boxed double each time

  constructor(private takeCount: Int16Array, private takeBase: Int32Array, private takeDur: Float32Array) {
    for (let i = MAX_SLOTS - 1; i >= 0; i--) this.freeStack[this.nFree++] = i;
    this.order = Int16Array.from(Array.from({ length: NSOUND }, (_, i) => i).sort((a, b) => SOUNDS[b].prio - SOUNDS[a].prio || a - b));
    this.lastTake = new Int16Array(NSOUND);
  }

  private rand() { const b = this.seedBox; let s = b[0]; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; b[0] = s; return b[0] / 4294967296; }

  // Called first for every batch. Frees voices whose end time has passed; returns how many slots were freed
  // through freed[] so a mixer can release its per-slot nodes.
  nReaped = 0;
  reaped = new Int16Array(MAX_SLOTS);
  private now = 0;
  begin(now: number) {
    this.now = now;
    this.nStart = this.nSteal = this.nDuck = this.nOwn = this.nReaped = 0;
    for (let s = 0; s < MAX_SLOTS; s++) {
      if (this.vState[s] !== 0 && this.vEnd[s] <= now) this.free(s);
    }
    for (let b = 0; b < NBUS; b++) if (this.duckUntil[b] <= now) this.duckDepth[b] = 0;
    this.gCount.fill(0);
  }

  private free(s: number) {
    if (this.vState[s] === 1) { this.perSound[this.vSound[s]]--; this.active--; }
    this.vState[s] = 0; this.freeStack[this.nFree++] = s; this.reaped[this.nReaped++] = s;
  }

  push(sound: number, pan: number, vol: number, flags: number, seq: number) {
    if (vol < CULL_VOL) { this.culled++; return; }
    if (flags & EF_OWN) {
      if (this.nOwn < MAX_OWN) { const o = this.nOwn++ * EV_STRIDE; this.own[o] = sound; this.own[o + 1] = pan; this.own[o + 2] = vol; this.own[o + 3] = flags; this.own[o + 4] = seq; }
      else this.dropTotal++;
      return;
    }
    const def = SOUNDS[sound];
    if (!def.stack) { this.admit(sound, pan, vol, 1, (flags & EF_TRACK) ? seq : -1, this.now); return; }
    const c = this.gCount[sound]++;
    if (c === 0) { this.gMax[sound] = vol; this.gPanW[sound] = pan * vol; this.gVolSum[sound] = vol; this.gTrack[sound] = 0; this.gSeq[sound] = -1; }
    else { if (vol > this.gMax[sound]) this.gMax[sound] = vol; this.gPanW[sound] += pan * vol; this.gVolSum[sound] += vol; this.merged++; }
    if ((flags & EF_TRACK) && this.gSeq[sound] < 0) this.gSeq[sound] = seq;
  }

  // Admits the batch: own sounds first, then the groups by priority.
  end(now: number) {
    for (let i = 0; i < this.nOwn; i++) { const o = i * EV_STRIDE; this.admit(this.own[o] | 0, this.own[o + 1], this.own[o + 2], 1, (this.own[o + 3] & EF_TRACK) ? this.own[o + 4] : -1, now); }
    for (let k = 0; k < NSOUND; k++) {
      const s = this.order[k], c = this.gCount[s];
      if (c === 0) continue;
      const vol = Math.min(STACK_CAP, this.gMax[s] * (1 + STACK_LOG * Math.log2(c)));
      this.admit(s, this.gPanW[s] / Math.max(1e-6, this.gVolSum[s]), vol, c, this.gSeq[s], now);
      this.gCount[s] = 0;
    }
  }

  private admit(sound: number, pan: number, vol: number, count: number, seq: number, now: number) {
    const def = SOUNDS[sound];
    // Per-sound limit.
    if (this.perSound[sound] >= def.limit) {
      if (def.prio >= 2) { const v = this.oldestOf(sound); if (v >= 0) this.steal(v, now); else { this.dropLimit++; return; } }
      else { this.dropLimit++; return; }
    }
    // Total limit: replace the quietest of the lowest priority below this one, else drop.
    if (this.active >= MAX_ACTIVE) {
      const v = this.victim(def.prio);
      if (v < 0) { this.dropTotal++; return; }
      this.steal(v, now);
    }
    if (this.nFree === 0) { this.dropTotal++; return; }
    const slot = this.freeStack[--this.nFree];
    const nt = this.takeCount[sound];
    const take = nt > 1 ? (this.lastTake[sound] + 1 + Math.floor(this.rand() * (nt - 1))) % nt : 0;
    this.lastTake[sound] = take;
    const rate = Math.pow(2, (this.rand() - 0.5) * 2 * def.pitchVar / 12);
    const gain = def.gain * vol * Math.pow(10, (this.rand() - 0.5) * 3 / 20);
    this.vSound[slot] = sound; this.vState[slot] = 1; this.vPrio[slot] = def.prio; this.vStart[slot] = now; this.vVol[slot] = vol;
    this.vEnd[slot] = now + this.takeDur[this.takeBase[sound] + take] / rate + END_MARGIN_S;
    this.perSound[sound]++; this.active++; this.started++;
    if (this.active > this.maxActive) this.maxActive = this.active;
    const o = this.nStart++;
    this.outSlot[o] = slot; this.outSound[o] = sound; this.outTake[o] = take; this.outGain[o] = gain; this.outPan[o] = pan; this.outRate[o] = rate; this.outSeq[o] = seq;
    // Ducking.
    const dv = Math.min(1, vol);
    if (def.duckMusic > 0) this.duck(BUS_MUSIC, def.duckMusic * dv, now);
    if (def.duckSmall > 0) this.duck(BUS_SMALL, def.duckSmall * dv, now);
  }

  private duck(bus: number, depth: number, now: number) {
    const until = now + DUCK_HOLD_S;
    if (depth <= this.duckDepth[bus] * 1.02 && until <= this.duckUntil[bus] + 0.05) return;
    if (depth > this.duckDepth[bus]) this.duckDepth[bus] = depth;
    this.duckUntil[bus] = until;
    let i = -1; for (let k = 0; k < this.nDuck; k++) if (this.outDuckBus[k] === bus) i = k;
    if (i < 0) i = this.nDuck++;
    this.outDuckBus[i] = bus; this.outDuckTarget[i] = 1 - this.duckDepth[bus]; this.outDuckHold[i] = DUCK_HOLD_S;
  }

  private steal(v: number, now: number) {
    this.perSound[this.vSound[v]]--; this.active--; this.vState[v] = 2; this.vEnd[v] = now + FADE_S + END_MARGIN_S;
    this.outSteal[this.nSteal++] = v; this.stolen++;
  }
  private oldestOf(sound: number) {
    let best = -1, t = Infinity;
    for (let s = 0; s < MAX_SLOTS; s++) if (this.vState[s] === 1 && this.vSound[s] === sound && this.vStart[s] < t) { t = this.vStart[s]; best = s; }
    return best;
  }
  private victim(prio: number) { // lowest priority below the new one, quietest first
    let best = -1, bp = prio, bv = Infinity;
    for (let s = 0; s < MAX_SLOTS; s++) {
      if (this.vState[s] !== 1) continue;
      const p = this.vPrio[s];
      if (p < bp || (p === bp && best >= 0 && this.vVol[s] < bv)) { best = s; bp = p; bv = this.vVol[s]; }
    }
    return best;
  }
}
