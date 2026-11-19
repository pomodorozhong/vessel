// Stage 3 comparison: the same scene in Three.js with its WebGPU renderer and instancing.
// Same sim worker, same snapshots and render clock (design A), same meshes, atlas, camera, static
// instances and CPU culling rectangle as the plain path. Differences that favour Three.js are listed
// in results/stage-3.md (no vertex animation texture, no upscale pass, no UI pass).
import * as THREE from 'three/webgpu';
import simdUrl from './wasm/sim-simd.wasm?url';
import { params } from './params';
import { Overlay, Stat, fmt } from './overlay';
import { HEADER_BYTES, snapshotBytes } from './protocol';
import type { FromWorker, ToWorker } from './protocol';
import { summarize } from './simhost';
import { SnapClock } from './snapclock';
import { DYNAMIC_KINDS, KIND_COUNT, POS_SCALE, VERTEX_BYTES, buildMeshes } from './meshes';
import { buildStatics, makeAtlas } from './render-world';
import { Camera } from './camera';

const wasmModule = WebAssembly.compileStreaming(fetch(simdUrl));
const canvas = document.getElementById('game') as HTMLCanvasElement;
if (params.cw) { canvas.width = params.cw; canvas.height = params.ch; }
document.getElementById('switches')!.style.display = 'none';

const frameStat = new Stat(), cpuStat = new Stat(), gpuStat = new Stat();
let worker: Worker;
const returnBuffer = (buffer: ArrayBuffer) => worker.postMessage({ type: 'return', buffer } satisfies ToWorker, [buffer]);
const clock = new SnapClock({ design: 'A', lag: params.lag, hz: params.hz, maxQueue: params.maxq }, returnBuffer);

const benchCap = params.bench ? Math.ceil((params.dur + params.warmup + 10) * 250) : 1;
const recFrame = new Float32Array(benchCap), recCpu = new Float32Array(benchCap), recGpu = new Float32Array(benchCap), recUpdate = new Float32Array(benchCap);
let nFrame = 0, nGpu = 0, benchOn = false, benchFrom = Infinity;
let visible = 0, drawCalls = 0;

