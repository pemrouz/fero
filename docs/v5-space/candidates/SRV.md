# SRV: MIN as a Rust or Go server binary, with apps as clients

**Verdict.** On [VERDICT.md's frame](../VERDICT.md#8-what-the-user-must-confirm) (strict DATA-01, clauses restated, no PERF-01 loss), SRV is out on two MUSTs. It fails PERF-04 (NATS JetStream), because its only durable rung is `persisted` (a rung is what a commit means; see the [key of terms][key]). On the strict reading it also fails DATA-01 by structure: its servers fold the rows in Rust or Go, not with `data` (RR-10, RR-17). Even let back in on both, it loses to COMP2 and MIN-P+par by [rule 3][rule]: 4 novel mechanisms against 3, and 5 SHOULDs against 6. The loose reading leaves DATA-01 open, so SRV is out on PERF-04 alone. If the user accepts JetStream's default test line as a loss, it stays out on the strict reading, and on the loose one TiKV-persisted wins ([matrix]). As worded, it fails 4 MUSTs and shares 5th place of 20 ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** Smart clients cache which server leads each slot and send writes straight there. Browser clients use forwarding (A-21). Keys hash into 4,096 fixed slots per resource.
- **How replicas agree.** Raft. The row has two variants: Rust on raft-rs, or Go on etcd's own Raft, run natively with no port.
- **Who heals and moves.** One loop on `#meta`'s leader heals replicas and moves slots. `#meta` is the project's own system group.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the answer.
- **Where rows fold.** Each server folds plain rows in Rust or Go. `data` and its views run only on clients and relays.
- **User code.** None runs on the servers. Apps are clients, so methods and rules would have to become declarative or WASM ([SPACE 2, U][s2]).
- **Where it comes from.** SPACE's row SRV, "MIN as a Rust or Go server binary with a TS client, like Redis or NATS" ([SPACE 4.2][s42]).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | Raft; membership changes take effect on commit (A-01, reasoned in the Rust variant) |
| G: what one log covers | `shard` | each resource has its own groups; idle groups go dormant (A-15) |
| P: how keys map to groups | `slot` | 4,096 fixed slots per resource; a slot moves between groups one at a time (A-16, A-18) |
| K: where write rules live | `lib(srv)` | a fenced log with five operations; dedup, conditions and ops are a library inside the server |
| C: who heals and moves | `cent-co` | one loop on `#meta`'s leader, with A-20's re-checks |
| V: kinds of replica | `+lrn` | voters, plus learners (full copies that do not vote) |
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
| Y: how a write reaches its leader | `smart` | the client holds the slot table and sends to the leader |
| M: threads | `kwN` | several kernel threads; each group pinned to one |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `proc` | one process set (one Fly app) per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome], which follow the loose reading in force. The strict figures add DATA-01 (computed here: `repro tally SRV --strict`).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: PERF-04, SC-03, SC-10, F-17 (gap ÷ bar 1.39); strict: 5, with DATA-01 | 1: PERF-04 (gap 0.07); strict: 2, with DATA-01 |
| MUSTs open | 100 (strict: 99) | 102 (strict: 101) |
| MUSTs met | 28 | 29 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 267 | 267 |
| Rank | 5th of 20, level with SLOG, RLOG and EMB-V8 ([A.2][oa2]) | out on PERF-04; with it waived alone, 1st of 20 ([B.4][ob4]) |

**Against the winner.** Rule 3 looks at novel mechanisms first, but only when two rows are 2 or more apart. SRV (4) and COMP2 (3) are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. A native server does not help: the disks set this floor. User choice item 2 opens it ([section 8][s8]).
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded, the hottest partition takes 5.5 to 9.8 % of a skewed load. So every design reaches only 12 to 22 effective writers, against F_w = 64. Gap 0.66. Restated with the app split, a slot row states 135 at 4,096 slots, so it is open. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). As worded, the writer ceiling of 12 to 22 sits below its floor of 64. Gap 0.66. Restated, it is open: 135 is stated, but no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck ([E-38]). Restated, it is open. Item 7 restates it; item 19 (the clique reading) opens it as worded.
- **DATA-01 (data is the state engine), strict reading only.** Structural (RR-10, RR-17): the row's own tags put the rows of record in Rust or Go. Restating does not save it. Item 15 does: the loose reading leaves it open until DATA-09's differential test, and the middle reading passes it ([VERDICT 3.3][v33]).

## What it does well

