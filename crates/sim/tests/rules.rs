//! The rules the sim crate keeps, checked by reading its source.
//!
//! - no hashed containers (their order can change between runs);
//! - no machine-sized integers and no floats: the only file that may name
//!   `usize` is `num.rs`, the bridge to slice positions;
//! - no `unsafe`, no `std`.
//!
//! The WASM build is 32-bit and the native build is 64-bit. A machine-sized
//! number in state or in the trace would make the two disagree. Probe P2's
//! byte check is the backstop; this scan is the first line.
//!
//! A file's unit tests (everything from `#[cfg(test)]` down) are not shipped
//! and are not scanned.

use std::fs;
use std::path::Path;

/// The code of a line: the part before a `//` comment.
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
fn sim_source_keeps_the_rules() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<_> = fs::read_dir(&src).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    assert!(files.len() >= 8, "found only {} source files", files.len());
    let mut broken = Vec::new();
    for file in &files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(file).unwrap();
        for (n, line) in text.lines().enumerate() {
            if line.trim() == "#[cfg(test)]" {
                break;
            }
            let code = code(line);
            let mut banned = vec!["HashMap", "HashSet", "isize", "f32", "f64", "unsafe", "std"];
            if name != "num.rs" {
                banned.push("usize");
            }
            for word in banned {
                if has_word(code, word) {
                    broken.push(format!("{name}:{}: `{word}`", n + 1));
                }
            }
        }
    }
    assert!(broken.is_empty(), "the sim crate breaks its rules:\n{}", broken.join("\n"));
    let manifest = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let deps: Vec<&str> = manifest
        .lines()
        .skip_while(|l| l.trim() != "[dependencies]")
        .skip(1)
        .take_while(|l| !l.starts_with('['))
        .filter(|l| !l.trim().is_empty())
        .collect();
    assert_eq!(deps, ["raft = { path = \"../raft\" }"], "the sim crate depends on the raft crate only");
}
