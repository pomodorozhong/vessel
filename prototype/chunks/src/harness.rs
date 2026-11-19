//! Property test: random operation sequences against the protocol in `world.rs`, checked against a
//! reference world that steps every tick of every chunk. Includes a delta-debugging shrinker.

use crate::model::*;
use crate::world::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Advance(u32),
    StartJob(u8),
    /// Deliver the (i mod pending)-th in-flight job result, so results arrive in any order.
    Deliver(u8),
    Event { chunk: u8, kind: u8, arg: u32 },
    Activate(u8),
    Deactivate(u8),
    /// The player jumps: the active set becomes exactly these chunks, activated all at once.
    Jump(Vec<u8>),
}

#[derive(Clone, Debug)]
pub struct Case {
    pub state_seed: u64,
    pub n_chunks: u8,
    pub ops: Vec<Op>,
}

pub const PLOTS: usize = 4;
pub const FURNACES: usize = 2;

pub fn gen_case(seed: u64, max_ops: usize, max_chunks: u8) -> Case {
    let mut r = Rng(seed);
    let n_chunks = 1 + r.below(max_chunks as u64) as u8;
    let n_ops = 1 + r.below(max_ops as u64) as usize;
    let mut ops = Vec::with_capacity(n_ops);
    for _ in 0..n_ops {
        let c = r.below(n_chunks as u64) as u8;
        let w = r.below(100);
        ops.push(match w {
            0..=29 => {
                let d = match r.below(100) {
                    0..=69 => 1 + r.below(30),
                    70..=94 => 30 + r.below(2000),
                    _ => 2000 + r.below(20000),
                };
                Op::Advance(d as u32)
            }
            30..=47 => Op::StartJob(c),
            48..=67 => Op::Deliver(r.below(8) as u8),
            68..=79 => Op::Event { chunk: c, kind: r.below(KIND_COUNT as u64) as u8, arg: r.next() as u32 },
            80..=87 => Op::Activate(c),
            88..=95 => Op::Deactivate(c),
            _ => {
                let k = 1 + r.below(n_chunks as u64);
                Op::Jump((0..k).map(|_| r.below(n_chunks as u64) as u8).collect())
            }
        });
    }
    Case { state_seed: r.next(), n_chunks, ops }
}

#[derive(Debug, Clone)]
pub struct Mismatch {
    pub op_index: usize,
    pub chunk: usize,
    pub got: Chunk,
    pub want: Chunk,
}

fn initial(case: &Case) -> Vec<Chunk> {
    let mut r = Rng(case.state_seed);
    (0..case.n_chunks).map(|_| random_chunk(&mut r, PLOTS, FURNACES, &TEST)).collect()
}

/// Runs the case. Ok(op count) when every activation matched the reference.
pub fn run_case(case: &Case, cfg: Config) -> Result<usize, Mismatch> {
    let par = TEST;
    let init = initial(case);
    let mut reference = init.clone();
    let mut world = World::new(par, cfg, init);
    let mut pending: Vec<JobResult> = Vec::new();
    let n = case.n_chunks as usize;

    let check = |world: &World, reference: &Vec<Chunk>, c: usize, i: usize| -> Result<(), Mismatch> {
        if world.slots[c].chunk != reference[c] {
            return Err(Mismatch { op_index: i, chunk: c, got: world.slots[c].chunk.clone(), want: reference[c].clone() });
        }
        Ok(())
    };

    for (i, op) in case.ops.iter().enumerate() {
        match op {
            Op::Advance(d) => {
                world.advance(*d as u64);
                for _ in 0..*d {
                    for c in reference.iter_mut() {
                        step_one(c, &par);
                    }
                }
            }
            Op::StartJob(c) => {
                if let Some(j) = world.start_job(*c as usize % n) {
                    pending.push(j.run(&par));
                }
            }
            Op::Deliver(k) => {
                if !pending.is_empty() {
                    let r = pending.remove(*k as usize % pending.len());
                    world.finish_job(r);
                }
            }
            Op::Event { chunk, kind, arg } => {
                let c = *chunk as usize % n;
                let kind = *kind as u16 % KIND_COUNT;
                world.record_event(c, kind, *arg);
                let ev = Event { tick: world.now, chunk: c as u16, kind, arg: *arg };
                apply_event(&mut reference[c], &ev);
            }
            Op::Activate(c) => {
                let c = *c as usize % n;
                if !world.slots[c].active {
                    world.activate(c);
                    check(&world, &reference, c, i)?;
                }
            }
            Op::Deactivate(c) => world.deactivate(*c as usize % n),
            Op::Jump(set) => {
                let want: Vec<usize> = set.iter().map(|c| *c as usize % n).collect();
                for c in 0..n {
                    if !want.contains(&c) {
                        world.deactivate(c);
                    }
                }
                for &c in &want {
                    if !world.slots[c].active {
                        world.activate(c);
                        check(&world, &reference, c, i)?;
                    }
                }
            }
        }
    }
    // Finally wake every chunk and compare.
    for c in 0..n {
        if !world.slots[c].active {
            world.activate(c);
            check(&world, &reference, c, case.ops.len())?;
        }
    }
    Ok(case.ops.len())
}

