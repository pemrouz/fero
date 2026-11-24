// Licensed under the Apache License, Version 2.0.

//! The rules the raft crate keeps, checked by reading its source.
//!
//! - no hashed containers (their order can change between runs);
//! - no machine-sized integers and no floats: the only file that may name
//!   `usize` is `num.rs`, the bridge to slice positions;
//! - no `unsafe`, no `std`, no outside crates.
//!
//! Test files (`*_test.rs`) are not shipped and are not scanned.

use std::fs;
use std::path::{Path, PathBuf};

fn raft_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("raft")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// The code of a line: the part before a `//` comment. (No string in the
/// crate holds `//` next to a banned word, so this simple cut is enough.)
fn code(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
}

fn has_word(code: &str, word: &str) -> bool {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(i) = code[from..].find(word) {
        let start = from + i;
        let end = start + word.len();
        let before = code[..start].chars().next_back().is_some_and(is_ident);
        let after = code[end..].chars().next().is_some_and(is_ident);
        if !before && !after {
            return true;
        }
        from = end;
    }
    false
}

#[test]
fn raft_source_keeps_the_rules() {
    let mut files = Vec::new();
    rust_files(&raft_dir().join("src"), &mut files);
    files.sort();
    assert!(files.len() >= 20, "found only {} source files", files.len());

    let banned = ["HashMap", "HashSet", "isize", "f32", "f64", "unsafe", "std"];
    let mut bad = Vec::new();
    for f in &files {
        let name = f.strip_prefix(raft_dir()).unwrap().display().to_string();
        let is_num = f.file_name().is_some_and(|n| n == "num.rs");
        // A `_test.rs` file is test code: it is not in the shipped crate, and
        // it may use `std` (to catch a panic).
        if name.ends_with("_test.rs") {
            continue;
        }
        for (i, line) in fs::read_to_string(f).unwrap().lines().enumerate() {
            let c = code(line);
            // `#![no_std]` and `#![forbid(unsafe_code)]` say the rule; they do not break it.
            if c.contains("#![no_std]") || c.contains("#![forbid(unsafe_code)]") {
                continue;
            }
            for w in banned {
                if has_word(c, w) {
                    bad.push(format!("{name}:{}: `{w}`", i + 1));
                }
            }
            if !is_num && has_word(c, "usize") {
                bad.push(format!("{name}:{}: `usize` outside num.rs", i + 1));
            }
        }
    }
    assert!(bad.is_empty(), "the raft crate breaks its rules:\n{}", bad.join("\n"));

    let lib = fs::read_to_string(raft_dir().join("src").join("lib.rs")).unwrap();
    assert!(lib.contains("#![no_std]") && lib.contains("#![forbid(unsafe_code)]"));
}

#[test]
fn raft_has_no_outside_crates() {
    let manifest = fs::read_to_string(raft_dir().join("Cargo.toml")).unwrap();
    let mut in_deps = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_deps = line.contains("dependencies");
            continue;
        }
        assert!(!(in_deps && !line.is_empty() && !line.starts_with('#')), "raft has a dependency: {line}");
    }
}
