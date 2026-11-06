# E-09a: Redis 7.0 on this box, with redis-benchmark

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09, Redis row (QUESTIONS.md §2, E-09a): what does Redis reach here, with its own tool, at matched guarantees and at its default? It sets the bar numbers of PERF-02 (GET, SET, INCR, 100-byte values, 4 threads × 50 clients, pipeline 1 and 16), and says, against [E-02](../E02-pipeline/README.md)'s pipeline floors, whether a TS build can win these rows at all.

## The answer in short

All measured here, medians of 3 runs, each on a fresh server. Ranges are in the tables below.

- **Redis as shipped (one server, no fsync, no replica) is one CPU core.** In every `default` run the server sat at 0.97-0.98 of a core. With 200 clients: **SET 140,600/s, GET 144,400/s, INCR 149,700/s at pipeline 1** (p50 1.2-1.3 ms, p99 2.6-2.8 ms, which is 200 requests in flight queued on one core), and **SET 812,000/s, GET 867,000/s, INCR 934,000/s at pipeline 16** (p99 5.9-7.3 ms). That is about **7 µs of server CPU per request at pipeline 1** (a socket read and write per request) and **1.0-1.2 µs at pipeline 16**.
- **PERF-02's matched config** (`appendonly yes, appendfsync always`, one server): **SET 88,600/s (p50 1.96, p99 4.6 ms) and INCR 103,000/s at pipeline 1; SET 362,000/s (p99 27 ms) and INCR 569,000/s at pipeline 16.** Redis fsyncs once per event-loop pass for all the writes of that pass (its design; reasoned here from the rates), so the fsync costs 37 % of SET's rate at pipeline 1 and 55 % at pipeline 16. GET does not change (139,000 and 855,000/s). One of the three `aof-set-p1` runs had a 1.7 s stall (max column) and 22 % less throughput: E-01's disk stalls.
- **With two replicas** (`aof-r3`, all three fsync always; replication is asynchronous, so the reply waits only for the primary): SET 75,500/s (p99 6.9 ms) and 260,000/s (p99 44 ms); INCR 90,100/s and 332,000/s. The replicas' own fsyncs on the same disk cost the primary 12-42 % of its rate.
- **The closest Redis 7.0 gets to fero's `persisted`:** `SET` then `WAIT 1 0` (on the primary's disk and in one replica's memory before the reply), driven by respbench: **45,400/s at pipeline 1 (p50 4.19, p99 7.9 ms) and 70,000/s at pipeline 16 (p99 71 ms)**. Against respbench's own plain `SET` on the same three servers (87,400 and 289,000/s), waiting for a replica halves the rate at pipeline 1 and quarters it at pipeline 16. respbench's plain `SET` read 11-16 % higher than redis-benchmark's on the same setup (a lighter client), so the `WAIT` rows are compared with respbench's own `SET` rows, not with redis-benchmark's.
- **Against E-02.** Every Redis row, matched or default, is below E-02's TS pipeline ceilings: the matched rows 5-60 × below the `persisted` ceiling (2.8 million 100 B appends/s), the default rows **only 3-5 × below** the `memory` (2.75 M/s) and `none` (4.3 M/s) ceilings. E-02 has no sockets, no RESP parsing and no replies, which are all of Redis's own cost, so **E-02 does not stop TS on any PERF-02 row, but the default rows at pipeline 16 are the thinnest margin in E-09** and are decided by E-45's RESP gateway. On the default rows' latency, E-02's `persisted` tail on this disk (TS p99 31 ms at 1.4 M/s) is far behind Redis's (p99 6-7 ms at 0.8-0.9 M/s), so winning Redis's default rows needs the `memory` rung (Q `maj-m`): reasoned from E-02's tails, not measured at Redis's rate.
- **GET** has PERF-02's own rule: an in-process read of a held row (PERF-10: < 100 ns) must beat a Redis GET round trip outright. It does by design: Redis's GET here is 1.26 ms at p50 under 200 clients, and an idle loopback round trip alone is 31-40 µs (E-01).

