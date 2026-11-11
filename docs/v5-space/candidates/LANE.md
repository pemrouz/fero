# LANE: 64 lanes per project, shared by every resource

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss; terms in VERDICT's [key of terms][key]), LANE is out on four MUSTs: PERF-04, SC-03, SC-04 and SC-10. Its 64 lanes are fixed per project and shared by every resource, so one resource gets only 23 to 53 writers' worth under a skewed load ([E-18]). No rule ever removes a lane, and its only durable rung is `persisted`. The DATA-01 reading does not touch it: it folds with `data` on either reading. Accepting JetStream's default test line as a loss removes PERF-04 only, so it stays out on SC-03, SC-04 and SC-10. As worded it fails 5 MUSTs and places 9th of 20, level with six other rows ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** Every resource in a project hashes into the same 64 lanes. Each lane is one Raft group. Any server takes a write and forwards it to the lane's leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. Each lane has full voters, learners, and a log-only voter (a witness) on a shared log tier.
- **Who heals and moves.** Each lane's leader heals its own replicas; an optional planner may send hints. Lanes never split, merge or go away. Moving a range between lanes is left for a later phase.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the ack.
- **Where rows fold.** Every full replica folds the rows with `data`.
- **Exactly once.** The draft's dedup window: per issuer, a window, a floor, outcomes by id and time budgets per hop.
- **Where it comes from.** SPACE's row LANE, "the reviewer's 64 lanes per project" ([SPACE 4.2][s42]). It copies Redis Cluster's fixed slots per cluster and Pulsar's bundles ([SPACE 2, G][s2g]).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority |
| G: what one log covers | `lane` | a fixed number of logs per project; every resource hashes into them |
| P: keys to groups | `fixN (lanes)` | 64 lanes per project, by hash, fixed for good |
| K: where write rules live | `lib` | a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `self+p` | each leader heals its own group; an optional planner sends hints |
| V: kinds of replica | `+lrn +wit` | voters, learners, and log-only voters that never serve |
| Q: what a commit means | `maj-d` | `persisted` only: on disk at a majority before the ack |
| D: exactly once | `win` | issuer window, floor, outcomes by id and per-hop time budgets |
| O: positions | `off` | an offset per group; it breaks if a lane's range ever moves |
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

From [outcome.json] and [OUTCOME.md][outcome]. LANE has no DATA-01 failure on either reading.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 5: F-17, PERF-04, SC-03, SC-04, SC-10 (gap ÷ bar 1.39) | 4: PERF-04, SC-03, SC-04, SC-10 (gap ÷ bar 1.39) |
| MUSTs open | 95 | 95 |
| MUSTs met | 32 | 33 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 3: the dedup window, the restore mark in the store's manifest, the dir lease (one process per dir) | the same 3 |
| Interacting pairs | 232 | 232 |
| Rank | 9th of 20, level with MIN, RUST, LEAN, MIN-P, MIN-TS and SIDE ([A.2][oa2]) | out on 4 MUSTs ([B.1][ob1]) |

Rule 3 ([VERDICT 1][rule]) ranks the rows still in: fewer novel mechanisms wins when 2 or more apart, then more SHOULDs, then fewer pairs. Counts such as 0 / 4 / 244 read novel / SHOULDs / pairs.

**Against the winner.** LANE is out, so rule 3 never compares it with COMP2. Let back in with all four waived, it would beat every study row still in: DRAFT, SPLIT and COMP (computed for this report: `repro rank --twenty`, `repro tally LANE`). Against COMP it is 3 / 5 / 232 to 3 / 5 / 283. Among all 31, COMP2 would still beat it on SHOULDs, 6 against 5.

## What fails, and the proof

- **SC-03 (Scale writes up) and SC-10 (Only stated ceilings).** A ceiling, simulated ([E-18]). The 64 lanes are shared by every resource, so one resource gets 23 to 53 writers' worth under skew, even with the app split. That is below F_w = 64, and no move adds a lane ([E-17b]). Restating does not save them. The recorded gap is the as-worded one, 0.66 each; restated, the scorecard puts it at 0.17.
- **SC-04 (Scale down).** Structural. G `lane` fixes 64 groups per project for good, and no rule removes one, so a project pays for 64 groups whatever its load ([scorecard][card]). Only ISR and LANE fail SC-04 ([VERDICT 2][v2]).
- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default acks one publisher at p99 0.55 ms ([E-09b]), so a win needs p99 under about 0.303 ms. The best `persisted` commit here has p99 0.323 ms ([E-01]; RR-15). Gap 0.07. User choice item 2 ([section 8][s8]) opens it.
- **F-17 (Partial partitions), as worded.** A counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38]). Restated, it is open.

## What it does well

