# E-01: this box's floors (fsync, flush honesty, loopback round trip)

> **C = 0.73 ms** (measured here). C is one commit's floor on this box: the fdatasync p99 with three writers on the one disk (fio, 4 KiB, **676 µs**, median of 3 runs, range 602-700) plus the loopback TCP round-trip p99 (Rust, 1 KiB, **58 µs**, range 57-59): 676 + 58 = 734 µs. With Node's round-trip p99 (96 µs) in place of Rust's, C_node = 0.77 ms. In short: **C ≈ 0.73 ms; C + 5 ms ≈ 5.7 ms (the TS bar of PERF-08); C + 0.5 ms ≈ 1.2 ms (the native bar).** Every latency bar in this study is written against C. The bars are also stated against a cited cloud figure (below), which the user must confirm.

## The question

Q-01: what are this box's floors? fsync time for one writer and for three writers on the one disk, and a loopback round trip. Are flushes honoured? (QUESTIONS.md §1.)

## The answer in short

- **One writer:** fdatasync after a 4 KiB write takes 194 µs at p50 and **481 µs at p99** (fio, 3 runs, range 465-490). p99.9 is 1.3 ms.
- **Three writers on the one disk:** **676 µs at p99** (602-700), 1.4 × the one-writer p99. That is under the 2 × threshold, so matched runs with three replicas on this disk are **not** called disk-bound by the threshold's rule. The disk also does more work with three writers: 9,374 flushed writes a second against 4,483 with one.
- **Stalls.** Every 30-60 s fio run had at least one flush of 22-52 ms (the "sync max" column). A stall like that, inside an 8-second window, sets a pipeline's p99 by itself. E-02 sees the same stalls.
- **Flushes cost real time.** A 4 KiB O_DIRECT write with no flush takes 37 µs (p50). With O_DSYNC it takes 173 µs. So the flush adds about 140 µs. The guest negotiates the virtio flush feature (bit 9 is set), and on Firecracker a guest flush becomes an `fsync` of the backing file on the host ([Firecracker docs, block-caching.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/block-caching.md), cited). `O_DIRECT|O_DSYNC` (391 µs p99) and buffered write plus fdatasync (481 µs p99) differ by 1.2 ×, well under the 2 × threshold. The sustained-write test is below. **What this box cannot show** is whether the host's fsync reaches stable media: a host NVMe with power-loss protection and a host that caches would both look like this.
- **Round trip:** a 1 KiB loopback ping-pong takes 31 µs p50 and **58 µs p99** in Rust, 28 / 84 µs in Go and 40 / **96 µs** in Node (median of 3 runs). These are slow for loopback. A smoke check of the same programs on a busy box, outside the lock (load 8; not a result), gave Rust 3.4 µs and Node 11-12 µs at p50. The likely reason (reasoned from those two observations, not proven) is that on this VM an idle vCPU halts and takes about 25 µs to wake, while on a busy box the vCPUs never halt. A commit wakes an idle thread at every hop, so the quiet-box number is the honest floor.
- **The filesystem has no journal.** `/` is ext4 mounted **without a journal** (dmesg: "mounted filesystem ... r/w without journal"), `discard`, `barrier`, `commit=5`. So there is no jbd2 and no journal mode to record. This matters for E-12: its threshold reasons about ext4's shared jbd2 commit, which does not exist here.

## Method

Everything ran under `$SP/bin/timing` (the box alone, apart from processes that do not take the lock), with `/proc/loadavg` recorded before each run. Each fio job ran 3 times, in three rounds (the first round in its own hold, rounds 2 and 3 in one hold). The probe rounds shared one hold, and the round-trip and sustained rounds another, so other agents' heavy jobs did not run between them.

