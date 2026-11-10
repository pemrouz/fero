# Amendments: what the evidence changes in the design map

Written 2026-11-10 for the v5 design-space study ([BRIEF.md](BRIEF.md)). All 56 experiments are finished. This file says what their answers change in [SPACE.md](SPACE.md), so that every judge scores the same thing. It gives no verdict and scores no row against a requirement. The judges do that. It was reviewed the same day by a blind second pick and three checkers; section 6 is the record of that review.

## How to read this

- **A fix** is a change inside one option: a changed rule, default or answer, or an added rule or mechanism. Every row that holds the option takes the fix. A fix is never optional.
- **A row** is one of SPACE §4's 19 named designs. A row keeps every option SPACE gives it. Where the evidence goes against an option a row holds, that is the row's weak point, not a reason to swap.
- **Basis.** Every claim says how it is known: **measured** (a timing or a count on this box), **model-checked** (an exhaustive model or TLC), **simulated** (seeded runs, not exhaustive), **cited** (a paper, a doc or a production system), or **reasoned** (argued, not run). The experiment id links to its README.
- **Counting.** A **mechanism** is one named piece of durable or replicated state plus the rules that write it. It is **novel** unless a cited paper or production system has the same state and rules in the same role. A **rule** is one guard or one state update that a checker needs: remove it and a counterexample appears. This is [REQUIREMENTS.md](REQUIREMENTS.md) DEV-10. Rule counts from different model harnesses are not compared with each other (QUESTIONS, "Counting").
- **Pieces with no durable state.** Three experiments call a piece "a mechanism" and name no durable or replicated state for it: the slow-leader score (A-03), the credit grant (A-07) and the tenant budget (A-29). E-23 applied DEV-10 (a)'s letter to its merger and found it is not a mechanism. Whether these three are mechanisms or only rules is for the two counting agents. This file marks each one.
- **Who decides novelty.** DEV-10 (e) gives the final count to two agents. Where an experiment did not settle whether a mechanism is novel, this file says "novelty open" and names the precedent on offer.
- **The judging rule.** It is REQUIREMENTS' rule. A candidate that fails a MUST by design is out. Among the rest, the lower count of novel mechanisms wins when the counts differ by 2 or more. Otherwise the one that meets more SHOULDs wins. Section 2 uses it one axis at a time. Two options on one axis are seldom 2 apart, so the count alone seldom picks. Where they are exactly one apart, section 2 says "one apart" and names the smaller option, for two reasons: rule 4 ranks few mechanisms first, and add-ons stack (two add-ons of one mechanism each are 2 apart from the base, and then the base wins). Where the larger option has a model that shows a SHOULD met, the axis is marked **undecided**.

**Where experiments disagree, or changed their own answer.** Each is shown again at the entry that uses it.

| # | The two answers | Followed here | Why |
|---|---|---|---|
| D1 | [E-21] first chose CockroachDB's guard on the leader's own clock (6 rules against 7). Its second pass added a planned-handover family and wrote the median as one assignment: both sets need 7 rules, and the guard causes a failover on every leader clock jump (60 of 60 runs, simulated) | the second pass: the median | the tie at 7 removes the count's edge, and F-06 as written forbids a failover caused by a clock jump |
| D2 | SPACE says `cent-co` is the smaller control plane ("fewest novel mechanisms", one decider). [E-16] found 18 rules against 14 for `self` (16 with a counterexample), a stuck state in `cent-co` as first written, and a wait while `#meta` is down (model-checked) | E-16, for healing | it is the only model of both, on one harness, with ablation. It models healing only: no slot moves, hints, leaves or drains |
| D3 | [E-14] said yes with one rule, liveness not finished, 6 of 22 mutants caught. [E-14b] said yes from three voters up, found the two-voter window, and stopped two scenarios on invariants that are stronger than Raft needs. [E-14c] replaced those invariants and finished both scenarios | E-14 for the campaign guard, E-14b for the window and "learners grant votes", E-14c for the final verdicts and the mutant rate (12 of 22 caught; 12 of the 13 judged not equivalent by reading) | each builds on the one before; none withdraws an earlier finding |
| D4 | [E-17b] said `pslot` needs 4 more rules than slot moves. [E-17c] showed the 4 rules name the slot key in any slot move, and withdrew the penalty | E-17c | a second agent re-ran every ablation and ran the probe that shows it |
| D5 | [E-22] said sagas hold with two added rules (F3). [E-24] showed a paused holder's late step still lands after its unit was undone (12 steps, model-checked) | E-24: F3 plus "undo every step" | E-24 is exhaustive; E-22 was 100 seeded histories |
| D6 | [E-09b] said relays must be native unless a Node relay reaches about 1.26 M deliveries a second per core. [E-08] measured 0.57 to 1.50 M with no added wait and 20.6 to 32.3 M with 10 ms rounds | E-08 for throughput; latency stays open | E-09b's line was conditional on E-08's number. E-08's high rates wait up to 10 ms, which is over P-05's own bar (C + one hop, under 1 ms here), and with no wait the measured p99 is over it too (section 1.3) |
| D7 | [E-07] settled `election.ms` at 2 s in TS. [E-13] measured failover at 2.03 to 3.36 s with E = 2 s, over F-05's 2.5 s | both, with DESIGN-V5's 0.25 E jitter | E-13's own sum: E + 0.25 E + a few ms = 2.5 s, just at the bar. The sum is reasoned: the measured runs used etcd's own timer. There is no margin |
| D8 | [E-07] moved the kernel-on-a-worker form up on F-06 and F-14. [E-34] measured 0.25 to 0.49 s pauses on that worker when it holds a row index on the V8 heap | both | the form holds only with the index kept off the V8 heap |
| D9 | [E-20] offers "append every refusal" in place of the `forward.once` rule. It would also remove two answer rules: 3 rules in all, for one log entry per refused first send. P-09 and P-11 say an empty take and a refused limit write nothing | `forward.once` | reasoned here from the requirement text; no experiment weighed the two. The price of this reading is 3 rules |
| D10 | [E-18] says change to 4,096 slots, and that [E-19] and [E-36] must confirm the price. Both ran at 1,024 slots only | 4,096, with the price open | E-18's own threshold picks 4,096; 1,024 stays the fallback (section 5) |
| D11 | [E-38] simulated 3.2 to 3.4 E to a new leader under one-way loss. [E-38c] measured 1.32 to 2.06 E on real TCP | E-38c for real TCP; E-38's timer fix is kept | TCP turns one-way loss into two-way loss; the fix is a constant either way |
| D12 | [E-45] listed the memtier and Redpanda runs as blocked. [E-09a2] and [E-09d] ran both later | the later runs | the tools were allowed after E-45 was written |

## 1. Fixes inside an option

"Raft rows" means the 13 rows whose data groups run etcd's Raft or its ports (DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) and PD. ISR and SLOG take a Raft fix for their metadata group only.

### 1.1 Fixes that every row takes, whatever its options

