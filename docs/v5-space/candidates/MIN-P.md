# MIN-P: the minimal stack with Raft groups owned by the project

**Verdict.** MIN-P is the base the winner is built on: MIN-P+par is MIN-P with peer repair, and COMP2 adds a `memory` rung too (words as in VERDICT's [key of terms](../VERDICT.md#key-of-terms)). On [VERDICT.md](../VERDICT.md#6-every-other-row)'s frame (strict DATA-01, clauses restated, no PERF-01 loss), it is out on one MUST. Its only durable rung is `persisted`, which cannot beat JetStream's default test line by PERF-01's spread rule (PERF-04, gap 0.07). Let back in, it still loses to MIN-P+par and COMP2 by one SHOULD (F-22 S). On the loose DATA-01 reading it is still out on PERF-04, and with the loss TiKV-persisted wins. With JetStream's default test line accepted as a loss, MIN-P wins among the 20 study rows, but MIN-P+par wins among all 31. With the clauses as worded it fails 5 MUSTs and places 9th of the 20, level with six others.

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots. Raft groups owned by the project hold slot sets of many resources. Any server forwards a write to the slot's group leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. A write commits at a majority.
- **Who heals and moves.** One loop on `#meta`'s leader (the project's system group) heals replicas and moves slots (C `cent-co`).
- **What a commit means.** Always `persisted`: a majority has the write on disk before the ack.
- **Where rows fold.** Every full replica folds the rows with `data`. No design rule is recorded on it, so DATA-09 stays open.
- **Damaged entries.** A checksum finds damage; the replica wipes and rejoins as new (`rejoin`).
- **Where it comes from.** [SPACE.md](../SPACE.md#42-what-each-one-is-and-why-it-stays): MIN with groups owned by the project. Its group form copies TiKV PD's cross-table region merge and CockroachDB's span-config coalescing ([SPACE section 2, G](../SPACE.md#2-the-axes)).

## Its line

It differs from COMP2 on Q and Z, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority; member changes take effect on commit |
| G: what one log covers | `pslot` | groups belong to the project; one group holds slots of many resources with equal settings |
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
| Novel mechanisms | 3: the slot move, the restore mark in the store's manifest, the dir lease | 3 |
| Interacting pairs | 252 | 252 |
| Rank | 9th of the 20, level with MIN, RUST, LEAN, LANE, MIN-TS and SIDE ([OUTCOME A.2](../judging/OUTCOME.md#a2-the-ranking)) | out on PERF-04; with only that MUST waived it would place 1st of the 20 ([OUTCOME B.4](../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out)) |

- SHOULDs not met: P-15 (S), F-22 (S), DEV-02 (S) and DEP-15 (S).
- **Rule 3 against the winner.** On VERDICT's frame it is out. With the loss accepted, COMP2 beats it: level on novel mechanisms (3), then 6 SHOULDs against 5. MIN-P's 25 fewer pairs never count.

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default acks one publisher at p99 0.550 ms ([E-09b](../experiments/E09b-nats/README.md)), so a win needs p99 under about 0.303 ms. The second-fastest of three fsyncs alone has p99 0.323 ms here ([E-01](../experiments/E01-floors/README.md); RR-15). Restating does not save it. Item 2 (this test line accepted as a loss) makes it open.
- **SC-03 and SC-10.** Measured ceiling, simulated: 12 to 22 effective writers against 64 under a skewed load ([E-18](../experiments/E18-slot-balance/README.md); gap 0.66 each). Restating with the app split saves both. Item 5 (F_w above 135) would fail them again.
- **F-15 (Outside services).** Structural: a slot move waits while the object store is down ([E-33](../experiments/E33-genesis-restore/README.md)). Restating saves it; item 11 keeps it failing.
- **F-17 (Partial partitions).** Counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38](../experiments/E38-raft-gray-failures/README.md)). Restating saves it; item 19's clique reading opens it as worded.
- Its [scorecard](../judging/rows/MIN-P.md) still leads PERF-04's reason with "C = 0.73 ms, the floor of any persisted commit". RR-04 and RR-15 replaced that reason; the fail stands.

## What it does well

- **Against COMP2.** Three MUSTs are met here and open there: P-10 (Locks and leader election), P-15 (Transactions across partitions) and F-02 (Exactly once per attempt). With no `memory` rung, no group can lose an acknowledged tail.
- **Fewest pairs of the family.** 252, against 264 for MIN-P+par and 277 for COMP2.
- **Against TiKV-TS.** 28 cells are met here and open there (computed for this report: `repro diff MIN-P TiKV-TS`). TiKV-TS meets F-22 (S) and SC-06 (S), which MIN-P does not.
- **Many small resources.** An idle resource costs 0.4 to 1.2 KB with no dormant groups, and a create takes 1.6 to 1.8 ms against a 10.7 ms bar ([E-36](../experiments/E36-many-resources/README.md)).

## What would change its verdict

- **Raise it:**
  - Item 2, the loss accepted: it wins among the 20 study rows ([OUTCOME B.3](../judging/OUTCOME.md#b3-what-flips-the-winner)). Among all 31, MIN-P+par still wins on F-22 (S).
  - Item 2 and kill test 2a together (`par` fails a MUST): MIN-P then wins among all 31 (computed for this report: in `repro rank --strict --loss`, only rows with `par` beat MIN-P).
- **Lower it:**
  - Item 15, the loose reading: with the loss, TiKV-persisted wins (0 novel against 3).
  - Kill tests K-01 (a slot move meets a membership change), 2d (slot-move mutants at 85 %) and the phase-4 writer count hit every slot row ([section 9](../VERDICT.md#9-the-next-step)).
- **Owed:** K-04 and K-06, the project-group crossings: the move loop over many resources, and big or dropped resources in a shared group ([AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp)).

## Twins and neighbours

- **MIN** (G `shard`, one option away): the same cells, but 4 novel mechanisms and 253 pairs. MIN-P beats it: one apart, SHOULDs level, one pair fewer.
- **MIN-P+par** (Z `par`, one option away): 3 / 6 / 264. It meets F-22 (S) and has DATA-09 met by its design rule. With the loss it beats MIN-P.
- **MIN-P+m** (Q `mix`, one option away): 3 / 5 / 264. It is in on VERDICT's frame, but P-10, P-15 and F-02 are open there.
- **MIN-TS** (G and L differ): 4 / 5 / 253, with 94 open restated. With the loss, "open MUSTs first" picks it among the judged rows.

## The evidence

- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms and 3,280 a second.
- [E-01](../experiments/E01-floors/README.md): C is 0.73 ms here; RR-15 puts a `persisted` commit's lower bound at 0.323 ms.
- [E-36](../experiments/E36-many-resources/README.md): 0.4 to 1.2 KB per idle resource with project groups, against 86 KB for MIN as drafted.
- [E-17c](../experiments/E17c-partitioning-rerun/README.md): project groups need 28 rules, the same as plain slot moves.
- [E-16](../experiments/E16-controller-loop/README.md): the controller loop needs 18 rules against leader healing's 14.
- [E-37](../experiments/E37-bad-entry/README.md): `rejoin` fixes one bad entry in 2 rules; two damaged replicas need F-12's operator step.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape, MIN-P included, costs $7.52 to $7.89 a month at 10 writes a second on Fly.
- [E-32's pair placement](../experiments/E32-composition/pairs.md): of MIN-P's 252 pairs, 61 are open ([VERDICT section 7.6](../VERDICT.md#76-dev-02-and-the-models)).

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its scorecard: [judging/rows/MIN-P.md](../judging/rows/MIN-P.md).
- SPACE's row: [section 4.1](../SPACE.md#41-the-matrix) and [section 4.2](../SPACE.md#42-what-each-one-is-and-why-it-stays).
- VERDICT: [section 3.1](../VERDICT.md#31-the-20-study-rows), [5.4](../VERDICT.md#54-every-must-it-leaves-open-restated-99) (its closers stand in for COMP's leader healing), [6](../VERDICT.md#6-every-other-row), [7.3](../VERDICT.md#73-every-flip-in-outcome-a3-and-b3) and [7.6](../VERDICT.md#76-dev-02-and-the-models).
