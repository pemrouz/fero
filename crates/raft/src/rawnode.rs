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

//! Port of `rawnode.go`.

use crate::node::{
    conf_change_to_msg, is_empty_hard_state, is_empty_snap, is_hard_state_equal, Ready, SnapshotStatus, SoftState,
};
use crate::num::len64;
use crate::raft::{new_raft, Config, LocalAppendThread, LocalApplyThread, Raft};
use crate::raftpb as pb;
use crate::status::{get_basic_status, get_status, BasicStatus, Status};
use crate::storage::{Error, Storage};
use crate::tracker;
use crate::util::{ents_size, is_local_msg, is_local_msg_target, is_response_msg};
use alloc::vec;
use alloc::vec::Vec;

/// RawNode is a thread-unsafe Node.
/// The methods of this struct correspond to the methods of Node and are described
/// more fully there.
#[derive(Debug)]
pub struct RawNode<S: Storage> {
    pub(crate) raft: Raft<S>,
    pub(crate) async_storage_writes: bool,

    // Mutable fields.
    pub(crate) prev_soft_st: SoftState,
    pub(crate) prev_hard_st: pb::HardState,
    pub(crate) steps_on_advance: Vec<pb::Message>,
}

impl<S: Storage> RawNode<S> {
    /// NewRawNode instantiates a RawNode from the given configuration.
    ///
    /// See Bootstrap() for bootstrapping an initial state; this replaces the former
    /// 'peers' argument to this method (with identical behavior). However, It is
    /// recommended that instead of calling Bootstrap, applications bootstrap their
    /// state manually by setting up a Storage that has a first index > 1 and which
    /// stores the desired ConfState as its InitialState.
    pub fn new(config: Config<S>) -> Result<RawNode<S>, Error> {
        let async_storage_writes = config.async_storage_writes;
        let r = new_raft(config);
        let ss = r.soft_state();
        let hs = r.hard_state();
        Ok(RawNode { raft: r, async_storage_writes, prev_soft_st: ss, prev_hard_st: hs, steps_on_advance: Vec::new() })
    }

    /// Tick advances the internal logical clock by a single tick.
    pub fn tick(&mut self) {
        self.raft.tick();
    }

    /// TickQuiesced advances the internal logical clock by a single tick without
    /// performing any other state machine processing. It allows the caller to avoid
    /// periodic heartbeats and elections when all of the peers in a Raft group are
    /// known to be at the same state. Expected usage is to periodically invoke Tick
    /// or TickQuiesced depending on whether the group is "active" or "quiesced".
    ///
    /// WARNING: Be very careful about using this method as it subverts the Raft
    /// state machine. You should probably be using Tick instead.
    ///
    /// DEPRECATED: This method will be removed in a future release.
    pub fn tick_quiesced(&mut self) {
        self.raft.election_elapsed += 1;
    }

