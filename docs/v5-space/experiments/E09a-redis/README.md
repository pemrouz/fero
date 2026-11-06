# E-09a: Redis 7.0 on this box, with redis-benchmark

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09, Redis row (QUESTIONS.md §2, E-09a): what does Redis reach here, with its own tool, at matched guarantees and at its default? It sets the bar numbers of PERF-02 (GET, SET, INCR, 100-byte values, 4 threads × 50 clients, pipeline 1 and 16), and says, against [E-02](../E02-pipeline/README.md)'s pipeline floors, whether a TS build can win these rows at all.

## The answer in short

All measured here, medians of 3 runs, each on a fresh server. Ranges are in the tables below.

__SHORT__

## Method

- **Redis 7.0.15** (the Ubuntu 24.04 package, `5:7.0.15-1ubuntu0.24.04.5`), started with no config file, so with Redis's compiled-in defaults ([redis.conf of 7.0.15](https://github.com/redis/redis/blob/7.0.15/redis.conf), cited): RDB snapshots on (`save 3600 1 300 100 60 10000`), `appendonly no`, one I/O thread. A new server (and data directory) per run, deleted after it.
- **Three server setups:**
  - `default`: one Redis as shipped. This is PERF-02's "competitor's default".
  - `aof`: one Redis with `appendonly yes, appendfsync always`. This is PERF-02's "matched" config: every write is in the append-only file, fsynced, before the reply.
  - `aof-r3`: the same plus **two replicas** (`replicaof`), each also with `appendonly yes, appendfsync always`, so three copies sit on the one disk as fero's three replicas would. Redis replication is asynchronous: the reply still waits only for the primary's fsync.
- **What "matched" cannot mean for Redis 7.0.** fero's `persisted` answers after a majority (2 of 3) has the write on disk. Redis 7.0 has no way to wait for that: `WAIT n` waits until n replicas have *received* a write (in memory), and `WAITAOF`, which waits for replicas' fsyncs, arrived only in Redis 7.2.0 ([waitaof.json](https://github.com/redis/redis/blob/7.2.0/src/commands/waitaof.json), cited). So PERF-02's matched row (`aof`) is **weaker** than fero's `persisted`: one fsynced copy, not two. The closest Redis 7.0 gets is `SET` then `WAIT 1 0` on `aof-r3`: on the primary's disk and in one replica's memory before the reply. That row is here too (`setwait1`).
- **The tool:** `redis-benchmark` 7.0.15 with `-c 200 --threads 4` (4 threads × 50 clients), `-d 100` (100-byte values), `-r 100000` (random keys over 100,000), `-P 1` and `-P 16`, `-t set|get|incr`, `--precision 3`; one test per run. Before each measured test the key space is filled (`SET` at pipeline 64, not measured), so every `GET` hits. `-n` was sized from short busy-box trial runs ([nreq.json](nreq.json)) so a run lasts about 5-40 s.
- **memtier_benchmark** (PERF-02's first-named tool) **was not run.** It is downloaded (TOOLS.md), but the session's safety check refused both building it from source and running the binary taken from Redis's image ("Code from External"); the toolsmith took that refusal as final, and so did this experiment. redis-benchmark covers GET, SET and INCR with the same clients, threads, sizes and pipeline depths, and gives p50, p95, p99, p99.9 and max. What is lost: memtier's HdrHistogram output and its mixed read/write loads.
- **respbench** ([respbench/main.go](respbench/main.go), 173 lines of Go, standard library only) is a port of redis-benchmark's load loop: 200 connections, a fixed pipeline depth, random keys, 100-byte values, latency from a batch's write to each reply. It drives the one row redis-benchmark cannot: `SET` followed by `WAIT 1 0` per request. To check it against the real tool, it also runs plain `SET` on the same `aof-r3` setup (`set-p1-respbench`, `set-p16-respbench`), beside redis-benchmark's `aof-r3-set` rows. Each respbench run is 20 s after 2 s of warm-up, with `GOMAXPROCS=4`.
- **Measured per run:** throughput and latency percentiles; CPU of every Redis process (from `/proc/<pid>/stat`) and of the load generator; the box's busy cores, so "other cores" = load from processes outside this run; `/proc/loadavg` before the run (the 1-minute figure includes our own previous run). Raw lines: [results/runs.jsonl](results/runs.jsonl); the tool's output per run: [results/raw/](results/raw); the table: [results/tables.md](results/tables.md).
- Everything timed ran under `$SP/bin/timing`, in three holds (`default`, `aof`, `r3`): [run.sh](run.sh). Machine: E-01's ([env.txt](../E01-floors/results/env.txt)): 4-vCPU Firecracker VM, one virtio disk, ext4 without a journal.

## Results

Median of 3 runs, range in brackets. Latency in ms. "redis cores" = CPU of all Redis processes; "client cores" = the load generator's CPU.

__TABLE__

## Against the floors (E-01, E-02)

__FLOORS__

## What this box cannot show

- **More cores for Redis, or a second machine for the client.** Redis serves every command on one thread (0.97-0.98 of a core in every `default` run), and redis-benchmark used another 0.8-1.4 cores on the same 4 vCPUs. On a real deployment the client is elsewhere and Redis can enable I/O threads (`io-threads`, off by default); neither is shown here.
- **Independent disks.** In `aof-r3` the primary and both replicas fsync their AOFs on the one virtual disk (E-01), so the replicas' fsyncs compete with the primary's.
- **Real round trips.** Loopback only; between machines every request also pays a network round trip.
- **Redis 7.2's `WAITAOF`** (wait until replicas have fsynced): not in 7.0, so the one Redis setting that matches fero's `persisted` (on disk at a majority) cannot be measured with the Redis version this study names. A later run with Redis ≥ 7.2 would close it.
- **memtier_benchmark**, refused here (see Method): its numbers may differ from redis-benchmark's by its own client cost; that difference is not shown.

## Files

- [bench.py](bench.py): the driver (`run`, `smoke`, `table`). [run.sh](run.sh): `sh run.sh build` (respbench), then `sh run.sh all` (three timing holds) or one hold (`default`, `aof`, `r3`).
- [respbench/](respbench): the SET + WAIT driver (`main.go`, `go.mod`).
- [nreq.json](nreq.json): requests per redis-benchmark run.
- [fetch.sh](fetch.sh): the Redis package and the cited files, with checksums.
- [results/](results): `runs.jsonl` (one line per run), `tables.md`, `raw/` (each run's output, progress lines removed).

## Verdict

__VERDICT__
