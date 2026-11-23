# E-64: four ways past one process, built small

**Question.** In v5 a resource's rows hash into 4,096 slots, and Raft groups own the slots (V5-2). Every feature that works over every row (served views, `{ pages }`, `derive`'s view form, root operators, `hold: 'all'`, a root `changes()` reader) rests today on TRANSFORMS' rule R0: one process holds every row and folds every write. That stops at about 1e6 to 5e6 rows and about 5 leaders' writes ([GROUPS.md](../../GROUPS.md) G5, G6). The owner asked to design the way past one process now (V5-18 pick 2), and first to understand E-23's "merger" and its alternatives, including whether `derive` can work from changes alone. E-64 asks: **built small and checked by seeded oracles with planted bugs, which ways past one process are exact, what does a client see with each, and what does each cost?** The page built on these results is [MERGE.md](../../MERGE.md).

## The answer first

- **All four ways rest on one new piece** *(checked in O1, O2, O4; reasoned in O3)*: on one copy of each group, a feed of each changed row **before and after** the change. `data` already hands every fold the row before it (`prev`). The log alone cannot do this: a field write carries no row, so the old bucket is unknown (O2's planted `nobefore` failed 1,000 of 1,000 seeds).
- **O1, the merger** (E-23's design): each group keeps the view over its own rows (a **partial**) and one merger adds the partials up by key. Exact in 282,540 checks with 0 mismatches, through 1,085 paired slot moves, failovers, outages and merger rebuilds; each rule's planted bug failed 321 to 1,000 of 1,000 seeds *(checked)*. **But its run made a slot move happen at both groups in one step, and never let a partial's host fail while a move was queued.** The probe added after the skeptic shows that case fails with O1's own code: 15 or 25 rows counted where 20 are true. A fourth rule (a picture that passed a queued move is installed together with the move's other half) gives 20 in the probe; it was not run on seeds *(checked: a probe)*.
- **O2, from changes alone**: each change carries the old and new values of the fields a view reads; runners per share of slots add them up and hold no rows. Exact for counts and sums in 15,000 seeds *(checked)*. A top k needs a buffer and a rescan near the rows when it runs short. A restart of the marks form needs the old values back to its marks (in the log: +25.6 % a record), which was not built.
- **O3, partials by slot**: no waiting at a move and no pairing. A host failover loses its stream's unsent frames, a move's among them, and pictures per slot repair it: 498 failovers in runs with real three-step moves, 0 mismatches *(checked)*. The price: a cut can show part of a multi-row commit during a move (13 to 22 of about 4,000), and about 230 times the cells of pieces by 16 groups (970 MB against 4.2 MB at 1,000 buckets) *(counted, measured)*.
- **O4, shards by output key**: each changed row goes to the process that owns its answer's key (for example its user). Exact per shard in 16,000 seeds; a read of every key sees 0.22 to 0.70 of every 1,000 rows twice or nowhere unless it waits for a barrier, then exact *(checked)*. With one shard it is a narrow one-process holder: 54 to 157 B a row against R0's 303 to 354 B *(measured)*.
- **Verdict.** The merger (O1) is the widest way for views with small answers, once its fourth rule passes a seeded run with real three-step moves. Views with very many keys need O4. No option makes a live median or code over every row run without one process.

## Words

- **R0.** TRANSFORMS 3.9's rule: one process holds every row of the resource and folds every write.
- **Group, slot, copy.** A slot is one of a resource's fixed hash buckets; a group is one Raft log that owns some slots; a copy is one server's replica of one group.
- **Partial.** A view over part of the rows (one group's, one slot's, one share's), kept by a process that already has those rows or their changes.
- **Merger** (O1), **combiner** (O3), **runner** (O2), **shard** (O4). What adds the partials up into the answer a client sees.
- **Cut.** One position per group (O1) or per slot (O3, O4). A merged answer is the query over the rows at one cut.
- **Picture.** A partial's whole state at one position, sent when a stream starts or is replaced. **Frame**: what one commit changed in it.
- **Paired move.** A slot move's two halves (A's fence, B's open), taken by the merger at one cut.
- **Torn.** A multi-row commit that a cut shows only in part, or a row that a read counts twice or not at all.
- **Oracle.** The same query run from scratch on the true rows at the cut, by code that does not share the code under test. **Planted bug**: a switch that breaks one rule on purpose, to show the oracle can fail.

## The parts

| Part | What it is | Its README |
|---|---|---|
| [O1/](O1) | partials by group and a merger with E-23's rules; six merge classes; pages and an exact median by asking every group | [O1/README.md](O1/README.md) |
| [O2/](O2) | an enricher on each group's copy, runners per share with no rows, a target with an exact sum: D1 (marks over ranges) and D2 (each share's partial, replaced on restart); a top k with a buffer | [O2/README.md](O2/README.md) |
| [O3/](O3) | partials keyed by (slot, view key), stamped with the slot's position, and a combiner | [O3/README.md](O3/README.md) |
| [O4/](O4) | routers on each group's copy, K shards on `data`, pictures per slot, a barrier for a read of every key | [O4/README.md](O4/README.md) |
| [probes/](probes) | `move-failover.mjs`: O1's own code when a partial's host fails while a slot move is queued (added after the skeptic's review) | this page |

O1 and O3 are plain JavaScript beside E-57 group B's contract code (the total order, typed bucket keys, the exact sum, the chunked index), imported unchanged. O2 and O4 fold on `data` at commit `63fea66` (read only, from `../data` next to this repo) and count bytes with fero v4's codec. Everything ran on Node 22.22.0, on one 4-vCPU box shared with other studies. Nothing in `data` or E-57 was changed.

## How each claim was measured

- **The oracle.** After every delivery (O1), every frame (O3), or every 50 steps and at the end (O2, O4), each answer must equal the query run from scratch on the true rows at that cut. Sums are compared exactly.
- **Seeds and faults.** 1,000 seeds a configuration unless said; long runs of 50,000 to 100,000 commits. Faults come from the seed: slot moves, groups made and removed, host failovers, outages, lost and late batches, re-reads, rebuilds, a group down.
- **Planted bugs.** A rule passes only if the real code has 0 failures and its planted bug fails at least 100 of 1,000 seeds; a bug below that shows the rule is not needed.
- **Timing.** Three runs, each process alone on the box under the timing lock; inside a run the median of 3 to 5 rounds; a cell is the range over the runs. Load averages at process start were 1.02 to 3.27 where recorded (O2, O3, O4's results; O1 did not record them). Seeded runs ran under the heavy lock. Every process ran with at most 3.5 GB of heap.
- **Marks.** *(checked)*: a seeded run with an oracle; its line is in `results/`. *(measured)*: a timed number as above. *(counted)*: a count from a run. *(reasoned)*: an argument, not run. *(a guess)*: nobody measured it.

## Results: the claims

| # | Claim | Bar (short) | Result | Verdict |
|---|---|---|---|---|
| O1-1 | the merger is exact through moves, failovers, outages, rebuilds | 0 mismatches; every rule's planted bug fails 100+ of 1,000 | 3 long runs, 282,540 checks, 0 mismatches; 1,000 seeds at G = 4 and elastic, 0 failed; unpaired moves 582 and 321, a resync that adds 437 and 429, ties by arrival 1,000 and 999, short windows 996 and 1,000, a merged-only max 1,000 and 1,000 | pass, on the world it ran *(checked)* |
| O1-2 | E-23's rule 2 ("each key from one group") is needed | planted off fails 100+ | 0 and 0 of 1,000: once a move's halves are taken together, fence first, it never fires | rule not needed *(checked)* |
| O1-3 | a partial's host can fail while a move is queued | the answer stays right | O1's run never made this case. Probe: a new host at its head, picture installed alone: 15 rows (A fails) and 25 (B fails) of 20. With a fourth rule (install it with the move's other half): 20 | **miss** for rules 1 to 3 as built; the fourth rule is checked in the probe only *(checked: a probe)* |
| O1-4 | the merger's cost | none set | a top 10 over 1e5 rows: 0.0008 to 0.05 frames a write (random scores), 0.21 to 0.23 (rising scores); counts and exact sums with every group's sums kept: 250 to 2,881 ns a delta, two deltas a write; merged sums only: 99 to 1,079 ns, but no resync exists for that form; a page of 20 by one round: G × 20 entries, 1.2 to 2.6 ms at G = 256 in one process | *(measured, counted)* |
| O1-5 | the merger's memory | none set | at G = 256: 0.8 MB for a top 10, 7.4 MB for a top 100; sums 394 B per (group, bucket) kept, 631 MB at 1e5 buckets and 16 groups | *(measured)* |
| O2-1 | counts and exact sums from enriched changes, no rows held | 0 wrong; planted bugs fail 100+ | D1: 11 configurations and 2 long runs, D2: 4 and 1, 0 seeds wrong; planted 353 to 1,000, except D2's token alone (2: its position check covers it) | pass *(checked)* |
| O2-2 | a top k from changes | 0 wrong | 3 configurations, 0 wrong; planted 725 and 867; rescans 0 to 10 per 1e6 changes for most workloads, 70 to 2,104 when the best row is often removed, 31 to 40 ms each at 1e6 rows | pass, with rescans near the rows *(checked, measured)* |
| O2-3 | the enricher's cost | none set | +0.1 to 0.4 µs a record on the copy, inside the fold's spread; the old values of two fields in the log: +13.9 B, +25.6 % a record | *(measured)* |
| O2-4 | buckets spread over target partitions | none set | each partition exact at its own cut; 0.07 to 0.36 % of rows checked counted twice or nowhere across partitions | *(checked, counted)* |
| O3-1 | partials by slot are exact | 0 mismatches; planted bugs fail 100+ | 4 long runs, 397,360 checks, 0 mismatches, through 8,096 three-step moves and 498 host failovers; 1,000 seeds at 4 and 1 to 16 groups, 0 failed; planted 240 to 1,000 | pass *(checked)* |
| O3-2 | a cut by slot keeps a commit whole | — | 13 to 22 of 3,512 to 4,651 multi-row commits shown in part with fixed groups; 530 and 552 with groups coming and going | torn, rarely *(counted)* |
| O3-3 | the slot key's price | none set | about 240 B a (slot, bucket) cell: 15.8 MB at 16 buckets, 970 MB at 1,000; a top 10 over 1e5 rows makes 0.55 to 0.63 frames a write by slot against 0.0009 to 0.05 by group | *(measured, counted)* |
| O4-1 | a view sharded by output key is exact per shard | 0 failed; planted bugs fail 100+ | 16 configurations of 1,000 seeds, 496,000 checks, 0 failed, through 106,643 slot moves and 79,722 router crashes; planted 453 to 1,000; one rule not needed (`nofilter`, 0) | pass *(checked)* |
| O4-2 | a read of every key | exact at one cut | without a barrier 0.22 to 0.70 of every 1,000 rows twice or nowhere (0 with one shard); with a barrier 26,928 exact | pass with the barrier *(checked)* |
| O4-3 | the router and a shard | none set | the router +0.35 to 1.3 µs a record, +1.7 to 2.8 µs with its messages encoded; a shard of 16: 54 to 157 B a row, 0.13 to 0.42 µs of its time a source write; 37 to 38 B of messages a source record against 54.7 B for the log record | *(measured)* |

The full tables are in each option's `results/summary.md` and README.

## Verdict

- **The merger (O1)** is the widest way for views with small answers (top k, counts and sums with few buckets, min, max, filters, `distinct`, `some`, `every`) and for pages read by asking every group. It holds no rows, and for a top k it is nearly idle. It is not ready as built: it needs a fourth rule for a host that fails while a move is queued, run on seeds with real three-step moves, and its sums need every group's sums kept (394 B per group and bucket) until a cheaper resync is built.
- **From changes alone (O2)** works for counts, sums and averages with no rows anywhere. Its marks form needs the old values back to its marks on a restart, which nothing built; its replace form changes the shape of `derive`'s target.
- **By slot (O3)** never waits at a move and survives a host failover in runs with real moves, but may show part of a commit and costs many more cells (about 230 times those by 16 groups at 1,000 buckets).
- **By output key (O4)** is the way for views with very many keys, per-key windows and medians; a read of every key needs a barrier. Its front, shard map and ranges were not built.

Decided: V5-20 ships the merger in the first build and puts O4 next (items 1 and 10); E-67 ran the fourth rule on seeds, and V5-22 took the form that passed.

## What this cannot show

- **No network, no Raft, no threads.** In every option, groups are lists in one process and links are queues. No byte crossed a socket; the extra hop is reasoned.
- **O1's move is one step at the groups**, and a resync's picture never passes a queued move. The probe shows what that hides; a seeded run with three-step moves and hosts that resume at their heads is owed (run since in E-67; V5-22 took its result).
- **O1's and O3's partials are plain code**, not `data` 5's views. O1's partial rescans a bucket's rows for a max or `distinct` on every write that touches it, and that work was not timed here (E-67 timed it: 514 to 559 µs a record at about 2,000 rows a bucket).
- **Reads at a pinned position** (a two-round page, an exact median) ran at the groups' heads with no write between rounds.
- **Batching**: one frame per commit everywhere; frames per commit batch were not timed.
- **Faults are drawn, not exhaustive**: no model checker ran any of this.
- **Timing quality**: one shared 4-vCPU box; differences inside a range are not claims.

## Files and how to rerun

- `run.sh`: every option in turn, or one: `./run.sh o1 [step]` (and `o2`, `o3`, `o4`), each option's steps as its own `run.sh` lists them; `./run.sh quick` (a smoke run of all, about five minutes, no locks, nothing written to `results/`); `./run.sh probe`; `./run.sh summary`. `SP` names a scratch folder holding `bin/timing` and `bin/heavy`; without it the locks are skipped. `DATA` overrides `data`'s folder.
- `O1/` to `O4/`: each has `src/` (and `sim/`, `bench/`), `run.sh`, `README.md` and `results/` (raw JSON lines and `summary.md`).
- `probes/move-failover.mjs` and its output `probes/move-failover.out`.
