# DRAFT: the v5 design draft of 2026-11-05, with Raft groups that heal and grow themselves

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no loss accepted; see the [key of terms][key]), DRAFT is still in. It fails no MUST, but it loses to COMP2 at the first step of [rule 3][rule]. It carries 5 novel mechanisms against COMP2's 3, and 2 apart decides; the two extra are its dedup window and its dormant groups. The loose DATA-01 reading moves none of its cells, but then TiKV-TS wins, with 0 novel against 5. With JetStream's default test line accepted as a loss, DRAFT still loses, to MIN-P+par (strict) or TiKV-persisted (loose) ([matrix]). As worded it is level first of the 20 study rows with SPLIT and ISR, yet outcome A names nothing to build ([VERDICT 2][v2]).

## In short

- **Where writes go.** Any server takes a write and forwards it to the group's leader. Keys hash into 4,096 fixed slots per resource (A-16).
- **How replicas agree.** Raft, with one group per slice of a resource. Groups have voters, learners (full copies that do not vote) and witnesses (copies that keep the log but not the rows).
- **Who heals and moves.** Each group's leader heals its own replicas. Each leader also runs a grow-and-shrink rule that hands slots to other groups. An optional planner may send hints.
- **What a commit means.** Chosen per resource: `persisted` (on disk at a majority) by default, or `memory` or `none` (best effort).
- **Exactly once.** The draft's own dedup window: an issuer window, a floor, outcomes by id and time budgets per hop. It is one of its novel mechanisms.
- **Where rows fold.** Every full replica folds the rows with `data`. The kernel runs on a worker thread.
- **Where it comes from.** SPACE's DRAFT row: DESIGN-V5 as of 2026-11-05 ([SPACE 4.2][s42]). It copies no single system. Its parts follow etcd's Raft (ported), Redis Cluster's fixed slots, CockroachDB's per-range healing queues and Spanner's witnesses ([SPACE 2][s2]).

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `raft` | Raft; membership changes take effect on commit (A-01, A-02) |
| G: what one log covers | `shard` | each resource has its own groups; idle groups go dormant (A-15) |
| P: how keys map to groups | `slot + rule` | 4,096 fixed slots; each leader's grow-and-shrink rule moves them, one at a time with a margin (A-18) |
| K: where write rules live | `lib` | a fenced log with five operations; dedup, conditions and ops are a library on the leader |
| C: who heals and moves | `self+p` | each leader heals its own replicas; an optional planner sends hints |
| V: kinds of replica | `+lrn +wit` | voters, learners, and witnesses that lead only to repair |
| Q: what a commit means | `mix` | `persisted` by default; `memory` or `none` per resource |
| D: exactly once | `win` | the dedup window: issuer window, floor, outcomes by id, time budgets per hop |
| O: positions | `slot` | a sequence per slot, compared as (epoch, sequence) |
| T: time | `clamp` | the leader's clock, never going back, held to the members' median (A-23) |
| X: writes across partitions | `saga` | fenced locks, an intent row and steps; a reader may see half a saga unit |
| S: storage | `jrnl +tier` | one journal per process plus an object-store tier; founded by `fero init`, so the restore mark's home is open (A-08) |
| F: where rows fold | `all` | every full replica folds with `data` |
| W: reads | `any ridx` | from any ready replica at a position, or by read index |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `both` | one code base for servers and log members |
| L: language | `ts→rs` | TypeScript first, a Rust core later, checked byte for byte |
| I: the Raft core | `port` | etcd's Raft ported to TypeScript ([E-10]) |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on a worker thread; user code and rows on the main thread |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `tier` | only the log tier is shared between projects; servers stay per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading changes no DRAFT cell (computed here: `repro tally DRAFT` and `repro tally DRAFT --strict` print the same).

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 3: F-17, SC-03, SC-10 (gap ÷ bar 1.32) | none |
| MUSTs open | 98 | 100 |
| MUSTs met | 31 | 32 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 5: dormant groups, the slot move, the dedup window, the restore mark, one process per dir (the dir lease) | the same 5 |
| Interacting pairs | 309 | 309 |
| Rank | 1st of 20, level with SPLIT and ISR ([A.2][oa2]) | 3rd of the 3 rows in: COMP and SPLIT both beat it ([B.2][ob2]) |

**Against the winner.** DRAFT has 5 novel mechanisms and COMP2 has 3. They are 2 apart, so COMP2 wins before SHOULDs (5 against 6) or pairs (309 against 277) are looked at.

## What fails, and the proof

All three fail as worded only. Restated, all three are open.

- **SC-03 (Scale writes up).** A measured ceiling, simulated ([E-18]). As worded, the hottest partition holds 5.5 to 9.8 % of a skewed load, so every design gets 12 to 22 effective writers against F_w = 64. Gap 0.66. Restated (the app splits any partition above half a writer's share), a slot row states 135 writers at 4,096 slots. Section 8 item 5 fails it again: kept as worded, or F_w above 135 ([section 8][s8]).
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). Gap 0.66. Restated, 135 is stated but no ceiling is pinned yet (G-06), so it is open. Item 5 bears on it the same way.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck ([E-38]). Restated ("a connected majority that includes an up-to-date replica") it is open. Item 7 restates it. Item 19, the clique reading, opens it as worded.

## What it does well