    /// Campaign causes this RawNode to transition to candidate state.
    pub fn campaign(&mut self) -> Result<(), Error> {
        self.raft.step(pb::Message { r#type: Some(pb::MsgHup), ..Default::default() })
    }

    /// Propose proposes data be appended to the raft log.
    pub fn propose(&mut self, data: Option<Vec<u8>>) -> Result<(), Error> {
        self.raft.step(pb::Message {
            r#type: Some(pb::MsgProp),
            from: Some(self.raft.id),
            entries: vec![pb::Entry { data, ..Default::default() }],
            ..Default::default()
        })
    }

    /// ProposeConfChange proposes a config change. See (Node).ProposeConfChange for
    /// details.
    pub fn propose_conf_change(&mut self, cc: &dyn pb::ConfChangeI) -> Result<(), Error> {
        let m = conf_change_to_msg(Some(cc));
        self.raft.step(m)
    }

    /// ApplyConfChange applies a config change to the local node. The app must call
    /// this when it applies a configuration change, except when it decides to reject
    /// the configuration change, in which case no call must take place.
    pub fn apply_conf_change(&mut self, cc: &dyn pb::ConfChangeI) -> pb::ConfState {
        self.raft.apply_conf_change(&cc.as_v2())
    }

    /// Step advances the state machine using the given message.
    pub fn step(&mut self, m: pb::Message) -> Result<(), Error> {
        // Ignore unexpected local messages receiving over network.
        if is_local_msg(m.get_type()) && !is_local_msg_target(m.get_from()) {
            return Err(Error::StepLocalMsg);
        }
        if is_response_msg(m.get_type())
            && !is_local_msg_target(m.get_from())
            && !self.raft.trk.progress.contains_key(&m.get_from())
        {
            return Err(Error::StepPeerNotFound);
        }
        self.raft.step(m)
    }

    /// Ready returns the outstanding work that the application needs to handle. This
    /// includes appending and applying entries or a snapshot, updating the HardState,
    /// and sending messages. The returned Ready() *must* be handled and subsequently
    /// passed back via Advance().
    pub fn ready(&mut self) -> Ready {
        let rd = self.ready_without_accept();
        self.accept_ready(&rd);
        rd
    }

    /// readyWithoutAccept returns a Ready. This is a read-only operation, i.e. there
    /// is no obligation that the Ready must be handled.
    pub(crate) fn ready_without_accept(&self) -> Ready {
        let r = &self.raft;

        let mut rd = Ready {
            entries: r.raft_log.next_unstable_ents().to_vec(),
            committed_entries: r.raft_log.next_committed_ents(self.apply_unstable_entries()),
            messages: r.msgs.clone(),
            ..Default::default()
        };
        let soft_st = r.soft_state();
        if !soft_st.equal(&self.prev_soft_st) {
            // Allocate only when SoftState changes.
            rd.soft_state = Some(soft_st);
        }
        let hard_st = r.hard_state();
        if !is_hard_state_equal(&hard_st, &self.prev_hard_st) {
            rd.hard_state = Some(hard_st);
        }
        if r.raft_log.has_next_unstable_snapshot() {
            rd.snapshot = r.raft_log.next_unstable_snapshot();
        }
        if !r.read_states.is_empty() {
            rd.read_states = r.read_states.clone();
        }
        rd.must_sync = must_sync(&r.hard_state(), &self.prev_hard_st, len64(&rd.entries));

        if self.async_storage_writes {
            // If async storage writes are enabled, enqueue messages to
            // local storage threads, where applicable.
            if need_storage_append_msg(r, &rd) {
                let m = new_storage_append_msg(r, &rd);
                rd.messages.push(m);
            }
            if need_storage_apply_msg(&rd) {
                let m = new_storage_apply_msg(r, &rd);
                rd.messages.push(m);
            }
        } else {
            // If async storage writes are disabled, immediately enqueue
            // msgsAfterAppend to be sent out. The Ready struct contract
            // mandates that Messages cannot be sent until after Entries
            // are written to stable storage.
            for m in &r.msgs_after_append {
                if m.get_to() != r.id {
                    rd.messages.push(m.clone());
                }
            }
        }

        rd
    }

    /// acceptReady is called when the consumer of the RawNode has decided to go
    /// ahead and handle a Ready. Nothing must alter the state of the RawNode between
    /// this call and the prior call to Ready().
    pub(crate) fn accept_ready(&mut self, rd: &Ready) {
        if let Some(ss) = rd.soft_state {
            self.prev_soft_st = ss;
        }
        if !is_empty_hard_state(rd.hard_state.as_ref()) {
            if let Some(hs) = &rd.hard_state {
                self.prev_hard_st = hs.clone();
            }
        }
        if !rd.read_states.is_empty() {
            self.raft.read_states = Vec::new();
        }
        // Go reads msgsAfterAppend below and sets it to nil after. Taking it
        // here does both, without a copy of the messages.
        let msgs_after_append = core::mem::take(&mut self.raft.msgs_after_append);
        if !self.async_storage_writes {
            if !self.steps_on_advance.is_empty() {
                self.raft.logger.panicf(format_args!("two accepted Ready structs without call to Advance"));
            }
            for m in msgs_after_append {
                if m.get_to() == self.raft.id {
                    self.steps_on_advance.push(m);
                }
            }
            if need_storage_append_resp_msg(&self.raft, rd) {
                let m = new_storage_append_resp_msg(&self.raft, rd);
                self.steps_on_advance.push(m);
            }
            if need_storage_apply_resp_msg(rd) {
                let m = new_storage_apply_resp_msg(&self.raft, rd.committed_entries.clone());
                self.steps_on_advance.push(m);
            }
        }
        self.raft.msgs = Vec::new();
        self.raft.raft_log.accept_unstable();
        if let Some(last) = rd.committed_entries.last() {
            let ents = &rd.committed_entries;
            let index = last.get_index();
            self.raft.raft_log.accept_applying(index, ents_size(ents), self.apply_unstable_entries());
        }
    }

    /// applyUnstableEntries returns whether entries are allowed to be applied once
    /// they are known to be committed but before they have been written locally to
    /// stable storage.
    pub(crate) fn apply_unstable_entries(&self) -> bool {
        !self.async_storage_writes
    }

    /// HasReady called when RawNode user need to check if any Ready pending.
    #[must_use]
    pub fn has_ready(&self) -> bool {
        // TODO(nvanbenschoten): order these cases in terms of cost and frequency.
        let r = &self.raft;
        let soft_st = r.soft_state();
        if !soft_st.equal(&self.prev_soft_st) {
            return true;
        }
        let hard_st = r.hard_state();
        if !is_empty_hard_state(Some(&hard_st)) && !is_hard_state_equal(&hard_st, &self.prev_hard_st) {
            return true;
        }
        if r.raft_log.has_next_unstable_snapshot() {
            return true;
        }
        if !r.msgs.is_empty() || !r.msgs_after_append.is_empty() {
            return true;
        }
        if r.raft_log.has_next_unstable_ents() || r.raft_log.has_next_committed_ents(self.apply_unstable_entries()) {
            return true;
        }
        if !r.read_states.is_empty() {
            return true;
        }
        false
    }

    /// Advance notifies the RawNode that the application has applied and saved progress in the
    /// last Ready results.
    ///
    /// NOTE: Advance must not be called when using AsyncStorageWrites. Response messages from
    /// the local append and apply threads take its place.
    pub fn advance(&mut self, _rd: Ready) {
        // The actions performed by this function are encoded into stepsOnAdvance in
        // acceptReady. In earlier versions of this library, they were computed from
        // the provided Ready struct. Retain the unused parameter for compatibility.
        if self.async_storage_writes {
            self.raft.logger.panicf(format_args!("Advance must not be called when using AsyncStorageWrites"));
        }
        for m in core::mem::take(&mut self.steps_on_advance) {
            let _ = self.raft.step(m);
        }
    }

    /// Status returns the current status of the given group. This allocates, see
    /// BasicStatus and WithProgress for allocation-friendlier choices.
    #[must_use]
    pub fn status(&self) -> Status {
        get_status(&self.raft)
    }

    /// BasicStatus returns a BasicStatus. Notably this does not contain the
    /// Progress map; see WithProgress for an allocation-free way to inspect it.
    #[must_use]
    pub fn basic_status(&self) -> BasicStatus {
        get_basic_status(&self.raft)
    }

    /// WithProgress is a helper to introspect the Progress for this node and its
    /// peers.
    pub fn with_progress(&mut self, mut visitor: impl FnMut(u64, ProgressType, tracker::Progress)) {
        self.raft.trk.visit(|id, pr| {
            let mut typ = ProgressType::ProgressTypePeer;
            if pr.is_learner {
                typ = ProgressType::ProgressTypeLearner;
            }
            let mut p = pr.clone();
            // Go sets the copy's Inflights to nil. Here it is an empty one.
            p.inflights = tracker::Inflights::default();
            visitor(id, typ, p);
        });
    }

    /// ReportUnreachable reports the given node is not reachable for the last send.
    pub fn report_unreachable(&mut self, id: u64) {
        let _ = self.raft.step(pb::Message { r#type: Some(pb::MsgUnreachable), from: Some(id), ..Default::default() });
    }

    /// ReportSnapshot reports the status of the sent snapshot.
    pub fn report_snapshot(&mut self, id: u64, status: SnapshotStatus) {
        let rej = status == SnapshotStatus::SnapshotFailure;

        let _ = self.raft.step(pb::Message {
            r#type: Some(pb::MsgSnapStatus),
            from: Some(id),
            reject: Some(rej),
            ..Default::default()
        });
    }

    /// TransferLeader tries to transfer leadership to the given transferee.
    pub fn transfer_leader(&mut self, transferee: u64) {
        let _ = self.raft.step(pb::Message {
            r#type: Some(pb::MsgTransferLeader),
            from: Some(transferee),
            ..Default::default()
        });
    }

    /// ForgetLeader forgets a follower's current leader, changing it to None.
    /// See (Node).ForgetLeader for details.
    pub fn forget_leader(&mut self) -> Result<(), Error> {
        self.raft.step(pb::Message { r#type: Some(pb::MsgForgetLeader), ..Default::default() })
    }

    /// ReadIndex requests a read state. The read state will be set in ready.
    /// Read State has a read index. Once the application advances further than the read
    /// index, any linearizable read requests issued before the read request can be
    /// processed safely. The read state will have the same rctx attached.
    pub fn read_index(&mut self, rctx: Option<Vec<u8>>) {
        let _ = self.raft.step(pb::Message {
            r#type: Some(pb::MsgReadIndex),
            entries: vec![pb::Entry { data: rctx, ..Default::default() }],
            ..Default::default()
        });
    }

    /// Sets the randomized election timeout of this node. Go has this in a
    /// test file (`SetRandomizedElectionTimeout` in raft_test.go) and hands
    /// it to rafttest; a test driver in another crate needs it to be public.
    #[doc(hidden)]
    pub fn set_randomized_election_timeout(&mut self, v: i64) {
        self.raft.randomized_election_timeout = v;
    }
}

/// MustSync returns true if the hard state and count of Raft entries indicate
/// that a synchronous write to persistent storage is required.
#[must_use]
pub fn must_sync(st: &pb::HardState, prevst: &pb::HardState, entsnum: u64) -> bool {
    // Persistent state on all servers:
    // (Updated on stable storage before responding to RPCs)
    // currentTerm
    // votedFor
    // log entries[]
    entsnum != 0 || st.get_vote() != prevst.get_vote() || st.get_term() != prevst.get_term()
}

fn need_storage_append_msg<S: Storage>(r: &Raft<S>, rd: &Ready) -> bool {
    // Return true if log entries, hard state, or a snapshot need to be written
    // to stable storage. Also return true if any messages are contingent on all
    // prior MsgStorageAppend being processed.
    !rd.entries.is_empty()
        || !is_empty_hard_state(rd.hard_state.as_ref())
        || !is_empty_snap(rd.snapshot.as_ref())
        || !r.msgs_after_append.is_empty()
}

fn need_storage_append_resp_msg<S: Storage>(r: &Raft<S>, rd: &Ready) -> bool {
    // Return true if raft needs to hear about stabilized entries or an applied
    // snapshot. See the comment in newStorageAppendRespMsg, which explains why
    // we check hasNextOrInProgressUnstableEnts instead of len(rd.Entries) > 0.
    r.raft_log.has_next_or_in_progress_unstable_ents() || !is_empty_snap(rd.snapshot.as_ref())
}

/// newStorageAppendMsg creates the message that should be sent to the local
/// append thread to instruct it to append log entries, write an updated hard
/// state, and apply a snapshot. The message also carries a set of responses
/// that should be delivered after the rest of the message is processed. Used
/// with AsyncStorageWrites.
fn new_storage_append_msg<S: Storage>(r: &Raft<S>, rd: &Ready) -> pb::Message {
    let mut m = pb::Message {
        r#type: Some(pb::MsgStorageAppend),
        to: Some(LocalAppendThread),
        from: Some(r.id),
        entries: rd.entries.clone(),
        ..Default::default()
    };
    if !is_empty_hard_state(rd.hard_state.as_ref()) {
        // If the Ready includes a HardState update, assign each of its fields
        // to the corresponding fields in the Message. This allows clients to
        // reconstruct the HardState and save it to stable storage.
        //
        // If the Ready does not include a HardState update, make sure to not
        // assign a value to any of the fields so that a HardState reconstructed
        // from them will be empty (return true from raft.IsEmptyHardState).
        if let Some(hs) = &rd.hard_state {
            m.term = Some(hs.get_term());
            m.vote = Some(hs.get_vote());
            m.commit = Some(hs.get_commit());
        }
    }
    if !is_empty_snap(rd.snapshot.as_ref()) {
        m.snapshot = rd.snapshot.clone();
    }
    // Attach all messages in msgsAfterAppend as responses to be delivered after
    // the message is processed, along with a self-directed MsgStorageAppendResp
    // to acknowledge the entry stability.
    //
    // NB: it is important for performance that MsgStorageAppendResp message be
    // handled after self-directed MsgAppResp messages on the leader (which will
    // be contained in msgsAfterAppend). This ordering allows the MsgAppResp
    // handling to use a fast-path in r.raftLog.term() before the newly appended
    // entries are removed from the unstable log.
    m.responses = r.msgs_after_append.clone();
    if need_storage_append_resp_msg(r, rd) {
        let resp = new_storage_append_resp_msg(r, rd);
        m.responses.push(resp);
    }
    m
}

/// newStorageAppendRespMsg creates the message that should be returned to node
/// after the unstable log entries, hard state, and snapshot in the current Ready
/// (along with those in all prior Ready structs) have been saved to stable
/// storage.
fn new_storage_append_resp_msg<S: Storage>(r: &Raft<S>, rd: &Ready) -> pb::Message {
    let mut m = pb::Message {
        r#type: Some(pb::MsgStorageAppendResp),
        to: Some(r.id),
        from: Some(LocalAppendThread),
        // Dropped after term change, see below.
        term: Some(r.term),
        ..Default::default()
    };
    if r.raft_log.has_next_or_in_progress_unstable_ents() {
        // If the raft log has unstable entries, attach the last index and term of the
        // append to the response message. This (index, term) tuple will be handed back
        // and consulted when the stability of those log entries is signaled to the
        // unstable. If the (index, term) match the unstable log by the time the
        // response is received (unstable.stableTo), the unstable log can be truncated.
        //
        // However, with just this logic, there would be an ABA problem[^1] that could
        // lead to the unstable log and the stable log getting out of sync temporarily
        // and leading to an inconsistent view. Consider the following example with 5
        // nodes, A B C D E:
        //
        //  1. A is the leader.
        //  2. A proposes some log entries but only B receives these entries.
        //  3. B gets the Ready and the entries are appended asynchronously.
        //  4. A crashes and C becomes leader after getting a vote from D and E.
        //  5. C proposes some log entries and B receives these entries, overwriting the
        //     previous unstable log entries that are in the process of being appended.
        //     The entries have a larger term than the previous entries but the same
        //     indexes. It begins appending these new entries asynchronously.
        //  6. C crashes and A restarts and becomes leader again after getting the vote
        //     from D and E.
        //  7. B receives the entries from A which are the same as the ones from step 2,
        //     overwriting the previous unstable log entries that are in the process of
        //     being appended from step 5. The entries have the original terms and
        //     indexes from step 2. Recall that log entries retain their original term
        //     numbers when a leader replicates entries from previous terms. It begins
        //     appending these new entries asynchronously.
        //  8. The asynchronous log appends from the first Ready complete and stableTo
        //     is called.
        //  9. However, the log entries from the second Ready are still in the
        //     asynchronous append pipeline and will overwrite (in stable storage) the
        //     entries from the first Ready at some future point. We can't truncate the
        //     unstable log yet or a future read from Storage might see the entries from
        //     step 5 before they have been replaced by the entries from step 7.
        //     Instead, we must wait until we are sure that the entries are stable and
        //     that no in-progress appends might overwrite them before removing entries
        //     from the unstable log.
        //
        // To prevent these kinds of problems, we also attach the current term to the
        // MsgStorageAppendResp (above). If the term has changed by the time the
        // MsgStorageAppendResp if returned, the response is ignored and the unstable
        // log is not truncated. The unstable log is only truncated when the term has
        // remained unchanged from the time that the MsgStorageAppend was sent to the
        // time that the MsgStorageAppendResp is received, indicating that no-one else
        // is in the process of truncating the stable log.
        //
        // However, this replaces a correctness problem with a liveness problem. If we
        // only attempted to truncate the unstable log when appending new entries but
        // also occasionally dropped these responses, then quiescence of new log entries
        // could lead to the unstable log never being truncated.
        //
        // To combat this, we attempt to truncate the log on all MsgStorageAppendResp
        // messages where the unstable log is not empty, not just those associated with
        // entry appends. This includes MsgStorageAppendResp messages associated with an
        // updated HardState, which occur after a term change.
        //
        // In other words, we set Index and LogTerm in a block that looks like:
        //
        //  if r.raftLog.hasNextOrInProgressUnstableEnts() { ... }
        //
        // not like:
        //
        //  if len(rd.Entries) > 0 { ... }
        //
        // To do so, we attach r.raftLog.lastIndex() and r.raftLog.lastTerm(), not the
        // (index, term) of the last entry in rd.Entries. If rd.Entries is not empty,
        // these will be the same. However, if rd.Entries is empty, we still want to
        // attest that this (index, term) is correct at the current term, in case the
        // MsgStorageAppend that contained the last entry in the unstable slice carried
        // an earlier term and was dropped.
        //
        // A MsgStorageAppend with a new term is emitted on each term change. This is
        // the same condition that causes MsgStorageAppendResp messages with earlier
        // terms to be ignored. As a result, we are guaranteed that, assuming a bounded
        // number of term changes, there will eventually be a MsgStorageAppendResp
        // message that is not ignored. This means that entries in the unstable log
        // which have been appended to stable storage will eventually be truncated and
        // dropped from memory.
        //
        // [^1]: https://en.wikipedia.org/wiki/ABA_problem
        let last = r.raft_log.last_entry_id();
        m.index = Some(last.index);
        m.log_term = Some(last.term);
    }
    if !is_empty_snap(rd.snapshot.as_ref()) {
        m.snapshot = rd.snapshot.clone();
    }
    m
}

fn need_storage_apply_msg(rd: &Ready) -> bool {
    !rd.committed_entries.is_empty()
}
fn need_storage_apply_resp_msg(rd: &Ready) -> bool {
    need_storage_apply_msg(rd)
}

/// newStorageApplyMsg creates the message that should be sent to the local
/// apply thread to instruct it to apply committed log entries. The message
/// also carries a response that should be delivered after the rest of the
/// message is processed. Used with AsyncStorageWrites.
fn new_storage_apply_msg<S: Storage>(r: &Raft<S>, rd: &Ready) -> pb::Message {
    let ents = rd.committed_entries.clone();
    pb::Message {
        r#type: Some(pb::MsgStorageApply),
        to: Some(LocalApplyThread),
        from: Some(r.id),
        term: Some(0), // committed entries don't apply under a specific term
        responses: vec![new_storage_apply_resp_msg(r, ents.clone())],
        entries: ents,
        ..Default::default()
    }
}

/// newStorageApplyRespMsg creates the message that should be returned to node
/// after the committed entries in the current Ready (along with those in all
/// prior Ready structs) have been applied to the local state machine.
fn new_storage_apply_resp_msg<S: Storage>(r: &Raft<S>, ents: Vec<pb::Entry>) -> pb::Message {
    pb::Message {
        r#type: Some(pb::MsgStorageApplyResp),
        to: Some(r.id),
        from: Some(LocalApplyThread),
        term: Some(0), // committed entries don't apply under a specific term
        entries: ents,
        ..Default::default()
    }
}

/// ProgressType indicates the type of replica a Progress corresponds to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressType {
    /// ProgressTypePeer accompanies a Progress for a regular peer replica.
    ProgressTypePeer = 0,
    /// ProgressTypeLearner accompanies a Progress for a learner replica.
    ProgressTypeLearner = 1,
}
