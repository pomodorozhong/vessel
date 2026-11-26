// Prints the Stage 10 results as markdown tables from <dir>/*.json: median over the repetitions of each configuration, with the
// min-max spread in brackets. A difference between two configurations is real only if it is larger than the spread.
// node scripts/run2/stage10-table.mjs [dir]   (default results/run-2/data/stage10/)
import { readdirSync, readFileSync } from 'node:fs';

const dir = process.argv[2] ?? 'results/run-2/data/stage10/';
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const groups = new Map();
for (const f of files) {
  const r = JSON.parse(readFileSync(dir + f, 'utf8'));
  if (!r.name) continue;
  const g = groups.get(r.name) ?? []; g.push(r); groups.set(r.name, g);
}
const med = (a) => { const s = a.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const get = (r, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), r.result);
// "median [min-max]" over the reps
const cell = (rs, path, d = 2) => {
  const v = rs.map((r) => get(r, path)).filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return '–';
  const m = med(v), lo = Math.min(...v), hi = Math.max(...v);
  return rs.length > 1 ? `${m.toFixed(d)} [${lo.toFixed(d)}–${hi.toFixed(d)}]` : m.toFixed(d);
};
const names = [...groups.keys()].sort();
const std = names.filter((n) => !/-(heap|rec)$/.test(n) && !/-validate-/.test(n));

console.log('Glitches (late = detector, same for A and B; underruns = AudioContext.playbackStats; both counted from the bench start)\n');
console.log('| Run | Reps | Late renders (detector) | Underrun events (playbackStats) | Underrun ms | Idle band (ms) | Max excess (ms) | Stalls | Master peak | Clipped samples |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const n of std) { const rs = groups.get(n); console.log(`| ${n} | ${rs.length} | ${cell(rs, 'glitches.detectorLate', 0)} | ${cell(rs, 'glitches.playbackUnderrunEvents', 0)} | ${cell(rs, 'glitches.playbackUnderrunMs', 1)} | ${cell(rs, 'glitches.detectorIdleBandMs', 1)} | ${cell(rs, 'glitches.detectorMaxExcessMs', 1)} | ${cell(rs, 'stalls', 0)} | ${cell(rs, 'glitches.masterPeak', 3)} | ${cell(rs, 'glitches.clippedSamples', 0)} |`); }

console.log('\nLatency and offset to the picture (ms; "mapped" = getOutputTimestamp mapping, which includes the output latency; "+outLat" adds ctx.outputLatency on top)\n');
console.log('| Run | Input to sound median (mapped) | p99 | max | Input to sound median (+outLat) | Event sound vs frame submit median (mapped) | p99 | Event offset median (+outLat) | Output latency | Base latency | Key presses |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const n of std) { const rs = groups.get(n); console.log(`| ${n} | ${cell(rs, 'latencyMs.inputToSound.median', 1)} | ${cell(rs, 'latencyMs.inputToSound.p99', 1)} | ${cell(rs, 'latencyMs.inputToSound.max', 1)} | ${cell(rs, 'latencyMs.inputToSoundPlusOutputLatency.median', 1)} | ${cell(rs, 'latencyMs.eventSoundVsFrameSubmit.median', 1)} | ${cell(rs, 'latencyMs.eventSoundVsFrameSubmit.p99', 1)} | ${cell(rs, 'latencyMs.eventSoundVsFrameSubmitPlusOutputLatency.median', 1)} | ${cell(rs, 'audio.outputLatencyMs', 0)} | ${cell(rs, 'audio.baseLatencyMs', 0)} | ${cell(rs, 'latencyMs.inputToSound.n', 0)} |`); }

console.log('\nCost and voices\n');
console.log('| Run | Main-thread audio ms/frame median | p99 | max | Frame ms p99 | B process() mean ms | B load (of a 2.67 ms quantum) | Voices median | Voices max | Started /s | Merged /s | Dropped (per-sound limit) /s | Dropped (total limit) /s | Stolen /s | Snapshot events /s | Stale events skipped |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const n of std) { const rs = groups.get(n); console.log(`| ${n} | ${cell(rs, 'mainThreadAudioMsPerFrame.median', 3)} | ${cell(rs, 'mainThreadAudioMsPerFrame.p99', 3)} | ${cell(rs, 'mainThreadAudioMsPerFrame.max', 2)} | ${cell(rs, 'frameMs.p99', 1)} | ${cell(rs, 'audioThread.procMeanMs', 3)} | ${cell(rs, 'audioThread.loadMean', 3)} | ${cell(rs, 'voices.perFrame.median', 0)} | ${cell(rs, 'voices.maxActive', 0)} | ${cell(rs, 'eventsPerSec.voicesStarted', 0)} | ${cell(rs, 'eventsPerSec.merged', 0)} | ${cell(rs, 'eventsPerSec.droppedByVoiceLimit', 1)} | ${cell(rs, 'eventsPerSec.droppedByTotalLimit', 1)} | ${cell(rs, 'eventsPerSec.stolen', 0)} | ${cell(rs, 'eventsPerSec.snapshotEventsDecoded', 0)} | ${cell(rs, 'eventsSkipped.stale', 0)} |`); }

const heaps = names.filter((n) => /-heap$/.test(n));
if (heaps.length) {
  console.log('\nAllocations (heap.mjs: V8 sampling heap profiler, attributed by script URL; bytes per second; typed array backing stores, native Web Audio objects and the worklet scope are not visible)\n');
  console.log('| Run | Target | Game B/s | Harness B/s | Browser/internal B/s | Seconds |');
  console.log('|---|---|---|---|---|---|');
  for (const n of heaps) for (const r of groups.get(n)) for (const [t, s] of Object.entries(r.heap?.sessions ?? {})) console.log(`| ${n} | ${t} | ${s.bytesPerSecond?.game?.toFixed(0) ?? '–'} | ${s.bytesPerSecond?.harness?.toFixed(0) ?? '–'} | ${s.bytesPerSecond?.internal?.toFixed(0) ?? '–'} | ${r.heap.seconds.toFixed(0)} |`);
}
const vals = names.filter((n) => /-validate-/.test(n));
if (vals.length) {
  console.log('\nGlitch counter validation\n');
  console.log('| Run | Injected (forced) | Late renders counted | Underrun events (playbackStats) | Underrun ms | Max excess (ms) |');
  console.log('|---|---|---|---|---|---|');
  for (const n of vals) { const rs = groups.get(n); console.log(`| ${n} | ${cell(rs, 'glitches.injected', 0)} | ${cell(rs, 'glitches.detectorLate', 0)} | ${cell(rs, 'glitches.playbackUnderrunEvents', 0)} | ${cell(rs, 'glitches.playbackUnderrunMs', 1)} | ${cell(rs, 'glitches.detectorMaxExcessMs', 1)} |`); }
}
const recs = names.filter((n) => /-rec$/.test(n));
for (const n of recs) for (const r of groups.get(n)) if (r.recording) console.log(`\nRecording ${n}: ${r.recording.file}, ${r.recording.bytes} bytes (${r.recording.mime})`);