| Id | Axis and option | What changes | Experiments, basis | Cost (DEV-10) | Rows | Moves |
|---|---|---|---|---|---|---|
| A-01 | R `raft`, `rlog`; any metadata group on Raft | Membership changes take effect on commit, with five stated rules: (1) no member campaigns while a committed change is unapplied; (2) learners grant votes; (3) only a voter of its own applied configuration stands; (4) a lost disk never returns under its old id; (5) healing grows before it shrinks. One stated limit: growing from two voters to three has a one-message window. If the leader is lost in it, the group waits for that leader; if its disk is lost too, an operator step is needed | [E-14] (1), [E-14b] (2, 4, the window), [E-14c] (3, 5): model-checked with TLC on etcd's own spec, not on any code. With grow first, 0 stuck states of 340,671 and of 235,702. Without it, 112 and 692, all the window. Stuck states are judged in the first leader's term only (G-10) | 16 rules for membership in all (E-14b's 14 plus E-14c's 2). 0 new mechanisms for etcd's raft and its TS port: each rule is in etcd's code or in DESIGN-V5 §4.1 and §4.2. Not checked for raft-rs | every Raft row. It carries to the `port` rows (the port passes etcd's own files, [E-10]) and to SRV's Go variant. It is reasoned for the I `raft-rs` rows (RUST, EMB-V8, SIDE, SRV's Rust variant, PD): raft-rs 0.7.0 lacks StepDownOnRemoval ([E-10]), which E-14 names as needed for liveness (reasoned), so those rows add it. E-14's own Moves line lists them with the port rows | F-16, DEV-03 up; F-07 down a little (the window); DEV-10 |
| A-02 | R `raft`, `rlog` | Three constants and two edge rules. CheckQuorum runs every E/4. The election jitter is 0.25 E with E = 2 s in TS (or E ≤ 1.25 s). A member that cannot forward a write refuses it at once with a redirect; it never drops or holds it. A handover refuses writes caught in the transfer; it never drops them. The cost of E/4: a leader whose followers all pause for more than E/4 steps down. That is 500 ms at E = 2 s. F-06 allows pauses up to 1 s, so F-06 then holds only while the followers' kernels do not pause that long together; [E-34] measured 0.25 to 0.49 s on the kernel's worker (D8, K-28) | [E-38] (simulated on etcd's raft: 3 to 3.9 E without the CheckQuorum constant; E/4 was run on the named cases only, not the sweeps), [E-38c] and [E-13] (measured on etcd 3.5.17: dropped writes cost the client its timeout; failover 2.03 to 3.36 s at E = 2 s with etcd's jitter). The failover sum with 0.25 E jitter is reasoned, not run (D7). The native bar of 1.25 s was missed once at E = 1 s (1.42 s), so a native row needs E under 1 s with that jitter (reasoned) | 2 rules, not ablated in a model. 0 mechanisms | every Raft row. Rows with Y `smart` meet the redirect clause by routing | F-05 (failover clause), F-17 (client level), DEP-01; F-06 down a little (the E/4 cost) |
| A-03 | R `raft`, `rlog` | A slow-leader rule: a leader much slower than its followers gives up leadership. Raft as published never does this. F-18's p99 clause also needs the leader to fsync in parallel with sending (etcd's async writes) | [E-38] (simulated: a leader 10 times slower is never replaced at moderate load), [E-38c] (measured: a leader capped at 10 % CPU kept leadership for 20 E with p99 32 times worse) | **+1 mechanism** by E-38's word (a latency score per member, and the rules that move leadership). By DEV-10 (a)'s letter it is open: no durable or replicated state is named. Novelty: E-38 names two forms. The controller's form has a precedent on offer, TiKV PD's evict-slow-store scheduler, cited by E-38 from memory. The form where a leader hands over by itself has no cited precedent, and it is the only form a row with no controller can use: novel as it stands. Rules not counted: the rule was named, not built or modelled | every Raft row and PD. C `cent`, `cent-co` rows: the controller's form. C `self`, `self+p` rows (DRAFT, CELL, LANE, SPLIT): the leader's own form | F-18, DEV-01, DEV-02 |
| A-04 | K (every option): how the writer answers | A refusal, an empty `claim` and a `call-diverged` answer are sent only once the log end they were judged on has committed. A write bound to a session is sent only after its session's record has committed | [E-22] (measured in a simulation: Porcupine found a refusal by a write that was then lost, in 10 of 100 seeds of a planted race), [E-22b] (real Knossos agrees on all 185,959 partitions) | 2 rules. 0 mechanisms. One commit wait on a refusal | all rows that judge at a writer (every row but BUY) | P-14, F-02, P-13 |
| A-05 | D (every option) | D gains `srchi-slot` for derived resources and consumer groups: per consumer, source slot and output slot, the highest source sequence applied. It is written in the output's own entry and carried when the output slot moves. No option with a horizon (`win`, `sess`, `pid`, `keys`) stays exactly once across a restart longer than its horizon. This replaces SPACE §4.2's "retention-length dedup table" (`srcpos`) | [E-30] (model-checked, 12 to 13 steps to a double apply without it; real Elle agrees on all 2,800 histories) | **+1 mechanism.** Novelty open. The precedent E-30 offers is storing consumer offsets in the same store as the outputs (KafkaConsumer javadoc, "Storing Offsets Outside Kafka", cited). The key per output slot and the carry on a move are fero's, and the form nearest that practice, one mark per group, loses an output when a slot moves (E-30, 12 steps). 5 rules, all needed. 29 B a mark | all rows. The carry on a re-key, a split or a lane's range move was not modelled | P-08, P-17, F-02 up; DEV-01 +1 |
| A-06 | W `any` (and logs under F `ldr`) | A replica that lacks the reader's next record answers `END` (go elsewhere, with your cursor). Only the leader of the group that holds the slot says `expired`. As drafted, a follower that reloaded a snapshot ended a `log` reader's stream for good | [E-31] (model-checked: 7 steps, one fault; with the fix every property holds on ten bounds, up to 7.6 million states) | a changed answer. 0 mechanisms. The subscribe protocol is 26 rules by ablation, 27 with A-17's carried segment names; 31 of 32 mutants caught | every row that serves subscriptions | P-03, P-05, P-07, F-04 |
| A-07 | every row: admission | Admission control is priced now: a credit window on the client wire (each client holds at most a granted number of writes outstanding; the rest wait in the client and fail at their deadline), and a budget on TLS handshakes per tick at the edge. Bounded queues with retry-after and jittered backoff collapse to 0 to 50 % goodput at 1 to 2 times capacity and do not recover | [E-39] (measured on [E-02]'s pipeline, with a fixed client-side window of 5 ms of the known maximum rate and two client processes: goodput 79 to 82 % in TS and 88 to 89 % in Rust at twice capacity). A grant handed out by the server, and the handshake budget, were not built (reasoned) | **+1 mechanism** by E-39's word (the grant per client or link). By DEV-10 (a)'s letter it is open. Novelty open: E-39 names no precedent. Credit-based flow control is published (AMQP 1.0 link credit, HTTP/2 windows; cited from memory, not checked in this study), and DESIGN-V5 §4.4 already has credits on the read side. Rules not counted: measured, not modelled | all rows | F-19, DEV-01 +1, X17 |
| A-08 | every row with `#meta`: genesis and restore | Founding on "a majority of seeds with no id" is replaced. Rows that require an object store across boxes found by a conditional create of the cluster id in the store. Rows that do not require one found by one `fero init`. `seeds` never runs beside a dir that holds an id; a one-box cluster grows by `hosts`. A restore takes an epoch above a high-water mark kept outside the restored data (the store's manifest), and a fresh session generation. Every new epoch is recorded in that mark before it is used, and a slot move raises the epoch. So a slot move waits while the store is down (section 1.3). For the rows that require no store, the home of the mark is open | [E-33] (model-checked: the draft founds two clusters in 10 steps with one lost dir and one crash; a restore read as "the backup's epoch plus one" repeats a lock token in 5 steps). The store is always reachable in the model | genesis stays 1 mechanism. Conditional create: 4 rules; E-33 calls it "new here", so novelty open (S3 conditional writes are the cited base). `fero init`: 3 rules, not novel (CockroachDB's `init`). Restore: 8 rules and one more store write per epoch. The high-water epoch is one more piece of durable state; whether it is a mechanism is for the counting agents, and E-33 names no precedent | conditional create: MIN, RUST, LEAN, MIN-P, MIN-TS, SIDE, SLOG, OBJ. `fero init`: DRAFT, CELL, LANE, SPLIT, SRV, EMB-V8, RLOG. PD and ISR unchanged (they already found by an explicit step) | SC-02 up for the conditional-create rows, down for the `fero init` rows (one setup step across boxes); DEP-18, OPS-07 |
| A-09 | every row: L0's format | Six format rules: preallocated segments; a marked reserve segment (at least 1 MiB) for removes, votes, member changes and retention marks; snapshot headroom inside the hard limit; segment ends by name; chained sequence numbers; a short write means ask again. Snapshot and catch-up writes must not starve commit fsyncs. A row that keeps snapshots on its own disk states "a volume holds the rows twice". Three recorder rules: whole-frame inputs, bulk bytes by journal reference, journal retention tied to the recorder's window | [E-29] (measured with LazyFS on E-29's own journal prototype: 2,640 power cuts, 0 of 10,020 acknowledged batches lost; disk-full on three processes passes), [E-01] (measured: a flush waits behind bulk data), [E-42] (measured: 1.1 to 1.7 % of a core) | format rules for DEV-09. 0 mechanisms | all rows; the snapshot line does not apply to OBJ | F-20, F-10 (power loss and torn writes only: G-26), SC-10, OPS-11, DEV-09 |
| A-10 | every row: the `data` seam and the API | Changes owed by `data`, the same for every row: a merge contract (ties by row key, an exactly rounded sum, one total order on values); `group` emits per-row deltas; a removed row is restored at its old key position; a number or digest that a test forces to move with the fold. fero's merger takes four rules (a cut, one owner per key, paired move halves, resync on rebuild). Five pins for the fold version. Five API changes (a number form for versions, reads from a version, byte values, issue order for one process's writes in flight to one partition, caller idempotency keys). Two pattern rules: a take hands over what it has at once; a lock name has one lease. One stated ceiling for SC-10: `limit`, `reverse`, `reduce` with no merge function and exact quantiles need one process that folds every group, so they are bounded by rows per process | [E-23] (measured: 0 mismatches in 225.6 million checks with the contract; the ceiling for operators that were not run is reasoned), [E-05], [E-06], [E-43], [E-45] (issue order broken in 12 of 100 seeds), [E-44] | the merger's rules keep in-memory state only, so they are not a mechanism by DEV-10's letter (E-23; the pattern is Gray et al. 1997, cited). The rest are contract and format items | all rows equally: no ranking change | P-12, P-16, DATA-01, DATA-03, DATA-04, DATA-05, OPS-12, F-21, DEP-10, SC-10 |
| A-11 | every row: relays and the edge | (a) Every row: a relay coalesces each room for a bounded few ms and spreads sockets over cores (about 1,000 a core keeps a round near 10 ms). WebSocket is a first-class transport that carries the same frames. (b) Rows with a TS edge: a TLS terminator stands in front of it. The coalescing wait does not fit P-05's delivery bar as written (section 1.3) | [E-08] (measured: a socket write costs 8 to 14 µs in Node and in Rust alike, so the rule holds for a native relay too), [E-40] (measured), [E-27] (measured: 10,000 TLS links take 538 MB), [E-39] (TLS storm p99 27 to 45 times steady) | 1 rule (coalescing), in every row. +0 mechanisms. (b) is +1 deploy piece | (a) all rows. (b) DRAFT, MIN, LEAN, MIN-TS, MIN-P, CELL, LANE, SPLIT, SLOG, RLOG, OBJ (E-27's list). ISR holds L `ts→rs` too and is not in E-27's list; it takes (b) by reasoning. RUST, SRV, EMB-V8 and SIDE may use a native edge (reasoned, not measured) | PERF-11, P-19, SC-12, DEP-07, F-19; not P-05's latency clause |
| A-12 | C's failure detector | Quiet groups are needed from phase 2, not later. Past 100 members, a bound on linked peers per member is needed | [E-11] (measured: ticking without quiet groups costs 4.9 to 13 % of a core for 2,000 groups; no failure was injected, so failure detection on the pings was not exercised), [E-25] (measured: 0.95 % of a core in Node at n = 100, and frames grow as n²) | quiet groups: a precedented mechanism (CockroachDB's quiesced ranges), now early. The peer bound: +1 placement rule, precedent not checked | every Raft row with pairwise pings | PERF-12, SC-07, X8 |
| A-13 | F `all` and M `kw` in TS | Stated ceilings: 16,777,216 rows per `data` source; the heap is sized from rows, and rows are bounded per process; a quiet group costs 16 to 26 KB of RSS in TS against 3.5 KB live ([E-11]). SC-05's wake time is stated per storage form: one Node process wakes 10 GB of 2 KB rows in 86 to 122 s, over the 60 s bar; 5 GB in 36 s. E-34's threshold then says a faster wake is planned now: a native crc32c, a record format V8 decodes whole, and taking blind writes while the fold catches up. None was built or measured | [E-34], [E-07], [E-11] (measured); the faster forms are reasoned | 0 | every row that holds rows on the V8 heap. RUST and SRV are up a little on SC-05 (reasoned from the breakdown, not measured) | SC-05 (open at 10 GB for every row that folds in Node), SC-10, DEP-13, F-13, PERF-12 |

### 1.2 Fixes that belong to one option

| Id | Axis and option | What changes | Experiments, basis | Cost (DEV-10) | Rows | Moves |
|---|---|---|---|---|---|---|
| A-14 | R `rlog` | The writer handover is 9 rules, all needed: hand over only when the writer is gone and only to a linked server; the new writer folds to the log's end before it writes; the log group's leader takes an append only with the latest committed writer epoch | [E-16] (model-checked) | +9 rules on top of C's. The mechanism is the writer epoch SPACE already counts (about 1) | RLOG | DEV-01, DEV-10 |
| A-15 | G `shard`, when each resource starts with its own group or groups | Groups go dormant: state on disk only, loaded on wake. Without it an idle resource costs about 86 KB against SC-13's 2 KB, and 17.3 KB even with A-16's formats. With it: 1.4 KB when about 10 slots are touched, 8.8 KB at 100. A wake holds SC-13's 5 ms cold-open bar at p50 and p90 (3.3 to 3.5 and 4.4 to 5.1 ms); its tail is over (5.4 to 7.6 ms) | [E-36] (measured in Node, with `#meta` sizes encoded, not a running `#meta`), [E-26] (measured: 57 B a dormant group, wake 3.3 to 3.5 ms) | **+1 mechanism.** Novelty open: E-26 cites TiKV's hibernate regions from memory, not checked | MIN, MIN-TS, RUST, LEAN, DRAFT, RLOG, SRV, SIDE, EMB-V8 (E-36); CELL in TS (E-26, for SC-11). SPLIT and SLOG are the same shape (reasoned, not measured: E-26 counts one group per resource for both, and a loglet's idle cost is unknown). Not MIN-P. Not OBJ (no group in memory, E-26). PD has its published cross-table merge. ISR has N partitions per resource and was not priced: SC-13 is open for it | SC-13 (memory clause), SC-10, DEV-01 +1 |
| A-16 | P `slot` (and O `slot`) | The default is 4,096 slots, not 1,024. Formats fixed in phase 1: delta-coded cursors, an implicit per-slot sequence (or a 5 B bar), a run-length slot table, sparse per-slot state. SC-10's writer ceiling is stated as 135 effective writers per resource, with the app splitting every partition above half a writer's share (72 at 1,024 slots; 30 at any slot count if the app splits only above a whole share; 12 to 22 with no split: section 1.3) | [E-18] (simulated: 1,024 slots give 72 effective writers in the worst draw and fail Pareto 1.16 in about 1 % of draws; the app split in the model is perfect and instant), [E-19] and [E-36] (measured, at 1,024 slots only) | 0 rules, 0 mechanisms. A constant and four format choices | every slot row: DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE | SC-03, SC-10, DEV-09 |
| A-17 | P `slot`: the move | Four changes. (1) The spec states two once guards: a move is fenced once and opened once. (2) The carried set is named in full: the slot's sequence and epoch, dedup outcomes and every session's floor, the lock fence table, A-05's marks, and the segment names that keep records below the fence reachable. (3) The client-visible window is cut to one or two commits before phase 1, or SC-08(b) is restated: three commits take 16.7 ms at p99 under 10,000 writes a second. (4) The move has one give-up decider, not the draft's two. Who decides when the target group is gone for good (the source or `#meta`) is not answered by any experiment (K-27) | [E-17c] (model-checked, crash-only: 28 rules with the once guards and no give-up path, which crash-only faults never need), [E-17 part 1] (model-checked, crash-only: on its footing the move is 26 rules with no give-up, 33 to 34 with one decider and 37 to 39 with the draft's two; a few give-up rules stayed undecided, so these are ranges), [E-15] (TLC agrees with slot_move.py on all 74 runs; 31 rules on that harness, with unclean recovery, cancel and abort), [E-31] (segment names: a false `expired` in 8 steps without them), [E-13] (measured on [E-10]'s TS Raft; the chain carries no copy) | the slot move stays 1 mechanism. 28 rules crash-only with no give-up, 31 on E-15's harness; the two are not compared. One decider saves 4 to 5 rules against two. The link incarnation check is not a rule (E-15). A fused move would be 22 to 23 rules ([E-17b]'s probe, crash-only) | every slot row. DRAFT's two-decider give-up is its weak point | SC-08(b), DEV-01, DEV-03, DEV-09 |
| A-18 | P `slot`: the move policy (and `slot + rule`) | Whatever decides the moves uses one policy: one slot at a time, from the busiest group to the least loaded, and only when the move wins by a margin. Without the margin the loop swapped two equal pieces for ever in 48 of 300 test cases. DRAFT's grow rule ("the busiest group hands half its slots to a new group") alone leaves max/mean group load at 1.5 to nearly 2 between powers of two, so it takes this policy too | [E-18] (simulated as one loop that sees every slot's exact load, one resource at a time). A rule that each leader runs alone was not run, except the draft's halving, which does not balance | a load policy with no safety rule: 0 rules. It is counted the same wherever it lives: 0 by DEV-10 (a)'s letter, or 1 in every slot row. SPACE's ladder counts DRAFT's grow rule as 1 mechanism and counts nothing for the same policy inside a controller | every slot row (in `cent` and `cent-co` rows the mover is the controller). DRAFT also replaces its halving rule | SC-03, SC-04 |
| A-19 | C: every option that heals (`self`, `self+p`, `cent`, `cent-co`) | Healing rules the model found for both `self` and `cent-co`: a surplus removal waits until the voters left answer, not only hold the offset; a member back with a new disk can be added as a new replica while its old replica is still a voter. One stated limit for both: a second fault during a swap can stop writes until a member returns | [E-16] (model-checked, 4 members, up to two faults, groups that start at three voters) | inside `self`'s 14 rules. 0 mechanisms | every Raft row; PD by reasoning | F-16, DEV-01 |
| A-20 | C `cent-co`, `cent` | Each command is checked again where it runs: the config epoch, "gone" on the leader's own links for a removal, "alive" on them for a promotion. A command the group refuses times out. Healing waits while `#meta` has no leader: with a member fault as well, 24 to 62 % of the judged states cannot finish until `#meta` returns (a delay, not a stuck state) | [E-16] (model-checked: 92 stuck states with a live majority before the "alive" re-check) | 18 rules against `self`'s 14 as E-16 counts them; 16 with a counterexample, which is DEV-10 (c)'s letter (two are undecided and kept). The command list in `#meta` is state of its own. Not novel: TiKV PD's region epoch and operator timeout | MIN, RUST, SRV, LEAN, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE; reasoned for PD, ISR, SLOG, OBJ | DEV-01, DEV-02, SC-08(e) down |
| A-21 | D `sess` under Y `fwd` | One hop rule: a relay forwards a copy only once (`forward.once`). "Append every refusal" would remove it and two answer rules (11 against 14; reasoned for `sess` from `win`'s 16 against 19), for one log entry per refused first send. It is not taken (D9) | [E-20] (model-checked: REFUSED in 9 steps without it; the count under `fwd` is 13 plus this rule, partly reasoned) | +1 rule: 14 against 13 on a `smart` path. 0 mechanisms. `sess` itself is not novel (Raft thesis §6.3) | counted in MIN, RUST, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, SIDE (E-20's Moves line). SRV and EMB-V8 also write and test it for their browser clients, which stay `fwd` (E-20's body; reasoned from SPACE): 14 rules written, 13 on the path of their server clients | F-02, DEV-10 |
| A-22 | D `pid` | Two fixes: a give-up bumps the epoch and restarts the sequence (Kafka's KIP-360), and "unknown producer" is answered only once the forget has committed. As first written a partition could stall for ever | [E-20] (model-checked) | 16 rules (17 under `fwd`), 2.1 KB per producer | ISR | F-02, DEV-10 |
| A-23 | T `clamp` | The window is 0: writer time is the median of the members' clocks, each reading carried forward by the receiver's monotonic clock, and it never goes back. The draft's window of `skew.max` expires rows up to 600 ms early or late when the leader's clock jumps. The agreement guard (`median+g`, 2 more rules) is **not** part of this fix (section 5) | [E-21] (simulated, 30 seeds in each of nine families, one group; D1) | 7 rules (the draft's `clamp` wrote 10). 0 new mechanisms. Precedent for a median log time: CometBFT's BFT time (cited by E-21) | every `clamp` row: DRAFT, MIN and its family, CELL, LANE, SPLIT, ISR, SLOG, OBJ | P-02, P-10, F-06, TEST-02 |
| A-24 | X `saga` | Three changes to DESIGN-V5 §5.3. Add: a saga's locks belong to the unit, and a holder resolves another unit's unfinished intent on its partitions first. Add: a failed run undoes every step, the failed one and those after it too. Drop: "every writer follows `#locks`"; it is not enough without a bound on delay, and not needed. `saga` refuses a step it cannot invert. In place of "undo every step", the epoch bump also holds on the same seven bounds: the holder raises the fence at every partition of its unit before it acts (Kafka's KIP-98, cited; one more write per partition per saga; its rules were not counted) | [E-24] (model-checked on seven bounds, up to 2.9 million states; D5), [E-22], [E-22b] (real Elle: no G0 with the first rule) | 38 rules with "undo every step", 41 of 44 mutants caught. Novelty open: 1 novel rule as E-24 counts it; 0 if the judges accept Kafka's end markers as its precedent (cited by E-24 from memory), or with the epoch bump if KIP-98 is accepted. SPACE's one novel mechanism for `saga`, fences across groups, leaves the count and this rule takes its place | every row with X `saga`: all but PD, ISR and V4. BUY takes it in fero's L5 library | P-15 (M) up; DEV-01 unchanged |
| A-25 | S `jrnl` | One journal per process with one flush stream, in preallocated segments. Striping over 4 files and a journal per worker both cost latency on this disk | [E-12] (measured: p99 2 to 6.6 ms against 9 to 854 ms for a file per group from 256 groups), [E-02] (measured: preallocated beats growing 1.3 to 1.9 times) | 0. `jrnl` keeps its one small mechanism (cuts, segment indexes) | every `jrnl` row | DEP-12, PERF-08, SC-10, SC-15 |
| A-26 | F `ldr` | The warm standby that folds is required, not optional: a cold rebuild passes F-05's 2.5 s above about 560,000 rows | [E-05] (measured: 1e6 rows replay in 4.5 s) | 0 | LEAN (E-05). SIDE and OBJ by reasoning; OBJ's `lazy` half may already be that standby | F-05 |
| A-27 | M `kw` | The seam between the kernel's worker and the main thread carries byte batches (27 to 40 ns a record at batch 256, against 0.8 to 2.2 µs one at a time). The worker keeps its row index off the V8 heap (D8) | [E-07], [E-34] (measured) | 0 | DRAFT, CELL, LANE, SPLIT, SLOG, RLOG, MIN, RUST, LEAN, MIN-P, MIN-TS, ISR, OBJ | F-06, F-14 |
| A-28 | Z `rejoin` | Confirmed at 2 rules: a checksum per entry turns damage into a wipe, and a wiped replica never votes under its old id. F-10's "a torn tail is cut" is narrowed: only a tail that the checksum shows was never acknowledged is cut. With one bad entry on each of two replicas the group is never writable without F-12's operator step | [E-37] (model-checked on etcd's spec, one group of three voters: without the checksum a committed write is lost with one fault, 32 states) | 2 rules. No mechanism beyond the disk incarnation the rows already count | DRAFT, CELL, LANE, SPLIT, RLOG, MIN, RUST, LEAN, MIN-P, MIN-TS, SRV, EMB-V8, SIDE; SLOG by reasoning only (its data path is not Raft, so E-37 did not check it) | F-22 (M), F-10 |
| A-29 | N `tier`, `pool` | A tier or process that pools tenants needs a byte budget per tenant (about 1 MiB/s of big-record bytes on this disk) or a volume per tenant. On a shared journal a tenant at its quota raised another's p99 by 1.40 to 1.59 times, against SC-11's 1.1 | [E-35] (measured for the ratios, on one disk; the budget itself was not built. 1 MiB/s is where the steadier "all light" ratio held, at 1.05 times; the neighbour's own p99 was 1.20 times there, inside its run-to-run spread) | **+1 mechanism** for the budget by E-35's word; by DEV-10 (a)'s letter it is open. Novelty open: E-35 names no precedent, and OPS-14 already asks for a disk and fsync budget per project. Or a volume per tenant: 0 mechanisms, at a price E-41 did not work out | DRAFT, CELL, LANE, SPLIT, SLOG, RLOG, OBJ (`tier`); EMB-V8 (`pool`) | SC-11, OPS-14, DEV-01 +1 or 0 |
| A-30 | L: guards per language option | The twin guard (TEST-10, and DATA-09 for a fold) compares state as well as effects, on inputs ≥ 2^32, ≥ 2^53, fractions, non-ASCII, astral and BMP-high keys. It applies to a row that keeps two kernels (a `ts→rs` row after its native step, unless it retires the TS kernel for the WASM build) or that folds natively (SRV; PD by reasoning). RUST, EMB-V8 and SIDE run one Rust kernel, as WASM in the sim: the kernel needs no twin. A WASM kernel in the sim reuses one instance per worker. `rs+napi`: the core is called on the JS thread, or crosses threads in batches. `rs+v8`: deno_core only (QuickJS folds 16 times slower). H `side`: a shared-memory ring, not a socket | [E-04] (measured: 1,000 seeds byte-identical; all five planted traps caught only with state compared), [E-03] (measured) | 0 | the guard: DRAFT, MIN, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, RLOG (`ts→rs`, from the native step on); SRV; PD by reasoning. The call rules only: RUST, EMB-V8, SIDE | TEST-10, TEST-01, DATA-09, PERF-10, X2 |

**Not a fix, but every row counts it.** P-06's `none` rung is one more mechanism in every row (SPACE §4.2). No experiment modelled its failover rule ([E-02] and [E-08] measured its speed).

### 1.3 Requirements the evidence asks to restate, and clauses left open for every row

No fix is taken here. The wording of a requirement is the user's. Judges score each line the same for every row it names.

| Requirement | What was found | Basis | What it asks |
|---|---|---|---|
| F-17, every Raft row | 5 of 280 five-node partial partitions stayed stuck with a connected majority (Raft's own vote rule; none with three nodes) | [E-38], simulated on etcd's raft. ISR, SLOG, OBJ and V4 were not run | a new election rule (novel, +1 mechanism), or F-17 restated to "a connected majority that includes an up-to-date replica", which E-38 recommends |
| SC-10 and SC-03, every row | As SC-10 is worded, the effective writer number is 12 to 22 for every design, below F_w = 64. Under Zipf 0.99 the hottest partition holds 5.5 to 9.8 % of the load, and nothing splits a partition | [E-18], simulated | SC-10 adds "with every partition above half a writer's share split by the app". With it: 72 at 1,024 slots, 135 at 4,096. With a split only above a whole share: 30 at every slot count |
| P-05's latency clause, every row | "Delivery p99 ≤ C + one hop" is under 1 ms on this box. With no added wait, p99 was 1.2 ms (Node) and 3.5 ms (Rust) at 1,000 subscribers, and 0.22 to 0.25 s at 10,000 on one core in both languages. A round that waits 10 ms is over the bar by design | [E-08], measured | P-05 is restated with a coalescing window per room and a socket count per core (about 1,000), or it is unmet by every row in both languages |
| F-05's handover clause, every Raft row | etcd's own handover pauses its group 9.7 to 9.8 ms at the median and 24 to 31 ms at worst on this disk, against 10 ms (TS) and 2 ms (native) | [E-13], measured on etcd 3.5.17 | E-13: state it as "C plus the box's normal longest gap between commits plus 5 ms", or it stays open |
| SC-08(b), every slot row | a three-commit move is unwritable 16.7 ms at p99 under 10,000 writes a second, against 10 ms | [E-13], measured | A-17 (3): cut the window to one or two commits, or restate the bar as a p50 plus a p99 tied to load |
| SC-13's "small", every slot row, `pslot` too | Per-slot state costs about 85 B per touched slot. An idle resource passes 2 KB with about 10 slots touched and fails at 100 (8.8 KB) | [E-36], measured in Node | "small" is defined as "few slots touched", or per-slot state is priced per touched slot |
| SC-05 at 10 GB, every row that folds in Node | 86 to 122 s against 60 s | [E-34], measured | the bar is stated per storage form (A-13); a faster wake is planned and not built |
| F-10's failed-fsync and directory-fsync clauses, every row | not tested: LazyFS cannot make a sync fail or lose a directory entry | [E-29] | open until the simulator's disk model or a block-level tool covers them |
| F-15, every row that restores by A-08 | a slot move records its new epoch in the store before use, so a move waits while the store is down. F-15 lets only wake, new replicas and old history wait | the rule is [E-33]'s; the clash with F-15 is reasoned in the review | F-15's list adds slot moves, or the mark gets another home |
| DEP-21's $10 bar, every row | the bar holds only with the subscribers placed: inside the project, or each taking at most 5 % of the writes | [E-41], cited prices | the bar says where the 100 subscribers run |

**Notes on tests and bars, the same for every row.**
- TEST-07 is met by undoing in tape order, and fero test states that a jump costs the inputs between. TEST-06 is met in storage only: a fork that runs costs O(rows) ([E-06], measured).
- PERF-01 gains a same-hold, same-tool, round-robin rule. PERF-02 takes its latencies from memtier and gains a 1:10 mixed row. To win PERF-02's matched SET row a TS row must reach about 92,000 persisted SETs a second at 200 connections with p99 under 4.9 ms on this box ([E-09a2], measured).
- L3's client shape fixes the pipelined door: the challenge rides in the upgrade's answer ([E-40]).
- TEST-13: Elle means real Elle, and every history carries an invoke and a completion with times ([E-22b]). A Maelstrom adapter needs `--concurrency 2n`, an outside pauser, and Porcupine beside Knossos with a time limit ([E-46]).

## 2. Option against option

**The summary.** "One apart" means the favoured option and the runner-up differ by exactly one mechanism, so the count does not decide (see "The judging rule" above).

| Axis | Favoured | Runner-up | How firm | Depends on a choice the user sets |
|---|---|---|---|---|
| R | `raft` | `rlog` | firm | region scope: multi-region writes bring `epax` back |
| G | `pslot` | `shard` with A-15 | one apart; level if dormant groups are judged not novel. E-36 priced `pslot` with one slot map shared by the project | N_res; SC-13's "small" |
| P | `slot`, moved by one policy | `split` + merge | firm for `slot`. Who decides the moves under C `self` is **undecided**: no experiment ran it | F_w; SC-10's wording |
| K | `lib` | — | firm | — |
| C | `self` | `cent-co` with A-20 | a tie on novel mechanisms (1 each in SPACE). `self` on E-16's threshold: rules, a stuck state as first written, the `#meta` wait. Not firm on the count: DEP-17's hint path and the slow-leader rule's form are open, and `self+p` was not tested | whether a platform hint may change membership (DEP-17) |
| V | `+lrn` | `+lrn +wit` | one apart, two with a budgeted shared tier; the witness was never modelled here | J and OPS-14 (a shared tier); the order in rule 3 |
| Q | `mix` (`maj-d` by default, plus `maj-m` and `none`) | `maj-d` plus `none` | under the proposed value, `maj-d` alone loses a default row by measurement. `maj-m` is shown to win that row only in a native build | the competitor-default rows accepted as losses; axis L |
| D | `sess`, with A-05's `srchi-slot` and A-10's caller keys | `win` | firm | — |
| O | `slot` | — | firm | — |
| T | `clamp` at window 0 | CockroachDB's guard | firm under F-06 as written | F-06's wording (not on the user's list today) |
| X | `saga` with A-24 | `ramp` for units of plain sets | firm for the MUST | — |
| S | `jrnl +tier` | — | firm; SC-15 sits at its bar | the fsync figure of the deploy target |
| F | `all` | `ldr` with a warm standby | firm up to about 5 to 6 GB per process in TS | — |
| W | `any` + `ridx` | — | firm; `lease` was not tested | — |
| U | `any` | — | firm | — |
| H | `emb` | `both` | follows V and N | J and OPS-14 |
| L | `ts→rs` | `ts` | **undecided** between stopping at `ts` and taking the native step. Under the proposed value for accepted losses, the evidence leans to the native step | the fsync figure; the accepted losses |
| I | `port` | etcd's raft run natively in Go | firm for the TS phase; the core of the native step is open | — |
| Y | `fwd` | `smart` added for server clients | firm as the base: every row needs it. The `smart` add-on is open: nothing measured its gain | — |
| M | `kw` | `kwN` | firm for TS rows; a native `kwN` was not measured | — |
| Z | `rejoin` | `par` | **undecided**: one apart, and `par` has a model that shows one more SHOULD met | the order in rule 3; whether PAR is `par`'s precedent |
| N | `proc` | `tier` with A-29 | one apart, or level if each tenant gets a volume. DEP-04 is tight for `proc` | J and OPS-14 |

**Axis by axis.**

**R, replication.** Options: `solo`, `async`, `lww`, `raft`, `rlog`, `vsr`, `isr`, `chain`, `slog`, `obj`, `calvin`, `epax`, `crdt+c`.
- `raft`: a faithful TS port of etcd's raft passes 41 of 41 of etcd's files and 4,000 of 4,000 fuzz scripts ([E-10], measured), is linearizable in 26 of 26 Maelstrom runs ([E-46], measured), and membership holds with A-01 ([E-14c], model-checked). It takes A-01 to A-03.
- `rlog`: +9 rules for the writer handover ([E-16], model-checked). Its handover time of 2 to 5 ms is reasoned ([E-13]).
- `obj`: a conditional PUT costs 1.37 ms p50 on MinIO here (measured), but a real store's p99 is above 10 × C (cited: S3 Standard about 30 ms typical), and 10 writes a second cost $131 a month against DEP-21's $10 bar ([E-28], [E-41]; prices cited from search summaries). It sends no idle frames, but its leases must go quiet or cost PUTs ([E-25]).
- `isr`: `pid` needs 16 rules and 2.1 KB per producer ([E-20]); a log file per group loses to a shared journal ([E-12]); idle fetches are pairwise ([E-25]).
- `slog`: for it, idle frames are 400 a second at n = 100 against 19,800 for pairwise pings, and it needs no peer bound ([E-25], measured: up on X8). Against it, it is not cheapest by 2 times ([E-41]), and it is about 82 times BUY's lines against about 49 for a Raft row ([E-44], an estimate).
- `vsr`: no experiment built it. [E-37] gives it a reason to be costed against "Raft + `par`".
- `lww`: no experiment here; conditions need consensus (cited in SPACE).
- **Favoured: `raft`.** No failed MUST, 0 novel in safety, and the most evidence. **Depends on** region scope: if the user wants writes homed in several regions, SC-14 brings `epax` back.

**G, what one log covers.** Options: `clus`, `lane`, `res`, `shard`, `pslot`, `key`.
- `lane`: fails SC-03 and SC-04 by design (reasoned in [E-17]); 64 lanes give 23 to 53 writers' worth of one resource under skew ([E-18], simulated). `clus` and `res` have one leader.
- `shard`: needs A-15 (dormant groups, +1 mechanism) to meet SC-13's memory clause for resources with few touched slots ([E-36], measured: 1.4 KB an idle resource with it, at 10 slots touched).
- `pslot`: 0.4 to 1.2 KB an idle resource at 1 to 10 slots touched, about 16 groups, a create in 1.6 to 1.8 ms against 4.6 to 5.3 ms ([E-36]). E-36 priced it with one slot map shared by the project. SPACE says slot tables stay per resource; with a run-length table per resource add one run, about 120 B (reasoned). The same move rules as `slot` on the same footing, 28 each ([E-17c], model-checked; D4). Fewer, busier groups beat many thin ones ([E-11], measured: 10,000 groups at one write a second each cost 5 to 12 times the p99).
- Both options pass 2 KB only while few slots are touched: per-slot state alone is about 8.5 KB at 100 touched slots (section 1.3). The cold open's tail is over 5 ms for `shard` with or without dormant groups; `pslot`'s open is a catalog lookup when its groups are awake (reasoned) and the same wake when they sleep.
- Against `pslot`: settings must be equal inside a group, and [E-17b] reasons about 2 placement rules. No experiment ran a big record inside one shared group's batch, or a resource dropped out of a shared group.
- **Favoured: `pslot`**, by one mechanism (it needs no dormant groups). If the two counting agents accept TiKV's hibernate regions as the precedent for dormant groups, the count ties. No experiment compared the two on SHOULDs or on DEV-02's pairs. **Depends on** N_res.

**P, partitions onto groups.** Options: `one`, `fixN`, `slot`, `split`, `ring`, `rekey`, `dir`.
- `slot`: 26 rules on the shared bounds and 28 in a real log, the fewest among the options that meet SC-03, SC-04 and SC-08 ([E-17], [E-17b], [E-17c]: model-checked, crash-only, reproduced by a second agent). TLC agrees with the Python model run for run ([E-15]). It takes A-16, A-17 and A-18.
- `split` + merge: 33 and 37 rules, two protocols, lineage kept for ever. For it: a split copies nothing (up on SC-08(f), [E-17b]), and key-level splits copy less per hotspot move ([E-18]).
- `fixN` + `rekey`: 30 to 38 rules, and it fails SC-08(b) and (f) (model-checked: a write to a partition that never moves waits for the re-key, and that partition's rows are copied). 16 cells give 7 to 15 writers' worth under skew ([E-18]).
- Lanes with range moves: 30 rules.
- Whatever decides the moves needs A-18's policy. E-18 ran it as one loop that sees every slot's exact load. E-17c counted its 28 rules with changes started one at a time, "as one controller would". The one rule a leader can run alone that was simulated, the draft's halving, does not balance.
- **Favoured: `slot`.** Who decides the moves under C `self` is **undecided**: no experiment ran `self` with any mover. There are two forms. One loop on `#meta`'s leader proposes the moves and does nothing else (the blind pick). Or each leader runs a grow-and-shrink rule (P `slot + rule`, DRAFT's form, and this file's first draft). COMP takes the loop, as the form with fewer mechanisms: SPACE's ladder counts `+ rule` as one more, and the loop adds no state of its own, since a move writes `#meta`'s slot table in any case ([E-15]). The loop is also the form E-18 and E-17c ran. Its cost: moves stop while `#meta` has no leader; healing does not (reasoned). **Depends on** F_w and on SC-10's wording (section 1.3): at 4,096 slots the stated ceiling is 135 effective writers with the app split at half a writer's share, above the proposed 64.

**K, where semantics live.** Options: `kern`, `lib`, `hyb`.
- `lib`: all 22 patterns run on the kernel's five operations with no sixth ([E-22], measured in a simulation; [E-22b] confirms with real Elle and Knossos). The libraries above the log are small on either base ([E-44]: a lock is 21 to 64 lines, a queue 62 to 112). A Rust core can keep L2 in JS if it is called on the JS thread or in batches ([E-03]).
- `kern`, `hyb`: no experiment. No dedup rule of any option is a Raft guard ([E-20]).
- **Favoured: `lib`.**

**C, the control plane.** Options: `none`, `self`, `self+p`, `cent`, `cent-co`, `out`.
- `self`: 14 rules; safe and live at every bound; heals while `#meta` is down ([E-16], model-checked; D2).
- `cent-co`: 18 rules as E-16 counts them, 16 with a counterexample; a stuck state as first written, removed by one rule; cannot finish healing in 24 to 62 % of the judged states while `#meta` is down (a delay, not a stuck state); its command list is replicated state of its own; 9 of its 21 mutants are undecided because the mutated models outgrow the explorer, and its smallest model is undecided at the verify bound. One agent counted both.
- `cent`: the same 4 extra rules (reasoned).
- `self+p`: not modelled. E-16 reasons that a hint that can change membership needs `cent-co`'s re-checks.
- On novel mechanisms the two tie: SPACE gives `self` and `cent-co` 1 each. So the count does not pick, and what separates them is E-16's own threshold: rules, the stuck state, the wait, and one more interacting pair for `cent-co` (commands against each group's config epoch, DEV-02).
- Three things sit outside E-16's model, and each can cost `self` more than `cent-co`. Someone must decide slot moves (axis P). DEP-17 (M) asks for drains, retirements, gone reports and placement hints from the platform: E-16 modelled no hint, leave or drain for either option, and with a hint path `self` is SPACE's `self+p` (+1 mechanism in SPACE). The slow-leader rule's only form for a row with no controller has no precedent on offer (A-03).
- **Favoured: `self`**, on E-16's threshold. It is not firm on the count: if the counting agents find `self` two mechanisms above `cent-co`, rule 3 picks `cent-co`. What `cent-co` was meant to buy, one place that sees every group, is a balancing need, not a healing rule; a balancer that only moves slots can sit off the healing path (E-16, reasoned). The crossings are K-07 and K-08.

**V, replica kinds.** Options: `full`, `+lrn`, `+wit`, `tier`.
- `+lrn`: a learner grants a vote when it is asked (A-01, [E-14b]); the candidate counts it only if its own configuration lists that member as a voter. 0 novel.
- `+wit`: 1 novel ("lead only to repair"). No experiment in this study modelled it: [E-16] starts every group at three full voters and names witnesses as left out. It buys DEP-15 (S). DRAFT's shared third voter is the cheapest way to run 10 writes a second; MIN costs 1.5 times that, inside DEP-21's 2 times ([E-41], cited prices).
- A witness on a tier shared between projects also takes A-29.
- **Favoured: `+lrn`**, by one mechanism; by two only if the tier is shared, kept apart by a budget, and the budget is judged a novel mechanism. **Depends on** whether J allows a shared tier, and on the order in rule 3: at one apart, DEP-15 (S) would count for `+wit`.

**Q, what a commit means.** Options: `maj-d`, `maj-m`, `isr`, `ldr`, `none`, `put`, `mix`.
- `maj-d` alone: JetStream's default acks a single publisher at p99 0.55 ms, below C = 0.73 ms, the floor of any `persisted` commit on this box ([E-09b], both measured). So a `persisted` rung cannot win that row of PERF-04. Redis's default rows at pipeline 16 and Kafka's default maximum also need the `memory` rung ([E-09a], reasoned from [E-02]'s tails; [E-09c]).
- `maj-m`: +1 mechanism ("a replica that stops uncleanly rejoins as new"; Kafka's default and Redpanda's write caching are the cited precedents). Its speed was measured ([E-02]: p99 0.57 ms in TS, 0.33 ms in Rust, both at 50,000 appends a second on a pipeline with no protocol work, not with one write in flight). Its safety was never modelled. In TS it only ties JetStream's 0.55 ms, and PERF-01 counts a tie only at the measured floor. In Rust it wins.
- `none`: required by P-06 in every row.
- `put`: see R `obj`.
- **Favoured: `mix`** = `maj-d` by default, with `maj-m` and `none` per resource. **Depends on** the user's list of competitor-default rows accepted as losses. Today that list is empty, and PERF-01 then makes the matching rung a MUST. **It also depends on L**: `maj-m` is shown to win its row only in a native build. In a build that stays TS, `maj-d` plus `none` gives the same result on that row with one mechanism fewer. If the user accepts the default rows of PERF-02, PERF-04 and PERF-05 by name, `maj-d` plus `none` wins by one mechanism.

**D, dedup.** Options: `win`, `sess`, `pid`, `keys`, `txn`, `srcpos`.
- `sess`: 13 rules, no time rule, 309 B per active client; 14 under `fwd` (A-21). `win`: 17, and 19 under `fwd`. `pid`: 16. `keys`: 12, but memory per write: 13 GB for one busy writer at a 10-minute TTL ([E-20], model-checked; memory measured).
- None survives a restart past its horizon, so every row adds `srchi-slot` (A-05, [E-30]). `srcpos` holds too but costs about 5 TB at 1e5 outputs a second for a week.
- A dedup window alone fails past its horizon on a real system too ([E-44], measured on JetStream).
- **Favoured: `sess`**, with `srchi-slot`. Caller keys (TEST-03) ride beside it in every row (A-10). E-20 reasons one rule under `sess` (a session per call), and calls a `keys` table right where the user brings a key with a short TTL. Neither was modelled apart.

**O, positions.** Options: `off`, `off+lin`, `slot`, `part`, `hlc`, `lamp`.
- `slot`: +3.9 B and at most 22 ns a record; a whole-resource cursor is 1.0 to 3.3 KB delta-coded at 1,024 slots ([E-19], measured). Cursors made of group offsets break both subscribe modes at the first move, in 5 steps ([E-31], model-checked).
- `off`: 4 to 5 B smaller a record, but a re-key or a split changes what a position means.
- **Favoured: `slot`.**

**T, time.** Options: `clamp`, `hlc`, `mono`, `tso`, `tt`.
- `clamp` at window 0: 7 rules, every check passes where at most one clock is wrong, and a leader's clock jump costs no failover ([E-21], simulated; D1).
- `hlc`: what the ablation keeps is the leader's own clock plus CockroachDB's step-down guard, also 7 rules, with a failover on every leader clock jump (60 of 60 runs).
- `mono`: a row can live a whole TTL too long after a failover. `tt`: 4 rules, but it needs clock hardware. `tso`: not modelled.
- Fencing makes lock safety independent of the clock rule under every option.
- **Favoured: `clamp` at window 0.** **Depends on** F-06's wording: if the user would rather take one failover per leader clock jump, the guard is the smaller design by precedent (E-21).

**X, atomicity across partitions.** Options: `none`, `saga`, `grp`, `2pc`, `det`, `ktxn`, `ramp`.
- `saga` with A-24: meets P-15's MUST with 1 novel rule as E-24 counts it ([E-24], model-checked; D5). No MUST needs atomic visibility ([E-22]). The SHOULD stays unmet: Elle finds fractured reads in 66 to 77 of 100 saga histories (E-22; [E-22b] confirms the verdicts with real Elle).
- `ramp`: read atomicity for units of plain sets with 1 novel rule (19 rules, 20 of 20 mutants; model-checked), one read round, or two for 8 to 12 % of reads. For fero's operations (`push`, `incr`) real Elle finds fractured reads, and the fix needs at least 3 novel rules (reasoned from a simulation), above E-24's threshold of 2.
- `2pc`, `ktxn`: the published routes to the SHOULD for operations (Percolator, Kafka's `read_committed`); SPACE prices both "large". No experiment here ran either.
- `grp`: no experiment.
- **Favoured: `saga` with A-24.** `ramp` meets the SHOULD for units of plain sets only; how that counts is the judges'.

**S, storage.** Options: `jrnl`, `walg`, `lsm`, `+tier`, `obj`.
- `jrnl` beats a log file per group from 256 groups up, with 8 to 30 times fewer fdatasyncs ([E-12], measured on ext4 with and without jbd2, and on XFS).
- `jrnl` sits at SC-15's bar on this disk with no new mechanism. A 1 MiB record ten times a second raised others' p99 by 1.26 times in a first set of three runs and by 1.18 times in a second, against the 1.2 bar ([E-35], measured). E-35's own word is "holds, just". Whether that is met or open is the judges'. The test was at the journal, not inside one shared group (K-06).
- `+tier`: the home for sleep, wake, forks and history ([E-28]); A-08's conditional create also needs the store.
- `obj`: see R `obj`. `lsm`: no experiment.
- **Favoured: `jrnl +tier`**, with A-09 and A-25.

**F, where state is folded.** Options: `all`, `ldr`, `lazy`.
- `all`: 0.22 to 1.90 µs a record and 315 to 338 B a row ([E-05], measured), but decode plus fold is about twice E-02's follower CPU per append. It meets SC-05 only up to about 5 to 6 GB of rows per process in TS ([E-34]; A-13).
- `ldr`: saves a follower's fold CPU; needs A-26's warm standby; its saving in money shows only above about 2 GB of rows per copy ([E-41]).
- Replicas and clients that fold and serve reads are exposed to drift in `sum` views until A-10's view rule lands; `ldr` rows only at failover ([E-43]).
- `lazy`: no experiment.
- **Favoured: `all`.**

**W, reads.** Options: `lease`, `ridx`, `any`.
- `any`: holds with A-06 ([E-31]). `ridx`: ReadIndex and log reads were linearizable in every Maelstrom run, and a planted follower-read bug was caught in 8 of 8 ([E-46], measured).
- `lease`: no experiment; it needs bounded clock drift.
- **Favoured: `any` with `ridx`.**

**U, where user code runs.** Options: `any`, `ldr`, `both`, `cli`.
- Nothing is safe only at the writer: a check-then-set is safe with a condition wherever the call runs, and unsafe without one even at the writer ([E-22], measured in a simulation). So `ldr` buys no safety. A synchronous call to a daemon costs about 33 µs ([E-03]).
- `cli`: servers beside the app's machines cost 2.4 to 3.7 times the cheapest at 10 writes a second ([E-41]).
- **Favoured: `any`.**

**H, where fero runs.** Options: `emb`, `srv`, `both`, `side`.
- `srv`: [E-41] as under U. `side`: a kernel on a worker already keeps replication alive through a 5 s main-thread stall ([E-07]), which was `side`'s reason; a socket seam fails E-03's 2 times bar.
- `both` is `emb` plus log members; it is needed only with V `+wit` or N `tier`.
- **Favoured: `emb`**, following V and N.

**L, language.** Options: `ts`, `ts→rs`, `rs+napi`, `rs-srv`, `rs+v8`, `wasm`, `go-srv`.
- A TS pipeline is viable on this floor: 5.5 µs of CPU per append against a 20 µs bar, p99 4.3 ms against 5.7 ms ([E-02], measured; a ceiling with no protocol work). Rust first gains nothing at moderate rates.
- Native builds win on tails and on CPU-bound ceilings: Rust is about 2.5 times TS with the disk out of the way, with a 3 times tighter p99. Redpanda's matched rate is only 1.62 times under TS's ceiling ([E-09d]); core NATS is 1.9 times under TS's socket-free ceiling ([E-09b]); etcd's single-client p99 beats TS's ([E-09e]).
- A Rust kernel in WASM can be the sim's kernel, so going native later need not mean two kernels for good ([E-04], measured).
- raft-rs cannot run etcd's 28 interaction files and lacks StepDownOnRemoval and etcd's newer fixes; a Rust port of etcd's raft was not tried ([E-10]; G-24).
- No fero kernel has run through the competitors' tools at speed: [E-45]'s gateways drove a simulator ([E-09a2]: 6 to 54 times below Redis). So every PERF row is open for every language.
- **Undecided** between `ts` for good and a later native step. The judging rule does not separate them: neither fails a MUST by design on the evidence in hand, and language adds no mechanism. The evidence leans to the native step under the proposed value for accepted losses: Q's `memory` rung is there to win PERF-04's default row, and it is shown to win it only in Rust (0.33 ms against 0.55; TS ties at 0.57; read at 50,000 a second). What would decide it: a real kernel driven by E-45's gateways on PERF-03, PERF-04's single-publisher row and PERF-06. `ts→rs` is taken as the default here: its first phase is `ts`, it adds no mechanism, and it keeps the native step open.

**I, the Raft core.** Options: `port`, `own`, `raft-rs`, `openraft`, `jslib`.
- `port`: confirmed ([E-10], [E-46]). `own`: etcd's TLA+ spec alone misses the campaign guard that etcd's code has ([E-14]). `raft-rs`: a drifted fork without etcd's oracle; not blocked. `jslib`: out. `openraft`: not examined.
- The async writes that F-18's p99 clause needs (A-03) are in etcd's raft and the port. raft-rs 0.7.0 has async persistence under a different API, not etcd's message contract, so etcd's files and traces for it do not carry over ([E-10]). It also lacks StepDownOnRemoval, so A-01 is reasoned for every `raft-rs` row.
- SPACE writes `port` as "port etcd's raft to TS; raft-rs later". On this evidence the "later" half is open: raft-rs as it is, or a Rust port of etcd's raft checked by etcd's own files, which nobody tried (G-24).
- **Favoured: `port`.**

**Y, how a write reaches its writer.** Options: `fwd`, `smart`, `proxy`.
- `fwd` needs one hop rule under `sess` (A-21); `smart` needs none on its path ([E-20]). Browsers stay `fwd` in every row, so the rule is written and tested either way; `smart` only takes it off the path of server clients.
- `smart` rows meet F-17's client-level clause by routing; `fwd` rows by A-02's redirect ([E-38c]).
- The extra hop is at least one loopback round trip: 96 µs p99 in Node, 58 µs in Rust, which is 8 to 13 % of C ([E-01], measured). A forward through a real server, or over a real network, was not measured.
- **Favoured: `fwd`.** It is the base in every row: browsers need it (SPACE; DEP-07), so `smart` can be added but cannot take its place. Both are 0 novel. Whether server clients also get `smart` is open: no experiment measured what it would gain, and its MOVED and ASK path was never examined (G-25).

**M, threads.** Options: `loop`, `kw`, `kwN`, `tpc`.
- `kw`: kept its heartbeat within 5 ms through a 5 s main-thread stall, where a main-thread kernel went silent for 2.6 to 5.1 s ([E-07], measured). So `loop` goes against F-14.
- `kwN`: TS workers fed by one main thread gave 0.8 to 1.03 times one worker ([E-02], measured, TS only: the limit was the main thread that makes every write). No native `kwN` ran: E-02's Rust and Go builds have one kernel thread. A journal per worker costs latency on this disk ([E-12], Node and Rust). This 4-vCPU box cannot show its gain on a machine with cores to spare.
- `tpc`: no experiment.
- **Favoured: `kw`**, with A-27.

**Z, storage faults.** Options: `crash`, `rejoin`, `par`.
- `crash`: Raft as published loses a committed write with one bad entry (TLC, one fault, 32 states; [E-37]). It goes against F-22 (M).
- `rejoin`: 2 rules, meets F-22 (M); never writable with one bad entry on each of two replicas.
- `par`: 7 rules, each shown needed, and 1 more mechanism (a bad mark per entry, and repair from a peer). It meets F-22 (S): 0 stuck states of 276 two-damage states. The precedent on offer is PAR (Alagappan et al., FAST'18, built into LogCabin, a Raft implementation; cited). It was checked with three voters and no membership change, and damage above the commit point needs PAR's "possibly committed" query (G-15).
- **Undecided.** The two are one mechanism apart, or level if the counting agents accept PAR as `par`'s precedent. Either way rule 3 as written lets the SHOULD decide, and `par` meets F-22 (S). Against that, rule 4 ranks few mechanisms first, and the rule is not transitive: `par` wins as the only add-on and loses once a second add-on is stacked on it. COMP takes `rejoin`, the option with fewer mechanisms. A checksum per entry and room for a bad mark in the phase-1 format keep `par` open with no shape change (reasoned).

**N, tenancy.** Options: `proc`, `pool`, `tier`.
- `proc`: nothing resident while a project sleeps. A wake is then a cold start: 265 to 318 ms for three processes with 20 groups on this warm box ([E-26], measured), plus the real machine start. v4 measured 1.4 s for a wake (cited from J) against DEP-04's 1.5 s, so DEP-04 is tight for `proc` on real hosting. Tenants stay off one disk (reasoned in [E-35], not tested).
- `tier`, `pool`: take A-29. In a live tier process a project of 20 dormant groups wakes in 10 to 16 ms, so DEP-04 is loose ([E-26], measured). A shared tier or pool saves about a third of the cost ([E-41], cited prices). SPACE counted `tier` at 0 with "OPS-14 applies".
- **Favoured: `proc`**, by one mechanism, or level if each tenant gets a volume. DEP-04 goes against it. With V `+lrn` and H `emb` there is no log tier to pool, so N follows V. **Depends on** J: a shared tier is allowed only if the user changes J.

## 3. The 19 rows as amended

A `*` marks an option that section 1 changed. The footnotes are SPACE's, unchanged.

| Id | R | G | P | K | C | V | Q | D | O | T | X | S | F | W | U | H | L | I |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DRAFT | raft* | shard* | slot* + rule* | lib | self+p* | +lrn +wit | mix | win | slot* | clamp* | saga* | jrnl* +tier | all | any* ridx | any | both | ts→rs* | port |
| MIN | raft* | shard* | slot* | lib | cent-co* | +lrn | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier¹ | all | any* ridx | any | emb | ts→rs* | port |
| RUST | raft* | shard* | slot* | lib | cent-co* | +lrn | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier¹ | all | any* ridx | any | emb | rs+napi* | raft-rs |
| SRV | raft* | shard* | slot* | lib² | cent-co* | +lrn | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier | all² | any* ridx | cli | srv | rs-srv* or go-srv⁸ | raft-rs or etcd raft⁸ |
| LEAN | raft* | shard* | slot* | lib | cent-co* | +lrn³ | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier¹ | ldr* | ridx; any* for logs | any | emb | ts→rs* | port |
| CELL | raft* | shard* | fixN + rekey | lib | self* | +lrn +wit | mix | sess* | off | clamp* | saga* | jrnl* +tier | all | any* ridx | any | both | ts→rs* | port |
| LANE | raft* | lane | fixN (lanes) | lib | self+p* | +lrn +wit | maj-d | win | off | clamp* | saga* | jrnl* +tier | all | any* ridx | any | both | ts→rs* | port |
| SPLIT | raft* | shard* | split | lib | self+p* | +lrn +wit | mix | win | off+lin | clamp* | saga* | jrnl* +tier | all | any* ridx | any | both | ts→rs* | port |
| PD | raft* | shard | split + merge | kern | cent* | +lrn | maj-d | txn | hlc | tso | 2pc | lsm | all | lease ridx | cli | srv | rs-srv* | raft-rs |
| ISR | isr | shard | fixN | hyb | cent* | full | isr | pid* | off | clamp* | ktxn | walg +tier | all | any* | any | both | ts→rs* | port⁴ |
| SLOG | slog | shard* | slot* | lib | cent*⁵ | tier +lrn | maj-d⁶ | win | slot* | clamp* | saga* | tier + obj | all | any* | any | both | ts→rs* | port⁴ |
| OBJ | obj | shard | slot* | lib | cent*⁷ | tier | put | sess* | slot* | clamp* | saga* | obj | ldr* + lazy | lease any* | any | both | ts→rs* | — |
| V4 | lww | res | ring | kern | self | full | mix | win | lamp | — | none | walg | all | any | any | emb | ts | — |
| MIN-P | raft* | pslot | slot* | lib | cent-co* | +lrn | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier¹ | all | any* ridx | any | emb | ts→rs* | port |
| MIN-TS | raft* | shard* | slot* | lib | cent-co* | +lrn | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier¹ | all | any* ridx | any | emb | ts | port |
| RLOG | rlog* | shard* | slot* | lib | cent-co* | tier +lrn⁹ | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier | all⁹ | any* ridx | any | both | ts→rs* | port |
| EMB-V8 | raft* | shard* | slot* | lib | cent-co* | +lrn | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier | all¹⁰ | any* ridx | any | srv | rs+v8* | raft-rs |
| SIDE | raft* | shard* | slot* | lib | cent-co* | +lrn | maj-d | sess* | slot* | clamp* | saga* | jrnl* +tier¹ | ldr*¹¹ | ridx; any* for logs | ldr | side* | rs-srv + ts* | raft-rs |
| BUY¹² | outside | theirs | theirs | lib | theirs | theirs | theirs | theirs | theirs | theirs | saga* | theirs | all | any | any | srv | ts client | — |

¹ An object store is required across boxes, as draft decision 23a proposes. ² The server folds plain rows in Rust; `data`'s views run on clients and relays. ³ One warm standby that folds. ⁴ For the metadata group only. ⁵ The writer changes its log nodes; the controller changes writers (F3). ⁶ A write quorum of the log nodes. ⁷ CAS on the object store's manifest. ⁸ Two variants of one row: Rust with raft-rs, or Go with etcd's raft run natively; E-02 and E-11 measure both. ⁹ Log members vote; servers are full learners that fold; the writer is a server holding a writer epoch. ¹⁰ `data` folds inside V8 isolates in the server. ¹¹ The app's Node process folds for the groups its host leads; every app folds what it follows. ¹² NATS JetStream first (Redpanda or FoundationDB also fit); a reference row, not a contender.

| Id | Y | M | Z | N |
|---|---|---|---|---|
| DRAFT, CELL, LANE, SPLIT, SLOG, RLOG | fwd | kw* | rejoin* | tier* |
| MIN, RUST, LEAN, MIN-P, MIN-TS | fwd | kw* | rejoin* | proc |
| SRV | smart | kwN | rejoin* | proc |
| EMB-V8 | smart | kwN | rejoin* | pool* |
| SIDE | fwd (to the local daemon) | kwN (daemon) | rejoin* | proc |
| PD | smart | kwN | crash | proc |
| ISR | smart | kw* | crash | proc |
| OBJ | fwd | kw* | crash | tier* |
| V4 | fwd | loop | crash | proc |
| BUY | smart | theirs | theirs | theirs |

**The fixes each row takes.** A-04 to A-13 apply to every row as far as the row has the part they touch; they are not repeated below.

| Row | Raft fixes | Fixes for its own options |
|---|---|---|
| DRAFT | A-01, A-02, A-03 | A-15, A-16, A-17, A-18, A-19, A-23, A-24, A-25, A-27, A-28, A-29, A-30 |
| MIN | A-01, A-02, A-03 | A-15, A-16, A-17, A-18, A-19, A-20, A-21, A-23, A-24, A-25, A-27, A-28, A-30 |
| RUST | A-01 (reasoned), A-02, A-03 | as MIN; of A-30 the call rule only |
| SRV | A-01 (reasoned in its Rust variant), A-02, A-03 | A-15, A-16, A-17, A-18, A-19, A-20, A-21 (for browser clients), A-23, A-24, A-25, A-28, A-30 (the guard for its native fold) |
| LEAN | A-01, A-02, A-03 | as MIN, plus A-26 |
| CELL | A-01, A-02, A-03 | A-15, A-19, A-21, A-23, A-24, A-25, A-27, A-28, A-29, A-30 |
| LANE | A-01, A-02, A-03 | A-19, A-23, A-24, A-25, A-27, A-28, A-29, A-30 |
| SPLIT | A-01, A-02, A-03 | A-15 (reasoned), A-19, A-23, A-24, A-25, A-27, A-28, A-29, A-30 |
| PD | A-01, A-02, A-03 (reasoned) | A-19 (reasoned), A-20 (reasoned), A-30 (the guard for its native fold, reasoned) |
| ISR | metadata group only | A-20 (reasoned), A-22, A-23, A-27, A-30 |
| SLOG | metadata group only | A-15 (reasoned), A-16, A-17, A-18, A-20 (reasoned), A-23, A-24, A-27, A-28 (reasoned), A-29, A-30 |
| OBJ | — | A-16, A-17, A-18, A-20 (reasoned), A-21, A-23, A-24, A-26 (reasoned), A-27, A-29, A-30 |
| V4 | — | none |
| MIN-P | A-01, A-02, A-03 | as MIN, without A-15 |
| MIN-TS | A-01, A-02, A-03 | as MIN, without A-30 |
| RLOG | A-01, A-02, A-03 | A-14, A-15, A-16, A-17, A-18, A-19, A-20, A-21, A-23, A-24, A-25, A-27, A-28, A-29, A-30 |
| EMB-V8 | A-01 (reasoned), A-02, A-03 | A-15, A-16, A-17, A-18, A-19, A-20, A-21 (for browser clients), A-23, A-24, A-25, A-28, A-29, A-30 (deno_core only) |
| SIDE | A-01 (reasoned), A-02, A-03 | A-15, A-16, A-17, A-18, A-19, A-20, A-21, A-23, A-24, A-25, A-26 (reasoned), A-28, A-30 (the ring) |
| BUY | — | A-24, in fero's L5 library |

**Row by row.** Each paragraph says what the fixes changed, then which findings of section 2 go against an option the row holds. Every finding of section 2 against an option counts for every row that holds the option, whether or not its paragraph repeats it.

**DRAFT.** Changed: dormant groups (A-15), 4,096 slots and the move's carried set (A-16, A-17), the move policy in place of its halving rule (A-18), the median for writer time (A-23), the saga's two rules (A-24), a tenant budget on its shared tier (A-29), and `fero init` across boxes (A-08). Against it: D `win` needs 19 rules under `fwd` against 14 for `sess`, and fails past its horizon ([E-20], [E-44]); V `+wit` and C's `+p` half were never modelled here; a grow rule run by each leader was never simulated beyond the halving that fails; its two-decider give-up costs 4 to 5 rules more than one (A-17); the `memory` rung of Q `mix` was never modelled; G `shard` is one mechanism dearer than `pslot`; N `tier` takes A-29; `fero init` costs SC-02.

**MIN.** Changed: its controller takes 4 more rules and waits while `#meta` is down (A-20); dormant groups (A-15); `forward.once` (A-21); the conditional create (A-08). Against it: C `cent-co` loses to `self` on E-16's threshold ([E-16]); Q `maj-d` alone cannot win PERF-04's default single-publisher row ([E-09b]); G `shard` against `pslot`; DEP-15 (S) is lost without a witness.

**RUST.** As MIN, with the napi call discipline (A-30) and one Rust kernel that is also the sim's kernel as WASM, so no twin ([E-04]). Against it: all of MIN's, and I `raft-rs` is a drifted fork without etcd's oracle and without StepDownOnRemoval, so A-01 is reasoned for it ([E-10]); L `rs+napi` gains nothing at moderate rates ([E-02]).

**SRV.** As MIN; `forward.once` is written and tested for its browser clients only (A-21); the twin guard covers its native fold (A-30); `fero init` across boxes. Against it: `cent-co`, `maj-d` alone, `shard` and the lost DEP-15 (S) as MIN; M `kwN` was not measured in a native build, and its journal per worker goes against A-25 ([E-12]); H `srv` and U `cli` cost 2.4 to 3.7 times the cheapest at small loads ([E-41]); `raft-rs` in its Rust variant; a native L gains nothing at moderate rates ([E-02]); `fero init` costs SC-02.

**LEAN.** As MIN, and its warm standby is required (A-26). Against it: MIN's, and F `ldr` saves money only above about 2 GB of rows per copy ([E-41]).

**CELL.** Changed: dormant groups for its 16 groups per resource (A-15, [E-26]), `forward.once`, the median, the saga's rules, a tenant budget, `fero init`. Against it: P `fixN + rekey` fails SC-08(b) and (f) (model-checked, [E-17c]) and gives 7 to 15 writers' worth under skew, below F_w ([E-18]); O `off` breaks at a re-key ([E-31]); V `+wit` and Q `mix`'s `memory` rung not modelled; G `shard` against `pslot`; N `tier` takes A-29; `fero init` costs SC-02.

**LANE.** Changed: the median, the saga's rules, a tenant budget, `fero init`. Against it: G `lane` fails SC-03 and SC-04 by design (reasoned) and gives 23 to 53 writers' worth ([E-17], [E-18]); D `win`; Q `maj-d` alone; O `off` if a lane's range ever moves; V `+wit` and C's `+p` half not modelled; N `tier` takes A-29; `fero init` costs SC-02.

**SPLIT.** Changed: dormant groups (reasoned), the median, the saga's rules, a tenant budget, `fero init`. For it: a split copies nothing ([E-17b]). Against it: P `split` needs 37 rules against 28, in two protocols, with lineage kept for ever ([E-17c]); about 82 times BUY's lines against about 49 for the other Raft rows ([E-44], an estimate); D `win`; C's `+p` half, V `+wit` and Q `mix`'s `memory` rung not modelled; G `shard` against `pslot`; N `tier` takes A-29; `fero init` costs SC-02.

**PD.** Changed: little; it is a published design. Its controller carries A-20's rules and A-19's healing rules, and its native fold takes A-30's guard (all three reasoned). Against it: Z `crash` loses a committed write with one bad entry ([E-37], model-checked on etcd's spec); P `split + merge` at 37 rules; Q `maj-d` alone; H `srv` at small loads ([E-41]); I `raft-rs`; C `cent`'s 4 extra rules and the `#meta` wait (reasoned); M `kwN` not measured; DEP-15 (S).

**ISR.** Changed: `pid`'s two fixes (A-22), the median. Against it: D `pid` at 16 rules and 2.1 KB per producer ([E-20]); S `walg` loses to a shared journal from 256 groups ([E-12]); P `fixN` has no growth; idle fetches pass PERF-12 only below about 1e4 partitions ([E-25]); SC-13 was not priced for its N partitions per resource; C `cent`'s 4 extra rules (reasoned); Z `crash` was not checked for it.

**SLOG.** Changed: 4,096 slots and the move's carried set, the move policy, dormant groups (reasoned), the median, the saga's rules, a tenant budget, the conditional create. For it: 400 idle frames a second against 19,800, with no peer bound ([E-25]). Against it: D `win`; Q `maj-d` alone; about 82 times BUY's lines against about 49 for a Raft row ([E-44], an estimate); C `cent`'s 4 extra rules (reasoned); a loglet's idle cost for SC-13 was not measured; N `tier` takes A-29.

**OBJ.** Changed: slots and the move policy, `forward.once`, the median, the saga's rules, a tenant budget, a required warm standby (reasoned). Against it: R `obj` with Q `put` is above 10 × C on a real store (cited) and costs 13 times DEP-21's $10 bar ([E-28], [E-41]); its leases must go quiet or cost PUTs ([E-25]); Z `crash` not checked; C `cent`'s 4 extra rules (reasoned); F `ldr` saves money only above about 2 GB of rows per copy; N `tier` takes A-29.

**V4.** It takes no option fix: it has no Raft group, no slots and no `#meta`. The all-row items A-05, A-07, A-09, A-10 and A-13 would apply if it were built on. Against it: M `loop` goes silent in a main-thread stall ([E-07]); D `win` past its horizon ([E-44]); S `walg` loses to a shared journal from 256 groups ([E-12]); [E-42] lists it with BUY as a row that cannot get the always-on recorder; R `lww` cannot hold conditions (cited in SPACE).

**MIN-P.** As MIN, but with no dormant groups: `pslot` meets SC-13's memory clause without them ([E-36]) and ties `slot` on move rules ([E-17c]). Against it: MIN's (C `cent-co`; Q `maj-d` alone; DEP-15 (S) lost without a witness), and what no experiment ran for `pslot`: a big record in one shared group's batch, a resource dropped out of a shared group, a balancer over many resources, and a slot table per resource (E-36 priced one map shared by the project).

**MIN-TS.** As MIN, with one kernel and no TEST-10 guard. Against it: MIN's, and L `ts` has no native step: Redpanda's matched rate leaves it a 1.62 times disk margin and no CPU margin ([E-09d]), its tail is wider than etcd's and JetStream's single-client rows ([E-09e], [E-09b]), and a `memory` rung would only tie JetStream's default row ([E-09b]).

**RLOG.** As MIN, plus 9 rules for the writer handover (A-14), a tenant budget on its tier, and `fero init`. Against it: R `rlog` is one mechanism and 9 rules over `raft`; about 82 times BUY's lines against about 49 for the other Raft rows ([E-44], an estimate); C `cent-co`; Q `maj-d` alone; G `shard` against `pslot`; N `tier` takes A-29; `fero init` costs SC-02.

**EMB-V8.** As SRV, with deno_core only (A-30), one Rust kernel with no twin, and a tenant budget for its pool (A-29). Against it: `cent-co`, `maj-d` alone, `shard`, `raft-rs`, the lost DEP-15 (S); M `kwN` not measured in a native build; N `pool` takes A-29; `data`'s fold runs at 0.80 times Node inside the isolate ([E-03]); a native L gains nothing at moderate rates (reasoned from [E-02], which names RUST and SRV); `fero init` costs SC-02.

**SIDE.** As MIN, with a shared-memory ring (A-30), one Rust kernel with no twin, and a required standby (reasoned). Against it: H `side`'s own reason is met by M `kw` in one process ([E-07]); each synchronous call to the daemon costs about 33 µs against 3 and 10 µs bars ([E-03]); U `ldr` buys no safety ([E-22]); F `ldr` saves money only above about 2 GB of rows per copy; `cent-co`, `maj-d` alone, `shard`, `raft-rs`, the lost DEP-15 (S); M `kwN` not measured in a native build; a native L gains nothing at moderate rates (reasoned from [E-02]).

**BUY.** The reference row. Its saga takes A-24 in fero's L5 library; fencing on JetStream is by convention ([E-44]). Four patterns run on JetStream in 164 fero-owned lines; ten gaps need fero's own kernel, among them failover at 5.2 to 7.2 s against F-05's 2.5 s ([E-44], measured). It stays out by construction.

## 4. The composite row, COMP

COMP takes, on each axis, the option section 2 favours. Where section 2 is undecided it takes the option with fewer novel mechanisms, and says so here: L `ts→rs` (0 either way; its first phase is `ts`), Z `rejoin`, and for the mover of slots under C `self`, one loop on `#meta`'s leader. On G, V and N one mechanism separates the options. Rule 3 lets SHOULDs decide a gap of one, so the count alone does not pick there; COMP takes the smaller option for the two reasons given under "The judging rule".

| Id | R | G | P | K | C | V | Q | D | O | T | X | S | F | W | U | H | L | I |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| COMP | raft* | pslot | slot*¹⁴ | lib | self*¹⁵ | +lrn | mix¹³ | sess*¹⁶ | slot* | clamp* | saga* | jrnl* +tier¹ | all | any* ridx | any | emb | ts→rs* | port |

| Id | Y | M | Z | N |
|---|---|---|---|---|
| COMP | fwd | kw* | rejoin*¹⁷ | proc |

¹ As above. ¹³ `maj-d` by default; `maj-m` and `none` per resource, never per write, because G `pslot` cuts groups by durability. `maj-m` is there only because the user's list of accepted competitor-default losses is empty, and it is shown to win its row only in a native build ([E-09b]). ¹⁴ 4,096 slots, with 1,024 the fallback (D10). One give-up decider (A-17). Moves are proposed one at a time, with a strict-improvement margin, by one loop on `#meta`'s leader (A-18). ¹⁵ Each group's leader heals its own replicas. The loop of ¹⁴ proposes slot moves only; it never heals. DEP-17's hint path is owed: in SPACE it is the `+p` of `self+p`, and it was not modelled. ¹⁶ With `srchi-slot` marks (A-05) and caller keys (A-10). ¹⁷ Undecided against `par` (section 2, Z).

**In one line.** MIN-P with each group's leader healing its own replicas, the loop on `#meta`'s leader kept only to propose slot moves, and a `memory` rung beside `persisted` and `none`.

**The fixes COMP takes.** A-01 to A-13, and A-16, A-17, A-18, A-19, A-21, A-23, A-24, A-25, A-27, A-28, A-30 (the guard, from its native step on). It does not take A-15 (no dormant groups) or A-29 (no shared tier). It does not take A-20 as a whole (no healing controller); but if DEP-17's hints may change membership, E-16 expects A-20's epoch check, two re-checks and timeout for them (reasoned).

**How it differs from the nearest row, MIN-P.** Two axes differ; the other 20 keep MIN-P's tag. Inside those tags COMP takes the same fixes MIN-P takes.

| Axis | MIN-P | COMP | The evidence for the change | What COMP gives up or adds |
|---|---|---|---|---|
| C | `cent-co`: one loop heals and moves | `self`: leaders heal; one loop on `#meta`'s leader only proposes moves | [E-16]: 14 rules against 18 (16 with a counterexample); no command list for healing; heals while `#meta` is down. [E-18] and [E-17c] ran the moves with one decider. E-16 reasons that a balancer that only moves slots can sit off the healing path | the two halves were never modelled together (K-07). DEP-17 needs a hint path: SPACE's `+p`, +1 by SPACE's ladder, not modelled; E-16 expects the re-checks if a hint can change membership (K-08). The slow-leader rule's only form here has no precedent on offer (A-03). Nobody decides a move's give-up when the target group is gone for good (K-27) |
| Q | `maj-d` | `mix` | [E-09b]: `persisted` cannot win PERF-04's default single-publisher row | +1 mechanism (`maj-m`), never modelled (K-09). It is shown to win that row only in the native build: TS ties at 0.57 against 0.55 ms, Rust wins at 0.33, both read at 50,000 a second and not with one write in flight. So `maj-m` is priced with the native step |

Like MIN-P, COMP gives up DEP-15 (S): it has no witness.

**The count against MIN-P.** The count is the two counting agents'. By SPACE's own numbers COMP carries one mechanism more than MIN-P for sure: the `memory` rung. Three more lines are open.
- The hint path. Under `self` it is SPACE's `+p`, +1 in SPACE's ladder. MIN-P's controller would take hints as inputs to its loop, which SPACE does not count. Neither was modelled.
- The slow-leader rule. COMP can use only the leader's own form, which has no precedent on offer. MIN-P can use the controller's form, which has one (cited from memory).
- The move loop. It adds no state of its own, so it is 0 by DEV-10 (a)'s letter, the same as the policy inside MIN-P's controller.

So COMP is 1 to 3 mechanisms above MIN-P, and at 2 or more rule 3 gives the lower count the win. The first two open lines belong to C `self`. If the counting agents count both, `self` is 2 above `cent-co`, rule 3 picks `cent-co`, and COMP becomes MIN-P with a `memory` rung. One thing comes before the count: under the proposed value for accepted losses, Q `maj-d` alone loses PERF-04's default single-publisher row by measurement of both floors ([E-09b]), and rule 1 comes before rule 3. COMP's own `memory` rung is shown to win that row only after the native step.

**One add-on the row rule might admit.** COMP+par is COMP with Z `par`: +5 rules (7 against 2), +1 mechanism with novelty open, F-22 (S) met, not modelled with a membership change. Rule 3 as written lets its one SHOULD outweigh its one mechanism. The judges score it beside COMP.

**What COMP carries.** For the two counting agents; the count is theirs.

| Piece | From | Novel? |
|---|---|---|
| Raft with membership on commit, learners | R `raft`, I `port`, V `+lrn`, A-01, A-02 | no (etcd) |
| `#meta`: the catalog and the slot table | every slot row | 0 in SPACE (inside R1 and the slot move) |
| Quiet groups, one ping per member pair, a peer bound past 100 members | A-12 | no (CockroachDB); the bound's precedent is open |
| Slow-leader rule, in the leader's own form | A-03 | open; no precedent on offer for this form; no durable state named |
| Shared journal with a reserve segment | S `jrnl`, A-09, A-25 | 1 small in SPACE |
| Object-store tier: history and snapshot layers | S `+tier` | 1 in SPACE |
| Genesis by a conditional create of the cluster id | A-08 | open (E-33: "new here"; S3 conditional writes are the cited base) |
| Restore: an epoch high-water mark in the store, and a session generation | A-08 | open; no precedent named |
| Slot move with its carried set and one give-up decider | P `slot`, A-16, A-17 | 1 big in SPACE |
| The move policy, run by one loop on `#meta`'s leader | A-18 | a load policy: 0 by DEV-10 (a)'s letter. SPACE's ladder counts 1 when leaders run it as a rule |
| Groups owned by the project | G `pslot` | 0 beyond the slot move in SPACE |
| Per-slot sequences | O `slot` | 1 small in SPACE |
| Healing by each group's leader | C `self`, A-19 | 1 in SPACE |
| Platform hints (DEP-17), checked at the group's leader | owed; SPACE's `+p` | 1 in SPACE's ladder; not modelled |
| Client sessions, with `forward.once` | D `sess`, A-21 | no (Raft thesis §6.3) |
| Caller keys (TEST-03) | A-10: a session per call, or a `keys` table | no (Stripe, SQS); not modelled |
| `srchi-slot` marks | A-05 | open; Kafka's offsets beside the outputs is the precedent on offer |
| Writer time as the median | T `clamp`, A-23 | 1 small in SPACE; CometBFT is the precedent on offer |
| Sagas with fenced locks | X `saga`, A-24 | open: 1 novel rule as E-24 counts it, 0 if Kafka's end markers are accepted |
| `memory` rung | Q `mix` | 1 in SPACE |
| `none` rung | P-06 | 1 in SPACE |
| Disk incarnation and checksum | Z `rejoin`, A-28 | 1 small in SPACE |
| Admission credits | A-07 | open; no durable state named |
| Fold-version entry in each group's log | A-10, OPS-12 | precedent on offer: CockroachDB's cluster versions (cited in REQUIREMENTS) |
| Subscribe protocol, merged views at a cut | W `any`, A-06, A-10 | no mechanism by DEV-10's letter ([E-23]) |

By this column: 10 lines carry a 1 in SPACE's own estimate (9 without the hint path), and 6 lines are open (the slow-leader rule, the conditional create, the restore mark, `srchi-slot`, the saga's rule, credits). DEV-01's bar is a total below 13. If every open line were judged novel, the total would pass it. Every Raft row carries these six lines too (the slow-leader rule in one form or the other), so they do little to order the rows; they decide whether any row meets DEV-01.

**Crossings that no experiment ran together.** No exhaustive model ran these together at COMP's shape. E-32 was the study's composition experiment ([QUESTIONS.md](QUESTIONS.md) Q-32). It has no folder: it was never run. Where a run did cover part of a crossing, the last column says so. Every crossing below is open for COMP. K-04 to K-09 come from COMP's own picks; the others are just as open for every slot row.

| Id | The mechanisms | The state they share | Covered alone, or in part, by |
|---|---|---|---|
| K-01 | a slot move, with a membership change or healing in A or B | each group's config and epoch, the fence and open entries, the commit index, the replicas' logs | [E-15], [E-17c] (moves; no member change, `#meta` never fails); [E-14c], [E-16] (membership; one group, no move) |
| K-02 | a slot move, with everything it must carry at once | the fence, copy and open entries; per-slot state at A and B: sequence, dedup outcomes, session floors, lock fence table, `srchi` marks, segment names | [E-15] (sequence and dedup only; it carries no lock fence table and no segment names); [E-17] (sequence, dedup outcomes and the highest lock token in one model, crash-only); [E-22] (rows, attempts and fences carried in a simulator under all 22 patterns, one forced move per seed); [E-20] (floors); [E-30] (marks); [E-31] (segment names); [E-24] (fence tables with the move abstract; it cites E-15 for the carry, which E-15 does not model) |
| K-03 | a move cut to one or two commits (A-17), with unclean recovery | the fence entry as the decision; the slot's epoch | [E-13] (timing of one commit); [E-17b] (the fused probe, crash-only); [E-15] (unclean recovery, three commits) |
| K-04 | `pslot`, with the move loop over many resources | the project's groups and their slot sets; load per resource and slot; the slot map in `#meta` | [E-17c] (move rules); [E-36] (static cost); [E-18] (one resource at a time, exact loads) |
| K-05 | `pslot`, with Q `mix` per resource | which group holds which settings; group boundaries by `copies` and durability | [E-36] (one class of group); [E-09b], [E-02] (the rungs' speed) |
| K-06 | `pslot`, with big records, and with a dropped resource | one group's batch, log, snapshot and retention across resources | [E-35] (at the journal, not inside one group); [E-36] |
| K-07 | healing by leaders, with one loop on `#meta`'s leader that proposes slot moves, and `#meta` down or changing leader | the slot table in `#meta`; group configs; load reports; the promise of one move at a time | [E-16] (healing only; it reasons the balancer can sit off the healing path); [E-18] (the policy, as one loop with exact loads); [E-17c] (moves start one at a time, "as one controller would"; two deciders at once not modelled); [E-15] (`#meta` never fails) |
| K-08 | healing by leaders, with a clean leave, a drain, a retire and platform hints | the group's config; gone and retiring marks | [E-16] (left out); [E-13] (handover timing); healing.py in v5-spec (the draft's text, before A-01 and A-19) |
| K-09 | the `memory` rung, with `rejoin`, elections and healing, after a majority stops uncleanly | the disk incarnation; an acknowledged tail that was never synced, and what it held: per-slot positions, lock fence tokens, session floors; votes | [E-02] (speed); [E-37] (one bad synced entry); [E-14b] (a lost disk); [E-29] (power loss on a `persisted` journal); [E-24] (leaves unclean recovery out: "a fence table can go back") |
| K-10 | the `none` rung, with subscribe and relays | a second delivery path and its failover rule | [E-02], [E-08], [E-09b] (speed); [E-31] (log-backed modes only) |
| K-11 | writer time as the median, with a slot that moves between groups, with a changing member set, and with session expiry by `#s`'s writer time | the last stamp of a slot; TTL and lease ends; the set of known clocks; when a session counts as expired | [E-21] (one group, fixed members; fewer than three clocks reasoned only); [E-15] (no clocks); [E-20] (writer time is one global clock) |
| K-12 | TTL expiry and leases by writer time, with quiet groups | the tick that expires rows; the pings that carry clocks | [E-21]; [E-11], [E-25] (quiet groups with no timers of their own) |
| K-13 | client sessions, with a restore | the session registry; floors; the session generation | [E-20] (failover and moves); [E-33] (one session with one restore, model-checked; E-20's registry and floors are not in it) |
| K-14 | `srchi-slot`, with a restore of the source, and with 4,096 slots in shared groups | marks per consumer, source slot and output slot; the source's epochs | [E-30] (two source slots, no restore); [E-33]; [E-18] |
| K-15 | 4,096 slots, with cursors, the `#meta` table, per-slot state and segment checkpoints | per-slot counters and table rows | [E-18] (balance only); [E-19], [E-36] (both at 1,024) |
| K-16 | sagas, with the dedup horizon, a slot move and real leases | lock fence tables; attempt ids of steps; lease ends | [E-24] (idempotent steps, leases lapse by free choice, move abstract); [E-22] (sagas with one forced move and one leader change, simulated, checked by Elle); [E-20], [E-30]; [E-21] |
| K-17 | the slow-leader rule, with healing, leader transfer, quiet groups, and overload under credits (a leader at twice its capacity looks slow) | who leads; a latency score that needs traffic | [E-38], [E-38c] (the rule named, not built); [E-16]; [E-13]; [E-11]; [E-39] (one leader, no slow-leader rule) |
| K-18 | admission credits, with `fwd`, failover and moves | grants per client link; writes in flight at a non-leader | [E-39] (one leader, clients direct); [E-20]; [E-13] |
| K-19 | merged views at a cut, with subscribe's `END` and relays | the merger's cut; cursors per slot | [E-23] (an in-process merger); [E-31] (one slot, one subscriber) |
| K-20 | a kernel on a worker, with the fold on the main thread, F-21's hash and the recorder | the byte-batch seam; the fold's position | [E-07]; [E-05]; [E-42]; [E-43] |
| K-21 | the object-store tier, with carried segment names, retention and a store that is down | segment names; the manifest; the cluster id | [E-28]; [E-31] (no retention, no store); [E-33]; [E-29] |
| K-22 | quiet groups, with failover and failure detection | the link pings that stand in for a quiet group's heartbeats; election timers | [E-11] (no failure injected); [E-13], [E-38], [E-38c] (failover, on groups that tick) |
| K-23 | the restore's high-water mark, with a slot move, and a store that is down | the slot's epoch; the mark in the store's manifest | [E-33] (the store is always reachable); [E-13] (the move's window has no store write in it) |
| K-24 | `rejoin`, with one journal per process and many groups on one disk | the disk incarnation: whether one bad entry wipes one group's replica or the member's whole disk, and so every group it votes in | [E-37] (one group); [E-12] (the journal, no faults) |
| K-25 | the move's unwritable window, with the size of the carried set | the copy inside the window: a floor per active client per move (16 MB at 1e6 clients); 50 to 64 moves to add or drain one group at 64 groups with 4,096 slots | [E-13] (three commits, no copy); [E-20] (the floors' size); [E-18] (the move counts) |
| K-26 | healing by leaders, with a group below three voters | the group's config while it grows from one voter, as every new project does | [E-16] (groups start at three voters); [E-14b] (the two-voter window, on Raft alone) |
| K-27 | a move's give-up, with a target group that lost its majority for good, and no controller to decide | the fence, the abort entry, the slot table | [E-17 part 1] (the target always comes back; it hands the question to E-16); [E-16] (no moves) |
| K-28 | CheckQuorum every E/4, with pauses on the kernel's thread | the leader's count of followers heard from; a worker's GC pauses | [E-38] (simulated, no pauses on followers); [E-34] (pauses of 0.25 to 0.49 s with the index on the V8 heap); [E-07] |

## 5. What the evidence left open

Each gap could change section 1, 2, 3 or 4. "Flip" says what.

| # | Experiment | The gap | What it could flip |
|---|---|---|---|
| G-01 | E-32 (never run) | No interaction matrix, no composed model, no independence arguments | DEV-02's MUST is open for every row. A counterexample in K-01 would hit every slot row at once |
| G-02 | [E-38] | F-17 as worded fails for Raft's vote rule. The fix is a restated F-17 or a novel election rule | every Raft row fails one MUST as worded, or takes +1 novel mechanism |
| G-03 | [E-38], [E-38c] | The slow-leader rule was named, not built, modelled or counted. Its precedent was cited from memory, and only for the controller's form | A-03's cost and novelty; F-18 for every Raft row; C `self` against `cent-co` on the count |
| G-04 | [E-02], [E-09a2], [E-45], [E-09c] | No fero kernel ran through a competitor's tool at speed. E-02 is a ceiling with no protocol work, and it never ran one write in flight; the gateways drove a simulator. Still not comparable: Kafka share groups, JetStream redelivery and message-id dedup, etcd's own lock recipe and multi-key Txns. OMB itself does not fit this box, so E-09c ran Kafka's own tools with OMB's settings | every PERF row is open; axis L; whether Q's `maj-m` wins in TS (0.57 ms against 0.55 ms) |
| G-05 | [E-09b], [E-02] | The `memory` rung's safety was never modelled, and E-02 has no 1 KiB `memory` run | Q: if `maj-m` needs more than one mechanism, `mix` costs more than section 2 says |
| G-06 | [E-18], [E-19], [E-36] | 4,096 slots were priced only by reasoning. E-18: a whole-resource cursor at 8 bytes an entry would be about 32 KB against Q-19's 8 KB bar. E-19's delta coding (1.0 to 3.3 KB at 1,024 slots) would come to about 4 to 13 KB (reasoned here, by scaling) | A-16's default falls back to 1,024 (72 effective writers with the app split, still above F_w = 64) |
| G-07 | [E-15] | Only 39 % of DEV-10's mechanical mutants are caught at `move` and `write0` (bar 85 %): the spec as written carries spare guards. The fused move was probed crash-only | DEV-03's mutant clause for P `slot`; the shape of A-17 |
| G-08 | [E-17c] | Crash-only faults; three groups at most; give-up prices checked, not re-derived; no two moves of one slot at once; changes start one at a time | the rule counts of every P option under unclean recovery; the margin of 28 against 37 is wide, so the order is unlikely to flip |
| G-09 | [E-16] | One data group that starts at three voters; no leave, drain or hint; `self+p` not modelled; no slot moves; 9 of `cent-co`'s 21 mutants undecided; one agent's count | C: `self+p`'s real cost; DEP-17 under every option; DEV-03's mutant clause for `cent-co` |
| G-10 | [E-14c] | The full runs did not finish (4.6 and 3.6 million states, no invariant broken); no 5 servers, more than 2 changes or more than 1 fault; "grow first" checked for two plans only. Stuck states are judged only in the first leader's term, under six extra bounds; a fail under the bounds is argued, not proved | A-01's liveness verdict |
| G-11 | [E-21] | Seeded runs, one group, one drop order. The agreement guard (2 more rules) is not in A-23: without it, when most clocks are wrong, the group keeps writing by a wrong time (104 rows early, 370 late, 2 early lock grants in 30 runs) | A-23 becomes 9 rules if the user wants the group to stop instead; T flips to the guard if F-06 is amended |
| G-12 | [E-20] | One agent, one drop order; `sess` under `fwd` partly reasoned; keyed calls (TEST-03) not modelled | D's counts by 1 either way; not the order of `sess` against `win` |
| G-13 | [E-30] | One output per record and output group; one consumer in order | A-05 needs one more rule (a record's outputs to one slot go in one entry) |
| G-14 | [E-24] | Idempotent steps only; RAMP for operations counted by reasoning from a simulation; the epoch bump's rules not counted | X: P-15's SHOULD stays unpriced for operations; A-24's novel count |
| G-15 | [E-37] | Three voters, one group, no membership change; damage found only at a restart; damage above the commit point needs PAR's "possibly committed" query | Z: `par`'s real rule count; whether PAR counts as its precedent decides Z |
| G-16 | [E-36] | 100,000 resources were not created through `fero()`; `#meta` sizes are encodings; `pslot`'s cold open is reasoned; its MIN-P had one slot map shared by the project, not SPACE's table per resource; the cold-open tail is over 5 ms in every form measured | G: `pslot`'s edge over `shard` with dormant groups; SC-13's cold-open clause |
| G-17 | [E-35] | One disk; one group per tenant; `proc`'s isolation reasoned, not tested; the tenant budget was not built | N and A-29 |
| G-18 | [E-41] | Prices cited from search summaries, not the vendors' pages | DEP-21's order of the rows; V and N |
| G-19 | [E-39] | TS sits on F-19's 80 % line (79 to 82 %); one pipeline, clients direct to the leader; two client processes with a fixed window. Many clients, how a grant is sized, and the handshake budget were not tested | F-19 for TS rows; A-07 under `fwd` |
| G-20 | [E-31] | Every feature at once with two faults did not finish (no counterexample in 3 million states each); one slot, one subscriber | A-06 |
| G-21 | [E-33] | The conditional create needs the object store at the first start. A slot move records its epoch in the store before use. The rows found by `fero init` have no stated home for the restore mark | SC-02 for rows that found this way when the store is down (F-15 allows that wait); F-15 for slot moves; OPS-07 for the `fero init` rows |
| G-22 | [E-01] | Whether this box's flushes reach the host's disk is unproven | every latency bar is also stated against a cited figure; C itself |
| G-23 | [E-43] | The `SCHEDULE_VERSION` bump 4 → 5 that fero v4 needs is not published, so it was not run | A-10's pins |
| G-24 | [E-10] | A Rust port of etcd's raft was not tried; openraft was not examined. raft-rs 0.7.0 cannot run etcd's files, lacks StepDownOnRemoval, and has async persistence under a different API | the native step of L `ts→rs` and every I `raft-rs` row: which core it uses, and whether A-01 holds on it |
| G-25 | no experiment | V `+wit`, C `self+p`, W `lease`, X `grp`, M `tpc`, a native M `kwN`, R `vsr`, N `pool`'s isolation, the `smart` client's MOVED and ASK, a forward through a real server | each is an option section 2 could not judge on evidence |
| G-26 | [E-29] | LazyFS cannot make a sync fail or lose a directory entry. The journal tested was E-29's own prototype | F-10's failed-fsync and directory-fsync clauses stay open for every row |
| G-27 | [E-08] | The coalescing wait is over P-05's delivery bar, and with no wait p99 is 0.22 to 0.25 s at 10,000 sockets a core in both languages | P-05's bar is restated, or a relay needs more cores |
| G-28 | [E-13] | etcd's own handover pauses 9.7 to 9.8 ms at the median and 24 to 31 ms at worst here. The 0.25 E failover sum was not run. The move's chain carries no copy | F-05's 10 ms and 2 ms handover bars; A-02's constants; SC-08(b) with a real carried set (K-25) |
| G-29 | [E-34] | None of the faster wake forms was built or measured | SC-05 at 10 GB for every row that folds in Node; F `all` against `ldr` |
| G-30 | [E-11] | No failure was injected, so failure detection on link pings with quiet groups was not exercised | A-12; every failover number comes from groups that tick (K-22) |
| G-31 | [E-17 part 1] | The give-up counts are ranges; the target group always comes back, so nobody decides a give-up when it is gone for good | A-17 (4); K-27 |
| G-32 | [E-18] | The balancer ran as one loop with exact loads, one resource at a time; the app split is perfect and instant; only write load is balanced | A-18 under any real mover; A-16's 135 |

## 6. Review record

One agent wrote sections 1 to 5. A second agent picked one option per axis without seeing them. Three checkers then read the file against the sources. A fourth agent settled each finding against its source, changed the file, and wrote this section. It read the README lines each finding names. For eight small clauses (E-06, E-09a2, E-09c, E-22b, E-41, E-43, E-45, E-46) it read the README's closing answer as EVIDENCE.md copies it word for word.

**Findings.**

| Checker | Findings | Taken in full | Taken in part | Not taken |
|---|---|---|---|---|
| Completeness | 20 | 18 | 2 | 0 |
| Soundness | 19 | 16 | 3 | 0 |
| Fairness and the composite | 17 | 13 | 4 | 0 |
| All | 56 | 47 | 9 | 0 |

Several findings named one fault from two sides: SC-10's wording, the wake figure under N `proc`, the raft-rs rows of A-01, A-11 against P-05, A-15's rows, E-29's gap, the uneven "Against it" lists, A-18's rows, and Q's link to L. Each was settled once. One fault that no checker named was also fixed: section 2 I said async writes are "not in raft-rs"; E-10 says raft-rs has async persistence under a different API.

**What was not taken, and why.** One line for each part.
- Soundness, axis S: "SC-15 is open, not met". Not taken as a verdict: E-35's own answer is "holds, just", and its "close to this box's noise" sentence is about SC-11's 1.1 clause. Taken: both sets of runs are now shown, and the word is left to the judges.
- Soundness, axis Q: "in TS the row is lost with or without `maj-m`". Not taken as "lost": E-09b calls it a tie, read at 50,000 writes a second, and E-02 never ran one write in flight. Taken: `maj-m` is not shown to win in TS, and Q now depends on L.
- Soundness, axis C: "taking `self` forces P `slot + rule`". Not taken: E-16 reasons that a balancer that only moves slots can sit off the healing path, and COMP now takes that form. Taken: the count against MIN-P, in section 4.
- Completeness, A-15: "OBJ has the same shape". Not taken: E-26 counts no group in memory for OBJ. Taken for SLOG, and ISR is marked not priced.
- Completeness, axis V: "a learner's vote still does not count toward a quorum". Not taken as worded: in E-14b's trace the candidate counts that vote, because its own configuration lists the member as a voter. Taken: "learners grant votes".
- Fairness, axis I: a new fix that rules out raft-rs for the native step. Not taken as a fix: E-10 says raft-rs is "not blocked". Taken: the open core is stated in section 2 I and in G-24.
- Fairness, axis L: "undecided only if the user accepts those rows". Not taken: no fero kernel ran through any competitor's tool, so no PERF row separates `ts` from `ts→rs` under rule 1. Taken: the lean to the native step, and the link from Q.
- Fairness, COMP's table: "11 lines marked 1", and the move's give-up as a line of its own. Not taken as written: the recount gives 10, and the give-up is rules inside the slot move, with no state of its own. Taken: the five other lines and a tally.
- Fairness, missing crossings: "under `pslot` a group's sessions span every resource in it". Not taken: it is the checker's own reasoning, with no source. Taken: the rest, as K-22 to K-28 and wider K-09, K-11 and K-17.

**Where the two picks differed, and how each was settled.**

| Axis | First draft of this file | Blind pick | Settled as | Why |
|---|---|---|---|---|
| P | `slot`, moved by the leaders' grow-and-shrink rule (`slot + rule` in COMP) | `slot`, moved by one loop on `#meta`'s leader | `slot`; the mover is marked undecided, and COMP takes the loop | no experiment ran any mover with C `self`. The loop is the form with fewer mechanisms by SPACE's ladder, and the one E-18 and E-17c ran |
| C | `self`, "firm against `cent-co`" | `self`, with the move loop, and hints as advice checked at the leader | `self` on E-16's threshold; not firm on the count; DEP-17's hint path marked as owed | both picks name `self`. SPACE gives both options 1 mechanism. Hints, moves and the slow-leader form sit outside E-16 |
| Q | `mix` | `mix`, with three named rungs | `mix`; it depends on L | the same pick in other words. E-09b: the `memory` rung is shown to win only in a native build |
| D | `sess` with `srchi-slot`; `keys` for caller keys in the text | `sess`, plus `srchi-slot`, plus `keys` for user keys | `sess` with `srchi-slot`; caller keys named in COMP's cell | the same in substance. E-20 reasons both ways to serve a caller key and modelled neither |
| T | `clamp` at window 0 | the same, in other words | `clamp` at window 0 | words only |
| X | `saga` | `saga`, with F3 and "undo every step" named | `saga` with A-24 | words only |
| W | `any` + `ridx` | `any` plus `ridx` | `any` + `ridx` | words only |
| L | `ts→rs`, undecided against `ts` | `ts→rs`, decided; the native step required before goal 2 is claimed | `ts→rs`, still undecided against `ts`, with a stated lean to the native step | the judging rule does not separate them on the evidence in hand; 0 novel either way, so COMP keeps `ts→rs` |
| Y | `fwd`, undecided on latency | `fwd`, decided | `fwd`, decided as the base; the `smart` add-on left open | every row must have `fwd` for browsers, which the first draft's own entry says. What nobody measured is the gain of adding `smart` |
| Z | `rejoin`, by one mechanism | `rejoin` in the row; undecided against `par` | undecided; COMP takes `rejoin` | one apart or level, and `par` has a model that shows F-22 (S) met. Rule 3 as written and rule 4's intent point opposite ways. `rejoin` is the option with fewer mechanisms |

**Checks after the changes.**
- Section 3's matrix was compared cell by cell with SPACE §4.1 by a script, with the stars stripped: all 19 rows and all four added axes are the same. Footnotes 8 and 12, which had been cut short, are SPACE's again.
- A star stands only where a fix of section 1 names the option, and each row's fix list holds every fix of section 1.2 whose Rows column names it (checked by hand, row by row).
- Section 4's COMP line holds section 2's favoured option on all 22 axes.
- The crossings are K-01 to K-28. Every one names at least two of COMP's picks or fixes, and none has an experiment that ran its parts together in full.

**For the user to confirm.** Each of these rests on reading a requirement one way, or on a value only the user sets.
1. **F-06 and the clock rule (T).** E-21 reads "a clock jump never causes a failover" as ruling out CockroachDB's guard, which fails over on every leader clock jump. If one failover per jump is fine, the guard is the smaller design by precedent.
2. **The accepted losses (Q and L).** The list is empty today. That is the only reason COMP has a `memory` rung, and that rung is shown to win its row only in a native build. If the default rows of PERF-02, PERF-04 and PERF-05 are accepted by name, `maj-d` plus `none` is enough.
3. **The order in rule 3 (Z, and V).** As written, one more SHOULD beats one more mechanism. Read that way, `par` joins COMP, and a witness could too. Rule 4 says few mechanisms rank first. COMP follows rule 4.
4. **DEP-17 (C).** May a platform hint change membership, or is it advice that a group's leader checks and may ignore? The first needs the controller's re-checks under `self` as well.
5. **SC-10 and F_w (P).** As worded, every design fails it. E-18 asks for "with every partition above half a writer's share split by the app". With that, 135 writers at 4,096 slots.
6. **P-05's delivery bar.** As worded it is unmet by every row in both languages. E-08 asks for a coalescing window and a socket count per core.
7. **F-17.** As worded it fails for Raft's own vote rule. E-38 asks for "a connected majority that includes an up-to-date replica".
8. **F-05's handover bar and SC-08(b).** etcd itself misses 10 ms at the tail on this disk; a three-commit move misses 10 ms under load. Restate both, or cut the move.
9. **SC-13's "small" and N_res (G).** The 2 KB bar holds only while few slots are touched.
10. **P-09 and P-11 (D9).** This file reads "an empty take writes nothing" as ruling out "append every refusal". That reading costs 3 rules.
11. **F-15.** May a slot move wait while the object store is down? A-08's restore mark makes it wait.
12. **A-23's agreement guard.** When most clocks are wrong, should a group stop (9 rules) or keep writing by a wrong time (7 rules)?
13. **SC-15.** 1.18 and 1.26 times against a 1.2 bar: is that met, or open?
14. **J and a shared tier (V, N, H).** COMP has none. With one, a witness and a pooled tier come back, each with A-29.

[E-01]: experiments/E01-floors/README.md
[E-02]: experiments/E02-pipeline/README.md
[E-03]: experiments/E03-napi-cost/README.md
[E-04]: experiments/E04-wasm-kernel/README.md
[E-05]: experiments/E05-fold-cost/README.md
[E-06]: experiments/E06-fork-rewind/README.md
[E-07]: experiments/E07-gc-worker/README.md
[E-08]: experiments/E08-relay-fanout/README.md
[E-09a]: experiments/E09a-redis/README.md
[E-09a2]: experiments/E09a2-redis-memtier/README.md
[E-09b]: experiments/E09b-nats/README.md
[E-09c]: experiments/E09c-kafka/README.md
[E-09d]: experiments/E09d-redpanda/README.md
[E-09e]: experiments/E09e-etcd/README.md
[E-10]: experiments/E10-raft-port/README.md
[E-11]: experiments/E11-many-groups/README.md
[E-12]: experiments/E12-journal/README.md
[E-13]: experiments/E13-handover/README.md
[E-14]: experiments/E14-membership-on-commit/README.md
[E-14b]: experiments/E14b-membership-liveness/README.md
[E-14c]: experiments/E14c-membership-completion/README.md
[E-15]: experiments/E15-slot-move-tla/README.md
[E-16]: experiments/E16-controller-loop/README.md
[E-17]: experiments/E17-partitioning/README.md
[E-17 part 1]: experiments/E17-partitioning/PART1.md
[E-17b]: experiments/E17b-partitioning-part2/README.md
[E-17c]: experiments/E17c-partitioning-rerun/README.md
[E-18]: experiments/E18-slot-balance/README.md
[E-19]: experiments/E19-slot-positions/README.md
[E-20]: experiments/E20-dedup/README.md
[E-21]: experiments/E21-time/README.md
[E-22]: experiments/E22-api-prototype/README.md
[E-22b]: experiments/E22b-real-elle/README.md
[E-23]: experiments/E23-merged-views/README.md
[E-24]: experiments/E24-sagas-ramp/README.md
[E-25]: experiments/E25-idle-fd/README.md
[E-26]: experiments/E26-dormant-groups/README.md
[E-27]: experiments/E27-idle-links/README.md
[E-28]: experiments/E28-minio-log/README.md
[E-29]: experiments/E29-power-loss-disk-full/README.md
[E-30]: experiments/E30-derived-once/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-33]: experiments/E33-genesis-restore/README.md
[E-34]: experiments/E34-wake-10gb/README.md
[E-35]: experiments/E35-neighbours/README.md
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-38]: experiments/E38-raft-gray-failures/README.md
[E-38c]: experiments/E38c-etcd-iptables/README.md
[E-39]: experiments/E39-overload-storm/README.md
[E-40]: experiments/E40-browser-client/README.md
[E-41]: experiments/E41-hosted-cost/README.md
[E-42]: experiments/E42-recorder/README.md
[E-43]: experiments/E43-fold-versions/README.md
[E-44]: experiments/E44-outside-log/README.md
[E-45]: experiments/E45-drivers/README.md
[E-46]: experiments/E46-maelstrom-raft/README.md
