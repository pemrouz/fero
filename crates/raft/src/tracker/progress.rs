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

//! Port of `tracker/progress.go`.

use super::{Inflights, StateType};
use alloc::collections::BTreeMap;
use core::cmp::{max, min};
use core::fmt;
use core::ops::{Deref, DerefMut};

/// Progress represents a follower’s progress in the view of the leader. Leader
/// maintains progresses of all followers, and sends entries to the follower
/// based on its progress.
///
/// NB(tbg): Progress is basically a state machine whose transitions are mostly
/// strewn around `*raft.raft`. Additionally, some fields are only used when in a
/// certain State. All of this isn't ideal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Progress {
    /// Match is the index up to which the follower's log is known to match the
    /// leader's. (`match` is a Rust keyword, hence the underscore.)
    pub match_: u64,
    /// Next is the log index of the next entry to send to this follower. All
    /// entries with indices in (Match, Next) interval are already in flight.
    ///
    /// Invariant: 0 <= Match < Next.
    /// NB: it follows that Next >= 1.
    ///
    /// In StateSnapshot, Next == PendingSnapshot + 1.
    pub next: u64,

    /// sentCommit is the highest commit index in flight to the follower.
    ///
    /// Generally, it is monotonic, but con regress in some cases, e.g. when
    /// converting to `StateProbe` or when receiving a rejection from a follower.
    ///
    /// In StateSnapshot, sentCommit == PendingSnapshot == Next-1.
    pub(crate) sent_commit: u64,

    /// State defines how the leader should interact with the follower.
    ///
    /// When in StateProbe, leader sends at most one replication message
    /// per heartbeat interval. It also probes actual progress of the follower.
    ///
    /// When in StateReplicate, leader optimistically increases next
    /// to the latest entry sent after sending replication message. This is
    /// an optimized state for fast replicating log entries to the follower.
    ///
    /// When in StateSnapshot, leader should have sent out snapshot
    /// before and stops sending any replication message.
    pub state: StateType,

    /// PendingSnapshot is used in StateSnapshot and tracks the last index of the
    /// leader at the time at which it realized a snapshot was necessary. This
    /// matches the index in the MsgSnap message emitted from raft.
    ///
    /// While there is a pending snapshot, replication to the follower is paused.
    /// The follower will transition back to StateReplicate if the leader
    /// receives an MsgAppResp from it that reconnects the follower to the
    /// leader's log (such an MsgAppResp is emitted when the follower applies a
    /// snapshot). It may be surprising that PendingSnapshot is not taken into
    /// account here, but consider that complex systems may delegate the sending
    /// of snapshots to alternative datasources (i.e. not the leader). In such
    /// setups, it is difficult to manufacture a snapshot at a particular index
    /// requested by raft and the actual index may be ahead or behind. This
    /// should be okay, as long as the snapshot allows replication to resume.
    ///
    /// The follower will transition to StateProbe if ReportSnapshot is called on
    /// the leader; if SnapshotFinish is passed then PendingSnapshot becomes the
    /// basis for the next attempt to append. In practice, the first mechanism is
    /// the one that is relevant in most cases. However, if this MsgAppResp is
    /// lost (fallible network) then the second mechanism ensures that in this
    /// case the follower does not erroneously remain in StateSnapshot.
    pub pending_snapshot: u64,

    /// RecentActive is true if the progress is recently active. Receiving any messages
    /// from the corresponding follower indicates the progress is active.
    /// RecentActive can be reset to false after an election timeout.
    /// This is always true on the leader.
    pub recent_active: bool,

    /// MsgAppFlowPaused is used when the MsgApp flow to a node is throttled. This
    /// happens in StateProbe, or StateReplicate with saturated Inflights. In both
    /// cases, we need to continue sending MsgApp once in a while to guarantee
    /// progress, but we only do so when MsgAppFlowPaused is false (it is reset on
    /// receiving a heartbeat response), to not overflow the receiver. See
    /// IsPaused().
    pub msg_app_flow_paused: bool,

    /// Inflights is a sliding window for the inflight messages.
    /// Each inflight message contains one or more log entries.
    /// The max number of entries per message is defined in raft config as MaxSizePerMsg.
    /// Thus inflight effectively limits both the number of inflight messages
    /// and the bandwidth each Progress can use.
    /// When inflights is Full, no more message should be sent.
    /// When a leader sends out a message, the index of the last
    /// entry should be added to inflights. The index MUST be added
    /// into inflights in order.
    /// When a leader receives a reply, the previous inflights should
    /// be freed by calling inflights.FreeLE with the index of the last
    /// received entry.
    ///
    /// Go holds a pointer here; the Progress owns the value here. See the
    /// note on `Changer::check_and_copy` for why that changes nothing.
    pub inflights: Inflights,

    /// IsLearner is true if this progress is tracked for a learner.
    pub is_learner: bool,
}

