# E-65 X1: the asking process holds every row, but better than a fixed ceiling

**Question.** Four features cannot be split across a resource's groups by the merger: `hold: 'all'`, `f.data.connect()` over the whole resource, code over every row (root code, a handler's `ctx.data`), and a live median or quantile ([MERGE.md](../../../MERGE.md) 5.4 item 1). MERGE.md proposed a fixed one-process ceiling for them: about 1e6 to 5e6 rows, at most 16,777,216 rows a `data` source, and about 0.28 M writes a second. The process that asks (the **asker**) already subscribes to every group, so no server holds the whole resource; the limit is the asker's own. X1 keeps "the asker holds every row" and asks: **what does better than a fixed row count, for each feature, and what does each way cost?**

## The answer first

- **The limit can be the asker's own `memory` budget, not a row count, but only if the guard measures the real live heap.** A guard that reads V8's used heap warned at 34 to 64 % of the budget in all 100 seeds (it counts garbage). A fixed bytes-a-row model let the live heap pass the budget unrefused, or refused late, in 98 of 100 (rows of other shapes cost more). A guard that re-measures the live heap with a full collection at each tenth from 50 % and at each line passed all 100: it warned at 80 to 84 % and refused at 90 to 96 % *(checked, `budget`)*. Its price is a few forced full collections per fill: up to 169 ms each at this small scale, and about 0.9 to 1.3 s at 5e6 rows *(measured, `budget`, `gc`)*. The budget should count live bytes, not RSS: once writes have run, RSS is 2.3 to 2.6 times data's live heap *(measured, `mem`)*.
- **A live median needs no rows at all.** One sorted column of numbers, fed by each changed row's before and after, gives the exact median for +0.5 to +1.7 µs a write over the fold (the three runs' ranges; +0.5 to +0.8 median to median). data's own `median` costs +12 µs a write at 1e5 rows and +180 µs at 1e6, because each change moves the whole sorted array *(measured, `median`)*. With worker threads feeding the column, the main thread kept the exact median at 0.74 M writes a second and the final value matched a fresh sort in 9 of 9 runs *(measured, checked, `workers`)*.
- **Worker threads spread the fold:** decode and fold of the write mix went from 0.29 M records a second on one thread to 0.57 M with 2 workers and 0.78 M with 3, on a 4-core box *(measured, `workers`)*. But a read over every row on the main thread then crosses threads: a `get` is a 45 to 52 µs round trip, and every row as decoded pages costs about 2.3 µs a row against 0.08 µs in the same thread *(measured)*. So workers serve live views and one-time reads, not a sync `.value` of every row.
- **Data's 16,777,216-row cap goes with several sources inside the asker.** Sources by fixed block of slots stayed exact against an oracle in 1,000 seeds per form, through 13,178 slot moves, held and resent records; four planted bugs failed 62 to 1,000 seeds *(checked, `sim`)*. Their fold is the same as one source's (1.67 to 1.90 µs a record against 1.85 to 1.99 at 1e6 rows) *(measured, `fold`)*. One source still stops at 16,777,216 rows (E-34 measured it); 16 sources fill together only near 2^28, about 268 M rows *(arithmetic; the 2e7-row run was not run in this pass)*.
- **Compact rows hold more per GB and nearly end GC pauses, but data's operators do not run on them.** The column store touched 156 B a row (248 B allocated) against 298 B of heap for one `data` source *(measured, `mem`)*. Loading 5e6 rows paused at most 5 to 14 ms against 0.88 to 1.34 s for `data` (one source or 16) *(measured, `gc`)*. A column scan costs 7 to 18 ns a row against 79 to 90 for data; a `get` costs 2.7 µs against 1.0 *(measured, `read`)*. Every operator over every row would have to be fero's own.
- **Spilling to disk works for one-time work, not for live views.** `node:sqlite` folds 0.12 to 0.15 M records a second, gets cost 7.6 to 8.1 µs, and a scan 1.1 to 2.4 µs a row; an index walk to the median was slower (1.7 to 1.9 s at 1e6) than gathering and sorting (1.2 s) *(measured, `fold`, `read`)*.
- **Verdict.** Replace the fixed row ceiling with the asker's `memory` budget, guarded by measured live heap; serve a live median from a sorted column (in `data` 5 or in fero), never from rows; lift the per-source cap (a `data` 5 fix, or sources by block); keep worker threads for live views and one-time reads past one core. Compact rows and disk spill are not worth their rules for the first build. The fold-rate ceiling for a sync `.value` of every row stays one thread's: about 0.29 M records a second with decoding.

