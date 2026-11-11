# ISR: Kafka's shape, a leader and an in-sync set per partition under one controller

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no loss accepted; see the [key of terms][key]), ISR is out. It fails three MUSTs even restated: SC-03 (Scale writes up), SC-04 (Scale down) and SC-10 (Only stated ceilings). The cause is one choice: a resource's partition count is fixed when it is made, and nothing merges a group. The loose DATA-01 reading moves none of its cells, so it stays out. Accepting JetStream's default test line as a loss changes nothing, since ISR does not fail PERF-04. As worded it is level first of the 20 study rows with DRAFT and SPLIT, mostly because its F-17 was never tested ([VERDICT 2][v2]).

## In short

- **Where writes go.** Smart clients send each write straight to its partition's leader. A resource's keys hash onto a fixed count of partitions, set when it is made.
- **How replicas agree.** A leader and an in-sync set (the replicas that are caught up). A write commits when every member of the set has it, as Kafka's `acks=all` does.
- **Who heals and moves.** One replicated controller changes leaders and in-sync sets, like Kafka's KRaft. Only this metadata group runs the ported Raft.
- **What a commit means.** Every member of the in-sync set has the write. There is no `memory` rung.
- **Exactly once.** A producer id, an epoch and a sequence per partition (Kafka's KIP-98), with A-22's two fixes.
- **Where rows fold.** Every full replica folds the rows with `data`.
- **Where it comes from.** SPACE's ISR row, "Kafka's shape" ([SPACE 4.2][s42]). It copies Kafka (ISR plus KRaft) and PacificA ([SPACE 2][s2]).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `isr` | a leader plus an in-sync set; an outside controller changes both |
| G: what one log covers | `shard` | each resource has its own partition groups |
| P: how keys map to groups | `fixN` | N groups fixed when the resource is made; a key's group is its hash mod N |
| K: where write rules live | `hyb` | dedup and fences in the kernel, the rest in a library |
| C: who heals and moves | `cent` | one replicated controller, KRaft-style (A-20, reasoned) |
| V: kinds of replica | `full` | every replica folds and can lead |
| Q: what a commit means | `isr` | every member of the in-sync set has it |
| D: exactly once | `pid` | producer id, epoch and a sequence per partition (A-22) |
| O: positions | `off` | an offset per group |
| T: time | `clamp` | the leader's clock, never going back, held to the members' median (A-23) |
| X: writes across partitions | `ktxn` | Kafka's transactions: a coordinator, commit markers, `read_committed` readers |
| S: storage | `walg +tier` | a log file per group, plus an object-store tier |
| F: where rows fold | `all` | every full replica folds with `data` |
| W: reads | `any` | from any ready replica, at a position |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `both` | one code base for both roles |
| L: language | `ts→rs` | TypeScript first, a Rust core later |
| I: the Raft core | `port(meta)` | etcd's Raft, ported, for the metadata group only |
| Y: how a write reaches its leader | `smart` | the client holds the partition table and sends to the leader |
| M: threads | `kw` | the kernel on a worker thread |
| Z: storage faults | `crash` | disks fail only by crash; a corrupt entry is undefined |
| N: tenancy | `proc` | one process set per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading changes no ISR cell (computed here: `repro tally ISR` and `repro tally ISR --strict` print the same).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 3: SC-03, SC-04, SC-10 (gap ÷ bar 1.32) | the same 3 (1.32) |
| MUSTs open | 117 | 117 |
| MUSTs met | 12 | 12 |
| SHOULDs met | 1: SC-12 | the same 1 |
| Novel mechanisms | 2: the restore mark, one process per dir (the dir lease) | the same 2 |
| Interacting pairs | 214 | 214 |
| Rank | 1st of 20, level with DRAFT and SPLIT ([A.2][oa2]) | out on 3 MUSTs; [B.4][ob4] lists only rows one or two MUSTs put out |

**Against the winner.** Let back in, ISR has 2 novel mechanisms to COMP2's 3. They are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 1.

## What fails, and the proof

No restatement and no user choice saves any of the three ([section 8][s8]).

- **SC-03 (Scale writes up).** A measured ceiling, simulated ([E-18]). As worded it fails like every row: 12 to 22 effective writers against F_w = 64 (gap 0.66). Restated it still fails. P `fixN` fixes the count up front, which SC-03 forbids. And hashing onto 64 fixed groups gives only 23 to 53 writers' worth under skew, even with the app's split ([E-18], B4).
- **SC-04 (Scale down).** Structural. The partition count is fixed when the resource is made, and no rule merges or removes a group. So a count sized for a peak stays for good ([E-17]: such groups "never go away").
- **SC-10 (Only stated ceilings, each above its floor).** A measured ceiling ([E-18]), gap 0.66. The 23 to 53 writers' worth sits below F_w = 64. And its log file per group loses to a shared journal well before SC-10's floor of 2,000 groups: p99 9 to 186 times worse at 2,000 ([E-12]).

## What it does well

- **No cell** is met for ISR and not met for all three leading rows (COMP2, MIN-P+par and TiKV-TS; computed here: `repro diff ISR COMP2 MIN-P+par TiKV-TS`).
- **Two SHOULDs are open for it** where COMP2 and MIN-P+par have "not met".
  - DEP-15 (two copies survive a crash): SPACE says two copies plus the controller survive either crash. TiKV-TS has "not met" too. Nothing ran it ([scorecard][card]).
  - P-15 S (readers never see half a unit): Kafka's `read_committed`. It stays open, because commit markers land per partition (reasoned). TiKV-TS has it open too.
- **P-15 M (Transactions across partitions) is met,** where COMP2 leaves it open for its `memory` rung (RR-11). MIN-P+par meets it too. Kafka's transactions are cited, not run here.
- **Few novel mechanisms.** Among the 20 study rows only PD and BUY carry fewer (0 each).
- **But it is among the least tested rows.** It has 117 open MUSTs, tied with PD and SLOG for the most of the 20 study rows, and 12 met. Its data path never ran under partial partitions, and E-37 never checked a damaged entry for it ([scorecard][card]).

## What would change its verdict

- **Nothing on this frame lets it back in.** Its three failures hold restated, and no item of [section 8][s8] opens them.
- **As worded, these move its place** ([VERDICT 7.3][v73]):
  - judge 1 alone or judge 2 alone, before the referee, puts ISR first alone ([OUTCOME A.3][oa3]);
  - item 14 (no tier shared between projects) puts ISR first alone among the 20, and among all 31 on the strict reading;
  - item 19 (F-17 read the clique way) drops it: DRAFT and SPLIT then lead with 2 MUSTs, ISR has 3.
- **No kill criterion of [section 9][s9] bears on it.** They test COMP2's shape.
- **Owed for its own cells** ([scorecard][card], [AMENDMENTS 3][am3]):
  - a partial-partition run on its data path ([E-38] ran etcd's Raft, not ISR);
  - a storage-fault check for Z `crash` with an in-sync leader that cuts a bad entry;
  - SC-13 priced for N partition groups per resource, each with its own log file;
  - a failover timed with the controller choosing a new leader (F-05).

## Twins and neighbours

All from `python3 tools/closure.py row '<change>' ISR`, restated.
- **ISR H=emb** and **ISR H=srv** tie it on every count (2 novel, 1 SHOULD, 214 pairs), with no guessed cell.
- **ISR Y=fwd** (2 / 1 / 208, no guessed cell) beats it on pairs. It still fails the same three MUSTs.
- **No one-option change brings it back in.** Every such variant still fails at least SC-03 and SC-10 (computed here: `repro one ISR`).
- **ISR with another partition map** is a case [VERDICT 2][v2] reports. As worded, 20 searched mixes (loose reading) fail only SC-03 and SC-10, one MUST fewer than any judged row. Eleven of them are ISR with another partition map. Two of those, ISR P=slot O=hlc and ISR P=slot O=slot, fail SC-10 only on a guessed cell.

## The evidence

- [E-18][]: hashing straight onto 64 fixed groups gives 23 to 53 writers' worth for one resource under skew, with the app's split.
- [E-17][]: `fixN` fails SC-03 and SC-04 by definition; slot moves need 26 rules and meet both.
- [E-12][]: at 2,000 groups, a log file per group has a p99 9 to 186 times worse than one shared journal. From 256 groups up, that is 9 to 854 ms against 2 to 6.6 ms.
- [E-20][]: `pid` dedup needs 16 rules and 2.1 KB per producer, against 13 rules for client sessions.
- [E-25][]: ISR's idle follower fetches are pairwise, so above about 10,000 partitions it sits at about twice the pings' frame count.
- [E-41][]: ISR has MIN's shape: $0.19 asleep and $7.52 to $7.89 a month at 10 writes a second on Fly.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/ISR.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS 3][am3]
- VERDICT: [section 2][v2] (outcome A, and why ISR is level first), [section 6][v6] (its one-line standing), [7.3][v73] and [section 8][s8] items 14 and 19

[key]: ../VERDICT.md#key-of-terms
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v6]: ../VERDICT.md#6-every-other-row
[v73]: ../VERDICT.md#73-every-flip-in-outcome-a3-and-b3
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[oa3]: ../judging/OUTCOME.md#a3-what-flips-the-winner
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/ISR.md
[s2]: ../SPACE.md#2-the-axes
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-12]: ../experiments/E12-journal/README.md
[E-17]: ../experiments/E17-partitioning/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-20]: ../experiments/E20-dedup/README.md
[E-25]: ../experiments/E25-idle-fd/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