impl Progress {
    /// ResetState moves the Progress into the specified State, resetting MsgAppFlowPaused,
    /// PendingSnapshot, and Inflights.
    pub fn reset_state(&mut self, state: StateType) {
        self.msg_app_flow_paused = false;
        self.pending_snapshot = 0;
        self.state = state;
        self.inflights.reset();
    }

    /// BecomeProbe transitions into StateProbe. Next is reset to Match+1 or,
    /// optionally and if larger, the index of the pending snapshot.
    pub fn become_probe(&mut self) {
        // If the original state is StateSnapshot, progress knows that
        // the pending snapshot has been sent to this peer successfully, then
        // probes from pendingSnapshot + 1.
        if self.state == StateType::StateSnapshot {
            let pending_snapshot = self.pending_snapshot;
            self.reset_state(StateType::StateProbe);
            self.next = max(self.match_ + 1, pending_snapshot + 1);
        } else {
            self.reset_state(StateType::StateProbe);
            self.next = self.match_ + 1;
        }
        self.sent_commit = min(self.sent_commit, self.next - 1);
    }

    /// BecomeReplicate transitions into StateReplicate, resetting Next to Match+1.
    pub fn become_replicate(&mut self) {
        self.reset_state(StateType::StateReplicate);
        self.next = self.match_ + 1;
    }

    /// BecomeSnapshot moves the Progress to StateSnapshot with the specified pending
    /// snapshot index.
    pub fn become_snapshot(&mut self, snapshoti: u64) {
        self.reset_state(StateType::StateSnapshot);
        self.pending_snapshot = snapshoti;
        self.next = snapshoti + 1;
        self.sent_commit = snapshoti;
    }

    /// SentEntries updates the progress on the given number of consecutive entries
    /// being sent in a MsgApp, with the given total bytes size, appended at log
    /// indices >= pr.Next.
    ///
    /// Must be used with StateProbe or StateReplicate.
    pub fn sent_entries(&mut self, entries: u64, bytes: u64) {
        match self.state {
            StateType::StateReplicate => {
                if entries > 0 {
                    self.next += entries;
                    self.inflights.add(self.next - 1, bytes);
                }
                // If this message overflows the in-flights tracker, or it was already full,
                // consider this message being a probe, so that the flow is paused.
                self.msg_app_flow_paused = self.inflights.full();
            }
            StateType::StateProbe => {
                // TODO(pavelkalinnikov): this condition captures the previous behaviour,
                // but we should set MsgAppFlowPaused unconditionally for simplicity, because any
                // MsgApp in StateProbe is a probe, not only non-empty ones.
                if entries > 0 {
                    self.msg_app_flow_paused = true;
                }
            }
            StateType::StateSnapshot => {
                panic!("sending append in unhandled state {}", self.state)
            }
        }
    }

    /// CanBumpCommit returns true if sending the given commit index can potentially
    /// advance the follower's commit index.
    #[must_use]
    pub fn can_bump_commit(&self, index: u64) -> bool {
        // Sending the given commit index may bump the follower's commit index up to
        // Next-1 in normal operation, or higher in some rare cases. Allow sending a
        // commit index eagerly only if we haven't already sent one that bumps the
        // follower's commit all the way to Next-1.
        index > self.sent_commit && self.sent_commit < self.next - 1
    }

    /// SentCommit updates the sentCommit.
    pub fn sent_commit(&mut self, commit: u64) {
        self.sent_commit = commit;
    }

