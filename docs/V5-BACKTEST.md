# v5 backtest: every hard case v4 met, and v5's own

Companion to [DESIGN-V5.md](DESIGN-V5.md). Part 1 maps every hard case recorded in v4's DECISIONS, STATUS, design records and HISTORY to v5. Part 2 lists the hard cases Raft per shard brings that v4 never had. Every row becomes a named test in phase 1 (DESIGN-V5 §11).

**Verdicts.** `gone`: the mechanism that caused it does not exist in v5, and the row says what replaces it. `same`: the need is real in any design; the row names v5's mechanism and layer. `open`: v5 needs a decision or a design not yet in DESIGN-V5. `n/a`: tooling, wording or process with no kernel consequence.

## Part 2: hard cases v5 brings

These are the cases Raft per shard (a Raft group per shard, `#meta` as a shard, healing by each shard's leader, an optional planner, log replicas and splits) is known to get wrong when built carelessly. Each is a property the TLA+ spec checks (phase 1) and a monitor the simulator runs (phase 2). The log-first list (L-01 to L-38) is in git history (commit 0ad07a8); each L case that still applies is folded into a row below, with its number.

| id | Case | v5's answer (DESIGN-V5) |
|---|---|---|
| R-01 (L-01, L-08) | Two replicas both try to lead shard 7 (a partition, or a stale planner hint) | Each needs a majority of votes in its term, and majorities overlap, so there is one leader per term; a leader of an older term cannot commit (4.2) |
| R-02 (L-02, L-09) | An old leader, cut off, keeps taking writes | It cannot reach a majority, so nothing commits; CheckQuorum steps it down within `election.ms`; its writes were never answered, and their issuers get `unknown` (4.2, 4.3) |
| R-03 (L-03, L-04, L-06, L-28, L-29) | A leader dies with a batch on a minority of replicas | The new leader holds every committed entry (leader completeness). The batch may be kept, committed by the new leader's first entry of its own term, or dropped; its writer was never told it committed, and readers only ever see up to the commit offset (4.2) |
| R-04 (L-05, L-21) | A shard loses its majority, or the whole cluster restarts | It refuses writes with the reason and keeps serving reads; it elects once a majority of its voters is back, in any order; without one, `fero recover --unclean` is the only way on (4.2) |
| R-05 | The single-server membership change bug (Ongaro, 2015) | A new leader commits an entry of its own term before any membership change (4.2) |
| R-06 | A partitioned replica returns with a high term and unseats a working leader | PreVote: it must first win a pre-vote, which voters that hear a live leader refuse (4.2) |
| R-07 (L-15) | A member comes back without its disk, with damaged records, or after an unclean stop under `memory` | Its replicas cannot vouch for their logs, so they come back as new replicas under a new disk incarnation, and never vote as the old ones (4.1, 4.2) |
| R-08 | A member that led a thousand shards dies | Its shards elect in parallel, ranked so one candidate usually stands, with their messages batched per peer (4.2) |
| R-09 | A quiet shard's leader dies | Its followers see the member's link pings stop, wake the shard and elect (4.2) |
| R-10 (L-30) | Healing and a planner hint change the same shard at once | Every change is a Raft entry in the shard's own log, one at a time; a hint names the config it read, and is refused `stale-plan` if the config moved (4.2) |
| R-11 | Two planners at once, or a stale one | Hints are checked against each shard's config, so they waste moves and never break anything; the planner lease in `#meta` keeps two from fighting (4.2) |
| R-12 | A slow but alive replica | The leader commits with the majority without it; it is replaced only after `evict.after` with its link down, or a planner's `gone` (4.2) |
| R-13 (L-27) | A join or a loss moves many replicas at once | Rendezvous hashing moves about `copies`/n of them; each member loads two snapshots at a time and answers `busy` to more; each shard makes one change at a time (4.2) |
| R-14 | A learner is promoted before it has caught up, and one more crash then stalls the shard | A learner is promoted only once caught up (etcd's rule) (4.2) |
| R-15 | Leadership flaps between the rank-1 replica and the one that took over | Leadership returns only once the rank-1 replica has been live and caught up for `settle.ms` (4.2) |
| R-16 (L-10, L-32) | A shard splits while writes, subscribers and consumers are in flight, or its leader dies mid-split | The split is one entry at offset X: committed, every replica applies it; not committed, it may be dropped like any entry. After it the parent refuses `moved`, naming the children; cursors resolve through the lineage; children inherit dedup outcomes, highest call ids and fence tokens (4.2) |
| R-17 | A replica receives a child shard's messages before it has applied the split | It holds them until it applies the split (4.2) |
| R-18 (L-11) | Two shards merge while readers hold cursors on both | Merges are phase 5 |
| R-19 (L-12) | The object store is down or slow | Uploads wait; replicas keep log and snapshots longer; a member near full refuses new replicas; an alarm says so; new replicas stream snapshots from the leader meanwhile (4.1) |
| R-20 (L-13, L-33) | A snapshot is named before its upload finished, or log is dropped while only an incremental layer covers it | A snapshot is named in the shard's log only after its put is confirmed; log is dropped only under a merged base, with no split child, fork or `history` still needing it (4.1) |
| R-21 | A log replica drops log that the only remaining full replica's snapshot does not cover | A log replica drops log only under a merged base in the object store, or below the offset every full voter has snapshotted past, as stamped by the leader (4.1) |
| R-22 (L-16) | A fork points at a snapshot that retention later deletes | Forks hold references in `#meta`; nothing referenced is deleted (4.1) |
| R-23 (L-17) | Writer time jumps on a change of leader | `t = max(last t in the log, min(clock, peers' median + skew.max))`; a skewed member is ranked last, never barred (4.2) |
| R-24 (L-18, L-38) | A retry reaches the new leader after a failover, or the dedup floor rose on refused attempts before it | Outcomes and each issuer's highest call id are shard state, in the log and in snapshots; a new leader folds its whole log before it answers (4.3) |
| R-25 (L-19) | Two machines, one crashes | A shard created below three candidates has one voter, the member that created it; a crash of its machine stops writes until it returns. A witness on a third failure domain makes three voters, so either crash is survived (4.2) |
| R-26 (L-14, L-20) | The full replicas crash and a log replica is the only up-to-date voter left | It leads only to repair: hands over to a returning full voter, or adds a server from the object store, promotes it and hands over. It never takes a client write; the shard says `no-writer` until then (4.2) |
| R-27 | A log replica must repair, and there is no object store | It cannot build a full replica from its log alone, so it waits for a full voter to return with its disk, and says so (4.2) |
| R-28 (L-22) | A noisy project on fero deploy's shared log tier | One log member per project, with a quota each; each project has its own cluster id and `#meta` (4.2) |
| R-29 (L-23) | A `none` resource's leader changes | Its records were never stored; cursors carry the leader's term; a subscriber whose term is gone resumes at `latest` and is told so (3.2) |
| R-30 (L-24, L-31) | A planned handover meets in-flight writes, or races a failover | The leader stops taking new writes, brings the target to its log end, then sends TimeoutNow; writes meanwhile wait or get `moved`; if a failover happens meanwhile, the higher term wins (4.2) |
| R-31 (L-25) | A slow server keeps leading | A planner places by load; without one, a member past `skew.max`, or a replica whose fold lags past `lag.max`, does not stand, and hands over (4.2) |
| R-32 (L-26) | A read from the object store gets stale data | Segments and snapshots are written once, under unique names, and never overwritten (4.1) |
| R-33 (L-34) | A disk lied about an fsync, and its copy is part of the only majority | Boot checks catch damaged records, and such a replica comes back as a new one; an acknowledged write lost by a disk that lies cannot be detected on its own, the residual case, named (4.1) |
| R-34 (L-35) | Healing shrinks a shard to fewer voters than `copies`, silently | Healing never lowers a voter count; a gone voter is removed only when a replacement exists; under-replication is reported on `cluster.health` and stderr (4.2, 4.5) |
| R-35 (L-36) | A member's main thread hangs while its kernel thread keeps pinging | The watchdog answers calls `busy`; its shards keep being written (4.2) |
| R-36 (L-37) | A run folder's dirs were wiped but its `cluster-id` file stayed | The file is renamed aside and a new cluster is founded, said on stderr (4.2) |
| R-37 (L-07) | `#meta` loses its majority | Writes and failovers carry on; joins, new resources and directory updates wait; a stale directory costs one `moved` (4.2) |
| R-38 | A member leaves while another voter of the same shard is dead | Voters dead past `evict.after` are removed first when that lets the leave carry; a shard where neither is safe keeps the leaver as a voter, and `destroy()` names it (4.2) |
| R-39 | A replica whose fold lags far behind wins an election | Raft elects only complete logs; a replica whose fold lags past `lag.max` waits one more step; a new leader answers only once its fold reaches its log end (4.2) |
| R-40 | A planner places a shard on a server without the resource's code | The leader refuses a target without the resource's code hashes (4.5) |
| R-41 | A frozen server forwards an attempt late | Links and budgets bound how late a copy can arrive: a server forwards only over the link it had, which the leader closed after `election.ms` of missed pings. The log makes answers unique: a resent attempt's refusal is appended, so a late copy finds it (4.3) |
| R-42 | A member holds thousands of shards, and each would fsync and ping alone | One journal per process, with one fsync per batch; one link ping per member pair; quiet shards send nothing (4.1, 4.2) |
| R-43 | A `fresh` read reaches a deposed leader | Read index: it confirms that a majority still follows it before it answers (4.2, 4.5) |
| R-44 | Example 01's voter leaves | It promotes the learner, hands over leadership, then removes itself, all while both are live (4.2) |
| R-45 | A gone voter is replaced while one more voter is down | A gone voter is removed first (it was not answering anyway), then its replacement is added as a learner and promoted, so no step needs more live voters than before (4.2) |
| R-46 | `confirm: 'sent'` on a write whose leader then dies | The answer carries the attempt id, never an offset; the write stays pending and is resent after failover, so dedup finds it; a client's view shows it only once it commits; refused on conditions and ops (3.2) |
| R-47 | A power loss of every voter, each journal ending in a torn record | A torn tail is truncated, and the replica still vouches for everything before it; only damage mid-log makes a replica a new one (4.1) |
| R-48 | One of three members is partitioned past `evict.after`, with no replacement candidate | Healing never lowers a voter count: the gone voter stays, the shard is reported under-replicated, and its live majority commits (4.2) |
| R-49 | An attempt is refused, then a stale earlier copy of it arrives (a queued frame on a closed link) | The refusal of a resent attempt is appended under its id, so the stale copy finds it and gets the same answer (4.3) |
| R-50 | A `sent` write's offset is reused by the next leader | The `sent` answer carries no offset; the write is matched by attempt id and resent after failover (3.2) |
| R-51 | A sleeping free-tier project wakes on a fresh copy, with only log replicas left | Log members hold full replicas of `#meta`, so it takes the new member record; each shard's log replica then adds the copy and hands it leadership (4.2) |
| R-52 | A leader's clock jumps a year ahead for one batch | `t` is clamped to the peers' median plus `skew.max`, so no TTL or lease is poisoned (4.2) |
| R-53 | A full voter whose log is behind keeps standing and losing, so a log replica never stands | A log replica stands when no full voter has won for twice `election.ms` (4.2) |
| R-54 | A fresh disk repeats an old disk incarnation and votes as the old replica | Disk incarnations are random 128-bit ids, written when the dir is created (4.1) |
| R-55 | A leader quiets a shard while a follower lags | A leader quiets only when every live voter has its commit offset; a follower told "quiet at i" while below it asks to wake (4.2) |
| R-56 | A `fresh` read at a quiet shard's deposed leader after links return | The read index is a per-shard message carrying the term; link pings never confirm leadership (4.2) |
| R-57 | A member returns as rank 1 for thousands of shards | It takes back at most ten leaderships a second (4.2) |
| R-58 | A member leaves while a peer is in a GC pause | Only voters dead past `evict.after` are removed for a leave; a shorter silence keeps the leaver as a voter, and `destroy()` says so (4.2) |
| R-59 | A follower restarts during a roll while its shards are quiet | When a link comes back, each side reports its log end per shared shard, and the leader wakes any shard whose follower is behind (4.2) |
| R-60 | A new leader overwrites a follower's uncommitted tail, then the follower loses power | The follower journals a cut record before the new entries and starts a new segment; boot replays cuts in order (4.1) |
| R-61 | A replica removed while it was down comes back | It learns of its removal from the leader or `#meta`, stops serving, and deletes its copy once `#meta` shows the configuration without it; if re-added first, its copy seeds the learner (4.2) |
| R-62 | Two members leave a three-voter shard one after the other | Each leave promotes a caught-up learner first, so the voter count holds while learners remain (4.2) |

## Part 1: v4's hard cases

Every hard case v4 recorded, with v4's mechanism and v5's answer, is in one file per source:

| File | Source | Rows |
|---|---|---|
| [v5-backtest/decisions.md](v5-backtest/decisions.md) | docs/DECISIONS.md, plus its 102 invariants against v5 | 414 |
| [v5-backtest/status-leave-door.md](v5-backtest/status-leave-door.md) | STATUS.md, docs/DESIGN-LEAVE.md, docs/DESIGN-DOOR.md | 306 |
| [v5-backtest/scale-m6-m7.md](v5-backtest/scale-m6-m7.md) | docs/DESIGN-SCALE.md, DESIGN-M6.md, DESIGN-M7.md, CHECKPOINT.md, plus v4's measured scale numbers | 259 |
| [v5-backtest/history-config-monitors.md](v5-backtest/history-config-monitors.md) | docs/HISTORY.md, DESIGN-DIRECTORY.md, DESIGN-CONFIG.md, sim/monitors.ts, data's SCHEDULE, plus the 36 monitors and 20 clauses against v5 | 334 |

The summary, and the third draft's answers to the rows the second draft left open, are in DESIGN-V5 section 7.
