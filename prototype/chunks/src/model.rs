//! Chunk state and its time-based systems (crops, furnaces), plus the two ways to advance it:
//! `replay` (the reference: one tick at a time) and `catch_up` (closed form per span between events).
//! Everything is integer math, so the two compare exactly.
//!
//! Tick semantics: a chunk with `last_tick = L` has been stepped through tick L. At tick t the
//! order is: step the systems once, then apply the events stamped t (in recorded order).

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Ticks a crop spends in growth stages 0, 1 and 2 (each >= 1).
    pub stage_ticks: [u32; 3],
    /// Ticks a ripe crop (stage 3) stays ripe before it withers (becomes an empty plot).
    pub spoil_ticks: u32,
    /// Ticks to smelt one item (>= 1).
    pub smelt_ticks: u32,
    /// Output cap; a furnace pauses when its output reaches it.
    pub output_cap: u32,
}

/// Values for the browser measurements, at 30 ticks/s: stages of 5, 10 and 15 min, spoil after 30 min,
/// 10 s per item, an output cap of 100.
pub const GAME: Params = Params { stage_ticks: [9_000, 18_000, 27_000], spoil_ticks: 54_000, smelt_ticks: 300, output_cap: 100 };
/// Tiny values so that random sequences hit every transition often.
pub const TEST: Params = Params { stage_ticks: [5, 9, 13], spoil_ticks: 17, smelt_ticks: 4, output_cap: 6 };

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Plot {
    pub planted: bool,
    /// 0..=2 growing, 3 ripe.
    pub stage: u8,
    /// Ticks into the current stage (for stage 3: ticks since it became ripe).
    pub prog: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Furnace {
    pub fuel: u32,
    pub input: u32,
    pub output: u32,
    /// Ticks into the item being smelted, always < smelt_ticks.
    pub prog: u32,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Chunk {
    pub last_tick: u64,
    pub plots: Vec<Plot>,
    pub furnaces: Vec<Furnace>,
}

/// An event from the stub summary simulation. `chunk` is only used by whoever routes it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Event {
    pub tick: u64,
    pub chunk: u16,
    pub kind: u16,
    pub arg: u32,
}

pub const KIND_RAID: u16 = 0;
pub const KIND_REPLANT: u16 = 1;
pub const KIND_SUPPLY: u16 = 2;
pub const KIND_COUNT: u16 = 3;

const PLOT_EMPTY: Plot = Plot { planted: false, stage: 0, prog: 0 };

// ---- one tick ----

#[inline]
fn plot_step(p: &mut Plot, par: &Params) {
    if !p.planted {
        return;
    }
    p.prog += 1;
    if p.stage < 3 {
        if p.prog == par.stage_ticks[p.stage as usize] {
            p.stage += 1;
            p.prog = 0;
        }
    } else if p.prog == par.spoil_ticks {
        *p = PLOT_EMPTY;
    }
}

#[inline]
fn furnace_step(f: &mut Furnace, par: &Params) {
    if f.input > 0 && f.fuel > 0 && f.output < par.output_cap {
        f.fuel -= 1;
        f.prog += 1;
        if f.prog == par.smelt_ticks {
            f.prog = 0;
            f.input -= 1;
            f.output += 1;
        }
    }
}

pub fn step_one(c: &mut Chunk, par: &Params) {
    for p in c.plots.iter_mut() {
        plot_step(p, par);
    }
    for f in c.furnaces.iter_mut() {
        furnace_step(f, par);
    }
    c.last_tick += 1;
}

// ---- n ticks at once (no event inside the span) ----

fn plot_advance(p: &mut Plot, n: u64, par: &Params) {
    if !p.planted || n == 0 {
        return;
    }
    let mut remaining = par.spoil_ticks as u64;
    for s in p.stage as usize..3 {
        remaining += par.stage_ticks[s] as u64;
    }
    remaining -= p.prog as u64;
    if n >= remaining {
        *p = PLOT_EMPTY;
        return;
    }
    let mut q = p.prog as u64 + n;
    while p.stage < 3 && q >= par.stage_ticks[p.stage as usize] as u64 {
        q -= par.stage_ticks[p.stage as usize] as u64;
        p.stage += 1;
    }
    p.prog = q as u32;
}

fn furnace_advance(f: &mut Furnace, n: u64, par: &Params) {
    if n == 0 || f.input == 0 || f.fuel == 0 || f.output >= par.output_cap {
        return;
    }
    let k = par.smelt_ticks as u64;
    let items = (f.input.min(par.output_cap - f.output)) as u64;
    let need = items * k - f.prog as u64;
    let s = n.min(f.fuel as u64).min(need);
    f.fuel -= s as u32;
    let total = f.prog as u64 + s;
    let done = total / k;
    f.prog = (total % k) as u32;
    f.input -= done as u32;
    f.output += done as u32;
}

/// Closed-form fast-forward of every system by `n` ticks, valid when nothing else happens in the span.
pub fn fast_forward(c: &mut Chunk, n: u64, par: &Params) {
    for p in c.plots.iter_mut() {
        plot_advance(p, n, par);
    }
    for f in c.furnaces.iter_mut() {
        furnace_advance(f, n, par);
    }
    c.last_tick += n;
}

// ---- events ----

pub fn apply_event(c: &mut Chunk, e: &Event) {
    match e.kind {
        KIND_RAID => {
            // Destroys every crop at an even plot index, steals half of each furnace's output,
            // and drops a supply crate (fuel and input) into one furnace.
            for (i, p) in c.plots.iter_mut().enumerate() {
                if i % 2 == 0 {
                    *p = PLOT_EMPTY;
                }
            }
            for f in c.furnaces.iter_mut() {
                f.output -= f.output / 2;
            }
            let m = c.furnaces.len() as u32;
            if m > 0 {
                let f = &mut c.furnaces[(e.arg % m) as usize];
                f.fuel = f.fuel.saturating_add(5 + e.arg % 40);
                f.input = f.input.saturating_add(1 + e.arg % 3);
            }
        }
        KIND_REPLANT => {
            for p in c.plots.iter_mut() {
                if !p.planted {
                    *p = Plot { planted: true, stage: 0, prog: 0 };
                }
            }
        }
        KIND_SUPPLY => {
            for f in c.furnaces.iter_mut() {
                f.fuel = f.fuel.saturating_add(20 + e.arg % 30);
                f.input = f.input.saturating_add(2);
            }
        }
        _ => {}
    }
}

// ---- the two ways to get from last_tick to `to` ----
// `events` must be sorted by tick (stable), every tick in [c.last_tick, to]. Events stamped exactly
// c.last_tick are applied first, before any tick is stepped.

/// Reference: every tick one by one.
pub fn replay(c: &mut Chunk, to: u64, events: &[Event], par: &Params) {
    let mut i = 0;
    while i < events.len() && events[i].tick == c.last_tick {
        apply_event(c, &events[i]);
        i += 1;
    }
    while c.last_tick < to {
        step_one(c, par);
        while i < events.len() && events[i].tick == c.last_tick {
            apply_event(c, &events[i]);
            i += 1;
        }
    }
    debug_assert!(i == events.len());
}

/// Direct calculation: O(events + plots + furnaces) per call, never O(ticks).
pub fn catch_up(c: &mut Chunk, to: u64, events: &[Event], par: &Params) {
    for e in events {
        debug_assert!(e.tick >= c.last_tick && e.tick <= to);
        fast_forward(c, e.tick - c.last_tick, par);
        apply_event(c, e);
    }
    fast_forward(c, to - c.last_tick, par);
}

// ---- bytes (shared by the WASM exports and the save blob) ----

pub const CHUNK_HEADER: usize = 16;
pub const PLOT_BYTES: usize = 8;
pub const FURNACE_BYTES: usize = 16;
pub const EVENT_BYTES: usize = 16;

pub fn chunk_byte_len(plots: usize, furnaces: usize) -> usize {
    CHUNK_HEADER + PLOT_BYTES * plots + FURNACE_BYTES * furnaces
}

fn rd32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

impl Chunk {
    pub fn to_bytes(&self, out: &mut [u8]) {
        out[0..8].copy_from_slice(&self.last_tick.to_le_bytes());
        out[8..12].copy_from_slice(&(self.plots.len() as u32).to_le_bytes());
        out[12..16].copy_from_slice(&(self.furnaces.len() as u32).to_le_bytes());
        let mut o = CHUNK_HEADER;
        for p in &self.plots {
            out[o] = p.planted as u8;
            out[o + 1] = p.stage;
            out[o + 2] = 0;
            out[o + 3] = 0;
            out[o + 4..o + 8].copy_from_slice(&p.prog.to_le_bytes());
            o += PLOT_BYTES;
        }
        for f in &self.furnaces {
            out[o..o + 4].copy_from_slice(&f.fuel.to_le_bytes());
            out[o + 4..o + 8].copy_from_slice(&f.input.to_le_bytes());
            out[o + 8..o + 12].copy_from_slice(&f.output.to_le_bytes());
            out[o + 12..o + 16].copy_from_slice(&f.prog.to_le_bytes());
            o += FURNACE_BYTES;
        }
    }

    pub fn from_bytes(b: &[u8]) -> Chunk {
        let last_tick = u64::from_le_bytes(b[0..8].try_into().unwrap());
        let np = rd32(b, 8) as usize;
        let nf = rd32(b, 12) as usize;
        let mut o = CHUNK_HEADER;
        let mut plots = Vec::with_capacity(np);
        for _ in 0..np {
            plots.push(Plot { planted: b[o] != 0, stage: b[o + 1], prog: rd32(b, o + 4) });
            o += PLOT_BYTES;
        }
        let mut furnaces = Vec::with_capacity(nf);
        for _ in 0..nf {
            furnaces.push(Furnace { fuel: rd32(b, o), input: rd32(b, o + 4), output: rd32(b, o + 8), prog: rd32(b, o + 12) });
            o += FURNACE_BYTES;
        }
        Chunk { last_tick, plots, furnaces }
    }
}

impl Event {
    pub fn to_bytes(&self, out: &mut [u8]) {
        out[0..8].copy_from_slice(&self.tick.to_le_bytes());
        out[8..10].copy_from_slice(&self.chunk.to_le_bytes());
        out[10..12].copy_from_slice(&self.kind.to_le_bytes());
        out[12..16].copy_from_slice(&self.arg.to_le_bytes());
    }
    pub fn from_bytes(b: &[u8]) -> Event {
        Event {
            tick: u64::from_le_bytes(b[0..8].try_into().unwrap()),
            chunk: u16::from_le_bytes(b[8..10].try_into().unwrap()),
            kind: u16::from_le_bytes(b[10..12].try_into().unwrap()),
            arg: rd32(b, 12),
        }
    }
}

// ---- random valid states (used by the property test and the browser benchmarks) ----

/// splitmix64
#[derive(Clone)]
pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform-ish in 0..n (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

pub fn random_chunk(rng: &mut Rng, plots: usize, furnaces: usize, par: &Params) -> Chunk {
    let mut c = Chunk { last_tick: 0, plots: Vec::with_capacity(plots), furnaces: Vec::with_capacity(furnaces) };
    for _ in 0..plots {
        if rng.below(2) == 0 {
            c.plots.push(PLOT_EMPTY);
        } else {
            let stage = rng.below(4) as u8;
            let dur = if stage < 3 { par.stage_ticks[stage as usize] } else { par.spoil_ticks };
            c.plots.push(Plot { planted: true, stage, prog: rng.below(dur as u64) as u32 });
        }
    }
    for _ in 0..furnaces {
        let input = rng.below(6) as u32;
        let prog = if input > 0 { rng.below(par.smelt_ticks as u64) as u32 } else { 0 };
        let fuel_range = (par.smelt_ticks as u64 * 8).max(8);
        c.furnaces.push(Furnace { fuel: rng.below(fuel_range) as u32, input, output: rng.below(par.output_cap as u64 + 1) as u32, prog });
    }
    c
}

/// `n` events with ticks in (from, to], sorted, spread uniformly.
pub fn random_events(rng: &mut Rng, n: usize, from: u64, to: u64) -> Vec<Event> {
    let span = to - from;
    let mut v: Vec<Event> = (0..n)
        .map(|_| Event { tick: from + 1 + rng.below(span), chunk: 0, kind: rng.below(KIND_COUNT as u64) as u16, arg: rng.next() as u32 })
        .collect();
    v.sort_by_key(|e| e.tick);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catch_up_equals_replay_random_spans() {
        let mut rng = Rng(7);
        for par in [&TEST, &GAME] {
            for case in 0..2000 {
                let base = random_chunk(&mut rng, 8, 4, par);
                let span = if par.smelt_ticks == 4 { rng.below(200) } else { rng.below(300_000) };
                let n_ev = rng.below(6) as usize;
                let ev = random_events(&mut rng, n_ev, 0, span.max(1));
                let ev: Vec<Event> = ev.into_iter().filter(|e| e.tick <= span).collect();
                let (mut a, mut b) = (base.clone(), base.clone());
                replay(&mut a, span, &ev, par);
                catch_up(&mut b, span, &ev, par);
                assert_eq!(a, b, "case {case}");
            }
        }
    }

    #[test]
    fn bytes_round_trip() {
        let mut rng = Rng(3);
        let c = random_chunk(&mut rng, 64, 8, &GAME);
        let mut buf = vec![0u8; chunk_byte_len(64, 8)];
        c.to_bytes(&mut buf);
        assert_eq!(Chunk::from_bytes(&buf), c);
        let e = Event { tick: 123456789012, chunk: 7, kind: 2, arg: 99 };
        let mut eb = [0u8; EVENT_BYTES];
        e.to_bytes(&mut eb);
        assert_eq!(Event::from_bytes(&eb), e);
    }
}
