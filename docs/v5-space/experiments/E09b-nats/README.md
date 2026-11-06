# E-09b: NATS 2.10 (core and JetStream) on this box, with the nats CLI

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09, NATS row (QUESTIONS.md §2, E-09b): what do NATS core and NATS JetStream reach here, with NATS's own tools, at matched guarantees and at their defaults? It sets the bar numbers of PERF-03 (core pub/sub, 1 → 1 and 1 → 16, 16 B and 1 KiB, msgs/s and p99 publish-to-receive) and PERF-04 (JetStream with 3 replicas and file storage: publish with acks, a pull consumer, a work queue; msgs/s and p99 ack latency), gives E-08 its NATS fan-out number, and says, against [E-02](../E02-pipeline/README.md)'s pipeline floors, whether a TS build can win these rows at all.

## The answer in short

All measured here, medians of 3 runs, each on freshly started servers. Ranges are in the tables below.

- **Core NATS (in memory, at most once), one server.** One publisher to one subscriber: **2.25 million 16 B msgs/s** and **694,000 1 KiB msgs/s** (0.7 GB/s). One publisher to 16 subscribers: **4.13 million deliveries/s at 16 B** (258,000 published/s) and **1.42 million at 1 KiB** (1.45 GB/s delivered). The server used 1.06, 0.75, 1.64 and 1.24 cores for these four, so it delivers about **2.5 million 16 B messages per server core-second** to 16 subscribers (1.1 million at 1 KiB). The CLI's publisher and subscribers used another 1.6-2.1 cores.
- **Core latency** (`nats latency`, publisher to subscriber through one server, 10,000 msgs/s): **p50 0.090 ms, p99 0.27 ms at 16 B; p50 0.092, p99 0.34 ms at 1 KiB.** Through two clustered servers (one route hop): p50 0.155, p99 0.51 ms.
- **JetStream, matched** (3 replicas, file storage, `sync_interval: always`): one synchronous publisher gets **1,228 acks/s at p50 0.79 ms, p99 1.31 ms**; 16 synchronous publishers 3,275/s (p99 9.2 ms); one asynchronous publisher **3,668 msgs/s at 100 B and 3,194/s at 1 KiB**. With `always`, the store fsyncs each message on its own, so the rate is about one fsync time per message (E-01: 0.19-0.29 ms at p50), whatever the batching; NATS's own docs say `always` forces "an fsync after each messsage" [sic] and slows throughput "to a few hundred msg/s" (cited). Reading back is not slowed: the pull consumer read 111,000 msgs/s, and 4 work-queue clients drained and acked 124,000/s (these two runs are short, 0.6-1.1 s, because only 50,000 messages were written).
- **JetStream at its default** (`sync_interval` 2 minutes: acked when a majority has the message in memory, which is fero's `memory` rung): one synchronous publisher **3,280 acks/s at p50 0.29 ms, p99 0.55 ms**; 16 publishers 22,200/s (p99 2.85 ms); one asynchronous publisher **98,200 msgs/s at 100 B, 68,200/s at 1 KiB**; pull consumer 121,000/s; work queue 95,700/s in, 111,000/s out with 4 clients. The three servers use 2.0-2.7 cores, about **23 µs of server CPU per message** at 98,000/s, so on this box JetStream's default is CPU-bound near 100,000 msgs/s. One single-publisher run was 30 % slower (p50 0.42 ms). Inferred from the servers' CPU (two servers busy instead of one): its stream leader was not the server the CLI connected to, so each publish took one more hop.
- **Against E-02.** Every JetStream throughput row is far below E-02's TS ceilings (matched 3,700/s against 2.8 M/s `persisted`; default 98,000/s against 2.75 M/s `memory`), so E-02 does not stop TS there. **Three rows are close or lost:**
  1. Core pub/sub 1 → 1 at 16 B (2.25 M/s) is only **1.9 ×** under TS's `none` ceiling (4.3 M/s), which has no sockets or parsing at all: the thinnest margin in E-09a, b and e.
  2. Fan-out: NATS delivers **2.5 M msgs per server core-second**, 25 × PERF-11's TS relay bar (100,000/s per core). E-08's own rule (relays go native if Node is more than 2 × below NATS's fan-out) means a Node relay must reach about 1.26 M deliveries/s per core to stay TS, reading the rule per core as E-08 measures relays (2.06 M/s if it means NATS's total).
  3. **JetStream's default single-publisher p99 (0.55 ms) is below C (0.73 ms)**, the floor of any `persisted` commit on this box, so fero's `persisted` rung cannot win that row by construction; only the `memory` rung can, and E-02's TS `memory` p99 at 50,000/s (0.57 ms) only ties it (Rust's 0.33 ms wins). The matched single-publisher p99 (1.31 ms) beats E-02's measured TS commit p99 (2.4-4.3 ms) and Rust's (1.58 ms at 50,000/s), as etcd's did.

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
- Cost: about 27 minutes of the box alone (about 7, 10 and 10 minutes for the three holds), plus a few minutes of untimed smoke runs; the entry estimated 3 agent-hours.
- Everything timed ran under `$SP/bin/timing`, in three holds (`core`, `always`, `default`): [run.sh](run.sh). Machine: E-01's ([env.txt](../E01-floors/results/env.txt)): 4-vCPU Firecracker VM, one virtio disk, ext4 without a journal.

