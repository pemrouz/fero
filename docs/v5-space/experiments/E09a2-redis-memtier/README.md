# E-09a2: Redis 7.0 with memtier_benchmark (the memtier addendum to E-09a)

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09a, memtier addendum ([QUESTIONS.md](../../QUESTIONS.md) §10): [E-09a](../E09a-redis/README.md) measured Redis with redis-benchmark only, because the session's safety check refused memtier_benchmark. memtier is PERF-02's first-named tool ([REQUIREMENTS.md](../../REQUIREMENTS.md) PERF-02). This experiment runs memtier on E-09a's three setups (`default`, `aof`, `aof-r3`), at PERF-02's shape, keeps its HdrHistogram output, adds a mixed GET/SET load, and drives E-45's RESP gateway with the same commands.

**Threshold** (QUESTIONS.md §10): memtier's numbers agree with redis-benchmark's within the spread, or the difference is explained; PERF-02's bar is then stated from memtier.

**Words.** *memtier* is memtier_benchmark, Redis Ltd.'s load tool. *redis-benchmark* is the load tool that ships with Redis. *Pipeline 16* means a connection has up to 16 requests sent and not yet answered. *Spread* is max minus min over the 3 runs of one row. *The prototype* is E-22's simulator (one Node process, three simulated servers, virtual time) with E-45's RESP gateway in front: it is **not a fero kernel**, so its rows show only that memtier drives fero's API end to end, and how a simulator answers.

## The answer in short

- **memtier ran this time, and it agrees with redis-benchmark where the two measure the same thing** (measured here). In the same hold, run beside run: within 7 % at pipeline 1 (memtier 1-7 % higher), and within the spread on 8 of 10 pipeline-16 pairs. Where they differ, at pipeline 16, memtier reads up to 14 % lower, never more than 5 % higher. The reason is measured: under memtier Redis is busy 3-6 % less of the time and spends 5-11 % more CPU per request; Redis is not short of a CPU, and both tools hand it 16 commands per read.
- **memtier's latencies are the honest ones.** Its mean matches Little's law (in-flight ÷ ops/s) within 0.2 % in every Redis run and within 1 % on the gateway. redis-benchmark's reads 2-7 % low on Redis, and 18-19 % low on E-45's gateway at pipeline 16, because it starts its clock late and gives a batch's 16 replies the time of the first (read in its source). So fero's PERF-02 latencies must come from memtier.
- **The box moved more than the tools differ.** The VM restarted twice during this work; the same command on the same Redis gave up to 36 % more on one boot than on another. A bar holds only for the hold it was measured in, so fero must be run beside Redis, round-robin, in one hold.
- **PERF-02's bar from memtier** (section 6): at the matched setting (`appendfsync always`, boot 3) SET 91,609/s with p99 4.9 ms at pipeline 1 and 379,300/s with p99 24 ms at pipeline 16; INCR 107,390 and 575,646/s; GET 819,796/s at pipeline 16. At Redis's default (boot 1) 144,000-155,000/s with p99 2.7-2.9 ms, and 620,000-839,000/s with p99 7-9 ms.
- **The mixed load is new, and it is where Redis's matched setting pays.** With `appendfsync always`, one SET per ten GETs makes the GETs wait for the SET's fsync: the mix runs 19-34 % below the pure GET rate and a GET's p50 rises 27-53 %. Without fsync the mix costs nothing. On E-45's gateway, held GETs answered in 1.3 ms beside 121-ms SETs at pipeline 1.
- **memtier drives fero's API end to end:** every row on E-45's RESP gateway over the E-22 simulator, 9.2 million requests, 0 errors, every GET a hit. The simulator is 6-54 × below Redis, which is a simulator's speed, not fero's. It also needed an 8 GB heap: it keeps every verb in memory and ran out of Node's default heap at GET pipeline 16.

## Method

