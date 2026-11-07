# E-09a2: Redis 7.0 with memtier_benchmark (the memtier addendum to E-09a)

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09a, memtier addendum ([QUESTIONS.md](../../QUESTIONS.md) §10): [E-09a](../E09a-redis/README.md) measured Redis with redis-benchmark only, because the session's safety check refused memtier_benchmark. memtier is PERF-02's first-named tool ([REQUIREMENTS.md](../../REQUIREMENTS.md) PERF-02). This experiment runs memtier on E-09a's three setups (`default`, `aof`, `aof-r3`), at PERF-02's shape, keeps its HdrHistogram output, adds a mixed GET/SET load, and drives E-45's RESP gateway with the same commands.

**Threshold** (QUESTIONS.md §10): memtier's numbers agree with redis-benchmark's within the spread, or the difference is explained; PERF-02's bar is then stated from memtier.

**Words.** *memtier* is memtier_benchmark, Redis Ltd.'s load tool. *redis-benchmark* is the load tool that ships with Redis. *Pipeline 16* means a connection has up to 16 requests sent and not yet answered. *Spread* is max minus min over the 3 runs of one row. *The prototype* is E-22's simulator (one Node process, three simulated servers, virtual time) with E-45's RESP gateway in front: it is **not a fero kernel**, so its rows show only that memtier drives fero's API end to end, and how a simulator answers.

__SHORT__

## Method

