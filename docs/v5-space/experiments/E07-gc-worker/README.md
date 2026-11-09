# E-07: GC pauses, and a kernel on a worker thread

**Question (Q-07).** Can a TypeScript kernel avoid false failovers and user-code stalls? Two parts. First: how long are Node's garbage-collection pauses (GC: the engine stops JavaScript to free memory) when a process holds many `data` rows and takes steady writes? A pause near `election.ms` (2 s in TypeScript) makes the followers think the leader died, a false failover (F-06). Second: decision 13a puts the kernel on a worker thread (a second JavaScript thread in the same process) so that user code and the main thread's GC cannot stop it. What does crossing between the two threads cost per record, and does a stalled main thread really leave the kernel alone (F-14)?

**Decides.** Decision 13; F-06, F-14; `election.ms` in TS; X6; whether TS can hold the F-05 TS bar at all.

**Thresholds (QUESTIONS.md).**
- Worst pause < 1 s (half of the 2 s `election.ms`) at the target heap → F-06 holds in TS. Above → rows leave the main heap (worker or native) from phase 2.
- Crossing ≤ 0.5 µs per record and heartbeat jitter ≤ 50 ms in a 5 s main-thread stall → decision 13a is affordable and F-14 holds.

## Method

Everything runs in Node 22.22.0 (V8 12.4) on the study box (4 vCPU, 15 GB, Linux 6.18 Firecracker VM). [tree.sh](tree.sh) builds the same scratch tree E-05 and E-34 use: fero's `api/substrate.ts`, `kernel/env.ts` and `kernel/codec.ts` (fero a08ac53) with `data` linked beside them (63fea66, `SCHEDULE_VERSION` 4). Nothing in fero or data is changed. The code is in [bench/](bench).

**(a) GC pauses on the main thread** ([bench/gc.mjs](bench/gc.mjs)). A fresh process fills one `data` source with N rows the way a replica does: insert records encoded in fero frames of 256, decoded, and folded through data's hot lane, so every row owns its strings. Two row shapes, borrowed from E-34: `small` (about 100 B, E-05's row) and `big` (the same plus a 1,890-character text field, about 2 KB: DEP-13's "2 KB a row"). Sizes: 1e5 big (0.2 GB of row data), 1e6 big (2 GB), 1e6 small and 5e6 small. The 5e6 big case (10 GB) belongs to E-34, which measured it (cited below). After the load, one forced GC, then 30 s of steady writes at 10,000 and at 50,000 a second: every 1 ms tick, the writes due are encoded into one frame, decoded and folded through the lane (at most 2,000 in one tick, so a late tick is followed by a catch-up burst, as queued writes would be). The mix keeps the row count flat: half field updates, a quarter whole-row rewrites, an eighth new rows, an eighth removes of the oldest row. Recorded for the write phase: every GC pause (`perf_hooks` `gc` entries: the time JavaScript was stopped, by kind) and the event-loop delay (`monitorEventLoopDelay`, 1 ms resolution), as p99, p99.9 and max. The heap limit is set to 8 GiB (`--max-old-space-size=8192`) so no run sits near its limit; 5e6 small rows also ran at Node's default limit (2 GiB here), as a deployment that never sized its heap would.

**(b) The crossing** ([bench/cross.mjs](bench/cross.mjs)). The main thread sends batches of records to a worker; the worker reads each record (as a kernel stamps it) and sends the batch back (the commits the main thread will fold); the main thread reads them again. So each record crosses twice. Records use E-02's layout (12 B header + 100 B payload). Up to 32 batches are in flight. Batches of 1, 16 and 256. Four ways:
- `transfer`: each batch is an `ArrayBuffer` moved with `postMessage(ab, [ab])` both ways (no copy; buffers are reused);
- `sab`: two single-producer single-consumer rings in `SharedArrayBuffer`s (64 slots of one batch), with a `postMessage` "doorbell" per drain in each direction, so both threads keep their event loops (a real kernel thread must also serve its sockets and timers);
- `sab-block`: the same rings, but both threads block in `Atomics.wait`: the raw floor, which a kernel with sockets cannot use;
- `clone`: an array of plain objects, structured-cloned both ways (the naive way).

Each run lasts 5 s. Reported: wall ns per record per crossing, and each thread's busy time per record (`performance.eventLoopUtilization`; for `sab-block`, the worker's time outside `Atomics.wait`).