- **fio** 3.36 (Ubuntu package, installed by the toolsmith, see [TOOLS.md](../TOOLS.md); not built from source as E-01's entry says, because the Ubuntu build has every engine needed). `--rw=write --ioengine=sync --size=4G --time_based`, on ext4 at `$SP/e01e02/e01` (the root disk `/dev/vda`). fio's default layout is `fallocate=native`, so its files start as unwritten extents. Jobs:
  - `fsync-1w-4k` and `fsync-3w-4k`: 4 KiB writes, `--fdatasync=1`, 60 s, 1 job and 3 jobs (each its own file, `--group_reporting`).
  - `dsync-1w-4k`: O_DSYNC (`--sync=dsync`), 30 s.
  - `direct-dsync-1w-4k` and `direct-dsync-3w-4k`: `O_DIRECT|O_DSYNC`, 30 s.
  - `direct-nosync-1w-4k`: O_DIRECT, no flush: the device's write time alone, 30 s.
  - `fsync-1w-64k`: 64 KiB writes with fdatasync, 30 s.
- **The probe** ([probe/wfsync.c](probe/wfsync.c), our own 109 lines of C): N writer processes on N files; each times one `pwrite` plus one `fdatasync` together and records every sample. Layouts: `grow` (a new file that grows, like an appended journal), `falloc` (fallocate 1 GiB first: unwritten extents), `zero` (1 GiB of zeros written and synced first: a pure overwrite). 20 s per run. Its one-writer `grow` samples give the 1,000-quantile table [results/fdatasync-1w-cdf.txt](results/fdatasync-1w-cdf.txt) that E-02's tmpfs variant draws its delays from.
- **Round trip** ([rtt/](rtt)): a TCP ping-pong on 127.0.0.1, one message in flight, Nagle off, in Node 22 ([rtt.mjs](rtt/rtt.mjs)), Rust ([rtt/rs](rtt/rs), std blocking sockets) and Go ([rtt.go](rtt/rtt.go)), 64 B and 1 KiB, 10 s after 1 s of warm-up, client and server in separate processes.
- **Sustained write**: 10 GiB of 1 MiB `O_DIRECT` writes (libaio, depth 8), with a 4 KiB fdatasync probe at 200 a second beside it. A host-side write cache that fills would show as a bandwidth cliff, or as the probe's flush time rising during the run.

Cost: about 40 minutes of the box alone (the entry estimated 0.4 CPU-hours), about 3 hours of wall time with the waits for the lock.

Machine: Firecracker VM (the kernel is `6.18.44-fc` and PID 1 runs with `--firecracker-init`), kernel 6.18.44-fc, 4 vCPU (Intel Xeon @ 2.10 GHz, no SMT), 15.7 GiB RAM, one virtio disk `/dev/vda` (`write_cache=write back`, `fua=0`, scheduler mq-deadline). Node 22.22.0, Rust 1.97.0, Go 1.24.7, gcc 13.3. Full details: [results/env.txt](results/env.txt).

## Results

Median of 3 runs, range in brackets. All latencies in µs. Raw lines: [results/fio.jsonl](results/fio.jsonl), [results/probe.jsonl](results/probe.jsonl), [results/rtt.jsonl](results/rtt.jsonl), [results/sustained.jsonl](results/sustained.jsonl); the same tables: [results/tables.md](results/tables.md). The full fio JSON and the probe's raw samples stay in `$SP/e01e02/e01-raw/` (too big for the repo).

#### fio (median of runs, range in brackets; µs)

| job | runs | IOPS | sync p50 | sync p99 | sync p99.9 | sync max | write clat p50 | write clat p99 | write clat p99.9 |
|---|---|---|---|---|---|---|---|---|---|
| fsync-1w-4k | 3 | 4,483 (4,474-4,530) | 194 (194-194) | 481 (465-490) | 1,286 (1,155-1,597) | 36,054 (22,665-38,170) | 3.1 (3.1-3.2) | 20.6 (17.8-22.9) | 55.6 (51.5-58.1) |
| fsync-3w-4k | 3 | 9,374 (9,356-9,858) | 289 (276-289) | 676 (602-700) | 1,942 (1,827-2,769) | 22,669 (21,684-43,877) | 3.1 (3.1-3.2) | 39.7 (20.4-40.2) | 85.5 (69.1-121.3) |
| dsync-1w-4k | 3 | 4,344 (4,201-4,574) | - | - | - | - | 200 (194-208) | 528 (477-553) | 1,335 (1,302-1,728) |
| direct-dsync-1w-4k | 3 | 5,467 (5,179-5,517) | - | - | - | - | 173 (173-177) | 391 (362-432) | 1,004 (930-2,114) |
| direct-nosync-1w-4k | 3 | 25,615 (25,337-25,941) | - | - | - | - | 36.6 (36.1-36.6) | 79.4 (76.3-88.6) | 268 (264-412) |
| fsync-1w-64k | 3 | 2,458 (2,092-3,629) | 313 (249-334) | 946 (578-1,237) | 2,802 (2,007-4,489) | 32,528 (25,348-51,854) | 14.7 (13.0-15.7) | 362 (64-498) | 13,042 (399-16,908) |
| direct-dsync-3w-4k | 3 | 10,318 (10,014-10,930) | - | - | - | - | 272 (255-272) | 594 (561-643) | 1,810 (1,761-2,023) |

#### probe: one pwrite plus fdatasync, timed together (µs). nosync-1w hit the probe sample cap (200k/s), so its ops/s is a floor

| layout | runs | ops/s (all writers) | write+flush p50 | p99 | p99.9 | flush only p50 | p99 | p99.9 |
|---|---|---|---|---|---|---|---|---|
| grow-1w | 3 | 4,818 (4,531-5,163) | 172 (172-192) | 482 (478-623) | 1,538 (1,316-2,288) | 168 (168-187) | 469 (468-614) | 1,506 (1,282-2,228) |
| grow-3w | 3 | 9,958 (9,740-10,073) | 279 (266-281) | 610 (604-668) | 2,482 (1,565-2,646) | 275 (261-276) | 595 (594-653) | 2,276 (1,507-2,544) |
| falloc-1w | 3 | 4,878 (4,840-5,067) | 188 (182-188) | 436 (435-450) | 1,325 (1,312-1,427) | 184 (178-184) | 427 (425-442) | 1,319 (1,269-1,388) |
| zero-1w | 3 | 5,812 (5,164-5,930) | 164 (161-179) | 346 (331-406) | 1,150 (1,003-1,368) | 159 (157-174) | 337 (322-395) | 1,117 (958-1,271) |
| zero-3w | 3 | 7,138 (6,990-7,550) | 397 (378-404) | 868 (825-869) | 2,378 (2,369-2,572) | 391 (372-398) | 856 (813-858) | 2,346 (2,342-2,559) |
| nosync-1w | 3 | 200,100 (200,100-200,100) | 1.6 (1.6-1.6) | 19.7 (17.3-19.7) | 104 (89-198) | 0.0 (0.0-0.0) | 0.0 (0.0-0.0) | 0.1 (0.1-0.1) |

#### loopback TCP round trip, one message in flight (µs)

| impl | bytes | runs | round trips/s | p50 | p99 | p99.9 |
|---|---|---|---|---|---|---|
| node | 64 | 3 | 24,517 (24,008-24,743) | 38.4 (37.8-38.4) | 89.8 (83.1-97.4) | 328 (316-356) |
| node | 1024 | 3 | 23,158 (22,002-23,445) | 39.8 (39.5-39.9) | 95.9 (95.4-108.3) | 324 (294-363) |
| rust | 64 | 3 | 32,523 (31,631-34,131) | 29.5 (28.9-29.9) | 56.0 (54.0-58.2) | 182 (150-196) |
| rust | 1024 | 3 | 32,006 (31,526-34,488) | 30.6 (30.1-30.6) | 58.3 (57.0-58.9) | 194 (177-200) |
| go | 64 | 3 | 36,723 (36,235-41,281) | 30.2 (19.0-30.6) | 83.3 (82.7-84.0) | 160 (140-170) |
| go | 1024 | 3 | 37,651 (35,991-38,684) | 28.3 (26.0-29.9) | 83.5 (83.4-85.6) | 151 (147-154) |

#### sustained 10 GiB O_DIRECT write with a 4 KiB fdatasync probe (200/s offered) beside it

| run | GiB | seconds | MiB/s mean | MiB/s per second (min-max) | probe flushes | probe fdatasync p50 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|---|---|
| 1 | 10.0 | 12.8 | 800.0 | 612.4-1184.8 | 39 | 304 | 684 | 687 |
| 2 | 10.0 | 11.3 | 906.4 | 642.4-1238.8 | 42 | 246 | 591 | 595 |
| 3 | 10.0 | 10.6 | 969.9 | 582.4-1254.7 | 31 | 263 | 893 | 891 |


## Reading the results

- **C.** C = 676 µs (fio fdatasync p99, 3 writers) + 58 µs (Rust round-trip p99, 1 KiB) = **0.73 ms**. The probe agrees: its `grow-3w` write-plus-flush p99 is 610 µs.
- **Three writers against one.** 676 / 481 = 1.4 × at p99 (probe: 610 / 482 = 1.3 ×). Under 2 ×: by the entry's rule the matched runs are not disk-bound. But two cautions stay. First, each flush is a host fsync of one shared backing file, so three replicas here never have three independent disks; E-02's tmpfs variant emulates independent disks. Second, the 20-50 ms stalls hit every writer, so a p99 measured over a few seconds can be set by one stall.
- **Are flushes honoured?** Three checks, all measured here: (1) the guest sees and uses a flush command (virtio bit 9; `write_cache=write back`); (2) a flush costs about 140 µs over a plain O_DIRECT write, so the host does work for it; (3) `O_DIRECT|O_DSYNC` and buffered write plus fdatasync differ by only 1.2 × at p99, and the sustained run shows the flush doing real work: 10 GiB of O_DIRECT writes went at 800-970 MiB/s with no cliff (582-1,255 MiB/s in every second, faster at the end than at the start), while a 4 KiB fdatasync issued beside them waited **250-300 ms at p50 and up to 0.9 s**. A flush that was dropped would not wait for the bulk data ahead of it. The likely shape (reasoned, not proven): the host keeps guest writes in its own write-back cache and a guest flush becomes a host fsync that drains it. Nothing here says the flushes are dropped. But 0.2 ms is fast for a flush that reaches flash on an ordinary SSD, and it is in the range of a datacenter NVMe with power-loss protection, or of a host that acknowledges from a protected cache. So, as the threshold says, **every report states its latency bars twice**: against C, and against a cited figure for the deploy target.
- **The cited deploy-target figures** (cited, not measured; the user must confirm which applies): AWS describes gp3 and gp2 EBS volumes as designed for single-digit millisecond latency ([AWS EBS volume types](https://aws.amazon.com/ebs/volume-types/)) and io2 Block Express as giving sub-millisecond average latency ([AWS EBS user guide, Provisioned IOPS SSD](https://docs.amazonaws.cn/en_us/ebs/latest/userguide/provisioned-iops.html)). These two come from a web search's summary of those pages; docs.aws.amazon.com itself could not be fetched from this box (the session's network refuses that host). Fly.io says a Fly Volume "is a slice of an NVMe drive on the same physical server as the Machine", with IOPS and bandwidth caps per machine size (for example 32,000 IOPS and 128 MiB/s on the largest), and publishes **no latency figure** ([Fly Volumes overview](https://fly.io/docs/volumes/overview)). So the cloud-SSD row of every bar uses **1-9 ms** (gp3, "single-digit milliseconds") and the local-NVMe row uses this box's C until the user names a target.
- **Layouts.** On this journal-less ext4, a growing file (482 µs p99), a fallocated file (436) and a zero-filled file (346) differ by less than 1.4 × with one writer. With three writers the zero-filled overwrite was the slowest (868 against 610). So, one 4 KiB write at a time, preallocation is not a clear win on this disk. Inside E-02's pipeline, with big batches, preallocated segments did win: they raised the ceiling 1.3-1.9 × ([E-02](../E02-pipeline/README.md)).
- **The price of Y `fwd`'s extra hop** (a write forwarded by a server to the group's writer, against a smart client that goes straight to the writer): one more loopback round trip, 31 µs p50 and 58 µs p99 in Rust, 40 µs and 96 µs in Node. That is 8-13 % of C on this box. Between machines the hop costs a real network round trip, which this box cannot measure.
- **64 KiB.** A 64 KiB write plus fdatasync: 313 µs p50, 946 µs p99, against 194 and 481 for 4 KiB. Bigger batches cost more per flush, but far less per byte. E-02's tmpfs variant uses the 4 KiB distribution for every batch size, which flatters large batches a little.

## What this box cannot show

- Whether the host's fsync reaches stable media (see above). The sustained run shows a flush waits for earlier data, but not where that data lands.
- **Head-of-line blocking on a shared disk.** One bulk writer on the same disk makes every small fdatasync wait 0.25-0.9 s (the sustained run). Any design that puts a big sequential writer (a snapshot, a compaction, a 10 GB catch-up) on the same disk as commit fsyncs will see this; this box shows it, but cannot show whether a real NVMe with separate queues would. This box may be F-10's "disk that lies"; nothing measured here proves it does or does not.
- Independent disks: the three replicas of every matched run share this one virtual disk and the host file behind it.
- Round trips between machines: loopback has no wire, no NIC and no switch. A real datacenter round trip is larger; no figure is cited here because none was measured or confirmed.
- Other filesystems: XFS, ext4 with a journal (data=ordered), NVMe without virtio. E-12's jbd2 reasoning cannot be checked on this mount.
- The stalls' cause. They are 20-50 ms long, rare, and appear in every fio run; other agents' disk use outside the lock, the host, or ext4 writeback could each cause them. They are reported, not explained.

## Files

- [run.sh](run.sh): `sh run.sh all` builds the probe and the round-trip programs, writes `results/env.txt`, then runs three timing holds (fio rounds, probe rounds and the CDF, round trips and sustained writes) and writes `results/tables.md`.
- [summarize.py](summarize.py): reads fio's JSON and the probe's samples; makes the tables and the CDF.
- [probe/wfsync.c](probe/wfsync.c), [rtt/](rtt): the programs.
- No downloads: fio is the Ubuntu package (TOOLS.md); the Rust round-trip program has no dependencies. So there is no fetch.sh.

## Verdict

C is fixed by measurement at **0.73 ms** (fio fdatasync p99 with three writers, 676 µs, plus the Rust loopback round-trip p99, 58 µs). Three writers cost 1.4 × one writer at p99, under the 2 × line, so matched three-replica runs on this disk are not called disk-bound. Flushes cost real time and wait behind earlier data, so they are honoured as far as a guest can see; whether the host's media is durable cannot be seen from here, so every bar is also stated against the cited cloud figure (gp3: single-digit milliseconds). Two findings change other experiments: the root ext4 has **no journal** (E-12's jbd2 reasoning does not apply here), and **rare 20-50 ms flush stalls** plus **0.25-0.9 s flushes behind a bulk writer** set the tail of every pipeline on this disk.

Q-01: C = 0.73 ms on this box (fsync p99 3 writers 676 µs + loopback RTT p99 58 µs; 1 writer 481 µs, so 3 writers = 1.4 ×, not disk-bound by the 2 × rule); flushes are honoured as far as the guest can see (a flush adds ~140 µs and waits behind bulk data), but host durability is unproven, so bars are stated against C and against the cited gp3 figure (1-9 ms). Moves: no candidate up or down by itself; it fixes C for PERF-01, PERF-08 and F-05, adds a cost every candidate's storage (axis S) must pay (keep snapshot and catch-up writes from starving commit fsyncs: E-34, F-19), and makes E-12 restate its jbd2 premise.
