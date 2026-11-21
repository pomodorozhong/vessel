// Stage 9 renderer: the Stage 3 GPU-driven path (all instances in big buffers, a compute pass culls them into per-kind
// visible lists and indirect draw arguments, render bundles replay the indirect draws) plus the cel-shaded look and the
// combat effects. Every GPU resource is created in build() and buildTargets(), which are the only places that create
// resources, so one new Renderer9 after a device loss brings the whole look back.
import { mat4 } from 'wgpu-matrix';
import type { Gpu } from '../gpu';
import { VERTEX_LAYOUT, buildMeshes } from '../meshes';
import type { MeshSet } from '../meshes';
import { makeAtlas } from '../render-world';
import { v2View } from '../run2/protocol';
import { EV_EXPLOSION, EV_HIT } from '../run2/protocol';
import { CHUNKS, CLUMPS_BASE, DMG_CAP, EV_CAP, EXPL_CAP, EXPL_DRAW, EXPL_LIFE, IND_GRASS, IND_PART, IND_WORDS, K_BUILDING, K_TREE, L_AURA, L_BLOB, L_DYN, L_SHADOW, MAX_ALIVE_POOL, MAX_BUILDINGS, NK, NL, SLOT, SLOTS, TREES, VAT_FRAMES, W_ALIVE, W_GRASS_CHUNKS, lookAt, makeRamp } from './look';
import { shaders } from './shaders9';
import { PassTimer } from './timer9';

export interface RenderOpts {
  outline: 'hull' | 'edge' | 'none'; shadow: 'map' | 'blob'; shadowRes: number; grass: number; bloom: boolean; overdraw: boolean;
  particles: number; evRate: number; ires: number; cw: number; ch: number; maxEntities: number; maxProj: number;
  pitch: number; dist: number; fog: boolean; ui: boolean; tod: number | 'auto'; daylen: number; outlinePx: number;
}

const HDR: GPUTextureFormat = 'rgba16float';
const DRAW_STRIDE = 256;
const LIGHT_EXTENT = 56;
const ADD: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
const ALPHA: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
const DRAW_KINDS: number[] = [...Array.from({ length: 17 }, (_, k) => k), K_BUILDING, K_TREE];
const PARTICLE_BYTES = 48;

let atlasCache: ReturnType<typeof makeAtlas> | null = null;
let meshCache: MeshSet | null = null;

// A walk cycle per enemy kind as per-vertex offsets, stored as snorm8 (units of 0.5 model units): walk, hop, wobble and lunge gaits.
function makeVat(vertexCount: number): Int8Array {
  const rows = 17 * VAT_FRAMES, data = new Int8Array(vertexCount * rows * 4);
  const q = (v: number) => Math.max(-127, Math.min(127, Math.round(v / 0.5 * 127)));
  for (let kind = 0; kind < 17; kind++) {
    const gait = kind % 4, amp = 0.8 + 0.1 * (kind % 5);
    for (let f = 0; f < VAT_FRAMES; f++) {
      const t = f / VAT_FRAMES * Math.PI * 2;
      for (let v = 0; v < vertexCount; v++) {
        const part = Math.floor(v / 77), o = ((kind * VAT_FRAMES + f) * vertexCount + v) * 4;
        const side = part === 2 || part === 5 ? 1 : -1;
        let x = 0, y = 0, z = 0;
        if (gait === 0) { if (part >= 2) { x = Math.sin(t) * side * (part >= 4 ? 0.45 : 0.35); z = part >= 4 ? Math.max(0, Math.cos(t) * side) * 0.15 : 0; } else z = Math.abs(Math.sin(t)) * 0.08; }
        else if (gait === 1) { z = Math.abs(Math.sin(t)) * (part >= 4 ? 0.1 : 0.32); if (part >= 2 && part < 4) z += 0.15 * Math.sin(t); }
        else if (gait === 2) { y = Math.sin(t) * (part >= 4 ? 0.05 : 0.22); z = part >= 4 ? 0 : Math.abs(Math.sin(t * 2)) * 0.05; }
        else { x = Math.sin(t) * (part >= 4 ? 0.1 : 0.3); if (part >= 2 && part < 4) z = (0.3 + 0.3 * Math.sin(t)); }
        data[o] = q(x * amp); data[o + 1] = q(y * amp); data[o + 2] = q(z * amp); data[o + 3] = 0;
      }
    }
  }
  return data;
}

export class Renderer9 {
  readonly name = 'stage9';
  drawCalls = 0;
  internal: [number, number] = [0, 0];
  // Stats read back a few frames after they happen.
  counts = new Uint32Array(NL);
  grassChunks = 0;
  alive = 0; aliveSamples: number[] = [];
  odSamples: { mean: number; p99: number; max: number }[] = [];
  eventsDropped = 0;
  truncated = { entities: 0, projectiles: 0 };   // snapshot contents that did not fit the buffers (must stay 0)
  limitsCheck: Record<string, unknown> = {};
  spawnScale = 1;
  triangles = 0;

  private device: GPUDevice; private gpu: Gpu; private o: RenderOpts; private timer: PassTimer;
  private meshes!: MeshSet;
  private sh!: ReturnType<typeof shaders>;
  private edge: boolean; private map: boolean; private maxN: number; private S = 0; private n = 0;
  private cx = 128; private cy = 128;
  // buffers
  private vbuf!: GPUBuffer; private ibuf!: GPUBuffer; private frameBuf!: GPUBuffer; private instanceBuf!: GPUBuffer; private visibleBuf!: GPUBuffer; private listBuf!: GPUBuffer;
  private indirectBuf!: GPUBuffer; private indirectTemplate = new Uint32Array(IND_WORDS); private gchunkBuf!: GPUBuffer; private drawBuf!: GPUBuffer;
  private projBuf!: GPUBuffer; private evBuf!: GPUBuffer; private explBuf!: GPUBuffer; private dmgBuf!: GPUBuffer; private poolBuf!: GPUBuffer; private plistBuf!: GPUBuffer; private headBuf!: GPUBuffer;
  private histBuf!: GPUBuffer; private stage: GPUBuffer[] = []; private stageBusy: boolean[] = [];
  private textures: GPUTexture[] = [];   // size-dependent targets, destroyed on resize
  private frameData = new ArrayBuffer(432); private ff = new Float32Array(this.frameData); private fu = new Uint32Array(this.frameData);
  // textures / views
  private shadowView!: GPUTextureView; private bendView!: GPUTextureView;
  private sceneA!: GPUTextureView; private sceneB: GPUTextureView | null = null; private depthView!: GPUTextureView; private depthSample!: GPUTextureView;
  private normalView: GPUTextureView | null = null; private countView: GPUTextureView | null = null; private bloomA: GPUTextureView | null = null; private bloomB: GPUTextureView | null = null;
  private final!: GPUTextureView;
  // pipelines
  private pl: Record<string, GPURenderPipeline | GPUComputePipeline> = {};
  private layouts!: { frame: GPUBindGroupLayout; shadow: GPUBindGroupLayout; draw: GPUBindGroupLayout; fx: GPUBindGroupLayout; ui: GPUBindGroupLayout; cull: GPUBindGroupLayout };
  private bg: Record<string, GPUBindGroup> = {};
  private bundles: Record<string, GPURenderBundle> = {};
  private postBuf!: GPUBuffer; private blurBufs: GPUBuffer[] = []; private edgeBuf!: GPUBuffer;
  private frameNo = 0;
  private readbackBusy = false;
  private dmg: { x: number; y: number; v: number; t0: number }[] = [];
  // Explosions: a ring of the newest EXPL_CAP (a full ring overwrites the oldest), of which only the EXPL_DRAW nearest the player
  // are drawn (Stage 9 P1: at Stage 8's 940 explosions/s, all 520 alive at once washed the frame out). No allocation per frame.
  private exX = new Float32Array(EXPL_CAP); private exY = new Float32Array(EXPL_CAP); private exR = new Float32Array(EXPL_CAP); private exT = new Float64Array(EXPL_CAP).fill(-1e9);
  private exHead = 0; exLive = 0; exSkipped = 0;
  private heapD = new Float32Array(EXPL_DRAW); private heapI = new Int32Array(EXPL_DRAW);
  private dmgData = new Float32Array(DMG_CAP * 4); private explData = new Float32Array(EXPL_CAP * 4);
  private spawnEvents = 0; private projCount = 0; private playerHp = 1;
  private nowSec = 0;
  private odCountdown = 0;

