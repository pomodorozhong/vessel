//! Vessel prototype, Stage 6: chunk catch-up. See `model` (systems, replay, catch_up), `world`
//! (the catch-up protocol), `harness` (property test and shrinker) and `ffi` (WASM exports).

pub mod harness;
pub mod model;
pub mod world;

#[cfg(target_arch = "wasm32")]
mod ffi;