    /// MaybeUpdate is called when an MsgAppResp arrives from the follower, with the
    /// index acked by it. The method returns false if the given n index comes from
    /// an outdated message. Otherwise it updates the progress and returns true.
    pub fn maybe_update(&mut self, n: u64) -> bool {
        if n <= self.match_ {
            return false;
        }
        self.match_ = n;
        self.next = max(self.next, n + 1); // invariant: Match < Next
        self.msg_app_flow_paused = false;
        true
    }

    /// MaybeDecrTo adjusts the Progress to the receipt of a MsgApp rejection. The
    /// arguments are the index of the append message rejected by the follower, and
    /// the hint that we want to decrease to.
    ///
    /// Rejections can happen spuriously as messages are sent out of order or
    /// duplicated. In such cases, the rejection pertains to an index that the
    /// Progress already knows were previously acknowledged, and false is returned
    /// without changing the Progress.
    ///
    /// If the rejection is genuine, Next is lowered sensibly, and the Progress is
    /// cleared for sending log entries.
    pub fn maybe_decr_to(&mut self, rejected: u64, match_hint: u64) -> bool {
        if self.state == StateType::StateReplicate {
            // The rejection must be stale if the progress has matched and "rejected"
            // is smaller than "match".
            if rejected <= self.match_ {
                return false;
            }
            // Directly decrease next to match + 1.
            //
            // TODO(tbg): why not use matchHint if it's larger?
            self.next = self.match_ + 1;
            // Regress the sentCommit since it unlikely has been applied.
            self.sent_commit = min(self.sent_commit, self.next - 1);
            return true;
        }

        // The rejection must be stale if "rejected" does not match next - 1. This
        // is because non-replicating followers are probed one entry at a time.
        // The check is a best effort assuming message reordering is rare.
        //
        // Go's unsigned subtraction wraps when Next is 0; so does this.
        if self.next.wrapping_sub(1) != rejected {
            return false;
        }

        // Go's matchHint+1 wraps at the top of uint64; so does this.
        self.next = max(min(rejected, match_hint.wrapping_add(1)), self.match_ + 1);
        // Regress the sentCommit since it unlikely has been applied.
        self.sent_commit = min(self.sent_commit, self.next - 1);
        self.msg_app_flow_paused = false;
        true
    }

    /// IsPaused returns whether sending log entries to this node has been throttled.
    /// This is done when a node has rejected recent MsgApps, is currently waiting
    /// for a snapshot, or has reached the MaxInflightMsgs limit. In normal
    /// operation, this is false. A throttled node will be contacted less frequently
    /// until it has reached a state in which it's able to accept a steady stream of
    /// log entries again.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        match self.state {
            StateType::StateProbe => self.msg_app_flow_paused,
            StateType::StateReplicate => self.msg_app_flow_paused,
            StateType::StateSnapshot => true,
        }
    }
}

/// Go's `(pr *Progress) String()`.
impl fmt::Display for Progress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} match={} next={}", self.state, self.match_, self.next)?;
        if self.is_learner {
            f.write_str(" learner")?;
        }
        if self.is_paused() {
            f.write_str(" paused")?;
        }
        if self.pending_snapshot > 0 {
            write!(f, " pendingSnap={}", self.pending_snapshot)?;
        }
        if !self.recent_active {
            f.write_str(" inactive")?;
        }
        let n = self.inflights.count();
        if n > 0 {
            write!(f, " inflight={n}")?;
            if self.inflights.full() {
                f.write_str("[full]")?;
            }
        }
        Ok(())
    }
}

/// ProgressMap is a map of *Progress.
///
/// Go's map holds pointers; this sorted map owns the values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProgressMap(pub BTreeMap<u64, Progress>);

impl Deref for ProgressMap {
    type Target = BTreeMap<u64, Progress>;
    fn deref(&self) -> &BTreeMap<u64, Progress> {
        &self.0
    }
}

impl DerefMut for ProgressMap {
    fn deref_mut(&mut self) -> &mut BTreeMap<u64, Progress> {
        &mut self.0
    }
}

/// String prints the ProgressMap in sorted key order, one Progress per line.
impl fmt::Display for ProgressMap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (id, pr) in self.0.iter() {
            writeln!(f, "{id}: {pr}")?;
        }
        Ok(())
    }
}
