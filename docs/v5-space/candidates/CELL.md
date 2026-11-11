# CELL: 16 fixed cells per resource, moved whole, re-keyed to grow

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss; terms in VERDICT's [key of terms][key]), CELL is out on five MUSTs: OPS-01, P-07, SC-03, SC-08 and SC-10. Sixteen cells hashed with no load-aware move give one resource only 7 to 15 writers' worth under a skewed load ([E-18]). To grow it re-keys into a new generation, where writes wait, old cursors are refused, and a person picks the new count ([E-17c], [E-31]). The DATA-01 reading does not touch it: it folds with `data`, and is out on the same five either way. Accepting JetStream's default test line as a loss does not touch it either, since its `memory` rung already leaves PERF-04 open. As worded it fails 6 MUSTs and places 17th of 20 ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** Each resource's keys hash into 16 cells, fixed when the resource is defined. Each cell is one Raft group. Any server takes a write and forwards it to the cell's leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. Each cell has full voters, learners, and a log-only voter (a witness) on a shared log tier.
- **Who heals and moves.** Each cell's leader heals its own replicas, and cells move whole. There is no controller and no planner.
- **How it grows.** A re-key copies every cell into a new generation with more cells, freezes the old one, then flips a catalogue pointer. One re-key runs at a time.
- **What a commit means.** `persisted` by default; `memory` or `none` per resource.
- **Where rows fold.** Every full replica folds the rows with `data`.
- **Where it comes from.** SPACE's row CELL, from V5-PRIMITIVE: "fixed 16 cells per resource, moved whole, re-keyed to grow" ([SPACE 4.2][s42]). The re-key copies Vitess's resharding (VReplication).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority |
| G: what one log covers | `shard` | each resource is cut into parts; each part is a group |
| P: keys to groups | `fixN + rekey` | 16 cells fixed at define, by hash; grow by copying into a new generation, then flip a pointer |
| K: where write rules live | `lib` | a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `self` | each group's leader heals its own replicas toward a computed target |
| V: kinds of replica | `+lrn +wit` | voters, learners, and log-only voters that never serve |
| Q: what a commit means | `mix` | `persisted` by default; `memory` or `none` per resource |
| D: exactly once | `sess` | client sessions: per client, the highest sequence and cached answers |
| O: positions | `off` | an offset per group; it breaks when a partition's records move |
| T: time, TTLs, leases | `clamp` | the leader's clock, held to the median of the members' clocks, never going back |
| X: writes across partitions | `saga` | sagas with fenced locks; a reader may see half a saga unit |
| S: storage | `jrnl +tier` | one journal per process, plus an object-store tier; founded by `fero init` |
| F: where rows fold | `all` | every full replica folds the rows with `data` |
| W: reads | `any ridx` | from any ready replica at a position, or by Raft's read index |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `both` | one code base for both roles: servers and log members |
| L: language | `ts→rs` | TypeScript first, a Rust core later |
| I: the Raft core | `port` | etcd's Raft ported to TypeScript; raft-rs later |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread; user code and the rows on the main thread |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `tier` | only the log tier is shared between projects; servers stay per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. CELL has no DATA-01 failure on either reading.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 6: F-17, OPS-01, P-07, SC-03, SC-08, SC-10 (gap ÷ bar 1.54) | 5: OPS-01, P-07, SC-03, SC-08, SC-10 (gap ÷ bar 1.54) |
| MUSTs open | 99 | 100 |
| MUSTs met | 27 | 27 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the re-key, the restore mark in the store's manifest, the dir lease (one process per dir) | the same 4 |
| Interacting pairs | 277 | 277 |
| Rank | 17th of 20 ([A.2][oa2]); on the strict reading 16th, above PD (computed for this report: `repro rank --worded --strict --twenty`) | out on 5 MUSTs ([B.1][ob1]) |

Rule 3 ([VERDICT 1][rule]) ranks the rows still in: fewer novel mechanisms wins when 2 or more apart, then more SHOULDs, then fewer pairs. Counts such as 0 / 4 / 244 read novel / SHOULDs / pairs.

**Against the winner.** CELL is out, so rule 3 never compares it with COMP2. Let back in with all five waived, it would beat every study row still in: DRAFT, SPLIT and COMP (computed for this report: `repro rank --twenty`, `repro tally CELL`). Against COMP it is 4 / 5 / 277 to 3 / 5 / 283: 1 apart, SHOULDs level, fewer pairs. Among all 31, COMP2 would still beat it on SHOULDs, 6 against 5.

## What fails, and the proof

- **SC-03 (Scale writes up) and SC-10 (Only stated ceilings).** A ceiling, simulated ([E-18]). Sixteen cells give 7 to 15 writers' worth under skew, even with the app split, against F_w = 64. A re-key to more cells keeps the same load-blind hashing: 1.35 to 2.72 times the mean load at 64 groups. Gap 0.77 each. Restating does not save them.
- **SC-08 (Without worry).** A counterexample, model-checked on CELL's own re-key ([E-17c]). A write to a partition that never moves must wait for the re-key (property L8, against clause b). That partition's rows are copied too (F8, against clause f). No reading or user choice saves it.
- **P-07 (Streams and replay).** Structural, from two models. A cursor of the old generation is refused, and the reader restarts from a snapshot ([E-17]). A raw group offset breaks at the first move, in 5 steps ([E-31]). The fix is another O option: a sequence carried in each record.
- **OPS-01 (No numbers to choose).** Structural, with each step confirmed by the referee. To reach F_w the resource must grow past 16 cells, and only a person picks the count, at define time or at a re-key ([scorecard][card]). If the user lowers F_w to 7 or less, 16 is enough and the cell is met. That is the only F_w flag in all 31 rows' cells ([VERDICT 7.4][v74]).
- **F-17 (Partial partitions), as worded.** A counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38]). Restated, it is open.

