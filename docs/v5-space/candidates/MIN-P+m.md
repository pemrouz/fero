# MIN-P+m: COMP2 with wipe-and-rejoin in place of peer repair

**Verdict.** MIN-P+m is in on [VERDICT.md](../VERDICT.md#6-every-other-row)'s frame (strict DATA-01, clauses restated, no PERF-01 loss), but COMP2 beats it by one SHOULD (words as in the [key of terms](../VERDICT.md#key-of-terms)). It is COMP2 with Z `rejoin` in place of `par`: a damaged replica wipes itself and rejoins as new. So one bad entry on each of two replicas stalls a group, and F-22 (S) is not met. It has fewer pairs than COMP2 (264 against 277), but rule 3 counts SHOULDs before pairs. On the loose DATA-01 reading TiKV-TS and PD+fix also beat it, with 0 novel mechanisms against 3. With JetStream's default test line accepted as a loss, MIN-P+par wins, and this row's `memory` rung buys nothing. With the clauses as worded it fails the same 4 MUSTs as COMP2.

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots, held by Raft groups owned by the project. Any server forwards a write to the slot's group leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. A write commits at a majority.
- **Who heals and moves.** One loop on `#meta`'s leader (the project's system group) heals replicas and moves slots.
- **What a commit means.** `persisted` by default; a resource may choose `memory` (in memory at a majority) or `none`.
- **Where rows fold.** Every full replica folds the rows with `data`, under COMP2's design rule (RR-17).
- **Damaged entries.** A checksum finds damage; the replica wipes, takes a new disk incarnation, and rejoins as a new member (`rejoin`).
- **Where it comes from.** Built by hand as COMP with the controller loop (C `cent-co`) ([cards.json](../judging/closure/hybrids/cards.json), row A1). It is also SPACE's MIN-P with a `memory` rung, hence the name.

## Its line

It differs from COMP2 only on Z, in bold.

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
| Z: storage faults | **`rejoin`** | **a checksum and a disk incarnation; a damaged replica wipes and rejoins as new** |
| N: tenancy | `proc` | one process (one Fly app) per project |

## Its score

From [cards.json](../judging/closure/hybrids/cards.json), tallied with `tools/closure.py`.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: F-15, F-17, SC-03, SC-10 (gap sum 1.32) | 0 |
| MUSTs open | 96 | 99 |
| MUSTs met | 32 | 33 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | 5 |
| Novel mechanisms | 3: the slot move, the restore mark in the store's manifest, the dir lease | 3 |
| Interacting pairs | 264 | 264 |
| Rank | every row out; 4th of 31 by rule 2 on the strict reading, level with COMP2 (computed for this report: `repro rank --worded --strict`) | not named on any [matrix.md](../judging/closure/results/matrix.md) line; on VERDICT's frame it beats COMP, SPLIT and DRAFT and loses to COMP2, COMP2 V=full and COMP+par C=cent V=full (computed for this report: `repro rank --strict`) |

- SHOULDs not met: P-15 (S), F-22 (S), DEV-02 (S) and DEP-15 (S).
- **Rule 3 against the winner.** It loses to COMP2: level on novel mechanisms (3), then 5 SHOULDs against 6. The one cell is F-22 (S), which family A's two judges scored met for COMP2 ([VERDICT section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix)).

## What fails, and the proof

All four fail only as worded, as for COMP2. Restated, none fails.

