// WGSL for the Stage 3 renderer (kept as strings; the prototype does not need a .wgsl loader).
const KIND_COUNT = 20, SHADOW = 20, VAT_FRAMES = 32, POS_SCALE = 4;

const COMMON = /* wgsl */`
struct Frame {
  viewProj: mat4x4f,
  sun: vec4f,       // xyz direction to the sun, w ambient strength
  sunColor: vec4f,
  cull: vec4f,      // ground rectangle on screen: centre x, y, half width, half height
  alpha: f32, time: f32, staticCount: u32, total: u32,
}
struct Entry { p0: vec2f, p1: vec2f, f0: f32, f1: f32, kind: u32, radius: f32 }
`;

export const CULL_WGSL = COMMON + /* wgsl */`
struct KindInfo { base: u32, cap: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> instances: array<Entry>;
@group(0) @binding(2) var<storage, read_write> visible: array<u32>;
@group(0) @binding(3) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> kinds: array<KindInfo, ${KIND_COUNT + 1}>;

@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= frame.total) { return; }
  let e = instances[id];
  // An interpolated entity is tested with a box around both of its positions, so it cannot pop at the edge.
  let lo = min(e.p0, e.p1) - vec2f(e.radius * 6.0);
  let hi = max(e.p0, e.p1) + vec2f(e.radius * 6.0);
  let c = frame.cull;
  if (hi.x < c.x - c.z || lo.x > c.x + c.z || hi.y < c.y - c.w || lo.y > c.y + c.w) { return; }
  let slot = atomicAdd(&indirect[e.kind * 5u + 1u], 1u);
  visible[kinds[e.kind].base + slot] = id;
  if (id >= frame.staticCount) {
    let s = atomicAdd(&indirect[${SHADOW}u * 5u + 1u], 1u);
    visible[kinds[${SHADOW}].base + s] = id;
  }
}
`;

export const WORLD_WGSL = COMMON + /* wgsl */`
struct Draw { base: u32, vat: u32, baseVertex: u32, pad: u32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> instances: array<Entry>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var atlasSampler: sampler;
@group(0) @binding(5) var vat: texture_2d<f32>;
@group(1) @binding(0) var<uniform> draw: Draw;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) light: vec3f }

fn place(e: Entry) -> vec3f {            // xy position and facing, interpolated inside one snapshot
  let p = mix(e.p0, e.p1, frame.alpha);
  var df = e.f1 - e.f0;
  df = df - 6.2831853 * round(df / 6.2831853);
  return vec3f(p, e.f0 + df * frame.alpha);
}

@vertex fn vs(@location(0) position: vec4f, @location(1) normal: vec4f, @location(2) uv: vec2f,
              @builtin(instance_index) inst: u32, @builtin(vertex_index) vi: u32) -> VOut {
  let id = visible[draw.base + inst];
  let e = instances[id];
  let pl = place(e);
  var local = position.xyz * ${POS_SCALE}.0;
  if (draw.vat == 1u) {
    // Crowd animation from a vertex animation texture: one row per frame, one column per vertex.
    let phase = fract(frame.time * 1.4 + f32(id % 61u) * 0.0164) * ${VAT_FRAMES}.0;
    let f0 = u32(phase) % ${VAT_FRAMES}u;
    let f1 = (f0 + 1u) % ${VAT_FRAMES}u;
    let col = vi - draw.baseVertex;
    local += mix(textureLoad(vat, vec2u(col, f0), 0).xyz, textureLoad(vat, vec2u(col, f1), 0).xyz, fract(phase));
  }
  local *= e.radius;
  let c = cos(pl.z); let s = sin(pl.z);
  let world = vec3f(pl.x + local.x * c - local.y * s, pl.y + local.x * s + local.y * c, local.z);
  let n = normalize(vec3f(normal.x * c - normal.y * s, normal.x * s + normal.y * c, normal.z));
  var out: VOut;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.uv = uv;
  // Baked ambient occlusion (position.w) times ambient plus one sun.
  out.light = position.w * (frame.sun.w + frame.sunColor.rgb * max(0.0, dot(n, frame.sun.xyz)));
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  return vec4f(textureSample(atlas, atlasSampler, in.uv).rgb * in.light, 1.0);
}

// Ground: one quad over the visible rectangle, shaded procedurally.
struct GOut { @builtin(position) pos: vec4f, @location(0) world: vec2f }
@vertex fn groundVs(@builtin(vertex_index) vi: u32) -> GOut {
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let w = frame.cull.xy + corner * frame.cull.zw * 1.3;
  var out: GOut;
  out.pos = frame.viewProj * vec4f(w, 0.0, 1.0);
  out.world = w;
  return out;
}
@fragment fn groundFs(in: GOut) -> @location(0) vec4f {
  let cell = floor(in.world);
  let h = fract(sin(dot(cell, vec2f(12.9898, 78.233))) * 43758.5453);
  let base = mix(vec3f(0.16, 0.25, 0.12), vec3f(0.22, 0.30, 0.14), h);
  let light = frame.sun.w + frame.sunColor.rgb * frame.sun.z;
  return vec4f(base * light, 1.0);
}

// Blob shadows: one soft quad on the ground under every visible moving entity.
struct SOut { @builtin(position) pos: vec4f, @location(0) q: vec2f }
@vertex fn shadowVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> SOut {
  let id = visible[draw.base + inst];
  let e = instances[id];
  let pl = place(e);
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let q = corners[vi];
  var out: SOut;
  out.pos = frame.viewProj * vec4f(pl.xy + q * e.radius * 1.5, 0.03, 1.0);
  out.q = q;
  return out;
}
@fragment fn shadowFs(in: SOut) -> @location(0) vec4f {
  let a = (1.0 - smoothstep(0.35, 1.0, length(in.q))) * 0.45;
  return vec4f(0.0, 0.0, 0.0, a);
}
`;

