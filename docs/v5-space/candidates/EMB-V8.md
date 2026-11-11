# EMB-V8: a Rust server that runs `data`, methods and rules in embedded V8 isolates

**Verdict.** On [VERDICT.md's frame](../VERDICT.md#8-what-the-user-must-confirm) (strict DATA-01, clauses restated, no PERF-01 loss), EMB-V8 is out. It fails one MUST, PERF-04 (NATS JetStream), because its only durable rung is `persisted` (a rung is what a commit means; see the [key of terms][key]). Let back in, it still loses to COMP2 and MIN-P+par by [rule 3][rule]: 4 novel mechanisms against their 3, and 5 SHOULDs against their 6. The loose DATA-01 reading changes nothing for it, since `data`'s own code folds inside the isolates. If the user accepts JetStream's default test line as a loss, it comes back in, but MIN-P+par (strict) or TiKV-persisted (loose) wins ([matrix]). As worded, it fails 4 MUSTs and shares 5th place of 20; with the loss also accepted it is level first on both readings ([OUTCOME A.2][oa2], [matrix]).

## In short

- **Where writes go.** Smart clients cache which server leads each slot and send writes straight there. Keys hash into 4,096 fixed slots per resource.
- **How replicas agree.** Raft inside a Rust server, on raft-rs, TiKV's Rust port of etcd's Raft.
- **Who heals and moves.** One loop on `#meta`'s leader heals replicas and moves slots. `#meta` is the project's own system group.
- **What a commit means.** Only `persisted`: a majority has the write on disk before the answer.
- **Where rows fold.** Every replica folds with `data`, inside V8 isolates in the server (deno_core). Methods and rules run there too.
- **Tenancy.** Many projects share one server process, each in its own isolates.
- **Where it comes from.** SPACE's row EMB-V8, "SRV with V8 embedded" ([SPACE 4.2][s42]). It copies Cloudflare's workerd (Durable Objects) and Deno.

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
| S: storage | `jrnl +tier` | one journal per process, plus an object-store tier; founded by `fero init`, so the restore mark's home is left open (G-21) |
| F: where rows fold | `all(isolates)` | every replica folds with `data`, inside V8 isolates |
| W: reads | `any ridx` | from any ready replica at a position, or by read index |
| U: where user code runs | `any` | methods run on the server the caller reached, in isolates |
| H: where fero runs | `srv` | a separate server binary; apps are clients |
| L: language | `rs+v8` | a Rust server that embeds V8 through deno_core |
| I: the Raft core | `raft-rs` | raft-rs, inside the server |
| Y: how a write reaches its leader | `smart` | the client holds the slot table and sends to the leader |
| M: threads | `kwN` | several kernel threads; each group pinned to one |
| Z: storage faults | `rejoin` | a checksum per entry; a damaged replica is wiped and rejoins as new |
| N: tenancy | `pool` | many projects per process; user code in V8 isolates |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. The strict DATA-01 reading moves none of these numbers.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 4: PERF-04, SC-03, SC-10, F-17 (gap ÷ bar 1.39) | 1: PERF-04 (gap 0.07) |
| MUSTs open | 97 | 99 |
| MUSTs met | 31 | 32 |
| SHOULDs met | 5: P-22, SC-12, DEV-04, DEV-05, OPS-11 | the same 5 |
| Novel mechanisms | 4: dormant groups, the slot move, the restore mark, one process per dir (the dir lease) | the same 4 |
| Interacting pairs | 269 | 269 |
| Rank | 5th of 20, level with SRV, SLOG and RLOG ([A.2][oa2]) | out on PERF-04; with it waived alone, 1st of 20 ([B.4][ob4]) |

**Against the winner.** Rule 3 looks at novel mechanisms first, but only when two rows are 2 or more apart. EMB-V8 (4) and COMP2 (3) are 1 apart, so SHOULDs decide, and COMP2 meets 6 against 5 (F-22 S, from `par`).

## What fails, and the proof

- **PERF-04 (NATS JetStream).** A ceiling, reasoned from measured parts. JetStream's default answers one publisher at p99 0.55 ms ([E-09b]). PERF-01's spread rule puts a win below about 0.303 ms. The best `persisted` commit here has p99 0.323 ms with no network at all ([E-01]; RR-15). Gap 0.07. Restating does not save it; user choice item 2 opens it ([section 8][s8]).
- **SC-03 (Scale writes up).** A ceiling, simulated ([E-18]). As worded, the hottest partition takes 5.5 to 9.8 % of a skewed load. So every design reaches only 12 to 22 effective writers, against F_w = 64. Gap 0.66. Restated with the app split, a slot row states 135 at 4,096 slots, so it is open. Item 5 (F_w above 135) would fail it again.
- **SC-10 (Only stated ceilings, each above its floor).** The same ceiling ([E-18]). As worded, the writer ceiling of 12 to 22 sits below its floor of 64. Gap 0.66. Restated, it is open: 135 is stated, but no ceiling is pinned yet (G-06). Item 5 bears on it the same way.
- **F-17 (Partial partitions).** A counterexample. In 5 of 280 five-node partial partitions with the leader up, etcd's own Raft stayed stuck ([E-38]). Restated, it is open. Item 7 restates it; item 19 (the clique reading) opens it as worded.

## What it does well

- **No cell** is met for EMB-V8 and open or failed for all three leading rows (COMP2, MIN-P+par, TiKV-TS).
- **F-15 (Outside services) is open as worded, not failed.** It founds by `fero init`, and A-08 leaves its mark's home open ([VERDICT 2][v2]). COMP2's family fails F-15 as worded. Both still fail 4 MUSTs as worded, since EMB-V8 fails PERF-04 instead.
- **P-10, P-15 and F-02 are met, where COMP2 leaves them open.** It has no `memory` rung (RR-11 to RR-13). MIN-P+par meets them too.
- **DATA-09 is met by construction:** `data`'s own code folds inside the isolates ([E-03]).
- **The cheapest row asleep in E-41:** $0.00. At 10 writes a second on Fly it costs $6.02 to $6.38, under MIN's shape at $7.52 to $7.89 ([E-41]).

## What would change its verdict

- **Item 2 (the PERF-01 loss).** It comes back in, restated. But 13 of the 31 judged rows then beat it on the strict reading, MIN-P+par among them (computed here: `repro rank --strict --loss`). As worded, the loss puts it level first among the 20 with DRAFT, SRV, SPLIT, ISR, SLOG and RLOG ([OUTCOME A.3][oa3]).
- **Item 14 (no tier shared between projects).** Its OPS-14 then fails: J does not allow a pooled process ([scorecard][card]).
- **Items 5, 7 and 20.** Each puts every row out, EMB-V8 with them.
- **Kill criteria for every slot row** ([section 9][s9]). A slot move that breaks beside a membership change (K-01), or a phase-4 writer count under 64, would put it out with COMP2. None of them lifts it.
- **Owed, for its own open cells** ([scorecard][card]):
  - F-14: a stall and a throw injected inside an isolate. E-07's stall test ran a Node kernel, not this server.
  - DEP-18 and OPS-14: how each pooled project keeps its own id and dir (G-25), and A-29's byte budget per tenant.
  - DEP-20 and TEST-10: the roughly 30 MB binary shipped through npm, and the native build checked against the WASM build.

## Twins and neighbours

- **SRV** is its base: the same server with no V8. EMB-V8 meets P-04, DATA-09, TEST-01, TEST-02 and TEST-07, which SRV leaves open. SRV meets F-14 and DEP-18, which EMB-V8 leaves open. Pairs: 269 against SRV's 267.
- **One option changed** (unjudged mixes with no guessed cell; `python3 tools/closure.py row '<change>' EMB-V8`):
  - Y `fwd` (any server forwards writes): 4 novel, 5 SHOULDs, 261 pairs. This is the same change that makes SRV V=full Y=fwd 8 pairs cheaper than SRV.
  - N `proc` (one process per project): 267 pairs and 98 open MUSTs.
  - Z `par`: 4 novel, 6 SHOULDs, 284 pairs.

## The evidence

- [E-03](../experiments/E03-napi-cost/README.md): a deno_core op costs 2.6 ns; `data`'s fold inside it times at 0.80 times Node 22's figure, inside the 1.2 times bar.
- [E-03](../experiments/E03-napi-cost/README.md): QuickJS folds 16 to 18 times slower than Node, so that variant was pruned.
- [E-43](../experiments/E43-fold-versions/README.md): Node 22 and Node 26 fold 1,000,000 records to the same rows (0 differ).
- [E-35](../experiments/E35-neighbours/README.md): on a shared journal a tenant at its quota raised another tenant's p99 by 1.40 to 1.59 times, against SC-11's 1.1.
- [E-41](../experiments/E41-hosted-cost/README.md): $0.00 asleep, $6.02 to $6.38 at 10 writes a second, and $158 to $342 at 5,000 writes a second on Fly.
- [E-09b](../experiments/E09b-nats/README.md): JetStream's default acks one publisher at p99 0.55 ms.
- [E-18](../experiments/E18-slot-balance/README.md): 135 effective writers at 4,096 slots with the app split; 12 to 22 as worded.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/EMB-V8.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS section 3][am3]
- VERDICT: [section 6][v6] (its one-line standing: "as MIN"; and E-41's costs under the table)

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v6]: ../VERDICT.md#6-every-other-row
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[matrix]: ../judging/closure/results/matrix.md
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[oa3]: ../judging/OUTCOME.md#a3-what-flips-the-winner
[ob4]: ../judging/OUTCOME.md#b4-rows-that-one-or-two-musts-put-out
[card]: ../judging/rows/EMB-V8.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-01]: ../experiments/E01-floors/README.md
[E-03]: ../experiments/E03-napi-cost/README.md
[E-09b]: ../experiments/E09b-nats/README.md
[E-18]: ../experiments/E18-slot-balance/README.md
[E-38]: ../experiments/E38-raft-gray-failures/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
