# E-64 O3: partials per group, pushed down, merged by key

**Question.** Can each group work out its own piece of a view over every row, next to its rows, and send it to a **combiner** that adds the pieces up by key, so that no process holds or folds the whole resource? This is option O3 of E-64 ("past one process"): map-reduce, or TRANSFORMS' class B run per group. What happens to a piece when a slot moves? What does a client then see? What does it cost? And which piece is cheaper: one per **group** (E-23's and O1's merger) or one per **slot** (this option's idea)?

**Words.** A **group** owns some of a resource's slots. A **partial** is a view over part of the rows, kept by a copy that holds them. A **cell** is one piece of a partial's state (a count, an exact sum, a max, a short list of rows). A **frame** is what one group commit changed in the partials: for each slot it touched, the positions it covers, (from, to], and the changed cells as whole new values. A **picture** is a slot's whole cells at one position. The **combiner** adds the partials up by key. A **cut** is one position per slot. A **torn** commit is a commit of several rows of one group that a cut shows only in part.

<!-- answer:start -->
## The answer first

- **Exact through everything the runs threw at it** *(checked)*. Four long runs (4, 16, and 1 to 16 groups, the last also with the import copy published early; 100,000 commits each) compared seven answers with the query at the combiner's cut at 397,360 points: 0 mismatches, through 8,096 slot moves of 217,143 slots, 1,490 groups made and 1,462 removed, 498 copy failovers, 205 outages, 523 duplicate frames, 64,528 merged runs of frames and 146 combiner rebuilds; 0 gaps, no position back. 1,000 short seeds each at 4 and 1 to 16 groups: 0 failed.
- **Each rule has teeth** *(checked, seeds failed of 1,000 at 4 / 1 to 16 groups)*: S2's position check off 240 / 824; S3 off 404 / 403; a picture that merges 417 / 860; merged frames that keep only the later changes 989 / 989; ties by arrival, one merged max, rounded sums 1,000 / 1,000 each; cells keyed by group with no move pairing 973 / 999.
- **B1's R2 shrinks to "only a slot's owner sends its picture"** *(checked)*. Publishing the import copy before the slot opens kept every answer equal to the query at the cut, but in 2 of 1,000 seeds with groups coming and going a new combiner took such a picture and started behind what the old one had shown.
- **A cut can show part of a multi-row commit during a move** *(counted)*: 13 to 22 of 3,512 to 4,651 multi-row commits with fixed groups, 530 and 552 of about 4,550 with groups coming and going. The cut is per slot, as R0's store's is; a cut paired per group (O1) never splits one.
- **The price of the slot key is cells** *(measured)*: about 240 B a (slot, bucket) cell for a count and an exact sum, so 4,096 slots × 16, 100, 1,000 buckets is 15.8 MB, 100 MB, 970 MB, against 4.2 MB keyed by 16 groups at 1,000 buckets and 0.3 MB for merged totals only. A top 10 by slot keeps 40,960 candidates (5.8 MB).
- **Windows by slot are chatty** *(counted)*: a top 10 over 1e5 rows makes 0.63 frames a write by slot, against 0.0009 to 0.051 by group (G = 4 to 256); a top 100 over 1e5 rows makes one every write. At 1e6 rows, 0.081 by slot.
- **Whole values cost CPU** *(measured)*: counts and exact sums per bucket cost the copy 2.1 to 3.8 µs a write and the combiner 1.9 to 4.0 µs a frame; the delta form 0.23 to 0.60 µs and 0.47 to 0.93 µs. Each slot's top 10 costs the combiner 11.5 to 15.4 µs a frame; a filter 0.28 to 1.5 µs.
- **A partials resource keyed by slot nearly doubles the writes** *(counted)*: at 50,000 writes a second, 0.94, 0.58 and 0.082 partial-row writes per source write with frames merged over 10 ms, 100 ms and 1 s; keyed by 16 groups, 0.032, 0.0032 and 0.00032.

<!-- answer:end -->

## The design built