async function main() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, trackTimestamp: true } as any);
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // no colour management, like our renderer
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x1a241a);

  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let blocked: Uint8Array = new Uint8Array(65536);
  const ready = new Promise<void>((resolve) => {
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'snapshot') clock.onSnapshot(m.buffer, performance.now());
      else if (m.type === 'ready') { blocked = m.blocked; resolve(); }
      else if (m.type === 'result') finish(m.result);
    };
  });
  const pool = Array.from({ length: params.pool }, () => new ArrayBuffer(snapshotBytes(params.n)));
  worker.postMessage({ type: 'init', module: await wasmModule, n: params.n, seed: params.seed, sim: 'wasm-simd', spawn: params.spawn, opt: { n: params.n, hz: params.hz, script: params.script, bench: !!params.bench, dur: params.dur, warmup: params.warmup }, pool } satisfies ToWorker, pool);
  await ready;

  // Scene.
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.38 * Math.PI));
  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.96, 0.88), Math.PI);
  sun.position.set(0.35, -0.45, 0.82);
  scene.add(sun);
  const atlasData = makeAtlas();
  const atlas = new THREE.DataTexture(atlasData.levels[0], atlasData.size, atlasData.size, THREE.RGBAFormat);
  atlas.colorSpace = THREE.NoColorSpace; atlas.generateMipmaps = true; atlas.minFilter = THREE.LinearMipmapLinearFilter; atlas.magFilter = THREE.LinearFilter; atlas.needsUpdate = true;
  const material = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true });

  // The same meshes, unpacked to the float attributes Three.js expects.
  const set = buildMeshes(), dv = new DataView(set.vertices);
  const statics = buildStatics(blocked), S = statics.length / 5;
  const staticPerKind = new Uint32Array(KIND_COUNT);
  for (let i = 0; i < S; i++) staticPerKind[statics[i * 5 + 3]]++;
  const meshes: THREE.InstancedMesh[] = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    const r = set.ranges[k], n = r.vertexCount;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = (r.baseVertex + i) * VERTEX_BYTES;
      for (let c = 0; c < 3; c++) { pos[i * 3 + c] = dv.getInt16(o + c * 2, true) / 32767 * POS_SCALE; nrm[i * 3 + c] = dv.getInt8(o + 8 + c) / 127; }
      const ao = dv.getInt16(o + 6, true) / 32767;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
      uv[i * 2] = dv.getUint16(o + 12, true) / 65535; uv[i * 2 + 1] = dv.getUint16(o + 14, true) / 65535;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(set.indices.slice(r.firstIndex, r.firstIndex + r.indexCount), 1));
    const cap = k < 16 ? Math.ceil(params.n / 16) + 1 : k === 16 ? 1 : staticPerKind[k];
    const m = new THREE.InstancedMesh(g, material, Math.max(1, cap));
    m.frustumCulled = false; // instances are culled on the CPU while the matrices are filled
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    scene.add(m);
    meshes.push(m);
  }
  // Blob shadows: one instanced quad, alpha blended.
  const shadowTex = new THREE.DataTexture((() => { const s = 64, px = new Uint8Array(s * s * 4); for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const d = Math.hypot(x / (s - 1) * 2 - 1, y / (s - 1) * 2 - 1); const t = Math.min(1, Math.max(0, (d - 0.35) / 0.65)); px[(y * s + x) * 4 + 3] = (1 - t * t * (3 - 2 * t)) * 0.45 * 255; } return px; })(), 64, 64, THREE.RGBAFormat);
  shadowTex.magFilter = shadowTex.minFilter = THREE.LinearFilter; shadowTex.needsUpdate = true;
  const shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, color: 0x000000 }), params.n);
  shadows.frustumCulled = false; shadows.count = 0; shadows.renderOrder = 10;
  scene.add(shadows);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(256, 256), new THREE.MeshLambertMaterial({ color: new THREE.Color(0.19, 0.275, 0.13) }));
  ground.position.set(128, 128, 0);
  scene.add(ground);

  const cam = new Camera();
  const camera = new THREE.PerspectiveCamera(cam.fov * 180 / Math.PI, 16 / 9, 1, 400);
  camera.up.set(0, 0, 1);
  const cursor = new Uint32Array(KIND_COUNT);

  // Writes one instance matrix (rotation about Z, uniform scale, translation) straight into the array.
  const put = (a: Float32Array, i: number, x: number, y: number, z: number, facing: number, s: number) => {
    const o = i * 16, c = Math.cos(facing) * s, sn = Math.sin(facing) * s;
    a[o] = c; a[o + 1] = sn; a[o + 2] = 0; a[o + 3] = 0;
    a[o + 4] = -sn; a[o + 5] = c; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = s; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
  };

  function update(buffer: ArrayBuffer, alpha: number) {
    const h = new Float32Array(buffer, 0, 20);
    const px = h[16] + (h[10] - h[16]) * alpha, py = h[17] + (h[11] - h[17]) * alpha;
    cam.update(px, py, 16 / 9);
    camera.position.set(px, py - cam.distance * Math.cos(cam.pitch), cam.distance * Math.sin(cam.pitch));
    camera.lookAt(px, py, 0);
    const x0 = cam.cx - cam.halfW, x1 = cam.cx + cam.halfW, y0 = cam.cy - cam.halfH, y1 = cam.cy + cam.halfH;
    cursor.fill(0);
    let sh = 0;
    for (let i = 0; i < S; i++) {
      const x = statics[i * 5], y = statics[i * 5 + 1], r = statics[i * 5 + 4], m = r * 6;
      if (x + m < x0 || x - m > x1 || y + m < y0 || y - m > y1) continue;
      const k = statics[i * 5 + 3];
      put(meshes[k].instanceMatrix.array as Float32Array, cursor[k]++, x, y, 0, statics[i * 5 + 2], r);
    }
    const n = new Uint32Array(buffer, 0, 3)[2];
    const f = new Float32Array(buffer, HEADER_BYTES, n * 8), u = new Uint32Array(buffer, HEADER_BYTES, n * 8);
    const sa = shadows.instanceMatrix.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const o = i * 8, r = f[o + 7], m = r * 6;
      const ax = f[o], ay = f[o + 1], bx = f[o + 2], by = f[o + 3];
      if ((ax > bx ? ax : bx) + m < x0 || (ax < bx ? ax : bx) - m > x1 || (ay > by ? ay : by) + m < y0 || (ay < by ? ay : by) - m > y1) continue;
      const x = ax + (bx - ax) * alpha, y = ay + (by - ay) * alpha;
      let df = f[o + 5] - f[o + 4];
      df -= 6.2831853 * Math.round(df / 6.2831853);
      const k = u[o + 6];
      put(meshes[k].instanceMatrix.array as Float32Array, cursor[k]++, x, y, 0, f[o + 4] + df * alpha, r);
      put(sa, sh++, x, y, 0.03, 0, r * 1.5);
    }
    visible = 0; drawCalls = 2;
    for (let k = 0; k < KIND_COUNT; k++) { const m = meshes[k]; m.count = cursor[k]; m.instanceMatrix.needsUpdate = true; visible += cursor[k]; if (cursor[k]) drawCalls++; }
    shadows.count = sh; shadows.instanceMatrix.needsUpdate = true;
  }

  const overlay = new Overlay(() => {
    const f = frameStat.summary(), c = cpuStat.summary(), g = gpuStat.summary();
    return [
      `frame  ${fmt(f.med)} ms  p99 ${fmt(f.p99)}  (${fmt(1000 / f.med, 0)} fps)`,
      `cpu    ${fmt(c.med)} ms  p99 ${fmt(c.p99)}   draws ${drawCalls}  [three.js r${THREE.REVISION} WebGPU]`,
      `gpu    ${fmt(g.med)} ms  p99 ${fmt(g.p99)}`,
      `draw   visible ${visible}   pauses ${clock.pauses}  jumps ${clock.jumps}`,
    ];
  });

  function finish(sim: unknown) {
    (window as any).__result = {
      config: params, sim,
      frameMs: summarize(recFrame.subarray(0, nFrame)), mainCpuMs: summarize(recCpu.subarray(0, nFrame)), encodeMs: summarize(recUpdate.subarray(0, nFrame)),
      gpuMs: nGpu ? summarize(recGpu.subarray(0, nGpu)) : null,
      framesOver20ms: recFrame.subarray(0, nFrame).reduce((a, v) => a + (v > 20 ? 1 : 0), 0),
      framesOver34ms: recFrame.subarray(0, nFrame).reduce((a, v) => a + (v > 34 ? 1 : 0), 0),
      clock: { pauses: clock.pauses, jumps: clock.jumps, pausesPerMin: clock.pauses / (params.dur / 60), jumpsPerMin: clock.jumps / (params.dur / 60) },
      render: { name: `three.js r${THREE.REVISION} WebGPURenderer`, drawCalls, info: { visible, backend: (renderer as any).backend?.isWebGPUBackend ? 'webgpu' : 'other', calls: (renderer.info.render as any).drawCalls ?? (renderer.info.render as any).calls, triangles: renderer.info.render.triangles } },
      ua: navigator.userAgent, canvas: [canvas.width, canvas.height], hidden: document.hidden, isolated: crossOriginIsolated,
    };
  }

  let last = 0, resolving = false;
  function raf(t: number) {
    requestAnimationFrame(raf);
    const dt = last ? t - last : 0;
    if (last) frameStat.push(dt);
    last = t;
    const t0 = performance.now();
    if (!benchOn && params.bench && t0 >= benchFrom) { benchOn = true; clock.resetMetrics(); }
    clock.frame(t, dt);
    let tUpdate = 0;
    if (clock.current) {
      update(clock.current, clock.alpha);
      tUpdate = performance.now() - t0;
      renderer.render(scene, camera);
      if (!resolving) {
        resolving = true;
        (renderer as any).resolveTimestampsAsync?.('render').then(() => {
          const ms = (renderer.info.render as any).timestamp;
          if (Number.isFinite(ms) && ms > 0) { gpuStat.push(ms); if (benchOn && nGpu < benchCap) recGpu[nGpu++] = ms; }
          resolving = false;
        }).catch(() => { resolving = false; });
      }
    }
    const cpu = performance.now() - t0;
    cpuStat.push(cpu);
    if (benchOn && nFrame < benchCap) { recFrame[nFrame] = dt; recCpu[nFrame] = cpu; recUpdate[nFrame] = tUpdate; nFrame++; }
    overlay.update(t);
  }
  benchFrom = performance.now() + params.warmup * 1000;
  worker.postMessage({ type: 'start' } satisfies ToWorker);
  requestAnimationFrame(raf);
  (window as any).__ready = true;
}
main().catch((e) => { document.getElementById('overlay')!.textContent = String(e); (window as any).__error = String(e); });
void DYNAMIC_KINDS;
