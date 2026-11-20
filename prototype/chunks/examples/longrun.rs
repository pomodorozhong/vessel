//! Long property-test run. Usage:
//!   cargo run --release --example longrun -- <cases> [config=fixed|literal|nogen|f1only|f2only] [threads] [seed0]
//! Prints one JSON object (cases, ops, mismatches, smallest failing case, wall time).
use std::time::Instant;
use vessel_chunks::harness::*;
use vessel_chunks::world::Config;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let cases: u64 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(100_000);
    let name = a.get(2).map(|s| s.as_str()).unwrap_or("fixed").to_string();
    let threads: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);
    let seed0: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(1);
    let cfg = match name.as_str() {
        "fixed" => Config::FIXED,
        "literal" => Config::LITERAL,
        "nogen" => Config { check_generation: false, ..Config::FIXED },
        "nogen_nomono" => Config { check_generation: false, monotonic_accept: false, ..Config::FIXED },
        "dropbytick" => Config { drop_by_tick: true, ..Config::FIXED },
        "f1only" => Config { monotonic_accept: false, ..Config::FIXED },
        "f2only" => Config { inclusive_bound: false, ..Config::FIXED },
        _ => panic!("unknown config"),
    };
    let t0 = Instant::now();
    let per = cases / threads;
    let reports: Vec<Report> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..threads).map(|t| s.spawn(move || run_many(seed0 + t * per, per, 60, cfg, 10))).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let wall = t0.elapsed().as_secs_f64();
    let (mut c, mut o, mut m) = (0, 0, 0);
    let mut smallest: Option<Case> = None;
    for r in reports {
        c += r.cases;
        o += r.ops;
        m += r.mismatches;
        if let Some(s) = r.smallest {
            if smallest.as_ref().map_or(true, |b| s.ops.len() < b.ops.len()) {
                smallest = Some(s);
            }
        }
    }
    let esc = |s: String| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    println!(
        "{{\"config\":\"{}\",\"threads\":{},\"seed0\":{},\"cases\":{},\"ops\":{},\"mismatches\":{},\"wall_s\":{:.2},\"smallest\":{}}}",
        name, threads, seed0, c, o, m, wall,
        match smallest { Some(s) => format!("\"{}\"", esc(describe(&s))), None => "null".into() }
    );
}
