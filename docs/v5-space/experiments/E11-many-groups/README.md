# E-11: the cost of N Raft groups in one process, 10 to 10,000

## The question

Q-11 ([QUESTIONS.md](../../QUESTIONS.md) §3): what do N Raft groups cost in one process, idle and busy, from 10 to 10,000?

A **group** is one Raft log with its own leader and replicas. A process that holds part of many resources holds one replica of many groups. The question decides axes G and P (SPACE §2): CELL (16 groups per resource) and LANE (64 per project) against MIN (one group per resource); PERF-12 (idle cost); and whether **quiet groups** (a group with no writes stops sending heartbeats; one link ping per pair of processes keeps failure detection) are needed in phase 2 or can wait (DEV-01).

**Thresholds** (from QUESTIONS.md):
- With quiet groups, 2,000 idle groups use ≤ 1% of a core and ≤ 20 KB each → PERF-12 holds.
- If ticking without quiet groups already meets that at 2,000 → quieting moves to a later phase.
- If a busy group's fixed cost per batch makes 16 groups slower than 1 at equal load → CELL and LANE pay it and MIN does not.

## Method

**Three builds, one design.** Each build is a host program around a Raft library. The library is a pure state machine (it does no I/O); the host owns the clock, the disk and the network.

| Build | Raft library | Host |
|---|---|---|
| Go | etcd's raft at c51f010 (`$SP/dl/raftsrc/raft`), built with Go 1.26.10 (its go.mod needs 1.26) | [go/main.go](go/main.go) |
| Rust | raft-rs 0.7.0 (crates.io; protobuf 2.28 codec) | [rs/src/main.rs](rs/src/main.rs) |
| TS | E-10's line-by-line TypeScript port of etcd's raft at c51f010 ([../E10-raft-port/port](../E10-raft-port/port)), on Node 22.22.0 | [ts/host.ts](ts/host.ts) |