- **No cell** is met for SRV and open or failed for all three leading rows (COMP2, MIN-P+par, TiKV-TS).
- **F-15 (Outside services) is open as worded, not failed.** It founds by `fero init`, and A-08 leaves its mark's home open ([VERDICT 2][v2]). COMP2's family fails F-15 as worded. Both still fail 4 MUSTs as worded, since SRV fails PERF-04 instead.
- **P-10, P-15 and F-02 are met, where COMP2 leaves them open.** It has no `memory` rung (RR-11 to RR-13). MIN-P+par meets them too.
- **Native strengths, in cells still open.** A tighter commit tail ([E-02]), and 3.9 KB (Rust) or 8.0 KB (Go) of memory per idle group ([E-11]). The Go variant runs etcd's Raft with no port.
- **Its weak side.** 102 open MUSTs, the most of MIN's family. Against MIN-P+par it also leaves open P-04, DATA-09, DEP-20, TEST-01, TEST-02, TEST-07 and TEST-13 (computed here: `repro diff MIN-P+par SRV`).

## What would change its verdict

- **Item 15 (the DATA-01 reading).** Strict: it fails DATA-01. Loose: DATA-01 is open. Middle (`data`'s lane or a tested port of it): it passes.
- **Item 2 (the PERF-01 loss).** Strict: still out on DATA-01. Loose: back in, but TiKV-persisted wins on the novel count, 0 against 4. Middle: MIN-P+par beats it on SHOULDs, with 3 novel and 6 SHOULDs against 4 and 5 ([VERDICT 3.3][v33]).
- **Item 17 (DEP-21's free bar judged awake).** SRV's shape costs $4.53 a month awake, against $2.19. If a judge ruled that structural, the separate-server shapes would go out ([section 8, note d][s8]).
- **Items 5, 7 and 20.** Each puts every row out, SRV with them.
- **Step 8** ([section 9][s9]). If a timing shows L2 must go native, COMP2 drops its design rule and fails the strict reading as SRV does. So SRV's fold is where COMP2 would land in that case.
- **Owed, for its own open cells** ([scorecard][card]):
  - DATA-09: the differential test of the native fold against `data` on E-43's stream of 1e6 records.
  - TEST-01 and TEST-07: the whole server, fold included, timed as WASM in one process, with undo reruns.
  - DEP-20 and TEST-13: the binary shipped through npm, and a choice of variant run under E-46's adapter.

## Twins and neighbours

- **SRV V=full Y=fwd** (a closure row, judged blind): every replica a voter, and writes forwarded by any server. Its 148 cells equal SRV's, and it has 259 pairs against 267, so it beats SRV by rule 3 ([A.settled.json][asettled]; [report][fwd]).
- **SRV with V `full` only** (unjudged, no guessed cell) ties SRV on every count. Learners stay as the healer's catch-up stage (`python3 tools/closure.py row 'V=full' SRV`).
- **SRV with Z `par`** (unjudged, no guessed cell): 4 novel, 6 SHOULDs, 281 pairs.
- **EMB-V8** is SRV with V8 embedded. EMB-V8 meets P-04, DATA-09, TEST-01, TEST-02 and TEST-07, which SRV leaves open. SRV meets F-14 and DEP-18, which EMB-V8 leaves open.

## The evidence

- [E-02](../experiments/E02-pipeline/README.md): on this disk every build hits the same ceiling. With the disk out of the way, Rust and Go have about a 3 times tighter p99 than TypeScript.
- [E-02](../experiments/E02-pipeline/README.md): `kwN` did not raise throughput here (0.8 to 1.03 times).
- [E-03](../experiments/E03-napi-cost/README.md): a native kernel can hand records to `data` in JavaScript at under 1 ns a record. So a native fold is a choice, not a need.
- [E-11](../experiments/E11-many-groups/README.md): idle groups cost 3.9 KB (Rust) and 8.0 KB (Go) of memory each.
- [E-41](../experiments/E41-hosted-cost/README.md): $11.97 to $12.34 a month at 10 writes a second on Fly, 2.2 to 2.3 times the cheapest; $9.58 to $10.11 with one app machine.
- [E-43](../experiments/E43-fold-versions/README.md): a 1,000,000-record stream with digests is ready for DATA-09's test.
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/SRV.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [section 6][v6] (its one-line standing), [3.3][v33] (the DATA-01 readings), [section 8][s8] items 15 and 17

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[asettled]: ../judging/closure/hybrids/A.settled.json
[fwd]: SRV-full-fwd.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/SRV.md
[s2]: ../SPACE.md#u-where-user-code-runs
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-02]: ../experiments/E02-pipeline/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-11]: ../experiments/E11-many-groups/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
