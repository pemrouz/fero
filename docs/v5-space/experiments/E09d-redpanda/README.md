# E-09d: Redpanda 26.2 (three nodes) on this box, with Kafka's own tools

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09, Redpanda row (QUESTIONS.md §2, E-09d): what does Redpanda reach here, driven by the same Kafka tools as [E-09c](../E09c-kafka/README.md), at the same workload? It sets the bar numbers of PERF-06: PERF-05's workload (1 KiB records, 16 partitions, replication 3, `acks=all`); the metrics are the **most MB/s** and the **p99 end-to-end latency at half of that rate**. Redpanda fsyncs before it answers `acks=all`, so its default is the `persisted` comparison. The entry said: if Redpanda will not run here, say why and cite its published numbers. **It runs here**, so every number below is measured, except the context marked cited.

## The answer in short

All measured here, medians of 3 runs, each on a freshly started cluster. Ranges are in the tables below. MB/s is MiB/s, as Kafka's tools print it.

- **Redpanda runs on this box,** three nodes with one core and 2 GB each, so PERF-06 is measured, not cited. It has **no share groups** (every share-group API answers UNSUPPORTED), so it gives no work-queue bar.
- **Matched (its default: on disk at a majority before `acks=all` is answered).** With OMB's throughput settings it takes **175,420 records/s = 171 MiB/s**; with the producer's own defaults 65,488/s. That is **2.0 × Kafka's matched rate** (86,344/s with `flush.messages=1`, E-09c) and 0.73 × Kafka's no-fsync default (240,043/s). It does it on about **1 core for all three nodes: 5.8 µs of broker CPU per record**, plus about 0.2 cores of kernel work for its direct disk I/O. Kafka used 1.7-1.8 cores for fewer records.
- **Latency under load, matched:** at half of its max (87,710/s) the end-to-end p50 is 6 ms and the **p99 43 ms** (25-85 ms); at 50,000/s, p50 4 ms and p99 19 ms. Kafka at its half: p99 869 ms matched and 638 ms at its default.
- **One record in flight, matched: ack p50 0.70 ms, p99 1.65 ms**, with a majority fsync behind every ack. Its p50 is about C (0.73 ms), and its p99 equals Kafka's *no-fsync* default (1.64 ms). Through `kafka-e2e-latency` (ack, then consume): p50 1 ms, p99 5 ms.
- **With write caching** (`wcache`: answered at a majority in memory, like Kafka's default): 187,199 records/s (183 MiB/s), only 7 % above `fsync` at OMB's 1 MiB batches (but 56 % above it with 16 KiB batches: 102,249 against 65,488/s); p99 16 ms at half (93,599/s), 8 ms at 50,000/s; one record in flight **ack p50 0.24 ms, p99 0.79 ms**.
- **Against E-02** (the TS, Rust and Go pipeline floors at 1 KiB on this disk): Redpanda's matched max is only **1.62 × under the TS ceiling** (283,881/s) and 1.99 × under Rust's (348,928/s): the thinnest matched margin in E-09 (Kafka 3.3 ×, etcd 40-120 ×, Redis 5-60 ×). Its CPU per record, with the whole Kafka protocol, is about the same as the TS pipeline's with no protocol at all (5.8 µs in the brokers plus about 1.1 µs in the kernel, against 6.6 µs). Its single-record p99 (1.65 ms) beats E-02's measured real-disk commit tails at 1 KiB (TS 3.8-4.3 ms, Rust 3.4 ms). Only its p99 at half is beaten clearly: TS's pipeline p99 is 19 ms at 141,941/s, against Redpanda's 43 ms at 87,710/s.

## Method

- **Redpanda 26.2.6** (commit `06e1aca3`) and **rpk 26.2.6**, the official `.deb` packages from Redpanda's public release bucket, unpacked with `dpkg -x`, not installed ([fetch.sh](fetch.sh); the apt route needs an active token, [TOOLS.md](../TOOLS.md)). `/opt/redpanda` links to the unpacked tree, because the broker's loader path is fixed there. No Docker and no `crane` were needed.
- **Three nodes**, each started as QUESTIONS.md says: `redpanda --redpanda-cfg <yaml> --smp 1 --memory 2G --overprovisioned` (one shard, so one core per node; 2 GB of memory each; `--overprovisioned` turns off thread pinning and busy polling, which a shared 4 vCPU box needs). `developer_mode: true` in each node's yaml (it skips the production checks of the host; it does not turn off fsync: see below), and `--unsafe-bypass-fsync=false` given explicitly. Cluster defaults at first start: `default_topic_replications: 3`, no auto-created topics. The driver is E-09c's [kbench.py](../E09c-kafka/kbench.py): the same code starts the cluster, makes the topics, runs the same tests with the same counts of warm-up and the same parsing, so Kafka's and Redpanda's rows are measured the same way. Results land in this folder.
- **Topics:** 16 partitions, replication 3, every producer `acks=all`. Redpanda has no `min.insync.replicas`: each partition is a Raft group, and `acks=all` is answered when a **majority (2 of 3)** has the batch. Kafka waits for every in-sync replica instead.
- **Two setups:**
  - `fsync`: Redpanda as shipped. With write caching off (the default), an `acks=all` write is answered after a majority has **fsynced** it. The broker's own description of `write_caching_default` says write caching "acknowledges a message as soon as it is received and acknowledged on a majority of brokers, without waiting for it to be written to disk" ([results/binary-docs.txt](results/binary-docs.txt), read from the 26.2.6 binary; docs.redpanda.com was not reachable from this session), and the fsync counters below show the fsyncs happen. This is Redpanda's default **and** the matched row (fero's `persisted`).
  - `wcache`: the cluster default `write_caching_default: true` (the topic-level `write.caching` cannot be set through Kafka's `kafka-topics.sh`, which checks names against Kafka's own list). Answered when a majority has the batch in memory; flushed after `flush.ms` (100 ms) or `flush.bytes` (256 KiB), whichever comes first. This lines up with Kafka's default and fero's `memory` rung.
  - [results/apicheck.txt](results/apicheck.txt) shows each setting as the topic sees it (`write.caching false` / `true`, `flush.ms 100`, `flush.bytes 262144`). [results/fsynccheck.txt](results/fsynccheck.txt) proves the difference (not a timing run): at 2,000 records/s, server 1's segment appender flushed **2,396 times in 8 s with `fsync`** and **123 times with `wcache`**; the host's disk saw 5,599 and 356 flushes (all three nodes). Redpanda issues its flushes through Linux AIO (`io_submit`), not `fsync()` system calls, so strace counts `io_submit`; the segment-appender counter is, in the binary's words, the "Number of disk fsync calls from segment appenders".
- **Tests:** exactly E-09c's (see [its method](../E09c-kafka/README.md#method)): `max-default` (producer defaults: 16 KiB batches, `linger.ms` 5), `consume`, `share-4c`, `max-omb` (OMB's throughput settings: `linger.ms=1`, `batch.size` 1 MiB), then on a fresh cluster `half` (half of `max-omb`'s median, OMB's latency settings, with an OMB-style end-to-end consumer), `rate50k` (OMB's standard 50,000/s), `e2e1` (`kafka-e2e-latency`, whole ms) and `ack1` (AckProbe: one record in flight, µs). Records per test: [../E09c-kafka/counts.json](../E09c-kafka/counts.json) (`redpanda` entries: 600,000 for `max-default` at `fsync`, 900,000 at `wcache`; 2,000,000 / 2,500,000 for `max-omb`; 10,000 / 12,000 for `e2e1`; 20,000 for `ack1`).
- **Share groups:** Redpanda 26.2.6 answers every share-group API (ShareGroupHeartbeat, ShareFetch, ShareAcknowledge, and the rest) as **UNSUPPORTED** ([results/apicheck.txt](results/apicheck.txt)), so `share-4c` has nothing to run. Redpanda has no Kafka queues here.
- **CPU, runs, load:** as E-09c: each node's CPU from `/proc`, the tool's from rusage; 3 runs per phase, each on a fresh cluster; every hold under `$SP/bin/timing`; the load before each test is in the tables.
- **Machine:** 4 vCPU Firecracker VM, 15 GB RAM, one virtio disk with ext4 without a journal ([E-01 env](../E01-floors/results/env.txt)). Kafka 4.4.0's tools on OpenJDK 21.0.12.1 drive it.
- **Resumed after a container restart (2026-11-07).** The checks and the calibration had finished on 2026-11-06 / 07 before the restart; both timing holds ran after it ([results/timing-log.txt](results/timing-log.txt)).

## Results

Medians of 3 runs, range in brackets. MB/s is MiB/s, as Kafka's tools print it. Every column of every run: [results/tables.md](results/tables.md); raw tool output: [results/raw/](results/raw); one JSON line per run: [results/runs.jsonl](results/runs.jsonl).

<!-- tables:start (generated by ../E09c-kafka/tools/readme_tables.py) -->
**Most throughput** (PERF-05/06 "max MB/s"): the producer at full speed, steady state after the warm-up records.

| system and setup | settings | records/s | MB/s | producer p50 ms | producer p99 ms | broker cores | client cores | other cores | broker µs CPU per record |
|---|---|---|---|---|---|---|---|---|---|
| Kafka `default` (no fsync) | OMB's (1 MiB batches, linger 1 ms) | 240,043 (238,014-257,107) | 234.4 (232.4-251.1) | 98 (95-99) | 396 (312-616) | 1.74 (1.72-1.78) | 1.35 (1.34-1.38) | 0.08 (0.08-0.11) | 7.3 (6.7-7.4) |
| Kafka `default` (no fsync) | producer defaults (16 KiB, linger 5 ms) | 65,807 (65,462-66,946) | 64.3 (63.9-65.4) | 425 (408-425) | 931 (825-1,033) | 2.74 (2.71-2.77) | 0.81 (0.80-0.81) | 0.05 (0.05-0.05) | 41.2 (40.9-42.3) |
| Kafka `flush1` (fsync, matched) | OMB's (1 MiB batches, linger 1 ms) | 86,344 (82,552-89,337) | 84.3 (80.6-87.2) | 314 (313-314) | 930 (927-1,154) | 1.82 (1.78-1.87) | 0.77 (0.74-0.79) | 0.11 (0.11-0.13) | 20.9 (20.6-22.0) |
| Kafka `flush1` (fsync, matched) | producer defaults (16 KiB, linger 5 ms) | 8,798 (8,649-9,511) | 8.6 (8.4-9.3) | 2,843 (2,621-2,870) | 4,520 (3,723-4,766) | 1.73 (1.66-1.73) | 0.41 (0.41-0.42) | 0.26 (0.26-0.31) | 191.9 (181.9-196.6) |
| Redpanda `fsync` (its default, matched) | OMB's (1 MiB batches, linger 1 ms) | 175,420 (167,842-179,986) | 171.3 (163.9-175.8) | 134 (129-152) | 419 (361-513) | 0.98 (0.96-1.07) | 1.25 (1.19-1.27) | 0.20 (0.20-0.80) | 5.8 (5.5-5.9) |
| Redpanda `fsync` (its default, matched) | producer defaults (16 KiB, linger 5 ms) | 65,488 (62,727-67,824) | 64.0 (61.3-66.2) | 434 (416-442) | 567 (528-611) | 1.09 (1.08-1.11) | 1.20 (1.17-1.26) | 0.46 (0.41-0.66) | 16.5 (16.4-17.4) |
| Redpanda `wcache` (write caching) | OMB's (1 MiB batches, linger 1 ms) | 187,199 (187,064-188,657) | 182.8 (182.7-184.2) | 116 (103-116) | 531 (507-534) | 1.10 (1.09-1.12) | 1.34 (1.33-1.34) | 0.19 (0.19-0.19) | 5.8 (5.8-6.0) |
| Redpanda `wcache` (write caching) | producer defaults (16 KiB, linger 5 ms) | 102,249 (97,937-105,872) | 99.8 (95.6-103.4) | 285 (264-287) | 420 (414-518) | 1.22 (1.18-1.24) | 1.38 (1.32-1.41) | 0.23 (0.21-0.25) | 11.9 (11.7-12.0) |

**End-to-end latency under load** (PERF-05/06 "p99 at half of the max rate"): OMB's latency settings (128 KiB batches, linger 1 ms); e2e = consumer receive time minus the producer's CreateTime, 1 ms resolution.

| system and setup | offered records/s | achieved records/s | e2e p50 ms | e2e p99 ms | e2e p99.9 ms | e2e max ms | producer p99 ms | broker cores | other cores |
|---|---|---|---|---|---|---|---|---|---|
| Kafka `default` (no fsync) | 120,021 (120,021-120,021) (half) | 125,135 (124,883-130,344) | 63 (60-86) | 638 (498-694) | 862 (754-1,125) | 884 (788-1,193) | 631 (493-649) | 2.28 (2.24-2.29) | -0.02 (-0.03--0.01) |
| Kafka `default` (no fsync) | 50,000 (50,000-50,000) | 49,960 (49,940-49,960) | 2 (2-2) | 15 (14-84) | 350 (343-391) | 412 (374-499) | 15 (13-82) | 1.18 (1.17-1.19) | -0.01 (-0.02--0.00) |
| Kafka `flush1` (fsync, matched) | 43,171 (43,171-43,171) (half) | 44,644 (44,273-44,862) | 75 (68-100) | 869 (846-1,014) | 1,016 (969-1,243) | 1,209 (1,055-1,379) | 860 (834-952) | 1.89 (1.86-1.93) | 0.14 (0.13-0.16) |
| Kafka `flush1` (fsync, matched) | 50,000 (50,000-50,000) | 49,771 (49,384-56,621) | 51 (50-432) | 614 (327-725) | 760 (485-791) | 813 (579-831) | 604 (325-721) | 1.38 (1.30-1.49) | 0.17 (0.16-0.18) |
| Redpanda `fsync` (its default, matched) | 87,710 (87,710-87,710) (half) | 87,581 (87,482-87,611) | 6 (6-13) | 43 (25-85) | 82 (47-119) | 112 (64-159) | 43 (25-86) | 1.16 (1.04-1.17) | 0.21 (0.21-1.11) |
| Redpanda `fsync` (its default, matched) | 50,000 (50,000-50,000) | 49,952 (49,943-49,958) | 4 (3-4) | 19 (17-23) | 107 (61-127) | 175 (168-500) | 18 (16-21) | 0.97 (0.93-0.99) | 0.19 (0.19-0.23) |
| Redpanda `wcache` (write caching) | 93,599 (93,599-93,599) (half) | 93,479 (93,452-93,497) | 3 (2-3) | 16 (16-19) | 34 (30-44) | 49 (46-72) | 16 (15-19) | 1.15 (1.12-1.16) | 0.13 (0.13-0.14) |
| Redpanda `wcache` (write caching) | 50,000 (50,000-50,000) | 49,960 (49,958-49,963) | 2 (2-2) | 8 (8-8) | 45 (31-157) | 165 (110-303) | 7 (6-7) | 0.85 (0.84-0.85) | 0.10 (0.10-0.11) |

**One record at a time.** `ack1`: AckProbe, one record in flight, send to ack, µs timer (shown in ms). `e2e1`: `kafka-e2e-latency`, send, ack and consume one record, whole ms rounded down.

| system and setup | ack1 acks/s | ack1 p50 ms | ack1 p90 ms | ack1 p99 ms | ack1 p99.9 ms | e2e1 p50 ms | e2e1 p99 ms | e2e1 p99.9 ms | e2e1 avg ms |
|---|---|---|---|---|---|---|---|---|---|
| Kafka `default` (no fsync) | 1,491 (1,433-1,509) | 0.606 (0.605-0.629) | 0.871 (0.858-0.919) | 1.636 (1.399-1.657) | 5.01 (4.72-5.97) | 1 (1-1) | 4 (4-4) | 8 (8-9) | 1.19 (1.19-1.22) |
| Kafka `flush1` (fsync, matched) | 376 (371-381) | 2.529 (2.499-2.567) | 3.320 (3.312-3.384) | 5.342 (5.212-5.546) | 10.42 (10.25-10.93) | 3 (3-3) | 8 (8-9) | 18 (15-18) | 3.71 (3.55-3.78) |
| Redpanda `fsync` (its default, matched) | 1,320 (1,252-1,320) | 0.704 (0.696-0.735) | 1.064 (1.053-1.113) | 1.646 (1.622-1.742) | 4.46 (4.04-4.89) | 1 (1-1) | 5 (4-5) | 9 (8-10) | 1.51 (1.50-1.51) |
| Redpanda `wcache` (write caching) | 3,562 (3,352-3,694) | 0.236 (0.218-0.243) | 0.431 (0.427-0.476) | 0.788 (0.741-0.861) | 2.04 (1.76-3.00) | 0 (0-0) | 3 (3-3) | 6 (6-7) | 0.80 (0.80-0.89) |

**Consumers.** `consume`: one classic consumer reads back `max-default`'s records (whole run includes about 1 s of group join; "fetch" leaves it out). `share-4c`: 4 consumers in one share group (Kafka's queues) read the same records.

| system and setup | records | consume records/s (whole run) | consume fetch records/s | share-4c records/s (4 consumers) | share-4c broker cores |
|---|---|---|---|---|---|
| Kafka `default` (no fsync) | 900,000 (900,000-900,000) | 314,685 (309,598-352,803) | 522,042 (477,200-554,871) | 78,534 (72,400-80,200) | 1.43 (1.34-1.51) |
| Kafka `flush1` (fsync, matched) | 220,000 (220,000-220,000) | 124,364 (104,265-132,450) | 293,725 (287,582-324,006) | 26,484 (25,671-26,535) | 1.02 (0.96-1.05) |
| Redpanda `fsync` (its default, matched) | 600,000 (600,000-600,000) | 126,342 (89,113-127,660) | 552,486 (513,699-571,973) | not supported (UNSUPPORTED on every share-group API) | - |
| Redpanda `wcache` (write caching) | 900,000 (900,000-900,000) | 177,480 (171,559-178,183) | 631,136 (609,343-632,022) | not supported (UNSUPPORTED on every share-group API) | - |

<!-- tables:end -->

## Against Kafka and the floors (E-01, E-02, E-09c)

E-02's floors at 1 KiB on the real disk, `persisted` (on disk at 2 of 3 before the commit), 1 group: TS 283,881 appends/s (277 MiB/s), Rust 348,928/s (341 MiB/s), Go 351,458/s (343 MiB/s); p99 at each build's own half rate: TS 19.45 ms (141,941/s), Rust 107 ms, Go 105 ms; p99 at 50,000/s: TS 4.34 ms, Rust 3.37 ms, Go 3.18 ms; CPU per append (leader + two followers) at TS's max: 3.07 + 1.75 + 1.76 = 6.6 µs. E-02's pipeline has no client, no protocol and no consumer: it is a ceiling that a real kernel with a Kafka gateway can only approach.

| PERF-06 row (Redpanda's default = matched) | Redpanda | E-02 TS floor | E-02 Rust floor | reading |
|---|---|---|---|---|
| max MB/s (OMB settings) | 171 MiB/s (175,420/s) | 277 MiB/s: **1.62 ×** above | 341 MiB/s: **1.99 ×** above | TS is not stopped by the threshold (the competitor is below the TS floor), but the margin is the thinnest of any matched row in E-09; the gateway's protocol work and the consumer must fit inside it |
| p99 end-to-end at half of max | 43 ms (25-85) at 87,710/s | 19.45 ms (17.9-109) at 141,941/s | 107 ms at 174,464/s | E-02's TS floor is better at a higher rate (by less than the larger spread if the 109 ms run counts, so a measured fero run must confirm) |
| broker CPU per record at max | 5.8 µs (3 nodes, with protocol) + about 1.1 µs kernel I/O | 6.6 µs (3 processes, no protocol) | 4.8 µs (1.96 + 1.41 + 1.44 at its max, no protocol) | no CPU margin for TS: on 4 vCPU shared with the load tool, CPU is the next limit after the disk |
| one record in flight, ack p99 | 1.65 ms (p50 0.70) | 3.8-4.3 ms at 10,000-50,000/s (not one in flight) | 3.4 ms at 50,000/s | Redpanda's tail wins against both measured real-disk tails; the same finding as etcd (E-09e) and JetStream (E-09b) |

**Write caching (`wcache`)** lines up with fero's `memory` rung. E-02 measured `memory` only at 100 B (TS 2.75 M/s, p99 0.57 ms at 50,000/s; Rust 0.33 ms), so the 1 KiB `memory` ceiling is a gap. Redpanda `wcache` gives 183 MiB/s at max, p99 16 ms at half and a single-record ack p99 of 0.79 ms: a `memory` rung that matches E-02's 100 B tail would win the single-record row; the max row needs the 1 KiB `memory` run.

**Against Kafka (E-09c), same tools, same box, same driver.** Redpanda with fsync beats Kafka with fsync on every row: 2.0 × the throughput at max, a p99 at half that is 20 × lower, and a single-record ack p99 of 1.65 ms against Kafka `flush1`'s 5.34 ms. It roughly ties Kafka's no-fsync default on single-record latency and reaches 73 % of its max throughput. Two cautions. Kafka's own docs advise against `flush.messages` ("In general we recommend you not set this and use replication for durability", [../E09c-kafka/results/cited/kafka-docs-flush.txt](../E09c-kafka/results/cited/kafka-docs-flush.txt), cited from the 4.4.0 release), so Kafka's matched row is a setting Kafka itself would not run. And the published dispute between Redpanda's own benchmark ([2022](https://redpanda.com/blog/redpanda-vs-kafka-performance-benchmark), cited) and an independent re-run ([Jack Vanlightly, 2023](https://jack-vanlightly.com/blog/2023/5/15/kafka-vs-redpanda-performance-do-the-claims-add-up), cited, which reports the gap shrinking or reversing with more producers, keyed records and long runs) is not settled here: this box runs one producer, unkeyed records and runs of under a minute, on one core per node.

**Outside CPU.** Two `fsync` runs saw about 0.6-0.9 cores of CPU busy outside the brokers and tools ("other" 0.80 in `max-omb` run 3 and 1.11 in `half` run 1, against about 0.2 in the other runs), from a process that did not take the timing lock (also seen in E-09c). Those two runs are the low end of `max-omb`'s range and the high end of `half`'s p99 range (85 ms); the medians are clean runs. The steady 0.2 cores of "other" in every `fsync` run is Redpanda's own disk I/O finishing in the kernel (softirq 0.17 cores in a 5 s sample during a run).

## What this box cannot show

- **Thread-per-core at its intended size.** Redpanda is built to own whole machines: one shard pinned per core, busy polling, its own memory. Here each node gets one shard, 2 GB and no pinning (`--overprovisioned`), and the three nodes share 4 vCPU with the load tool. QUESTIONS §9 names this gap. Its published numbers (on large machines) are far higher; they are context only (PERF-01).
- **Three disks.** The three nodes' fsyncs queue on one disk (E-01: three writers cost 1.4 × one at p99). Redpanda's matched rows are pessimistic in absolute terms, as Kafka's and fero's are.
- **Real networks.** Loopback round trips are 58 µs at p99; a real network adds a hop to every ack.
- **Long runs.** Each run lasts at most about 60 s; the page cache absorbs much of what `wcache` writes.
- **Millisecond tools.** Kafka's tools print whole milliseconds; AckProbe gives µs for the single-record ack.

## Files

- [run.sh](run.sh): every step (`sh run.sh all`; it uses E-09c's driver). [fetch.sh](fetch.sh): Redpanda 26.2.6 and rpk, with first-seen sha256 (the bucket publishes none), then E-09c's fetch for Kafka's tools.
- [results/fsynccheck.txt](results/fsynccheck.txt), [results/apicheck.txt](results/apicheck.txt): the setup checks (E-09c's [tools/](../E09c-kafka/tools)). [results/binary-docs.txt](results/binary-docs.txt): the broker's own descriptions of write caching and its fsync counter.
- [results/tables.md](results/tables.md) (every column, `sh run.sh table`), [results/runs.jsonl](results/runs.jsonl), [results/raw/](results/raw), [results/timing-log.txt](results/timing-log.txt). The README's tables come from [../E09c-kafka/tools/readme_tables.py](../E09c-kafka/tools/readme_tables.py), which reads both experiments' runs.
- [results/calibrate.txt](results/calibrate.txt): short unrecorded runs that sized each test (not measurements).

## Verdict

Redpanda runs on this box, and at its default it is the matched row of PERF-06: an `acks=all` write is on disk at a majority before the answer. It is the strongest competitor measured in E-09 for a TS build. Its matched throughput (171 MiB/s of 1 KiB records) sits only 1.62 × under E-02's TS pipeline ceiling, which has no protocol work at all, and it spends about the same CPU per record as that pipeline. Its single-record ack p99 (1.65 ms) beats E-02's real-disk commit tails. Only its p99 at half of max (43 ms) is clearly beaten by E-02's floor (19 ms). Kafka's tools drove it unchanged; it has no share groups.

Q-09 (Redpanda): Redpanda 26.2.6 runs here (3 nodes, `--smp 1 --memory 2G --overprovisioned`, Kafka's own tools) and at its default (fsync at a majority before `acks=all`, so PERF-06's matched row) takes 175,420 × 1 KiB records/s (171 MiB/s, OMB settings) on about 1 broker core (5.8 µs/record + about 1.1 µs kernel I/O), end-to-end p99 43 ms at half of max (87,710/s) and 19 ms at 50,000/s, and a single-record ack p50 0.70 / p99 1.65 ms; with write caching 187,199/s, p99 16 ms at half, ack p50 0.24 / p99 0.79 ms; no share groups (UNSUPPORTED). That is 2.0 × Kafka's matched rate and only 1.62 × under E-02's TS 1 KiB `persisted` ceiling (1.99 × under Rust's): the thinnest matched margin in E-09, with no CPU margin for TS, and its single-record tail beats E-02's real-disk tails; E-02's TS p99 at half (19 ms) beats Redpanda's 43 ms. Moves: MIN-TS down on PERF-06 (max MB/s and single-record p99 rows: thin disk margin, no CPU margin, wider tail); RUST, SRV, SIDE and EMB-V8 up a little on PERF-06 (2 × ceiling, tighter tail); MIN, DRAFT, LEAN (`ts→rs`) not down at matched throughput by the threshold, but PERF-06 is the row most likely to need the native build before G2 is claimed (decision 3); every candidate up on PERF-06's p99-at-half row; no `memory` rung is needed for PERF-06 (its default is the matched row), and E-45's "Redpanda cannot run here" is superseded: PERF-06 becomes comparable when fero's Kafka gateway runs at speed.
