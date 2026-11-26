// Stage 10: the sound set and the tuning constants. Both mixers (and the voice policy they share) read these,
// so the two designs are tuned by the same numbers. Take counts and sample offsets come from the manifest.
export const BUS_BIG = 0, BUS_SMALL = 1, BUS_MUSIC = 2, BUS_UI = 3, NBUS = 4;
export const BUS_NAMES = ['sfx-big', 'sfx-small', 'music', 'ui'];

export interface SoundDef {
  name: string;
  bus: number;
  prio: number;       // 3 = the player's own sounds, 2 = big, 1 = normal, 0 = filler
  limit: number;      // voices of this sound at once
  gain: number;
  duckMusic: number;  // depth (0..1) the music bus drops by under this sound at volume 1
  duckSmall: number;  // same for the small-sfx bus
  stack: boolean;     // identical events in one batch merge into one louder voice
  pitchVar: number;   // random pitch change, +-semitones
}

const d = (name: string, bus: number, prio: number, limit: number, gain: number, duckMusic: number, duckSmall: number, stack: boolean, pitchVar: number): SoundDef =>
  ({ name, bus, prio, limit, gain, duckMusic, duckSmall, stack, pitchVar });

export const SOUNDS: SoundDef[] = [
  d('shoot', BUS_BIG, 3, 6, 0.8, 0, 0, false, 0.5),
  d('dash', BUS_BIG, 3, 2, 0.8, 0, 0, false, 0.4),
  d('eshoot', BUS_SMALL, 0, 6, 0.45, 0, 0, true, 0.8),
  d('hit_s', BUS_SMALL, 1, 10, 0.6, 0, 0, true, 0.8),
  d('hit_b', BUS_BIG, 2, 6, 0.85, 0.15, 0.15, true, 0.6),
  d('death_s', BUS_SMALL, 1, 8, 0.7, 0, 0, true, 0.8),
  d('death_b', BUS_BIG, 2, 4, 0.9, 0.35, 0.3, true, 0.5),
  d('explosion', BUS_BIG, 2, 4, 1.0, 0.6, 0.5, true, 0.4),
  d('pickup', BUS_SMALL, 0, 4, 0.5, 0, 0, true, 0.3),
  d('hurt', BUS_BIG, 3, 2, 0.9, 0.45, 0.3, false, 0.2),
  d('wall_built', BUS_BIG, 1, 3, 0.6, 0, 0, true, 0.4),
  d('wall_removed', BUS_BIG, 1, 3, 0.6, 0, 0, true, 0.4),
  d('ui_click', BUS_UI, 1, 3, 0.7, 0, 0, false, 0.2),
];
export const NSOUND = SOUNDS.length;
export const SND = { shoot: 0, dash: 1, eshoot: 2, hit_s: 3, hit_b: 4, death_s: 5, death_b: 6, explosion: 7, pickup: 8, hurt: 9, wall_built: 10, wall_removed: 11, ui_click: 12 };

// Voice management.
export const MAX_SLOTS = 64;        // slot table (active voices plus voices fading out after a steal)
export const MAX_ACTIVE = 40;       // total SFX voices at once
export const FADE_S = 0.008;        // fade-out of a stolen voice
export const END_MARGIN_S = 0.006;  // a slot is reused this long after its voice should have ended
export const STACK_LOG = 0.45;      // stacked volume = max volume * (1 + STACK_LOG * log2(count)), capped
export const STACK_CAP = 1.6;
export const CULL_VOL = 0.02;

// Ducking: bus gain goes to 1 - depth quickly, holds, then recovers (exponential time constants, seconds).
export const DUCK_ATTACK_TC = 0.008;
export const DUCK_HOLD_S = 0.12;
export const DUCK_RELEASE_TC = 0.15;

// Master.
export const MASTER_PRE = 0.7;
export const LIMIT_CEIL = 0.891;    // -1 dBFS
export const LIMIT_LOOKAHEAD = 64;  // samples (worklet limiter)

// Music: four layers (pad+bass, kick+hat, arpeggio, snare+riff). Layer k fades in above this intensity.
export const MUSIC_LAYERS = 4;
export const MUSIC_THRESH = [0, 0.12, 0.38, 0.68];
export const MUSIC_TC = 0.6;

// Event record passed to a mixer: 6 floats.
export const EV_STRIDE = 6; // sound, pan, vol, flags, seq, spare
export const EF_OWN = 1;    // the player's own sound (priority, never stacked)
export const EF_TRACK = 2;  // measured: the mixer reports when it started (seq is the probe index)
export const MUSIC_CMD = 100; // sound = MUSIC_CMD + layer: vol is the target gain of that layer
