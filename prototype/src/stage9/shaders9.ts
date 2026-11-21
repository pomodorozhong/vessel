// WGSL for the Stage 9 renderer. Modules are generated from the options so that every look variant
// (outline method, shadow method, bloom, overdraw view) compiles only the code it uses.
import { CHUNKS, IND_GRASS, IND_PART, K_BUILDING, L_AURA, L_BLOB, L_DYN, L_SHADOW, NL, VAT_FRAMES, W_ALIVE, W_GRASS_CHUNKS } from './look';

export interface ShaderOpts { edge: boolean; shadowMap: boolean; bloom: boolean; overdraw: boolean }

const COMMON = /* wgsl */`
struct Frame {
  viewProj: mat4x4f,
  lightVP: mat4x4f,
  sunDir: vec4f, sunCol: vec4f, shadowCol: vec4f, rimCol: vec4f, fogCol: vec4f, skyTop: vec4f, skyBot: vec4f,
  cull: vec4f,       // ground rectangle on screen: centre x, y, half width, half height
  camPos: vec4f, camRight: vec4f, camUp: vec4f,
  p0: vec4f,         // alpha, time, dt, time of day
  p1: vec4u,         // static count, total instances, dynamic count, event count
  p2: vec4f,         // shadow texel, shadow bias, light extent, 0
  p3: vec4f,         // outline width per unit distance, grass height, bend strength, wind strength
  p4: vec4u,         // clumps per chunk, projectile count, particle capacity, max spawn per event
  p5: vec4f,         // spawn scale, internal width, internal height, explosion count
  p6: vec4f,         // canvas width, canvas height, ramp shift, damage number count
  p7: vec4f,         // player hp, fog on, player x, player y
}
struct Entry { p0: vec2f, p1: vec2f, f0: f32, f1: f32, packed: u32, radius: f32 }

fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn rnd3(seed: u32) -> vec3f { let a = pcg(seed); let b = pcg(a); let c = pcg(b); return vec3f(f32(a), f32(b), f32(c)) / 4294967295.0; }
fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1, 0)), u.x), mix(hash2(i + vec2f(0, 1)), hash2(i + vec2f(1, 1)), u.x), u.y);
}
fn place(e: Entry) -> vec3f {            // xy position and facing, interpolated inside one snapshot
  let p = mix(e.p0, e.p1, frame.p0.x);
  var df = e.f1 - e.f0;
  df = df - 6.2831853 * round(df / 6.2831853);
  return vec3f(p, e.f0 + df * frame.p0.x);
}
`;

const FRAME_BG = (b = 0) => /* wgsl */`@group(0) @binding(${b}) var<uniform> frame: Frame;`;
const SCENE_BINDINGS = /* wgsl */`
${FRAME_BG()}
@group(0) @binding(1) var<storage, read> instances: array<Entry>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
struct Draw { base: u32, vat: u32, baseVertex: u32, pad: u32 }
@group(1) @binding(0) var<uniform> draw: Draw;
`;

// Places one vertex of one visible instance in the world: enemies and the player (with the VAT walk cycle),
// buildings (a unit box scaled to the box) and trees. grow > 0 extrudes the vertex outwards, for the hull outline.
const PLACE = /* wgsl */`
@group(0) @binding(5) var vat: texture_2d<f32>;
struct Placed { w: vec3f, n: vec3f, ao: f32, kind: u32, packed: u32 }
fn placeVertex(position: vec4f, normal: vec4f, inst: u32, vi: u32, grow: f32) -> Placed {
  let id = visible[draw.base + inst];
  let e = instances[id];
  let kind = e.packed & 255u;
  var o: Placed;
  o.kind = kind; o.packed = e.packed; o.ao = position.w;
  var local = position.xyz * 4.0;
  if (kind == ${K_BUILDING}u) {
    // p0 = centre, p1 = half extents, f1 = height. The mesh is a box 1 x 1 x 1.8 around the origin in x, y.
    let sc = vec3f(e.p1.x * 2.0, e.p1.y * 2.0, e.f1 / 1.8);
    var xy = e.p0 + local.xy * sc.xy;
    var z = local.z * sc.z;
    if (grow > 0.0) { xy += sign(local.xy) * grow; z += select(-grow, grow, local.z > 0.9); }
    o.w = vec3f(xy, z); o.n = normal.xyz;
    return o;
  }
  let pl = place(e);
  if (kind < 17u) {
    // Crowd animation from a vertex animation texture: one row per frame, 32 frames per kind, one column per vertex.
    let phase = fract(frame.p0.y * (1.1 + 0.04 * f32(kind)) + f32(id % 61u) * 0.0164) * ${VAT_FRAMES}.0;
    let f0 = u32(phase) % ${VAT_FRAMES}u;
    let f1 = (f0 + 1u) % ${VAT_FRAMES}u;
    let col = vi - draw.baseVertex;
    local += mix(textureLoad(vat, vec2u(col, kind * ${VAT_FRAMES}u + f0), 0).xyz, textureLoad(vat, vec2u(col, kind * ${VAT_FRAMES}u + f1), 0).xyz, fract(phase)) * 0.5;
  }
  local *= e.radius;
  let c = cos(pl.z); let s = sin(pl.z);
  let n = normalize(vec3f(normal.x * c - normal.y * s, normal.x * s + normal.y * c, normal.z));
  o.w = vec3f(pl.x + local.x * c - local.y * s, pl.y + local.x * s + local.y * c, local.z) + n * grow;
  o.n = n;
  return o;
}
`;

