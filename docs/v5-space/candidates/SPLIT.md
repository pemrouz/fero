# SPLIT: groups that split and merge by size and load, with no controller

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss; terms in VERDICT's [key of terms][key]), SPLIT is in, but COMP2 beats it by [rule 3][rule]. They are 1 apart on novel mechanisms (4 against 3), so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`). SPLIT is still the row three user choices would name on this frame: F_w above 135, F-15 kept as worded, or DEP-21's volume ruled structural (items 5, 11 and 17). The loose reading keeps it in, but TiKV-TS wins with 0 novel mechanisms against 4. With JetStream's default test line accepted as a loss, MIN-P+par wins on the strict reading and TiKV-persisted on the loose one. As worded it shares first place with DRAFT and ISR among the 20 ([OUTCOME A.2][oa2]), and among all 31 on the strict reading.

## In short

- **Where writes go.** A resource's keys live in groups that split at a key or hash bit when they grow too big or too busy, and merge when they shrink. Any server takes a write and forwards it to the group's leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript. Each group has full voters, learners, and a log-only voter (a witness) on a shared log tier.
- **Who heals and moves.** Each group's leader heals its own replicas and decides its own splits. An optional planner may send hints. There is no controller.
- **What a commit means.** `persisted` by default; `memory` or `none` per resource.
- **Where rows fold.** Every full replica folds the rows with `data`.
- **Exactly once.** The draft's dedup window: per issuer, a window, a floor, outcomes by id and time budgets per hop.
- **Where it comes from.** SPACE's row SPLIT, the draft's decision 20a: "groups that split by size and load, CockroachDB-style, with no controller" ([SPACE 4.2][s42]). It copies CockroachDB's and TiKV's range splits and merges.

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority |
| G: what one log covers | `shard` | each resource is cut into parts; each part is a group |
| P: keys to groups | `split` | a group splits at a key or hash bit, and later merges; lineage is kept |
| K: where write rules live | `lib` | a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `self+p` | each leader heals its own group; an optional planner sends hints |
| V: kinds of replica | `+lrn +wit` | voters, learners, and log-only voters that never serve |
| Q: what a commit means | `mix` | `persisted` by default; `memory` or `none` per resource |
| D: exactly once | `win` | issuer window, floor, outcomes by id and per-hop time budgets |
| O: positions | `off+lin` | an offset per group, plus the lineage of splits |
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

From [outcome.json] and [OUTCOME.md][outcome]. SPLIT has no DATA-01 failure on either reading.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 3: F-17, SC-03, SC-10 (gap ÷ bar 1.32) | none |
| MUSTs open | 100 | 102 |
| MUSTs met | 29 | 30 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the dedup window, the restore mark in the store's manifest, the dir lease (one process per dir) | the same 4 |
| Interacting pairs | 295 | 295 |
| Rank | 1st of 20, level with DRAFT and ISR ([A.2][oa2]); among 31, level first on the strict reading, with PD+fix and TiKV-TS also level on the loose one ([matrix]) | 2nd of the 3 rows in among the 20: COMP beats it, and it beats DRAFT ([B.2][ob2]); among 31 on the strict reading, 6th of the 7 rows in (computed for this report: `repro rank --strict`) |

Rule 3 ([VERDICT 1][rule]) ranks the rows still in: fewer novel mechanisms wins when 2 or more apart, then more SHOULDs, then fewer pairs. Counts such as 0 / 4 / 244 read novel / SHOULDs / pairs.

**Against the winner.** COMP2 beats SPLIT: 1 apart on novel mechanisms, so the SHOULDs decide, 6 against 5. Even with `par` added (SPLIT with Z `par`: 4 / 6 / 311, no guessed cell), COMP2 wins on pairs (computed for this report: `repro row Z=par SPLIT`).

## What fails, and the proof

No MUST fails restated. As worded, three fail, and restating saves each one.

- **SC-03 (Scale writes up) and SC-10 (Only stated ceilings).** A ceiling, simulated ([E-18]). As worded, every design reaches only 12 to 22 effective writers under a skewed load, against F_w = 64 (gap 0.66 each). Restated with the app split, both are open: key-level splits have no fixed ceiling ([E-18], [E-17b]), but were not run with the split. Item 5 (F_w above 135) fails the slot rows and leaves SPLIT open.
- **F-17 (Partial partitions).** A counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stayed stuck ([E-38]). Restated, it is open. Item 19 (the clique reading) opens it as worded, and then DRAFT and SPLIT lead outcome A with 2 MUSTs ([VERDICT 2][v2]).

## What it does well

- **No cell is met here and not met by all three leading rows** (COMP2, MIN-P+par, TiKV-TS; computed for this report: `repro diff SPLIT COMP2 MIN-P+par TiKV-TS`).
- **DEP-15 (S) Two copies survive a crash** is open here and not met by all three. SPLIT's log-only voter is the third voter by design, but V `+wit` was never modelled ([scorecard][card]).
- **One failure fewer than COMP2 as worded.** Its F-15 (Outside services) is open: it has no slot moves, and its restore mark's home is left open by `fero init` (A-08). COMP2's slot moves wait while the store is down ([VERDICT 2][v2]).
- **No fixed writer ceiling.** That is why item 5 names it. A split copies no data ([E-17b]).
- **The cheapest shape at 10 writes a second.** DRAFT's shape costs $5.17 to $5.54 a month on Fly, against $7.52 to $7.89 for COMP2's. It stays at the $2.19 free bar when awake ([E-41]). Both savings need the shared log tier, which OPS-14 must allow ([E-35]).
- **Against TiKV-TS,** 23 cells are met here and open there (computed for this report: `repro diff SPLIT TiKV-TS`).
- **Its weak side** (the first line computed for this report: `repro diff COMP2 SPLIT`; the rest from the files):
  - Against COMP2 it leaves open or unmet P-17, DATA-09, F-22 (S) and TEST-12.
  - Split and merge need 37 rules, against 28 for slot moves ([E-17c]).
  - About 82 times BUY's lines, against about 49 for a Raft-per-group row ([E-44], an estimate).
  - 123 of its 295 pairs are open, the most of the eight rows VERDICT places ([VERDICT 7.6][v76]).

