// Procedural meshes for the prototype (there is no art yet). One vertex and one index buffer hold
// every kind. Vertices are packed into 16 bytes: position snorm16x4 (xyz, w = baked AO),
// normal snorm8x4, uv unorm16x2.
export const DYNAMIC_KINDS = 17;   // 16 enemy kinds + the player (kind 16)
export const KIND_WALL = 17;       // play plane, static
export const KIND_GRASS = 18;      // background layer, static
export const KIND_TREE = 19;       // foreground layer, static
export const KIND_COUNT = 20;
export const POS_SCALE = 4;        // snorm16 position * POS_SCALE = model units
export const VERTEX_BYTES = 16;
export const ATLAS_COLS = 8, ATLAS_ROWS = 4;

export interface MeshRange { firstIndex: number; indexCount: number; baseVertex: number; vertexCount: number }
export interface MeshSet { vertices: ArrayBuffer; indices: Uint16Array; ranges: MeshRange[]; triangles: number }

class Builder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; idx: number[] = [];
  get count() { return this.pos.length / 3; }
  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg = 10, rings = 6) {
    const base = this.count;
    for (let r = 0; r <= rings; r++) {
      const v = r / rings, phi = v * Math.PI;
      for (let s = 0; s <= seg; s++) {
        const u = s / seg, th = u * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(th), ny = Math.sin(phi) * Math.sin(th), nz = Math.cos(phi);
        this.pos.push(cx + nx * rx, cy + ny * ry, cz + nz * rz);
        const l = Math.hypot(nx / rx, ny / ry, nz / rz);
        this.nrm.push(nx / rx / l, ny / ry / l, nz / rz / l);
        this.uv.push(u, v);
      }
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
      const a = base + r * (seg + 1) + s, b = a + seg + 1;
      this.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
    const faces: [number[], number[], number[]][] = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
      [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
    ];
    const h = [hx, hy, hz];
    for (const [n, u, v] of faces) {
      const base = this.count;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        this.pos.push(cx + (n[0] + u[0] * su + v[0] * sv) * h[0], cy + (n[1] + u[1] * su + v[1] * sv) * h[1], cz + (n[2] + u[2] * su + v[2] * sv) * h[2]);
        this.nrm.push(n[0], n[1], n[2]);
        this.uv.push(su * 0.5 + 0.5, sv * 0.5 + 0.5);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

// A low-poly character facing +X: body, head, two arms, two legs. About 460 vertices, 720 triangles.
function character(b: Builder, k: number) {
  const fat = 0.75 + 0.05 * (k % 5), tall = 1.6 + 0.12 * (k % 7), head = 0.42 + 0.03 * (k % 4);
  b.ellipsoid(0, 0, tall * 0.95, fat * 0.75, fat, tall * 0.55);            // body
  b.ellipsoid(0.1, 0, tall * 1.6 + head * 0.6, head, head, head);           // head
  b.ellipsoid(0.15, fat * 1.05, tall * 1.0, 0.2, 0.2, tall * 0.45);         // arms
  b.ellipsoid(0.15, -fat * 1.05, tall * 1.0, 0.2, 0.2, tall * 0.45);
  b.ellipsoid(0, fat * 0.45, tall * 0.25, 0.24, 0.24, tall * 0.3);          // legs
  b.ellipsoid(0, -fat * 0.45, tall * 0.25, 0.24, 0.24, tall * 0.3);
}

export function buildMeshes(): MeshSet {
  const all: Builder[] = [];
  for (let k = 0; k < DYNAMIC_KINDS; k++) { const b = new Builder(); character(b, k); all.push(b); }
  { const b = new Builder(); b.box(0, 0, 0.9, 0.5, 0.5, 0.9); all.push(b); }                                   // wall block: 1 cell wide, radius is 1
  { const b = new Builder(); for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3; b.box(0, 0, 0.25, Math.cos(a) * 0.45 + 0.02, Math.sin(a) * 0.45 + 0.02, 0.25); } all.push(b); } // grass tuft
  { const b = new Builder(); b.ellipsoid(0, 0, 1.2, 0.22, 0.22, 1.2, 8, 3); b.ellipsoid(0, 0, 2.9, 1.5, 1.5, 1.1); b.ellipsoid(0.6, 0.3, 3.6, 1.0, 1.0, 0.8); b.ellipsoid(-0.5, -0.4, 3.5, 1.1, 1.1, 0.8); all.push(b); } // tree

  const totalV = all.reduce((a, b) => a + b.count, 0), totalI = all.reduce((a, b) => a + b.idx.length, 0);
  const vertices = new ArrayBuffer(totalV * VERTEX_BYTES);
  const dv = new DataView(vertices);
  const indices = new Uint16Array((totalI + 1) & ~1);
  const ranges: MeshRange[] = [];
  let v0 = 0, i0 = 0;
  all.forEach((b, kind) => {
    let zMax = 0;
    for (let i = 0; i < b.count; i++) zMax = Math.max(zMax, b.pos[i * 3 + 2]);
    const cellU = (kind % ATLAS_COLS) / ATLAS_COLS, cellV = Math.floor(kind / ATLAS_COLS) / ATLAS_ROWS;
    for (let i = 0; i < b.count; i++) {
      const o = (v0 + i) * VERTEX_BYTES;
      const s16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v / POS_SCALE * 32767)));
      dv.setInt16(o, s16(b.pos[i * 3]), true); dv.setInt16(o + 2, s16(b.pos[i * 3 + 1]), true); dv.setInt16(o + 4, s16(b.pos[i * 3 + 2]), true);
      // Baked ambient occlusion: darker near the ground and on downward faces.
      const ao = Math.min(1, 0.35 + 0.65 * (b.pos[i * 3 + 2] / zMax)) * (0.8 + 0.2 * Math.max(0, b.nrm[i * 3 + 2] * 0.5 + 0.5));
      dv.setInt16(o + 6, Math.round(ao * 32767), true);
      for (let c = 0; c < 3; c++) dv.setInt8(o + 8 + c, Math.round(b.nrm[i * 3 + c] * 127));
      dv.setUint16(o + 12, Math.round((cellU + (0.02 + 0.96 * b.uv[i * 2]) / ATLAS_COLS) * 65535), true);
      dv.setUint16(o + 14, Math.round((cellV + (0.02 + 0.96 * b.uv[i * 2 + 1]) / ATLAS_ROWS) * 65535), true);
    }
    indices.set(b.idx, i0);
    ranges.push({ firstIndex: i0, indexCount: b.idx.length, baseVertex: v0, vertexCount: b.count });
    v0 += b.count; i0 += b.idx.length;
  });
  return { vertices, indices, ranges, triangles: totalI / 3 };
}

export const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'snorm16x4' },
    { shaderLocation: 1, offset: 8, format: 'snorm8x4' },
    { shaderLocation: 2, offset: 12, format: 'unorm16x2' },
  ],
};
