//! The catch-up protocol as a state machine driven by explicit operations (no threads), so the
//! property test can interleave job starts, job results, events and activations in any order.
//!
//! `Config` carries the protocol as first written (all fixes off, "literal") and the two fixes the
//! property test led to, plus a mutation switch that disables the generation check.

use crate::model::*;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// Mutation switch: false accepts stale results (generation not compared).
    pub check_generation: bool,
    /// Fix 1: events stamped exactly `last_tick` are not yet applied to a stored chunk (they were recorded
    /// after the state was captured by a job start or by `deactivate`), so catch-up takes `last_tick <= tick`.
    pub inclusive_bound: bool,
    /// Fix 2: a result is accepted only if it moves the chunk forward (`to_tick > last_tick`), so results
    /// delivered out of order cannot roll a chunk back.
    pub monotonic_accept: bool,
    /// Mutation switch: an accepted result drops every pending event with `tick <= to_tick` instead of only
    /// the ones the job consumed (loses events recorded after the job started).
    pub drop_by_tick: bool,
}

impl Config {
    pub const FIXED: Config = Config { check_generation: true, inclusive_bound: true, monotonic_accept: true, drop_by_tick: false };
    /// The protocol exactly as specified before any hole was found.
    pub const LITERAL: Config = Config { check_generation: true, inclusive_bound: false, monotonic_accept: false, drop_by_tick: false };
}

pub struct Slot {
    /// For an active chunk this is the live state, stepped every tick by the sim.
    pub chunk: Chunk,
    pub generation: u64,
    pub active: bool,
    /// Pending events of a stored chunk, in recorded order, with a unique sequence number.
    pub events: Vec<(u64, Event)>,
}

pub struct Job {
    pub chunk: usize,
    pub generation: u64,
    pub to_tick: u64,
    pub state: Chunk,
    pub events: Vec<Event>,
    pub seqs: Vec<u64>,
}

pub struct JobResult {
    pub chunk: usize,
    pub generation: u64,
    pub to_tick: u64,
    pub state: Chunk,
    pub seqs: Vec<u64>,
}

impl Job {
    /// What a job worker does: pure function of the copy it was given.
    pub fn run(self, par: &Params) -> JobResult {
        let mut state = self.state;
        catch_up(&mut state, self.to_tick, &self.events, par);
        JobResult { chunk: self.chunk, generation: self.generation, to_tick: self.to_tick, state, seqs: self.seqs }
    }
}

pub struct World {
    pub par: Params,
    pub cfg: Config,
    pub slots: Vec<Slot>,
    /// Ticks completed so far.
    pub now: u64,
    next_seq: u64,
}

impl World {
    pub fn new(par: Params, cfg: Config, chunks: Vec<Chunk>) -> World {
        let slots = chunks.into_iter().map(|chunk| Slot { chunk, generation: 0, active: false, events: Vec::new() }).collect();
        World { par, cfg, slots, now: 0, next_seq: 0 }
    }

    fn in_range(&self, last: u64, tick: u64, to: u64) -> bool {
        (if self.cfg.inclusive_bound { tick >= last } else { tick > last }) && tick <= to
    }

    /// The sim steps every active chunk once per tick; stored chunks are not touched.
    pub fn advance(&mut self, ticks: u64) {
        for _ in 0..ticks {
            self.now += 1;
            for s in self.slots.iter_mut().filter(|s| s.active) {
                step_one(&mut s.chunk, &self.par);
            }
        }
    }

    /// The summary sim records an event for `chunk` at the current tick (after this tick's step).
    pub fn record_event(&mut self, chunk: usize, kind: u16, arg: u32) {
        let ev = Event { tick: self.now, chunk: chunk as u16, kind, arg };
        let s = &mut self.slots[chunk];
        if s.active {
            apply_event(&mut s.chunk, &ev);
        } else {
            self.next_seq += 1;
            s.events.push((self.next_seq, ev));
        }
    }

    pub fn start_job(&mut self, chunk: usize) -> Option<Job> {
        let s = &self.slots[chunk];
        if s.active || self.now <= s.chunk.last_tick {
            return None;
        }
        let to = self.now;
        let mut events = Vec::new();
        let mut seqs = Vec::new();
        for (seq, e) in &s.events {
            if self.in_range(s.chunk.last_tick, e.tick, to) {
                events.push(*e);
                seqs.push(*seq);
            }
        }
        Some(Job { chunk, generation: s.generation, to_tick: to, state: s.chunk.clone(), events, seqs })
    }

    /// Returns true if the result was accepted.
    pub fn finish_job(&mut self, r: JobResult) -> bool {
        let s = &mut self.slots[r.chunk];
        if s.active {
            return false;
        }
        if self.cfg.check_generation && s.generation != r.generation {
            return false;
        }
        if self.cfg.monotonic_accept && r.to_tick <= s.chunk.last_tick {
            return false;
        }
        s.chunk = r.state;
        debug_assert_eq!(s.chunk.last_tick, r.to_tick);
        if self.cfg.drop_by_tick {
            s.events.retain(|(_, e)| e.tick > r.to_tick);
        } else {
            s.events.retain(|(seq, _)| !r.seqs.contains(seq));
        }
        true
    }

    /// Bumps the generation (in-flight results become stale), catches up inline, then the sim steps it.
    pub fn activate(&mut self, chunk: usize) {
        if self.slots[chunk].active {
            return;
        }
        let (now, cfg) = (self.now, self.cfg);
        let par = self.par;
        let s = &mut self.slots[chunk];
        s.generation += 1;
        let last = s.chunk.last_tick;
        let ev: Vec<Event> = s
            .events
            .iter()
            .map(|(_, e)| *e)
            .filter(|e| (if cfg.inclusive_bound { e.tick >= last } else { e.tick > last }) && e.tick <= now)
            .collect();
        catch_up(&mut s.chunk, now, &ev, &par);
        s.events.clear();
        s.active = true;
    }

    /// Stores the chunk at the current tick and bumps the generation.
    pub fn deactivate(&mut self, chunk: usize) {
        let s = &mut self.slots[chunk];
        if !s.active {
            return;
        }
        s.active = false;
        s.generation += 1;
    }
}