- **The tool:** memtier_benchmark 2.5.2 (`$SP/opt/memtier/bin/memtier_benchmark`, `--version`: `v=2.5.2 ... libevent=2.1.12-stable`), the binary of Redis Ltd.'s official image `redislabs/memtier_benchmark:2.5.2` (layer sha256 `6aef4ecc…ea41`, binary sha256 `d8d87a6d…4262`; [fetch.sh](fetch.sh)). The user allowed it on 2026-11-06: "allow Redpanda, memtier_benchmark and LazyFS and anything else you need". This time it ran; nothing was refused.
- **The servers:** E-09a's three setups, copied verbatim into [bench.py](bench.py) (`SETUPS`): `default` (one Redis 7.0.15 as shipped: no config file, RDB on, `appendonly no`), `aof` (`appendonly yes, appendfsync always`, PERF-02's matched setting) and `aof-r3` (the same plus two replicas, each also fsync always; replication is asynchronous). A new server and data folder per run, deleted after it. Only the ports differ (36479-36481, so this never meets E-09a's).
- **PERF-02's shape:** `--threads=4 --clients=50` (200 connections), `--data-size=100`, keys uniform at random over 1..100,000 (`--key-pattern=R:R`, `--distinct-client-seed` so the 200 clients do not walk the same key sequence), `--pipeline=1` and `16`, `--test-time=20`. Tests: SET (`--ratio=1:0`), GET (`--ratio=0:1`), INCR (`--command="incr __key__"` on keys `counter:N`, apart from the 100-byte keys, as redis-benchmark's INCR uses `counter:` keys), and the **mixed load** MIX (`--ratio=1:10`: one SET per ten GETs, memtier's own default ratio). As in E-09a, `aof-r3` has no GET row (a GET touches neither the AOF nor the replicas; the `aof` rows cover it).
- **Fill:** before every Redis run, memtier writes all 100,000 keys once (`--key-pattern=P:P --requests=allkeys --pipeline=64`, not measured), so every GET hits (memtier counts hits and misses: the hit ratio was 1.0000 in every GET and MIX run). E-09a's redis-benchmark fill (300,000 random SETs) covered about 95 % of the keys (reasoned: 1 − e⁻³).
- **Recorded per run:** memtier's JSON (ops/s, average, p50, p90, p99, p99.9, p99.99, max, per command, and per second), its **HdrHistogram** log of the whole run (`--hdr-file-prefix`; the `.hgrm` files in [results/hdr/](results/hdr) hold each run's full histogram as one compressed line, readable with any HdrHistogram log reader), the CPU of every Redis process (from `/proc/<pid>/stat`), memtier's CPU, the box's busy cores, and `/proc/loadavg` before the run. The 1-second counts give "1-s min ops", the slowest whole second of the run: a stall shows there.
- **Same-hold controls:** E-09a's numbers were taken on 2026-11-06 at a different load. So each hold also runs E-09a's exact redis-benchmark command (same fill, same `-n` from E-09a's [nreq.json](nreq.json)) on every E-09a row of the setup it times (GET, SET and INCR at both depths; `aof-r3` has no GET row; `b2` repeats SET at both depths and GET at pipeline 16), named `*-rb`, and once more on the prototype (SET at both depths). A difference between memtier and redis-benchmark that the controls also show against E-09a is the box, not the tool.
- **Holds:** eight timing holds under `$SP/bin/timing`, each 2-18 minutes, so the lock is never held near 30 minutes: `default` (its memtier rows and SET controls), `aof`, `default2` (the default setup's GET and INCR controls, then probe 1), `r3`, `b2`, `proto` (stopped by the prototype's heap, section 5), `probe2` and `proto8g`. Inside a hold the runs go round-robin: run 1 of every config, then run 2, then run 3, so a slow drift of the box lands on every row alike. Every line of the holds is in [results/timing-log.txt](results/timing-log.txt). **The container restarted twice**, so the holds ran on three boots of the VM ([results/env.txt](results/env.txt)): boot 1 (kernel build `fc-v300`) ran `default`, `aof` and `default2`; boot 2 (booted 04:48 UTC, same build) ran `r3`; boot 3 (booted 05:21 UTC, build `fc-v310`) ran `b2`, `proto`, `probe2` and `proto8g`. The load average before each run is in every line of the timing log; the 1-minute load was 1.2-4.1 before every run but the first three of `proto8g` (6.0, 5.0 and 4.6: the average still decaying from other agents' heavy jobs, which had ended when the hold began; and round 1 of those rows was not slower than rounds 2 and 3: SET at pipeline 1 gave 6,775, then 6,358 and 6,477). The bridge hold `b2` runs `aof`'s matched rows (with three redis-benchmark controls) and `aof-r3`'s six memtier rows again on boot 3, so `aof` and `aof-r3` meet on one boot and each boot can be compared with another on the same command. Probe 2 repeats six pipeline-16 rows of boot 1 once each. The first run of every row is kept as it is; nothing finished was run again under the same name.
- **Open or closed loop.** Both tools are closed loop: a connection sends a new request only when a reply frees a slot. Neither corrects for coordinated omission (a request that would have been sent during a stall is not counted as waiting). This holds for both tools alike, so it does not bias the comparison, but every latency here is a closed-loop latency.
- **The prototype rows (`proto8g-*`, and the stopped `proto-*`):** E-45's host ([host.ts](../E45-drivers/host.ts)) with its RESP gateway ([lib/resp.ts](../E45-drivers/lib/resp.ts)), unchanged: one Node 22 process holding E-22's simulated world (three servers, virtual time, a simulated fsync) at the resource's default `persisted` rung, the gateway inside server `s1`. memtier drives it with exactly the Redis commands above. Fill: only before GET and MIX (filling 100,000 rows in the simulator takes 10-15 s; SET and INCR do not need it). The one change to E-45's command is Node's heap: `proto8g` runs the host as `node --max-old-space-size=8192 ...`, because the simulator keeps every verb in memory and the first hold (`proto`, the default heap of about 2 GB) ran out of it (section 5, point 5). "server cores" for these rows is the host process: gateway, three simulated servers and the simulator together. These rows measure **a simulator behind a gateway, not a fero kernel**.
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

## Results

All measured here, medians of 3 runs, range in brackets, latency in ms. Full tables: [results/tables.md](results/tables.md) (every row, the CPU columns, the probes, the boot-to-boot rows), [results/tails.md](results/tails.md) (where in a run the tail sits). Each run's one-line result: [results/timing-log.txt](results/timing-log.txt); each run's memtier output: [results/raw/](results/raw); each run's HdrHistogram: [results/hdr/](results/hdr).

### 1. memtier on Redis, PERF-02's shape

"Redis cores" = CPU of all Redis processes (the primary and, in `aof-r3`, both replicas); "memtier cores" = the load tool's CPU. 200 connections throughout. "boot" = which boot of the VM the row ran on (see Method, Holds); compare rows across boots only with care (section 3, point 6).

| setup | test | pipeline | boot | ops/s | p50 | p99 | p99.9 | max | Redis cores | memtier cores |
|---|---|---|---|---|---|---|---|---|---|---|
| default | SET | 1 | 1 | 144,076 (138,101-146,757) | 1.271 | 2.879 | 5.727 | 28.5 | 0.94 | 1.30 |
| default | SET | 16 | 1 | 620,157 (589,898-636,947) | 5.055 | 9.343 | 17.663 | 41.7 | 0.94 | 0.84 |
| default | GET | 1 | 1 | 144,680 (127,154-146,000) | 1.271 | 2.847 | 5.055 | 33.8 | 0.98 | 1.38 |
| default | GET | 16 | 1 | 690,181 (684,334-722,826) | 4.639 | 8.159 | 10.751 | 36.9 | 0.94 | 0.83 |
| default | INCR | 1 | 1 | 155,283 (153,128-155,301) | 1.199 | 2.719 | 5.663 | 28.8 | 0.94 | 1.35 |
| default | INCR | 16 | 1 | 838,775 (787,124-840,279) | 3.775 | 7.007 | 12.735 | 26.9 | 0.94 | 0.95 |
| default | MIX 1:10 | 1 | 1 | 144,054 (141,387-147,861) | 1.279 | 2.847 | 4.927 | 30.2 | 0.94 | 1.31 |
| default | MIX 1:10 | 16 | 1 | 668,943 (652,523-674,850) | 4.703 | 8.511 | 13.503 | 39.7 | 0.97 | 0.82 |
| aof | SET | 1 | 1 | 86,520 (75,555-87,791) | 2.047 | 4.863 | 9.535 | 48.9 | 0.74 | 0.85 |
| aof | SET | 16 | 1 | 317,820 (316,863-325,850) | 9.599 | 28.159 | 41.983 | 47.6 | 0.79 | 0.47 |
| aof | GET | 1 | 1 | 145,873 (144,106-148,369) | 1.255 | 2.927 | 5.471 | 26.0 | 0.94 | 1.30 |
| aof | GET | 16 | 1 | 604,260 (587,184-635,278) | 5.279 | 9.535 | 12.543 | 34.6 | 0.93 | 0.74 |
| aof | INCR | 1 | 1 | 98,031 (95,005-99,020) | 1.847 | 4.383 | 8.959 | 43.5 | 0.75 | 0.96 |
| aof | INCR | 16 | 1 | 468,768 (468,754-478,011) | 6.783 | 12.159 | 36.351 | 48.4 | 0.80 | 0.58 |
| aof | MIX 1:10 | 1 | 1 | 101,047 (98,292-101,221) | 1.799 | 4.063 | 6.431 | 35.3 | 0.76 | 0.96 |
| aof | MIX 1:10 | 16 | 1 | 489,158 (470,598-511,676) | 6.687 | 10.879 | 26.495 | 44.3 | 0.81 | 0.61 |
| aof-r3 | SET | 1 | 2 | 106,389 (90,122-108,010) | 1.615 | 4.447 | 31.743 | 88.6 | 1.21 | 0.79 |
| aof-r3 | SET | 16 | 2 | 330,829 (323,028-353,447) | 8.767 | 37.375 | 51.711 | 64.8 | 1.78 | 0.41 |
| aof-r3 | INCR | 1 | 2 | 121,830 (116,101-128,195) | 1.463 | 3.391 | 8.575 | 70.1 | 1.20 | 0.89 |
| aof-r3 | INCR | 16 | 2 | 540,088 (501,874-540,652) | 5.631 | 14.079 | 44.287 | 72.2 | 1.95 | 0.54 |
| aof-r3 | MIX 1:10 | 1 | 2 | 134,431 (126,152-136,732) | 1.351 | 2.911 | 5.375 | 31.6 | 0.98 | 0.99 |
| aof-r3 | MIX 1:10 | 16 | 2 | 731,879 (706,547-770,418) | 4.351 | 7.999 | 36.607 | 80.4 | 1.16 | 0.77 |
| aof | SET | 1 | 3 | 91,609 (83,443-94,816) | 1.991 | 4.895 | 10.367 | 51.5 | 0.72 | 0.88 |
| aof | SET | 16 | 3 | 379,300 (378,560-386,580) | 7.999 | 23.807 | 39.679 | 50.4 | 0.76 | 0.48 |
| aof | GET | 16 | 3 | 819,796 (716,159-825,375) | 3.823 | 7.423 | 12.479 | 37.9 | 0.98 | 0.85 |
| aof | INCR | 1 | 3 | 107,390 (101,578-107,751) | 1.663 | 4.223 | 9.279 | 44.5 | 0.73 | 0.93 |
| aof | INCR | 16 | 3 | 575,646 (516,297-576,326) | 5.503 | 11.199 | 32.639 | 40.7 | 0.79 | 0.60 |
| aof | MIX 1:10 | 1 | 3 | 104,964 (104,482-116,103) | 1.743 | 4.255 | 7.103 | 47.9 | 0.75 | 0.97 |
| aof | MIX 1:10 | 16 | 3 | 581,169 (527,207-606,987) | 5.471 | 9.919 | 27.519 | 46.3 | 0.80 | 0.66 |
| aof-r3 | SET | 1 | 3 | 81,966 (81,016-82,690) | 2.159 | 5.695 | 29.183 | 81.9 | 1.21 | 0.75 |
| aof-r3 | SET | 16 | 3 | 284,930 (283,339-302,953) | 10.175 | 39.167 | 52.223 | 63.5 | 1.76 | 0.38 |
| aof-r3 | INCR | 1 | 3 | 94,923 (86,253-102,809) | 1.879 | 4.767 | 10.175 | 52.5 | 1.17 | 0.85 |
| aof-r3 | INCR | 16 | 3 | 430,014 (384,209-464,365) | 6.975 | 17.279 | 54.015 | 75.8 | 1.94 | 0.48 |
| aof-r3 | MIX 1:10 | 1 | 3 | 108,943 (97,563-110,052) | 1.671 | 3.919 | 6.719 | 29.8 | 0.98 | 0.93 |
| aof-r3 | MIX 1:10 | 16 | 3 | 537,735 (464,668-563,889) | 5.855 | 10.943 | 39.167 | 86.0 | 1.11 | 0.61 |

**On one boot, the replicas cost what E-09a found.** On boot 3, `aof-r3` against `aof`, run k against run k: 0.88 (0.87-0.98) for SET and 0.88 (0.85-0.95) for INCR at pipeline 1, 0.75 (0.73-0.81) for both at pipeline 16, and 0.95 and 0.89 for the mixed load (E-09a with redis-benchmark: 0.85 and 0.72 for SET). On boot 2, `aof-r3` had run faster than boot 1's `aof` (106,389 against 86,520 SETs/s), which a setup with more work cannot do on the same box: that was the box (section 3, point 6). The third run of the `b2` hold was slower on most rows (for example `aof-r3` INCR at pipeline 16: 464,365, then 430,014, then 384,209); the round-robin order puts that drift on every row alike.

- **Every GET hit** (memtier's hit ratio was 1.0000 in every GET and MIX run), and memtier reported no connection errors.
- **CPU per request** (the primary Redis's CPU ÷ requests): 6.3-7.0 µs at pipeline 1 and 1.2-1.6 µs at pipeline 16 on `default`; 8.0-9.3 µs and 1.8-2.6 µs for SET and INCR on `aof`, where the AOF write and fsync add work. memtier itself spent 8.9-10.8 µs per request at pipeline 1 and 1.2-1.5 µs at pipeline 16 on boot 1, so on this box the client costs more CPU than the server at pipeline 1.
- **Latency at a fixed depth is set by throughput.** Both tools keep a fixed number of requests in flight (200, or 3,200 at pipeline 16), so by Little's law the mean latency is in-flight ÷ ops/s. memtier's mean is 0.998-1.000 of that in every run (for example 3,200 ÷ 620,157/s = 5.16 ms, memtier's mean 5.15 ms). So the p50 column says little that ops/s does not; the tail columns (p99, p99.9) are the new information.

### 2. The mixed load: one SET per ten GETs

| setup, pipeline, boot | GETs/s in the mix | SETs/s in the mix | total | pure GET run | GET p50 in the mix / pure | GET p99 in the mix / pure |
|---|---|---|---|---|---|---|
| default, 1, boot 1 | 130,954 | 13,100 | 144,054 | 144,680 | 1.279 / 1.271 | 2.847 / 2.847 |
| default, 16, boot 1 | 608,125 | 60,818 | 668,943 | 690,181 | 4.703 / 4.639 | 8.511 / 8.159 |
| aof, 1, boot 1 | 91,856 | 9,190 | 101,047 | 145,873 | **1.799 / 1.255** | **4.063 / 2.927** |
| aof, 16, boot 1 | 444,685 | 44,474 | 489,158 | 604,260 | **6.687 / 5.279** | 10.879 / 9.535 |
| aof, 1, boot 3 | 95,417 | 9,547 | 104,964 | - | 1.743 / - | 4.255 / - |
| aof, 16, boot 3 | 528,331 | 52,838 | 581,169 | 819,796 | **5.471 / 3.823** | **9.919 / 7.423** |
| aof-r3, 1, boot 2 | 122,206 | 12,225 | 134,431 | - | 1.351 / - | 2.911 / - |
| aof-r3, 16, boot 2 | 665,341 | 66,539 | 731,879 | - | 4.351 / - | 7.999 / - |
| aof-r3, 1, boot 3 | 99,034 | 9,908 | 108,943 | - | 1.671 / - | 3.919 / - |
| aof-r3, 16, boot 3 | 488,846 | 48,889 | 537,735 | 819,796 (`aof`) | **5.855 / 3.823** | **10.943 / 7.423** |

- **Without fsync, the mix costs nothing:** on `default` the mixed load runs at the pure GET rate (0-3 % lower), with the same GET latency.
- **With `appendfsync always`, ten GETs pay for one SET's fsync.** On `aof` (boot 1) the mixed load is 31 % below the pure GET rate at pipeline 1 (19 % at pipeline 16), and a GET's p50 rises from 1.26 to 1.80 ms (+43 %). On boot 3, at pipeline 16, it is 29 % below with a GET p50 43 % higher on `aof`, and 34 % below with a GET p50 53 % higher on `aof-r3`. The reason is in Redis's source (cited, [server.c of 7.0.15](https://github.com/redis/redis/blob/7.0.15/src/server.c), `beforeSleep`): before it sleeps, each pass of the event loop first writes and fsyncs the AOF (`flushAppendOnlyFile`), and only then sends every reply of that pass (`handleClientsWithPendingWritesUsingThreads`). So a GET answered in a pass that also held a SET waits for that SET's fsync. At 9,190 SETs/s nearly every pass holds one.
- **What this means for fero (reasoned).** A fero held-row read is answered from the process's own copy and does not wait for any fsync (PERF-10), and a `persisted` write waits for its own commit only. So the mixed row is where fero's design is furthest ahead of Redis's matched setting, and PERF-02 does not measure it today: PERF-02 names GET, SET and INCR alone.

### 3. memtier against redis-benchmark, row by row

"rb here" is E-09a's exact redis-benchmark command, run in the same hold as the memtier rows (for `default` GET and INCR, in the `default2` hold an hour later). "paired" is memtier run k ÷ redis-benchmark run k, minutes apart: median and range of the three. "agree" uses PERF-01's spread rule: the medians differ by no more than the larger range of the two. "E-09a" is redis-benchmark in E-09a, on 2026-11-06.

| row (boot) | memtier ops/s | rb here ops/s | paired | agree? | memtier p50 / p99 | rb here p50 / p99 | E-09a rb ops/s | memtier ÷ E-09a |
|---|---|---|---|---|---|---|---|---|
| default SET 1 (1) | 144,076 | 140,513 | 1.01 (1.00-1.03) | yes | 1.27 / 2.88 | 1.24 / 2.69 | 140,584 | 1.02 |
| default SET 16 (1) | 620,157 | 629,756 | 0.98 (0.94-1.01) | yes | 5.05 / 9.34 | 4.97 / 8.81 | 811,908 | 0.76 |
| default GET 1 (1) | 144,680 | 139,243 | 1.03 (0.91-1.09) | yes | 1.27 / 2.85 | 1.25 / 2.81 | 144,439 | 1.00 |
| default GET 16 (1) | 690,181 | 671,892 | 1.03 (0.97-1.09) | yes | 4.64 / 8.16 | 4.64 / 8.00 | 867,002 | 0.80 |
| default INCR 1 (1) | 155,283 | 149,693 | 1.02 (1.02-1.05) | no (+4 %) | 1.20 / 2.72 | 1.17 / 2.63 | 149,701 | 1.04 |
| default INCR 16 (1) | 838,775 | 843,170 | 0.98 (0.93-1.00) | yes | 3.77 / 7.01 | 3.61 / 6.46 | 934,288 | 0.90 |
| aof SET 1 (1) | 86,520 | 83,998 | 1.04 (0.90-1.06) | yes | 2.05 / 4.86 | 2.01 / 4.92 | 88,643 | 0.98 |
| aof SET 16 (1) | 317,820 | 318,979 | 0.99 (0.98-1.02) | yes | 9.60 / 28.16 | 9.57 / 29.93 | 362,450 | 0.88 |
| aof GET 1 (1) | 145,873 | 141,024 | 1.04 (1.03-1.05) | no (+3 %) | 1.25 / 2.93 | 1.24 / 2.84 | 139,243 | 1.05 |
| aof GET 16 (1) | 604,260 | 695,604 | 0.86 (0.84-0.95) | **no (−13 %)** | 5.28 / 9.54 | 4.41 / 7.83 | 854,798 | 0.71 |
| aof INCR 1 (1) | 98,031 | 93,886 | 1.02 (1.01-1.04) | no (+4 %) | 1.85 / 4.38 | 1.80 / 4.33 | 102,973 | 0.95 |
| aof INCR 16 (1) | 468,768 | 498,753 | 0.94 (0.94-0.99) | no (−6 %) | 6.78 / 12.16 | 6.30 / 13.09 | 569,395 | 0.82 |
| aof-r3 SET 1 (2) | 106,389 | 99,744 | 1.07 (0.90-1.08) | yes | 1.61 / 4.45 | 1.61 / 4.70 | 75,464 | 1.41 |
| aof-r3 SET 16 (2) | 330,829 | 323,102 | 1.05 (1.00-1.09) | yes | 8.77 / 37.38 | 8.74 / 35.42 | 259,875 | 1.27 |
| aof-r3 INCR 1 (2) | 121,830 | 116,376 | 1.05 (1.04-1.10) | yes | 1.46 / 3.39 | 1.45 / 3.62 | 90,090 | 1.35 |
| aof-r3 INCR 16 (2) | 540,088 | 519,931 | 0.99 (0.97-1.08) | yes | 5.63 / 14.08 | 5.57 / 16.14 | 332,005 | 1.63 |
| aof SET 1 (3) | 91,609 | 88,741 | 1.03 (0.92-1.07) | yes | 1.99 / 4.89 | 1.90 / 4.78 | 88,643 | 1.03 |
| aof SET 16 (3) | 379,300 | 379,579 | 1.00 (1.00-1.11) | yes | 8.00 / 23.81 | 7.84 / 24.88 | 362,450 | 1.05 |
| aof GET 16 (3) | 819,796 | 808,495 | 1.01 (0.87-1.02) | yes | 3.82 / 7.42 | 3.68 / 6.77 | 854,798 | 0.96 |
| aof INCR 1 (3) | 107,390 | - | - | - | 1.66 / 4.22 | - | 102,973 | 1.04 |
| aof INCR 16 (3) | 575,646 | - | - | - | 5.50 / 11.20 | - | 569,395 | 1.01 |
| aof-r3 SET 1 (3) | 81,966 | - | - | - | 2.16 / 5.70 | - | 75,464 | 1.09 |
| aof-r3 SET 16 (3) | 284,930 | - | - | - | 10.18 / 39.17 | - | 259,875 | 1.10 |
| aof-r3 INCR 1 (3) | 94,923 | - | - | - | 1.88 / 4.77 | - | 90,090 | 1.05 |
| aof-r3 INCR 16 (3) | 430,014 | - | - | - | 6.97 / 17.28 | - | 332,005 (315,000-412,000) | 1.30 |

**What agrees, and why the rest differs:**

1. **At pipeline 1 the two tools agree to within 7 %.** In all 9 same-hold pairs memtier reads 1-7 % higher (paired medians 1.01-1.07). By the spread rule that is "agree" on 6 rows and a small, steady "no" on 3, where both tools' ranges are tight. Redis spent 0-5 % less CPU per request under memtier (for example 6.33-6.43 µs against 6.51-6.63 µs on `default` INCR), which matches; this was measured, not traced to a cause (the keys and commands differ slightly: `memtier-N` against `key:000000NNNNNN`). p50 and p99 agree to within 0.25 ms.
2. **At pipeline 16 they agree on 8 of 10 same-hold pairs** (paired medians 0.98-1.05). The two that did not were on boot 1: `aof` GET (memtier 13 % lower by the medians, 14 % run beside run) and `aof` INCR (6 % lower); probe 1, also on boot 1, had memtier 5-8 % lower on three `default` rows (one run each). The `aof` GET gap did not come back on boot 3 (paired 1.01, 0.87-1.02). In the boot-1 pipeline-16 runs Redis sat at 0.88-0.98 of a core under memtier (mostly 0.93-0.94) against 0.97-0.98 under redis-benchmark, so **Redis waited for requests 2-8 % of the time**, though both tools fed it exactly 16.0 commands per read syscall (probe 1). Probe 2 (boot 3, one run each) looked for the cause, and found three things. **Redis did not lack a CPU:** its run-queue wait (time ready to run but not running) was 0.10-0.30 s of a 21-s run under memtier (at most 1.4 %) and under 0.01 s under redis-benchmark. **memtier's own speed sets the feed:** with fewer memtier threads the run-queue wait fell to 0.003 s, yet memtier got slower, not faster (GET: 4 threads 795,686/s, 2 threads 782,584/s, 1 thread 730,942/s). **Each request cost Redis more under memtier:** 5-11 % more CPU per request at pipeline 16 (probe 2: 1.02-1.38 µs against 0.92-1.26 µs; probe 1: 1.22-1.68 against 1.14-1.61), with the same 16.0 commands per read; this was measured, not traced to a cause. In probe 2 memtier read 4-11 % lower on all three `default` rows. So at pipeline 16, where Redis sits at its one-core limit under both tools, memtier keeps Redis busy a few percent less of the time and makes each request cost a few percent more, and reads the same or up to 14 % lower: across all 16 pipeline-16 comparisons (10 timed pairs, 6 probe pairs) memtier was never more than 5 % higher. The rule that follows: compare fero with Redis under the same tool, never memtier's fero against redis-benchmark's Redis.
3. **redis-benchmark's latency reads 2-7 % low, by construction.** In every redis-benchmark run the mean latency is 0.931-0.976 of in-flight ÷ ops/s (Little's law); in every memtier run it is 0.998-1.000. The source says why (cited, [redis-benchmark.c of 7.0.15](https://github.com/redis/redis/blob/7.0.15/src/redis-benchmark.c)): after a batch's replies, redis-benchmark only registers a write event (`resetClient`, line 412), and its clock starts later, inside `writeHandler` (line 618); the wait for that event is not counted. memtier stamps the next request inside the read callback that parsed the reply. So **memtier's latencies are the honest ones**, and fero's rows must be read with the same tool as the Redis rows they are compared with.
4. **redis-benchmark's batch timing does not bite on Redis.** redis-benchmark gives all 16 replies of a batch the time of the first (`readHandler`, line 496). On Redis that changes little, because Redis answers the 16 commands of a read in one pass: p50 at pipeline 16 agrees between the tools within the 2-7 % of point 3 (for example 4.64 and 4.64 ms on `default` GET). It would matter against a server that answers a batch in pieces, such as a gateway that answers each command when its own commit lands (section 5).
5. **memtier's p99.9 and max are higher, from a few seconds of the run, not from every second.** On `default`, memtier's whole-run p99.9 was 4.9-17.7 ms against redis-benchmark's 3.9-12.4 ms, and its max 27-42 ms against 10-22 ms. memtier also records each second's percentiles ([results/tails.md](results/tails.md)): the median second's p99.9 was 3.6-4.4 ms at pipeline 1 on `default`, the same as redis-benchmark's whole-run p99.9, and on `default` the max fell in the first second (when 200 connections open at once) in 18 of 24 runs. On the SET and INCR rows of `aof` and `aof-r3` the max fell mid-run in every run: the disk's stalls, as E-09a saw. So the max column is a start-up effect on `default` and a disk effect with fsync, and p99 is the column to compare.
6. **The box moved more between boots than the tools differ.** The same command, same binary, gave very different numbers on the three boots of the VM ([tables.md](results/tables.md), "The same row on another boot"): boot 3 against boot 1 on `aof`, +4 % to +36 % (pipeline 16: SET +19 %, INCR +23 %, GET +36 % with memtier, +16 % with redis-benchmark); boot 3 against boot 2 on `aof-r3`, −14 % to −27 %. Boot 2 was faster at CPU work too, not only at fsync: memtier spent 7.6-8.8 µs per request at pipeline 1 there, against 8.9-10.8 µs on boot 1. Boot 3 came closest to E-09a's day (memtier within −4 % to +10 % of E-09a's redis-benchmark on 8 of 9 rows), boot 1 was 10-29 % below E-09a at pipeline 16 with memtier and 10-23 % below with the same redis-benchmark command. Probe 2 ran the `default` pipeline-16 rows on boot 3: redis-benchmark gave 831,624 GETs/s, 784,570 SETs/s and 1,068,224 INCRs/s, 24-27 % above boot 1's medians and 0.96-1.14 of E-09a's; memtier gave 14-15 % above boot 1. **So a bar number is only good for the hold it was measured in,** and every tool comparison above is made inside one hold, run k beside run k.

### 4. Probes: how each tool feeds Redis

One run each, not timed rows (they ran inside a timing hold). "commands per read" = requests ÷ the primary Redis's read syscalls (`/proc/<pid>/io`); "Redis µs/request" = the primary's CPU ÷ requests; "run-queue wait" = how long the primary waited for a CPU (`/proc/<pid>/schedstat`, probe 2 only). Probe 1 ran on boot 1 (hold `default2`), probe 2 on boot 3.

| probe (boot) | row | tool | threads x connections | ops/s | p99 | commands per read | Redis cores | Redis µs/request | run-queue wait, s | memtier or rb cores |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 (1) | default-set-p1 | memtier | 4 x 50 | 138,072 | 3.07 | 1.0 | 0.94 | 7.15 | - | 1.33 |
| 1 (1) | default-set-p1 | redis-benchmark | 4 x 50 | 133,191 | 2.94 | 1.0 | 0.98 | 7.42 | - | 1.31 |
| 1 (1) | default-set-p16 | memtier | 4 x 50 | 583,143 | 9.60 | 16.0 | 0.98 | 1.68 | - | 0.81 |
| 1 (1) | default-set-p16 | redis-benchmark | 4 x 50 | 613,466 | 9.08 | 16.0 | 0.98 | 1.61 | - | 0.66 |
| 1 (1) | default-get-p16 | memtier | 4 x 50 | 641,463 | 8.96 | 16.0 | 0.92 | 1.52 | - | 0.74 |
| 1 (1) | default-get-p16 | redis-benchmark | 4 x 50 | 696,314 | 7.55 | 16.0 | 0.98 | 1.42 | - | 0.76 |
| 1 (1) | default-incr-p16 | memtier | 4 x 50 | 801,155 | 7.71 | 16.0 | 0.93 | 1.22 | - | 0.91 |
| 1 (1) | default-incr-p16 | redis-benchmark | 4 x 50 | 866,401 | 5.68 | 16.0 | 0.98 | 1.14 | - | 0.90 |
| 2 (3) | default-get-p16 | memtier | 4 x 50 | 795,686 | 7.87 | 16.0 | 0.94 | 1.24 | 0.101 | 0.85 |
| 2 (3) | default-get-p16 | redis-benchmark | 4 x 50 | 831,624 | 7.21 | 16.0 | 0.97 | 1.17 | 0.010 | 0.81 |
| 2 (3) | default-get-p16 | memtier | 2 x 100 | 782,584 | 7.10 | 16.0 | 0.93 | 1.26 | 0.003 | 0.83 |
| 2 (3) | default-get-p16 | memtier | 1 x 200 | 730,942 | 8.26 | 16.0 | 0.92 | 1.32 | 0.004 | 0.72 |
| 2 (3) | default-set-p16 | memtier | 4 x 50 | 707,734 | 8.45 | 16.0 | 0.93 | 1.38 | 0.203 | 0.88 |
| 2 (3) | default-set-p16 | redis-benchmark | 4 x 50 | 784,570 | 7.54 | 16.0 | 0.98 | 1.26 | 0.006 | 0.76 |
| 2 (3) | default-incr-p16 | memtier | 4 x 50 | 952,765 | 6.78 | 16.0 | 0.92 | 1.02 | 0.295 | 0.99 |
| 2 (3) | default-incr-p16 | redis-benchmark | 4 x 50 | 1,068,224 | 5.46 | 16.0 | 0.97 | 0.92 | 0.003 | 0.98 |

Reading the probes: both tools hand Redis exactly 1.0 command per read at pipeline 1 and 16.0 at pipeline 16, so they batch alike. At pipeline 1 Redis spent 4 % less CPU per request under memtier (7.15 against 7.42 µs), at pipeline 16 5-11 % more. Redis waited for a CPU at most 1.4 % of a run. Fewer memtier threads lowered throughput (section 3, point 2).

### 5. The prototype behind E-45's RESP gateway (a simulator, not a fero kernel)

These rows measure E-22's simulator (three simulated servers in one Node 22 process, virtual time, a simulated fsync, and every verb kept in memory for the checkers) behind E-45's RESP gateway, at the resource's default `persisted` rung, on boot 3, with an 8 GB Node heap (`proto8g`; why in point 5). **They are not fero's speed.** They show that memtier drives fero's API end to end, how the two tools read a server that answers a batch in pieces, and how a simulator behaves under load. "host cores" = the one host process: gateway, three simulated servers and the simulator together.

| test | pipeline | tool | ops/s | p50 | p99 | p99.9 | max | host cores | Redis `aof`, same test, ops/s (boot) |
|---|---|---|---|---|---|---|---|---|---|
| SET | 1 | memtier | 6,477 (6,358-6,775) | 27.3 | 78.3 | 495.6 | 522 | 1.23 | 91,609 (3) |
| SET | 16 | memtier | 10,744 (10,569-11,421) | 292.9 | 761.9 | 1,884 | 2,081 | 1.33 | 379,300 (3) |
| GET | 1 | memtier | 24,397 (23,869-24,660) | 6.94 | 19.6 | 120.8 | 590 | 1.16 | 145,873 (1) |
| GET | 16 | memtier | 44,314 (43,890-44,488) | 66.6 | 109.1 | 2,130 | 5,407 | 1.28 | 819,796 (3) |
| INCR | 1 | memtier | 6,128 (6,102-6,150) | 29.2 | 86.0 | 436.2 | 477 | 1.22 | 107,390 (3) |
| INCR | 16 | memtier | 10,613 (9,486-10,663) | 301.1 | 880.6 | 1,802 | 2,073 | 1.34 | 575,646 (3) |
| MIX 1:10 | 1 | memtier | 15,391 (14,458-15,462) | 1.37 | 179.2 | 246.8 | 631 | 1.15 | 104,964 (3) |
| MIX 1:10 | 16 | memtier | 26,171 (25,885-26,652) | 123.4 | 284.7 | 651.3 | 672 | 1.24 | 581,169 (3) |
| SET | 1 | redis-benchmark | 8,205 (7,979-8,209) | 22.4 | 53.1 | 78.2 | 89 | 1.29 | 88,741 (3) |
| SET | 16 | redis-benchmark | 13,280 (12,872-13,702) | 196.2 | 327.9 | 331.3 | 382 | 1.44 | 379,579 (3) |

1. **memtier drives fero's API end to end.** Every row ran 3 times: 9.2 million requests through the gateway, 0 gateway errors, 0 connection errors, and every GET hit (hit ratio 1.0000). The simulator sits 6-54 × below Redis's matched rows; that is a simulator's speed and says nothing about a fero kernel (E-45, E-22).
2. **On the gateway, redis-benchmark's pipeline-16 latency reads 18-19 % low.** redis-benchmark's mean was 0.81-0.82 of in-flight ÷ ops/s at pipeline 16 (0.97-0.99 at pipeline 1); memtier's was 0.99-1.00 in every run. This is section 3's point 4 coming true: redis-benchmark gives all 16 replies of a batch the time of the first, and unlike Redis the gateway answers a batch in pieces, each reply when its own commit lands. So p50 at pipeline 16 reads 196 ms with redis-benchmark against 293 ms with memtier on the same server. **fero's PERF-02 latencies must come from memtier**; redis-benchmark under-reads a gateway several times more than it under-reads Redis (2-7 %).
3. **memtier reads 18-21 % fewer ops/s than redis-benchmark here (paired 0.79 and 0.82), and that is run length.** The simulator slows as its kept history grows: memtier SET at pipeline 1, run 2, answered 9,779 requests in its first second and 4,290 in its twentieth, while the host's memory rose from 0.5 to 1.4 GB. redis-benchmark's fixed 70,000 or 110,000 requests end after about 8.5 s, before the slow part. A fero kernel compacts its log and must not slow with its history; a simulator that keeps every verb does (reasoned from the per-second counts in [results/persec.jsonl](results/persec.jsonl) and the host lines in [results/raw/](results/raw)).
4. **A held read does not wait for a write at pipeline 1.** In the mixed load at pipeline 1, a GET's p50 was 1.27 ms and a SET's 121 ms: the gateway answers a GET from s1's held copy without waiting for any commit, which is the opposite of Redis's `aof` mix (section 2). At pipeline 16 GETs wait behind earlier SETs of the same connection (GET p50 118 ms, SET 164 ms), because RESP sends replies in request order on a connection and the gateway keeps that order (`InOrder` in E-45's [lib/common.ts](../E45-drivers/lib/common.ts)). That ordering is RESP's, not fero's, so a mixed row at pipeline 16 ties reads to writes in any RESP server (reasoned).
5. **Node's default heap was not enough.** The first prototype hold (`proto`, the default heap: about 2 GB here) ran SET at pipeline 1 and 16 and GET at pipeline 1 once each (6,632, 11,721 and 23,543 per s, within 9 % of the `proto8g` medians; the GET run ended with the host at 2,040 MB), then GET at pipeline 16 ran out of heap: memtier got no reply in 21.8 s ([results/raw/proto-get-p16-1-failed.txt](results/raw/proto-get-p16-1-failed.txt)). The memory is the simulator's kept history (2.5-10 KB per verb, from the host's own lines: more for a SET than for a GET). That hold was not resumed; `proto8g` ran every prototype row again with `node --max-old-space-size=8192`, the one change to E-45's host command. Its rows are the ones above.

### 6. PERF-02's bar, stated from memtier

The bar for a fero row is the Redis row **run with memtier in the same hold**, round-robin with fero's own runs (section 3, point 6). As measured here, it reads (median of 3, ops/s, then p99 in ms):

| row | pipeline 1 | pipeline 16 | boot |
|---|---|---|---|
| default SET | 144,076, 2.88 | 620,157, 9.34 | 1 |
| default GET | 144,680, 2.85 | 690,181, 8.16 | 1 |
| default INCR | 155,283, 2.72 | 838,775, 7.01 | 1 |
| default SET / GET / INCR (probe 2, one run each) | - | 707,734 / 795,686 / 952,765; 6.8-8.4 | 3 |
| matched (`aof`) SET | 86,520, 4.86 / 91,609, 4.90 | 317,820, 28.2 / 379,300, 23.8 | 1 / 3 |
| matched GET | 145,873, 2.93 | 604,260, 9.54 / 819,796, 7.42 | 1 / 3 |
| matched INCR | 98,031, 4.38 / 107,390, 4.22 | 468,768, 12.2 / 575,646, 11.2 | 1 / 3 |
| matched MIX 1:10 | 101,047, 4.06 / 104,964, 4.26 | 489,158, 10.9 / 581,169, 9.92 | 1 / 3 |
| matched with two async replicas (`aof-r3`) SET | 81,966, 5.70 | 284,930, 39.2 | 3 |
| `aof-r3` INCR | 94,923, 4.77 | 430,014, 17.3 | 3 |

What memtier changes against E-09a's redis-benchmark bar:
- **Throughput:** the same at pipeline 1 (memtier 1-7 % higher); the same or up to 14 % lower at pipeline 16. A fero row timed with memtier is compared with memtier's Redis row, so the gap between the tools cancels.
- **Latency:** memtier's mean and p50 are the true ones; redis-benchmark's are 2-7 % low on Redis and 18-19 % low on a gateway at pipeline 16. Take p99 from memtier. Ignore max and p99.9 on `default` (they come from the first second).
- **Against fero's own latency target (reasoned).** At pipeline 1 with 200 connections Redis's matched SET p99 is 4.9 ms on one server (INCR 4.2-4.4 ms), tighter than P-01's TS write bar of C + 5 ms = 5.7 ms (C from E-01), and 5.7 ms with two replicas, equal to it. In a closed loop the p99 at a fixed depth follows throughput (section 1), so a TS build that only meets P-01's bar does not yet win PERF-02's matched p99: it needs about 92,000 `persisted` SETs/s or more at 200 connections on this box (boot 3), with a tail no wider than Redis's.
- **The mixed row.** PERF-02 names GET, SET and INCR alone. With `appendfsync always`, Redis's mixed load runs 19-34 % below its pure GET rate, and a GET's p50 rises 27-53 % (section 2), and E-45's gateway answered held GETs in 1.27 ms at pipeline 1 while SETs took 121 ms (section 5). A 1:10 SET:GET row is where fero's design is furthest ahead, and PERF-02 does not measure it yet.

## What this box cannot show

- **The client on another machine.** memtier used 0.4-1.4 cores of the same 4 vCPUs that Redis used, and on boot 1 Redis waited for requests 2-8 % of the time under memtier at pipeline 16. With the client on its own machine both tools would likely feed Redis fully, and the boot-1 pipeline-16 gaps between them would likely close (reasoned). In a real deployment every request also pays a network round trip, which loopback does not show.
- **Redis with more than one core.** Redis serves commands on one thread here (`io-threads` is off by default); E-09a's note stands.
- **Independent disks.** In `aof-r3` the primary and both replicas fsync on the one virtual disk (E-01).
- **Open-loop latency.** Both tools are closed loop and neither corrects for coordinated omission, so a stall shows as fewer requests, not as long waits for requests that were never sent. memtier's `--rate-limiting` (a fixed rate per connection) would show the open-loop tail; it was not run, because PERF-02 names the closed-loop shape.
- **A stable box.** The same command moved by up to 36 % between boots of the VM within one day, and by up to 17 % from the first to the third round of one hold (section 1). Any bar here holds for its hold; fero's runs must be paired with Redis runs in the same hold.
- **Redis 7.2's `WAITAOF`**, the one Redis setting that matches fero's `persisted` (on disk at a majority): not in 7.0, as E-09a says.
- **A fero kernel.** The `proto8g-*` and `proto-*` rows measure E-22's simulator behind E-45's gateway, in one Node process, with virtual time. They show that memtier drives fero's API end to end, and what the gateway and simulator cost; they are not fero's speed.

## Files

- [bench.py](bench.py): the driver (`run`, `probe`, `smoke`, `table`, `tails`, `list`); E-09a's three setups copied verbatim in `SETUPS`; the `b2-*` rows are the same configs with `same_as` naming the first row.
- [run.sh](run.sh): `sh run.sh all` runs every timing hold in order and writes the tables; or one hold: `default`, `aof`, `default2`, `r3`, `b2`, `proto`, `probe2`, `proto8g`; `sh run.sh table` rebuilds `results/tables.md` and `results/tails.md`.
- [fetch.sh](fetch.sh): memtier 2.5.2 (the official image's layer and the binary, by sha256), Redis 7.0.15 (Ubuntu package), and the cited sources (redis-benchmark.c, server.c, aof.c of 7.0.15, by sha256).
- [nreq.json](nreq.json): requests per redis-benchmark control run (E-09a's values for every Redis row).
- [results/](results): `runs.jsonl` (one line per timed run), `probe.jsonl` (the probes), `tables.md`, `tails.md`, `persec.jsonl` (each memtier run's per-second count, p50, p99, p99.9 and max, from which `tails.md` is built), `timing-log.txt` (each run's line as it finished, and each hold's start, end, load and versions), `env.txt` (the machine, all three boots), `raw/` (each run's tool output, progress lines removed; the prototype host's lines at the end of its files; `proto-get-p16-1-failed.txt` is the run that ran out of heap), `hdr/` (each memtier run's HdrHistogram log, `.hgrm`, one compressed histogram per file: the whole run and each command). The full memtier JSON of each run stays in `$SP/e09a2/keep/` (about 27 KB a run).

## Verdict

memtier_benchmark, PERF-02's first-named tool, ran on all three of E-09a's Redis setups, with its HdrHistogram output, a mixed load, and E-45's gateway. The threshold is met: **memtier agrees with redis-benchmark within the spread at pipeline 1 and on 8 of 10 pipeline-16 pairs, and where it does not, the difference is explained** (Redis is fed a few percent less evenly and spends a few percent more CPU per request under memtier, so memtier reads up to 14 % lower at pipeline 16; redis-benchmark's latency reads low by construction). PERF-02's bar is now stated from memtier (section 6). Nothing here moves a candidate: E-09a's conclusions stand (every PERF-02 row sits below E-02's TS ceilings; the default pipeline-16 rows are the tight ones; winning Redis's default rows on p99 needs the `memory` rung). Four things should change in the requirements: run fero beside the competitor in one hold, round-robin, with the same tool (PERF-01), because the box itself moved by up to 36 % between boots; take PERF-02's latencies from memtier, never redis-benchmark, which under-reads a gateway by 18-19 % at pipeline 16; add a 1:10 SET:GET row to PERF-02, where Redis's matched setting makes GETs wait for fsync and fero's held reads do not; and note that P-01's TS write bar (C + 5 ms = 5.7 ms) is looser than Redis's matched SET p99 at 200 connections (4.9 ms), so meeting P-01 does not by itself win PERF-02's matched p99.

Q-09a (memtier): memtier_benchmark 2.5.2 at PERF-02's shape on Redis 7.0.15 (measured here, 3 runs each, HdrHistogram kept) agrees with redis-benchmark run beside it within 7 % at pipeline 1 and within the spread on 8 of 10 pipeline-16 pairs, and is otherwise up to 14 % lower at pipeline 16 (Redis busy 3-6 % less and 5-11 % more CPU per request under memtier, not a CPU shortage); redis-benchmark's latency reads 2-7 % low on Redis and 18-19 % low on a fero gateway at pipeline 16, memtier's matches Little's law; the box moved up to 36 % between three boots, so the bar is the memtier Redis row of the same hold, which here read SET 91,600/s p99 4.9 ms and 379,000/s p99 24 ms, INCR 107,000 and 576,000/s, GET 820,000/s at pipeline 16 (`appendfsync always`, boot 3), and 144,000-155,000/s p99 2.7-2.9 ms and 620,000-839,000/s p99 7-9 ms at the default (boot 1); a 1:10 SET:GET mix under `appendfsync always` costs Redis 19-34 % of its GET rate and 27-53 % on GET p50, while E-45's gateway answered held GETs in 1.3 ms beside 121-ms SETs; memtier drove every row through E-45's RESP gateway over the E-22 simulator with 0 errors (a simulator, 6-54 × below Redis, needing an 8 GB heap). Moves: no candidate up or down (E-09a's moves on PERF-02 stand); PERF-01 gains a same-hold, same-tool, round-robin rule; PERF-02 takes its latencies from memtier and gains a 1:10 mixed row; P-01's TS write bar is looser than PERF-02's matched SET p99 at 200 connections, so a TS candidate must reach about 92,000 `persisted` SETs/s at 200 connections with p99 under 4.9 ms on this box to win that row.