Each cell is keyed by (slot, view key) and stamped with the slot's position. The combiner keeps, per slot, its position and cells, and three rules (`src/partial.mjs`):
- **S1.** Cells are keyed by slot; every frame names its slot range (from, to].
- **S2.** Per slot, the newest wins with no gap: a frame applies when from ≤ position < to and is dropped when to ≤ position; a picture replaces the slot's cells whole when it is newer.
- **S3.** A stream starts every slot with its picture, sent by the slot's owner: when a copy opens a slot after a move, and when a stream (re)starts after a failover or for a new combiner.

These are E-57 B1's R1 and R2 applied to partials instead of rows. Since a slot move carries the slot's position (E-19), a move is invisible to the combiner: nothing pairs the move's two halves, nothing waits, and a failover replaces slots, never a group's whole contribution.

## Method

Everything is plain JavaScript on Node 22, in one process; no network, no Raft, no `data`. The merge contract's definitions (the total order with key ties, typed bucket keys, the numeric projection, the exact sum, the dirty rows) and the chunked ordered index are imported unchanged from E-57 group B (`b-merge/src/lib.mjs`, `index.mjs`), so the partials are judged by the contract E-57 checked.

**The seeded run** (`sim/sim.mjs`) uses E-57 B1's world: one resource of 1,024 slots (E-23's count: more rows a slot than 4,096, so a harder test) over G = 4, 16, or elastic groups (1 to 16: a grow moves half of a group's slots to a new group, a shrink moves all of a group's slots out), 3,000 keys in E-23's dirty domain, the three-step slot move of LAYERS 8.6, and 5 % of commits touching several rows of one group. Each group has one **host**, a copy that folds the group's log at its head and keeps, per slot, the cells of seven answers: `length()`, an exact `sum('points')`, per `room` a count, an exact sum and a max, `za('points', 10)` with key ties, and `gt('points', 50)`'s rows. In the sim a host works its slot's cells out again from the slot's few rows on every change (correct by construction: the host is not what is under test; the bench times the incremental form). One **combiner** takes frames from the G streams in its own interleaving, 0 to 3 a step, and never more than 100 behind a stream. Faults, drawn from the seed: a **host failover** (the stream's undelivered frames are lost; a new copy folds the group's log and starts a new stream with pictures, 1 in 900 steps), an **outage** (a stream sends nothing for 50 to 300 steps, then goes on or fails over, 1 in 1,500), a **duplicate** (a recent frame comes again, 1 in 700), **merged frames** (a run of 2 to 6 frames at a stream's head becomes one, as a slow reader is folded, 1 delivery in 5), and a **combiner rebuild** (every stream restarts with pictures; answers wait until every slot has one, 1 in 2,500).

**The oracle**, after every frame the combiner takes while it has a picture of every slot: each answer against the query run from scratch on the true rows at the combiner's cut, folded apart from each slot's own record log by code that shares only the contract's definitions with the partials. The filter's rows are checked for the touched keys, and in full every 1,000 frames. Also: no slot's position goes back, no frame ever arrives past a gap, and after the run drains, the cut is every slot's head. The run also counts **torn** multi-row commits (every 50 frames, over the last 300 multi-slot commits): a measure, not a bug.

