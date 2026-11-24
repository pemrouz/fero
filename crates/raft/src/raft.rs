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

//! Port of `raft.go`: the Raft state machine.
//!
//! What differs from Go, and why:
//! - `Config` and `Raft` are generic over the storage type (Go holds an
//!   interface value).
//! - Go draws the election jitter from a global, locked `crypto/rand` source.
//!   This crate draws nothing on its own: the source is injected through
//!   `Config::rand` (the trait [`Rand`]).
//! - Go's `int` (tick counts) is `i64`.
//! - Go keeps the step and tick functions as function values. Here they are
//!   the two small enums `StepFn` and `TickFn`.
//! - Go holds a `*Progress` across calls that also change the Raft struct.
//!   Rust's borrow rules refuse that, so the progress is looked up again by
//!   id after such a call. Nothing removes a progress in between.
//! - `Step` takes the message by value (Go takes a pointer and may change the
//!   message; the caller must not use it again either way).
//! - The trace hooks of `state_trace.go` are not ported.

use crate::confchange;
use crate::log::{new_log_with_size, RaftLog};
use crate::logger::LoggerRef;
use crate::node::{conf_change_to_msg, is_empty_hard_state, is_empty_snap, SoftState};
use crate::num::len64;
use crate::quorum;
use crate::raftpb as pb;
use crate::read_only::{ReadOnly, ReadState};
use crate::storage::{Error, Storage};
use crate::tracker;
use crate::types::{EntryID, LogSlice};
use crate::util::{
    assert_conf_states_equivalent, describe_conf_change, ents_size, is_local_msg_target, payloads_size,
    vote_resp_msg_type, ConfStateText, EntryEncodingSize, EntryPayloadSize,
};
use alloc::boxed::Box;
use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use core::cmp::{max, min};
use core::fmt;

/// None is a placeholder node ID used when there is no leader.
///
/// Go calls it `None`. Rust's `Option` owns that name, so it is `NONE` here.
pub const NONE: u64 = 0;
/// LocalAppendThread is a reference to a local thread that saves unstable
/// log entries and snapshots to stable storage. The identifier is used as a
/// target for MsgStorageAppend messages when AsyncStorageWrites is enabled.
pub const LocalAppendThread: u64 = u64::MAX;
/// LocalApplyThread is a reference to a local thread that applies committed
/// log entries to the local state machine. The identifier is used as a
/// target for MsgStorageApply messages when AsyncStorageWrites is enabled.
pub const LocalApplyThread: u64 = u64::MAX - 1;

/// Go's `ReadOnlyOption`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReadOnlyOption {
    /// ReadOnlySafe guarantees the linearizability of the read only request by
    /// communicating with the quorum. It is the default and suggested option.
    #[default]
    ReadOnlySafe = 0,
    /// ReadOnlyLeaseBased ensures linearizability of the read only request by
    /// relying on the leader lease. It can be affected by clock drift.
    /// If the clock drift is unbounded, leader might keep the lease longer than it
    /// should (clock can move backward/pause without any bound). ReadIndex is not safe
    /// in that case.
    ReadOnlyLeaseBased = 1,
}

/// CampaignType represents the type of campaigning.
/// Go uses a string type, because the value also travels as the context of
/// a vote request. `as_bytes` gives that string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CampaignType {
    /// campaignPreElection represents the first phase of a normal election when
    /// Config.PreVote is true.
    PreElection,
    /// campaignElection represents a normal (time-based) election (the second phase
    /// of the election when Config.PreVote is true).
    Election,
    /// campaignTransfer represents the type of leader transfer
    Transfer,
}

impl CampaignType {
    pub(crate) fn as_bytes(self) -> &'static [u8] {
        match self {
            CampaignType::PreElection => b"CampaignPreElection",
            CampaignType::Election => b"CampaignElection",
            CampaignType::Transfer => b"CampaignTransfer",
        }
    }
}

pub(crate) const noLimit: u64 = u64::MAX;

/// The source of the election jitter. Go's `lockedRand` (`globalRand`).
///
/// Go reads `crypto/rand` behind a mutex. A deterministic kernel cannot draw
/// a number itself, so the host hands one in: a real random source in
/// production, a seeded one in a simulator.
pub trait Rand: Send + Sync {
    /// Returns a number in `[0, n)`. `n` is greater than zero.
    fn intn(&self, n: i64) -> i64;
}

/// How a Raft state machine holds its random source.
pub type RandRef = Arc<dyn Rand>;

/// StateType represents the role of a node in a cluster.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StateType {
    #[default]
    StateFollower = 0,
    StateCandidate = 1,
    StateLeader = 2,
    StatePreCandidate = 3,
}

const STMAP: [&str; 4] = ["StateFollower", "StateCandidate", "StateLeader", "StatePreCandidate"];

impl fmt::Display for StateType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.pad(match self {
            StateType::StateFollower => STMAP[0],
            StateType::StateCandidate => STMAP[1],
            StateType::StateLeader => STMAP[2],
            StateType::StatePreCandidate => STMAP[3],
        })
    }
}

/// Config contains the parameters to start a raft.
#[derive(Clone)]
pub struct Config<S: Storage> {
    /// ID is the identity of the local raft. ID cannot be 0.
    pub id: u64,

    /// ElectionTick is the number of Node.Tick invocations that must pass between
    /// elections. That is, if a follower does not receive any message from the
    /// leader of current term before ElectionTick has elapsed, it will become
    /// candidate and start an election. ElectionTick must be greater than
    /// HeartbeatTick. We suggest ElectionTick = 10 * HeartbeatTick to avoid
    /// unnecessary leader switching.
    pub election_tick: i64,
    /// HeartbeatTick is the number of Node.Tick invocations that must pass between
    /// heartbeats. That is, a leader sends heartbeat messages to maintain its
    /// leadership every HeartbeatTick ticks.
    pub heartbeat_tick: i64,

    /// Storage is the storage for raft. raft generates entries and states to be
    /// stored in storage. raft reads the persisted entries and states out of
    /// Storage when it needs. raft reads out the previous state and configuration
    /// out of storage when restarting.
    pub storage: S,
    /// Applied is the last applied index. It should only be set when restarting
    /// raft. raft will not return entries to the application smaller or equal to
    /// Applied. If Applied is unset when restarting, raft might return previous
    /// applied entries. This is a very application dependent configuration.
    pub applied: u64,

    /// AsyncStorageWrites configures the raft node to write to its local storage
    /// (raft log and state machine) using a request/response message passing
    /// interface instead of the default Ready/Advance function call interface.
    /// Local storage messages can be pipelined and processed asynchronously
    /// (with respect to Ready iteration), facilitating reduced interference
    /// between Raft proposals and increased batching of log appends and state
    /// machine application. As a result, use of asynchronous storage writes can
    /// reduce end-to-end commit latency and increase maximum throughput.
    ///
    /// When true, the Ready.Message slice will include MsgStorageAppend and
    /// MsgStorageApply messages. The messages will target a LocalAppendThread
    /// and a LocalApplyThread, respectively. Messages to the same target must be
    /// reliably processed in order. In other words, they can't be dropped (like
    /// messages over the network) and those targeted at the same thread can't be
    /// reordered. Messages to different targets can be processed in any order.
    ///
    /// MsgStorageAppend carries Raft log entries to append, election votes /
    /// term changes / updated commit indexes to persist, and snapshots to apply.
    /// All writes performed in service of a MsgStorageAppend must be durable
    /// before response messages are delivered. However, if the MsgStorageAppend
    /// carries no response messages, durability is not required. The message
    /// assumes the role of the Entries, HardState, and Snapshot fields in Ready.
    ///
    /// MsgStorageApply carries committed entries to apply. Writes performed in
    /// service of a MsgStorageApply need not be durable before response messages
    /// are delivered. The message assumes the role of the CommittedEntries field
    /// in Ready.
    ///
    /// Local messages each carry one or more response messages which should be
    /// delivered after the corresponding storage write has been completed. These
    /// responses may target the same node or may target other nodes. The storage
    /// threads are not responsible for understanding the response messages, only
    /// for delivering them to the correct target after performing the storage
    /// write.
    pub async_storage_writes: bool,

    /// MaxSizePerMsg limits the max byte size of each append message. Smaller
    /// value lowers the raft recovery cost(initial probing and message lost
    /// during normal operation). On the other side, it might affect the
    /// throughput during normal replication. Note: math.MaxUint64 for unlimited,
    /// 0 for at most one entry per message.
    pub max_size_per_msg: u64,
    /// MaxCommittedSizePerReady limits the size of the committed entries which
    /// can be applying at the same time.
    ///
    /// Despite its name (preserved for compatibility), this quota applies across
    /// Ready structs to encompass all outstanding entries in unacknowledged
    /// MsgStorageApply messages when AsyncStorageWrites is enabled.
    pub max_committed_size_per_ready: u64,
    /// MaxUncommittedEntriesSize limits the aggregate byte size of the
    /// uncommitted entries that may be appended to a leader's log. Once this
    /// limit is exceeded, proposals will begin to return ErrProposalDropped
    /// errors. Note: 0 for no limit.
    pub max_uncommitted_entries_size: u64,
    /// MaxInflightMsgs limits the max number of in-flight append messages during
    /// optimistic replication phase. The application transportation layer usually
    /// has its own sending buffer over TCP/UDP. Setting MaxInflightMsgs to avoid
    /// overflowing that sending buffer. TODO (xiangli): feedback to application to
    /// limit the proposal rate?
    pub max_inflight_msgs: i64,
    /// MaxInflightBytes limits the number of in-flight bytes in append messages.
    /// Complements MaxInflightMsgs. Ignored if zero.
    ///
    /// This effectively bounds the bandwidth-delay product. Note that especially
    /// in high-latency deployments setting this too low can lead to a dramatic
    /// reduction in throughput. For example, with a peer that has a round-trip
    /// latency of 100ms to the leader and this setting is set to 1 MB, there is a
    /// throughput limit of 10 MB/s for this group. With RTT of 400ms, this drops
    /// to 2.5 MB/s. See Stevens, TCP/IP Illustrated, Volume 1, Chapter 20.7 or
    /// https://en.wikipedia.org/wiki/TCP_tuning for more details.
    pub max_inflight_bytes: u64,

    /// CheckQuorum specifies if the leader should check quorum activity. Leader
    /// steps down when quorum is not active for an electionTimeout.
    pub check_quorum: bool,

    /// PreVote enables the Pre-Vote algorithm described in raft thesis section
    /// 9.6. This prevents disruption when a node that has been partitioned away
    /// rejoins the cluster.
    pub pre_vote: bool,

    /// ReadOnlyOption specifies how the read only request is processed.
    ///
    /// ReadOnlySafe guarantees the linearizability of the read only request by
    /// communicating with the quorum. It is the default and suggested option.
    ///
    /// ReadOnlyLeaseBased ensures linearizability of the read only request by
    /// relying on the leader lease. It can be affected by clock drift.
    /// If the clock drift is unbounded, leader might keep the lease longer than it
    /// should (clock can move backward/pause without any bound). ReadIndex is not safe
    /// in that case.
    /// CheckQuorum MUST be enabled if ReadOnlyOption is ReadOnlyLeaseBased.
    pub read_only_option: ReadOnlyOption,

    /// Logger is the logger used for raft log. For multinode which can host
    /// multiple raft group, each raft group can have its own logger.
    ///
    /// Go falls back to a global logger when this is nil. There is no global
    /// here: `None` means [`crate::DiscardLogger`].
    pub logger: Option<LoggerRef>,

    /// The source of the election jitter (Go: the global `globalRand`).
    pub rand: RandRef,

    /// DisableProposalForwarding set to true means that followers will drop
    /// proposals, rather than forwarding them to the leader. One use case for
    /// this feature would be in a situation where the Raft leader is used to
    /// compute the data of a proposal, for example, adding a timestamp from a
    /// hybrid logical clock to data in a monotonically increasing way. Forwarding
    /// should be disabled to prevent a follower with an inaccurate hybrid
    /// logical clock from assigning the timestamp and then forwarding the data
    /// to the leader.
    pub disable_proposal_forwarding: bool,

    /// DisableConfChangeValidation turns off propose-time verification of
    /// configuration changes against the currently active configuration of the
    /// raft instance. These checks are generally sensible (cannot leave a joint
    /// config unless in a joint config, et cetera) but they have false positives
    /// because the active configuration may not be the most recent
    /// configuration. This is because configurations are activated during log
    /// application, and even leaders can trail log application by an unbounded
    /// number of entries.
    /// Symmetrically, the mechanism has false negatives - because the check may
    /// not run against the most recent config, a config change that is no longer
    /// valid at application time may be accepted.
    /// When this is true, the application must take care of the validity of
    /// conf changes itself (for example by checking, when it applies a conf
    /// change, that it is still valid, and skipping it if not).
    pub disable_conf_change_validation: bool,

