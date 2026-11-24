// Licensed under the Apache License, Version 2.0.

//! Runs etcd's datadriven files: the interaction files, the quorum files and
//! the confchange files.

use crate::confchange_dd::ConfChangeDataDriven;
use crate::datadriven::{run_test, walk, FileResult};
use crate::quorum_dd;
use crate::rafttest::{InteractionEnv, InteractionOpts};
use std::path::{Path, PathBuf};

/// How many files etcd raft has at the vendored commit.
pub const ETCD_FILES: usize = 41;

/// The three suites, with the directory of each under the testdata root.
pub const SUITES: [(&str, &str); 3] = [("interaction", ""), ("quorum", "quorum"), ("confchange", "confchange")];

/// The vendored files, next to the raft crate.
pub fn default_testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("raft").join("testdata")
}

/// One file's result, with its suite.
#[derive(Clone, Debug)]
pub struct SuiteResult {
    pub suite: &'static str,
    pub result: FileResult,
}

/// Runs every file under `root`. The name of a file in the results is
/// `<suite>/<file>`.
pub fn run_all(root: &Path) -> std::io::Result<Vec<SuiteResult>> {
    let mut all = Vec::new();
    for (suite, dir) in SUITES {
        for path in walk(&root.join(dir))? {
            let file = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            let name = format!("{suite}/{file}");
            let result = match suite {
                "interaction" => {
                    // As Go's TestInteraction: the test hook for the election timeout
                    // is handed to the environment.
                    let mut env = InteractionEnv::new(Some(InteractionOpts {
                        on_config: None,
                        set_randomized_election_timeout: Some(Box::new(|node, timeout| {
                            node.set_randomized_election_timeout(timeout);
                        })),
                    }));
                    run_test(&path, &name, |d| env.handle(d))
                }
                "quorum" => run_test(&path, &name, quorum_dd::handle),
                _ => {
                    let mut t = ConfChangeDataDriven::new();
                    run_test(&path, &name, |d| t.handle(d))
                }
            };
            all.push(SuiteResult { suite, result });
        }
    }
    Ok(all)
}
