# E-02: how fast a replication pipeline can be in TypeScript, Rust and Go

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-02: how fast can a replication pipeline be in TypeScript, Rust and Go on this disk, and at what CPU per append? (QUESTIONS.md §1.) It decides axis L (MIN, DRAFT and LEAN with `ts→rs`, against MIN-TS, RUST and SRV), axis M (`kw` against `kwN`), decision 3, PERF-08, PERF-09 and DEP-12.

## The answer in short

All measured here unless marked. Medians of 3 runs; the tables below give the ranges.

- **CPU per append is mostly a fixed cost per batch, in every language.** Each process spends about 0.2-0.3 of a core every second on the 1 ms tick, the thread wakeups and one round of syscalls per batch, whatever the rate. On top of that, each 100 B append costs 0.1-0.3 µs (TS about 2 × Rust). So "µs per append" depends on the rate far more than on the language: at 10,000 appends/s every build's leader spends 21-34 µs per append; at 50,000/s, 4.7-8.5 µs (4.7-6.9 at 100 B); at a million a second or more, under 0.5 µs.
- **TS passes its bars.** At 50,000 appends/s (PERF-09's TS bar per process) the TS leader spends **5.5 µs** of one core per committed append and each follower 3.9 µs, against the 20 µs line. p99 commit is **4.3 ms** on the real disk and **2.4 ms** with emulated independent disks, against C + 5 ms = 5.7 ms. TS on the main thread commits about **4 million** 100 B appends a second when the disk is not the limit (tmpfs) and **2.8 million** on the real disk.
- **Rust is about 2.5 × TS only where the disk is not the limit.** On tmpfs with emulated disks: Rust **10.1 million/s**, Go 7.1 million, TS on a worker 4.8 million, TS 4.0 million. On the real disk all four builds sit at **2.2-2.8 million** 100 B appends/s (280-350 thousand at 1 KiB), which is about 1 GB/s across the three journals: the disk's own bandwidth (E-01 measured 0.8-1 GB/s). So **on this box's disk, throughput did not separate the languages**, and MIN-TS ties MIN on G2 at this box's floor.
- **Rust meets the native CPU bar only at native rates.** At 50,000/s the Rust leader spends 4.7 µs per append (the fixed cost dominates). At 1.1 million/s it spends 0.33 µs. Fitted: 0.23 cores + 0.13 µs per append, so it is under 2 µs from about 130,000 appends/s. The native latency bar (C + 0.5 ms = 1.2 ms) is met only with emulated independent disks at moderate load (Rust 0.67 ms p99 at 50,000/s). On the real shared disk Rust's p99 is 1.6 ms at 50,000/s, and near the disk's limit every build's p99 is set by disk stalls (5-100 ms).
- **TS's tail is worse than its median.** At 50,000/s with emulated disks: p50 0.56 ms in TS, 0.38 in Rust, 0.40 in Go; p99 2.4 ms in TS, 0.67 in Rust, 0.75 in Go. The cause was not isolated; the event loop and V8's garbage collector are the likely ones (reasoned).
- **The kernel on a worker (`kw`) costs about 25% more CPU** (fixed 0.32 cores against 0.25; 6.9 against 5.5 µs per append at 50,000/s) and adds 0.05-0.1 ms at p50. It raised the ceiling only on tmpfs (4.8 against 4.0 million/s), because the main thread and the worker then share the work.
- **`kwN` did not scale on this box.** With 16 groups on tmpfs, 1, 2 and 4 kernel workers per process committed 5.5, 5.2 and 4.4 million appends/s: 4 workers gave 0.8 × one worker, not 3 ×. Three processes with 1 + N threads each share 4 vCPUs, and the main thread hands every write to the workers. The same holds inside one process with cores to spare: the leader alone on tmpfs (`ldr`, 16 groups) committed 5.8, 5.9 and 6.0 million/s with 1, 2 and 4 workers (1.03 ×), using only 1.5-1.8 of the 4 cores. So the limit is the main thread, which makes every write and hands it to a worker (about one core), not the workers. `kwN` can only scale if writes reach the workers without passing through one thread (for example, client sockets owned by the workers); this experiment did not build that. At a fixed 50,000/s, CPU per append grows with N (6.2, 10.1, 14.3 µs in the leader), because each worker pays its own fixed batch cost on a quarter of the records.
- **Groups cost almost nothing when they share one journal and one link.** At 50,000/s the TS leader spends 5.5, 5.6 and 5.7 µs per append with 1, 16 and 1,000 groups (Rust 4.7, 4.8, 4.7), and the ceiling stays at the disk's (2.5-3.5 million/s). Here a group costs two array writes per record; a real Raft group per shard adds its own messages, terms and timers (E-11 measures that). In that timing hold one or two of the three runs at 50,000/s caught a 100 ms disk stall in every build, so those p99 medians (54-83 ms) measure the disk, not the groups; the best run of each was 1.6-3.7 ms.
- **Rungs.** Not waiting for fsync (`memory`) cuts p50 at 50,000/s from 0.6-0.9 ms to 0.16-0.24 ms and p99 to 0.33-0.57 ms, and about doubles Rust's and Go's ceiling on this disk (5.0 and 5.6 million/s against 2.2 and 2.8). TS stays at 2.75 million: its main thread is then the limit (0.95 of a core). The leader alone with fsync (`ldr`) reaches 3.8 million/s in TS and 6.0-6.2 million in Go and Rust. With no followers and no disk (`none`) the ceiling is the language alone: **4.3 million/s in TS, 13.3 million in Go, 18.6 million in Rust**; at 50,000/s TS's `none` path costs 1.6 µs per append and commits in 0.03 ms. (Rust's and Go's `none` latency includes up to one 1 ms tick: their loop checks for commits after waiting for events. Their throughput and CPU are not affected.)
- **Preallocated segments beat growing files on this disk.** With 512 MiB segments made by `fallocate` (or filled with zeros) the real-disk ceiling rose from 2.8 to 3.6 million/s in TS, from 2.2 to 4.1 million in Rust and from 2.8 to 4.1 million in Go, and p99 at the ceiling fell from 146-627 ms to 40-91 ms. At half of each new ceiling p99 was 4.8-16 ms, against 5.5-70 ms for growing files at half of theirs. `falloc` and `zero` were within 11 % of each other. One caution: a 512 MiB segment wraps about once a second at these rates, so after the first lap the writes overwrite blocks already written; a journal that preallocates fresh segments, as etcd's WAL does, sits between the two rows. (E-01's probe, one 4 KiB write at a time, saw the layouts within 1.4 × of each other; the gap opens with big batches.)

## What was built

The smallest honest replication pipeline, written three times (TypeScript on Node 22, Rust, Go) with the same protocol, the same journal format, the same batching and the same commit rule. It is a floor, not a product: steady state only, no elections, no recovery, no clients on the network.