- **SC-03 and SC-10.** Measured ceiling, simulated: 12 to 22 effective writers against 64 under a skewed load ([E-18](../experiments/E18-slot-balance/README.md); gap 0.66 each). Restating with the app split saves both. Item 5 (F_w above 135) would fail them again.
- **F-15 (Outside services).** Structural: a slot move waits while the object store is down ([E-33](../experiments/E33-genesis-restore/README.md)'s rule). Restating saves it; item 11 keeps it failing.
- **F-17 (Partial partitions).** Counterexample, simulated: 5 of 280 five-node partial partitions stuck on etcd's Raft ([E-38](../experiments/E38-raft-gray-failures/README.md)). Restating saves it; item 19's clique reading opens it as worded.

## What it does well

- **Against COMP2 and MIN-P+par.** No cell is met here that either leaves unmet. This row's only gain is 13 fewer pairs than COMP2 (264 against 277), which rule 3 reaches only when SHOULDs tie.
- **Smaller repair.** `rejoin` needs 2 rules against `par`'s 7 ([E-37](../experiments/E37-bad-entry/README.md)). Rule 3 does not count rules.
- **Against TiKV-TS.** 26 cells are met here and open there: 23 MUSTs and 3 SHOULDs (computed for this report: `repro diff MIN-P+m TiKV-TS`). TiKV-TS meets F-22 (S) and SC-06 (S), which this row does not.

## What would change its verdict

- **Raise it** ([section 7.4](../VERDICT.md#74-the-sweep-over-all-31-rows), [section 9](../VERDICT.md#9-the-next-step)):
  - Kill test 2a: `par` fails a MUST with a voter change or on one journal per process (G-15, K-24). Then this row is next in line.
  - F-22 (S) left out of the count: it wins, on 264 pairs against 277.
  - `par-repair` counted novel and rule 4 read as "fewer novel first, whatever the gap" ([section 7.5](../VERDICT.md#75-close-calls-in-the-mechanism-count)). With rule 3 as written COMP2 still wins: 4 against 3 is one apart.
  - Given 2 fewer novel mechanisms, it would win (section 7.4).
- **Lower it:**
  - Kill test 2b: its `memory` rung breaks P-10, P-15 or F-02 with no fixing rule.
  - Item 2, the loss accepted: 11 judged rows beat it on the strict reading, MIN-P+par (the winner), MIN-P and MIN among them (computed for this report: `repro rank --strict --loss`). Its rung earns no cell.
  - Item 15, the loose reading: TiKV-TS wins.
- **Owed:** K-24, whether one bad entry wipes one group's replica or a member's whole journal ([AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp)).

## Twins and neighbours

- **COMP2** (Z `par`, one option away): 3 / 6 / 277. It differs only on F-22 (S).
- **COMP** (C `self+mv`, one option away): 3 / 5 / 283. It also has DATA-09 open. This row beats it by 19 pairs.
- **MIN-P** (Q `maj-d`, one option away): 3 / 5 / 252. It meets P-10, P-15 and F-02 but fails PERF-04. With the loss accepted it beats this row on pairs.
- **MIN-P+par** (Q and Z differ): 3 / 6 / 264, out on PERF-04 on VERDICT's frame.

## The evidence

- [E-37](../experiments/E37-bad-entry/README.md): `rejoin` fixes one bad entry in 2 rules, but two replicas with one bad entry each are never writable without F-12's operator step.
- [E-16](../experiments/E16-controller-loop/README.md): the controller loop needs 18 rules against leader healing's 14; 24 to 62 % of judged states could not finish healing while `#meta` was down.
- [E-02](../experiments/E02-pipeline/README.md): the `memory` rung read 0.57 ms in TypeScript and 0.33 ms in Rust at 50,000 writes a second.
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default p99 is 0.55 ms; a win needs about 0.30 ms.
- [E-18](../experiments/E18-slot-balance/README.md): 135 effective writers per resource at 4,096 slots, 72 at 1,024.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape costs $7.52 to $7.89 a month at 10 writes a second on Fly (VERDICT gives this row that shape, reasoned).

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its cells: [cards.json](../judging/closure/hybrids/cards.json) (row A1), or `python3 tools/closure.py card '' MIN-P+m`. That command shows DATA-09 open (100 open restated), because the design rule is recorded on the judged row only.
- SPACE's rows it is built from: [MIN-P](../SPACE.md#42-what-each-one-is-and-why-it-stays) and [COMP in AMENDMENTS section 4](../AMENDMENTS.md#4-the-composite-row-comp).
- VERDICT: [section 3.2](../VERDICT.md#32-all-31-judged-rows-the-matrix), [6](../VERDICT.md#6-every-other-row), [7.1](../VERDICT.md#71-the-judges-agreement), [7.4](../VERDICT.md#74-the-sweep-over-all-31-rows), [7.5](../VERDICT.md#75-close-calls-in-the-mechanism-count) and [9's kill table](../VERDICT.md#9-the-next-step).
