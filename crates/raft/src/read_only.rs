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

//! Port of `read_only.go`.

use crate::num::{ix, len64};
use crate::quorum::{self, AckedIndexer, JointConfig};
use crate::raft::ReadOnlyOption;
use crate::raftpb as pb;
use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cmp::max;

/// ReadState provides state for read only query.
/// It's caller's responsibility to call ReadIndex first before getting
/// this state from ready, it's also caller's duty to differentiate if this
/// state is what it requests through RequestCtx, eg. given a unique id as
/// RequestCtx
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReadState {
    pub index: u64,
    pub request_ctx: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) struct ReadIndexRequest {
    pub(crate) req: pb::Message,
    pub(crate) index: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct ReadOnly {
    pub(crate) option: ReadOnlyOption,
    acks: BTreeMap<u64, u64>,

    unconfirmed_reads: Vec<ReadIndexRequest>,
    /// Number of readIndexRequests that were confirmed in the past by this
    /// readOnly, which were removed from the beginning of `unconfirmedReads`.
    confirmed_reads: u64,
}

impl ReadOnly {
    pub(crate) fn new(option: ReadOnlyOption) -> ReadOnly {
        ReadOnly { option, acks: BTreeMap::new(), unconfirmed_reads: Vec::new(), confirmed_reads: 0 }
    }

    /// addRequest adds a read only request into the `readOnly`.
    /// `commitIndex` is the commit index of the raft state machine when it received
    /// the read only request.
    /// `req` is the original read only request message from the local or remote node.
    pub(crate) fn add_request(&mut self, commit_index: u64, req: pb::Message) {
        self.unconfirmed_reads.push(ReadIndexRequest { req, index: commit_index });
    }

    /// recvAck notifies the `readOnly` of an acknowledgment of a heartbeat response.
    pub(crate) fn recv_ack(&mut self, from: u64, ctx: &[u8]) {
        if !ctx.is_empty() {
            // Go's binary.LittleEndian.Uint64 panics on fewer than 8 bytes.
            let Some(b) = ctx.first_chunk::<8>() else {
                panic!("read ack context has {} bytes, need 8", ctx.len());
            };
            let v = u64::from_le_bytes(*b);
            let cur = self.acks.get(&from).copied().unwrap_or(0);
            self.acks.insert(from, max(cur, v));
        }
    }

    /// maybeAdvance uses the existing acknowledgements and current raft
    /// configuration to confirm and return as many unconfirmed reads as possible.
    pub(crate) fn maybe_advance(&mut self, c: &JointConfig) -> Vec<ReadIndexRequest> {
        // Use `CommittedIndex` to figure out how many reads are now confirmed.
        let new_confirmed_reads = c.committed_index(self).0;
        if new_confirmed_reads <= self.confirmed_reads {
            return Vec::new();
        }
        // As in Go, a count past the end of the queue is a panic.
        let n = new_confirmed_reads - self.confirmed_reads;
        if n > len64(&self.unconfirmed_reads) {
            panic!("slice bounds out of range [:{}] with length {}", n, self.unconfirmed_reads.len());
        }
        let read_states: Vec<ReadIndexRequest> = self.unconfirmed_reads.drain(..ix(n)).collect();
        self.confirmed_reads = new_confirmed_reads;
        read_states
    }

    /// heartbeatCtx returns the `Context` that should be sent in order to confirm
    /// all currently unconfirmed reads.
    pub(crate) fn heartbeat_ctx(&self) -> Option<Vec<u8>> {
        if self.unconfirmed_reads.is_empty() {
            return None;
        }
        let unconfirmed_read_position = self.confirmed_reads + len64(&self.unconfirmed_reads);
        Some(unconfirmed_read_position.to_le_bytes().to_vec())
    }
}

/// AckedIndex allows for using `CommittedIndex` in `maybeAdvance`.
impl AckedIndexer for ReadOnly {
    fn acked_index(&self, voter_id: u64) -> Option<quorum::Index> {
        self.acks.get(&voter_id).map(|&idx| quorum::Index(idx))
    }
}
