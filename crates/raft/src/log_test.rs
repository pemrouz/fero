// Copyright 2015 The etcd Authors
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

//! Port of a first part of `log_test.go`: TestFindConflict, TestIsUpToDate,
//! TestAppend, TestLogMaybeAppend and TestSlice. The rest of Go's unit tests
//! are not ported yet.

// Go's index helpers count by hand; so do these.
#![allow(clippy::explicit_counter_loop)]

extern crate std;

use crate::log::{new_log, RaftLog};
use crate::logger::{DiscardLogger, LoggerRef};
use crate::raft::noLimit;
use crate::raftpb as pb;
use crate::storage::{Error, MemoryStorage};
use crate::types::{EntryID, LogSlice};
use alloc::sync::Arc;
use alloc::vec::Vec;
use core::panic::AssertUnwindSafe;
use std::panic::catch_unwind;

fn raft_logger() -> LoggerRef {
    Arc::new(DiscardLogger)
}

/// index is a helper type for generating slices of pb.Entry. The value of index
/// is the first entry index in the generated slices.
fn index_terms(i: u64, terms: &[u64]) -> Vec<pb::Entry> {
    let mut index = i;
    let mut entries = Vec::new();
    for &term in terms {
        entries.push(pb::Entry { term: Some(term), index: Some(index), ..Default::default() });
        index += 1;
    }
    entries
}

