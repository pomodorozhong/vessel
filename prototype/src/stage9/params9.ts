// Stage 9 URL parameters. Every run is reproducible from its URL.
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const str = (k: string, d: string) => q.get(k) ?? d;

export const P9 = {
  // Load (the scripted stream, later the real combat sim)
  enemies: num('enemies', 2000),
  proj: num('proj', 1000),
  shots: num('shots', 60),            // events per second
  hits: num('hits', 150),
  deaths: num('deaths', 40),
  explosions: num('explosions', 10),
  seed: num('seed', 1),
  hz: 30,
  // Look
  outline: str('outline', 'hull') as 'hull' | 'edge' | 'none',
  shadow: str('shadow', 'map') as 'map' | 'blob',
  shadowres: num('shadowres', 2048),
  grass: num('grass', 1),             // clump density multiplier, 0 = off
  bloom: num('bloom', 1),
  particles: num('particles', 10000), // target alive count
  fog: num('fog', 1),
  ui: num('ui', 1),
  overlay: num('overlay', 1),
  olw: num('olw', 2),                 // outline thickness in internal pixels, the same for both methods
  tod: str('tod', '0.45'),            // time of day 0..1, frozen unless 'auto'
  daylen: num('daylen', 120),         // seconds per day when tod=auto
  pitch: num('pitch', 58),            // camera pitch in degrees (run 1's top-down view is 58)
  dist: num('dist', 34),
  // Resolution
  ires: num('ires', 1080),            // internal height (cap when dynres=1)
  dynres: num('dynres', 0),
  budget: num('budget', 10),          // GPU ms budget for dynres (60% of 16.7)
  cw: num('cw', 1920), ch: num('ch', 1080),
  overdraw: num('overdraw', 0),
  // Bench
  bench: str('bench', ''),
  dur: num('dur', 300),
  warmup: num('warmup', 5),
  cap: num('cap', 0),
};
export type P9T = typeof P9;
