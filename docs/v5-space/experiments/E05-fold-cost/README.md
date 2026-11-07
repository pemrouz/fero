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
<!-- tables:end -->

## What the numbers say

**1. The fold itself is cheap; fero v4's one-commit-per-record path and decoding are not.** Handing data a committed batch of 256 records costs FOLD_B256 µs of main-thread time per record with no views (field updates, whole-row sets, inserts and deletes; 1e3 to 1e6 rows). It grows with the number of rows (cache misses), not with the batch. Process CPU, which counts V8's GC helper threads, is higher at 1e6 rows (FOLD_CPU_1M µs), because the collector marks a 330 MB heap while the fold runs. fero v4's own path, one `applyRec` and one data commit per record, costs FOLD_REC µs. Decoding a ~100 B record with fero v4's codec costs more than folding it: DECODE_US µs per insert record in the replay (fold: FOLD_REPLAY_US µs). So a TS follower that folds what it receives pays about DECODE_PLUS_FOLD µs per record, most of it the codec.

**2. Rows are small: about 330 B of heap each, 6 times under DEP-13's 2 KB.** A small row costs MEM_ROW B of V8 heap after a full collection at 1e5 to 1e6 rows (a plain `Map` of the same decoded rows: MEM_MAP B, so data adds about 20 B a row). Rewriting every row leaves the same size (old versions are collected). A `group` view adds MEM_GROUP B a row, 100 filters MEM_FILTER B a row. RSS per row at 1e6 rows is about 540 B. The default heap here is 2,096 MB (`heap_size_limit`), so the default flags hold about 5 million small rows (E-34 loads 5e6 into it, with 1,707 MB used). At 1e3 rows the per-row figures are dominated by fixed costs.

**3. Decision 13's form fits too: about 510-530 B a row with every row on both threads.** The worker's compact rows cost D13_WORKER B a row (D13_ARENA B of encoded bytes outside the V8 heap, plus D13_WHEAP B of heap for the key index), the main thread's projection the same ~330 B as above: D13_TOTAL B in all. Holding rows as objects on both threads (the naive form) costs D13_NAIVE B. Both are well under 2 KB, so DEP-13 needs no restating for decision 13.

**4. Hashing 1e6 rows takes under 1 s only where the rows are already bytes.** On the worker's compact rows, an order-free 64-bit xxHash sum of 1e6 rows takes HASH_WORKER_1M ms (and gives the same digest as the main thread's hash of the same state). Where rows are objects, the encoding dominates: fero's codec encode alone takes ENC_1M ms for 1e6 rows, so `xx-sum` takes HASH_XX_1M ms, a sorted SHA-256 HASH_SHA_1M ms, and node:crypto per row HASH_MD5_1M ms. V8's `JSON.stringify` is the fastest encoder in JS (`json-xx`: HASH_JSON_1M ms), and is deterministic here because replicas that fold the same log build rows with the same key order. So F-21's hourly check is affordable on a kernel worker that holds encoded rows (decision 13), or in slices on the main thread; one 1-2 s block on the main thread would stall methods and views.

**5. Replay runs at REPLAY_LOAD records a second for a 1e6-row snapshot, REPLAY_MIXED for a mixed log, and decoding is most of it.** Rebuilding 1e6 small rows from fero v4's codec takes REPLAY_LOAD_S s (REPLAY_LOAD_SGB s per GB of log). The same records as JSON take REPLAY_JSON_S s (REPLAY_JSON_SGB s per GB). A `group` view built after the rows adds VIEW_BUILD s at 1e6 rows. So 2.5 s rebuilds about ROWS_IN_2_5S small rows; and F-05's 2.5 s already includes failure detection and an election (`election.ms` is 2 s in DESIGN-V5), which leaves about half a second, about ROWS_IN_0_5S rows.

