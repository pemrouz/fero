// Licensed under the Apache License, Version 2.0.

//! Runs etcd raft's 41 datadriven files against the Rust port.
//!
//! Usage: raft-datadriven [--testdata DIR] [--verbose] [--diff]
//!
//! When every file passes byte for byte, the last line is exactly
//! `ok raft: 41 of 41 etcd files` and the exit code is 0. Otherwise each
//! failing file is listed on a `FAIL` line and the exit code is 1.

use raft_harness::suites::{default_testdata, run_all, ETCD_FILES, SUITES};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut root = default_testdata();
    let mut verbose = false;
    let mut diff = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--testdata" => match args.next() {
                Some(d) => root = PathBuf::from(d),
                None => {
                    eprintln!("--testdata needs a directory");
                    return ExitCode::from(2);
                }
            },
            "--verbose" | "-v" => verbose = true,
            "--diff" => diff = true,
            _ => {
                eprintln!("usage: raft-datadriven [--testdata DIR] [--verbose] [--diff]");
                return ExitCode::from(2);
            }
        }
    }

    // A panic inside a handler is caught and reported per file; keep the
    // default hook from printing it a second time.
    std::panic::set_hook(Box::new(|_| {}));

    let all = match run_all(&root) {
        Ok(all) => all,
        Err(e) => {
            println!("FAIL raft: cannot read the test files: {e}");
            return ExitCode::from(1);
        }
    };

    if verbose {
        for r in &all {
            let mark = if r.result.ok() { "PASS" } else { "FAIL" };
            println!("{mark} {}  directives {}/{}", r.result.file, r.result.passed, r.result.directives);
        }
    }
    for r in &all {
        let Some(f) = &r.result.failure else { continue };
        let why = if f.error.is_empty() { "output differs from the expected text" } else { f.error.as_str() };
        println!("FAIL {} at {}: {}", r.result.file, f.pos, why.lines().next().unwrap_or(""));
        if diff && f.error.is_empty() {
            let e: Vec<&str> = f.expected.split('\n').collect();
            let a: Vec<&str> = f.actual.split('\n').collect();
            for i in 0..e.len().max(a.len()) {
                if e.get(i) != a.get(i) {
                    println!("  first differing line {}:", i + 1);
                    println!("    expected: {:?}", e.get(i).copied().unwrap_or("<none>"));
                    println!("    actual:   {:?}", a.get(i).copied().unwrap_or("<none>"));
                    break;
                }
            }
        }
    }
    for (suite, _) in SUITES {
        let n = all.iter().filter(|r| r.suite == suite).count();
        let ok = all.iter().filter(|r| r.suite == suite && r.result.ok()).count();
        let dirs: usize = all.iter().filter(|r| r.suite == suite).map(|r| r.result.directives).sum();
        let passed: usize = all.iter().filter(|r| r.suite == suite).map(|r| r.result.passed).sum();
        println!("suite {suite}: {ok} of {n} files, {passed} of {dirs} directives");
    }

    let pass = all.iter().filter(|r| r.result.ok()).count();
    if all.len() != ETCD_FILES {
        println!("FAIL raft: found {} files, etcd has {ETCD_FILES}", all.len());
        return ExitCode::from(1);
    }
    if pass == ETCD_FILES {
        println!("ok raft: {pass} of {ETCD_FILES} etcd files");
        ExitCode::SUCCESS
    } else {
        println!("FAIL raft: {pass} of {ETCD_FILES} etcd files");
        ExitCode::from(1)
    }
}
