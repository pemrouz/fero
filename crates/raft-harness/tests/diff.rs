// Licensed under the Apache License, Version 2.0.

//! Replays the Go-filled fuzz scripts kept in the repo: the samples and the
//! regression scripts. The full fuzz is `diff/run_diff.sh`.

use raft_harness::datadriven::walk;
use raft_harness::diff::run_script;
use std::path::Path;

fn replay(dir: &str) -> (usize, usize) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("diff").join(dir);
    let (mut scripts, mut panics) = (0, 0);
    for path in walk(&dir).unwrap() {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let original = dir.join("in").join(&name);
        let r = run_script(&path, Some(&original), &name);
        if let Some(f) = &r.result.failure {
            panic!("{name} at {}: {}\nexpected:\n{}\nactual:\n{}", f.pos, f.error, f.expected, f.actual);
        }
        if let Some(p) = &r.panic {
            assert!(p.ok(), "{name}: go: {} | port at {:?}: {}", p.go_note, p.rust_at, p.rust_msg);
            // Go's note is `directive N (line): message`; the message must be the same.
            assert!(
                p.go_note.ends_with(&format!("): {}", p.rust_msg)),
                "{name}: go: {} | port: {}",
                p.go_note,
                p.rust_msg
            );
            panics += 1;
        }
        assert!(r.result.directives > 0, "{name} has no directives");
        scripts += 1;
    }
    (scripts, panics)
}

#[test]
fn samples_equal_the_go_outputs() {
    // One base script, one with reads, one with restarts, one where Go panics.
    assert_eq!(replay("samples"), (4, 1));
}

#[test]
fn regressions_equal_the_go_outputs() {
    replay("regressions");
}
