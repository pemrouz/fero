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
<!-- tables:end -->

Row ceilings ([results/limits.jsonl](results/limits.jsonl), heavy lock): a JS `Map` held 16,777,216 keys and then threw `Map maximum size exceeded`; **a `data` source filled through fero's seam stopped at exactly the same 16,777,216 rows with the same error** (it keys rows in a `Map`). A plain object used as a dictionary did not finish: after about 330 s at full CPU it was stopped by hand (the probe then checked its time cap only every 65,536 keys; it now checks every 1,024).

Disk: `dd` read the 10.2 GB snapshot at 2.7-5.9 GB/s after the wakes (four reads, runs 2 and 3; part of the file was in the page cache).

## What the numbers say

**1. 5e6 small rows wake in about 22-25 s on the main thread, well inside the minute.** The 0.64 GB snapshot becomes 1.7-2.0 GB of heap. Most of the load is fero v4's decode (about 14-16 s), then the fold (about 5.5-6 s, with 3-4 s of GC inside it), the crc (1.5 s) and the read (0.15 s, from the page cache). The first committed write then takes about 2 ms (one `fdatasync`).

**2. 10 GB of 2 KB rows does not: 94-122 s on the main thread, and the time is the CPU, not the disk.** The 10.2 GB snapshot becomes 11.1 GB of heap (12 GB RSS), so the process needs `--max-old-space-size` of about 12-13 GB, nearly the whole 16 GB box. Its load splits into decode 56 s and crc 24 s, with 38 s of GC inside them, the fold 8 s, and the read 5 s; `dd` reads the file at 2.7-4.2 GB/s. fero v4's crc32c is JavaScript (about 420 MB/s here) and its decode copies every 2 KB string into a fresh V8 string that the young generation then copies again. The 5.1 GB half wakes in 36 s. So this box wakes about 10 s per GB of 2 KB rows, or about 4.5 µs per small row: the minute holds about 5-6 GB of 2 KB rows, or about 13 million small rows if one source could hold them (it cannot past 16.8 million, below).

**3. GC pauses stay under 1 s on the main thread, even with an 11 GB heap.** Under 10,000 writes a second after the wake, the longest main-thread GC pause was 9-64 ms with 5e6 small rows and 85-90 ms with 11 GB of heap. During the load the longest were 110-460 ms. One small-row wake at the default 2 GB heap, with 1.7 GB used, took a 600 ms pause: the default heap holds 5e6 small rows but with no room to spare, so the flag this needs is about 3 GB. The event loop's worst delay under the writes was 17-28 ms (small rows) and 150-370 ms (11 GB). F-06's 1 s bar holds in every main-thread run.

**4. The worker form (decision 13) wakes faster only when the main thread holds nothing, and moves the long pauses onto the kernel's thread.** A worker that keeps the snapshot's bytes as they are, with a `Map` index of row keys, reaches its first write in about 10 s for 5e6 small rows and about 60 s for the 10 GB snapshot (read, JS crc and a key scan; no values decoded). With every row also projected on the main thread it is no faster than the main-thread form (23 s small, 32 s for 5 GB), and it holds the rows twice: 12 GB RSS for the 5 GB case, so the 10 GB case with a full projection (about 21-24 GB, reasoned) cannot run on this box. The worker's own GC pauses were 240-490 ms (major collections while it holds a `Map` of 5e6 keys), against 40-75 ms for the same `Map` on the main thread (the side probe: [bench/worker-gc.mjs](bench/worker-gc.mjs); explicit `resourceLimits` did not change it). Those pauses land on the thread decision 13 gives the kernel's heartbeats (`ping.ms` is 500 ms in DESIGN-V5): under 1 s, so F-06 holds, but with little margin. An index outside the V8 heap (a hash table in an `ArrayBuffer`) would avoid them; that is reasoned, not measured.

**5. Two traps for a wake path.** Letting data adopt one big object (`$(obj)`, its adopted-object mode) defers its key map to the first new-key write: that write then took 5.7-7.1 s for 5e6 rows, and one run's event loop stalled 1.08 s later. A v5 wake should fold through the lane, as here. And one `data` source keys its rows in a JS `Map`, which V8 caps at 2^24 = 16,777,216 entries: SC-10 must list it as a ceiling (rows per resource per process), and a resource past it needs several sources or groups per process.

**6. "Writable" does not need the fold (reasoned).** A write commits when its record is in the log at a majority; only reads, conditions and methods need the folded rows. A server could take blind writes (and queue the rest) as soon as its log is open, and fold behind them, as SC-05 already allows ("writes made meanwhile wait, then commit"). That turns the bar into two numbers: time to the log open (seconds) and time to rows readable (the tables above).

## What this box cannot show

- A faster CPU or native code. The wake here is CPU-bound in JavaScript (decode, crc32c, GC); a native or WASM decoder, a native crc32c and a snapshot format V8 can take whole (for example strings as one buffer) were not built. How much they would save is not measured here.
- A cold disk at cloud speed. `dd` read 2.7-4.2 GB/s, partly from the page cache; the 10 GB wakes read with most of the file evicted (the process itself used 12 of 16 GB). A cloud volume (EBS gp3: 125-1,000 MB/s, cited from AWS's volume documentation) could make the read itself 10-80 s for 10 GB.
- More memory. The 10 GB worker form with a full projection needs about twice the heap and could not run; it is scaled from the 5 GB case.
- Other row shapes. Only flat ~100 B rows and the same rows with one 1,900-character string ran.

## Verdict

VERDICT_TEXT

VERDICT_LINE