The TS row runs on the real port, not a stand-in: E-10's port exists and passes etcd's 41 datadriven files byte for byte. The port has no binary codec for messages (etcd's Go code uses protobuf), so the TS host carries a small varint codec of its own.

**The cluster.** Three OS processes on loopback. Each hosts one replica of each of N groups (so N three-replica groups in all), one TCP link to each peer (all groups share it), and one ticker for all groups. At start, process `g % 3 + 1` campaigns for group g, so leaders spread evenly. Every replica of a group starts from the same snapshot naming voters 1, 2, 3, as etcd's own test harness does. Raft settings: HeartbeatTick 1, PreVote and CheckQuorum on, 1 MiB per message, 256 messages in flight.

**The host loop** (the same in all three): take incoming frames, tick, and propose; then, for every group touched, take its Ready; write all their entries and hard states into one journal file with one write and **one fdatasync** per loop round (etcd's contract: persist, then send); send all messages for a peer in **one frame**; apply committed entries; advance. A frame is `u32 length, u32 count`, then per message `u32 group, u32 length, bytes`.

**Modes.**
- `tick100`: every group ticks every 100 ms, ElectionTick 10 (etcd's defaults: heartbeat 100 ms, election 1 s).
- `tick500`: every group ticks every 500 ms, ElectionTick 4 (the draft's `ping.ms` of 500 ms as the heartbeat, and `election.ms` of 2 s).
- `quiet500`: the draft's **quiet shards** (DESIGN-V5 §4.2, after CockroachDB's quiesced ranges), ticks of 500 ms. A leader whose group had no proposal for 2 ticks, and whose voters all have its commit index, sends "quiet at c" to its followers and stops ticking the group. A follower at c stops ticking it too (a follower below c asks the leader to wake). A proposal, or any Raft message other than a response, wakes a quiet group. Each pair of processes exchanges one link ping every 500 ms when no other frame went that way. Failure detection on the pings is not exercised here (no failures are injected).

**Loads.** Idle: no writes, N = 10, 100, 1,000, 2,000, 10,000. Busy (quiet mode on): 10,000 writes/s of 100 B over the whole cluster, spread over all groups (N = 1, 10, 16, 100, 1,000, 2,000, 10,000), then over the hottest 1% only (N = 100 to 10,000). Each process proposes to the groups it leads, in proportion. A few busy runs with `tick100` show the cost of ticking under load.

**What is recorded**, per process, over a 6 s window after 3 s of warm-up (4 s for quiet mode, so groups have gone quiet): CPU (`getrusage`, all threads) as a share of one core; frames and messages sent per second; fdatasyncs/s; resident memory (VmRSS) at the end of the window, and the heap after a forced GC (Go and Node); commit latency on the proposing leader, from the write's ideal arrival time (open loop) to the moment the leader applies it (p50, p99); leaders per process and groups still awake at the end; the load average before the run; and the whole disk's write rate during the run. **Memory per group** = (RSS at N − RSS at N = 10) / (N − 10).

**Timing rules.** Every block holds `$SP/bin/timing`; each configuration runs 3 times (repeats interleaved); tables show the median and the range.

**Files.** [bench.mjs](bench.mjs) (driver: starts the three processes, waits until every group has a leader, starts the window, collects each process's JSON), [run.sh](run.sh), [summarize.py](summarize.py), [fetch.sh](fetch.sh). Raw rows: [results/runs.jsonl](results/runs.jsonl). Tables: [results/tables.md](results/tables.md). Smoke runs (not measurements): [results/smoke.jsonl](results/smoke.jsonl).

**Machine.** As [E-12](../E12-journal/README.md): 4 vCPU Firecracker VM, 15 GB RAM, one virtio disk with ext4 without a journal, Linux 6.18.44; Go 1.26.10; Rust 1.97.0; Node 22.22.0.

## Results

Medians of 3 runs; ranges in [results/tables.md](results/tables.md). "Per process" means one of the three processes, each holding one replica of every group. A third of the groups are led by each process.

### Bugs found on the way, and what was re-run

Smoke runs and the first timed rows found three bugs in my hosts, not in the Raft libraries. Each was fixed and every affected row was run again; the old rows are kept, marked, in [results/discarded.jsonl](results/discarded.jsonl).
1. **Rust host dropped "go".** Its drain loop discarded control lines that arrived among frames, so under heavy traffic a process could miss the start of the window. Found in a smoke run; fixed before any timed run.
2. **One inter-arrival time added to latency** (the same generator bug as E-35's): a write made at `(k+1)/rate` was timed from `k/rate`, about 0.1-0.3 ms here. Fixed in all three hosts before any timed busy run.
3. **Quiet notices could stay unsent.** A "quiet at c" notice queued in a tick was sent only when some group had Raft work in that loop round; when the last groups went quiet together, it waited, and a follower that never heard it kept ticking and could campaign. All three hosts had it; it showed most in TS (leaders moved, for example 343/280/377 instead of 334/333/333). Fixed in all three; every quiet-mode row was run again on the fixed hosts.

### Idle, ticking: the cost grows with the group count

CPU per process (share of one core) with no writes at all:

| groups | Go, tick 100 ms | Rust, tick 100 ms | TS, tick 100 ms | Go, tick 500 ms | Rust, tick 500 ms | TS, tick 500 ms |
|---|---|---|---|---|---|---|
| 10 | 0.85% | 0.42% | 1.8% | 0.16% | 0.08% | 0.97% |
| 100 | 1.2% | 0.65% | 2.4% | 0.29% | 0.13% | 1.2% |
| 1,000 | 5.4% | 2.6% | 6.5% | 1.1% | 0.51% | 2.1% |
| **2,000** | **11%** | **4.9%** | **13%** | **2.0%** | **0.98%** | **3.3%** |
| 10,000 | 52% | 27% | 64% | 11% | 5.8% | 14% |

- Every tick, each leader sends a heartbeat to both followers and gets two answers. At 2,000 groups that is 26,667 messages a second per process at 100 ms ticks and 5,333 at 500 ms. The host batches them, so the frames stay at about 40 and 8 a second per process; the cost is the messages, not the frames.
- The cost per group is about the same in Go and TS and about half that in Rust: at 100 ms ticks, 52-65 µs (Go, TS) and 24-27 µs (Rust) of CPU per group per second, at 2,000 and at 10,000 groups.
- **Only Rust with 500 ms ticks stays within 1% of a core at 2,000 groups (0.98%), and none does at 10,000.** So ticking without quiet groups does not meet PERF-12 for the TS kernel (3.3%) or for Go (2.0%), and not for any build at etcd's default 100 ms ticks.

### Memory per group

Resident memory per process, and the growth per group:

| build | RSS at 10 groups | at 2,000 | at 10,000 | RSS growth per group (10 → 2,000; 10 → 10,000) | live heap per group after a GC (10 → 10,000) |
|---|---|---|---|---|---|
| Go | 7.8-9.2 MB | 24 MB | 73-74 MB | 7.8-8.4 KB; 6.6-6.8 KB | 3.5-3.7 KB |
| Rust | 3.4 MB | 11 MB | 41-44 MB | 4.0 KB; 3.9-4.2 KB | (no GC; RSS is the measure) |
| TS | 91 MB | 151-182 MB | 292-304 MB | 31-47 KB; 21-22 KB | 2.8-3.3 KB |

- Rust and Go are well under PERF-12's 20 KB a group. So is TS's **live** data (about 3 KB a group after a full GC, the smallest of the three), but its **resident** memory grows 21-47 KB a group, because V8 keeps the garbage of the message churn between collections and does not hand the pages back. At 2,000 groups that is 31-47 KB on the RSS measure, over the bar.
- The idle state of a group (a RawNode, its in-memory log with one entry, its progress tracker) is small in all three; what a TS process costs depends on how its heap is sized, not on the groups.
- Startup: every group had a leader within 0.2-0.9 s at 2,000 groups and 0.5-2.1 s at 10,000 (TS slowest).

### Idle, quiet: the cost stays flat

With the draft's quiet groups (500 ms ticks for groups that are awake, one link ping per pair of processes every 500 ms), on the fixed hosts:

| groups | Go CPU | Rust CPU | TS CPU | frames/s per process | messages/s | RSS growth per group (Go / Rust / TS) | groups awake at the end |
|---|---|---|---|---|---|---|---|
| 10 | 0.10% | 0.04% | 0.64% | 2-3 | 0 | – | 0 |
| 100 | 0.08% | 0.03% | 0.30% | 2-3 | 0 | 20 / 4.1 / 32 KB | 0 |
| 1,000 | 0.11% | 0.04% | 0.12% | 2-3 | 0 | 10 / 4.2 / 26 KB | 0 |
| **2,000** | **0.10%** | **0.04%** | **0.15%** | 2-3 | 0 | **8.0 / 3.9 / 26 KB** | 0 |
| 10,000 | 0.11% | 0.04% | 0.15% | 2-3 | 0 | 6.5 / 4.0 / 16 KB | 0 |

- **A quiet group costs nothing measurable**: CPU per process does not grow with the group count, and the only frames are the link pings (2-3 a second per process; at most one ping per pair per 500 ms, as PERF-12 asks). What is left is each runtime's own floor (Node's timers and GC: 0.1-0.6%).
- Every group went quiet within the warm-up, leaders stayed where they were put, and no message moved in the window.
- Live heap after a GC: 3.5-4.1 KB per group in Go and 3.3-3.7 KB in TS at 2,000 and 10,000 groups.

### Busy: 10,000 writes a second over the cluster (quiet mode on)

**One group against 16 at equal load** (QUESTIONS.md's third threshold):

| build | groups | CPU per process (mean) | CPU of the busiest process | CPU of the whole cluster | commit p50 | commit p99 |
|---|---|---|---|---|---|---|
| Go | 1 | 43% | 44% | 1.29 cores | 1.88 ms | 5.9 ms |
| Go | 16 | 43% | 44% | 1.31 cores | 1.96 ms | 7.5 ms |
| Rust | 1 | 51% | 64% | 1.53 cores | 1.63 ms | 7.4 ms |
| Rust | 16 | 35% | 36% | 1.06 cores | 1.76 ms | 4.3 ms |
| TS | 1 | 61% | 69% | 1.83 cores | 3.98 ms | 11 ms |
| TS | 16 | 49% | 50% | 1.48 cores | 2.16 ms | 10 ms |

**16 groups were not slower than one.** The whole cluster spent the same CPU in Go and 20-30% less in Rust and TS, because 16 groups spread their leaders over all three processes while one group puts every write on one leader. p99 was a little higher in Go (5.9 → 7.5 ms, ranges 4.5-6.0 against 5.8-7.5) and lower in Rust and TS. A group's fixed cost per batch did not show at 16 groups: the shared loop round (one journal write and fdatasync, one frame per peer) is paid once for all groups.

**Spreading the same load over more groups:**

| groups that get writes | Go CPU / p99 | Rust CPU / p99 | TS CPU / p99 |
|---|---|---|---|
| 16 (of 16) | 43% / 7.5 ms | 35% / 4.3 ms | 49% / 10 ms |
| 100 (of 100) | 46% / 7.6 ms | 36% / 4.9 ms | 46% / 13 ms |
| 1,000 (of 1,000) | 48% / 9.6 ms | 36% / 5.6 ms | 50% / 15 ms |
| 2,000 (of 2,000) | 49% / 14 ms | 38% / 7.2 ms | 57% / 20 ms |
| 10,000 (of 10,000) | 56% / 45 ms | 40% / 21 ms | 72% / 121 ms |
| 100 (hottest 1% of 10,000) | 47% / 9.8 ms | 37% / 4.3 ms | 55% / 22 ms |

- **Writes concentrated on a few groups cost about the same however many quiet groups sit beside them**: with 10,000 groups and the writes on the hottest 1%, CPU and p99 match 100 busy groups.
- **Writes spread thin cost more.** With 10,000 groups each getting about one write a second, each write wakes its group, which goes quiet again two ticks later, so the groups keep waking and sleeping (7,000-7,500 of each process's 10,000 replicas were awake at the end), and every write pays a group's whole round alone: CPU rose 14-47% over 16 groups and p99 rose 5-12 ×. TS fell slightly behind the offered rate there (9,953 of 10,000 commits a second).
- **Ticking under load** (`tick100`, 2,000 groups) cost 2-8 points of a core more than quiet mode at the same load (Go 53% against 49%, Rust 40% against 38%, TS 65% against 57%): the idle groups' heartbeats on top of the work.
- The hosts are simple (a blocking fdatasync per loop round, no pipelining), so these latencies are not the kernel's floor; E-02 is. At 10,000 writes a second each process ran 1,600-3,000 loop rounds (fdatasyncs) a second, and the commit p50 of 1.5-2.3 ms (Go, Rust) and 2.0-4.3 ms (TS) is two fdatasyncs plus two hops on this disk.

## What this box cannot show

- **Real networks and more members.** Three processes on loopback, so one link per pair and no network delay. At n = 100 the link pings grow with the number of member pairs (PERF-12's second clause, about 20,000 frames a second, is an n = 100 sim count, not measured here).
- **Failures.** No process was killed, so quiet groups' failure detection by link pings (and waking groups when a link comes back) was not exercised; the quiet rule's safety needs the model checks (E-14, E-38), not this run.
- **Larger heaps and other GC settings for Node.** The TS hosts ran with `--max-old-space-size=6144` and V8's defaults otherwise. Their RSS per group (16-47 KB) depends on how V8 sizes its heap, which was not tuned; the live heap per group (about 3.5 KB) is the floor.
- **More than 10,000 groups per process**, as SC-13's 100,000 resources would need (E-36 takes this harness there).
- Load averages at the start of runs: median 1.2, max 4.3 (busy runs count their own threads blocked in fdatasync). The idle runs wrote at most 0.07 MB/s to the disk.

## Verdict

**PERF-12 holds with quiet groups, in all three builds.** At 2,000 idle groups per process, quiet groups cost 0.04% (Rust), 0.10% (Go) and 0.15% (TS) of a core, against the 1% bar, and the same at 10,000; the only frames were link pings (2-3 a second per process). Memory per group is 3.9 KB (Rust) and 8.0 KB (Go) of RSS, under 20 KB. TS keeps only about 3.5 KB a group of live data, but its RSS grows 26 KB a group at 2,000 groups (16 KB at 10,000), over the bar on that measure, because V8 holds garbage between collections.

**Quiet groups are needed in phase 2, not later.** Without them, ticking at etcd's 100 ms costs 4.9% (Rust), 11% (Go) and 13% (TS) of a core at 2,000 idle groups, and at the draft's 500 ms 0.98%, 2.0% and 3.3%: only Rust at 500 ms ticks scrapes under 1%, and none does at 10,000 groups (5.8-64%).

**At equal load, 16 groups did not cost more than one** (cluster CPU equal in Go, 20-30% lower in Rust and TS; p99 within 1.3 ×), so CELL and LANE pay no busy penalty at their group counts. What does cost is spreading writes thinly over very many groups (10,000 groups at one write a second each: CPU +14-47%, p99 5-12 ×, TS 121 ms), which is MIN's shape with one group per small resource.

**The TS row ran on E-10's real port**, not a stand-in, and its idle costs track Go's (TS 1.2-1.6 × Go's CPU when ticking, the same order when quiet).

Q-11: with quiet groups (one link ping per process pair every 500 ms), 2,000 idle groups per process cost 0.04% (Rust raft-rs), 0.10% (Go etcd raft) and 0.15% (TS port) of a core and 3.9 / 8.0 KB of RSS per group in Rust / Go (TS: 3.5 KB live heap but 26 KB of RSS per group), flat up to 10,000 groups, so PERF-12 holds on CPU in all three and on memory in Rust and Go; without quiet groups, ticking costs 4.9-13% at 100 ms ticks and 0.98-3.3% at 500 ms (only Rust at 500 ms under 1%), so quieting cannot wait; at 10,000 writes/s, 16 groups cost the same or less than one (cluster CPU 1.31 vs 1.29 cores in Go, 1.06 vs 1.53 Rust, 1.48 vs 1.83 TS; p99 within 1.3 ×), while spreading the load over 10,000 groups at one write a second each costs +14-47% CPU and 5-12 × p99 (TS 121 ms). Moves: every Raft row with many groups per process (MIN, DRAFT, RUST, LEAN, MIN-P, MIN-TS, RLOG, SRV, EMB-V8, SIDE, CELL, LANE, SPLIT) up on PERF-12, provided quiet groups (the draft's quiet shards, CockroachDB's precedent) are in phase 2 (DEV-01: a precedented mechanism, now required early); CELL and LANE neither up nor down on busy cost (no penalty at 16-64 groups); MIN-P up a little against MIN on SC-13 (fewer, busier groups beat many thinly written ones: at 10,000 groups with uniform writes, p99 5-12 × and CPU +14-47%); MIN-TS and the `ts→rs` rows down a little on PERF-12's memory clause until Node's heap is sized or rows leave the V8 heap (TS RSS 16-26 KB per group against 3.5 KB live).
