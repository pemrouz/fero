# OBJ: the object store is the log, so every commit is a PUT and leadership is a compare-and-swap

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no loss accepted; see the [key of terms][key]), OBJ is out on 7 MUSTs. Nearly all come from one choice: each commit is a conditional PUT to an object store. On a real store that PUT is too slow (P-01, P-05, PERF-04, PERF-07, PERF-08) and too dear (DEP-21), and writes stop while the store is down (F-15). The loose DATA-01 reading moves none of its cells, so it stays out. Accepting JetStream's default test line as a loss does not help: OBJ also loses JetStream's fsync-always line. As worded it fails 9 MUSTs and ranks 18th of 20, with the largest gap sum of any row, 18.08 ([A.2][oa2]).

## In short

- **Where writes go.** Any server takes a write and forwards it to the slot's writer. Keys hash into 4,096 fixed slots per resource (A-16).
- **How replicas agree.** No Raft at all. The writer holds a lease by compare-and-swap on the store's manifest (its index file). A commit is one object written to the store.
- **Who heals and moves.** The controller is a compare-and-swap on that manifest. A warm standby is required (A-26, reasoned).
- **What a commit means.** A conditional PUT to the object store has finished.
- **Where rows fold.** Only the leader folds the rows with `data`. Followers fold behind, or on first read.
- **Exactly once.** Client sessions, in replicated state.
- **Where it comes from.** SPACE's OBJ row, "the object store is the log" ([SPACE 4.2][s42]). It copies WarpStream and SlateDB, built on S3's conditional writes ([SPACE 2][s2]).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `obj` | the object store is the durable layer; the writer holds a lease by compare-and-swap |
| G: what one log covers | `shard` | each resource has its own slot sets |
| P: how keys map to groups | `slot` | 4,096 fixed slots; a slot moves one at a time with a margin (A-16, A-18) |
| K: where write rules live | `lib` | a fenced log with five operations; dedup, conditions and ops are a library at the writer |
| C: who heals and moves | `cent(manifest CAS)` | the controller is a compare-and-swap on the store's manifest (A-20, reasoned) |
| V: kinds of replica | `tier` | the store holds all durability; servers are disposable |
| Q: what a commit means | `put` | one object-store PUT |
| D: exactly once | `sess` | client sessions, in replicated state |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time | `clamp` | the writer's clock, never going back, held to the members' median (A-23) |
| X: writes across partitions | `saga` | fenced locks, an intent row and steps; a reader may see half a saga unit |
| S: storage | `obj` | the object store only, with a local cache |
| F: where rows fold | `ldr + lazy` | only the leader folds; followers fold behind or on first read |
| W: reads | `lease any` | leader reads under a time lease, or from any ready replica at a position |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `both` | one code base for both roles |
| L: language | `ts→rs` | TypeScript first, a Rust core later |
| I: the Raft core | `—` | none |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread |
| Z: storage faults | `crash` | disks fail only by crash; a corrupt entry is undefined |
| N: tenancy | `tier` | the shared tier, here the object store itself, is pooled |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading changes no OBJ cell (computed here: `repro tally OBJ` and `repro tally OBJ --strict` print the same).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 9: P-01, P-05, PERF-04, PERF-07, PERF-08, SC-03, SC-10, F-15, DEP-21 (gap ÷ bar 18.08) | 7: the same without SC-03 and SC-10 (16.76) |
| MUSTs open | 109 | 111 |
| MUSTs met | 14 | 14 |
| SHOULDs met | 1: SC-12 | the same 1 |
| Novel mechanisms | 2: the slot move, the restore mark | the same 2 |
| Interacting pairs | 144 | 144 |
| Rank | 18th of 20 ([A.2][oa2]) | out on 7 MUSTs |

**Against the winner.** Let back in, OBJ has 2 novel mechanisms to COMP2's 3. They are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 1.

## What fails, and the proof

Section 8 items are in [VERDICT section 8][s8].
- **P-01 (Live shared state).** Structural. A `persisted` write is one PUT. A real store's PUT p99 is about 80 ms on S3 Standard and 7.3 ms or more on Express One Zone (cited in [E-28]). The bar is C + 5 ms = 5.7 ms. No restatement or choice saves it.
- **P-05 (WebSocket fan-out by room).** A ceiling. Delivery waits for a commit that is a PUT: p99 2.67 ms on local MinIO, against C plus one hop, about 0.83 ms. Gap 2.2. It fails restated too, so item 6 does not save it.
- **PERF-04 (NATS JetStream).** A ceiling. On MinIO one writer gets 698 PUTs a second at p99 2.67 ms ([E-28]). JetStream with fsync always gets 1,228 acks a second at p99 1.31 ms, and 0.55 ms at its default ([E-09b]). Gap 0.43. Item 2 does not save it: OBJ loses the fsync-always line too.
- **PERF-07 (etcd).** A ceiling. One client's put is one PUT: 698 a second at p99 2.67 ms, against etcd's 1,118 puts a second at p99 1.73 ms ([E-09e]). Gap 0.38. No choice saves it.
- **PERF-08 (Commit latency).** A ceiling, on the native bar. A 1 KB PUT takes p50 1.37 ms and p99 2.67 ms here, over C + 0.5 ms = 1.23 ms ([E-28]). Gap 1.17. Item 20 can save this one: judged on its TypeScript phase alone, the PUT is inside the 5.73 ms bar, so the cell would be open.
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded every design gets 12 to 22 effective writers against 64. Gap 0.66. Restated it is open; item 5 fails it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling, gap 0.66. Restated it is open; item 5 bears on it the same way.
- **F-15 (Outside services).** Structural. With the store down, no PUT and no compare-and-swap can finish, so writes and failover stop. That fails restated too. Item 11 does not help, since it lets only slot moves wait.
- **DEP-21 (Cost is a number).** A ceiling. Ten writes a second cannot share a PUT unless the commit window is over 2 s. That is about 26.3 million PUTs a month: $135.80 against the $10 bar ([E-41]; the price re-check gives $136.02 to $136.39). Gap 12.58. Items 17 and 18 do not save it: asleep it costs $0.04, and no likely price error flips it.

