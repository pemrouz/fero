# The mechanism catalogue: DEV-01 and DEV-02

Written 2026-11-10 for the v5 design-space study ([BRIEF.md](BRIEF.md)). It settles the two counts that [REQUIREMENTS.md](REQUIREMENTS.md) DEV-01 asks for, and lists every mechanism the 20 rows carry.

- **The list:** [judging/mechanism-list.json](judging/mechanism-list.json), 103 units with their state and rules.
- **Two counters, blind:** [judging/mechanisms.a.json](judging/mechanisms.a.json) (counter a) and [judging/mechanisms.b.json](judging/mechanisms.b.json) (counter b). Each judged every unit, and each added and regrouped units on its own.
- **The settled file:** [judging/mechanisms.json](judging/mechanisms.json). A referee decided every difference in writing (section 4). `python3 tools/judging.py mechanisms` checked it and wrote the counts into it; `python3 tools/judging.py pairs` built [judging/pairs.json](judging/pairs.json) and [judging/PAIRS.md](judging/PAIRS.md).
- **Numbers.** The counts in section 2's table are copied by a script from those tool outputs. None is added by hand.

## 1. How mechanisms are counted

REQUIREMENTS DEV-10 sets the rule. In short:

- **A mechanism** is one named piece of durable or replicated state, plus the rules that write it. Example: "slot sequence" is the last sequence per slot, plus the rule that stamps the next one.
- **It is novel** unless a cited paper or a production system has the same state and the same rules, in the same role. If nobody can place such a precedent, it counts as novel.
- **DEV-01** is the number of novel mechanisms a row carries. The bar is below v4's 13. Judging rule 3: when two rows that are still in differ by 2 or more, the lower count wins.
- **DEV-02** counts interacting pairs: two mechanisms that the row carries, that both touch one piece of state, where at least one of them writes it. It breaks ties that are left after rule 3.

**How this count was made.** The list split the 20 rows into 103 units. Two counters judged each unit on their own: novel or not, and which rows carry it. They agreed on 94 of the 103. Each also added units the list missed, and proposed regroupings. A referee settled every difference. Where the counters agreed, their judgment was kept; the referee found none of those plainly wrong.

**The referee's policy, in four lines.**
- The list's units stay. A regrouping is taken only where it changes what is novel, or which piece of state a unit names (so the pairs come out right). Merging two units that are both not novel changes no DEV-01 count.
- An added unit is taken when it is durable or replicated state with rules of its own (DEV-10 (a)).
- A precedent counts only if a counter placed it. The referee checked the doubtful ones at their source where it could (section 4.4). A lead the referee found that no counter placed does not count; it goes to the user.
- Some units name no durable state (the slow-leader rule, admission credits, the tenant budget, the `none` rung). REQUIREMENTS X17 and P-06 ask that they be counted, so they stay in the file. Each was judged on its precedent like any other.

## 2. The 20 rows

"Novel" is DEV-01. "Carried" counts every mechanism the row holds, novel or not. "Pairs" is DEV-02.

| Row | Novel, counter a | Novel, counter b | Novel, settled | Mechanisms carried | Interacting pairs | The row's novel mechanisms (settled) |
|---|---|---|---|---|---|---|
| DRAFT | 6 | 8 | **6** | 52 | 309 | Dormant groups; Log replicas (the witness): lead only to repair; Slot move (the move record: export, import, fence, copy, open); Dedup window (issuer window, floor, outcomes by id, per-hop time budgets); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| MIN | 4 | 3 | **4** | 48 | 253 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| RUST | 4 | 3 | **4** | 48 | 253 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| SRV | 4 | 3 | **4** | 50 | 267 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| LEAN | 4 | 3 | **4** | 48 | 255 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| CELL | 4 | 6 | **5** | 48 | 262 | Dormant groups; Log replicas (the witness): lead only to repair; Re-key into a new generation; Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| LANE | 4 | 5 | **4** | 47 | 232 | Log replicas (the witness): lead only to repair; Dedup window (issuer window, floor, outcomes by id, per-hop time budgets); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| SPLIT | 5 | 7 | **5** | 52 | 278 | Dormant groups; Log replicas (the witness): lead only to repair; Dedup window (issuer window, floor, outcomes by id, per-hop time budgets); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| PD | 0 | 1 | **0** | 46 | 210 | none |
| ISR | 2 | 1 | **2** | 45 | 215 | Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| SLOG | 5 | 4 | **5** | 49 | 272 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Dedup window (issuer window, floor, outcomes by id, per-hop time budgets); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| OBJ | 2 | 2 | **2** | 37 | 147 | Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation) |
| V4 | 8 | 11 | **8** | 24 | 52 | Dedup window (issuer window, floor, outcomes by id, per-hop time budgets); Orphans; Sheds; Latches; Teachers; Floors; FEED words; Membership views by ballot (joint consensus) |
| MIN-P | 3 | 2 | **3** | 48 | 252 | Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| MIN-TS | 4 | 3 | **4** | 48 | 253 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| RLOG | 4 | 4 | **4** | 50 | 268 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| EMB-V8 | 4 | 3 | **4** | 51 | 269 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| SIDE | 4 | 3 | **4** | 51 | 277 | Dormant groups; Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |
| BUY | 0 | 0 | **0** | 10 | 12 | none |
| COMP | 3 | 5 | **3** | 50 | 283 | Slot move (the move record: export, import, fence, copy, open); Restore mark in the store's manifest (an epoch high-water mark, and a session generation); One process per dir: a lock with a lease, and an epoch fence |

**How to read it.**
- Every row is below DEV-01's bar of 13, by every count.
- The settled count of V4 itself is 8, not 13. REQUIREMENTS section 5's list of thirteen held two names that are not v4's (in-sync sets and eligible leaders: section 4.1), both counters found precedents for four more (lanes, stamps, digests, tombstones), and the referee took counter a's precedent for compaction frontiers. The bar stays as the user wrote it.
- One unit, `dir-lease`, adds 1 to each of 16 rows. It changes no order among them (section 4.2).
- Three close calls decide COMP against MIN-P: the `memory` rung, planner hints and the slow-leader rule in the leader's own form. Counter b judged all three novel; counter a and the referee did not. Counter b's column shows what follows if they were: COMP 5 against MIN-P 2. Settled, they are 3 and 3 (section 4.1).
- BUY's count is 0 because its replication is the bought log, judged as one published unit (`outside-log`).

## 3. The catalogue

Grouped by the axis of [SPACE.md](SPACE.md) section 2 that the unit belongs to; v4's own kernel comes last. Each entry gives the state, the rules, whether it is novel (or its precedent), the rows that carry it, and the model that checked it. "Settled by both" means the two counters agreed; "referee" means section 4 says why. Layers are those of [DESIGN-V5.md](../DESIGN-V5.md) (L0 to L5) where the list names one.

### R: replication and agreement

**Raft log** (`raft-log`, L1)
- State: Each replica's ordered entries of one group (index, term, payload): a committed part and an uncommitted tail.
- Rules: Only the leader appends. A follower takes entries only when the entry before them matches, and cuts a tail that conflicts (log matching).
- Not novel. Precedent: a: Ongaro and Ousterhout, 'In Search of an Understandable Consensus Algorithm' (USENIX ATC 2014), section 5.3 (log replication, the Log Matching property); etcd's raft, log.go and raft.go. / b: Ongaro and Ousterhout, 'In Search of an Understandable Consensus Algorithm', USENIX ATC 2014, section 5.3; etcd's raft (log.go, raft.go)
- Rows: every row but OBJ, V4, BUY (17).
- Model: E-14, E-14b, E-14c: TLC on etcd's own TLA+ spec; no rule count by ablation
- Settled by: both counters.

**Term and vote** (`raft-term-vote`, L1)
- State: Each replica's current term and the vote it gave in that term, on disk before any reply that depends on them.
- Rules: A replica votes once a term, only for a candidate whose log is at least as up to date. A candidate with a majority of its own configuration's voters leads the term; no member campaigns while a committed change is unapplied (A-01).
- Not novel. Precedent: a: Raft (ATC 2014), sections 5.2 and 5.4.1 (one vote a term; the up-to-date check); etcd's raft, raft.go: hup() will not campaign 'since there are still pending configuration changes to apply' (read here, line 984 of the copy the study downloaded). / b: Raft paper sections 5.2 and 5.4.1; etcd's raft, raft.go: hup() refuses to campaign while a committed config change is unapplied
- Rows: every row but OBJ, V4, BUY (17).
- Model: E-14, E-14b, E-14c: TLC on etcd's spec; the campaign guard is 1 of the 16 membership rules
- Settled by: both counters.