**(c) A stalled main thread** ([bench/stall.mjs](bench/stall.mjs), [bench/peer.mjs](bench/peer.mjs)). A tiny kernel holds one TCP link to a peer process (a follower): it sends a heartbeat every 100 ms, and acks each write the peer sends (one 100 B write a millisecond) after appending it to an in-memory log; it hands every committed write to the main thread for the fold (transferred buffers, one per event-loop turn). The kernel runs either on a worker thread (decision 13a) or on the main thread (the control). After 3 s the main thread stalls: `busy` is a 5 s synchronous loop (user code that never yields); `gc` builds a 3e6-entry `Map` of small objects and forces two full GCs (stop-the-world, 0.3-0.5 s each). The peer records every heartbeat's arrival and every write's round trip; the kernel records its own timer gaps; the main thread counts the commits that queued for it during the stall and how long it took to drain them.

**Timing.** Every process ran under `$SP/bin/timing` (the box to itself), in five holds (`./run.sh gcA`, `gcB`, `gcC`, `cross`, `stall`), 3 runs of each configuration, each process under about 60 s, its load average recorded before it. Tables give the median and, in brackets, the lowest and highest run.

Reproduce: `./run.sh` (setup, then the five holds), then `./run.sh summary` (= `python3 summarize.py`). Raw lines: [results/](results).

## Results

All raw lines are in [results/](results) (`gc.jsonl`, `cross.jsonl`, `stall.jsonl`; each process is preceded by its load average). The tables are printed by [summarize.py](summarize.py).

<!-- tables:start (python3 summarize.py) -->

### GC pauses on the main thread: while loading the rows, and under 30 s of steady writes

Pauses are perf_hooks `gc` entries (JavaScript stopped). Load phase = filling the rows (the heap grows, so major GCs run); writes = the 30 s write phase after one forced GC (columns: longest pause of any kind, longest major, longest minor, p99 of all). ELD = event-loop delay in the write phase.

| rows | shape | heap limit MB | offered/s | runs | achieved/s | heap after load MB | load s | load phase: longest pause ms | writes: longest pause ms | major ms | minor ms | GC p99 ms | ELD p99 ms | ELD p99.9 ms | ELD max ms | load avg |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100,000 | big | 8,240 | 10,000 | 3 | 10,000 (10,000-10,000) | 227 (227-227) | 1.5 (1.4-1.5) | 23.1 (22.6-27.0) | 5.9 (4.9-6.1) | 0.0 (0.0-0.0) | 5.9 (4.9-6.1) | 5.1 (4.7-5.5) | 1.6 (1.6-1.7) | 4.6 (4.6-4.8) | 7.4 (6.9-13.9) | 1.1 (1.1-3.7) |
| 100,000 | big | 8,240 | 50,000 | 3 | 49,998 (49,998-49,999) | 227 (227-227) | 1.5 (1.5-1.5) | 23.7 (21.3-26.1) | 11.8 (11.1-12.2) | 11.8 (11.1-12.2) | 9.4 (7.0-9.7) | 7.8 (7.1-8.8) | 6.0 (5.7-6.2) | 10.1 (9.6-10.7) | 31.8 (29.5-32.0) | 0.8 (0.7-2.3) |
| 1,000,000 | big | 8,240 | 10,000 | 3 | 10,000 (10,000-10,000) | 2,178 (2,178-2,178) | 15.4 (15.2-15.8) | 200.8 (198.7-201.4) | 24.1 (20.0-25.0) | 0.0 (0.0-0.0) | 24.1 (20.0-25.0) | 13.9 (13.8-13.9) | 1.8 (1.7-2.0) | 10.9 (10.8-11.1) | 27.6 (22.3-32.0) | 0.8 (0.7-1.2) |
| 1,000,000 | big | 8,240 | 50,000 | 3 | 49,998 (49,998-49,999) | 2,178 (2,178-2,178) | 15.6 (15.3-16.0) | 206.4 (197.5-414.5) | 26.1 (24.9-37.4) | 0.0 (0.0-0.0) | 26.1 (24.9-37.4) | 13.5 (13.2-13.9) | 14.1 (13.6-14.5) | 20.4 (19.8-22.3) | 68.3 (62.5-69.2) | 0.8 (0.7-0.9) |
| 1,000,000 | small | 8,240 | 10,000 | 3 | 10,000 (10,000-10,000) | 324 (324-324) | 6.1 (6.0-6.3) | 154.0 (145.0-159.8) | 9.4 (4.8-10.6) | 0.0 (0.0-0.0) | 9.4 (4.8-10.6) | 9.4 (4.8-10.6) | 1.5 (1.5-1.6) | 4.7 (4.4-4.8) | 11.7 (7.4-11.8) | 0.7 (0.7-1.6) |
| 1,000,000 | small | 8,240 | 50,000 | 3 | 49,999 (49,999-49,999) | 324 (324-324) | 6.2 (6.1-6.5) | 163.5 (160.5-201.0) | 5.4 (5.4-10.4) | 0.0 (0.0-0.0) | 5.4 (5.4-10.4) | 5.0 (4.9-5.9) | 4.5 (4.4-4.6) | 6.4 (6.2-6.7) | 62.3 (54.0-71.1) | 0.6 (0.5-1.0) |
| 5,000,000 | small | 8,240 | 10,000 | 3 | 10,000 (10,000-10,000) | 1,669 (1,669-1,669) | 33.1 (32.9-35.3) | 863.2 (770.0-885.2) | 28.0 (13.7-28.3) | 0.0 (0.0-0.0) | 28.0 (13.7-28.3) | 28.0 (13.7-28.3) | 1.6 (1.5-1.6) | 8.0 (7.8-9.5) | 33.5 (27.6-110.8) | 1.1 (1.0-1.4) |
| 5,000,000 | small | 8,240 | 50,000 | 3 | 49,998 (49,997-49,999) | 1,669 (1,669-1,669) | 33.5 (33.3-35.8) | 842.1 (816.5-984.2) | 35.8 (25.9-45.5) | 0.0 (0.0-0.0) | 35.8 (25.9-45.5) | 13.8 (11.1-14.5) | 10.2 (10.1-10.9) | 13.8 (13.2-14.5) | 100.9 (59.4-123.7) | 0.8 (0.7-1.1) |

