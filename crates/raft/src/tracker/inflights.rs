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

//! Port of `tracker/inflights.go`.

use crate::num::{ix, len64};
use alloc::vec::Vec;

/// inflight describes an in-flight MsgApp message.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Inflight {
    index: u64, // the index of the last entry inside the message
    bytes: u64, // the total byte size of the entries in the message
}

/// Inflights limits the number of MsgApp (represented by the largest index
/// contained within) sent to followers but not yet acknowledged by them. Callers
/// use Full() to check whether more messages can be sent, call Add() whenever
/// they are sending a new append, and release "quota" via FreeLE() whenever an
/// ack is received.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Inflights {
    /// the starting index in the buffer
    start: u64,

    count: u64, // number of inflight messages in the buffer
    bytes: u64, // number of inflight bytes

    size: u64,      // the max number of inflight messages
    max_bytes: u64, // the max total byte size of inflight messages

    /// buffer is a ring buffer containing info about all in-flight messages.
    buffer: Vec<Inflight>,
}

impl Inflights {
    /// NewInflights sets up an Inflights that allows up to size inflight messages,
    /// with the total byte size up to maxBytes. If maxBytes is 0 then there is no
    /// byte size limit. The maxBytes limit is soft, i.e. we accept a single message
    /// that brings it from size < maxBytes to size >= maxBytes.
    #[must_use]
    pub fn new(size: u64, max_bytes: u64) -> Inflights {
        Inflights { start: 0, count: 0, bytes: 0, size, max_bytes, buffer: Vec::new() }
    }

    // Go's Clone (a copy that shares no memory) is Rust's derived `clone`.

    /// Add notifies the Inflights that a new message with the given index and byte
    /// size is being dispatched. Full() must be called prior to Add() to verify that
    /// there is room for one more message, and consecutive calls to Add() must
    /// provide a monotonic sequence of indexes.
    pub fn add(&mut self, index: u64, bytes: u64) {
        if self.full() {
            panic!("cannot add into a Full inflights");
        }
        let mut next = self.start + self.count;
        let size = self.size;
        if next >= size {
            next -= size;
        }
        if next >= len64(&self.buffer) {
            self.grow();
        }
        self.buffer[ix(next)] = Inflight { index, bytes };
        self.count += 1;
        self.bytes += bytes;
    }

    /// grow the inflight buffer by doubling up to inflights.size. We grow on demand
    /// instead of preallocating to inflights.size to handle systems which have
    /// thousands of Raft groups per process.
    fn grow(&mut self) {
        let mut new_size = len64(&self.buffer) * 2;
        if new_size == 0 {
            new_size = 1;
        } else if new_size > self.size {
            new_size = self.size;
        }
        self.buffer.resize(ix(new_size), Inflight::default());
    }

    /// FreeLE frees the inflights smaller or equal to the given `to` flight.
    pub fn free_le(&mut self, to: u64) {
        if self.count == 0 || to < self.buffer[ix(self.start)].index {
            // out of the left side of the window
            return;
        }

        let mut idx = self.start;
        let mut i: u64 = 0;
        let mut bytes: u64 = 0;
        while i < self.count {
            if to < self.buffer[ix(idx)].index {
                // found the first large inflight
                break;
            }
            bytes += self.buffer[ix(idx)].bytes;

            // increase index and maybe rotate
            let size = self.size;
            idx += 1;
            if idx >= size {
                idx -= size;
            }
            i += 1;
        }
        // free i inflights and set new start index
        self.count -= i;
        self.bytes -= bytes;
        self.start = idx;
        if self.count == 0 {
            // inflights is empty, reset the start index so that we don't grow the
            // buffer unnecessarily.
            self.start = 0;
        }
    }

    /// Full returns true if no more messages can be sent at the moment.
    #[must_use]
    pub fn full(&self) -> bool {
        self.count == self.size || (self.max_bytes != 0 && self.bytes >= self.max_bytes)
    }

    /// Count returns the number of inflight messages.
    #[must_use]
    pub fn count(&self) -> u64 {
        self.count
    }

    /// reset frees all inflights.
    pub(crate) fn reset(&mut self) {
        self.start = 0;
        self.count = 0;
        self.bytes = 0;
    }
}
