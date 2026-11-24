// Licensed under the Apache License, Version 2.0.

//! Port of `confchange/datadriven_test.go`.

use crate::datadriven::{trim_space, Fatal, TestData};
use raft::confchange::Changer;
use raft::gostd::{parse_uint, Error};
use raft::raftpb as pb;
use raft::tracker::ProgressTracker;

/// The state of one file's run: Go's `tr` and `c`, made once per file.
pub struct ConfChangeDataDriven {
    c: Changer,
}

impl Default for ConfChangeDataDriven {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfChangeDataDriven {
    pub fn new() -> ConfChangeDataDriven {
        let tr = ProgressTracker::make(10, 0);
        ConfChangeDataDriven {
            c: Changer {
                tracker: tr,
                last_index: 0, // incremented in this test with each cmd
            },
        }
    }

    // The test files use the commands
    // - simple: run a simple conf change (i.e. no joint consensus),
    // - enter-joint: enter a joint config, and
    // - leave-joint: leave a joint config.
    // The first two take a list of config changes, which have the following
    // syntax:
    // - vn: make n a voter,
    // - ln: make n a learner,
    // - rn: remove n, and
    // - un: update n.
    pub fn handle(&mut self, d: &TestData) -> Result<String, Fatal> {
        // Go's `defer func() { c.LastIndex++ }()`.
        let res = self.handle_inner(d);
        self.c.last_index += 1;
        res
    }

    fn handle_inner(&mut self, d: &TestData) -> Result<String, Fatal> {
        let c = &mut self.c;
        let mut ccs: Vec<pb::ConfChangeSingle> = Vec::new();
        let mut toks: Vec<&str> = trim_space(&d.input).split(' ').collect();
        if toks[0].is_empty() {
            toks = Vec::new();
        }
        for tok in toks {
            if tok.len() < 2 {
                return Ok(format!("unknown token {tok}"));
            }
            let mut cc = pb::ConfChangeSingle::default();
            match tok.as_bytes()[0] {
                b'v' => cc.r#type = Some(pb::ConfChangeAddNode),
                b'l' => cc.r#type = Some(pb::ConfChangeAddLearnerNode),
                b'r' => cc.r#type = Some(pb::ConfChangeRemoveNode),
                b'u' => cc.r#type = Some(pb::ConfChangeUpdateNode),
                _ => return Ok(format!("unknown input: {tok}")),
            }
            let id = match parse_uint(&tok[1..]) {
                Ok(id) => id,
                Err(err) => return Ok(err.to_string()),
            };
            cc.node_id = Some(id);
            ccs.push(cc);
        }

        let res = match d.cmd.as_str() {
            "simple" => c.simple(&ccs),
            "enter-joint" => {
                let mut auto_leave = false;
                if !d.cmd_args.is_empty() {
                    auto_leave = d.scan_args_bool("autoleave")?;
                }
                c.enter_joint(auto_leave, &ccs)
            }
            "leave-joint" => {
                if !ccs.is_empty() {
                    Err(Error::new("this command takes no input"))
                } else {
                    c.leave_joint()
                }
            }
            _ => return Ok("unknown command".to_string()),
        };
        let (cfg, trk) = match res {
            Ok(v) => v,
            Err(err) => return Ok(format!("{err}\n")),
        };
        c.tracker.config = cfg;
        c.tracker.progress = trk;
        Ok(format!("{}\n{}", c.tracker.config, c.tracker.progress))
    }
}
