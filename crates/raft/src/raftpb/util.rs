// Copyright 2026 The etcd Authors
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

//! Port of `raftpb/util.go`.
//!
//! Go's versions take a pointer that may be nil and return a non-nil one.
//! Here they take the `Option` slot and return a reference to the filled value.

use super::raft::{ConfState, Snapshot, SnapshotMetadata};

/// EnsureConfState ensures that cs and all of its pointer fields are non-nil.
/// If cs is nil, a new ConfState is allocated. Any nil pointer field is set to
/// point to its zero value. Returns the resulting cs.
pub fn ensure_conf_state(cs: &mut Option<ConfState>) -> &mut ConfState {
    let cs = cs.get_or_insert_with(ConfState::default);
    if cs.auto_leave.is_none() {
        cs.auto_leave = Some(false);
    }
    cs
}

/// EnsureSnapshotMetadata ensures that m and all of its pointer fields are
/// non-nil. If m is nil, a new SnapshotMetadata is allocated. Any nil pointer
/// field is set to point to its zero value. Returns the resulting m.
pub fn ensure_snapshot_metadata(m: &mut Option<SnapshotMetadata>) -> &mut SnapshotMetadata {
    let m = m.get_or_insert_with(SnapshotMetadata::default);
    // ConfState in a SnapshotMetadata is guaranteed to be non-nil.
    ensure_conf_state(&mut m.conf_state);
    if m.index.is_none() {
        m.index = Some(0);
    }
    if m.term.is_none() {
        m.term = Some(0);
    }
    m
}

/// EnsureSnapshot ensures that s and all of its pointer fields are non-nil.
/// If s is nil, a new Snapshot is allocated. Any nil pointer field is set to
/// point to its zero value. Returns the resulting s.
pub fn ensure_snapshot(s: &mut Option<Snapshot>) -> &mut Snapshot {
    let s = s.get_or_insert_with(Snapshot::default);
    // Metadata in a snapshot is guaranteed to be non-nil.
    ensure_snapshot_metadata(&mut s.metadata);
    s
}