export const FINAL_WGSL = /* wgsl */`
struct Post { texel: vec2f, sharpen: f32, pad: f32, lift: vec4f, gain: vec4f }
@group(0) @binding(0) var world: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> post: Post;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: VOut;
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}
// Upscale (bilinear) + contrast-adaptive sharpening in the style of FSR 1's RCAS + colour grading, one pass.
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(world, linearSampler, in.uv, 0.0).rgb;
  let n = textureSampleLevel(world, linearSampler, in.uv + vec2f(0.0, -post.texel.y), 0.0).rgb;
  let s = textureSampleLevel(world, linearSampler, in.uv + vec2f(0.0, post.texel.y), 0.0).rgb;
  let w = textureSampleLevel(world, linearSampler, in.uv + vec2f(-post.texel.x, 0.0), 0.0).rgb;
  let e = textureSampleLevel(world, linearSampler, in.uv + vec2f(post.texel.x, 0.0), 0.0).rgb;
  let lo = min(c, min(min(n, s), min(w, e)));
  let hi = max(c, max(max(n, s), max(w, e)));
  // Sharpen less where local contrast is already high, and never leave the local range.
  let amount = post.sharpen * (1.0 - clamp(max(hi.r - lo.r, max(hi.g - lo.g, hi.b - lo.b)) * 2.0, 0.0, 1.0));
  var col = clamp(c + (c * 4.0 - n - s - w - e) * amount, lo, hi);
  col = pow(max(col * post.gain.rgb + post.lift.rgb, vec3f(0.0)), vec3f(post.gain.a));  // grade
  let v = in.uv - 0.5;
  col *= 1.0 - dot(v, v) * 0.35;                                                         // vignette
  return vec4f(col, 1.0);
}
// UI: a few rectangles drawn after the upscale at canvas resolution.
struct UOut { @builtin(position) pos: vec4f, @location(0) color: vec4f }
@vertex fn uiVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> UOut {
  let rects = array<vec4f, 3>(vec4f(-0.95, -0.95, -0.45, -0.90), vec4f(-0.945, -0.94, -0.60, -0.91), vec4f(0.70, -0.95, 0.95, -0.55));
  let colors = array<vec4f, 3>(vec4f(0.0, 0.0, 0.0, 0.6), vec4f(0.8, 0.15, 0.1, 0.9), vec4f(0.0, 0.0, 0.0, 0.45));
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1));
  let r = rects[inst];
  var out: UOut;
  out.pos = vec4f(mix(r.xy, r.zw, corners[vi]), 0.0, 1.0);
  out.color = colors[inst];
  return out;
}
@fragment fn uiFs(in: UOut) -> @location(0) vec4f { return in.color; }
`;