    /// StepDownOnRemoval makes the leader step down when it is removed from the
    /// group or demoted to a learner.
    ///
    /// This behavior will become unconditional in the future. See:
    /// https://github.com/etcd-io/raft/issues/83
    pub step_down_on_removal: bool,
    // Go's `TraceLogger` belongs to state_trace.go, which is not ported.
}

impl<S: Storage> fmt::Debug for Config<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config").field("id", &self.id).finish_non_exhaustive()
    }
}

impl<S: Storage> Config<S> {
    pub(crate) fn validate(&mut self) -> Result<(), Error> {
        let errors_new = |s: &str| Err(Error::Other(String::from(s)));
        if self.id == NONE {
            return errors_new("cannot use none as id");
        }
        if is_local_msg_target(self.id) {
            return errors_new("cannot use local target as id");
        }

        if self.heartbeat_tick <= 0 {
            return errors_new("heartbeat tick must be greater than 0");
        }

        if self.election_tick <= self.heartbeat_tick {
            return errors_new("election tick must be greater than heartbeat tick");
        }

        // Go: "storage cannot be nil". A value of type S is never nil.

        if self.max_uncommitted_entries_size == 0 {
            self.max_uncommitted_entries_size = noLimit;
        }

        // default MaxCommittedSizePerReady to MaxSizePerMsg because they were
        // previously the same parameter.
        if self.max_committed_size_per_ready == 0 {
            self.max_committed_size_per_ready = self.max_size_per_msg;
        }

        if self.max_inflight_msgs <= 0 {
            return errors_new("max inflight messages must be greater than 0");
        }
        if self.max_inflight_bytes == 0 {
            self.max_inflight_bytes = noLimit;
        } else if self.max_inflight_bytes < self.max_size_per_msg {
            return errors_new("max inflight bytes must be >= max message size");
        }

        if self.logger.is_none() {
            self.logger = Some(Arc::new(crate::logger::DiscardLogger));
        }

        if self.read_only_option == ReadOnlyOption::ReadOnlyLeaseBased && !self.check_quorum {
            return errors_new("CheckQuorum must be enabled when ReadOnlyOption is ReadOnlyLeaseBased");
        }

        Ok(())
    }
}

/// Go's `stepFunc` value: which of the three step functions is active.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepFn {
    Follower,
    Candidate,
    Leader,
}

/// Go's `tick` function value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TickFn {
    Election,
    Heartbeat,
}

pub(crate) struct Raft<S: Storage> {
    pub(crate) id: u64,

    pub(crate) term: u64,
    pub(crate) vote: u64,

    pub(crate) read_states: Vec<ReadState>,

    /// the log
    pub(crate) raft_log: RaftLog<S>,

    pub(crate) max_msg_size: EntryEncodingSize,
    pub(crate) max_uncommitted_size: EntryPayloadSize,

    pub(crate) trk: tracker::ProgressTracker,

    pub(crate) state: StateType,

    /// isLearner is true if the local raft node is a learner.
    pub(crate) is_learner: bool,

    /// msgs contains the list of messages that should be sent out immediately to
    /// other nodes.
    ///
    /// Messages in this list must target other nodes.
    pub(crate) msgs: Vec<pb::Message>,
    /// msgsAfterAppend contains the list of messages that should be sent after
    /// the accumulated unstable state (e.g. term, vote, []entry, and snapshot)
    /// has been persisted to durable storage. This includes waiting for any
    /// unstable state that is already in the process of being persisted (i.e.
    /// has already been handed out in a prior Ready struct) to complete.
    ///
    /// Messages in this list may target other nodes or may target this node.
    ///
    /// Messages in this list have the type MsgAppResp, MsgVoteResp, or
    /// MsgPreVoteResp. See the comment in raft.send for details.
    pub(crate) msgs_after_append: Vec<pb::Message>,

    /// the leader id
    pub(crate) lead: u64,
    /// leadTransferee is id of the leader transfer target when its value is not zero.
    /// Follow the procedure defined in raft thesis 3.10.
    pub(crate) lead_transferee: u64,
    /// Only one conf change may be pending (in the log, but not yet
    /// applied) at a time. This is enforced via pendingConfIndex, which
    /// is set to a value >= the log index of the latest pending
    /// configuration change (if any). Config changes are only allowed to
    /// be proposed if the leader's applied index is greater than this
    /// value.
    pub(crate) pending_conf_index: u64,
    /// disableConfChangeValidation is Config.DisableConfChangeValidation,
    /// see there for details.
    pub(crate) disable_conf_change_validation: bool,
    /// an estimate of the size of the uncommitted tail of the Raft log. Used to
    /// prevent unbounded log growth. Only maintained by the leader. Reset on
    /// term changes.
    pub(crate) uncommitted_size: EntryPayloadSize,

    pub(crate) read_only: ReadOnly,

    /// number of ticks since it reached last electionTimeout when it is leader
    /// or candidate.
    /// number of ticks since it reached last electionTimeout or received a
    /// valid message from current leader when it is a follower.
    pub(crate) election_elapsed: i64,

    /// number of ticks since it reached last heartbeatTimeout.
    /// only leader keeps heartbeatElapsed.
    pub(crate) heartbeat_elapsed: i64,

    pub(crate) check_quorum: bool,
    pub(crate) pre_vote: bool,

    pub(crate) heartbeat_timeout: i64,
    pub(crate) election_timeout: i64,
    /// randomizedElectionTimeout is a random number between
    /// [electiontimeout, 2 * electiontimeout - 1]. It gets reset
    /// when raft changes its state to follower or candidate.
    pub(crate) randomized_election_timeout: i64,
    pub(crate) disable_proposal_forwarding: bool,
    pub(crate) step_down_on_removal: bool,

    pub(crate) tick: TickFn,
    pub(crate) step: StepFn,

    pub(crate) logger: LoggerRef,

    /// The random source of the election jitter (Go: `globalRand`).
    pub(crate) rand: RandRef,

    /// pendingReadIndexMessages is used to store messages of type MsgReadIndex
    /// that can't be answered as new leader didn't committed any log in
    /// current term. Those will be handled as fast as first log is committed in
    /// current term.
    pub(crate) pending_read_index_messages: Vec<pb::Message>,
}

impl<S: Storage> fmt::Debug for Raft<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Raft")
            .field("id", &self.id)
            .field("term", &self.term)
            .field("vote", &self.vote)
            .field("state", &self.state)
            .field("lead", &self.lead)
            .finish_non_exhaustive()
    }
}

/// Go's `fmt.Sprintf("%x", n)` joined by commas, for newRaft's log line.
struct PeersHex<'a>(&'a [u64]);

impl fmt::Display for PeersHex<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, n) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(",")?;
            }
            write!(f, "{n:x}")?;
        }
        Ok(())
    }
}

pub(crate) fn new_raft<S: Storage>(mut c: Config<S>) -> Raft<S> {
    if let Err(err) = c.validate() {
        panic!("{err}");
    }
    let logger = match c.logger.clone() {
        Some(l) => l,
        None => unreachable!("validate sets the logger"),
    };
    // validate made sure this is greater than zero.
    let max_inflight_msgs = u64::try_from(c.max_inflight_msgs).unwrap_or(0);
    let raftlog = new_log_with_size(c.storage, logger.clone(), c.max_committed_size_per_ready);
    let (hs, cs) = match raftlog.storage.initial_state() {
        Ok(v) => v,
        Err(err) => panic!("{err}"), // TODO(bdarnell)
    };

    let mut r = Raft {
        id: c.id,
        term: 0,
        vote: 0,
        read_states: Vec::new(),
        lead: NONE,
        is_learner: false,
        raft_log: raftlog,
        max_msg_size: c.max_size_per_msg,
        max_uncommitted_size: c.max_uncommitted_entries_size,
        trk: tracker::ProgressTracker::make(max_inflight_msgs, c.max_inflight_bytes),
        state: StateType::StateFollower,
        msgs: Vec::new(),
        msgs_after_append: Vec::new(),
        lead_transferee: NONE,
        pending_conf_index: 0,
        uncommitted_size: 0,
        election_elapsed: 0,
        heartbeat_elapsed: 0,
        election_timeout: c.election_tick,
        heartbeat_timeout: c.heartbeat_tick,
        randomized_election_timeout: 0,
        logger,
        rand: c.rand,
        check_quorum: c.check_quorum,
        pre_vote: c.pre_vote,
        read_only: ReadOnly::new(c.read_only_option),
        disable_proposal_forwarding: c.disable_proposal_forwarding,
        disable_conf_change_validation: c.disable_conf_change_validation,
        step_down_on_removal: c.step_down_on_removal,
        // Go leaves both nil until becomeFollower below sets them.
        tick: TickFn::Election,
        step: StepFn::Follower,
        pending_read_index_messages: Vec::new(),
    };

    let last_id = r.raft_log.last_entry_id();
    let (cfg, trk) =
        match confchange::restore(confchange::Changer { tracker: r.trk.clone(), last_index: last_id.index }, &cs) {
            Ok(v) => v,
            Err(err) => panic!("{err}"),
        };
    let cs2 = r.switch_to_config(cfg, trk);
    assert_conf_states_equivalent(&r.logger, &cs, &cs2);

    if !is_empty_hard_state(hs.as_ref()) {
        if let Some(hs) = &hs {
            r.load_state(hs);
        }
    }
    if c.applied > 0 {
        r.raft_log.applied_to(c.applied, 0 /* size */);
    }
    r.become_follower(r.term, NONE);

    let nodes = r.trk.voter_nodes();

    r.logger.infof(format_args!(
        "newRaft {:x} [peers: [{}], term: {}, commit: {}, applied: {}, lastindex: {}, lastterm: {}]",
        r.id,
        PeersHex(&nodes),
        r.term,
        r.raft_log.committed,
        r.raft_log.applied,
        last_id.index,
        last_id.term
    ));
    r
}

impl<S: Storage> Raft<S> {
    // Nothing in Go's core calls this either. It is kept as Go has it.
    #[allow(dead_code)]
    pub(crate) fn has_leader(&self) -> bool {
        self.lead != NONE
    }

    pub(crate) fn soft_state(&self) -> SoftState {
        SoftState { lead: self.lead, raft_state: self.state }
    }

    pub(crate) fn hard_state(&self) -> pb::HardState {
        pb::HardState { term: Some(self.term), vote: Some(self.vote), commit: Some(self.raft_log.committed) }
    }

    /// Go's `r.trk.Progress[id]` where the code goes on to use the pointer.
    /// A missing progress is a nil pointer use in Go, so it panics here too.
    fn pr(&self, id: u64) -> &tracker::Progress {
        match self.trk.progress.get(&id) {
            Some(pr) => pr,
            None => panic!("no progress for {id:x}: nil pointer dereference"),
        }
    }

    /// As `pr`, for writing.
    fn pr_mut(&mut self, id: u64) -> &mut tracker::Progress {
        match self.trk.progress.get_mut(&id) {
            Some(pr) => pr,
            None => panic!("no progress for {id:x}: nil pointer dereference"),
        }
    }

