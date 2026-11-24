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

//! Port of `raftpb/confstate.go`.

use super::raft::ConfState;
use crate::gostd::Error;

impl ConfState {
    /// Equivalent returns a nil error if the inputs describe the same configuration.
    /// On mismatch, returns a descriptive error showing the differences.
    ///
    /// Go also rejects a nil input; a reference cannot be nil here. The error
    /// text shows the values in Rust's debug form, not Go's `%+#v`.
    pub fn equivalent(&self, cs2: &ConfState) -> Result<(), Error> {
        let mut cs1v = self.clone();
        let mut cs2v = cs2.clone();

        for c in [&mut cs1v, &mut cs2v] {
            c.voters.sort_unstable();
            c.learners.sort_unstable();
            c.voters_outgoing.sort_unstable();
            c.learners_next.sort_unstable();

            // Treat nil AutoLeave as false.
            let auto_leave = c.get_auto_leave();
            c.auto_leave = Some(auto_leave);
        }

        if cs1v != cs2v {
            return Err(Error::errorf(format_args!(
                "ConfStates not equivalent after sorting:\n{cs1v:?}\n{cs2v:?}\nInputs were:\n{self:?}\n{cs2:?}"
            )));
        }
        Ok(())
    }
}
