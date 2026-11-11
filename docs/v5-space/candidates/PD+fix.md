# PD+fix: TiKV's shape with three fixes: a checksum per entry, an object-store tier and a `memory` rung

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss; terms in VERDICT's [key of terms][key]), PD+fix is out on one MUST, DATA-01. Its Rust servers keep the rows in a multi-version LSM, not in `data` (RR-10, RR-17). On the loose reading it is in with no MUST failed, but TiKV-TS beats it by one SHOULD, F-22 (S), with both at 0 novel mechanisms ([VERDICT 4.6][v46]). With JetStream's default test line accepted as a loss, TiKV-persisted wins on the loose reading and PD+fix stays out on the strict one. As worded it fails F-17, SC-03 and SC-10, and on the loose reading shares first place with DRAFT, SPLIT, ISR and TiKV-TS ([matrix]).

## In short

- **Where writes go.** Each resource is cut into ranges of keys, each one Raft group. A smart client caches which server leads each range and writes straight there.
- **How replicas agree.** Raft, through raft-rs in a Rust server.
- **Who heals and moves.** A separate controller (PD, the "placement driver") places replicas, splits big ranges and merges small ones. A timestamp oracle in it hands out times.
- **What a commit means.** `persisted` by default. A resource may choose `memory` (in memory at a majority, on disk within about a second) or `none`. Writes across ranges use two-phase commit.
- **Where rows fold.** Each server keeps many versions of each row in an LSM. `data` folds only on clients.
- **Storage and faults.** The LSM sits on each server's disk, with old data copied to an object store (the tier). A checksum per entry finds damage, and a damaged replica is wiped and rejoins as new (`rejoin`).
- **Where it comes from.** Draft 2 priced it by hand as PD with three fixes. The closure pass judged it blind as family B's row B3 ([cards.json][cards]). It copies TiKV, Kafka's and Redpanda's tiered storage, and Kafka's clean-shutdown mark for the `memory` rung ([B.settled.json][bsettled]).

## Its line

It differs from PD on three axes, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority |
| G: what one log covers | `shard` | each resource is cut into parts; each part is a group |
| P: keys to groups | `split+merge` | a group splits at a key when it grows too big or busy; small neighbours merge |
| K: where write rules live | `kern` | dedup, conditions and ops are commands of the kernel's own state machine |
| C: who heals and moves | `cent` | a separate replicated controller decides placement and moves |
| V: kinds of replica | `+lrn` | voters, plus learners (full copies that do not vote) |
| Q: what a commit means | **`mix`** | **`persisted` by default; `memory` or `none` per resource** |
| D: exactly once | `txn` | transaction ids under two-phase commit |
| O: positions | `hlc` | hybrid-logical-clock timestamps, plus closed timestamps |
| T: time, TTLs, leases | `tso` | a central timestamp oracle |
| X: writes across partitions | `2pc` | transaction records and intents over multi-version state |
| S: storage | **`lsm +tier`** | **an LSM on each server's disk, plus an object-store tier** |
| F: where rows fold | `all` | every full replica keeps the rows, in its own multi-version store |
| W: reads | `lease ridx` | leader reads under a time lease, or by Raft's read index |
| U: where user code runs | `cli` | no user code on servers; apps are clients |
| H: where fero runs | `srv` | a separate server binary |
| L: language | `rs-srv` | a Rust server with a TypeScript client |
| I: the Raft core | `raft-rs` | raft-rs, the Rust port of etcd's Raft |
| Y: how a write reaches its leader | `smart` | the client holds the range table and sends to the leader |
| M: threads | `kwN` | several kernel threads; each group pinned to one |
| Z: storage faults | **`rejoin`** | **a checksum per entry; a damaged replica is wiped and rejoins as new** |
| N: tenancy | `proc` | one process set (one Fly app) per project |

## Its score

