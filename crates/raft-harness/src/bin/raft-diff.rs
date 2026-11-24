// Licensed under the Apache License, Version 2.0.

//! Replays Go-filled fuzz scripts on the Rust port.
//!
//! Usage: raft-diff <dir with Go's outputs> [<dir with the scripts as generated>]
//!
//! The second directory is needed for scripts where Go panicked. The last
//! line starts with `ok raft-diff:` when every script is equal byte for byte
//! and every Go panic is met by a panic at the same step; the exit code is
//! then 0. Otherwise each failing script is listed and the exit code is 1.

use raft_harness::datadriven::walk;
use raft_harness::diff::run_script;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.len() > 2 {
        eprintln!("usage: raft-diff <dir with Go's outputs> [<dir with the scripts as generated>]");
        return ExitCode::from(2);
    }
    let out_dir = PathBuf::from(&args[0]);
    let in_dir = args.get(1).map(PathBuf::from);
    let files = match walk(&out_dir) {
        Ok(f) => f,
        Err(e) => {
            println!("FAIL raft-diff: cannot read {}: {e}", args[0]);
            return ExitCode::from(1);
        }
    };

    // A panic is caught and reported per script; keep the default hook quiet.
    std::panic::set_hook(Box::new(|_| {}));

    let (mut pass, mut fail, mut dirs, mut panics, mut panics_matched) = (0u64, 0u64, 0usize, 0u64, 0u64);
    for path in &files {
        let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        let original = in_dir.as_ref().map(|d| d.join(&name));
        let r = run_script(path, original.as_deref(), &name);
        dirs += r.result.passed;
        if let Some(f) = &r.result.failure {
            fail += 1;
            println!("FAIL {name} at {} ({})", f.pos, f.cmd);
            if f.error.is_empty() {
                let e: Vec<&str> = f.expected.split('\n').collect();
                let a: Vec<&str> = f.actual.split('\n').collect();
                for i in 0..e.len().max(a.len()) {
                    if e.get(i) != a.get(i) {
                        println!("  line {}", i + 1);
                        println!("    go:   {:?}", e.get(i).copied().unwrap_or("<none>"));
                        println!("    rust: {:?}", a.get(i).copied().unwrap_or("<none>"));
                        break;
                    }
                }
            } else {
                println!("  error: {}", f.error.lines().take(4).collect::<Vec<_>>().join(" | "));
            }
        } else {
            pass += 1;
        }
        if let Some(p) = &r.panic {
            panics += 1;
            if p.ok() {
                panics_matched += 1;
                println!("PANIC SAME {name}: go: {} | rust: {}", p.go_note, p.rust_msg);
            } else {
                println!(
                    "PANIC MISMATCH {name}: go panicked at directive {}, rust at {:?} (go: {} | rust: {})",
                    p.go_at, p.rust_at, p.go_note, p.rust_msg
                );
            }
        }
    }
    let ok = fail == 0 && panics == panics_matched && !files.is_empty();
    println!(
        "{} raft-diff: {pass} of {} scripts equal the Go outputs byte for byte; {dirs} directives compared; \
         Go panicked in {panics} scripts, the port panicked at the same directive in {panics_matched}",
        if ok { "ok" } else { "FAIL" },
        pass + fail
    );
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