- **No cell is met here and not met by all three leading rows** (COMP2, MIN-P+par, TiKV-TS; computed for this report: `repro diff LANE COMP2 MIN-P+par TiKV-TS`).
- **DEP-15 (S) Two copies survive a crash** is open here and not met by all three, through its witness. V `+wit` was never modelled.
- **Against COMP2,** P-10 (Locks and leader election) and P-15 (Transactions across partitions) are met. COMP2's `memory` rung leaves both open (RR-11, RR-12). MIN-P+par meets them too.
- **OPS-01 (No numbers to choose) is met by construction:** fero fixes the 64 lanes, so no one picks a count.
- **The cheapest per resource.** An idle resource costs 0.2 KB and is created in 1.6 to 1.8 ms ([E-36]).
- **The fewest pairs of any 3-novel row:** 232, against 264 for MIN-P+par and 277 for COMP2 ([outcome.json]).
- **F-15 (Outside services) is open as worded,** where COMP2 and MIN-P+par fail it: it has no slot moves.
- **Its weak side.** Against MIN-P+par it leaves open or unmet DATA-09, F-02, F-22 (S) and TEST-12 (computed for this report: `repro diff MIN-P+par LANE`). Its F-02 is open because the dedup window was never checked beside fence tokens (RR-05).

## What would change its verdict

- **No user choice in [section 8][s8] lets it back in.** Item 2 removes PERF-04 only. SC-03, SC-04 and SC-10 fail under every reading, and the cells carry no F_w alternative for them ([VERDICT 7.4][v74]).
- **Other options would fix parts** (computed for this report: `repro row Q=mix LANE`). LANE with Q `mix` no longer fails PERF-04 (3 / 5 / 244, on 6 guessed cells). It is still out on SC-03, SC-04 and SC-10.
- **Lower it further:** item 14 (no shared tier) fails its OPS-14, and item 20 fails its P-13, F-07 and P-02.
- **A close call in the mechanism count** ([VERDICT 7.2][v72]). RM-02 found log replicas not novel (4 to 3). It does not move its standing.
- **Owed, for its own open cells** ([scorecard][card]):
  - E-32's dedup crossing run with the dedup window beside fence tokens (F-02; RR-05).
  - A model and a run of dropping and re-creating a resource inside shared lanes (SC-13).
  - If a lane's range ever moves: an epoch and lineage for its per-lane offsets ([E-17b], [E-31]).

## Twins and neighbours

- **No judged row is within three options of LANE** (computed for this report: `repro near LANE`).
- **One option away** (unjudged mixes, `python3 tools/closure.py row '<change>' LANE`), all still out on SC-03, SC-04 and SC-10:
  - Z `par`: 3 / 6 / 246, no guessed cell.
  - Q `mix`: 3 / 5 / 244, on 6 guessed cells; PERF-04 opens.
  - D `sess`: 2 / 5 / 234, on 8 guessed cells.
  - N `proc`: 3 / 5 / 230, on 1 guessed cell (DEP-15 S).
- **CELL** is the other fixed-count row: 16 cells per resource, re-keyed to grow ([report][cell]).
- **ISR** fails SC-04 the same way: its partition count is fixed, and nothing merges a group ([VERDICT 6][v6]).

## The evidence

- [E-18]: 64 shared lanes give one resource 23 to 53 writers' worth under skew, with the app split.
- [E-17b]: lanes with range moves need 28 to 29 rules, and fail SC-03 and SC-04 by design.
- [E-17c]: on the same footing, lanes need 30 rules against 28 for slot moves.
- [E-36]: an idle resource costs 0.2 KB with 64 groups a project; a create takes 1.6 to 1.8 ms.
- [E-20]: the dedup window needs 17 rules against 13 for client sessions, and fails past its horizon.
- [E-11]: at 10,000 writes a second, 16 groups cost the same CPU as one or less; it finds no penalty at 16 to 64 groups.
- [E-09b] and [E-01]: JetStream's default p99 is 0.55 ms; a `persisted` commit here is at least 0.323 ms.
- [E-41]: LANE has DRAFT's cost shape: $5.17 to $5.54 a month at 10 writes a second on Fly.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/LANE.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [2][v2] (SC-04), [6][v6] (its one-line standing), [7.2][v72], [7.4][v74], [8][s8] item 2

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v6]: ../VERDICT.md#6-every-other-row
[v72]: ../VERDICT.md#72-the-re-rulings-since-draft-2-and-what-each-changed
[v74]: ../VERDICT.md#74-the-sweep-over-all-31-rows
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob1]: ../judging/OUTCOME.md#b1-each-row
[card]: ../judging/rows/LANE.md
[cell]: CELL.md
[s2g]: ../SPACE.md#g-what-one-ordered-log-covers-the-cost-unit
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-11]: ../experiments/E11-many-groups/README.md
[E-17b]: ../experiments/E17b-partitioning-part2/README.md
[E-17c]: ../experiments/E17c-partitioning-rerun/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-20]: ../experiments/E20-dedup/README.md
[E-31]: ../experiments/E31-subscribe/README.md
[E-36]: ../experiments/E36-many-resources/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
