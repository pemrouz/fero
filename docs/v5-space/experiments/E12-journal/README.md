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

- **One journal keeps one fsync stream whatever the number of groups.** It made 740-890 fdatasyncs a second at every group count and every fixed rate, and its commit p99 stayed at 2.0-3.5 ms (Rust) and 3.4-4.5 ms (Node) from 16 to 2,000 groups.
- **Per-group files turn one fsync per batch into one fsync per group's batch.** At 256 and 2,000 groups they made 7,000-14,000 fdatasyncs a second, the disk queued them, and commit p99 rose to 35-92 ms (Rust) and 46-150 ms (Node) at 256 groups, and to 45-600 ms at 2,000 groups. That is 13 to 150 times the journal's p99, at the same offered rate. Every layout kept up with every fixed rate; only the waiting changed.
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
