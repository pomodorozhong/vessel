// Stage 10: layout of the counter arrays shared by the game, the worklets and the harness.
// Indices into probe.mix (latest mixer counters; A fills 0-7 and 19 from its policy, B receives all from the worklet).
export const M_STARTED = 0, M_MERGED = 1, M_DROP_LIMIT = 2, M_DROP_TOTAL = 3, M_STOLEN = 4, M_CULLED = 5, M_ACTIVE = 6, M_MAX_ACTIVE = 7;
export const M_QUANTA = 8, M_PROC_MS = 9, M_PROC_MAX = 10, M_HIST = 11, M_MIXVOICES = 19; // 8 histogram buckets at 11..18
export const HIST_EDGES = [0.05, 0.1, 0.2, 0.5, 1, 1.5, 2.67]; // ms; the 8th bucket is above the last edge
// Indices into probe.det (latest detector counters).
export const D_QUANTA = 0, D_LATE = 1, D_MAX_EXCESS = 2, D_PEAK = 3, D_CLIP = 4, D_IDLE_EXCESS = 5, D_INJECT = 6, D_HAS_PERF = 7;
// Messages from the worklets are Float64Arrays whose first element tells what they are.
export const MSG_MIXER_STATS = 1, MSG_STARTS = 2, MSG_DETECTOR = 3, MSG_INJECT = 4;
