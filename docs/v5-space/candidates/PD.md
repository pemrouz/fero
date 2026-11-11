# PD: TiKV's shape as published, with a placement process, timestamps and two-phase commit

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss; terms in VERDICT's [key of terms][key]), PD is out on four MUSTs: F-22, SC-05, PERF-04 and DATA-01. One bad entry on a disk can lose a committed write, and nothing survives lost disks, because it has no object-store tier. Its only durable rung is `persisted`, and its servers keep the rows in their own multi-version store, not in `data`. The loose DATA-01 reading leaves DATA-01 open, so PD is out on the other three. Accepting JetStream's default test line as a loss removes only PERF-04, so it stays out on F-22 and SC-05. As worded it fails 6 MUSTs and places 16th of 20 ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** Each resource is cut into ranges of keys (TiKV calls them regions). Each range is one Raft group. A smart client caches which server leads each range and writes straight there.
- **How replicas agree.** Raft, through raft-rs in a Rust server. A write commits once a majority has it on disk.
- **Who heals and moves.** A separate controller (PD, the "placement driver") places replicas, splits big ranges and merges small ones. A timestamp oracle in it hands out times.
- **What a commit means.** Only `persisted`. A write that spans ranges uses two-phase commit: all prepare, then all commit (Percolator).
- **Where rows fold.** Each server keeps many versions of each row in an LSM (a disk store that writes sorted batches). `data` folds only on clients ([SPACE 4.2][s42]: "`data` is not the engine on servers").
- **Storage faults.** Raft as published: a damaged entry is not detected (Z `crash`).
- **Where it comes from.** SPACE's row PD, "TiKV's shape" ([SPACE 4.2][s42]). It copies TiKV with its placement driver, Percolator's transactions and RocksDB.

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority |
| G: what one log covers | `shard` | each resource is cut into parts; each part is a group |
| P: keys to groups | `split + merge` | a group splits at a key when it grows too big or busy; small neighbours merge |
| K: where write rules live | `kern` | dedup, conditions and ops are commands of the kernel's own state machine |
| C: who heals and moves | `cent` | a separate replicated controller decides placement and moves |
| V: kinds of replica | `+lrn` | voters, plus learners (full copies that do not vote) |
| Q: what a commit means | `maj-d` | `persisted` only: on disk at a majority before the ack |
| D: exactly once | `txn` | transaction ids under two-phase commit |
| O: positions | `hlc` | hybrid-logical-clock timestamps, plus closed timestamps |
| T: time, TTLs, leases | `tso` | a central timestamp oracle |
| X: writes across partitions | `2pc` | transaction records and intents over multi-version state |
| S: storage | `lsm` | an LSM holds the log and the rows on each server's disk; no object-store tier |
| F: where rows fold | `all` | every full replica keeps the rows, in its own multi-version store |
| W: reads | `lease ridx` | leader reads under a time lease, or by Raft's read index |
| U: where user code runs | `cli` | no user code on servers; apps are clients |
| H: where fero runs | `srv` | a separate server binary |
| L: language | `rs-srv` | a Rust server with a TypeScript client |
| I: the Raft core | `raft-rs` | raft-rs, the Rust port of etcd's Raft |
| Y: how a write reaches its leader | `smart` | the client holds the range table and sends to the leader |
| M: threads | `kwN` | several kernel threads; each group pinned to one |
| Z: storage faults | `crash` | disks fail only by crash; no checksum per entry |
| N: tenancy | `proc` | one process set (one Fly app) per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome], which follow the loose reading in force. The strict figures add DATA-01 (computed for this report: `repro tally PD --strict`).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 6: F-17, F-22, PERF-04, SC-03, SC-05, SC-10 (gap ÷ bar 1.39); strict: 7, with DATA-01 | 3: F-22, PERF-04, SC-05 (gap 0.07); strict: 4, with DATA-01 |
| MUSTs open | 114 (strict: 113) | 117 (strict: 116) |
| MUSTs met | 12 | 12 |
| SHOULDs met | 4: P-15, SC-06, SC-12, DEV-04 | the same 4 |
| Novel mechanisms | 0 | 0 |
| Interacting pairs | 218 | 218 |
| Rank | 16th of 20 ([A.2][oa2]); on the strict reading 17th, below CELL (computed for this report: `repro rank --worded --strict --twenty`) | out on 3 MUSTs ([B.1][ob1]); strict: 4 |

