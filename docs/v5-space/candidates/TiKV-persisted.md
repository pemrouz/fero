# TiKV-persisted: TiKV's shape as a Rust or Go server, with only the `persisted` rung

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss; terms in VERDICT's [key of terms][key]), TiKV-persisted is out on two MUSTs. Its only durable rung is `persisted`, which cannot beat JetStream's default test line by PERF-01's spread rule (PERF-04, gap 0.07). Its Rust or Go servers keep the rows in a multi-version LSM, not in `data`, so it fails DATA-01 by structure (RR-17). On the loose reading it is out on PERF-04 alone. With JetStream's default test line accepted as a loss, it wins on the loose reading; on the strict one it stays out and MIN-P+par wins ([matrix]). As worded it fails 4 MUSTs and places level 11th of 31 on the loose reading, and level first once the loss is accepted.

## In short

- **Where writes go.** Each resource is cut into ranges of keys, each one Raft group. Any server takes a write and forwards it to the range's leader.
- **How replicas agree.** Raft. The row has two variants: Rust on raft-rs, or Go on etcd's own Raft. Every replica votes; learners exist only while a heal catches a new copy up.
- **Who heals and moves.** A separate controller (PD, the "placement driver") places replicas, splits big ranges and merges small ones. A timestamp oracle in it hands out times.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the ack. Writes across ranges use two-phase commit.
- **Where rows fold.** Each server keeps many versions of each row in an LSM, in Rust or Go. `data` folds only on clients.
- **Damaged entries.** A checksum per entry finds damage, and the entry is copied back from a peer (`par`).
- **Where it comes from.** The closure pass built it as TiKV-TS without the `memory` rung, as a Rust or Go server. It judged it blind as family B's row B2 ([cards.json][cards]). It copies TiKV, PAR (FAST'18) and, in its Go variant, etcd's Raft run natively.

## Its line

It differs from TiKV-TS on four axes, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority |
| G: what one log covers | `shard` | each resource is cut into parts; each part is a group |
| P: keys to groups | `split+merge` | a group splits at a key when it grows too big or busy; small neighbours merge |
| K: where write rules live | `kern` | dedup, conditions and ops are commands of the kernel's own state machine |
| C: who heals and moves | `cent` | a separate replicated controller decides placement and moves |
| V: kinds of replica | `full` | every replica votes; learners only as a heal's catch-up stage |
| Q: what a commit means | **`maj-d`** | **`persisted` only: on disk at a majority before the ack** |
| D: exactly once | `txn` | transaction ids under two-phase commit |
| O: positions | `hlc` | hybrid-logical-clock timestamps, plus closed timestamps |
| T: time, TTLs, leases | `tso` | a central timestamp oracle |
| X: writes across partitions | `2pc` | transaction records and intents over multi-version state |
| S: storage | `lsm +tier` | an LSM on each server's disk, plus an object-store tier |
| F: where rows fold | **`all(srv)`** | **every server keeps the rows natively, in its own multi-version store** |
| W: reads | `lease ridx` | leader reads under a time lease, or by Raft's read index |
| U: where user code runs | `cli` | no user code on servers; apps are clients |
| H: where fero runs | `srv` | a separate server binary |
| L: language | **`rs-srv or go-srv`** | **a Rust or a Go server: two variants of one row** |
| I: the Raft core | **`raft-rs or etcd raft`** | **raft-rs in Rust; etcd's own Raft in Go** |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on one worker thread |
| Z: storage faults | `par` | a damaged entry is repaired from a peer whose commit covers it |
| N: tenancy | `proc` | one process set (one Fly app) per project |

## Its score

From [cards.json][cards] and [matrix.md][matrix], tallied with `tools/closure.py`. The strict figures add DATA-01.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: F-17, PERF-04, SC-03, SC-10 (gap ÷ bar 1.39); strict: 5, with DATA-01 | 1: PERF-04 (gap 0.07); strict: 2, with DATA-01 |
| MUSTs open | 117 (strict: 116) | 120 (strict: 119); 121 with the loss accepted |
| MUSTs met | 11 | 11 |
| SHOULDs met | 5: P-15, SC-06, SC-12, F-22, DEV-04 | the same 5 |
| Novel mechanisms | 0 | 0 |
| Interacting pairs | 233 | 233 |
| Rank | loose: level 11th of 31 with SRV, SLOG, RLOG, EMB-V8 and SRV V=full Y=fwd (computed for this report: `repro rank --worded`); with the loss accepted, level first by rule 2 ([matrix]) | out on PERF-04; with the loss accepted, first on matrix.md's line "restated, loss accepted, loose"; strict: out on DATA-01 too |

