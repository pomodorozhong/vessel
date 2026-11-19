//! `cargo test --release` in prototype/chunks. PROP_CASES / PROP_SEED change the size of the run;
//! `cargo run --release --example longrun` is the multi-million-operation mode.
use vessel_chunks::harness::*;
use vessel_chunks::world::*;

fn cases() -> u64 {
    std::env::var("PROP_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(20_000)
}
fn seed() -> u64 {
    std::env::var("PROP_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1)
}

#[test]
fn fixed_protocol_has_no_mismatch() {
    let rep = run_many(seed(), cases(), 60, Config::FIXED, 3);
    if let Some(c) = &rep.smallest {
        panic!("mismatch in {} of {} cases; smallest:\n{}", rep.mismatches, rep.cases, describe(c));
    }
}

/// Mutation check: without the generation check the test must find stale results being accepted and shrink them.
#[test]
fn mutation_without_generation_check_is_caught() {
    // The monotonic check would reject most stale results on its own (see stage-6.md), so it is off too.
    let cfg = Config { check_generation: false, monotonic_accept: false, ..Config::FIXED };
    let rep = run_many(seed(), cases(), 60, cfg, 5);
    assert!(rep.mismatches > 0, "mutation not detected");
    let small = rep.smallest.unwrap();
    assert!(small.ops.len() <= 10, "shrinker left {} ops:\n{}", small.ops.len(), describe(&small));
}

/// Mutation: dropping every event up to to_tick on accept instead of the consumed ones.
#[test]
fn mutation_drop_by_tick_is_caught() {
    let cfg = Config { drop_by_tick: true, ..Config::FIXED };
    let rep = run_many(seed(), cases(), 60, cfg, 5);
    assert!(rep.mismatches > 0, "mutation not detected");
}

/// The protocol as first written has holes; the test must find them.
#[test]
fn literal_protocol_is_caught() {
    let rep = run_many(seed(), cases(), 60, Config::LITERAL, 5);
    assert!(rep.mismatches > 0);
}

// Hand-written minimal cases for each hole (found by the property test, then written down).
use vessel_chunks::model::*;

fn world(cfg: Config) -> (World, vessel_chunks::model::Chunk) {
    let c = Chunk { last_tick: 0, plots: vec![Plot { planted: true, stage: 0, prog: 0 }; 2], furnaces: vec![Furnace { fuel: 0, input: 0, output: 4, prog: 0 }] };
    (World::new(TEST, cfg, vec![c.clone()]), c)
}

/// Hole 2: a chunk is deactivated at tick T and an event stamped T is recorded afterwards.
#[test]
fn hole_event_after_deactivate_same_tick() {
    for (cfg, ok) in [(Config::LITERAL, false), (Config::FIXED, true)] {
        let (mut w, mut r) = world(cfg);
        w.advance(3);
        for _ in 0..3 { step_one(&mut r, &TEST); }
        w.activate(0);
        w.deactivate(0);
        w.record_event(0, KIND_RAID, 0);
        apply_event(&mut r, &Event { tick: 3, chunk: 0, kind: KIND_RAID, arg: 0 });
        w.advance(2);
        for _ in 0..2 { step_one(&mut r, &TEST); }
        w.activate(0);
        assert_eq!(w.slots[0].chunk == r, ok);
    }
}

/// Hole 1: an event stamped T arrives after a job was started at tick T.
#[test]
fn hole_event_after_job_start_same_tick() {
    for (cfg, ok) in [(Config::LITERAL, false), (Config::FIXED, true)] {
        let (mut w, mut r) = world(cfg);
        w.advance(3);
        for _ in 0..3 { step_one(&mut r, &TEST); }
        let res = w.start_job(0).unwrap().run(&TEST);
        w.record_event(0, KIND_RAID, 0);
        apply_event(&mut r, &Event { tick: 3, chunk: 0, kind: KIND_RAID, arg: 0 });
        assert!(w.finish_job(res));
        w.advance(2);
        for _ in 0..2 { step_one(&mut r, &TEST); }
        w.activate(0);
        assert_eq!(w.slots[0].chunk == r, ok);
    }
}

/// Hole 3: two jobs for the same chunk come back in the wrong order and the older one rolls the chunk back.
#[test]
fn hole_results_out_of_order() {
    for (cfg, ok) in [(Config::LITERAL, false), (Config::FIXED, true)] {
        let (mut w, mut r) = world(cfg);
        w.advance(2);
        for _ in 0..2 { step_one(&mut r, &TEST); }
        let older = w.start_job(0).unwrap().run(&TEST);
        w.advance(2);
        for _ in 0..2 { step_one(&mut r, &TEST); }
        w.record_event(0, KIND_RAID, 0);
        apply_event(&mut r, &Event { tick: 4, chunk: 0, kind: KIND_RAID, arg: 0 });
        let newer = w.start_job(0).unwrap().run(&TEST);
        w.finish_job(newer);
        w.finish_job(older);
        w.advance(1);
        step_one(&mut r, &TEST);
        w.activate(0);
        assert_eq!(w.slots[0].chunk == r, ok);
    }
}