## Method

- **Redis 7.0.15** (the Ubuntu 24.04 package, `5:7.0.15-1ubuntu0.24.04.5`), started with no config file, so with Redis's compiled-in defaults ([redis.conf of 7.0.15](https://github.com/redis/redis/blob/7.0.15/redis.conf), cited): RDB snapshots on (`save 3600 1 300 100 60 10000`), `appendonly no`, one I/O thread. A new server (and data directory) per run, deleted after it.
- **Three server setups:**
  - `default`: one Redis as shipped. This is PERF-02's "competitor's default".
  - `aof`: one Redis with `appendonly yes, appendfsync always`. This is PERF-02's "matched" config: every write is in the append-only file, fsynced, before the reply.
  - `aof-r3`: the same plus **two replicas** (`replicaof`), each also with `appendonly yes, appendfsync always`, so three copies sit on the one disk as fero's three replicas would. Redis replication is asynchronous: the reply still waits only for the primary's fsync.
- **What "matched" cannot mean for Redis 7.0.** fero's `persisted` answers after a majority (2 of 3) has the write on disk. Redis 7.0 has no way to wait for that: `WAIT n` waits until n replicas have *received* a write (in memory), and `WAITAOF`, which waits for replicas' fsyncs, arrived only in Redis 7.2.0 ([waitaof.json](https://github.com/redis/redis/blob/7.2.0/src/commands/waitaof.json), cited). So PERF-02's matched row (`aof`) is **weaker** than fero's `persisted`: one fsynced copy, not two. The closest Redis 7.0 gets is `SET` then `WAIT 1 0` on `aof-r3`: on the primary's disk and in one replica's memory before the reply. That row is here too (`setwait1`).
- **The tool:** `redis-benchmark` 7.0.15 with `-c 200 --threads 4` (4 threads × 50 clients), `-d 100` (100-byte values), `-r 100000` (random keys over 100,000), `-P 1` and `-P 16`, `-t set|get|incr`, `--precision 3`; one test per run. Before each measured test the key space is filled (`SET` at pipeline 64, not measured), so every `GET` hits. `-n` was sized from short busy-box trial runs ([nreq.json](nreq.json)) so a run lasts about 5-40 s.
- **memtier_benchmark** (PERF-02's first-named tool) **was not run.** It is downloaded (TOOLS.md), but the session's safety check refused both building it from source and running the binary taken from Redis's image ("Code from External"). Later the same day TOOLS.md recorded that the user had allowed memtier and put a binary at `$SP/opt/memtier/bin/memtier_benchmark`; this experiment's one attempt to run it (`--version`, at 20:45, after the redis-benchmark runs) was again refused by the safety check with the same reason, and that refusal was taken as final. A later run can add memtier rows with the same setups ([bench.py](bench.py) starts the servers). redis-benchmark covers GET, SET and INCR with the same clients, threads, sizes and pipeline depths, and gives p50, p95, p99, p99.9 and max. What is lost: memtier's HdrHistogram output and its mixed read/write loads.
- **respbench** ([respbench/main.go](respbench/main.go), 173 lines of Go, standard library only) is a port of redis-benchmark's load loop: 200 connections, a fixed pipeline depth, random keys, 100-byte values, latency from a batch's write to each reply. It drives the one row redis-benchmark cannot: `SET` followed by `WAIT 1 0` per request. To check it against the real tool, it also runs plain `SET` on the same `aof-r3` setup (`set-p1-respbench`, `set-p16-respbench`), beside redis-benchmark's `aof-r3-set` rows. Each respbench run is 20 s after 2 s of warm-up, with `GOMAXPROCS=4`.
- **Measured per run:** throughput and latency percentiles; CPU of every Redis process (from `/proc/<pid>/stat`) and of the load generator; the box's busy cores, so "other cores" = load from processes outside this run; `/proc/loadavg` before the run (the 1-minute figure includes our own previous run). Raw lines: [results/runs.jsonl](results/runs.jsonl); the tool's output per run: [results/raw/](results/raw); the table: [results/tables.md](results/tables.md).
- Everything timed ran under `$SP/bin/timing`, in three holds (`default`, `aof`, `r3`): [run.sh](run.sh). Machine: E-01's ([env.txt](../E01-floors/results/env.txt)): 4-vCPU Firecracker VM, one virtio disk, ext4 without a journal.

## Results

Median of 3 runs, range in brackets. Latency in ms. "redis cores" = CPU of all Redis processes; "client cores" = the load generator's CPU.

| config | tool | runs | ops/s | p50 ms | p99 ms | p99.9 ms | max ms | redis cores (all servers) | primary cores | client cores | other cores | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default-set-p1 | redis-benchmark | 3 | 140584 (138581-140584) | 1.279 (1.263-1.287) | 2.807 (2.711-2.831) | 4.591 (4.015-4.919) | 21.2 (15.1-48.4) | 0.98 (0.97-0.98) | 0.98 (0.97-0.98) | 1.28 (1.27-1.30) | 0.14 (0.12-0.18) | 1.11, 1.20, 1.38 |
| default-set-p16 | redis-benchmark | 3 | 811908 (797766-824742) | 3.639 (3.615-3.679) | 7.327 (6.199-7.591) | 10.311 (8.663-10.439) | 23.9 (16.1-28.4) | 0.97 (0.97-0.98) | 0.97 (0.97-0.98) | 0.81 (0.77-0.84) | 0.13 (0.11-0.14) | 2.03, 2.02, 2.18 |
| default-get-p1 | redis-benchmark | 3 | 144439 (142586-144439) | 1.255 (1.255-1.255) | 2.719 (2.703-2.759) | 3.951 (3.775-4.591) | 17.0 (13.1-61.0) | 0.98 (0.98-0.99) | 0.98 (0.98-0.99) | 1.34 (1.32-1.36) | 0.10 (0.09-0.12) | 2.51, 2.51, 2.50 |
| default-get-p16 | redis-benchmark | 3 | 867002 (842460-879817) | 3.567 (3.391-3.583) | 6.167 (5.967-6.215) | 8.191 (7.895-8.319) | 12.3 (12.1-16.0) | 0.98 (0.98-0.98) | 0.98 (0.98-0.98) | 0.84 (0.81-0.85) | 0.12 (0.11-0.13) | 2.68, 2.80, 2.44 |
| default-incr-p1 | redis-benchmark | 3 | 149701 (146071-149716) | 1.199 (1.191-1.231) | 2.647 (2.639-2.671) | 3.943 (3.807-4.039) | 16.9 (9.3-25.0) | 0.98 (0.98-0.98) | 0.98 (0.98-0.98) | 1.37 (1.36-1.39) | 0.10 (0.09-0.10) | 2.41, 2.98, 3.01 |
| default-incr-p16 | redis-benchmark | 3 | 934288 (921263-965500) | 3.103 (3.063-3.271) | 5.919 (5.663-6.759) | 8.463 (8.207-16.991) | 13.2 (11.9-34.3) | 0.97 (0.97-0.98) | 0.97 (0.97-0.98) | 0.95 (0.89-0.97) | 0.16 (0.15-0.16) | 3.09, 2.69, 2.61 |
| aof-set-p1 | redis-benchmark | 3 | 88643 (69360-88741) | 1.959 (1.919-2.007) | 4.607 (4.295-6.639) | 12.703 (10.119-31.215) | 41.9 (35.7-1699.8) | 0.73 (0.59-0.74) | 0.73 (0.59-0.74) | 0.85 (0.71-0.94) | 0.23 (0.18-0.51) | 1.10, 1.48, 1.64 |
| aof-set-p16 | redis-benchmark | 3 | 362450 (362450-362582) | 8.351 (8.311-8.455) | 27.279 (25.199-29.167) | 40.735 (39.167-45.151) | 50.0 (48.3-68.9) | 0.78 (0.76-0.80) | 0.78 (0.76-0.80) | 0.36 (0.35-0.42) | 0.40 (0.31-0.89) | 1.78, 1.82, 1.71 |
| aof-get-p1 | redis-benchmark | 3 | 139243 (136036-144231) | 1.255 (1.199-1.295) | 3.391 (2.815-4.039) | 6.567 (4.263-6.703) | 26.9 (15.1-41.5) | 0.95 (0.91-0.98) | 0.95 (0.91-0.98) | 1.31 (1.26-1.31) | 0.47 (0.15-0.79) | 1.83, 2.58, 2.97 |
| aof-get-p16 | redis-benchmark | 3 | 854798 (842460-866852) | 3.527 (3.399-3.535) | 6.615 (6.255-7.047) | 9.167 (8.975-9.791) | 21.6 (14.2-24.0) | 0.98 (0.97-0.98) | 0.98 (0.97-0.98) | 0.82 (0.80-0.85) | 0.15 (0.14-0.20) | 2.68, 2.71, 2.59 |
| aof-incr-p1 | redis-benchmark | 3 | 102973 (99552-102987) | 1.679 (1.679-1.695) | 3.863 (3.855-3.911) | 10.655 (8.471-12.391) | 43.2 (34.8-87.4) | 0.76 (0.75-0.76) | 0.76 (0.75-0.76) | 1.00 (0.97-1.00) | 0.19 (0.15-0.21) | 2.27, 2.22, 2.36 |
| aof-incr-p16 | redis-benchmark | 3 | 569395 (550282-590406) | 5.175 (5.151-5.631) | 11.543 (11.239-11.951) | 34.719 (32.799-35.199) | 37.8 (34.6-38.6) | 0.81 (0.80-0.81) | 0.81 (0.80-0.81) | 0.57 (0.57-0.59) | 0.23 (0.21-0.26) | 2.30, 2.17, 1.99 |
| aof-r3-set-p1 | redis-benchmark | 3 | 75464 (75439-75488) | 2.167 (2.151-2.207) | 6.935 (6.039-7.287) | 28.863 (27.055-35.007) | 82.8 (76.2-89.1) | 1.21 (1.20-1.23) | 0.71 (0.70-0.72) | 0.76 (0.73-0.78) | 0.30 (0.29-0.42) | 1.03, 1.44, 1.62 |
| aof-r3-set-p16 | redis-benchmark | 3 | 259875 (254259-271592) | 10.687 (10.535-11.239) | 44.287 (41.119-45.823) | 61.151 (58.591-89.919) | 69.8 (67.7-106.1) | 1.69 (1.55-1.72) | 0.76 (0.72-0.78) | 0.25 (0.24-0.27) | 0.52 (0.46-0.86) | 1.55, 1.86, 2.30 |
| aof-r3-incr-p1 | redis-benchmark | 3 | 90090 (90067-93060) | 1.863 (1.839-1.887) | 4.575 (4.359-4.639) | 13.591 (12.327-23.183) | 54.7 (52.3-89.7) | 1.19 (1.17-1.20) | 0.75 (0.75-0.77) | 0.90 (0.88-0.90) | 0.21 (0.21-0.28) | 2.36, 2.47, 2.49 |
| aof-r3-incr-p16 | redis-benchmark | 3 | 332005 (314795-411692) | 8.695 (7.119-8.983) | 24.191 (21.759-26.175) | 77.951 (50.559-122.687) | 97.8 (73.7-128.6) | 1.94 (1.86-1.99) | 0.79 (0.76-0.79) | 0.35 (0.34-0.37) | 0.33 (0.29-0.36) | 2.43, 2.38, 2.69 |
| aof-r3-setwait1-p1 | respbench | 3 | 45439 (44840-46464) | 4.187 (4.089-4.199) | 7.875 (7.398-8.176) | 28.960 (19.845-36.694) | 96.8 (96.7-135.0) | 1.08 (1.06-1.08) | 0.67 (0.66-0.68) | 0.79 (0.79-0.80) | 0.23 (0.22-0.24) | 2.52, 3.11, 3.06 |
| aof-r3-set-p1-respbench | respbench | 3 | 87427 (83861-88651) | 2.070 (2.047-2.161) | 5.003 (4.938-5.106) | 25.237 (22.558-30.373) | 90.8 (86.5-97.3) | 1.26 (1.25-1.28) | 0.74 (0.73-0.76) | 0.83 (0.83-0.84) | 0.23 (0.23-0.25) | 2.54, 2.46, 2.83 |
| aof-r3-setwait1-p16 | respbench | 3 | 69975 (69441-70636) | 24.103 (23.882-24.208) | 71.238 (66.046-72.675) | 167.638 (166.893-179.906) | 208.5 (193.3-210.0) | 1.15 (1.14-1.17) | 0.63 (0.62-0.63) | 0.55 (0.55-0.56) | 0.27 (0.26-0.29) | 2.79, 2.89, 3.18 |
| aof-r3-set-p16-respbench | respbench | 3 | 289183 (286703-295886) | 10.391 (10.245-10.478) | 39.613 (38.264-39.678) | 51.153 (50.642-51.323) | 88.2 (74.7-134.0) | 1.65 (1.60-1.76) | 0.77 (0.76-0.77) | 0.32 (0.32-0.32) | 0.39 (0.36-0.39) | 2.80, 2.93, 2.79 |

CPU per request, from the medians above (µs of one core; "all servers" adds the replicas):

| config | primary | all servers | client |
|---|---|---|---|
| default, pipeline 1 (SET / GET / INCR) | 7.0 / 6.8 / 6.6 | same | 9.1 / 9.3 / 9.2 |
| default, pipeline 16 (SET / GET / INCR) | 1.2 / 1.1 / 1.0 | same | 1.0 / 1.0 / 1.0 |
| aof, pipeline 1 (SET / INCR) | 8.2 / 7.4 | same | 9.6 / 9.7 |
| aof, pipeline 16 (SET / INCR) | 2.2 / 1.4 | same | 1.0 / 1.0 |
| aof-r3, pipeline 1 (SET / INCR) | 9.4 / 8.3 | 16.0 / 13.2 | 10.1 / 10.0 |
| aof-r3, pipeline 16 (SET / INCR) | 2.9 / 2.4 | 6.5 / 5.8 | 1.0 / 1.1 |
| aof-r3 SET + WAIT 1, pipeline 1 / 16 (respbench) | 14.8 / 9.0 | 23.8 / 16.4 | 17.4 / 7.9 |

## Against the floors (E-01, E-02)

QUESTIONS.md's threshold, per row: if the competitor's matched median is better than E-02's TS floor, TS cannot win that row and the native build must come first; better than the Rust floor too, and the gap goes into the verdict. A default row won only by a `memory` or `none` rung means that rung is priced as a mechanism (DEV-01). E-02's pipeline makes its own writes (no sockets, no protocol, no replies), so a floor far above Redis means only that E-02 does not rule a win out; E-45's RESP gateway, driven by this same tool, decides.

**Matched rows** (PERF-02: Redis `appendfsync always`; one fsynced copy, weaker than fero's `persisted`, see Method):

| PERF-02 row | Redis here (median) | E-02 floor (real disk, 3 replicas, 100 B) | Reading |
|---|---|---|---|
| SET, pipeline 1 | 88,600/s; p50 1.96, p99 4.6 ms | `persisted` ceiling TS 2.79 M/s, Rust 2.21 M/s (preallocated: 3.6 and 4.1 M/s); at 50,000/s TS p99 4.33 ms, Rust 1.58 | floor 25-30 × above: **not stopped** |
| SET, pipeline 16 | 362,000/s; p99 27 ms | same; at half of the ceiling (1.1-1.4 M/s) p99 TS 31 ms, Rust 5.5 ms | floor 6-8 × above: not stopped |
| INCR, pipeline 1 / 16 | 103,000 / 569,000/s; p99 3.9 / 11.5 ms | same | floor 5-27 × above: not stopped |
| GET, pipeline 1 / 16 | 139,000 / 855,000/s; p99 3.4 / 6.6 ms | PERF-10 held-row read < 100 ns in process | in process: outright win by design; through the tool: E-45 |
| SET on three servers (`aof-r3`), pipeline 1 / 16 | 75,500 / 260,000/s; p99 6.9 / 44 ms | same as SET | not stopped |
| SET + WAIT 1 (closest to `persisted`), pipeline 1 / 16 | 45,400 / 70,000/s; p99 7.9 / 71 ms | same as SET | floor 40-60 × above: not stopped |

**Default rows** (Redis as shipped vs fero's weakest rung):

| PERF-02 row | Redis here (median) | E-02 floor | Reading |
|---|---|---|---|
| SET, pipeline 1 | 140,600/s; p50 1.28, p99 2.81 ms; 7.0 µs of server CPU per request | `memory` ceiling TS 2.75 M/s, Rust 4.96 M/s; `none` TS 4.29 M/s, Rust 18.6 M/s; at 50,000/s `memory` p99 TS 0.57, Rust 0.33 ms | floor 20-30 × above: not stopped. Redis spends 7 µs per request at pipeline 1, mostly a socket read and write; E-01's round trip shows Node paying about 9 µs more than Rust per round trip (40 against 31 µs at p50), so this row is about a TS gateway's per-request socket cost (reasoned) |
| SET, pipeline 16 | 812,000/s; p99 7.3 ms; 1.2 µs per request | same | **floor only 3.4 × (TS `memory`) to 5 × (TS `none`) above**: not stopped, but the thinnest margin; a TS gateway must parse, apply and answer a command in about 1 µs of one core to match Redis per core |
| GET, pipeline 1 / 16 | 144,400 / 867,000/s; p99 2.7 / 6.2 ms | held-row read < 100 ns in process | in process: outright win by design (PERF-02's own rule); through the tool: as SET |
| INCR, pipeline 1 / 16 | 149,700 / 934,000/s; p99 2.6 / 5.9 ms | P-11: an op at the writer ≤ 3 µs (TS), 0.5 µs (native) | as SET; at pipeline 16 Redis does a whole INCR, socket included, in 1.0 µs of CPU, under P-11's TS bar for the op alone |

**Which rung the default rows need (reasoned from E-02's measured tails).** With 3,200 requests in flight (200 clients × 16), Redis answers at p99 5.9-7.3 ms. E-02's `persisted` pipeline at 1.1-1.4 M/s had p99 31 ms (TS) and 5.5 ms (Rust) on this disk, and its tail was set by the disk's stalls; the `memory` rung at 50,000/s had p99 0.57 ms (TS). So on this disk fero can only expect to beat Redis's default p99 at pipeline 16 with the `memory` rung (Q `maj-m`), not with `persisted`. By the threshold, **the `memory` rung is then priced as a mechanism (DEV-01: one novel rule, "a replica that stops uncleanly rejoins as new", SPACE §2 Q)** in every candidate that claims PERF-02's default rows, or the user accepts those rows' loss by name (PERF-01). E-45 measures the real gateway.

**No Redis row is above the Rust floor**, so there is no gap to carry into the verdict from Redis.

## What this box cannot show

- **More cores for Redis, or a second machine for the client.** Redis serves every command on one thread (0.97-0.98 of a core in every `default` run), and redis-benchmark used another 0.8-1.4 cores on the same 4 vCPUs. On a real deployment the client is elsewhere and Redis can enable I/O threads (`io-threads`, off by default); neither is shown here.
- **Independent disks.** In `aof-r3` the primary and both replicas fsync their AOFs on the one virtual disk (E-01), so the replicas' fsyncs compete with the primary's.
- **Real round trips.** Loopback only; between machines every request also pays a network round trip.
- **Redis 7.2's `WAITAOF`** (wait until replicas have fsynced): not in 7.0, so the one Redis setting that matches fero's `persisted` (on disk at a majority) cannot be measured with the Redis version this study names. A later run with Redis ≥ 7.2 would close it.
- **memtier_benchmark**, refused for this agent (see Method): its numbers may differ from redis-benchmark's by its own client cost; that difference is not shown.

## Files

- [bench.py](bench.py): the driver (`run`, `smoke`, `table`). [run.sh](run.sh): `sh run.sh build` (respbench), then `sh run.sh all` (three timing holds) or one hold (`default`, `aof`, `r3`).
- [respbench/](respbench): the SET + WAIT driver (`main.go`, `go.mod`).
- [nreq.json](nreq.json): requests per redis-benchmark run.
- [fetch.sh](fetch.sh): the Redis package and the cited files, with checksums.
- [results/](results): `runs.jsonl` (one line per run), `tables.md`, `raw/` (each run's output, progress lines removed).

## Verdict

Redis 7.0 at its default is one core: 140,000-150,000 requests/s at pipeline 1 and 812,000-934,000/s at pipeline 16 with 200 clients, at about 7 µs and 1 µs of CPU per request. At PERF-02's matched setting (fsync always, one copy) it does 88,600 SETs/s and 362,000/s, and the closest it can get to fero's `persisted` (SET + WAIT 1 on three servers) is 45,400/s and 70,000/s. Every one of these sits below E-02's TS pipeline ceilings, so **no PERF-02 row is closed against a TS build**, and none is above the Rust floor. The default rows at pipeline 16 are the tightest margin in E-09 (3-5 × under the ceiling of a pipeline that does no socket or protocol work), so they are where a TS gateway is most likely to lose, and E-45 decides them. Winning Redis's default rows on p99 also needs the `memory` rung (Q `maj-m`) on this disk's evidence, so that rung counts in DEV-01 for any candidate that claims them, unless the user accepts the loss by name. memtier_benchmark was not run: this agent's attempt was refused by the session's safety check, even after TOOLS.md recorded the user's permission; redis-benchmark covers the same rows, and memtier's HdrHistogram output, its mixed loads and its own client cost are what is missing.

Q-09 (Redis): Redis 7.0.15 with 200 clients does, at its default (one core, no fsync), SET 140,600 / GET 144,400 / INCR 149,700 per s at pipeline 1 (p99 2.6-2.8 ms) and 812,000 / 867,000 / 934,000 per s at pipeline 16 (p99 5.9-7.3 ms), about 7 µs and 1 µs of CPU per request; at PERF-02's matched setting (appendfsync always) SET 88,600/s (p99 4.6 ms) and 362,000/s (p99 27 ms), INCR 103,000 and 569,000/s; with two async replicas SET 75,500 and 260,000/s; SET + WAIT 1 (the closest to `persisted` that Redis 7.0 has) 45,400 and 70,000/s; all rows sit below E-02's TS ceilings (matched 5-60 ×, default only 3-5 ×), so E-02 does not stop TS on PERF-02, and the default pipeline-16 rows are the thinnest margin, decided by E-45's RESP gateway. Moves: no candidate down on PERF-02 at matched guarantees; candidates whose only rung is Q `maj-d` (MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) and OBJ (`put`) down on PERF-02's default rows unless they add Q `maj-m` (+1 on DEV-01) or the user accepts the loss by name; DRAFT, CELL, SPLIT (Q `mix`) and ISR (`isr`) unchanged; MIN-TS down a little on PERF-02's default pipeline-16 rows (per-request CPU of about 1 µs needed), RUST and SRV up a little there.