## What it does well

- **No cell is met here and not met by all three leading rows** (COMP2, MIN-P+par, TiKV-TS; computed for this report: `repro diff CELL COMP2 MIN-P+par TiKV-TS`). Against COMP2 alone, none either.
- **DEP-15 (S) Two copies survive a crash** is open here and not met by all three, through its witness. V `+wit` was never modelled.
- **F-15 (Outside services) is open as worded,** where COMP2 and MIN-P+par fail it: it has no slot moves.
- **No kernel mechanism for scaling.** The re-key is a library above the log ([SPACE 4.2][s42]). A re-key down holds in the model, so SC-04 (Scale down) is open, not failed ([E-17]).
- **Against TiKV-TS,** 21 cells are met here and open there (computed for this report: `repro diff CELL TiKV-TS`).
- **Its weak side.**
  - The re-key needs 36 to 38 rules as CELL writes it, against 28 for slot moves ([E-17c]).
  - Sixteen groups per resource add up. For 1,000 sleeping projects CELL needs 171,432 groups. In TypeScript that is 2.74 GB, the only row over 2 GB ([E-26]).

## What would change its verdict

- **No user choice in [section 8][s8] lets it back in.** SC-03, SC-10, SC-08 and P-07 fail under every reading.
- **Item 5 (F_w).** The cells flag only OPS-01: F_w at 7 or less meets it. SC-03 and SC-10 carry no F_w alternative in the cells.
- **Other options would fix parts.** CELL with O `slot` meets P-07, but is still out on SC-03, SC-08, SC-10 and OPS-01, on 6 guessed cells (computed for this report: `repro row O=slot CELL`). Load-aware slot moves are MIN's family.
- **Lower it further:** item 14 (no shared tier) fails its OPS-14, and item 20 fails its P-13, F-07 and P-02.
- **Close calls in the mechanism count** ([VERDICT 7.2][v72]). RM-02 found log replicas not novel (5 to 4). RM-05 found that CELL carries planner hints (262 to 277 pairs). Neither moves its standing.
- **Owed, for its own open cells** ([scorecard][card]):
  - E-36's create, cold-open and drop runs for 16 groups a resource (SC-13);
  - the 7-day load-cycle sim (SC-04);
  - the `memory` rung's lost tail (K-09), which opened P-10, P-15 and F-02 (RR-11 to RR-13).

## Twins and neighbours

- **No judged row is within three options of CELL** (computed for this report: `repro near CELL`).
- **One option away** (unjudged mixes, `python3 tools/closure.py row '<change>' CELL`):
  - Z `par`: 4 / 6 / 293, no guessed cell. It meets F-22 (S), but is still out on the same five.
  - O `slot`: 4 / 5 / 284, on 6 guessed cells. P-07 is met; still out on four.
- **Fixed N with no re-key** was pruned in SPACE as "strictly less than CELL" ([SPACE 4.3][s43]).
- **LANE** is the other fixed-count row: 64 lanes per project, not 16 cells per resource ([report][lane]).

## The evidence

- [E-18]: 16 cells give 7 to 15 writers' worth of one resource under skew; a re-key keeps load-blind hashing.
- [E-17]: the re-key is 2 to 10 rules bigger than slot moves, and fails SC-08 (b) and (f).
- [E-17c]: L8 and F8 model-checked; the re-key needs 36 to 38 rules as CELL writes it (30 to 32 with carried positions), against 28.
- [E-31]: group offsets break both subscribe modes at the first move, in 5 steps.
- [E-26]: 1,000 sleeping projects need 171,432 CELL groups; in TypeScript, 2.74 GB.
- [E-38]: 5 of 280 five-node partial partitions stuck with the leader up.
- [E-41]: CELL has DRAFT's cost shape: $5.17 to $5.54 a month at 10 writes a second on Fly.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/CELL.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [6][v6] (its one-line standing), [7.2][v72] (RM-02, RM-05), [7.4][v74], [8][s8] item 5

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v6]: ../VERDICT.md#6-every-other-row
[v72]: ../VERDICT.md#72-the-re-rulings-since-draft-2-and-what-each-changed
[v74]: ../VERDICT.md#74-the-sweep-over-all-31-rows
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob1]: ../judging/OUTCOME.md#b1-each-row
[card]: ../judging/rows/CELL.md
[lane]: LANE.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[s43]: ../SPACE.md#43-the-pruned-families
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-17]: ../experiments/E17-partitioning/README.md
[E-17c]: ../experiments/E17c-partitioning-rerun/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-26]: ../experiments/E26-dormant-groups/README.md
[E-31]: ../experiments/E31-subscribe/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