## What would change its verdict

- **Raise it** ([section 8][s8], each on VERDICT's frame):
  - Item 5, F_w above 135: the slot rows' own restated cells fail, and SPLIT wins (reasoned from the cells).
  - Item 11, F-15 kept as worded: SPLIT wins, but only because its restore mark has no home in the store yet. COMP2 with its mark's home left open the same way would pass, on 9 guessed cells.
  - Item 17, DEP-21's volume ruled structural: COMP2's family goes out at $2.34 awake, and SPLIT wins (note d).
  - The phase-4 writer count ([section 9][s9]): below 64 writers per resource, the slot rows fail SC-03 and SC-10, and the split rows are left.
  - With every open SHOULD counted met, SPLIT wins among the 20, 13 against COMP's 12 ([OUTCOME B.3][ob3]). Over all 31, COMP2 keeps the win then ([VERDICT 7.4][v74]).
- **Lower it:**
  - Item 14 (no shared tier): its OPS-14 fails, and it is out in both outcomes ([VERDICT 7.3][v73]).
  - Items 7 and 20 put every row out. The loose reading gives TiKV-TS, and the PERF-01 loss gives MIN-P+par or TiKV-persisted.
- **Close calls in the mechanism count** ([VERDICT 7.5][v75]). RM-01 gave SPLIT the merge its SC-04 relies on (278 to 295 pairs). Without it, SPLIT would have won among the 20. RM-02 found log replicas not novel (5 to 4).
- **Owed:**
  - models of the witness's "lead only to repair" rule and of the planner's hints;
  - E-32's dedup crossing run with the dedup window beside fence tokens (RR-05);
  - the `memory` rung's lost tail (K-09), which leaves P-10, P-15 and F-02 open;
  - A-29's tenant budget for the shared tier.

## Twins and neighbours

- **DRAFT** (study row, two options away: P `slot + rule` and O `slot`): 5 / 5 / 309. SPLIT beats it: 1 apart, SHOULDs level, fewer pairs ([OUTCOME B.2][ob2]).
- **SPLIT2** is SPLIT made like COMP2, and not judged. It adds client sessions, the controller loop, learners, split and merge, and `par`. It scores 3 / 6 / 273 with 102 open, or 269 pairs with N `proc`. It passes COMP2 by 4 to 8 pairs, but on 15 guessed cells (14 with N `proc`) ([VERDICT 4.6][v46]).
- **One option away** (unjudged mixes, `python3 tools/closure.py row '<change>' SPLIT`):
  - Z `par`: 4 / 6 / 311, no guessed cell.
  - D `sess`: 3 / 5 / 296, on 6 guessed cells.
  - C `cent-co`: 4 / 5 / 278, on 3 guessed cells.
  - N `proc`: 4 / 5 / 292, on 1 guessed cell (DEP-15 S).
- **The strict ladder's circle** from 4 guessed cells runs through SPLIT2 rows with a separate controller (2 / 5 / 267). They beat COMP2 only on guesses ([VERDICT 4.4][v44]).

## The evidence

- [E-17b]: a split copies nothing; split and merge need 33 to 34 rules (a 9-rule split, an 11-rule merge and lineage).
- [E-17c]: on the same footing, split and merge need 37 rules against 28 for slot moves; a third group needs "split only a partition you hold".
- [E-18]: key-level splits balance at most 5 % better than slots to 64 groups, and meet the same hot-partition ceiling.
- [E-20]: the dedup window needs 17 rules against 13 for client sessions, and fails past its horizon.
- [E-44]: about 13,500 fero-owned lines for SPLIT against about 8,000 for a Raft-per-group row (estimates).
- [E-41]: $0.04 asleep, $2.19 awake, $5.17 to $5.54 a month at 10 writes a second (DRAFT's shape).
- [E-35]: on a shared journal, a tenant at its quota raised another's p99 1.40 to 1.59 times, against a 1.1 bar.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/SPLIT.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [3.1][v31] (the 20 study rows), [3.2][v32], [4.6][v46] (SPLIT2), [6][v6], [7.5][v75], [8][s8] items 5, 11, 14 and 17

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v31]: ../VERDICT.md#31-the-20-study-rows
[v32]: ../VERDICT.md#32-all-31-judged-rows-the-matrix
[v44]: ../VERDICT.md#44-step-3-rows-far-from-any-judged-row-win-only-on-guesses
[v46]: ../VERDICT.md#46-draft-2s-two-unjudged-rivals-now
[v6]: ../VERDICT.md#6-every-other-row
[v73]: ../VERDICT.md#73-every-flip-in-outcome-a3-and-b3
[v74]: ../VERDICT.md#74-the-sweep-over-all-31-rows
[v75]: ../VERDICT.md#75-close-calls-in-the-mechanism-count
[v76]: ../VERDICT.md#76-dev-02-and-the-models
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob2]: ../judging/OUTCOME.md#b2-the-ranking
[ob3]: ../judging/OUTCOME.md#b3-what-flips-the-winner
[card]: ../judging/rows/SPLIT.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-17b]: ../experiments/E17b-partitioning-part2/README.md
[E-17c]: ../experiments/E17c-partitioning-rerun/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-20]: ../experiments/E20-dedup/README.md
[E-35]: ../experiments/E35-neighbours/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
[E-44]: ../experiments/E44-outside-log/README.md
