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

//! Port of `util.go`.
//!
//! Left out: `StateType.MarshalJSON` (no JSON here). `isMsgInArray` and its
//! two tables are a `matches!` in `is_local_msg` and `is_response_msg`.

use crate::gostd::Quote;
use crate::logger::LoggerRef;
use crate::node::{is_empty_hard_state, is_empty_snap, Ready, SoftState};
use crate::num::len64;
use crate::raft::{LocalAppendThread, LocalApplyThread, NONE};
use crate::raftpb as pb;
use crate::raftpb::ConfChangeI;
use crate::read_only::ReadState;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::fmt;
use core::fmt::Write;

// Go keeps two bool arrays indexed by message type (isLocalMsg,
// isResponseMsg) and a bounds-checked lookup. A `matches!` over the same
// types says the same, and a type outside the list (or out of range) is
// "not in the array" in both.

#[must_use]
pub fn is_local_msg(msgt: pb::MessageType) -> bool {
    matches!(
        msgt,
        pb::MsgHup
            | pb::MsgBeat
            | pb::MsgUnreachable
            | pb::MsgSnapStatus
            | pb::MsgCheckQuorum
            | pb::MsgStorageAppend
            | pb::MsgStorageAppendResp
            | pb::MsgStorageApply
            | pb::MsgStorageApplyResp
    )
}

#[must_use]
pub fn is_response_msg(msgt: pb::MessageType) -> bool {
    matches!(
        msgt,
        pb::MsgAppResp
            | pb::MsgVoteResp
            | pb::MsgHeartbeatResp
            | pb::MsgUnreachable
            | pb::MsgReadIndexResp
            | pb::MsgPreVoteResp
            | pb::MsgStorageAppendResp
            | pb::MsgStorageApplyResp
    )
}

#[must_use]
pub fn is_local_msg_target(id: u64) -> bool {
    id == LocalAppendThread || id == LocalApplyThread
}

/// voteResponseType maps vote and prevote message types to their corresponding responses.
pub(crate) fn vote_resp_msg_type(msgt: pb::MessageType) -> pb::MessageType {
    match msgt {
        pb::MsgVote => pb::MsgVoteResp,
        pb::MsgPreVote => pb::MsgPreVoteResp,
        _ => panic!("not a vote message: {msgt}"),
    }
}

#[must_use]
pub fn describe_hard_state(hs: &pb::HardState) -> String {
    let mut buf = String::new();
    let _ = write!(buf, "Term:{}", hs.get_term());
    if hs.get_vote() != 0 {
        let _ = write!(buf, " Vote:{}", hs.get_vote());
    }
    let _ = write!(buf, " Commit:{}", hs.get_commit());
    buf
}

/// Go's `%v` of a `[]uint64`: `[1 2 3]`.
struct U64s<'a>(&'a [u64]);

impl fmt::Display for U64s<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[")?;
        for (i, v) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{v}")?;
        }
        f.write_str("]")
    }
}

/// Go takes a pointer and reads a nil one as an empty ConfState; pass
/// `None` for that.
#[must_use]
pub fn describe_conf_state(state: Option<&pb::ConfState>) -> String {
    let empty = pb::ConfState::default();
    let state = state.unwrap_or(&empty);
    format!(
        "Voters:{} VotersOutgoing:{} Learners:{} LearnersNext:{} AutoLeave:{}",
        U64s(&state.voters),
        U64s(&state.voters_outgoing),
        U64s(&state.learners),
        U64s(&state.learners_next),
        state.get_auto_leave(),
    )
}

#[must_use]
pub fn describe_soft_state(ss: &SoftState) -> String {
    format!("Lead:{} State:{}", ss.lead, ss.raft_state)
}

#[must_use]
pub fn describe_snapshot(snap: &pb::Snapshot) -> String {
    let m = snap.get_metadata();
    format!(
        "Index:{} Term:{} ConfState:{}",
        snap.get_metadata_index(),
        snap.get_metadata_term(),
        describe_conf_state(m.and_then(|m| m.get_conf_state()))
    )
}

/// Go's `%v` of a `[]ReadState`: `[{7 [104 105]}]`.
struct ReadStates<'a>(&'a [ReadState]);

