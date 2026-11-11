# TiKV-TS: TiKV's shape built in TypeScript first, the winner on the loose DATA-01 reading

**Verdict.** Rule 3 names TiKV-TS on the cells as they stand, which follow the loose DATA-01 reading (terms as in VERDICT's [key of terms][key]). On VERDICT's frame (strict DATA-01, clauses restated, no PERF-01 loss) it is out on DATA-01: its servers keep the rows in a multi-version LSM, not in `data` (RR-17, RR-18). VERDICT leans strict on BRIEF item 6, "`data` stays the state engine" ([VERDICT 3.3][v33]). It also notes that TiKV-TS leaves 23 more MUSTs open than COMP2 (122 against 99), which rule 3 never counts. On the loose reading it wins at rule 3's first step, with 0 novel mechanisms against COMP2's 3 ([matrix]). With JetStream's default test line accepted as a loss, TiKV-persisted beats it on the loose reading, 5 SHOULDs against 4. As worded it fails F-17, SC-03 and SC-10, and on the loose reading shares first place with DRAFT, SPLIT, ISR and PD+fix.

## In short

- **Where writes go.** Each resource is cut into ranges of keys, each one Raft group. Any server takes a write and forwards it to the range's leader.
- **How replicas agree.** Raft, from etcd's Raft ported to TypeScript ([E-10]). Every replica votes; learners exist only while a heal catches a new copy up.
- **Who heals and moves.** A separate controller (PD, the "placement driver") places replicas, splits big ranges and merges small ones. A timestamp oracle in it hands out times.
- **What a commit means.** `persisted` by default; `memory` or `none` per resource. Writes across ranges use two-phase commit (all prepare, then all commit).
- **Where rows fold.** Each server keeps many versions of each row in an LSM. RR-18 places that store in TypeScript first and Rust later. `data` folds only on clients.
- **Damaged entries.** A checksum per entry finds damage, and the entry is copied back from a peer (`par`).
- **Where it comes from.** The closure pass built it as PD+fix in TypeScript first, with `par`, forwarding and every replica a voter. It judged it blind as family B's row B1 ([cards.json][cards]). It copies TiKV, etcd's Raft and PAR (FAST'18).

## Its line

It differs from PD+fix on six axes, in bold.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | one leader per group; a write commits at a majority |
| G: what one log covers | `shard` | each resource is cut into parts; each part is a group |
| P: keys to groups | `split+merge` | a group splits at a key when it grows too big or busy; small neighbours merge |
| K: where write rules live | `kern` | dedup, conditions and ops are commands of the kernel's own state machine |
| C: who heals and moves | `cent` | a separate replicated controller decides placement and moves |
| V: kinds of replica | **`full`** | **every replica votes; learners only as a heal's catch-up stage** |
| Q: what a commit means | `mix` | `persisted` by default; `memory` or `none` per resource |
| D: exactly once | `txn` | transaction ids under two-phase commit |
| O: positions | `hlc` | hybrid-logical-clock timestamps, plus closed timestamps |
| T: time, TTLs, leases | `tso` | a central timestamp oracle |
| X: writes across partitions | `2pc` | transaction records and intents over multi-version state |
| S: storage | `lsm +tier` | an LSM on each server's disk, plus an object-store tier |
| F: where rows fold | `all` | every full replica keeps the rows, in its own multi-version store |
| W: reads | `lease ridx` | leader reads under a time lease, or by Raft's read index |
| U: where user code runs | `cli` | no user code on servers; apps are clients |
| H: where fero runs | `srv` | a separate server, a Node server in the TypeScript phase |
| L: language | **`ts→rs`** | **TypeScript first; a Rust core later** |
| I: the Raft core | **`port`** | **etcd's Raft ported to TypeScript; raft-rs later** |
| Y: how a write reaches its leader | **`fwd`** | **any server takes it and forwards it** |
| M: threads | **`kw`** | **the kernel on one worker thread** |
| Z: storage faults | **`par`** | **a damaged entry is repaired from a peer whose commit covers it** |
| N: tenancy | `proc` | one process set (one Fly app) per project |

## Its score

From [cards.json][cards] and [matrix.md][matrix], tallied with `tools/closure.py`. The strict figures add DATA-01.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 3: F-17, SC-03, SC-10 (gap ÷ bar 1.32); strict: 4, with DATA-01 | none; strict: 1, DATA-01 |
| MUSTs open | 119 (strict: 118) | 122 (strict: 121) |
| MUSTs met | 10 | 10 |
| SHOULDs met | 4: SC-06, SC-12, F-22, DEV-04 | the same 4 |
| Novel mechanisms | 0 | 0 |
| Interacting pairs | 244 | 244 |
| Rank | every row out; loose: level first by rule 2 with DRAFT, SPLIT, ISR and PD+fix ([matrix]); strict: level 4th of 31 with six other rows (computed for this report: `repro rank --worded --strict`) | loose: first on matrix.md's line "restated, no loss, loose"; strict: out on DATA-01 |

Rule 3 ([VERDICT 1][rule]) ranks the rows still in: fewer novel mechanisms wins when 2 or more apart, then more SHOULDs, then fewer pairs. Counts such as 0 / 4 / 244 read novel / SHOULDs / pairs.

**Against the winner.** On the strict reading it is out, so rule 3 never compares it with COMP2. On the loose reading it beats COMP2: 0 novel against 3, so the novel count decides. "SHOULDs first" or "open MUSTs first" would pick COMP2 (6 SHOULDs against 4, 99 open against 122). But three of TiKV-TS's SHOULDs are open because nobody judged them ([section 8, note a][s8]).

## What fails, and the proof

- **DATA-01 (data is the state engine), strict reading only.** Structural (RR-17, RR-18). In the TypeScript phase the servers keep the rows as versions in an LSM written by kernel commands; after the native step, in Rust. Neither is `data`'s lane. The middle reading fails it too. Only item 15's loose reading ([section 8][s8]) saves it: the cell is then open until DATA-09's differential test runs.
- **SC-03 (Scale writes up) and SC-10 (Only stated ceilings), as worded.** A ceiling, simulated ([E-18]). Every design reaches only 12 to 22 effective writers under a skewed load, against F_w = 64 (gap 0.66 each). Restated with the app split, both are open. Item 5 (F_w above 135) leaves them open, since split rows state no fixed ceiling.
- **F-17 (Partial partitions), as worded.** A counterexample, simulated on etcd's Raft: 5 of 280 five-node partial partitions stuck ([E-38]). Restated, it is open. Item 19's clique reading opens it as worded.

## What it does well

- **Against COMP2 and MIN-P+par** (computed for this report: `repro differ TiKV-TS COMP2 --worded`, and the same with MIN-P+par):
  - **SC-06 (S) State size** is met: an LSM holds state larger than memory by construction. Both leaders leave it open.
  - **P-15 (S) Transactions across partitions** is open, where both do not meet it: their readers can see half a saga.
  - **F-15 (Outside services)** is open as worded, where both fail it: writes, elections and new replicas use the local LSM.
- **Rule 3's own counts.** 0 novel mechanisms and 244 pairs, against COMP2's 3 and 277. On aim 4's two counts it beats COMP2 ([VERDICT 3.3][v33]).
- **F-22 (M and S) met by `par`,** as for COMP2: no stuck state with one bad entry on each of two replicas ([E-37]).
- **Its weak side,** the grounds rule 3 never counts ([VERDICT 3.3][v33]):
  - 10 MUSTs met against COMP2's 33. 26 cells are met for COMP2 and open here: 23 MUSTs and 3 SHOULDs (computed for this report: `repro diff COMP2 TiKV-TS`).
  - No build size for two-phase commit, an oracle and a multi-version store ([E-44] gives none).
  - U `cli` runs no user code on servers, so fero's methods would become declarative rules or WASM.
  - Cost: PD's shape is $18.64 to $19.01 a month at 10 writes a second, against $7.52 to $7.89 for COMP2's ([E-41]).
  - DATA-03: a `data` record must ride inside a two-phase-commit prewrite, a format nobody designed.

## What would change its verdict

- **Item 15** ([section 8][s8]). Loose: it wins. Strict, middle or word for word: out.
- **Item 2** (the PERF-01 loss). Loose: TiKV-persisted wins, and TiKV-TS is 2nd of the 24 rows in (computed for this report: `repro rank --loss`).
- **Items 3 and 16** (SHOULDs first, or open MUSTs first). Both pick COMP2. Note a: if two of its open SHOULDs (P-22, DEV-05, OPS-11) came out met, the SHOULDs would tie and the novel count would pick TiKV-TS again.
- **Items 5 and 11** (F_w above 135; F-15 kept as worded). On the loose reading TiKV-TS still wins.
- **The ladder** ([VERDICT 4.4][v44]). It is unbeaten only when no guessed cell is allowed. From one guessed cell, rule 3 goes round in a circle:
  - its twin with client sessions and sagas (1 / 5 / 253) beats it;
  - the same with a dedup window (2 / 5 / 252) beats that twin;
  - TiKV-TS beats the window row.
  - Section 9 step 1 owes a judging pass on those two rows, and the user must say how a circle is broken.
- **Kill test 6b** ([section 9][s9]). If the `memory` rung misses about 0.30 ms p99, the rung's rows fail PERF-04, and with the loss the loose arithmetic picks TiKV-persisted.
- **The phase-4 writer count.** If the real mover gives a slot row fewer than 64 effective writers per resource, the slot rows fail SC-03 and SC-10. The split rows are left: SPLIT, and TiKV's shape on the loose reading.
- **Novel counts.** A store-held window for the oracle after an unclean loss of the controller's majority (OPS-07) would be novel. TiKV's shape would then have 1, still 2 below COMP2 (reasoned). The critic's Y `proxy` lead could save 3 pairs (241) on this shape only ([VERDICT 4.7][v47]).
- **Owed in its first build:** DATA-09's differential test on its store (RR-18's design rule); OPS-07's restore model; and a rerun on its multi-version state (TEST-07).
- **The files differ on its store.** RR-18 and VERDICT 3.2 say the TypeScript phase writes its LSM in TypeScript. The judged DEP-20, TEST-10 and SC-05 cells treat it as a native LSM behind a binding, and DEP-20's says "The study names no LSM written in TypeScript" ([B.settled.json][bsettled]). Every such cell is open either way, so no count moves. The build must name the store.

## Twins and neighbours

- **Its native twin:** PD+fix with Y `fwd`, M `kw` and Z `par`, a Rust server. It ties TiKV-TS on every count (0 / 4 / 244, 122 open, no guessed cell). The search does not reach it: it is 3 changes from both ([VERDICT 4.3][v43]).
- **In TypeScript for good** (L `ts`): 0 / 4 / 244 with 121 open, resting on two guessed cells, PERF-08 and DEP-20 (computed for this report: `repro row L=ts TiKV-TS`).
- **PD+fix** (judged, six options away): 0 / 3 / 247. Without `par` it loses F-22 (S), so TiKV-TS beats it ([report][pdfix]).
- **Without the `memory` rung** (Q `maj-d`): 0 / 5 / 233 (computed for this report: `repro row Q=maj-d TiKV-TS`). P-15 (M and S) come back, but PERF-04 fails. It is TiKV-persisted's TypeScript-first twin ([report][tikvp]).
- **With `rejoin` in place of `par`:** 0 / 3 / 232 (computed for this report: `repro row Z=rejoin TiKV-TS`).
- **The circle's rows** (D `sess` or `win`, with X `saga`) each guess one cell, DATA-03. Ten rows with that one guess beat TiKV-TS, among them SPLIT2 with TiKV's kernel and LSM (1 / 5 / 261).

## The evidence

- [E-37]: `par` keeps every judged state writable with one bad entry on each of two replicas (565,222 states, 276 two-damage states, 0 stuck), at 7 rules.
- [E-10]: the TypeScript port of etcd's Raft passes 41 of 41 datadriven files and 4,000 of 4,000 random scripts byte for byte.
- [E-46]: the port was linearizable in all 26 Maelstrom runs under partitions and pauses.
- [E-02] and [E-09b]: the `memory` rung read p99 0.57 ms in TypeScript and 0.33 ms in Rust; a win over JetStream's default needs about 0.303 ms.
- [E-27]: one Node server holds 10,000 idle links in 89 MB, so its TypeScript phase meets SC-12 (S).
- [E-41]: $18.64 to $19.01 a month at 10 writes a second; $9.58 to $10.11 with the placement process inside the stores.
- [E-43]: a 1,000,000-record stream with digests is ready for DATA-09's test.
- [E-18]: 12 to 22 effective writers as worded.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its cells: [cards.json][cards] (row B1), or `python3 tools/closure.py card 'V=full,L=ts→rs,I=port,Y=fwd,M=kw,Z=par' PD+fix`. Its judges' notes and RR-18's design rule: [B.settled.json][bsettled].
- The study row it is built on: [PD's scorecard][pdcard]; SPACE's row: [SPACE 4.1][s41].
- VERDICT: [section 0][v0] items 5 and 6, [3.2][v32], [3.3][v33], [4.4][v44], [6][v6], [7.4][v74], [8][s8] items 2, 3, 15 and 16, [9][s9] step 1.

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v0]: ../VERDICT.md#0-the-answer
[v32]: ../VERDICT.md#32-all-31-judged-rows-the-matrix
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v43]: ../VERDICT.md#43-step-2-the-search
[v44]: ../VERDICT.md#44-step-3-rows-far-from-any-judged-row-win-only-on-guesses
[v47]: ../VERDICT.md#47-the-options-no-judged-row-holds
[v6]: ../VERDICT.md#6-every-other-row
[v74]: ../VERDICT.md#74-the-sweep-over-all-31-rows
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[cards]: ../judging/closure/hybrids/cards.json
[bsettled]: ../judging/closure/hybrids/B.settled.json
[pdcard]: ../judging/rows/PD.md
[pdfix]: PD+fix.md
[tikvp]: TiKV-persisted.md
[s41]: ../SPACE.md#41-the-matrix
[E-02]: ../experiments/E02-pipeline/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-10]: ../experiments/E10-raft-port/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-27]: ../experiments/E27-idle-links/README.md
[E-37]: ../experiments/E37-bad-entry/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
[E-43]: ../experiments/E43-fold-versions/README.md
[E-44]: ../experiments/E44-outside-log/README.md
[E-46]: ../experiments/E46-maelstrom-raft/README.md