## Words

- **Asker.** The process that wants every row: one with `hold: 'all'`, a `f.data.connect()` over the whole resource, code over every row, or a live median. Today (R0) it holds every row in one `data` source and folds every write on its main thread.
- **Source.** One `data` store. data keys a source's rows in one JavaScript `Map`, which V8 stops at 16,777,216 entries ([E-34](../../E34-wake-10gb/README.md)).
- **Block.** A fixed set of slots inside the asker (slot mod S). It never changes when slots move between groups.
- **Fold.** Applying a committed record to the rows in memory.
- **Live heap.** What the heap holds after a full collection: the rows and what they point to, with no garbage.
- **Budget.** The asker's `memory` option ([API.md](../../../API.md) section 9), in bytes.
- **Column store.** Rows kept field by field in typed arrays, outside V8's object graph. **Arena**: each row kept as JSON bytes in big buffers. Both find a row by a hash table in a typed array, not a `Map`.
- **Projection.** Holding only some fields of each row.
- **Oracle.** The same answer worked out by separate code from the true rows. **Planted bug**: a switch that breaks one rule on purpose, to show the oracle can see it.

## Method

Node 22.22.0 on one 4-vCPU box shared with other studies; `data` at 63fea66 (read from `../data`, never changed) and fero v4's codec (`kernel/codec.ts`, read only). The rows and the write mix are E-64 O2's and O4's: eight fields, about 100 B of JSON; 25 % whole rows, 30 % one number field, 12 % the user field, 13 % the score, 8 % a flag, 3 % a field deleted, 9 % a row removed.

- **Seeded runs** (`src/sim.mjs`, heavy lock, 1,000 seeds a line).
  - *Split.* G groups own the slots and send their records in each group's order, mixed at random across groups. Slots move between groups. A group's link stalls for 20 to 300 steps. A reconnect sends the last 1 to 20 frames again. The asker keeps every row in one source, in S sources by block, or in one source per group. The oracle is the true rows at the asker's cut, applied by separate code to a plain `Map`: every 25 steps the row count, 20 gets, the sum of a field, the top 10 scores and the median score; every 250 steps every row.
  - *Compact.* The arena, the column store and the arena on disk against a plain `Map`, on a dirty domain (numbers as strings, `null`, objects and arrays in fields, unknown fields, emoji in keys and text), after every batch.
- **The budget guard** (`src/budget.mjs`, heavy lock, 100 seeds a policy). A 32 MB budget and a 128 MB heap, so a full collection is cheap enough to serve as the oracle. The asker takes inserts, longer rows, rewrites in other shapes and deletes, with four row shapes mixed per seed. After every batch of 512 records the guard reads its estimate: at 80 % it warns, at 95 % it refuses. The oracle reads the live heap at every warning and refusal, and whenever the used heap passes the budget. A seed fails if the warning comes outside 70 to 90 % of the budget, the refusal below 85 %, or the live heap passes 100 % unrefused.
- **Timed runs** (`src/bench.mjs`, `src/workers.mjs`; timing lock, three runs, each process alone on the box). 1e6 rows unless named; GC pauses at 5e6 rows. Fold: the write mix in lanes of 256 records, at most about 3 s of records. Reads: 1e5 random gets; a scan of one field; every row as an object; an exact median once (gather and sort). Workers: 1e6 records encoded as fero frames of 256 and split by block to the worker that owns them.
- **Memory and the ceiling** (`bench.mjs mem`, `cap`; heavy lock). Heap after a full collection, off-heap memory (`arrayBuffers` and `external`) and RSS, after the load and again after 1e6 more writes.
- **Scaled down.** Every process stayed under 4 GB: 1e6 rows for most timings, 5e6 for GC pauses, 2e7 for the ceiling runs, a 32 MB budget for the guard, worker heaps capped at 1.5 GB.
- **Marks.** *(measured)*: three timed runs, a range. *(checked)*: a seeded run with an oracle, or a probe. *(counted)*: a count from a run. *(reasoned)*: an argument nothing ran. *(a guess)*: nobody measured it. *(from memory)*: an outside fact not checked here.

