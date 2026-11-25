//! The native runner of the simulator.
//!
//! ```text
//! sim-run seeds <start> <count>          one line per seed: seed, events, trace hash
//! sim-run fresh <start> <count>          the same for the fresh-world scenario
//! sim-run time  <start> <count> <reps>   runs the seeds <reps> times; one line per repeat
//! ```
//!
//! It needs no Node and folds nothing. The lines of `seeds` are what probe
//! P2's byte check compares with the WASM build's.

use sim::exec::{Chaos, Exec, Outcome};
use sim::p2::{fresh, NoSink, P2World};
use std::process::ExitCode;
use std::time::Instant;

fn usage() -> ExitCode {
    eprintln!("usage: sim-run seeds|fresh <start> <count>\n       sim-run time <start> <count> <reps>");
    ExitCode::from(2)
}

fn line(seed: u64, o: Outcome) {
    println!("{seed} {} {:016x}", o.events, o.hash);
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let num = |i: usize| args.get(i).and_then(|s| s.parse::<u64>().ok());
    let (Some(mode), Some(start), Some(count)) = (args.first(), num(1), num(2)) else {
        return usage();
    };
    let mut exec = Exec::new(P2World::new(NoSink));
    match mode.as_str() {
        "seeds" => {
            for seed in start..start + count {
                line(seed, exec.run_seed(seed, Chaos::P2));
            }
        }
        "fresh" => {
            for seed in start..start + count {
                line(seed, fresh(&mut exec, seed));
            }
        }
        "time" => {
            let Some(reps) = num(3) else { return usage() };
            // One pass first, not timed, to warm the caches and the allocator.
            for seed in start..start + count {
                let _ = exec.run_seed(seed, Chaos::P2);
            }
            for rep in 0..reps {
                let mut events = 0;
                let t0 = Instant::now();
                for seed in start..start + count {
                    events += exec.run_seed(seed, Chaos::P2).events;
                }
                let ns = t0.elapsed().as_nanos();
                println!("{{\"measure\":\"native\",\"rep\":{rep},\"seeds\":{count},\"ns\":{ns},\"events\":{events}}}");
            }
        }
        _ => return usage(),
    }
    ExitCode::SUCCESS
}
