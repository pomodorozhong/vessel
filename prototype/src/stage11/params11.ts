// Stage 11 URL parameters. Every run is reproducible from its URL.
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const str = (k: string, d: string) => q.get(k) ?? d;

export const P11 = {
  // The wave: enemies ramp from `start` to `peak` over `ramp` seconds and hold there until `dur` ends.
  // mode=past keeps ramping after `peak` by `past` enemies per minute up to `cap`, to find which budget breaks first.
  mode: str('mode', 'wave') as 'wave' | 'past',
  start: num('start', 300),
  peak: num('peak', 5000),
  ramp: num('ramp', 240),
  past: num('past', 3000),
  cap: num('cap', 20000),            // entities allocated in the sim (the most the wave can reach)
  projPerEnemy: num('ppe', 0.2),     // live projectile target = max(200, enemies x this): 1,000 at 5,000 enemies (Stage 8's pass load)
  method: num('method', 0),          // pair finding: 0 = A (the grid, Stage 8's choice)
  passes: num('passes', 3),
  simslow: num('simslow', 1),        // > 1: the sim worker busy-waits (simslow - 1) x each step's time, a stand-in for a slower CPU
  hz: 30,
  seed: num('seed', 1),
  // The look: Stage 9's full look at 1080p.
  outline: str('outline', 'hull') as 'hull' | 'edge' | 'none',
  shadow: str('shadow', 'map') as 'map' | 'blob',
  shadowres: num('shadowres', 2048),
  grass: num('grass', 1),
  bloom: num('bloom', 1),
  particles: num('particles', 10000),
  ires: num('ires', 1080),
  cw: num('cw', 1920), ch: num('ch', 1080),
  // Sound: Stage 10's mixer.
  mixer: str('mixer', 'B'),
  lead: num('lead', -1),              // ms: snapshot events fire this much early (-1 = the measured output pipeline delay; Stage 10 found them about one output latency late without it)
  vol: num('vol', 1),
  // Hand-off: the Stage 2 render clock (design A, the run 1 choice).
  lag: num('lag', 2),
  // Bench
  bench: str('bench', ''),
  dur: num('dur', 300),
  warmup: num('warmup', 5),
  overlay: num('overlay', 1),
  window: num('window', 5),          // seconds per window in the ramp record
};
export type P11T = typeof P11;
