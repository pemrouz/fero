# SLOG: the earlier log-first draft, where a shared log tier holds the data and servers only fold

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no loss accepted; see the [key of terms][key]), SLOG is out on one MUST, PERF-04 (NATS JetStream). Its only durable rung, `persisted` (on disk at a majority), cannot beat JetStream's default single-publisher test line by PERF-01's spread rule. Even let back in, it loses to COMP2 at the first step of [rule 3][rule]: 5 novel mechanisms against 3. The loose DATA-01 reading moves none of its cells, so it stays out. With the loss accepted it is back in, but MIN-P+par (strict) or TiKV-persisted (loose) wins ([matrix]). As worded it fails 4 MUSTs and shares 5th place of 20; with the loss accepted too, it is level first.

## In short

- **Where writes go.** Any server takes a write and forwards it to the slot's writer. Keys hash into 4,096 fixed slots per resource (A-16).
- **How replicas agree.** A shared log: the writer appends to small logs ("loglets") on log nodes. A write commits at a write quorum of log nodes. A seal plus a compare-and-swap on the metadata reconfigures it.
- **Who heals and moves.** The writer changes its own log nodes. A controller changes writers and moves slots. Raft runs only in that metadata group.
- **What a commit means.** `persisted` only: a write quorum of log nodes has it on disk.
- **Exactly once.** The draft's dedup window, a novel mechanism.
- **Where rows fold.** Every server folds the rows with `data`. Servers are disposable; the log tier holds all durability.
- **Where it comes from.** SPACE's SLOG row, "the earlier log-first draft, with slots in place of splits" ([SPACE 4.2][s42]). It copies shared logs such as Corfu, Tango, Delos, LogDevice, BookKeeper and Pulsar, Neon and Aurora ([SPACE 2][s2]).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `slog` | a shared log: loglets on log nodes; seal and metadata compare-and-swap to reconfigure |
| G: what one log covers | `shard` | each resource has its own slot sets; idle groups go dormant (A-15, reasoned) |
| P: how keys map to groups | `slot` | 4,096 fixed slots; a slot moves one at a time with a margin (A-16, A-18) |
| K: where write rules live | `lib` | a fenced log with five operations; dedup, conditions and ops are a library at the writer |
| C: who heals and moves | `cent(writers)` | the writer changes its log nodes; a controller changes writers (A-20, reasoned) |
| V: kinds of replica | `tier +lrn` | a separate log tier holds durability; servers are disposable; plus learners |
| Q: what a commit means | `maj-d(log nodes)` | `persisted` only, at a write quorum of log nodes |
| D: exactly once | `win` | the dedup window: issuer window, floor, outcomes by id, time budgets per hop |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time | `clamp` | the leader's clock, never going back, held to the members' median (A-23) |
| X: writes across partitions | `saga` | fenced locks, an intent row and steps; a reader may see half a saga unit |
| S: storage | `tier + obj` | the log tier, plus an object store that holds the restore mark (A-08) |
| F: where rows fold | `all` | every server folds with `data` |
| W: reads | `any` | from any ready replica, at a position |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `both` | one code base for servers and log nodes |
| L: language | `ts→rs` | TypeScript first, a Rust core later |
| I: the Raft core | `port(meta)` | etcd's Raft, ported, for the metadata group only |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged node is wiped and rejoins as new |
| N: tenancy | `tier` | only the log tier is shared between projects |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading changes no SLOG cell (computed here: `repro tally SLOG` and `repro tally SLOG --strict` print the same).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: F-15, PERF-04, SC-03, SC-10 (gap ÷ bar 1.39) | 1: PERF-04 (gap 0.07) |
| MUSTs open | 114 | 117 |
| MUSTs met | 14 | 14 |
| SHOULDs met | 2: SC-12, DEV-05 | the same 2 |
| Novel mechanisms | 5: dormant groups, the slot move, the dedup window, the restore mark, one process per dir (the dir lease) | the same 5 |
| Interacting pairs | 272 | 272 |
| Rank | 5th of 20, level with SRV, RLOG and EMB-V8 ([A.2][oa2]) | out on PERF-04; with it waived alone, 4th of 20, and COMP still wins ([B.4][ob4]) |

**Against the winner.** SLOG has 5 novel mechanisms and COMP2 has 3. They are 2 apart, so COMP2 wins before SHOULDs (2 against 6) are looked at.

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. Restating does not save it. Section 8 item 2 does: accept JetStream's default test line as a loss ([section 8][s8]).
- **SC-03 (Scale writes up).** A measured ceiling, simulated ([E-18]). As worded every design gets 12 to 22 effective writers against F_w = 64. Gap 0.66. Restated, a slot row states 135 at 4,096 slots, so it is open. Item 5 fails it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]), gap 0.66. Restated it is open: 135 is stated, but no ceiling is pinned (G-06). Item 5 bears on it the same way.
- **F-15 (Outside services).** Structural. A slot move records its new epoch in the store's manifest before use ([E-33]'s rule, A-08). So a move waits while the object store is down, and F-15 lets only wake, new replicas and old history wait. Restated, with slot moves added to F-15's list, it is open. Item 11 ("no slot move may wait") fails it again.

## What it does well

