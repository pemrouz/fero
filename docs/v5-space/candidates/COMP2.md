# COMP2: Raft groups owned by the project, one loop that heals and moves, `data` on every replica

**Verdict.** COMP2 is the design [VERDICT.md](../VERDICT.md#0-the-answer) tells fero to aim for (words as in its [key of terms](../VERDICT.md#key-of-terms)). On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss), it fails no MUST and no judged row beats it. Of the rows still in, it has the fewest novel mechanisms (3) and the most SHOULDs (6), with 277 pairs. The build starts without its `memory` rung (a commit held in memory at a majority), which stays only if it passes its kill test. On the loose DATA-01 reading TiKV-TS wins instead: 0 novel mechanisms against 3. With JetStream's default test line accepted as a loss, MIN-P+par wins: the rung then buys no cell and costs 13 pairs. With the clauses as worded every row fails a MUST, and COMP2 fails 4, behind DRAFT, SPLIT and ISR.

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots. Raft groups owned by the project hold the slots. Any server takes a write and forwards it to that group's leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript ([E-10](../experiments/E10-raft-port/README.md)). A write commits at a majority of voters.
- **Who heals and moves.** One loop on `#meta`'s leader (the project's own system group) heals each group's replicas and moves slots, one at a time.
- **What a commit means.** `persisted` (on disk at a majority) by default. A resource may choose `memory` or `none` instead, never a single write.
- **Where rows fold.** Every full replica folds the log into rows with `data`. Its design rule (RR-17) says a later Rust core never folds rows.
- **Damaged entries.** A checksum per entry finds damage, and the entry is copied back from a peer (`par`, protocol-aware recovery).
- **Where it comes from.** It was built by hand in the closure pass: COMP with C `cent-co` and Z `par` ([cards.json](../judging/closure/hybrids/cards.json), row A2). In one line, it is SPACE's MIN-P with a `memory` rung and `par`.
- **What it copies.** etcd's Raft, Redis Cluster's fixed slots, KRaft's combined-mode controller, the Raft thesis's client sessions, and PAR (FAST'18) ([SPACE.md section 2](../SPACE.md#2-the-axes)).

## Its line

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority; member changes take effect on commit |
| G: what one log covers | `pslot` | groups belong to the project; one group holds slots of many resources |
| P: keys to groups | `slot` | 4,096 fixed slots per resource (1,024 as a fallback); a slot moves between groups, one at a time |
| K: where write rules live | `lib` | the kernel is a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `cent-co` | one loop on `#meta`'s leader heals replicas and proposes slot moves |
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
| L: language | `ts→rs` | TypeScript first, a Rust core later; under the design rule Rust holds only the log layers |
| I: the Raft core | `port` | etcd's Raft ported to TypeScript; raft-rs later |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread; user code and the rows on the main thread |
| Z: storage faults | `par` | a damaged entry is repaired from a peer whose commit covers it |
| N: tenancy | `proc` | one process (one Fly app) per project |

## Its score

From [cards.json](../judging/closure/hybrids/cards.json) and [matrix.md](../judging/closure/results/matrix.md), tallied with `tools/closure.py` as [VERDICT section 5.2](../VERDICT.md#52-its-score) does.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: F-15, F-17, SC-03, SC-10 (gap sum 1.32) | 0 |
| MUSTs open | 96 | 99 |
| MUSTs met | 32 | 33 |
| SHOULDs met | 6: P-22, SC-12, F-22, DEV-04, DEV-05, OPS-11 | 6, the same |
| Novel mechanisms | 3: the slot move, the restore mark in the store's manifest, the dir lease | 3 |
| Interacting pairs | 277 | 277 |
| Rank | every row out; [matrix.md](../judging/closure/results/matrix.md) puts DRAFT, SPLIT and ISR first (strict); COMP2 is level 4th of 31 by rule 2, with six other rows (computed for this report: `repro rank --worded --strict`) | first on matrix.md's line "restated, strict, no loss", level with COMP2 V=full; first by "open MUSTs first" on both no-loss lines |

- SHOULDs not met: P-15 (S) (readers can see half a saga), DEV-02 (S) and DEP-15 (S). Seven SHOULDs are open.
- **Rule 3 against the winner.** It is the winner. COMP2 V=full ties it on every count.

## What fails, and the proof

All four fail only as worded. Restated, none fails ([VERDICT section 2](../VERDICT.md#2-outcome-a-the-requirements-as-worded)).

- **SC-03 (Scale writes up).** Measured ceiling, in a simulation. Under a skewed load the hottest partition holds 5.5 to 9.8 % of it, so 12 to 22 effective writers against 64 ([E-18](../experiments/E18-slot-balance/README.md); gap 0.66). Restating with the app split saves it. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling, gap 0.66. Restating saves it; item 5 applies the same way.
- **F-15 (Outside services).** Structural. A slot move records its new epoch in the object store first ([E-33](../experiments/E33-genesis-restore/README.md)'s rule), so a move waits while the store is down. Restating saves it. Item 11 (kept as worded) does not, and gives SPLIT the win.
- **F-17 (Partial partitions).** Counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stayed stuck ([E-38](../experiments/E38-raft-gray-failures/README.md)). Restating saves it. Item 19's clique reading makes it open even as worded.
- **Not failed: DATA-01 on the strict reading.** It passes only because of its design rule: `data` folds every row on every full replica, in every phase ([VERDICT section 3.3](../VERDICT.md#33-which-data-01-reading-the-brief-supports)).

## What it does well

- **Against TiKV-TS.** 26 cells are met here and open there: 23 MUSTs and 3 SHOULDs (P-22, DEV-05, OPS-11) (computed for this report: `repro diff COMP2 TiKV-TS`). VERDICT counts 33 MUSTs met against 10.
- **Against MIN-P+par.** No cell is met here and not there. COMP2's one edge is PERF-04 (NATS JetStream): open here, failed there.
- **DATA-09 (A native kernel keeps data).** Met by construction under the design rule, so no differential test is needed while the rule holds.
- **What it lacks.** TiKV-TS meets SC-06 (S) (State size), which COMP2 leaves open.

## What would change its verdict

- **User choices** ([section 8](../VERDICT.md#8-what-the-user-must-confirm)):
  - Item 15, the loose DATA-01 reading: TiKV-TS wins.
  - Item 2, JetStream's default test line accepted as a loss: MIN-P+par wins.
  - Items 5 (F_w above 135), 11 (F-15 as worded) and 17 (DEP-21's volume ruled structural): SPLIT wins.
  - Items 5, 7 and 20 read the other way: every row is out.
  - Item 23: without family A's link-pings ruling, COMP+par C=cent V=full prices 272 pairs and beats it.
- **Kill criteria** ([section 9](../VERDICT.md#9-the-next-step)):
  - 6b: the `memory` rung needs p99 under about 0.30 ms and about 4,340 acks a second. If it fails, MIN-P+par's shape stays, and it needs the loss accepted.
  - 2b: the rung breaks a MUST with no fixing rule. The rung goes.
  - 2a: `par` fails a MUST with a voter change or on one journal. MIN-P+m takes its place.
  - 2c: the controller model needs 2 or more novel mechanisms, or 19 or more pairs, beyond leader healing. COMP with `par` takes its place (3 / 6 / 296).
  - K-01, 2d (slot-move mutants at 85 %), steps 4, 6a, 6c to 6e and 7, and the phase-4 writer count hit every slot row alike.
  - Step 3: D `keys`, X `rampv` or R `vsr` could each beat it once tested and judged ([section 4.7](../VERDICT.md#47-the-options-no-judged-row-holds)).
- **Owed before code:** the models of `par` with a voter change (G-15, K-24), the rung inside Raft (K-09), and the controller healing while it moves (K-07, G-09).
- **Owed on the first slice:** F-14 (met on [E-07](../experiments/E07-gc-worker/README.md)) rerun with writes judged on `data`'s rows on the main thread, as the design rule reads. If writes stop through a 5 s stall, F-14 fails ([VERDICT 11.5](../VERDICT.md#115-after-the-verdict-what-the-layer-write-up-found)).

## Twins and neighbours

- **COMP2 V=full** (every replica votes): ties on every cell, mechanism and pair. Learners stay as the healer's catch-up stage ([A.settled.json](../judging/closure/hybrids/A.settled.json)).
- **H and U twins.** COMP2 H=both, H=srv, U=cli H=srv and V=full H=both tie it at 3 / 6 / 277 / 99, with no guessed cell ([strict ladder](../judging/closure/results/ladder-restated-DATA-01_reading.md)).
- **COMP2 L=ts** (TypeScript for good): ties on counts with one guessed cell, and has 98 open MUSTs (TEST-10 met). It is better if step 6 shows TypeScript wins the native rows.
- **MIN-P+par** (Q `maj-d`, one option away): 3 / 6 / 264, out on PERF-04. It meets P-10, P-15 and F-02, which the rung leaves open here.
- **MIN-P+m** (Z `rejoin`, one option away): 3 / 5 / 264. It loses F-22 (S).
- **COMP+par C=cent V=full** (two options away): 3 / 6 / 282. It leaves PERF-12 (Idle cost) open.
- **COMP** (C and Z differ): 3 / 5 / 283, with DATA-09 open.

## The evidence

- [E-37](../experiments/E37-bad-entry/README.md): with one bad entry on each of two replicas, `par` kept 276 of 276 judged states writable; 7 rules, 8 of 9 mutants caught.
- [E-16](../experiments/E16-controller-loop/README.md): the controller loop needs 18 rules against leader healing's 14; 24 to 62 % of judged states could not finish healing while `#meta` was down.
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms and 3,280 a second; the rung must beat that by the spread.
- [E-02](../experiments/E02-pipeline/README.md): the `memory` rung read 0.57 ms in TypeScript and 0.33 ms in Rust, at 50,000 writes a second, never one in flight.
- [E-18](../experiments/E18-slot-balance/README.md): 135 effective writers per resource at 4,096 slots, 72 at 1,024.
- [E-34](../experiments/E34-wake-10gb/README.md): the two-copy form the design rule asks for held 12 GB of memory for 5 GB of rows.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape costs $7.52 to $7.89 a month at 10 writes a second on Fly. E-41 did not price COMP2; VERDICT section 6 gives it that shape (reasoned).
- [E-32](../experiments/E32-composition/crossing/README.md): the composed crossing held on 28 bounds (up to 2,612,006 states) and caught 95 of 136 mutants (70 %).

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its cells: [cards.json](../judging/closure/hybrids/cards.json) (row A2), or `python3 tools/closure.py card '' COMP2`. That command shows DATA-09 open (100 open MUSTs), because the design rule is recorded on the judged row only.
- SPACE's nearest row: [MIN-P](../SPACE.md#42-what-each-one-is-and-why-it-stays). Its base: [COMP in AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp).
- VERDICT: [section 0](../VERDICT.md#0-the-answer), [3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix), [3.3](../VERDICT.md#33-which-data-01-reading-the-brief-supports), [5](../VERDICT.md#5-the-winner-comp2), [7.5](../VERDICT.md#75-close-calls-in-the-mechanism-count), [8](../VERDICT.md#8-what-the-user-must-confirm) and [9](../VERDICT.md#9-the-next-step).
