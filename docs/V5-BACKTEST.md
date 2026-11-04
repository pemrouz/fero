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
| R-08 | A member that led a thousand shards dies | Its shards elect in parallel, with Raft's randomized timeouts so one candidate usually stands, and their messages batched per peer (4.2) |
| R-09 | A quiet shard's leader dies | Its followers see the member's link pings stop, wake the shard and elect (4.2) |
| R-10 (L-30) | Healing and a planner hint change the same shard at once | Every change is a Raft entry in the shard's own log, one at a time; a hint names the config it read, and is refused `stale-plan` if the config moved (4.2) |
| R-11 | Two planners at once, or a stale one | Hints are checked against each shard's config, so they waste moves and never break anything; the planner lease in `#meta` keeps two from fighting (4.2) |
| R-12 | A slow but alive replica | The leader commits with the majority without it; it is replaced only after `evict.after` with its link down, or a planner's `gone` (4.2) |
| R-13 (L-27) | A join or a loss moves many replicas at once | Rendezvous hashing moves about `copies`/n of them; each member loads two snapshots at a time and answers `busy` to more; each shard makes one change at a time (4.2) |
| R-14 | A learner is promoted before it has caught up, and one more crash then stalls the shard | A learner is promoted only once caught up (etcd's rule) (4.2) |
| R-15 | Leadership flaps between the preferred leader and the one that took over | Leadership returns only once the preferred leader has been live and caught up for `settle.ms` (4.2) |
| R-16 (L-10, L-32) | A slot moves while writes, subscribers and consumers are in flight, or a leader dies mid-move | The move is `importing`, `fenced` and `open` entries in the two shards' logs, and each leader resumes from its own; after the fence the old shard answers `moved`; positions are per slot, so cursors need nothing; outcomes, highest ids (by `max`) and fence tokens move with the slot (4.2) |
| R-17 | A move's old shard crashes after `fenced`, or the new one after `importing` | Each resumes from its own log; the old shard cancels only after the new one appends `abort`, which it does only before `open`; at most one shard has the slot open (4.2) |
| R-18 (L-11) | A quiet shard empties into a sibling while readers hold cursors on it | Its slots move one by one; positions are per slot, so readers resubscribe where `END` and `moved` point (4.2) |
| R-19 (L-12) | The object store is down or slow | Uploads wait; replicas keep log and snapshots longer; a member near full refuses new replicas; an alarm says so; new replicas stream snapshots from the leader meanwhile (4.1) |
| R-20 (L-13, L-33) | A snapshot is named before its upload finished, or log is dropped while only an incremental layer covers it | A snapshot is named in the shard's log only after its put is confirmed; log is dropped only under a merged base, with no split child, fork or `history` still needing it (4.1) |
| R-21 | A log replica drops log that the only remaining full replica's snapshot does not cover | A log replica drops log only under a merged base in the object store, or below the offset every full voter has snapshotted past, as stamped by the leader (4.1) |
| R-22 (L-16) | A fork points at a snapshot that retention later deletes | Forks hold references in `#meta`; nothing referenced is deleted (4.1) |
| R-23 (L-17) | Writer time jumps on a change of leader | `t = max(last t in the log, min(clock, peers' median + skew.max))`; a skewed member waits longer to stand, never barred (4.2) |
| R-24 (L-18, L-38) | A retry reaches the new leader after a failover, or the dedup floor rose on refused attempts before it | Outcomes and each issuer's highest call id are shard state, in the log and in snapshots; a new leader folds its whole log before it answers (4.3) |
| R-25 (L-19) | Two machines, one crashes | A shard created below three candidates has one voter, the member that created it; a crash of its machine stops writes until it returns. A witness on a third failure domain makes three voters, so either crash is survived (4.2) |
| R-26 (L-14, L-20) | The full replicas crash and a log replica is the only up-to-date voter left | It leads only to repair: hands over to a returning full voter, or adds a server from the object store, promotes it and hands over. It never takes a client write; the shard says `no-writer` until then (4.2) |
| R-27 | A log replica must repair, and there is no object store | It cannot build a full replica from its log alone, so it waits for a full voter to return with its disk, and says so (4.2) |
| R-28 (L-22) | A noisy project on fero deploy's shared log tier | One log member per project, with a quota each; each project has its own cluster id and `#meta` (4.2) |
| R-29 (L-23) | A `none` resource's leader changes (phase 5) | Its records were never stored; cursors carry the leader's term; a subscriber whose term is gone resumes at `latest` and is told so (3.2) |
| R-30 (L-24, L-31) | A planned handover meets in-flight writes, or races a failover | The leader stops taking new writes, brings the target to its log end, then sends TimeoutNow; writes meanwhile wait or get `moved`; if a failover happens meanwhile, the higher term wins (4.2) |
| R-31 (L-25) | A slow server keeps leading | A planner places by load; without one, a member past `skew.max` waits longer to stand, and hands over (4.2) |
| R-32 (L-26) | A read from the object store gets stale data | Segments and snapshots are written once, under unique names, and never overwritten (4.1) |
| R-33 (L-34) | A disk lied about an fsync, and its copy is part of the only majority | Boot checks catch damaged records, and such a replica comes back as a new one; an acknowledged write lost by a disk that lies cannot be detected on its own: the residual case, named in 4.1, "Disks that lie" |
| R-34 (L-35) | Healing shrinks a shard to fewer voters than `copies`, silently | Healing never lowers a voter count; a gone voter is removed only when a replacement exists; under-replication is reported on `cluster.health` and stderr (4.2, 4.5) |
| R-35 (L-36) | A member's main thread hangs while its kernel thread keeps pinging | The watchdog answers calls `busy`; its shards keep being written (4.2) |
| R-36 (L-37) | A run folder's dirs were wiped but its `cluster-id` file stayed | The file is renamed aside and a new cluster is founded, said on stderr (4.2) |
| R-37 (L-07) | `#meta` loses its majority | Writes and failovers carry on; joins, new resources and directory updates wait; a stale directory costs one `moved` (4.2) |
| R-38 | A member leaves while another voter of the same shard is dead | A voter whose link is down past `election.ms` and that does not answer probes for the rest of `leave.ms` is removed first, when that lets the leave carry (V4-60); a shard where neither is safe keeps the leaver as a voter, and `destroy()` names it (4.2) |
| R-39 | A replica whose fold lags far behind wins an election | Raft elects only complete logs; a new leader answers only once its fold reaches its log end, and the hand-back later returns leadership to the preferred leader (4.2) |
| R-40 | A planner places a shard on a server without the resource's code | The leader refuses a target without the resource's code hashes (4.5) |
| R-41 | A frozen server forwards an attempt late | Links and budgets bound how late a copy can arrive: a server forwards only over the link it had, which the leader closed after `election.ms` of missed pings. The log makes answers unique: a resent attempt's refusal is appended, so a late copy finds it (4.3) |
| R-42 | A member holds thousands of shards, and each would fsync and ping alone | One journal per process, with one fsync per batch; one link ping per member pair; quiet shards send nothing (4.1, 4.2) |
| R-43 | A `fresh` read reaches a deposed leader | Read index: it confirms that a majority still follows it before it answers (4.2, 4.5) |
| R-44 | Example 01's voter leaves | It promotes the learner, hands over leadership, then removes itself, all while both are live (4.2) |
| R-45 | A gone voter is replaced while one more voter is down | A gone voter is removed first (it was not answering anyway), then its replacement is added as a learner and promoted, so no step needs more live voters than before (4.2) |
| R-46 | `confirm: 'sent'` on a write whose leader then dies (phase 5) | The answer carries the attempt id, never an offset; the write stays pending and is resent after failover, so dedup finds it; a client's view shows it only once it commits; refused on conditions and ops (3.2) |
| R-47 | A power loss of every voter, each journal ending in a torn record | A torn tail is truncated, and the replica still vouches for everything before it; only damage mid-log makes a replica a new one (4.1) |
| R-48 | One of three members is partitioned past `evict.after`, with no replacement candidate | Healing never lowers a voter count: the gone voter stays, the shard is reported under-replicated, and its live majority commits (4.2) |
| R-49 | An attempt is refused, then another copy of it arrives: a frame queued on a closed link, or a first send still in flight when a timeout resent it | A resent copy's refusal is appended under its id, so a later copy finds it; an issuer that has resent accepts only its latest copy's answer, so a first send's unappended refusal is ignored (4.3) |
| R-50 | A `sent` write's offset is reused by the next leader (phase 5) | The `sent` answer carries no offset; the write is matched by attempt id and resent after failover (3.2) |
| R-51 | A sleeping free-tier project wakes on a fresh copy, with only log replicas left | Log members hold full replicas of `#meta`, so it takes the new member record; each shard's log replica then adds the copy and hands it leadership (4.2) |
| R-52 | A leader's clock jumps a year ahead for one batch | `t` is clamped to the peers' median plus `skew.max`, so no TTL or lease is poisoned (4.2) |
| R-53 | A full voter whose log is behind keeps standing and losing, so a log replica never stands | A log replica stands when no full voter has won for twice `election.ms` (4.2) |
| R-54 | A fresh disk repeats an old disk incarnation and votes as the old replica | Disk incarnations are random 128-bit ids, written when the dir is created (4.1) |
| R-55 | A leader quiets a shard while a follower lags | A leader quiets only when every live voter has its commit offset; a follower told "quiet at i" while below it asks to wake (4.2) |
| R-56 | A `fresh` read at a quiet shard's deposed leader after links return | The read index is a per-shard message carrying the term; link pings never confirm leadership (4.2) |
| R-57 | A member returns as the preferred leader of thousands of shards | It takes back at most ten leaderships a second (4.2) |
| R-58 | A member leaves while a peer is in a GC pause | A paused peer answers the leader's probes within `leave.ms`, so it is kept, and the leave carries normally (4.2) |
| R-59 | A follower restarts during a roll while its shards are quiet | When a link comes back, each side reports its log end per shared shard, and the leader wakes any shard whose follower is behind (4.2) |
| R-60 | A new leader overwrites a follower's uncommitted tail, then the follower loses power | The follower journals a cut record before the new entries and starts a new segment; boot replays cuts in order (4.1) |
| R-61 | A replica removed while it was down comes back | It learns of its removal from the leader or `#meta`, stops serving, and deletes its copy once `#meta` shows the configuration without it; if re-added first, its copy seeds the learner (4.2) |
| R-62 | Two members leave a three-voter shard one after the other | Each leave promotes a caught-up learner first, so the voter count holds while learners remain (4.2) |
| R-63 | Founding seeds each mint a cluster id, or a seed restarted without its dir founds a second cluster | A seed founds only with a majority of seeds and none holding an id; the winner of `#meta`'s first election mints it; a dir-less seed that finds an id joins (4.2) |
| R-64 | Healing adds back a member that is leaving, or example 01 hands the vote back to the exiting process | A leave marks the member `draining` in `#meta` first, so no target includes it (4.2) |
| R-65 | A Raft verb, or a planner or admin `ASK`, arrives on a client link | Raft verbs only on member links past the door, planner and admin `ASK`s only with the admin key; otherwise the link closes (4.1) |
| R-66 | A huge batch, catch-up or bundled frame stalls a link | Batches cap at 1 MB, catch-up appends at 4 MB, bundled frames at 1 MB; big records are cut between markers (4.1) |
| R-67 | The journal or log is dropped before the segment or snapshot covering it is on disk | Journal truncation waits for the covering segments' fsync; log drops wait for the snapshot's fsync or confirmed put (4.1) |
| R-68 | A new learner, still loading its snapshot, serves a read as if rows were absent | A replica serves only once ready: snapshot loaded and fold at the commit offset it started from; until then `moved` (4.4) |
| R-69 | Two founders start with different `seeds` lists, or a process has both `seeds` and a one-box `cluster-id` file | Seeds compare list hashes and refuse to found on a mismatch; the `cluster-id` file wins over `seeds` (4.2) |
| R-70 | A stale-looking `cluster-id` file while a dir is still locked by a live process | Not stale: only wiped and unlocked dirs make it stale (4.2) |
| R-71 | A process opens another project's dir | The boot record names cluster id and project; a mismatch is refused, naming both (4.1) |
| R-72 | Healing removes a live voter whose replacement is only within `lag.max` | Removal waits until the replacement's log reaches the commit offset exactly (4.2) |
| R-73 | Every election brings a resend storm | Resends back off with jitter from 200 ms to `election.ms`; `no-writer` and `moved` carry a retry-after (4.3) |
| R-74 | Issuers and writers disagree on `issuer.window`, so a lost write looks committed | `issuer.window` is a cluster key, and the floor uses it (4.3, 4.5) |
| R-75 | A cluster key changes online to a value that breaks another | `fero.alter('#meta', change)` checks ranges and cross-key rules, and refuses with the reason (4.5) |
| R-76 | A leader dies mid-promotion, or example 01's leave is cut off halfway, and the shard needs a vote from a learner that has not heard of its promotion | Learners answer vote requests by the normal log rule and never stand; candidates count only their own configuration's voters (4.2) |
| R-77 | One voter crashed seconds ago, then another member leaves a three-voter shard | A voter silent past `election.ms` that does not answer probes for the rest of `leave.ms` is removed first, so the stayer keeps writing (V4-60) (4.2) |
| R-78 | `#meta` is recovered with `--new-cluster`, then an old voter returns with its dir | Members compare `#meta`'s incarnation in HELLO; the lower one stops its `#meta` replica and rejoins the new one (4.2) |
| R-79 | `recover` is run while a voter it would drop is still alive | Both recover commands refuse while any voter they would drop answers, naming it (4.2) |
| R-80 | A leave during a roll leaves a shard one voter, and the restarted member returns | Healing raises a voter count only to an odd number, so the returning member is a learner until a third candidate arrives (4.2) |
| R-81 | `issuer.window` is lowered online while attempts are in flight | It may only be raised online (4.5) |
| R-82 | `recover --new-cluster` rebuilds `#meta` from a copy that was behind | On the incarnation bump every leader re-writes its shard record and every server re-registers its resources (4.2) |
| R-83 | `fero recover --unclean` loses a slot's last records, and new writes reuse their sequence numbers | Recovery bumps the epoch of each slot the shard holds; a position from an older epoch is refused `unknown-log`, and the reader takes a fresh snapshot (2, 4.2) |
| R-84 | A whole-resource reader's cursor grows with the resource | One number per slot: at most 1,024, about 8 KB, whatever the number of partitions (2) |
| R-85 | One slot is hot | The shard rule can give a hot slot a shard of its own; a hot partition is still one writer (4.2) |
| R-86 | A slot moves while an issuer is resending an attempt to it | Outcomes tagged with the slot move with it, and the issuer's highest id merges by `max`, so a late copy at the new shard is a dedup hit or below the floor, never fresh (4.2, 4.3) |
| R-87 | Two slot moves of one resource at once, or a grow and a shrink racing | One move at a time per resource, by a lease row in `#meta`; shrinking waits a quarter of both limits for `settle.ms`, so it cannot chase a grow (4.2) |
| R-88 | A subscriber is reading slot s at the old shard when the fence lands | It gets `END` with its position, and resubscribes at the new shard, which serves from that position once open (4.2, 4.4) |
| R-89 | A's leader appends `fenced` and is deposed before it commits, while B opens the slot | Every move step acts only on committed entries; A fences only after B's `importing` commits, and streams and answers `moved` only after `fenced` commits; B serves only after `open` commits (4.2) |
| R-90 | B's leader is deposed with `importing` uncommitted, and A fences to a shard that knows nothing of the slot | A fences only after B reports `importing` committed; until `open`, B answers `retry`, never `moved(A)` (4.2) |
| R-91 | A `log` reader (a tape, a derived resource) resumes below a move's fence | B answers `moved(A)`, or `expired` once `history` lapsed; a replay reads A's segments for the slot, then B's (4.2) |
| R-92 | `recover --unclean` restores a shard from a copy older than a move's fence | The recovered shard re-fences every slot the slot table places elsewhere, never reopens one, and shows the list first (4.2) |
| R-93 | A recovered `#locks` shard reuses sequence numbers, so a new token looks older than the highest seen | Versions and fence tokens compare as (epoch, sequence) (2) |
| R-94 | A slot move carries fence tokens for locks that live in `#locks`, while B already holds a higher one | A's whole per-lock table is carried and merged by `max` at B (4.2) |
| R-95 | A daily load cycle makes a resource shrink every night and grow every morning | Shrinking waits `shrink.after` (6 h), and only when the sibling stays under half of both limits afterwards (4.2) |
| R-96 | A client with a stale route dials a shard deleted by a shrink | A shard is deleted only after a grace period with no slots in the table, and its former members answer `moved` from the table meanwhile (4.2) |
| R-97 | A client link carries a `recover` inside an `ASK` | Admin `ASK`s need the admin key, checked at the door before the payload reaches the library (4.1) |
| R-98 | An issuer's oldest unacknowledged attempt sits exactly at the floor | The window is a span of ids: highest issued minus oldest unacknowledged is below `issuer.window`, so the oldest is always above the floor (4.3) |

## Part 1: v4's hard cases

Every hard case v4 recorded, with v4's mechanism and v5's answer, is in one file per source:

| File | Source | Rows |
|---|---|---|
| [v5-backtest/decisions.md](v5-backtest/decisions.md) | docs/DECISIONS.md, plus its 102 invariants against v5 | 414 |
| [v5-backtest/status-leave-door.md](v5-backtest/status-leave-door.md) | STATUS.md, docs/DESIGN-LEAVE.md, docs/DESIGN-DOOR.md | 306 |
| [v5-backtest/scale-m6-m7.md](v5-backtest/scale-m6-m7.md) | docs/DESIGN-SCALE.md, DESIGN-M6.md, DESIGN-M7.md, CHECKPOINT.md, plus v4's measured scale numbers | 259 |
| [v5-backtest/history-config-monitors.md](v5-backtest/history-config-monitors.md) | docs/HISTORY.md, DESIGN-DIRECTORY.md, DESIGN-CONFIG.md, sim/monitors.ts, data's SCHEDULE, plus the 36 monitors and 20 clauses against v5 | 334 |

The summary, and the third draft's answers to the rows the second draft left open, are in DESIGN-V5 section 7.