    /// send schedules persisting state to a stable storage and AFTER that
    /// sending the message (as part of next Ready message processing).
    pub(crate) fn send(&mut self, mut m: pb::Message) {
        if m.get_from() == NONE {
            m.from = Some(self.id);
        }
        if m.get_type() == pb::MsgVote
            || m.get_type() == pb::MsgVoteResp
            || m.get_type() == pb::MsgPreVote
            || m.get_type() == pb::MsgPreVoteResp
        {
            if m.get_term() == 0 {
                // All {pre-,}campaign messages need to have the term set when
                // sending.
                // - MsgVote: m.Term is the term the node is campaigning for,
                //   non-zero as we increment the term when campaigning.
                // - MsgVoteResp: m.Term is the new r.Term if the MsgVote was
                //   granted, non-zero for the same reason MsgVote is
                // - MsgPreVote: m.Term is the term the node will campaign,
                //   non-zero as we use m.Term to indicate the next term we'll be
                //   campaigning for
                // - MsgPreVoteResp: m.Term is the term received in the original
                //   MsgPreVote if the pre-vote was granted, non-zero for the
                //   same reasons MsgPreVote is
                self.logger.panicf(format_args!("term should be set when sending {}", m.get_type()));
            }
        } else {
            if m.get_term() != 0 {
                self.logger.panicf(format_args!(
                    "term should not be set when sending {} (was {})",
                    m.get_type(),
                    m.get_term()
                ));
            }
            // do not attach term to MsgProp, MsgReadIndex
            // proposals are a way to forward to the leader and
            // should be treated as local message.
            // MsgReadIndex is also forwarded to leader.
            if m.get_type() != pb::MsgProp && m.get_type() != pb::MsgReadIndex {
                m.term = Some(self.term);
            }
        }
        if m.get_type() == pb::MsgAppResp || m.get_type() == pb::MsgVoteResp || m.get_type() == pb::MsgPreVoteResp {
            // If async storage writes are enabled, messages added to the msgs slice
            // are allowed to be sent out before unstable state (e.g. log entry
            // writes and election votes) have been durably synced to the local
            // disk.
            //
            // For most message types, this is not an issue. However, response
            // messages that relate to "voting" on either leader election or log
            // appends require durability before they can be sent. It would be
            // incorrect to publish a vote in an election before that vote has been
            // synced to stable storage locally. Similarly, it would be incorrect to
            // acknowledge a log append to the leader before that entry has been
            // synced to stable storage locally.
            //
            // Per the Raft thesis, section 3.8 Persisted state and server restarts:
            //
            // > Raft servers must persist enough information to stable storage to
            // > survive server restarts safely. In particular, each server persists
            // > its current term and vote; this is necessary to prevent the server
            // > from voting twice in the same term or replacing log entries from a
            // > newer leader with those from a deposed leader. Each server also
            // > persists new log entries before they are counted towards the entries'
            // > commitment; this prevents committed entries from being lost or
            // > "uncommitted" when servers restart
            //
            // To enforce this durability requirement, these response messages are
            // queued to be sent out as soon as the current collection of unstable
            // state (the state that the response message was predicated upon) has
            // been durably persisted. This unstable state may have already been
            // passed to a Ready struct whose persistence is in progress or may be
            // waiting for the next Ready struct to begin being written to Storage.
            // These messages must wait for all of this state to be durable before
            // being published.
            //
            // Rejected responses (m.Reject == true) present an interesting case
            // where the durability requirement is less unambiguous. A rejection may
            // be predicated upon unstable state. For instance, a node may reject a
            // vote for one peer because it has already begun syncing its vote for
            // another peer. Or it may reject a vote from one peer because it has
            // unstable log entries that indicate that the peer is behind on its
            // log. In these cases, it is likely safe to send out the rejection
            // response immediately without compromising safety in the presence of a
            // server restart. However, because these rejections are rare and
            // because the safety of such behavior has not been formally verified,
            // we err on the side of safety and omit a `&& !m.Reject` condition
            // above.
            self.msgs_after_append.push(m);
        } else {
            if m.get_to() == self.id {
                self.logger.panicf(format_args!("message should not be self-addressed when sending {}", m.get_type()));
            }
            self.msgs.push(m);
        }
    }

    /// sendAppend sends an append RPC with new entries (if any) and the
    /// current commit index to the given peer.
    pub(crate) fn send_append(&mut self, to: u64) {
        self.maybe_send_append(to, true);
    }

    /// maybeSendAppend sends an append RPC with new entries to the given peer,
    /// if necessary. Returns true if a message was sent. The sendIfEmpty
    /// argument controls whether messages with no entries will be sent
    /// ("empty" messages are useful to convey updated Commit indexes, but
    /// are undesirable when we're sending multiple messages in a batch).
    ///
    /// TODO(pav-kv): make invocation of maybeSendAppend stateless. The Progress
    /// struct contains all the state necessary for deciding whether to send a
    /// message.
    pub(crate) fn maybe_send_append(&mut self, to: u64, send_if_empty: bool) -> bool {
        let pr = self.pr(to);
        if pr.is_paused() {
            return false;
        }
        let (pr_next, pr_state, inflights_full) = (pr.next, pr.state, pr.inflights.full());

        // Go's Next-1 wraps when Next is 0; so does this.
        let prev_index = pr_next.wrapping_sub(1);
        let prev_term = match self.raft_log.term(prev_index) {
            Ok(t) => t,
            Err(_) => {
                // The log probably got truncated at >= pr.Next, so we can't catch up the
                // follower log anymore. Send a snapshot instead.
                return self.maybe_send_snapshot(to);
            }
        };

        let mut ents: Vec<pb::Entry> = Vec::new();
        let mut err: Option<Error> = None;
        // In a throttled StateReplicate only send empty MsgApp, to ensure progress.
        // Otherwise, if we had a full Inflights and all inflight messages were in
        // fact dropped, replication to that follower would stall. Instead, an empty
        // MsgApp will eventually reach the follower (heartbeats responses prompt the
        // leader to send an append), allowing it to be acked or rejected, both of
        // which will clear out Inflights.
        if pr_state != tracker::StateType::StateReplicate || !inflights_full {
            match self.raft_log.entries(pr_next, self.max_msg_size) {
                Ok(e) => ents = e,
                Err(e) => err = Some(e),
            }
        }
        if ents.is_empty() && !send_if_empty {
            return false;
        }
        // TODO(pav-kv): move this check up to where err is returned.
        if err.is_some() {
            // send a snapshot if we failed to get the entries
            return self.maybe_send_snapshot(to);
        }

        // Send the actual MsgApp otherwise, and update the progress accordingly.
        let n = len64(&ents);
        let bytes = payloads_size(&ents);
        let committed = self.raft_log.committed;
        self.send(pb::Message {
            to: Some(to),
            r#type: Some(pb::MsgApp),
            index: Some(prev_index),
            log_term: Some(prev_term),
            entries: ents,
            commit: Some(committed),
            ..Default::default()
        });
        let pr = self.pr_mut(to);
        pr.sent_entries(n, bytes);
        pr.sent_commit(committed);
        true
    }

    /// maybeSendSnapshot fetches a snapshot from Storage, and sends it to the given
    /// node. Returns true iff the snapshot message has been emitted successfully.
    pub(crate) fn maybe_send_snapshot(&mut self, to: u64) -> bool {
        if !self.pr(to).recent_active {
            self.logger.debugf(format_args!("ignore sending snapshot to {to:x} since it is not recently active"));
            return false;
        }

        let snapshot = match self.raft_log.snapshot() {
            Ok(s) => s,
            Err(err) => {
                if err == Error::SnapshotTemporarilyUnavailable {
                    self.logger.debugf(format_args!(
                        "{:x} failed to send snapshot to {:x} because snapshot is temporarily unavailable",
                        self.id, to
                    ));
                    return false;
                }
                panic!("{err}"); // TODO(bdarnell)
            }
        };
        if is_empty_snap(Some(&snapshot)) {
            panic!("need non-empty snapshot");
        }
        let (sindex, sterm) = (snapshot.get_metadata_index(), snapshot.get_metadata_term());
        self.logger.debugf(format_args!(
            "{:x} [firstindex: {}, commit: {}] sent snapshot[index: {}, term: {}] to {:x} [{}]",
            self.id,
            self.raft_log.first_index(),
            self.raft_log.committed,
            sindex,
            sterm,
            to,
            self.pr(to)
        ));
        self.pr_mut(to).become_snapshot(sindex);
        self.logger.debugf(format_args!(
            "{:x} paused sending replication messages to {:x} [{}]",
            self.id,
            to,
            self.pr(to)
        ));

        self.send(pb::Message {
            to: Some(to),
            r#type: Some(pb::MsgSnap),
            snapshot: Some(snapshot),
            ..Default::default()
        });
        true
    }

    /// sendHeartbeat sends a heartbeat RPC to the given peer.
    pub(crate) fn send_heartbeat(&mut self, to: u64, ctx: Option<Vec<u8>>) {
        // Attach the commit as min(to.matched, r.committed).
        // When the leader sends out heartbeat message,
        // the receiver(follower) might not be matched with the leader
        // or it might not have all the committed entries.
        // The leader MUST NOT forward the follower's commit to
        // an unmatched index.
        let commit = min(self.pr(to).match_, self.raft_log.committed);
        self.send(pb::Message {
            to: Some(to),
            r#type: Some(pb::MsgHeartbeat),
            commit: Some(commit),
            context: ctx,
            ..Default::default()
        });
        self.pr_mut(to).sent_commit(commit);
    }

    /// The ids of all tracked progresses, in the order Go's `Visit` walks them
    /// (sorted). Go's `r.trk.Visit(func...)` closures call back into the Raft
    /// struct, which Rust's borrow rules refuse; the callers loop over this.
    fn visit_ids(&self) -> Vec<u64> {
        self.trk.progress.keys().copied().collect()
    }

    /// bcastAppend sends RPC, with entries to all peers that are not up-to-date
    /// according to the progress recorded in r.trk.
    pub(crate) fn bcast_append(&mut self) {
        for id in self.visit_ids() {
            if id == self.id {
                continue;
            }
            self.send_append(id);
        }
    }

    /// bcastHeartbeat sends RPC, without entries to all the peers.
    pub(crate) fn bcast_heartbeat(&mut self) {
        let ctx = self.read_only.heartbeat_ctx();
        self.bcast_heartbeat_with_ctx(ctx);
    }

    pub(crate) fn bcast_heartbeat_with_ctx(&mut self, ctx: Option<Vec<u8>>) {
        for id in self.visit_ids() {
            if id == self.id {
                continue;
            }
            self.send_heartbeat(id, ctx.clone());
        }
    }

    pub(crate) fn applied_to(&mut self, index: u64, size: EntryEncodingSize) {
        let old_applied = self.raft_log.applied;
        let new_applied = max(index, old_applied);
        self.raft_log.applied_to(new_applied, size);

        if self.trk.config.auto_leave && new_applied >= self.pending_conf_index && self.state == StateType::StateLeader
        {
            // If the current (and most recent, at least for this leader's term)
            // configuration should be auto-left, initiate that now. We use a
            // nil Data which unmarshals into an empty ConfChangeV2 and has the
            // benefit that appendEntry can never refuse it based on its size
            // (which registers as zero).
            let m = conf_change_to_msg(None);
            // NB: this proposal can't be dropped due to size, but can be
            // dropped if a leadership transfer is in progress. We'll keep
            // checking this condition on each applied entry, so either the
            // leadership transfer will succeed and the new leader will leave
            // the joint configuration, or the leadership transfer will fail,
            // and we will propose the config change on the next advance.
            match self.step(m) {
                Err(err) => self.logger.debugf(format_args!(
                    "not initiating automatic transition out of joint configuration {}: {}",
                    self.trk.config, err
                )),
                Ok(()) => self.logger.infof(format_args!(
                    "initiating automatic transition out of joint configuration {}",
                    self.trk.config
                )),
            }
        }
    }

    pub(crate) fn applied_snap(&mut self, snap: &pb::Snapshot) {
        let index = snap.get_metadata_index();
        self.raft_log.stable_snap_to(index);
        self.applied_to(index, 0 /* size */);
    }

    /// maybeCommit attempts to advance the commit index. Returns true if the commit
    /// index changed (in which case the caller should call r.bcastAppend). This can
    /// only be called in StateLeader.
    pub(crate) fn maybe_commit(&mut self) -> bool {
        let at = EntryID { term: self.term, index: self.trk.committed() };
        self.raft_log.maybe_commit(at)
    }

    pub(crate) fn reset(&mut self, term: u64) {
        if self.term != term {
            self.term = term;
            self.vote = NONE;
        }
        self.lead = NONE;

        self.election_elapsed = 0;
        self.heartbeat_elapsed = 0;
        self.reset_randomized_election_timeout();

        self.abort_leader_transfer();

        self.trk.reset_votes();
        let last_index = self.raft_log.last_index();
        let (self_id, max_inflight, max_inflight_bytes) = (self.id, self.trk.max_inflight, self.trk.max_inflight_bytes);
        self.trk.visit(|id, pr| {
            *pr = tracker::Progress {
                match_: 0,
                next: last_index + 1,
                inflights: tracker::Inflights::new(max_inflight, max_inflight_bytes),
                is_learner: pr.is_learner,
                ..Default::default()
            };
            if id == self_id {
                pr.match_ = last_index;
            }
        });

        self.pending_conf_index = 0;
        self.uncommitted_size = 0;
        self.read_only = ReadOnly::new(self.read_only.option);
    }

