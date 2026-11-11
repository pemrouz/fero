# SIDE: MIN with a native daemon on each host, and the app's Node process folding beside it

**Verdict.** On [VERDICT.md's frame](../VERDICT.md#8-what-the-user-must-confirm) (strict DATA-01, clauses restated, no PERF-01 loss), SIDE is out. It fails one MUST, PERF-04 (NATS JetStream), because its only durable rung is `persisted` (a rung is what a commit means; see the [key of terms][key]). Let back in, it still loses to COMP2 and MIN-P+par by [rule 3][rule]: 4 novel mechanisms against their 3, and 5 SHOULDs against their 6. Its 277 interacting pairs are also the most of MIN's family. So every other row of that family beats it too (MIN, MIN-P, RUST, LEAN and MIN-TS), and so do RLOG and EMB-V8. The loose DATA-01 reading changes nothing for it, since `data` folds in the app's process. If the user accepts JetStream's default test line as a loss, it comes back in, but MIN-P+par (strict) or TiKV-persisted (loose) wins ([matrix]). As worded, it fails 5 MUSTs and shares 9th place of 20 ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** The app hands each write to its own host's daemon, which forwards it to the group's leader. Keys hash into 4,096 fixed slots per resource, as in MIN.
- **How replicas agree.** Raft inside the daemon, on raft-rs, TiKV's Rust port of etcd's Raft.
- **Who heals and moves.** One loop on `#meta`'s leader heals replicas and moves slots. `#meta` is the project's own system group.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the answer.
- **Where rows fold.** The app's Node process folds, with `data`, the groups its host leads, and runs their methods. Every app folds what it follows. Calls go to the leader's host.
- **Two processes per host.** A Rust daemon holds the journal, Raft and fan-out. The app reaches it over a shared-memory ring (A-30).
- **Where it comes from.** SPACE's row SIDE ([SPACE 4.2][s42]). It copies sidecars such as Dapr and Envoy, and TiDB's split over TiKV.

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | Raft; membership changes take effect on commit (A-01, reasoned for raft-rs) |
| G: what one log covers | `shard` | each resource has its own groups; idle groups go dormant (A-15) |
| P: how keys map to groups | `slot` | 4,096 fixed slots per resource; a slot moves between groups one at a time (A-16, A-18) |
| K: where write rules live | `lib` | the kernel is a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `cent-co` | one loop on `#meta`'s leader, with A-20's re-checks |
| V: kinds of replica | `+lrn` | voters, plus learners (full copies that do not vote) |
| Q: what a commit means | `maj-d` | `persisted` only: on disk at a majority before the answer |
| D: exactly once | `sess` | client sessions: per client, the highest sequence and cached answers, in replicated state |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time | `clamp` | the leader's clock, never going back, held to the median of the members' clocks (A-23) |
| X: writes across partitions | `saga` | fenced locks, an intent row and steps; a reader may see half a saga unit |
| S: storage | `jrnl +tier(store)` | one journal per process, plus an object-store tier; the restore mark lives in the store's manifest (A-08) |
| F: where rows fold | `ldr(app folds)` | the app's Node process folds the groups its host leads; every app folds what it follows |
| W: reads | `ridx; any for logs` | rows by read index at the leader; logs and subscriptions from any replica |
| U: where user code runs | `ldr` | a call goes to its partition's leader and runs there |
| H: where fero runs | `side` | a native daemon per host; the app's Node process is a privileged local client |
| L: language | `rs-srv + ts` | a Rust daemon, plus TypeScript in the app |
| I: the Raft core | `raft-rs` | raft-rs, inside the daemon |
| Y: how a write reaches its leader | `fwd` (to the local daemon) | the app hands it to its daemon, which forwards it |
| M: threads | `kwN` (in the daemon) | several kernel threads; each group pinned to one |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `proc` | one process set (one Fly app) per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading moves none of these numbers.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 5: PERF-04, SC-03, SC-10, F-15, F-17 (gap ÷ bar 1.39) | 1: PERF-04 (gap 0.07) |
| MUSTs open | 96 | 99 |
| MUSTs met | 31 | 32 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark in the store's manifest, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 277 | 277 |
| Rank | 9th of 20, level with MIN, RUST, LEAN, LANE, MIN-P and MIN-TS ([A.2][oa2]) | out on PERF-04; with it waived alone, 1st of 20 ([B.4][ob4]) |

**Against the winner.** Rule 3 looks at novel mechanisms first, but only when two rows are 2 or more apart. SIDE (4) and COMP2 (3) are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`). Both rows have 277 pairs.

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. Restating does not save it; user choice item 2 opens it ([section 8][s8]).
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded, the hottest partition takes 5.5 to 9.8 % of a skewed load. So every design reaches only 12 to 22 effective writers, against F_w = 64. Gap 0.66. Restated with the app split, a slot row states 135 at 4,096 slots, so it is open. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). As worded, the writer ceiling of 12 to 22 sits below its floor of 64. Gap 0.66. Restated, it is open: 135 is stated, but no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-15 (Outside services).** Structural. A slot move records its new epoch in the object store before use ([E-33]'s rule, A-08). So a move waits while the store is down. Restated, it is open. Item 11 keeps it failed.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck ([E-38]). Restated, it is open. Item 7 restates it; item 19 (the clique reading) opens it as worded.

## What it does well

- **No cell** is met for SIDE and open or failed for all three leading rows (COMP2, MIN-P+par, TiKV-TS).
- **P-10 and P-15 are met, where COMP2 leaves them open.** It has no `memory` rung (RR-11, RR-12). MIN-P+par meets them too.
- **DATA-09 is met by construction:** the daemon never folds, and `data` folds in the app ([E-03]). MIN leaves it open.
- **Its own reason is met more cheaply elsewhere.** SIDE keeps GC pauses and main-thread stalls away from replication. A kernel on a worker thread (M `kw`) already does that in one process ([E-07]). COMP2 has M `kw`.

## What would change its verdict

- **Item 2 (the PERF-01 loss).** It comes back in. But 14 of the 31 judged rows then beat it on the strict reading, MIN-P+par among them (computed here: `repro rank --strict --loss`).
- **Items 5, 7 and 20.** Each puts every row out, SIDE with them. Item 11 keeps its F-15 failed.
- **Kill criteria for every slot row** ([section 9][s9]). A slot move that breaks beside a membership change (K-01), or a phase-4 writer count under 64, would put SIDE out with COMP2. None of them lifts it.
- **Owed, for its own open cells** ([scorecard][card]):
  - F-02: a model of calls in flight across a leader handover, since calls run at the leader (U `ldr`).
  - F-14: a 5 s stall test with the rules running in the app's process.
  - PERF-10: the ring path for ops built and pinned. A synchronous call to the daemon costs about 33 µs, against 3 and 10 µs bars ([E-03]).
  - DEP-20 and TEST-13: the daemon shipped through npm, and E-46's adapter around raft-rs.

## Twins and neighbours

- **MIN** is its base. SIDE meets DATA-09, which MIN leaves open. MIN meets F-02, F-14, DEP-20 and TEST-13, which SIDE leaves open. MIN has 253 pairs against 277, so MIN beats SIDE by rule 3.
- **CELL** ties SIDE on rule 3's counts (4 novel, 5 SHOULDs, 277 pairs). It is a different design and fails 5 MUSTs restated ([OUTCOME B.1][ob1]).
- **One option changed** (unjudged mixes with no guessed cell; `python3 tools/closure.py row '<change>' SIDE`):
  - M `kw` (one kernel thread): 4 novel, 5 SHOULDs, 271 pairs.
  - G `pslot`: 3 novel, 5 SHOULDs, 277 pairs.
  - Z `par`: 4 novel, 6 SHOULDs, 291 pairs.

## The evidence

- [E-03](../experiments/E03-napi-cost/README.md): the daemon reaches Node at 15 ns a record over a shared-memory ring, 1.5 times napi's 10.3 ns.
- [E-03](../experiments/E03-napi-cost/README.md): over a Unix socket it is 4.3 times napi, and each request and reply costs 33 µs.
- [E-07](../experiments/E07-gc-worker/README.md): a kernel on a worker kept its heartbeat within 5 ms through a 5 s main-thread stall. A main-thread kernel went silent 2.6 to 5.1 s.
- [E-22](../experiments/E22-api-prototype/README.md): no pattern is safe only at the writer, so running calls at the leader buys no safety (AMENDMENTS 3).
- [E-10](../experiments/E10-raft-port/README.md): raft-rs runs 0 of etcd's 28 interaction files.
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape, SIDE included, costs $7.52 to $7.89 a month at 10 writes a second on Fly.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/SIDE.md][card]
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
[ob1]: ../judging/OUTCOME.md#b1-each-row
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/SIDE.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-03]: ../experiments/E03-napi-cost/README.md
[E-07]: ../experiments/E07-gc-worker/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-33]: ../experiments/E33-genesis-restore/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