Failed processes: run 1: /home/user/fero/docs/v5-space/experiments/E07-gc-worker/bench/gc.mjs 5000000 small 10000 30, run 2: /home/user/fero/docs/v5-space/experiments/E07-gc-worker/bench/gc.mjs 5000000 small 10000 30, run 3: /home/user/fero/docs/v5-space/experiments/E07-gc-worker/bench/gc.mjs 5000000 small 10000 30

### Crossing between the main thread and a kernel worker (each record crosses in and out)

| mode | batch | runs | records/s (round trips) | wall ns per record per crossing | main busy ns per record (both crossings) | worker busy ns per record | load avg |
|---|---|---|---|---|---|---|---|
| transfer | 1 | 3 | 226,342 (219,399-244,184) | 2209.1 (2047.6-2279.0) | 4267.6 (3966.2-4351.9) | 4131.7 (3797.1-4234.0) | 1.5 (1.3-1.5) |
| sab | 1 | 3 | 635,019 (634,771-652,245) | 787.4 (766.6-787.7) | 718.1 (699.4-726.8) | 647.2 (630.7-676.2) | 1.5 (1.4-1.6) |
| sab-block | 1 | 3 | 693,671 (664,843-704,697) | 720.8 (709.5-752.1) | 1441.6 (1419.1-1504.2) | 522.6 (518.6-535.0) | 1.5 (1.3-1.5) |
| clone | 1 | 3 | 80,755 (77,116-87,429) | 6191.6 (5718.9-6483.7) | 12148.8 (11079.6-12644.8) | 10648.8 (10258.5-10714.4) | 1.5 (1.5-1.6) |
| transfer | 16 | 3 | 3,217,628 (3,123,604-3,535,723) | 155.4 (141.4-160.1) | 303.1 (273.5-308.4) | 276.3 (264.8-293.2) | 1.5 (1.4-1.5) |
| sab | 16 | 3 | 6,494,788 (6,196,365-6,528,532) | 77.0 (76.6-80.7) | 74.4 (73.7-76.9) | 70.0 (68.9-73.2) | 1.5 (1.5-1.6) |
| sab-block | 16 | 3 | 6,967,006 (6,804,104-7,074,224) | 71.8 (70.7-73.5) | 143.5 (141.4-147.0) | 56.3 (55.9-58.9) | 1.5 (1.4-1.6) |
| clone | 16 | 3 | 312,711 (303,498-316,864) | 1598.9 (1578.0-1647.5) | 3099.5 (3082.7-3229.3) | 2522.9 (2512.7-2546.9) | 1.5 (1.4-1.6) |
| transfer | 256 | 3 | 18,161,628 (17,431,800-18,487,241) | 27.5 (27.0-28.7) | 54.8 (53.7-57.0) | 40.6 (39.8-40.7) | 1.5 (1.4-1.6) |
| sab | 256 | 3 | 12,426,939 (12,258,637-12,504,634) | 40.2 (40.0-40.8) | 36.9 (36.6-37.0) | 35.8 (35.8-36.9) | 1.6 (1.5-1.6) |
| sab-block | 256 | 3 | 13,261,596 (12,879,293-13,298,110) | 37.7 (37.6-38.8) | 75.4 (75.2-77.6) | 32.6 (31.9-33.7) | 1.5 (1.4-1.5) |
| clone | 256 | 3 | 566,074 (543,547-569,758) | 883.3 (877.6-919.9) | 1761.9 (1755.2-1832.6) | 1374.8 (1346.1-1387.4) | 1.4 (1.4-1.5) |