- **No cell** is met for SLOG and not met for all three leading rows (COMP2, MIN-P+par and TiKV-TS; computed here: `repro diff SLOG COMP2 MIN-P+par TiKV-TS`).
- **One SHOULD is open for it and not met by all three:** DEP-15 (two copies survive a crash). Durability sits in a log tier of three, so two servers can lose either one by design. It stays open because the writer change was never modelled ([scorecard][card]).
- **Idle cost.** Its servers keep one session each to the controller. That is 400 frames a second at 100 members, against 19,800 for pairwise pings ([E-25]).
- **Price.** It costs $0.04 asleep and $5.23 to $5.60 a month at 10 writes a second on Fly, against $7.52 to $7.89 for COMP2's shape ([E-41]).
- **Its weak side is evidence.** It has 117 open MUSTs, tied with PD and ISR for the most of the 20 study rows ([B.1][ob1]). Restated, it is worse than COMP2 on 24 cells (computed here: `repro differ COMP2 SLOG`). Most rest on its writer change by seal and metadata compare-and-swap, which was never modelled or run ([scorecard][card]).

## What would change its verdict

- **Item 2 (the PERF-01 loss).** It comes back in, but loses on the novel count. MIN-P+par wins on the strict reading (3 against 5), and TiKV-persisted on the loose one (0 against 5). As worded, SLOG is then level first on both lines, with DRAFT, SPLIT, ISR, RLOG and EMB-V8 among others ([matrix]).
- **Kill step 6b** ([section 9][s9]). If the `memory` rung loses JetStream's default test line, only a loss accepted by name keeps a row in. The arithmetic then picks MIN-P+par or TiKV-persisted, not SLOG.
- **Items that lower it.** Item 11 fails its F-15 again. Item 14 (no tier shared between projects) fails its OPS-14 ([VERDICT 7.3][v73]).
- **To beat COMP2 by rule 3** it would need 4 fewer novel mechanisms (1 against 3), or 1 to 3 fewer and more than 6 SHOULDs. Its nearest neighbour, with client sessions, has 4 novel and still 2 SHOULDs.
- **Owed for its own cells** ([AMENDMENTS 3][am3], [scorecard][card]):
  - a model of the writer change by seal and metadata compare-and-swap (P-03, F-01);
  - E-37's bad-entry check on a log node, which never ran for this path (F-22);
  - a loglet's idle cost for SC-13, never measured;
  - its data path under partial partitions ([E-38] ran etcd's Raft only).

## Twins and neighbours

All from `python3 tools/closure.py row '<change>' SLOG`, restated.
- **SLOG H=srv** ties it on every count (5 novel, 2 SHOULDs, 272 pairs), with no guessed cell. SLOG P=slot+rule and SLOG C=cent tie it too, on one guessed cell each (F-15, F-12).
- **SLOG D=sess** (4 / 2 / 274, no guessed cell) has one novel mechanism fewer. It is still out on PERF-04.
- **SLOG Q=mix** adds the `memory` rung. It is back in restated (5 / 2 / 286), on 5 guessed cells: P-01, P-15, PERF-07, PERF-08 and DEP-21. It still loses to COMP2 by 2 novel. As worded, 6 of the 20 searched mixes (loose reading) that fail only SC-03 and SC-10 are SLOG with the rung ([VERDICT 2][v2]).
- **RLOG** is its log-first sibling. It reaches the same hosted shape with Raft on its log members: 4 novel, 5 SHOULDs, 268 pairs and 96 open MUSTs ([RLOG](RLOG.md)).

## The evidence

- [E-09b][]: JetStream's default acks one publisher at p99 0.55 ms (3,280 a second); with fsync always, 1,228 a second at p99 1.31 ms.
- [E-01][]: the commit bar C is 0.73 ms on this box; the best `persisted` commit's p99 is 0.323 ms with no network (RR-15).
- [E-18][]: as worded, 12 to 22 effective writers for every design; restated, 135 at 4,096 slots.
- [E-33][]: a restore stays honest only with an epoch above an outside high-water mark and a fresh session generation (8 rules).
- [E-25][]: 400 idle frames a second at 100 members, against 19,800 for pairwise pings.
- [E-44][]: a log-first row is about 13,500 lines, about 82 times BUY's, against about 49 times for a Raft row (an estimate).
- [E-20][]: the dedup window needs 17 rules against 13 for client sessions.
- [E-41][]: $5.23 to $5.60 a month at 10 writes a second; neither OBJ nor SLOG is the cheapest by 2 times at 5,000 writes a second.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/SLOG.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS 3][am3]
- VERDICT: [section 2][v2] (outcome A), [3.1][v31] (the PERF-04 rows), [section 6][v6] (its one-line standing), [section 8][s8] items 2, 11 and 14

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v31]: ../VERDICT.md#31-the-20-study-rows
[v6]: ../VERDICT.md#6-every-other-row
[v73]: ../VERDICT.md#73-every-flip-in-outcome-a3-and-b3
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[ob1]: ../judging/OUTCOME.md#b1-each-row
[card]: ../judging/rows/SLOG.md
[s2]: ../SPACE.md#2-the-axes
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-20]: ../experiments/E20-dedup/README.md
[E-25]: ../experiments/E25-idle-fd/README.md
[E-33]: ../experiments/E33-genesis-restore/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
[E-44]: ../experiments/E44-outside-log/README.md
