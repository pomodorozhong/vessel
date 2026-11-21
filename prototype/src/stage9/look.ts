// Shared constants and the day/night cycle for the Stage 9 renderer.
export const NK = 20;                 // kinds: 0-15 enemies, 16 player, 17 building box, 18 unused, 19 tree (run 1's numbering)
export const K_BUILDING = 17;
export const K_TREE = 19;
// Visible lists: camera lists per kind, shadow-caster lists per kind, then blob (everything visible), dynamic entities, aura.
export const L_VIEW = 0, L_SHADOW = NK, L_BLOB = 2 * NK, L_DYN = 2 * NK + 1, L_AURA = 2 * NK + 2;
export const NL = 2 * NK + 3;
export const IND_GRASS = NL, IND_PART = NL + 1;       // non-indexed indirect entries after the lists (5 words each)
export const IND_WORDS = 256;
export const W_GRASS_CHUNKS = (NL + 2) * 5, W_ALIVE = W_GRASS_CHUNKS + 1;
export const CHUNK = 8, CHUNKS = 32;                    // the grass field: 32 x 32 chunks of 8 x 8 units = the 256 x 256 world
export const CLUMPS_BASE = 192;                        // grass clumps per chunk at density 1 (3 per square unit)
export const MAX_BUILDINGS = 512, TREES = 700;
export const VAT_FRAMES = 32;
// EXPL_CAP holds Stage 8's pass load: about 940 explosions/s, each drawn for 0.55 s, so about 520 alive.
export const EV_CAP = 8192, EXPL_CAP = 1024, DMG_CAP = 96;
export const MAX_ALIVE_POOL = 2_000_000;

// Timer slots (one per pass) and how they group in the report.
export const SLOTS = ['cull', 'shadow', 'bend', 'grass', 'world', 'outline', 'pSpawn', 'pUpdate', 'pDraw', 'effects', 'bloomBright', 'bloomH', 'bloomV', 'upscale', 'ui', 'overdraw'] as const;
export type Slot = typeof SLOTS[number];
export const SLOT = Object.fromEntries(SLOTS.map((s, i) => [s, i])) as Record<Slot, number>;
export const GROUPS: Record<string, Slot[]> = {
  cull: ['cull'], shadowMap: ['shadow'], grass: ['bend', 'grass'], world: ['world'], outlines: ['outline'],
  particles: ['pSpawn', 'pUpdate', 'pDraw'], effects: ['effects'], bloom: ['bloomBright', 'bloomH', 'bloomV'], upscale: ['upscale'], ui: ['ui'],
};

