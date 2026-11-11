# RUST: MIN with a Rust core and raft-rs from the first build

**Verdict.** On [VERDICT.md's frame](../VERDICT.md#8-what-the-user-must-confirm) (strict DATA-01, clauses restated, no PERF-01 loss), RUST is out. It fails one MUST, PERF-04 (NATS JetStream), because its only durable rung is `persisted` (a rung is what a commit means; see the [key of terms][key]). Let back in, it still loses to COMP2 and MIN-P+par by [rule 3][rule]: 4 novel mechanisms against their 3, and 5 SHOULDs against their 6. The loose DATA-01 reading changes nothing for it, since `data` still folds in JavaScript. If the user accepts JetStream's default test line as a loss, it comes back in, but MIN-P+par (strict) or TiKV-persisted (loose) wins ([matrix]). As worded, it fails 5 MUSTs and shares 9th place of 20 ([OUTCOME A.2][oa2]).

## In short

- **Where writes go.** As in MIN, each resource's keys hash into 4,096 fixed slots. Each resource has its own Raft groups, which own sets of slots. Any server forwards a write to the group's leader.
- **How replicas agree.** Raft, through raft-rs, TiKV's Rust port of etcd's Raft. It is called from Node through napi from day one.
- **Who heals and moves.** One loop on `#meta`'s leader heals replicas and moves slots. `#meta` is the project's own system group.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the answer.
- **Where rows fold.** Every full replica folds the rows with `data`, in JavaScript. The Rust core hands records over in batches (A-30's call rule, [E-03]).
- **Language.** A Rust core with TypeScript bindings. User code, methods and `data` stay in JavaScript.
- **Where it comes from.** SPACE's row RUST, "MIN with a Rust core and raft-rs from day one" ([SPACE 4.2][s42]). It copies TiKV's raft-rs and the napi-rs pattern of tools such as SWC.

## Its line

The options are SPACE's, as [AMENDMENTS section 3][am3] fixed them. Only L and I differ from MIN.

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
| F: where rows fold | `all` | every full replica folds with `data` |
| W: reads | `any ridx` | from any ready replica at a position, or by read index |
| U: where user code runs | `any` | methods run on the server the caller reached |
| H: where fero runs | `emb` | inside the app's own Node process |
| L: language | `rs+napi` | a Rust core from day one, with TypeScript bindings |
| I: the Raft core | `raft-rs` | raft-rs through napi |
| Y: how a write reaches its leader | `fwd` | any server takes it and forwards it |
| M: threads | `kw` | the kernel on its own thread, apart from user code |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `proc` | one process (one Fly app) per project |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading moves none of these numbers.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 5: PERF-04, SC-03, SC-10, F-15, F-17 (gap ÷ bar 1.39) | 1: PERF-04 (gap 0.07) |
| MUSTs open | 94 | 97 |
| MUSTs met | 33 | 34 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark in the store's manifest, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 253 | 253 |
| Rank | 9th of 20, level with MIN, LEAN, LANE, MIN-P, MIN-TS and SIDE ([A.2][oa2]) | out on PERF-04; with it waived alone, 1st of 20 ([B.4][ob4]) |

**Against the winner.** Rule 3 looks at novel mechanisms first, but only when two rows are 2 or more apart. RUST (4) and COMP2 (3) are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. Rust's speed does not help: the disks set this floor. Restating does not save it; user choice item 2 opens it ([section 8][s8]).
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded, the hottest partition takes 5.5 to 9.8 % of a skewed load. So every design reaches only 12 to 22 effective writers, against F_w = 64. Gap 0.66. Restated with the app split, a slot row states 135 at 4,096 slots, so it is open. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). As worded, the writer ceiling of 12 to 22 sits below its floor of 64. Gap 0.66. Restated, it is open: 135 is stated, but no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-15 (Outside services).** Structural. A slot move records its new epoch in the object store before use ([E-33]'s rule, A-08). So a move waits while the store is down. Restated, it is open. Item 11 keeps it failed.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck ([E-38]). Restated, it is open. Item 7 restates it; item 19 (the clique reading) opens it as worded.

## What it does well

- **No cell** is met for RUST and open or failed for all three leading rows (COMP2, MIN-P+par, TiKV-TS).
- **P-10, P-15 and F-02 are met, where COMP2 leaves them open.** It has no `memory` rung, so no lost unsynced tail can undo them (RR-11 to RR-13). MIN-P+par meets them too.
- **DATA-09 is met by construction:** the Rust core never folds, and `data` folds in JavaScript. VERDICT's design rule for COMP2 borrows exactly this reason ([VERDICT 3.3][v33]).
- **Its gains are in cells still open for everyone.** A Rust kernel compiled to WASM can serve as the simulator's kernel ([E-04]). Without the disk limit, a native build has a tighter tail ([E-02]).
- **Its losses against MIN-TS:** TEST-10, TEST-13 and DEP-20 are open for RUST. raft-rs cannot run etcd's test files. No package with a prebuilt addon per platform was made ([scorecard][card]).

## What would change its verdict

- **Item 2 (the PERF-01 loss).** It comes back in. But MIN-P+par still beats it on one SHOULD, and TiKV-persisted on the novel count (loose reading).
- **Items 5, 7 and 20.** Each puts every row out, RUST with them. Item 11 keeps its F-15 failed.
- **Step 8 (the native step)** ([section 9][s9]). COMP2 goes native later only for rows TypeScript does not win. Under COMP2's design rule, its Rust core holds only the journal, Raft and the log, as RUST's does. So RUST's shape is close to COMP2's later phase, not a rival to it.
- **G-24.** raft-rs 0.7.0 cannot run etcd's files and lacks StepDownOnRemoval, so A-01 is only reasoned for it ([E-10]). The gap decides which Rust core RUST uses, and COMP2's native step faces the same choice ([AMENDMENTS 5][am5]).
- **Owed** ([scorecard][card]):
  - TEST-10: the native build compared with the WASM build under A-30's guard.
  - TEST-13: E-46's Maelstrom adapter around raft-rs.
  - DEP-20: a tarball test with the addon built for each platform.

## Twins and neighbours

- **MIN and MIN-TS** tie RUST on rule 3's counts: 4 novel, 5 SHOULDs, 253 pairs. RUST meets DATA-09, which MIN leaves open. MIN meets DEP-20 and TEST-13, which RUST leaves open. Open MUSTs: MIN-TS 94, MIN 96, RUST 97.
- **RUST with G `pslot`** (an unjudged mix with no guessed cell): 3 novel, 5 SHOULDs, 252 pairs. It beats RUST on pairs (`python3 tools/closure.py row 'G=pslot' RUST`).
- **RUST with Z `par`** (unjudged, no guessed cell): 4 novel, 6 SHOULDs, 266 pairs.
- **COMP2 and MIN-P+par with RUST's core** (L `rs+napi`, I `raft-rs`). COMP2's version is a twin with one guessed cell on the strict ladder ([VERDICT 4.4][v44]). MIN-P+par's version is among the unbeaten rows at 0 guessed cells when the loss is accepted ([strict loss ladder][lad]).

## The evidence

- [E-10](../experiments/E10-raft-port/README.md): raft-rs runs 0 of etcd's 28 interaction files; the TypeScript port passes all 41 of etcd's files.
- [E-04](../experiments/E04-wasm-kernel/README.md): a Rust kernel in WASM runs 200 chaos seeds in 384 ms with raft-rs, against a 1 s bar.
- [E-03](../experiments/E03-napi-cost/README.md): Rust hands a 256-record batch to `data`'s fold at under 1 ns a record for the crossing.
- [E-02](../experiments/E02-pipeline/README.md): on this disk every build hits the same ceiling; without the disk limit Rust is about 2.5 times TypeScript.
- [E-09e](../experiments/E09e-etcd/README.md): etcd's one-client put has p99 1.73 ms; E-02's Rust tail was 1.58 ms, its TypeScript tail 2.4 to 4.3 ms.
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms.
- [E-41](../experiments/E41-hosted-cost/README.md): MIN's shape, RUST included, costs $7.52 to $7.89 a month at 10 writes a second on Fly. RUST gains nothing from its language at these loads.

## Links

- Scorecard: [judging/rows/RUST.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [section 6][v6] (its one-line standing), [3.3][v33] (the design rule that copies RUST's fold), [section 9][s9] step 8

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v33]: ../VERDICT.md#33-which-data-01-reading-the-brief-supports
[v44]: ../VERDICT.md#44-step-3-rows-far-from-any-judged-row-win-only-on-guesses
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[lad]: ../judging/closure/results/ladder-restated-PERF-01_losses-DATA-01_reading.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/RUST.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[am5]: ../AMENDMENTS.md#5-what-the-evidence-left-open
[E-01]: ../experiments/E01-floors/README.md
[E-02]: ../experiments/E02-pipeline/README.md
[E-03]: ../experiments/E03-napi-cost/README.md
[E-04]: ../experiments/E04-wasm-kernel/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-10]: ../experiments/E10-raft-port/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-33]: ../experiments/E33-genesis-restore/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
