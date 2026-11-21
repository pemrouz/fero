# E-64 O1: the merger, built small

**Question.** Can a view over every row of a resource be kept by **partials** (the view over one group's rows, kept where that group's rows already are) and a **merger** (which combines the partials by key), so that no process holds or folds the whole resource? Is it exact through slot moves, groups made and removed, failovers and outages? What does the merger cost per change, and how many changes reach it per write? This is option O1 of E-64 ("past one process"); E-23 named the merger and its rules, and TRANSFORMS 3.9 and 10 item 1 name it the later design.

**Words.** A **group** owns some of a resource's slots. A **partial** is a view over one group's rows. A **partial frame** is what one group commit changed in its partials. The **merger** combines the G partials into the answer a client sees. A **cut** is one position per group. A **paired move** is a slot move whose two halves (A's fence, B's open) the merger takes at one cut.

## The answer first

- **Exact through everything the run threw at it** *(checked)*. Three long runs (4, 16, and 1 to 16 groups; 100,000 commits each) checked the merger's six answers after each of 282,540 deliveries, and in full 810 times: 0 mismatches, through 1,085 paired moves of 56,303 slots, 104 groups made and 96 removed, 403 partial resyncs, 153 partial outages of 50 to 300 steps and 106 merger rebuilds, with queues up to 231 deliveries deep. 1,000 short seeds each at G = 4 and elastic: 0 failed. A page by scatter-gather and an exact median by selection were exact at all 603 checks each (at the groups' heads).
- **Each rule has teeth** *(checked)*, failing seeds out of 1,000 at G = 4 and elastic: a move's halves taken one by one 582 and 321; a resync that adds the picture without taking the old contribution out 437 and 429; window ties by arrival 1,000 and 999; each group sending 4 of a top 10 996 and 1,000; the max kept only as a merged value 1,000 and 1,000. **E-23's rule 2 ("each key from one group") turned off: 0 and 0.** Once a move's halves are taken together, fence first, it never fires.
- **The merger is cheap per change** *(measured)*: 0.62 to 2.17 µs a frame for a top 10 over 1e5 rows and 0.90 to 4.06 µs for a top 100 (at 1e6 rows too few frames came for a steady number); 98.7 to 1,079 ns a change for counts and exact sums kept as merged sums only (250 to 2,880 ns when every group's sums are kept); 89.4 to 428 ns for a max per bucket; 192 to 280 ns for a filter.
- **How many changes reach it depends on the view** *(counted)*. A top 10 over 1e5 rows: 0.00081 to 0.05008 (G = 4 to 256) frames a write when scores are random, 0.20983 to 0.22833 when a few hot rows keep rising. A top 100 over 256 groups of 1e5 rows: 0.45 frames a write, since a quarter of all rows sit in some group's window. Counts and sums: one frame (two changes) every write.
- **Memory** *(measured)*: the merger at 256 groups holds 0.80 to 0.81 MB for a top 10, 7.38 MB for a top 100, 11.4 MB for a max over 1,000 buckets; sums cost 373 B a bucket merged, or 394 B per (group, bucket) when every group's sums are kept (631 MB at 1e5 buckets × 16 groups).
- **Reads** *(measured, in one process)*: a page of 20 by one round sends G × 20 entries (about 5,000 at 256 groups, 1,164 to 2,575 µs); by two rounds 54.7 to 525.1 entries a page, but that form needs a pinned read (see below); an exact median takes 17 to 39 rounds for two selections. One index (G = 1) answers a page in 2.26 to 8.23 µs at 1e5 and 1e6 rows.
- **Bytes** *(measured as JSON)*: windows 0.3 B a write, counts and sums 52.2 B, a filter 41.5 B, against 74.7 B for the record itself.

The full tables are in [results/summary.md](results/summary.md).


## Method

Everything is plain JavaScript on Node 22, in one process; no network, no Raft, no `data`. The merge contract's definitions (the total order with key ties, typed bucket keys, the numeric projection, the exact sum) and the ordered index are imported from E-57 group B (`b-merge/src/lib.mjs`, `index.mjs`) unchanged, so the merger is judged by the contract E-57 checked.

**The views** (`src/partial.mjs`, `src/merger.mjs`), over rows `{ id, points, room }`:
- window: `za('points', 10)`, ties by key; each partial keeps its group's top KP = 10 in its own ordered index;
- add: `by('room').length()`, `by('room').sum('points')` exact, and `length()`, `sum('points')`; the partial keeps no state and sends (bucket, value, ±1) for each changed row's before and after;
- extreme: `by('room').max('points')`; the merger keeps every group's max per bucket;
- union: `gt('points', 50)`;
- distinct: `distinct('room')`, the value of the smallest key per bucket;
- bool: `some(points === 100)`.

**The seeded run** (`sim/sim.mjs`). One resource of 1,024 slots over G = 4, 16, or elastic groups (1 to 16: a grow moves half of a group's slots to a new group, a shrink moves all of a group's slots out and drops it). 3,000 keys in E-23's dirty domain (numbers, two-decimal values, `null`, missing fields, numeric strings, `'x'`, emoji, booleans, objects, `NaN`, `-0`, the infinities). Each step one commit (5 % touch several rows of one group). Each group's partials run at the group's head and queue one partial frame per commit. A slot move (1, 8 or 64 slots, 1 in 250 steps) is one paired delivery in both groups' queues. The merger takes 0 to 3 deliveries a step from random groups and drains any queue past 100. Faults: a partial failover (1 in 1,000 steps: the new host waits until it is at or past the merger's position, then sends a picture), a partial outage (1 in 2,000: 50 to 300 steps with nothing from one group, then a resync), a merger failover (1 in 3,000: a new merger from every group's picture). **The oracle:** after every delivery, each answer against the query run from scratch on the rows of exactly the commits the merger had taken (its cut), for the touched keys and buckets, and in full every 1,000 deliveries and after every event; every record's slot sequence must be its slot's next one, and its slot must belong, at the merger's cut, to the group that sent it. Every 500 steps, at the groups' heads, a page of 7 after a random cursor (both scatter-gather forms) and an exact median by selection, against the query over every row. **Planted bugs** (`--mutate`), each run on the same 1,000 short seeds as the real code: `nopair` (a move's halves taken one by one), `ties` (window ties by arrival), `kshort` (each group sends 4 rows of a top 10), `extmerged` (the extreme keeps only the merged value), `resyncadd` (a resync adds the picture without taking the old contribution out), `noowner` (E-23's rule 2, "each key from one group", off).

**The cost bench** (`bench/bench.mjs`), one part per process, each run alone under the timing lock, three runs; inside a run the median of 5 rounds after a warm-up. Partial frames are made first by real partial code, then the merger is timed alone on them.
- `window`: N rows over G = 1 (one index of every row: R0's own view, for comparison), 4, 16, 64, 256 groups (rows to groups by a hash), each group a chunked index; 200,000 writes, `uniform` (a random row gets a random score) or `rising` (a Zipf 0.99 row's score goes up); K = 10 and 100; N = 1e5 and 1e6. Reports the partials' cost per write, partial frames and changes per write, the merger's ns per frame and per write, and client frames per write.
- `add`: deltas (bucket, value, ±1), B = 16, 1,000, 1e5 buckets, G = 4 to 256, with per-group state and with merged sums only; each round applies the stream and then its exact inverse.
- `ext`: frames (group, bucket, new max), 30 % of them lowering a group's value; `union`: rows in and out.
- `pages`: a page of 20 after 2,000 random cursors over G indexes of N = 1e5 and 1e6 rows, one-round and two-round forms; an exact median by two selections.
- `bytes`: JSON length of real partial frames per write, G = 4, 20,000 keys. `mem`: the merger's heap at G = 256.

## Files and how to rerun

- `src/partial.mjs` the partials; `src/merger.mjs` the merger and its rules; `src/select.mjs` pages and selection by scatter-gather; `src/lib.mjs` E-57's contract helpers and an independent exact sum for the oracle.
- `sim/sim.mjs` the seeded run; `bench/bench.mjs` the cost bench; `bench/summarize.mjs` the tables.
- `results/sim.jsonl`, `results/bench.jsonl` (each line tagged with its run), `results/summary.md`.
- `./run.sh quick` (a smoke run, nothing written), `./run.sh sim`, `./run.sh bench`, `./run.sh S`, `./run.sh all`. `SP` names a folder with `bin/heavy` and `bin/timing` lock wrappers, if there are any.

## What this does not show

- **Real links, Raft, threads.** Queues stand for links. No byte crossed a socket; the extra hop is reasoned.
- **`data` as the partials.** The partials here are plain code over E-57's index, not data 5's views. E-23 ran data's own views as partials (runs A and E: 225.6 million checks, 0 mismatches with the contract) but without failovers, outages or a merger rebuild.
- **Reads at a pinned position.** The page and median checks ran at the groups' heads with no write between rounds. The two-round page and the median need each group to answer every round at one position, which nothing here builds.
- **Batching.** One partial frame per commit; frames per commit batch were not timed.