## Results

Median of 3 runs, range in brackets. Latency in ms. "server cores" = CPU of all nats-server processes; "client cores" = the CLI processes' CPU.

Throughput rows. For core rows the "pub p50/p99" columns are the time of the publish call in the client (a buffered write, microseconds), not a delivery latency; the latency table below has the delivery latency. For JetStream `pub-sync` rows they are the ack latency of each publish; for `pub-async` rows they are per batch of 500. "other cores" on the core pub/sub rows reads slightly negative because the box's busy time includes the 1 s while subscribers connect and our own processes' time does not.

| setup : test | runs | msgs | publisher msgs/s | subscriber or consumer msgs/s (all clients) | pub p50 ms | pub p99 ms | pub p99.9 ms | server cores (all) | client cores | other cores | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| core:pubsub-1to1-16B | 3 | 40000000 | 2246998 (2224202-2259842) | 2246536 (2224342-2259864) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.009 (0.008-0.009) | 1.06 (1.06-1.07) | 1.60 (1.60-1.64) | -0.13 (-0.14--0.11) | 2.18, 2.67, 3.24 |
| core:pubsub-1to16-16B | 3 | 3000000 | 258372 (255000-259298) | 4126431 (4076210-4138383) | 0.000 (0.000-0.000) | 0.000 (0.000-0.000) | 0.006 (0.006-0.007) | 1.64 (1.61-1.70) | 1.80 (1.80-1.81) | -0.23 (-0.23--0.21) | 2.81, 3.38, 3.45 |
| core:pubsub-1to1-1KB | 3 | 8000000 | 693675 (670728-723607) | 691080 (669077-721436) | 0.000 (0.000-0.000) | 0.005 (0.005-0.005) | 0.080 (0.080-0.087) | 0.75 (0.74-0.77) | 1.91 (1.89-1.93) | -0.19 (-0.20--0.19) | 3.52, 3.85, 4.44 |
| core:pubsub-1to16-1KB | 3 | 600000 | 89742 (88360-92970) | 1418104 (1392060-1458802) | 0.000 (0.000-0.000) | 0.005 (0.005-0.006) | 0.046 (0.042-0.048) | 1.24 (1.20-1.25) | 2.11 (2.10-2.14) | -0.39 (-0.40--0.39) | 3.83, 4.25, 4.32 |
| js-always:pub-sync-1c-100B | 3 | 30000 | 1228 (1204-1436) | - | 0.791 (0.672-0.810) | 1.307 (1.175-1.324) | 2.755 (2.698-2.873) | 1.52 (1.49-1.53) | 0.16 (0.16-0.19) | 0.10 (0.09-0.13) | 2.63, 3.67, 4.37 |
| js-always:pub-sync-16c-100B | 3 | 40000 | 3275 (3056-3306) | - | 4.749 (4.661-5.037) | 9.160 (8.841-10.435) | 13.274 (12.336-14.322) | 1.89 (1.89-1.91) | 0.14 (0.14-0.15) | 0.32 (0.30-0.32) | 2.97, 3.60, 4.68 |
| js-always:pub-async-100B | 3 | 50000 | 3668 (3627-3843) | - | 133.787 (128.641-137.108) | 166.010 (149.166-173.177) | 178.038 (150.622-183.919) | 1.14 (0.91-1.20) | 0.28 (0.28-0.30) | 0.31 (0.30-0.32) | 4.03, 4.05, 5.20 |
| js-always:fetch-100B | 3 | 50000 | - | 111236 (105257-148371) | - | - | - | 1.28 (1.01-1.31) | 0.24 (0.22-0.27) | -0.02 (-0.03-0.03) | 4.09, 4.37, 5.09 |
| js-always:pub-async-1KB | 3 | 40000 | 3194 (3162-3221) | - | 154.921 (154.880-157.396) | 191.529 (178.258-192.780) | 191.529 (178.258-192.780) | 1.14 (0.97-1.17) | 0.25 (0.24-0.26) | 0.32 (0.31-0.37) | 4.09, 4.90, 4.69 |
| js-always:wq-pub-100B | 3 | 50000 | 3568 (3525-3704) | - | 137.461 (132.984-139.359) | 167.446 (165.541-177.691) | 182.106 (167.880-190.521) | 1.20 (0.98-1.21) | 0.29 (0.28-0.31) | 0.32 (0.31-0.34) | 4.30, 4.69, 4.51 |
| js-always:wq-fetch-4c-100B | 3 | 50000 | - | 124460 (107878-127476) | - | - | - | 1.71 (0.93-1.88) | 0.37 (0.26-0.50) | 0.10 (0.04-0.12) | 4.33, 4.75, 4.47 |
| js-default:pub-sync-1c-100B | 3 | 80000 | 3280 (2287-3342) | - | 0.295 (0.289-0.423) | 0.550 (0.536-0.783) | 1.260 (1.155-2.030) | 2.04 (1.91-2.04) | 0.31 (0.25-0.31) | 0.05 (0.03-0.05) | 2.59, 6.12, 5.48 |
| js-default:pub-sync-16c-100B | 3 | 300000 | 22173 (20241-22541) | - | 0.625 (0.611-0.704) | 2.850 (2.483-3.047) | 5.599 (5.558-5.824) | 2.33 (2.32-2.36) | 0.58 (0.53-0.60) | 0.04 (0.04-0.08) | 3.17, 5.38, 5.17 |
| js-default:pub-async-100B | 3 | 1200000 | 98159 (94043-126029) | - | 4.691 (3.472-4.731) | 12.772 (10.130-13.538) | 25.068 (23.487-26.059) | 2.26 (2.24-2.30) | 0.36 (0.35-0.44) | 0.02 (0.01-0.02) | 4.92, 6.54, 6.61 |
| js-default:fetch-100B | 3 | 1200000 | - | 121465 (119080-122348) | - | - | - | 2.53 (2.47-2.54) | 0.38 (0.37-0.39) | 0.02 (0.01-0.02) | 4.77, 6.10, 6.58 |
| js-default:pub-async-1KB | 3 | 600000 | 68167 (58797-68303) | - | 6.836 (6.779-7.814) | 16.192 (15.974-21.495) | 22.481 (21.182-31.450) | 2.48 (2.47-2.53) | 0.28 (0.24-0.28) | 0.03 (0.02-0.03) | 5.10, 5.70, 6.49 |
| js-default:wq-pub-100B | 3 | 1200000 | 95674 (93255-119459) | - | 4.702 (3.571-4.709) | 11.854 (10.963-14.727) | 23.996 (23.583-29.539) | 2.40 (2.39-2.41) | 0.37 (0.36-0.44) | 0.01 (0.00-0.04) | 5.17, 5.58, 6.57 |
| js-default:wq-fetch-4c-100B | 3 | 1200000 | - | 111076 (108645-112388) | - | - | - | 2.66 (2.66-2.72) | 0.36 (0.35-0.36) | 0.02 (0.01-0.04) | 5.96, 5.71, 6.40 |