- **Three OS processes on loopback**: a leader and two followers. Each has its own journal file.
- **The leader** makes the writes itself (the load generator lives inside it). Every 1 ms tick it takes the writes due, frames them (a 20-byte header with a CRC32, then per record: group, index, length, payload), sends **the same bytes** to both followers at once, and queues them for its own journal.
- **The journal** (in every process) does group commit: when the disk is free, it writes everything queued with one `writev` and then one `fdatasync`. Writes that arrive meanwhile wait for the next round.
- **The followers** parse each frame, check that every group's index is the next one (Raft's log-matching check in its simplest form), append the frame bytes to their journal, and after each fdatasync send one ack: the highest batch that is now durable.
- **Commit** is a majority: a batch commits when two of the three copies are durable (the median of the leader's durable batch and the two acks). At commit the leader walks every record and sets that group's commit index, standing in for "notify the waiter".
- **Groups**: 1, 16 or 1,000 groups share one journal and one link per peer. Records go round robin over the groups. Every group keeps its own last index and commit index. Followers ack per batch, not per group: since a link delivers batches in order, one ack covers every group in the batch, and the leader maps the batch back to its groups. One Raft group per shard would send a reply per group per batch; that extra work is not measured here (E-11 measures many real groups).

The code: [ts/pipeline.ts](ts/pipeline.ts) (one file: main thread or N workers), [rs/src/main.rs](rs/src/main.rs) (plain threads: one kernel thread, one disk thread, one ack reader per follower), [go/main.go](go/main.go) (goroutines). The journals of all three processes are byte-identical after a run (checked with `cmp` during development).

Why Rust uses plain threads and not tokio: there are three sockets and one file per process, and `fdatasync` blocks a thread in any runtime (tokio sends file I/O to its blocking pool), so an async runtime would add wakeups and no parallelism here.

## Variants

| Axis | Values | Notes |
|---|---|---|
| Build | `ts` (Node 22, everything on the main thread: M `loop`), `ts-w1` (the kernel on one worker thread: M `kw`), `ts-w2`, `ts-w4` (2 or 4 kernel workers, groups pinned by group % N, one journal and one link per worker: M `kwN`), `rust`, `go` | In `ts-wN` the main thread makes the writes and receives commits (leader), or receives every durable frame and walks its records once, standing in for data's fold (followers). So the thread crossing is paid where `kw` would pay it. |
| Rung | `persisted` (commit = 2 of 3 durable), `memory` (commit = 2 of 3 have it in memory; files are written but never fsynced), `ldr` (the leader alone, with fdatasync), `none` (the leader alone, no disk) | The entry's `none` is "no followers"; `ldr` adds the leader-only fsync floor. |
| Record size | 100 B and 1 KiB payloads (plus a 12-byte record header) | |
| Groups | 1, 16, 1,000 | |
| Storage | `grow` (new files that grow), `falloc` (fallocated 512 MiB segments), `zero` (zero-filled 512 MiB segments, so every write is an overwrite), `emu` (tmpfs, see below) | `falloc` and `zero` files are made before the run by the driver. |
| Offered rate | `max`, fixed 10,000/s and 50,000/s, and `half` (half of that configuration's median `max`) | |

**The tmpfs variant (`emu`).** The journals live on tmpfs, so writes cost a memory copy and `fdatasync` returns at once. After each real `fdatasync`, the disk thread sleeps for a time drawn at random from E-01's one-writer fdatasync distribution ([1,000 quantiles](../E01-floors/results/fdatasync-1w-cdf.txt); p50 179 µs, p90 280 µs, p99 519 µs, top quantile 2.5 ms). This emulates three independent disks, which this box does not have. Rust and Go sleep with `nanosleep` on their disk thread; Node uses a 50-line N-API addon ([emu/emu.c](emu/emu.c)) that runs `fdatasync` and the sleep on libuv's thread pool, the same path `fs.fdatasync` takes. All three set the thread's timer slack to 1 µs. The table leaves out the rare 20-50 ms stalls of the real disk (above its top quantile), and it uses the 4 KiB distribution for every batch size, so big batches are flattered.

## How it was measured

- [bench.mjs](bench.mjs) starts the followers, then the leader, with a common start time. Each run: 2 s of warm-up, an **8 s window**, 1 s of drain. Each configuration runs **3 times**; tables show the median and the range (min-max). Every run records `/proc/loadavg` before it starts, and the box's busy cores during the window minus our own processes' cores ("other cores": work by other agents that do not take the lock).
- **Throughput** = records committed inside the window / 8 s.
- **Commit latency** = from the tick that made a write to the moment the leader learns it is committed. In `ts-wN` it is measured on the main thread, so it includes both thread crossings.
- **CPU** = `getrusage(RUSAGE_SELF)` (user + system, all threads of the process) over the window, per process. **CPU per append** = that CPU / the records committed (leader) or received (followers) in the window.
- **`max`** keeps up to 32 MiB of records in flight (made but not yet committed), and the leader adds at most 1/16 of that per tick, so about 16 batches are in flight and every stage overlaps. The max is a throughput ceiling; its latency is queueing, not a target.
- All timing ran under `$SP/bin/timing` (the box alone apart from processes that skip the lock), a few configurations to one hold.
- Cost: about 1.6 hours of the box alone (107 configurations × 3 runs × about 14 s, plus the set-aside runs), against the entry's 3.5 CPU-hours; about 6 hours of wall time, most of it waiting for other agents' heavy jobs to release the lock.
- Machine and versions: as E-01 ([env.txt](../E01-floors/results/env.txt)): 4 vCPU Firecracker VM, one virtio disk with ext4 without a journal, Node 22.22.0, Rust 1.97.0 (libc 0.2, crc32fast 1.5), Go 1.24.7.

## Results

Median of 3 runs, range in brackets. Latency in ms; CPU in µs of one core per append (leader / follower 1 / follower 2, medians). "records per flush" is how many appends shared one fdatasync in the leader. All rows: [results/runs.jsonl](results/runs.jsonl) (one line per run) and [results/raw.jsonl](results/raw.jsonl) (one line per process); every column of every run: [results/tables.md](results/tables.md). These tables: [results/report.md](results/report.md).

#### Real disk, persisted, 1 group, 100 B records

| rate | build | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|
| max | ts | 3 | 2,789,884 (2,590,944-2,906,903) | 46.71 (24.30-56.58) | 146.06 (114.84-164.18) | 177.8 | 0.33 / 0.18 / 0.18 | 0.89 | 77,038 |
| max | ts-w1 | 3 | 2,745,477 (2,740,799-3,134,007) | 93.66 (81.33-94.56) | 190.13 (164.44-232.54) | 226.5 | 0.36 / 0.25 / 0.25 | 1.02 | 100,851 |
| max | rust | 3 | 2,214,172 (1,947,353-2,654,203) | 86.71 (81.83-90.47) | 627.17 (314.34-711.98) | 652.7 | 0.29 / 0.20 / 0.20 | 0.65 | 142,035 |
| max | go | 3 | 2,827,403 (2,228,214-3,337,646) | 87.64 (72.87-88.90) | 161.64 (157.50-554.40) | 252.4 | 0.25 / 0.19 / 0.19 | 0.75 | 142,306 |
| 10,000 | ts | 3 | 10,000 (9,997-10,009) | 0.73 (0.69-0.74) | 2.73 (2.39-66.94) | 5.9 | 24.86 / 18.58 / 18.55 | 0.25 | 13 |
| 10,000 | ts-w1 | 3 | 10,000 (9,999-10,002) | 0.80 (0.80-0.83) | 4.05 (3.27-64.19) | 19.3 | 32.42 / 24.15 / 24.09 | 0.32 | 12 |
| 10,000 | rust | 3 | 10,000 (9,999-10,000) | 0.51 (0.49-0.53) | 21.77 (1.41-50.28) | 57.2 | 21.51 / 11.11 / 11.00 | 0.21 | 10 |
| 10,000 | go | 3 | 9,999 (9,998-9,999) | 0.64 (0.63-0.66) | 35.50 (2.33-80.39) | 63.3 | 26.38 / 19.75 / 19.80 | 0.26 | 12 |
| 50,000 | ts | 3 | 50,007 (50,000-50,008) | 0.85 (0.84-0.90) | 4.33 (3.02-4.49) | 20.2 | 5.46 / 3.88 / 3.83 | 0.27 | 69 |
| 50,000 | ts-w1 | 3 | 49,999 (49,995-50,000) | 0.92 (0.91-0.93) | 3.68 (3.23-4.55) | 14.1 | 6.91 / 5.10 / 4.98 | 0.34 | 62 |
| 50,000 | rust | 3 | 49,997 (49,996-50,004) | 0.62 (0.61-0.71) | 1.58 (1.29-2.00) | 4.1 | 4.71 / 2.60 / 2.60 | 0.24 | 50 |
| 50,000 | go | 3 | 50,001 (49,997-50,007) | 0.74 (0.73-0.78) | 1.97 (1.59-3.35) | 4.9 | 5.45 / 4.46 / 4.43 | 0.27 | 60 |
| half = 1,394,942 | ts | 3 | 1,395,224 (1,394,898-1,410,009) | 3.15 (2.96-3.35) | 30.80 (15.25-113.75) | 49.5 | 0.44 / 0.27 / 0.27 | 0.62 | 2,727 |
| half = 1,372,739 | ts-w1 | 3 | 1,372,579 (1,372,499-1,373,193) | 3.70 (3.53-3.87) | 43.94 (18.44-129.29) | 65.0 | 0.53 / 0.36 / 0.36 | 0.73 | 2,607 |
| half = 1,107,086 | rust | 3 | 1,107,018 (1,105,424-1,107,185) | 1.33 (1.23-1.34) | 5.50 (5.14-161.03) | 12.9 | 0.33 / 0.21 / 0.21 | 0.37 | 1,199 |
| half = 1,413,702 | go | 3 | 1,413,497 (1,413,432-1,413,565) | 2.24 (2.16-2.38) | 69.77 (56.91-166.99) | 119.4 | 0.36 / 0.25 / 0.25 | 0.52 | 2,043 |

#### Real disk, persisted, 1 group, 1024 B records

| rate | build | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|
| max | ts | 3 | 283,881 (281,599-284,891) | 51.25 (51.20-70.49) | 150.15 (126.51-170.88) | 206.8 | 3.07 / 1.75 / 1.76 | 0.88 | 7,285 |
| max | ts-w1 | 3 | 280,355 (278,584-281,621) | 102.26 (97.93-103.54) | 184.34 (177.54-194.83) | 215.1 | 3.21 / 2.39 / 2.32 | 0.90 | 11,257 |
| max | rust | 3 | 348,928 (348,675-374,484) | 80.11 (72.76-80.86) | 155.29 (142.96-186.42) | 211.9 | 1.96 / 1.41 / 1.44 | 0.73 | 15,644 |
| max | go | 3 | 351,458 (336,529-361,325) | 79.20 (75.25-85.81) | 147.70 (134.47-168.78) | 232.2 | 2.10 / 1.65 / 1.64 | 0.75 | 15,614 |
| 10,000 | ts | 3 | 10,001 (9,999-10,002) | 0.89 (0.88-0.90) | 3.83 (3.75-51.48) | 10.8 | 26.88 / 19.83 / 19.94 | 0.27 | 14 |
| 10,000 | ts-w1 | 3 | 10,000 (10,000-10,001) | 0.95 (0.93-0.95) | 3.95 (3.57-90.56) | 16.3 | 34.40 / 25.61 / 25.58 | 0.34 | 13 |
| 10,000 | rust | 3 | 9,999 (9,999-10,001) | 0.64 (0.61-0.67) | 19.17 (3.36-79.43) | 52.7 | 22.19 / 12.50 / 12.22 | 0.22 | 10 |
| 10,000 | go | 3 | 10,000 (9,999-10,001) | 0.87 (0.79-0.88) | 56.44 (2.65-73.18) | 91.2 | 27.58 / 23.07 / 22.92 | 0.28 | 13 |
| 50,000 | ts | 3 | 49,997 (49,993-50,006) | 1.17 (1.16-1.19) | 4.34 (3.95-5.37) | 13.0 | 6.92 / 4.91 / 4.92 | 0.35 | 60 |
| 50,000 | ts-w1 | 3 | 50,004 (50,000-50,016) | 1.19 (1.18-1.20) | 5.24 (5.16-5.52) | 19.1 | 8.53 / 6.80 / 6.56 | 0.43 | 58 |
| 50,000 | rust | 3 | 50,001 (50,000-50,001) | 0.80 (0.80-0.82) | 3.37 (2.39-3.52) | 28.0 | 5.15 / 2.96 / 2.85 | 0.26 | 51 |
| 50,000 | go | 3 | 50,002 (49,997-50,007) | 1.04 (1.03-1.07) | 3.18 (3.00-4.66) | 14.3 | 6.35 / 5.52 / 5.49 | 0.32 | 63 |
| half = 141,941 | ts | 3 | 141,948 (141,926-141,953) | 2.51 (2.51-2.59) | 19.45 (17.88-109.44) | 49.0 | 3.79 / 2.53 / 2.50 | 0.54 | 232 |
| half = 140,178 | ts-w1 | 3 | 140,212 (140,171-140,244) | 3.35 (3.35-3.43) | 27.40 (21.38-98.21) | 44.8 | 4.58 / 3.31 / 3.36 | 0.64 | 250 |
| half = 174,464 | rust | 3 | 174,445 (174,401-174,463) | 2.67 (2.44-2.74) | 107.04 (105.33-155.34) | 144.9 | 2.40 / 1.69 / 1.69 | 0.42 | 278 |
| half = 175,729 | go | 3 | 175,717 (175,694-175,747) | 3.02 (2.94-3.30) | 104.89 (103.16-163.04) | 131.8 | 3.06 / 2.07 / 2.07 | 0.54 | 311 |

#### tmpfs with sampled fsync delays (independent disks emulated), persisted, 1 group(s), 100 B

| rate | build | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|
| max | ts | 3 | 3,960,126 (3,939,062-3,988,212) | 8.76 (8.51-8.77) | 15.25 (14.99-15.32) | 20.3 | 0.26 / 0.10 / 0.10 | 1.04 | 18,760 |
| max | ts-w1 | 3 | 4,830,854 (4,798,077-4,856,588) | 35.18 (33.52-39.70) | 76.84 (74.35-89.81) | 87.9 | 0.32 / 0.16 / 0.16 | 1.53 | 43,498 |
| max | rust | 3 | 10,050,107 (10,031,383-10,089,895) | 3.71 (3.69-3.75) | 7.35 (7.17-8.04) | 11.9 | 0.13 / 0.07 / 0.07 | 1.28 | 18,810 |
| max | go | 3 | 7,080,012 (6,993,414-7,321,084) | 7.21 (6.89-7.26) | 21.72 (21.14-25.76) | 32.5 | 0.15 / 0.10 / 0.10 | 1.08 | 19,398 |
| 50,000 | ts | 3 | 50,001 (49,993-50,008) | 0.56 (0.56-0.57) | 2.40 (2.25-3.89) | 6.1 | 4.49 / 3.09 / 3.09 | 0.23 | 61 |
| 50,000 | ts-w1 | 3 | 50,001 (49,993-50,005) | 0.64 (0.62-0.64) | 2.91 (2.88-4.19) | 7.9 | 5.84 / 4.09 / 4.04 | 0.29 | 59 |
| 50,000 | rust | 3 | 50,002 (50,000-50,004) | 0.38 (0.36-0.38) | 0.67 (0.67-0.70) | 2.3 | 3.51 / 1.43 / 1.45 | 0.17 | 50 |
| 50,000 | go | 3 | 50,000 (49,993-50,001) | 0.40 (0.39-0.41) | 0.75 (0.69-0.83) | 2.5 | 4.68 / 2.59 / 2.51 | 0.23 | 56 |
| half = 1,980,063 | ts | 3 | 1,980,017 (1,979,213-1,980,079) | 1.28 (1.19-1.29) | 5.08 (4.40-5.90) | 11.0 | 0.32 / 0.17 / 0.17 | 0.63 | 2,730 |
| half = 2,415,427 | ts-w1 | 3 | 2,415,795 (2,415,791-2,416,249) | 1.85 (1.76-1.90) | 8.87 (8.42-10.32) | 18.8 | 0.36 / 0.23 / 0.24 | 0.88 | 3,616 |
| half = 5,025,054 | rust | 3 | 5,024,609 (5,024,375-5,025,396) | 0.89 (0.85-0.90) | 2.42 (1.81-3.63) | 7.7 | 0.15 / 0.07 / 0.08 | 0.73 | 5,114 |
| half = 3,540,006 | go | 3 | 3,539,846 (3,539,582-3,539,925) | 1.20 (1.18-1.23) | 4.92 (3.79-5.13) | 13.2 | 0.23 / 0.14 / 0.14 | 0.81 | 4,393 |

#### tmpfs with sampled fsync delays (independent disks emulated), persisted, 16 group(s), 100 B

| rate | build | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|
| max | ts-w1 | 3 | 5,451,126 (5,226,441-5,607,903) | 45.56 (37.40-48.51) | 74.47 (65.47-80.24) | 83.8 | 0.28 / 0.15 / 0.16 | 1.47 | 55,458 |
| max | ts-w2 | 3 | 5,177,187 (5,136,230-5,344,533) | 11.11 (10.53-11.61) | 51.61 (43.82-55.76) | 73.3 | 0.30 / 0.18 / 0.18 | 1.59 | 13,236 |
| max | ts-w4 | 3 | 4,356,841 (4,247,422-4,372,054) | 7.90 (7.76-8.23) | 41.07 (30.75-43.74) | 70.0 | 0.37 / 0.22 / 0.22 | 1.60 | 5,120 |
| 50,000 | ts-w1 | 3 | 49,993 (49,990-50,008) | 0.64 (0.62-0.65) | 1.81 (1.79-1.92) | 5.6 | 6.17 / 4.22 / 4.21 | 0.31 | 58 |
| 50,000 | ts-w2 | 3 | 50,002 (50,001-50,004) | 0.68 (0.67-0.68) | 2.67 (2.56-3.39) | 6.3 | 10.06 / 7.20 / 6.77 | 0.50 | 31 |
| 50,000 | ts-w4 | 3 | 50,000 (49,999-50,006) | 0.76 (0.75-0.77) | 3.66 (3.59-4.51) | 10.0 | 14.29 / 10.71 / 10.41 | 0.71 | 17 |
| half = 2,725,563 | ts-w1 | 3 | 2,725,613 (2,725,362-2,726,120) | 1.98 (1.92-2.10) | 9.89 (8.16-10.52) | 17.2 | 0.34 / 0.22 / 0.22 | 0.93 | 4,099 |
| half = 2,588,594 | ts-w2 | 3 | 2,588,652 (2,588,325-2,588,654) | 1.54 (1.50-1.59) | 9.97 (9.88-10.36) | 21.1 | 0.42 / 0.28 / 0.28 | 1.08 | 1,828 |
| half = 2,178,421 | ts-w4 | 3 | 2,178,425 (2,178,222-2,178,874) | 1.58 (1.53-1.61) | 17.24 (13.86-18.13) | 36.0 | 0.57 / 0.41 / 0.41 | 1.23 | 775 |

#### Real disk, several TS kernel workers (kwN), 16 groups, 100 B

| rate | build | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|
| max | ts-w1 | 3 | 2,569,938 (2,513,763-2,616,749) | 98.66 (96.35-107.50) | 212.03 (192.34-229.99) | 254.0 | 0.39 / 0.28 / 0.28 | 1.01 | 110,410 |
| max | ts-w2 | 3 | 3,195,555 (2,892,911-3,297,898) | 77.86 (73.98-90.70) | 159.72 (159.70-182.83) | 235.9 | 0.40 / 0.27 / 0.27 | 1.29 | 54,791 |
| max | ts-w4 | 3 | 2,928,804 (2,824,027-3,149,796) | 82.33 (72.49-91.27) | 192.79 (143.89-195.34) | 217.8 | 0.44 / 0.28 / 0.27 | 1.30 | 22,996 |
| 50,000 | ts-w1 | 3 | 50,007 (50,001-50,268) | 1.00 (0.96-1.04) | 8.90 (4.23-84.04) | 57.0 | 7.00 / 5.05 / 5.06 | 0.35 | 61 |
| 50,000 | ts-w2 | 3 | 50,001 (49,998-50,005) | 1.08 (1.08-1.14) | 13.94 (4.41-90.63) | 79.3 | 11.34 / 8.66 / 8.50 | 0.57 | 30 |
| 50,000 | ts-w4 | 3 | 50,005 (50,005-50,006) | 1.60 (1.60-1.81) | 8.70 (7.24-72.25) | 45.3 | 17.26 / 14.00 / 13.77 | 0.86 | 15 |
| half = 1,284,969 | ts-w1 | 3 | 1,284,878 (1,284,477-1,285,204) | 2.83 (2.72-3.26) | 14.07 (8.82-16.41) | 35.0 | 0.52 / 0.37 / 0.37 | 0.67 | 1,935 |
| half = 1,597,778 | ts-w2 | 3 | 1,597,281 (1,595,345-1,597,795) | 4.64 (4.52-5.20) | 15.62 (14.22-15.86) | 23.0 | 0.57 / 0.40 / 0.39 | 0.91 | 1,955 |
| half = 1,464,402 | ts-w4 | 3 | 1,464,634 (1,464,594-1,464,738) | 6.26 (5.94-6.29) | 20.71 (18.50-20.93) | 32.3 | 0.74 / 0.50 / 0.51 | 1.09 | 1,134 |

#### One process, several TS kernel workers: the leader alone (`ldr`), tmpfs with sampled fsync delays, 16 groups, 100 B

| rate | build | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|
| max | ts-w1 | 3 | 5,806,782 (5,589,117-5,928,488) | 5.55 (5.43-5.61) | 35.56 (30.46-40.68) | 54.6 | 0.26 / - / - | 1.51 | 20,453 |
| max | ts-w2 | 3 | 5,907,422 (5,779,865-6,029,128) | 4.85 (4.75-4.91) | 13.03 (11.67-13.44) | 17.8 | 0.27 / - / - | 1.62 | 9,419 |
| max | ts-w4 | 3 | 5,998,116 (5,797,419-6,129,770) | 4.59 (4.46-4.67) | 12.53 (12.28-12.65) | 19.6 | 0.30 / - / - | 1.80 | 4,714 |

#### Groups sharing one journal and one link per peer (real disk, 100 B)

| rate | build | groups | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|---|
| max | ts | 1 | 3 | 2,789,884 (2,590,944-2,906,903) | 46.71 (24.30-56.58) | 146.06 (114.84-164.18) | 177.8 | 0.33 / 0.18 / 0.18 | 0.89 | 77,038 |
| max | ts | 16 | 3 | 2,527,747 (2,394,338-2,651,792) | 51.97 (35.55-52.65) | 159.27 (128.90-187.52) | 187.7 | 0.36 / 0.23 / 0.22 | 0.94 | 69,950 |
| max | ts | 1000 | 3 | 2,773,495 (2,675,192-2,780,516) | 31.33 (23.49-32.41) | 152.44 (85.42-158.15) | 174.0 | 0.34 / 0.18 / 0.17 | 0.95 | 49,876 |
| max | rust | 1 | 3 | 2,214,172 (1,947,353-2,654,203) | 86.71 (81.83-90.47) | 627.17 (314.34-711.98) | 652.7 | 0.29 / 0.20 / 0.20 | 0.65 | 142,035 |
| max | rust | 16 | 3 | 3,070,823 (2,506,746-3,365,734) | 73.86 (72.81-101.00) | 184.70 (170.45-349.12) | 215.4 | 0.23 / 0.16 / 0.16 | 0.71 | 144,505 |
| max | rust | 1000 | 3 | 3,379,779 (3,325,940-3,464,037) | 74.63 (70.36-76.61) | 169.11 (127.94-185.25) | 223.5 | 0.23 / 0.15 / 0.16 | 0.79 | 144,869 |
| max | go | 1 | 3 | 2,827,403 (2,228,214-3,337,646) | 87.64 (72.87-88.90) | 161.64 (157.50-554.40) | 252.4 | 0.25 / 0.19 / 0.19 | 0.75 | 142,306 |
| max | go | 16 | 3 | 3,468,715 (3,398,493-3,515,528) | 69.87 (69.43-70.73) | 179.61 (172.66-220.51) | 234.2 | 0.24 / 0.18 / 0.18 | 0.84 | 136,165 |
| max | go | 1000 | 3 | 3,274,450 (2,974,857-3,473,401) | 76.16 (67.70-86.59) | 199.29 (146.32-206.47) | 214.7 | 0.24 / 0.18 / 0.18 | 0.79 | 138,561 |
| 50,000 | ts | 1 | 3 | 50,007 (50,000-50,008) | 0.85 (0.84-0.90) | 4.33 (3.02-4.49) | 20.2 | 5.46 / 3.88 / 3.83 | 0.27 | 69 |
| 50,000 | ts | 16 | 3 | 50,006 (50,006-50,008) | 0.89 (0.89-0.96) | 3.72 (3.24-111.27) | 16.8 | 5.62 / 3.95 / 4.05 | 0.28 | 67 |
| 50,000 | ts | 1000 | 3 | 49,993 (49,993-50,019) | 0.89 (0.89-0.93) | 57.80 (3.62-111.90) | 99.9 | 5.73 / 4.03 / 3.96 | 0.29 | 69 |
| 50,000 | rust | 1 | 3 | 49,997 (49,996-50,004) | 0.62 (0.61-0.71) | 1.58 (1.29-2.00) | 4.1 | 4.71 / 2.60 / 2.60 | 0.24 | 50 |
| 50,000 | rust | 16 | 3 | 49,998 (49,996-50,001) | 0.64 (0.62-0.66) | 53.96 (1.89-103.62) | 91.4 | 4.76 / 2.53 / 2.52 | 0.24 | 52 |
| 50,000 | rust | 1000 | 3 | 50,000 (49,998-50,005) | 0.64 (0.63-0.65) | 62.09 (1.64-99.62) | 98.1 | 4.71 / 2.57 / 2.57 | 0.23 | 52 |
| 50,000 | go | 1 | 3 | 50,001 (49,997-50,007) | 0.74 (0.73-0.78) | 1.97 (1.59-3.35) | 4.9 | 5.45 / 4.46 / 4.43 | 0.27 | 60 |
| 50,000 | go | 16 | 3 | 50,004 (50,001-50,010) | 0.80 (0.79-0.83) | 77.77 (1.76-116.39) | 104.6 | 5.49 / 4.54 / 4.52 | 0.28 | 66 |
| 50,000 | go | 1000 | 3 | 50,002 (49,995-50,014) | 0.76 (0.76-0.86) | 82.69 (2.62-116.78) | 126.7 | 5.43 / 4.45 / 4.48 | 0.27 | 63 |

#### Rungs (real disk, 1 group, 100 B)

| rate | build | rung | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|---|
| max | ts | persisted | 3 | 2,789,884 (2,590,944-2,906,903) | 46.71 (24.30-56.58) | 146.06 (114.84-164.18) | 177.8 | 0.33 / 0.18 / 0.18 | 0.89 | 77,038 |
| max | ts | memory | 3 | 2,754,769 (2,637,744-2,775,833) | 6.24 (6.10-6.91) | 27.21 (26.38-28.32) | 34.9 | 0.35 / 0.17 / 0.17 | 0.95 | 18,724 |
| max | ts | ldr | 3 | 3,791,613 (3,618,413-3,815,017) | 13.16 (12.57-13.86) | 82.08 (28.69-86.23) | 123.1 | 0.26 / - / - | 0.98 | 30,088 |
| max | ts | none | 3 | 4,287,796 (4,280,775-4,350,990) | 2.91 (2.90-2.94) | 7.97 (7.86-8.44) | 12.2 | 0.19 / - / - | 0.81 | - |
| max | rust | persisted | 3 | 2,214,172 (1,947,353-2,654,203) | 86.71 (81.83-90.47) | 627.17 (314.34-711.98) | 652.7 | 0.29 / 0.20 / 0.20 | 0.65 | 142,035 |
| max | rust | memory | 3 | 4,964,239 (4,891,676-5,163,203) | 12.91 (11.62-25.16) | 172.20 (156.54-192.03) | 254.7 | 0.19 / 0.14 / 0.13 | 0.97 | 88,345 |
| max | rust | ldr | 3 | 6,216,554 (5,729,716-6,291,453) | 38.28 (38.04-44.19) | 98.33 (71.21-100.83) | 134.3 | 0.12 / - / - | 0.77 | 149,040 |
| max | rust | none | 3 | 18,625,699 (18,613,996-18,635,061) | 0.82 (0.82-0.82) | 0.95 (0.94-0.95) | 2.0 | 0.03 / - / - | 0.62 | 0 |
| max | go | persisted | 3 | 2,827,403 (2,228,214-3,337,646) | 87.64 (72.87-88.90) | 161.64 (157.50-554.40) | 252.4 | 0.25 / 0.19 / 0.19 | 0.75 | 142,306 |
| max | go | memory | 3 | 5,551,669 (5,366,773-5,556,360) | 10.21 (10.02-10.86) | 124.60 (74.57-141.53) | 244.2 | 0.19 / 0.15 / 0.15 | 1.04 | 22,980 |
| max | go | ldr | 3 | 6,041,011 (5,823,339-6,328,902) | 38.72 (37.41-42.14) | 99.59 (71.57-102.08) | 141.0 | 0.15 / - / - | 0.88 | 147,514 |
| max | go | none | 3 | 13,291,699 (12,304,008-13,331,488) | 1.10 (1.10-1.32) | 2.62 (2.58-2.88) | 3.9 | 0.07 / - / - | 0.99 | 0 |
| 50,000 | ts | persisted | 3 | 50,007 (50,000-50,008) | 0.85 (0.84-0.90) | 4.33 (3.02-4.49) | 20.2 | 5.46 / 3.88 / 3.83 | 0.27 | 69 |
| 50,000 | ts | memory | 3 | 49,999 (49,998-50,004) | 0.24 (0.22-0.25) | 0.57 (0.55-0.66) | 2.6 | 3.56 / 2.16 / 2.23 | 0.18 | 61 |
| 50,000 | ts | ldr | 3 | 50,003 (50,001-50,008) | 0.63 (0.59-0.71) | 1.87 (1.69-85.46) | 4.3 | 4.30 / - / - | 0.21 | 59 |
| 50,000 | ts | none | 3 | 50,001 (49,996-50,004) | 0.03 (0.03-0.03) | 0.08 (0.08-0.10) | 0.2 | 1.64 / - / - | 0.08 | - |
| 50,000 | rust | persisted | 3 | 49,997 (49,996-50,004) | 0.62 (0.61-0.71) | 1.58 (1.29-2.00) | 4.1 | 4.71 / 2.60 / 2.60 | 0.24 | 50 |
| 50,000 | rust | memory | 3 | 49,999 (49,999-50,001) | 0.16 (0.16-0.17) | 0.33 (0.33-0.35) | 1.2 | 3.63 / 1.35 / 1.41 | 0.18 | 50 |
| 50,000 | rust | ldr | 3 | 49,999 (49,997-49,999) | 0.47 (0.46-0.47) | 2.76 (0.99-79.26) | 53.3 | 2.92 / - / - | 0.15 | 51 |
| 50,000 | rust | none | 3 | 50,000 (49,999-50,002) | 1.00 (1.00-1.00) | 1.11 (1.11-1.13) | 1.6 | 0.63 / - / - | 0.03 | 0 |
| 50,000 | go | persisted | 3 | 50,001 (49,997-50,007) | 0.74 (0.73-0.78) | 1.97 (1.59-3.35) | 4.9 | 5.45 / 4.46 / 4.43 | 0.27 | 60 |
| 50,000 | go | memory | 3 | 49,999 (49,998-50,002) | 0.20 (0.20-0.21) | 0.45 (0.41-0.48) | 1.7 | 5.12 / 2.26 / 2.24 | 0.26 | 58 |
| 50,000 | go | ldr | 3 | 50,001 (49,996-50,003) | 0.66 (0.52-0.66) | 3.84 (1.02-86.03) | 57.4 | 4.07 / - / - | 0.20 | 57 |
| 50,000 | go | none | 3 | 49,998 (49,993-50,002) | 1.11 (1.11-1.11) | 1.24 (1.24-1.24) | 1.8 | 1.19 / - / - | 0.06 | 0 |

#### Growing files against preallocated segments (real disk, 1 group, 100 B)

| rate | build | layout | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |
|---|---|---|---|---|---|---|---|---|---|---|
| max | ts | grow | 3 | 2,789,884 (2,590,944-2,906,903) | 46.71 (24.30-56.58) | 146.06 (114.84-164.18) | 177.8 | 0.33 / 0.18 / 0.18 | 0.89 | 77,038 |
| max | ts | falloc | 3 | 3,583,306 (3,527,135-3,662,883) | 20.22 (19.24-21.14) | 39.90 (36.74-69.42) | 44.5 | 0.27 / 0.10 / 0.12 | 0.97 | 44,110 |
| max | ts | zero | 3 | 3,492,027 (3,487,345-3,520,113) | 24.13 (22.31-28.18) | 61.15 (55.14-75.85) | 92.7 | 0.27 / 0.12 / 0.11 | 0.96 | 48,813 |
| max | rust | grow | 3 | 2,214,172 (1,947,353-2,654,203) | 86.71 (81.83-90.47) | 627.17 (314.34-711.98) | 652.7 | 0.29 / 0.20 / 0.20 | 0.65 | 142,035 |
| max | rust | falloc | 3 | 4,105,357 (3,794,059-4,234,088) | 62.44 (61.54-63.87) | 78.79 (75.41-157.48) | 90.2 | 0.15 / 0.07 / 0.07 | 0.63 | 147,903 |
| max | rust | zero | 3 | 4,014,076 (3,852,577-4,098,335) | 64.66 (63.01-66.92) | 82.02 (81.55-83.99) | 102.8 | 0.16 / 0.07 / 0.07 | 0.63 | 150,141 |
| max | go | grow | 3 | 2,827,403 (2,228,214-3,337,646) | 87.64 (72.87-88.90) | 161.64 (157.50-554.40) | 252.4 | 0.25 / 0.19 / 0.19 | 0.75 | 142,306 |
| max | go | falloc | 3 | 4,077,272 (4,007,055-4,252,812) | 62.19 (60.52-63.73) | 77.49 (75.51-84.22) | 81.8 | 0.16 / 0.10 / 0.10 | 0.68 | 148,932 |
| max | go | zero | 3 | 3,627,884 (3,595,116-3,693,419) | 69.47 (67.97-71.06) | 90.67 (87.18-161.74) | 100.0 | 0.18 / 0.10 / 0.11 | 0.65 | 145,752 |
| half = 1,394,942 | ts | grow | 3 | 1,395,224 (1,394,898-1,410,009) | 3.15 (2.96-3.35) | 30.80 (15.25-113.75) | 49.5 | 0.44 / 0.27 / 0.27 | 0.62 | 2,727 |
| half = 1,791,653 | ts | falloc | 3 | 1,792,355 (1,792,284-1,792,884) | 2.81 (2.71-3.21) | 12.87 (9.30-66.26) | 48.8 | 0.36 / 0.18 / 0.19 | 0.65 | 3,166 |
| half = 1,746,014 | ts | zero | 3 | 1,746,005 (1,745,868-1,746,432) | 3.14 (3.03-3.45) | 15.53 (9.43-49.96) | 53.6 | 0.38 / 0.19 / 0.20 | 0.66 | 3,286 |
| half = 1,107,086 | rust | grow | 3 | 1,107,018 (1,105,424-1,107,185) | 1.33 (1.23-1.34) | 5.50 (5.14-161.03) | 12.9 | 0.33 / 0.21 / 0.21 | 0.37 | 1,199 |
| half = 2,052,679 | rust | falloc | 3 | 2,053,178 (2,053,140-2,053,332) | 1.31 (1.29-1.45) | 8.31 (6.60-50.79) | 31.8 | 0.20 / 0.11 / 0.10 | 0.41 | 2,427 |
| half = 2,007,038 | rust | zero | 3 | 2,006,928 (2,003,389-2,006,963) | 2.18 (1.94-2.75) | 6.46 (5.29-30.73) | 32.0 | 0.20 / 0.10 / 0.10 | 0.39 | 2,498 |
| half = 1,413,702 | go | grow | 3 | 1,413,497 (1,413,432-1,413,565) | 2.24 (2.16-2.38) | 69.77 (56.91-166.99) | 119.4 | 0.36 / 0.25 / 0.25 | 0.52 | 2,043 |
| half = 2,038,636 | go | falloc | 3 | 2,038,862 (2,038,707-2,039,084) | 1.70 (1.67-1.86) | 4.79 (4.26-65.60) | 8.9 | 0.25 / 0.15 / 0.15 | 0.52 | 2,705 |
| half = 1,813,942 | go | zero | 3 | 1,814,147 (1,814,042-1,814,167) | 2.33 (1.91-2.37) | 5.27 (4.95-7.34) | 8.1 | 0.26 / 0.15 / 0.15 | 0.47 | 2,502 |

#### CPU as a fixed part plus a part per append

A least-squares line through (committed/s, cores used) over the fixed-rate and half-max runs of one configuration. The fixed part is what a process spends each second whatever the rate (ticks, wakeups, one round of syscalls per batch); the marginal part is µs of one core per extra committed append.

| storage | size B | groups | build | leader: fixed cores + µs/append | follower: fixed cores + µs/append | appends/s at 1 core (leader; extrapolated from the line, reasoned) |
|---|---|---|---|---|---|---|
| emu | 100 | 1 | ts | 0.21 + 0.21 | 0.15 + 0.09 | 3,793,534 |
| emu | 100 | 1 | ts-w1 | 0.28 + 0.25 | 0.19 + 0.16 | 2,893,398 |
| emu | 100 | 1 | rust | 0.17 + 0.11 | 0.07 + 0.06 | 7,474,816 |
| emu | 100 | 1 | go | 0.22 + 0.16 | 0.12 + 0.10 | 4,758,153 |
| emu | 100 | 16 | ts-w1 | 0.29 + 0.24 | 0.20 + 0.15 | 2,982,272 |
| emu | 100 | 16 | ts-w2 | 0.49 + 0.23 | 0.35 + 0.15 | 2,218,612 |
| emu | 100 | 16 | ts-w4 | 0.70 + 0.24 | 0.53 + 0.17 | 1,230,961 |
| grow | 100 | 1 | ts | 0.25 + 0.26 | 0.19 + 0.13 | 2,837,501 |
| grow | 100 | 1 | ts-w1 | 0.32 + 0.30 | 0.24 + 0.19 | 2,277,109 |
| grow | 100 | 1 | rust | 0.23 + 0.13 | 0.12 + 0.10 | 5,970,239 |
| grow | 100 | 1 | go | 0.26 + 0.18 | 0.21 + 0.09 | 4,063,932 |
| grow | 100 | 16 | ts-w1 | 0.34 + 0.27 | 0.24 + 0.18 | 2,485,695 |
| grow | 100 | 16 | ts-w2 | 0.55 + 0.23 | 0.43 + 0.13 | 1,940,430 |
| grow | 100 | 16 | ts-w4 | 0.85 + 0.16 | 0.70 + 0.03 | 919,425 |
| grow | 1024 | 1 | ts | 0.25 + 2.05 | 0.19 + 1.19 | 366,893 |
| grow | 1024 | 1 | ts-w1 | 0.32 + 2.36 | 0.25 + 1.55 | 290,170 |
| grow | 1024 | 1 | rust | 0.21 + 1.16 | 0.10 + 1.02 | 685,943 |
| grow | 1024 | 1 | go | 0.25 + 1.61 | 0.23 + 0.74 | 468,786 |

**Set aside.** The first `max` runs kept one 32 MiB batch in flight at a time (stop-and-wait), so their ceiling measured one batch's round trip, not the pipeline. They were replaced by `max` runs that keep about 16 batches in flight (the leader adds at most 1/16 of the window per tick), and every `half` run was redone from the new `max`. The old lines are kept in [results/superseded-stopwait-runs.jsonl](results/superseded-stopwait-runs.jsonl) for the record; no table uses them.

## The thresholds, one by one

| Threshold (QUESTIONS.md, E-02) | Measured | Result |
|---|---|---|
| TS ≤ 20 µs of one core per committed append in each process ("50k/s per core") | at 50,000/s: leader 5.5, followers 3.9 (real disk); 4.5 / 3.1 (tmpfs). With the kernel on a worker: 6.9 / 5.0. Fitted: 0.25 cores + 0.26 µs per append, so one core at about 2.8 million/s | **met** at the bar's rate. Below about 13,000/s per process the fixed cost alone is above 20 µs per append, in every language |
| TS p99 ≤ C + 5 ms = 5.7 ms | 50,000/s: 4.3 (real disk), 2.4 (tmpfs). Half of max: 31 ms (real disk, 1.4 million/s), 5.1 ms (tmpfs, 2.0 million/s) | **met** at the bar's rate, and at half of TS's own ceiling when the disks are independent. Not met at half of the shared disk's bandwidth (31 ms), where the disk's stalls set the tail: Go (70 ms) and TS on a worker (44 ms) miss it too, and Rust scrapes in (5.5 ms) |
| Rust ≤ 2 µs per append | 50,000/s: 4.7 (real disk), 3.5 (tmpfs). Half of max: 0.33, 0.15. Fitted 0.23 cores + 0.13 µs | **met from about 130,000/s** per process, not at 50,000/s |
| Rust p99 ≤ C + 0.5 ms = 1.2 ms | 50,000/s: 1.6 (real disk), 0.67 (tmpfs). Half of max: 5.5 (real disk), 2.4 (tmpfs) | **met only with independent disks at moderate load** |
| Every build at the same disk-bound ceiling? | real disk `max`: 2.2-2.8 million/s at 100 B and 280-350 thousand/s at 1 KiB for all four builds, about 1 GB/s across three journals. With preallocated segments: 3.6 (TS) to 4.1 million/s (Rust, Go), within 1.15 × | **yes**: on this disk, throughput did not separate them |
| `kwN` with 4 workers ≥ 3 × one worker's appends on tmpfs | 4.4 against 5.5 million/s = 0.8 × (three processes); one process alone: 6.0 against 5.8 million/s = 1.03 ×, with cores to spare: the main thread that feeds the workers is the limit | **not met** on this box |

## What this box cannot show

- **Independent disks.** The three replicas share one virtual disk, so on the real disk they share its bandwidth (about 1 GB/s) and its stalls. The tmpfs variant emulates independent disks with E-01's one-writer flush times; it leaves out E-01's rare 20-50 ms stalls and uses the 4 KiB flush time for every batch size, so it flatters big batches.
- **Real round trips.** Loopback only. A real network adds its round trip to every commit (C covers loopback only).
- **More cores.** With 4 vCPUs, three processes and their threads compete for cores. `kwN` and the `ts-w1` split can only show their cost here, not their gain on a machine with cores to spare; nor can any build show scaling past 4 cores.
- **Clients.** The leader makes its own writes. Real clients add a socket read, a decode and a reply per write (E-45 drives fero through the competitors' own tools; E-39 adds overload).
- **A real kernel.** No elections, no Raft terms, no snapshots, no reads, no `data` fold. This is a ceiling: a real kernel can only approach it. E-05 prices data's fold; E-10 and E-11 the Raft core and many groups.
- **Other runtimes.** Node 22 only (not Node 26 or Bun), Rust with std threads only (not io_uring or a thread-per-core design), Go with its default scheduler.
- **Other agents' load.** Processes that do not take the lock still ran. The median run saw 0.11 other busy cores; the tmpfs runs at 50,000/s saw about one (so they had three free cores, more than they used), and one 16-group Rust row saw 0.6. Each run's figure is in `runs.jsonl` (`other_cores`).
- **The quiet-box penalty.** On this VM an idle vCPU costs about 25 µs to wake (E-01). Every hop of a commit wakes a thread, so medians here include several such wakeups. A busy production box would show lower medians and a different CPU profile.

## Files

- [ts/pipeline.ts](ts/pipeline.ts), [rs/src/main.rs](rs/src/main.rs) (with [Cargo.toml](rs/Cargo.toml) and Cargo.lock), [go/main.go](go/main.go): the three pipelines.
- [emu/emu.c](emu/emu.c): the Node addon for the tmpfs variant.
- [bench.mjs](bench.mjs): the driver (one configuration, N runs; skips configurations already done).
- [run.sh](run.sh): `sh run.sh build`, then `sh run.sh all` (five timing holds) or one block (`core`, `emu1`, `emu16kwn`, `grouprungs`, `preallocsolo`). Needs E-01's flush table for the tmpfs blocks.
- [summarize.py](summarize.py) (every column, `results/tables.md`) and [report.py](report.py) (the tables above, `results/report.md`).
- [fetch.sh](fetch.sh): `cargo fetch --locked` for the two crates.

## Verdict

**A TS-first kernel is viable on this evidence, and the language did not decide throughput on this box's disk.** TS on one thread spends 5.5 µs of CPU per committed append at 50,000/s (bar: 20 µs) with p99 4.3 ms (bar: C + 5 ms = 5.7 ms), and its pipeline floor reaches about 2.8 million 100 B appends a second on the real disk and 4 million on emulated independent disks, far above PERF-09's TS bars (50,000/s per process and per writer) and even its native throughput bars (500,000/s per process, 2 million/s per writer). On the real disk every build hits the same ceiling, the disk's own bandwidth, so MIN-TS ties MIN on G2 at this box's floor. Where the disk is not the limit, Rust is about 2.5 × TS (10.1 against 4.0 million/s) and Go about 1.8 ×, and both have a much tighter tail (p99 0.67-0.75 ms against 2.4 ms at 50,000/s). The native latency bar (C + 0.5 ms) is met only by Rust and Go, only with independent disks and only at moderate load. CPU per append is mostly a fixed 0.2-0.3 of a core per process for batching in every language, so the per-append bars of Q-02 are bars on batch size: under about 13,000 appends/s per process no build meets 20 µs, and Rust meets 2 µs only from about 130,000/s. `kwN` did not raise throughput here (0.8 × with three processes, 1.03 × in one process), because the main thread feeds every worker; so on this evidence M stays `kw` and S `jrnl` stays one journal per process, and `kwN` returns only with a design where writes reach workers directly. `kw` itself costs about 25 % more CPU and 0.07 ms at p50 than `loop`; whether that buys enough isolation from user code and GC pauses is E-07's question. Preallocated segments raised the real-disk ceiling 1.3-1.9 × over growing files, so a journal should preallocate (as etcd does).

Q-02: a TS kernel is viable on this floor: 5.5 µs of CPU per committed append at 50k/s (bar 20 µs), p99 4.3 ms (bar C + 5 = 5.7 ms), ceiling about 2.8M (real disk) to 4M (independent disks emulated) 100 B appends/s per process; on this disk every build hits the same disk-bandwidth ceiling, so throughput did not separate the languages; with the disk out of the way Rust is about 2.5 × TS (10.1M vs 4.0M/s) and Go 1.8 ×, and both have a 3 × tighter p99 (0.67-0.75 vs 2.4 ms); CPU per append is mostly a fixed 0.2-0.3 core per process in every language, so Rust meets 2 µs only above about 130k/s; kwN did not scale (0.8-1.03 ×); preallocated segments beat growing files 1.3-1.9 ×. Moves: MIN, DRAFT and LEAN (`ts→rs`) up on PERF-08 (TS column), PERF-09 and DEP-12 (decision 3b gains nothing here); MIN-TS up on PERF-09 at this box's floor (ties MIN) but down on PERF-08's native column (tail); RUST and SRV (Rust or Go) up only on the native tail (PERF-08 native) and the CPU-bound ceiling, not on CPU per append at moderate rates; M `kwN` down (not planned for phase 2 on this evidence; S `jrnl` one journal per process); S up for preallocated segments.
