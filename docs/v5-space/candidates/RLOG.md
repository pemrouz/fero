# RLOG: Raft on log members, with servers that write by holding a committed writer epoch

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no loss accepted; see the [key of terms][key]), RLOG is out on one MUST, PERF-04 (NATS JetStream). Its only durable rung, `persisted` (on disk at a majority), cannot beat JetStream's default single-publisher test line by PERF-01's spread rule. Even let back in, it loses to COMP2 by [rule 3][rule]. Its 4 novel mechanisms are only 1 above COMP2's 3, so SHOULDs decide, and COMP2 meets 6 against 5. The loose DATA-01 reading moves none of its cells, so it stays out. With the loss accepted it is back in, but MIN-P+par (strict) or TiKV-persisted (loose) wins ([matrix]). As worded it fails 4 MUSTs and shares 5th place of 20; with the loss accepted too, it is level first.

## In short

- **Where writes go.** Any server takes a write and forwards it to the group's writer. The writer is the server that holds the latest committed writer epoch.
- **How replicas agree.** Raft groups run on log members. Every append carries the writer epoch, and the log group's leader checks it. On one box the server is its own log member, so it is plain Raft.
- **Who heals and moves.** One loop on `#meta`'s leader heals, moves slots, and hands the writer role over (A-14's 9 rules). `#meta` is the project's own system group.
- **What a commit means.** `persisted` only: a majority of log members has the write on disk.
- **Exactly once.** Client sessions: per client, the highest sequence and cached answers, in replicated state.
- **Where rows fold.** Servers are full learners (copies that do not vote) and fold the rows with `data`. Log members keep the log only.
- **Where it comes from.** SPACE's RLOG row ([SPACE 4.2][s42]). It copies Kafka's producer epochs, BookKeeper's ledger fencing, Neon's terms on safekeepers and Delos's NativeLoglet ([SPACE 2][s2]).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `rlog` | Raft on log members; a server writes by committing a writer-epoch entry, checked on every append |
| G: what one log covers | `shard` | each resource has its own groups; idle groups go dormant (A-15) |
| P: how keys map to groups | `slot` | 4,096 fixed slots; a slot moves one at a time with a margin (A-16, A-18) |
| K: where write rules live | `lib` | a fenced log with five operations; dedup, conditions and ops are a library at the writer |
| C: who heals and moves | `cent-co` | one loop on `#meta`'s leader, with A-20's re-checks and A-14's writer handover |
| V: kinds of replica | `tier +lrn` | log members vote; servers are full learners that fold |
| Q: what a commit means | `maj-d` | `persisted` only: on disk at a majority of log members |
| D: exactly once | `sess` | client sessions, in replicated state |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time | `clamp` | the writer's clock, never going back, held to the members' median (A-23) |
| X: writes across partitions | `saga` | fenced locks, an intent row and steps; a reader may see half a saga unit |
| S: storage | `jrnl +tier` | one journal per process plus an object-store tier; founded by `fero init`, so the restore mark's home is open (A-08) |
| F: where rows fold | `all(servers)` | every server folds with `data` |
| W: reads | `any ridx` | from any ready replica at a position, or by read index |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `both` | one code base for servers and log members |
| L: language | `ts→rs` | TypeScript first, a Rust core later |
| I: the Raft core | `port` | etcd's Raft ported to TypeScript ([E-10]) |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `tier` | only the log tier is shared between projects; servers stay per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading changes no RLOG cell (computed here: `repro tally RLOG` and `repro tally RLOG --strict` print the same).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: F-17, PERF-04, SC-03, SC-10 (gap ÷ bar 1.39) | 1: PERF-04 (gap 0.07) |
| MUSTs open | 94 | 96 |
| MUSTs met | 34 | 35 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 268 | 268 |
| Rank | 5th of 20, level with SRV, SLOG and EMB-V8 ([A.2][oa2]) | out on PERF-04; with it waived alone, 1st of 20 ([B.4][ob4]) |

**Against the winner.** RLOG (4) and COMP2 (3) are 1 apart on novel mechanisms, so SHOULDs decide: COMP2 meets 6 against 5.

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network ([E-01]; RR-15). Gap 0.07. Restating does not save it. Section 8 item 2 does: accept JetStream's default test line as a loss ([section 8][s8]).
- **SC-03 (Scale writes up).** A measured ceiling, simulated ([E-18]). As worded every design gets 12 to 22 effective writers against F_w = 64. Gap 0.66. Restated, a slot row states 135 at 4,096 slots, so it is open. Item 5 fails it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]), gap 0.66. Restated it is open: no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's Raft stayed stuck ([E-38]). Restated it is open. Item 7 restates it; item 19, the clique reading, opens it as worded.

## What it does well

