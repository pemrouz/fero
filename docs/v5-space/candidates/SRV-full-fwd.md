# SRV V=full Y=fwd: SRV with every replica a voter, and writes forwarded by any server

**Verdict.** On [VERDICT.md's frame](../VERDICT.md#8-what-the-user-must-confirm) (strict DATA-01, clauses restated, no PERF-01 loss), this row is out on two MUSTs, as SRV is. It fails PERF-04 (NATS JetStream), because its only durable rung is `persisted` (a rung is what a commit means; see the [key of terms][key]). On the strict reading it also fails DATA-01, because its servers fold the rows in Rust or Go. With SRV's 148 cells and 8 fewer pairs, it still loses to COMP2 and MIN-P+par by [rule 3][rule] on SHOULDs, 5 against 6. The loose reading leaves DATA-01 open, so it is out on PERF-04 alone. If the user accepts JetStream's default test line as a loss, it stays out on the strict reading, and on the loose one TiKV-persisted wins ([matrix]). As worded, it fails 4 MUSTs, and with the loss on the loose reading it is level first ([matrix]).

## In short

- **Where writes go.** Any server takes a write and forwards it to the group's leader. Clients hold no slot table. Keys hash into 4,096 fixed slots per resource.
- **How replicas agree.** Raft, with every replica a voter. A new replica is a learner only while the healer catches it up. Rust on raft-rs, or Go on etcd's own Raft.
- **Who heals and moves.** One loop on `#meta`'s leader heals replicas and moves slots. `#meta` is the project's own system group.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the answer.
- **Where rows fold.** Each server folds plain rows in Rust or Go. `data` and its views run only on clients and relays.
- **User code.** None runs on the servers; apps are clients.
- **Where it comes from.** A closure row: the closure pass built it from SPACE's row SRV by changing two axes, V and Y. Two blind judges in family A scored it as A8 ([VERDICT 4.5][v45]).

## Its line

From [cards.json][cards]. Only V and Y differ from SRV.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | Raft; membership changes take effect on commit (A-01, reasoned in the Rust variant) |
| G: what one log covers | `shard` | each resource has its own groups; idle groups go dormant (A-15) |
| P: how keys map to groups | `slot` | 4,096 fixed slots per resource; a slot moves between groups one at a time (A-16, A-18) |
| K: where write rules live | `lib(srv)` | a fenced log with five operations; dedup, conditions and ops are a library inside the server |
| C: who heals and moves | `cent-co` | one loop on `#meta`'s leader, with A-20's re-checks |
| V: kinds of replica | `full` | every replica votes; learners only while a heal catches a new copy up |
| Q: what a commit means | `maj-d` | `persisted` only: on disk at a majority before the answer |
| D: exactly once | `sess` | client sessions: per client, the highest sequence and cached answers, in replicated state |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time | `clamp` | the leader's clock, never going back, held to the median of the members' clocks (A-23) |
| X: writes across partitions | `saga` | fenced locks, an intent row and steps; a reader may see half a saga unit |
| S: storage | `jrnl +tier` | one journal per process, plus an object-store tier; founded by `fero init`, so the restore mark's home is left open (G-21) |
| F: where rows fold | `all(srv)` | every server folds plain rows natively; `data`'s views run on clients and relays |
| W: reads | `any ridx` | from any ready replica at a position, or by read index |
| U: where user code runs | `cli` | no user code on servers; apps are clients |
| H: where fero runs | `srv` | a separate server binary |
| L: language | `rs-srv or go-srv` | a Rust or a Go server: two variants of one row |
| I: the Raft core | `raft-rs or etcd raft` | raft-rs in Rust; etcd's own Raft in Go |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it to the leader |
| M: threads | `kwN` | several kernel threads; each group pinned to one |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `proc` | one process set (one Fly app) per project |

## Its score

From [cards.json][cards], tallied with `tools/closure.py`, and [matrix.md][matrix]. `python3 tools/closure.py card 'V=full,Y=fwd' SRV` prints the full card: 49 mechanisms, 4 novel, 259 pairs.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: PERF-04, SC-03, SC-10, F-17 (gap ÷ bar 1.39); strict: 5, with DATA-01 | 1: PERF-04 (gap 0.07); strict: 2, with DATA-01 |
| MUSTs open | 100 (strict: 99) | 102 (strict: 101) |
| MUSTs met | 28 | 29 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 259 | 259 |
| Rank ([matrix.md][matrix]) | named on one line only: with the loss accepted and the loose reading, level first by rule 2 with 10 other rows | named on no line: out on PERF-04 (and on DATA-01, strict) |

Among all 31 judged rows as worded, with no loss and the loose reading, it shares 11th place. SRV, SLOG, RLOG, EMB-V8 and TiKV-persisted share it too (computed here: `repro rank --worded`; [VERDICT 2][v2] gives its 4 MUSTs and 1.39).

**Against the winner.** Rule 3 looks at novel mechanisms first, but only when two rows are 2 or more apart. This row (4) and COMP2 (3) are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts; family A's referee recorded it under RR-15 ([A.settled.json][asettled]). JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). A win needs about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network ([E-01]). Gap 0.07. User choice item 2 opens it ([section 8][s8]).
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded, the hottest partition takes 5.5 to 9.8 % of a skewed load. So every design reaches only 12 to 22 effective writers, against F_w = 64. Gap 0.66. Restated with the app split, a slot row states 135 at 4,096 slots, so it is open. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). As worded, the writer ceiling of 12 to 22 sits below its floor of 64. Gap 0.66. Restated, it is open: 135 is stated, but no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck ([E-38]). Restated, it is open. Item 7 restates it; item 19 (the clique reading) opens it as worded.
- **DATA-01 (data is the state engine), strict reading only.** Structural: F `all(srv)` is one of the two cases RR-10 named and RR-17 wrote out. It carries no design rule, since its own tags fold natively ([VERDICT 3.3][v33]). Item 15 saves it: the loose reading leaves it open, and the middle reading passes it.