impl fmt::Display for ReadStates<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[")?;
        for (i, rs) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{{{} [", rs.index)?;
            for (j, b) in rs.request_ctx.iter().enumerate() {
                if j > 0 {
                    f.write_str(" ")?;
                }
                write!(f, "{b}")?;
            }
            f.write_str("]}")?;
        }
        f.write_str("]")
    }
}

#[must_use]
pub fn describe_ready(rd: &Ready, f: EntryFormatter<'_>) -> String {
    let mut buf = String::new();
    if let Some(ss) = &rd.soft_state {
        buf.push_str(&describe_soft_state(ss));
        buf.push('\n');
    }
    if !is_empty_hard_state(rd.hard_state.as_ref()) {
        if let Some(hs) = &rd.hard_state {
            let _ = write!(buf, "HardState {}", describe_hard_state(hs));
            buf.push('\n');
        }
    }
    if !rd.read_states.is_empty() {
        let _ = writeln!(buf, "ReadStates {}", ReadStates(&rd.read_states));
    }
    if !rd.entries.is_empty() {
        buf.push_str("Entries:\n");
        buf.push_str(&describe_entries(&rd.entries, f));
    }
    if !is_empty_snap(rd.snapshot.as_ref()) {
        if let Some(snap) = &rd.snapshot {
            let _ = writeln!(buf, "Snapshot {}", describe_snapshot(snap));
        }
    }
    if !rd.committed_entries.is_empty() {
        buf.push_str("CommittedEntries:\n");
        buf.push_str(&describe_entries(&rd.committed_entries, f));
    }
    if !rd.messages.is_empty() {
        buf.push_str("Messages:\n");
        for msg in &rd.messages {
            buf.push_str(&describe_message(msg, f));
            buf.push('\n');
        }
    }
    if !buf.is_empty() {
        return format!("Ready MustSync={}:\n{}", rd.must_sync, buf);
    }
    String::from("<empty Ready>")
}

/// EntryFormatter can be implemented by the application to provide human-readable formatting
/// of entry data. Nil is a valid EntryFormatter and will use a default format.
pub type EntryFormatter<'a> = Option<&'a dyn Fn(&[u8]) -> String>;

/// DescribeMessage returns a concise human-readable description of a
/// Message for debugging.
#[must_use]
pub fn describe_message(m: &pb::Message, f: EntryFormatter<'_>) -> String {
    describe_message_with_indent("", m, f)
}

fn describe_message_with_indent(indent: &str, m: &pb::Message, f: EntryFormatter<'_>) -> String {
    let mut buf = String::new();
    let _ = write!(
        buf,
        "{}{}->{} {} Term:{} Log:{}/{}",
        indent,
        describe_target(m.get_from()),
        describe_target(m.get_to()),
        m.get_type(),
        m.get_term(),
        m.get_log_term(),
        m.get_index()
    );
    if m.get_reject() {
        let _ = write!(buf, " Rejected (Hint: {})", m.get_reject_hint());
    }
    if m.get_commit() != 0 {
        let _ = write!(buf, " Commit:{}", m.get_commit());
    }
    if m.get_vote() != 0 {
        let _ = write!(buf, " Vote:{}", m.get_vote());
    }
    let ents = m.get_entries();
    if ents.len() == 1 {
        let _ = write!(buf, " Entries:[{}]", describe_entry(&ents[0], f));
    } else if ents.len() > 1 {
        buf.push_str(" Entries:[");
        for e in ents {
            let _ = write!(buf, "\n{indent}  ");
            buf.push_str(&describe_entry(e, f));
        }
        let _ = write!(buf, "\n{indent}]");
    }
    if let Some(s) = m.get_snapshot() {
        if !is_empty_snap(Some(s)) {
            let _ = write!(buf, "\n{}  Snapshot: {}", indent, describe_snapshot(s));
        }
    }
    if !m.get_responses().is_empty() {
        buf.push_str(" Responses:[");
        let inner = format!("{indent}  ");
        for r in m.get_responses() {
            buf.push('\n');
            buf.push_str(&describe_message_with_indent(&inner, r, f));
        }
        let _ = write!(buf, "\n{indent}]");
    }
    buf
}

fn describe_target(id: u64) -> String {
    match id {
        NONE => "None".to_string(),
        LocalAppendThread => "AppendThread".to_string(),
        LocalApplyThread => "ApplyThread".to_string(),
        _ => format!("{id:x}"),
    }
}

/// DescribeEntry returns a concise human-readable description of an
/// Entry for debugging.
#[must_use]
pub fn describe_entry(e: &pb::Entry, f: EntryFormatter<'_>) -> String {
    let default = |data: &[u8]| -> String { Quote(data).to_string() };
    let f: &dyn Fn(&[u8]) -> String = match f {
        Some(f) => f,
        None => &default,
    };

    let format_conf_change = |cc: &dyn ConfChangeI| -> String {
        // TODO(tbg): give the EntryFormatter a type argument so that it gets
        // a chance to expose the Context.
        pb::conf_changes_to_string(&cc.as_v2().changes)
    };

    let mut formatted = String::new();
    match e.get_type() {
        pb::EntryNormal => formatted = f(e.get_data()),
        pb::EntryConfChange => match pb::ConfChange::unmarshal(e.get_data()) {
            Err(err) => formatted = err,
            Ok(cc) => formatted = format_conf_change(&cc),
        },
        pb::EntryConfChangeV2 => match pb::ConfChangeV2::unmarshal(e.get_data()) {
            Err(err) => formatted = err,
            Ok(cc) => formatted = format_conf_change(&cc),
        },
        _ => {}
    }
    if !formatted.is_empty() {
        formatted.insert(0, ' ');
    }
    format!("{}/{} {}{}", e.get_term(), e.get_index(), e.get_type(), formatted)
}

/// DescribeConfChange returns a deterministic, human-readable representation of
/// a ConfChangeI. It avoids using the proto text format (which adds random extra
/// spaces via detrand, producing unstable output across architectures/builds).
#[must_use]
pub fn describe_conf_change(cc: &dyn ConfChangeI) -> String {
    let cv2 = cc.as_v2();
    let mut b = String::new();
    let _ = write!(b, "transition:{}", cv2.get_transition());
    for c in cv2.get_changes() {
        let _ = write!(b, " changes:{{type:{} node_id:{}}}", c.get_type(), c.get_node_id());
    }
    if !cv2.get_context().is_empty() {
        let _ = write!(b, " context:{}", Quote(cv2.get_context()));
    }
    b
}

/// DescribeEntries calls DescribeEntry for each Entry, adding a newline to
/// each.
#[must_use]
pub fn describe_entries(ents: &[pb::Entry], f: EntryFormatter<'_>) -> String {
    let mut buf = String::new();
    for e in ents {
        buf.push_str(&describe_entry(e, f));
        buf.push('\n');
    }
    buf
}

/// entryEncodingSize represents the protocol buffer encoding size of one or more
/// entries.
pub(crate) type EntryEncodingSize = u64;

pub(crate) fn ents_size(ents: &[pb::Entry]) -> EntryEncodingSize {
    let mut size: EntryEncodingSize = 0;
    for ent in ents {
        size += ent.size();
    }
    size
}

/// limitSize returns the longest prefix of the given entries slice, such that
/// its total byte size does not exceed maxSize. Always returns a non-empty slice
/// if the input is non-empty, so, as an exception, if the size of the first
/// entry exceeds maxSize, a non-empty slice with just this entry is returned.
pub(crate) fn limit_size(ents: &[pb::Entry], max_size: EntryEncodingSize) -> &[pb::Entry] {
    if ents.is_empty() {
        return ents;
    }
    let mut size: EntryEncodingSize = ents[0].size();
    for limit in 1..ents.len() {
        size += ents[limit].size();
        if size > max_size {
            return &ents[..limit];
        }
    }
    ents
}

/// entryPayloadSize represents the size of one or more entries' payloads.
/// Notably, it does not depend on its Index or Term. Entries with empty
/// payloads, like those proposed after a leadership change, are considered
/// to be zero size.
pub(crate) type EntryPayloadSize = u64;

/// payloadSize is the size of the payload of the provided entry.
pub(crate) fn payload_size(e: &pb::Entry) -> EntryPayloadSize {
    len64(e.get_data())
}

/// payloadsSize is the size of the payloads of the provided entries.
pub(crate) fn payloads_size(ents: &[pb::Entry]) -> EntryPayloadSize {
    let mut s: EntryPayloadSize = 0;
    for e in ents {
        s += payload_size(e);
    }
    s
}

pub(crate) fn assert_conf_states_equivalent(l: &LoggerRef, cs1: &pb::ConfState, cs2: &pb::ConfState) {
    match cs1.equivalent(cs2) {
        Ok(()) => {}
        Err(err) => l.panicf(format_args!("{err}")),
    }
}

/// Stands in for Go's `%v` of a `*pb.ConfState`, which is protobuf's text
/// form (`voters:1 voters:2 auto_leave:false`). Go's protobuf library adds
/// spaces at random to that form so that nobody depends on it; this prints
/// it with single spaces. It is used in two "should never happen" lines only.
pub(crate) struct ConfStateText<'a>(pub(crate) &'a pb::ConfState);

impl fmt::Display for ConfStateText<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut sep = "";
        let lists: [(&str, &[u64]); 4] = [
            ("voters", &self.0.voters),
            ("learners", &self.0.learners),
            ("voters_outgoing", &self.0.voters_outgoing),
            ("learners_next", &self.0.learners_next),
        ];
        for (name, ids) in lists {
            for id in ids {
                write!(f, "{sep}{name}:{id}")?;
                sep = " ";
            }
        }
        if let Some(al) = self.0.auto_leave {
            write!(f, "{sep}auto_leave:{al}")?;
        }
        Ok(())
    }
}

/// extend appends vals to the given dst slice. It differs from the standard
/// slice append only in the way it allocates memory. If cap(dst) is not enough
/// for appending the values, precisely size len(dst)+len(vals) is allocated.
///
/// Use this instead of standard append in situations when this is the last
/// append to dst, so there is no sense in allocating more than needed.
pub(crate) fn extend(mut dst: Vec<pb::Entry>, vals: &[pb::Entry]) -> Vec<pb::Entry> {
    dst.reserve_exact(vals.len());
    dst.extend_from_slice(vals);
    dst
}
