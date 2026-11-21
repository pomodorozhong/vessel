// Stage 10: turns snapshot events and the player's input into mixer events, and drives the music layers.
// Snapshot events are copied out of each snapshot when it arrives (so a snapshot the render clock drops under a
// stall still has its sounds played) and fired when the render clock shows their tick, which is when the picture
// shows them. Nothing here allocates per event.
import { EV_DEATH, EV_EXPLOSION, EV_HIT, EV_PICKUP, EV_PLAYER_HURT, EV_SHOT, EV_WALL_BUILT, EV_WALL_REMOVED, V2_ENTITY_BYTES, V2_EVENT_BYTES, V2_HEADER_BYTES, V2_PROJECTILE_BYTES } from '../run2/protocol';
import { EF_OWN, EF_TRACK, MUSIC_LAYERS, MUSIC_THRESH, SND } from './soundset';
import type { Mixer } from './mixer';
import { probe, track } from './probe';

const RING = 64, MAXE = 4096, TRACK_EVERY = 16; // MAXE holds 2x Stage 8's busiest pass-load step; more is counted as overflow
const STALE_STEPS = 8; // events older than this many steps when they come due (after a long stall) are skipped
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class Director {
  private ringTick = new Float64Array(RING);
  private ringN = new Int32Array(RING);
  private ringPx = new Float32Array(RING);
  private ringPy = new Float32Array(RING);
  private bytes = new Uint8Array(RING * MAXE * V2_EVENT_BYTES);
  private u32 = new Uint32Array(this.bytes.buffer);
  private f32 = new Float32Array(this.bytes.buffer);
  private head = 0; private tail = 0;
  private trackCount = 0;
  // Recent event flashes for the picture: x, y, type, birth frame.
  flash = new Float32Array(256 * 4);
  flashHead = 0;
  // Music.
  private ema = 0;
  private fired = 0; private lastMusic = 0;
  private levels = new Float32Array(MUSIC_LAYERS);
  intensity = 0;
  playerX = 0; playerY = 0;
  leadSteps = 0; // events fire this many steps before the render clock reaches their tick

  constructor(private mixer: Mixer) {}

  onSnapshot(buf: ArrayBuffer) {
    const u = new Uint32Array(buf, 0, 16), f = new Float32Array(buf, 0, 16);
    const n = u[2], p = u[4], e = u[5];
    const slot = this.head % RING;
    if (this.head - this.tail >= RING) { probe.eventsStale += this.ringN[this.tail % RING]; this.tail++; } // the ring is full: the oldest snapshot's events are lost
    const cnt = Math.min(e, MAXE);
    probe.eventsOverflow += e - cnt;
    if (cnt > 0) this.bytes.set(new Uint8Array(buf, V2_HEADER_BYTES + V2_ENTITY_BYTES * n + V2_PROJECTILE_BYTES * p, cnt * V2_EVENT_BYTES), slot * MAXE * V2_EVENT_BYTES);
    this.ringTick[slot] = u[1]; this.ringN[slot] = cnt; this.ringPx[slot] = f[10]; this.ringPy[slot] = f[11];
    this.head++;
  }

  // Fires every stored batch whose tick the render clock has reached. Returns the number of events decoded.
  pump(displayedTick: number, frame: number): number {
    const m = this.mixer;
    m.begin();
    let total = 0;
    while (this.tail < this.head) {
      const s = this.tail % RING;
      if (this.ringTick[s] > displayedTick + this.leadSteps + 1e-6) break;
      this.tail++;
      if (displayedTick - this.ringTick[s] > STALE_STEPS) { probe.eventsStale += this.ringN[s]; continue; }
      this.playerX = this.ringPx[s]; this.playerY = this.ringPy[s];
      total += this.decode(s, frame);
    }
    m.flush();
    this.fired += total;
    return total;
  }

  private decode(s: number, frame: number): number {
    const m = this.mixer, u = this.u32, f = this.f32, px = this.ringPx[s], py = this.ringPy[s], n = this.ringN[s];
    for (let i = 0; i < n; i++) {
      const b = (s * MAXE + i) * 4, packed = u[b], type = packed & 0xff, kind = (packed >>> 8) & 0xff, owner = (packed >>> 16) & 0xff;
      const x = f[b + 1], y = f[b + 2], val = f[b + 3];
      probe.eventsIn++;
      let sound = -1, vol = 1, flags = 0;
      switch (type) {
        case EV_SHOT: if (owner === 0) continue; sound = SND.eshoot; vol = 0.6; break; // the player's own shots already played from input
        case EV_HIT: if (kind >= 4 || val >= 8) { sound = SND.hit_b; vol = clamp(0.5 + val * 0.04, 0.4, 1.1); } else { sound = SND.hit_s; vol = clamp(0.45 + val * 0.05, 0.3, 1); } break;
        case EV_DEATH: if (kind >= 4) { sound = SND.death_b; vol = 1; } else { sound = SND.death_s; vol = 0.8; } break;
        case EV_EXPLOSION: sound = SND.explosion; vol = clamp(val / 5, 0.6, 1.3); break;
        case EV_PICKUP: sound = SND.pickup; vol = 0.7; break;
        case EV_PLAYER_HURT: sound = SND.hurt; flags = EF_OWN; break;
        case EV_WALL_BUILT: sound = SND.wall_built; vol = 0.8; break;
        case EV_WALL_REMOVED: sound = SND.wall_removed; vol = 0.8; break;
        default: continue;
      }
      const dx = x - px, dy = y - py, d = Math.sqrt(dx * dx + dy * dy);
      let pan = 0;
      if (!(flags & EF_OWN)) {
        if (d > 70) continue; // too far to hear
        pan = clamp(dx / 25, -1, 1) * 0.85; vol *= clamp(1.15 - d / 70, 0.15, 1);
      }
      let seq = -1;
      if (++this.trackCount % TRACK_EVERY === 0) { seq = track(1, this.ringTick[s]); if (seq >= 0) flags |= EF_TRACK; }
      m.push(sound, pan, vol, flags, seq);
      const fh = this.flashHead++ & 255; this.flash[fh * 4] = x; this.flash[fh * 4 + 1] = y; this.flash[fh * 4 + 2] = type; this.flash[fh * 4 + 3] = frame;
    }
    return n;
  }

  // The player's own sound, straight from input (no snapshot involved). timeStamp is the input event's, or -1 if not measured.
  own(sound: number, timeStamp: number) {
    const m = this.mixer;
    let flags = EF_OWN, seq = -1;
    if (timeStamp >= 0) { seq = track(0, timeStamp); if (seq >= 0) flags |= EF_TRACK; }
    probe.eventsPlayerIn++;
    m.begin(); m.push(sound, 0, 1, flags, seq); m.flush();
  }

  // Music layers follow combat intensity: events per second, smoothed.
  updateMusic(now: number) {
    if (now - this.lastMusic < 200) return;
    const dt = (now - this.lastMusic) / 1000; this.lastMusic = now;
    const rate = this.fired / dt; this.fired = 0;
    this.ema += (rate - this.ema) * (1 - Math.exp(-dt / 1.5));
    this.intensity = clamp(this.ema / 250, 0, 1);
    for (let l = 0; l < MUSIC_LAYERS; l++) this.levels[l] = l === 0 ? 0.9 : clamp((this.intensity - MUSIC_THRESH[l]) / 0.2, 0, 1) * 0.9;
    this.mixer.setMusic(this.levels);
  }
}
