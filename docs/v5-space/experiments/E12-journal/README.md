# E-12: one shared journal against one log file per group

## The question

Q-12 ([QUESTIONS.md](../../QUESTIONS.md) §3): does one shared journal for every group beat one log file per group, and from how many groups?

It decides axis S (SPACE §2): `jrnl` (one journal per process for every group; one small novel mechanism: cuts and segment indexes) against `walg` (a WAL per group, as etcd, Kafka and Redpanda do; no novel mechanism, but fsyncs grow with groups). It also bears on DEP-12 (group commit: many writes share one fsync) and on every candidate with many groups per process.

**Threshold** (from QUESTIONS.md): at 256 groups, if (b) or (c) reaches at least 0.8 × the appends/s of (a), then `walg` is enough and the journal mechanism is cut. Below that, `jrnl` is required in phase 2.

## Method

One process, storage only: no replication and no network. A record counts as committed ("durable") when the `fdatasync` that covers it returns. This isolates the storage layout. E-02 already measured the full three-replica pipeline on one journal.

**Three layouts** (the same in Node and in Rust):

| Mode | What | Who waits for what |
|---|---|---|
| **a** | one journal for every group | When the journal is idle, it takes every queued record, writes them with one write, and calls one `fdatasync` (group commit). |
| **b** | one file per group, synced per group | Each group commits on its own: when its file is idle, it takes that group's queue, writes it, and calls `fdatasync` on that file. At most `pool` fdatasyncs run at once (Node: libuv's thread pool, default 4; Rust: 4 worker threads). |
| **c** | one file per group, all synced together per window | When idle, take every group's queue, write each dirty file, call `fdatasync` on all of them at once (on `pool` threads), and ack every record when the last one returns. |

**Load.** N groups (1, 16, 256, 2,000) share a fixed total rate of 100-byte records: 10,000/s, 50,000/s and 200,000/s, each record sent to a random group. A fourth load, `max`, keeps up to 32 MiB of records in flight (made but not yet durable), as E-02's `max` did; it measures the ceiling, and its latency is queueing. The load is open loop: each record has an ideal arrival time (`k / rate`), and its latency is measured from that time, so a late generator counts against the run, never for it.

**What is recorded per run:** durable appends/s in the window; fdatasync calls/s; commit p50, p99, p99.9 and max; CPU of the whole process (all threads, `getrusage` or `process.cpuUsage`) per durable append; records per fdatasync; the load average before the run; busy cores outside this process during the window (`/proc/stat` minus our own CPU); and the whole disk's write rate during the run (`/proc/diskstats`, to spot other writers).