- **No cell** is met for DRAFT and not met for all three leading rows (COMP2, MIN-P+par and TiKV-TS; computed here: `repro diff DRAFT COMP2 MIN-P+par TiKV-TS`).
- **One SHOULD is open for it and not met by all three:** DEP-15 (two copies survive a crash). Its witness can be the third voter. But `+wit` was never modelled and no crash test ran ([scorecard][card]).
- **Its cells are almost COMP2's.** Restated, they differ on three cells only (computed here: `repro differ DRAFT COMP2`). DATA-09 is open here and met by COMP2's design rule. F-22 S is met by COMP2 through `par`. DEP-15 S is open here and not met for COMP2.
- **It is the cheapest shape at 10 writes a second.** On Fly it costs $5.17 to $5.54 a month, against $7.52 to $7.89 for COMP2's shape. Asleep it costs $0.04. Awake all month it is $2.19, on the bar ([VERDICT 6][v6], note d of [section 8][s8]).

## What would change its verdict

- **Kill criteria that hit it with COMP2** ([section 9][s9]). DRAFT is a slot row and carries the `memory` rung, so it shares COMP2's risks:
  - a counterexample where a slot move meets a membership change (K-01) hits every slot row;
  - slot-move mutants caught below 85 % (step 2d) fail DEV-03 for every slot row;
  - a move's unwritable window over 10 ms (step 7) fails SC-08 for every slot row;
  - fewer than 64 effective writers in the phase-4 sim fails SC-03 and SC-10 restated;
  - step 6b: if the `memory` rung loses JetStream's default test line, every row with the rung fails PERF-04, DRAFT too;
  - step 2b: if the rung breaks P-10, P-15 or F-02 with no fixing rule, the rung goes.
- **User choices.** None puts DRAFT first on this frame.
  - Items 11 and 17, and item 5 with F_w above 135, give SPLIT. SPLIT beats DRAFT: 4 novel against 5, SHOULDs level, 295 pairs against 309. Under item 11 only DRAFT and SPLIT stay in.
  - Items 7 and 20, and item 5 kept as worded, put every row out. DRAFT is then level first with SPLIT and the five COMP-like rows ([VERDICT 7.4][v74]).
  - Item 14 (no shared tier) fails its OPS-14, since its log tier is shared ([VERDICT 7.3][v73]).
  - Item 19 (the clique reading): as worded, DRAFT and SPLIT lead with 2 MUSTs.
- **To beat COMP2 by rule 3** it would need 4 fewer novel mechanisms (1 against 3). With 1 to 3 fewer, it would also need a seventh SHOULD. Its neighbour with client sessions (D `sess`) has 4, on 6 guessed cells.
- **Owed for its own options** ([AMENDMENTS 3][am3]): `+wit` and the planner half of C were never modelled. The grow rule run by each leader was never simulated beyond the halving that fails ([E-18]). The dedup window was never checked beside fence tokens (RR-05, E-32's crossing). The `memory` rung inside Raft was never modelled (K-09).

## Twins and neighbours

All from `python3 tools/closure.py row '<change>' DRAFT`, restated.
- **DRAFT C=self** (no planner) and **DRAFT H=srv** tie it on every count (5 novel, 5 SHOULDs, 309 pairs), with no guessed cell.
- **DRAFT L=ts** ties it on rule 3's counts with 98 open MUSTs, on one guessed cell (PERF-08).
- **DRAFT Z=par** (5 / 6 / 325, no guessed cell) beats it by one SHOULD, F-22 S.
- **DRAFT C=cent-co** (5 / 5 / 289, one guessed cell, F-12) beats it on pairs.
- **SPLIT** is two options away (P `split`, O `off+lin`). It beats DRAFT on pairs ([B.2][ob2]). DRAFT meets P-17 and TEST-12, which SPLIT leaves open.
- **COMP** is eight options away and beats it by 2 novel. Restated, they differ only on DEP-15 S, open here and not met for COMP.

## The evidence

- [E-18][]: as worded, 12 to 22 effective writers for every design; restated, 135 at 4,096 slots. The draft's grow rule alone leaves max/mean group load 1.5 to nearly 2.
- [E-38][]: 5 of 280 five-node partial partitions stuck with the leader up, on etcd's Raft.
- [E-20][]: the dedup window needs 17 rules against 13 for client sessions. AMENDMENTS counts 19 against 14 under forwarding.
- [E-44][]: a dedup window failed past its horizon on a real system (JetStream).
- [E-16][]: healing by each leader needs 14 rules; the controller loop needs 18.
- [E-37][]: with `rejoin`, two replicas with one bad entry each are never writable without F-12. With `par`, when the bad entries sit at different offsets, all 276 judged states with one bad entry on each of two replicas reach a working leader (565,222 states explored).
- [E-26][]: a dormant group costs 57 B of memory and 24 B on disk, and wakes in 3.3 to 3.5 ms.
- [E-41][]: $5.17 to $5.54 a month at 10 writes a second on Fly; $0.04 asleep.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/DRAFT.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS 3][am3]
- VERDICT: [section 2][v2] (outcome A), [3.1][v31] (the 20 study rows), [section 6][v6] (its one-line standing), [7.4][v74] and [section 8][s8] items 5, 11, 14, 17 and 19
- Neighbours: [SPLIT](SPLIT.md), [COMP](COMP.md), [COMP2](COMP2.md)

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v31]: ../VERDICT.md#31-the-20-study-rows
[v6]: ../VERDICT.md#6-every-other-row
[v73]: ../VERDICT.md#73-every-flip-in-outcome-a3-and-b3
[v74]: ../VERDICT.md#74-the-sweep-over-all-31-rows
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob2]: ../judging/OUTCOME.md#b2-the-ranking
[card]: ../judging/rows/DRAFT.md
[s2]: ../SPACE.md#2-the-axes
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-10]: ../experiments/E10-raft-port/README.md
[E-16]: ../experiments/E16-controller-loop/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-20]: ../experiments/E20-dedup/README.md
[E-26]: ../experiments/E26-dormant-groups/README.md
[E-37]: ../experiments/E37-bad-entry/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
[E-44]: ../experiments/E44-outside-log/README.md