| setup : test | runs | msgs/s | p50 ms | p90 ms | p99 ms | p99.9 ms | max ms | server cores | client cores | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|---|
| core:latency-16B | 3 | 10001 (9998-10002) | 0.090 (0.090-0.091) | 0.146 (0.145-0.150) | 0.273 (0.270-0.297) | 0.785 (0.662-0.789) | 7.26 (6.62-13.39) | 0.50 (0.49-0.50) | 0.62 (0.61-0.62) | 4.25, 4.55, 4.21 |
| core:latency-1KB | 3 | 10000 (9999-10002) | 0.092 (0.090-0.095) | 0.154 (0.148-0.170) | 0.342 (0.312-0.414) | 1.109 (0.808-1.407) | 9.80 (7.50-19.15) | 0.49 (0.48-0.50) | 0.63 (0.61-0.64) | 3.89, 4.23, 3.24 |
| core-route:latency-route-16B | 3 | 10000 (9999-10001) | 0.155 (0.150-0.155) | 0.239 (0.233-0.244) | 0.509 (0.482-0.558) | 2.073 (1.340-2.412) | 5.44 (5.37-8.34) | 0.87 (0.85-0.88) | 0.55 (0.55-0.56) | 2.84, 2.25, 2.27 |

## Against the floors (E-01, E-02)

