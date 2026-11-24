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

//! Port of `raftpb/confchange.go`.

use super::alias::*;
use super::raft::{ConfChange, ConfChangeSingle, ConfChangeV2, EntryType};
use crate::gostd::{parse_uint, Error};
use crate::num::len64;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::fmt::Write;

/// ConfChangeI abstracts over ConfChangeV2 and (legacy) ConfChange to allow
/// treating them in a unified manner.
pub trait ConfChangeI {
    /// AsV2 should always return a non-nil object
    fn as_v2(&self) -> ConfChangeV2;
    /// AsV1 returns the ConfChange if this is one. Go returns `(cc, ok)`.
    fn as_v1(&self) -> Option<&ConfChange>;
}

/// MarshalConfChange calls Marshal on the underlying ConfChange or ConfChangeV2
/// and returns the result along with the corresponding EntryType.
///
/// Go also returns an error; encoding cannot fail here. A nil `c` gives nil
/// data, which is `None`.
#[must_use]
pub fn marshal_conf_change(c: Option<&dyn ConfChangeI>) -> (EntryType, Option<Vec<u8>>) {
    let typ: EntryType;
    let ccdata: Option<Vec<u8>>;
    match c {
        None => {
            // A nil data unmarshals into an empty ConfChangeV2 and has the benefit
            // that appendEntry can never refuse it based on its size (which
            // registers as zero).
            typ = EntryConfChangeV2;
            ccdata = None;
        }
        Some(c) => {
            if let Some(ccv1) = c.as_v1() {
                typ = EntryConfChange;
                ccdata = Some(ccv1.marshal());
            } else {
                let ccv2 = c.as_v2();
                typ = EntryConfChangeV2;
                ccdata = Some(ccv2.marshal());
            }
        }
    }
    (typ, ccdata)
}

impl ConfChangeI for ConfChange {
    /// AsV2 returns a V2 configuration change carrying out the same operation.
    fn as_v2(&self) -> ConfChangeV2 {
        ConfChangeV2 {
            transition: None,
            changes: vec![ConfChangeSingle { r#type: Some(self.get_type()), node_id: Some(self.get_node_id()) }],
            context: self.context.clone(),
        }
    }

    /// AsV1 returns the ConfChange and true.
    fn as_v1(&self) -> Option<&ConfChange> {
        Some(self)
    }
}

impl ConfChangeI for ConfChangeV2 {
    /// AsV2 is the identity.
    fn as_v2(&self) -> ConfChangeV2 {
        self.clone()
    }

    /// AsV1 returns nil and false.
    fn as_v1(&self) -> Option<&ConfChange> {
        None
    }
}

impl ConfChangeV2 {
    /// EnterJoint returns two bools. The second bool is true if and only if this
    /// config change will use Joint Consensus, which is the case if it contains more
    /// than one change or if the use of Joint Consensus was requested explicitly.
    /// The first bool can only be true if second one is, and indicates whether the
    /// Joint State will be left automatically.
    #[must_use]
    pub fn enter_joint(&self) -> (bool, bool) {
        // NB: in theory, more config changes could qualify for the "simple"
        // protocol but it depends on the config on top of which the changes apply.
        // For example, adding two learners is not OK if both nodes are part of the
        // base config (i.e. two voters are turned into learners in the process of
        // applying the conf change). In practice, these distinctions should not
        // matter, so we keep it simple and use Joint Consensus liberally.
        if self.get_transition() != ConfChangeTransitionAuto || len64(&self.changes) > 1 {
            // Use Joint Consensus.
            let auto_leave: bool = match self.get_transition() {
                ConfChangeTransitionAuto => true,
                ConfChangeTransitionJointImplicit => true,
                ConfChangeTransitionJointExplicit => false,
                _ => panic!("unknown transition: {self:?}"),
            };
            return (auto_leave, true);
        }
        (false, false)
    }

    /// LeaveJoint is true if the configuration change leaves a joint configuration.
    /// This is the case if the ConfChangeV2 is zero, with the possible exception of
    /// the Context field.
    #[must_use]
    pub fn leave_joint(&self) -> bool {
        self.get_transition() == ConfChangeTransitionAuto && self.get_changes().is_empty()
    }
}

/// ConfChangesFromString parses a Space-delimited sequence of operations into a
/// slice of ConfChangeSingle. The supported operations are:
/// - vn: make n a voter,
/// - ln: make n a learner,
/// - rn: remove n, and
/// - un: update n.
pub fn conf_changes_from_string(s: &str) -> Result<Vec<ConfChangeSingle>, Error> {
    let mut ccs: Vec<ConfChangeSingle> = Vec::new();
    let mut toks: Vec<&str> = go_trim_space(s).split(' ').collect();
    if toks[0].is_empty() {
        toks = Vec::new();
    }
    for tok in toks {
        if tok.len() < 2 {
            return Err(Error::errorf(format_args!("unknown token {tok}")));
        }
        let mut cc = ConfChangeSingle::default();
        match tok.as_bytes()[0] {
            b'v' => cc.r#type = Some(ConfChangeAddNode),
            b'l' => cc.r#type = Some(ConfChangeAddLearnerNode),
            b'r' => cc.r#type = Some(ConfChangeRemoveNode),
            b'u' => cc.r#type = Some(ConfChangeUpdateNode),
            _ => return Err(Error::errorf(format_args!("unknown input: {tok}"))),
        }
        // The first byte is ASCII here, so the cut is on a character boundary.
        let id = parse_uint(&tok[1..])?;
        cc.node_id = Some(id);
        ccs.push(cc);
    }
    Ok(ccs)
}

/// ConfChangesToString is the inverse to ConfChangesFromString.
#[must_use]
pub fn conf_changes_to_string(ccs: &[ConfChangeSingle]) -> String {
    let mut buf = String::new();
    for (i, cc) in ccs.iter().enumerate() {
        if i > 0 {
            buf.push(' ');
        }
        match cc.get_type() {
            ConfChangeAddNode => buf.push('v'),
            ConfChangeAddLearnerNode => buf.push('l'),
            ConfChangeRemoveNode => buf.push('r'),
            ConfChangeUpdateNode => buf.push('u'),
            _ => buf.push_str("unknown"),
        }
        let _ = write!(buf, "{}", cc.get_node_id());
    }
    buf
}

/// Go's `strings.TrimSpace`.
fn go_trim_space(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{85}')
}