Rule 3 ([VERDICT 1][rule]) ranks the rows still in: fewer novel mechanisms wins when 2 or more apart, then more SHOULDs, then fewer pairs. Counts such as 0 / 4 / 244 read novel / SHOULDs / pairs.

**Against the winner.** On the frame it is out, so rule 3 never compares it with COMP2. With the loss accepted on the loose reading, it beats every other row in. It has 0 novel mechanisms against COMP2's 3, and 5 SHOULDs against TiKV-TS's 4 ([VERDICT 3.2][v32]).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default acks one publisher at p99 0.55 ms ([E-09b]), so a win needs p99 under about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. A native server does not help: the disks set this floor. User choice item 2 ([section 8][s8]) opens it.
- **DATA-01 (data is the state engine), strict reading only.** Structural (RR-17). Its servers fold in Rust or Go (F `all(srv)`), into an LSM written by kernel commands (K `kern`). Both of RR-10's cases apply; it carries PD's reason, since PD's rule is tried first. The middle reading fails it too. Only item 15's loose reading saves it: the cell is then open until DATA-09's differential test runs ([VERDICT 3.3][v33]).
- **SC-03 (Scale writes up) and SC-10 (Only stated ceilings), as worded.** A ceiling, simulated ([E-18]): 12 to 22 effective writers against F_w = 64 (gap 0.66 each). Restated with the app split, both are open.
- **F-17 (Partial partitions), as worded.** A counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38]). Restated, it is open. Item 19's clique reading opens it as worded.

## What it does well

- **P-15 (S) Transactions across partitions is met here and by none of COMP2, MIN-P+par or TiKV-TS** (computed for this report: `repro diff TiKV-persisted COMP2 MIN-P+par TiKV-TS`). With no `memory` rung, Percolator's snapshot reads hold: a reader sees all of a unit or none of it (family B's referee, [B.settled.json][bsettled]).
- **Against COMP2,** P-15 (M) and SC-06 (S) State size are met too. COMP2's P-15 (M) is open because its `memory` rung can lose a saga's step (RR-11).
- **Against TiKV-TS,** P-15 (M and S) are met. That is its one extra SHOULD.
- **0 novel mechanisms and 233 pairs,** the fewest pairs of the 24 rows that are in with the loss accepted on the loose reading (computed for this report: `repro rank --loss`).
- **Native strengths, in cells still open.** A Go server runs etcd's Raft with no port. Idle groups cost 3.9 KB (Rust) or 8.0 KB (Go) each ([E-11]).
- **Its weak side.** 11 MUSTs met and 120 open. 26 cells are met for COMP2 and not here (computed for this report: `repro diff COMP2 TiKV-persisted`). It shares TiKV-TS's other costs: no user code on servers, PD's price, and a `data` record inside a two-phase-commit prewrite ([VERDICT 3.3][v33]).

## What would change its verdict