QUESTIONS.md's threshold, per row: if the competitor's matched median is better than E-02's TS floor, TS cannot win that row and the native build must come first; better than the Rust floor too, and the gap goes into the verdict. A default row won only by a `memory` or `none` rung means that rung is priced as a mechanism (DEV-01). E-02's pipeline makes its own writes (no sockets, no protocol), so a floor far above NATS means only that E-02 does not rule a win out; E-45's NATS-protocol gateway and E-08's relay decide.

**PERF-03, core NATS, against fero's `none` rung** (P-06 requires it; `persisted` reported beside):

| Row | NATS here (median) | Floor (measured) | Reading |
|---|---|---|---|
| 1 → 1, 16 B | 2,247,000 msgs/s; server 1.06 cores (0.47 µs per message in and out) | E-02 `none` ceiling (100 B, in process, no network): TS 4.29 M/s at 0.19 µs per append, Rust 18.6 M/s | **floor only 1.9 × above (TS)**: not stopped, but the thinnest margin; a TS path must read, parse and forward a message in under about 0.5 µs of one core to match NATS per core (reasoned) |
| 1 → 1, 1 KiB | 694,000 msgs/s; server 0.75 cores | E-02 has no 1 KiB `none` row; its TS leader spent about 2 µs per 1 KiB append on the `persisted` path (fit), against NATS's 1.1 µs per message | not decided by E-02; E-45 |
| 1 → 16, 16 B | 4,126,000 deliveries/s (258,000 published/s); server 1.64 cores: **2.5 M deliveries per server core-second** | PERF-11: a relay core ≥ 100,000 deliveries/s (TS), ≥ 3 M/s (native) | NATS per core is **25 × PERF-11's TS bar** and near the native bar. **E-08's rule** (Node more than 2 × below NATS → relays native from phase 3) needs a Node relay of about 1.26 M deliveries/s per core |
| 1 → 16, 1 KiB | 1,418,000 deliveries/s; server 1.24 cores (1.1 M per core) | same | same reading at 1 KiB: half of NATS per core is about 0.57 M/s |
| latency 16 B / 1 KiB, 10,000 msgs/s | p50 0.090 / 0.092 ms, p99 0.27 / 0.34 ms | E-01 loopback round trip p50 31-40 µs, p99 58-96 µs; E-02 TS `none` commit at 50,000/s p50 0.03, p99 0.08 ms (in process) | not decided by E-02 (it has no delivery hop). `persisted` (p99 ≥ C = 0.73 ms) loses this row by design, as P-06 says |
| latency through two servers, 16 B | p50 0.155, p99 0.51 ms | one more loopback hop | the price of a route hop here: about 0.065 ms at p50 |

