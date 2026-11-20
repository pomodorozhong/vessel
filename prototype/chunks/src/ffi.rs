//! Plain `extern "C"` exports (no wasm-bindgen). Buffers live in WASM memory; JS gets pointers from
//! `alloc`, copies bytes in and out. Ticks are passed as f64 (exact up to 2^53).

use crate::model::*;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn chunk_len(plots: u32, furnaces: u32) -> u32 {
    chunk_byte_len(plots as usize, furnaces as usize) as u32
}

/// Writes a random valid chunk (game parameters, last_tick 0) into `out`.
#[no_mangle]
pub unsafe extern "C" fn init_chunk(out: *mut u8, plots: u32, furnaces: u32, seed: u32) {
    let mut rng = Rng(seed as u64);
    let c = random_chunk(&mut rng, plots as usize, furnaces as usize, &GAME);
    let len = chunk_byte_len(plots as usize, furnaces as usize);
    c.to_bytes(std::slice::from_raw_parts_mut(out, len));
}

/// Writes `n` sorted random events with ticks in (from, to] (16 bytes each).
#[no_mangle]
pub unsafe extern "C" fn gen_events(out: *mut u8, n: u32, seed: u32, from: f64, to: f64) {
    let mut rng = Rng(seed as u64 ^ 0xABCD);
    let ev = random_events(&mut rng, n as usize, from as u64, to as u64);
    let buf = std::slice::from_raw_parts_mut(out, n as usize * EVENT_BYTES);
    for (i, e) in ev.iter().enumerate() {
        e.to_bytes(&mut buf[i * EVENT_BYTES..(i + 1) * EVENT_BYTES]);
    }
}

unsafe fn load(chunk: *const u8, chunk_bytes: u32, events: *const u8, n: u32) -> (Chunk, Vec<Event>) {
    let c = Chunk::from_bytes(std::slice::from_raw_parts(chunk, chunk_bytes as usize));
    let eb = std::slice::from_raw_parts(events, n as usize * EVENT_BYTES);
    let ev = (0..n as usize).map(|i| Event::from_bytes(&eb[i * EVENT_BYTES..])).collect();
    (c, ev)
}

/// Direct calculation, in place. Events must be sorted with ticks in [last_tick, to].
#[no_mangle]
pub unsafe extern "C" fn catch_up_chunk(chunk: *mut u8, chunk_bytes: u32, events: *const u8, n: u32, to: f64) {
    let (mut c, ev) = load(chunk, chunk_bytes, events, n);
    catch_up(&mut c, to as u64, &ev, &GAME);
    c.to_bytes(std::slice::from_raw_parts_mut(chunk, chunk_bytes as usize));
}

/// Reference: every tick one by one, in place.
#[no_mangle]
pub unsafe extern "C" fn replay_chunk(chunk: *mut u8, chunk_bytes: u32, events: *const u8, n: u32, to: f64) {
    let (mut c, ev) = load(chunk, chunk_bytes, events, n);
    replay(&mut c, to as u64, &ev, &GAME);
    c.to_bytes(std::slice::from_raw_parts_mut(chunk, chunk_bytes as usize));
}