export interface Look {
  sunDir: [number, number, number]; sunCol: [number, number, number]; shadowCol: [number, number, number]; rimCol: [number, number, number];
  fogCol: [number, number, number]; fogDensity: number; skyTop: [number, number, number]; skyBot: [number, number, number]; rampShift: number;
}
type V3 = [number, number, number];
interface Key { t: number; sun: V3; shade: V3; rim: V3; fog: V3; top: V3; bot: V3; fogD: number; ramp: number }
// Keyframes over the day: night, dawn, noon, dusk, night. Colours are linear-ish and painterly rather than physical.
const KEYS: Key[] = [
  { t: 0.00, sun: [0.32, 0.4, 0.7], shade: [0.1, 0.12, 0.26], rim: [0.2, 0.3, 0.6], fog: [0.07, 0.09, 0.18], top: [0.02, 0.04, 0.12], bot: [0.09, 0.12, 0.25], fogD: 0.016, ramp: 0.10 },
  { t: 0.22, sun: [0.5, 0.45, 0.6], shade: [0.2, 0.2, 0.36], rim: [0.5, 0.4, 0.5], fog: [0.35, 0.3, 0.4], top: [0.18, 0.24, 0.5], bot: [0.95, 0.6, 0.45], fogD: 0.014, ramp: 0.06 },
  { t: 0.30, sun: [1.25, 0.95, 0.7], shade: [0.34, 0.36, 0.5], rim: [1.0, 0.7, 0.45], fog: [0.8, 0.66, 0.55], top: [0.3, 0.5, 0.85], bot: [0.96, 0.75, 0.55], fogD: 0.012, ramp: 0.02 },
  { t: 0.50, sun: [1.3, 1.2, 1.0], shade: [0.42, 0.5, 0.68], rim: [0.9, 0.95, 1.0], fog: [0.62, 0.76, 0.9], top: [0.22, 0.46, 0.9], bot: [0.78, 0.88, 0.97], fogD: 0.011, ramp: 0.0 },
  { t: 0.70, sun: [1.3, 0.9, 0.6], shade: [0.36, 0.34, 0.5], rim: [1.0, 0.6, 0.4], fog: [0.85, 0.6, 0.5], top: [0.28, 0.36, 0.74], bot: [1.0, 0.6, 0.4], fogD: 0.012, ramp: 0.03 },
  { t: 0.78, sun: [0.7, 0.4, 0.45], shade: [0.2, 0.18, 0.36], rim: [0.7, 0.4, 0.5], fog: [0.4, 0.28, 0.4], top: [0.1, 0.12, 0.34], bot: [0.7, 0.35, 0.4], fogD: 0.014, ramp: 0.07 },
  { t: 1.00, sun: [0.32, 0.4, 0.7], shade: [0.1, 0.12, 0.26], rim: [0.2, 0.3, 0.6], fog: [0.07, 0.09, 0.18], top: [0.02, 0.04, 0.12], bot: [0.09, 0.12, 0.25], fogD: 0.016, ramp: 0.10 },
];
const mix3 = (a: V3, b: V3, f: number): V3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Sun direction, colour, ramp shift, fog and sky for a time of day in 0..1 (0 and 1 are midnight, 0.5 noon).
export function lookAt(tod: number): Look {
  tod = ((tod % 1) + 1) % 1;
  let i = 0;
  while (i < KEYS.length - 2 && tod > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1], f = Math.min(1, Math.max(0, (tod - a.t) / (b.t - a.t)));
  // The sun rises at 0.25 and sets at 0.75; the moon takes over at night from the opposite side.
  const sunElev = (8 + 55 * Math.max(0, Math.sin((tod - 0.25) * 2 * Math.PI))) * Math.PI / 180;
  const az = 0.5 + (tod - 0.5) * 2.2;
  const day: V3 = [Math.cos(sunElev) * Math.cos(az), Math.cos(sunElev) * Math.sin(az), Math.sin(sunElev)];
  const me = 38 * Math.PI / 180, moon: V3 = [-Math.cos(me) * Math.cos(0.9), -Math.cos(me) * Math.sin(0.9), Math.sin(me)];
  const night = Math.max(smooth(0.72, 0.84, tod), 1 - smooth(0.16, 0.28, tod));
  const d = mix3(day, moon, night), l = Math.hypot(...d);
  return {
    sunDir: [d[0] / l, d[1] / l, d[2] / l], sunCol: mix3(a.sun, b.sun, f), shadowCol: mix3(a.shade, b.shade, f), rimCol: mix3(a.rim, b.rim, f),
    fogCol: mix3(a.fog, b.fog, f), fogDensity: a.fogD + (b.fogD - a.fogD) * f, skyTop: mix3(a.top, b.top, f), skyBot: mix3(a.bot, b.bot, f), rampShift: a.ramp + (b.ramp - a.ramp) * f,
  };
}

// The cel ramp: a 3-band lookup with slightly soft edges. Input is the light term in 0..1, output the band strength.
export function makeRamp(width = 128): Uint8Array {
  const px = new Uint8Array(width * 4);
  const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < width; i++) {
    const x = i / (width - 1);
    const v = 0.52 * sm(0.36, 0.40, x) + 0.48 * sm(0.60, 0.64, x);
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = Math.round(v * 255); px[i * 4 + 3] = 255;
  }
  return px;
}