- **Item 2 with item 15's loose reading** ([section 8][s8]). It wins.
- **Item 2 on the strict reading.** MIN-P+par wins. TiKV-persisted stays out on DATA-01.
- **Kill test 6b** ([section 9][s9]). If the `memory` rung misses about 0.30 ms p99 or about 4,340 acks a second, only a loss accepted by name keeps a row in. The arithmetic then picks this row on the loose reading.
- **Items 3 and 16, with the loss, on the loose reading.** SHOULDs first picks MIN-P+par (6 against 5; computed for this report: `repro rank --loss --shoulds-first`). Open MUSTs first picks MIN-TS among the judged rows (95 against 121; [matrix]).
- **The loss ladder never circles** ([VERDICT 4.4][v44]). With the loss on the loose reading, this row and its TypeScript-first twin lead at 0 to 10 guessed cells. From 11, rows that rest on 11 or more guesses lead.
- **The oracle's restore** after an unclean loss of the controller's majority (OPS-07). A store-held window would be novel and give the family 1, still 2 below COMP2 (reasoned).
- **Item 17** (DEP-21's free bar awake). PD's shape costs $6.72 awake, against $2.19 (note d).
- **Owed:**
  - `par`'s vote and repair rules written inside raft-rs or Go's etcd Raft ([B.settled.json][bsettled]).
  - DATA-09's differential test of its native store against `data`, on [E-43]'s stream.
  - OPS-07's restore model, the server binary shipped through npm (DEP-20), and a WASM build of its kernel timed for TEST-01.

## Twins and neighbours

- **Its TypeScript-first twin** is TiKV-TS without the `memory` rung (PD with V `full`, the tier, TypeScript first, the ported Raft, forwarding, one kernel thread and `par`). It ties at 0 / 5 / 233 with no guessed cell. The two lead the loose loss ladder together ([ladder][ladder-loss]).
- **With the `memory` rung** (Q `mix`): 0 / 4 / 244, with one guessed cell (PERF-08). It ties TiKV-TS on every count (computed for this report: `repro row Q=mix TiKV-persisted`).
- **TiKV-TS** (judged, four options away): 0 / 4 / 244. It has no PERF-04 failure, but loses P-15 (M and S) ([report][tikvts]).
- **PD+fix with Q `maj-d`:** 0 / 4 / 236, without `par`, so F-22 (S) is not met (computed for this report: `repro row Q=maj-d PD+fix`).
- **PD** (study row, eight options away): out on F-22, PERF-04 and SC-05 ([report][pd]).

## The evidence

- [E-09b]: JetStream's default acks one publisher at p99 0.55 ms, 3,280 a second; with sync always, 1,228 a second at p99 1.31 ms.
- [E-01]: RR-15 puts the best `persisted` commit here at 0.323 ms p99, above the 0.303 ms bar.
- [E-37]: `par` keeps every judged state writable with one bad entry on each of two replicas (276 two-damage states, 0 stuck).
- [E-02]: with the disk out of the way, Rust and Go have a p99 about 3 times tighter than TypeScript (0.67 to 0.75 ms against 2.4 ms).
- [E-11]: idle groups cost 0.04 % (Rust) and 0.10 % (Go) of a core per 2,000 groups.
- [E-41]: PD's shape costs $18.64 to $19.01 a month at 10 writes a second; $9.58 to $10.11 with the placement process inside the stores.
- [E-43]: a 1,000,000-record stream with digests is ready for DATA-09's test.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its cells: [cards.json][cards] (row B2), or `python3 tools/closure.py card 'V=full,S=lsm +tier,F=all(srv),L=rs-srv or go-srv,I=raft-rs or etcd raft,Y=fwd,M=kw,Z=par' PD`.
- The study row it is built on: [PD's scorecard][pdcard]; SPACE's row: [SPACE 4.1][s41].
- VERDICT: [3.2][v32] (the matrix), [3.3][v33], [4.4][v44], [6][v6], [8][s8] items 2 and 15, [9][s9] (the kill table, step 6b).

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v32]: ../VERDICT.md#32-all-31-judged-rows-the-matrix
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v44]: ../VERDICT.md#44-step-3-rows-far-from-any-judged-row-win-only-on-guesses
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[ladder-loss]: ../judging/closure/results/ladder-restated-PERF-01_losses.md
[cards]: ../judging/closure/hybrids/cards.json
[bsettled]: ../judging/closure/hybrids/B.settled.json
[pdcard]: ../judging/rows/PD.md
[pd]: PD.md
[tikvts]: TiKV-TS.md
[s41]: ../SPACE.md#41-the-matrix
[E-01]: ../experiments/E01-floors/README.md
[E-02]: ../experiments/E02-pipeline/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-11]: ../experiments/E11-many-groups/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-37]: ../experiments/E37-bad-entry/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
[E-43]: ../experiments/E43-fold-versions/README.md