**Commit index** (`raft-commit`, L1)
- State: The highest index a majority of the group's voters hold (on disk, under `persisted`); the leader stamps it on later messages and followers learn it.
- Rules: The leader advances it when a majority of voters, itself once its own fsync lands, hold an entry of its own term. A new leader first commits an entry of its own term.
- Not novel. Precedent: a: Raft (ATC 2014), sections 5.3 and 5.4.2 (commit by a majority; only entries of the leader's own term); Ongaro's thesis, section 10.2.1 (the leader writes its own disk while it sends); etcd's raft, maybeCommit. / b: Raft paper sections 5.3 and 5.4.2; Ongaro's thesis section 10.2.1 (the leader writes its disk in parallel and counts itself only once its write lands); etcd's raft async storage writes
- Rows: every row but OBJ, V4, BUY (17).
- Model: E-14, E-14b, E-14c: TLC on etcd's spec; no rule count by ablation
- Settled by: both counters.

**Configurations and joint consensus (membership on commit)** (`raft-config`, L1)
- State: The group's voters, the one change that may be pending (or the joint configuration), and the config epoch: the count of committed changes.
- Rules: One change at a time, as a log entry that takes effect when it commits. Only a voter of its own applied configuration stands; a removed leader steps down; a lost disk never returns under its old id (A-01).
- Not novel. Precedent: a: Ongaro's thesis, sections 4.1 and 4.3 (one server at a time; joint consensus); etcd's raft: a change takes effect when its entry is applied (confchange package), and StepDownOnRemoval (raft.go, read here); etcd's runtime-reconfiguration guide (a member that lost its data is removed and added under a new id); TiKV's region epoch (conf_ver) for the count of changes. / b: Ongaro's thesis chapter 4 (one change at a time; joint consensus); etcd's raft confchange package, where a change takes effect when it is applied, and StepDownOnRemoval; TiKV's region epoch (conf_ver) for the count of changes; Kafka KIP-853 for 'a lost disk never returns under its old id'
- Rows: every row but OBJ, V4, BUY (17).
- Model: E-14, E-14b, E-14c (TLC on etcd's spec): 16 rules for membership in all (E-14b's 14 plus E-14c's 2); 12 of 13 non-equivalent mutants caught
- Settled by: both counters.

**Snapshots** (`raft-snapshot`, L1)
- State: Each replica's snapshot of the folded state at one index, and the log prefix it has dropped below it.
- Rules: A replica cuts a snapshot at a committed index and may then drop its log below it. The leader sends a snapshot to a replica that is behind its log start (InstallSnapshot).
- Not novel. Precedent: a: Raft (ATC 2014), section 7 (log compaction, InstallSnapshot); etcd's raft, Storage.Snapshot and MsgSnap. / b: Raft paper section 7 (log compaction, InstallSnapshot); etcd's raft MsgSnap
- Rows: every row but OBJ, V4, BUY (17).
- Model: none in this study.
- Settled by: both counters.

**PreVote and CheckQuorum** (`raft-prevote-checkquorum`, L1)
- State: Not durable: each replica's election timer, and the leader's record of which voters it heard from within the election timeout.
- Rules: A replica asks for pre-votes before it raises its term. A leader that has not heard from a majority steps down; the check runs every E/4, and on a quiet group it reads the link pings (A-02).
- Not novel. Precedent: a: Ongaro's thesis, section 9.6 (PreVote) and section 6.2 (a leader steps down when it has not heard from a majority for an election timeout); etcd's raft, Config.PreVote and Config.CheckQuorum (raft.go, read here). / b: Ongaro's thesis section 9.6 (PreVote); etcd's raft Config.PreVote and Config.CheckQuorum; CockroachDB's quiesced ranges, which lean on node or store liveness while a range does not tick
- Rows: every row but OBJ, V4, BUY (17).
- Model: none in this study.
- Settled by: both counters.

**Leader transfer** (`raft-leader-transfer`, L1)
- State: Not durable: a transfer in flight (its target, and the leader's stop on new writes).
- Rules: The leader stops taking writes, brings the target up to its log end and sends TimeoutNow, so the target stands at once. Writes caught in the transfer are refused, never dropped (A-02).
- Not novel. Precedent: a: Ongaro's thesis, section 3.10 (leadership transfer, TimeoutNow); etcd's raft, MsgTransferLeader and MsgTimeoutNow; a proposal that arrives while a transfer is under way is dropped with ErrProposalDropped (raft.go, read here, line 1304), which the caller sees as a refusal. / b: Ongaro's thesis section 3.10 (leadership transfer, TimeoutNow); etcd's raft MsgTransferLeader, MsgTimeoutNow, and ErrProposalDropped for a write caught in a transfer
- Rows: every row but OBJ, V4, BUY (17).
- Model: none in this study.
- Settled by: both counters.

**Quiet groups** (`quiet-groups`, L1)
- State: Per group: whether it is quiet, and the offset it went quiet at ('quiet at i').
- Rules: A leader with no writes for two ticks, whose live voters all hold its commit offset, tells them 'quiet at i' and stops sending. Any write or read index wakes it; a follower below i asks to wake; a returning link reports log ends.
- Not novel. Precedent: a: CockroachDB's quiesced ranges (pkg/kv/kvserver/replica_raft_quiesce.go: a leader with nothing pending, whose live followers are caught up, sends a quiesce heartbeat and stops; a lagging follower is told so it can ask to wake; any proposal or message wakes the range). For PD: TiKV's hibernate regions (tikv/rfcs, text/0023-hibernate-raft.md, read here). / b: CockroachDB's quiesced ranges (pkg/kv/kvserver/replica_raft_quiesce.go: the leader quiesces when it has nothing pending and its followers hold the commit index; any proposal or message wakes it); TiKV's hibernate regions
- Rows: every row but ISR, SLOG, OBJ, V4, BUY (15).
- Model: none in this study.
- Settled by: both counters.

**Slow-leader rule, the controller's form** (`slow-leader-controller`)
- State: No durable or replicated state is named (A-03 leaves open whether this is a mechanism): a latency score per member, kept by the controller.
- Rules: The controller moves leadership away from a member that is much slower than its followers. The rule was named, not built or modelled.
- Not novel. Precedent: a: TiKV's slow score and PD's evict-slow-store-scheduler (TiDB docs, from v5.2.0: each store reports a score from 1 to 100; at 80 or more, and when only one store is slow, PD moves the leaders off it). Confirmed by search. / b: TiKV and PD: each TiKV store computes a slow score (1 to 100) and reports it; PD's evict-slow-store-scheduler evicts the leaders from the one store whose score reaches 80 (TiDB docs: slow node detection since v5.2.0, PD scheduling)
- Rows: MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE (10).
- Model: none in this study.
- Settled by: both counters.

**Slow-leader rule, the leader's own form** (`slow-leader-self`)
- State: No durable or replicated state is named (A-03 leaves open whether this is a mechanism): a latency score per member, kept by each leader.
- Rules: A leader that is much slower than its followers hands leadership over by itself. The rule was named, not built or modelled; no precedent is on offer for this form.
- Not novel. Precedent: CockroachDB's lease shedding on IO overload, read at its source on 2026-11-10 (master, pkg/kv/kvserver/allocator/allocatorimpl/allocator_scorer.go: ExistingLeaseCheck, with kv.allocator.lease_io_overload_threshold_enforcement = shed, whose default there is shed, and kv.allocator.lease_shed_io_overload_threshold, default 0.4). A leaseholder store whose own IO overload score (which adds a disk-unhealthy score) is at or above the threshold and above 1.75 times the mean of comparable stores sheds its leases to stores that are not overloaded. Each range's own leaseholder runs the check; there is no controller. PR 117703 lowered the threshold while the setting was still off by default.
- Rows: DRAFT, CELL, LANE, SPLIT, COMP (5).
- Model: none in this study.
- Settled by: the referee (section 4).

**Member records in #meta** (`meta-members`, L1)
- State: Per member in the metadata group: id, life, disk incarnation, roles, addresses, code hashes, and its state mark (live, draining, retiring, gone).
- Rules: A joiner writes its own record. The metadata group's leader (or a hint) marks a member gone when its links have not reached it for evict.after, and clears the mark when that life returns. A leave marks itself retiring first.
- Not novel. Precedent: a: Kafka KRaft's broker registration (KIP-631: RegisterBrokerRecord with the broker id, an incarnation id per start, endpoints, features, and the fenced and controlled-shutdown marks; the controller fences a broker whose heartbeats stop); CockroachDB's liveness records with their draining and decommissioning marks. / b: Kafka KRaft broker registration records (KIP-631: broker id, incarnation id, epoch, endpoints, features, fenced, in controlled shutdown); CockroachDB's node liveness records (epoch, draining, membership: active, decommissioning, decommissioned)
- Rows: every row but V4 and BUY (18).
- Model: none in this study.
- Settled by: both counters.

**Resource catalog in #meta** (`meta-catalog`, L1)
- State: Per resource in the metadata group: name, config (slots, copies, standbys, durability, history, rules), allowed code hashes, seed applied, write gate.
- Rules: The first fero(name, opts) that creates a resource writes its record, with its first group and that group's slots. A later open that differs is refused; alter changes it online.
- Not novel. Precedent: a: Kafka KRaft's TopicRecord, PartitionRecord and ConfigRecord (KIP-631: a create writes the topic with its first partitions; a second create is refused; AlterConfigs changes it online); CockroachDB's system.descriptor with zone configs. / b: Kafka KRaft TopicRecord, PartitionRecord and ConfigRecord in the metadata log (a topic is created on first use, a second create is refused); NATS JetStream stream configs (a create with a different config is refused); CockroachDB descriptors
- Rows: every row but V4 and BUY (18).
- Model: none in this study.
- Settled by: both counters.

**Group directory in #meta** (`meta-directory`, L1)
- State: Per group in the metadata group: its resource, its incarnation, and its last known replicas and leader. It is a routing hint; the group's own log is the truth.
- Rules: A group's leader refreshes its record after each change, the newest config winning. A recovery raises the incarnation. A group's record is deleted once the slot table has shown none of its slots for settle.ms and its history is safe.
- Not novel. Precedent: a: TiKV PD's region table (each region's leader reports its peers, leader and region epoch in RegionHeartbeat; PD keeps the report with the newest epoch and hands it to clients as a route; the region's own Raft log stays the truth). For the forced recovery that raises the incarnation: TiKV's unsafe-recover and CockroachDB's 'debug recover'. From memory. / b: TiKV PD's region records, refreshed by each region leader's heartbeat with the newest region epoch winning; CockroachDB's meta2 range descriptors, used as routing hints while the range itself is the truth
- Rows: every row but V4 and BUY (18).
- Model: none in this study.
- Settled by: both counters.

**Writer epoch on log members (rlog)** (`writer-epoch-rlog`)
- State: In the log group's log: writer entries, each naming the server that is the group's writer and its epoch; every append carries the writer's epoch.
- Rules: The controller hands the role over only when the writer is gone to it and only to a linked server, by committing a writer entry with the next epoch. The new writer folds to the log's end before it writes, and the log group's leader takes an append only with the latest committed writer epoch (A-14).
- Not novel. Precedent: Amazon MemoryDB (Taleb et al., SIGMOD 2024, DOI 10.1145/3626246.3653380, section 4): the primary is a server outside the transaction log; it takes leadership by appending a leadership entry with a conditional append that names the entry it follows, so only a replica caught up to the log's end can win, and the old primary's appends then fail; leases are renewed by log entries. Checked here through reviews of the paper found by web search (the paper itself and two blogs were not reachable from this session). Kafka's producer epochs (KIP-98): a coordinator bumps the epoch in a committed record, every batch carries it, and the partition leader refuses an older one.
- Rows: RLOG (1).
- Model: E-16: 9 rules by ablation, all needed (9 of 9 non-equivalent mutants)
- Settled by: the referee (section 4).

**Loglets on log nodes** (`loglet`)
- State: Per loglet: its entries on a set of log nodes, and the last entry a write quorum of them holds.
- Rules: The group's writer appends each batch to the loglet's log nodes; a batch is committed when a write quorum holds it on disk.
- Not novel. Precedent: a: Apache BookKeeper ledgers (ensemble, write quorum, ack quorum); Delos loglets (Balakrishnan et al., OSDI 2020). / b: Apache BookKeeper ledgers (an ensemble, a write quorum, an ack quorum); Delos loglets (Balakrishnan et al., OSDI 2020)
- Rows: SLOG (1).
- Model: none in this study.
- Settled by: both counters.

**Seal and recovery** (`loglet-seal`)
- State: Per loglet and log node: a sealed flag; and the recovered end of a sealed loglet.
- Rules: A sealed log node takes no more appends to that loglet. A new writer seals enough nodes to block a write quorum, reads forward to find the end, and writes the tail again to a quorum before the chain is closed.
- Not novel. Precedent: a: BookKeeper's fencing and ledger recovery (the new writer fences enough bookies, reads forward, writes the tail again, then closes the ledger); Delos's seal (OSDI 2020, section 3). The rule 'unknown is not absent' (V5-LOG-FIRST-REVIEW F1) is the one Vanlightly's TLA+ work found for BookKeeper. / b: BookKeeper's ledger recovery (fence the bookies, read forward, write the tail again, close the ledger); Delos's seal and checkTail; Corfu's seal
- Rows: SLOG (1).
- Model: none in this study.
- Settled by: both counters.

**Loglet chain (metadata compare-and-swap)** (`loglet-chain`)
- State: In the metadata group, per data group: the chain of its loglets, each with its log nodes, its start and, once closed, its end.
- Rules: The chain changes only by compare-and-swap: one step closes the open loglet at its recovered end and opens the next on a chosen set of log nodes.
- Not novel. Precedent: a: Delos's VirtualLog: a chain of loglets in the MetaStore, changed by compare-and-swap (OSDI 2020, section 3); Pulsar's managed ledger, a list of ledgers in the metadata store. / b: Delos's VirtualLog MetaStore (a chain of loglets changed by a versioned conditional write); Pulsar's managed ledger list in its metadata store
- Rows: SLOG (1).
- Model: none in this study.
- Settled by: both counters.

**Writer assignment on a shared log (slog)** (`writer-epoch-slog`)
- State: In the metadata group, per data group: the server that is its writer, and the epoch of that role.
- Rules: The controller names a new writer when the old one's session lapses; the new writer seals the open loglet, which fences the old writer. The writer changes its own log nodes; the controller changes writers.
- Not novel. Precedent: a: Apache Pulsar: a broker takes a topic through the metadata store, and opening the topic's ledger with recovery fences the old owner; the writer changes its own ensemble (BookKeeper), the load manager changes owners. From memory. / b: Apache Pulsar: a topic's owner broker is named in the metadata store; a new owner opens the managed ledger, which fences the old owner's ledger; the owner itself changes its bookies
- Rows: SLOG (1).
- Model: none in this study.
- Settled by: both counters.

**Partition log (the leader appends, followers fetch)** (`isr-log`)
- State: Each replica's log of one partition: records with their offsets and the leader epoch they were written in.
- Rules: Only the partition's leader appends; followers fetch from it and append in order.
- Not novel. Precedent: a: Kafka's partition log with leader epochs (KIP-101). / b: Kafka's partition log and follower fetch
- Rows: ISR (1).
- Model: none in this study.
- Settled by: both counters.

**In-sync set** (`isr-set`)
- State: Per partition, in the controller's log: the in-sync replica set.
- Rules: The leader asks the controller to drop a follower that falls behind and to add one that has caught up to the high watermark; only a registered, unfenced replica may join.
- Not novel. Precedent: a: Kafka's in-sync replica set under KRaft (KIP-841, KIP-903). / b: Kafka's in-sync replicas under KRaft (AlterPartition; KIP-841, KIP-903)
- Rows: ISR (1).
- Model: none in this study.
- Settled by: both counters.

**Leader epoch** (`leader-epoch`)
- State: Per partition: the leader and its epoch, set by the controller; each replica keeps the start offset of every epoch.
- Rules: The controller picks a new leader from the in-sync set (or the eligible leaders) and bumps the epoch. A follower truncates its log to the end of the last epoch it shares with the leader before it fetches.
- Not novel. Precedent: a: Kafka's leader epoch (KIP-101, KIP-279, KIP-320). / b: Kafka's leader epoch (KIP-101, KIP-279, KIP-320)
- Rows: ISR (1).
- Model: none in this study.
- Settled by: both counters.

**Eligible leader replicas** (`eligible-leaders`)
- State: Per partition, in the controller's log: replicas that left the in-sync set while holding everything up to the high watermark.
- Rules: When the in-sync set falls below the minimum, the controller keeps the leavers as eligible leaders, and elects only from the in-sync set or from them.
- Not novel. Precedent: a: Kafka's eligible leader replicas (KIP-966). / b: Kafka KIP-966 (eligible leader replicas)
- Rows: ISR (1).
- Model: none in this study.
- Settled by: both counters.

**Log objects (a commit is a PUT)** (`obj-log`)
- State: Per group: its log as numbered objects in the object store.
- Rules: The writer creates the next log object only if it does not exist yet (If-None-Match); a write is committed when that PUT answers.
- Not novel. Precedent: a: Delta Lake's log protocol (Armbrust et al., VLDB 2020, section 3: commit N+1 is a numbered object written with put-if-absent); SlateDB's WAL objects. / b: Delta Lake's commit log (Armbrust et al., VLDB 2020, section 3: numbered log objects, a commit is a put-if-absent of the next number); SlateDB's numbered WAL objects
- Rows: OBJ (1).
- Model: none in this study.
- Settled by: both counters.

**Manifest compare-and-swap** (`obj-manifest`)
- State: Per group: a manifest object that names the log head, the snapshot objects and, with the lease, the writer.
- Rules: The manifest is swapped only if nobody changed it since it was read (If-Match); every change of writer, snapshot or placement goes through it.
- Not novel. Precedent: a: SlateDB's manifest (rfcs/0001-manifest.md: numbered manifest files, changed by compare-and-swap); Apache Iceberg's catalog pointer swap. From memory. / b: SlateDB's manifest (RFC 0001: every change of writer, WAL position or snapshot is a compare-and-swap on the manifest); Apache Iceberg's catalog pointer swap
- Rows: OBJ (1).
- Model: none in this study.
- Settled by: both counters.

**Writer lease and epoch by compare-and-swap** (`obj-writer-lease`)
- State: In the manifest: the writer's lease end and its epoch.
- Rules: A server becomes the writer by swapping the manifest with a higher epoch once the old lease has lapsed. The writer renews before the lease ends and stops writing when it cannot.
- Not novel. Precedent: a: SlateDB's writer_epoch in the manifest (a new writer raises it by compare-and-swap, and the old one is fenced); Azure Event Processor Host's partition leases on blobs (owner, epoch, renew or lose); Gray and Cheriton, 'Leases' (SOSP 1989). From memory. / b: Kubernetes leader election on a Lease object (holder, renew time, lease length, a transition count; taken over by a compare-and-swap once the lease has lapsed; the holder stops when it cannot renew); HashiCorp Vault's GCS backend in HA mode (a lock object, a TTL, generation preconditions)
- Rows: OBJ (1).
- Model: none in this study.
- Settled by: both counters.

**The outside log (NATS JetStream), bought** (`outside-log`)
- State: Everything the bought system keeps: replicated streams with their sequences, its own consensus groups and metadata, its message-id dedup window, consumers and their acks, key-value buckets.
- Rules: Theirs. fero publishes with an expected sequence for a condition, reads streams to fold rows, and uses consumers for delivery; failover, dedup, placement, storage and time are the bought system's.
- Not novel. Precedent: a: NATS JetStream itself, a production system. / b: NATS JetStream itself (a bought production system; E-44 ran fero's patterns on 2.10.22)
- Rows: BUY (1).
- Model: none in this study.
- Settled by: both counters.

### V: replica kinds

**Learners (non-voting replicas)** (`learners`, L1)
- State: The group's non-voting replicas: they copy the log, and fold where the row folds on replicas (in SLOG and RLOG they are the servers).
- Rules: A new replica joins as a learner and is promoted only once it has caught up. A learner grants a vote when asked and never stands (A-01).
- Not novel. Precedent: a: Ongaro's thesis, section 4.2.1 (a new server catches up as a non-voting member first); etcd's learners (etcd v3.4 learner design; raft.go, Step: 'learners must be allowed to cast votes', read here, line 1223); CockroachDB's non-voting replicas. / b: Ongaro's thesis section 4.2.1 (non-voting members catch up first); etcd learners (v3.4 design); etcd's raft, raft.go Step: a learner answers a vote request and never campaigns
- Rows: every row but ISR, OBJ, V4, BUY (16).
- Model: E-14b (TLC): 'learners grant votes' is 1 of the 16 membership rules
- Settled by: both counters.

**Log replicas (the witness): lead only to repair** (`log-replicas`, L1)
- State: Which voters of a group are log replicas: they vote and keep the log tail, but never fold rows or serve clients.
- Rules: A log replica stands only when no full voter has won an election for twice election.ms. When it leads it commits an entry of its own term, brings a full voter up to date (or adds one from the object store's snapshot and its own tail), hands it leadership, and takes no client write.
- **Novel.** None (both counters). Nearest: witnesses that vote and keep the log but hold no rows (Harp, Spanner, Megastore) never lead; here a log replica leads, only to repair. TiKV's witness could not be checked by either counter.
- Rows: DRAFT, CELL, LANE, SPLIT (4).
- Model: none in this study.
- Settled by: both counters.

### C: the control plane

**Link pings (one ping per member pair)** (`link-pings`, L1)
- State: Per pair of members that share a group: whether the link is up and when it last answered, as each side sees it; the pings also carry each side's clock.
- Rules: Two members of one cluster that share a group ping every ping.ms when no other frame went their way; a peer silent past evict.after is gone to this member. Past 100 members a bound on linked peers per member is needed (A-12, a placement rule).
- Not novel. Precedent: a: CockroachDB's store liveness (pkg/kv/kvserver/storeliveness and the leader-leases design, v24.3: one heartbeat per pair of stores, shared by every range the two share), and CockroachDB's RPC heartbeat, whose answer carries the server's clock for the RemoteClockMonitor (pkg/rpc/heartbeat.proto). Cited from memory; DESIGN-V5 4.2 names store liveness too. / b: CockroachDB: pkg/rpc heartbeat (one ping per node pair; PingRequest and PingResponse carry the sender's clock, read by RemoteClockMonitor in pkg/rpc/clock_offset.go) and store liveness (pkg/kv/kvserver/storeliveness: one heartbeat per store pair, shared by every range)
- Rows: every row but PD, ISR, SLOG, OBJ, V4, BUY (14).
- Model: none in this study.
- Settled by: both counters.

**Healing by each group's leader** (`healing-self`, L1)
- State: Its steps are config entries in the group's own log. It keeps no other state: the target is computed from the ring over the members in #meta, or read from a stored placement.
- Rules: From its own links the leader adds a learner when a voter is gone, promotes it once caught up, then removes the gone or surplus voter once the voters left answer and hold the commit offset; it grows before it shrinks (A-01, A-19). It hands leadership back to the preferred leader after settle.ms.
- Not novel. Precedent: a: CockroachDB's replicate queue (pkg/kv/kvserver/replicate_queue.go with the allocator): each range's leaseholder, with no controller, replaces a voter on a dead store by adding a learner, promoting it once it has caught up, then removing the old voter; filterUnremovableReplicas refuses a removal that would leave too few up-to-date voters; GetNeededVoters keeps the voter count odd. Kafka's preferred-leader election for the hand-back. The target by rendezvous hashing is Thaler and Ravishankar (1998), as Dynamo's ring picks a key's replicas. Function names are from memory; the order 'up-replicate, then remove once the new replica has caught up' is in CockroachDB's replication-layer doc (found by search). / b: CockroachDB's replicate queue and allocator, run by each range's leaseholder (pkg/kv/kvserver/replicate_queue.go; allocatorimpl Allocator.ComputeAction: AddVoter, ReplaceDeadVoter, RemoveDeadVoter, RemoveVoter, RemoveLearner; filterUnremovableReplicas keeps a removal from leaving too few live, caught-up voters); Kafka's preferred leader election for the hand-back after settle.ms
- Rows: DRAFT, CELL, LANE, SPLIT, COMP (5).
- Model: E-16: 14 rules by ablation (16 of 17 mutants caught); v5-spec/healing.py checked the draft's text before A-01 and A-19
- Settled by: both counters.

**Controller loop with commands checked by config epoch** (`controller-commands`)
- State: The controller's list of live commands in the metadata group, each naming the group's config epoch it was decided at.
- Rules: The loop on #meta's leader (or a separate controller) decides each change from its own links and the reported config, and writes a command. The group's leader runs it only if the epoch still matches and its own links agree (gone for a removal, alive for a promotion); a command the group refuses times out (A-20).
- Not novel. Precedent: a: TiKV PD's operators (pd, pkg/schedule/operator: AddLearner, PromoteLearner and RemovePeer steps, one operator per region, sent to the region's leader, refused there when the region epoch has changed, dropped on a timeout), with TiKV's own check at the leader that the voters left healthy still make a quorum (raftstore, check_conf_change). Kafka KRaft's reassignment records are a durable list of the same kind. From memory; E-16 cites the same. / b: TiKV PD operators (one per region, built on a region epoch, dropped on timeout) with TiKV's checks where the command runs (the region epoch check; raftstore check_conf_change refuses a change that would leave no healthy quorum); Kafka KRaft keeps reassignments as records in the metadata log, checked by partition epoch
- Rows: MIN, RUST, SRV, LEAN, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE (13).
- Model: E-16: 18 rules by ablation (16 with a counterexample; 12 of 21 mutants caught, 9 undecided)
- Settled by: both counters.

**Planner hints, checked against the config they name** (`planner-hints`, L1)
- State: Hints written to #meta (drain, retire and gone marks on member records; the planner's lease row in the cluster record), and a placement target and preferred leader stored in the group's log. A move hint takes the move lease like any mover.
- Rules: Anything holding the admin key sends a hint that names the group config it read. The group applies it only if its config is still that one, else refuses stale-plan; a leader whose link to a member is up ignores a gone hint. A lease row keeps two planners apart.
- Not novel. Precedent: CockroachDB, a cluster that heals itself with no planner and takes operator commands: node drain (gives up leases, keeps replicas), node decommission and recommission (a mark in the liveness record; each range's replicate queue then moves replicas off), zone configs with constraints and lease_preferences (a stored target and a preferred leaseholder that each range's leaseholder follows), and AdminChangeReplicasRequest.exp_desc ('If the range descriptor is not identical to ExpDesc ... the request will fail', pkg/kv/kvpb/api.proto, read at the source on 2026-11-10). A lease row that keeps two deciders apart is Kubernetes' leader-election Lease.
- Rows: DRAFT, LANE, SPLIT, COMP (4).
- Model: none in this study.
- Settled by: the referee (section 4).

**Sessions to the controller (the failure detector)** (`controller-sessions`)
- State: Per member: a session with the controller, kept by heartbeats, with an epoch that rises each time the member registers.
- Rules: A member whose heartbeats stop for the session timeout is fenced; it must register again, with a new epoch, before it leads, writes or joins an in-sync set.
- Not novel. Precedent: a: Kafka's broker heartbeats and broker epoch (KIP-631); ZooKeeper sessions; TiKV's store heartbeats to PD. / b: Kafka KRaft broker heartbeats and broker epochs (KIP-631: a broker whose heartbeats stop is fenced and must register again); TiKV's store heartbeats to PD
- Rows: PD, ISR, SLOG (3).
- Model: none in this study.
- Settled by: both counters.

### G: what one ordered log covers

**Dormant groups** (`dormant-groups`)
- State: Per group: a dormant mark. A dormant group is on disk only (a 24-byte record of term, vote, commit and log end; 57 B in memory) and is loaded on wake.
- Rules: A quiet, fully committed group is written to the dormant store and dropped from memory; the first message, write or open for it wakes it.
- **Novel.** None (both counters). Nearest: TiKV's hibernate regions and CockroachDB's quiesced ranges stop a group's ticks but keep it in memory (quiet-groups' precedent); Orleans grains and Durable Objects unload idle units, which hold no Raft state.
- Rows: DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, SLOG, MIN-TS, RLOG, EMB-V8, SIDE (12).
- Model: none in this study.
- Settled by: both counters.

**Groups owned by the project (pslot)** (`project-groups`)
- State: Per project group: its settings class (copies, durability) and the (resource, slot set) pairs it holds.
- Rules: A new resource's slots start inside an existing group of its class; a different copies or durability forces a group boundary; slot moves split slots off under load, and each move entry names (resource, slot).
- Not novel. Precedent: a: CockroachDB's span-config coalescing (cluster setting spanconfig.storage_coalesce_adjacent.enabled: neighbouring tables with the same span config share one range, a different config forces a range boundary, and load-based splitting cuts a busy part off); TiKV PD's schedule.enable-cross-table-merge; YugabyteDB's colocated tables. Setting names are from memory (a search did not show them); SPACE cites the same two. / b: CockroachDB's span-config coalescing (spanconfig.storage_coalesce_adjacent.enabled): adjacent tables with equal span configs share one range, and a different config forces a range boundary; TiKV's enable-cross-table-merge
- Rows: MIN-P, COMP (2).
- Model: E-17b, E-17c: the move needs 28 rules, the same as `slot` on the same footing (0 more); about 2 placement rules are reasoned, not modelled
- Settled by: both counters.

**Project lanes** (`lanes`)
- State: A fixed number of groups per project (64) and the hash that maps every (resource, partition) onto one of them; copies and durability are project-wide.
- Rules: The lane count is fixed when the project is founded; every write hashes to its lane; a lane never moves, splits or goes away.
- Not novel. Precedent: a: Temporal's and Cadence's history shards (numHistoryShards is fixed when the cluster is made and never changes; every workflow of every namespace hashes onto one shard; each shard has one owner). Also Kafka's __consumer_offsets topic: a fixed 50 partitions that every group hashes onto. From memory. / b: Fixed hash partitioning: Elasticsearch primary shards (the count is fixed when the index is made; hash of the routing key modulo the count); Kafka's default partitioner; Redis Cluster's fixed 16,384 slots shared by every key
- Rows: LANE (1).
- Model: E-17b: lanes with a range move need 28 rules (30 in a real log); the LANE row holds no range move, so its count is fixN's 13
- Settled by: both counters.

### P: how partitions map onto groups

**Slot table** (`slot-table`, L1)
- State: In #meta, per slot of a resource: the group that holds it open, or is about to. Each write carries a version (slot epoch, move name, writer incarnation, step) and #meta keeps the highest.
- Rules: The target writes s to B before it opens; after an abort it writes s to A back before A reopens; a recovery writes the row at the slot's new epoch. So the table is never behind an open.
- Not novel. Precedent: a: Redis Cluster's slot map (Redis Cluster specification, 'Hash slots configuration propagation': a slot changes owner only on a claim with a higher configEpoch; a migration ends with CLUSTER SETSLOT and an epoch bump); MongoDB's config.chunks (the config server's row per chunk with a chunk version; a migration commits by writing that row, and a donor that failed over reads it to learn whether the move happened). MongoDB from memory. / b: Redis Cluster's slot map with config epochs (cluster spec: a claim for a slot with a greater configEpoch wins; CLUSTER SETSLOT); Couchbase's vBucket map (1,024 vBuckets to nodes, versioned by the cluster manager)
- Rows: DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP (13).
- Model: E-15 (TLC and slot_move.py): inside the move's 31 rules ('whenever a group holds s open, the table names it')
- Settled by: both counters.

**Slot move (the move record: export, import, fence, copy, open)** (`slot-move`, L1)
- State: The entries of one move in the source's and the target's logs: exporting, importing, fenced(N), the copy and END(N), open, and cancel, abort or unfenced; and the carried set.
- Rules: The source fences the slot once, on the target's ready report, and takes no write to it from then. The target opens it once, only after the fence, the delta and the carried set are committed in its own log; one decider gives a move up (A-17). The carried set is the slot's sequence and epoch, dedup outcomes and floors, the lock fence table, the srchi marks and the segment names; a new epoch is recorded in the restore mark before use (A-08).
- **Novel.** None (both counters). Nearest: MongoDB's moveChunk (it even carries retryable-write history), Couchbase's vBucket takeover, Redis Cluster's MIGRATING and IMPORTING, Spanner's movedir. None has these entries in two Raft logs, the fence as the decision, the once guards, one give-up decider and this carried set; the rules were found here by model checking (E-15, E-17c).
- Rows: DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP (13).
- Model: E-15: TLC agrees with slot_move.py on 74 runs, 31 rules with unclean recovery, cancel and abort; E-17c: 28 rules by ablation, crash-only, no give-up (26 on the shared bounds; 33 to 34 with one give-up decider), counting the 13 rules of a plain write path (fixN)
- Settled by: both counters.

**Move policy (who decides the moves)** (`move-policy`, L1)
- State: No durable state beyond the promise of one move at a time (a lease row in #meta in DRAFT; the mover's one pending proposal elsewhere); load per slot and group is kept in memory.
- Rules: One slot at a time, from the busiest group to the least loaded, and only when the move wins by a margin (A-18); a grow makes a new group and a shrink deletes one. Run by the controller, by one loop on #meta's leader that only proposes moves (COMP), or by each group's leader (DRAFT).
- Not novel. Precedent: a: MongoDB's balancer (it runs on the config server's primary, moves a chunk from the shard with the most to the shard with the least only when the difference passes a migration threshold, and a shard takes part in one migration at a time); TiKV PD's balance-region and hot-region schedulers, with tolerant-size-ratio as the margin; Slicer's weighted-move (Adya et al., OSDI 2016, section 4.4). For a rule that each leader runs alone: CockroachDB's store rebalancer and load-based splitting. From memory. / b: TiKV PD's balance-region and hot-region schedulers (move from the most loaded store to the least, with tolerant-size-ratio as the margin, under schedule limits); CockroachDB's allocator rebalance threshold and load-based splitting and merging; redis-cli --cluster rebalance --cluster-threshold
- Rows: DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP (13).
- Model: none in this study.
- Settled by: both counters.

**Re-key into a new generation** (`rekey`, L5)
- State: The entries of one re-key (rk, cut, frz, cp, flip) in the old and the new groups' logs, and the catalog's generation pointer.
- Rules: Copy every partition into a new generation with more groups, freeze the old one, then flip the catalog pointer once the copies are committed; one re-key at a time. A cursor of another generation is refused and restarts from a snapshot.
- **Novel.** None with the same rules. Nearest: Vitess Reshard (VReplication copies, SwitchTraffic stops writes and flips the routing rules) and MongoDB's reshardCollection (clone, a short write block, a catalog swap). They do the same job by other rules.
- Rows: CELL (1).
- Model: E-17, E-17c: 35 rules by ablation as written, 29 with positions carried (36 to 38 and 30 to 32 in a real log), counting fixN's 13
- Settled by: the referee (section 4).

**Split (the split record)** (`split-record`)
- State: The entries of one split in the parent's and the child's logs (spl, and init with the carried dedup and fence state).
- Rules: A group splits only a range it holds. The parent takes no write to the split-off range once the split entry is in its log; the child starts once, from a committed split, carrying dedup and fence state. A split copies no rows.
- Not novel. Precedent: a: TiKV's region split (the BatchSplit admin command goes through the region's Raft log; each replica that applies it makes the child's peer from its own data, so nothing is copied); CockroachDB's AdminSplit with its split trigger, which also hands the child its share of per-range state (the abort span). From memory. / b: CockroachDB's AdminSplit and split trigger (pkg/kv/kvserver/batcheval/cmd_end_transaction.go: the right-hand range starts once, from the committed split; no rows are copied; per-range state such as the abort span is copied to it); TiKV's BatchSplit
- Rows: SPLIT, PD (2).
- Model: E-17b, E-17c: split + merge needs 33 rules by ablation (37 in a real log): a 9-rule split, an 11-rule merge and lineage, counting fixN's 13
- Settled by: both counters.

**Merge (the merge record)** (`merge-record`)
- State: The entries of one merge (mrg, sub, mgd) in the two groups' logs.
- Rules: The group to be removed freezes only for a committed merge; the survivor takes its rows and carried state once and gives the merged range a new generation.
- Not novel. Precedent: a: TiKV's region merge (PrepareMerge freezes the source at a committed index; CommitMerge at the target takes its data once; the merged region's epoch rises); CockroachDB's range merge (the Subsume request freezes the right-hand range). From memory. / b: TiKV's region merge (PrepareMerge freezes the source, CommitMerge runs in the target, RollbackMerge); CockroachDB's AdminMerge with Subsume
- Rows: PD (1).
- Model: E-17b, E-17c: an 11-rule merge inside split + merge's 33 rules (37 in a real log)
- Settled by: both counters.

**Range table (which group holds which range)** (`range-table`)
- State: Per group: the key or hash range it holds and a generation that rises on every split or merge (CockroachDB's range descriptors; the version half of TiKV's region epoch).
- Rules: A split or a merge writes the new ranges with a higher generation; a route or a command made on an older generation is refused and refreshed.
- Not novel. Precedent: a: CockroachDB's range descriptors, with a generation that rises on every split and merge; TiKV's region epoch (its version half). / b: CockroachDB's range descriptors with a generation that rises on every split and merge; TiKV's region epoch (version)
- Rows: SPLIT, PD (2).
- Model: none in this study.
- Settled by: both counters.

**Split policy (who decides the splits and merges)** (`split-policy`)
- State: No durable state: size and load per group, kept in memory.
- Rules: A group splits when it passes a size or load limit: each leader decides in SPLIT; in PD the controller's schedulers also decide merges. It is listed so that splits are counted as A-18 counts slot moves.
- Not novel. Precedent: a: CockroachDB's size-based and load-based splitting (range_max_bytes; kv.range_split.by_load_enabled), decided by each range's leaseholder, and its merge queue; TiKV's split checker and PD's merge checker. / b: CockroachDB's split queue (by size and by load) run by each leaseholder, and its merge queue; PD's merge checker
- Rows: SPLIT, PD (2).
- Model: none in this study.
- Settled by: both counters.

### O: positions

**Slot sequence** (`slot-sequence`, L2)
- State: Per slot: the last sequence number stamped, read with the slot's epoch. A position is (epoch, sequence); versions, cursors and fence tokens are positions.
- Rules: The slot's writer stamps each record with the slot's next sequence. The sequence never goes back and travels with the slot.
- Not novel. Precedent: a: Couchbase's per-vBucket sequence numbers and vBucket UUIDs (kv_engine, docs/dcp/documentation: commands/failover-log.md and commands/stream-request.md; confirmed by search). Each of the 1,024 vBuckets has its own sequence that only rises. A position is (vBucket UUID, seqno). The UUID changes when a vBucket becomes active or stops uncleanly, so no position names two histories. The sequence stays with the vBucket when it moves to another node. DCP cursors and mutation tokens are these positions. / b: Couchbase DCP (kv_engine docs/dcp): every mutation in a vBucket, one of 1,024 fixed hash buckets, gets that vBucket's next sequence number from the active node; a position is (vBucket UUID, seqno) with a failover log; the numbers and the failover log go with the vBucket when it moves between nodes. Kafka's (leader epoch, offset) per partition is the same pair (KIP-101, KIP-320)
- Rows: DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP (13).
- Model: E-15, E-17c: inside the move's rules (1 rule carries the sequence; 'no sequence is stamped by two groups'); E-31: cursors must be per-slot sequences (group offsets break in 5 steps)
- Settled by: both counters.

**Lineage** (`lineage`)
- State: Kept for ever: for each group made by a split, its parent and the offset base at which it took over.
- Rules: A base is written once, when the child starts. A reader's cursor of (generation, group, offset) is resolved through the lineage from the parent to the child.
- Not novel. Precedent: a: Amazon Kinesis shard lineage (Kinesis API: a Shard has ParentShardId, AdjacentParentShardId and a SequenceNumberRange; a consumer finishes the parent before it reads the children); DynamoDB Streams' shard lineage; Pravega's segment successors. / b: Amazon Kinesis shards (API type Shard: ParentShardId, AdjacentParentShardId, SequenceNumberRange.StartingSequenceNumber; a reader finishes the parent, then goes on in the children); DynamoDB Streams has the same; Pravega's segment successors
- Rows: SPLIT (1).
- Model: E-17b, E-17c: 2 lineage rules on the shared bounds, 3 with a reader across a merge
- Settled by: both counters.

**Timestamp positions with closed timestamps** (`closed-timestamps`)
- State: Per group: a closed timestamp below which no new write will commit; positions are commit timestamps.
- Rules: The leader advances the closed timestamp as the locks below it resolve; replicas serve reads and change feeds at or below it.
- Not novel. Precedent: a: CockroachDB's closed timestamps (RFC 20180603_follower_reads.md); TiKV's resolved-ts. / b: CockroachDB's closed timestamps; TiKV's resolved timestamp
- Rows: PD (1).
- Model: none in this study.
- Settled by: both counters.

### K: where semantics live

**Judging at the one writer (conditions, ops, claim, batch)** (`writer-judging`, L2)
- State: Not durable: the writer's log-end state, the fold of its committed state plus its uncommitted tail. Only results are appended.
- Rules: Dedup, shape checks, rules, conditions and ops are judged against the log-end state, in that order, and only for a slot this group holds open. Every answer, a refusal and an empty claim included, is sent only once the log end it was judged on has committed (A-04); a deposed writer answers unknown.
- Not novel. Precedent: a: ZooKeeper's request pipeline (Hunt et al., USENIX ATC 2010, section 4.1, and PrepRequestProcessor.java: the leader judges each request against its future state, that is its state plus the proposals not yet committed, turns it into an idempotent transaction, and the followers apply the result; a request that fails becomes an error transaction that is ordered and answered after commit). Also CockroachDB's proposer-evaluated KV (RFC 20160420_proposer_evaluated_kv.md). / b: ZooKeeper's request pipeline (PrepRequestProcessor judges each request against its outstanding, not yet committed changes and proposes only the resulting state change; every answer, an error included, leaves in commit order; Junqueira, Reed and Serafini, 'Zab', DSN 2011); CockroachDB's proposer-evaluated KV (RFC 20160420); Kafka's group coordinator runtime (KIP-848), which holds an answer until its records commit
- Rows: every row but BUY (19).
- Model: none in this study.
- Settled by: both counters.

**Consumer groups (#groups: members with leases, a generation, fenced cursors)** (`consumer-groups`, L5)
- State: In #groups, per group: a row with a lease for each member, and a generation. Per consumer: its committed cursor, a row written under a fence on the generation.
- Rules: The assignment of groups or slots to members is a pure function of the live members and the generation. A member whose lease lapses by writer time is dropped and the generation rises. A cursor is written only with a fence on the current generation, so a consumer of an older generation cannot commit.
- Not novel. Precedent: a: Kafka's group coordinator (KIP-62 and KIP-848: members kept by heartbeats under a session timeout, a generation that rises on every change, and an offset commit from an older generation refused with ILLEGAL_GENERATION). / b: Kafka's group coordinator (members kept alive by heartbeats under a session timeout, a generation id, an assignment per generation, OffsetCommit refused with ILLEGAL_GENERATION; KIP-848)
- Rows: every row but V4 and BUY (18).
- Model: E-30 modelled the cursor and the marks, not the membership
- Settled by: both counters.

### D: dedup and exactly once

**Dedup window (issuer window, floor, outcomes by id, per-hop time budgets)** (`dedup-window`, L2)
- State: Per group, tagged by slot: per issuer the highest call id seen and every committed outcome above the floor; an issuer silent for the retry horizon is forgotten.
- Rules: An attempt among the outcomes gets its first answer; one at or below the floor (highest id minus the window) is refused stale-attempt; a resent attempt's refusal is appended. Each copy carries a time budget that every hop cuts, and a relay forwards a copy once.
- **Novel.** None (both counters). Its parts are known (Kafka's last five batches per producer, NFSv4.1's session slots, deadlines cut at each hop); the set (a floor at the highest id minus a window, refusals of resends kept as outcomes, per-hop time budgets, forward-once) is the draft's own.
- Rows: DRAFT, LANE, SPLIT, SLOG, V4 (5).
- Model: E-20: 17 rules by ablation (19 under `fwd`)
- Settled by: both counters.

**Client sessions** (`client-sessions`, L2)
- State: A session registry (#sessions: per client life, a lease it renews), and per group, tagged by slot: per session the outcomes at or above the client's floor (its lowest unacknowledged id), and that floor.
- Rules: Apply an attempt only when it is not among the session's outcomes, above its floor, and while the session lives; a copy at or below the floor is answered stale. A session expires by the registry's writer time, and unknown is answered only once that expiry has committed; a restarted process takes a new session. Under `fwd` a relay forwards a copy once (A-21).
- Not novel. Precedent: a: Ongaro's thesis, section 6.3 (a session per client, serial numbers, cached answers; the client's lowest unanswered number lets the server drop older answers; sessions expire by a time agreed through the log), and LogCabin. RIFL (Lee et al., SOSP 2015, sections 3 and 4: completion records per client, the client's first incomplete id, client leases at one lease server, and completion records that move with the object when it migrates). / b: Ongaro's thesis section 6.3 (a session per client, a serial number per request, cached answers, the client's lowest unanswered number as the floor, expiry by a time agreed through the log); LogCabin
- Rows: MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP (12).
- Model: E-20: 13 rules by ablation (14 under `fwd`, the hop rule partly reasoned)
- Settled by: both counters.

**Producer id, epoch and sequence** (`producer-state`)
- State: Per (producer, partition): the producer's epoch and last sequence, with its last cached batches; producer ids are handed out by the controller.
- Rules: Accept the next sequence, absorb a duplicate, refuse a gap. A give-up bumps the epoch and restarts the sequence (KIP-360); 'unknown producer' is answered only once the forget has committed (A-22).
- Not novel. Precedent: a: Kafka KIP-98 (producer id, epoch and sequence per partition) and KIP-360 (a give-up bumps the epoch). / b: Kafka KIP-98 (producer id, epoch, a sequence per partition, five cached batches) and KIP-360 (a give-up bumps the epoch)
- Rows: ISR (1).
- Model: E-20: 16 rules by ablation (17 under `fwd`)
- Settled by: both counters.

**Caller keys (idempotency keys for calls)** (`caller-keys`, L4)
- State: Per caller key, for its ttl: a claim with a lease, and the first result (a row in #calls, or a session per call).
- Rules: A call with a key claims its row before its handler runs and stores the result; a retry gets the first result. A re-run after the lease lapses issues the same attempt ids, under a fence on the key.
- Not novel. Precedent: a: Stripe's idempotency keys (Stripe API docs, 'Idempotent requests': the first result is stored under the key and given to retries); AWS Lambda Powertools' idempotency utility (a record is claimed INPROGRESS with an in-progress expiry before the handler runs, then set COMPLETED with the stored result; a changed payload is an error; confirmed by search); Temporal and Restate for a re-run that issues the same ids and is stopped when it diverges. / b: Stripe's idempotency keys (API docs, 'Idempotent requests'); AWS Lambda Powertools idempotency (a conditional claim with an in-progress expiry, then the stored result); for a re-run that must issue the same effects, Temporal's replay against its event history (a command that differs is a non-determinism error)
- Rows: all 20 rows.
- Model: E-20 modelled the `keys` option alone (12 rules by ablation); a caller key beside `sess` or `win` was not modelled
- Settled by: both counters.

**Cursor mark beside the outputs (srchi-slot)** (`srchi-marks`, L2)
- State: Per consumer, source slot and output slot: the highest source sequence applied, written in the output's own entry. Where a row has no slots the key is the output's own moving unit; that carry was not modelled.
- Rules: Apply an output only above the mark and write the source sequence into its entry; commit the consumer's cursor only after every output of the record is answered; carry the slot's marks out with the fence and in with the open.
- Not novel. Precedent: a: KafkaConsumer javadoc, 'Storing Offsets Outside Kafka' (keep the consumed offset in the same store, and the same atomic write, as the results; after a restart skip what is at or below it); Helland, 'Life beyond Distributed Transactions' (CIDR 2007), 'activities': the receiving entity keeps, inside itself, what it has taken from each partner, and that state moves with the entity; Delta Lake's SetTransaction(appId, version) action in its log protocol. / b: Apache Pulsar: PIP-6 keeps, in the output topic's own log, the last sequence id per producer, and Pulsar Functions' effectively-once mode uses one producer per input and the source message id as that sequence id; Delta Lake's transaction identifiers (PROTOCOL.md: appId and version written inside the commit; options txnAppId and txnVersion); KafkaConsumer javadoc, 'Storing Offsets Outside Kafka'
- Rows: all 20 rows.
- Model: E-30: 5 rules by ablation (6 of 6 mutants); real Elle agrees on 2,800 histories
- Settled by: both counters.

### T: time, TTL and leases

**Writer time (the median of the members' clocks)** (`writer-time`, L2)
- State: Per group: the last time stamp t in its log; and each member's view of its peers' clocks, carried forward by its own monotonic clock.
- Rules: The writer stamps each batch with max(last t, the median of the members' clocks); t never goes back, across a handover too. TTL expiry and lease lapse are judged by t on the writer's tick and written as log entries (A-23).
- Not novel. Precedent: a: CometBFT's BFT Time (spec/consensus/bft-time.md: a block's time is the weighted median of the validators' clock readings, and it never goes back; confirmed by search). TigerBeetle's cluster time (src/vsr/clock.zig and 'Three Clocks are Better than One', 2021: each replica samples its peers' clocks on pings, carries the readings by its own monotonic clock, takes the interval most clocks agree on, and the primary's timestamps only rise; confirmed by search). For expiry written into the log by the leader's time: Ongaro's thesis, section 6.3, and Redis, whose master expires a key and replicates the DEL. / b: CometBFT's BFT Time (spec/consensus/bft-time.md: a block's time is the median of the validators' vote times, and it never goes back); Ongaro's thesis section 6.3 for expiry by a time carried in the log; etcd's lease revoke as a log entry
- Rows: every row but PD, V4, BUY (17).
- Model: E-21: 7 rules by ablation, on a seeded simulation (30 seeds in each of nine families), not exhaustive
- Settled by: both counters.

**Timestamp oracle** (`timestamp-oracle`)
- State: In the controller: the last timestamp handed out, and a high-water window saved before it is used.
- Rules: Every transaction takes its start and commit timestamps from the oracle's leader; timestamps strictly rise, across a controller failover too. It is also the time by which TTLs and leases are judged.
- Not novel. Precedent: a: Percolator's timestamp oracle (Peng and Dabek, OSDI 2010, section 2.3); TiKV PD's TSO. / b: Percolator's timestamp oracle (Peng and Dabek, OSDI 2010); TiKV PD's TSO, which saves a window before it hands timestamps out
- Rows: PD (1).
- Model: none in this study.
- Settled by: both counters.

### X: atomicity across partitions

**Lock rows (#locks)** (`lock-rows`, L5)
- State: Per lock: its holder, its lease end and its version; the version is the fence token.
- Rules: A lock is claimed only when its row is absent or its lease has lapsed by writer time; the claim's new version is the token. A saga's locks belong to the unit (A-24); a lock name has one lease (A-10).
- Not novel. Precedent: a: Chubby (Burrows, OSDI 2006, section 2.4: locks and sequencers); etcd's clientv3/concurrency Mutex (a key made only if absent and bound to a lease; its create revision is the fence token). / b: Chubby (Burrows, OSDI 2006: locks with sequencers); etcd's lock on a lease, with the key's revision as the token; Kleppmann, 'How to do distributed locking', 2016
- Rows: every row but V4 (19).
- Model: E-24: inside the saga's 38 rules by ablation; E-21 (simulated) for leases under clock faults
- Settled by: both counters.

**Fence tokens (the fence table)** (`fence-tokens`, L2)
- State: Per group, carried with a moving slot: the highest token seen per lock.
- Rules: A protected write carries its lock's token; the writer refuses a token below the highest it has seen for that lock, and raises the table on a write it takes. A slot move carries the table, merged by max. Writers do not follow #locks (A-24).
- Not novel. Precedent: a: Chubby, section 2.4 (a server checks a sequencer 'against the most recent sequencer that the server has observed'); Kleppmann, 'How to do distributed locking' (2016): the store keeps the highest token it has seen and refuses a lower one. / b: Chubby section 2.4 (a server may check a sequencer against the most recent one it has seen); Kleppmann 2016 (the store keeps the highest token and refuses a lower one); HDFS QJM epoch numbers at the journal nodes
- Rows: every row but PD, V4 (18).
- Model: E-24: inside the saga's 38 rules; E-17: 1 fence-transfer rule in every move; E-21 (simulated): the fence refused every late write under every time rule
- Settled by: both counters.

**Saga intent rows (#sagas)** (`saga-intents`, L5)
- State: Per unit: its steps and its direction (run, undo, then done or undone).
- Rules: Take the unit's locks in key order, write the intent, apply each step under its fence, record done. A holder first resolves another unit's unfinished intent on its partitions; a failed run undoes every step, the failed one and those after it too (A-24).
- Not novel. Precedent: a: Garcia-Molina and Salem, 'Sagas' (SIGMOD 1987): the saga's log and backward recovery. Percolator (Peng and Dabek, OSDI 2010, section 2.2): whoever meets an unfinished transaction resolves it first. For 'undo every step, the ones that never ran too': Seata's TCC mode (seata.apache.org, 'Seata TCC fence', v1.5.1, table tcc_fence_log: Cancel runs for a branch whose Try never arrived, the 'empty rollback', and leaves a record so that a late Try is refused, the 'suspension' case; confirmed by search). Kafka's epoch bump (KIP-98) is the precedent for A-24's other form. / b: Garcia-Molina and Salem, 'Sagas', SIGMOD 1987 (the saga log, backward recovery); Percolator (resolve another transaction's lock first); for 'a failed run undoes every step': the TCC pattern's empty rollback and anti-hanging rules as Apache Seata builds them (tcc_fence_log since 1.5.1: a cancel for a branch whose try never ran writes a marker, and a late try is then refused); Kafka KIP-98's end markers and epoch bump
- Rows: every row but PD, ISR, V4 (17).
- Model: E-24: 38 rules by ablation with 'undo every step' (41 of 44 mutants; 1 novel rule as E-24 counts it); E-22, E-22b (simulated, real Elle)
- Settled by: both counters.

**Two-phase commit (transaction records and intents)** (`two-phase-commit`)
- State: Per transaction: a primary lock and secondary locks (intents) on the keys it writes, and its commit record at the primary.
- Rules: Prewrite every key with a lock that names the primary; commit the primary at a commit timestamp, then the secondaries; a reader that meets a lock resolves it from the primary. A retried commit finds its record: the transaction id is the dedup key.
- Not novel. Precedent: a: Percolator (Peng and Dabek, OSDI 2010, section 2.2); TiKV's transaction model. / b: Percolator (OSDI 2010); TiKV's transactions
- Rows: PD (1).
- Model: none in this study.
- Settled by: both counters.

**Multi-version rows (MVCC)** (`mvcc`)
- State: Per key: its versions by commit timestamp, and a safe point below which old versions are collected.
- Rules: A committed write adds a version at its commit timestamp; a read at timestamp t sees the newest version at or below t; versions below the safe point are collected.
- Not novel. Precedent: a: Percolator's data, lock and write columns (OSDI 2010, section 2.2); TiKV's MVCC with its GC safe point. / b: TiKV's MVCC with a GC safe point; Percolator
- Rows: PD (1).
- Model: none in this study.
- Settled by: both counters.

**Transaction coordinator log** (`ktxn-coordinator`)
- State: Per transactional id, in the coordinator's own log: its producer id and epoch, the transaction's state and the partitions it wrote.
- Rules: The coordinator records begin, then prepare-commit or prepare-abort, writes a marker to every partition and records the end. A new producer with the same id bumps the epoch and fences the old one.
- Not novel. Precedent: a: Kafka transactions (KIP-98: the transaction coordinator and its __transaction_state log). / b: Kafka's transaction coordinator (KIP-98)
- Rows: ISR (1).
- Model: none in this study.
- Settled by: both counters.

**Commit markers and the last stable offset** (`ktxn-markers`)
- State: Per partition: commit and abort markers in its log, and the last stable offset, below which no transaction is open.
- Rules: The coordinator writes a marker for each partition of an ended transaction; a read_committed reader stops at the last stable offset and skips aborted records.
- Not novel. Precedent: a: Kafka transactions (KIP-98: control records and the last stable offset). / b: Kafka's control markers and last stable offset (KIP-98)
- Rows: ISR (1).
- Model: none in this study.
- Settled by: both counters.

### Q: what a commit means

**Memory rung (a replica that stops uncleanly rejoins as new)** (`memory-rung`, L0)
- State: Per replica: whether it stopped cleanly. Under `memory` an acknowledged tail may not be on its disk.
- Rules: A commit under `memory` waits for a majority to hold the entry in memory, with disks within about a second. Each replica marks whether it stopped cleanly. A replica that stopped uncleanly cannot vouch for its log; disk-incarnation's rule then brings it back as a new replica that never votes under its old identity.
- Not novel. Precedent: Kafka with acks=all and no fsync (its default): a record commits once the in-sync replicas hold it in memory; each log dir has a clean-shutdown marker; a broker that stopped uncleanly leaves the eligible leaders (KIP-966) and counts toward commits again only after it has caught up and rejoined the in-sync set. Viewstamped Replication Revisited (Liskov and Cowling, MIT-CSAIL-TR-2012-021, sections 4 and 4.3): commit at a majority in memory, and a replica that crashed takes no part until it has recovered its state from the others. The step 'come back as a new replica' is disk-incarnation's rule (Paxos Made Live, section 5.1; KIP-853), counted there.
- Rows: DRAFT, CELL, SPLIT, COMP (4).
- Model: none in this study.
- Settled by: the referee (section 4).

**None rung (a second delivery path)** (`none-rung`, L3)
- State: Not durable: messages published with durability none go straight to the current subscribers and never enter the log.
- Rules: Publish, then deliver in order per subject to every current subscriber, best effort. It has a failover rule of its own, which nobody has written (K-10).
- Not novel. Precedent: a: Redis sharded Pub/Sub (Redis 7.0, SPUBLISH and SSUBSCRIBE: a channel hashes to a slot; a message goes through that slot's shard to its current subscribers, at most once; a moved slot ends the subscription); NATS core publish and subscribe. / b: Core NATS publish and subscribe (at most once, in order, to the subscribers of the moment); Redis Pub/Sub, which in Redis Cluster is a second delivery path beside the replicated keyspace
- Rows: all 20 rows.
- Model: none in this study.
- Settled by: both counters.

**High watermark** (`high-watermark`)
- State: Per partition: the offset up to which every member of the in-sync set holds the log.
- Rules: The leader advances it to the lowest log end of the in-sync set. A write with acks=all is answered when the high watermark passes it; readers see only records below it.
- Not novel. Precedent: a: Kafka's high watermark with acks=all and min.insync.replicas. / b: Kafka's high watermark with acks=all and min.insync.replicas
- Rows: ISR (1).
- Model: none in this study.
- Settled by: both counters.

### S: storage

**Shared journal (group commit, cuts, segment indexes)** (`journal`, L0)
- State: One journal per process holding every group's entries, terms and votes, chained and checksummed; cut records; then per-group segment files with indexes by offset, slot and partition; one reserve segment.
- Rules: One fdatasync covers a batch, and `persisted` waits for it. A follower writes a cut record before entries that replace its tail; the journal is truncated only once the segments that cover it are fsynced (A-09, A-25).
- Not novel. Precedent: a: Apache BookKeeper's bookie storage (BookKeeper docs, 'Architecture': journals, entry logs, index files: every ledger's entries go to one journal with group commit; the ack waits for the journal's fsync; entries then go to entry logs with an index per ledger; the journal is trimmed only up to a checkpoint that the entry logs and indexes have synced). TiKV's raft-engine (one log for every region's entries and hard state). etcd's WAL for the chained checksum and for a later entry that replaces an earlier tail. EventStoreDB's index from stream to log position, for the index by partition. TiKV's storage.reserve-space, for the reserve. From memory. / b: Apache BookKeeper's bookie (one journal for every ledger, one fsync per batch, then indexed ledger storage; a journal file is removed only after a checkpoint has synced what it covers); TiKV's raft-engine (one log for every region, an index per region); CockroachDB's shared engine (a replaced Raft tail is deleted in the same batch as the new entries) and its emergency ballast file for the reserve
- Rows: every row but PD, ISR, SLOG, OBJ, V4, BUY (14).
- Model: none in this study.
- Settled by: both counters.

**A write-ahead log per group** (`wal-per-group`)
- State: One log file per group (per partition in ISR, per resource in V4).
- Rules: Each group's appends are synced to its own file, so fsyncs grow with groups.
- Not novel. Precedent: a: etcd's WAL; Kafka's log per partition. / b: etcd's WAL; Kafka's per-partition logs
- Rows: ISR, V4 (2).
- Model: none in this study.
- Settled by: both counters.

**LSM store (log and state)** (`lsm-store`)
- State: One LSM tree per member that holds the Raft log and the multi-version rows: memtables, sorted files and their compaction state.
- Rules: Writes go to a write-ahead log and a memtable, then to sorted files; compaction merges files and drops versions below the safe point.
- Not novel. Precedent: a: RocksDB under TiKV; Pebble under CockroachDB. / b: TiKV on RocksDB; CockroachDB on Pebble
- Rows: PD (1).
- Model: none in this study.
- Settled by: both counters.

**Object-store tier (old segments and snapshot layers)** (`tier`, L0)
- State: In the object store: uploaded old segments with their indexes, and snapshot layers with removal markers and merged bases, each named by an entry in the group's log.
- Rules: The leader uploads a segment or a snapshot (put-if-absent) and names it in the log only after the put is confirmed. A replica may drop its log below i only when a reachable snapshot covers i, the segment is uploaded or history allows it, and no slot move or fork still reads it.
- Not novel. Precedent: a: For segments: Redpanda's Tiered Storage (the partition leader uploads a closed segment, then records it in the partition's own Raft log, and local data is deleted only up to what is uploaded; redpanda.com, 'tiered storage architecture deep dive', confirmed by search) and Kafka KIP-405. For snapshot layers against retention and forks: Neon (docs/pageserver-storage.md and the safekeeper: image and delta layers in the object store, merged by compaction; a safekeeper drops WAL only below both backup_lsn, the segment is uploaded, and remote_consistent_lsn, layers that cover it are uploaded; a branch keeps the layers it reads from being collected). Neon from memory. / b: Redpanda's tiered storage (the leader uploads a segment, then replicates an archival metadata command in the partition's own Raft log; local data is dropped only below what is uploaded); Kafka KIP-405; Neon (image and delta layers in the object store, merged in the background; the safekeepers drop WAL only below what the pageserver has made durable in the store; a branch pins its parent's history)
- Rows: every row but PD, OBJ, V4, BUY (16).
- Model: none in this study.
- Settled by: both counters.

**One process per dir: a lock with a lease, and an epoch fence** (`dir-lease`, L0)
- State: Per dir: a lock file with the holder's record (pid, host, start) and a lease that the holder renews from a thread of its own; the lease's epoch, carried in the name of every file; retired-<epoch> directories, each with a boot record that names the end offset the new holder will read to.
- Rules: A process takes a dir only when the lock is free or its holder is gone (its pid gone, or its lease run out), and it takes a new epoch. A holder writes only files of its own epoch. A new holder renames the old epoch's directory to retired-<epoch>, writes and fsyncs a boot record that names it and the end offset, and only then reads it, read-only and never past that end. Files roll by a new file and an unlink, never by truncating in place.
- **Novel.** None that a counter placed. The lock with a lease alone is published (npm's proper-lockfile; sanlock's delta leases); the epoch fence is not.
- Rows: every row but PD, OBJ, V4, BUY (16).
- Model: Not modelled in this study.
- Settled by: the referee (section 4).

### Z: storage faults

**Disk incarnation and checksum (a damaged replica rejoins as new)** (`disk-incarnation`, L0)
- State: Per dir: a random 128-bit incarnation written when the dir is made; per record a checksum and its predecessor's offset.
- Rules: A checksum per entry turns damage into a wipe, and a wiped or new disk takes a new incarnation that never votes as the replica it replaced (A-28). Only a tail that the checksum shows was never acknowledged is cut. The same rule brings back as new a replica that stopped uncleanly under `memory`, and one whose store a failed fsync condemned (DESIGN-V5 4.1: one rule, three triggers).
- Not novel. Precedent: a: Chandra, Griesemer and Redstone, 'Paxos Made Live' (PODC 2007), section 5.1, 'Handling disk corruption': checksums find the damage, a marker tells a wiped disk from a new replica, and the replica rebuilds as a non-voting member (confirmed by search). Alagappan et al., 'Protocol-Aware Recovery' (FAST 2018) lists the same answer among the known ones. Kafka KIP-858's directory id. etcd's chained WAL checksum and its repair of a torn tail. / b: Kafka KIP-853 (a directory id made when the log dir is formatted; a voter is (node id, directory id), so a replaced disk is not the old voter and joins by AddVoter); CockroachDB's StoreIdent (a wiped disk gets a new store id); etcd's WAL (a chained CRC; only a torn tail is repaired, other damage means the member is replaced); Chandra et al., 'Paxos Made Live', PODC 2007, section 5.1 (checksums; a replica that lost its disk state does not vote at first)
- Rows: every row but PD, ISR, OBJ, V4, BUY (15).
- Model: E-37 (TLC on etcd's spec, three voters): 2 rules, both needed
- Settled by: both counters.

**Repair of a damaged entry from a peer (Z par)** (`par-repair`, L0)
- State: Per entry: a checksum and a bad mark; per group: which damaged entries may be the only committed copy.
- Rules: A replica that finds a damaged entry marks it bad, keeps its vote, and fetches the entry from a peer. While the entry may be the only committed copy, the replica does not stand and does not count toward a commit of it (the "possibly committed" rule).
- Not novel. Precedent: Alagappan, Ganesan, Lee, Albarghouthi, Chidambaram, Arpaci-Dusseau and Arpaci-Dusseau, "Protocol-Aware Recovery for Consensus-Based Storage" (FAST 2018), sections 3 and 4: CTRL tells a crash from a corruption by checksums, repairs a faulty entry from a peer, and keeps a node with a faulty entry that may be committed from leading. Built into LogCabin (Raft) and ZooKeeper in the paper; TigerBeetle's VSR repairs the same way in production.
- Rows: no row.
- Model: E-37 (TLC on etcd's spec, three voters, no membership change): 7 rules, each needed; 0 stuck states of 276 two-damage states
- Settled by: the referee (section 4).

### F: where state is folded

**Fold on every full replica** (`fold-all`, L2)
- State: On each full replica: the rows of the partitions its groups hold, folded by `data` from committed records in log order.
- Rules: Apply each committed record once, in offset order, through data's hot lane; never re-run a condition or an op. A new leader folds its whole log before it answers; a moved slot's rows are taken from exactly one group.
- Not novel. Precedent: a: State machine replication as Raft has it (ATC 2014, section 5.3: every server applies committed entries in log order); etcd's apply loop. / b: Raft paper section 5.3 (each server applies committed entries in log order); etcd's apply loop
- Rows: every row but LEAN, OBJ, SIDE (17).
- Model: none in this study.
- Settled by: both counters.

**Fold on the leader only, with one warm standby** (`fold-leader`, L2)
- State: On the leader and on one warm standby: the rows of the group's partitions; the other followers keep the log only.
- Rules: Only the leader and the standby apply committed records. A failover to the standby is warm; to any other replica it is a cold rebuild from a snapshot and the tail, so the standby is required (A-26).
- Not novel. Precedent: a: Kafka Streams with num.standby.replicas=1 (the active task folds; one standby keeps a warm copy from the changelog; any other instance rebuilds cold). / b: Kafka Streams with one standby replica (num.standby.replicas = 1: the active task folds, one standby keeps a warm copy, any other instance rebuilds from the changelog)
- Rows: LEAN, OBJ, SIDE (3).
- Model: none in this study.
- Settled by: both counters.

**Lazy fold on followers** (`fold-lazy`, L2)
- State: On a follower: rows folded behind the log, or on first read.
- Rules: A follower folds when it is asked or idle, and serves a read only once its fold has reached the position asked for.
- Not novel. Precedent: a: Neon's pageserver (it applies WAL when a page is asked for, and a read at a position waits until the WAL up to it has arrived); TiKV's follower read (wait until the apply index reaches the read index). From memory. / b: Tango (Balakrishnan et al., SOSP 2013: an object's view is played forward from the shared log when it is read); TiKV's follower read waits until its applied index reaches the read index
- Rows: OBJ (1).
- Model: none in this study.
- Settled by: both counters.

### W: reads and subscriptions

**ReadIndex** (`raft-readindex`, L1)
- State: Not durable: the leader's pending read requests, each with the commit index it had and the acks that confirm it still leads.
- Rules: The leader confirms with a majority that it still leads (one round, no fsync), then answers once its fold reaches that commit index. The request is the group's own message and wakes a quiet group.
- Not novel. Precedent: a: Ongaro's thesis, section 6.4; etcd's raft, ReadIndex with ReadOnlySafe (raft.go and read_only.go). / b: Ongaro's thesis section 6.4; etcd's raft ReadIndex (ReadOnlySafe)
- Rows: every row but ISR, SLOG, OBJ, V4, BUY (15).
- Model: none in this study.
- Settled by: both counters.

**Subscribe (cursors, snapshot then deltas, END and expired)** (`subscribe`, L3)
- State: Held by the subscriber: a cursor of the cluster id, the resource's incarnation and, per slot, its epoch and the last sequence seen (a durable row only for a consumer). On the server, not durable: the index of partitions to subscribers. AMENDMENTS section 4 lists this piece as no mechanism by DEV-10 (a)'s letter.
- Rules: A ready replica serves up to the commit offset, and never before its fold has reached the cursor. A replica that lacks the reader's next record answers END, and only the leader of the group that holds the slot says expired (A-06). A snapshot replaces; a cursor of an older epoch is refused unknown-log.
- Not novel. Precedent: a: Couchbase DCP (kv_engine, docs/dcp: a stream request carries the vBucket UUID and seqno; a snapshot marker, then mutations; 'stream end' when the vBucket moves; a rollback when the cursor is ahead). Kafka KIP-392 (a follower serves only up to its high watermark; a follower that lacks the offset sends the client to the leader, which alone decides 'out of range') and KIP-320 (a cursor's epoch is checked). Kubernetes list-then-watch with '410 Gone', for a snapshot that replaces. / b: Couchbase DCP stream requests (a cursor of vBucket UUID and seqno; a snapshot marker, then mutations; a stream end when the vBucket moved; a rollback answer); Kafka's fetch from a follower (KIP-392) with leader epoch checks (KIP-320) and committed offsets for a consumer; etcd's watch from a revision, with ErrCompacted
- Rows: every row but V4 and BUY (18).
- Model: E-31: 26 rules by ablation, 27 with the move's carried segment names (31 of 32 mutants)
- Settled by: both counters.

**Lease reads** (`read-lease`)
- State: Not durable: the leader's read lease, a time promise that no other leader exists until it ends.
- Rules: A leader that holds an unexpired lease answers a read from its own state, with no round to the majority. It needs bounded clock drift.
- Not novel. Precedent: a: Ongaro's thesis, section 6.4.1 (leases); TiKV's leader lease; CockroachDB's leaseholder. / b: Ongaro's thesis section 6.4.1 (lease reads); CockroachDB's leases; etcd's raft ReadOnlyLeaseBased
- Rows: PD, OBJ (2).
- Model: none in this study.
- Settled by: both counters.

### Y: how a write reaches its writer

**Forwarding (any server takes a write and forwards it to the leader)** (`route-forward`, L1)
- State: Not durable: a server's route view (from the #meta copy every member follows) and the writes it holds in flight for a leader.
- Rules: A server forwards a write only over the link to the leader it had when it took the write, and each copy only once. A stale route costs one moved; a member that cannot forward refuses at once with a redirect, and never drops or holds the write (A-02, A-21).
- Not novel. Precedent: a: etcd's raft (a follower forwards a proposal to its leader once, and drops it when it knows none); CockroachDB's NotLeaseHolderError redirect; Redis Cluster's MOVED. / b: ZooKeeper followers forward a write to the leader, one hop; etcd's raft forwards a proposal to the leader and answers ErrProposalDropped when it has none; Raft paper section 8 (a follower redirects the client); Redis Cluster's MOVED
- Rows: every row but BUY (19).
- Model: E-20: the hop rule `forward.once` is counted inside each dedup option (1 rule under `sess`, 2 under `win`)
- Settled by: both counters.

**Smart clients (the client caches slot to leader)** (`route-smart`)
- State: In each client: a cached table of slot (or range, or partition) to leader, at most one entry per slot of a resource.
- Rules: The client sends a write straight to the cached leader and follows MOVED or ASK during a move, refreshing its table.
- Not novel. Precedent: a: Redis Cluster clients (MOVED and ASK); Kafka clients' metadata cache; TiKV's client region cache. / b: Redis Cluster clients (a slot table in the client; MOVED and ASK); Kafka clients' metadata cache
- Rows: SRV, PD, ISR, EMB-V8 (4).
- Model: none in this study.
- Settled by: both counters.

### U: where user code runs

**Calls routed to the partition's leader** (`leader-calls`, L4)
- State: Not durable: calls in flight at a partition leader's host.
- Rules: A call goes to its partition's leader and runs there; a call in flight across a handover is refused or re-run at the new leader.
- Not novel. Precedent: a: Orleans (Bykov et al., 'Orleans: Distributed Virtual Actors', MSR-TR-2014-41: a call goes to the grain's one activation; a call cut off by a failure fails and is retried); Cloudflare Durable Objects; Redis Functions, which run at the master. / b: Cloudflare Durable Objects; Orleans grains; VoltDB procedures run at the partition's leader
- Rows: SIDE (1).
- Model: none in this study.
- Settled by: both counters.

### H: where fero runs

**Local seam between the daemon and the app (a shared-memory ring)** (`side-seam`)
- State: Not durable: a shared-memory ring between the host's daemon and the app's Node process, holding batches on their way to the app's L2 and fold, and results on their way back.
- Rules: The daemon holds L0, L1 and fan-out. It hands the app the batches of the groups this host leads and appends only what the app returns (A-30: a ring, not a socket).
- Not novel. Precedent: a: Not a mechanism by DEV-10 (a)'s letter: it names no durable or replicated state. Its nearest published forms: Aeron Cluster (the consensus module and the clustered service are joined by Aeron IPC, a shared-memory ring, so a stalled service does not stop replication), and Dapr's sidecar, which calls the app for the actors placed on its host. From memory. / b: Aeron Cluster (the consensus module and the clustered service are separate agents, or processes, joined by Aeron IPC: shared-memory log buffers); Dapr and Envoy sidecars for the role split
- Rows: SIDE (1).
- Model: none in this study.
- Settled by: both counters.

### M: threads inside one process

**Group-to-worker map (N kernel workers)** (`worker-map`)
- State: Per process: which kernel worker each group is pinned to, with one journal per worker.
- Rules: The main thread routes each message to its group's worker; a group stays on its worker; messages between workers are recorded as inputs.
- Not novel. Precedent: a: Redpanda's shard_table (each Raft group is pinned to one core; cores pass messages with Seastar's submit_to); ScyllaDB's commit log per shard; TiKV's raftstore pool. From memory. / b: Redpanda's shard table (each Raft group is pinned to one core; other cores hand work over with Seastar's submit_to); CockroachDB's Raft scheduler shards
- Rows: SRV, PD, EMB-V8, SIDE (4).
- Model: none in this study.
- Settled by: both counters.

### N: tenancy

**Tenant byte budget on a shared tier or pool** (`tenant-budget`)
- State: No durable or replicated state is named (A-29 leaves open whether this is a mechanism): a byte budget per tenant per second in a process that pools tenants.
- Rules: The tier or pool holds a tenant's bytes back past its budget (about 1 MiB/s of big-record bytes on this disk), so one tenant at its quota does not raise another's p99. A volume per tenant needs no such rule.
- Not novel. Precedent: a: Kafka's quotas (KIP-13: a byte-rate quota per client or user on a shared broker; the broker holds back a client that passes it); Pulsar's publish-rate limits per namespace; CockroachDB's per-tenant admission control. / b: Kafka's quotas (KIP-13: a byte rate per client, held back by the broker); CockroachDB's tenant rate limiter (pkg/kv/kvserver/tenantrate: a token bucket of bytes per tenant)
- Rows: DRAFT, CELL, LANE, SPLIT, SLOG, OBJ, RLOG, EMB-V8 (8).
- Model: none in this study.
- Settled by: both counters.

### On no single axis: every row with the part

**Restore mark in the store's manifest (an epoch high-water mark, and a session generation)** (`restore-mark`)
- State: In the store's manifest (the home is open for rows that need no store): the highest epoch ever used (a slot's epoch; in a row with no slots, its unit's generation or the resource's incarnation); and a session generation that a restore raises.
- Rules: Every new epoch is recorded in the mark before it is used, so a slot move writes it. A restore takes an epoch above the mark and starts a new session generation; a retry from an older generation is refused, and a cursor the history does not hold is refused.
- **Novel.** None with the same rules. Nearest: PostgreSQL's timelines (timeline.c, findNewestTimeLine).
- Rows: every row but PD, V4, BUY (17).
- Model: E-33: 8 rules by ablation (8 of 8 mutants); the store is always reachable in the model
- Settled by: the referee (section 4).

**Fold-version entry** (`fold-version`)
- State: A committed entry in each group's log that names the fold version in force from that offset (data's build and fero's L2 library).
- Rules: A replica never folds an entry under another version than the one in force at its offset, and refuses to serve until it runs that version. A roll raises the version only after every replica has said it can run it.
- Not novel. Precedent: a: etcd's cluster version (set by a request through the Raft log once every member can run it); CockroachDB's cluster version with the per-range Migrate command; Kafka's metadata.version, a FeatureLevelRecord in the KRaft log (KIP-778). / b: Kafka KIP-584 and metadata.version (a finalized feature level is a record in the metadata log, raised only when every broker supports it); etcd's cluster version, set through Raft as the lowest member version; CockroachDB's cluster version; Cosmos SDK x/upgrade (a plan in the log takes effect at a height and an old binary stops there)
- Rows: all 20 rows.
- Model: none in this study.
- Settled by: both counters.

**Admission credits (a credit window on the client wire)** (`admission-credits`, L3)
- State: No durable or replicated state is named (A-07 leaves open whether this is a mechanism): how many writes each client or link may have outstanding, and a budget of TLS handshakes per tick at the edge.
- Rules: A client holds at most its granted number of writes outstanding; the rest wait in the client and fail at their deadline. The server hands out the grant; that part was not built.
- Not novel. Precedent: a: Breakwater (Cho et al., OSDI 2020, sections 4 and 5: the server hands out credits from its own queueing delay; a client sends only with a credit and holds the rest; confirmed by search). HTTP/2's SETTINGS_MAX_CONCURRENT_STREAMS (RFC 9113, section 5.1.2). AMQP 1.0 link credit (section 2.6.7). For the handshake budget: HAProxy's maxsslrate. / b: HTTP/2 SETTINGS_MAX_CONCURRENT_STREAMS (RFC 9113 section 5.1.2) and QUIC MAX_STREAMS (RFC 9000 section 4.6): the server grants how many requests a client may have open; AMQP 1.0 link credit; RSocket's LEASE frame; HAProxy maxsslrate for a budget of TLS handshakes per second
- Rows: all 20 rows.
- Model: none in this study.
- Settled by: both counters.

**Founding by a conditional create of the cluster id** (`genesis-conditional-create`, L1)
- State: The cluster id, created once in the object store (If-None-Match), then held in every dir's boot record and in #meta's first entry.
- Rules: The create succeeds only while no id is stored; the seed whose create succeeds is #meta's only voter; every other seed adopts only the stored id and is added by healing. `seeds` never runs beside a dir that holds an id. On one box the same rule uses an exclusive create of the cluster-id file.
- Not novel. Precedent: a: Patroni's 'initialize' key (Patroni docs, patroni.dcs: initialize() must create the key atomically; the node that wins bootstraps alone and the cluster's system identifier is stored there; every other node joins as a replica only once the key exists; a node whose data carries another identifier is refused; confirmed by search). S3's If-None-Match is the same create-if-absent on an object store. Also Kafka's /cluster/id (KIP-78). / b: Patroni's /initialize key (patroni/ha.py bootstrap): the first node to create the key in the DCS, an atomic create-if-absent, founds the cluster alone and writes its system id there; every other node joins it as a replica; a data dir with another id is refused ('system ID mismatch'). S3's If-None-Match is the same create-if-absent on an object store
- Rows: MIN, RUST, LEAN, SLOG, OBJ, MIN-P, MIN-TS, SIDE, COMP (9).
- Model: E-33: 4 rules by ablation (4 of 4 mutants); one box 4 rules, 5 with the exclusive create (reasoned)
- Settled by: both counters.

**Founding by one fero init** (`genesis-init`, L1)
- State: The cluster id, minted by one operator step, then held in every dir's boot record and in #meta's first entry.
- Rules: Init runs once and mints the id; a seed never founds by itself and adopts only an id it finds at a seed it reaches. `seeds` never runs beside a dir that holds an id. On one box an exclusive create of the cluster-id file founds.
- Not novel. Precedent: a: CockroachDB's 'cockroach init'; KRaft's 'kafka-storage format --cluster-id'; PD's initial-cluster. / b: CockroachDB's `cockroach init` (run once; the cluster id is kept in every store); Kafka KRaft's `kafka-storage format --cluster-id`
- Rows: DRAFT, SRV, CELL, LANE, SPLIT, PD, ISR, RLOG, EMB-V8 (9).
- Model: E-33: 3 rules by ablation (3 of 3 mutants); one box 4 rules, 5 with the exclusive create (reasoned)
- Settled by: both counters.

**Presence: rows that live while a session lives** (`presence-rows`, L2)
- State: Per row written `while: 'session'`: the id of the session it lives by. The session is a row in #sessions with a lease the client renews.
- Rules: Each group's writer follows #sessions. Once a session's lapse has committed there (by #sessions' writer time), the writer removes that session's rows by entries in its own log.
- Not novel. Precedent: a: ZooKeeper's ephemeral nodes (Hunt et al., USENIX ATC 2010, section 2.1: a znode bound to the session that made it, removed when the session ends); etcd keys attached to a lease; across groups, CockroachDB's sqlliveness sessions, which rows in other ranges name and which make those rows void once the session is seen dead (from memory). / b: ZooKeeper's ephemeral nodes (a node carries its session's id and is deleted, through the log, when the session expires); etcd's leases with attached keys; across groups, CockroachDB's sqlliveness sessions (system.sqlliveness; holders elsewhere check the session and clean up its claims)
- Rows: every row but V4 and BUY (18).
- Model: Not modelled in this study.
- Settled by: both counters.

**Cluster version in #meta** (`cluster-version`, L1)
- State: In #meta's cluster record: the cluster version, that is the kernel and protocol version in force. Every frame carries its sender's protocol version.
- Rules: The cluster version is raised only when every member runs a kernel that can speak it. A member that cannot is refused.
- Not novel. Precedent: Kafka's metadata.version (KIP-778; DESIGN-V5 4.2 names it); CockroachDB's cluster version; TiKV PD's cluster-version.
- Rows: every row but V4 and BUY (18).
- Model: Not modelled in this study.
- Settled by: the referee (section 4).

**Cluster credentials in #meta (CA envelopes, join tokens, certificates, the rotating secret)** (`cluster-credentials`, L1)
- State: In #meta: the door secret, current and next; the CA key as envelopes encrypted to each #meta voter's key; single-use join tokens; each member's certificate; revoked certificates.
- Rules: A peer is let in only after it proves it holds the secret. The secret rotates through #meta as current and next, for a window in which both are valid. A join spends one join token and gets the member a certificate of its own. A removed member's certificate is revoked in #meta.
- Not novel. Precedent: a: Docker Swarm mode's built-in PKI (Docker docs, "Manage swarm security with public key infrastructure": the root CA and its key live in the managers' Raft store; a join token carries the CA's digest; each node gets its own certificate at join; tokens and the CA rotate). Consul's gossip keyring for a secret that rotates as install, use, remove. SPIRE's one-time join tokens. From memory. / b: Docker swarm mode (its Raft store holds the cluster CA, the join tokens and the node certificates; `docker swarm join-token --rotate`, `docker swarm ca --rotate`); CockroachDB's join tokens (`cockroach node create-join-token`); kubeadm bootstrap tokens
- Rows: every row but V4 and BUY (18).
- Model: Not modelled in this study.
- Settled by: both counters.

**Queue claims (leases and delivery counts on message rows)** (`queue-claims`, L5)
- State: Per message row of a queue: its claim's lease end and its delivery count. A dead-letter resource holds the rows past the limit.
- Rules: take(n) is one claim at the writer: the first n unclaimed rows, leased from writer time, with the count raised. An ack removes the row; a lapsed lease makes it claimable again; past the limit it moves to the dead-letter resource. A take hands over what it has at once (A-10).
- Not novel. Precedent: Amazon SQS (a visibility timeout per received message, a receive count, a redrive to a dead-letter queue past maxReceiveCount); Redis Streams' pending entries with delivery counts (XCLAIM)
- Rows: every row but V4 and BUY (18).
- Model: Not modelled in this study (E-44 ran the pattern on JetStream).
- Settled by: the referee (section 4).

**Forks (a new resource that starts from the parent's snapshots)** (`forks`, L1)
- State: In #meta, per fork: a new resource whose groups start from named snapshots and segments of the parent's groups.
- Rules: A fork writes one #meta record per group and copies nothing. The parent may not drop a snapshot or a segment that a fork names.
- Not novel. Precedent: Neon's branches (a timeline with an ancestor timeline and an ancestor LSN shares the parent's layers, and GC keeps what a branch still needs); Delta Lake's shallow clones
- Rows: every row but V4 and BUY (18).
- Model: Not modelled in this study (E-06 measured fork cost).
- Settled by: the referee (section 4).

**Recorder of kernel inputs** (`input-recorder`, L0)
- State: Per process: a recording of every kernel input (whole frames, ticks, disk and object-store completions), with bulk bytes named by journal reference.
- Rules: Every input is recorded before the kernel steps on it. The journal is kept for as long as the recorder's window refers to it. A dump replays byte for byte.
- Not novel. Precedent: Aeron Cluster with Aeron Archive (every input to the state machine is recorded in order and can be replayed); VoltDB's command logging (inputs logged, replayed deterministically); rr (record every nondeterministic input, replay exactly)
- Rows: every row but V4 and BUY (18).
- Model: Not modelled; E-42 measured it (1.1 to 1.7 % of a core, 18 of 18 replays byte-identical).
- Settled by: the referee (section 4).

### V4: v4's kernel as it is

**Lanes (per-origin logs)** (`v4-lanes`)
- State: Per author (a member's life): its own numbered log of the changes it stamped, kept by every replica that holds the rows.
- Rules: An author stamps each change with its next ticket in its own lane; replicas copy lanes in ticket order; a restarted member writes under a new lane.
- Not novel. Precedent: a: Bayou (Petersen et al., SOSP 1997, sections 3 and 4: each server's writes carry its id and accept stamp; servers pass them on in that order, so whoever holds one write of a server holds every earlier one); Golding's timestamped anti-entropy (Golding, 1992: a message log per originating site). / b: Bayou (Petersen et al., 'Flexible Update Propagation for Weakly Consistent Replication', SOSP 1997: each server's writes carry its own rising accept stamp and every server holds a prefix of each other server's writes); Golding's timestamped anti-entropy (UCSC thesis, 1992): one message log per originator
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Stamps (per-cell last writer wins)** (`v4-stamps`)
- State: Per cell: the stamp of the change that holds it now: member-list version, ticket number, author.
- Rules: A change replaces a cell's value only if its stamp is newer: version first, then ticket, then author.
- Not novel. Precedent: a: Thomas's write rule (Thomas, ACM TODS 1979) with Lamport's total order (Lamport, CACM 1978: a counter, then the site id); the last-writer-wins register (Shapiro et al., 2011). / b: The last-writer-wins register (Shapiro et al., 'A comprehensive study of Convergent and Commutative Replicated Data Types', 2011) with Lamport's total order (1978); Cassandra's per-cell timestamps; the (view, counter) order of viewstamps (Oki and Liskov, PODC 1988)
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Digests (anti-entropy)** (`v4-digests`)
- State: Per link: a short list, for each author, of the highest ticket this replica holds.
- Rules: After hello, and again after a paused link drains, the two sides swap digests and send what the other lacks.
- Not novel. Precedent: a: Bayou's anti-entropy by version vectors (SOSP 1997, section 3); Golding's summary vectors (1992). / b: Bayou's version vectors in anti-entropy (SOSP 1997); Scuttlebutt digests (van Renesse et al., LADIS 2008), as Cassandra's gossip sends them
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Tombstones** (`v4-tombstones`)
- State: Per removed cell: a deleted-at marker with its stamp.
- Rules: A removal leaves a marker so that an older late change cannot bring the value back; a marker is dropped only once every holder has shown it is past it.
- Not novel. Precedent: a: Wuu and Bernstein, 'Efficient solutions to the replicated log and dictionary problems' (PODC 1984): a delete record is kept until the time table shows that every site has it. / b: Wuu and Bernstein, 'Efficient solutions to the replicated log and dictionary problems', PODC 1984 (a delete record is kept until every node is known to have it); Cassandra's tombstones
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Compaction frontiers** (`v4-frontiers`)
- State: Per (author, row): the point below which a replica has compacted its log.
- Rules: A replica compacts a lane only behind the frontier that every current holder has attested on crash-stable floors.
- Not novel. Precedent: Wuu and Bernstein, 'Efficient solutions to the replicated log and dictionary problems' (PODC 1984): a log record is discarded once the time table shows every site holds it. Golding's acknowledgment vectors (1992).
- Rows: V4 (1).
- Model: none in this study.
- Settled by: the referee (section 4).

**Orphans** (`v4-orphans`)
- State: Per slice: an orphan mark on a copy this replica may no longer serve.
- Rules: A slice is frozen when its keepers were reassigned away or a cancelled copy left partial data; it is copied again from a teacher, or held only until the new keepers prove they have everything.
- **Novel.** None that either counter could name; Riak's ownership handoff is the nearest.
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Sheds** (`v4-sheds`)
- State: Per slice: that a former keeper deleted its copy; per paused link: that its whole queue was thrown away.
- Rules: A former keeper sheds a slice only once every current keeper has proved it holds everything; a shed link queue is healed by a new digest exchange.
- **Novel.** None (both counters): a keeper deletes its copy only on its successors' proof by floors, and a paused link's queue is thrown away and healed by a digest. Riak's handoff is the nearest for the first half.
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Latches** (`v4-latches`)
- State: Per slice being copied: the one chosen teacher, with incoming changes for the slice held to one side; per store: a latch set by a failed fsync.
- Rules: A replica latches onto exactly one teacher and drops copy data from any other; a failed fsync latches the store shut.
- **Novel.** None for the teacher latch (DESIGN-V5 10.1: no literature). Its second half, the fsync latch, is published (PostgreSQL stops on a failed fsync since 2018).
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Teachers** (`v4-teachers`)
- State: Per slice copy: the staged data from the teacher and its end marker.
- Rules: The teacher ships the part of a slice the learner lacks, then a marker for 'everything up to here'; the learner folds the staged copy in at once, never half.
- **Novel.** None (both counters). Near Raft's InstallSnapshot, but it ships only the part of a slice the learner lacks, and its cut sets the learner's floors (DESIGN-V5 10.1).
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Floors** (`v4-floors`)
- State: Per (author, row) and holder: a possession floor and a durable floor, below which that holder holds every change.
- Rules: A holder raises its floors as it receives and syncs changes and attests them to its co-holders (the pp floor law); a teacher's cut sets the learner's floors.
- **Novel.** None (both counters). Acknowledgment vectors are published (Wuu and Bernstein 1984; Golding 1992); the pp floor law, with a possession and a durable floor per (author, row) and holder, is not (DESIGN-V5 10.1).
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**FEED words** (`v4-feed-words`)
- State: Per feeder and spoke (a client and its primary server): the words the feeder owes the spoke about sheds and re-latches of the rows it feeds.
- Rules: A feeder tells its spokes when it shed or re-latched rows, so a spoke resyncs and never keeps rows its feeder dropped; an owed word survives a paused link.
- **Novel.** None (both counters; DESIGN-V5 10.1 lists FEED words among the protocols with no literature).
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**In-sync sets** (`v4-in-sync-sets`)
- State: Per slice: the holders that have proved they hold everything up to the crash-stable frontier (named in REQUIREMENTS section 5; this reading of v4 was not checked against a model).
- Rules: A holder enters the set only by attesting its floors, and leaves it when it is reassigned or falls behind.
- Not novel. Precedent: Kafka's in-sync replicas under KRaft (KIP-841, KIP-903): the ISR row carries them as isr-set. v4 itself has no such state.
- Rows: no row.
- Model: none in this study.
- Settled by: the referee (section 4).

**Eligible leaders** (`v4-eligible-leaders`)
- State: Per row: the members that may take over stamping it after a view change (named in REQUIREMENTS section 5; this reading of v4 was not checked against a model).
- Rules: Only a member that holds everything the old owner stamped may become the row's owner.
- Not novel. Precedent: Kafka's eligible leader replicas (KIP-966): the ISR row carries them as eligible-leaders. v4 itself has no such state.
- Rows: no row.
- Model: none in this study.
- Settled by: the referee (section 4).

**Membership views by ballot (joint consensus)** (`v4-views`)
- State: The member list and its version (the epoch in every stamp); ballots and votes for the next view; held members.
- Rules: A view changes only by a ballot carried by a majority of the old and of the new view. A member that voted for a view two or more members apart from its own is held, read-only and uncounted, until that ballot settles.
- **Novel.** None (both counters). Joint consensus is published (Ongaro's thesis, section 4.3), but not ballots among leaderless members with held members, the knock window and a leave that drops the dead (DESIGN-V5 10.1).
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Ring ownership (one owner per row)** (`v4-ring`)
- State: For each row: the one member that the ring over the current view picks to stamp its changes.
- Rules: Every write to a row is forwarded to its owner, which stamps and files it; a view change moves ownership.
- Not novel. Precedent: a: Chord (Stoica et al., SIGCOMM 2001: a key is owned by its successor on the ring, and ownership moves when members change); Dynamo's ring (DeCandia et al., SOSP 2007, section 4.2). / b: Dynamo (DeCandia et al., SOSP 2007, sections 4.2, 4.3 and 4.5: a ring over the members picks the coordinator of a key, and a request is forwarded to it); Riak's vnode-coordinated puts
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

**Confirm ladder (per-write confirmations)** (`v4-confirm-ladder`)
- State: Per pending write: which holders have attested that they hold it, in memory or on disk.
- Rules: A write is answered at the rung it asked for, once enough holders attest it.
- Not novel. Precedent: a: MongoDB's write concern, chosen per write (w: a number or 'majority'; j: true for on disk). / b: MongoDB's write concern per write ({w: n or majority, j: true}: how many members hold it, in memory or on disk); Cassandra's consistency level per write
- Rows: V4 (1).
- Model: none in this study.
- Settled by: both counters.

## 4. Where the two counters differed, and how it was settled

Every difference is below, with the referee's reason. The same records are in `disagreements` in [judging/mechanisms.json](judging/mechanisms.json).

### 4.1 Novel or not, and which rows carry it

| Unit | The difference | Counter a | Counter b | Settled | Why |
|---|---|---|---|---|---|
| `slow-leader-self` | novel or not | not novel | novel | **not novel** | Referee, with the source read. Same state: a slowness score per store, compared with the peers' mean, where the leader runs. Same rule: a leader whose own score passes a threshold and sits well above its peers' hands leadership away by itself. Same role: a slow leader in a cluster with no controller. Only the score's input differs (storage overload and disk health there; latency against the followers here). fero's rule was named, not written (A-03), so its form is still open, and REQUIREMENTS X17 asks for the published fix. So it settles as not novel on one condition: fero builds it in CockroachDB's form (an absolute threshold plus a margin over the peers' mean). b's doubt, that the feature is off by default, does not hold on the current source. By DEV-10 (a)'s letter it names no durable state; X17 asks to count it, so it stays in the file. |
| `planner-hints` | novel or not | not novel | novel | **not novel** | Referee. Every piece of state has a placed match in one system, CockroachDB, in the same role: an optional outside hand on a cluster that heals itself. The stale-plan rule is exp_desc, checked at the source. What b found unmatched: (1) the gone guard, where a leader whose link to that life is up ignores the hint. That is meta-members' own rule (a gone mark is cleared when that life comes back), applied where the hint lands, and both counters judge meta-members not novel. (2) The placement target is kept in the group's own log, not in a system table: same state and role, another home. The planner's lease row is its own row, apart from the move lease (a's regrouping, taken), and a move hint still takes the move lease. It was never modelled (K-08): that is a debt to DEV-03, not novelty. A close call. State names changed by a regrouping the referee took (see disagreements). |
| `rekey` | novel or not | not novel | novel | **novel** | Referee, judged as the slot move is. a's precedents do the same job: copy into a new layout, stop writes, flip the catalog. Both counters reject the same kind of match for the slot move (MongoDB's moveChunk, Redis Cluster's migration, Couchbase's takeover), because its entries and guards are fero's own. The re-key is the same case. Its entries (rk, cut, frz, cp, flip) live in two groups' Raft logs. It carries dedup and fence state across the flip, and it refuses a cursor of another generation. Its rules were found and counted here (E-17: 35 rules, 22 beyond fixN's 13). If Vitess were a precedent for this, MongoDB's moveChunk would be one for the slot move. CELL only. |
| `memory-rung` | novel or not | not novel | novel | **not novel** | Referee. DESIGN-V5 4.1 writes one rule with three triggers: 'a replica that cannot vouch for its log comes back as a new replica' (a new disk, damaged records, an unclean stop under memory). So a's regrouping is taken: that rule sits in disk-incarnation, and the memory rung keeps two things, a clean-stop mark and the commit rule. Both have the same state and rule in the same role in Kafka (the clean-shutdown marker; commit in memory at the in-sync set) and in VR Revisited (commit at a majority in memory). b's objection is that no system brings the replica back under a new identity. But that step is the published disk-incarnation rule with one more trigger. And the role, 'a replica that may lack what it acknowledged does not count again until it has caught up', is Kafka's (KIP-966 plus the in-sync rejoin) and VR's recovery. Its safety inside Raft was never modelled (K-09): a debt to DEV-03, not novelty. A close call. |
| `writer-epoch-rlog` | novel or not | not novel | novel | **not novel** | Referee. b's reason was that in every precedent it knew, the writer is the log's own proposer or the epoch lives in a metadata store. MemoryDB is the case b missed: a writer outside the log, a leadership entry inside the log, appends tied to it, and the new writer caught up first. That RLOG's controller commits the entry, rather than the writer itself, is the controller's part (controller-commands, counted there), and a coordinator that bumps an epoch is Kafka's. SPACE estimated about 1; A-14's 9 rules stay as rules (E-16). A close call. RLOG only. |
| `v4-frontiers` | novel or not | not novel | novel | **not novel** | Referee. The frontier is the lowest point every current holder has attested. Dropping the log only behind what every holder has acknowledged is published: same state, same rule, same role. What is v4's own is that the acknowledgment is of crash-stable floors per (author, row), and that is the floors' rule: v4-floors is novel by both counters. DESIGN-V5 10.1's list of protocols with no literature does not name the frontiers; REQUIREMENTS section 5 put them among its 13 without a precedent test. |
| `restore-mark` | which rows carry it | 17 rows: PD left out | 18 rows: PD in | **17 rows: PD left out** | Novel, as both say: the nearest form is PostgreSQL's timelines (a restore takes a timeline above every history file in the archive), which neither records an epoch before use nor raises a session generation; E-33 names no precedent. Rows: a is right on PD. In PD's row, positions and lock tokens are the oracle's timestamps; the oracle saves its high-water before use, outside the data a restore brings back (timestamp-oracle, not novel by both), and D `txn` has no sessions to cut. AMENDMENTS A-08 lists PD as unchanged. The other 17 rows keep it. One unit, not two: both counters keep the count at 1; its two pieces of state are written by one protocol, E-33's 8 rules. |
| `v4-in-sync-sets` | novel or not, and whether V4 carries it | not novel; no row (not a v4 mechanism) | novel; V4 | **not novel; no row** | Referee, with v4's code searched. v4 has no such state: kernel/*.ts holds neither 'in-sync', 'insync' nor 'eligible' (searched 2026-11-10). Its holders attest floors (kernel/scope.ts), which v4-floors already counts. The names come from the third v5 draft, Kafka's in-sync sets under a controller (DESIGN-V5 section 12, decision 2c; section 13, 'The third draft'); DESIGN-V5 10.2's 'Gone' list joined them to v4's. So V4 does not carry this unit, and REQUIREMENTS section 5's thirteen hold eleven of v4's own. b judged the list's text, which the list itself says was not checked against v4. |
| `v4-eligible-leaders` | novel or not, and whether V4 carries it | not novel; no row (not a v4 mechanism) | novel; V4 | **not novel; no row** | Referee, with v4's code searched. v4 has no such state: kernel/*.ts holds neither 'in-sync', 'insync' nor 'eligible' (searched 2026-11-10). Its holders attest floors (kernel/scope.ts), which v4-floors already counts. The names come from the third v5 draft, Kafka's in-sync sets under a controller (DESIGN-V5 section 12, decision 2c; section 13, 'The third draft'); DESIGN-V5 10.2's 'Gone' list joined them to v4's. So V4 does not carry this unit, and REQUIREMENTS section 5's thirteen hold eleven of v4's own. b judged the list's text, which the list itself says was not checked against v4. |

### 4.2 Mechanisms the counters added

| Unit | The difference | Counter a | Counter b | Settled | Why |
|---|---|---|---|---|---|
| `dir-lease` | one counter added a mechanism | added it: novel, 16 rows | not listed | **taken: novel, 16 rows** | Added by a; taken. The list missed it: durable state (a lock file with a lease, epoch-named files, retired directories, a boot record with the end offset) with rules of its own, in DESIGN-V5 4.1 (L0). b did not list it. The lock with a lease alone is published, so V4, which has only that (V4-59), does not carry this unit. The fence, which stops a holder frozen past its lease from changing what the new holder reads, has no precedent that either counter placed, so by DEV-10 (b) it is novel. Every row that keeps fero's own dirs carries it: +1 in each of 16 rows, so it changes no order among them. PD (RocksDB's own lock), OBJ (no durable dir of its own), V4 and BUY do not. The referee knows one lead that no counter placed, so it does not count here: HBase renames a dead region server's WAL directory to '-splitting' and recovers each file's HDFS lease before it reads the logs (from memory, not checked). |
| `par-repair` | one counter added a mechanism | added it: not novel, no row | not listed | **taken: not novel, no row** | Added by a; taken with no rows. No row holds Z `par`, so it changes no count. It is here so the judges can score COMP+par (AMENDMENTS section 4). a's precedent is the paper SPACE itself names for the option: same state (a checksum and a bad mark per entry), same rules (repair from a peer; a replica whose damaged entry may be the only committed copy neither stands nor counts toward it), same role. E-37 modelled it: 7 rules, each needed. So COMP+par has COMP's count of novel mechanisms. |
| `cluster-version` | one counter added a mechanism | added it: not novel, 18 rows | not listed | **taken: not novel, 18 rows** | Added by a; taken. DESIGN-V5 4.2 ('Mixed versions') and the #meta record table name a cluster version in #meta, apart from each group's fold-version entry: replicated state with a rule of its own. Same state, rule and role as Kafka's metadata.version (DESIGN-V5 names it), CockroachDB's cluster version and TiKV PD's cluster-version. Not novel, so no count changes; it adds pairs. |
| `queue-claims` | one counter added a mechanism | not listed | added it: not novel, 19 rows with BUY | **taken: not novel, 18 rows (BUY out)** | Added by b; taken, not novel: same state and rules as Amazon SQS (a visibility timeout and a receive count per message, a redrive to a dead-letter queue) and Redis Streams' pending entries. The list named the claim op only inside writer-judging; the lease and the count per message row are state of their own, as lock-rows' are. BUY is taken out: on JetStream the claim is JetStream's own ack wait and delivery count (E-44: a pull consumer whose ack wait is the lease), inside outside-log, as b itself judged for consumer groups. a did not list it. |
| `forks` | one counter added a mechanism | not listed | added it: not novel, 18 rows | **taken: not novel, 18 rows** | Added by b; taken. DESIGN-V5 6.2 (piece 8) makes a fork a new resource whose groups start from the parent's snapshots, and 4.1 keeps what a fork names. That is a #meta record per fork plus a pin on the parent's files: replicated state with rules. The list had only the tier's guard. Same state and rules in the same role as Neon's branches (a timeline with an ancestor and a start position shares the parent's layers, and collection keeps what a branch reads). Not novel. a did not list it. |
| `input-recorder` | one counter added a mechanism | not listed | added it: not novel, 14 rows | **taken: not novel, 18 rows** | Added by b; taken, not novel (Aeron Archive with Aeron Cluster; VoltDB's command log; rr). A-09 counts the recorder's three rules as format rules. But the tape is a file on disk with a rule that writes it, and it holds the journal's retention, so by DEV-10 (a)'s letter it is a mechanism. Rows: E-42's verdict gives it to every row with a deterministic kernel of fero's own and names only BUY and V4 as rows that cannot have it. Its list leaves out PD, ISR, SLOG and OBJ without saying they cannot, and each of them runs fero's own deterministic kernel (DEV-07), so they carry it too: 18 rows, not b's 14. a did not list it. |
| `presence-rows` | both added the same mechanism under different keys and state names | session-rows: reads the registry, writes session.rows | presence-rows: writes group.rows and session.registry | **one unit, presence-rows, with b's state names; not novel; 18 rows** | The same state, rule, rows and precedent. b's names are kept because the rows are group rows, and in rows with no client sessions (DRAFT, LANE, SPLIT, SLOG, PD, ISR) this unit is what keeps #sessions. |
| `cluster-credentials` | both added the same mechanism under different keys and state names | cluster-secrets (L1), writes cluster.secrets and meta.members | cluster-credentials (L4), writes meta.credentials | **one unit, cluster-credentials, L1, writes cluster.credentials; not novel; 18 rows** | The same state, rules, rows and precedent. The state lives in #meta, so L1. A member's certificate is kept in this unit, not in meta-members, so it writes only cluster.credentials. |
| `consumer-groups` | both added it; the axis and the state they read differ | axis K; reads fence.table | axis all; reads slot.table | **one unit; reads both; writes cgroup.members and sub.cursor; not novel; 18 rows** | The assignment is over slots (slot.table) and the cursor write is fenced on the generation (fence.table), so it reads both. Renamed group.members to cgroup.members, since "group" means a log group everywhere else in the list. |

### 4.3 Regroupings

| Unit | The difference | Counter a | Counter b | Settled | Why |
|---|---|---|---|---|---|
| `slot-table` | a regrouped it into slot-move | one unit with slot-move (its three write rules are steps of the move) | two units | **kept as two units; no count changes** | Two pieces of state in two homes: the table in #meta, the move's entries in the groups' logs. By DEV-10 (a) each is a unit. slot-table is not novel by both, so the count is the same either way; keeping it shows the pair with slot-move, which E-15 and E-17c model together. |
| `slot-move` | a: every carry rule (sequence, sessions, dedup, fences, marks) belongs to slot-move | the carry is counted once, in slot-move | says the same in its judgments of slot-sequence and srchi-marks | **taken as a reading; no change to the file** | A-17 (2) names the carried set as the move's. A published piece of state does not turn novel because fero's move carries it. slot-move is novel by both. |
| `move-policy` | both say it has no unit of its own by DEV-10 (a) | rules that start slot moves (fold into slot-move) | a load policy; its lease row is the mover's | **kept in the file, not novel, with its 13 rows** | Both counters count it 0 in every row, and both still give it the same 13 rows. It is kept because it writes the move lease and the load reports, which other units read, so DEV-02 needs it. No count changes. |
| `planner-hints` | a: two lease rows under one name; b: the hint marks are meta-members' state | the planner lease and the move lease are two rows | one unit: the placement record; the lease row is the mover's | **a's reading taken: a new state, planner.lease; planner-hints writes it and, for a move hint, move.lease** | DESIGN-V5 has both rows: "a lease row in #meta keeps two from fighting" (4.2, the planner) and the cluster record's "planner lease", against "one move at a time per resource, by a lease row in #meta" (the shard rule). b's point on the marks stands too: planner-hints writes meta.members, so it pairs with meta-members. The count is not touched. |
| `restore-mark` | both: the unit holds two pieces of state (the mark and the session generation) | split by state, the count stays 1 (the generation is a rule on the session registry) | kept as one unit; if split, both halves novel | **kept as one unit, novel** | Both counters count it once. Its two pieces are written by one protocol, E-33's 8 rules, in one role. Counting them twice would count one model twice. |
| `slow-leader-controller` | both: the two forms are one rule (b) or triggers of leader transfer (a) | one more trigger of raft-leader-transfer | one mechanism in two forms | **kept as the list's two entries; no row carries both; neither is novel** | No row carries both forms, so merging or not changes no count and no pair. Each form keeps its own precedent: TiKV PD's evict-slow-store scheduler for the controller form, CockroachDB's lease shedding for the leader's own form. |
| `healing-self` | both: by DEV-10 (a) its rules write raft-config | rules on raft-config and learners | one unit with raft-config by the letter, kept apart for the precedent test | **kept apart; not novel** | Kept, as b and SPACE's ladder (R1.H) keep it, so its rules get their own test; CockroachDB's replicate queue passes it. No count changes. |
| `split-policy` | both: no durable state | rules that start splits and merges | no unit of its own | **kept in the file, not novel, with SPLIT and PD** | Counted 0 either way. Kept because it writes the load reports that split-record reads. |
| `memory-rung` | a: memory-rung and disk-incarnation both write the disk incarnation by one rule | the rejoin rule sits in disk-incarnation; memory-rung keeps the clean-stop mark and the commit rule | one unit as listed | **a's regrouping taken: memory-rung writes group.unclean and durable.log; disk-incarnation reads group.unclean and holds the rejoin (and the failed-fsync trigger)** | DESIGN-V5 4.1 writes it once: "a replica that cannot vouch for its log comes back as a new replica" with three triggers, and the fsyncgate latch beside it. The pair memory-rung / disk-incarnation stays (through group.unclean). |
| `fold-leader` | a: fold-leader and fold-lazy are one unit for OBJ | one unit (OBJ's ldr + lazy) | two units | **kept as two units; not novel** | Both are not novel, so no count changes. LEAN and SIDE carry fold-leader without fold-lazy, so the list's two units are kept. |
| `v4-latches` | a: the entry holds two latches | two units: the teacher latch (novel) and the fsync latch (published) | one unit, novel | **one unit, novel** | Both count it once and novel. The fsync latch is published (PostgreSQL stops on a failed fsync since 2018) and v5 keeps it inside disk-incarnation. |
| `v4-sheds` | a: the entry holds two sheds | two units, counted once | one unit, novel | **one unit, novel** | Both count it once and novel. |
| `client-sessions` | b: two units (the registry and the per-group tables) | one unit | two units, both published | **kept as one unit; not novel** | Both halves are published (Raft thesis 6.3), so no count changes. The registry's second user, presence, is the added unit presence-rows, which writes session.registry too. |
| `genesis-conditional-create` | b: one mechanism (the cluster id) with two founding rules | two units | one unit | **kept as the list's two entries; no row carries both; neither novel** | AMENDMENTS A-08 says genesis stays 1 mechanism, and no row carries both entries, so no count or pair changes. |
| `raft-term-vote` | b: term-vote, PreVote and CheckQuorum, leader transfer and ReadIndex are one unit by DEV-10 (a) | four units | one unit (leadership) | **kept as the list's units; none novel** | All are published, so DEV-01 does not move. The list's units are kept for DEV-02 because they are etcd's own separate rules over separate state (election timers, a transfer in flight, pending reads), and the same in all 17 Raft rows. |

### 4.4 What the referee checked, and what it could not

- **CockroachDB's lease shedding** (for `slow-leader-self`): read in CockroachDB's source on 2026-11-10, `pkg/kv/kvserver/allocator/allocatorimpl/allocator_scorer.go` on master (`ExistingLeaseCheck`; the enforcement setting's default there is `shed`; the shed threshold is 0.4 and the margin 1.75 times the mean). PR 117703 is where the threshold was lowered while the setting was still off. This is cited, not measured.
- **CockroachDB's `exp_desc`** (for `planner-hints`): read in `pkg/kv/kvpb/api.proto` on master, 2026-11-10: "If the range descriptor is not identical to ExpDesc ... the request will fail".
- **Amazon MemoryDB** (for `writer-epoch-rlog`): checked through reviews of the SIGMOD 2024 paper found by web search (a conditional append that names the entry it follows; leadership taken by a log entry; only a caught-up replica can win; leases renewed in the log). The paper itself was not fetched, and two review blogs (brooker.co.za, muratbuffalo.blogspot.com) could not be reached from this session.
- **v4's kernel** (for `v4-in-sync-sets` and `v4-eligible-leaders`): searched `kernel/*.ts` in this repo for "in-sync", "insync" and "eligible": no match. Holders attest floors in `kernel/scope.ts`. DESIGN-V5 section 12 (decision 2c) and section 13 place "Kafka's in-sync sets" in the third v5 draft.
- **Redpanda's write caching** (for `memory-rung`): a web search found no special rule for a replica that stops uncleanly; Redpanda states that acknowledged data can be lost. So it was not used as a precedent.
- Everything else rests on the counters' own citations, which they mark as checked on the web or cited from memory.

### 4.5 For the user to confirm

- **The three close calls behind COMP against MIN-P** (`memory-rung`, `planner-hints`, `slow-leader-self`). Settled not novel. If the user reads "the same rules" more strictly than the referee did (for example, that the gone guard of planner hints, or "come back under a new identity", is a rule no precedent has), the counts move toward counter b's column for DRAFT, CELL, LANE, SPLIT and COMP. The slow-leader ruling also holds only if fero builds the rule in CockroachDB's form.
- **`dir-lease` is novel because no counter placed a precedent.** The referee knows one lead, not checked: HBase renames a dead region server's WAL directory to `-splitting` and recovers each file's HDFS lease before it reads the logs, so a zombie cannot change them. If the user accepts it, 16 rows each lose 1, and no order among them changes.
- **DEV-01's bar.** REQUIREMENTS says "below v4's 13". The settled count of v4 is 8 (section 2). The bar is the user's to keep or restate; no row is near either number.
- **P-06 and X17 ask to count the `none` rung, credits and the slow-leader rule in DEV-01.** Both counters and the referee found published precedents, so they count 0 as novel. They stay in the file and in DEV-02's pairs.

## 5. Interacting pairs (DEV-02)

The pairs are in [judging/PAIRS.md](judging/PAIRS.md), built by `python3 tools/judging.py pairs` from the reads and writes in [judging/mechanisms.json](judging/mechanisms.json): each row's count, and every distinct pair with the state it shares and the rows that carry both. The per-row counts are also in the table of section 2. DEV-02's other half, that each pair sits inside one model or is shown independent, is not judged here: AMENDMENTS section 4 lists the crossings that no experiment ran together (K-01 to K-28).