## Results

The full tables are in [results/summary.md](results/summary.md).

### 1. Correctness: sources inside the asker, and compact stores *(checked, `sim`)*

| What ran | Seeds | Failed | What the run held |
|---|---|---|---|
| one source (R0), 4 groups | 1,000 | 0 | 81,000 checks, 13,178 slot moves, 6,535 records held for their turn, 148,475 resends dropped |
| 8 sources by block, 4 groups | 1,000 | 0 | the same world |
| 32 sources by block, 8 groups | 1,000 | 0 | 13,110 moves |
| one source per group, 4 groups | 1,000 | 0 | 104,017 rows moved between sources at slot moves |
| arena, column store, arena on disk (dirty domain) | 1,000 each | 0 | 600,000 checks each |

| Planted bug (each rule off) | Failed of 1,000 |
|---|---|
| B1: a slot's records applied on arrival, not in order | 794 |
| B2: a resent record applied again | 948 |
| B3: `get` picks the block by another function than the fold | 1,000 |
| B3: each source gives k/2 rows to the top k (8 sources; 2 sources) | 62; 1,000 |
| B3: the median as the median of the sources' medians | 1,000 |
| B4: a slot move does not move its rows (sources by group) | 1,000 |
| an index probe stops at a deleted key's mark (arena, column, disk) | 1,000 each |
| arena compaction forgets to move a row's address | 1,000 |
| a deleted field keeps its presence bit (column) | 1,000 |
| a value of the wrong type forced into its column | 1,000 |

- The top-k rule fails only 62 seeds with 8 sources, because a top 10 rarely puts 6 rows in one block; with 2 sources it fails all 1,000.
- The first run of the six real split lines failed 2 seeds each. The cause was the check, not the split: when fewer than 10 rows have a score, data's `za('score', 10)` fills its window with a row that has none, which the oracle left out. The check now compares numeric scores; the rerun had 0 failures. The first lines are kept in `results/superseded-sims.jsonl`.
- **With decimal values, sums are not exact either way.** data's running sum differed from the exact sum in 71,227 of 81,000 checks with one source and 42,090 with 8 sources *(counted)*. An exact sum (data 5's merge contract) is needed whether or not the rows are split.

### 2. The memory budget as the limit *(checked, `budget`, 100 seeds a policy)*

| Guard reads | Failed | Live heap at the warning (% of budget) | At the refusal | Main way it failed |
|---|---|---|---|---|
| V8's used heap now | 100 | 34 to 64 | 55 to 84 | garbage counted: far too early |
| a fixed model, bytes a row from JSON size | 98 | 77 to 111 | 92 to 113 | other row shapes cost more: late, past the budget in 11 |
| bytes a row of the first 1,000 rows (planted) | 93 | 78 to 107 | 97 to 113 | late, past the budget in 16 |
| the used heap after the last major collection, plus the model's growth | 32 | 63 to 83 | 78 to 101 | mostly too early; once past the budget by 1 % |
| the model scaled by heap/model at the last major collection | 99 | 55 to 72 | 63 to 90 | garbage at the read inflates the scale: too early |
| **the model, re-measured with a full collection at each tenth from 50 % and at each line** | **0** | **80 to 84** | **90 to 96** | — |

- A guard check costs 0.7 to 5 µs a batch of 512 records *(measured inside the seeded run)*; `v8.getHeapStatistics()` costs 450 to 650 ns *(measured, `probe`)*.
- The passing guard forces about 4 to 6 full collections per fill: up to 169 ms each here, with a 32 MB budget on a shared box. At a real budget each is a full pause of the main thread: 0.88 to 1.34 s while 5e6 rows load *(measured, `gc`)*.
- A side finding: **data does not free a dropped source.** 1e5 small rows left 18 MB on the heap when the handle was dropped and 23 MB when it was disposed; removing every row first freed it all *(checked, `probe-drop`)*. A hold that ends past its budget must remove its rows, or data must forget the source.

### 3. Bytes a row *(measured, `mem`, three runs, heavy lock)*, and past 16,777,216 rows