### A stalled main thread: the kernel's heartbeat and writes

| kernel on | stall | runs | stall ms | kernel timer gap max in stall ms | heartbeat gap at peer, max in stall ms | write RTT p50 in stall ms | write RTT p99 in stall ms | write RTT max in stall ms | commits queued for main | main drain ms | load avg |
|---|---|---|---|---|---|---|---|---|---|---|---|
| worker | busy | 3 | 5,000 (5,000-5,000) | 100.9 (100.8-101.4) | 101.0 (100.9-101.6) | 0.20 (0.18-0.21) | 1.01 (0.99-1.26) | 9.45 (7.79-11.30) | 5,001 (5,001-5,001) | 12.7 (12.4-13.0) | 0.9 (0.6-1.1) |
| worker | gc | 3 | 2,750 (2,663-2,758) | 104.0 (101.1-104.7) | 104.7 (104.0-104.7) | 0.20 (0.19-0.23) | 4.09 (3.54-4.17) | 8.03 (8.00-9.98) | 2,752 (2,663-2,760) | 5.1 (3.4-5.3) | 0.8 (0.6-1.1) |
| main | busy | 3 | 5,000 (5,000-5,000) | 5092.6 (5088.3-5096.0) | 5092.6 (5088.4-5096.1) | 2403.28 (2402.92-2405.33) | 4949.22 (4948.25-4953.37) | 5000.86 (4999.75-5003.67) | 4,901 (4,855-5,001) | 6.6 (6.0-8.5) | 0.8 (0.6-0.9) |
| main | gc | 3 | 2,540 (2,431-2,627) | 2627.1 (2527.7-2722.4) | 2627.2 (2527.8-2722.7) | 1169.05 (1118.76-1217.51) | 2514.43 (2406.78-2601.72) | 2541.77 (2432.93-2629.68) | 2,538 (2,431-2,635) | 4.2 (4.0-8.2) | 0.8 (0.7-1.0) |

Forced full GCs on the main thread in the `gc` stall (ms, each run): 363, 370; 499, 415; 314, 378; 292, 340; 478, 348; 292, 382


<!-- tables:end -->

**Notes on the runs.** (1) The first four `cross` processes of run 1 (batch 1) started while a short smoke test of mine for E-27 (not under the lock, my mistake) was finishing; their numbers sit inside the spread of runs 2 and 3, so they are kept. (2) The default-heap run of 5e6 small rows failed (out of memory) in all three runs; the table's "failed processes" line names them. (3) The shell that drove the `gcC` hold hit its time limit during run 3; run 3 of `gcC` was re-run in a later hold (see the row counts in the table).

**Cited beside it (E-34, measured on this box):** 5e6 rows of 2 KB (10 GB of rows, an 11 GB heap) woke on the main thread with every GC pause under 0.46 s, and took 10,000 writes a second with pauses of at most 0.21 s ([E-34](../E34-wake-10gb/README.md)).

### What the numbers say