    pub(crate) fn append_entry(&mut self, mut es: Vec<pb::Entry>) -> bool {
        let mut li = self.raft_log.last_index();
        // Go clones each entry before it sets the term and the index, so the
        // caller's entries stay as they were. Here the caller hands the
        // entries over, so there is nothing to protect.
        for (i, e) in (0_u64..).zip(es.iter_mut()) {
            e.term = Some(self.term);
            e.index = Some(li + 1 + i);
        }
        // Track the size of this uncommitted proposal.
        if !self.increase_uncommitted_size(&es) {
            self.logger.warningf(format_args!(
                "{:x} appending new entries to log would exceed uncommitted entry size limit; dropping proposal",
                self.id
            ));
            // Drop the proposal.
            return false;
        }

        // use latest "last" index after truncate/append
        li = self.raft_log.append(&es);
        // The leader needs to self-ack the entries just appended once they have
        // been durably persisted (since it doesn't send an MsgApp to itself). This
        // response message will be added to msgsAfterAppend and delivered back to
        // this node after these entries have been written to stable storage. When
        // handled, this is what triggers a quorum commit of the entries. Persisting
        // before self-acking is important for the same durability reasons that
        // followers must persist before acking an MsgApp.
        self.send(pb::Message {
            to: Some(self.id),
            r#type: Some(pb::MsgAppResp),
            index: Some(li),
            ..Default::default()
        });
        true
    }

    /// Go's `r.tick()`: runs the tick function that the current role set.
    pub(crate) fn tick(&mut self) {
        match self.tick {
            TickFn::Election => self.tick_election(),
            TickFn::Heartbeat => self.tick_heartbeat(),
        }
    }