- **The tool:** memtier_benchmark 2.5.2 (`$SP/opt/memtier/bin/memtier_benchmark`, `--version`: `v=2.5.2 ... libevent=2.1.12-stable`), the binary of Redis Ltd.'s official image `redislabs/memtier_benchmark:2.5.2` (layer sha256 `6aef4ecc…ea41`, binary sha256 `d8d87a6d…4262`; [fetch.sh](fetch.sh)). The user allowed it on 2026-11-06: "allow Redpanda, memtier_benchmark and LazyFS and anything else you need". This time it ran; nothing was refused.
- **The servers:** E-09a's three setups, copied verbatim into [bench.py](bench.py) (`SETUPS`): `default` (one Redis 7.0.15 as shipped: no config file, RDB on, `appendonly no`), `aof` (`appendonly yes, appendfsync always`, PERF-02's matched setting) and `aof-r3` (the same plus two replicas, each also fsync always; replication is asynchronous). A new server and data folder per run, deleted after it. Only the ports differ (36479-36481, so this never meets E-09a's).
- **PERF-02's shape:** `--threads=4 --clients=50` (200 connections), `--data-size=100`, keys uniform at random over 1..100,000 (`--key-pattern=R:R`, `--distinct-client-seed` so the 200 clients do not walk the same key sequence), `--pipeline=1` and `16`, `--test-time=20`. Tests: SET (`--ratio=1:0`), GET (`--ratio=0:1`), INCR (`--command="incr __key__"` on keys `counter:N`, apart from the 100-byte keys, as redis-benchmark's INCR uses `counter:` keys), and the **mixed load** MIX (`--ratio=1:10`: one SET per ten GETs, memtier's own default ratio). As in E-09a, `aof-r3` has no GET row (a GET touches neither the AOF nor the replicas; the `aof` rows cover it).
- **Fill:** before every Redis run, memtier writes all 100,000 keys once (`--key-pattern=P:P --requests=allkeys --pipeline=64`, not measured), so every GET hits (memtier counts hits and misses: the hit ratio was 1.0000 in every GET and MIX run). E-09a's redis-benchmark fill (300,000 random SETs) covered about 95 % of the keys (reasoned: 1 − e⁻³).
- **Recorded per run:** memtier's JSON (ops/s, average, p50, p90, p99, p99.9, p99.99, max, per command, and per second), its **HdrHistogram** log of the whole run (`--hdr-file-prefix`; the `.hgrm` files in [results/hdr/](results/hdr) hold each run's full histogram as one compressed line, readable with any HdrHistogram log reader), the CPU of every Redis process (from `/proc/<pid>/stat`), memtier's CPU, the box's busy cores, and `/proc/loadavg` before the run. The 1-second counts give "1-s min ops", the slowest whole second of the run: a stall shows there.
- **Same-hold controls:** E-09a's numbers were taken on 2026-11-06 at a different load. So each hold also runs E-09a's exact redis-benchmark command (same fill, same `-n` from E-09a's [nreq.json](nreq.json)) on one SET row per setup and pipeline depth (`*-set-p1-rb`, `*-set-p16-rb`). A difference between memtier and redis-benchmark that the controls also show against E-09a is the box, not the tool.
- **Holds:** four timing holds under `$SP/bin/timing` (`default`, `aof`, `r3`, `proto`), each 10-16 minutes, so the lock is never held near 30 minutes. Inside a hold the runs go round-robin: run 1 of every config, then run 2, then run 3, so a slow drift of the box lands on every row alike. Every line of the holds is in [results/timing-log.txt](results/timing-log.txt).
- **The prototype rows (`proto-*`):** E-45's host ([host.ts](../E45-drivers/host.ts)) with its RESP gateway ([lib/resp.ts](../E45-drivers/lib/resp.ts)), unchanged: one Node 22 process holding E-22's simulated world (three servers, virtual time, a simulated fsync) at the resource's default `persisted` rung, the gateway inside server `s1`. memtier drives it with exactly the Redis commands above. Fill: only before GET and MIX (filling 100,000 rows in the simulator takes about 20 s; SET and INCR do not need it). "server cores" for these rows is the host process: gateway, three simulated servers and the simulator together. These rows measure **a simulator behind a gateway, not a fero kernel**.
- **Machine:** E-01's ([env.txt](../E01-floors/results/env.txt)): a 4-vCPU Firecracker VM, 15 GB, one virtio disk (ext4). Redis 7.0.15 (Ubuntu 24.04 package), redis-benchmark 7.0.15, Node 22.22.0, data at the commit each hold's header in timing-log.txt names.

### How memtier and redis-benchmark differ (read from their sources)

| | memtier 2.5.2 | redis-benchmark 7.0.15 |
|---|---|---|
| Pipeline | a **sliding window**: while a connection has fewer than `--pipeline` requests out, it sends another; every reply refills the window (`shard_connection::fill_pipeline`, `while (... m_pipeline->size() < m_config->pipeline)`, called after each read) | a **batch**: write `-P` commands at once, wait for all `-P` replies, then write the next batch (`writeHandler` / `readHandler`, `c->pending`) |
| Latency of one request | from the moment that request was queued to the read event that parsed its reply (`client::handle_response`, `ts_diff(ref_sent, timestamp)`) | one number per batch: from the batch's write to the **first** read event (`readHandler`: `if (c->latency < 0) c->latency = ustime()-(c->start)`), recorded for every reply of the batch |
| Run length | `--test-time` seconds | `-n` requests |
| Keys | `memtier-N` (and `counter:N` for INCR), uniform, one seed per client | `key:000000NNNNNN`, uniform, one shared `random()` |
| Value | 100 bytes `x` (`object_generator`: `memset(m_value_buffer, 'x', ...)` without `--random-data`) | 100 generated bytes (`genBenchmarkRandomData`); Redis stores either as an opaque string, so this does not change its work |
| Threads | 4 libevent threads, 50 connections each | 4 threads (`--threads 4`), 50 connections each |

At pipeline 1 the two measure the same thing. At pipeline 16 redis-benchmark's latency is a lower bound: the 16 replies of a batch all get the time of the first one. Sources: memtier at tag 2.5.2 (`$SP/dl/memtier/src`, commit `f3ff1793`), and [redis-benchmark.c of 7.0.15](https://github.com/redis/redis/blob/7.0.15/src/redis-benchmark.c) (cited; sha256 in [fetch.sh](fetch.sh)).

__RESULTS__
