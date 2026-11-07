# E-05: what data's fold costs

**Question (Q-05).** What does `data`'s fold cost per record, per row of memory, and per GB of replay? The fold is the step that turns committed change records into rows. In MIN, every full replica folds (axis F `all`); in LEAN, only the leader does (F `ldr`). The question decides F `all` against `ldr`, and touches P-01, P-12, DEP-13, F-05 (LEAN's cold failover), F-21 (the divergence hash) and the 2 µs L2 bar.

**Thresholds (QUESTIONS.md).**
- ≤ 2 µs per record and ≤ 2 KB per small row → "every replica folds" is affordable (MIN).
- Decision 13's form (rows on a worker plus a projection on the main thread) above 2 KB a row → DEP-13 is restated for it, or rows stay on one thread.
- A hash of 1e6 rows ≤ 1 s of a background thread → F-21's hourly check is affordable.
- The fold ≥ 30 % of E-02's CPU per append → every replica spends about a core on it, and LEAN moves up. E-02 measured 5.5 µs of CPU per committed append in the TS leader at 50,000/s, and 3.9 µs in each follower, so 30 % is 1.65 µs (leader) or 1.2 µs (follower).
- Replaying one group's state > 2.5 s → LEAN fails F-05 without its warm standby.

## Method

Everything goes through fero v4's real seam. [tree.sh](tree.sh) copies `api/substrate.ts`, `kernel/env.ts` and `kernel/codec.ts` from fero (68a5b8e) into a scratch tree and links `data` (63fea66, `SCHEDULE_VERSION` 4) beside them, so the seam's `import '../../data/api/index.ts'` resolves as it does in fero. Nothing in fero or data is changed. The harness is in [bench/](bench).