  static async create(gpu: Gpu, timer: PassTimer, o: RenderOpts) {
    const r = new Renderer9(gpu, timer, o);
    await r.build();
    return r;
  }
  private constructor(gpu: Gpu, timer: PassTimer, o: RenderOpts) {
    this.gpu = gpu; this.device = gpu.device; this.timer = timer; this.o = o;
    this.edge = o.outline === 'edge'; this.map = o.shadow === 'map'; this.maxN = o.maxEntities;
    this.spawnScale = o.particles > 0 && o.evRate > 0 ? o.particles / (o.evRate * 1.1) : 0;
  }

  // ------------------------------------------------------------------ the one place that creates the look's resources
  private async build() {
    const d = this.device, o = this.o, lim = d.limits;
    this.meshes = meshCache ??= buildMeshes();
    this.triangles = this.meshes.triangles;
    this.sh = shaders({ edge: this.edge, shadowMap: this.map, bloom: o.bloom, overdraw: o.overdraw });
    const buf = (size: number, usage: GPUBufferUsageFlags) => d.createBuffer({ size: Math.max(16, (size + 3) & ~3), usage });
    const ST = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST;

    // Static instances: building slots (filled from the world message) then trees. Same 32-byte layout as the snapshot's entities.
    const S = this.S = MAX_BUILDINGS + TREES, total = S + this.maxN;
    const st = new ArrayBuffer(S * 32), sf = new Float32Array(st), su = new Uint32Array(st);
    let seed = 777;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < TREES; i++) {
      const o8 = (MAX_BUILDINGS + i) * 8, x = 2 + rnd() * 252, y = 2 + rnd() * 252, r = 0.55 + rnd() * 0.4, a = rnd() * 6.28;
      sf[o8] = sf[o8 + 2] = x; sf[o8 + 1] = sf[o8 + 3] = y; sf[o8 + 4] = sf[o8 + 5] = a; su[o8 + 6] = K_TREE; sf[o8 + 7] = r;
    }
    this.instanceBuf = buf(total * 32, ST | CD);
    d.queue.writeBuffer(this.instanceBuf, 0, st);

    // Visible lists: camera lists per kind, shadow-caster lists per kind, blob, dynamic, aura.
    const caps = new Array<number>(NL).fill(1);
    for (let k = 0; k < NK; k++) {
      const cap = k < 17 ? this.maxN : k === K_BUILDING ? MAX_BUILDINGS : k === K_TREE ? TREES : 1;
      caps[k] = cap; caps[L_SHADOW + k] = this.map ? cap : 1;
    }
    caps[L_BLOB] = total; caps[L_DYN] = this.maxN; caps[L_AURA] = this.maxN;
    const lists = new Uint32Array(NL * 4); let base = 0;
    for (let l = 0; l < NL; l++) { lists[l * 4] = base; lists[l * 4 + 1] = caps[l]; base += caps[l]; }
    this.visibleBuf = buf(base * 4, ST | CD);
    this.listBuf = buf(lists.byteLength, GPUBufferUsage.UNIFORM | CD); d.queue.writeBuffer(this.listBuf, 0, lists);

    // Indirect arguments: an indexed draw for every kind in both list sets; non-indexed draws for the blob, dynamic and aura lists, the grass and the particles.
    const ind = this.indirectTemplate;
    for (let k = 0; k < NK; k++) {
      if (k === 18) continue;
      const m = this.meshes.ranges[k];
      for (const l of [k, L_SHADOW + k]) { ind[l * 5] = m.indexCount; ind[l * 5 + 2] = m.firstIndex; ind[l * 5 + 3] = m.baseVertex; }
    }
    for (const l of [L_BLOB, L_DYN, L_AURA, IND_PART]) ind[l * 5] = 6;
    ind[IND_GRASS * 5] = 18;
    this.indirectBuf = buf(IND_WORDS * 4, GPUBufferUsage.INDIRECT | ST | CD | GPUBufferUsage.COPY_SRC);
    this.gchunkBuf = buf(CHUNKS * CHUNKS * 4, ST);
    const draws = new Uint32Array((NL + 2) * DRAW_STRIDE / 4);
    for (let l = 0; l < NL; l++) {
      const kind = l < NK ? l : l >= L_SHADOW && l < L_SHADOW + NK ? l - L_SHADOW : -1;
      const o4 = l * DRAW_STRIDE / 4;
      draws[o4] = lists[l * 4]; draws[o4 + 1] = kind >= 0 && kind < 17 ? 1 : 0; draws[o4 + 2] = kind >= 0 && kind !== 18 ? this.meshes.ranges[kind].baseVertex : 0;
    }
    this.drawBuf = buf(draws.byteLength, GPUBufferUsage.UNIFORM | CD); d.queue.writeBuffer(this.drawBuf, 0, draws);
    this.frameBuf = buf(432, GPUBufferUsage.UNIFORM | CD);
    this.vbuf = buf(this.meshes.vertices.byteLength, GPUBufferUsage.VERTEX | CD); d.queue.writeBuffer(this.vbuf, 0, this.meshes.vertices);
    this.ibuf = buf(this.meshes.indices.byteLength, GPUBufferUsage.INDEX | CD); d.queue.writeBuffer(this.ibuf, 0, this.meshes.indices as Uint16Array<ArrayBuffer>);
    this.projBuf = buf(o.maxProj * 24, ST | CD); this.evBuf = buf(EV_CAP * 16, ST | CD); this.explBuf = buf(EXPL_CAP * 16, ST | CD); this.dmgBuf = buf(DMG_CAP * 16, ST | CD);
    const poolCap = Math.max(256, Math.min(MAX_ALIVE_POOL, Math.ceil(o.particles * 1.15)));
    this.poolCap = poolCap;
    this.poolBuf = buf(poolCap * PARTICLE_BYTES, ST | CD); this.plistBuf = buf(poolCap * 4, ST); this.headBuf = buf(16, ST | CD);
    this.histBuf = buf(128 * 4, ST | GPUBufferUsage.COPY_SRC | CD);
    for (let i = 0; i < 5; i++) { this.stage.push(buf(IND_WORDS * 4, CD | GPUBufferUsage.MAP_READ)); this.stageBusy.push(false); }
    this.postBuf = buf(48, GPUBufferUsage.UNIFORM | CD); this.edgeBuf = buf(16, GPUBufferUsage.UNIFORM | CD);
    for (let i = 0; i < 3; i++) this.blurBufs.push(buf(16, GPUBufferUsage.UNIFORM | CD));

