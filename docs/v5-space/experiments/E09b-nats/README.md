# E-09b: NATS 2.10 (core and JetStream) on this box, with the nats CLI

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09, NATS row (QUESTIONS.md §2, E-09b): what do NATS core and NATS JetStream reach here, with NATS's own tools, at matched guarantees and at their defaults? It sets the bar numbers of PERF-03 (core pub/sub, 1 → 1 and 1 → 16, 16 B and 1 KiB, msgs/s and p99 publish-to-receive) and PERF-04 (JetStream with 3 replicas and file storage: publish with acks, a pull consumer, a work queue; msgs/s and p99 ack latency), gives E-08 its NATS fan-out number, and says, against [E-02](../E02-pipeline/README.md)'s pipeline floors, whether a TS build can win these rows at all.

## The answer in short

All measured here, medians of 3 runs, each on freshly started servers. Ranges are in the tables below.

__SHORT__

## Method

- **nats-server 2.10.22** and the **nats CLI 0.5.1** (`nats bench`, `nats latency`), release binaries ([TOOLS.md](../TOOLS.md)). The CLI is newer than the server; its `bench` commands worked against 2.10.22 (TOOLS.md). Servers run with config files written by [bench.py](bench.py) and otherwise default settings.
- **Core NATS** (`core`): one server, no JetStream (core NATS is in-memory, at most once). `nats bench sub` with 1 or 16 subscriber connections (one process) starts first; then `nats bench pub` with 1 publisher sends N messages of 16 B or 1 KiB on one subject. The subscribers' aggregate rate counts every delivery, so for 1 → 16 it is deliveries/s. Then `nats latency` (publisher and subscriber in one process, HDR percentiles of publish-to-receive time) at **10,000 msgs/s for 20 s**, 16 B and 1 KiB. `core-route`: three clustered servers, `nats latency` with the publisher on server A and the subscriber on server B (one route hop), 16 B.
- **JetStream**: three clustered servers, each with its own store directory on the one ext4 disk; every stream has **3 replicas and file storage** (`--replicas 3 --storage file`, 1 GB max). Two setups:
  - `js-always`: `jetstream { sync_interval: always }`: the file store fsyncs every message before the ack. This is PERF-04's **matched** row (fero's `persisted`: on disk at a majority before the answer).
  - `js-default`: NATS's default `sync_interval` (2 minutes): a message is acked when a majority of the three replicas have it, written to the OS page cache but not fsynced. NATS's docs say it "relies on stream replication in the cluster to guarantee data is available after an OS crash" ([configuration page](https://github.com/nats-io/nats.docs/blob/master/running-a-nats-service/configuration/README.md), cited). This is the **competitor's default**, and it matches fero's `memory` rung (in memory at a majority), not `persisted`.
- **JetStream tests**, in this order on each fresh cluster, 100-byte messages unless named:
  - `pub-sync-1c`: one client, synchronous publish: each publish waits for its ack, so the tool's per-message latency is the **ack latency at concurrency 1**.
  - `pub-sync-16c`: 16 clients publishing synchronously (16 in flight).
  - `pub-async-100B` and `pub-async-1KB`: one client, asynchronous publish in batches of 500 (the tool's default): the throughput row. Its latency figures are per batch, not per message.
  - `fetch-100B`: a durable **pull consumer** (`nats bench js fetch`, batch 500, explicit acks) reads back everything `pub-async-100B` wrote.
  - **Work queue**: a stream with `--retention work`, filled by one async publisher (`wq-pub`), then drained by **4 pull clients** on one shared durable consumer that ack each message (`wq-fetch-4c`); an acked message is removed from the stream.
- **Message counts** ([msgs.json](msgs.json)) were sized from short busy-box trial runs so a run lasts about 5-40 s. A stream is deleted after its test, so its storage is free for the next.
- **Measured per run:** the tool's msgs/s and percentiles; CPU of every nats-server (from `/proc/<pid>/stat`) and of the tool's processes; the box's busy cores, so "other cores" = load from processes outside this run; `/proc/loadavg` before the run (the 1-minute figure includes our own previous run). Raw lines: [results/runs.jsonl](results/runs.jsonl); the tools' output per run: [results/raw/](results/raw); the tables: [results/tables.md](results/tables.md).
- Everything timed ran under `$SP/bin/timing`, in three holds (`core`, `always`, `default`): [run.sh](run.sh). Machine: E-01's ([env.txt](../E01-floors/results/env.txt)): 4-vCPU Firecracker VM, one virtio disk, ext4 without a journal.

## Results

Median of 3 runs, range in brackets. Latency in ms. "server cores" = CPU of all nats-server processes; "client cores" = the CLI processes' CPU.

__TABLE__

## Against the floors (E-01, E-02)

__FLOORS__

## What this box cannot show

__CANNOT__

## Files

- [bench.py](bench.py): the driver (`run`, `smoke`, `table`). [run.sh](run.sh): `sh run.sh all` (three timing holds) or one hold (`core`, `always`, `default`).
- [msgs.json](msgs.json): messages per test.
- [fetch.sh](fetch.sh): nats-server, the nats CLI and the cited page, with checksums.
- [results/](results): `runs.jsonl` (one line per test run), `tables.md`, `raw/` (each run's output).

## Verdict

__VERDICT__