// ---- shrinking (delta debugging) ----

fn fails(case: &Case, cfg: Config) -> bool {
    run_case(case, cfg).is_err()
}

fn with_ops(case: &Case, ops: Vec<Op>) -> Case {
    Case { ops, ..case.clone() }
}

pub fn shrink(case: &Case, cfg: Config) -> Case {
    let mut cur = case.clone();
    debug_assert!(fails(&cur, cfg));
    loop {
        let before = (cur.ops.clone(), cur.n_chunks, cur.state_seed);
        // ddmin on the operation list: drop chunks of decreasing size.
        let mut gran = 2usize;
        while cur.ops.len() >= 2 {
            let len = cur.ops.len();
            let size = (len + gran - 1) / gran;
            let mut removed = false;
            let mut start = 0;
            while start < cur.ops.len() {
                let end = (start + size).min(cur.ops.len());
                let mut ops = cur.ops.clone();
                ops.drain(start..end);
                let cand = with_ops(&cur, ops);
                if fails(&cand, cfg) {
                    cur = cand;
                    removed = true;
                } else {
                    start = end;
                }
            }
            if !removed {
                if size == 1 {
                    break;
                }
                gran = (gran * 2).min(cur.ops.len());
            } else {
                gran = gran.max(2);
            }
        }
        // Shrink the numbers inside the operations.
        for i in 0..cur.ops.len() {
            let cands: Vec<Op> = match &cur.ops[i] {
                Op::Advance(d) => [1, d / 2, d.saturating_sub(1)].iter().filter(|x| **x >= 1 && **x < *d).map(|x| Op::Advance(*x)).collect(),
                Op::StartJob(c) if *c > 0 => vec![Op::StartJob(0)],
                Op::Deliver(k) if *k > 0 => vec![Op::Deliver(0)],
                Op::Event { chunk, kind, arg } => {
                    let mut v = vec![];
                    if *chunk > 0 { v.push(Op::Event { chunk: 0, kind: *kind, arg: *arg }); }
                    if *arg > 0 { v.push(Op::Event { chunk: *chunk, kind: *kind, arg: 0 }); }
                    v
                }
                Op::Activate(c) if *c > 0 => vec![Op::Activate(0)],
                Op::Deactivate(c) if *c > 0 => vec![Op::Deactivate(0)],
                Op::Jump(s) => {
                    let mut v = vec![];
                    for j in 0..s.len() {
                        if s.len() > 1 {
                            let mut t = s.clone();
                            t.remove(j);
                            v.push(Op::Jump(t));
                        }
                    }
                    v
                }
                _ => vec![],
            };
            for cand in cands {
                let mut ops = cur.ops.clone();
                ops[i] = cand;
                let c2 = with_ops(&cur, ops);
                if fails(&c2, cfg) {
                    cur = c2;
                    break;
                }
            }
        }
        // Fewer chunks (indices wrap with modulo, so any n works).
        while cur.n_chunks > 1 {
            let c2 = Case { n_chunks: cur.n_chunks - 1, ..cur.clone() };
            if fails(&c2, cfg) { cur = c2 } else { break }
        }
        // The smallest initial-state seed that still fails reads best.
        for s in 0..300u64 {
            let c2 = Case { state_seed: s, ..cur.clone() };
            if fails(&c2, cfg) {
                cur = c2;
                break;
            }
        }
        if (cur.ops.clone(), cur.n_chunks, cur.state_seed) == before {
            return cur;
        }
    }
}

pub fn describe(case: &Case) -> String {
    let init = initial(case);
    let mut s = format!("state_seed={} chunks={}\n", case.state_seed, case.n_chunks);
    for (i, c) in init.iter().enumerate() {
        s += &format!("  chunk {i} initial: {:?}\n", c);
    }
    for (i, o) in case.ops.iter().enumerate() {
        s += &format!("  op {i}: {:?}\n", o);
    }
    s
}

// ---- running many cases ----

#[derive(Default, Debug)]
pub struct Report {
    pub cases: u64,
    pub ops: u64,
    pub mismatches: u64,
    pub smallest: Option<Case>,
}

/// Cases with seeds `seed0 .. seed0+cases`. Shrinks up to `shrink_limit` failures and keeps the smallest.
pub fn run_many(seed0: u64, cases: u64, max_ops: usize, cfg: Config, shrink_limit: usize) -> Report {
    let mut rep = Report::default();
    let mut shrunk = 0;
    for k in 0..cases {
        let case = gen_case(seed0 + k, max_ops, 6);
        rep.cases += 1;
        match run_case(&case, cfg) {
            Ok(n) => rep.ops += n as u64,
            Err(_) => {
                rep.ops += case.ops.len() as u64;
                rep.mismatches += 1;
                if shrunk < shrink_limit {
                    shrunk += 1;
                    let s = shrink(&case, cfg);
                    let better = match &rep.smallest {
                        None => true,
                        Some(b) => s.ops.len() < b.ops.len(),
                    };
                    if better {
                        rep.smallest = Some(s);
                    }
                }
            }
        }
    }
    rep
}