**Record format.** Batch header (u32 length, u32 CRC-32 of the rest, u32 sequence, u32 count), then per record u32 group, u32 sequence in group, u32 length, payload. The CRC is computed over each batch (zlib's in Node, crc32fast in Rust).

**Variants.**
- **Preallocated segments** (as E-02): each file is a ring, filled with zeros before the run, so every write overwrites blocks already on disk and an `fdatasync` never has to write new size metadata. 256 MiB in all, split over the files (at least 256 KiB per file).
- **32 sync threads** for b and c (Node `UV_THREADPOOL_SIZE=32`, Rust `pool=32`), to give per-group files more fdatasyncs in flight.
- **Other filesystems on the same disk** (Rust only). E-01 found the root ext4 has **no journal**, so the threshold's note about ext4's shared jbd2 commit cannot be checked on `/`. [mkfs.sh](mkfs.sh) makes two 4 GiB loop filesystems on the same virtual disk, with direct I/O on the loop device: **ext4 with its jbd2 journal** (`data=ordered`, the default) and **XFS**. Fixed-rate runs use growing files; `max` runs use preallocated segments (a `max` run with growing files fills 4 GiB in about 8 s; those three runs were set aside in [results/discarded.jsonl](results/discarded.jsonl)).

**Timing rules.** Every block of runs holds `$SP/bin/timing` (the box to itself). Each run: 1.5 s warm-up, a 6 s window, 1 s drain. Each configuration runs 3 times, the repeats interleaved across the block. Tables show the median and the range.

**Files.** [ts/journal.ts](ts/journal.ts) (Node; E-35 reuses it with record classes, batch caps, round robin and side files), [rs/src/main.rs](rs/src/main.rs) (Rust), [run.sh](run.sh) (blocks, resumable), [mkfs.sh](mkfs.sh), [summarize.py](summarize.py), [fetch.sh](fetch.sh). Raw rows: [results/runs.jsonl](results/runs.jsonl). Tables: [results/tables.md](results/tables.md).

**Machine.** 4 vCPU Firecracker VM (Intel Xeon 2.1 GHz), 15 GB RAM, one virtio disk (`/dev/vda`, write-back cache) with ext4 mounted **without a journal** (`discard`, `barrier`, `commit=5`; see [E-01's env.txt](../E01-floors/results/env.txt)); Linux 6.18.44; Node 22.22.0; Rust 1.97.0 (libc 0.2.191, crc32fast 1.5.4); xfsprogs 6.6.0 (Ubuntu archive) for the XFS variant.

## Results

All numbers are medians of 3 runs; ranges are in [results/tables.md](results/tables.md). C (one commit's floor on this box, from E-01) is 0.73 ms.

### In plain words

- **One journal keeps one fsync stream whatever the number of groups.** It made 740-890 fdatasyncs a second at every group count and every fixed rate, and its commit p99 stayed at 2.0-6.6 ms (Rust) and 3.3-4.5 ms (Node) from 16 to 2,000 groups.
- **Per-group files turn one fsync per batch into one fsync per group's batch.** At 256 and 2,000 groups they made 7,000-14,000 fdatasyncs a second, the disk queued them, and commit p99 rose to 9-92 ms (Rust) and 21-147 ms (Node) at 256 groups, and to 31-731 ms at 2,000 groups. That is 4.5-46 times the journal's p99 at 256 groups and 9-186 times at 2,000, at the same offered rate. At 16 groups the gap was smaller and uneven (1.3-11.5 ×). Every layout kept up with every fixed rate; only the waiting changed.
- **Per-group files also cost 3.5-4 times the CPU per append** at 10,000-50,000 appends/s: Rust 11 → 43 µs and 2.3 → 9.0 µs; Node 21 → 76 µs and 4.8 → 18 µs. Each group's batch pays its own write and fsync call.
- **The ceiling is a different story at few groups.** With 16 groups and 4 sync threads, per-group files reached 1.83 × the journal's `max` in Rust (9.9 against 5.4 million appends/s) and 1.28 × in Node: this disk serves several flushes at once faster than one flush at a time, and one journal keeps only one flush in flight. The striped journal below tests whether a journal can have both.
- **At the threshold's point, 256 groups, the ceiling passes and the latency fails.** Mode b reached 0.90 × (Rust) and 0.86 × (Node) of the journal's `max`, above the 0.8 bar; mode c 0.48 × and 0.73 ×. But at every fixed rate its p99 was 13-46 × the journal's.
- **At 2,000 groups (SC-10's floor for groups per process) both fail.** Mode b reached 0.63 × (Rust) and 0.32 × (Node) of the journal's `max`, mode c 0.28 × and 0.21 ×, and p99 at fixed rates was 13-150 ×.

### The threshold row: 256 groups, growing files, 4 sync threads

| build | load | a: one journal | b: file per group, own sync | c: file per group, synced together | b ÷ a | c ÷ a |
|---|---|---|---|---|---|---|
| Rust | `max` appends/s | 5.37 M | 4.85 M | 2.57 M | **0.90** | 0.48 |
| Node | `max` appends/s | 1.62 M | 1.39 M | 1.17 M | **0.86** | 0.73 |
| Rust | p99 at 10k/s | 2.0 ms | 92 ms | 9.0 ms | 46 × | 4.5 × |
| Rust | p99 at 50k/s | 2.6 ms | 45 ms | 54 ms | 17 × | 20 × |
| Rust | p99 at 200k/s | 2.6 ms | 35 ms | 72 ms | 14 × | 28 × |
| Node | p99 at 10k/s | 3.4 ms | 46 ms | 21 ms | 14 × | 6.0 × |
| Node | p99 at 50k/s | 3.8 ms | 67 ms | 76 ms | 18 × | 20 × |
| Node | p99 at 200k/s | 4.5 ms | 91 ms | 147 ms | 20 × | 33 × |
| Rust | fdatasyncs/s at 50k/s | 884 | 11,218 | 14,061 | 13 × | 16 × |
| Rust | CPU µs per append at 50k/s | 2.3 | 9.0 | 8.9 | 3.9 × | 3.9 × |
| Node | CPU µs per append at 50k/s | 4.8 | 18.2 | 15.8 | 3.8 × | 3.3 × |

### Across group counts (growing files, 4 sync threads)

`max` appends/s, and p99 at 50,000 appends/s:

| groups | build | a `max` | b `max` (÷ a) | c `max` (÷ a) | a p99 | b p99 | c p99 |
|---|---|---|---|---|---|---|---|
| 1 | Rust | 5.09 M | 5.70 M (1.12) | - | 20 ms* | 25 ms* | - |
| 16 | Rust | 5.42 M | 9.91 M (1.83) | 5.70 M (1.05) | 3.1 ms | 23 ms | 22 ms |
| 256 | Rust | 5.37 M | 4.85 M (0.90) | 2.57 M (0.48) | 2.6 ms | 45 ms | 54 ms |
| 2,000 | Rust | 2.63 M† | 1.65 M (0.63) | 0.75 M (0.28) | 3.3 ms | 189 ms | 310 ms |
| 1 | Node | 1.58 M | 1.67 M (1.06) | - | 4.0 ms | 4.2 ms | - |
| 16 | Node | 1.75 M | 2.25 M (1.28) | 1.57 M (0.90) | 3.3 ms | 8.1 ms | 7.3 ms |
| 256 | Node | 1.62 M | 1.39 M (0.86) | 1.17 M (0.73) | 3.8 ms | 67 ms | 76 ms |
| 2,000 | Node | 1.84 M | 0.59 M (0.32) | 0.40 M (0.21) | 3.8 ms | 460 ms | 378 ms |

\* With one group, a and b run the same code path, so the 1-group rows are the noise control: their p99 ratio was 0.99-1.26 at every fixed rate, while one rare disk stall (E-01 saw 20-50 ms flush stalls in every run) can set p99 in a 6 s window. The 1-group Rust runs at 10,000 and 50,000/s caught such stalls in 2 of 3 runs (ranges in the tables). † The Rust one-journal `max` at 2,000 groups ranged 2.0-4.0 M across its 3 runs, against 5.3-6.0 M at 256 groups; a journal does not depend on the group count, so this is the disk's variance, and b ÷ a at 2,000 stays below 0.8 even against the lowest run (1.65 against 2.0 M).

### Variants

**Preallocated segments** (zero-filled rings, so every write overwrites blocks already on disk). They help the journal far more than the per-group files, so the gap widens:

| build | groups | a `max` | b `max` (÷ a) | c `max` (÷ a) | p99 at 50k/s: a / b / c |
|---|---|---|---|---|---|
| Rust | 256 | 7.89 M | 5.39 M (0.68) | 2.58 M (0.33) | 2.8 / 61 / 132 ms |
| Rust | 2,000 | 7.75 M | 2.24 M (0.29) | — | 2.6 / 235 / 402 ms |
| Node | 256 | 2.88 M | 1.53 M (0.53) | 1.25 M (0.43) | 2.9 / 108 / 127 ms |
| Node | 2,000 | 2.82 M | 0.87 M (0.31) | 0.62 M (0.22) | 6.1 / 468 / 419 ms |

(The Rust 2,000-group c row at `max` is in the tables.) With preallocation the journal's ceiling rose 1.5 × in Rust and 1.8 × in Node over growing files, as E-02 found, and its p99 stayed at 2.6-6.1 ms.

**32 sync threads** for b and c (growing files; compared with the 4-thread journal on growing files). More fdatasyncs in flight lift the per-group files' ceiling and cut their tail, but not to the journal's:

| build | groups | b `max` ÷ a | c `max` ÷ a | fdatasyncs/s at 50k/s (b) | p99 at 50k/s: a / b / c |
|---|---|---|---|---|---|
| Rust | 256 | 1.27 | 0.70 | 23,233 | 2.6 / 14 / 24 ms |
| Rust | 2,000 | 0.89 | 0.42 | 21,317 | 3.3 / 76 / 133 ms |
| Node | 256 | 0.95 | 0.97 | 26,574 | 3.8 / 37 / 26 ms |
| Node | 2,000 | 0.56 | 0.35 | 23,426 | 3.8 / 176 / 136 ms |

At 32 threads the per-group files spend 20-25 µs of CPU per append at 50,000/s (Rust and Node), against 2.3 (Rust) and 4.8 (Node) for the journal: 5-10 × the CPU for the same work, because every one of the 21,000-27,000 fdatasyncs a second is a system call and a thread wake-up.

**Other filesystems on the same disk** (Rust; ext4 with its jbd2 journal, and XFS, each on a 4 GiB loop device with direct I/O; `max` on preallocated segments):

| fs | groups | a `max` | b `max` (÷ a) | c `max` (÷ a) | p99 at 50k/s: a / b / c |
|---|---|---|---|---|---|
| ext4 + jbd2 | 256 | 6.60 M | 5.29 M (0.80) | 2.56 M (0.39) | 5.3 / 99 / 98 ms |
| ext4 + jbd2 | 2,000 | 7.13 M | 2.13 M (0.30) | 0.87 M (0.12) | 4.8 / 694 / 600 ms |
| XFS | 256 | 7.24 M | 5.76 M (0.80) | 3.03 M (0.42) | 5.0 / 58 / 119 ms |
| XFS | 2,000 | 7.38 M | 2.37 M (0.32) | 0.89 M (0.12) | 4.7 / 388 / 854 ms |

The jbd2 journal did not rescue per-group files: on ext4 with a journal, b's p99 at 256 groups was 19 × the shared journal's, about what the journal-less root showed (17 ×). XFS was a little kinder to b at 256 groups (12 ×) and no better at 2,000. QUESTIONS.md expected that ext4's shared jbd2 commit might batch the per-file fsyncs; on this disk it did not batch them enough to matter.

**One sync thread per group** for b and c (Rust; 256 and 2,000 threads, as a goroutine per WAL would give). More threads in flight do not close the gap:

| groups | b `max` ÷ a | c `max` ÷ a | fdatasyncs/s at 50k/s (b) | p99 at 50k/s: a / b / c | CPU µs per append at 50k/s (b) |
|---|---|---|---|---|---|
| 256 | 0.93 | 0.68 | 28,982 | 2.6 / 28 / 27 ms | 38 |
| 2,000 | 0.47 | 0.44 | 26,466 | 3.3 / 242 / 193 ms | 46 |

**One journal striped over 4 files** (Rust; each file has its own flush thread, group g goes to file g % 4), to test whether a journal can also use the disk's parallel flushes:

| groups | load | striped: appends/s | ÷ one journal | striped p99 | one journal p99 | fdatasyncs/s |
|---|---|---|---|---|---|---|
| 256 | 10k/s | 10k | 1.00 | 48 ms | 2.0 ms | 3,211 |
| 256 | 50k/s | 50k | 1.00 | 17 ms | 2.6 ms | 3,417 |
| 256 | 200k/s | 200k | 1.00 | 3.8 ms | 2.6 ms | 3,473 |
| 256 | `max` | 6.57 M | 1.22 | 138 ms | 97 ms | 188 |
| 2,000 | 50k/s | 50k | 1.00 | 16 ms | 3.3 ms | 3,398 |
| 2,000 | `max` | 6.70 M | 2.55 | 206 ms | 267 ms | 254 |

Striping raises the journal's ceiling (1.2-2.6 ×) but makes its p99 5-24 × worse at 10,000-50,000 appends/s. On this disk, several flush streams at once slow each other at moderate load, as the per-group files do; only with big batches near the ceiling does the parallelism pay. So the best journal here is **one flush stream** at moderate load. Adding flush streams under load only (or preallocation, which gave 1.5 × without any cost in p99) is the way to a higher ceiling. This also bears on M `kwN`: "one journal per worker" means several flush streams, which on this disk costs latency at moderate load.

### Measurement notes

- **A small bias in every latency here.** The load generators (both builds) made record k when `(k+1)/rate` had passed, but timed it from `k/rate`. So every latency in E-12 includes one extra inter-arrival time: 0.1 ms at 10,000/s, 0.02 ms at 50,000/s, 0.005 ms at 200,000/s, nothing at `max`. It is the same for a, b and c, so no ratio moves by more than 0.1 ms over its base, and no conclusion changes. It was found during E-35, where classes write 10 or 100 times a second and the extra time was 10-100 ms; [ts/journal.ts](ts/journal.ts) is fixed (E-35 runs on the fixed code), the Rust harness was kept as it was so that all E-12 Rust rows stay comparable.
- **Another agent's CPU-only job** ran outside the lock from about 06:01 to 06:16, during the Rust 256- and 2,000-group blocks: `other_cores` (busy cores outside this process) jumped from about 0.1 to 1.15 for every run, even runs whose own work was tiny, while the whole disk's write rate matched the run's own. It used about one of the four cores and no disk; the journal's numbers in those blocks match the 16-group block's.
- **Noise control.** With one group, modes a and b run the same path. Their ratios (0.99-1.26 on p99, 1.00-1.12 on `max`) show how far two identical layouts drift on this disk in 6 s windows. Differences of 4 × and more, as above, are far outside it.
- Load averages at the start of runs: median 2.7, max 5.1 (the load average counts threads blocked in fdatasync, so it rises with the per-group runs' own sync threads; `other_cores` is the better measure of outside work: median 0.42).

## What this box cannot show

- **Independent disks.** One process here, one virtual disk. With a real NVMe drive, or one volume per tenant, parallel flushes may cost less; E-01 showed this disk serves several flushes at once faster than one at a time near its ceiling, and slower at moderate load. The ratios here are for one virtio disk with a write-back cache.
- **Other filesystems at full size.** ext4 with its journal and XFS ran on 4 GiB loop devices on the same disk; they agree with the root filesystem, but are not a native mount.
- **Group counts above 2,000 and real Raft traffic.** Each group here is a stream of appends with no Raft messages; E-11 runs the groups for real.
- **Durability of the host.** As E-01 says, whether the host's media holds a flush cannot be seen from the guest.

## Verdict

**`jrnl` is required.** One shared journal keeps one stream of about 800 fdatasyncs a second whatever the group count, and a commit p99 of 2-4.5 ms from 1 to 2,000 groups. A log file per group (`walg`) turns that into 7,000-29,000 fdatasyncs a second, 3.5-10 × the CPU per append, and a p99 4.5-47 × higher at 256 groups and 9-186 × higher at 2,000 (9-854 ms against 2-6.6 ms), at the same offered rate, in Node and in Rust, on the journal-less root ext4, on ext4 with jbd2 and on XFS, with 4, 32 or one sync thread per group. That misses PERF-08's commit bars (C + 5 ms = 5.7 ms for TS, C + 0.5 ms for native) by a wide margin from 256 groups up, and in most 16-group rows.

**The threshold as written is met only on throughput, only at 256 groups, and fails at 2,000.** QUESTIONS.md asked for (b) or (c) ≥ 0.8 × (a)'s appends/s at 256 groups. With growing files, b reached 0.90 × (Rust) and 0.86 × (Node), and 1.27 × with 32 sync threads; with preallocated segments only 0.53-0.68 ×. At 2,000 groups, SC-10's floor for groups per process, b reached 0.29-0.93 × (0.63 × Rust and 0.32 × Node with 4 threads). The threshold names only throughput, but the latency gap decides: at 256 groups and above, no `walg` variant came within 4 × of the journal's p99 (26 configurations at each count). So the "below" branch applies: `jrnl` (with its cuts and segment indexes) is required in phase 2.

**Two design notes for the journal.** Preallocate its segments (1.5-1.8 × the ceiling, no cost in p99). Keep one flush stream at moderate load: striping it over 4 files raised the ceiling 1.2-2.6 × but cost 5-24 × in p99 at 10,000-50,000 appends/s on this disk.

Q-12: one shared journal beats a log file per group on commit latency from 256 groups up in every variant (p99 2-6.6 ms against 9-854 ms: 4.5-47 × at 256 groups, 9-186 × at 2,000; 1.3-11.5 × at 16), with 8-30 × fewer fdatasyncs and 3.5-10 × less CPU per append, in Node and Rust, on ext4 without and with jbd2 and on XFS, with 4, 32 or one sync thread per group; per-group files reach the 0.8 × throughput bar only at 256 groups (0.86-1.27 × with growing files, 0.53-0.68 × preallocated) and miss it at 2,000 (0.29-0.93 ×); the best journal here preallocates and keeps one flush stream (striping over 4 files: ceiling 1.2-2.6 ×, p99 5-24 × worse at moderate load). Moves: S `jrnl` up and `walg` down on DEP-12, PERF-08 and SC-10 (groups per process ≥ 2,000), so every row with S `jrnl` (DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) keeps it and its one small mechanism (cuts, segment indexes); ISR (`walg +tier`) down on PERF-08 at many partitions per process; M `kwN` down a little (one journal per worker means several flush streams, which cost latency on this disk).