1. **GC pauses grow with the number of objects, not with bytes.** 1e6 rows of 2 KB (a 2.2 GB heap) paused at most 0.2 s (one run 0.41 s) while loading, and at most 37 ms under writes. 5e6 small rows hold fewer bytes (a 1.7 GB heap) but about five times as many objects, and their load paused **0.77-0.98 s**, just under the 1 s line. E-34's 10 GB of big rows paused at most 0.46 s. So the risk is a process with many small rows, not a big heap.
2. **Steady writes are cheap for the GC.** With the row count flat, 30 s of writes at 10,000 and 50,000 a second never started a major GC; the longest pause in any write phase was 45 ms, and the event-loop delay p99 stayed at 1.5-14 ms. The long pauses come from growth: a load, a wake, a snapshot, a burst of new rows.
3. **An unsized heap is the real danger.** At Node's default heap limit (2 GiB here), 5e6 small rows ran out of memory during the write phase in all three runs, after "last resort" full GCs of **1.2-1.45 s** each: a false failover first, then a crash. With `--max-old-space-size=8192` the same rows ran fine. A TS server must size its heap from its row count (or refuse rows past a bound, F-13).
4. **The crossing is cheap only in batches.** Handing records to a worker and back costs **27-40 ns per record per crossing at batch 256** and 77-155 ns at batch 16 (transferred `ArrayBuffer`s or a `SharedArrayBuffer` ring with a `postMessage` doorbell), well under 0.5 µs. One record per message costs 0.8 µs (ring) to 2.2 µs (transfer), and structured cloning plain objects costs 0.9-6.2 µs per record at any batch size. A kernel cuts a batch every 1 ms tick anyway, so it pays the batch price. The ring with a doorbell is about as fast as the blocking ring (`sab-block`), so nothing is lost by keeping both threads' event loops.
5. **A worker kernel ignores the main thread.** Through a 5 s busy stall of the main thread, the worker's heartbeat stayed within 1-5 ms of its 100 ms schedule and the peer's writes kept their round trip (p99 1.0 ms); through two forced full GCs of the main heap (0.29-0.50 s each, inside a 2.7 s stall), p99 4 ms. The same kernel on the main thread went silent for 5.1 s (and 2.6 s), past the 2 s `election.ms`: a false failover. The commits waiting for the main thread queued up (5,000 in a 5 s stall at 1,000 writes a second) and drained in 13 ms afterwards; that queue grows with the stall, so it needs a bound (F-13).


## What this box cannot show

- **Other heap shapes.** The rows here are flat objects with strings. A heap with many small nested objects per row, or with `data` views holding derived rows, has more pointers to trace; E-05 measured the views' fold cost, not their GC cost.
- **Bigger heaps.** 10 GB is E-34's (cited). Past that, this 15 GB box cannot go.
- **Other Node versions.** Node 22 (V8 12.4) only. Node 26 (V8 14.6) is on the box but was not run here.
- **Contention.** On a busy production host, GC helper threads compete with other processes; here the box was quiet (the timing lock).
- **The crossing on more cores.** One worker and one main thread; `kwN` (several kernel workers) is E-02's.

## Verdict

**F-06 holds in TypeScript with rows on the main thread only with a margin that is thin and conditional; F-14 holds with the kernel on a worker (decision 13a), and the crossing is affordable when records cross in batches.** The worst main-thread pause measured here was 0.77-0.98 s, while loading 5e6 small rows into a sized heap; every other case stayed at or under 0.41 s, and steady writes under 45 ms. At Node's default heap the same rows ran out of memory after 1.2-1.45 s full GCs. So: size the heap from the row count, bound the rows per process (about 5e6 small rows, or E-34's 5-6 GB of 2 KB rows, whichever comes first), and keep the kernel and its heartbeat off the main thread, where no main-thread pause can reach it. The worker's own heap must stay small too: E-34 measured 0.25-0.49 s pauses on a kernel worker that held a 5e6-key `Map` of rows, so the kernel's row index belongs off the V8 heap (or in the main thread's projection), not on the kernel's thread. Decision 13a costs 27-155 ns per record per crossing at batch 16-256, under the 0.5 µs bar, but 0.8-6 µs per record if records cross one at a time or as cloned objects, so the seam between the kernel worker and the main thread must carry batches of bytes, never per-record objects.

Q-07: the worst main-thread GC pause was 0.77-0.98 s (loading 5e6 small rows, a 1.7 GB heap, 8 GB limit), 0.2-0.41 s at 1e6 rows of 2 KB (2.2 GB), at most 45 ms under 10,000-50,000 steady writes a second, and 5e6 small rows at Node's default 2 GB heap ran out of memory after 1.2-1.45 s full GCs; a kernel on a worker crosses to the main thread at 27-40 ns per record (batch 256) and 77-155 ns (batch 16), but 0.8-2.2 µs one record at a time and 0.9-6.2 µs by structured clone, and it kept its heartbeat within 5 ms and write p99 ≤ 4 ms through a 5 s main-thread stall and 0.3-0.5 s forced GCs, where a main-thread kernel went silent 2.6-5.1 s. Moves: decision 13a (M `kw`, so MIN, DRAFT, LEAN, MIN-P, RLOG and MIN-TS) up on F-14 and F-06, on the condition that the seam carries byte batches; rows on the main thread (F `all` in TS) down a little on F-06 (thin margin past about 5e6 small rows; a sized heap is required: DEP-13 and F-13 gain "heap sized from rows, rows bounded per process"); SIDE down on its own reason (GC and stalls cannot stop replication: 13a gives that in one process), RUST and SRV unchanged (no GC on their kernel); X6 resolved as "kernel on its own thread, election.ms 2 s in TS".