**6. A finding outside the question: data's `group` view costs O(rows in a bucket) per commit.** With one `group` view (16 buckets) a field update costs GROUP_1E3 µs at 1e3 rows, GROUP_1E5 µs at 1e5 and GROUP_1E6 µs at 1e6 in batches of 256, and GROUP_REC_1E5 µs / GROUP_REC_1E6 µs with fero v4's one commit per record. [group-scale.mjs](bench/group-scale.mjs) shows why: the cost tracks the rows per bucket (62 → 62,500), with or without a sink, while a counting view over the same buckets (`length(fn)`) stays at a few µs. data's `BucketNode` rebuilds each touched bucket's whole emitted object on every commit (`ops/bucket.ts`, "rebuilding a touched bucket is one O(B) object fill"), and loading rows under a live `group` view is therefore quadratic (a 1e6-row load under one did not finish in minutes; views here are built after the rows). 100 `filter` views cost FILTER_1E5 µs a record at 1e5 rows and FILTER_1E6 µs at 1e6 (batches of 256): every predicate runs on every change, about 0.1-0.25 µs per view. P-12 asks for ≤ 1 µs per affected view and 5,000 room views at ≤ 20 µs a write: neither `group` (above about 100 rows a bucket) nor many `filter`s meets it today. This is a data-side change for every candidate (DATA-05): `group` must emit per-row deltas into a bucket, and many filters over one key need routing, not one predicate call each.

## Against the thresholds

| Threshold | Measured | Result |
|---|---|---|
| ≤ 2 µs per record (the fold) | lane, batch 256, no views: FOLD_B256 µs wall (1e3-1e6 rows); CPU incl. GC threads up to FOLD_CPU_1M µs at 1e6; fero v4's per-record path FOLD_REC µs; decode adds DECODE_US µs | **met for the fold in batches** on the main thread up to 1e6 rows; not met by v4's per-record path at 1e6, nor once decoding with v4's codec is counted |
| ≤ 2 KB per small row | MEM_ROW B heap (1e5-1e6), about 540 B RSS | **met** (6 ×) |
| decision 13's form ≤ 2 KB a row | D13_TOTAL B (compact worker + full projection); D13_NAIVE B naive | **met**; DEP-13 stands for it |
| hash of 1e6 rows ≤ 1 s of a background thread | HASH_WORKER_1M ms on the worker's compact rows; HASH_XX_1M ms on main-thread objects with v4's codec (HASH_JSON_1M ms with JSON) | **met on a worker that holds encoded rows**; not met by encoding objects with v4's codec |
| fold ≥ 30 % of E-02's CPU per append (1.65 µs leader, 1.2 µs follower) | lane CPU LANE_CPU_RANGE µs (1e3-1e6 rows); with decode about DECODE_PLUS_FOLD µs | **crossed** from about 1e5 rows for the lane alone, and at any size once decoding is counted: a folding follower spends about twice the CPU of E-02's follower per record (about 0.2 of a core at 50,000 writes/s, not a whole core) |
| replay of one group's state > 2.5 s → LEAN fails F-05 without its standby | REPLAY_LOAD records/s: 1e6 small rows take REPLAY_LOAD_S s; 2.5 s holds about ROWS_IN_2_5S rows | **crossed** for groups above about half a million small rows (or about ROWS_IN_0_5S once the election's 2 s is taken out): LEAN needs its warm standby |

## What this box cannot show

- Other CPUs. These are one Firecracker VM's vCPUs, shared with other agents' idle processes; µs per record would be lower on a dedicated modern core. Ratios (fold against decode, group against counts) should travel; absolute µs less so.
- Other V8 versions. Node 26 (V8 14.6) may change GC pauses and the per-row heap; only Node 22.22 ran here.
- Rows of other shapes. Every row here is a flat ~100 B object with a two-element array. Wide rows, long strings (E-34's 2 KB rows) and deep paths change both memory and decode cost.
- A real kernel. The fold is measured alone, not inside a running Raft group; E-02 gives the pipeline's own CPU, and the comparison between the two is reasoned, not measured together.
- A cold disk. The replay files were read from the page cache; E-34 measures reads of a 10 GB file.

## Verdict

VERDICT_TEXT

VERDICT_LINE
