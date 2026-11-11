# COMP+par C=cent V=full: COMP2 with a separate controller process and every replica a voter

**Verdict.** This is COMP2's separate-controller neighbour (words as in VERDICT's [key of terms](../VERDICT.md#key-of-terms)). VERDICT calls it a twin, though it has 5 more pairs, so by the key's rule it is not one. On [VERDICT.md](../VERDICT.md#6-every-other-row)'s frame (strict DATA-01, clauses restated, no PERF-01 loss), only COMP2 and its V=full twin beat it. It ties COMP2 on novel mechanisms (3) and SHOULDs (6), but has 282 pairs against 277. The 5 extra pairs are its controller sessions, the one mechanism COMP2 lacks, and they buy no cell. That lead rests on one ruling: without family A's link-pings ruling this row prices 272 pairs and beats COMP2. On the loose DATA-01 reading TiKV-TS and PD+fix also beat it, with 0 novel mechanisms against 3. With JetStream's default test line accepted as a loss, MIN-P+par wins, and this row keeps a `memory` rung that earns nothing. With the clauses as worded it fails the same 4 MUSTs as COMP2.

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots, held by Raft groups owned by the project. Any server forwards a write to the slot's group leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. Every replica votes. Learners appear only while a heal catches a new copy up.
- **Who heals and moves.** A separate, replicated controller process decides healing and slot moves. It tracks members by sessions (C `cent`).
- **What a commit means.** `persisted` by default; a resource may choose `memory` (in memory at a majority) or `none`.
- **Where rows fold.** Every full replica folds the rows with `data`, under COMP2's design rule (RR-17).
- **Damaged entries.** A damaged entry is copied back from a peer (`par`).
- **Where it comes from.** Built by hand in the closure pass as COMP with C `cent`, Z `par` and V `full` ([cards.json](../judging/closure/hybrids/cards.json), row A4). Its controller has TiKV PD's and Kafka KRaft's form ([SPACE.md section 2, C](../SPACE.md#2-the-axes)).

## Its line

It differs from COMP2 on C and V, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority; member changes take effect on commit |
| G: what one log covers | `pslot` | groups belong to the project; one group holds slots of many resources |
| P: keys to groups | `slot` | 4,096 fixed slots per resource (1,024 as a fallback); a slot moves between groups, one at a time |
| K: where write rules live | `lib` | the kernel is a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | **`cent`** | **a separate replicated controller heals replicas and moves slots; members keep sessions with it** |
| V: kinds of replica | **`full`** | **every replica votes and can lead; learners only as a heal's catch-up stage** |
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

From [cards.json](../judging/closure/hybrids/cards.json), tallied with `tools/closure.py`.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: F-15, F-17, SC-03, SC-10 (gap sum 1.32) | 0 |
| MUSTs open | 97 | 100 |
| MUSTs met | 31 | 32 |
| SHOULDs met | 6: P-22, SC-12, F-22, DEV-04, DEV-05, OPS-11 | 6 |
| Novel mechanisms | 3: the slot move, the restore mark in the store's manifest, the dir lease | 3 |
| Interacting pairs | 282 | 282 |
| Rank | every row out; 4th of 31 by rule 2 on the strict reading, level with COMP2 (computed for this report: `repro rank --worded --strict`) | not named on any [matrix.md](../judging/closure/results/matrix.md) line; on VERDICT's frame it loses only to COMP2 and COMP2 V=full, and beats the other four rows in (computed for this report: `repro rank --strict`) |

- **Rule 3 against the winner.** It loses to COMP2: level on novel mechanisms (3) and SHOULDs (6), then 282 pairs against 277 ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).
- Against COMP2 it differs in cells only on PERF-12 (Idle cost), a MUST: open here, met there. Rule 3 does not count open MUSTs.

## What fails, and the proof

All four fail only as worded, as for COMP2. Restated, none fails.

- **SC-03 and SC-10.** Measured ceiling, simulated: 12 to 22 effective writers against 64 under a skewed load ([E-18](../experiments/E18-slot-balance/README.md); gap 0.66 each). Family A's judges scored both here, the same as every row. Restating with the app split saves both; item 5 (F_w above 135) would not.
- **F-15 (Outside services).** Structural: a slot move waits while the object store is down ([E-33](../experiments/E33-genesis-restore/README.md)'s rule). Restating saves it; item 11 keeps it failing.
- **F-17 (Partial partitions).** Counterexample, simulated: 5 of 280 five-node partial partitions stuck on etcd's Raft ([E-38](../experiments/E38-raft-gray-failures/README.md)). Restating saves it; item 19's clique reading opens it as worded.

## What it does well

- **Against COMP2 and MIN-P+par.** None. No cell is met here that either leaves unmet. It leaves PERF-12 open where both meet it. Its card carries PD's reason: groups that report to a separate controller on a timer were never priced at 100 members.
- **Against TiKV-TS.** 25 cells are met here and open there: 22 MUSTs and 3 SHOULDs (computed for this report: `repro diff 'COMP+par C=cent V=full' TiKV-TS`). TiKV-TS meets SC-06 (S), which this row does not.

## What would change its verdict

- **Raise it:**
  - Item 23: if link pings are not added to the separate-controller rows, it prices 272 pairs and beats COMP2 by 5 ([section 8](../VERDICT.md#8-what-the-user-must-confirm); [section 7.5](../VERDICT.md#75-close-calls-in-the-mechanism-count)). Both family A judges added them, so this is a ruling to keep, not a guess.
  - Given 2 fewer novel mechanisms than the rest, it would win ([section 7.4](../VERDICT.md#74-the-sweep-over-all-31-rows)).
- **Lower it:**
  - Item 2, the loss accepted: the MIN-P+par rows win; its own `persisted`-only twin prices 269 and loses too.
  - Item 15, the loose reading: TiKV-TS wins.
  - Kill tests 6b and 2b on the `memory` rung, and 2a on `par`, hit it as they hit COMP2 ([section 9](../VERDICT.md#9-the-next-step)).
- **Owed:** PERF-12's idle cost with controller sessions at 100 members. No experiment ran a separate controller beside fero's quiet groups.

## Twins and neighbours

- **COMP2 V=full** (C `cent-co`, one option away): 3 / 6 / 277, PERF-12 met. The loop on `#meta`'s leader replaces the separate process and its sessions.
- **MIN-P+par C=cent V=full** (Q `maj-d`, one option away, row A7): 3 / 6 / 269. It meets P-10, P-15 and F-02 but fails PERF-04 on VERDICT's frame.
- **COMP2** (C and V differ): ties it on novel mechanisms and SHOULDs and wins on pairs.

## The evidence

- [E-16](../experiments/E16-controller-loop/README.md): a controller loop needs 18 rules against leader healing's 14; E-16 modelled the loop on `#meta`'s leader, not a separate process.
- [E-11](../experiments/E11-many-groups/README.md) and [E-25](../experiments/E25-idle-fd/README.md): 2,000 quiet groups cost 0.15 % of a core in TypeScript; with 99 links pinged every 500 ms, 0.95 %. This backs COMP2's PERF-12, not this row's.
- [E-37](../experiments/E37-bad-entry/README.md): `par` kept 276 of 276 judged two-damage states writable; 7 rules.
- [E-02](../experiments/E02-pipeline/README.md): the `memory` rung read 0.57 ms in TypeScript and 0.33 ms in Rust; the bar is about 0.30 ms ([E-09b](../experiments/E09b-nats/README.md)).
- [E-18](../experiments/E18-slot-balance/README.md): 135 effective writers per resource at 4,096 slots, 72 at 1,024.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its cells: [cards.json](../judging/closure/hybrids/cards.json) (row A4), or `python3 tools/closure.py card 'C=cent,Z=par,V=full' COMP`. That command shows DATA-09 open (101 open restated), because the design rule is recorded on the judged row only.
- The judges' ruling on its link pings: [A.settled.json](../judging/closure/hybrids/A.settled.json).
- SPACE's row it is built from: [COMP in AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp); the C axis in [SPACE.md section 2](../SPACE.md#2-the-axes).
- VERDICT: [section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix), [6](../VERDICT.md#6-every-other-row), [7.1](../VERDICT.md#71-the-judges-agreement), [7.5](../VERDICT.md#75-close-calls-in-the-mechanism-count) and [8 item 23](../VERDICT.md#8-what-the-user-must-confirm).