## What it does well

- **F-12 (Majority loss) is met here and open for all three leading rows** (COMP2, MIN-P+par and TiKV-TS; computed here: `repro diff OBJ COMP2 MIN-P+par TiKV-TS`). OBJ has no voters, so no majority can be lost (the referee's ruling, [scorecard][card]).
- **One SHOULD is open for it and not met by all three:** DEP-15 (two copies survive a crash). The store holds every commit. But the lease takeover by compare-and-swap was never modelled.
- **The fewest pairs of any v5 row that runs its own kernel:** 144 ([VERDICT 7.6][v76]). Only V4 (52) and BUY (12) carry fewer.
- **Cheap to keep asleep.** It costs $0.04 a month asleep and holds nothing in memory ([E-41], [E-26]).
- **The store still has a role.** [E-28] keeps the object store as a storage tier (S `+tier`) for sleep, wake, forks and history. COMP2 uses it that way.

## What would change its verdict

- **Nothing in [section 8][s8] lets it back in.** Five of its seven restated failures come from Q `put` on a real store. F-15 comes from R `obj`, and DEP-21 from the PUT bill.
- **Item 20 opens PERF-08 alone** (its TypeScript phase judged on its own). Six failures remain.
- **Item 14 (no tier shared between projects) fails its OPS-14 too,** since its store is pooled between projects. It then fails 10 MUSTs as worded and 8 restated, and no first place moves (computed for this report: `repro tally OBJ --worded --choice 'shared tier'`, then without `--worded`; `repro rank --worded --choice 'shared tier'`). [VERDICT 7.3](../VERDICT.md#73-every-flip-in-outcome-a3-and-b3) names only DRAFT, SPLIT and SLOG, the rows whose failure moves the winner. CELL, LANE, RLOG and EMB-V8 fail OPS-14 under item 14 as well.
- **No kill criterion of [section 9][s9] bears on it.** They test COMP2's shape.
- **What it would take.** A store whose PUT p99 sits well under C + 5 ms, with many commits sharing one PUT. [E-28] cites Express One Zone at single-digit milliseconds, still 7.3 ms or more at p99.
- **Owed for its own cells** ([scorecard][card], [AMENDMENTS 3][am3]). The lease takeover by compare-and-swap was never modelled. Z `crash` was never checked for it. Its leases must go quiet or cost PUTs ([E-25]). None of this is planned.

## Twins and neighbours

All from `python3 tools/closure.py row '<change>' OBJ`, restated.
- **OBJ H=srv** and **OBJ P=slot+rule** tie it on every count (2 novel, 1 SHOULD, 144 pairs), with no guessed cell.
- **No one-option change brings it back in.** Every such variant keeps its PUT commit, so it still fails at least six of the seven (computed here: `repro one OBJ`). Swapping L to `ts` drops PERF-08, as item 20 does.
- **SLOG** keeps OBJ's hosted aim, with disposable servers, but on a log tier of its own. [E-41] finds neither OBJ nor SLOG the cheapest by 2 times at 5,000 writes a second ([SLOG](SLOG.md)).

## The evidence

- [E-28][]: a conditional PUT to MinIO on this disk costs p50 1.37 ms and p99 2.67 ms for 1 KB. S3 Standard is about 30 ms typical and 80 ms at the tail (cited). 1,000 commits a second would cost about $13,000 a month on S3 Standard.
- [E-41][]: $136.02 to $136.39 a month at 10 writes a second on Fly, 24.6 to 26.3 times the cheapest row. At 5,000 writes a second it is $1,468 to $1,652.
- [E-09b][]: JetStream with fsync always: 1,228 acks a second, p99 1.31 ms; at its default, p99 0.55 ms.
- [E-09e][]: etcd does 1,118 puts a second at one client, p99 1.73 ms.
- [E-25][]: OBJ's leases must go quiet, or they cost PUTs ([AMENDMENTS 3][am3]).
- [E-26][]: OBJ holds nothing in memory while asleep.
- [E-18][]: as worded, 12 to 22 effective writers for every design; restated, 135 at 4,096 slots.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/OBJ.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS 3][am3]
- VERDICT: [section 2][v2] (every gap ÷ bar), [section 6][v6] (its one-line standing and DEP-21's written reasons), [7.6][v76] (pairs), [section 8][s8] item 20

[key]: ../VERDICT.md#key-of-terms
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v6]: ../VERDICT.md#6-every-other-row
[v76]: ../VERDICT.md#76-dev-02-and-the-models
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[card]: ../judging/rows/OBJ.md
[s2]: ../SPACE.md#2-the-axes
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-09b]: ../experiments/E09b-nats/README.md
[E-09e]: ../experiments/E09e-etcd/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-25]: ../experiments/E25-idle-fd/README.md
[E-26]: ../experiments/E26-dormant-groups/README.md
[E-28]: ../experiments/E28-minio-log/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