**PERF-04, JetStream, matched** (`sync_interval: always`, 3 replicas, file storage; against fero's `persisted`):

| Row | NATS here (median) | Floor (measured) | Reading |
|---|---|---|---|
| publish with ack, 1 client | 1,228/s; p50 0.79, p99 1.31 ms | C = 0.73 ms; E-02 commit p99 on the real disk: TS 2.73 ms at 10,000/s and 4.33 ms at 50,000/s, Rust 1.58 ms at 50,000/s (21.8 ms at 10,000/s, set by disk stalls); with emulated independent disks at 50,000/s TS 2.40, Rust 0.67 | **NATS's p99 beats every real-disk p99 E-02 measured, TS and Rust.** E-02 has no one-in-flight run, so this does not prove TS or Rust cannot win; it says the tail at low load decides this row. Gap to carry: 0.27 ms against Rust's real-disk p99, 1.1-3.0 ms against TS's |
| publish with ack, 16 clients | 3,275/s; p99 9.2 ms | as above | NATS fsyncs each message alone, so 16 clients wait in line; group commit (DEP-12) wins this by design (reasoned) |
| async publish, 100 B / 1 KiB | 3,668 / 3,194 msgs/s | `persisted` ceiling TS 2.79 M/s (100 B), 284 k/s (1 KiB); Rust 2.21 M, 349 k | floor about 90-760 × above: not stopped |
| pull consumer (fetch) | 111,000 msgs/s (short runs) | — | reads; E-45 |
| work queue: in, then 4 clients out with acks | 3,568 / 124,000 msgs/s (out: short runs) | as async publish | not stopped |

**PERF-04, JetStream at its default** (`sync_interval` 2 minutes = in memory at a majority; against fero's `memory` rung, Q `maj-m`):

| Row | NATS here (median) | Floor (measured) | Reading |
|---|---|---|---|
| publish with ack, 1 client | 3,280/s; **p50 0.29, p99 0.55 ms** | `persisted`: C = 0.73 ms (p99 floor of any persisted commit here). `memory` rung at 50,000/s: TS p50 0.24, p99 0.57 ms; Rust 0.16, 0.33 ms | **`persisted` cannot win this row on this box (0.55 < 0.73 ms), by measurement of both.** TS `memory` only ties at p99 (0.57 against 0.55); Rust `memory` wins (0.33). So winning JetStream's default needs the `memory` rung, and in TS it is not yet a win |
| publish with ack, 16 clients | 22,200/s; p99 2.85 ms | as above | not stopped |
| async publish, 100 B / 1 KiB | 98,200 / 68,200 msgs/s; 23 µs of server CPU per message | `memory` ceiling TS 2.75 M/s, Rust 4.96 M/s (100 B) | floor 28-50 × above: not stopped |
| pull consumer; work queue in / out | 121,000; 95,700 / 111,000 msgs/s | — | E-45 |

**Rungs.** PERF-03 is defined against the `none` rung (P-06 already requires it, and every candidate counts it). PERF-04's default rows are won only by the `memory` rung (Q `maj-m`): the single-publisher p99 at NATS's default (0.55 ms) is below this box's `persisted` floor C (0.73 ms). So by the threshold **the `memory` rung is priced as a mechanism (DEV-01) in every candidate that claims PERF-04's default rows**, or the user accepts their loss by name. E-09a reached the same conclusion for Redis's default rows, from E-02's tails.

**Rows above the Rust floor:** JetStream's matched single-publisher p99 (1.31 ms) is below E-02 Rust's real-disk p99 at 50,000/s (1.58 ms). That gap (0.27 ms) goes into the verdict as PERF-01 asks, with the caveat that E-02 never ran one write in flight.

## What this box cannot show

- **Separate machines for servers and clients.** The three servers, the publisher and up to 16 subscribers share 4 vCPUs. Core NATS fan-out (1 → 16) is limited here by the subscribers' and the server's share of those cores, not by NATS alone; NATS's own published numbers come from bigger machines and are not cited as results.
- **Independent disks.** The three JetStream servers fsync (with `sync_interval: always`) on the one virtual disk (E-01), so each message's three fsyncs queue behind each other's.
- **Real round trips.** Loopback only; between machines every replicated ack also pays a network round trip.
- **What the default `sync_interval` risks.** With the 2-minute default, an acked message can be lost if a majority of servers lose power within that window; this experiment measures speed, not that loss.
- **Newer servers.** 2.10.22 is the version this study names; 2.11 and 2.12 add batch publishing and other changes (the CLI 0.5.1 lists `js pub atomic` and `js pub fast`, not used here).

## Files

- [bench.py](bench.py): the driver (`run`, `smoke`, `table`). [run.sh](run.sh): `sh run.sh all` (three timing holds) or one hold (`core`, `always`, `default`).
- [msgs.json](msgs.json): messages per test.
- [fetch.sh](fetch.sh): nats-server, the nats CLI and the cited page, with checksums.
- [results/](results): `runs.jsonl` (one line per test run), `tables.md`, `timing-log.txt` (each run's one-line result as it finished, and when each timing hold began and ended), `raw/` (each run's output).

## Verdict

Core NATS on this box moves 2.25 million small messages a second from one publisher to one subscriber and delivers 4.13 million a second to 16 subscribers, at about 2.5 million deliveries per server core-second, with a publish-to-receive p99 of 0.27 ms. That makes PERF-03 the hardest competitor bar for a TS build: E-02's TS `none` ceiling, with no sockets at all, is only 1.9 × above NATS's 1 → 1 rate, and PERF-11's TS relay bar (100,000 deliveries/s per core) is 25 × below what NATS does per core, so by E-08's own rule a Node relay must reach about 1.26 million deliveries/s per core or relays go native. JetStream is the opposite: with fsync before every ack it does only 1,200-3,700 msgs/s here (it fsyncs each message alone), so fero's group commit beats it by design on throughput; at its default it does about 98,000 msgs/s, CPU-bound at 23 µs of server CPU per message. Its single-publisher ack latency is the risk row: 1.31 ms p99 matched (better than every real-disk p99 in E-02) and 0.55 ms p99 at its default, which is below C, so only a `memory` rung can win JetStream's default rows.

Q-09 (NATS): NATS 2.10.22 here does core pub/sub 2.25 M msgs/s (16 B, 1 → 1), 694 k/s (1 KiB), 4.13 M deliveries/s to 16 subscribers (2.5 M per server core), publish-to-receive p50 0.09 / p99 0.27 ms; JetStream with 3 file replicas and fsync always 1,228 acks/s at 1 client (p99 1.31 ms) and 3,700 msgs/s async (one fsync per message), and at its default (memory at a majority) 3,280 acks/s (p99 0.55 ms) and 98,000 msgs/s async (CPU-bound, 23 µs per message); E-02 does not stop TS on any JetStream throughput row, but core pub/sub sits only 1.9 × under TS's socket-free `none` ceiling, NATS's fan-out per core is 25 × PERF-11's TS bar, and JetStream's single-publisher p99 beats E-02's real-disk TS and Rust tails (matched) and C itself (default). Moves: MIN-TS down on PERF-03 and PERF-11 (fan-out and core pub/sub need native speed; relays native unless E-08's Node relay reaches about 1.26 M deliveries/s per core), RUST, SRV, SIDE and EMB-V8 up on PERF-03 and PERF-11; candidates with only Q `maj-d` (MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) and OBJ down on PERF-04's default rows unless they add Q `maj-m` (+1 on DEV-01) or the user accepts the loss by name; every candidate up on PERF-04's matched throughput rows (group commit against one fsync per message), and open on PERF-04's single-publisher p99 (needs the tail of E-02's emulated-disk Rust run, 0.67 ms, not its real-disk TS run).
