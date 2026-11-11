# MIN-TS: MIN written in TypeScript for good, with no native step

**Verdict.** On [VERDICT.md's frame](../VERDICT.md#8-what-the-user-must-confirm) (strict DATA-01, clauses restated, no PERF-01 loss), MIN-TS is out. It fails one MUST, PERF-04 (NATS JetStream), because its only durable rung is `persisted` (a rung is what a commit means; see the [key of terms][key]). Let back in, it still loses to COMP2 and MIN-P+par by [rule 3][rule]: 4 novel mechanisms against their 3, and 5 SHOULDs against their 6. The loose DATA-01 reading changes nothing for it. If the user accepts JetStream's default test line as a loss, it comes back in, but MIN-P+par (strict) or TiKV-persisted (loose) wins ([matrix]). As worded, it fails 5 MUSTs and shares 9th place of 20 ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** Each resource's keys hash into 4,096 fixed slots (A-16). Each resource has its own Raft groups, and each group owns a set of slots. Any server takes a write and forwards it to the group's leader.
- **How replicas agree.** Raft: one leader per group, and a write commits at a majority. The core is etcd's Raft, ported to TypeScript ([E-10]).
- **Who heals and moves.** One loop on `#meta`'s leader heals replicas and moves slots. `#meta` is the project's own system group.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the answer. There is no `memory` or `none` rung.
- **Where rows fold.** Every full replica folds the rows with `data`. The kernel runs on a worker thread; the rows and user code sit on the main thread.
- **Language.** TypeScript only, for good. The server and the simulator run the same source, so there is never a second kernel.
- **Where it comes from.** SPACE's row MIN-TS, "MIN in TypeScript for good" ([SPACE 4.2][s42]). It copies etcd's Raft, Redis Cluster's fixed slots and Kafka's KRaft controller run inside a member.

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | Raft; membership changes take effect on commit (A-01) |
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
| F: where rows fold | `all` | every full replica folds with `data` |
| W: reads | `any ridx` | from any ready replica at a position, or by read index |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `emb` | inside the app's own Node process |
| L: language | `ts` | TypeScript only, for good: one kernel |
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
| MUSTs open | 91 | 94 |
| MUSTs met | 36 | 37 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark in the store's manifest, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 253 | 253 |
| Rank | 9th of 20, level with MIN, RUST, LEAN, LANE, MIN-P and SIDE ([A.2][oa2]) | out on PERF-04; with it waived alone, 1st of 20 ([B.4][ob4]) |

**Against the winner.** Rule 3 looks at novel mechanisms first, but only when two rows are 2 or more apart. MIN-TS (4) and COMP2 (3) are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. Restating does not save it. User choice item 2 (accept that loss by name) opens it ([section 8][s8]).
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded, the hottest partition takes 5.5 to 9.8 % of a skewed load. So every design reaches only 12 to 22 effective writers, against F_w = 64. Gap 0.66. Restated with the app split, a slot row states 135 at 4,096 slots, so it is open. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). As worded, the writer ceiling of 12 to 22 sits below its floor of 64. Gap 0.66. Restated, it is open: 135 is stated, but no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-15 (Outside services).** Structural. A slot move records its new epoch in the object store before use ([E-33]'s rule, A-08). So a move waits while the store is down, and F-15 does not list moves. Restated, it is open. Item 11 (F-15 kept as worded) keeps it failed.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck, by Raft's vote rule ([E-38]). Restated to "a connected majority that includes an up-to-date replica", it is open. Item 7 restates it; item 19 (the clique reading) opens it as worded.

## What it does well

- **TEST-10 (Same kernel bytes) is met.** COMP2, MIN-P+par and TiKV-TS all leave it open. There is one TypeScript kernel, so nothing needs a byte-for-byte twin check. The port matched Go's etcd Raft on 4,000 of 4,000 random scripts ([E-10]).
- **DATA-09 (A native kernel keeps data) is met by construction.** Nothing ever moves to native code. COMP2 and MIN-P+par meet it only through RR-17's design rule ([VERDICT 3.3][v33]).
- **P-10, P-15 and F-02 are met, where COMP2 leaves them open.** It has no `memory` rung, so no lost unsynced tail can undo a lock, a saga or a refusal (RR-11 to RR-13). MIN-P+par meets them too.
- **The fewest open MUSTs.** With the loss accepted, it has 95, the fewest of the judged rows that are in ([matrix]).
- It meets no SHOULD that the leading rows miss. P-22, DEV-05 and OPS-11 (S) are met for it and open for TiKV-TS only.

## What would change its verdict

- **Item 2 (the PERF-01 loss).** It comes back in. But MIN-P+par still beats it on one SHOULD, and TiKV-persisted on the novel count (loose reading).
- **Item 16 (open MUSTs counted first).** With the loss accepted, this picks MIN-TS among the 31 judged rows ([matrix]). Over the searched mixes, MIN-P+par in TypeScript ties it at 95 open and beats it by rule 3 ([VERDICT 3.2][v32]).
- **Items 5, 7 and 20.** Each puts every row out, MIN-TS with them. Item 11 keeps its F-15 failed.
- **Kill criteria 6a, 6d and 6e** ([section 9][s9]). For MIN-TS a miss in TypeScript is final, since it has no native step (reasoned). A commit p99 above 5.73 ms at 50,000 writes a second fails P-01 and PERF-08. An etcd one-client put above 1.73 ms fails PERF-07. Under 62 % of E-02's ceiling against Redpanda fails PERF-06.
- **Step 8 (the native step).** If TypeScript wins every row, the page stays in TypeScript (L `ts`). That backs MIN-TS's language, but on COMP2's or MIN-P+par's shape ([VERDICT 5.1][v51]).
- **Owed** ([scorecard][card]): the PERF-08 commit pin on the real TypeScript kernel, and PERF-06 and PERF-07 through E-45's gateways, in the same hold as each rival.

## Twins and neighbours

- **MIN** (one option apart: L `ts→rs`). It ties MIN-TS on rule 3's counts: 4 novel, 5 SHOULDs, 253 pairs. DATA-09 and TEST-10 are met for MIN-TS and open for MIN, so MIN has 96 open MUSTs against 94.
- **RUST** also ties it on those counts. DEP-20, TEST-10 and TEST-13 are met for MIN-TS and open for RUST (97 open).
- **MIN-TS with G `pslot`** (an unjudged mix with no guessed cell): 3 novel, 5 SHOULDs, 252 pairs, 94 open. Dormant groups are no longer needed. It beats MIN-TS on pairs (`python3 tools/closure.py row 'G=pslot' MIN-TS`).
- **MIN-TS with Z `par`** (unjudged, no guessed cell): 4 novel, 6 SHOULDs, 266 pairs. `par` adds F-22 (S).
- **With both: MIN-P+par in TypeScript** (`row 'L=ts' MIN-P+par`): 3 novel, 6 SHOULDs, 264 pairs, 94 open (95 with the loss). It is MIN-TS's strongest neighbour, and "open MUSTs first" picks it over the searched mixes ([VERDICT 3.2][v32]).

## The evidence

- [E-02](../experiments/E02-pipeline/README.md): TypeScript spends 5.5 µs of CPU per committed append at 50,000 a second, with p99 4.3 ms against a 5.7 ms bar.
- [E-02](../experiments/E02-pipeline/README.md): with the disk out of the way, Rust and Go have about a 3 times tighter p99 (0.67 to 0.75 ms against 2.4 ms).
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms and 3,280 acks a second.
- [E-09d](../experiments/E09d-redpanda/README.md): Redpanda's matched rate sits only 1.62 times under TypeScript's protocol-free ceiling, with no CPU margin.
- [E-09e](../experiments/E09e-etcd/README.md): etcd's one-client put has p99 1.73 ms; TypeScript's measured commit p99 is 2.4 to 4.3 ms.
- [E-10](../experiments/E10-raft-port/README.md): the port passes all 41 of etcd's test files byte for byte.
- [E-46](../experiments/E46-maelstrom-raft/README.md): the port was linearizable in 26 of 26 Maelstrom runs under partitions and pauses.
- [E-18](../experiments/E18-slot-balance/README.md): 135 effective writers at 4,096 slots with the app split; 12 to 22 as worded.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape costs $7.52 to $7.89 a month at 10 writes a second on Fly, and $0.19 asleep.

## Links

- Scorecard: [judging/rows/MIN-TS.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [section 6][v6] (its one-line standing), [3.2][v32] (the matrix and "open MUSTs first"), [5.1][v51] (COMP2 in TypeScript for good), [section 8][s8] item 16

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v32]: ../VERDICT.md#32-all-31-judged-rows-the-matrix
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v51]: ../VERDICT.md#51-its-full-line-in-plain-words
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/MIN-TS.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-10]: ../experiments/E10-raft-port/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-33]: ../experiments/E33-genesis-restore/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