    // Limits across stages: every buffer and texture must fit the loads the other stages measure.
    this.limitsCheck = {
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxBufferSize: lim.maxBufferSize, maxTextureDimension2D: lim.maxTextureDimension2D,
      instanceBufferBytes: total * 32, visibleBufferBytes: base * 4, particlePoolBytes: poolCap * PARTICLE_BYTES, particlePoolCap: poolCap, eventsCap: EV_CAP, projectilesCap: o.maxProj, shadowRes: this.map ? o.shadowRes : 0,
      maxStorageBuffersPerShaderStage: lim.maxStorageBuffersPerShaderStage,
    };
    const need = Math.max(total * 32, base * 4, poolCap * PARTICLE_BYTES);
    if (need > lim.maxStorageBufferBindingSize || need > lim.maxBufferSize) throw new Error(`A buffer of ${need} bytes does not fit the device limits.`);
    if (this.map && o.shadowRes > lim.maxTextureDimension2D) throw new Error('The shadow map is larger than maxTextureDimension2D.');

    // Textures that do not depend on the internal resolution.
    atlasCache ??= makeAtlas();
    const atlasData = atlasCache;
    const atlas = d.createTexture({ size: [atlasData.size, atlasData.size], format: 'rgba8unorm', mipLevelCount: atlasData.levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    atlasData.levels.forEach((px, level) => { const s = atlasData.size >> level; d.queue.writeTexture({ texture: atlas, mipLevel: level }, px as Uint8Array<ArrayBuffer>, { bytesPerRow: s * 4 }, [s, s]); });
    const vv = this.meshes.ranges[0].vertexCount;
    const vat = d.createTexture({ size: [vv, 17 * VAT_FRAMES], format: 'rgba8snorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: vat }, makeVat(vv) as Int8Array<ArrayBuffer>, { bytesPerRow: vv * 4 }, [vv, 17 * VAT_FRAMES]);
    const rampPx = makeRamp(128);
    const ramp = d.createTexture({ size: [128, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: ramp }, rampPx as Uint8Array<ArrayBuffer>, { bytesPerRow: 512 }, [128, 1]);
    const sres = this.map ? o.shadowRes : 1;
    const shadowTex = d.createTexture({ size: [sres, sres], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowView = shadowTex.createView();
    const bend = d.createTexture({ size: [128, 128], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.bendView = bend.createView();
    const samp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const cmp = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });

    // Layouts
    const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT, C = GPUShaderStage.COMPUTE;
    const ro = (b: number, vis: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: vis, buffer: { type: 'read-only-storage' } });
    const L = this.layouts = {
      frame: d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } }, ro(1, V), ro(2, V),
        { binding: 3, visibility: F, texture: {} }, { binding: 4, visibility: V | F, sampler: {} }, { binding: 5, visibility: V, texture: { sampleType: 'float' } },
        { binding: 6, visibility: F, texture: {} }, { binding: 7, visibility: F, texture: { sampleType: 'depth' } }, { binding: 8, visibility: F, sampler: { type: 'comparison' } },
        ro(9, V), { binding: 10, visibility: V, texture: {} },
      ] }),
      shadow: d.createBindGroupLayout({ entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform' } }, ro(1, V), ro(2, V), { binding: 5, visibility: V, texture: { sampleType: 'float' } }] }),
      draw: d.createBindGroupLayout({ entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }] }),
      fx: d.createBindGroupLayout({ entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }, ro(1, V), ro(2, V), ro(3, V), ro(4, V), ro(5, V), ro(6, V)] }),
      ui: d.createBindGroupLayout({ entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }, ro(1, V), ro(2, V), ro(3, V)] }),
      cull: d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } }, { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } }, { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } }, { binding: 4, visibility: C, buffer: { type: 'uniform' } }, { binding: 5, visibility: C, buffer: { type: 'storage' } },
      ] }),
    };
    const pl = (...g: GPUBindGroupLayout[]) => d.createPipelineLayout({ bindGroupLayouts: g });
    const sceneLayout = pl(L.frame, L.draw), shadowLayout = pl(L.shadow, L.draw), fxLayout = pl(L.fx, L.draw), uiLayout = pl(L.ui, L.draw);
    const cullLayout = pl(L.cull);
    const M = (code: string) => d.createShaderModule({ code });
    const sCull = M(this.sh.cull), sShadow = M(this.sh.shadow), sWorld = M(this.sh.world), sFx = M(this.sh.fx), sSpawn = M(this.sh.particleSpawn), sUpdate = M(this.sh.particleUpdate), sUi = M(this.sh.ui);
    const sEdge = M(this.sh.edge), sBloom = M(this.sh.bloom), sFinal = M(this.sh.final), sHist = M(this.sh.odHist);

    // Colour targets per pass kind. The normal target exists only for outline method B; the count target only for the overdraw view.
    const od = o.overdraw, edge = this.edge;
    const solid = (blend?: GPUBlendState, normalMask: number = GPUColorWrite.ALL): GPUColorTargetState[] => [
      { format: HDR, blend }, ...(edge ? [{ format: 'rgba8unorm' as GPUTextureFormat, writeMask: normalMask }] : []), ...(od ? [{ format: 'r16float' as GPUTextureFormat, blend: ADD }] : []),
    ];
    const fxT = (blend?: GPUBlendState): GPUColorTargetState[] => [{ format: HDR, blend }, ...(od ? [{ format: 'r16float' as GPUTextureFormat, blend: ADD }] : [])];
    const depth = (write: boolean, cmp: GPUCompareFunction = 'less'): GPUDepthStencilState => ({ format: 'depth24plus', depthWriteEnabled: write, depthCompare: cmp });
    const rp = (name: string, desc: GPURenderPipelineDescriptor) => d.createRenderPipelineAsync(desc).then((p) => { this.pl[name] = p; });
    const cp = (name: string, layout: GPUPipelineLayout | 'auto', module: GPUShaderModule, entryPoint: string) => d.createComputePipelineAsync({ layout, compute: { module, entryPoint } }).then((p) => { this.pl[name] = p; });
    const fsq = (module: GPUShaderModule, fragment: string, format: GPUTextureFormat) => ({ layout: 'auto' as const, vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: fragment, targets: [{ format }] } });
    const jobs: Promise<void>[] = [
      cp('cull', cullLayout, sCull, 'cull'), cp('chunks', cullLayout, sCull, 'chunks'), cp('finalize', cullLayout, sCull, 'finalize'),
      rp('mesh', { layout: sceneLayout, vertex: { module: sWorld, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] }, fragment: { module: sWorld, entryPoint: 'fs', targets: solid() }, primitive: { cullMode: 'back' }, depthStencil: depth(true) }),
      rp('sky', { layout: sceneLayout, vertex: { module: sWorld, entryPoint: 'skyVs' }, fragment: { module: sWorld, entryPoint: 'skyFs', targets: solid() }, depthStencil: depth(false, 'always') }),
      rp('ground', { layout: sceneLayout, vertex: { module: sWorld, entryPoint: 'groundVs' }, fragment: { module: sWorld, entryPoint: 'groundFs', targets: solid() }, primitive: { topology: 'triangle-strip' }, depthStencil: depth(true) }),
      rp('grass', { layout: sceneLayout, vertex: { module: sWorld, entryPoint: 'grassVs' }, fragment: { module: sWorld, entryPoint: 'grassFs', targets: solid() }, depthStencil: depth(true) }),
      rp('particleDraw', { layout: fxLayout, vertex: { module: sFx, entryPoint: 'pVs' }, fragment: { module: sFx, entryPoint: 'pFs', targets: fxT(ADD) }, depthStencil: depth(false) }),
      rp('aura', { layout: fxLayout, vertex: { module: sFx, entryPoint: 'auraVs' }, fragment: { module: sFx, entryPoint: 'auraFs', targets: fxT(ALPHA) }, depthStencil: depth(false) }),
      rp('expl', { layout: fxLayout, vertex: { module: sFx, entryPoint: 'explVs' }, fragment: { module: sFx, entryPoint: 'explFs', targets: fxT(ADD) }, depthStencil: depth(false) }),
      rp('proj', { layout: fxLayout, vertex: { module: sFx, entryPoint: 'projVs' }, fragment: { module: sFx, entryPoint: 'projFs', targets: fxT(ADD) }, depthStencil: depth(false) }),
      rp('final', fsq(sFinal, 'fs', this.gpu.format)),
      rp('uiBar', { layout: uiLayout, vertex: { module: sUi, entryPoint: 'barVs' }, fragment: { module: sUi, entryPoint: 'barFs', targets: [{ format: this.gpu.format, blend: ALPHA }] } }),
      rp('uiDmg', { layout: uiLayout, vertex: { module: sUi, entryPoint: 'dmgVs' }, fragment: { module: sUi, entryPoint: 'dmgFs', targets: [{ format: this.gpu.format, blend: ALPHA }] } }),
      rp('uiHud', { layout: uiLayout, vertex: { module: sUi, entryPoint: 'hudVs' }, fragment: { module: sUi, entryPoint: 'hudFs', targets: [{ format: this.gpu.format, blend: ALPHA }] } }),
    ];
    if (this.o.grass > 0) jobs.push(rp('bend', { layout: fxLayout, vertex: { module: sFx, entryPoint: 'bendVs' }, fragment: { module: sFx, entryPoint: 'bendFs', targets: [{ format: HDR, blend: ADD }] } }));
    if (this.map) jobs.push(rp('shadow', { layout: shadowLayout, vertex: { module: sShadow, entryPoint: 'shadowVs', buffers: [VERTEX_LAYOUT] }, primitive: { cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 1, depthBiasSlopeScale: 1.5 } }));
    else jobs.push(rp('blob', { layout: sceneLayout, vertex: { module: sWorld, entryPoint: 'blobVs' }, fragment: { module: sWorld, entryPoint: 'blobFs', targets: solid(ALPHA, 0) }, depthStencil: depth(false, 'always') }));
    if (o.outline === 'hull') jobs.push(rp('hull', { layout: sceneLayout, vertex: { module: sWorld, entryPoint: 'hullVs', buffers: [VERTEX_LAYOUT] }, fragment: { module: sWorld, entryPoint: 'hullFs', targets: fxT() }, primitive: { cullMode: 'front' }, depthStencil: depth(true) }));
    if (edge) jobs.push(rp('edge', fsq(sEdge, 'fs', HDR)));
    if (o.bloom) { jobs.push(rp('bright', fsq(sBloom, 'bright', HDR)), rp('blur', { layout: 'auto', vertex: { module: sBloom, entryPoint: 'vs' }, fragment: { module: sBloom, entryPoint: 'blurFs', targets: [{ format: HDR }] } })); }
    if (o.particles > 0) jobs.push(cp('spawn', 'auto', sSpawn, 'spawn'), cp('update', 'auto', sUpdate, 'update'));
    if (od) jobs.push(cp('hist', 'auto', sHist, 'main'));
    await Promise.all(jobs); // every pipeline is created at load time, so no shader compiles mid-game

    // Bind groups that do not depend on the internal resolution.
    const bgb = (b: number, buffer: GPUBuffer, size?: number): GPUBindGroupEntry => ({ binding: b, resource: { buffer, size } });
    this.bg.frame = d.createBindGroup({ layout: L.frame, entries: [
      bgb(0, this.frameBuf), bgb(1, this.instanceBuf), bgb(2, this.visibleBuf), { binding: 3, resource: atlas.createView() }, { binding: 4, resource: samp }, { binding: 5, resource: vat.createView() },
      { binding: 6, resource: ramp.createView() }, { binding: 7, resource: this.shadowView }, { binding: 8, resource: cmp }, bgb(9, this.gchunkBuf), { binding: 10, resource: this.bendView },
    ] });
    if (this.map) this.bg.shadow = d.createBindGroup({ layout: L.shadow, entries: [bgb(0, this.frameBuf), bgb(1, this.instanceBuf), bgb(2, this.visibleBuf), { binding: 5, resource: vat.createView() }] });
    this.bg.draw = d.createBindGroup({ layout: L.draw, entries: [bgb(0, this.drawBuf, 16)] });
    this.bg.fx = d.createBindGroup({ layout: L.fx, entries: [bgb(0, this.frameBuf), bgb(1, this.poolBuf), bgb(2, this.plistBuf), bgb(3, this.projBuf), bgb(4, this.explBuf), bgb(5, this.instanceBuf), bgb(6, this.visibleBuf)] });
    this.bg.ui = d.createBindGroup({ layout: L.ui, entries: [bgb(0, this.frameBuf), bgb(1, this.instanceBuf), bgb(2, this.visibleBuf), bgb(3, this.dmgBuf)] });
    this.bg.cull = d.createBindGroup({ layout: L.cull, entries: [bgb(0, this.frameBuf), bgb(1, this.instanceBuf), bgb(2, this.visibleBuf), bgb(3, this.indirectBuf), bgb(4, this.listBuf), bgb(5, this.gchunkBuf)] });
    if (o.particles > 0) {
      this.bg.spawn = d.createBindGroup({ layout: (this.pl.spawn as GPUComputePipeline).getBindGroupLayout(0), entries: [bgb(0, this.frameBuf), bgb(1, this.poolBuf), bgb(2, this.evBuf), bgb(3, this.headBuf)] });
      this.bg.update = d.createBindGroup({ layout: (this.pl.update as GPUComputePipeline).getBindGroupLayout(0), entries: [bgb(0, this.frameBuf), bgb(1, this.poolBuf), bgb(2, this.indirectBuf), bgb(3, this.plistBuf)] });
    }
    this.samp = samp;

    // Render bundles: the fixed list of indirect draws is recorded once and replayed every frame.
    const colorFormats = solid().map((t) => t.format);
    const fxFormats = fxT().map((t) => t.format);
    const meshDraws = (enc: GPURenderBundleEncoder, listBase: number) => {
      enc.setVertexBuffer(0, this.vbuf); enc.setIndexBuffer(this.ibuf, 'uint16');
      for (const k of DRAW_KINDS) { enc.setBindGroup(1, this.bg.draw, [(listBase + k) * DRAW_STRIDE]); enc.drawIndexedIndirect(this.indirectBuf, (listBase + k) * 20); }
    };
    {
      const enc = d.createRenderBundleEncoder({ colorFormats, depthStencilFormat: 'depth24plus' });
      enc.setBindGroup(0, this.bg.frame);
      if (!this.map) { enc.setPipeline(this.pl.blob as GPURenderPipeline); enc.setBindGroup(1, this.bg.draw, [L_BLOB * DRAW_STRIDE]); enc.drawIndirect(this.indirectBuf, L_BLOB * 20); }
      enc.setPipeline(this.pl.mesh as GPURenderPipeline);
      meshDraws(enc, 0);
      this.bundles.world = enc.finish();
    }
    if (o.outline === 'hull') {
      const enc = d.createRenderBundleEncoder({ colorFormats: fxFormats, depthStencilFormat: 'depth24plus' });
      enc.setBindGroup(0, this.bg.frame); enc.setPipeline(this.pl.hull as GPURenderPipeline);
      meshDraws(enc, 0);
      this.bundles.hull = enc.finish();
    }
    if (this.map) {
      const enc = d.createRenderBundleEncoder({ colorFormats: [], depthStencilFormat: 'depth32float' });
      enc.setBindGroup(0, this.bg.shadow); enc.setPipeline(this.pl.shadow as GPURenderPipeline);
      meshDraws(enc, L_SHADOW);
      this.bundles.shadow = enc.finish();
    }
    this.buildTargets(o.ires);
  }
  private poolCap = 0; private samp!: GPUSampler;

  // Everything that depends on the internal resolution: the render targets, the bind groups that read them, the pass descriptors.
  private buildTargets(ih: number) {
    const d = this.device, o = this.o;
    for (const t of this.textures) t.destroy();
    this.textures = [];
    const iw = Math.round(ih * 16 / 9);
    this.internal = [iw, ih];
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    const tex = (w: number, h: number, format: GPUTextureFormat, usage: number) => { const t = d.createTexture({ size: [w, h], format, usage }); this.textures.push(t); return t; };
    this.sceneA = tex(iw, ih, HDR, RA | TB).createView();
    this.sceneB = this.edge ? tex(iw, ih, HDR, RA | TB).createView() : null;
    const depthTex = tex(iw, ih, 'depth24plus', RA | TB);
    this.depthView = depthTex.createView(); this.depthSample = depthTex.createView({ aspect: 'depth-only' });
    this.normalView = this.edge ? tex(iw, ih, 'rgba8unorm', RA | TB).createView() : null;
    this.countView = o.overdraw ? tex(iw, ih, 'r16float', RA | TB).createView() : null;
    this.final = this.sceneB ?? this.sceneA;
    const hw = Math.max(1, iw >> 1), hh = Math.max(1, ih >> 1);
    if (o.bloom) { this.bloomA = tex(hw, hh, HDR, RA | TB).createView(); this.bloomB = tex(hw, hh, HDR, RA | TB).createView(); } else { this.bloomA = this.bloomB = null; }

    const bgb = (b: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding: b, resource: { buffer } });
    const q = this.device.queue;
    q.writeBuffer(this.postBuf, 0, new Float32Array([1 / iw, 1 / ih, 0.2, 0.9, 0.0, 0.0, 0.01, 0, 1.06, 1.03, 0.98, 0.95]));
    q.writeBuffer(this.edgeBuf, 0, new Float32Array([o.outlinePx, 1, 400, 0]));
    q.writeBuffer(this.blurBufs[0], 0, new Float32Array([1 / iw, 1 / ih, 1.0, 0]));
    q.writeBuffer(this.blurBufs[1], 0, new Float32Array([1 / hw, 0, 0, 0]));
    q.writeBuffer(this.blurBufs[2], 0, new Float32Array([0, 1 / hh, 0, 0]));
    const fin: GPUBindGroupEntry[] = [{ binding: 0, resource: this.final }, { binding: 1, resource: this.samp }, bgb(2, this.postBuf)];
    if (o.bloom) fin.push({ binding: 3, resource: this.bloomA! });
    this.bg.final = d.createBindGroup({ layout: (this.pl.final as GPURenderPipeline).getBindGroupLayout(0), entries: fin });
    if (this.edge) this.bg.edge = d.createBindGroup({ layout: (this.pl.edge as GPURenderPipeline).getBindGroupLayout(0), entries: [{ binding: 0, resource: this.sceneA }, { binding: 1, resource: this.depthSample }, { binding: 2, resource: this.normalView! }, bgb(3, this.edgeBuf)] });
    if (o.bloom) {
      const bl = (this.pl.blur as GPURenderPipeline).getBindGroupLayout(0), br = (this.pl.bright as GPURenderPipeline).getBindGroupLayout(0);
      this.bg.bright = d.createBindGroup({ layout: br, entries: [{ binding: 0, resource: this.final }, { binding: 1, resource: this.samp }, bgb(2, this.blurBufs[0])] });
      this.bg.blurH = d.createBindGroup({ layout: bl, entries: [{ binding: 0, resource: this.bloomA! }, { binding: 1, resource: this.samp }, bgb(2, this.blurBufs[1])] });
      this.bg.blurV = d.createBindGroup({ layout: bl, entries: [{ binding: 0, resource: this.bloomB! }, { binding: 1, resource: this.samp }, bgb(2, this.blurBufs[2])] });
    }
    if (o.overdraw) this.bg.hist = d.createBindGroup({ layout: (this.pl.hist as GPUComputePipeline).getBindGroupLayout(0), entries: [{ binding: 0, resource: this.countView! }, bgb(1, this.histBuf)] });
  }

  resize(ih: number) { this.buildTargets(ih); }

  // ------------------------------------------------------------------ data in
  setWorld(boxes: Float32Array) {
    const n = Math.min(boxes.length / 5, MAX_BUILDINGS);
    const h = new Float32Array(MAX_BUILDINGS * 8), hu = new Uint32Array(h.buffer);
    for (let i = 0; i < n; i++) {
      const x0 = boxes[i * 5], y0 = boxes[i * 5 + 1], x1 = boxes[i * 5 + 2], y1 = boxes[i * 5 + 3], on = boxes[i * 5 + 4];
      const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, o8 = i * 8, thin = Math.min(hx, hy) < 0.75;
      h[o8] = (x0 + x1) / 2; h[o8 + 1] = (y0 + y1) / 2; h[o8 + 2] = hx; h[o8 + 3] = hy;   // p0 = centre, p1 = half extents
      h[o8 + 4] = on; h[o8 + 5] = thin ? 1.8 : 2.2 + ((i * 7919) % 13) / 13 * 1.6;           // f0 = active, f1 = height
      hu[o8 + 6] = K_BUILDING; h[o8 + 7] = Math.hypot(hx, hy);
    }
    this.device.queue.writeBuffer(this.instanceBuf, 0, h);
  }

  // Once per displayed snapshot: entities, projectiles and events are uploaded whole, and the CPU side of the events is read for the
  // effects that are not on the GPU (explosion rings, damage numbers).
  setSnapshot(buffer: ArrayBuffer) {
    const v = v2View(buffer), q = this.device.queue;
    if (v.n > this.maxN) this.truncated.entities += v.n - this.maxN;
    if (v.p > this.o.maxProj) this.truncated.projectiles += v.p - this.o.maxProj;
    this.n = Math.min(v.n, this.maxN);
    q.writeBuffer(this.instanceBuf, this.S * 32, buffer, v.entityOffset, this.n * 32);
    this.projCount = Math.min(v.p, this.o.maxProj);
    if (this.projCount) q.writeBuffer(this.projBuf, 0, buffer, v.projectileOffset, this.projCount * 24);
    const e = Math.min(v.e, EV_CAP);
    if (v.e > EV_CAP) this.eventsDropped += v.e - EV_CAP;
    if (e) q.writeBuffer(this.evBuf, 0, buffer, v.eventOffset, e * 16);
    this.spawnEvents = e;
    const hf = new Float32Array(buffer, 0, 32);
    this.playerHp = hf[12];
    const now = performance.now() / 1000;
    const eu = new Uint32Array(buffer, v.eventOffset, e * 4), ef = new Float32Array(buffer, v.eventOffset, e * 4);
    let numbers = 0;
    for (let i = 0; i < e; i++) {
      const type = eu[i * 4] & 255;
      if (type === EV_EXPLOSION) { const k = this.exHead; this.exHead = (k + 1) % EXPL_CAP; this.exX[k] = ef[i * 4 + 1]; this.exY[k] = ef[i * 4 + 2]; this.exR[k] = ef[i * 4 + 3]; this.exT[k] = now; }
      else if (type === EV_HIT && numbers < 12 && this.dmg.length < DMG_CAP) { numbers++; this.dmg.push({ x: ef[i * 4 + 1] + (Math.random() - 0.5), y: ef[i * 4 + 2] + (Math.random() - 0.5), v: Math.max(1, Math.round(ef[i * 4 + 3])), t0: now }); }
    }
  }

  // The EXPL_DRAW live explosions nearest (px, py), kept in a max-heap on distance, into heapI[0..n). Counts the live ones left out.
  private nearestExplosions(px: number, py: number): number {
    const hd = this.heapD, hi = this.heapI, now = this.nowSec;
    let n = 0, live = 0;
    for (let k = 0; k < EXPL_CAP; k++) {
      if (now - this.exT[k] >= EXPL_LIFE) continue;
      live++;
      const dx = this.exX[k] - px, dy = this.exY[k] - py, d = dx * dx + dy * dy;
      if (n < EXPL_DRAW) { // add, sift up
        let c = n++; while (c > 0) { const pa = (c - 1) >> 1; if (hd[pa] >= d) break; hd[c] = hd[pa]; hi[c] = hi[pa]; c = pa; } hd[c] = d; hi[c] = k;
      } else if (d < hd[0]) { // replace the farthest, sift down
        let c = 0; for (;;) { const l = 2 * c + 1; if (l >= n) break; const r = l + 1, m = r < n && hd[r] > hd[l] ? r : l; if (hd[m] <= d) break; hd[c] = hd[m]; hi[c] = hi[m]; c = m; } hd[c] = d; hi[c] = k;
      }
    }
    this.exLive = live; this.exSkipped += live - n;
    return n;
  }

  // ------------------------------------------------------------------ one frame
  render(encoder: GPUCommandEncoder, target: GPUTexture, alpha: number, time: number, dt: number, px: number, py: number): () => void {
    const o = this.o, d = this.device, tm = this.timer, q = d.queue;
    this.nowSec = performance.now() / 1000; this.frameNo++;
    tm.begin();
    let draws = 0;
    // Uniforms
    const aspect = o.cw / o.ch, pitch = o.pitch * Math.PI / 180, fov = 40 * Math.PI / 180;
    this.camera(px, py, aspect, pitch, fov, o.dist);
    const tod = o.tod === 'auto' ? ((time / o.daylen) % 1) : o.tod, lk = lookAt(tod);
    const f = this.ff, u = this.fu;
    f.set(this.vp, 0);
    const lvp = this.light(lk.sunDir, px, py);
    f.set(lvp, 16);
    f.set([...lk.sunDir, 0, ...lk.sunCol, 0, ...lk.shadowCol, 0, ...lk.rimCol, 0, ...lk.fogCol, lk.fogDensity, ...lk.skyTop, 0, ...lk.skyBot, 0], 32);
    f.set([this.cullCx, this.cullCy, this.halfW, this.halfH, px, py - o.dist * Math.cos(pitch), o.dist * Math.sin(pitch), 0, 1, 0, 0, 0, 0, Math.sin(pitch), Math.cos(pitch), 0], 60);
    const spawning = o.particles > 0 && this.spawnEvents > 0;
    const maxSpawn = Math.max(1, Math.ceil(96 * this.spawnScale));
    f.set([alpha, time, dt, tod], 76);
    u[80] = this.S; u[81] = this.S + this.n; u[82] = this.n; u[83] = spawning ? this.spawnEvents : 0;
    f.set([1 / Math.max(1, o.shadowRes), 0.0007, LIGHT_EXTENT, 0], 84);
    const bendAmt = 1.1;
    f.set([o.outlinePx * 2 * Math.tan(fov / 2) / this.internal[1], 0.95, bendAmt, 0.18], 88);
    u[92] = Math.round(CLUMPS_BASE * o.grass); u[93] = this.projCount; u[94] = this.poolCap; u[95] = maxSpawn;
    const nExpl = this.nearestExplosions(px, py);
    const dm = this.dmg.filter((x) => this.nowSec - x.t0 < 1.0);
    this.dmg = dm;
    f.set([this.spawnScale, this.internal[0], this.internal[1], nExpl, o.cw, o.ch, lk.rampShift, dm.length, this.playerHp, o.fog ? 1 : 0, px, py], 96);
    q.writeBuffer(this.frameBuf, 0, this.frameData);
    q.writeBuffer(this.indirectBuf, 0, this.indirectTemplate); // counts back to zero
    for (let j = 0; j < nExpl; j++) { const k = this.heapI[j], e = this.explData; e[j * 4] = this.exX[k]; e[j * 4 + 1] = this.exY[k]; e[j * 4 + 2] = this.exR[k]; e[j * 4 + 3] = (this.nowSec - this.exT[k]) / EXPL_LIFE; }
    if (nExpl) q.writeBuffer(this.explBuf, 0, this.explData, 0, nExpl * 4);
    for (let i = 0; i < dm.length; i++) { const x = dm[i]; this.dmgData.set([x.x, x.y, x.v, this.nowSec - x.t0], i * 4); }
    if (dm.length) q.writeBuffer(this.dmgBuf, 0, this.dmgData, 0, dm.length * 4);

    // Cull (entities, grass chunks, clamp counts)
    {
      const c = encoder.beginComputePass({ timestampWrites: tm.writes(SLOT.cull) });
      c.setBindGroup(0, this.bg.cull);
      c.setPipeline(this.pl.cull as GPUComputePipeline); c.dispatchWorkgroups(Math.ceil((this.S + this.n) / 64));
      c.setPipeline(this.pl.chunks as GPUComputePipeline); c.dispatchWorkgroups(Math.ceil(CHUNKS * CHUNKS / 64));
      c.setPipeline(this.pl.finalize as GPUComputePipeline); c.dispatchWorkgroups(1);
      c.end(); draws += 3;
    }
    // Shadow map
    if (this.map) {
      const p = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.shadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: tm.writes(SLOT.shadow) });
      p.executeBundles([this.bundles.shadow]); p.end(); draws += DRAW_KINDS.length;
    }
    // Bend map for the grass
    if (o.grass > 0) {
      const p = encoder.beginRenderPass({ colorAttachments: [{ view: this.bendView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }], timestampWrites: tm.writes(SLOT.bend) });
      p.setPipeline(this.pl.bend as GPURenderPipeline); p.setBindGroup(0, this.bg.fx); p.setBindGroup(1, this.bg.draw, [L_DYN * DRAW_STRIDE]); p.drawIndirect(this.indirectBuf, L_DYN * 20);
      p.end(); draws++;
    }
    // Sky, ground and grass (clears the targets)
    const clear = { r: 0, g: 0, b: 0, a: 0 };
    const attachments = (loadOp: GPULoadOp): GPURenderPassColorAttachment[] => {
      const a: GPURenderPassColorAttachment[] = [{ view: this.sceneA, clearValue: clear, loadOp, storeOp: 'store' }];
      if (this.edge) a.push({ view: this.normalView!, clearValue: clear, loadOp, storeOp: 'store' });
      if (o.overdraw) a.push({ view: this.countView!, clearValue: clear, loadOp, storeOp: 'store' });
      return a;
    };
    {
      const p = encoder.beginRenderPass({ colorAttachments: attachments('clear'), depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: tm.writes(SLOT.grass) });
      p.setBindGroup(0, this.bg.frame); p.setBindGroup(1, this.bg.draw, [0]);
      p.setPipeline(this.pl.sky as GPURenderPipeline); p.draw(3);
      p.setPipeline(this.pl.ground as GPURenderPipeline); p.draw(4);
      if (o.grass > 0) { p.setPipeline(this.pl.grass as GPURenderPipeline); p.drawIndirect(this.indirectBuf, IND_GRASS * 20); }
      p.end(); draws += 2 + (o.grass > 0 ? 1 : 0);
    }
    // The cel-shaded world (and blob shadows)
    {
      const p = encoder.beginRenderPass({ colorAttachments: attachments('load'), depthStencilAttachment: { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store' }, timestampWrites: tm.writes(SLOT.world) });
      p.executeBundles([this.bundles.world]); p.end(); draws += DRAW_KINDS.length + (this.map ? 0 : 1);
    }
    // Outlines: A, the inverted hull as another instanced pass; B, edges from depth and normals in a second post pass.
    const fxAtt = (view: GPUTextureView, loadOp: GPULoadOp): GPURenderPassColorAttachment[] => {
      const a: GPURenderPassColorAttachment[] = [{ view, clearValue: clear, loadOp, storeOp: 'store' }];
      if (o.overdraw) a.push({ view: this.countView!, clearValue: clear, loadOp: 'load', storeOp: 'store' });
      return a;
    };
    if (o.outline === 'hull') {
      const p = encoder.beginRenderPass({ colorAttachments: fxAtt(this.sceneA, 'load'), depthStencilAttachment: { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store' }, timestampWrites: tm.writes(SLOT.outline) });
      p.executeBundles([this.bundles.hull]); p.end(); draws += DRAW_KINDS.length;
    } else if (this.edge) {
      const p = encoder.beginRenderPass({ colorAttachments: [{ view: this.sceneB!, clearValue: clear, loadOp: 'clear', storeOp: 'store' }], timestampWrites: tm.writes(SLOT.outline) });
      p.setPipeline(this.pl.edge as GPURenderPipeline); p.setBindGroup(0, this.bg.edge); p.draw(3); p.end(); draws++;
    }
    // Particles: spawn from the events, move and cull on the GPU, draw
    const depthRO: GPURenderPassDepthStencilAttachment = { view: this.depthView, depthReadOnly: true };
    if (o.particles > 0) {
      if (spawning) {
        const c = encoder.beginComputePass({ timestampWrites: tm.writes(SLOT.pSpawn) });
        c.setPipeline(this.pl.spawn as GPUComputePipeline); c.setBindGroup(0, this.bg.spawn);
        c.dispatchWorkgroups(Math.min(65535, Math.ceil(this.spawnEvents * maxSpawn / 64)));
        c.end(); draws++;
        this.spawnEvents = 0; // events are spawned once, from the snapshot that carried them
      }
      {
        const c = encoder.beginComputePass({ timestampWrites: tm.writes(SLOT.pUpdate) });
        c.setPipeline(this.pl.update as GPUComputePipeline); c.setBindGroup(0, this.bg.update); c.dispatchWorkgroups(Math.ceil(this.poolCap / 64));
        c.end(); draws++;
      }
      const p = encoder.beginRenderPass({ colorAttachments: fxAtt(this.final, 'load'), depthStencilAttachment: depthRO, timestampWrites: tm.writes(SLOT.pDraw) });
      p.setPipeline(this.pl.particleDraw as GPURenderPipeline); p.setBindGroup(0, this.bg.fx); p.setBindGroup(1, this.bg.draw, [0]); p.drawIndirect(this.indirectBuf, IND_PART * 20);
      p.end(); draws++;
    }
    // Effects: auras, explosions, projectiles with trails
    {
      const p = encoder.beginRenderPass({ colorAttachments: fxAtt(this.final, 'load'), depthStencilAttachment: depthRO, timestampWrites: tm.writes(SLOT.effects) });
      p.setBindGroup(0, this.bg.fx);
      p.setPipeline(this.pl.aura as GPURenderPipeline); p.setBindGroup(1, this.bg.draw, [L_AURA * DRAW_STRIDE]); p.drawIndirect(this.indirectBuf, L_AURA * 20); draws++;
      p.setBindGroup(1, this.bg.draw, [0]);
      if (nExpl) { p.setPipeline(this.pl.expl as GPURenderPipeline); p.draw(6, nExpl); draws++; }
      if (this.projCount) { p.setPipeline(this.pl.proj as GPURenderPipeline); p.draw(6, this.projCount); draws++; }
      p.end();
    }
    // Overdraw histogram, every few frames, read back later
    let post: (() => void) | null = null;
    if (o.overdraw && --this.odCountdown <= 0) {
      const si = this.stageBusy.slice(0, 4).indexOf(false);
      if (si >= 0) {
        this.odCountdown = 8;
        encoder.clearBuffer(this.histBuf);
        const c = encoder.beginComputePass({ timestampWrites: tm.writes(SLOT.overdraw) });
        c.setPipeline(this.pl.hist as GPUComputePipeline); c.setBindGroup(0, this.bg.hist); c.dispatchWorkgroups(Math.ceil(this.internal[0] / 8), Math.ceil(this.internal[1] / 8)); c.end();
        encoder.copyBufferToBuffer(this.histBuf, 0, this.stage[si], 0, 512);
        this.stageBusy[si] = true;
        post = () => this.stage[si].mapAsync(GPUMapMode.READ, 0, 512).then(() => {
          const h = new Uint32Array(this.stage[si].getMappedRange(0, 512).slice(0));
          this.stage[si].unmap(); this.stageBusy[si] = false;
          let tot = 0, sum = 0, max = 0; for (let i = 0; i < 128; i++) { tot += h[i]; sum += i * h[i]; if (h[i]) max = i; }
          let acc = 0, p99 = 0; for (let i = 0; i < 128; i++) { acc += h[i]; if (acc >= tot * 0.99) { p99 = i; break; } }
          this.odSamples.push({ mean: sum / Math.max(1, tot), p99, max });
        }).catch(() => { this.stageBusy[si] = false; });
      }
    }
    // Bloom
    if (o.bloom) {
      const tp = (view: GPUTextureView, slot: number, bg: GPUBindGroup, pipe: GPURenderPipeline) => {
        const p = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: clear }], timestampWrites: tm.writes(slot) });
        p.setPipeline(pipe); p.setBindGroup(0, bg); p.draw(3); p.end(); draws++;
      };
      tp(this.bloomA!, SLOT.bloomBright, this.bg.bright, this.pl.bright as GPURenderPipeline);
      tp(this.bloomB!, SLOT.bloomH, this.bg.blurH, this.pl.blur as GPURenderPipeline);
      tp(this.bloomA!, SLOT.bloomV, this.bg.blurV, this.pl.blur as GPURenderPipeline);
    }
    // Upscale + sharpen + tone + grade, then the UI at canvas resolution
    const tv = target.createView();
    {
      const p = encoder.beginRenderPass({ colorAttachments: [{ view: tv, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }], timestampWrites: tm.writes(SLOT.upscale) });
      p.setPipeline(this.pl.final as GPURenderPipeline); p.setBindGroup(0, this.bg.final); p.draw(3); p.end(); draws++;
    }
    if (o.ui) {
      const p = encoder.beginRenderPass({ colorAttachments: [{ view: tv, loadOp: 'load', storeOp: 'store' }], timestampWrites: tm.writes(SLOT.ui) });
      p.setBindGroup(0, this.bg.ui);
      p.setPipeline(this.pl.uiBar as GPURenderPipeline); p.setBindGroup(1, this.bg.draw, [L_DYN * DRAW_STRIDE]); p.drawIndirect(this.indirectBuf, L_DYN * 20);
      p.setPipeline(this.pl.uiDmg as GPURenderPipeline); p.setBindGroup(1, this.bg.draw, [0]); if (dm.length) p.draw(6, dm.length);
      p.setPipeline(this.pl.uiHud as GPURenderPipeline); p.draw(6, 10);
      p.end(); draws += 3;
    }
    this.drawCalls = draws;

    // Counts and particle stats: read back a few frames later, never waiting on the GPU.
    let countsPost: (() => void) | null = null;
    if (!this.readbackBusy && this.frameNo % 20 === 0) {
      this.readbackBusy = true;
      const sb = this.stage[4];
      encoder.copyBufferToBuffer(this.indirectBuf, 0, sb, 0, IND_WORDS * 4);
      countsPost = () => sb.mapAsync(GPUMapMode.READ).then(() => {
        const r = new Uint32Array(sb.getMappedRange().slice(0));
        sb.unmap(); this.readbackBusy = false;
        for (let l = 0; l < NL; l++) this.counts[l] = r[l * 5 + 1];
        this.grassChunks = r[W_GRASS_CHUNKS]; this.alive = r[W_ALIVE]; this.aliveSamples.push(this.alive);
        // Particle count control: nudge the spawn scale so the pool holds the requested number of live particles.
        if (o.particles > 0 && this.spawnScale > 0) {
          const ratio = o.particles / Math.max(1, this.alive);
          this.spawnScale = Math.max(0.01, Math.min(3000, this.spawnScale * Math.pow(Math.min(3, Math.max(0.33, ratio)), 0.35)));
        }
      }).catch(() => { this.readbackBusy = false; });
    }
    const timerPost = tm.end(encoder);
    return () => { timerPost?.(); post?.(); countsPost?.(); };
  }

  // ------------------------------------------------------------------ camera and sun
  private vp = new Float32Array(16);
  private cullCx = 0; private cullCy = 0; private halfW = 0; private halfH = 0;
  private camera(x: number, y: number, aspect: number, pitch: number, fov: number, dist: number) {
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const view = mat4.lookAt([x, y - dist * c, dist * s], [x, y, 0], [0, 0, 1]);
    const proj = mat4.perspective(fov, aspect, 1, 400);
    this.vp = mat4.multiply(proj, view);
    // Conservative ground rectangle that covers the view frustum (the far edge is the wide one).
    const t = Math.tan(fov / 2);
    const far = Math.min(150, dist * s / Math.max(0.2, Math.sin(pitch - fov / 2)));
    this.halfW = far * t * aspect * 1.05;
    const near = dist * s / Math.sin(pitch + fov / 2);
    const yFar = -dist * c + far * Math.cos(pitch - fov / 2), yNear = -dist * c + near * Math.cos(pitch + fov / 2);
    this.cullCx = x; this.cullCy = y + (yFar + yNear) / 2; this.halfH = (yFar - yNear) / 2 * 1.05;
    this.cx = x; this.cy = y;
  }
  // An orthographic light box around the player, snapped to the shadow map's texel grid so shadows do not shimmer.
  private light(dir: [number, number, number], x: number, y: number) {
    const up: [number, number, number] = Math.abs(dir[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
    const xa = norm(cross(up, dir)), ya = cross(dir, xa);
    const texel = 2 * LIGHT_EXTENT / Math.max(1, this.o.shadowRes);
    const r = x * xa[0] + y * xa[1], u = x * ya[0] + y * ya[1];
    const sr = Math.round(r / texel) * texel - r, su = Math.round(u / texel) * texel - u;
    const c = [x + xa[0] * sr + ya[0] * su, y + xa[1] * sr + ya[1] * su, xa[2] * sr + ya[2] * su];
    const view = mat4.lookAt([c[0] + dir[0] * 150, c[1] + dir[1] * 150, c[2] + dir[2] * 150], c as [number, number, number], up);
    const proj = mat4.ortho(-LIGHT_EXTENT, LIGHT_EXTENT, -LIGHT_EXTENT, LIGHT_EXTENT, 1, 320);
    return mat4.multiply(proj, view);
  }

  info() {
    const c = this.counts;
    const sum = (a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += c[i]; return s; };
    return {
      internal: this.internal, staticInstances: this.S, dynamic: this.n, visible: sum(0, NK), shadowCasters: sum(L_SHADOW, L_SHADOW + NK), blobs: c[L_BLOB], dynVisible: c[L_DYN], auras: c[L_AURA],
      grassChunks: this.grassChunks, grassClumps: this.grassChunks * Math.round(CLUMPS_BASE * this.o.grass), alive: this.alive, poolCap: this.poolCap, spawnScale: this.spawnScale,
      triangles: this.triangles, limits: this.limitsCheck, eventsDropped: this.eventsDropped, explosionsLive: this.exLive, explosionFramesNotDrawn: this.exSkipped, truncated: this.truncated, shadowRes: this.map ? this.o.shadowRes : 0,
    };
  }
  overlay(): string[] {
    const i = this.info();
    return [
      `draw   visible ${i.visible} shadow casters ${i.shadowCasters} blobs ${i.blobs}  grass chunks ${i.grassChunks} (${i.grassClumps} clumps)  internal ${i.internal[0]}x${i.internal[1]}`,
      `fx     particles alive ${i.alive}/${i.poolCap} scale ${i.spawnScale.toFixed(1)}  proj ${this.projCount}  expl ${this.exLive} (drew ≤${EXPL_DRAW})  numbers ${this.dmg.length}`,
    ];
  }
}
void SLOTS;
