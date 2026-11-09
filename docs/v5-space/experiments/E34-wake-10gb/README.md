# E-34: waking 10 GB of rows

**Question (Q-34).** Can one Node process wake 10 GB of rows to writable within a minute, with GC pauses under 1 s? "Wake" means: the process starts, reads its snapshot from disk, folds it into `data`, and takes its first committed write. The question decides SC-05 (scale to zero and back: "10 GB is writable again ≤ 1 min after wake"), SC-10's rows per process, F-06 (no false failover from a GC pause ≤ 1 s), F `all` against `ldr`, L `ts` against a native fold, decision 13 (the kernel on a worker thread), and conflict X15 (state past the V8 heap against synchronous reads).

**Threshold (QUESTIONS.md).** ≤ 60 s and a max GC pause < 1 s → F `all` in TS meets SC-05. Otherwise state off the V8 heap (a native fold, LEAN's leader-only fold, or SC-06's cold rows) is planned now, and SC-05's bar is stated per storage form.

## What "10 GB of rows" means here

QUESTIONS.md reads 10 GB as about 5e6 rows, from DEP-13's budget of 2 KB a row. E-05 measured a small row (about 100 B of data) at about 330 B of V8 heap, not 2 KB. So the two readings differ by 6 times, and this experiment runs both:
- **5e6 small rows** (the row count the question names): a 0.64 GB snapshot, about 1.7 GB of heap.
- **5e6 rows of about 2 KB** (the bytes the question names): each small row plus a 1,900-character text field, a **10.2 GB snapshot**, about 11 GB of heap. Its first half (2.5e6 rows, 5.1 GB) is the "5 GB, then scale" case the question allows for the worker form.

A third reading, 10 GB of *small* rows (about 8e7 rows, 26 GB of heap), cannot run on this 16 GB box, and cannot run in one `data` source on any box: data keys a source's rows in a JS `Map`, and V8 caps a `Map` at 2^24 = 16,777,216 entries (measured below).

## Method

Everything goes through fero v4's real seam: [tree.sh](tree.sh) copies `api/substrate.ts`, `kernel/env.ts` and `kernel/codec.ts` from fero (68a5b8e) into a scratch tree and links `data` (63fea66) beside them. Nothing in fero or data is changed. The code is in [bench/](bench).

