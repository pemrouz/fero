# E-09e: etcd 3.5.17 on this box, with its own benchmark tool

> **C = 0.73 ms** (from [E-01](../E01-floors/README.md): fdatasync p99 with three writers 676 µs + Rust loopback round-trip p99 58 µs). The TS latency bar is C + 5 ms = 5.7 ms; the native bar is C + 0.5 ms = 1.2 ms.

## The question

Q-09, etcd row (QUESTIONS.md §2, E-09e): what does etcd reach here, with its own `benchmark` tool, at matched guarantees and at its default? It sets the bar numbers of PERF-07 (put, linearizable and serializable range, txn-put, lease keep-alive, locks), and says, against [E-02](../E02-pipeline/README.md)'s pipeline floors, whether a TS build can win these rows at all.

## The answer in short

All measured here, medians of 3 runs, each run on a fresh three-member cluster. Ranges are in the tables below.

- **etcd fsyncs before every answer, by default.** So its matched row and its default row are the same run: three members, a majority on disk before the answer (fero's `persisted`). Turning fsync off (`--unsafe-no-fsync`, not a supported setting) shows what the fsync costs: at 1 client a put drops from 0.85 to 0.49 ms at p50 (1,118 to 1,937 puts/s); at 1,000 clients nothing changes (22,800 against 24,000/s), because the CPU is the limit there.
- **Writes.** `put` of 256 bytes: **1,118/s at 1 client, p50 0.85 ms, p99 1.73 ms**; **22,800/s at 1,000 clients on 100 connections, p99 90 ms**. At 1,000 clients the three members use 2.8 cores and the benchmark tool 0.8, so the box's 4 vCPUs are the ceiling. Sending to all members instead of the leader gave the same rate and a p99 of 104 ms. A one-put transaction (`txn-put`) costs the same as a put (1,093/s and 20,900/s).
- **Reads.** Linearizable range: **2,230/s at 1 client (p50 0.43, p99 0.80 ms)**, 53,200/s at 1,000 clients. Serializable: **5,135/s (p50 0.18, p99 0.40 ms)**, 66,100/s. At 1,000 clients the tool itself uses 1.5-1.7 cores.
- **Conditional writes, leases and locks.** A compare-and-set through etcd's STM (a get, then a txn that writes only if the key is unchanged): 778/s at 1 client (p50 1.22, p99 2.80 ms), 10,200/s at 1,000. Lease keep-alive: 51,000/s at 1,000 clients; only the leader does work (it is not replicated). A lock (etcd's `concurrency.Mutex`, each client its own lock name): **acquire p50 1.04 ms, p99 2.02 ms**; a lock-then-unlock cycle p50 2.0 ms, 479 cycles/s at 1 client and 6,050/s with 100 clients. A compare-and-set inside the client lock: 313/s, p50 3.06 ms.
- **CPU per write.** At 1,000 clients etcd spends about **121 µs of CPU per put** across its three members (77 µs in the leader) plus 34 µs in the client. E-02's TS pipeline spent 13 µs per append across its three processes at 50,000/s, and under 1 µs at its ceiling.
- **Against E-02.** Every etcd throughput row is 40-120 × below E-02's TS pipeline ceiling, so E-02 does not stop a TS build on any PERF-07 throughput row; the gRPC gateway and the real kernel (E-45) decide those. The one row that is close is **latency at one client**: etcd's put p99 (1.73 ms) is better than the TS pipeline's measured commit p99 (2.4-4.3 ms) and about equal to Rust's (1.58 ms). And etcd's lock acquire (p50 1.04 ms) misses P-10's bar (acquire ≤ C = 0.73 ms), so P-10's bar is not set by etcd.
- **Context, cited:** etcd's own page measured 583 puts/s at 1 client (1.6 ms average) and 44,341/s at 1,000 clients on three 8-vCPU machines with a 16-vCPU client (etcd 3.2.0, 2017). This box is faster at one client (its flush is fast, E-01) and slower at 1,000 clients (four vCPUs for everything).

