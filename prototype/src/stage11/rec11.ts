// Stage 11 recording: preallocated typed arrays the game loop writes into, so recording never allocates. harness11.ts reads them.
export const rec = {
  t0: 0,
  // Per frame.
  nF: 0, fT: new Float32Array(0), fDt: new Float32Array(0), fCpu: new Float32Array(0), fRecv: new Float32Array(0), fUpload: new Float32Array(0),
  fEncode: new Float32Array(0), fAudio: new Float32Array(0), fUi: new Float32Array(0), fAnom: new Uint8Array(0), fLate: new Float32Array(0),
  fInput: new Float32Array(0), fGpuUp: new Uint8Array(0),
  // Per snapshot received.
  nS: 0, sT: new Float32Array(0), sTransit: new Float32Array(0), sStep: new Float32Array(0), sP: new Uint32Array(0), sE: new Uint32Array(0), sEnemies: new Uint32Array(0), sWorld: new Uint8Array(0),
  // Per GPU sample.
  nG: 0, gT: new Float32Array(0), gMs: new Float32Array(0),
  // Once a second.
  nM: 0, mT: new Float32Array(0), mHeap: new Float64Array(0),
  on: false,

  init(seconds: number) {
    const F = Math.ceil(seconds * 250), S = Math.ceil(seconds * 40), M = Math.ceil(seconds + 10);
    this.fT = new Float32Array(F); this.fDt = new Float32Array(F); this.fCpu = new Float32Array(F); this.fRecv = new Float32Array(F); this.fUpload = new Float32Array(F);
    this.fEncode = new Float32Array(F); this.fAudio = new Float32Array(F); this.fUi = new Float32Array(F); this.fAnom = new Uint8Array(F); this.fLate = new Float32Array(F);
    this.fInput = new Float32Array(F); this.fGpuUp = new Uint8Array(F);
    this.sT = new Float32Array(S); this.sTransit = new Float32Array(S); this.sStep = new Float32Array(S); this.sP = new Uint32Array(S); this.sE = new Uint32Array(S); this.sEnemies = new Uint32Array(S); this.sWorld = new Uint8Array(S);
    this.gT = new Float32Array(F); this.gMs = new Float32Array(F);
    this.mT = new Float32Array(M); this.mHeap = new Float64Array(M);
  },
  start(t: number) { this.t0 = t; this.on = true; },
  frame(t: number, dt: number, cpu: number, recv: number, upload: number, encode: number, audio: number, ui: number, anomaly: number, late: number, input: number, gpuUp: number) {
    const i = this.nF; if (i >= this.fT.length) return;
    this.fT[i] = (t - this.t0) / 1000; this.fDt[i] = dt; this.fCpu[i] = cpu; this.fRecv[i] = recv; this.fUpload[i] = upload; this.fEncode[i] = encode;
    this.fAudio[i] = audio; this.fUi[i] = ui; this.fAnom[i] = anomaly; this.fLate[i] = late; this.fInput[i] = input; this.fGpuUp[i] = gpuUp; this.nF = i + 1;
  },
  snap(t: number, transit: number, step: number, p: number, e: number, enemies: number, world: boolean) {
    if (!this.on) return;
    const i = this.nS; if (i >= this.sT.length) return;
    this.sT[i] = (t - this.t0) / 1000; this.sTransit[i] = transit; this.sStep[i] = step; this.sP[i] = p; this.sE[i] = e; this.sEnemies[i] = enemies; this.sWorld[i] = world ? 1 : 0; this.nS = i + 1;
  },
  gpu(t: number, ms: number) {
    if (!this.on) return;
    const i = this.nG; if (i >= this.gT.length) return;
    this.gT[i] = (t - this.t0) / 1000; this.gMs[i] = ms; this.nG = i + 1;
  },
  mem(t: number, heap: number) {
    const i = this.nM; if (i >= this.mT.length) return;
    this.mT[i] = (t - this.t0) / 1000; this.mHeap[i] = heap; this.nM = i + 1;
  },
};
