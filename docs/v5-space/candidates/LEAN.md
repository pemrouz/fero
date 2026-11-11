# LEAN: MIN where only the leader, and one warm standby, fold the rows

**Verdict.** On [VERDICT.md's frame](../VERDICT.md#8-what-the-user-must-confirm) (strict DATA-01, clauses restated, no PERF-01 loss), LEAN is out. It fails one MUST, PERF-04 (NATS JetStream), because its only durable rung is `persisted` (a rung is what a commit means; see the [key of terms][key]). Let back in, it still loses to COMP2 and MIN-P+par by [rule 3][rule]: 4 novel mechanisms against their 3, and 5 SHOULDs against their 6. It even loses to MIN: the two rows have the same 148 cells, and LEAN has 2 more interacting pairs. The loose DATA-01 reading changes nothing for it. If the user accepts JetStream's default test line as a loss, it comes back in, but MIN-P+par (strict) or TiKV-persisted (loose) wins ([matrix]). As worded, it fails 5 MUSTs and shares 9th place of 20 ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** As in MIN, each resource's keys hash into 4,096 fixed slots. Each resource has its own Raft groups, which own sets of slots. Any server forwards a write to the group's leader.
- **How replicas agree.** Raft, on etcd's Raft ported to TypeScript ([E-10]).
- **Who heals and moves.** One loop on `#meta`'s leader heals replicas and moves slots. `#meta` is the project's own system group.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the answer.
- **Where rows fold.** Only the leader folds the rows with `data`, plus one warm standby that folds too (required by A-26). The other followers keep only the log.
- **Reads.** Reads of rows go to the leader by read index. Log reads and subscriptions may use any replica.
- **Where it comes from.** SPACE's row LEAN, "MIN where only leaders fold" ([SPACE 4.2][s42]). It copies Kafka's split: brokers keep logs, and Kafka Streams folds.

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them. Only V, F and W differ from MIN.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | Raft; membership changes take effect on commit (A-01) |
| G: what one log covers | `shard` | each resource has its own groups; idle groups go dormant (A-15) |
| P: how keys map to groups | `slot` | 4,096 fixed slots per resource; a slot moves between groups one at a time (A-16, A-18) |
| K: where write rules live | `lib` | the kernel is a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `cent-co` | one loop on `#meta`'s leader, with A-20's re-checks |
| V: kinds of replica | `+lrn(standby)` | voters and learners, plus one warm standby that folds |
| Q: what a commit means | `maj-d` | `persisted` only: on disk at a majority before the answer |
| D: exactly once | `sess` | client sessions: per client, the highest sequence and cached answers, in replicated state |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time | `clamp` | the leader's clock, never going back, held to the median of the members' clocks (A-23) |
| X: writes across partitions | `saga` | fenced locks, an intent row and steps; a reader may see half a saga unit |
| S: storage | `jrnl +tier(store)` | one journal per process, plus an object-store tier; the restore mark lives in the store's manifest (A-08) |
| F: where rows fold | `ldr` | only the leader (and its standby) folds; followers keep the log |
| W: reads | `ridx; any for logs` | rows by read index at the leader; logs and subscriptions from any replica |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `emb` | inside the app's own Node process |
| L: language | `ts→rs` | TypeScript first; a Rust core later, checked byte for byte |
| I: the Raft core | `port` | etcd's Raft ported to TypeScript |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on one worker thread |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `proc` | one process (one Fly app) per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading moves none of these numbers.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 5: PERF-04, SC-03, SC-10, F-15, F-17 (gap ÷ bar 1.39) | 1: PERF-04 (gap 0.07) |
| MUSTs open | 93 | 96 |
| MUSTs met | 34 | 35 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark in the store's manifest, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 255 | 255 |
| Rank | 9th of 20, level with MIN, RUST, LANE, MIN-P, MIN-TS and SIDE ([A.2][oa2]) | out on PERF-04; with it waived alone, 1st of 20 ([B.4][ob4]) |

**Against the winner.** Rule 3 looks at novel mechanisms first, but only when two rows are 2 or more apart. LEAN (4) and COMP2 (3) are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. Restating does not save it; user choice item 2 opens it ([section 8][s8]).
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded, the hottest partition takes 5.5 to 9.8 % of a skewed load. So every design reaches only 12 to 22 effective writers, against F_w = 64. Gap 0.66. Restated with the app split, a slot row states 135 at 4,096 slots, so it is open. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). As worded, the writer ceiling of 12 to 22 sits below its floor of 64. Gap 0.66. Restated, it is open: 135 is stated, but no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-15 (Outside services).** Structural. A slot move records its new epoch in the object store before use ([E-33]'s rule, A-08). So a move waits while the store is down. Restated, it is open. Item 11 keeps it failed.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck ([E-38]). Restated, it is open. Item 7 restates it; item 19 (the clique reading) opens it as worded.

## What it does well

- **No cell** is met for LEAN and open or failed for all three leading rows (COMP2, MIN-P+par, TiKV-TS). It has exactly MIN's cells (computed here: `repro differ LEAN MIN`).
- **P-10, P-15 and F-02 are met, where COMP2 leaves them open.** It has no `memory` rung (RR-11 to RR-13). MIN-P+par meets them too.
- **Its idea is to fold once per group, not on every replica.** The evidence makes that saving small. Every replica can afford to fold: 315 to 338 B of heap a small row, and 0.22 to 1.90 µs a record ([E-05]). F `ldr` saves money only above about 2 GB of rows per copy ([E-41]).
- **The standby takes back part of the saving.** Without it, a cold rebuild passes F-05's 2.5 s above about 560,000 small rows ([E-05]). So A-26 makes the folding standby required, and two copies fold, not one.

## What would change its verdict

- **Item 2 (the PERF-01 loss).** It comes back in. But MIN, RUST, MIN-TS and MIN-P then beat it on pairs, and the winners beat it on SHOULDs or the novel count (computed here: `repro rank --strict --loss`).
- **Items 5, 7 and 20.** Each puts every row out, LEAN with them. Item 11 keeps its F-15 failed.
- **Kill criteria for every slot row** ([section 9][s9]). A slot move that breaks beside a membership change (K-01), or a phase-4 writer count under 64, would put LEAN out with COMP2. None of them lifts it.
- **G-29.** No faster wake form was built or timed. AMENDMENTS names "F `all` against `ldr`" among what this gap could flip ([AMENDMENTS 5][am5]). So a timed wake could move LEAN's own choice of who folds.
- **Owed:** F-05 timed with the warm standby, and DATA-09 decided at the native step: does the native step keep `data` folding, or hold rows natively? ([scorecard][card]).

## Twins and neighbours

- **MIN** is its base. It has the same 148 cells and 253 pairs against LEAN's 255, so MIN beats LEAN by rule 3. The only mechanism difference is who folds (`fold-all` against `fold-leader`).
- **LEAN in TypeScript for good** (L `ts`; unjudged, no guessed cell): 4 novel, 5 SHOULDs, 255 pairs, 94 open MUSTs (`python3 tools/closure.py row 'L=ts' LEAN`).
- **LEAN with G `pslot`** (unjudged, no guessed cell): 3 novel, 5 SHOULDs, 254 pairs. **LEAN with Z `par`**: 4 novel, 6 SHOULDs, 268 pairs.

## The evidence

- [E-05](../experiments/E05-fold-cost/README.md): a cold rebuild replays 1e6 small rows in 4.5 s, so F-05's 2.5 s is passed above about 560,000 rows.
- [E-05](../experiments/E05-fold-cost/README.md): a small row costs 315 to 338 B of heap; `data`'s lane folds 0.22 to 1.90 µs a record.
- [E-41](../experiments/E41-hosted-cost/README.md): F `ldr` saves money only above about 2 GB of rows per copy. MIN's shape costs $7.52 to $7.89 a month at 10 writes a second.
- [E-07](../experiments/E07-gc-worker/README.md): a kernel on a worker kept its heartbeat within 5 ms through a 5 s main-thread stall.
- [E-13](../experiments/E13-handover/README.md): a failover takes the election timer plus about 5 ms (2.03 to 3.36 s at E = 2 s).
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms.
- [E-18](../experiments/E18-slot-balance/README.md): 135 effective writers at 4,096 slots with the app split; 12 to 22 as worded.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/LEAN.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [section 6][v6] (its one-line standing: "as MIN")

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/LEAN.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[am5]: ../AMENDMENTS.md#5-what-the-evidence-left-open
[E-01]: ../experiments/E01-floors/README.md
[E-05]: ../experiments/E05-fold-cost/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-10]: ../experiments/E10-raft-port/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-33]: ../experiments/E33-genesis-restore/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
