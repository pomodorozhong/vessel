//! Vessel prototype sim. Stage 0: an empty sim that only counts ticks and
//! writes a snapshot header, so the worker/snapshot plumbing carries real traffic.

pub const HEADER_BYTES: usize = 64;
pub const ENTRY_BYTES: usize = 32;

#[cfg(target_arch = "wasm32")]
extern "C" {
    fn now() -> f64;
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn now() -> f64 {
    0.0
}

struct Sim {
    tick: u32,
    snapshot: Vec<u8>,
}

static mut SIM: Option<Sim> = None;

#[allow(static_mut_refs)]
fn sim() -> &'static mut Sim {
    unsafe { SIM.as_mut().expect("init not called") }
}

#[no_mangle]
pub extern "C" fn init(max_entities: u32, _seed: u32) {
    let snapshot = vec![0u8; HEADER_BYTES + ENTRY_BYTES * max_entities as usize];
    unsafe { SIM = Some(Sim { tick: 0, snapshot }) };
}

/// Steps the whole sim once. One coarse call per step, never one per entity.
#[no_mangle]
pub extern "C" fn step(_move_x: f32, _move_y: f32, _buttons: u32) {
    let s = sim();
    let t0 = unsafe { now() };
    let start = s.tick;
    s.tick += 1;
    let t1 = unsafe { now() };
    let h = &mut s.snapshot;
    h[0..4].copy_from_slice(&start.to_le_bytes());
    h[4..8].copy_from_slice(&s.tick.to_le_bytes());
    h[8..12].copy_from_slice(&0u32.to_le_bytes());
    h[16..20].copy_from_slice(&((t1 - t0) as f32).to_le_bytes());
}

#[no_mangle]
pub extern "C" fn snapshot_ptr() -> *const u8 {
    sim().snapshot.as_ptr()
}

#[no_mangle]
pub extern "C" fn snapshot_len() -> u32 {
    let s = sim();
    let count = u32::from_le_bytes([s.snapshot[8], s.snapshot[9], s.snapshot[10], s.snapshot[11]]);
    (HEADER_BYTES + ENTRY_BYTES * count as usize) as u32
}