Rule 3 ([VERDICT 1][rule]) ranks the rows still in: fewer novel mechanisms wins when 2 or more apart, then more SHOULDs, then fewer pairs. Counts such as 0 / 4 / 244 read novel / SHOULDs / pairs.

**Against the winner.** On the frame PD is out, so rule 3 never compares it with COMP2. Let back in on the loose reading, its 0 novel mechanisms would put it 3 below COMP2's 3. It would then beat even TiKV-TS on pairs, 218 against 244 (computed for this report: `repro tally PD TiKV-TS`). On the strict reading it stays out on DATA-01.

## What fails, and the proof

- **F-22 (One bad entry).** A counterexample, model-checked. TLC found it on etcd's spec, with one fault, in 32 states ([E-37]). One voter cuts one bad entry as a torn tail and votes for a lagging candidate. The new leader then overwrites a committed write. Restating does not save it, and no user choice does. The fix is another option: Z `rejoin` (2 rules) or `par`, as PD+fix and TiKV-TS take.
- **SC-05 (Scale to zero and back).** Structural, confirmed by both PD judges. The rows sit in an LSM on each server's own disk, with no tier. With every server stopped and its disk lost, no copy is left ([scorecard][card]). No reading saves it. With S `lsm +tier` the proof is gone (family B's judges, [B.settled.json][bsettled]).
- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default acks one publisher at p99 0.55 ms ([E-09b]), so a win needs p99 under about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. User choice item 2 ([section 8][s8]) opens it.
- **SC-03 (Scale writes up) and SC-10 (Only stated ceilings).** A ceiling, simulated ([E-18]). As worded, every design reaches only 12 to 22 effective writers under a skewed load, against F_w = 64 (gap 0.66 each). Restated with the app split, both are open: key-level splits have no fixed ceiling, but were not run with the split.
- **F-17 (Partial partitions).** A counterexample, simulated on etcd's Raft. 5 of 280 five-node partial partitions stayed stuck ([E-38]). Restated, it is open. Item 19 (the clique reading) opens it as worded.
- **DATA-01 (data is the state engine), strict reading only.** Structural (RR-10, RR-17). The servers' rows are versions in an LSM, written by kernel commands and two-phase commit. Item 15 ([section 8][s8]) is the only way out: on the loose reading the cell stays open until DATA-09's differential test runs. The middle reading still fails it ([VERDICT 3.3][v33]).

## What it does well

