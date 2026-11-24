# Hand classes of the 155 surviving mutants that are not swaps

Each surviving mutant was read by hand (reasoned). `S` marks the 45 drawn as the seeded sample
(`node mutate.mjs sample 45 10`). The sample was read first and with more care; the other 110 were
read after it, faster. The classes are the ones the TypeScript experiment used:

- **E, equivalent:** the change cannot alter behaviour in any state the code can reach.
- **U, unexercised feature:** the change matters only under a setting or a call the oracle never
  uses (the uncommitted-size limit, byte limits, `CreateSnapshot`, `ReportSnapshot`, `WithProgress`,
  a heartbeat tick above 1, config checks).
- **G, gap:** a real change in a feature the oracle does use, which it does not notice.

Only E against not-E moves the score. The split between U and G is rougher.

Tally (counted): all 155: E 54, U 59, G 42. The sample of 45: E 17, U 18, G 10.

| # | S | Mutant | Line before | Class | Why |
|---|---|---|---|---|---|
| 1 |  | confchange/confchange.rs:118:9 drop | `cfg.learners_next = None;` | E | the line above already took the value out (a Rust-only repeat) |
| 2 |  | confchange/confchange.rs:129:9 drop | `cfg.auto_leave = false;` | E | the copy made at the start already has it false |
| 3 | S | confchange/confchange.rs:451:12 guard | `if !buf.is_empty() {` | G | Describe's text is never printed by the files |
| 4 | S | log_unstable.rs:74:12 guard | `if l != 0 {` | E | with no unstable entries, offset-1 is the stored last index (or the snapshot index) |
| 5 |  | log_unstable.rs:88:20 guard | `if snapshot.get_metadata_index() == i {` | G | an index below a pending snapshot would get the snapshot's term |
| 6 |  | log_unstable.rs:137:12 guard | `if self.snapshot.is_some() {` | E | the flag is only read when a snapshot is there |
| 7 | S | log_unstable.rs:138:13 drop | `self.snapshot_in_progress = true;` | G | async writes: a second Ready while a snapshot is being written would hand it out again |
| 8 | S | log_unstable.rs:173:9 drop | `self.offset_in_progress = max(self.offset_in_progress, self.offset);` | E | a stable ack only follows an accept, so the in-progress mark is already at or past the new offset |
| 9 | S | log_unstable.rs:183:13 drop | `self.entries = Vec::new();` | E | only frees memory of an empty list |
| 10 |  | log_unstable.rs:189:16 guard | `if snapshot.get_metadata_index() == i {` | G | a late ack for an older snapshot clears a newer one |
| 11 |  | log_unstable.rs:191:17 drop | `self.snapshot_in_progress = false;` | E | the flag is only read when a snapshot is there, and restore resets it |
| 12 |  | log_unstable.rs:199:9 drop | `self.entries = Vec::new();` | G | a snapshot restored over unstable entries keeps them |
| 13 |  | log_unstable.rs:201:9 drop | `self.snapshot_in_progress = false;` | G | a snapshot restored while another is in flight keeps the flag |
| 14 |  | log_unstable.rs:209:19 guard | `} else if from_index <= self.offset {` | G | a conflict in the middle of the unstable entries is never tried |
| 15 |  | log_unstable.rs:224:13 drop | `self.offset_in_progress = min(self.offset_in_progress, from_index);` | G | same: the middle-of-unstable branch is never tried |
| 16 |  | log_unstable.rs:238:15 rel | `if lo > hi {` | E | the callers never ask for an empty range |
| 17 | S | log.rs:154:22 rel | `} else if ci <= self.committed {` | E | a conflict at a committed index cannot happen; the check is a panic that never fires |
| 18 |  | log.rs:161:40 rel | `if ci.wrapping_sub(offset) > len64(&a.entries) {` | E | a panic check that cannot fire: the conflict index is inside the entries |
| 19 |  | log.rs:231:21 rel | `while index > 0 {` | E | at index 0 the term is 0 and the loop returns |
| 20 |  | log.rs:282:15 rel | `if lo >= hi {` | E | an empty range gives an empty list either way |
| 21 |  | log.rs:376:27 rel | `if self.committed < tocommit {` | E | committing to the same index changes nothing |
| 22 |  | log.rs:397:12 guard | `if self.applying_ents_size > size {` | E | the size given back is never more than the size held (the else branch is a defence) |
| 23 |  | log.rs:397:36 rel | `if self.applying_ents_size > size {` | E | at equality both branches give 0 |
| 24 |  | log.rs:398:13 drop | `self.applying_ents_size -= size;` | G | apply-size bookkeeping with several accepts outstanding |
| 25 |  | log.rs:403:61 rel | `self.applying_ents_paused = self.applying_ents_size >= self.max_applyi` | U | apply-size limit, exact equality |
| 26 |  | log.rs:427:37 rel | `self.applying_ents_size >= self.max_applying_ents_size \|\| i < self.max` | U | apply-size limit, exact equality |
| 27 |  | log.rs:480:20 guard | `if err == Error::Compacted \|\| err == Error::Unavailable {` | U | the memory storage never returns an error here |
| 28 | S | log.rs:480:24 eq | `if err == Error::Compacted \|\| err == Error::Unavailable {` | U | the memory storage never returns an error here |
| 29 | S | log.rs:480:51 eq | `if err == Error::Compacted \|\| err == Error::Unavailable {` | U | the memory storage never returns an error here |
| 30 |  | log.rs:531:12 guard | `if at.term != 0 && at.index > self.committed && self.match_term(at) {` | E | a leader's term is never 0 |
| 31 |  | log.rs:531:57 guard | `if at.term != 0 && at.index > self.committed && self.match_term(at) {` | G | commit without the term check (only entries of the leader's own term may be counted); never tried |
| 32 |  | log.rs:597:15 rel | `if hi <= self.unstable.offset {` | E | at equality the unstable part is empty |
| 33 | S | log.rs:610:17 rel | `if size >= max_size {` | E | at exactly the limit the next step adds nothing either |
| 34 | S | log.rs:617:12 guard | `if unstable.len() == 1 && size + ents_size(unstable) > max_size {` | E | the size can only pass the limit when there is one entry |
| 35 | S | log.rs:617:27 eq | `if unstable.len() == 1 && size + ents_size(unstable) > max_size {` | U | size limit met exactly where stable and unstable entries join |
| 36 | S | log.rs:617:62 rel | `if unstable.len() == 1 && size + ents_size(unstable) > max_size {` | U | size limit, exact equality |
| 37 |  | log.rs:627:15 rel | `if lo > hi {` | E | the callers never ask for an empty range |
| 38 | S | quorum/joint.rs:66:17 rel | `if idx0 < idx1 {` | E | when the two indexes are equal both branches return the same number |
| 39 |  | quorum/majority.rs:170:34 guard | `let srt: &mut [u64] = if stk.len() >= n {` | U | more than 7 voters is never tried |
| 40 |  | quorum/majority.rs:170:44 rel | `let srt: &mut [u64] = if stk.len() >= n {` | E | only picks the heap or the stack for the scratch list |
| 41 |  | raft.rs:334:32 rel | `if self.heartbeat_tick <= 0 {` | U | config check; a zero heartbeat tick is never tried |
| 42 | S | raft.rs:338:31 rel | `if self.election_tick <= self.heartbeat_tick {` | U | config check; equal ticks are never tried |
| 43 |  | raft.rs:344:12 guard | `if self.max_uncommitted_entries_size == 0 {` | U | uncommitted-size limit is never set |
| 44 |  | raft.rs:354:35 rel | `if self.max_inflight_msgs <= 0 {` | U | config check; zero in-flight messages is never tried |
| 45 |  | raft.rs:357:12 guard | `if self.max_inflight_bytes == 0 {` | U | byte limit on in-flight messages is never set |
| 46 | S | raft.rs:358:13 drop | `self.max_inflight_bytes = noLimit;` | E | 0 also means no limit inside the in-flight tracker |
| 47 | S | raft.rs:359:19 guard | `} else if self.max_inflight_bytes < self.max_size_per_msg {` | U | byte limit on in-flight messages is never set |
| 48 |  | raft.rs:359:43 rel | `} else if self.max_inflight_bytes < self.max_size_per_msg {` | U | byte limit on in-flight messages is never set |
| 49 |  | raft.rs:364:13 drop | `self.logger = Some(Arc::new(crate::logger::DiscardLogger));` | U | the harness always gives a logger |
| 50 |  | raft.rs:575:8 guard | `if !is_empty_hard_state(hs.as_ref()) {` | U | a store that hands back an empty hard state as present |
| 51 |  | raft.rs:580:8 guard | `if c.applied > 0 {` | U | a restart with applied = 0 on a store that has a snapshot |
| 52 | S | raft.rs:580:18 rel | `if c.applied > 0 {` | U | a restart with applied = 0 on a store that has a snapshot |
| 53 |  | raft.rs:604:19 eq | `self.lead != NONE` | E | nothing calls it |
| 54 | S | raft.rs:814:20 guard | `if err == Error::SnapshotTemporarilyUnavailable {` | U | the storage never fails a snapshot read |
| 55 |  | raft.rs:814:24 eq | `if err == Error::SnapshotTemporarilyUnavailable {` | U | the storage never fails a snapshot read |
| 56 |  | raft.rs:961:9 drop | `self.heartbeat_elapsed = 0;` | U | heartbeat tick is always 1 in the oracle |
| 57 |  | raft.rs:978:17 drop | `pr.match_ = last_index;` | G | the leader's own match index before its first self-ack; Status is not printed in that window |
| 58 |  | raft.rs:982:9 drop | `self.pending_conf_index = 0;` | E | becoming leader sets it again before any use |
| 59 | S | raft.rs:983:9 drop | `self.uncommitted_size = 0;` | U | uncommitted-size limit is never set |
| 60 |  | raft.rs:1063:16 guard | `if self.state == StateType::StateLeader && self.lead_transferee != NON` | E | a node that stepped down has already dropped the transfer |
| 61 | S | raft.rs:1063:56 guard | `if self.state == StateType::StateLeader && self.lead_transferee != NON` | E | aborting a transfer that is not running does nothing |
| 62 |  | raft.rs:1072:12 guard | `if self.heartbeat_elapsed >= self.heartbeat_timeout {` | U | heartbeat tick is always 1 in the oracle |
| 63 |  | raft.rs:1073:13 drop | `self.heartbeat_elapsed = 0;` | U | heartbeat tick is always 1 in the oracle |
| 64 |  | raft.rs:1098:9 drop | `self.tick = TickFn::Election;` | E | the state before already ticks elections |
| 65 |  | raft.rs:1114:9 drop | `self.tick = TickFn::Election;` | E | the state before already ticks elections |
| 66 |  | raft.rs:1139:9 drop | `pr.recent_active = true;` | G | the leader's own active flag before its first self-ack; Status is not printed in that window |
| 67 |  | raft.rs:1183:34 rel | `if self.raft_log.applied >= self.raft_log.committed {` | E | at equality the scan is empty |
| 68 |  | raft.rs:1259:16 guard | `if t == CampaignType::Transfer {` | G | a vote request carries a context it should not; the text output does not show it |
| 69 |  | raft.rs:1295:96 rel | `let in_lease = self.check_quorum && self.lead != NONE && self.election` | G | lease check at exactly the election timeout; needs jitter above 0 |
| 70 |  | raft.rs:1391:20 guard | `if m.get_index() != 0 {` | G | a late storage answer with index 0 prints an extra line |
| 71 |  | raft.rs:1697:24 guard | `if m.get_log_term() > 0 {` | G | a reject hint with term 0 would be searched in the leader's log |
| 72 | S | raft.rs:1697:41 rel | `if m.get_log_term() > 0 {` | G | a reject hint with term 0 (follower log compacted) would be searched in the leader's log |
| 73 |  | raft.rs:1826:84 guard | `} else if pr.state == tracker::StateType::StateSnapshot && pr.match_ +` | G | leaving the snapshot state on an ack below the first index |
| 74 |  | raft.rs:1847:35 guard | `} else if pr.state == tracker::StateType::StateReplicate {` | E | only the snapshot state is left, and it has nothing in flight |
| 75 |  | raft.rs:1920:20 guard | `if self.pr(from).state != tracker::StateType::StateSnapshot {` | U | ReportSnapshot is not used by the oracle |
| 76 |  | raft.rs:1920:40 eq | `if self.pr(from).state != tracker::StateType::StateSnapshot {` | U | ReportSnapshot is not used by the oracle |
| 77 |  | raft.rs:1923:20 guard | `if !m.get_reject() {` | U | ReportSnapshot is not used by the oracle |
| 78 |  | raft.rs:1935:21 drop | `pr.pending_snapshot = 0;` | U | ReportSnapshot is not used by the oracle |
| 79 |  | raft.rs:1947:17 drop | `self.pr_mut(from).msg_app_flow_paused = true;` | U | ReportSnapshot is not used by the oracle |
| 80 |  | raft.rs:2107:17 drop | `self.election_elapsed = 0;` | G | a snapshot message does not reset the election timer |
| 81 |  | raft.rs:2108:17 drop | `self.lead = m.get_from();` | G | a snapshot message does not set the leader |
| 82 | S | raft.rs:2282:35 rel | `if s.get_metadata_index() <= self.raft_log.committed {` | G | a snapshot at exactly the commit index prints a different line |
| 83 | S | raft.rs:2313:20 guard | `if *id == self.id {` | G | a node restores a snapshot whose config leaves it out |
| 84 |  | raft.rs:2313:24 eq | `if *id == self.id {` | G | a node restores a snapshot whose config leaves it out |
| 85 | S | raft.rs:2318:16 guard | `if found {` | G | a learner restoring a snapshot |
| 86 |  | raft.rs:2348:9 drop | `self.trk = tracker::ProgressTracker::make(self.trk.max_inflight, self.` | G | restore keeps peers of the old config |
| 87 |  | raft.rs:2463:21 guard | `if !t_ok && self.lead_transferee != 0 {` | E | aborting a transfer that is not running does nothing |
| 88 |  | raft.rs:2471:31 rel | `if state.get_commit() < self.raft_log.committed \|\| state.get_commit() ` | G | a restart whose saved commit equals the commit index from the snapshot |
| 89 | S | raft.rs:2539:12 guard | `if self.uncommitted_size > 0 && s > 0 && self.uncommitted_size.wrappin` | U | uncommitted-size limit is never set |
| 90 |  | raft.rs:2539:34 rel | `if self.uncommitted_size > 0 && s > 0 && self.uncommitted_size.wrappin` | U | uncommitted-size limit is never set |
| 91 |  | raft.rs:2539:41 guard | `if self.uncommitted_size > 0 && s > 0 && self.uncommitted_size.wrappin` | U | uncommitted-size limit is never set |
| 92 |  | raft.rs:2539:43 rel | `if self.uncommitted_size > 0 && s > 0 && self.uncommitted_size.wrappin` | U | uncommitted-size limit is never set |
| 93 |  | raft.rs:2539:88 rel | `if self.uncommitted_size > 0 && s > 0 && self.uncommitted_size.wrappin` | U | uncommitted-size limit is never set |
| 94 |  | raft.rs:2549:9 drop | `self.uncommitted_size = self.uncommitted_size.wrapping_add(s);` | U | uncommitted-size limit is never set |
| 95 |  | raft.rs:2556:12 guard | `if s > self.uncommitted_size {` | U | uncommitted-size limit is never set |
| 96 |  | raft.rs:2556:14 rel | `if s > self.uncommitted_size {` | E | at equality both branches give 0 |
| 97 | S | raft.rs:2560:13 drop | `self.uncommitted_size = 0;` | U | uncommitted-size limit is never set |
| 98 | S | raft.rs:2562:13 drop | `self.uncommitted_size -= s;` | U | uncommitted-size limit is never set |
| 99 | S | raft.rs:2592:12 guard | `if self.trk.is_voter(self.id) && self.trk.is_singleton() {` | G | a leader that is not a voter, alone with one voter, answering a read |
| 100 |  | raft.rs:2594:16 guard | `if resp.get_to() != NONE {` | G | a read on a one-voter group |
| 101 | S | raft.rs:2594:30 eq | `if resp.get_to() != NONE {` | G | a read on a one-voter group; the fuzz never has one voter |
| 102 |  | rawnode.rs:79:9 drop | `self.raft.election_elapsed += 1;` | U | TickQuiesced is not used by the oracle |
| 103 |  | rawnode.rs:156:12 guard | `if r.raft_log.has_next_unstable_snapshot() {` | E | asking for an absent snapshot gives none |
| 104 |  | rawnode.rs:159:12 guard | `if !r.read_states.is_empty() {` | E | copying an empty list |
| 105 |  | rawnode.rs:197:12 guard | `if !is_empty_hard_state(rd.hard_state.as_ref()) {` | E | a Ready's hard state is absent when unchanged |
| 106 |  | rawnode.rs:202:12 guard | `if !rd.read_states.is_empty() {` | E | clearing an empty list |
| 107 | S | rawnode.rs:217:16 guard | `if need_storage_append_resp_msg(&self.raft, rd) {` | E | an append answer with no index and no snapshot is a no-op |
| 108 |  | rawnode.rs:221:16 guard | `if need_storage_apply_resp_msg(rd) {` | E | an empty apply answer is a no-op |
| 109 | S | rawnode.rs:252:12 guard | `if !is_empty_hard_state(Some(&hard_st)) && !is_hard_state_equal(&hard_` | E | the hard state never goes back to empty |
| 110 | S | rawnode.rs:306:16 guard | `if pr.is_learner {` | U | WithProgress is not used by the oracle |
| 111 |  | rawnode.rs:307:17 drop | `typ = ProgressType::ProgressTypeLearner;` | U | WithProgress is not used by the oracle |
| 112 |  | rawnode.rs:311:13 drop | `p.inflights = tracker::Inflights::default();` | U | WithProgress is not used by the oracle |
| 113 | S | rawnode.rs:323:26 eq | `let rej = status == SnapshotStatus::SnapshotFailure;` | U | ReportSnapshot is not used by the oracle |
| 114 | S | rawnode.rs:411:8 guard | `if !is_empty_hard_state(rd.hard_state.as_ref()) {` | E | a Ready's hard state is absent when unchanged; the inner check already covers it |
| 115 |  | rawnode.rs:425:8 guard | `if !is_empty_snap(rd.snapshot.as_ref()) {` | E | copying an absent snapshot leaves it absent |
| 116 |  | rawnode.rs:426:9 drop | `m.snapshot = rd.snapshot.clone();` | G | async writes with a snapshot: the storage message loses the snapshot |
| 117 | S | rawnode.rs:543:8 guard | `if !is_empty_snap(rd.snapshot.as_ref()) {` | E | copying an absent snapshot leaves it absent |
| 118 | S | read_only.rs:71:12 guard | `if !ctx.is_empty() {` | E | the caller only passes a non-empty context |
| 119 |  | read_only.rs:87:32 rel | `if new_confirmed_reads <= self.confirmed_reads {` | E | at equality zero reads are released |
| 120 |  | storage.rs:190:12 guard | `if ms_index != 0 && ms_index >= snap_index {` | U | ApplySnapshot at index 0 on an empty store is never tried |
| 121 |  | storage.rs:190:21 eq | `if ms_index != 0 && ms_index >= snap_index {` | G | an out-of-date snapshot is never applied to the store |
| 122 |  | storage.rs:190:38 rel | `if ms_index != 0 && ms_index >= snap_index {` | G | a snapshot at the same index is never applied twice |
| 123 |  | storage.rs:213:12 guard | `if i <= self.snapshot.get_metadata_index() {` | U | CreateSnapshot is not used by the oracle |
| 124 | S | storage.rs:213:14 rel | `if i <= self.snapshot.get_metadata_index() {` | U | CreateSnapshot is not used by the oracle |
| 125 | S | storage.rs:218:12 guard | `if i > self.last_index_() {` | U | CreateSnapshot is not used by the oracle |
| 126 |  | storage.rs:218:14 rel | `if i > self.last_index_() {` | U | CreateSnapshot is not used by the oracle |
| 127 |  | storage.rs:224:9 drop | `md.index = Some(i);` | U | CreateSnapshot is not used by the oracle |
| 128 | S | storage.rs:225:9 drop | `md.term = Some(term);` | U | CreateSnapshot is not used by the oracle |
| 129 |  | storage.rs:227:13 drop | `md.conf_state = Some(cs.clone());` | U | CreateSnapshot is not used by the oracle |
| 130 |  | storage.rs:229:9 drop | `self.snapshot.data = data;` | U | CreateSnapshot is not used by the oracle |
| 131 |  | storage.rs:238:26 rel | `if compact_index <= offset {` | G | compacting at exactly the first index is not refused |
| 132 |  | storage.rs:274:18 rel | `if first > entries[0].get_index() {` | E | at equality the cut removes nothing |
| 133 | S | storage.rs:275:13 drop | `entries = &entries[ix(first - entries[0].get_index())..];` | G | appending entries that are already compacted; raft never does it |
| 134 |  | storage.rs:279:12 guard | `if len64(&self.ents) > offset {` | E | differs only where the original panics, and that cannot happen |
| 135 | S | storage.rs:279:30 rel | `if len64(&self.ents) > offset {` | E | at equality, cutting at the end changes nothing |
| 136 |  | storage.rs:282:19 guard | `} else if len64(&self.ents) == offset {` | E | differs only where the original panics, and that cannot happen |
| 137 |  | storage.rs:302:15 rel | `if lo <= offset {` | G | reading entries from exactly the compacted index |
| 138 |  | storage.rs:323:23 rel | `if i - offset >= len64(&self.ents) {` | U | a term read one past the stored end; raft never asks |
| 139 |  | tracker/inflights.rs:90:28 rel | `} else if new_size > self.size {` | E | at equality the size is the same |
| 140 |  | tracker/inflights.rs:91:13 drop | `new_size = self.size;` | E | only the buffer's capacity; not visible |
| 141 |  | tracker/inflights.rs:111:13 drop | `bytes += self.buffer[ix(idx)].bytes;` | U | byte limit on in-flight messages is never set |
| 142 |  | tracker/inflights.rs:123:9 drop | `self.bytes -= bytes;` | U | byte limit on in-flight messages is never set |
| 143 | S | tracker/inflights.rs:128:13 drop | `self.start = 0;` | E | only where the ring buffer starts; not visible |
| 144 | S | tracker/inflights.rs:135:52 eq | `self.count == self.size \|\| (self.max_bytes != 0 && self.bytes >= self.` | U | byte limit on in-flight messages is never set |
| 145 |  | tracker/inflights.rs:135:71 rel | `self.count == self.size \|\| (self.max_bytes != 0 && self.bytes >= self.` | U | byte limit on in-flight messages is never set |
| 146 |  | tracker/inflights.rs:146:9 drop | `self.start = 0;` | E | only where the ring buffer starts; not visible |
| 147 |  | tracker/inflights.rs:148:9 drop | `self.bytes = 0;` | U | byte limit on in-flight messages is never set |
| 148 | S | tracker/progress.rs:142:12 guard | `if self.state == StateType::StateSnapshot {` | E | outside the snapshot state the pending snapshot is 0, so both branches give match+1 |
| 149 |  | tracker/progress.rs:142:23 eq | `if self.state == StateType::StateSnapshot {` | G | next index after a reported snapshot |
| 150 | S | tracker/progress.rs:145:13 drop | `self.next = max(self.match_ + 1, pending_snapshot + 1);` | G | next index after a reported snapshot; the files overwrite it before it shows |
| 151 |  | tracker/progress.rs:150:9 drop | `self.sent_commit = min(self.sent_commit, self.next - 1);` | G | sent-commit bookkeeping when a peer goes back to probing |
| 152 |  | tracker/progress.rs:206:54 rel | `index > self.sent_commit && self.sent_commit < self.next - 1` | G | an extra commit-index message when everything sent is already committed |
| 153 |  | tracker/progress.rs:242:25 rel | `if rejected <= self.match_ {` | G | a late reject at exactly the match index |
| 154 |  | tracker/progress.rs:250:13 drop | `self.sent_commit = min(self.sent_commit, self.next - 1);` | G | sent-commit bookkeeping after a reject while replicating |
| 155 |  | tracker/progress.rs:266:9 drop | `self.sent_commit = min(self.sent_commit, self.next - 1);` | G | sent-commit bookkeeping after a rejected probe |