- **No cell** is met for RLOG and not met for all three leading rows (COMP2, MIN-P+par and TiKV-TS; computed here: `repro diff RLOG COMP2 MIN-P+par TiKV-TS`).
- **One SHOULD is open for it and not met by all three:** DEP-15 (two copies survive a crash). Its writer handover is model-checked with two servers and crashes ([E-16]). It would be met with a log tier per project; with a shared tier the tier's budget (A-29) is not built ([scorecard][card]).
- **Against COMP2 alone,** it meets P-10, P-15 and F-02 (M), which COMP2 leaves open for its `memory` rung (RR-11 to RR-13). MIN-P+par meets them too.
- **As worded, its F-15 is open, not failed.** It founds by `fero init`, so its restore mark has no home in the store yet ([VERDICT 2][v2]). So as worded it fails 4 MUSTs, one fewer than MIN, which shares its other cells.
- **Disposable servers with one published protocol** ([SPACE 4.2][s42]). R `rlog` adds one mechanism and 9 rules over Raft ([AMENDMENTS 3][am3]).
- **Price.** It costs $0.04 asleep and $5.23 to $5.60 a month at 10 writes a second on Fly, against $7.52 to $7.89 for COMP2's shape ([E-41]).

## What would change its verdict

- **Item 2 (the PERF-01 loss).** It comes back in. On the strict reading MIN-P+par beats it: 3 novel against 4, then 6 SHOULDs against 5. On the loose reading TiKV-persisted wins, with 0 novel. As worded, RLOG is then level first on both lines ([matrix]).
- **Kill step 6b** ([section 9][s9]). If the `memory` rung loses JetStream's default test line, only a loss accepted by name keeps a row in. The arithmetic then picks MIN-P+par or TiKV-persisted, not RLOG.
- **Kill criteria for every slot row** hit RLOG as they hit COMP2:
  - a counterexample where a slot move meets a membership change (K-01);
  - slot-move mutants caught below 85 % (step 2d);
  - a move's unwritable window over 10 ms (step 7);
  - fewer than 64 effective writers in the phase-4 sim.
- **Item 14 (no tier shared between projects)** fails its OPS-14, since its log tier is shared (computed here: `repro tally RLOG --worded --choice 'shared tier'`).
- **Owed for its own cells** ([scorecard][card], [AMENDMENTS 3][am3]):
  - E-38's sweeps re-run with CheckQuorum every E/4, for F-17 restated;
  - the port's handover and failover timed, for F-05;
  - a byte budget per tenant on its shared tier (A-29), for DEP-15 and OPS-14.

## Twins and neighbours

All from `python3 tools/closure.py row '<change>' RLOG`, restated.
- **RLOG H=srv** ties it on every count (4 novel, 5 SHOULDs, 268 pairs), with no guessed cell. RLOG F=all ties it on 3 guessed cells.
- **RLOG G=pslot** (groups owned by the project) has 3 novel, 5 SHOULDs and 267 pairs, on 2 guessed cells (SC-06 S, SC-15). It is still out on PERF-04. With the loss accepted, MIN-P+par would beat it on SHOULDs, 6 against 5.
- **RLOG Z=par** has 4 novel, 6 SHOULDs and 282 pairs, on 2 guessed cells (F-22 M and S). With the loss accepted, MIN-P+par beats it: 1 apart, SHOULDs level, 264 pairs against 282.
- **MIN** is RLOG on one box, six options away ([SPACE 4.2][s42]). Restated, their cells differ only on DEP-15 S: open here, not met for MIN. MIN has 253 pairs against 268, so MIN beats RLOG when both are in. As worded MIN also fails F-15 ([MIN](MIN.md)).
- **SLOG** is the other log-first row: 5 novel, 2 SHOULDs, 117 open MUSTs ([SLOG](SLOG.md)).

## The evidence

- [E-16][]: RLOG's writer handover needs 9 rules, all needed (A-14), model-checked with two servers, crashes and `#meta` down.
- [E-09b][]: JetStream's default acks one publisher at p99 0.55 ms (3,280 a second).
- [E-01][]: the commit bar C is 0.73 ms on this box; the best `persisted` commit's p99 is 0.323 ms with no network (RR-15).
- [E-38][]: 5 of 280 five-node partial partitions stuck with the leader up, on etcd's Raft.
- [E-18][]: as worded, 12 to 22 effective writers for every design; restated, 135 at 4,096 slots.
- [E-44][]: a log-first row is about 13,500 lines, about 82 times BUY's, against about 49 times for a Raft row (an estimate).
- [E-41][]: $5.23 to $5.60 a month at 10 writes a second on Fly; $0.04 asleep.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/RLOG.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS 3][am3]
- VERDICT: [section 2][v2] (outcome A, and its open F-15), [3.1][v31] (the PERF-04 rows), [section 6][v6] (its one-line standing), [section 8][s8] items 2, 7, 14 and 19

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v31]: ../VERDICT.md#31-the-20-study-rows
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/RLOG.md
[s2]: ../SPACE.md#2-the-axes
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-10]: ../experiments/E10-raft-port/README.md
[E-16]: ../experiments/E16-controller-loop/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
[E-44]: ../experiments/E44-outside-log/README.md