From [cards.json][cards] and [matrix.md][matrix], tallied with `tools/closure.py`. The strict figures add DATA-01.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 3: F-17, SC-03, SC-10 (gap ÷ bar 1.32); strict: 4, with DATA-01 | none; strict: 1, DATA-01 |
| MUSTs open | 119 (strict: 118) | 122 (strict: 121) |
| MUSTs met | 10 | 10 |
| SHOULDs met | 3: SC-06, SC-12, DEV-04 | the same 3 |
| Novel mechanisms | 0 | 0 |
| Interacting pairs | 247 | 247 |
| Rank | every row out; loose: level first by rule 2 with DRAFT, SPLIT, ISR and TiKV-TS ([matrix]); strict: level 4th of 31 with six other rows (computed for this report: `repro rank --worded --strict`) | loose: in, but not named; it is 2nd of the 9 rows in, beaten only by TiKV-TS (computed for this report: `repro rank`); strict: out on DATA-01 |

Rule 3 ([VERDICT 1][rule]) ranks the rows still in: fewer novel mechanisms wins when 2 or more apart, then more SHOULDs, then fewer pairs. Counts such as 0 / 4 / 244 read novel / SHOULDs / pairs.

**Against the winner.** On the strict reading it is out, so rule 3 never compares it with COMP2. On the loose reading it beats COMP2 at rule 3's first step, 0 novel against 3. It still loses to TiKV-TS: level on novel, 3 SHOULDs against 4.

## What fails, and the proof

- **DATA-01 (data is the state engine), strict reading only.** Structural (RR-10, RR-17). The servers' rows are versions in an LSM, written by kernel commands and two-phase commit, in Rust. Item 15 ([section 8][s8]) is the only way out: on the loose reading the cell stays open until DATA-09's differential test runs. The middle reading still fails it ([VERDICT 3.3][v33]).
- **SC-03 (Scale writes up) and SC-10 (Only stated ceilings), as worded.** A ceiling, simulated ([E-18]). Every design reaches only 12 to 22 effective writers under a skewed load, against F_w = 64 (gap 0.66 each). Restated with the app split, both are open: key-level splits have no fixed ceiling, but were not run with the split. Item 5 (F_w above 135) leaves split rows open.
- **F-17 (Partial partitions), as worded.** A counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38]). Restated, it is open. Item 19's clique reading opens it as worded.

## What it does well