    /// tickElection is run by followers and candidates after r.electionTimeout.
    pub(crate) fn tick_election(&mut self) {
        self.election_elapsed += 1;

        if self.promotable() && self.past_election_timeout() {
            self.election_elapsed = 0;
            if let Err(err) =
                self.step(pb::Message { from: Some(self.id), r#type: Some(pb::MsgHup), ..Default::default() })
            {
                self.logger.debugf(format_args!("error occurred during election: {err}"));
            }
        }
    }

    /// tickHeartbeat is run by leaders to send a MsgBeat after r.heartbeatTimeout.
    pub(crate) fn tick_heartbeat(&mut self) {
        self.heartbeat_elapsed += 1;
        self.election_elapsed += 1;

        if self.election_elapsed >= self.election_timeout {
            self.election_elapsed = 0;
            if self.check_quorum {
                if let Err(err) = self.step(pb::Message {
                    from: Some(self.id),
                    r#type: Some(pb::MsgCheckQuorum),
                    ..Default::default()
                }) {
                    self.logger.debugf(format_args!("error occurred during checking sending heartbeat: {err}"));
                }
            }
            // If current leader cannot transfer leadership in electionTimeout, it becomes leader again.
            if self.state == StateType::StateLeader && self.lead_transferee != NONE {
                self.abort_leader_transfer();
            }
        }

        if self.state != StateType::StateLeader {
            return;
        }

        if self.heartbeat_elapsed >= self.heartbeat_timeout {
            self.heartbeat_elapsed = 0;
            if let Err(err) =
                self.step(pb::Message { from: Some(self.id), r#type: Some(pb::MsgBeat), ..Default::default() })
            {
                self.logger.debugf(format_args!("error occurred during checking sending heartbeat: {err}"));
            }
        }
    }

    pub(crate) fn become_follower(&mut self, term: u64, lead: u64) {
        self.step = StepFn::Follower;
        self.reset(term);
        self.tick = TickFn::Election;
        self.lead = lead;
        self.state = StateType::StateFollower;
        self.logger.infof(format_args!("{:x} became follower at term {}", self.id, self.term));
    }

    pub(crate) fn become_candidate(&mut self) {
        // TODO(xiangli) remove the panic when the raft implementation is stable
        if self.state == StateType::StateLeader {
            panic!("invalid transition [leader -> candidate]");
        }
        self.step = StepFn::Candidate;
        self.reset(self.term + 1);
        self.tick = TickFn::Election;
        self.vote = self.id;
        self.state = StateType::StateCandidate;
        self.logger.infof(format_args!("{:x} became candidate at term {}", self.id, self.term));
    }

    pub(crate) fn become_pre_candidate(&mut self) {
        // TODO(xiangli) remove the panic when the raft implementation is stable
        if self.state == StateType::StateLeader {
            panic!("invalid transition [leader -> pre-candidate]");
        }
        // Becoming a pre-candidate changes our step functions and state,
        // but doesn't change anything else. In particular it does not increase
        // r.Term or change r.Vote.
        self.step = StepFn::Candidate;
        self.trk.reset_votes();
        self.tick = TickFn::Election;
        self.lead = NONE;
        self.state = StateType::StatePreCandidate;
        self.logger.infof(format_args!("{:x} became pre-candidate at term {}", self.id, self.term));
    }

    pub(crate) fn become_leader(&mut self) {
        // TODO(xiangli) remove the panic when the raft implementation is stable
        if self.state == StateType::StateFollower {
            panic!("invalid transition [follower -> leader]");
        }
        self.step = StepFn::Leader;
        self.reset(self.term);
        self.tick = TickFn::Heartbeat;
        self.lead = self.id;
        self.state = StateType::StateLeader;
        // Followers enter replicate mode when they've been successfully probed
        // (perhaps after having received a snapshot as a result). The leader is
        // trivially in this state. Note that r.reset() has initialized this
        // progress with the last index already.
        let id = self.id;
        let pr = self.pr_mut(id);
        pr.become_replicate();
        // The leader always has RecentActive == true; MsgCheckQuorum makes sure to
        // preserve this.
        pr.recent_active = true;

        // Conservatively set the pendingConfIndex to the last index in the
        // log. There may or may not be a pending config change, but it's
        // safe to delay any future proposals until we commit all our
        // pending log entries, and scanning the entire tail of the log
        // could be expensive.
        self.pending_conf_index = self.raft_log.last_index();

        let empty_ent = pb::Entry { data: None, ..Default::default() };
        if !self.append_entry(vec![empty_ent]) {
            // This won't happen because we just called reset() above.
            self.logger.panicf(format_args!("empty entry was dropped"));
        }
        // The payloadSize of an empty entry is 0 (see TestPayloadSizeOfEmptyEntry),
        // so the preceding log append does not count against the uncommitted log
        // quota of the new leader. In other words, after the call to appendEntry,
        // r.uncommittedSize is still 0.
        self.logger.infof(format_args!("{:x} became leader at term {}", self.id, self.term));
    }

    pub(crate) fn hup(&mut self, t: CampaignType) {
        if self.state == StateType::StateLeader {
            self.logger.debugf(format_args!("{:x} ignoring MsgHup because already leader", self.id));
            return;
        }

        if !self.promotable() {
            self.logger.warningf(format_args!("{:x} is unpromotable and can not campaign", self.id));
            return;
        }
        if self.has_unapplied_conf_changes() {
            self.logger.warningf(format_args!(
                "{:x} cannot campaign at term {} since there are still pending configuration changes to apply",
                self.id, self.term
            ));
            return;
        }

        self.logger.infof(format_args!("{:x} is starting a new election at term {}", self.id, self.term));
        self.campaign(t);
    }

    pub(crate) fn has_unapplied_conf_changes(&self) -> bool {
        if self.raft_log.applied >= self.raft_log.committed {
            // in fact applied == committed
            return false;
        }
        let mut found = false;
        // Scan all unapplied committed entries to find a config change. Paginate the
        // scan, to avoid a potentially unlimited memory spike.
        let (lo, hi) = (self.raft_log.applied + 1, self.raft_log.committed + 1);
        // Reuse the maxApplyingEntsSize limit because it is used for similar purposes
        // (limiting the read of unapplied committed entries) when raft sends entries
        // via the Ready struct for application.
        // TODO(pavelkalinnikov): find a way to budget memory/IO more globally.
        let page_size = self.raft_log.max_applying_ents_size;
        let res = self.raft_log.scan(lo, hi, page_size, |ents| {
            for ent in ents {
                if ent.get_type() == pb::EntryConfChange || ent.get_type() == pb::EntryConfChangeV2 {
                    found = true;
                    return Err(Error::Break);
                }
            }
            Ok(())
        });
        if let Err(err) = res {
            if err != Error::Break {
                self.logger.panicf(format_args!("error scanning unapplied entries [{lo}, {hi}): {err}"));
            }
        }
        found
    }

    /// campaign transitions the raft instance to candidate state. This must only be
    /// called after verifying that this is a legitimate transition.
    pub(crate) fn campaign(&mut self, t: CampaignType) {
        if !self.promotable() {
            // This path should not be hit (callers are supposed to check), but
            // better safe than sorry.
            self.logger.warningf(format_args!("{:x} is unpromotable; campaign() should have been called", self.id));
        }
        let term: u64;
        let vote_msg: pb::MessageType;
        if t == CampaignType::PreElection {
            self.become_pre_candidate();
            vote_msg = pb::MsgPreVote;
            // PreVote RPCs are sent for the next term before we've incremented r.Term.
            term = self.term + 1;
        } else {
            self.become_candidate();
            vote_msg = pb::MsgVote;
            term = self.term;
        }
        // The set is sorted already (Go copies the map's keys and sorts them).
        let ids: Vec<u64> = self.trk.config.voters.ids().into_iter().collect();
        for id in ids {
            if id == self.id {
                // The candidate votes for itself and should account for this self
                // vote once the vote has been durably persisted (since it doesn't
                // send a MsgVote to itself). This response message will be added to
                // msgsAfterAppend and delivered back to this node after the vote
                // has been written to stable storage.
                self.send(pb::Message {
                    to: Some(id),
                    term: Some(term),
                    r#type: Some(vote_resp_msg_type(vote_msg)),
                    ..Default::default()
                });
                continue;
            }
            // TODO(pav-kv): it should be ok to simply replicate the log up to the
            // candidate's last index instead of fetching it each time.
            let last = self.raft_log.last_entry_id();
            self.logger.infof(format_args!(
                "{:x} [logterm: {}, index: {}] sent {} request to {:x} at term {}",
                self.id, last.term, last.index, vote_msg, id, self.term
            ));

            let mut ctx: Option<Vec<u8>> = None;
            if t == CampaignType::Transfer {
                ctx = Some(t.as_bytes().to_vec());
            }
            self.send(pb::Message {
                to: Some(id),
                term: Some(term),
                r#type: Some(vote_msg),
                index: Some(last.index),
                log_term: Some(last.term),
                context: ctx,
                ..Default::default()
            });
        }
    }

    pub(crate) fn poll(&mut self, id: u64, t: pb::MessageType, v: bool) -> (u64, u64, quorum::VoteResult) {
        if v {
            self.logger.infof(format_args!("{:x} received {} from {:x} at term {}", self.id, t, id, self.term));
        } else {
            self.logger
                .infof(format_args!("{:x} received {} rejection from {:x} at term {}", self.id, t, id, self.term));
        }
        self.trk.record_vote(id, v);
        self.trk.tally_votes()
    }

    /// Step advances the state machine with the given message.
    ///
    /// Go also rejects a nil message; a value cannot be nil here.
    pub(crate) fn step(&mut self, m: pb::Message) -> Result<(), Error> {
        // Handle the message term, which may result in our stepping down to a follower.
        if m.get_term() == 0 {
            // local message
        } else if m.get_term() > self.term {
            if m.get_type() == pb::MsgVote || m.get_type() == pb::MsgPreVote {
                let force = m.get_context() == CampaignType::Transfer.as_bytes();
                let in_lease = self.check_quorum && self.lead != NONE && self.election_elapsed < self.election_timeout;
                if !force && in_lease {
                    // If a server receives a RequestVote request within the minimum election timeout
                    // of hearing from a current leader, it does not update its term or grant its vote
                    let last = self.raft_log.last_entry_id();
                    // TODO(pav-kv): it should be ok to simply print the %+v of the lastEntryID.
                    self.logger.infof(format_args!(
                        "{:x} [logterm: {}, index: {}, vote: {:x}] ignored {} from {:x} [logterm: {}, index: {}] at term {}: lease is not expired (remaining ticks: {})",
                        self.id,
                        last.term,
                        last.index,
                        self.vote,
                        m.get_type(),
                        m.get_from(),
                        m.get_log_term(),
                        m.get_index(),
                        self.term,
                        self.election_timeout - self.election_elapsed
                    ));
                    return Ok(());
                }
            }
            if m.get_type() == pb::MsgPreVote {
                // Never change our term in response to a PreVote
            } else if m.get_type() == pb::MsgPreVoteResp && !m.get_reject() {
                // We send pre-vote requests with a term in our future. If the
                // pre-vote is granted, we will increment our term when we get a
                // quorum. If it is not, the term comes from the node that
                // rejected our vote so we should become a follower at the new
                // term.
            } else {
                self.logger.infof(format_args!(
                    "{:x} [term: {}] received a {} message with higher term from {:x} [term: {}]",
                    self.id,
                    self.term,
                    m.get_type(),
                    m.get_from(),
                    m.get_term()
                ));
                if m.get_type() == pb::MsgApp || m.get_type() == pb::MsgHeartbeat || m.get_type() == pb::MsgSnap {
                    self.become_follower(m.get_term(), m.get_from());
                } else {
                    self.become_follower(m.get_term(), NONE);
                }
            }
        } else if m.get_term() < self.term {
            if (self.check_quorum || self.pre_vote) && (m.get_type() == pb::MsgHeartbeat || m.get_type() == pb::MsgApp)
            {
                // We have received messages from a leader at a lower term. It is possible
                // that these messages were simply delayed in the network, but this could
                // also mean that this node has advanced its term number during a network
                // partition, and it is now unable to either win an election or to rejoin
                // the majority on the old term. If checkQuorum is false, this will be
                // handled by incrementing term numbers in response to MsgVote with a
                // higher term, but if checkQuorum is true we may not advance the term on
                // MsgVote and must generate other messages to advance the term. The net
                // result of these two features is to minimize the disruption caused by
                // nodes that have been removed from the cluster's configuration: a
                // removed node will send MsgVotes (or MsgPreVotes) which will be ignored,
                // but it will not receive MsgApp or MsgHeartbeat, so it will not create
                // disruptive term increases, by notifying leader of this node's activeness.
                // The above comments also true for Pre-Vote
                //
                // When follower gets isolated, it soon starts an election ending
                // up with a higher term than leader, although it won't receive enough
                // votes to win the election. When it regains connectivity, this response
                // with "pb.MsgAppResp" of higher term would force leader to step down.
                // However, this disruption is inevitable to free this stuck node with
                // fresh election. This can be prevented with Pre-Vote phase.
                self.send(pb::Message { to: m.from, r#type: Some(pb::MsgAppResp), ..Default::default() });
            } else if m.get_type() == pb::MsgPreVote {
                // Before Pre-Vote enable, there may have candidate with higher term,
                // but less log. After update to Pre-Vote, the cluster may deadlock if
                // we drop messages with a lower term.
                let last = self.raft_log.last_entry_id();
                // TODO(pav-kv): it should be ok to simply print %+v of the lastEntryID.
                self.logger.infof(format_args!(
                    "{:x} [logterm: {}, index: {}, vote: {:x}] rejected {} from {:x} [logterm: {}, index: {}] at term {}",
                    self.id,
                    last.term,
                    last.index,
                    self.vote,
                    m.get_type(),
                    m.get_from(),
                    m.get_log_term(),
                    m.get_index(),
                    self.term
                ));
                self.send(pb::Message {
                    to: m.from,
                    term: Some(self.term),
                    r#type: Some(pb::MsgPreVoteResp),
                    reject: Some(true),
                    ..Default::default()
                });
            } else if m.get_type() == pb::MsgStorageAppendResp {
                if m.get_index() != 0 {
                    // Don't consider the appended log entries to be stable because
                    // they may have been overwritten in the unstable log during a
                    // later term. See the comment in newStorageAppendResp for more
                    // about this race.
                    self.logger.infof(format_args!(
                        "{:x} [term: {}] ignored entry appends from a {} message with lower term [term: {}]",
                        self.id,
                        self.term,
                        m.get_type(),
                        m.get_term()
                    ));
                }
                if let Some(snap) = m.get_snapshot() {
                    // Even if the snapshot applied under a different term,
                    // its application is still valid. Snapshots carry
                    // committed (term-independent) state.
                    self.applied_snap(snap);
                }
            } else {
                // ignore other cases
                self.logger.infof(format_args!(
                    "{:x} [term: {}] ignored a {} message with lower term from {:x} [term: {}]",
                    self.id,
                    self.term,
                    m.get_type(),
                    m.get_from(),
                    m.get_term()
                ));
            }
            return Ok(());
        }

        match m.get_type() {
            pb::MsgHup => {
                if self.pre_vote {
                    self.hup(CampaignType::PreElection);
                } else {
                    self.hup(CampaignType::Election);
                }
            }

            pb::MsgStorageAppendResp => {
                if m.get_index() != 0 {
                    self.raft_log.stable_to(EntryID { term: m.get_log_term(), index: m.get_index() });
                }
                if let Some(snap) = m.get_snapshot() {
                    self.applied_snap(snap);
                }
            }

            pb::MsgStorageApplyResp => {
                if let Some(last) = m.get_entries().last() {
                    let index = last.get_index();
                    self.applied_to(index, ents_size(m.get_entries()));
                    self.reduce_uncommitted_size(payloads_size(m.get_entries()));
                }
            }

            pb::MsgVote | pb::MsgPreVote => {
                // We can vote if this is a repeat of a vote we've already cast...
                let can_vote = self.vote == m.get_from() ||
                    // ...we haven't voted and we don't think there's a leader yet in this term...
                    (self.vote == NONE && self.lead == NONE) ||
                    // ...or this is a PreVote for a future term...
                    (m.get_type() == pb::MsgPreVote && m.get_term() > self.term);
                // ...and we believe the candidate is up to date.
                let last_id = self.raft_log.last_entry_id();
                let cand_last_id = EntryID { term: m.get_log_term(), index: m.get_index() };
                if can_vote && self.raft_log.is_up_to_date(cand_last_id) {
                    // Note: it turns out that that learners must be allowed to cast votes.
                    // This seems counter- intuitive but is necessary in the situation in which
                    // a learner has been promoted (i.e. is now a voter) but has not learned
                    // about this yet.
                    // For example, consider a group in which id=1 is a learner and id=2 and
                    // id=3 are voters. A configuration change promoting 1 can be committed on
                    // the quorum `{2,3}` without the config change being appended to the
                    // learner's log. If the leader (say 2) fails, there are de facto two
                    // voters remaining. Only 3 can win an election (due to its log containing
                    // all committed entries), but to do so it will need 1 to vote. But 1
                    // considers itself a learner and will continue to do so until 3 has
                    // stepped up as leader, replicates the conf change to 1, and 1 applies it.
                    // Ultimately, by receiving a request to vote, the learner realizes that
                    // the candidate believes it to be a voter, and that it should act
                    // accordingly. The candidate's config may be stale, too; but in that case
                    // it won't win the election, at least in the absence of the bug discussed
                    // in:
                    // https://github.com/etcd-io/etcd/issues/7625#issuecomment-488798263.
                    self.logger.infof(format_args!(
                        "{:x} [logterm: {}, index: {}, vote: {:x}] cast {} for {:x} [logterm: {}, index: {}] at term {}",
                        self.id,
                        last_id.term,
                        last_id.index,
                        self.vote,
                        m.get_type(),
                        m.get_from(),
                        cand_last_id.term,
                        cand_last_id.index,
                        self.term
                    ));
                    // When responding to Msg{Pre,}Vote messages we include the term
                    // from the message, not the local term. To see why, consider the
                    // case where a single node was previously partitioned away and
                    // it's local term is now out of date. If we include the local term
                    // (recall that for pre-votes we don't update the local term), the
                    // (pre-)campaigning node on the other end will proceed to ignore
                    // the message (it ignores all out of date messages).
                    // The term in the original message and current local term are the
                    // same in the case of regular votes, but different for pre-votes.
                    self.send(pb::Message {
                        to: m.from,
                        term: m.term,
                        r#type: Some(vote_resp_msg_type(m.get_type())),
                        ..Default::default()
                    });
                    if m.get_type() == pb::MsgVote {
                        // Only record real votes.
                        self.election_elapsed = 0;
                        self.vote = m.get_from();
                    }
                } else {
                    self.logger.infof(format_args!(
                        "{:x} [logterm: {}, index: {}, vote: {:x}] rejected {} from {:x} [logterm: {}, index: {}] at term {}",
                        self.id,
                        last_id.term,
                        last_id.index,
                        self.vote,
                        m.get_type(),
                        m.get_from(),
                        cand_last_id.term,
                        cand_last_id.index,
                        self.term
                    ));
                    self.send(pb::Message {
                        to: m.from,
                        term: Some(self.term),
                        r#type: Some(vote_resp_msg_type(m.get_type())),
                        reject: Some(true),
                        ..Default::default()
                    });
                }
            }

            _ => match self.step {
                StepFn::Leader => self.step_leader(m)?,
                StepFn::Candidate => self.step_candidate(m)?,
                StepFn::Follower => self.step_follower(m)?,
            },
        }
        Ok(())
    }

    fn step_leader(&mut self, mut m: pb::Message) -> Result<(), Error> {
        // These message types do not require any progress for m.From.
        match m.get_type() {
            pb::MsgBeat => {
                self.bcast_heartbeat();
                return Ok(());
            }
            pb::MsgCheckQuorum => {
                if !self.trk.quorum_active() {
                    self.logger
                        .warningf(format_args!("{:x} stepped down to follower since quorum is not active", self.id));
                    self.become_follower(self.term, NONE);
                }
                // Mark everyone (but ourselves) as inactive in preparation for the next
                // CheckQuorum.
                let self_id = self.id;
                self.trk.visit(|id, pr| {
                    if id != self_id {
                        pr.recent_active = false;
                    }
                });
                return Ok(());
            }
            pb::MsgProp => {
                if m.get_entries().is_empty() {
                    self.logger.panicf(format_args!("{:x} stepped empty MsgProp", self.id));
                }
                if !self.trk.progress.contains_key(&self.id) {
                    // If we are not currently a member of the range (i.e. this node
                    // was removed from the configuration while serving as leader),
                    // drop any new proposals.
                    return Err(Error::ProposalDropped);
                }
                if self.lead_transferee != NONE {
                    self.logger.debugf(format_args!(
                        "{:x} [term {}] transfer leadership to {:x} is in progress; dropping proposal",
                        self.id, self.term, self.lead_transferee
                    ));
                    return Err(Error::ProposalDropped);
                }

                for (i, e) in (0_u64..).zip(m.entries.iter_mut()) {
                    let mut cc: Option<Box<dyn pb::ConfChangeI>> = None;
                    if e.get_type() == pb::EntryConfChange {
                        match pb::ConfChange::unmarshal(e.get_data()) {
                            Ok(ccc) => cc = Some(Box::new(ccc)),
                            Err(err) => panic!("{err}"),
                        }
                    } else if e.get_type() == pb::EntryConfChangeV2 {
                        match pb::ConfChangeV2::unmarshal(e.get_data()) {
                            Ok(ccc) => cc = Some(Box::new(ccc)),
                            Err(err) => panic!("{err}"),
                        }
                    }
                    if let Some(cc) = cc {
                        let already_pending = self.pending_conf_index > self.raft_log.applied;
                        let already_joint = !self.trk.config.voters.0[1].is_empty();
                        let wants_leave_joint = cc.as_v2().changes.is_empty();

                        let mut failed_check = String::new();
                        if already_pending {
                            failed_check = alloc::format!(
                                "possible unapplied conf change at index {} (applied to {})",
                                self.pending_conf_index,
                                self.raft_log.applied
                            );
                        } else if already_joint && !wants_leave_joint {
                            failed_check = String::from("must transition out of joint config first");
                        } else if !already_joint && wants_leave_joint {
                            failed_check = String::from("not in joint state; refusing empty conf change");
                        }

                        if !failed_check.is_empty() && !self.disable_conf_change_validation {
                            self.logger.infof(format_args!(
                                "{:x} ignoring conf change {} at config {}: {}",
                                self.id,
                                describe_conf_change(cc.as_ref()),
                                self.trk.config,
                                failed_check
                            ));
                            *e = pb::Entry { r#type: Some(pb::EntryNormal), ..Default::default() };
                        } else {
                            self.pending_conf_index = self.raft_log.last_index() + i + 1;
                        }
                    }
                }

                if !self.append_entry(core::mem::take(&mut m.entries)) {
                    return Err(Error::ProposalDropped);
                }
                self.bcast_append();
                return Ok(());
            }
            pb::MsgReadIndex => {
                // Postpone read only request when this leader has not committed
                // any log entry at its term.
                if !self.committed_entry_in_current_term() {
                    self.pending_read_index_messages.push(m);
                    return Ok(());
                }

                self.send_msg_read_index_response(m);

                return Ok(());
            }
            pb::MsgForgetLeader => {
                return Ok(()); // noop on leader
            }
            _ => {}
        }

        // All other message types require a progress for m.From (pr).
        let from = m.get_from();
        if !self.trk.progress.contains_key(&from) {
            self.logger.debugf(format_args!("{:x} no progress available for {:x}", self.id, from));
            return Ok(());
        }
        match m.get_type() {
            pb::MsgAppResp => {
                // NB: this code path is also hit from (*raft).advance, where the leader steps
                // an MsgAppResp to acknowledge the appended entries in the last Ready.

                self.pr_mut(from).recent_active = true;

                if m.get_reject() {
                    // RejectHint is the suggested next base entry for appending (i.e.
                    // we try to append entry RejectHint+1 next), and LogTerm is the
                    // term that the follower has at index RejectHint. Older versions
                    // of this library did not populate LogTerm for rejections and it
                    // is zero for followers with an empty log.
                    //
                    // Under normal circumstances, the leader's log is longer than the
                    // follower's and the follower's log is a prefix of the leader's
                    // (i.e. there is no divergent uncommitted suffix of the log on the
                    // follower). In that case, the first probe reveals where the
                    // follower's log ends (RejectHint=follower's last index) and the
                    // subsequent probe succeeds.
                    //
                    // However, when networks are partitioned or systems overloaded,
                    // large divergent log tails can occur. The naive attempt, probing
                    // entry by entry in decreasing order, will be the product of the
                    // length of the diverging tails and the network round-trip latency,
                    // which can easily result in hours of time spent probing and can
                    // even cause outright outages. The probes are thus optimized as
                    // described below.
                    self.logger.debugf(format_args!(
                        "{:x} received MsgAppResp(rejected, hint: (index {}, term {})) from {:x} for index {}",
                        self.id,
                        m.get_reject_hint(),
                        m.get_log_term(),
                        from,
                        m.get_index()
                    ));
                    let mut next_probe_idx = m.get_reject_hint();
                    if m.get_log_term() > 0 {
                        // If the follower has an uncommitted log tail, we would end up
                        // probing one by one until we hit the common prefix.
                        //
                        // For example, if the leader has:
                        //
                        //   idx        1 2 3 4 5 6 7 8 9
                        //              -----------------
                        //   term (L)   1 3 3 3 5 5 5 5 5
                        //   term (F)   1 1 1 1 2 2
                        //
                        // Then, after sending an append anchored at (idx=9,term=5) we
                        // would receive a RejectHint of 6 and LogTerm of 2. Without the
                        // code below, we would try an append at index 6, which would
                        // fail again.
                        //
                        // However, looking only at what the leader knows about its own
                        // log and the rejection hint, it is clear that a probe at index
                        // 6, 5, 4, 3, and 2 must fail as well:
                        //
                        // For all of these indexes, the leader's log term is larger than
                        // the rejection's log term. If a probe at one of these indexes
                        // succeeded, its log term at that index would match the leader's,
                        // i.e. 3 or 5 in this example. But the follower already told the
                        // leader that it is still at term 2 at index 6, and since the
                        // log term only ever goes up (within a log), this is a
                        // contradiction.
                        //
                        // At index 1, however, the leader can draw no such conclusion,
                        // as its term 1 is not larger than the term 2 from the
                        // follower's rejection. We thus probe at 1, which will succeed
                        // in this example. In general, with this approach we probe at
                        // most once per term found in the leader's log.
                        //
                        // There is a similar mechanism on the follower (implemented in
                        // handleAppendEntries via a call to findConflictByTerm) that is
                        // useful if the follower has a large divergent uncommitted log
                        // tail[1], as in this example:
                        //
                        //   idx        1 2 3 4 5 6 7 8 9
                        //              -----------------
                        //   term (L)   1 3 3 3 3 3 3 3 7
                        //   term (F)   1 3 3 4 4 5 5 5 6
                        //
                        // Naively, the leader would probe at idx=9, receive a rejection
                        // revealing the log term of 6 at the follower. Since the leader's
                        // term at the previous index 8 is already smaller than 6, the
                        // leader- side optimization discussed above is ineffective. The
                        // leader thus probes at index 8 and, naively, receives a
                        // rejection for the same index and log term 5. Again, the
                        // leader optimization does not improve over linear probing as
                        // term 5 is above the leader's term 3 for that and many
                        // preceding indexes; the leader would have to probe linearly
                        // until it would finally hit index 3, where the probe would
                        // succeed.
                        //
                        // Instead, we apply a similar optimization on the follower. When
                        // the follower receives the probe at index 8 (log term 3), it
                        // concludes that all of the leader's log preceding that index has
                        // log terms of 3 or below. The largest index in the follower's
                        // log with a log term of 3 or below is index 3. The follower will
                        // thus return a rejection for index=3, log term=3 instead. The
                        // leader's next probe will then succeed at that index.
                        //
                        // [1]: more precisely, if the log terms in the large uncommitted
                        // tail on the follower are larger than the leader's. At first,
                        // it may seem unintuitive that a follower could even have such
                        // a large tail, but it can happen:
                        //
                        // 1. Leader appends (but does not commit) entries 2 and 3, crashes.
                        //   idx        1 2 3 4 5 6 7 8 9
                        //              -----------------
                        //   term (L)   1 2 2     [crashes]
                        //   term (F)   1
                        //   term (F)   1
                        //
                        // 2. a follower becomes leader and appends entries at term 3.
                        //              -----------------
                        //   term (x)   1 2 2     [down]
                        //   term (F)   1 3 3 3 3
                        //   term (F)   1
                        //
                        // 3. term 3 leader goes down, term 2 leader returns as term 4
                        //    leader. It commits the log & entries at term 4.
                        //
                        //              -----------------
                        //   term (L)   1 2 2 2
                        //   term (x)   1 3 3 3 3 [down]
                        //   term (F)   1
                        //              -----------------
                        //   term (L)   1 2 2 2 4 4 4
                        //   term (F)   1 3 3 3 3 [gets probed]
                        //   term (F)   1 2 2 2 4 4 4
                        //
                        // 4. the leader will now probe the returning follower at index
                        //    7, the rejection points it at the end of the follower's log
                        //    which is at a higher log term than the actually committed
                        //    log.
                        (next_probe_idx, _) =
                            self.raft_log.find_conflict_by_term(m.get_reject_hint(), m.get_log_term());
                    }
                    if self.pr_mut(from).maybe_decr_to(m.get_index(), next_probe_idx) {
                        self.logger.debugf(format_args!(
                            "{:x} decreased progress of {:x} to [{}]",
                            self.id,
                            from,
                            self.pr(from)
                        ));
                        if self.pr(from).state == tracker::StateType::StateReplicate {
                            self.pr_mut(from).become_probe();
                        }
                        self.send_append(from);
                    }
                } else {
                    // We want to update our tracking if the response updates our
                    // matched index or if the response can move a probing peer back
                    // into StateReplicate (see heartbeat_rep_recovers_from_probing.txt
                    // for an example of the latter case).
                    // NB: the same does not make sense for StateSnapshot - if `m.Index`
                    // equals pr.Match we know we don't m.Index+1 in our log, so moving
                    // back to replicating state is not useful; besides pr.PendingSnapshot
                    // would prevent it.
                    let first_index = self.raft_log.first_index();
                    let pr = self.pr_mut(from);
                    if pr.maybe_update(m.get_index())
                        || (pr.match_ == m.get_index() && pr.state == tracker::StateType::StateProbe)
                    {
                        if pr.state == tracker::StateType::StateProbe {
                            pr.become_replicate();
                        } else if pr.state == tracker::StateType::StateSnapshot
                            && pr.match_.wrapping_add(1) >= first_index
                        {
                            // Note that we don't take into account PendingSnapshot to
                            // enter this branch. No matter at which index a snapshot
                            // was actually applied, as long as this allows catching up
                            // the follower from the log, we will accept it. This gives
                            // systems more flexibility in how they implement snapshots;
                            // see the comments on PendingSnapshot.
                            self.logger.debugf(format_args!(
                                "{:x} recovered from needing snapshot, resumed sending replication messages to {:x} [{}]",
                                self.id,
                                from,
                                self.pr(from)
                            ));
                            // Transition back to replicating state via probing state
                            // (which takes the snapshot into account). If we didn't
                            // move to replicating state, that would only happen with
                            // the next round of appends (but there may not be a next
                            // round for a while, exposing an inconsistent RaftStatus).
                            let pr = self.pr_mut(from);
                            pr.become_probe();
                            pr.become_replicate();
                        } else if pr.state == tracker::StateType::StateReplicate {
                            pr.inflights.free_le(m.get_index());
                        }

                        if self.maybe_commit() {
                            // committed index has progressed for the term, so it is safe
                            // to respond to pending read index requests
                            self.release_pending_read_index_messages();
                            self.bcast_append();
                        } else if self.id != from && self.pr(from).can_bump_commit(self.raft_log.committed) {
                            // This node may be missing the latest commit index, so send it.
                            // NB: this is not strictly necessary because the periodic heartbeat
                            // messages deliver commit indices too. However, a message sent now
                            // may arrive earlier than the next heartbeat fires.
                            self.send_append(from);
                        }
                        // We've updated flow control information above, which may
                        // allow us to send multiple (size-limited) in-flight messages
                        // at once (such as when transitioning from probe to
                        // replicate, or when freeTo() covers multiple messages). If
                        // we have more entries to send, send as many messages as we
                        // can (without sending empty messages for the commit index)
                        if self.id != from {
                            while self.maybe_send_append(from, false /* sendIfEmpty */) {}
                        }
                        // Transfer leadership is in progress.
                        if from == self.lead_transferee && self.pr(from).match_ == self.raft_log.last_index() {
                            self.logger.infof(format_args!(
                                "{:x} sent MsgTimeoutNow to {:x} after received MsgAppResp",
                                self.id, from
                            ));
                            self.send_timeout_now(from);
                        }
                    }
                }
            }
            pb::MsgHeartbeatResp => {
                let last_index = self.raft_log.last_index();
                let pr = self.pr_mut(from);
                pr.recent_active = true;
                pr.msg_app_flow_paused = false;

                // NB: if the follower is paused (full Inflights), this will still send an
                // empty append, allowing it to recover from situations in which all the
                // messages that filled up Inflights in the first place were dropped. Note
                // also that the outgoing heartbeat already communicated the commit index.
                //
                // If the follower is fully caught up but also in StateProbe (as can happen
                // if ReportUnreachable was called), we also want to send an append (it will
                // be empty) to allow the follower to transition back to StateReplicate once
                // it responds.
                //
                // Note that StateSnapshot typically satisfies pr.Match < lastIndex, but
                // `pr.Paused()` is always true for StateSnapshot, so sendAppend is a
                // no-op.
                if pr.match_ < last_index || pr.state == tracker::StateType::StateProbe {
                    self.send_append(from);
                }

                if self.read_only.option != ReadOnlyOption::ReadOnlySafe || m.get_context().is_empty() {
                    return Ok(());
                }

                self.read_only.recv_ack(from, m.get_context());
                let rss = self.read_only.maybe_advance(&self.trk.config.voters);
                for rs in rss {
                    let resp = self.response_to_read_index_req(&rs.req, rs.index);
                    if resp.get_to() != NONE {
                        self.send(resp);
                    }
                }
            }
            pb::MsgSnapStatus => {
                if self.pr(from).state != tracker::StateType::StateSnapshot {
                    return Ok(());
                }
                if !m.get_reject() {
                    self.pr_mut(from).become_probe();
                    self.logger.debugf(format_args!(
                        "{:x} snapshot succeeded, resumed sending replication messages to {:x} [{}]",
                        self.id,
                        from,
                        self.pr(from)
                    ));
                } else {
                    // NB: the order here matters or we'll be probing erroneously from
                    // the snapshot index, but the snapshot never applied.
                    let pr = self.pr_mut(from);
                    pr.pending_snapshot = 0;
                    pr.become_probe();
                    self.logger.debugf(format_args!(
                        "{:x} snapshot failed, resumed sending replication messages to {:x} [{}]",
                        self.id,
                        from,
                        self.pr(from)
                    ));
                }
                // If snapshot finish, wait for the MsgAppResp from the remote node before sending
                // out the next MsgApp.
                // If snapshot failure, wait for a heartbeat interval before next try
                self.pr_mut(from).msg_app_flow_paused = true;
            }
            pb::MsgUnreachable => {
                // During optimistic replication, if the remote becomes unreachable,
                // there is huge probability that a MsgApp is lost.
                if self.pr(from).state == tracker::StateType::StateReplicate {
                    self.pr_mut(from).become_probe();
                }
                self.logger.debugf(format_args!(
                    "{:x} failed to send message to {:x} because it is unreachable [{}]",
                    self.id,
                    from,
                    self.pr(from)
                ));
            }
            pb::MsgTransferLeader => {
                if self.pr(from).is_learner {
                    self.logger.debugf(format_args!("{:x} is learner. Ignored transferring leadership", self.id));
                    return Ok(());
                }
                let lead_transferee = from;
                let last_lead_transferee = self.lead_transferee;
                if last_lead_transferee != NONE {
                    if last_lead_transferee == lead_transferee {
                        self.logger.infof(format_args!(
                            "{:x} [term {}] transfer leadership to {:x} is in progress, ignores request to same node {:x}",
                            self.id, self.term, lead_transferee, lead_transferee
                        ));
                        return Ok(());
                    }
                    self.abort_leader_transfer();
                    self.logger.infof(format_args!(
                        "{:x} [term {}] abort previous transferring leadership to {:x}",
                        self.id, self.term, last_lead_transferee
                    ));
                }
                if lead_transferee == self.id {
                    self.logger.debugf(format_args!(
                        "{:x} is already leader. Ignored transferring leadership to self",
                        self.id
                    ));
                    return Ok(());
                }
                // Transfer leadership to third party.
                self.logger.infof(format_args!(
                    "{:x} [term {}] starts to transfer leadership to {:x}",
                    self.id, self.term, lead_transferee
                ));
                // Transfer leadership should be finished in one electionTimeout, so reset r.electionElapsed.
                self.election_elapsed = 0;
                self.lead_transferee = lead_transferee;
                if self.pr(from).match_ == self.raft_log.last_index() {
                    self.send_timeout_now(lead_transferee);
                    self.logger.infof(format_args!(
                        "{:x} sends MsgTimeoutNow to {:x} immediately as {:x} already has up-to-date log",
                        self.id, lead_transferee, lead_transferee
                    ));
                } else {
                    self.send_append(lead_transferee);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// stepCandidate is shared by StateCandidate and StatePreCandidate; the difference is
    /// whether they respond to MsgVoteResp or MsgPreVoteResp.
    fn step_candidate(&mut self, m: pb::Message) -> Result<(), Error> {
        // Only handle vote responses corresponding to our candidacy (while in
        // StateCandidate, we may get stale MsgPreVoteResp messages in this term from
        // our pre-candidate state).
        let my_vote_resp_type: pb::MessageType =
            if self.state == StateType::StatePreCandidate { pb::MsgPreVoteResp } else { pb::MsgVoteResp };
        // Go's switch has `case myVoteRespType` after the fixed cases; the
        // fixed cases are all different from the two vote response types.
        match m.get_type() {
            pb::MsgProp => {
                self.logger.infof(format_args!("{:x} no leader at term {}; dropping proposal", self.id, self.term));
                return Err(Error::ProposalDropped);
            }
            pb::MsgApp => {
                self.become_follower(m.get_term(), m.get_from()); // always m.Term == r.Term
                self.handle_append_entries(m);
            }
            pb::MsgHeartbeat => {
                self.become_follower(m.get_term(), m.get_from()); // always m.Term == r.Term
                self.handle_heartbeat(m);
            }
            pb::MsgSnap => {
                self.become_follower(m.get_term(), m.get_from()); // always m.Term == r.Term
                self.handle_snapshot(m);
            }
            t if t == my_vote_resp_type => {
                let (gr, rj, res) = self.poll(m.get_from(), m.get_type(), !m.get_reject());
                self.logger.infof(format_args!(
                    "{:x} has received {} {} votes and {} vote rejections",
                    self.id,
                    gr,
                    m.get_type(),
                    rj
                ));
                match res {
                    quorum::VoteResult::VoteWon => {
                        if self.state == StateType::StatePreCandidate {
                            self.campaign(CampaignType::Election);
                        } else {
                            self.become_leader();
                            self.bcast_append();
                        }
                    }
                    quorum::VoteResult::VoteLost => {
                        // pb.MsgPreVoteResp contains future term of pre-candidate
                        // m.Term > r.Term; reuse r.Term
                        self.become_follower(self.term, NONE);
                    }
                    quorum::VoteResult::VotePending => {}
                }
            }
            pb::MsgTimeoutNow => {
                self.logger.debugf(format_args!(
                    "{:x} [term {} state {}] ignored MsgTimeoutNow from {:x}",
                    self.id,
                    self.term,
                    self.state,
                    m.get_from()
                ));
            }
            _ => {}
        }
        Ok(())
    }

    fn step_follower(&mut self, mut m: pb::Message) -> Result<(), Error> {
        match m.get_type() {
            pb::MsgProp => {
                if self.lead == NONE {
                    self.logger.infof(format_args!("{:x} no leader at term {}; dropping proposal", self.id, self.term));
                    return Err(Error::ProposalDropped);
                } else if self.disable_proposal_forwarding {
                    self.logger.infof(format_args!(
                        "{:x} not forwarding to leader {:x} at term {}; dropping proposal",
                        self.id, self.lead, self.term
                    ));
                    return Err(Error::ProposalDropped);
                }
                m.to = Some(self.lead);
                self.send(m);
            }
            pb::MsgApp => {
                self.election_elapsed = 0;
                self.lead = m.get_from();
                self.handle_append_entries(m);
            }
            pb::MsgHeartbeat => {
                self.election_elapsed = 0;
                self.lead = m.get_from();
                self.handle_heartbeat(m);
            }
            pb::MsgSnap => {
                self.election_elapsed = 0;
                self.lead = m.get_from();
                self.handle_snapshot(m);
            }
            pb::MsgTransferLeader => {
                if self.lead == NONE {
                    self.logger.infof(format_args!(
                        "{:x} no leader at term {}; dropping leader transfer msg",
                        self.id, self.term
                    ));
                    return Ok(());
                }
                m.to = Some(self.lead);
                self.send(m);
            }
            pb::MsgForgetLeader => {
                if self.read_only.option == ReadOnlyOption::ReadOnlyLeaseBased {
                    self.logger.errorf(format_args!("ignoring MsgForgetLeader due to ReadOnlyLeaseBased"));
                    return Ok(());
                }
                if self.lead != NONE {
                    self.logger
                        .infof(format_args!("{:x} forgetting leader {:x} at term {}", self.id, self.lead, self.term));
                    self.lead = NONE;
                }
            }
            pb::MsgTimeoutNow => {
                self.logger.infof(format_args!(
                    "{:x} [term {}] received MsgTimeoutNow from {:x} and starts an election to get leadership.",
                    self.id,
                    self.term,
                    m.get_from()
                ));
                // Leadership transfers never use pre-vote even if r.preVote is true; we
                // know we are not recovering from a partition so there is no need for the
                // extra round trip.
                self.hup(CampaignType::Transfer);
            }
            pb::MsgReadIndex => {
                if self.lead == NONE {
                    self.logger.infof(format_args!(
                        "{:x} no leader at term {}; dropping index reading msg",
                        self.id, self.term
                    ));
                    return Ok(());
                }
                m.to = Some(self.lead);
                self.send(m);
            }
            pb::MsgReadIndexResp => {
                if m.get_entries().len() != 1 {
                    self.logger.errorf(format_args!(
                        "{:x} invalid format of MsgReadIndexResp from {:x}, entries count: {}",
                        self.id,
                        m.get_from(),
                        m.get_entries().len()
                    ));
                    return Ok(());
                }
                self.read_states
                    .push(ReadState { index: m.get_index(), request_ctx: m.get_entries()[0].get_data().to_vec() });
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn handle_append_entries(&mut self, mut m: pb::Message) {
        // TODO(pav-kv): construct logSlice up the stack next to receiving the
        // message, and validate it before taking any action (e.g. bumping term).
        let a = log_slice_from_msg_app(&mut m);

        if a.prev.index < self.raft_log.committed {
            self.send(pb::Message {
                to: m.from,
                r#type: Some(pb::MsgAppResp),
                index: Some(self.raft_log.committed),
                ..Default::default()
            });
            return;
        }
        if let Some(mlast_index) = self.raft_log.maybe_append(&a, m.get_commit()) {
            self.send(pb::Message {
                to: m.from,
                r#type: Some(pb::MsgAppResp),
                index: Some(mlast_index),
                ..Default::default()
            });
            return;
        }
        self.logger.debugf(format_args!(
            "{:x} [logterm: {}, index: {}] rejected MsgApp [logterm: {}, index: {}] from {:x}",
            self.id,
            self.raft_log.zero_term_on_out_of_bounds(self.raft_log.term(m.get_index())),
            m.get_index(),
            m.get_log_term(),
            m.get_index(),
            m.get_from()
        ));

        // Our log does not match the leader's at index m.Index. Return a hint to the
        // leader - a guess on the maximal (index, term) at which the logs match. Do
        // this by searching through the follower's log for the maximum (index, term)
        // pair with a term <= the MsgApp's LogTerm and an index <= the MsgApp's
        // Index. This can help skip all indexes in the follower's uncommitted tail
        // with terms greater than the MsgApp's LogTerm.
        //
        // See the other caller for findConflictByTerm (in stepLeader) for a much more
        // detailed explanation of this mechanism.

        // NB: m.Index >= raftLog.committed by now (see the early return above), and
        // raftLog.lastIndex() >= raftLog.committed by invariant, so min of the two is
        // also >= raftLog.committed. Hence, the findConflictByTerm argument is within
        // the valid interval, which then will return a valid (index, term) pair with
        // a non-zero term (unless the log is empty). However, it is safe to send a zero
        // LogTerm in this response in any case, so we don't verify it here.
        let hint_index = min(m.get_index(), self.raft_log.last_index());
        let (hint_index, hint_term) = self.raft_log.find_conflict_by_term(hint_index, m.get_log_term());
        self.send(pb::Message {
            to: m.from,
            r#type: Some(pb::MsgAppResp),
            index: Some(m.get_index()),
            reject: Some(true),
            reject_hint: Some(hint_index),
            log_term: Some(hint_term),
            ..Default::default()
        });
    }

    pub(crate) fn handle_heartbeat(&mut self, m: pb::Message) {
        self.raft_log.commit_to(m.get_commit());
        self.send(pb::Message {
            to: m.from,
            r#type: Some(pb::MsgHeartbeatResp),
            context: m.context,
            ..Default::default()
        });
    }

    pub(crate) fn handle_snapshot(&mut self, mut m: pb::Message) {
        // MsgSnap messages should always carry a non-nil Snapshot, but err on the
        // side of safety and treat a nil Snapshot as a zero-valued Snapshot.
        let mut s = m.snapshot.take();
        pb::ensure_snapshot(&mut s);
        let s = s.unwrap_or_default();
        let (sindex, sterm) = (s.get_metadata_index(), s.get_metadata_term());
        if self.restore(s) {
            self.logger.infof(format_args!(
                "{:x} [commit: {}] restored snapshot [index: {}, term: {}]",
                self.id, self.raft_log.committed, sindex, sterm
            ));
            self.send(pb::Message {
                to: m.from,
                r#type: Some(pb::MsgAppResp),
                index: Some(self.raft_log.last_index()),
                ..Default::default()
            });
        } else {
            self.logger.infof(format_args!(
                "{:x} [commit: {}] ignored snapshot [index: {}, term: {}]",
                self.id, self.raft_log.committed, sindex, sterm
            ));
            self.send(pb::Message {
                to: m.from,
                r#type: Some(pb::MsgAppResp),
                index: Some(self.raft_log.committed),
                ..Default::default()
            });
        }
    }

    /// restore recovers the state machine from a snapshot. It restores the log and the
    /// configuration of state machine. If this method returns false, the snapshot was
    /// ignored, either because it was obsolete or because of an error.
    pub(crate) fn restore(&mut self, mut s: pb::Snapshot) -> bool {
        if s.get_metadata_index() <= self.raft_log.committed {
            return false;
        }
        if self.state != StateType::StateFollower {
            // This is defense-in-depth: if the leader somehow ended up applying a
            // snapshot, it could move into a new term without moving into a
            // follower state. This should never fire, but if it did, we'd have
            // prevented damage by returning early, so log only a loud warning.
            //
            // At the time of writing, the instance is guaranteed to be in follower
            // state when this method is called.
            self.logger
                .warningf(format_args!("{:x} attempted to restore snapshot as leader; should never happen", self.id));
            self.become_follower(self.term + 1, NONE);
            return false;
        }

        // More defense-in-depth: throw away snapshot if recipient is not in the
        // config. This shouldn't ever happen (at the time of writing) but lots of
        // code here and there assumes that r.id is in the progress tracker.
        let mut found = false;
        let cs = pb::ensure_conf_state(&mut pb::ensure_snapshot_metadata(&mut s.metadata).conf_state).clone();

        for set in [
            &cs.voters,
            &cs.learners,
            &cs.voters_outgoing,
            // `LearnersNext` doesn't need to be checked. According to the rules, if a peer in
            // `LearnersNext`, it has to be in `VotersOutgoing`.
        ] {
            for id in set {
                if *id == self.id {
                    found = true;
                    break;
                }
            }
            if found {
                break;
            }
        }
        if !found {
            self.logger.warningf(format_args!(
                "{:x} attempted to restore snapshot but it is not in the ConfState {}; should never happen",
                self.id,
                ConfStateText(&cs)
            ));
            return false;
        }

        // Now go ahead and actually restore.

        let id = EntryID { term: s.get_metadata_term(), index: s.get_metadata_index() };
        if self.raft_log.match_term(id) {
            // TODO(pav-kv): can print %+v of the id, but it will change the format.
            let last = self.raft_log.last_entry_id();
            self.logger.infof(format_args!(
                "{:x} [commit: {}, lastindex: {}, lastterm: {}] fast-forwarded commit to snapshot [index: {}, term: {}]",
                self.id, self.raft_log.committed, last.index, last.term, id.index, id.term
            ));
            self.raft_log.commit_to(s.get_metadata_index());
            return false;
        }

        self.raft_log.restore(&s);

        // Reset the configuration and add the (potentially updated) peers in anew.
        self.trk = tracker::ProgressTracker::make(self.trk.max_inflight, self.trk.max_inflight_bytes);
        let (cfg, trk) = match confchange::restore(
            confchange::Changer { tracker: self.trk.clone(), last_index: self.raft_log.last_index() },
            &cs,
        ) {
            Ok(v) => v,
            Err(err) => {
                // This should never happen. Either there's a bug in our config change
                // handling or the client corrupted the conf change.
                panic!("unable to restore config {}: {}", ConfStateText(&cs), err);
            }
        };

        let cs2 = self.switch_to_config(cfg, trk);
        assert_conf_states_equivalent(&self.logger, &cs, &cs2);

        let last = self.raft_log.last_entry_id();
        self.logger.infof(format_args!(
            "{:x} [commit: {}, lastindex: {}, lastterm: {}] restored snapshot [index: {}, term: {}]",
            self.id, self.raft_log.committed, last.index, last.term, id.index, id.term
        ));
        true
    }

    /// promotable indicates whether state machine can be promoted to leader,
    /// which is true when its own id is in progress list.
    pub(crate) fn promotable(&self) -> bool {
        match self.trk.progress.get(&self.id) {
            Some(pr) => !pr.is_learner && !self.raft_log.has_next_or_in_progress_snapshot(),
            None => false,
        }
    }

    pub(crate) fn apply_conf_change(&mut self, cc: &pb::ConfChangeV2) -> pb::ConfState {
        let res = {
            let changer = confchange::Changer { tracker: self.trk.clone(), last_index: self.raft_log.last_index() };
            if cc.leave_joint() {
                changer.leave_joint()
            } else if let (auto_leave, true) = cc.enter_joint() {
                changer.enter_joint(auto_leave, &cc.changes)
            } else {
                changer.simple(&cc.changes)
            }
        };

        let (cfg, trk) = match res {
            Ok(v) => v,
            Err(err) => {
                // TODO(tbg): return the error to the caller.
                panic!("{err}");
            }
        };

        self.switch_to_config(cfg, trk)
    }

    /// switchToConfig reconfigures this node to use the provided configuration. It
    /// updates the in-memory state and, when necessary, carries out additional
    /// actions such as reacting to the removal of nodes or changed quorum
    /// requirements.
    ///
    /// The inputs usually result from restoring a ConfState or applying a ConfChange.
    pub(crate) fn switch_to_config(&mut self, cfg: tracker::Config, trk: tracker::ProgressMap) -> pb::ConfState {
        self.trk.config = cfg;
        self.trk.progress = trk;

        self.logger.infof(format_args!("{:x} switched to configuration {}", self.id, self.trk.config));
        let cs = self.trk.conf_state();
        let (ok, pr_is_learner) = match self.trk.progress.get(&self.id) {
            Some(pr) => (true, pr.is_learner),
            None => (false, false),
        };

        // Update whether the node itself is a learner, resetting to false when the
        // node is removed.
        self.is_learner = ok && pr_is_learner;

        if (!ok || self.is_learner) && self.state == StateType::StateLeader {
            // This node is leader and was removed or demoted, step down if requested.
            //
            // We prevent demotions at the time writing but hypothetically we handle
            // them the same way as removing the leader.
            //
            // TODO(tbg): ask follower with largest Match to TimeoutNow (to avoid
            // interruption). This might still drop some proposals but it's better than
            // nothing.
            if self.step_down_on_removal {
                self.become_follower(self.term, NONE);
            }
            return cs;
        }

        // The remaining steps only make sense if this node is the leader and there
        // are other nodes.
        if self.state != StateType::StateLeader || cs.voters.is_empty() {
            return cs;
        }

        if self.maybe_commit() {
            // If the configuration change means that more entries are committed now,
            // broadcast/append to everyone in the updated config.
            self.bcast_append();
        } else {
            // Otherwise, still probe the newly added replicas; there's no reason to
            // let them wait out a heartbeat interval (or the next incoming
            // proposal).
            for id in self.visit_ids() {
                if id == self.id {
                    continue;
                }
                self.maybe_send_append(id, false /* sendIfEmpty */);
            }
        }
        // If the leadTransferee was removed or demoted, abort the leadership transfer.
        let t_ok = self.trk.config.voters.ids().contains(&self.lead_transferee);
        if !t_ok && self.lead_transferee != 0 {
            self.abort_leader_transfer();
        }

        cs
    }

    pub(crate) fn load_state(&mut self, state: &pb::HardState) {
        if state.get_commit() < self.raft_log.committed || state.get_commit() > self.raft_log.last_index() {
            self.logger.panicf(format_args!(
                "{:x} state.commit {} is out of range [{}, {}]",
                self.id,
                state.get_commit(),
                self.raft_log.committed,
                self.raft_log.last_index()
            ));
        }
        self.raft_log.committed = state.get_commit();
        self.term = state.get_term();
        self.vote = state.get_vote();
    }

    /// pastElectionTimeout returns true if r.electionElapsed is greater
    /// than or equal to the randomized election timeout in
    /// [electiontimeout, 2 * electiontimeout - 1].
    pub(crate) fn past_election_timeout(&self) -> bool {
        self.election_elapsed >= self.randomized_election_timeout
    }

    pub(crate) fn reset_randomized_election_timeout(&mut self) {
        self.randomized_election_timeout = self.election_timeout + self.rand.intn(self.election_timeout);
    }

    pub(crate) fn send_timeout_now(&mut self, to: u64) {
        self.send(pb::Message { to: Some(to), r#type: Some(pb::MsgTimeoutNow), ..Default::default() });
    }

    pub(crate) fn abort_leader_transfer(&mut self) {
        self.lead_transferee = NONE;
    }

    /// committedEntryInCurrentTerm return true if the peer has committed an entry in its term.
    pub(crate) fn committed_entry_in_current_term(&self) -> bool {
        // NB: r.Term is never 0 on a leader, so if zeroTermOnOutOfBounds returns 0,
        // we won't see it as a match with r.Term.
        self.raft_log.zero_term_on_out_of_bounds(self.raft_log.term(self.raft_log.committed)) == self.term
    }

    /// responseToReadIndexReq constructs a response for `req`. If `req` comes from the peer
    /// itself, a blank value will be returned.
    pub(crate) fn response_to_read_index_req(&mut self, req: &pb::Message, read_index: u64) -> pb::Message {
        if req.get_from() == NONE || req.get_from() == self.id {
            self.read_states
                .push(ReadState { index: read_index, request_ctx: req.get_entries()[0].get_data().to_vec() });
            return pb::Message::default();
        }
        pb::Message {
            r#type: Some(pb::MsgReadIndexResp),
            to: req.from,
            index: Some(read_index),
            entries: req.get_entries().to_vec(),
            ..Default::default()
        }
    }

    /// increaseUncommittedSize computes the size of the proposed entries and
    /// determines whether they would push leader over its maxUncommittedSize limit.
    /// If the new entries would exceed the limit, the method returns false. If not,
    /// the increase in uncommitted entry size is recorded and the method returns
    /// true.
    ///
    /// Empty payloads are never refused. This is used both for appending an empty
    /// entry at a new leader's term, as well as leaving a joint configuration.
    pub(crate) fn increase_uncommitted_size(&mut self, ents: &[pb::Entry]) -> bool {
        let s = payloads_size(ents);
        // Go's sum wraps at the top of uint64. So does this one.
        if self.uncommitted_size > 0 && s > 0 && self.uncommitted_size.wrapping_add(s) > self.max_uncommitted_size {
            // If the uncommitted tail of the Raft log is empty, allow any size
            // proposal. Otherwise, limit the size of the uncommitted tail of the
            // log and drop any proposal that would push the size over the limit.
            // Note the added requirement s>0 which is used to make sure that
            // appending single empty entries to the log always succeeds, used both
            // for replicating a new leader's initial empty entry, and for
            // auto-leaving joint configurations.
            return false;
        }
        self.uncommitted_size = self.uncommitted_size.wrapping_add(s);
        true
    }

    /// reduceUncommittedSize accounts for the newly committed entries by decreasing
    /// the uncommitted entry size limit.
    pub(crate) fn reduce_uncommitted_size(&mut self, s: EntryPayloadSize) {
        if s > self.uncommitted_size {
            // uncommittedSize may underestimate the size of the uncommitted Raft
            // log tail but will never overestimate it. Saturate at 0 instead of
            // allowing overflow.
            self.uncommitted_size = 0;
        } else {
            self.uncommitted_size -= s;
        }
    }

    pub(crate) fn release_pending_read_index_messages(&mut self) {
        if self.pending_read_index_messages.is_empty() {
            // Fast path for the common case to avoid a call to storage.LastIndex()
            // via committedEntryInCurrentTerm.
            return;
        }

        if !self.committed_entry_in_current_term() {
            self.logger.errorf(format_args!(
                "pending MsgReadIndex should be released only after first commit in current term"
            ));
            return;
        }

        let msgs = core::mem::take(&mut self.pending_read_index_messages);

        for m in msgs {
            self.send_msg_read_index_response(m);
        }
    }

    pub(crate) fn send_msg_read_index_response(&mut self, m: pb::Message) {
        // thinking: use an internally defined context instead of the user given context.
        // We can express this in terms of the term and index instead of a user-supplied value.
        // This would allow multiple reads to piggyback on the same message.
        // If more than the local vote is needed, go through a full broadcast.
        if self.trk.is_voter(self.id) && self.trk.is_singleton() {
            let resp = self.response_to_read_index_req(&m, self.raft_log.committed);
            if resp.get_to() != NONE {
                self.send(resp);
            }
            return;
        }
        match self.read_only.option {
            ReadOnlyOption::ReadOnlySafe => {
                self.read_only.add_request(self.raft_log.committed, m);
                // The local node automatically acks the request.
                let ctx = self.read_only.heartbeat_ctx();
                self.read_only.recv_ack(self.id, ctx.as_deref().unwrap_or(&[]));
                self.bcast_heartbeat();
            }
            ReadOnlyOption::ReadOnlyLeaseBased => {
                let resp = self.response_to_read_index_req(&m, self.raft_log.committed);
                if resp.get_to() != NONE {
                    self.send(resp);
                }
            }
        }
    }
}

/// Go's `logSliceFromMsgApp`. Go shares the entries with the message; here
/// they move out of it (the message is not read for its entries afterwards).
pub(crate) fn log_slice_from_msg_app(m: &mut pb::Message) -> LogSlice {
    // TODO(pav-kv): consider also validating the logSlice here.
    LogSlice {
        term: m.get_term(),
        prev: EntryID { term: m.get_log_term(), index: m.get_index() },
        entries: core::mem::take(&mut m.entries),
    }
}