## Method

- **etcd 3.5.17** (release binary, [TOOLS.md](../TOOLS.md)), **three members** on loopback, each with its own data directory on the one ext4 disk (`$SP/e09/etcd/data/m1..m3`). Defaults throughout (heartbeat 100 ms, election 1 s, snapshot every 100,000 entries, 2 GB backend quota), `--log-level error`. A new cluster is made for every run and deleted after it, so no run sees an earlier run's data.
- **Matched and default are the same here.** etcd always fsyncs its write-ahead log before it answers a write, and always replicates to a majority: that is fero's `persisted` rung, and it is also etcd's default. etcd has no `memory` rung; its only switch is `--unsafe-no-fsync`, unsafe by its own name. Two `put` rows run with that switch, marked "nofsync", only to price the fsync. They are not etcd's default and not a fair "default" row.
- **The tool:** etcd's own `benchmark`, built from the v3.5.17 tag ([TOOLS.md](../TOOLS.md)), with `--precise`. The configurations follow etcd's own performance page ([cited](https://github.com/etcd-io/website/blob/main/content/en/docs/v3.5/op-guide/performance.md)) and QUESTIONS.md E-09e:
  - `put`: 8-byte keys, sequential over 100,000, **256-byte values**; 1 client on 1 connection, and **1,000 clients on 100 connections**; to the leader only (`--target-leader`), and for 1,000 clients also to all three members (`-all`: followers forward to the leader, like fero's Y `fwd`).
  - `range` of one 256-byte key: linearizable (`l`, a ReadIndex round with a quorum) and serializable (`s`, served by one member from its own copy); 1 client to the leader, and 1,000 clients on 100 connections over all members.
  - `txn-put`: a transaction holding one put (no compare), 1 and 1,000 clients, to the leader.
  - `lease-keepalive`: each of 1,000 clients grants a lease and sends `KeepAliveOnce` requests, to the leader.
  - `stm` (etcd's software transactional memory): one key out of 100,000 per transaction, read then written (`--txn-wr-percent=100`), so each transaction is a get followed by a compare-and-set txn: **a conditional write**. 1 client and 1,000 clients. (The tool's default, 50 % of one key, writes nothing: `int(0.5) = 0`; it was changed before any timed run.)
  - **Locks**: `stm --stm-locker=lock-client` wraps each conditional write in etcd's client lock (`concurrency.Mutex` on one name), with 1 client; and [lockbench/main.go](lockbench/main.go), our 120-line Go loop over `concurrency.Mutex` (as E-09e allows): each client holds one session (one lease) and loops Lock, Unlock for 20 s after 2 s of warm-up, with its own lock name (no contention: the "acquire ≤ C" case of P-10). 1 client, and 100 clients on 10 connections.
- **Totals.** Each configuration's `--total` was sized by a short untimed calibration on a busy box ([results/calibrate.txt](results/calibrate.txt), [totals.json](totals.json)), so a run lasts 15-60 s. The six single-client read runs lasted 84-94 s each (the quiet box was faster than the calibration guessed), longer than the brief's 60 s; their timing hold took about 12 minutes, inside the 30-minute rule.
- **Measured per run:** the tool's requests/s and latency percentiles; CPU seconds of each member (from `/proc/<pid>/stat`) and of the load generator (`os.times()` children); the box's busy cores, so "other cores" = load from processes outside this run; `/proc/loadavg` before the run (its 1-minute figure includes our own previous run). Raw lines: [results/runs.jsonl](results/runs.jsonl); the tool's text per run: [results/raw/](results/raw); the table: [results/tables.md](results/tables.md).
- Everything timed ran under `$SP/bin/timing`, in three holds (`put`, `range`, `ops`): [run.sh](run.sh). Machine: E-01's ([env.txt](../E01-floors/results/env.txt)): 4-vCPU Firecracker VM, one virtio disk, ext4 without a journal; Go 1.24.7 for lockbench.

## Results

Median of 3 runs, range in brackets. Latency in ms. "etcd cores" = CPU of all three members together over the run; "client cores" = the benchmark tool's CPU.

| config | runs | ops/s | p50 ms | p99 ms | p99.9 ms | max ms | etcd cores (3 members) | client cores | other cores | load before (1-min) |
|---|---|---|---|---|---|---|---|---|---|---|
| put-1c | 3 | 1118 (1116-1144) | 0.849 (0.833-0.853) | 1.731 (1.623-1.735) | 4.35 (4.16-4.39) | 21.5 (9.8-23.4) | 1.75 (1.71-1.75) | 0.33 (0.33-0.34) | 0.14 (0.14-0.24) | 1.68, 2.97, 3.17 |
| put-1000c | 3 | 22799 (22256-23347) | 38.487 (37.481-39.892) | 89.922 (88.225-90.128) | 113.15 (105.90-115.81) | 139.3 (126.1-150.3) | 2.80 (2.78-2.83) | 0.80 (0.79-0.81) | 0.07 (0.07-0.07) | 4.58, 4.89, 5.31 |
| put-1000c-all | 3 | 22782 (22685-22938) | 38.568 (38.375-38.691) | 103.784 (100.350-104.469) | 128.55 (128.50-128.81) | 157.5 (157.1-168.0) | 2.84 (2.84-2.84) | 0.78 (0.78-0.79) | 0.07 (0.07-0.07) | 5.69, 6.84, 7.25 |
| range-l-1c | 3 | 2230 (2229-2267) | 0.425 (0.418-0.428) | 0.799 (0.756-0.803) | 1.96 (1.85-1.99) | 23.0 (13.5-25.4) | 1.57 (1.57-1.58) | 0.63 (0.63-0.63) | 0.02 (0.02-0.05) | 1.10, 3.16, 3.55 |
| range-l-1000c | 3 | 53151 (52760-53654) | 15.089 (15.010-15.287) | 43.667 (42.653-43.835) | 57.22 (56.92-58.64) | 91.7 (77.5-98.2) | 2.16 (2.16-2.17) | 1.54 (1.54-1.56) | 0.03 (0.03-0.03) | 4.01, 5.50, 6.59 |
| range-s-1c | 3 | 5135 (5133-5221) | 0.181 (0.178-0.182) | 0.403 (0.400-0.407) | 1.10 (1.08-1.11) | 17.1 (16.1-32.5) | 0.91 (0.91-0.91) | 0.88 (0.88-0.88) | -0.04 (-0.04--0.01) | 7.27, 3.15, 2.31 |
| range-s-1000c | 3 | 66094 (65415-67519) | 10.712 (10.696-10.885) | 40.677 (39.074-40.806) | 55.50 (51.99-56.08) | 85.1 (77.0-85.5) | 2.06 (2.06-2.08) | 1.72 (1.71-1.73) | 0.05 (0.04-0.06) | 2.31, 4.29, 6.20 |
| txn-put-1c | 3 | 1093 (1048-1109) | 0.870 (0.857-0.909) | 1.759 (1.758-1.818) | 4.26 (4.25-4.28) | 22.5 (14.5-23.7) | 1.74 (1.73-1.75) | 0.33 (0.33-0.33) | 0.12 (0.12-0.16) | 1.72, 3.05, 2.99 |
| txn-put-1000c | 3 | 20862 (20782-21185) | 42.494 (41.859-42.919) | 96.015 (94.022-98.342) | 118.22 (114.76-121.50) | 151.9 (137.5-162.4) | 2.83 (2.81-2.85) | 0.73 (0.72-0.75) | 0.07 (0.07-0.08) | 3.37, 5.52, 5.85 |
| lease-keepalive-1000c | 3 | 51030 (51026-52360) | 13.266 (12.854-13.299) | 48.308 (46.487-48.564) | 67.15 (63.95-70.58) | 118.9 (115.0-123.2) | 2.01 (2.00-2.02) | 1.64 (1.63-1.64) | 0.05 (0.05-0.07) | 7.59, 6.40, 5.81 |
| stm-1c | 3 | 778 (734-786) | 1.221 (1.201-1.292) | 2.804 (2.701-2.926) | 5.57 (5.52-5.99) | 26.9 (24.2-106.5) | 1.57 (1.56-1.57) | 0.46 (0.45-0.46) | 0.09 (0.07-0.09) | 5.07, 3.96, 3.34 |
| stm-1000c | 3 | 10224 (10153-10261) | 93.332 (92.447-93.746) | 184.331 (180.374-184.807) | 235.12 (234.82-235.29) | 371.7 (357.7-374.9) | 2.63 (2.61-2.63) | 0.89 (0.88-0.90) | 0.08 (0.07-0.08) | 3.14, 4.07, 5.19 |
| stm-lock-1c | 3 | 313 (310-317) | 3.061 (3.051-3.098) | 5.574 (5.407-5.780) | 8.71 (8.59-8.82) | 46.6 (26.5-51.3) | 1.65 (1.65-1.67) | 0.39 (0.39-0.39) | 0.11 (0.11-0.11) | 5.98, 5.01, 3.74 |
| lock-1c | 3 | 479 (471-482) | 2.018 (2.007-2.045) | 3.747 (3.579-3.854) | 5.78 (5.78-6.25) | 13.0 (10.6-24.5) | 1.69 (1.68-1.69) | 0.31 (0.30-0.31) | 0.10 (0.10-0.12) | 3.22, 4.58, 3.78 |
| lock-100c | 3 | 6046 (5955-6104) | 15.982 (15.799-16.087) | 30.650 (30.512-32.177) | 38.26 (35.99-44.09) | 49.7 (42.0-58.3) | 2.38 (2.35-2.40) | 0.77 (0.76-0.77) | 0.15 (0.15-0.17) | 4.49, 5.88, 7.27 |
| put-1c-nofsync | 3 | 1937 (1909-1946) | 0.491 (0.487-0.497) | 0.925 (0.914-0.949) | 3.52 (3.01-3.54) | 17.0 (11.6-17.3) | 2.03 (2.03-2.04) | 0.49 (0.49-0.50) | 0.07 (0.06-0.07) | 7.02, 5.52, 5.18 |
| put-1000c-nofsync | 3 | 23950 (22021-24276) | 36.692 (35.795-39.149) | 89.125 (85.889-105.675) | 113.00 (106.83-133.13) | 148.3 (123.7-170.3) | 2.85 (2.82-2.86) | 0.85 (0.83-0.86) | 0.05 (0.04-0.05) | 4.87, 5.48, 6.03 |

Lock acquire alone (lockbench; the cycle columns above are Lock + Unlock):

| config | runs | acquire p50 ms | acquire p99 ms | acquire p99.9 ms |
|---|---|---|---|---|
| lock-1c | 3 | 1.044 (1.036-1.057) | 2.016 (1.893-2.113) | 3.95 (3.58-4.32) |
| lock-100c | 3 | 7.810 (7.722-7.846) | 18.909 (18.798-19.589) | 25.10 (24.18-27.97) |

## Against the floors (E-01, E-02)

QUESTIONS.md's threshold, per row: if the competitor's matched median is better than E-02's TS floor, TS cannot win that row, and the native build must come first; if it is better than the Rust floor too, the gap goes into the verdict. E-02's pipeline makes its own writes (no clients, no network protocol), so a floor far above the competitor does not mean fero wins: it means only that E-02 does not rule a win out, and E-45's driver decides. For etcd, matched = default, so this one table covers both.

| PERF-07 row | etcd here (median) | Floor it is judged against (measured) | Reading |
|---|---|---|---|
| put 256 B, 1 client | 1,118/s; p50 0.85, p99 1.73 ms | C = 0.73 ms (E-01). E-02 commit latency, real disk, 100 B: at 10,000/s TS p50 0.73 / p99 2.73 ms, Rust 0.51 / 21.8 (disk stalls; range 1.4-50); at 50,000/s TS 0.85 / 4.33, Rust 0.62 / 1.58; with emulated independent disks at 50,000/s TS 0.56 / 2.40, Rust 0.38 / 0.67 | **etcd's p99 beats TS's measured p99** by 1.4-2.5 ×; Rust's is about equal. E-02 has no one-in-flight run, and its 1 ms batch tick adds up to 1 ms of wait, so this does not prove TS cannot win. It says TS must bring its commit p99 under 1.7 ms at low load to win this row. **Open for TS; the risk row.** etcd itself misses PERF-08's native bar (C + 0.5 = 1.2 ms) and meets the TS bar (5.7 ms). |
| put 256 B, 1,000 clients (leader) | 22,800/s; p99 90 ms; CPU-bound (3.6 of 4 cores) | E-02 TS ceiling 2.8 M/s at 100 B, 284 k/s at 1 KiB (about 1 M/s at 256 B, interpolated: reasoned); Rust 2.2 M and 349 k. CPU: TS 13 µs per append (three processes) at 50,000/s, etcd 121 µs per put | floor 40-120 × above: **not stopped by E-02**; E-45 decides |
| put, 1,000 clients, all members | 22,800/s; p99 104 ms | same | same; followers forwarding to the leader cost no throughput, 14 ms of p99 under full CPU |
| range linearizable, 1 client (vs a `fresh` read) | 2,230/s; p50 0.43, p99 0.80 ms | PERF-10: a `fresh` read costs one round trip and no fsync. E-01 round trip p50 31-40 µs, p99 58-96 µs | E-02 has no reads; the physical floor is about 10 × below etcd. E-45 decides |
| range linearizable, 1,000 clients | 53,200/s; p99 44 ms | — | CPU-bound (2.2 etcd + 1.5 tool cores). E-45 |
| range serializable, 1 client (vs a held-row read) | 5,135/s; p50 0.18, p99 0.40 ms | PERF-10: held-row read < 100 ns in process | in process, fero's read is about 2,000 × faster by design; through the tool and a gateway it costs a round trip. E-45 |
| range serializable, 1,000 clients | 66,100/s; p99 41 ms | — | the tool uses 1.7 cores; E-45 |
| txn-put, 1 and 1,000 clients (vs a conditional write) | 1,093/s (p99 1.76 ms); 20,900/s (p99 96 ms) | as put | as put. etcd's `txn-put` has no compare; its conditional write is the STM row |
| compare-and-set (stm), 1 and 1,000 clients | 778/s (p50 1.22, p99 2.80 ms); 10,200/s (p99 184 ms) | PERF-10: a conditional op at the writer ≤ 3 µs (TS), then one commit | etcd's CAS pays a read round trip plus a commit, from the client; fero's is one commit at the writer. Not stopped by E-02; E-45 |
| lease keep-alive, 1,000 clients | 51,000/s; p99 48 ms; leader only | — | etcd does not replicate keep-alives. E-45 |
| lock, 1 client, own name (vs the locks library) | acquire p50 1.04, p99 2.02 ms; cycle p50 2.02 ms; 479/s | P-10: acquire ≤ C = 0.73 ms | **etcd misses P-10's bar.** A fero acquire is one commit, so its p99 is at least C; P-10's bar is about C, not about etcd |
| lock, 100 clients | 6,050 cycles/s; acquire p50 7.8, p99 18.9 ms | — | CPU-bound. E-45 |
| CAS inside the client lock, 1 client | 313/s; p50 3.06, p99 5.57 ms | — | lock + CAS + unlock: three commits and reads |

**Rungs.** etcd's default is its matched setting, so no PERF-07 row needs a `memory` or `none` rung to be won at etcd's default. DEV-01 gains nothing from etcd.

**No row is above the Rust floor**, so there is no gap to carry into the verdict from etcd.

## What this box cannot show

- **Three machines.** All three members and the load generator share 4 vCPUs. At 1,000 clients etcd used 2.8 cores and the tool 0.8: the box's CPU, not the disk, set those rows' ceiling (the `nofsync` row is no faster). etcd's own page reached 44,341 puts/s (leader only) and 141,578 linearizable reads/s with three 8-vCPU machines and a 16-vCPU client (cited, etcd 3.2.0, 2017). So the 1,000-client throughputs here are this box's, not etcd's.
- **Independent disks.** The three write-ahead logs share one virtual disk (E-01). At one client this costs each put the slowest of two concurrent fsyncs on one disk.
- **Real round trips.** Loopback only. Between machines every put and every linearizable read pays at least one real network round trip more.
- **The quiet-box wake-up cost** (E-01): an idle vCPU takes about 25 µs to wake, and one put at one client wakes threads in three processes several times. A busy production box would show lower single-client latencies.

## Files

- [bench.py](bench.py): the driver (`calibrate`, `run`, `smoke`, `table`). [run.sh](run.sh): `sh run.sh build`, then `sh run.sh all` (three timing holds) or one hold (`put`, `range`, `ops`).
- [lockbench/](lockbench): the lock loop (`main.go`, `go.mod`, `go.sum`).
- [fetch.sh](fetch.sh): etcd, its benchmark tool, lockbench's modules and the cited page, with checksums.
- [results/](results): `runs.jsonl` (one line per run), `tables.md`, `calibrate.txt`, `raw/` (the tool's summary per run for the `ops` hold; see the note in the verdict).

## Verdict

etcd at its default is already fero's `persisted` shape, and on this box it is CPU-bound well below E-02's pipeline ceilings: 22,800 puts/s, 53,200 linearizable reads/s and 66,100 serializable reads/s at 1,000 clients, at about 121 µs of server CPU per put. So **no PERF-07 throughput row is closed against a TS build by these numbers**; those rows are decided when E-45 drives fero through a gRPC gateway with this same tool. **The single-client latency rows are the risk.** etcd answers a put at p50 0.85 ms and p99 1.73 ms, which beats the TS pipeline's measured commit p99 (2.4-4.3 ms) and matches Rust's (1.58 ms). So TS's tail, not its throughput, decides whether it can win PERF-07 at one client. etcd's lock acquire (p50 1.04, p99 2.02 ms) misses P-10's own bar (≤ C = 0.73 ms), so beating etcd there is not enough to pass P-10.

One process note: the tool's text output for the `put` and `range` runs (27 files) was lost after the runs, by a cleanup step of mine that opened each file for writing before reading it. Every number in this README comes from [results/runs.jsonl](results/runs.jsonl), which the driver wrote from that text at the end of each run, before the cleanup; it holds each run's rate, average, max and all eight percentiles. The `ops` runs keep their text in [results/raw/](results/raw).

Q-09 (etcd): etcd 3.5.17 with 3 members (fsync before every answer, which is both matched and its default) reaches 1,118 puts/s at 1 client (p50 0.85, p99 1.73 ms) and 22,800/s at 1,000 clients (p99 90 ms, CPU-bound on 4 vCPU), linearizable reads 2,230/s (p50 0.43 ms) and 53,200/s, serializable 5,135/s (p50 0.18 ms) and 66,100/s, txn-put about the same as put, compare-and-set 778/s and 10,200/s, lease keep-alive 51,000/s, lock acquire p50 1.04 / p99 2.02 ms; every throughput row is 40-120 × below E-02's TS pipeline ceiling at about 9 × its CPU per write, so E-02 does not stop TS on any PERF-07 throughput row (E-45 decides), but etcd's single-client p99 (1.73 ms) beats E-02 TS's measured commit p99 (2.4-4.3 ms) and equals Rust's (1.58 ms). Moves: MIN, DRAFT, LEAN (`ts→rs`) and MIN-TS not down on PERF-07 throughput; MIN-TS down a little on PERF-07's single-client rows and PERF-08's native column (TS tail), RUST and SRV up a little there; no candidate moves on DEV-01 (etcd's default needs no `memory` rung); P-10's bar (acquire ≤ C) stands above etcd's own lock.