- **No cell is met here and not met by all three leading rows** (COMP2, MIN-P+par, TiKV-TS; computed for this report: `repro diff PD+fix COMP2 MIN-P+par TiKV-TS`).
- **Against COMP2 and MIN-P+par,** it meets SC-06 (S) State size. An LSM holds state larger than memory by construction. TiKV-TS meets it too.
- **0 novel mechanisms and 247 pairs,** against COMP2's 3 and 277.
- **One failure fewer as worded than COMP2.** Its F-15 (Outside services) is open. Writes, elections and new replicas use the local LSM, and the tier uploads behind them (family B's judges, [B.settled.json][bsettled]).
- **What the three fixes bought over PD.** `rejoin` meets F-22 (M) ([E-37]). The tier turns SC-05 from failed to open. The `memory` rung turns PERF-04 from failed to open.
- **What they cost.** The tier opened F-15 and OPS-14, which PD met by having no store. The `memory` rung opened P-15 (M and S): a majority that stops uncleanly can lose half of a two-phase unit (judge 2's crossing, upheld). It has 10 MUSTs met, against COMP2's 33.

## What would change its verdict

- **Item 15** ([section 8][s8]). Strict, VERDICT's frame: out. Loose: in, behind TiKV-TS.
- **To pass TiKV-TS on the loose reading** it needs F-22 (S), which only `par` gives. PD+fix with Z `par` meets it but prices 0 / 4 / 260, so it still loses on pairs (computed for this report: `repro row Z=par PD+fix`). The full TiKV-TS changes are needed to tie.
- **One stated rule would close its P-15 cells:** a unit that touches a `memory` resource commits at `persisted`, or is refused. The rule is not stated or modelled, so the cells stay open ([B.settled.json][bsettled]).
- **Item 2** (the PERF-01 loss). Loose: TiKV-persisted wins, and PD+fix is 3rd of the 24 rows in (computed for this report: `repro rank --loss`).
- **Kill test 6b** ([section 9][s9]). If the `memory` rung misses about 0.30 ms p99, every row with the rung fails PERF-04, PD+fix included.
- **Novel counts.** The sweep from TiKV-TS: given 2 more novel mechanisms, TiKV-TS loses to PD+fix ([VERDICT 7.4][v74]). The oracle's restore after an unclean loss of the controller's majority (OPS-07) may need a store-held window, which is novel. That would add 1 to the whole family alike (reasoned, [VERDICT 3.3][v33]).
- **Items 14 and 19** move only outcome A. With no shared tier, ISR, PD+fix and TiKV-TS lead level on the loose reading. With the clique reading, DRAFT and SPLIT lead, with PD+fix and TiKV-TS on the loose reading.
- **Item 17** (DEP-21's free bar awake). PD's shape costs $6.72 awake, against $2.19 (note d).
- **Owed:**
  - OPS-07's restore model.
  - A power cut on an LSM (F-01); [E-29] ran only fero's own journal.
  - An LSM woken from the store (SC-05), and the server binary shipped through npm (DEP-20).

## Twins and neighbours

- **PD** (study row, three options away): out on F-22, PERF-04 and SC-05. But it meets P-15 (M and S), F-15 and OPS-14, which PD+fix leaves open ([report][pd]).
- **TiKV-TS** (closure row, six options away: V `full`, TypeScript first, the ported Raft, forwarding, one kernel thread, `par`): 0 / 4 / 244. It beats PD+fix by one SHOULD ([report][tikvts]).
- **TiKV-TS's native twin** is PD+fix with Y `fwd`, M `kw` and Z `par`. It ties TiKV-TS at 0 / 4 / 244 with 122 open and no guessed cell ([VERDICT 4.3][v43]).
- **One option away** (unjudged mixes, `python3 tools/closure.py row '<change>' PD+fix`):
  - Z `par`: 0 / 4 / 260, no guessed cell.
  - Q `maj-d`: 0 / 4 / 236. P-15 (S) comes back, but PERF-04 fails.
  - V `full`: 0 / 3 / 247, with one guessed cell (F-12).
- **The loose ladder's 10-guess row** is PD+fix with process ids, sagas and TiKV-TS's changes (1 / 5 / 248). It is unbeaten at 10 and 11 guessed cells, so it is a guess, not a winner ([VERDICT 4.4][v44]).

## The evidence

- [E-37]: `rejoin` meets F-22's MUST in 2 rules (one damaged replica, 27,985 states, all invariants hold); it never keeps two damaged replicas writable, so F-22 (S) is not met.
- [E-18]: 12 to 22 effective writers as worded; key-level splits balance at most 5 % better than slots.
- [E-38]: 5 of 280 five-node partial partitions stuck with the leader up.
- [E-02] and [E-09b]: the `memory` rung read p99 0.57 ms in TypeScript and 0.33 ms in Rust, against a bar of about 0.303 ms.
- [E-41]: PD's shape costs $18.64 to $19.01 a month at 10 writes a second; the family's tier upload adds $0.16 to $0.53 ([VERDICT 6][v6]).
- [E-29]: LazyFS cut power 2,640 times with 0 of 10,020 acknowledged batches lost, but on fero's journal, not on an LSM.
- [E-17c]: split and merge need 37 rules against 28 for slot moves.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its cells: [cards.json][cards] (row B3), or `python3 tools/closure.py card '' PD+fix`.
- The study row it is built on: [PD's scorecard][pdcard]; SPACE's row: [SPACE 4.1][s41].
- VERDICT: [key of terms][key], [3.2][v32], [3.3][v33], [4.6][v46] (draft 2's rivals, now), [6][v6], [7.4][v74], [8][s8] item 15.

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v32]: ../VERDICT.md#32-all-31-judged-rows-the-matrix
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v43]: ../VERDICT.md#43-step-2-the-search
[v44]: ../VERDICT.md#44-step-3-rows-far-from-any-judged-row-win-only-on-guesses
[v46]: ../VERDICT.md#46-draft-2s-two-unjudged-rivals-now
[v6]: ../VERDICT.md#6-every-other-row
[v74]: ../VERDICT.md#74-the-sweep-over-all-31-rows
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[cards]: ../judging/closure/hybrids/cards.json
[bsettled]: ../judging/closure/hybrids/B.settled.json
[pdcard]: ../judging/rows/PD.md
[pd]: PD.md
[tikvts]: TiKV-TS.md
[s41]: ../SPACE.md#41-the-matrix
[E-02]: ../experiments/E02-pipeline/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-17c]: ../experiments/E17c-partitioning-rerun/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-29]: ../experiments/E29-power-loss-disk-full/README.md
[E-37]: ../experiments/E37-bad-entry/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
