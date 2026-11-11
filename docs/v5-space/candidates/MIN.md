# MIN: the simplest stack, with Raft groups per resource and one controller loop

**Verdict.** MIN is the study's simplest stack: DESIGN-V5's draft minus the witness, the planner, the group rule and window dedup (words as in VERDICT's [key of terms](../VERDICT.md#key-of-terms)). On [VERDICT.md](../VERDICT.md#6-every-other-row)'s frame (strict DATA-01, clauses restated, no PERF-01 loss), it is out on one MUST. Its only durable rung is `persisted`, which cannot beat JetStream's default test line by PERF-01's spread rule (PERF-04, gap 0.07). Let back in, it still loses to MIN-P: 4 novel mechanisms against 3, SHOULDs level, then 253 pairs against 252. COMP2 and MIN-P+par beat it on SHOULDs, 6 against 5 ([VERDICT 6](../VERDICT.md#6-every-other-row)). On the loose DATA-01 reading it is still out on PERF-04, and with the loss TiKV-persisted wins. With JetStream's default test line accepted as a loss, MIN-P wins among the 20 study rows and MIN-P+par among all 31. With the clauses as worded it fails 5 MUSTs and places 9th of the 20, level with six others.

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots. Each resource has its own Raft groups, each holding one slot set of it. Any server forwards a write to the group's leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. A write commits at a majority.
- **Who heals and moves.** One loop on `#meta`'s leader (the project's system group) heals replicas and moves slots (C `cent-co`).
- **What a commit means.** Always `persisted`: a majority has the write on disk before the ack.
- **Where rows fold.** Every full replica folds the rows with `data`. No design rule is recorded on it, so DATA-09 stays open.
- **Idle groups.** A quiet group is written to disk and dropped from memory, then woken by its first message (dormant groups, its fourth novel mechanism).
- **Where it comes from.** [SPACE.md section 4.2](../SPACE.md#42-what-each-one-is-and-why-it-stays): "the simplest stack that could meet every goal". Its groups copy Kafka partitions, CockroachDB ranges and TiKV regions ([SPACE section 2, G](../SPACE.md#2-the-axes)).

## Its line

It differs from COMP2 on G, Q and Z, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority; member changes take effect on commit |
| G: what one log covers | **`shard`** | **part of one resource: each resource has its own groups** |
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
| MUSTs failed | 5: PERF-04, F-15, F-17, SC-03, SC-10 (gap sum 1.39) | 1: PERF-04 (gap 0.07) |
| MUSTs open | 93 | 96 (97 with the loss accepted) |
| MUSTs met | 34 | 35 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark in the store's manifest, the dir lease | 4 |
| Interacting pairs | 253 | 253 |
| Rank | 9th of the 20, level with MIN-P, RUST, LEAN, LANE, MIN-TS and SIDE ([OUTCOME A.2](../judging/OUTCOME.md#a2-the-ranking)) | out on PERF-04; with only that MUST waived it would place 1st of the 20 ([OUTCOME B.4](../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out)) |

- SHOULDs not met: P-15 (S), F-22 (S), DEV-02 (S) and DEP-15 (S).
- **Rule 3 against the winner.** On VERDICT's frame it is out. With the loss accepted, COMP2 beats it: one apart on novel mechanisms (4 against 3), then 6 SHOULDs against 5.

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default acks one publisher at p99 0.550 ms ([E-09b](../experiments/E09b-nats/README.md)), so a win needs p99 under about 0.303 ms. The second-fastest of three fsyncs alone has p99 0.323 ms here ([E-01](../experiments/E01-floors/README.md); RR-15). Restating does not save it. Item 2 (this test line accepted as a loss) makes it open.
- **SC-03 and SC-10.** Measured ceiling, simulated: 12 to 22 effective writers against 64 under a skewed load ([E-18](../experiments/E18-slot-balance/README.md); gap 0.66 each). Restating with the app split saves both. Item 5 (F_w above 135) would fail them again.
- **F-15 (Outside services).** Structural: a slot move waits while the object store is down ([E-33](../experiments/E33-genesis-restore/README.md)). Restating saves it; item 11 keeps it failing.
- **F-17 (Partial partitions).** Counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38](../experiments/E38-raft-gray-failures/README.md)). Restating saves it; item 19's clique reading opens it as worded.
- Its [scorecard](../judging/rows/MIN.md) still leads PERF-04's reason with "C = 0.73 ms, the floor of any persisted commit". RR-04 and RR-15 replaced that reason; the fail stands.

## What it does well

- **Against COMP2.** Three MUSTs are met here and open there: P-10 (Locks and leader election), P-15 (Transactions across partitions) and F-02 (Exactly once per attempt). With no `memory` rung, no group can lose an acknowledged tail.
- **Against TiKV-TS.** 28 cells are met here and open there (computed for this report: `repro diff MIN TiKV-TS`). TiKV-TS meets F-22 (S) and SC-06 (S), which MIN does not.
- **Not counted by rule 3.** Groups are never shared between resources. SPACE names sharing as MIN-P's weak spot: one group's batch and leader serve many resources, and a different `copies` forces a new group. MIN's cells are the same as MIN-P's, so this earns no cell.

## What would change its verdict

- **Raise it:**
  - Item 2, the loss accepted: it is level second among the 20 with RUST and MIN-TS, behind MIN-P. All three are 4 / 5 / 253, and only MIN-P beats them ([OUTCOME B.3](../judging/OUTCOME.md#b3-what-flips-the-winner); rule 3 pair by pair, computed for this report: `repro rank --twenty --strict --loss`). It wins only if PERF-04 is waived for MIN alone (OUTCOME B.4).
  - Dormant groups ruled not novel: RM-06 and RM-07 kept them novel ([VERDICT section 7.2](../VERDICT.md#72-the-re-rulings-since-draft-2-and-what-each-changed)). Even then MIN would trail MIN-P by one pair, 253 against 252.
- **Lower it:**
  - Item 15, the loose reading: with the loss, TiKV-persisted wins.
  - [E-36](../experiments/E36-many-resources/README.md) moved MIN down on SC-13 (Many resources) as drafted. It recovers only with three phase-1 format choices plus dormant groups, so its cell is open, not met.
  - Kill tests K-01, 2d and the phase-4 writer count hit every slot row ([section 9](../VERDICT.md#9-the-next-step)).
- **Owed:** the sim that creates and drops 100,000 resources through `fero()`, and a definition of a "small" resource (SC-13, [scorecard](../judging/rows/MIN.md)).

## Twins and neighbours

- **MIN-P** (G `pslot`, one option away): the same cells on every requirement, with 3 novel mechanisms and 252 pairs. MIN-P beats it.
- **MIN-TS** (L `ts`, one option away): 4 / 5 / 253, with 94 open restated against MIN's 96. It ties MIN on rule 3's counts.
- **RUST** (L `rs+napi` and I `raft-rs`, two options away): 4 / 5 / 253, with 97 open restated.
- **MIN-P+par** (G and Z differ): 3 / 6 / 264, the shape VERDICT builds first.

## The evidence

- [E-36](../experiments/E36-many-resources/README.md): as drafted, an idle resource costs about 86 KB in memory (824 MB of `#meta` at 100,000). With the formats and dormant groups it is 1.4 KB; MIN-P's is 0.4 to 1.2 KB.
- [E-26](../experiments/E26-dormant-groups/README.md): a dormant group costs 57 B of memory and 24 B on disk, and wakes in 3.3 to 3.5 ms.
- [E-12](../experiments/E12-journal/README.md): from 256 groups up, one shared journal keeps commit p99 at 2 to 6.6 ms, where a file per group reaches 9 to 854 ms.
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms and 3,280 a second.
- [E-16](../experiments/E16-controller-loop/README.md): the controller loop needs 18 rules against leader healing's 14.
- [E-17c](../experiments/E17c-partitioning-rerun/README.md): slot moves need 28 rules, the smallest of the ways to map partitions.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape costs $0.19 asleep and $7.52 to $7.89 a month at 10 writes a second on Fly.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its scorecard: [judging/rows/MIN.md](../judging/rows/MIN.md).
- SPACE's row: [section 4.1](../SPACE.md#41-the-matrix) and [section 4.2](../SPACE.md#42-what-each-one-is-and-why-it-stays).
- Its mechanisms: [MECHANISMS section 2](../MECHANISMS.md#2-the-20-rows). Its settled counts predate RM-01 to RM-08 ([rerulings.mech.json](../judging/closure/rerulings.mech.json)); [outcome.json](../judging/outcome.json) has the settled ones.
- VERDICT: [section 2](../VERDICT.md#2-outcome-a-the-requirements-as-worded), [3.1](../VERDICT.md#31-the-20-study-rows) and [6](../VERDICT.md#6-every-other-row).
