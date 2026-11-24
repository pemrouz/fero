// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_raftstate.go`.

use super::interaction_env::InteractionEnv;
use super::HResult;

/// isVoter checks whether node id is in the voter list within st.
fn is_voter(id: u64, st: &raft::Status) -> bool {
    let id_map = st.config.voters.ids();
    for idx in &id_map {
        if id == *idx {
            return true;
        }
    }
    false
}

impl InteractionEnv {
    /// handleRaftState pretty-prints the raft state for all nodes to the output buffer.
    /// For each node, the information is based on its own configuration view.
    pub(crate) fn handle_raft_state(&mut self) -> HResult {
        for n in &self.nodes {
            let st = n.raw_node.status();
            let voter_status = if is_voter(st.basic.id, &st) { "(Voter)" } else { "(Non-Voter)" };
            self.output.write_string(&format!(
                "{}: {} {} Term:{} Lead:{}\n",
                st.basic.id,
                st.basic.soft_state.raft_state,
                voter_status,
                st.basic.hard_state.get_term(),
                st.basic.soft_state.lead
            ));
        }
        Ok(())
    }
}
