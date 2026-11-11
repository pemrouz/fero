# MIN-P+par: COMP2 without the `memory` rung, the shape to build first

**Verdict.** MIN-P+par is the shape [VERDICT.md](../VERDICT.md#0-the-answer) says to build first, in TypeScript (words as in its [key of terms](../VERDICT.md#key-of-terms)). On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss), it is out on one MUST. Its only durable rung is `persisted` (on disk at a majority), which cannot beat JetStream's default test line by PERF-01's spread rule (PERF-04, gap 0.07). It is built first because COMP2's extra rung exists only to win that line, and no measurement shows it winning. On the loose DATA-01 reading it is still out on PERF-04, and with the loss accepted TiKV-persisted wins there. With JetStream's default test line accepted as a loss, it wins on the strict reading, level with its V=full twin. With the clauses as worded it fails 5 MUSTs and places level 14th of 31 on the strict reading.

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots, held by Raft groups owned by the project. Any server forwards a write to the slot's group leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript ([E-10](../experiments/E10-raft-port/README.md)). A write commits at a majority.
- **Who heals and moves.** One loop on `#meta`'s leader (the project's system group) heals replicas and moves slots, one at a time.
- **What a commit means.** Always `persisted`: a majority has the write on disk before the ack. There is no `memory` rung.
- **Where rows fold.** Every full replica folds the rows with `data`, under the same design rule as COMP2 (RR-17).
- **Damaged entries.** A checksum per entry finds damage, and the entry is copied back from a peer (`par`).
- **Where it comes from.** Built by hand in the closure pass as SPACE's MIN-P with Z `par` ([cards.json](../judging/closure/hybrids/cards.json), row A5). It copies etcd's Raft, Redis Cluster's fixed slots, KRaft's combined-mode controller and PAR (FAST'18).

## Its line

It differs from COMP2 only on Q, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority; member changes take effect on commit |
| G: what one log covers | `pslot` | groups belong to the project; one group holds slots of many resources |
| P: keys to groups | `slot` | 4,096 fixed slots per resource (1,024 as a fallback); a slot moves between groups, one at a time |
| K: where write rules live | `lib` | the kernel is a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `cent-co` | one loop on `#meta`'s leader heals replicas and proposes slot moves |
| V: kinds of replica | `+lrn` | voters, plus learners (full copies that do not vote) |
| Q: what a commit means | **`maj-d`** | **`persisted` only: a majority has it on disk before the ack** |
| D: exactly once | `sess` | client sessions: per client, the highest sequence and cached answers |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time, TTLs, leases | `clamp` | the leader's clock, held to the median of the members' clocks, never going back |
| X: writes across partitions | `saga` | sagas with fenced locks; a reader may see half a saga unit |
| S: storage | `jrnl +tier(store)` | one journal per process, plus an object-store tier; the restore mark lives in the store |
| F: where rows fold | `all` | every full replica folds the rows with `data` |
| W: reads | `any ridx` | from any ready replica at a position, or by Raft's read index |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `emb` | inside the app's own Node process |
| L: language | `ts→rs` | TypeScript first, a Rust core later; under the design rule Rust holds only the log layers |
| I: the Raft core | `port` | etcd's Raft ported to TypeScript; raft-rs later |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread; user code and the rows on the main thread |
| Z: storage faults | `par` | a damaged entry is repaired from a peer whose commit covers it |
| N: tenancy | `proc` | one process (one Fly app) per project |

## Its score

From [cards.json](../judging/closure/hybrids/cards.json) and [matrix.md](../judging/closure/results/matrix.md), tallied with `tools/closure.py`.

| | As worded | Restated | Restated, loss accepted |
|---|---|---|---|
| MUSTs failed | 5: PERF-04, F-15, F-17, SC-03, SC-10 (gap sum 1.39) | 1: PERF-04 (gap 0.07) | 0 |
| MUSTs open | 92 | 95 | 96 |
| MUSTs met | 35 | 36 | 36 |
| SHOULDs met | 6: P-22, SC-12, F-22, DEV-04, DEV-05, OPS-11 | 6 | 6 |
| Novel mechanisms | 3: the slot move, the restore mark in the store's manifest, the dir lease | 3 | 3 |
| Interacting pairs | 264 | 264 | 264 |
| Rank | every row out; level 14th of 31 by rule 2 on the strict reading, with twelve other rows, MIN-P and MIN among them (computed for this report: `repro rank --worded --strict`) | out on PERF-04 | first on [matrix.md](../judging/closure/results/matrix.md)'s line "restated, loss accepted, strict", level with MIN-P+par V=full |

- **Rule 3 against the winner.** On VERDICT's frame it is out, so rule 3 does not compare them. With the loss accepted it beats COMP2: level on novel mechanisms (3) and SHOULDs (6), and 264 pairs against 277.
- "Open MUSTs first" with the loss picks MIN-TS (95 open) among the judged rows. Over the searched mixes it picks MIN-P+par in TypeScript for good, with up to 9 guessed cells ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default acks one publisher at p99 0.550 ms, over runs of 0.536 to 0.783 ms ([E-09b](../experiments/E09b-nats/README.md)), so a win needs p99 under about 0.303 ms. The second-fastest of three fsyncs alone has p99 0.323 ms here ([E-01](../experiments/E01-floors/README.md); RR-15). Restating does not save it. Item 2 (this test line accepted as a loss) makes it open.
- **SC-03 and SC-10.** Measured ceiling, simulated: 12 to 22 effective writers against 64 under a skewed load ([E-18](../experiments/E18-slot-balance/README.md); gap 0.66 each). Restating with the app split saves both. Item 5 (F_w above 135) would fail them again.
- **F-15 (Outside services).** Structural: a slot move waits while the object store is down ([E-33](../experiments/E33-genesis-restore/README.md)'s rule). Restating saves it; item 11 keeps it failing.
- **F-17 (Partial partitions).** Counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38](../experiments/E38-raft-gray-failures/README.md)). Restating saves it; item 19's clique reading opens it even as worded.