/// termRange generates a slice of to-from entries, at consecutive indices
/// starting from i, and consecutive terms in [from, to).
fn index_term_range(i: u64, from: u64, to: u64) -> Vec<pb::Entry> {
    let mut index = i;
    let mut entries = Vec::new();
    for term in from..to {
        entries.push(pb::Entry { term: Some(term), index: Some(index), r#type: Some(pb::EntryNormal), data: None });
        index += 1;
    }
    entries
}

fn log_with(previous_ents: &[pb::Entry]) -> RaftLog<MemoryStorage> {
    let mut raft_log = new_log(MemoryStorage::new(), raft_logger());
    raft_log.append(previous_ents);
    raft_log
}

#[test]
fn test_find_conflict() {
    let previous_ents = index_terms(1, &[1, 2, 3]);
    let tests: Vec<(Vec<pb::Entry>, u64)> = alloc::vec![
        (Vec::new(), 0),
        (index_terms(1, &[1, 2, 3]), 0),
        (index_terms(2, &[2, 3]), 0),
        (index_terms(3, &[3]), 0),
        (index_terms(1, &[1, 2, 3, 4, 4]), 4),
        (index_terms(2, &[2, 3, 4, 5]), 4),
        (index_terms(3, &[3, 4, 4]), 4),
        (index_terms(4, &[4, 4]), 4),
        (index_terms(1, &[4, 4]), 1),
        (index_terms(2, &[1, 4, 4]), 2),
        (index_terms(3, &[1, 2, 4, 4]), 3),
    ];

    for (i, (ents, wconflict)) in tests.iter().enumerate() {
        let raft_log = log_with(&previous_ents);
        assert_eq!(*wconflict, raft_log.find_conflict(ents), "#{i}");
    }
}

#[test]
fn test_is_up_to_date() {
    let previous_ents = index_terms(1, &[1, 2, 3]);
    let raft_log = log_with(&previous_ents);
    let li = raft_log.last_index();
    let tests = [
        // greater term, ignore lastIndex
        (li - 1, 4, true),
        (li, 4, true),
        (li + 1, 4, true),
        // smaller term, ignore lastIndex
        (li - 1, 2, false),
        (li, 2, false),
        (li + 1, 2, false),
        // equal term, equal or lager lastIndex wins
        (li - 1, 3, false),
        (li, 3, true),
        (li + 1, 3, true),
    ];

    for (i, (last_index, term, w_up_to_date)) in tests.iter().enumerate() {
        assert_eq!(*w_up_to_date, raft_log.is_up_to_date(EntryID { term: *term, index: *last_index }), "#{i}");
    }
}

#[test]
fn test_append() {
    let previous_ents = index_terms(1, &[1, 2]);
    let tests: Vec<(Vec<pb::Entry>, u64, Vec<pb::Entry>, u64)> = alloc::vec![
        (Vec::new(), 2, index_terms(1, &[1, 2]), 3),
        (index_terms(3, &[2]), 3, index_terms(1, &[1, 2, 2]), 3),
        // conflicts with index 1
        (index_terms(1, &[2]), 1, index_terms(1, &[2]), 1),
        // conflicts with index 2
        (index_terms(2, &[3, 3]), 3, index_terms(1, &[1, 3, 3]), 2),
    ];

    for (i, (ents, windex, wents, wunstable)) in tests.iter().enumerate() {
        let mut storage = MemoryStorage::new();
        storage.append(&previous_ents).unwrap();
        let mut raft_log = new_log(storage, raft_logger());
        assert_eq!(*windex, raft_log.append(ents), "#{i}");
        let g = raft_log.entries(1, noLimit).unwrap();
        assert_eq!(wents, &g, "#{i}");
        assert_eq!(*wunstable, raft_log.unstable.offset, "#{i}");
    }
}

/// TestLogMaybeAppend ensures:
/// If the given (index, term) matches with the existing log:
///  1. If an existing entry conflicts with a new one (same index
///     but different terms), delete the existing entry and all that
///     follow it
///     2.Append any new entries not already in the log
///
/// If the given (index, term) does not match with the existing log:
///
///     return false
#[test]
fn test_log_maybe_append() {
    let previous_ents = index_terms(1, &[1, 2, 3]);
    let lastindex: u64 = 3;
    let lastterm: u64 = 3;
    let commit: u64 = 1;
    let id = |term: u64, index: u64| EntryID { term, index };

    // (prev, committed, ents, wlasti, wappend, wcommit, wpanic)
    type Case = (EntryID, u64, Vec<pb::Entry>, u64, bool, u64, bool);
    let tests: Vec<Case> = alloc::vec![
        // not match: term is different
        (id(lastterm - 1, lastindex), lastindex, index_terms(lastindex + 1, &[4]), 0, false, commit, false),
        // not match: index out of bound
        (id(lastterm, lastindex + 1), lastindex, index_terms(lastindex + 2, &[4]), 0, false, commit, false),
        // match with the last existing entry
        (id(lastterm, lastindex), lastindex, Vec::new(), lastindex, true, lastindex, false),
        // do not increase commit higher than lastnewi
        (id(lastterm, lastindex), lastindex + 1, Vec::new(), lastindex, true, lastindex, false),
        // commit up to the commit in the message
        (id(lastterm, lastindex), lastindex - 1, Vec::new(), lastindex, true, lastindex - 1, false),
        // commit do not decrease
        (id(lastterm, lastindex), 0, Vec::new(), lastindex, true, commit, false),
        // commit do not decrease
        (id(0, 0), lastindex, Vec::new(), 0, true, commit, false),
        (id(lastterm, lastindex), lastindex, index_terms(lastindex + 1, &[4]), lastindex + 1, true, lastindex, false),
        (
            id(lastterm, lastindex),
            lastindex + 1,
            index_terms(lastindex + 1, &[4]),
            lastindex + 1,
            true,
            lastindex + 1,
            false
        ),
        // do not increase commit higher than lastnewi
        (
            id(lastterm, lastindex),
            lastindex + 2,
            index_terms(lastindex + 1, &[4]),
            lastindex + 1,
            true,
            lastindex + 1,
            false
        ),
        (
            id(lastterm, lastindex),
            lastindex + 2,
            index_terms(lastindex + 1, &[4, 4]),
            lastindex + 2,
            true,
            lastindex + 2,
            false
        ),
        // match with the entry in the middle
        (id(lastterm - 1, lastindex - 1), lastindex, index_terms(lastindex, &[4]), lastindex, true, lastindex, false),
        (
            id(lastterm - 2, lastindex - 2),
            lastindex,
            index_terms(lastindex - 1, &[4]),
            lastindex - 1,
            true,
            lastindex - 1,
            false
        ),
        // conflict with existing committed entry
        (
            id(lastterm - 3, lastindex - 3),
            lastindex,
            index_terms(lastindex - 2, &[4]),
            lastindex - 2,
            true,
            lastindex - 2,
            true
        ),
        (
            id(lastterm - 2, lastindex - 2),
            lastindex,
            index_terms(lastindex - 1, &[4, 4]),
            lastindex,
            true,
            lastindex,
            false
        ),
    ];

    for (i, (prev, committed, ents, wlasti, wappend, wcommit, wpanic)) in tests.iter().enumerate() {
        let app = LogSlice { term: 100, prev: *prev, entries: ents.clone() };
        assert_eq!(app.valid(), Ok(()), "#{i}");

        let mut raft_log = log_with(&previous_ents);
        raft_log.committed = commit;

        let res = catch_unwind(AssertUnwindSafe(|| {
            let got = raft_log.maybe_append(&app, *committed);
            assert_eq!((got.unwrap_or(0), got.is_some()), (*wlasti, *wappend), "#{i}");
            assert_eq!(*wcommit, raft_log.committed, "#{i}");
            if got.is_some() && !ents.is_empty() {
                let n = crate::num::len64(ents);
                let gents = raft_log.slice(raft_log.last_index() - n + 1, raft_log.last_index() + 1, noLimit).unwrap();
                assert_eq!(ents, &gents, "#{i}");
            }
        }));
        assert_eq!(res.is_err(), *wpanic, "#{i}");
    }
}

#[test]
fn test_slice() {
    let offset: u64 = 100;
    let num: u64 = 100;
    let last = offset + num;
    let half = offset + num / 2;
    let halfe = pb::Entry { index: Some(half), term: Some(half), r#type: Some(pb::EntryNormal), data: None };
    let sz = halfe.size();

    let entries = |from: u64, to: u64| -> Vec<pb::Entry> { index_term_range(from, from, to) };

    let mut storage = MemoryStorage::new();
    storage
        .apply_snapshot(pb::Snapshot {
            metadata: Some(pb::SnapshotMetadata { index: Some(offset), ..Default::default() }),
            ..Default::default()
        })
        .unwrap();
    storage.append(&entries(offset + 1, half)).unwrap();
    let mut l = new_log(storage, raft_logger());
    l.append(&entries(half, last));

    let nil = Vec::new;
    // (lo, hi, lim, w, wpanic)
    let tests: Vec<(u64, u64, u64, Vec<pb::Entry>, bool)> = alloc::vec![
        // ErrCompacted.
        (offset - 1, offset + 1, noLimit, nil(), false),
        (offset, offset + 1, noLimit, nil(), false),
        // panics
        (half, half - 1, noLimit, nil(), true), // lo and hi inversion
        (last, last + 1, noLimit, nil(), true), // hi is out of bounds
        // No limit.
        (offset + 1, offset + 1, noLimit, nil(), false),
        (offset + 1, half - 1, noLimit, entries(offset + 1, half - 1), false),
        (offset + 1, half, noLimit, entries(offset + 1, half), false),
        (offset + 1, half + 1, noLimit, entries(offset + 1, half + 1), false),
        (offset + 1, last, noLimit, entries(offset + 1, last), false),
        (half - 1, half, noLimit, entries(half - 1, half), false),
        (half - 1, half + 1, noLimit, entries(half - 1, half + 1), false),
        (half - 1, last, noLimit, entries(half - 1, last), false),
        (half, half + 1, noLimit, entries(half, half + 1), false),
        (half, last, noLimit, entries(half, last), false),
        (last - 1, last, noLimit, entries(last - 1, last), false),
        // At least one entry is always returned.
        (offset + 1, last, 0, entries(offset + 1, offset + 2), false),
        (half - 1, half + 1, 0, entries(half - 1, half), false),
        (half, last, 0, entries(half, half + 1), false),
        (half + 1, last, 0, entries(half + 1, half + 2), false),
        // Low limit.
        (offset + 1, last, sz - 1, entries(offset + 1, offset + 2), false),
        (half - 1, half + 1, sz - 1, entries(half - 1, half), false),
        (half, last, sz - 1, entries(half, half + 1), false),
        // Just enough for one limit.
        (offset + 1, last, sz, entries(offset + 1, offset + 2), false),
        (half - 1, half + 1, sz, entries(half - 1, half), false),
        (half, last, sz, entries(half, half + 1), false),
        // Not enough for two limit.
        (offset + 1, last, sz + 1, entries(offset + 1, offset + 2), false),
        (half - 1, half + 1, sz + 1, entries(half - 1, half), false),
        (half, last, sz + 1, entries(half, half + 1), false),
        // Enough for two limit.
        (offset + 1, last, sz * 2, entries(offset + 1, offset + 3), false),
        (half - 2, half + 1, sz * 2, entries(half - 2, half), false),
        (half - 1, half + 1, sz * 2, entries(half - 1, half + 1), false),
        (half, last, sz * 2, entries(half, half + 2), false),
        // Not enough for three.
        (half - 2, half + 1, sz * 3 - 1, entries(half - 2, half), false),
        // Enough for three.
        (half - 1, half + 2, sz * 3, entries(half - 1, half + 2), false),
    ];

    for (i, (lo, hi, lim, w, wpanic)) in tests.iter().enumerate() {
        let res = catch_unwind(AssertUnwindSafe(|| {
            let g = l.slice(*lo, *hi, *lim);
            assert!(!(*lo <= offset && g != Err(Error::Compacted)), "#{i}");
            assert!(!(*lo > offset && g.is_err()), "#{i}");
            assert_eq!(w, &g.unwrap_or_default(), "#{i}");
        }));
        assert_eq!(res.is_err(), *wpanic, "#{i}");
    }
}
