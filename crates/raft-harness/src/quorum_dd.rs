// Licensed under the Apache License, Version 2.0.

//! Port of `quorum/datadriven_test.go` (and of
//! `alternativeMajorityCommittedIndex` from `quorum/quick_test.go`).

use crate::datadriven::{Fatal, TestData};
use crate::gofmt::{MapSet, Slice};
use raft::quorum::{AckedIndexer, Index, JointConfig, MajorityConfig, MapAckIndexer};
use std::collections::BTreeMap;
use std::fmt::Write;

/// TestDataDriven parses and executes the test cases in ./testdata/*. An entry
/// in such a file specifies the command, which is either of "committed" to check
/// CommittedIndex or "vote" to verify a VoteResult. The underlying configuration
/// and inputs are specified via the arguments 'cfg' and 'cfgj' (for the majority
/// config and, optionally, majority config joint to the first one) and 'idx'
/// (for CommittedIndex) and 'votes' (for VoteResult).
///
/// Internally, the harness runs some additional checks on each test case for
/// which it is known that the result shouldn't change. For example,
/// interchanging the majority configurations of a joint quorum must not
/// influence the result; if it does, this is noted in the test's output.
pub fn handle(d: &TestData) -> Result<String, Fatal> {
    // Two majority configs. The first one is always used (though it may
    // be empty) and the second one is used iff joint is true.
    let mut joint = false;
    let mut ids: Vec<u64> = Vec::new();
    let mut idsj: Vec<u64> = Vec::new();
    // The committed indexes for the nodes in the config in the order in
    // which they appear in (ids,idsj), without repetition. An underscore
    // denotes an omission (i.e. no information for this voter); this is
    // different from 0. For example,
    //
    // cfg=(1,2) cfgj=(2,3,4) idxs=(_,5,_,7) initializes the idx for voter 2
    // to 5 and that for voter 4 to 7 (and no others).
    //
    // cfgj=zero is specified to instruct the test harness to treat cfgj
    // as zero instead of not specified (i.e. it will trigger a joint
    // quorum test instead of a majority quorum test for cfg only).
    let mut idxs: Vec<Index> = Vec::new();
    // Votes. These are initialized similar to idxs except the only values
    // used are 1 (voted against) and 2 (voted for). This looks awkward,
    // but is convenient because it allows sharing code between the two.
    let mut votes: Vec<Index> = Vec::new();

    // Parse the args.
    for arg in &d.cmd_args {
        for i in 0..arg.vals.len() {
            match arg.key.as_str() {
                "cfg" => {
                    let n = arg.scan_u64(i)?;
                    ids.push(n);
                }
                "cfgj" => {
                    joint = true;
                    if arg.vals[i] == "zero" {
                        if arg.vals.len() != 1 {
                            return Err("cannot mix 'zero' into configuration".to_string());
                        }
                    } else {
                        let n = arg.scan_u64(i)?;
                        idsj.push(n);
                    }
                }
                "idx" => {
                    let mut n: u64 = 0;
                    // Register placeholders as zeroes.
                    if arg.vals[i] != "_" {
                        n = arg.scan_u64(i)?;
                        // This is a restriction caused by the above
                        // special-casing for _.
                        if n == 0 {
                            return Err("cannot use 0 as idx".to_string());
                        }
                    }
                    idxs.push(Index(n));
                }
                "votes" => {
                    let s = arg.scan_string(i)?;
                    match s.as_str() {
                        "y" => votes.push(Index(2)),
                        "n" => votes.push(Index(1)),
                        "_" => votes.push(Index(0)),
                        _ => return Err(format!("unknown vote: {s}")),
                    }
                }
                _ => return Err(format!("unknown arg {}", arg.key)),
            }
        }
    }

    // Build the two majority configs.
    let c: MajorityConfig = ids.iter().copied().collect();
    let cj: MajorityConfig = idsj.iter().copied().collect();

    // Helper that returns an AckedIndexer which has the specified indexes
    // mapped to the right IDs.
    let make_lookuper = |idxs: &[Index], ids: &[u64], idsj: &[u64]| -> MapAckIndexer {
        let mut l = MapAckIndexer::new();
        let mut p = 0; // next to consume from idxs
        for id in ids.iter().chain(idsj.iter()) {
            if l.contains_key(id) {
                continue;
            }
            if p < idxs.len() {
                // NB: this creates zero entries for placeholders that we remove later.
                // The upshot of doing it that way is to avoid having to specify place-
                // holders multiple times when omitting voters present in both halves of
                // a joint config.
                l.insert(*id, idxs[p]);
                p += 1;
            }
        }

        // Zero entries are created by _ placeholders; we don't want
        // them in the lookuper because "no entry" is different from
        // "zero entry". Note that we prevent tests from specifying
        // zero commit indexes, so that there's no confusion between
        // the two concepts.
        l.retain(|_, v| *v != Index(0));
        l
    };

    {
        let input = if d.cmd == "vote" { &votes } else { &idxs };
        let voters = JointConfig([c.clone(), cj.clone()]).ids();
        if voters.len() != input.len() {
            return Ok(format!(
                "error: mismatched input (explicit or _) for voters {}: {}",
                MapSet(&voters),
                Slice(input)
            ));
        }
    }

    let mut buf = String::new();
    match d.cmd.as_str() {
        "committed" => {
            let l = make_lookuper(&idxs, &ids, &idsj);

            // Branch based on whether this is a majority or joint quorum
            // test case.
            if !joint {
                let idx = c.committed_index(&l);
                buf.push_str(&c.describe(&l));
                // These alternative computations should return the same
                // result. If not, print to the output.
                let a_idx = alternative_majority_committed_index(&c, &l);
                if a_idx != idx {
                    let _ = writeln!(buf, "{a_idx} <-- via alternative computation");
                }
                // Joining a majority with the empty majority should give same result.
                let a_idx = JointConfig([c.clone(), MajorityConfig::new()]).committed_index(&l);
                if a_idx != idx {
                    let _ = writeln!(buf, "{a_idx} <-- via zero-joint quorum");
                }
                // Joining a majority with itself should give same result.
                let a_idx = JointConfig([c.clone(), c.clone()]).committed_index(&l);
                if a_idx != idx {
                    let _ = writeln!(buf, "{a_idx} <-- via self-joint quorum");
                }
                let overlay = |c: &MajorityConfig, l: &dyn AckedIndexer, id: u64, idx: Index| -> MapAckIndexer {
                    let mut ll = MapAckIndexer::new();
                    for &iid in c.iter() {
                        if iid == id {
                            ll.insert(iid, idx);
                        } else if let Some(idx) = l.acked_index(iid) {
                            ll.insert(iid, idx);
                        }
                    }
                    ll
                };
                for &id in c.iter() {
                    let iidx = l.acked_index(id).unwrap_or(Index(0));
                    if idx > iidx && iidx > Index(0) {
                        // If the committed index was definitely above the currently
                        // inspected idx, the result shouldn't change if we lower it
                        // further.
                        let lo = overlay(&c, &l, id, Index(iidx.0 - 1));
                        let a_idx = c.committed_index(&lo);
                        if a_idx != idx {
                            let _ = write!(buf, "{} <-- overlaying {}->{}", a_idx, id, iidx.0);
                        }
                        let lo = overlay(&c, &l, id, Index(0));
                        let a_idx = c.committed_index(&lo);
                        if a_idx != idx {
                            let _ = write!(buf, "{a_idx} <-- overlaying {id}->0");
                        }
                    }
                }
                let _ = writeln!(buf, "{idx}");
            } else {
                let cc = JointConfig([c.clone(), cj.clone()]);
                buf.push_str(&cc.describe(&l));
                let idx = cc.committed_index(&l);
                // Interchanging the majorities shouldn't make a difference. If it does, print.
                let a_idx = JointConfig([cj.clone(), c.clone()]).committed_index(&l);
                if a_idx != idx {
                    let _ = writeln!(buf, "{a_idx} <-- via symmetry");
                }
                let _ = writeln!(buf, "{idx}");
            }
        }
        "vote" => {
            let ll = make_lookuper(&votes, &ids, &idsj);
            let mut l: BTreeMap<u64, bool> = BTreeMap::new();
            for (id, v) in &ll {
                l.insert(*id, *v != Index(1)); // NB: 1 == false, 2 == true
            }

            if !joint {
                // Test a majority quorum.
                let r = c.vote_result(&l);
                let _ = writeln!(buf, "{r}");
            } else {
                // Run a joint quorum test case.
                let r = JointConfig([c.clone(), cj.clone()]).vote_result(&l);
                // Interchanging the majorities shouldn't make a difference. If it does, print.
                let ar = JointConfig([cj.clone(), c.clone()]).vote_result(&l);
                if ar != r {
                    let _ = writeln!(buf, "{ar} <-- via symmetry");
                }
                let _ = writeln!(buf, "{r}");
            }
        }
        _ => return Err(format!("unknown command: {}", d.cmd)),
    }
    Ok(buf)
}

/// This is an alternative implementation of (MajorityConfig).CommittedIndex(l).
fn alternative_majority_committed_index(c: &MajorityConfig, l: &dyn AckedIndexer) -> Index {
    if c.is_empty() {
        return Index(u64::MAX);
    }

    let mut id_to_idx: BTreeMap<u64, Index> = BTreeMap::new();
    for &id in c.iter() {
        if let Some(idx) = l.acked_index(id) {
            id_to_idx.insert(id, idx);
        }
    }

    // Build a map from index to voters who have acked that or any higher index.
    let mut idx_to_votes: BTreeMap<Index, usize> = BTreeMap::new();
    for idx in id_to_idx.values() {
        idx_to_votes.insert(*idx, 0);
    }

    for idx in id_to_idx.values() {
        for (idy, n) in idx_to_votes.iter_mut() {
            if idy > idx {
                continue;
            }
            *n += 1;
        }
    }

    // Find the maximum index that has achieved quorum.
    let q = c.len() / 2 + 1;
    let mut max_quorum_idx = Index(0);
    for (idx, n) in &idx_to_votes {
        if *n >= q && *idx > max_quorum_idx {
            max_quorum_idx = *idx;
        }
    }

    max_quorum_idx
}
