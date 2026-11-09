# E-11: the cost of N Raft groups in one process, 10 to 10,000

> **Status: in progress.** Results and the verdict are filled in when the timed runs finish.

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

**What is recorded**, per process, over a 10 s window after 3 s of warm-up (4 s for quiet mode, so groups have gone quiet): CPU (`getrusage`, all threads) as a share of one core; frames and messages sent per second; fdatasyncs/s; resident memory (VmRSS) at the end of the window, and the heap after a forced GC (Go and Node); commit latency on the proposing leader, from the write's ideal arrival time (open loop) to the moment the leader applies it (p50, p99); leaders per process and groups still awake at the end; the load average before the run; and the whole disk's write rate during the run. **Memory per group** = (RSS at N − RSS at N = 10) / (N − 10).

**Timing rules.** Every block holds `$SP/bin/timing`; each configuration runs 3 times (repeats interleaved); tables show the median and the range.

**Files.** [bench.mjs](bench.mjs) (driver: starts the three processes, waits until every group has a leader, starts the window, collects each process's JSON), [run.sh](run.sh), [summarize.py](summarize.py), [fetch.sh](fetch.sh). Raw rows: [results/runs.jsonl](results/runs.jsonl). Tables: [results/tables.md](results/tables.md). Smoke runs (not measurements): [results/smoke.jsonl](results/smoke.jsonl).

**Machine.** As [E-12](../E12-journal/README.md): 4 vCPU Firecracker VM, 15 GB RAM, one virtio disk with ext4 without a journal, Linux 6.18.44; Go 1.26.10; Rust 1.97.0; Node 22.22.0.