## What it does well

- **No cell** is met for it and open or failed for all three leading rows (COMP2, MIN-P+par, TiKV-TS).
- **SRV's cells for 8 fewer pairs.** Forwarding by any server replaces the smart client's routing mechanism ([A.settled.json][asettled]). So it beats SRV by rule 3 on identical cells.
- **F-15 (Outside services) is open as worded, not failed.** It founds by `fero init`, and A-08 leaves its mark's home open ([VERDICT 2][v2]). COMP2's family fails F-15 as worded. Both still fail 4 MUSTs as worded, since this row fails PERF-04 instead.
- **P-10, P-15 and F-02 are met, where COMP2 leaves them open.** It has no `memory` rung (RR-11 to RR-13). MIN-P+par meets them too.

## What would change its verdict

- **Item 15 (the DATA-01 reading).** Strict: it fails DATA-01. Loose: DATA-01 is open. Middle: it passes ([VERDICT 3.3][v33]).
- **Item 2 (the PERF-01 loss).** Strict: still out on DATA-01. Loose: back in, but TiKV-persisted wins on the novel count, 0 against 4. Middle: MIN-P+par beats it on SHOULDs, 6 against 5.
- **Item 17 (DEP-21's free bar judged awake).** It has SRV's shape, $4.53 a month awake against $2.19 (reasoned in [VERDICT 6][v6]). If a judge ruled that structural, the separate-server shapes would go out ([section 8, note d][s8]).
- **Items 5, 7 and 20.** Each puts every row out, this one with them.
- **What family A left open.** Its two judges scored the one cell no judged row supported, F-12, as open. Judge 1 also scored SC-05 as open. A referee later set PERF-04's gap under RR-15. No crossing was upheld ([A.settled.json][asettled]).
- **Owed:** SRV's list. That is DATA-09's differential test on E-43's stream, the whole server timed as WASM, the npm binary, and E-46's adapter around the chosen core ([SRV's scorecard][srvcard]).

## Twins and neighbours

- **SRV**, its base, has the same 148 cells and 267 pairs. This row beats it on pairs ([SRV's report][srv]).
- **SRV with Y `fwd` only** (V `+lrn` kept; unjudged, no guessed cell) ties this row on every count: 4 novel, 5 SHOULDs, 259 pairs. Learners stay either way, so V `full` changes no count (`python3 tools/closure.py row 'Y=fwd' SRV`).
- **With Z `par` added** (unjudged, no guessed cell): 4 novel, 6 SHOULDs, 273 pairs.
- **EMB-V8 with Y `fwd`** shows the same saving on V8's server: 261 pairs against EMB-V8's 269.

## The evidence

- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms and 3,280 acks a second.
- [E-20](../experiments/E20-dedup/README.md): client sessions hold exactly once in 13 rules, 14 when writes are forwarded (A-21's `forward.once`).
- [E-16](../experiments/E16-controller-loop/README.md): the controller adds a replacement as a learner and promotes it, which is why learners stay under V `full`.
- [E-02](../experiments/E02-pipeline/README.md): on this disk every build hits the same ceiling. With the disk out of the way, Rust and Go have about a 3 times tighter p99 than TypeScript.
- [E-11](../experiments/E11-many-groups/README.md): idle groups cost 3.9 KB (Rust) and 8.0 KB (Go) of memory each.
- [E-41](../experiments/E41-hosted-cost/README.md): SRV's shape costs $11.97 to $12.34 a month at 10 writes a second on Fly, 2.2 to 2.3 times the cheapest.
- [E-43](../experiments/E43-fold-versions/README.md): a 1,000,000-record stream with digests is ready for DATA-09's test.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Its card: [cards.json][cards] (row "SRV V=full Y=fwd"); its ruling: [A.settled.json][asettled] (row A8)
- SPACE's row (SRV's): [SPACE 4.1][s41] and [4.2][s42]
- VERDICT: [section 6][v6] (its one-line standing: "as SRV"), [3.3][v33] (the DATA-01 readings), [4.5][v45] (family A), [3.2][v32] (the matrix)

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v32]: ../VERDICT.md#32-all-31-judged-rows-the-matrix
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v45]: ../VERDICT.md#45-step-4-the-frontier-rows-judged-blind
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[matrix]: ../judging/closure/results/matrix.md
[cards]: ../judging/closure/hybrids/cards.json
[asettled]: ../judging/closure/hybrids/A.settled.json
[srv]: SRV.md
[srvcard]: ../judging/rows/SRV.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[E-01]: ../experiments/E01-floors/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
