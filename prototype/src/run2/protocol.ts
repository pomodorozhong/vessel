// Run 2 snapshot layout (v2), shared by the combat sim (prototype/combat), the Stage 9 renderer,
// the Stage 10 mixer and the Stage 11 wave. Little endian throughout. Run 1's layout in
// src/protocol.ts is left as it is, so run 1's pages still rerun unchanged.
//
// Header (128 bytes), indexed as u32/f32 slots:
//   u32[0] tickStart        u32[1] tickEnd          u32[2] entity count N (player + enemies)
//   u32[3] input seq applied (written by JS)        u32[4] projectile count P
//   u32[5] event count E    u32[6] events dropped this step (over capacity)
//   u32[7] flags: bit 0 = the building list changed this step (a 'world' message follows)
//   f32[8] player x0  f32[9] player y0  f32[10] player x1  f32[11] player y1  f32[12] player hp (0..1)
//   u32[13] live pickups
//   f64 @56 (slots 14-15) wall time the step ended (performance.timeOrigin + now)
//   f64 @64 (slots 16-17) wall time the step was due
//   f32[18] step ms         f32[19] pair finding    f32[20] exact checks    f32[21] crowd pushing
//   f32[22] projectiles     f32[23] area effects    f32[24] flow field      f32[25] AI
//   f32[26] integrate+sort  f32[27] snapshot write  f32[28] obstacle/building collision
//   f32[29] building updates   f32[30..31] spare
//
// Entities at byte 128, 32 bytes each:
//   f32 x0, y0, x1, y1, facing0, facing1,
//   u32 packed: bits 0-7 kind, bits 8-15 hp (0..255), bits 16-23 flags (FLAG_*), f32 radius
// Projectiles at 128 + 32*N, 24 bytes each:
//   f32 x0, y0, x1, y1 (x1, y1 is the hit point if it hit this step), u32 packed: bits 0-7 kind,
//   bit 8 owner (0 player, 1 enemy), bit 9 hit this step, bit 10 explosive; f32 radius
// Events at 128 + 32*N + 24*P, 16 bytes each:
//   u32 packed: bits 0-7 type (EV_*), bits 8-15 kind, bits 16-23 owner/flags; f32 x, f32 y, f32 value
//   value: damage for EV_HIT, radius for EV_EXPLOSION, building index for EV_WALL_*.
//
// Buildings (walls and boxes) are sent in a separate 'world' message when they change:
//   Float32Array of 5 floats per box: x0, y0, x1, y1, active (0/1). Index = building index.

export const V2_HEADER_BYTES = 128;
export const V2_ENTITY_BYTES = 32;
export const V2_PROJECTILE_BYTES = 24;
export const V2_EVENT_BYTES = 16;

export const FLAG_HIT = 1 << 0; // took damage this step (hit flash)
export const FLAG_SHOOTER = 1 << 1;
export const FLAG_AURA = 1 << 2;
export const FLAG_LARGE = 1 << 3;

// Event kinds, as the combat sim (prototype/combat/src/shared.rs) numbers them: enemy kinds 0-15, the player 16,
// and 255 for an EV_HIT on a wall or building. Kinds 7 and 15 are large (shared.rs `is_large`).
export const KIND_COUNT = 16;
export const KIND_PLAYER = 16;
export const KIND_WALL = 255;
export const isLargeKind = (k: number) => k < KIND_COUNT && k % 8 === 7;

export const EV_SHOT = 0;
export const EV_HIT = 1;
export const EV_DEATH = 2;
export const EV_EXPLOSION = 3;
export const EV_PICKUP = 4;
export const EV_WALL_BUILT = 5;
export const EV_WALL_REMOVED = 6;
export const EV_PLAYER_HURT = 7;
export const EV_TYPES = 8;

export const v2SnapshotBytes = (maxEntities: number, maxProjectiles: number, maxEvents: number) =>
  V2_HEADER_BYTES + V2_ENTITY_BYTES * maxEntities + V2_PROJECTILE_BYTES * maxProjectiles + V2_EVENT_BYTES * maxEvents;

export interface V2View {
  n: number;
  p: number;
  e: number;
  entityOffset: number;
  projectileOffset: number;
  eventOffset: number;
  usedBytes: number;
}

export function v2View(buf: ArrayBuffer): V2View {
  const u = new Uint32Array(buf, 0, 32);
  const n = u[2], p = u[4], e = u[5];
  const entityOffset = V2_HEADER_BYTES;
  const projectileOffset = entityOffset + V2_ENTITY_BYTES * n;
  const eventOffset = projectileOffset + V2_PROJECTILE_BYTES * p;
  return { n, p, e, entityOffset, projectileOffset, eventOffset, usedBytes: eventOffset + V2_EVENT_BYTES * e };
}