export function shaders(o: ShaderOpts) {
  const { edge, shadowMap, bloom, overdraw } = o;
  const solidFields = `@location(0) color: vec4f,` + (edge ? ` @location(1) normal: vec4f,` : '') + (overdraw ? ` @location(${edge ? 2 : 1}) count: f32,` : '');
  const fxFields = `@location(0) color: vec4f,` + (overdraw ? ` @location(1) count: f32,` : '');
  const OUTS = /* wgsl */`
struct SolidOut { ${solidFields} }
struct FxOut { ${fxFields} }
fn solid(c: vec4f, n: vec4f) -> SolidOut { var o: SolidOut; o.color = c; ${edge ? 'o.normal = n;' : ''} ${overdraw ? 'o.count = 1.0;' : ''} return o; }
fn fx(c: vec4f) -> FxOut { var o: FxOut; o.color = c; ${overdraw ? 'o.count = 1.0;' : ''} return o; }
`;

  // ---------------------------------------------------------------- culling (compute)
  const cull = COMMON + /* wgsl */`
struct ListInfo { base: u32, cap: u32, pad0: u32, pad1: u32 }
${FRAME_BG(0)}
@group(0) @binding(1) var<storage, read> instances: array<Entry>;
@group(0) @binding(2) var<storage, read_write> visible: array<u32>;
@group(0) @binding(3) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> lists: array<ListInfo, ${NL}>;
@group(0) @binding(5) var<storage, read_write> gchunks: array<u32>;

fn inRect(lo: vec2f, hi: vec2f) -> bool {
  let c = frame.cull;
  return !(hi.x < c.x - c.z || lo.x > c.x + c.z || hi.y < c.y - c.w || lo.y > c.y + c.w);
}
fn push(list: u32, id: u32) {
  let slot = atomicAdd(&indirect[list * 5u + 1u], 1u);
  if (slot < lists[list].cap) { visible[lists[list].base + slot] = id; }
}
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= frame.p1.y) { return; }
  let e = instances[id];
  let kind = e.packed & 255u;
  // An interpolated entity is tested with a box around both of its positions, so it cannot pop at the edge.
  var lo = min(e.p0, e.p1); var hi = max(e.p0, e.p1);
  var m = e.radius * 6.0;
  if (kind == ${K_BUILDING}u) {
    if (e.f0 < 0.5) { return; }         // a wall that is not built
    lo = e.p0 - e.p1; hi = e.p0 + e.p1; m = e.f1 + 1.0;
  }
  lo -= vec2f(m); hi += vec2f(m);
  if (inRect(lo, hi)) {
    push(${0}u + kind, id);
    push(${L_BLOB}u, id);
    if (id >= frame.p1.x) {
      push(${L_DYN}u, id);
      if ((e.packed & 0x40000u) != 0u) { push(${L_AURA}u, id); }
    }
  }
  ${shadowMap ? `
  // Shadow casters are culled against the sun's frustum (an orthographic box around the player), not the camera's.
  let ctr = (lo + hi) * 0.5;
  let lp = frame.lightVP * vec4f(ctr, 0.0, 1.0);
  let mm = length(hi - lo) * 0.5 / frame.p2.z;
  if (abs(lp.x) <= 1.0 + mm && abs(lp.y) <= 1.0 + mm) { push(${L_SHADOW}u + kind, id); }` : ''}
}
// Grass is culled per chunk: a chunk is a square of the field that holds a fixed number of clumps.
@compute @workgroup_size(64) fn chunks(@builtin(global_invocation_id) gid: vec3u) {
  let ch = gid.x;
  if (ch >= ${CHUNKS * CHUNKS}u || frame.p4.x == 0u) { return; }
  let lo = vec2f(f32(ch % ${CHUNKS}u), f32(ch / ${CHUNKS}u)) * 8.0 - vec2f(2.0);
  if (inRect(lo, lo + vec2f(12.0))) { let s = atomicAdd(&indirect[${W_GRASS_CHUNKS}u], 1u); gchunks[s] = ch; }
}
@compute @workgroup_size(64) fn finalize(@builtin(local_invocation_id) lid: vec3u) {
  let t = lid.x;
  if (t == 0u) { let c = min(atomicLoad(&indirect[${W_GRASS_CHUNKS}u]), ${CHUNKS * CHUNKS}u); atomicStore(&indirect[${IND_GRASS * 5 + 1}u], c * frame.p4.x); }
  for (var l = t; l < ${NL}u; l += 64u) { let c = atomicLoad(&indirect[l * 5u + 1u]); atomicStore(&indirect[l * 5u + 1u], min(c, lists[l].cap)); }
}
`;

  // ---------------------------------------------------------------- shadow map (depth only)
  const shadow = COMMON + SCENE_BINDINGS + PLACE + /* wgsl */`
@vertex fn shadowVs(@location(0) position: vec4f, @location(1) normal: vec4f, @builtin(instance_index) inst: u32, @builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = placeVertex(position, normal, inst, vi, 0.0);
  return frame.lightVP * vec4f(p.w, 1.0);
}
`;

  // ---------------------------------------------------------------- the cel-shaded world
  const world = COMMON + OUTS + SCENE_BINDINGS + PLACE + /* wgsl */`
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(6) var ramp: texture_2d<f32>;
@group(0) @binding(7) var shadowTex: texture_depth_2d;
@group(0) @binding(8) var shadowSamp: sampler_comparison;
@group(0) @binding(9) var<storage, read> gchunks: array<u32>;
@group(0) @binding(10) var bendTex: texture_2d<f32>;

fn rampBand(x: f32) -> f32 { return textureSampleLevel(ramp, samp, vec2f(clamp(x, 0.0, 1.0), 0.5), 0.0).r; }
${shadowMap ? /* wgsl */`
// The sun's shadow map, compared once (the hardware filter gives a one texel soft edge), then pushed to a hard cel edge.
fn shadowAt(world: vec3f, n: vec3f) -> f32 {
  let lp = frame.lightVP * vec4f(world + n * 0.06, 1.0);
  let uv = vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { return 1.0; }
  let s = textureSampleCompareLevel(shadowTex, shadowSamp, uv, lp.z - frame.p2.y);
  return smoothstep(0.35, 0.65, s);
}` : `fn shadowAt(world: vec3f, n: vec3f) -> f32 { return 1.0; }`}

// Cel lighting: the sun term goes through the ramp (three bands), the bands pick between the shade colour and the sun colour,
// and a stepped rim light is added on lit edges.
fn shade(albedo: vec3f, n: vec3f, world: vec3f, ao: f32, sh: f32) -> vec3f {
  let v = normalize(frame.camPos.xyz - world);
  let ndl = dot(n, frame.sunDir.xyz);
  let band = rampBand((ndl * 0.5 + 0.5) * mix(0.35, 1.0, sh) - frame.p6.z);
  let lit = mix(frame.shadowCol.rgb, frame.sunCol.rgb, band);
  let rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
  let rimB = smoothstep(0.55, 0.6, rim) * clamp(ndl * 0.5 + 0.7, 0.0, 1.0) * (0.35 + 0.65 * sh);
  return albedo * lit * ao + frame.rimCol.rgb * rimB * 0.6;
}
fn fogged(col: vec3f, world: vec3f) -> vec3f {
  let d = length(world - frame.camPos.xyz);
  let f = (1.0 - exp(-pow(max(d - 22.0, 0.0) * frame.fogCol.w, 1.3))) * frame.p7.y;
  return mix(col, frame.fogCol.rgb, clamp(f, 0.0, 0.92));
}

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) world: vec3f, @location(2) n: vec3f, @location(3) ao: f32, @location(4) @interpolate(flat) flash: f32 }
@vertex fn vs(@location(0) position: vec4f, @location(1) normal: vec4f, @location(2) uv: vec2f, @builtin(instance_index) inst: u32, @builtin(vertex_index) vi: u32) -> VOut {
  let p = placeVertex(position, normal, inst, vi, 0.0);
  var out: VOut;
  out.pos = frame.viewProj * vec4f(p.w, 1.0);
  out.uv = uv; out.world = p.w; out.n = p.n; out.ao = p.ao;
  out.flash = f32((p.packed >> 16u) & 1u);
  return out;
}
@fragment fn fs(in: VOut) -> SolidOut {
  let n = normalize(in.n);
  let albedo = textureSample(atlas, samp, in.uv).rgb;
  var col = shade(albedo, n, in.world, in.ao, shadowAt(in.world, n));
  col = mix(col, vec3f(2.2, 1.9, 1.5), in.flash * 0.55);
  return solid(vec4f(fogged(col, in.world), 1.0), vec4f(n * 0.5 + 0.5, 1.0));
}

// Inverted hull outline: the same mesh, front faces culled, pushed out along the normal by a width that keeps its size on screen.
struct HOut { @builtin(position) pos: vec4f, @location(0) world: vec3f }
@vertex fn hullVs(@location(0) position: vec4f, @location(1) normal: vec4f, @builtin(instance_index) inst: u32, @builtin(vertex_index) vi: u32) -> HOut {
  let p0 = placeVertex(position, normal, inst, vi, 0.0);
  let d = length(p0.w - frame.camPos.xyz);
  let p = placeVertex(position, normal, inst, vi, frame.p3.x * d);
  var out: HOut;
  out.pos = frame.viewProj * vec4f(p.w, 1.0);
  out.world = p.w;
  return out;
}
@fragment fn hullFs(in: HOut) -> FxOut { return fx(vec4f(fogged(vec3f(0.035, 0.02, 0.05), in.world), 1.0)); }

// Sky: a painted, banded gradient behind everything (the ground covers most of it from the game camera).
struct SOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn skyVs(@builtin(vertex_index) vi: u32) -> SOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: SOut; out.pos = vec4f(p * 2.0 - 1.0, 1.0, 1.0); out.uv = vec2f(p.x, 1.0 - p.y); return out;
}
@fragment fn skyFs(in: SOut) -> SolidOut {
  var t = in.uv.y;
  t = mix(t, floor(t * 7.0) / 7.0 + 0.07, 0.45);            // painted bands
  let cloud = vnoise(in.uv * vec2f(6.0, 3.0) + vec2f(frame.p0.y * 0.01, 0.0));
  var col = mix(frame.skyTop.rgb, frame.skyBot.rgb, smoothstep(0.0, 1.0, t));
  col = mix(col, col * 1.25 + vec3f(0.05), smoothstep(0.55, 0.62, cloud) * 0.5 * (1.0 - t));
  return solid(vec4f(col, 1.0), vec4f(0.0));
}

// Ground: one quad over the visible part of the world, painted in three tones.
struct GOut { @builtin(position) pos: vec4f, @location(0) world: vec2f }
@vertex fn groundVs(@builtin(vertex_index) vi: u32) -> GOut {
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let w = clamp(frame.cull.xy + corner * frame.cull.zw * 1.15, vec2f(0.0), vec2f(256.0));
  var out: GOut;
  out.pos = frame.viewProj * vec4f(w, 0.0, 1.0);
  out.world = w;
  return out;
}
@fragment fn groundFs(in: GOut) -> SolidOut {
  let n1 = vnoise(in.world * 0.11) * 0.65 + vnoise(in.world * 0.43) * 0.35;
  let tone = floor(n1 * 3.0) / 3.0;
  var albedo = mix(vec3f(0.12, 0.23, 0.09), vec3f(0.26, 0.38, 0.13), tone * 1.4);
  albedo = mix(albedo, vec3f(0.34, 0.27, 0.15), smoothstep(0.62, 0.66, vnoise(in.world * 0.045 + vec2f(9.0, 3.0))) * 0.8);   // dirt patches
  let w3 = vec3f(in.world, 0.0);
  let col = shade(albedo, vec3f(0.0, 0.0, 1.0), w3, 1.0, shadowAt(w3, vec3f(0.0, 0.0, 1.0)));
  return solid(vec4f(fogged(col, w3), 1.0), vec4f(0.0, 0.0, 1.0, 0.0));
}

// Blob shadows (run 1's method): one soft quad on the ground under everything visible.
struct BOut { @builtin(position) pos: vec4f, @location(0) q: vec2f }
@vertex fn blobVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> BOut {
  let e = instances[visible[draw.base + inst]];
  var c = e.p0; var hs = vec2f(e.radius * 1.5);
  if ((e.packed & 255u) == ${K_BUILDING}u) { hs = e.p1 * 1.15 + vec2f(0.4); } else { c = place(e).xy; }
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let q = corners[vi];
  var out: BOut;
  out.pos = frame.viewProj * vec4f(c + q * hs, 0.03, 1.0);
  out.q = q;
  return out;
}
@fragment fn blobFs(in: BOut) -> SolidOut {
  let a = (1.0 - smoothstep(0.35, 1.0, length(in.q))) * 0.5;
  return solid(vec4f(0.0, 0.0, 0.0, a), vec4f(0.0));
}

// Grass: dense clumps (three crossed, alpha-tested quads) placed from a hash in the vertex shader inside the visible chunks.
struct GrOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) world: vec3f, @location(2) tone: vec4f }
@vertex fn grassVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> GrOut {
  let clumps = max(frame.p4.x, 1u);
  let chunk = gchunks[inst / clumps];
  let seed = chunk * 65599u + (inst % clumps) * 2246822519u;
  let r = rnd3(seed); let r2 = rnd3(seed ^ 0x9e3779b9u);
  let base = (vec2f(f32(chunk % ${CHUNKS}u), f32(chunk / ${CHUNKS}u)) + r.xy) * 8.0;
  let q = vi / 6u; let c = vi % 6u;
  let cs = array<vec2f, 6>(vec2f(-1, 0), vec2f(1, 0), vec2f(1, 1), vec2f(-1, 0), vec2f(1, 1), vec2f(-1, 1));
  let corner = cs[c];
  let ang = r.z * 6.2832 + f32(q) * 1.0472;
  let dirv = vec2f(cos(ang), sin(ang));
  let hgt = frame.p3.y * (0.6 + 0.8 * r2.x);
  let wid = 0.5 * (0.75 + 0.5 * r2.y);
  let hf = corner.y;
  // Wind sway, and a bend away from nearby entities read from the bend map (a low resolution texture the entities draw into).
  let sway = sin(frame.p0.y * 1.7 + base.x * 0.35 + base.y * 0.27) * 0.5 + sin(frame.p0.y * 0.9 + base.y * 0.6) * 0.3;
  let muv = vec2f((base.x - frame.cull.x) / (2.0 * frame.cull.z) + 0.5, 0.5 - (base.y - frame.cull.y) / (2.0 * frame.cull.w));
  let bend = textureSampleLevel(bendTex, samp, muv, 0.0).xyz;
  let disp = vec2f(0.8, 0.5) * sway * frame.p3.w * hf * hf + bend.xy * frame.p3.z * hf * hf;
  let z = hf * hgt * (1.0 - 0.5 * clamp(bend.z, 0.0, 1.0));
  let w = vec3f(base + dirv * corner.x * wid + disp, z);
  var out: GrOut;
  out.pos = frame.viewProj * vec4f(w, 1.0);
  out.uv = vec2f(corner.x * 0.5 + 0.5, hf);
  out.world = w;
  let hue = r2.z;
  out.tone = vec4f(mix(vec3f(0.09, 0.24, 0.07), mix(vec3f(0.45, 0.68, 0.18), vec3f(0.72, 0.66, 0.2), hue * 0.5), hf), hf);
  return out;
}
@fragment fn grassFs(in: GrOut) -> SolidOut {
  let cell = fract(in.uv.x * 3.0) - 0.5;
  let w = 0.46 * (1.0 - in.uv.y * 0.92);
  if (abs(cell) > w) { discard; }
  let sh = shadowAt(in.world, vec3f(0.0, 0.0, 1.0));
  let band = rampBand((frame.sunDir.z * 0.5 + 0.5) * mix(0.35, 1.0, sh) - frame.p6.z);
  let lit = mix(frame.shadowCol.rgb, frame.sunCol.rgb, band);
  let tip = step(0.5, in.tone.w + cell * 0.25);                 // painterly two-tone blades
  let col = mix(in.tone.rgb * 0.75, in.tone.rgb * 1.3, tip) * lit;
  return solid(vec4f(fogged(col, in.world), 1.0), vec4f(0.0, 0.0, 1.0, 0.0));
}
`;

  // ---------------------------------------------------------------- effects, particles, bend map
  const fxBindings = /* wgsl */`
${FRAME_BG(0)}
struct Particle { pos: vec3f, life: f32, vel: vec3f, size: f32, col: u32, ttl: f32, kind: u32, pad: u32 }
struct Proj { x0: f32, y0: f32, x1: f32, y1: f32, packed: u32, radius: f32 }
@group(0) @binding(1) var<storage, read> pool: array<Particle>;
@group(0) @binding(2) var<storage, read> plist: array<u32>;
@group(0) @binding(3) var<storage, read> projs: array<Proj>;
@group(0) @binding(4) var<storage, read> expl: array<vec4f>;
@group(0) @binding(5) var<storage, read> instances: array<Entry>;
@group(0) @binding(6) var<storage, read> visible: array<u32>;
struct Draw { base: u32, vat: u32, baseVertex: u32, pad: u32 }
@group(1) @binding(0) var<uniform> draw: Draw;
const CORNERS = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
`;
  const fxm = COMMON + OUTS + fxBindings + /* wgsl */`
// Bend map: every visible entity writes a push-away vector into a low resolution texture around the camera.
struct BmOut { @builtin(position) pos: vec4f, @location(0) q: vec2f }
@vertex fn bendVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> BmOut {
  let e = instances[visible[draw.base + inst]];
  let c = place(e).xy;
  let q = CORNERS[vi];
  let w = c + q * (e.radius * 2.6 + 0.5);
  var out: BmOut;
  out.pos = vec4f((w.x - frame.cull.x) / frame.cull.z, (w.y - frame.cull.y) / frame.cull.w, 0.0, 1.0);
  out.q = q;
  return out;
}
@fragment fn bendFs(in: BmOut) -> @location(0) vec4f {
  let d = length(in.q);
  if (d > 1.0) { discard; }
  let f = 1.0 - smoothstep(0.1, 1.0, d);
  return vec4f(normalize(in.q + vec2f(1e-4)) * f, f, 0.0);
}

struct POut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) col: vec3f, @location(2) fade: f32 }
@vertex fn pVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> POut {
  let p = pool[plist[inst]];
  let q = CORNERS[vi];
  let fade = clamp(p.life / p.ttl, 0.0, 1.0);
  let sz = p.size * (0.35 + 0.65 * fade);
  let w = p.pos + (frame.camRight.xyz * q.x + frame.camUp.xyz * q.y) * sz;
  var out: POut;
  out.pos = frame.viewProj * vec4f(w, 1.0);
  out.q = q; out.fade = fade;
  out.col = vec3f(f32(p.col & 255u), f32((p.col >> 8u) & 255u), f32((p.col >> 16u) & 255u)) / 255.0;
  return out;
}
@fragment fn pFs(in: POut) -> FxOut {
  let d2 = dot(in.q, in.q);
  if (d2 > 1.0) { discard; }
  let a = (1.0 - d2) * (1.0 - d2);
  return fx(vec4f(in.col * a * (1.2 + 3.0 * in.fade), 1.0));
}

// Auras: a pulsing translucent ring on the ground around enemies that have one.
struct AOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) k: f32 }
@vertex fn auraVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> AOut {
  let e = instances[visible[draw.base + inst]];
  let c = place(e).xy;
  let q = CORNERS[vi];
  var out: AOut;
  out.pos = frame.viewProj * vec4f(c + q * e.radius * 3.4, 0.06, 1.0);
  out.q = q; out.k = f32((e.packed & 255u) % 5u);
  return out;
}
@fragment fn auraFs(in: AOut) -> FxOut {
  let r = length(in.q);
  if (r > 1.0) { discard; }
  let pulse = 0.5 + 0.5 * sin(frame.p0.y * 3.0 + in.k);
  let ring = smoothstep(0.12, 0.0, abs(r - (0.7 + 0.12 * pulse)));
  let fill = (1.0 - r) * 0.22;
  let col = mix(vec3f(0.55, 0.2, 0.9), vec3f(0.2, 0.8, 0.9), in.k / 4.0);
  return fx(vec4f(col, clamp(ring * 0.6 + fill, 0.0, 0.7)));
}

// Explosions: a flash and an expanding ring.
struct EOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) age: f32 }
@vertex fn explVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> EOut {
  let e = expl[inst];
  let q = CORNERS[vi];
  let size = e.z * (0.6 + 1.2 * sqrt(e.w));
  let w = vec3f(e.xy, 1.0) + (frame.camRight.xyz * q.x + frame.camUp.xyz * q.y) * size;
  var out: EOut;
  out.pos = frame.viewProj * vec4f(w, 1.0);
  out.q = q; out.age = e.w;
  return out;
}
@fragment fn explFs(in: EOut) -> FxOut {
  let r = length(in.q);
  if (r > 1.0) { discard; }
  let k = 1.0 - in.age;
  let core = exp(-r * r * 5.0) * k * k * 1.6;  // Stage 12: 3.0 and 2.2 before; less of it passes the bloom threshold
  let ring = smoothstep(0.14, 0.0, abs(r - (0.2 + 0.8 * in.age))) * k * 1.3;
  return fx(vec4f(vec3f(1.0, 0.55, 0.15) * (core + ring) + vec3f(1.0, 0.85, 0.6) * core * 0.5, 1.0));
}

// Projectiles: a stretched ribbon from the tail of a short trail to the interpolated head.
struct TOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f }
@vertex fn projVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> TOut {
  let p = projs[inst];
  let a = vec2f(p.x0, p.y0); let b = vec2f(p.x1, p.y1);
  var dir = b - a;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / len, len > 1e-4);
  let head = vec3f(mix(a, b, frame.p0.x), 0.9);
  let tail = head - vec3f(dir * 2.6, 0.0);
  let fwd = cross(frame.camRight.xyz, frame.camUp.xyz);
  let side = normalize(cross(vec3f(dir, 0.0), fwd));
  let k = CORNERS[vi];
  let t = k.x * 0.5 + 0.5;                       // 0 tail, 1 head
  let w = mix(tail, head, t) + side * k.y * p.radius * 0.9 * (0.15 + 0.85 * t);
  var out: TOut;
  out.pos = frame.viewProj * vec4f(w, 1.0);
  out.uv = vec2f(t, k.y);
  let enemy = (p.packed >> 8u) & 1u; let explosive = (p.packed >> 10u) & 1u;
  out.col = select(select(vec3f(0.5, 0.9, 1.0), vec3f(1.0, 0.3, 0.2), enemy == 1u), vec3f(1.0, 0.6, 0.15), explosive == 1u);
  return out;
}
@fragment fn projFs(in: TOut) -> FxOut {
  let a = (1.0 - in.uv.y * in.uv.y) * (0.1 + 0.9 * in.uv.x * in.uv.x);
  return fx(vec4f(in.col * a * 4.0, 1.0));
}
`;

  // ---------------------------------------------------------------- particles (compute)
  const particleSpawn = COMMON + /* wgsl */`
struct Particle { pos: vec3f, life: f32, vel: vec3f, size: f32, col: u32, ttl: f32, kind: u32, pad: u32 }
struct Event { packed: u32, x: f32, y: f32, value: f32 }
${FRAME_BG(0)}
@group(0) @binding(1) var<storage, read_write> pool: array<Particle>;
@group(0) @binding(2) var<storage, read> events: array<Event>;
@group(0) @binding(3) var<storage, read_write> head: atomic<u32>;
fn pack(c: vec3f) -> u32 { let v = vec3u(clamp(c, vec3f(0.0), vec3f(1.0)) * 255.0); return v.x | (v.y << 8u) | (v.z << 16u); }
// Spawns particles from the snapshot's events. One thread per (event, particle index); the number per event type is scaled
// so the pool holds the requested number of live particles.
@compute @workgroup_size(64) fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  let S = max(frame.p4.w, 1u);
  let ei = gid.x / S; let j = gid.x % S;
  if (ei >= frame.p1.w) { return; }
  let ev = events[ei];
  let t = ev.packed & 255u;
  var base = 0.0; var col = vec3f(1.0); var speed = 4.0; var up = 3.0; var size = 0.16;
  switch (t) {
    case 0u: { base = 3.0; col = vec3f(1.0, 0.85, 0.4); speed = 3.0; up = 1.0; size = 0.12; }    // shot
    case 1u: { base = 6.0; col = vec3f(1.0, 0.6, 0.2); speed = 6.0; up = 3.0; size = 0.14; }     // hit
    case 2u: { base = 24.0; col = vec3f(0.9, 0.2, 0.6); speed = 6.5; up = 6.0; size = 0.2; }     // death
    case 3u: { base = 96.0; col = vec3f(1.0, 0.45, 0.1); speed = 11.0; up = 7.0; size = 0.3; }   // explosion
    case 4u: { base = 6.0; col = vec3f(0.4, 1.0, 0.5); speed = 3.0; up = 5.0; size = 0.14; }     // pickup
    case 5u: { base = 10.0; col = vec3f(0.7, 0.65, 0.55); speed = 3.5; up = 3.0; size = 0.2; }   // wall built
    case 6u: { base = 14.0; col = vec3f(0.6, 0.55, 0.5); speed = 4.5; up = 3.0; size = 0.22; }   // wall removed
    default: { base = 12.0; col = vec3f(1.0, 0.15, 0.1); speed = 5.0; up = 3.0; size = 0.18; }   // player hurt
  }
  let cnt = base * frame.p5.x;
  let r = rnd3(gid.x * 2654435761u + bitcast<u32>(frame.p0.y) * 40503u);
  if (f32(j) >= floor(cnt) + select(0.0, 1.0, r.x < fract(cnt)) ) { return; }
  let r2 = rnd3(pcg(gid.x) ^ bitcast<u32>(frame.p0.y));
  let slot = atomicAdd(&head, 1u) % frame.p4.z;
  let a = r2.x * 6.2832; let sp = speed * (0.25 + 0.75 * r2.y);
  var p: Particle;
  p.pos = vec3f(ev.x + (r2.z - 0.5) * 0.4, ev.y + (r.y - 0.5) * 0.4, 0.4 + r.z * 0.6);
  p.vel = vec3f(cos(a) * sp, sin(a) * sp, up * (0.3 + 0.9 * r.z));
  p.ttl = 0.5 + 1.1 * r.y; p.life = p.ttl;
  p.size = size * (0.6 + 0.8 * r2.z);
  p.col = pack(col * (0.8 + 0.4 * r.x)); p.kind = t; p.pad = 0u;
  pool[slot] = p;
}
`;
  const particleUpdate = COMMON + /* wgsl */`
struct Particle { pos: vec3f, life: f32, vel: vec3f, size: f32, col: u32, ttl: f32, kind: u32, pad: u32 }
${FRAME_BG(0)}
@group(0) @binding(1) var<storage, read_write> pool: array<Particle>;
@group(0) @binding(2) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> plist: array<u32>;
// Moves every live particle, counts them, and appends the ones inside the camera's ground rectangle to the draw list.
@compute @workgroup_size(64) fn update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= frame.p4.z) { return; }
  var p = pool[i];
  if (p.life <= 0.0) { return; }
  let dt = frame.p0.z;
  p.vel.z -= 9.0 * dt;
  p.vel *= 1.0 - 1.3 * dt;
  p.pos += p.vel * dt;
  if (p.pos.z < 0.05) { p.pos.z = 0.05; p.vel.z = -p.vel.z * 0.35; p.vel.x *= 0.7; p.vel.y *= 0.7; }
  p.life -= dt;
  pool[i] = p;
  if (p.life > 0.0) {
    atomicAdd(&indirect[${W_ALIVE}u], 1u);
    let c = frame.cull;
    if (p.pos.x > c.x - c.z && p.pos.x < c.x + c.z && p.pos.y > c.y - c.w - 4.0 && p.pos.y < c.y + c.w + 4.0) {
      let s = atomicAdd(&indirect[${IND_PART * 5 + 1}u], 1u);
      plist[s] = i;
    }
  }
}
`;

  // ---------------------------------------------------------------- post: edge detection, bloom, upscale
  const fsVs = /* wgsl */`
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: VOut; out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); out.uv = vec2f(p.x, 1.0 - p.y); return out;
}
`;
  const edgeM = fsVs + /* wgsl */`
// Outline method B: edges from depth and normals. An edge is drawn on the nearer solid pixel where a neighbour is much
// farther away, or where the normals of two solid pixels differ a lot.
struct Edge { width: f32, near: f32, far: f32, pad: f32 }
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var normals: texture_2d<f32>;
@group(0) @binding(3) var<uniform> edge: Edge;
fn lin(d: f32) -> f32 { return edge.near * edge.far / (edge.far - d * (edge.far - edge.near)); }
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let c = textureLoad(color, p, 0);
  let n0 = textureLoad(normals, p, 0);
  if (n0.a < 0.5) { return c; }
  let dims = vec2i(textureDimensions(color));
  let z0 = lin(textureLoad(depth, p, 0));
  let w = i32(edge.width);
  var e = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = select(select(vec2i(w, 0), vec2i(-w, 0), k == 1), select(vec2i(0, w), vec2i(0, -w), k == 3), k >= 2);
    let q = clamp(p + o, vec2i(0), dims - vec2i(1));
    let z = lin(textureLoad(depth, q, 0));
    let n = textureLoad(normals, q, 0);
    e = max(e, step(0.35 + 0.012 * z0, z - z0));
    if (n.a > 0.5) { e = max(e, step(dot(n0.rgb * 2.0 - 1.0, n.rgb * 2.0 - 1.0), 0.65)); }
  }
  return vec4f(mix(c.rgb, vec3f(0.035, 0.02, 0.05), e * 0.92), 1.0);
}
`;
  const bloomM = fsVs + /* wgsl */`
struct Blur { dir: vec2f, thr: f32, pad: f32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> blur: Blur;
// Bloom, first half: keep what is brighter than the threshold, at half resolution.
@fragment fn bright(in: VOut) -> @location(0) vec4f {
  let t = blur.dir;
  var s = textureSampleLevel(src, samp, in.uv + vec2f(-t.x, -t.y) * 0.5, 0.0).rgb + textureSampleLevel(src, samp, in.uv + vec2f(t.x, -t.y) * 0.5, 0.0).rgb
        + textureSampleLevel(src, samp, in.uv + vec2f(-t.x, t.y) * 0.5, 0.0).rgb + textureSampleLevel(src, samp, in.uv + vec2f(t.x, t.y) * 0.5, 0.0).rgb;
  s *= 0.25;
  return vec4f(max(s - vec3f(blur.thr), vec3f(0.0)), 1.0);
}
@fragment fn blurFs(in: VOut) -> @location(0) vec4f {
  var w = array<f32, 5>(0.2270, 0.1946, 0.1216, 0.0540, 0.0162);
  var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb * w[0];
  for (var i = 1; i < 5; i++) {
    let o = blur.dir * f32(i) * 1.5;
    c += (textureSampleLevel(src, samp, in.uv + o, 0.0).rgb + textureSampleLevel(src, samp, in.uv - o, 0.0).rgb) * w[i];
  }
  return vec4f(c, 1.0);
}
`;
  const finalM = fsVs + /* wgsl */`
struct Post { texel: vec2f, sharpen: f32, bloom: f32, lift: vec4f, gain: vec4f }
@group(0) @binding(0) var world: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> post: Post;
${bloom ? '@group(0) @binding(3) var bloomTex: texture_2d<f32>;' : ''}
// Upscale (bilinear) + contrast-adaptive sharpening (as in run 1) + bloom + tone curve + grade, one pass.
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(world, linearSampler, in.uv, 0.0).rgb;
  let n = textureSampleLevel(world, linearSampler, in.uv + vec2f(0.0, -post.texel.y), 0.0).rgb;
  let s = textureSampleLevel(world, linearSampler, in.uv + vec2f(0.0, post.texel.y), 0.0).rgb;
  let w = textureSampleLevel(world, linearSampler, in.uv + vec2f(-post.texel.x, 0.0), 0.0).rgb;
  let e = textureSampleLevel(world, linearSampler, in.uv + vec2f(post.texel.x, 0.0), 0.0).rgb;
  let lo = min(c, min(min(n, s), min(w, e)));
  let hi = max(c, max(max(n, s), max(w, e)));
  let amount = post.sharpen * (1.0 - clamp(max(hi.r - lo.r, max(hi.g - lo.g, hi.b - lo.b)) * 1.5, 0.0, 1.0));
  var col = clamp(c + (c * 4.0 - n - s - w - e) * amount, lo, hi);
  ${bloom ? 'col += textureSampleLevel(bloomTex, linearSampler, in.uv, 0.0).rgb * post.bloom;' : ''}
  col = col / (1.0 + max(col - vec3f(0.7), vec3f(0.0)) * 0.9);                            // soft shoulder for HDR values
  col = pow(max(col * post.gain.rgb + post.lift.rgb, vec3f(0.0)), vec3f(post.gain.a));   // grade
  let v = in.uv - 0.5;
  col *= 1.0 - dot(v, v) * 0.3;                                                          // vignette
  return vec4f(col, 1.0);
}
`;

  // ---------------------------------------------------------------- UI (after the upscale, at canvas resolution)
  const ui = COMMON + /* wgsl */`
${FRAME_BG(0)}
@group(0) @binding(1) var<storage, read> instances: array<Entry>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var<storage, read> dmg: array<vec4f>;
struct Draw { base: u32, vat: u32, baseVertex: u32, pad: u32 }
@group(1) @binding(0) var<uniform> draw: Draw;
const CORNERS = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1));
const OFF = vec4f(2.0, 2.0, 2.0, 1.0);
fn toNdc(px: vec2f) -> vec2f { return vec2f(px.x / frame.p6.x * 2.0, px.y / frame.p6.y * 2.0); }

// Health bars over enemies, from the hp bits of the snapshot. Full health draws nothing.
struct BarOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) hp: f32 }
@vertex fn barVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> BarOut {
  let e = instances[visible[draw.base + inst]];
  let hp = f32((e.packed >> 8u) & 255u) / 255.0;
  var out: BarOut;
  out.uv = CORNERS[vi]; out.hp = hp;
  let pl = place(e);
  if (hp > 0.985 || distance(pl.xy, frame.p7.zw) > 14.0) { out.pos = OFF; return out; } // damaged and near the player only (BAR_RANGE 14)
  let top = vec3f(pl.xy, 4.0 * e.radius + 0.5);
  let clip = frame.viewProj * vec4f(top, 1.0);
  let d = length(top - frame.camPos.xyz);
  let size = vec2f(max(e.radius, 0.45) * 46.0 * 34.0 / d, 5.0) * frame.p6.x / 1920.0;
  let ndc = clip.xy / clip.w + toNdc((CORNERS[vi] - vec2f(0.5, 0.0)) * size);
  out.pos = vec4f(ndc, 0.0, 1.0);
  return out;
}
@fragment fn barFs(in: BarOut) -> @location(0) vec4f {
  let edge = min(min(in.uv.x, 1.0 - in.uv.x) * 20.0, min(in.uv.y, 1.0 - in.uv.y) * 3.0);
  if (edge < 1.0) { return vec4f(0.0, 0.0, 0.0, 0.85); }
  if (in.uv.x < in.hp) { return vec4f(mix(vec3f(0.9, 0.15, 0.1), vec3f(0.3, 0.85, 0.25), in.hp), 0.95); }
  return vec4f(0.1, 0.05, 0.05, 0.8);
}

// Floating damage numbers: seven-segment digits drawn in the fragment shader (no font texture).
struct DOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) val: f32, @location(2) age: f32 }
@vertex fn dmgVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> DOut {
  let d = dmg[inst];
  var out: DOut;
  out.uv = CORNERS[vi]; out.val = d.z; out.age = d.w;
  if (d.z <= 0.0) { out.pos = OFF; return out; }
  let clip = frame.viewProj * vec4f(d.x, d.y, 3.2 + d.w * 2.5, 1.0);
  let digits = 1.0 + floor(log2(d.z) * 0.30103 + 1e-4);
  let size = vec2f(digits * 13.0, 20.0) * frame.p6.x / 1920.0 * (1.2 - 0.3 * d.w);
  out.pos = vec4f(clip.xy / clip.w + toNdc((CORNERS[vi] - vec2f(0.5, 0.0)) * size), 0.0, 1.0);
  return out;
}
const SEG = array<u32, 10>(0x3Fu, 0x06u, 0x5Bu, 0x4Fu, 0x66u, 0x6Du, 0x7Du, 0x07u, 0x7Fu, 0x6Fu);
fn bar(u: f32, v: f32, x0: f32, y0: f32, x1: f32, y1: f32) -> bool { return u >= x0 && u <= x1 && v >= y0 && v <= y1; }
@fragment fn dmgFs(in: DOut) -> @location(0) vec4f {
  let digits = 1.0 + floor(log2(in.val) * 0.30103 + 1e-4);
  let cellF = in.uv.x * digits;
  let pw = digits - 1.0 - floor(cellF);                         // 0 = ones digit
  let digit = u32(floor(in.val / pow(10.0, pw) + 1e-3)) % 10u;
  let u = fract(cellF); let v = in.uv.y;
  let m = SEG[digit]; let t = 0.14;
  var on = false;
  if ((m & 1u) != 0u)  { on = on || bar(u, v, 0.15, 1.0 - t, 0.85, 1.0); }
  if ((m & 2u) != 0u)  { on = on || bar(u, v, 0.85 - t, 0.5, 0.85, 1.0); }
  if ((m & 4u) != 0u)  { on = on || bar(u, v, 0.85 - t, 0.0, 0.85, 0.5); }
  if ((m & 8u) != 0u)  { on = on || bar(u, v, 0.15, 0.0, 0.85, t); }
  if ((m & 16u) != 0u) { on = on || bar(u, v, 0.15, 0.0, 0.15 + t, 0.5); }
  if ((m & 32u) != 0u) { on = on || bar(u, v, 0.15, 0.5, 0.15 + t, 1.0); }
  if ((m & 64u) != 0u) { on = on || bar(u, v, 0.15, 0.5 - t * 0.5, 0.85, 0.5 + t * 0.5); }
  if (!on) { discard; }
  return vec4f(mix(vec3f(1.0, 0.95, 0.5), vec3f(1.0, 0.45, 0.2), clamp(in.val / 100.0, 0.0, 1.0)), clamp(1.0 - in.age * 0.9, 0.0, 1.0));
}

// HUD: the player's bars and ability slots.
struct HOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) uv: vec2f }
@vertex fn hudVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> HOut {
  let rects = array<vec4f, 10>(
    vec4f(-0.965, 0.885, -0.5, 0.955), vec4f(-0.96, 0.89, -0.505, 0.95), vec4f(-0.965, 0.835, -0.6, 0.87), vec4f(-0.96, 0.84, -0.7, 0.865),
    vec4f(-0.25, -0.96, -0.17, -0.8), vec4f(-0.15, -0.96, -0.07, -0.8), vec4f(-0.05, -0.96, 0.03, -0.8), vec4f(0.05, -0.96, 0.13, -0.8), vec4f(0.15, -0.96, 0.23, -0.8),
    vec4f(0.74, -0.97, 0.97, -0.58));
  let r = rects[inst];
  var rr = r;
  var col = vec4f(0.0, 0.0, 0.0, 0.55);
  if (inst == 1u) { rr.z = mix(rr.x, rr.z, clamp(frame.p7.x, 0.0, 1.0)); col = vec4f(0.85, 0.15, 0.12, 0.95); }
  if (inst == 3u) { rr.z = mix(rr.x, rr.z, 0.55 + 0.4 * sin(frame.p0.y * 0.3)); col = vec4f(0.25, 0.55, 0.95, 0.95); }
  if (inst >= 4u && inst <= 8u) { col = vec4f(0.1, 0.1, 0.14, 0.7); }
  if (inst == 9u) { col = vec4f(0.0, 0.0, 0.0, 0.4); }
  var out: HOut;
  out.pos = vec4f(mix(rr.xy, rr.zw, CORNERS[vi]), 0.0, 1.0);
  out.color = col; out.uv = CORNERS[vi];
  return out;
}
@fragment fn hudFs(in: HOut) -> @location(0) vec4f { return in.color; }
`;

  const odHist = /* wgsl */`
@group(0) @binding(0) var cnt: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> hist: array<atomic<u32>, 128>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(cnt);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let v = textureLoad(cnt, gid.xy, 0).r;
  atomicAdd(&hist[min(u32(max(v, 0.0) + 0.5), 127u)], 1u);
}
`;
  return { cull, shadow, world, fx: fxm, particleSpawn, particleUpdate, edge: edgeM, bloom: bloomM, final: finalM, ui, odHist };
}