- **Rows.** A "small row" is about 100 bytes: `{ name, email, region, room, n, active, tags: ['a','b'] }`. It is 114 B as JSON and 125 B as one insert record in fero's codec. Rows are loaded the way a replica gets them: insert records encoded into fero frames of 256, decoded with the codec (`Frame.records()`, `rec()`), and folded with data's hot lane. So row strings are real decoded strings.
- **Views.** `none`; `group`: one `group` view by region (16 buckets) with one sink; `filter100`: 100 `filter` views (one per room, each matching 1 % of rows), each with one sink. A sink stands for a live subscriber. Views are built after the rows are loaded (data's bulk path; see the group finding below for why).
- **Fold cost** ([bench/fold.mjs](bench/fold.mjs)). Four kinds of record: a field update (`[row, 'n'] = number`), a whole-row set (a new ~100 B row object), an insert of a new row, and a delete. Two ways to hand them over:
  - `rec`: `substrate.applyRec(p, r)` per record. This is exactly what fero v4 does today: one lane call, one data commit per record.
  - `b256`: data's lane with 256 records per call, made as `substrate.ts` makes it (same origin token). This is what a v5 kernel handing over one committed batch would do: one data commit per 256 records.
  Records are built before each timed round and the heap is collected, so the time is the fold's own, plus the garbage the fold makes. Rounds are sized by a probe to about 300 ms (5 rounds, or 3 when a round would pass a second); the median round is reported, as wall time and as process CPU time (all threads, so GC helper threads count).
- **Group scaling** ([bench/group-scale.mjs](bench/group-scale.mjs)). One finding needed its own probe: the cost of one `group` view per record against the size of its buckets, at 1e3 to 1e6 rows, beside a counting view (`length(fn)`, counts per bucket) and nothing.
- **Memory** ([bench/mem.mjs](bench/mem.mjs)). V8 heap used after three forced full collections, before and after loading n rows; again after "churn" (every row's field updated, every other row replaced whole); again with the views built. The same rows in a plain `Map` give the floor any JS fold pays. Also `heap_size_limit`.
- **Replay** ([bench/replay.mjs](bench/replay.mjs)). Two logs of 1e6 records each in fero's codec (frames of 256 with their crc32c): `load1m`, 1e6 inserts (rebuilding a 1e6-row state from a snapshot or a log); `mixed1m`, 1e5 inserts then 9e5 records over those rows (60 % field updates, 20 % whole-row sets, 10 % new rows, 10 % deletes). A fresh process reads the file (from the page cache), checks every crc, decodes and folds in 256-record batches. Time is split into read, decode and fold. A third log holds the same `load1m` records as JSON arrays (`JSON.parse`, V8's native parser), as a stand-in for a faster record format than v4's codec. The `group` variant builds the view after the rows.
- **Hash** ([bench/hash.mjs](bench/hash.mjs), F-21). The folded state hashed on the thread that holds it (the main thread in fero v4's form), five ways: `xx-sum` (each row's key and value encoded with fero's codec, hashed with xxHash32 under two seeds, summed over rows, so the order rows sit in does not matter); `sha-sorted` (keys sorted, one SHA-256 over the encoded stream, node:crypto); `md5-each` (node:crypto's one-shot md5 per row, summed); `json-xx` (as `xx-sum`, but each row encoded by V8's `JSON.stringify`); `encode-only` (the codec encode with no hash, to show where the time goes). [bench/xxh.mjs](bench/xxh.mjs) is checked against xxHash's reference vectors at import.
- **Decision 13's form** ([bench/d13.mjs](bench/d13.mjs)). A worker thread receives the rows as fero frames and keeps them compact: each row's key and value encoded with fero's codec into an arena of 4 MiB buffers (outside the V8 heap), plus a `Map` from row key to offset. It hands each frame to the main thread, which folds it through the seam (`projection all`), or holds nothing (`projection none`). Each thread's heap is measured after three collections, and the arena apart. Then the worker hashes its compact rows (`xx-sum` over the bytes it already holds; the digest equals the main thread's `xx-sum`, a check that both hash the same state). A naive form (`data`: the worker folds rows as objects in its own data source too) is measured beside it.
- **Timing.** Every timed part ran under `$SP/bin/timing`, 3 runs, each run in two holds (the fold part, then the rest), each process well under 60 s and preceded by its load average. Memory is not a speed: it ran under `$SP/bin/heavy`, 3 runs. Tables give the median of the runs and, in brackets, the spread (lowest and highest run). Machine: 4 vCPU, 16 GB, Linux 6.18 (Firecracker VM), Node 22.22.0 (V8 12.4).

To reproduce: `./fetch.sh` (data at 63fea66), then `./run.sh` (setup, memory, timing), then `python3 summarize.py` prints the tables below from `results/`.

## Results

All raw lines are in [results/](results) (`fold.jsonl`, `group-scale.jsonl`, `mem.jsonl`, `replay.jsonl`, `hash.jsonl`, `d13.jsonl`; each timed process is preceded by its load average). The tables below are printed by [summarize.py](summarize.py) from those files.

<!-- tables:start (python3 summarize.py) -->

### fold: µs per record, wall (CPU), median of runs (spread of run medians)

| rows | views | mode | field update | whole-row set | insert | delete | runs |
|---|---|---|---|---|---|---|---|
| 1,000 | none | rec | 0.63 [cpu 0.94] | 0.61 [cpu 0.85] | 0.60 [cpu 1.90] | 0.62 [cpu 2.12] | 1 |
| 1,000 | none | b256 | 0.29 [cpu 0.39] | 0.22 [cpu 0.34] | 0.28 [cpu 0.38] | 0.26 [cpu 0.34] | 1 |
| 1,000 | group | rec | 11.4 [cpu 12.3] | 11.0 [cpu 11.3] | 11.6 [cpu 13.5] | 12.0 [cpu 13.5] | 1 |
| 1,000 | group | b256 | 0.91 [cpu 1.13] | 1.01 [cpu 1.28] | 2.30 [cpu 4.29] | 1.75 [cpu 3.43] | 1 |
| 1,000 | filter100 | rec | 7.95 [cpu 9.18] | 8.16 [cpu 8.59] | 5.89 [cpu 8.03] | 7.84 [cpu 9.08] | 1 |
| 1,000 | filter100 | b256 | 2.66 [cpu 2.87] | 2.14 [cpu 2.34] | 1.04 [cpu 2.71] | 3.35 [cpu 5.27] | 1 |
| 100,000 | none | rec | 1.58 [cpu 2.33] | 1.08 [cpu 1.36] | 1.17 [cpu 1.97] | 0.67 [cpu 1.40] | 1 |
| 100,000 | none | b256 | 1.09 [cpu 1.52] | 0.51 [cpu 0.77] | 0.64 [cpu 0.95] | 0.66 [cpu 1.03] | 1 |
| 100,000 | group | rec | 2,751 [cpu 2,975] | 2,707 [cpu 2,924] | 1,189 [cpu 1,386] | 1,192 [cpu 1,409] | 1 |
| 100,000 | group | b256 | 155.9 [cpu 172.5] | 164.6 [cpu 176.2] | 68.3 [cpu 78.1] | 80.8 [cpu 91.0] | 1 |
| 100,000 | filter100 | rec | 21.7 [cpu 25.0] | 21.7 [cpu 23.9] | 7.52 [cpu 9.59] | 18.8 [cpu 21.3] | 1 |
| 100,000 | filter100 | b256 | 8.98 [cpu 10.1] | 8.57 [cpu 10.0] | 2.01 [cpu 2.79] | 7.66 [cpu 8.23] | 1 |
| 1,000,000 | none | rec | 2.88 [cpu 9.89] | 2.51 [cpu 4.49] | 1.23 [cpu 4.78] | 1.03 [cpu 4.00] | 1 |
| 1,000,000 | none | b256 | 1.90 [cpu 4.10] | 1.45 [cpu 2.63] | 0.80 [cpu 2.37] | 0.45 [cpu 1.72] | 1 |
| 1,000,000 | group | rec | 44,075 [cpu 45,783] | 44,718 [cpu 46,758] | 20,405 [cpu 22,022] | 21,144 [cpu 22,933] | 1 |
| 1,000,000 | group | b256 | 2,647 [cpu 3,134] | 2,704 [cpu 3,223] | 1,122 [cpu 1,641] | 1,149 [cpu 1,611] | 1 |
| 1,000,000 | filter100 | rec | 44.0 [cpu 113.2] | 43.6 [cpu 85.8] | 8.14 [cpu 31.7] | 36.7 [cpu 65.7] | 1 |
| 1,000,000 | filter100 | b256 | 25.9 [cpu 49.9] | 21.8 [cpu 67.7] | 2.18 [cpu 8.42] | 16.1 [cpu 31.1] | 1 |

load average at start of each process: median 2.81, range 1.07-3.94, n=18

### group view cost against bucket size (lane batches of 256, µs per record)

| rows | rows per bucket | none | counts (length(fn)) | group | group + sink |
|---|---|---|---|---|---|
| 1,000 | 62 | 0.37 | 0.39 | 1.31 | 1.40 |
| 10,000 | 625 | 0.41 | 0.43 | 12.1 | 15.0 |
| 100,000 | 6,250 | 1.63 | 6.32 | 160.6 | 175.4 |
| 1,000,000 | 62,500 | 3.15 | 5.39 | 2,953 | 2,867 |

load average at start of each process: median 1.28, range 1.05-1.32, n=4

### memory: bytes of V8 heap per row after full GC (runs agree to within a few bytes; median shown)

| rows | form | views | heap/row after load | after churn | views add | heap/row with views | RSS/row after churn | heap limit MB |
|---|---|---|---|---|---|---|---|---|
| 1,000 | seam | none | 522 | 616 | 1 | 618 | 2531 | 2096 |
| 1,000 | seam | group | 522 | 616 | 191 | 807 | 2228 | 2096 |
| 1,000 | seam | filter100 | 522 | 616 | 249 | 866 | 2228 | 2096 |
| 1,000 | map | none | 577 | 537 | 0 | 537 | 2097 | 2096 |
| 100,000 | seam | none | 338 | 323 | 0 | 323 | 790 | 2096 |
| 100,000 | seam | group | 338 | 323 | 182 | 505 | 791 | 2096 |
| 100,000 | seam | filter100 | 338 | 323 | 31 | 354 | 781 | 2096 |
| 100,000 | map | none | 320 | 304 | 0 | 304 | 771 | 2096 |
| 1,000,000 | seam | none | 331 | 315 | 0 | 315 | 542 | 2096 |
| 1,000,000 | seam | group | 331 | 315 | 146 | 461 | 540 | 2096 |
| 1,000,000 | seam | filter100 | 331 | 315 | 46 | 361 | 539 | 2096 |
| 1,000,000 | map | none | 310 | 294 | 0 | 294 | 537 | 2096 |

row size: 114 B as JSON, 125 B in fero's codec (one insert record).

### replay from an encoded log (1e6 records, file in page cache)

| log | format | views | seconds | records/s | s per GB | read s | decode s | fold s | view build s | heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| load1m.log | fero | none | 4.46 | 223,945 | 35.6 | 0.55 | 2.72 | 0.88 | 0.00 | 324.0 |
| load1m.log | fero | group | 5.81 | 172,094 | 46.3 | 0.07 | 2.68 | 0.89 | 1.87 | 464.0 |
| mixed1m.log | fero | none | 3.05 | 328,110 | 53.1 | 0.23 | 1.46 | 1.22 | 0.00 | 49.0 |
| load1m.json | json | none | 3.20 | 312,410 | 20.3 | 0.61 | 1.48 | 0.74 | 0.00 | 286.0 |

load average at start of each process: median 1.79, range 1.73-1.93, n=4

### hashing the folded state on the main thread (ms)

| rows | xx-sum | sha-sorted | md5-each | json-xx | encode-only |
|---|---|---|---|---|---|
| 100,000 | 200.7 | 201.9 | 322.5 | 88.3 | 176.5 |
| 1,000,000 | 1,870 | 2,875 | 3,657 | 851.1 | 1,837 |

load average at start of each process: median 1.67, range 1.32-1.93, n=10

### decision 13's form: bytes per row on each thread, and the worker's hash

| rows | worker form | projection | main heap/row | worker heap/row | worker arena/row | total/row | RSS/row | worker hash ms | load ms |
|---|---|---|---|---|---|---|---|---|---|
| 100,000 | compact | all | 338 | 64 | 126 | 528 | 1351 | 26.4 | 1,096 |
| 100,000 | compact | none | 1 | 64 | 126 | 191 | 873 | 35.9 | 908.0 |
| 100,000 | data | all | 338 | 339 | 0 | 678 | 1592 | 193.5 | 966.0 |
| 1,000,000 | compact | all | 331 | 49 | 130 | 510 | 621 | 237.3 | 9,248 |
| 1,000,000 | compact | none | 0 | 54 | 130 | 184 | 314 | 234.0 | 8,166 |
| 1,000,000 | data | all | 331 | 331 | 0 | 661 | 777 | 1,954 | 8,214 |

load average at start of each process: median 1.74, range 1.50-1.86, n=6

<!-- tables:end -->

## What the numbers say

**1. The fold itself is cheap; fero v4's one-commit-per-record path and decoding are not.** Handing data a committed batch of 256 records costs 0.22-1.90 µs of main-thread time per record with no views (field updates, whole-row sets, inserts and deletes; 1e3 to 1e6 rows). It grows with the number of rows (cache misses), not with the batch. Process CPU, which counts V8's GC helper threads, is higher at 1e6 rows (1.72-4.10 µs), because the collector marks a 330 MB heap while the fold runs. fero v4's own path, one `applyRec` and one data commit per record, costs 0.60-2.88 µs. Decoding a ~100 B record with fero v4's codec costs more than folding it: 2.7 µs per insert record in the replay (fold: 0.9 µs). So a TS follower that folds what it receives pays about 3.6 µs per record, most of it the codec.

**2. Rows are small: about 330 B of heap each, 6 times under DEP-13's 2 KB.** A small row costs 315-338 B of V8 heap after a full collection at 1e5 to 1e6 rows (a plain `Map` of the same decoded rows: 294-320 B, so data adds about 20 B a row). Rewriting every row leaves the same size (old versions are collected). A `group` view adds 146-182 B a row, 100 filters 31-46 B a row. RSS per row at 1e6 rows is about 540 B. The default heap here is 2,096 MB (`heap_size_limit`), so the default flags hold about 5 million small rows (E-34 loads 5e6 into it, with 1,707 MB used). At 1e3 rows the per-row figures are dominated by fixed costs.

**3. Decision 13's form fits too: about 510-530 B a row with every row on both threads.** The worker's compact rows cost 184-191 B a row (126-130 B of encoded bytes outside the V8 heap, plus 54-64 B of heap for the key index), the main thread's projection the same ~330 B as above: 510-528 B in all. Holding rows as objects on both threads (the naive form) costs 661-678 B. Both are well under 2 KB, so DEP-13 needs no restating for decision 13.

**4. Hashing 1e6 rows takes under 1 s only where the rows are already bytes.** On the worker's compact rows, an order-free 64-bit xxHash sum of 1e6 rows takes 234 ms (and gives the same digest as the main thread's hash of the same state). Where rows are objects, the encoding dominates: fero's codec encode alone takes 1,837 ms for 1e6 rows, so `xx-sum` takes 1,870 ms, a sorted SHA-256 2,875 ms, and node:crypto per row 3,657 ms. V8's `JSON.stringify` is the fastest encoder in JS (`json-xx`: 851 ms), and is deterministic here because replicas that fold the same log build rows with the same key order. So F-21's hourly check is affordable on a kernel worker that holds encoded rows (decision 13), or in slices on the main thread; one 1-2 s block on the main thread would stall methods and views.

**5. Replay runs at 224,000 records a second for a 1e6-row snapshot, 328,000 for a mixed log, and decoding is most of it.** Rebuilding 1e6 small rows from fero v4's codec takes 4.5 s (36 s per GB of log). The same records as JSON take 3.2 s (20 s per GB). A `group` view built after the rows adds 1.9 s at 1e6 rows. So 2.5 s rebuilds about 560,000 small rows; and F-05's 2.5 s already includes failure detection and an election (`election.ms` is 2 s in DESIGN-V5), which leaves about half a second, about 110,000 rows.

**6. A finding outside the question: data's `group` view costs O(rows in a bucket) per commit.** With one `group` view (16 buckets) a field update costs 0.9 µs at 1e3 rows, 156 µs at 1e5 and 2,647 µs at 1e6 in batches of 256, and 2,751 µs / 44,075 µs with fero v4's one commit per record. [group-scale.mjs](bench/group-scale.mjs) shows why: the cost tracks the rows per bucket (62 → 62,500), with or without a sink, while a counting view over the same buckets (`length(fn)`) stays at a few µs. data's `BucketNode` rebuilds each touched bucket's whole emitted object on every commit (`ops/bucket.ts`, "rebuilding a touched bucket is one O(B) object fill"), and loading rows under a live `group` view is therefore quadratic: the first memory run, which built the view before loading 1e6 rows, had used about 2.5 minutes of CPU without finishing when it was stopped. Views here are built after the rows. 100 `filter` views cost 9.0 µs a record at 1e5 rows and 25.9 µs at 1e6 (batches of 256): every predicate runs on every change, about 0.09-0.26 µs per view per change. P-12 asks for ≤ 1 µs per affected view and 5,000 room views at ≤ 20 µs a write: neither `group` (above about 100 rows a bucket) nor many `filter`s meets it today. This is a data-side change for every candidate (DATA-05): `group` must emit per-row deltas into a bucket, and many filters over one key need routing, not one predicate call each.

## Against the thresholds

| Threshold | Measured | Result |
|---|---|---|
| ≤ 2 µs per record (the fold) | lane, batch 256, no views: 0.22-1.90 µs wall (1e3-1e6 rows); CPU incl. GC threads up to 1.72-4.10 µs at 1e6; fero v4's per-record path 0.60-2.88 µs; decode adds 2.7 µs | **met for the fold in batches** on the main thread up to 1e6 rows; not met by v4's per-record path at 1e6, nor once decoding with v4's codec is counted |
| ≤ 2 KB per small row | 315-338 B heap (1e5-1e6), about 540 B RSS | **met** (6 ×) |
| decision 13's form ≤ 2 KB a row | 510-528 B (compact worker + full projection); 661-678 B naive | **met**; DEP-13 stands for it |
| hash of 1e6 rows ≤ 1 s of a background thread | 234 ms on the worker's compact rows; 1,870 ms on main-thread objects with v4's codec (851 ms with JSON) | **met on a worker that holds encoded rows**; not met by encoding objects with v4's codec |
| fold ≥ 30 % of E-02's CPU per append (1.65 µs leader, 1.2 µs follower) | lane CPU 0.34-4.10 µs (1e3-1e6 rows); with decode about 3.6 µs | **crossed** from about 1e5 rows for the lane alone, and at any size once decoding is counted: a folding follower spends about twice the CPU of E-02's follower per record (about 0.2 of a core at 50,000 writes/s, not a whole core) |
| replay of one group's state > 2.5 s → LEAN fails F-05 without its standby | 224,000 records/s: 1e6 small rows take 4.5 s; 2.5 s holds about 560,000 rows | **crossed** for groups above about half a million small rows (or about 110,000 once the election's 2 s is taken out): LEAN needs its warm standby |

## What this box cannot show

- Other CPUs. These are one Firecracker VM's vCPUs, shared with other agents' idle processes; µs per record would be lower on a dedicated modern core. Ratios (fold against decode, group against counts) should travel; absolute µs less so.
- Other V8 versions. Node 26 (V8 14.6) may change GC pauses and the per-row heap; only Node 22.22 ran here.
- Rows of other shapes. Every row here is a flat ~100 B object with a two-element array. Wide rows, long strings (E-34's 2 KB rows) and deep paths change both memory and decode cost.
- A real kernel. The fold is measured alone, not inside a running Raft group; E-02 gives the pipeline's own CPU, and the comparison between the two is reasoned, not measured together.
- A cold disk. The replay files were read from the page cache; E-34 measures reads of a 10 GB file.

## Verdict

**Every replica can afford to fold, on memory and on the fold itself.** A small row costs 315-338 B of heap, 6 times under DEP-13's 2 KB (510-528 B in decision 13's two-thread form), and data's lane folds a committed batch at 0.22-1.90 µs a record up to 1e6 rows. What is not cheap sits around the fold. fero v4's codec decodes a ~100 B record in about 2.7 µs, three times the fold; V8's native `JSON.parse` did the same records in about half that, and E-03 found that building the objects in Rust is no faster, so the record format, not the language, is the lever (a point for DEV-09's L0 format). fero v4's one data commit per record costs up to 0.60-2.88 µs. And data's `group` view costs O(rows per bucket) per commit, 2,647 µs a record at 1e6 rows, which fails P-12 for every candidate until data changes. Because of the decode, a folding follower spends about twice E-02's follower CPU per record, so the 30 % line is crossed (about 0.2 of a core at 50,000 writes a second, not a whole core). A cold rebuild of 1e6 rows takes 4.5 s, so LEAN without its warm standby fails F-05 for groups above about half a million small rows. F-21's hash of 1e6 rows takes 234 ms on a worker that already holds encoded rows, but 1,870 ms if objects must be encoded first.

Q-05: the fold is affordable on every replica: 0.22-1.90 µs per record in 256-record batches up to 1e6 rows (fero v4's one commit per record: 0.60-2.88 µs), 315-338 B of heap per ~100 B row (510-528 B in decision 13's two-thread form; both far under 2 KB), 1e6 rows replayed in 4.5 s (224,000 records/s, 36 s per GB, mostly fero v4's 2.7 µs decode), and a 1e6-row hash in 234 ms on a worker holding encoded rows (1,870 ms from objects); but decode plus fold is about twice E-02's follower CPU per append, and data's `group` view costs O(rows per bucket) per commit (2,647 µs a record at 1e6 rows). Moves: MIN and every F `all` row up on P-01, DEP-13 and F-21 (with decision 13's encoded rows); LEAN up a little on CPU (a folding follower doubles its CPU per record) but down on F-05 without its warm standby (a cold rebuild passes 2.5 s above about 560,000 rows); every candidate down on P-12 until data's `group` emits per-row deltas (a data-side change, DATA-05); no move on L (the decode's cost is the record format's, DEV-09).
