// Copyright 2019 The etcd Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// This file is a Rust port of etcd raft (go.etcd.io/raft/v3) at commit
// c51f010c851edd0dada5af41bafbf68e54617767. See ../NOTICE (or ../../NOTICE).

//! Port of `quorum/majority.go`.

use super::{AckedIndexer, Index, VoteResult};
use crate::num::n64;
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::fmt;
use core::fmt::Write;
use core::ops::{Deref, DerefMut};

/// MajorityConfig is a set of IDs that uses majority quorums to make decisions.
///
/// Go uses `map[uint64]struct{}`. A sorted set gives the same members and a
/// fixed order. Go's nil map and empty map are both the empty set here.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MajorityConfig(pub BTreeSet<u64>);

impl Deref for MajorityConfig {
    type Target = BTreeSet<u64>;
    fn deref(&self) -> &BTreeSet<u64> {
        &self.0
    }
}

impl DerefMut for MajorityConfig {
    fn deref_mut(&mut self) -> &mut BTreeSet<u64> {
        &mut self.0
    }
}

impl FromIterator<u64> for MajorityConfig {
    fn from_iter<I: IntoIterator<Item = u64>>(iter: I) -> Self {
        MajorityConfig(iter.into_iter().collect())
    }
}

/// Go's `(c MajorityConfig) String()`.
impl fmt::Display for MajorityConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_char('(')?;
        for (i, id) in self.iter().enumerate() {
            if i > 0 {
                f.write_char(' ')?;
            }
            write!(f, "{id:x}")?;
        }
        f.write_char(')')
    }
}

fn repeat(buf: &mut String, s: char, n: u64) {
    for _ in 0..n {
        buf.push(s);
    }
}

impl MajorityConfig {
    #[must_use]
    pub fn new() -> MajorityConfig {
        MajorityConfig(BTreeSet::new())
    }

    /// Describe returns a (multi-line) representation of the commit indexes for the
    /// given lookuper.
    pub fn describe(&self, l: &dyn AckedIndexer) -> String {
        if self.is_empty() {
            return String::from("<empty majority quorum>");
        }
        struct Tup {
            id: u64,
            idx: Index,
            ok: bool, // idx found?
            bar: u64, // length of bar displayed for this tup
        }

        // Below, populate .bar so that the i-th largest commit index has bar i (we
        // plot this as sort of a progress bar). The actual code is a bit more
        // complicated and also makes sure that equal index => equal bar.

        let n = n64(self.len());
        let mut info: Vec<Tup> = Vec::with_capacity(self.len());
        for &id in self.iter() {
            let (idx, ok) = match l.acked_index(id) {
                Some(idx) => (idx, true),
                None => (Index(0), false),
            };
            info.push(Tup { id, idx, ok, bar: 0 });
        }

        // Sort by index
        info.sort_by(|a, b| a.idx.cmp(&b.idx).then(a.id.cmp(&b.id)));

        // Populate .bar.
        for i in 1..info.len() {
            if info[i - 1].idx < info[i].idx {
                info[i].bar = n64(i);
            } else {
                info[i].bar = info[i - 1].bar;
            }
        }

        // Sort by ID.
        info.sort_by_key(|a| a.id);

        let mut buf = String::new();

        // Print.
        repeat(&mut buf, ' ', n);
        buf.push_str("    idx\n");
        for t in &info {
            let bar = t.bar;
            if !t.ok {
                buf.push('?');
                repeat(&mut buf, ' ', n);
            } else {
                repeat(&mut buf, 'x', bar);
                buf.push('>');
                repeat(&mut buf, ' ', n - bar);
            }
            // Go's `%5d` prints the number, not Index's String().
            let _ = writeln!(buf, " {:5}    (id={:x})", t.idx.0, t.id);
        }
        buf
    }

    /// Slice returns the MajorityConfig as a sorted slice.
    #[must_use]
    pub fn slice(&self) -> Vec<u64> {
        self.iter().copied().collect()
    }

    /// CommittedIndex computes the committed index from those supplied via the
    /// provided AckedIndexer (for the active config).
    pub fn committed_index(&self, l: &dyn AckedIndexer) -> Index {
        let n = self.len();
        if n == 0 {
            // This plays well with joint quorums which, when one half is the zero
            // MajorityConfig, should behave like the other half.
            return Index(u64::MAX);
        }

        // Use an on-stack slice to collect the committed indexes when n <= 7
        // (otherwise we alloc). The alternative is to stash a slice on
        // MajorityConfig, but this impairs usability (as is, MajorityConfig is just
        // a map, and that's nice). The assumption is that running with a
        // replication factor of >7 is rare, and in cases in which it happens
        // performance is a secondary concern (and we may have other reasons to
        // avoid allocations).
        let mut stk = [0u64; 7];
        let mut heap: Vec<u64>;
        let srt: &mut [u64] = if stk.len() >= n {
            &mut stk[..n]
        } else {
            heap = vec![0u64; n];
            &mut heap[..]
        };

        {
            // Fill the slice with the indexes observed. Any unused slots will be
            // left as zero; these correspond to voters that may report in, but
            // haven't yet. We fill from the right (since the zeroes will end up on
            // the left after sorting below anyway).
            let mut i = n;
            for &id in self.iter() {
                if let Some(idx) = l.acked_index(id) {
                    i -= 1;
                    srt[i] = idx.0;
                }
            }
        }
        srt.sort_unstable();

        // The smallest index into the array for which the value is acked by a
        // quorum. In other words, from the end of the slice, move n/2+1 to the
        // left (accounting for zero-indexing).
        let pos = n - (n / 2 + 1);
        Index(srt[pos])
    }

    /// VoteResult takes a mapping of voters to yes/no (true/false) votes and returns
    /// a result indicating whether the vote is pending (i.e. neither a quorum of
    /// yes/no has been reached), won (a quorum of yes has been reached), or lost (a
    /// quorum of no has been reached).
    #[must_use]
    pub fn vote_result(&self, votes: &BTreeMap<u64, bool>) -> VoteResult {
        if self.is_empty() {
            // By convention, the elections on an empty config win. This comes in
            // handy with joint quorums because it'll make a half-populated joint
            // quorum behave like a majority quorum.
            return VoteResult::VoteWon;
        }

        let mut voted_cnt: u64 = 0; //vote counts for yes.
        let mut missing: u64 = 0;
        for id in self.iter() {
            let Some(&v) = votes.get(id) else {
                missing += 1;
                continue;
            };
            if v {
                voted_cnt += 1;
            }
        }

        let q = n64(self.len()) / 2 + 1;
        if voted_cnt >= q {
            return VoteResult::VoteWon;
        }
        if voted_cnt + missing >= q {
            return VoteResult::VotePending;
        }
        VoteResult::VoteLost
    }
}
