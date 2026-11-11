# COMP: the study's composite, where each group's leader heals its own replicas

**Verdict.** COMP takes, on each axis, the option the evidence favoured, and it won among the 20 study rows (words as in VERDICT's [key of terms](../VERDICT.md#key-of-terms)). The closure pass then judged better rows beside it. On [VERDICT.md](../VERDICT.md#6-every-other-row)'s frame (strict DATA-01, clauses restated, no PERF-01 loss), it is in, but COMP2, COMP2 V=full, COMP+par C=cent V=full and MIN-P+m all beat it. COMP2 meets one more SHOULD through `par` (F-22 S), and MIN-P+m has 19 fewer pairs (264 against 283). On the loose DATA-01 reading TiKV-TS and PD+fix also beat it, with 0 novel mechanisms against 3. With JetStream's default test line accepted as a loss, MIN-P wins among the 20 study rows and MIN-P+par among all 31. With the clauses as worded it fails 4 MUSTs and places 4th of the 20.

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots, held by Raft groups owned by the project. Any server forwards a write to the slot's group leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. A write commits at a majority.
- **Who heals and moves.** Each group's leader heals its own replicas. One loop on `#meta`'s leader (the project's system group) only proposes slot moves (C `self+mv`).
- **What a commit means.** `persisted` (on disk at a majority) by default; a resource may choose `memory` (in memory at a majority) or `none`.
- **Where rows fold.** Every full replica folds the rows with `data`. No design rule is recorded on it, so DATA-09 stays open ([VERDICT section 3.3](../VERDICT.md#33-which-data-01-reading-the-brief-supports)).
- **Damaged entries.** A checksum finds damage; the replica wipes and rejoins as new (`rejoin`).
- **Where it comes from.** [AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp): MIN-P with leaders healing, the loop kept only for moves, and a `memory` rung. Leader healing copies CockroachDB's per-range queues and Redis Cluster's failover ([SPACE.md section 2, C](../SPACE.md#2-the-axes)).

## Its line

It differs from COMP2 on C and Z, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority; member changes take effect on commit |
| G: what one log covers | `pslot` | groups belong to the project; one group holds slots of many resources |
| P: keys to groups | `slot` | 4,096 fixed slots per resource (1,024 as a fallback); a slot moves between groups, one at a time |
| K: where write rules live | `lib` | the kernel is a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | **`self+mv`** | **each group's leader heals its own replicas; one loop on `#meta`'s leader only proposes slot moves** |
| V: kinds of replica | `+lrn` | voters, plus learners (full copies that do not vote) |
| Q: what a commit means | `mix` | `persisted` by default; `memory` or `none` per resource, never per write |
| D: exactly once | `sess` | client sessions: per client, the highest sequence and cached answers |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time, TTLs, leases | `clamp` | the leader's clock, held to the median of the members' clocks, never going back |
| X: writes across partitions | `saga` | sagas with fenced locks; a reader may see half a saga unit |
| S: storage | `jrnl +tier(store)` | one journal per process, plus an object-store tier; the restore mark lives in the store |
| F: where rows fold | `all` | every full replica folds the rows with `data` |
| W: reads | `any ridx` | from any ready replica at a position, or by Raft's read index |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `emb` | inside the app's own Node process |
| L: language | `ts→rs` | TypeScript first, a Rust core later, compared byte for byte |
| I: the Raft core | `port` | etcd's Raft ported to TypeScript; raft-rs later |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread; user code and the rows on the main thread |
| Z: storage faults | **`rejoin`** | **a checksum and a disk incarnation; a damaged replica wipes and rejoins as new** |
| N: tenancy | `proc` | one process (one Fly app) per project |

## Its score

From [OUTCOME.md](../judging/OUTCOME.md) and [outcome.json](../judging/outcome.json).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: F-15, F-17, SC-03, SC-10 (gap sum 1.32) | 0 |
| MUSTs open | 97 | 100 |
| MUSTs met | 31 | 32 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | 5 |
| Novel mechanisms | 3: the slot move, the restore mark in the store's manifest, the dir lease | 3 |
| Interacting pairs | 283 | 283 |
| Rank | 4th of the 20 ([OUTCOME A.2](../judging/OUTCOME.md#a2-the-ranking)), behind DRAFT, SPLIT and ISR | 1st of the 20: it beats SPLIT and DRAFT ([OUTCOME B.2](../judging/OUTCOME.md#b2-the-ranking)); among all 31, 5th of the 7 rows in on the strict reading, and 7th of 9 on the loose one (computed for this report: `repro rank --strict`, `repro rank`) |

- SHOULDs not met: P-15 (S), F-22 (S), DEV-02 (S) and DEP-15 (S).
- **Rule 3 against the winner.** It loses to COMP2: level on novel mechanisms (3), then 5 SHOULDs against 6 ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).

## What fails, and the proof

All four fail only as worded ([scorecard](../judging/rows/COMP.md)). Restated, none fails.

- **SC-03 (Scale writes up).** Measured ceiling, simulated: 12 to 22 effective writers against 64 under a skewed load ([E-18](../experiments/E18-slot-balance/README.md); gap 0.66). Restating with the app split saves it. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings).** The same ceiling, gap 0.66. Restating saves it; item 5 applies the same way.
- **F-15 (Outside services).** Structural: a slot move records its epoch in the object store first, so it waits while the store is down ([E-33](../experiments/E33-genesis-restore/README.md)). Restating saves it; item 11 keeps it failing.
- **F-17 (Partial partitions).** Counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38](../experiments/E38-raft-gray-failures/README.md)). Restating saves it; item 19's clique reading opens it as worded.

## What it does well

- **Against COMP2 and MIN-P+par.** No cell is met here that either leaves unmet.
- **Not counted by rule 3:** leader healing is smaller and keeps healing while `#meta` is down. It needs 14 rules against the controller loop's 18, and has no command list ([E-16](../experiments/E16-controller-loop/README.md)). The judges gave it the same cells as the loop, so it earns no cell ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).
- **Directly modelled.** E-32's composed crossing models leader healing and client sessions itself. COMP2's controller is covered only through a checked reduction ([VERDICT section 7.6](../VERDICT.md#76-dev-02-and-the-models)).
- **Against TiKV-TS.** 25 cells are met here and open there (computed for this report: `repro diff COMP TiKV-TS`). TiKV-TS meets F-22 (S) and SC-06 (S), which COMP does not.

## What would change its verdict

- **Raise it** ([section 9](../VERDICT.md#9-the-next-step)):
  - Kill test 2c: the controller model needs 2 or more novel mechanisms, or 19 or more pairs, beyond leader healing. Then COMP with `par` takes COMP2's place (3 / 6 / 296). Leader healing comes back, with `par`.
  - Given 2 fewer novel mechanisms than the rest, it would win ([section 7.4](../VERDICT.md#74-the-sweep-over-all-31-rows)).
- **Lower it:**
  - Counter b's stricter count gives COMP 5 novel mechanisms against COMP2's 3 ([MECHANISMS section 2](../MECHANISMS.md#2-the-20-rows); its settled counts predate RM-01 to RM-08, so take settled counts from [outcome.json](../judging/outcome.json)).
  - Item 2, the loss accepted: MIN-P wins among the 20 ([OUTCOME B.3](../judging/OUTCOME.md#b3-what-flips-the-winner)), MIN-P+par among the 31.
  - Item 15, the loose reading: TiKV-TS wins.
  - Kill tests 6b and 2b on its `memory` rung hit it as they hit COMP2.
- **Owed:** K-07 (leaders heal while one loop moves; never modelled together), K-08 (platform hints), and K-27 (nobody decides a move's give-up). Its slow-leader rule, in the leader's own form, has no precedent on offer ([AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp)).

## Twins and neighbours

- **MIN-P+m** (C `cent-co`, one option away): 3 / 5 / 264, with DATA-09 met by COMP2's design rule. It beats COMP by 19 pairs.
- **COMP with `par`** (Z `par`, one option away; built, not judged): 3 / 6 / 296 by `python3 tools/closure.py mechrow 'Z=par' COMP`. It would beat COMP on SHOULDs and lose to COMP2 on pairs. It has 19 more pairs than COMP2 (296 against 277), and 16 of them come from planner hints ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).
- **COMP2** (C and Z differ): 3 / 6 / 277. It differs only on F-22 (S) and DATA-09.
- **MIN-P** (C and Q differ): 3 / 5 / 252, out on PERF-04.

## The evidence

- [E-16](../experiments/E16-controller-loop/README.md): leader healing needs 14 rules and the controller loop 18. While `#meta` is down the loop could not finish healing in 24 to 62 % of judged states; leader healing in none.
- [E-37](../experiments/E37-bad-entry/README.md): `rejoin` fixes one bad entry in 2 rules, but two replicas with one bad entry each are never writable without F-12's operator step.
- [E-32](../experiments/E32-composition/crossing/README.md): the composed crossing held on 28 bounds (up to 2,612,006 states) and found one counterexample, fixed by E-20's floor rule.
- [E-02](../experiments/E02-pipeline/README.md): the `memory` rung read 0.57 ms in TypeScript and 0.33 ms in Rust; a win over JetStream needs about 0.30 ms ([E-09b](../experiments/E09b-nats/README.md)).
- [E-18](../experiments/E18-slot-balance/README.md): 135 effective writers per resource at 4,096 slots, 72 at 1,024.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape, which E-41 lists COMP under, costs $7.52 to $7.89 a month at 10 writes a second on Fly.
- [E-32's pair placement](../experiments/E32-composition/pairs.md): of COMP's 283 pairs, 87 are open ([VERDICT section 7.6](../VERDICT.md#76-dev-02-and-the-models)).

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its scorecard: [judging/rows/COMP.md](../judging/rows/COMP.md).
- Its row: [AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp) (COMP is not in SPACE's section 4; it was added from the evidence).
- VERDICT: [section 3.1](../VERDICT.md#31-the-20-study-rows), [3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix) ("What lifts COMP2 over COMP"), [5.3](../VERDICT.md#53-what-it-gives-up), [6](../VERDICT.md#6-every-other-row), [7.5](../VERDICT.md#75-close-calls-in-the-mechanism-count) and [9's kill table](../VERDICT.md#9-the-next-step).