- **Snapshots** ([bench/gen.mjs](bench/gen.mjs), [gen.sh](gen.sh)). Insert records in fero v4's codec, 256 to a frame, each frame with its crc32c, back to back in one file: 5e6 small rows (128 B a row, 0.64 GB, written in 33 s) and 5e6 rows of about 2 KB (2,039 B a row, 10.2 GB, written in 117 s). They live in the scratchpad, not the repo.
- **Wake on the main thread** ([bench/wake.mjs](bench/wake.mjs)), form (a). One process: read the snapshot in 64 MiB chunks, check every frame's crc, decode it with fero's codec, fold it into a `data` source through the seam's lane (one batch per frame). Then the **first committed write**: a new row's record is encoded, appended to a journal file and `fdatasync`'d, then folded with `substrate.applyRec`. "Committed" is local here: there is no replication round trip (E-01's C = 0.73 ms would add to it). Time is counted from the process start (`performance.now()`, whose zero is the process's start). A second way to fill, `adopt`, puts every row in one plain object and lets data adopt it (`$(obj)`): data then builds its key map only at the first new-key write.
- **Wake in decision 13's form** ([bench/wake-d13.mjs](bench/wake-d13.mjs)), form (b). A worker thread reads the snapshot and keeps the frames' bytes as they are (an arena of 64 MiB buffers outside the V8 heap) with a `Map` from row key to where its latest record sits: the compact form. With projection `all`, it hands each frame to the main thread, which decodes and folds it through the seam; with `none`, the main thread holds no rows. A write goes main → worker (journal, `fdatasync`, arena, index; a field update re-encodes the row) → main (applyRec). Time to the first write is to the main thread holding it.
- **After the wake: 30 s of writes at 10,000 a second** (both forms): every 1 ms, the writes due at that rate (half field updates, a quarter whole-row rewrites, a quarter new rows), one journal frame per tick, `fdatasync` every 100 ms, folded with `applyRec` (fero v4's path). GC pauses are perf_hooks `gc` entries on each thread; event-loop delay is `monitorEventLoopDelay` at 1 ms resolution. A GC is put in the load or the write phase by its own start time.
- **Heap flags.** The small rows ran with the default heap (2,096 MB here), 3,072 and 4,096 MB, to find what is needed; the 10 GB case with 14,336 MB (the box has 16 GB); the 5 GB case with 7,168 MB.
- **Side probes.** [bench/limits.mjs](bench/limits.mjs): how many keys a JS `Map`, a plain object and a `data` source hold before V8 refuses (heavy lock, each capped at 150 s). [bench/worker-gc.mjs](bench/worker-gc.mjs): the longest GC pause while one thread fills a `Map` of 5e6 row keys, on the main thread and on a worker. A `dd` read of the 10 GB file after each big hold gives the disk's read speed.
- **Timing.** Three runs, each two holds of `$SP/bin/timing` (small rows, then big rows), every wake preceded by its load average and free memory. One wake runs longer than the brief's 60 s, because the bar it tests is 60 s and the 10 GB load alone takes longer; it is still one process per measurement. Run 1's small-row hold ran before two fixes to the harness (GC pauses sorted into phases by start time; perf_hooks' GC kind codes), so it was run again as run 4 and its lines moved to `results/superseded-wake-run1-small.jsonl`. Tables give the median of the runs and, in brackets, the spread (lowest and highest run). Machine: 4 vCPU, 16 GB, one virtual disk, Linux 6.18 (Firecracker VM), Node 22.22.0 (V8 12.4).

To reproduce: `./fetch.sh` (data at 63fea66), `./run.sh` (setup, snapshots, limits, timing), then `python3 summarize.py`. The snapshots need 11 GB of free disk; delete `$SP/e34/*.snap` afterwards.

## Results

Raw lines: [results/wake.jsonl](results/wake.jsonl) (each wake preceded by its load average and free memory), [results/worker-gc.jsonl](results/worker-gc.jsonl), [results/limits.jsonl](results/limits.jsonl), [results/disk-read.jsonl](results/disk-read.jsonl), [results/gen.jsonl](results/gen.jsonl). The tables are printed by [summarize.py](summarize.py).

<!-- tables:start (python3 summarize.py) -->

### wake: time to the first committed write, memory, and GC pauses (median of runs, spread of runs)

| rows | shape | snapshot GB | form | load | heap flag MB | wake to first write s | load s | first write ms | max RSS MB | heap used after load MB | GC max pause in load ms | runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5,000,000 | small | 0.64 | main | adopt | 4096 | 30.2 (29.8-30.5) | 23.3 (23.0-23.6) | 6,717 (6,456-7,054) | 2,785 (2,783-2,787) | 1,944 (1,943-2,442) | 341.2 (72.1-425.0) | 3 |
| 5,000,000 | small | 0.64 | main | lane | 3072 | 22.3 (22.0-22.9) | 22.1 (21.9-22.7) | 2.20 (1.90-2.30) | 2,061 (2,056-2,073) | 1,675 (1,673-1,684) | 58.5 (28.0-117.3) | 3 |
| 5,000,000 | small | 0.64 | main | lane | 4096 | 22.1 (20.8-22.7) | 22.0 (20.7-22.5) | 3.10 (2.10-4.00) | 2,234 (2,233-2,241) | 1,992 (1,991-1,994) | 28.5 (23.8-109.9) | 3 |
| 5,000,000 | small | 0.64 | main | lane | default | 23.7 (23.4-24.9) | 23.5 (23.3-24.8) | 2.30 (2.30-5.10) | 1,994 (1,993-1,997) | 1,707 (1,707-1,707) | 124.1 (118.1-600.3) | 3 |
| 5,000,000 | small | 0.64 | worker+all | frames | 4096 | 22.2 (22.0-24.5) | 22.0 (21.9-24.2) | 6.40 (4.90-7.40) | 3,683 (3,631-3,714) | 1,901 (1,900-1,955) | 470.0 (465.3-493.5) | 3 |
| 5,000,000 | small | 0.64 | worker+none | frames | 4096 | 9.94 (9.68-10.16) | 9.81 (9.53-10.02) | 7.10 (6.80-8.40) | 1,412 (1,409-1,428) | 9.00 (9.00-9.00) | 424.2 (272.1-448.1) | 3 |
| 2,500,096 | big | 5.1 | main | lane | 7168 | 36.4 (36.2-36.9) | 36.3 (36.0-36.7) | 2.80 (2.20-3.40) | 6,126 (6,117-6,155) | 5,469 (5,466-5,470) | 52.5 (42.1-57.5) | 3 |
| 2,500,096 | big | 5.1 | worker+all | frames | 7168 | 32.1 (30.1-32.4) | 31.9 (30.0-32.2) | 9.20 (8.10-16.00) | 12,007 (11,951-12,093) | 5,557 (5,466-5,560) | 241.3 (214.8-264.2) | 3 |
| 5,000,000 | big | 10.2 | main | lane | 14336 | 93.9 (86.3-122.4) | 93.6 (86.1-122.3) | 9.70 (3.60-15.80) | 12,021 (12,005-12,037) | 11,119 (11,119-11,119) | 127.1 (121.3-460.2) | 3 |
| 5,000,000 | big | 10.2 | worker+none | frames | 4096 | 59.7 (59.2-61.3) | 59.5 (59.0-61.1) | 15.5 (7.8-16.4) | 11,226 (11,224-11,233) | 9.00 (9.00-10.00) | 478.0 (450.8-485.4) | 3 |

### under 10,000 writes a second for 30 s after the wake: GC pauses and event-loop delay (ms)

A 30 s phase has fewer than 1,000 GCs, so its p99.9 is its longest pause.

| rows | shape | form | heap flag | writes/s | GC max (main) | GC p99.9 (main) | major GCs (main) | GC max (worker) | GC p99.9 (worker) | loop delay p99.9 | loop delay max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 5,000,000 | small | main (adopt) | 4096 | 10,000 (10,000-10,000) | 15.9 (10.5-340.8) | 15.9 (10.5-340.8) | 0.00 (0.00-1.00) | - | - | 9.10 (8.40-9.20) | 32.4 (32.2-1102.1) |
| 5,000,000 | small | main (lane) | 3072 | 10,000 (10,000-10,000) | 9.60 (8.70-10.10) | 9.60 (8.70-10.10) | 0.00 (0.00-0.00) | - | - | 8.30 (8.30-8.50) | 24.5 (17.0-29.1) |
| 5,000,000 | small | main (lane) | 4096 | 10,000 (10,000-10,000) | 11.4 (9.0-16.2) | 11.4 (9.0-16.2) | 0.00 (0.00-0.00) | - | - | 8.70 (8.00-8.70) | 26.2 (23.1-28.4) |
| 5,000,000 | small | main (lane) | default | 10,000 (10,000-10,000) | 10.4 (10.3-13.3) | 10.4 (10.3-13.3) | 0.00 (0.00-0.00) | - | - | 8.40 (8.10-8.70) | 22.7 (18.4-38.4) |
| 5,000,000 | small | worker+all (frames) | 4096 | 10,000 (10,000-10,000) | 14.3 (11.5-23.5) | 14.3 (11.5-23.5) | 0.00 (0.00-0.00) | 279.5 (239.4-328.1) | 279.5 (239.4-328.1) | 8.70 (7.80-8.80) | 24.8 (12.7-28.9) |
| 5,000,000 | small | worker+none (frames) | 4096 | 10,000 (10,000-10,000) | 1.60 (1.00-3.10) | 1.60 (1.00-3.10) | 0.00 (0.00-0.00) | 280.1 (267.1-285.3) | 280.1 (267.1-285.3) | 3.00 (3.00-3.60) | 8.10 (5.60-8.70) |
| 2,500,096 | big | main (lane) | 7168 | 10,000 (9,999-10,000) | 26.4 (23.2-40.3) | 26.4 (23.2-40.3) | 0.00 (0.00-0.00) | - | - | 21.7 (20.8-22.3) | 43.4 (43.1-72.6) |
| 2,500,096 | big | worker+all (frames) | 7168 | 10,000 (9,999-10,000) | 113.1 (76.3-165.0) | 113.1 (76.3-165.0) | 1.00 (0.00-1.00) | 181.1 (175.0-250.5) | 181.1 (175.0-250.5) | 22.7 (22.6-23.2) | 120.8 (80.2-176.0) |
| 5,000,000 | big | main (lane) | 14336 | 10,000 (9,798-10,000) | 89.6 (84.6-211.8) | 89.6 (84.6-211.8) | 0.00 (0.00-1.00) | - | - | 42.8 (40.6-60.8) | 373.6 (148.8-405.5) |
| 5,000,000 | big | worker+none (frames) | 4096 | 10,000 (10,000-10,000) | 3.00 (3.00-3.70) | 3.00 (3.00-3.70) | 4.00 (4.00-4.00) | 349.0 (318.6-467.4) | 349.0 (318.6-467.4) | 4.00 (3.50-4.10) | 11.4 (8.3-28.7) |

### where the main-thread load time goes (s; GC runs inside decode and fold, so the parts overlap)

| rows | shape | load | read | crc | decode | fold | of which GC |
|---|---|---|---|---|---|---|---|
| 5,000,000 | small | adopt (4096 MB) | 0.14 (0.14-0.16) | 1.51 (1.51-1.53) | 16.1 (15.9-16.5) | 5.35 (5.34-5.45) | 4.61 (4.54-4.74) |
| 5,000,000 | small | lane (3072 MB) | 0.15 (0.14-0.15) | 1.53 (1.51-1.55) | 14.8 (14.7-15.3) | 5.61 (5.45-5.70) | 3.32 (2.96-3.46) |
| 5,000,000 | small | lane (4096 MB) | 0.14 (0.14-0.15) | 1.48 (1.48-1.54) | 14.7 (13.7-15.2) | 5.67 (5.35-5.67) | 3.29 (3.11-3.31) |
| 5,000,000 | small | lane (default MB) | 0.66 (0.61-0.71) | 1.52 (1.52-1.56) | 15.7 (15.2-16.3) | 5.83 (5.64-6.23) | 3.60 (3.32-3.83) |
| 2,500,096 | big | lane (7168 MB) | 3.21 (2.84-3.59) | 12.1 (12.1-12.2) | 17.6 (17.2-18.1) | 3.44 (3.34-3.55) | 9.65 (9.42-9.88) |
| 5,000,000 | big | lane (14336 MB) | 5.69 (5.15-6.23) | 24.1 (23.9-24.4) | 51.8 (47.8-55.7) | 8.24 (8.15-8.33) | 35.6 (32.9-38.3) |

### a Map of 5e6 row keys filled on the main thread, then on a worker: longest GC pause (ms)

| where | worker heap limit | longest pause, each try | GC kind of the longest (4 = major) | build s |
|---|---|---|---|---|
| main | - | 44, 49.3, 46, 40.7, 59.5, 47.3, 50.8, 73.8, 54, 57, 60.7, 53.4, 57.7, 49.8, 48.5, 134.3, 49.9, 45.2 | 1, 1, 1, 1, 1, 1, 1, 4, 1, 1, 1, 1, 1, 1, 1, 4, 1, 1 | 4.58 (4.31-5.27) |
| worker | 4096 | 174.3, 168.5, 182.3, 154.5, 207.4, 163.4, 143.4, 162.7, 163.8 | 4, 4, 4, 4, 4, 4, 4, 4, 4 | 4.68 (4.58-4.95) |
| worker | default | 104.5, 148.2, 230.4, 203.7, 253, 130.1, 258.3, 167.9, 123.4 | 4, 4, 4, 4, 4, 4, 4, 4, 4 | 4.89 (4.66-5.22) |

load average at the start of each wake: median 1.05, range 0.58-3.30; memory available: 13,479-15,331 MB; n=30

<!-- tables:end -->

Row ceilings ([results/limits.jsonl](results/limits.jsonl), heavy lock): a JS `Map` held 16,777,216 keys and then threw `Map maximum size exceeded`; **a `data` source filled through fero's seam stopped at exactly the same 16,777,216 rows with the same error** (it keys rows in a `Map`). A plain object used as a dictionary (data's adopted-object mode) has a cliff instead of an error. It did not finish: after about 330 s at full CPU it was stopped by hand, and so was a second try on 2026-11-08 (630 s) that checked its 150 s cap every 1,024 keys, so one block of 1,024 inserts took minutes. A third probe ([bench/limits-object-progress.mjs](bench/limits-object-progress.mjs), [results/limits-object-progress.jsonl](results/limits-object-progress.jsonl), heavy lock, cut off at 200 s) printed its progress every 262,144 keys: 0.2-0.5 s a block up to 8,126,464 keys (14 s in all, with a few 1.5 s blocks where the table grew), then 5.5 s for the block that reached 8,388,608 (2^23), then no further block in the remaining 180 s. So an adopted object stalls just past 2^23 = 8.4 million keys, half the `Map`'s ceiling (reasoned: the dictionary's next doubling does not complete; the V8 source was not read). Another reason for the wake to fold through the lane, not adopt one object.

Disk: `dd` read the 10.2 GB snapshot at 2.7-5.9 GB/s after the wakes (four reads, runs 2 and 3; part of the file was in the page cache).

## What the numbers say

**1. 5e6 small rows wake in about 21-25 s on the main thread, well inside the minute.** The 0.64 GB snapshot becomes 1.7-2.0 GB of heap. Most of the load is fero v4's decode (about 14-16 s), then the fold (about 5.5-6 s, with 3-4 s of GC inside it), the crc (1.5 s) and the read (0.15 s, from the page cache). The first committed write then takes about 2 ms (one `fdatasync`).

**2. 10 GB of 2 KB rows does not: 86-122 s (median 94 s) on the main thread, and the time is the CPU, not the disk.** The 10.2 GB snapshot becomes 11.1 GB of heap (12 GB RSS), so the process needs `--max-old-space-size` of about 12-13 GB, nearly the whole 16 GB box. Its load splits into decode 48-56 s and crc 24 s, with 33-38 s of GC inside them, the fold 8 s, and the read 5-6 s; `dd` reads the file at 2.7-5.9 GB/s. fero v4's crc32c is JavaScript (about 420 MB/s here) and its decode copies every 2 KB string into a fresh V8 string that the young generation then copies again. The 5.1 GB half wakes in 36 s. So this box wakes about 10 s per GB of 2 KB rows, or about 4.5 µs per small row: the minute holds about 5-6 GB of 2 KB rows, or about 13 million small rows if one source could hold them (it cannot past 16.8 million, below).

**3. GC pauses stay under 1 s on the main thread, even with an 11 GB heap.** Under 10,000 writes a second after the wake, the longest main-thread GC pause was 9-16 ms with 5e6 small rows and 85-210 ms with 11 GB of heap. During the load the longest were 24-124 ms (small rows) and 121-460 ms (11 GB). One small-row wake at the default 2 GB heap, with 1.7 GB used, took a 600 ms pause: the default heap holds 5e6 small rows but with no room to spare, so the flag this needs is about 3 GB. The event loop's worst delay under the writes was 17-38 ms (small rows) and 150-410 ms (11 GB). F-06's 1 s bar holds in every main-thread run.

**4. The worker form (decision 13) wakes faster only when the main thread holds nothing, and moves the long pauses onto the kernel's thread.** A worker that keeps the snapshot's bytes as they are, with a `Map` index of row keys, reaches its first write in about 10 s for 5e6 small rows and about 60 s for the 10 GB snapshot (read, JS crc and a key scan; no values decoded). With every row also projected on the main thread it is no faster than the main-thread form (23 s small, 32 s for 5 GB), and it holds the rows twice: 12 GB RSS for the 5 GB case, so the 10 GB case with a full projection (about 21-24 GB, reasoned) cannot run on this box. The worker's own GC pauses were 240-490 ms (major collections while it holds a `Map` of 5e6 keys), against 40-75 ms for the same `Map` on the main thread (the side probe: [bench/worker-gc.mjs](bench/worker-gc.mjs); explicit `resourceLimits` did not change it). Those pauses land on the thread decision 13 gives the kernel's heartbeats (`ping.ms` is 500 ms in DESIGN-V5): under 1 s, so F-06 holds, but with little margin. An index outside the V8 heap (a hash table in an `ArrayBuffer`) would avoid them; that is reasoned, not measured.

**5. Two traps for a wake path.** Letting data adopt one big object (`$(obj)`, its adopted-object mode) defers its key map to the first new-key write: that write then took 6.5-7.1 s for 5e6 rows, and in one run of three the event loop stalled 1.1 s a little later. A v5 wake should fold through the lane, as here. And one `data` source keys its rows in a JS `Map`, which V8 caps at 2^24 = 16,777,216 entries (an adopted plain object stalls earlier, just past 2^23): SC-10 must list it as a ceiling (rows per resource per process), and a resource past it needs several sources or groups per process.

**6. "Writable" does not need the fold (reasoned).** A write commits when its record is in the log at a majority; only reads, conditions and methods need the folded rows. A server could take blind writes (and queue the rest) as soon as its log is open, and fold behind them, as SC-05 already allows ("writes made meanwhile wait, then commit"). That turns the bar into two numbers: time to the log open (seconds) and time to rows readable (the tables above).

## What this box cannot show

- A faster CPU or native code. The wake here is CPU-bound in JavaScript (decode, crc32c, GC); a native or WASM decoder, a native crc32c and a snapshot format V8 can take whole (for example strings as one buffer) were not built. How much they would save is not measured here.
- A cold disk at cloud speed. `dd` read 2.7-4.2 GB/s, partly from the page cache; the 10 GB wakes read with most of the file evicted (the process itself used 12 of 16 GB). A cloud volume (EBS gp3: 125-1,000 MB/s, cited from AWS's volume documentation) could make the read itself 10-80 s for 10 GB.
- More memory. The 10 GB worker form with a full projection needs about twice the heap and could not run; it is scaled from the 5 GB case.
- Other row shapes. Only flat ~100 B rows and the same rows with one 1,900-character string ran.

## Verdict

**Not for 10 GB of 2 KB rows on this box: 86-122 s (median 94 s) to the first committed write on the main thread.** GC is not the problem: every main-thread pause stayed under 1 s. Neither is the disk (a read of about 6 s) or data's fold (8 s). The wall is JavaScript work around the fold: fero v4's crc32c (24 s) and its decode (52 s, with 36 s of GC inside). Half of it, 5 GB, wakes in 36 s, and 5e6 small rows (the row count the question names) in 22-24 s. So on this box the minute holds about 5-6 GB of 2 KB rows, or about 13 million small rows (below the 16.8 million rows one `data` source can hold at all). Decision 13's compact worker reaches its first write of the 10 GB in about 60 s when the main thread holds no rows, but its own GC pauses (0.25-0.49 s, from a 5e6-key `Map`) land on the kernel's thread, and with every row also projected on the main thread it holds them twice (about 22-24 GB for 10 GB, which this box does not have).

Q-34: no for 10 GB of 2 KB rows: one Node process wakes them to the first committed write in 86-122 s (median 94 s; 11.1 GB of heap, so `--max-old-space-size` of about 12-13 GB), CPU-bound in fero v4's JS crc32c (24 s) and decode (52 s, 36 s of it GC), not the disk (about 6 s) or data's fold (8 s); 5 GB wakes in 36 s and 5e6 small rows in 22-24 s (1.7-2.0 GB of heap: the default 2 GB heap holds it with one 0.6 s pause in three runs, about 3 GB is comfortable); main-thread GC pauses stay under 1 s everywhere (at most 0.46 s in a load and 0.21 s under 10,000 writes a second with 11 GB of heap); one `data` source holds at most 16,777,216 rows (V8's `Map` limit; an adopted plain object stalls just past 8.4 million keys). Moves: F `all` in TS meets SC-05 only up to about 5-6 GB of 2 KB rows (or about 13e6 small rows) per process here, so SC-05's bar is stated per storage form and a faster wake (a native crc32c, a record format V8 decodes natively, taking writes while the fold catches up) is planned now; F-06 up for TS on the main thread (pauses under 1 s even at 11 GB); decision 13's compact worker down a little on F-06 and F-14 (0.25-0.49 s pauses on the kernel's thread; keep its index off the V8 heap); SC-10 gains the ceiling of 16.8M rows per `data` source; SRV (rows folded natively) and RUST (crc and log in Rust) up a little on SC-05 (reasoned from the breakdown, not measured).