## What it does well

- **Against COMP2.** Three MUSTs are met here and open there: P-10 (Locks and leader election), P-15 (Transactions across partitions) and F-02 (Exactly once per attempt). Without a `memory` rung, no group can lose an acknowledged tail (RR-11 to RR-13).
- **Fewer pairs.** 264 against COMP2's 277: the rung's 13 pairs are gone ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).
- **Against TiKV-TS.** 29 cells are met here and open there: 26 MUSTs and 3 SHOULDs (P-22, DEV-05, OPS-11) (computed for this report: `repro diff MIN-P+par TiKV-TS`).
- **What it lacks.** TiKV-TS meets SC-06 (S) (State size), which this row leaves open.

## What would change its verdict

- **Raise it** ([section 8](../VERDICT.md#8-what-the-user-must-confirm), [section 9](../VERDICT.md#9-the-next-step)):
  - Item 2: accept JetStream's default test line as a loss by name. Then it wins on the strict reading.
  - Kill test 6b fails: the `memory` rung misses p99 0.30 ms or 4,340 acks a second. Then COMP2 fails PERF-04 by measurement, and with the loss the arithmetic picks this row.
  - Kill test 2b: the rung breaks a MUST (P-10, P-15, F-02) with no fixing rule. The rung goes, leaving this row's shape.
- **Lower it:**
  - Item 15, the loose reading: with the loss, TiKV-persisted wins (0 novel against 3).
  - Kill test 2a: `par` fails a MUST with a voter change or on one journal. With the loss, MIN-P then wins (computed for this report: in `repro rank --strict --loss`, only rows with `par` beat MIN-P).
  - Kill test 2c: the controller needs 2 or more novel mechanisms beyond leader healing.
  - K-01, 2d (slot-move mutants at 85 %), 6a, 6c to 6e, 7 and the phase-4 writer count hit every slot row alike.
- **Owed:** it is VERDICT's slice (step 4). The models of `par` with a voter change (2a) and of the controller (2c) come first. Then chaos (5) and timing with each rival's own tool (6).
- PERF-04's other half, `persisted` against JetStream's sync-always line (p99 1.31 ms), is still open.

## Twins and neighbours

- **MIN-P+par V=full** (every replica votes): ties on every cell, mechanism and pair (row A6).
- **MIN-P+par C=cent V=full** (a separate controller process too, row A7): 3 / 6 / 269, with 96 open restated. It leaves PERF-12 (Idle cost) open, because its groups report to a controller on a timer. Its 5 extra pairs are controller sessions, so it loses on pairs.
- **MIN-P+par in TypeScript for good** (L `ts`, a searched mix): 3 / 6 / 264 with no guessed cell. It has 95 open with the loss, since TEST-10 is met ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).
- **H and L twins.** The [strict loss ladder](../judging/closure/results/ladder-restated-PERF-01_losses-DATA-01_reading.md) shows MIN-P+par H=both, H=srv and others tied at 3 / 6 / 264 / 96, unbeaten up to 5 guessed cells.
- **COMP2** (Q `mix`, one option away): 3 / 6 / 277. It differs on four cells: P-10, P-15 and F-02 open, PERF-04 open.
- **MIN-P** (Z `rejoin`, one option away): 3 / 5 / 252. It loses F-22 (S), so this row beats it on SHOULDs.

## The evidence

- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms and 3,280 a second; sync always, 1,228 a second at p99 1.31 ms.
- [E-01](../experiments/E01-floors/README.md): C (three-writer fsync p99 plus round-trip p99) is 0.73 ms; RR-15 puts a `persisted` commit's lower bound at 0.323 ms.
- [E-37](../experiments/E37-bad-entry/README.md): `par` kept 276 of 276 judged two-damage states writable; 7 rules, 8 of 9 mutants caught.
- [E-16](../experiments/E16-controller-loop/README.md): the controller loop needs 18 rules against leader healing's 14, and heals more slowly while `#meta` has no leader.
- [E-36](../experiments/E36-many-resources/README.md): with project groups an idle resource costs 0.4 to 1.2 KB, with no dormant groups.
- [E-17c](../experiments/E17c-partitioning-rerun/README.md): project groups need 28 rules, the same as plain slot moves.
- [E-34](../experiments/E34-wake-10gb/README.md): 10 GB of 2 KB rows wakes in 86 to 122 s against 60 s; the two-copy form doubles the memory.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape costs $7.52 to $7.89 a month at 10 writes a second on Fly (VERDICT gives this row that shape, reasoned).

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its cells: [cards.json](../judging/closure/hybrids/cards.json) (row A5), or `python3 tools/closure.py card '' MIN-P+par`. That command shows DATA-09 open (96 open restated), because the design rule is recorded on the judged row only.
- SPACE's row it is built on: [MIN-P](../SPACE.md#42-what-each-one-is-and-why-it-stays), with its scorecard [judging/rows/MIN-P.md](../judging/rows/MIN-P.md).
- VERDICT: [section 0](../VERDICT.md#0-the-answer), [3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix), [5.2](../VERDICT.md#52-its-score) ("MIN-P+par's best argument"), [6](../VERDICT.md#6-every-other-row), [7.4](../VERDICT.md#74-the-sweep-over-all-31-rows), [8 item 2](../VERDICT.md#8-what-the-user-must-confirm) and [9 step 4](../VERDICT.md#9-the-next-step).