**Planted bugs** (`--mutate`), each run on the same 1,000 short seeds as the real code (400 commits, 300 keys): `nor1` (S2's position check off), `nopicture` (S3 off: no picture at open or at a new stream), `mergepic` (a picture merges instead of replacing), `coalescedrop` (merging two frames keeps only the later one's changes), `ties` (ties by arrival), `extmerged` (the combiner keeps one merged max per bucket), `rounded` (sum cells carry a rounded value), `pergroup` (cells keyed by group, with no move pairing: E-23 without its rule 3). **A variant expected to pass**: `--early`, the importing group publishes its copy of a slot at import, before the slot opens (B1's R2 dropped).

**The cost bench** (`bench/bench.mjs`), S = 4,096 slots (LAYERS' count), rows `{ id, points, room }` with integer scores up to 1e6, one part per process, three runs in one hold of the timing lock (each process alone on the box); inside a run the median of 5 rounds after a warm-up, a full collection before each round:
- `host`: a copy keeps per-slot partials incrementally on 200,000 uniform writes (10 % change bucket): count and exact sum per bucket (B = 16 and 1,000), the same with max per bucket, each slot's top 10 (a rescan of the slot's rows when one of its top rows changes), and a filter; N = 1e5 and 1e6 rows. ns a write, frame entries and cells a write.
- `comb`: the combiner applies those frames, from every slot's picture. ns a frame entry, a cell and a write.
- `rate` (counts): frames a write for a window, partials by slot against by group (G = 4, 16, 64, 256), top 10 and 100, N = 1e5 and 1e6, uniform scores and rising ones (a Zipf 0.99 row's score goes up).
- `coalesce` (counts): partial-row writes per source write when frames are merged per slot (or per group, G = 16) over a window of 10 ms, 100 ms or 1 s, at 1e4, 5e4 and 2e5 writes a second over 1e6 keys, uniform and Zipf: what a partials **resource** written through Raft would take.
- `mem`: the combiner's heap after a full collection for cells per (slot, bucket), per (group, bucket) at G = 16 and 256, and merged totals only, with B = 1, 16, 100, 1,000; a max per bucket; a window's candidates.
- `delta`: the delta form, for comparison: a frame carries (bucket out, value out, bucket in, value in), and the combiner keeps merged totals only; the copy's and the combiner's ns.
- `bytes` (counts): JSON bytes of frame entries per write and of one slot's picture.

## Results

The tables are in [results/summary.md](results/summary.md); the raw lines in `results/sim.jsonl` and `results/bench.jsonl` (each timed process's line follows a line with the load average when it was queued: 1.17 to 3.27). The seeded runs ran three at a time under the heavy lock; the cost bench ran its three runs in one hold of the timing lock, each process alone on the box.

**Seeded runs.** The long runs' table (checks, moves, groups made and removed, failovers, outages, duplicates, merged runs, rebuilds, pictures, frames dropped by S2, torn commits) and the 1,000-seed table (real code, the `early` variant and the eight planted bugs at 4 and 1 to 16 groups) are the first two tables of the summary. What they measured: the answers of a combiner that holds per-slot cells only, against the query over the true rows at its cut, after every frame it took.

**Cost.** What each part measured:
- `host`: the time a copy spends keeping per-slot cells on one write, with the frame's cells built (exact-sum states copied). Not the fold itself, and not encoding.
- `comb`: the time the combiner spends applying one frame entry (taking old cells out, putting new ones in, keeping a window's candidates in E-57's chunked index), from frames recorded by the host part. Not decoding: the page adds E-03's 0.7 µs a frame for that.
- `delta`: the same two costs when a frame carries "bucket out, value out, bucket in, value in" and the combiner keeps merged totals only.
- `rate`, `coalesce`, `bytes`: counts, not times.
- `mem`: the heap a combiner's state takes after a full collection; the row for 16 window partials is below the heap's noise.

## Files and how to rerun

- `src/lib.mjs` E-57's contract helpers, a slot hash for any slot count, and an exact sum's state that can be added and taken out whole; `src/partial.mjs` the host, the frames, merging, and the combiner with S1 to S3.
- `sim/sim.mjs` the seeded run; `bench/bench.mjs` the cost bench; `bench/summarize.mjs` the tables.
- `./run.sh quick` (a smoke run, nothing written), `./run.sh sim`, `./run.sh bench`, `./run.sh S`, `./run.sh all`. `SP` names a folder with `bin/heavy` and `bin/timing` lock wrappers, if there are any.

## What this does not show

- **Real links, Raft, threads.** Queues stand for links; the extra hop is reasoned.
- **`data` as the partials.** The partials are plain code, not data 5's views. The sim's host works a slot's cells out again on every change; the bench's host is incremental.
- **Windows kept by group with pairing.** O1 built that; this part only counts its frames beside the slot form.
- **`{ pages }`, `some`/`every`, `distinct`.** Not built here; pages are O1's scatter-gather, the others are reasoned to follow the add and extreme classes.
- **The delta form's rules.** The bench times delta frames; no seeded run checked them. They need frames applied exactly once and in order, and a merged delta cannot be cut where a lagging copy's picture lands.
- **Copies that lag.** A new host here is always at its group's head; a lagging copy's pictures would be older, and S2 would drop them until it caught up (reasoned).