- **Three cells are met here and not met by COMP2, MIN-P+par or TiKV-TS** (computed for this report: `repro diff PD COMP2 MIN-P+par TiKV-TS`):
  - **P-15 (S) Transactions across partitions.** A reader at one timestamp sees all of a unit or none of it (Percolator's snapshot reads, cited). COMP2 and MIN-P+par do not meet it: a reader can see half a saga. TiKV-TS leaves it open, because its `memory` rung can lose half a unit.
  - **F-15 (M) Outside services.** Met by construction: no object store sits on any path. The three leaders leave it open, and COMP2 and MIN-P+par fail it as worded.
  - **OPS-14 (M) A shared tier keeps projects apart.** Met by construction: nothing holds more than one project.
- **Against COMP2 alone,** P-15 (M) and SC-06 (S) State size are met here too.
- **0 novel mechanisms and 218 pairs,** the fewest pairs of any row on R `raft` ([outcome.json]).
- **Its weak side.** 12 MUSTs met, against 33 for COMP2 and 36 for MIN-P+par. 28 cells are met for COMP2 and not here (computed for this report: `repro diff COMP2 PD`). Nine of them are patterns (P-03 to P-19) that no experiment ran on this shape.

## What would change its verdict

- **Nothing in [section 8][s8] lets it back in.** F-22 and SC-05 fail under every reading. Item 2 removes PERF-04 only. Item 15's loose reading leaves DATA-01 open only.
- **Its fixes are other rows.** PD+fix adds `rejoin`, a tier and the `memory` rung. TiKV-TS also takes `par`, TypeScript first and forwarding.
- **Item 17** (DEP-21's free bar judged awake). PD's shape costs $6.72 a month awake, against $2.19 ([section 8, note d][s8]). If a judge ruled that structural, the separate-server shapes would go out.
- **Item 18** (DEP-21's price). $18.64 to $19.01 a month at 10 writes a second on Fly, 3.4 to 3.6 times the cheapest. With PD inside the stores and one app machine, $9.58 to $10.11. RR-06 kept DEP-21 open ([VERDICT 6][v6]).
- **Item 14** (no shared tier) leaves PD alone: its OPS-14 is met by construction.
- **Owed for its family:**
  - a restore model for the timestamp oracle after an unclean loss of the controller's majority (OPS-07; family B's lead in [B.settled.json][bsettled]). A store-held window would be novel, giving the family 1 novel mechanism (reasoned, [VERDICT 3.3][v33]).
  - the critic's third lead: price DEP-21 for TiKV's shape with stateless proxies inside its store machines ([VERDICT 4.7][v47]).
  - its own scorecard's closers: E-21's checks on a timestamp oracle, E-22's pattern checks on a prototype of this shape, and a WASM build of its kernel timed for TEST-01 ([scorecard][card]).

## Twins and neighbours

- **PD+fix** (a closure row, judged blind): PD with Z `rejoin`, S `lsm +tier` and Q `mix`, three options away. F-22 is met, and SC-05 and PERF-04 are open. But F-15, OPS-14 and P-15 (M and S) fall to open. It is in on the loose reading at 0 / 3 / 247 ([report][pdfix]).
- **One option away** (unjudged mixes with no guessed cell, `python3 tools/closure.py row '<change>' PD`):
  - Z `rejoin`: 0 / 4 / 226. F-22 is met; still out on PERF-04 and SC-05.
  - Z `par`: 0 / 5 / 237. It also meets F-22 (S); still out on PERF-04 and SC-05.
  - S `lsm +tier`: 0 / 4 / 227. SC-05 opens; still out on PERF-04 and F-22.
  - Q `mix` alone breaks a constraint: the `memory` rung needs `rejoin` or `par` (Q-mix-Z, [constraints.json][cons]).
- **TiKV-TS and TiKV-persisted** are PD's shape repaired, 8 options away each ([TiKV-TS][tikvts], [TiKV-persisted][tikvp]).

## The evidence

- [E-37]: Raft as published loses a committed write with one bad entry (32 states); `rejoin` fixes it in 2 rules, `par` in 7.
- [E-38]: 5 of 280 five-node partial partitions stuck with the leader up.
- [E-18]: 12 to 22 effective writers as worded; key-level splits balance at most 5 % better to 64 groups than slots.
- [E-17c]: split and merge need 37 rules, against 28 for slot moves, on the same footing.
- [E-41]: $18.64 to $19.01 a month at 10 writes a second; $6.72 for a free project awake all month; $0.23 asleep.
- [E-09b] and [E-01]: JetStream's default p99 is 0.55 ms; a `persisted` commit here is at least 0.323 ms.
- [E-11]: raft-rs with quiet groups costs 0.04 % of a core and 3.9 KB per idle group.
- [E-16]: a controller needs 4 more healing rules than leader healing (18 against 14); PD's `cent` carries them (reasoned).
- [VERDICT 7.6][v76]: of PD's 218 pairs, 122 (56.0 %) sit in a model or an argument, and 75 are open.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/PD.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [key of terms][key] ("TiKV's shape"), [3.3][v33] (why the brief leans strict), [6][v6] (its one-line standing), [7.6][v76] (pairs), [8][s8] items 2, 15 and 17

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v47]: ../VERDICT.md#47-the-options-no-judged-row-holds
[v6]: ../VERDICT.md#6-every-other-row
[v76]: ../VERDICT.md#76-dev-02-and-the-models
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob1]: ../judging/OUTCOME.md#b1-each-row
[card]: ../judging/rows/PD.md
[bsettled]: ../judging/closure/hybrids/B.settled.json
[cons]: ../judging/closure/constraints.json
[pdfix]: PD+fix.md
[tikvts]: TiKV-TS.md
[tikvp]: TiKV-persisted.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-11]: ../experiments/E11-many-groups/README.md
[E-16]: ../experiments/E16-controller-loop/README.md
[E-17c]: ../experiments/E17c-partitioning-rerun/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-37]: ../experiments/E37-bad-entry/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
