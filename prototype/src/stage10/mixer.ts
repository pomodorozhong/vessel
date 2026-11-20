// Stage 10: the interface both mixer designs implement. A batch is begin(), push() per event, flush().
//
// Both mixers take the same decisions (voice policy, tuning constants, ducking depths and time constants, pan law, music
// layers) and the same measurement path (probe buffers, the same detector worklet on the master). What still differs, and
// which way it biases the comparison:
// - Limiter. A: DynamicsCompressorNode (threshold -1 dB, ratio 20, attack 0): it adds its own latency, applies its own make-up
//   gain and is not a brickwall, so it can let peaks past; B: a true look-ahead limiter (64 samples, brickwall at -1 dBFS).
//   Bias: B's peak control is stricter than A's; the detector's peak and clipped-sample counts show what each lets through.
// - Pitch. A: the browser's resampler in AudioBufferSourceNode; B: linear interpolation (cheaper and slightly duller on
//   pitch-shifted takes). Bias: B is a little cheaper per voice than a higher-quality resampler would be.
// - Where the policy runs. A: on the main thread (its cost is in "main-thread audio ms"); B: inside process() on the audio
//   thread (its cost is in B's process() time). Neither number includes the other thread's work.
// - Voice start. A: start(currentTime) at the next render quantum; B: a message hop plus the next quantum. Both report the
//   context time the sound started at, so input latency includes B's message hop.
// - Node chains. A reuses a gain+panner pair per voice slot (pool=1, default) and creates one source node per sound; pool=0
//   creates all three per sound. B has no nodes. Allocations seen by the heap sampler are therefore a lower bound for "plain nodes".
// - Counters. A reads them from its policy every frame; B receives them by message every ~0.35 s (rates use audio time).
// - B holds a second copy of all sample data in the worklet scope, so it uses more memory than A.
export interface Mixer {
  readonly name: string;
  readonly out: AudioNode;   // master output after the limiter (the detector and the recorder tap here)
  start(): void;             // starts the music loops
  begin(): void;
  push(sound: number, pan: number, vol: number, flags: number, seq: number): void;
  flush(): void;
  setMusic(levels: Float32Array): void;
  poll(): void;              // refreshes probe.mix where the mixer keeps its counters on this thread
}