| Form | Heap a row | Off-heap a row (allocated) | RSS a row after the load | RSS a row after 1e6 more writes | On disk a row | Rows a GB of live memory |
|---|---|---|---|---|---|---|
| one `data` source (R0) | 298 B | 0 | 335 B | 701 B | — | about 3.4 M |
| 16 sources by block | 296 B | 0 | 332 B | 759 B | — | about 3.4 M |
| 64 sources by block | 300 B | 0 | 361 B | 767 B | — | about 3.3 M |
| one source, three fields of eight | 154 B | 0 | 199 B | 543 B | — | about 6.5 M |
| column store | 8 B | 248 B | 156 B | 298 B | — | 3.9 M allocated, 6.4 M touched |
| arena (JSON bytes) | 0 | 373 B | 229 B | 313 B | — | 2.7 M allocated, 4.4 M touched |
| arena, values in a file | 0 | 107 B | 94 B | 191 B | 254 B | about 9 M in memory |
| `node:sqlite` | 0 | 0 | 105 B | 162 B | 163 B | about 9.5 M in memory (its cache and the process) |

- Rows of about 100 B of JSON in eight fields, 1e6 loaded (945,078 left after the writes' deletes); bytes divided by 1e6. Three runs agreed to within 1 % on the heap and 6 % on RSS *(measured, `mem`, heavy lock)*.
- "Allocated" is what the compact stores reserved, growth slack included; "touched" is the RSS after the load, the pages really used.
- **RSS after writes is about 2.3 to 2.6 times data's live heap** (701 to 767 B against 296 to 300 B): V8 keeps the heap it grew for the write batches. A `memory` budget read as RSS holds about 1.4 M such rows a GB; read as live heap, about 3.4 M *(measured)*.
- A projection to three of eight fields halves the heap a row. The column store touches about half of data's bytes and keeps them off the V8 heap. The disk forms keep 94 to 105 B a row in memory and 163 to 254 B on disk.

**Past 16,777,216 rows.** One `data` source stops at exactly 16,777,216 rows with V8's `Map maximum size exceeded` *(measured in E-34)*. Sources by block split the rows by slot, so each holds about one S-th of them: 16 sources fill together near 16 × 2^24 = 2^28, about 268 M rows, which at 298 B a row is about 80 GB of heap, far past any one machine's `memory` budget *(arithmetic)*. The column store finds rows by a hash table in a typed array, which has no such cap *(reasoned)*. This pass did not run `./run.sh cap` (2e7 tiny rows into one source, into 16 sources and into the column store): the shared box was held by other studies' timing runs for over half an hour, and the claim rests on E-34's measured cap and the arithmetic above. The script is ready for a rerun.

**Does data free a dropped source?** *(checked, `probe-drop`, three rounds of 1e5 small rows a way)*

| Way the asker lets go | Heap kept a round |
|---|---|
| drop the handle and the lane | 18.2 MB |
| `src.dispose()`, then drop | 22.8 MB |
| remove every row through the lane, then dispose and drop | 0 |

### 4. Fold rate at 1e6 rows *(measured, `fold`, three runs)*

| Form | ns a record | Records a second |
|---|---|---|
| one `data` source (R0) | 1,845 to 1,990 | 0.50 to 0.54 M |
| 16 sources by block | 1,670 to 1,904 | 0.53 to 0.60 M |
| 64 sources by block | 1,968 to 2,206 | 0.45 to 0.51 M |
| one source, three fields only | 1,611 to 1,955 | 0.51 to 0.62 M |
| column store | 1,132 to 1,374 | 0.73 to 0.88 M |
| arena (JSON bytes) | 2,193 to 2,939 | 0.34 to 0.46 M |
| arena with values in a file | 2,735 to 3,166 | 0.32 to 0.37 M |
| `node:sqlite` | 6,638 to 8,068 | 0.12 to 0.15 M |

These are decoded records. With fero v4's decode added, one thread folds 0.27 to 0.30 M records a second *(measured, `workers` W = 0)*, GROUPS G6's figure.

**With live views over every row** (a sum, a count, a top 10 by score and a median):

| Form | ns a record | Records a second |
|---|---|---|
| one source, data's views | 3.30 to 4.28 ms | 234 to 303 |
| 16 sources, data's views per source, one sorted column for the median | 45 to 47 µs | 21,000 to 22,000 |
| column store, a sum, a count and a sorted column | 5.1 to 6.6 µs | 0.15 to 0.20 M |

At 1e6 rows today's data spends milliseconds a write on `za` and `median`, each of which moves an array of every row. TRANSFORMS 8.2 found the same for `za`; `median` is new here.

**A live median alone:**

| Median kept by | 1e5 rows: ns a record | 1e6 rows | Reading the median |
|---|---|---|---|
| nothing (the fold alone) | 1,079 to 1,341 | 1,912 to 2,046 | — |
| data's `median` on one source | 12,366 to 13,391 | 150,110 to 193,395 | 2.6 to 4.8 µs |
| data's `median` on each of 16 sources (not one answer) | 2,593 to 2,668 | 10,395 to 11,751 | — |
| one sorted column fed by row deltas | 1,479 to 1,696 | 2,494 to 3,565 | 6 to 18 µs |

### 5. Reads over every row at 1e6 rows *(measured, `read`)*

| Form | get | one field, a row | every row as an object, a row | exact median once |
|---|---|---|---|---|
| one source | 0.83 to 1.05 µs | 79 to 90 ns | 77 to 83 ns | 170 to 185 ms |
| 16 sources | 1.39 to 1.44 µs | 73 to 77 ns | 42 to 66 ns | 154 to 163 ms |
| three fields only | 0.81 to 1.31 µs | 56 to 66 ns | 55 to 73 ns | 151 to 166 ms |
| column store | 2.5 to 3.4 µs | 11 to 18 ns (a sum: 7 to 9 ns) | 605 to 634 ns | 105 to 107 ms |
| arena | 1.9 to 2.0 µs | 1.37 to 1.52 µs | 1.70 to 1.93 µs | 1.40 to 1.63 s |
| arena, values in a file | 2.3 to 2.8 µs | 2.08 to 2.15 µs | 2.33 to 2.51 µs | 2.02 to 2.19 s |
| `node:sqlite` | 7.7 to 8.0 µs | 1.13 to 1.14 µs (SQL sum: 0.38 µs) | 2.06 to 2.38 µs | 1.17 to 1.27 s |
| `node:sqlite` with an index on score | 6.9 to 8.1 µs | 1.07 to 1.24 µs | 2.13 to 2.20 µs | index walk 1.75 to 1.88 s |

### 6. GC pauses: loading 5e6 rows, then 10 s of 50,000 writes a second *(measured, `gc`)*

| Form | Load s | Heap | Off-heap | Longest pause while loading | Longest pause under writes | Loop delay p99 / max |
|---|---|---|---|---|---|---|
| one `data` source | 8.8 to 9.5 | 1,658 MB | 18 MB | 1,252 to 1,341 ms (major) | 25 to 48 ms (no major) | 1.5 to 1.7 / 23 to 55 ms |
| 16 sources by block | 8.6 to 9.4 | 1,645 to 1,651 MB | 18 MB | 881 to 1,062 ms (major) | 23 to 29 ms (no major) | 1.6 to 1.7 / 12 to 15 ms |
| column store | 9.7 to 10.0 | 110 to 137 MB | 1,166 MB | 9.5 to 14 ms | 23 to 41 ms | 1.5 / 4.8 to 14 ms |
| arena | 7.8 to 8.1 | 121 to 123 MB | 2,098 MB | 5.4 to 6.1 ms | 24 to 43 ms | 1.7 to 1.9 / 5.1 to 49 ms |

- A pause of 1.25 to 1.34 s while loading 5e6 small rows into one source is longer than E-07's 0.77 to 0.98 s on the same box *(measured; E-07 measured)*: past F-06's 1 s bar for a main thread with a kernel on it.
- 16 sources do not end the pause: the same objects sit on the same heap. Rows off the V8 object graph do.
- Under steady writes every form stayed under 50 ms, as E-07 found.
- The off-heap column is what the stores had allocated, growth slack included; the bytes a row are in section 3.

### 7. Worker threads *(measured, `workers`; the median check is checked)*

| Workers | Records a second, decode and fold | With live count, sum and exact median on the main thread | Main thread busy, with those views (without: under 1 % once workers fold) |
|---|---|---|---|
| 0 (the main thread folds) | 0.27 to 0.30 M | 0.24 to 0.26 M | 100 % |
| 1 | 0.27 to 0.30 M | 0.24 to 0.27 M | 12 to 13 % |
| 2 | 0.52 to 0.65 M | 0.42 to 0.59 M | 21 to 25 % |
| 3 | 0.71 to 0.82 M | 0.63 to 0.75 M | 31 to 33 % |

- The median the main thread kept from the workers' before-and-after values equalled the exact median of every worker's rows at the end in all 9 runs with views *(checked)*.
- Reads from the main thread, with the rows in 1 to 3 workers: a `get` one at a time 45 to 52 µs; 64 in flight 8.9 to 14 µs each; every row as decoded pages 2.2 to 2.5 µs a row; one column, then an exact median, 118 to 152 ms *(measured)*.
- With 3 workers the third worker was 75 to 88 % busy: the 4-core box and the main thread's share cap it.

## Verdict

1. **Replace the fixed row ceiling with the asker's `memory` budget, guarded by the measured live heap** (the `confirm` guard: 0 of 100 seeds failed). Health warns at 80 %; past 95 % new whole-resource holds are refused `not-held`, and a growing hold ends `not-held` with its rows removed. The price is a few forced full collections per fill, each a main-thread pause of up to about a second at millions of rows. A guard that only reads the heap after natural collections is safe but early (32 of 100 failed, all but one by warning or refusing too soon).
2. **Serve a live median or quantile from a sorted column, never from rows.** It is exact, costs +0.5 to +1.7 µs a write, and holds 8 to 16 B a value instead of a row (chunks of 512 to 1,024 values in buffers of 1,024; see `../probes`). It fits data 5 (data's own comment names a tree as its upgrade path) or fero.
3. **Lift data's 16,777,216-row cap** inside `data` 5 (a source keyed by more than one `Map`), or by sources per fixed block in the asker, which cost no fold and passed every check.
4. **Use worker threads for live views and one-time reads past one core** (2.0 to 2.7 times one thread), not for a sync `.value` of every row.
5. **Do not build compact rows or disk spill for the first build.** They hold more rows a GB and end GC pauses, but every operator over every row becomes fero's own code, and a disk store serves no live views.

## What this cannot show

- One process, no network: groups are queues and links are function calls; the subscription to every group was not run.
- The worker threads split a pre-made stream by block; each worker's own subscription to its slots was not built. A multi-row commit that spans two workers can show half done on the main thread for a moment *(reasoned; not run)*.
- The budget guard ran at a 32 MB budget. Its forced collections at real sizes are E-07's and this page's GC pauses, not measured inside the guard.
- The arena and the column store use JSON and a fixed shape; JSON loses `-0` and `NaN`, and the column store sends odd rows to a `Map`. Their compaction pauses were not timed.
- `node:sqlite` is experimental in Node 22 (it prints a warning) *(checked)*.
- The ceiling run (`./run.sh cap`, 2e7 tiny rows) was not run in this pass: it waited over half an hour behind other studies' timing runs on the shared box. The claim past 2^24 rows rests on E-34's measured cap and arithmetic.
- One shared 4-vCPU box; differences inside a range are not claims. One 3-second check overlapped the first timing run's worker lines; their numbers sit inside the other runs' spread.

## Files and how to rerun

- `run.sh`: `./run.sh quick` (a smoke run of every part, a few minutes, nothing written; under the heavy lock when `SP` is set), `./run.sh sims`, `budget`, `mem`, `cap`, `timing`, `summary`, or all of them with no argument. `SP` names a scratch folder holding `bin/timing` and `bin/heavy`; without it the locks are skipped. `DATA` overrides `data`'s folder (default `../data` next to this repo).
- `src/lib.mjs` rows, the write mix, helpers; `src/dstores.mjs` the `data` forms (one, blocks, groups, projection); `src/compact.mjs` the key index, arena, column store and sorted column; `src/sqlite.mjs` the disk form; `src/sim.mjs` the seeded runs; `src/budget.mjs` the guard; `src/bench.mjs` the timed and memory benches; `src/workers.mjs` and `src/worker.mjs` the worker threads; `src/probe-drop.mjs` the dropped-source probe; `src/summarize.mjs` the tables.
- `results/`: raw JSON lines, each process preceded by its load average, and [results/summary.md](results/summary.md).
