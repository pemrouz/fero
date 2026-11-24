// Licensed under the Apache License, Version 2.0.

//! The reader's own cases, and the etcd files that must pass.

use raft_harness::datadriven::{parse_line, read_test_data, run_test, CmdArg};
use raft_harness::suites::{default_testdata, run_all, ETCD_FILES};

fn arg(key: &str, vals: &[&str]) -> CmdArg {
    CmdArg { key: key.to_string(), vals: vals.iter().map(|v| v.to_string()).collect() }
}

#[test]
fn parse_line_forms() {
    assert_eq!(parse_line("   ").unwrap(), (String::new(), vec![]));
    assert_eq!(parse_line("cmd").unwrap(), ("cmd".to_string(), vec![]));
    assert_eq!(
        parse_line("committed cfg=(1, 2,3) cfgj=zero idx=(_,5) flag empty= x=((a,b), c)").unwrap(),
        (
            "committed".to_string(),
            vec![
                arg("cfg", &["1", "2", "3"]),
                arg("cfgj", &["zero"]),
                arg("idx", &["_", "5"]),
                arg("flag", &[]),
                arg("empty", &[""]),
                arg("x", &["(a,b)", "c"]),
            ]
        )
    );
    assert_eq!(parse_line("cmd a=(1,2").unwrap_err(), "cannot parse directive at column 7: cmd a=(1,2");
    assert_eq!(arg("k", &["1", "2"]).to_string(), "k=(1, 2)");
}

#[test]
fn reader_shapes() {
    let text = "# a comment\n\ncmd one \\\n  two=2\ninput line\n----\nout 1\nout 2\n\nblank\n----\n----\na\n\nb\n----\n----\n\nlast\n----\n";
    let ds = read_test_data(text, "f").unwrap();
    assert_eq!(ds.len(), 3);
    assert_eq!((ds[0].pos.as_str(), ds[0].cmd.as_str()), ("f:3", "cmd"));
    assert_eq!(ds[0].cmd_args, vec![arg("one", &[]), arg("two", &["2"])]);
    assert_eq!(ds[0].input, "input line");
    assert_eq!(ds[0].expected, "out 1\nout 2\n");
    assert_eq!((ds[1].pos.as_str(), ds[1].expected.as_str()), ("f:10", "a\n\nb\n"));
    assert_eq!((ds[2].pos.as_str(), ds[2].expected.as_str()), ("f:19", ""));
}

#[test]
fn first_mismatch_ends_the_file() {
    let dir = std::env::temp_dir().join(format!("raft-harness-dd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.txt");
    std::fs::write(&path, "a\n----\nA\n\nb\n----\nwrong\n\nc\n----\nC\n").unwrap();
    let mut seen = Vec::new();
    let r = run_test(&path, "t.txt", |d| {
        seen.push(d.cmd.clone());
        Ok(d.cmd.to_uppercase())
    });
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(seen, ["a", "b"]);
    assert_eq!((r.directives, r.passed, r.ok()), (3, 1, false));
    let f = r.failure.unwrap();
    assert_eq!((f.pos.as_str(), f.expected.as_str(), f.actual.as_str()), ("t.txt:5", "wrong\n", "B\n"));
}

/// etcd's files, byte for byte. A suite listed in `MUST_PASS` may not lose a
/// file.
#[test]
fn etcd_files() {
    const MUST_PASS: [&str; 3] = ["interaction", "quorum", "confchange"];
    let all = run_all(&default_testdata()).unwrap();
    assert_eq!(all.len(), ETCD_FILES);
    let failing: Vec<&str> =
        all.iter().filter(|r| MUST_PASS.contains(&r.suite) && !r.result.ok()).map(|r| r.result.file.as_str()).collect();
    assert!(failing.is_empty(), "failing: {failing:?}");
    let count = |s: &str| all.iter().filter(|r| r.suite == s).count();
    assert_eq!((count("interaction"), count("quorum"), count("confchange")), (28, 4, 9));
}
