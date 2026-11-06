# Open questions, and the experiments that answer them now

Written 2026-11-06 for the v5 design-space study ([BRIEF.md](BRIEF.md)), from [REQUIREMENTS.md](REQUIREMENTS.md), [SPACE.md](SPACE.md) and [DESIGN-V5.md](../DESIGN-V5.md) §8 to §12. This file lists every open question whose answer could change which candidate wins, or could surprise us in phases 1 to 5, and the one-off experiment that answers it **now**. It runs nothing itself. Each answer lands in `experiments/E<nn>-<name>/` (README with a verdict line, code, `run.sh`, `fetch.sh`, `results/`). Revised the same day after two completeness critics: Q-30 to Q-45 are new (§8), several existing experiments were widened or given a threshold that decides, and the section at the end lists what was merged or left out.

## How to read this

- **Q-nn** is the question, in one sentence. **Decides** names the candidates (SPACE §4) and the requirement ids (REQUIREMENTS) it moves. **E-nn** answers Q-nn (same number): what to build or run, on what tool, what it gives, and the **threshold** that decides.
- **C** is one commit's floor on this box: E-01's fsync p99 with three writers on the one disk, plus the loopback round-trip p99. Every latency threshold is written against C, so it is fixed by measurement, not guessed.
- **Cost** is agent hours and CPU hours (for a timing run, CPU hours = wall hours with the box to itself). **Timing** means the result is a speed: it runs alone under `flock -x $SP/cpu.lock`, three times, median and spread. Other heavy jobs run under `flock -s`.
- **Literature alone** says whether a cited source could answer it without running anything.
- **MIN's variants.** MIN-P, MIN-TS, RLOG, EMB-V8 and SIDE (SPACE §4) differ from MIN on one or two axes. A Decides line that names MIN covers them too, unless it names one of them apart.
- SPACE §6's questions map here: 1 → Q-02, Q-09; 2 → Q-03; 3 → Q-10; 4 → Q-11; 5 → Q-13; 6 → Q-20; 7 → Q-16; 8 → Q-05; 9 → Q-28; 10 and 12 → Q-22; 11 → Q-21; 13 → Q-20, Q-01; 14 → Q-02; 15 → Q-37; 16 → Q-36; 17 → Q-03; 18 → Q-44; 19 → Q-13, Q-16; 20 → Q-24; 21 → Q-35, Q-41; 22 → Q-30; 23 → Q-32; 24 → Q-33.
- **Counting.** Every model counts rules and makes its mutants as REQUIREMENTS DEV-10 says. Models that compare options (E-16, E-17, E-20, E-21, E-24, E-30, E-31, E-33) share one Python harness, built first in E-17: one event alphabet (crash, restart, partition, deliver, tick) and one property module; each option adds only its own transition rules, and a second agent re-runs each ablation. Rule counts from different harnesses are not compared.
- **On the box today** (measured here while writing, by `ls`, `strings` and `wc`): Kafka 4.4.0 unpacked, with `kafka-e2e-latency.sh` and `kafka-share-consumer-perf-test.sh`; etcd 3.5.17 without its benchmark tool; nats-server 2.10.22, which knows `sync_interval`; redis-server 7.0 and `redis-benchmark`; the TLA+ tools; etcd's raft at c51f010; `/dev/fuse`. Missing: fio, memtier_benchmark, the nats CLI, etcd's `benchmark`, MinIO, LazyFS, perf. Redpanda's apt repository refused the download (`TOKEN_NOT_ACTIVE`, saved in `$SP/dl/redpanda/`). Added after review: the disk is one ext4 virtual disk (`/dev/vda`); `iptables` is installed; openraft 0.9.25's source is in `$SP/dl/openraft-critic/`; a critic's head-of-line probe is in `$SP/critic/hol/` (Q-35).

## 1. The floors and the language

**Q-01. What are this box's floors: fsync latency for one writer and for three writers on the one disk, and a loopback round trip?**
- Decides: no candidate alone. It fixes C for PERF-01, PERF-08 and F-05, and says how much "three replicas on one disk" distorts every matched run.
- E-01: build fio from source; `fio --rw=write --bs=4k --ioengine=sync --fdatasync=1`, 60 s, with 1 job and with 3 jobs on 3 files; also O_DSYNC and 64 KB writes. A 64 B and 1 KB TCP ping-pong (no Nagle delay) in Node and in Rust. Gives fsync p50, p99 and p99.9 for 1 and 3 writers, and round-trip p50 and p99. Also: **are flushes honoured?** Compare `O_DIRECT|O_DSYNC` writes with `fdatasync`, and run a sustained write longer than any plausible cache (say 10 GB). Record the filesystem, mount options and the jbd2 journal mode. The round trip also prices Y `fwd`'s extra hop against `smart`.
- Threshold: none chooses a candidate. If the 3-writer p99 is more than 2 × the 1-writer p99, every matched run is disk-bound and each report says so. A critic's probe already saw a 6.4 KB `writev` plus `fdatasync` at p50 0.16-0.21 ms here, fast enough to suggest the hypervisor acknowledges from a cache. If the sustained run's p99 rises far above the short run's, or `O_DIRECT|O_DSYNC` and `fdatasync` differ by more than 2×, flushes are probably cached: every report says so, and every latency bar is stated twice, against this box's C and against a cited fsync figure for the deploy target (Fly volumes, a cloud SSD), which the user confirms.
- Cost: 3 agent-h, 0.4 CPU-h; timing. Literature alone: no (the deploy target's figure is cited).

**Q-02. How fast can a replication pipeline be in TypeScript, Rust and Go on this disk, and at what CPU per append?**
- Decides: L, so MIN, DRAFT and LEAN (`ts→rs`) against MIN-TS (`ts`), RUST (`rs+napi`) and SRV (`rs-srv` or `go-srv`); axis M (`kw` against `kwN`); decision 3; PERF-08, PERF-09, DEP-12; conflict X2.
- E-02: one minimal pipeline, built in Node 22, in Rust, and in Go (for SRV's Go variant). Three OS processes on loopback, each with its own journal file. The leader batches records (window ≤ 1 ms), writes with `writev`, fdatasyncs once per batch, and sends the batch bytes to both followers at once; followers append, fdatasync and ack; a record commits at a majority. No elections: steady state is the floor. Variants: TS on the main thread, TS on one worker (M `kw`), TS on 2 and 4 workers with groups pinned to workers and one journal each (M `kwN`), Rust and Go with plain threads; 100 B and 1 KB records; 1, 16 and 1,000 groups sharing one journal and one link per peer; rungs `persisted`, `memory` (no fsync wait) and `none` (no followers); preallocated segments (`fallocate`) against growing files; and a **tmpfs variant** where each replica's fdatasync is replaced by a delay sampled from E-01's one-writer distribution, which emulates three independent disks that this box does not have. Gives **CPU µs per committed append** in each process at a fixed offered rate, the most persisted appends a second per process, and commit p50 and p99 at half that rate. This is a ceiling: a real kernel can only approach it. E-39 reuses this pipeline for overload.
- Threshold: three replicas share one disk and one 1 ms batch window, so throughput measures the disk as much as the language; **L is decided on CPU per append**. TS ≤ 20 µs of one core per committed append in each process (so 50k/s per core) and p99 ≤ C + 5 ms → a TS-first kernel is viable and MIN keeps `ts→rs`. TS above either → decision 3b (Rust first) gains and RUST moves up. Rust ≤ 2 µs per append and p99 ≤ C + 0.5 ms → the native bars are reachable. Throughput on the real disk and on tmpfs is reported beside; if every build hits the same disk-bound ceiling, the verdict says throughput did not separate them, and MIN-TS ties MIN on G2 at this box's floor. `kwN` with 4 workers ≥ 3 × one worker's appends on tmpfs → M `kwN` is planned for phase 2 and S `jrnl` is one journal per worker. Read with Q-09: a competitor above Rust's floor at matched settings cannot be beaten by any design on this box, and the gap is stated.
- Cost: 14 agent-h, 3.5 CPU-h; timing. Literature alone: no.

**Q-03. What does a call from JavaScript into Rust (napi, Node's native addon interface) cost, per call and per record?**
- Decides: whether RUST can keep L2 and user rules in JS over a Rust core (K `lib` × L `rs+napi`), or must move them to Rust or WASM; EMB-V8 (L `rs+v8`); SIDE (H `side`); X3; DATA-09; PERF-10.
- E-03: a napi-rs addon measuring: an empty call; passing and returning a 4 KB Buffer without a copy; Rust calling a JS function once per record, directly and through a threadsafe function from a Rust thread; a SharedArrayBuffer ring between a Rust thread and JS. Batches of 1, 16, 256 and 4,096. Gives ns per call and ns per record. Then the same micro-benchmarks **through a deno_core op and through rquickjs** (an empty op; a 4 KB buffer; data's hot lane applying a 256-record batch inside the isolate; isolate memory), for EMB-V8. Then **a local seam** between a Rust daemon and a Node process, by a Unix socket and by a shared-memory ring, in ns per record at batch 256, for SIDE.
- Threshold: a JS rule called per record ≤ 300 ns (10% of the 3 µs op bar) → RUST keeps L2 and rules in JS. ≥ 1 µs → L2 must be Rust and rules declarative or WASM, which counts against RUST and SRV on G1 and DEV-05. A batch of 256 handed to data's JS fold at ≤ 50 ns per record → "Rust kernel, data folds in JS" (X3) holds. An isolate op ≤ 100 ns and data's fold inside the isolate within 1.2 × plain Node → EMB-V8 is a live candidate for G2 with G6 kept; otherwise it is pruned with the number. The local seam ≤ 2 × napi's per-record cost at batch 256 → SIDE stays; otherwise it is pruned with the number.
- Cost: 10 agent-h, 1 CPU-h; timing. Literature alone: no.

**Q-04. Could one Rust kernel, compiled to WASM (WebAssembly) for the sim and the site, replace the two-kernel plan; and do a TS and a Rust kernel stay byte-identical in practice?**
- Decides: L `wasm` against `ts→rs` (X2, TEST-10, DEV-07); whether "two kernels for a while" is needed at all.
- E-04: the real question is whether a WASM kernel can **be the sim's kernel**, where every event crosses from JS (the sim, user code, data's fold) into WASM and back with its effects. Compile E-02's Rust inner loop (encode, an in-memory journal, a map fold) and raft-rs's step loop (if E-10 builds it) to wasm32, behind a small JS sim driver; measure the cost per event of the crossing with effects, at the sim's rate; then run TEST-01's bar with the kernel in WASM. As a guard, feed the TS and WASM versions the same 1,000 seeded input streams and diff their output bytes.
- Threshold: TEST-01 met with the kernel in WASM (200 chaos seeds ≤ 1 s; a fresh node plus a scenario ≤ 5 ms) → one Rust kernel runs everywhere (sim, site, `node app.ts`) and the TS kernel is never written: RUST moves up. Missed → `ts→rs` keeps a TS kernel for the sim. Any byte difference names a trap (map order, floats, varints) that TEST-10's guard must cover.
- Cost: 7 agent-h, 0.5 CPU-h; timing. Literature alone: no.

**Q-05. What does data's fold cost per record, per row of memory, and per GB of replay?**
- Decides: F `all` (MIN) against `ldr` (LEAN); P-01, P-12, DEP-13; F-05 for LEAN's cold failover; the 2 µs L2 bar.
- E-05: through `api/substrate.ts`, with data at HEAD, apply fero records through data's hot lane: 100 B row sets, field updates, deletes; at 1e3, 1e5 and 1e6 rows; with no view, one `group` view, and 100 filter views. Gives µs per record, bytes per row after GC, and replay speed (records/s, seconds per GB) from an encoded log. Also: bytes per row in decision 13's form (compact rows on a worker plus a main-thread projection, each held row counted on both threads); the heap limit (`heap_size_limit`); and the time to hash folded state at 1e5 and 1e6 rows (F-21's check).
- Threshold: ≤ 2 µs per record and ≤ 2 KB per small row → "every replica folds" is affordable (MIN). Decision 13's form above 2 KB a row → DEP-13 is restated for it, or rows stay on one thread. A hash of 1e6 rows ≤ 1 s of a background thread → F-21's hourly check is affordable. If the fold is ≥ 30% of E-02's CPU per append, every replica spends about a core on it and LEAN moves up. If replaying one group's state takes more than 2.5 s, LEAN fails F-05 without its warm standby.
- Cost: 5 agent-h, 0.7 CPU-h; timing. Literature alone: no.

**Q-06. Can data fork and rewind state cheaply enough for fero test (a fork costs a record; a rerun on the exact earlier state ≤ 10 ms)?**
- Decides: TEST-06 and TEST-07 for every candidate; whether data needs shared-structure state, a data-side change to plan now (DATA-04).
- E-06: in Node with data at HEAD: the cost to copy a resource's state at 1e3, 1e5 and 1e6 rows; to rewind by "nearest snapshot plus replay" with snapshots every 100, 1,000 and 10,000 records; and the same with rows in a persistent map (a map whose copies share most memory, from npm), to see the gain.
- Threshold: a rerun ≤ 10 ms at the café's size (fero test's example) and ≤ 100 ms at 1e6 rows → no data change. Above → data gains structural sharing (planned now), or fero test states its limit.
- Cost: 4 agent-h, 0.3 CPU-h; timing (light). Literature alone: no.

**Q-07. Can a TS kernel avoid false failovers and user-code stalls: how long are Node's GC pauses, and what does a kernel on a worker thread cost?**
- Decides: decision 13; F-06, F-14; `election.ms` in TS; X6; whether TS can hold the F-05 TS bar at all.
- E-07: Node holding 1e5, 1e6 and 5e6 data rows (at DEP-13's 2 KB a row, 0.2, 2 and 10 GB; the default heap here is 2.05 GiB, so the larger runs set `--max-old-space-size`, and E-34 owns the 10 GB case) under steady writes: GC pauses (`perf_hooks` gc entries) and event-loop delay (`monitorEventLoopDelay`), p99, p99.9 and max. Then a kernel on a worker thread trading records with the main thread, by transferred ArrayBuffers and by a SharedArrayBuffer ring (ns per record at batch 256), and a 5 s main-thread stall (the worker's heartbeat jitter).
- Threshold: worst pause < 1 s (half of the 2 s `election.ms`) at the target heap → F-06 holds in TS. Above → rows leave the main heap (worker or native) from phase 2. Crossing ≤ 0.5 µs per record and jitter ≤ 50 ms in the stall → decision 13a is affordable and F-14 holds.
- Cost: 5 agent-h, 1 CPU-h; timing. Literature alone: partly (V8's GC docs say which pauses exist, not how long here).

**Q-08. How many deliveries a second can one relay core push, in Node and in Rust?**
- Decides: PERF-11, P-05, PERF-03 against NATS; whether relays must be native early, whatever the kernel's language.
- E-08: one relay process; 1,000 and 10,000 loopback TCP subscribers in two client processes; 64 rooms; 100 B records, each encoded once and written with `writev` per socket per tick. Node and Rust. Gives deliveries a second per relay core (relay CPU apart from the clients') and p99 delivery latency at half of the maximum.
- Threshold: Node ≥ 100k/s and Rust ≥ 3M/s → the bars stand. Node below 100k/s, or more than 2 × below E-09b's NATS fan-out → relays are native from phase 3.
- Cost: 5 agent-h, 1 CPU-h; timing. Literature alone: no.

## 2. The competitors on this box

**Q-09. What does each competitor reach here, with its own tool, at matched guarantees and at its default?**
- Decides: the bar numbers of PERF-02 to PERF-07. Read against E-02 and E-08: whether any candidate, in which language, can win G2 here, and which rungs (`memory`, `none`) fero needs to win at a competitor's default (axis Q, X1).
- Method for all five: three members on the box (where the system has members), three runs each, E-01's floors beside them, matched settings and the default. The load generator shares the 4 vCPU; its CPU is recorded.
- E-09a Redis 7.0: memtier_benchmark built from source, `redis-benchmark` as the cross-check; GET, SET, INCR, 100 B, 4 threads × 50 clients, pipeline 1 and 16; default and `appendonly yes, appendfsync always`.
- E-09b NATS 2.10.22 with the nats CLI (`go install` at a pinned tag): core 1 → 1 and 1 → 16 at 16 B and 1 KB (`nats bench`, `nats latency`); JetStream with 3 servers, file storage, `sync_interval: always` and default; publish with acks, a pull consumer, work-queue retention.
- E-09c Kafka 4.4.0 (KRaft): 3 brokers with 1 GB heaps; the producer and consumer perf tools and `kafka-e2e-latency`; 1 KB, 16 partitions, replication 3, `acks=all`, `min.insync.replicas=2`; `flush.messages=1` and default; share groups (`kafka-share-consumer-perf-test`, Kafka's queues) as the work-queue bar. The OpenMessaging Benchmark only if it fits 4 vCPU; if not, said.
- E-09d Redpanda: the apt route is blocked. Fetch the official image's layers through the registry with `crane export` (no Docker daemon needed) and start 3 nodes with `rpk redpanda start --smp 1 --memory 2G --overprovisioned`; same Kafka tools. If it will not run here, say why, and cite Redpanda's published numbers, marked cited.
- E-09e etcd 3.5.17 with its `benchmark` tool built from the v3.5.17 tag: put 256 B at 1 client and at 1,000 clients on 100 connections; range linearizable and serializable; txn-put; lease-keepalive; locks via `stm` or a short Go loop over `concurrency.Mutex`.
- Threshold, per row of PERF-02 to PERF-07: competitor's matched median above E-02's TS floor → TS cannot win that row, so the native build must come before G2 is claimed (moves decision 3). Above the Rust floor too → the gap goes into the verdict (PERF-01's rule). A default-config row won only by a `memory` or `none` rung → that rung is priced as a mechanism (DEV-01) in each candidate (`none` is already required by P-06). fero's side of each row is driven as E-45 says; a row with no faithful driver is "not comparable".
- Cost: 15 agent-h (a 3, b 3, c 4, d 3, e 2), 6 CPU-h; timing. Literature alone: no (PERF-01 needs the same box; published numbers are context only).

## 3. The Raft core and many groups

**Q-10. How big is etcd's raft, how hard is a faithful TypeScript port, and is raft-rs (or a JS library) a better start?**
- Decides: axis I (`port`, `own`, `raft-rs`, `jslib`); decision 22; DEV-04, DEV-05; MIN against RUST.
- Known (measured here, `wc -l` at c51f010, tests and generated code left out): core package 6,147 lines; confchange 574; quorum 357; tracker 788; raftpb 351; the `rafttest` harness 2,122; 28 datadriven test files (`testdata/*.txt`: scripted interactions whose text output is compared).
- E-10: (a) port, time-boxed to 12 agent-h, the slice for elections, replication and progress tracking (quorum, tracker, log, log_unstable, the matching parts of raft.go and rawnode.go), plus enough of `rafttest` to run etcd's datadriven files unchanged; (b) build raft-rs at its latest tag, count its lines, and list what etcd's raft has that it lacks (async storage writes, which datadriven files it can run); (c) survey npm's Raft libraries (last release, tests, users). Gives lines ported per hour, the share of applicable datadriven files that pass byte for byte, projected hours for the whole port, and raft-rs's gaps.
- Threshold: the slice passes ≥ 90% of its applicable files and projects to ≤ 80 agent-h for the whole port → `port` is confirmed (MIN). Below, or a Go-only construct that blocks a faithful port → RUST with raft-rs moves up, unless raft-rs has a blocking gap. A JS library counts only with a test oracle as strong as the datadriven files (expected none; reasoned).
- Cost: 16 agent-h, 0.5 CPU-h; not timing. Literature alone: partly (raft-rs says what it ports; the effort needs the trial).

**Q-11. What do N Raft groups cost in one process, idle and busy, from 10 to 10,000?**
- Decides: axes G and P, so CELL (16 groups per resource) and LANE (64 per project) against MIN (one per resource); PERF-12; whether quiet groups and one ping per member pair are needed in phase 2 or can wait (DEV-01).
- E-11: three processes on the box, each hosting N groups (10, 100, 1,000, 2,000, 10,000) of three replicas, messages sent over one link per peer, one ticker for all groups. Built in Go on etcd's raft (the reference), in Rust on raft-rs, and in TS on E-10's port when ready. Modes: idle and ticking; idle and quiet (a quiet group stops sending; one ping per peer pair); busy (10k writes/s over all groups, then over the hottest 1%). Gives resident memory per group, CPU % idle and busy, frames/s, and commit p99 under load.
- Threshold: with quiet groups, 2,000 idle groups use ≤ 1% of a core and ≤ 20 KB each → PERF-12 holds. If ticking without quiet groups already meets it at 2,000 → quieting moves to a later phase. If a busy group's fixed cost per batch makes 16 groups slower than 1 at equal load → CELL and LANE pay it and MIN does not.
- Cost: 12 agent-h, 4 CPU-h; timing. Literature alone: partly (CockroachDB's quiesced ranges and store liveness, TiKV's hibernating regions: the shape, not this box's cost).

**Q-12. Does one shared journal for every group beat one log file per group, and from how many groups?**
- Decides: S `jrnl` (one small novel mechanism: cuts and segment indexes) against `walg` (none); DEP-12; every candidate with many groups per process.
- E-12: Node and Rust; 1, 16, 256 and 2,000 groups appending 100 B records at a fixed total rate: (a) one journal, one fdatasync per batch; (b) one file per group, synced per group batch; (c) one file per group, all synced together per window. Gives appends/s, fsyncs/s, p99.
- Threshold: (b) or (c) ≥ 0.8 × (a) at 256 groups → `walg` is enough and the journal mechanism is cut. Below → `jrnl` is required in phase 2. Preallocated segments are a variant, as in E-02. The filesystem and mount options are recorded: on ext4 every file shares one jbd2 journal commit, so (b) and (c) may behave differently on XFS or NVMe, and the verdict says so rather than claiming it for every disk.
- Cost: 4 agent-h, 1 CPU-h; timing. Literature alone: partly (TiKV's raft-engine and Redpanda's design notes).

**Q-13. On this box, how long are a planned handover, a failover, a catch-up per GB, and a slot move's unwritable window?**
- Decides: F-05 (handover ≤ 10 ms TS, failover ≤ 2.5 s), SC-08(b) (slot move ≤ 10 ms), SC-08(f), DEP-01 (3 copies roll in ≤ 10 s); whether these bars can hold on this disk for any Raft design; RLOG's writer handover.
- E-13: three etcd 3.5.17 members (Raft with fsync, the reference) under a steady put load: (a) `etcdctl move-leader`: the longest gap between acknowledged puts; (b) kill -9 of the leader: time to the first acknowledged put, at election timeouts of 1,000 and 2,000 ms; (c) a new member joining a cluster holding 1 GB: time until caught up. A slot move is three commits (A's fence, the `#meta` row, B's open), so its window is computed as 3 × E-02's commit p99 (reasoned, flagged), and measured once E-10's port runs. RLOG's writer handover is one epoch commit plus the new writer's fold catch-up, computed as E-02's commit p99 plus E-05's replay time for the tail (reasoned, flagged).
- Threshold: etcd's handover gap ≤ 10 ms → the TS bar is reachable here; above → it is disk-bound and restated as C plus a margin. 3 × commit p99 > 10 ms → SC-08(b) is restated, or the move is cut to fewer commits before phase 1.
- Cost: 5 agent-h, 1 CPU-h; timing. Literature alone: no.

## 4. Membership, healing and moves (models)

**Q-14. Are membership changes that take effect on commit, as in etcd's raft, safe and live in fero's healing scenarios?**
- Decides: L1's membership rule (DESIGN-V5 §4.2), on which both DRAFT's per-leader healing and MIN's controller loop rest; DEV-03; F-07, F-16.
- Known (measured here, by grep): etcd's spec `tla/etcdraft.tla` (926 lines) models one change at a time applied at commit, learners, restarts with durable state, and lost and repeated messages. It has no PreVote, CheckQuorum or leadership transfer, and checks 8 safety invariants and no liveness.
- E-14: run TLC (the TLA+ model checker; needs CommunityModules-deps.jar, fetched) on `MCetcdraft` as shipped: states, time, the 8 invariants. Then add as model actions: a restart that loses its disk and returns as a new id; healing.py's scenarios (`four`: a cut-off leader demotes a member with an entry only that member gets; a swap; two voters back to one); and a liveness property: after a fault budget, with fair delivery and timeouts, a leader of the latest configuration commits a new entry (liveness runs drop SYMMETRY, which TLC cannot use soundly with liveness). Mutant: changes take effect on append; healing.py says this gets stuck, and TLC must find the same trace.
- Threshold: on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms ≤ 4, each run ≤ 1 h, and on append gives the stuck trace → two independent checkers confirm the rule. Any on-commit counterexample → the healing rules change before DRAFT or MIN can be judged. PreVote, CheckQuorum and leader transfer, which DESIGN-V5 §4.2 relies on and the spec lacks, are checked by Q-38; one bad entry on a voter that keeps its id is Q-37.
- Cost: 10 agent-h, 10 CPU-h; not timing. Literature alone: partly (Ongaro's 2015 raft-dev post on the single-server change bug; the healing scenarios are fero's own).

**Q-15. Does a TLA+ model of the slot move give the same verdicts as slot_move.py?**
- Decides: trust in P `slot` (MIN, DRAFT, RUST, SRV, LEAN, SLOG, OBJ); DEV-03.
- E-15: write `SlotMove.tla` from [slot_move.md](../v5-spec/slot_move.md)'s fixed rules: groups as ordered logs that can lose their leader and recover uncleanly, the `#meta` table row, fence, copy, open, the per-slot sequence, carried dedup. The same 9 properties, the same bounds (groups A, B, C; two moves; one unclean recovery), the same 18 mutants; each slot_move.py counterexample replayed as a TLA+ trace.
- Threshold: the same verdict on every bound and mutant. A disagreement is a bug in one model and is settled before the verdict.
- Cost: 10 agent-h, 5 CPU-h; not timing. Literature alone: no.

**Q-16. Is one controller loop on `#meta`'s leader smaller and safer than healing by every group's leader?**
- Decides: C `cent-co` (MIN, RUST, LEAN) against `self` and `self+p` (DRAFT, CELL, LANE); DEV-01, DEV-02, SC-08(e).
- E-16: add a `cent-co` mode to [healing.py](../v5-spec/healing.py) (ported to the shared harness): one loop reads a global view and issues each change as an entry checked against the group's epoch (as TiKV PD's region epoch); the same scenarios and properties P1 to P9, mutants as DEV-10 says, plus `#meta` without a majority, plus RLOG's case: the writer is a server holding a writer epoch committed in the group's log, one more guard on every append. Gives the rules needed (each breaks a property when removed), states, stuck states, and the scenarios where `self` heals while `cent-co` waits.
- Threshold: `cent-co` needs fewer rules, has no stuck state with a live majority, and its wait while `#meta` is down is only a stated delay → MIN's choice stands. A new stuck state, or more rules → per-leader healing wins this axis.
- Cost: 9 agent-h, 5 CPU-h; not timing. Literature alone: partly (PD and KRaft show it works at scale; the rule count is fero's).

**Q-17. Measured, not guessed: how complex is each way of mapping partitions onto groups?**
- Decides: axis P (`fixN`; `fixN` + re-key in CELL; slots + moves in MIN and DRAFT; splits + merges in SPLIT; lanes + range moves in LANE); X4; SC-03, SC-04, SC-08, SC-10, DEV-01, DEV-02.
- E-17: first, **one shared Python harness** in slot_move.py's style: one event alphabet (crash, restart, partition, deliver, tick) and one property module: no acknowledged write lost or doubled; a position never changes meaning; dedup and fence state survive; a cursor resumes with no gap or overlap; grow and shrink finish; one writer per partition. Then each option adds only its own transition rules (`fixN`; `fixN` + re-key; `slot` moves; `pslot`, where a move also splits one resource's slots out of a shared group; `split` + merge; lanes + range moves). Each option's smallest rule set is found by ablation, rules counted and mutants made as DEV-10 says, and a second agent re-runs each ablation. Gives, per option at the same bounds: rules, model lines, state variables, states and seconds, mutants caught, and the extra machinery each property needs (lineage, dedup transfer, fence transfer, cursor refusal). One agent per option, in parallel, after the harness.
- Threshold: among options meeting SC-03, SC-04 and SC-08, the fewest necessary rules wins axis P. If `fixN` + re-key is smaller than slot moves, the verdict states the trade in numbers: CELL's ceiling (16 writers, below SC-03's F_w of 64, broken cursors, no shrink) against the moves' rules.
- Cost: 28 agent-h, 15 CPU-h; not timing. Literature alone: partly ([V5-UNITS](../V5-UNITS.md); CockroachDB on merges).

**Q-18. Do 1,024 slots spread load well enough, with hot keys, as groups grow?**
- Decides: the slot count, fixed forever, so DEV-09 needs it now; the slot family against SPLIT's key-level splits; SC-03, SC-10.
- E-18: a Python simulation: 1e4 to 1e7 partitions; uniform, Zipf 0.8, 0.99 and 1.2, Pareto room sizes, one hot partition, a moving hotspot; 256, 1,024, 4,096 and 16,384 slots; 1 to 256 groups; placement by contiguous ranges, by greedy packing, and greedy with one move at a time. Gives max/mean group load, moves needed after a load shift, and the group count at which one slot alone exceeds a fair share; ideal key-level splits as the reference. Also gives the **effective writers per resource** (SC-10): the largest group count at which max/mean ≤ 1.25 under Zipf 0.99, searched up to 1,024 groups, since DRAFT and V5-UNITS claim up to 1,024 writers per resource. (The fixed cost per slot × resources is E-36's.)
- Threshold: 1,024 keeps max/mean ≤ 1.25 up to 64 groups on every distribution, except where one partition alone exceeds 1/G (a ceiling for any design) → keep 1,024. If 4,096 passes where 1,024 fails → change it now (cheap now, a format change later). Effective writers below F_w (64) with 1,024 slots → the slot count changes now, or SC-03's ceiling fails for every slot row. The effective number, not 1,024, is the ceiling each slot row states.
- Cost: 4 agent-h, 1.5 CPU-h; not timing. Literature alone: partly (Couchbase's 1,024 vBuckets, Redis Cluster's 16,384 slots: the choices, not balance numbers).

**Q-19. What do slot-shaped positions cost: bytes per record, and cursor size over a whole resource?**
- Decides: O `slot` (MIN family) against `off` (CELL, LANE) and `off+lin` (SPLIT); P-03, P-05, P-07; DEV-09.
- E-19: encode the record header with (slot, seq) varints against one offset, in Node and Rust: bytes and ns per record. Whole-resource cursors of 1,024 (slot, epoch, seq) entries, raw, delta-coded and run-length coded, after 0, 10 and 100 moves; bytes when 10,000 clients reconnect at once.
- Threshold: ≤ 4 extra bytes and ≤ 50 ns per record, typical cursor ≤ 256 B and worst ≤ 8 KB → O `slot` stands. A reconnect storm over 100 MB → a server-side cursor token, priced as one more mechanism.
- Cost: 3 agent-h, 0.2 CPU-h; timing (light, the ns part). Literature alone: no.

## 5. Semantics

**Q-20. Which dedup option holds exactly once with the fewest rules, across failover and slot moves?**
- Decides: D, so `win` (DRAFT, LANE, SPLIT, SLOG) against `sess` (MIN and its family, CELL, OBJ), `pid` (ISR) and `keys`; Y (`fwd` against `smart`); F-02, TEST-03, DEV-01.
- E-20: extend the L2 reference model (Python, in the shared harness) with retries whose answers are lost, failover mid-retry, a slot move mid-retry, a refusal followed by a stale copy on another link, a client restart, and expiry by the leader's time. Model each option, each under Y `fwd` (a write through a non-leader server, retried through another server, with the first forward landing late) and Y `smart` (straight to the leader). Measure Node memory per session at 1e4 and 1e6 clients.
- Threshold: the option with the fewest rules that holds F-02 and TEST-03 in every scenario wins. If `sess` holds them only with session state copied per slot, its memory at 1e6 clients is priced in the verdict. If `sess` under `fwd` needs any hop rule that `smart` does not, that rule is counted for every `fwd` row; if not, Y is decided on latency alone (E-01's round trip against P-01's bar).
- Cost: 7 agent-h, 1 CPU-h; not timing. Literature alone: partly (Raft thesis §6.3; LogCabin; Kafka's KIP-98 and KIP-360 for the pitfalls).

**Q-21. Which time rule gives correct TTLs and safe leases under clock skew, clock jumps, GC pauses and leader changes?**
- Decides: T (`clamp` in the draft, `hlc`, `mono`, `tt`); P-02, P-10, P-13, F-06, TEST-02.
- E-21: a Python simulation of 3 to 5 nodes: drift ±200 ppm, skew up to `skew.max`, jumps of 1 s to 1 h both ways, a leader paused 1 to 5 s, leader changes. Checks: no fenced write by an older lock holder commits after a newer token is seen; how often two holders act without fencing; a TTL row expires within one tick + `skew.max` and never before its ttl by the writer's clock; leases across a leader change; every replica agrees on expiry.
- Threshold: the option that passes every check with the fewest rules wins. Reasoned expectation, to confirm or refute: fencing makes lock safety independent of clocks, and TTLs need a wall-time order (`clamp` or `hlc`).
- Cost: 6 agent-h, 0.5 CPU-h; not timing. Literature alone: partly (Jepsen's etcd 3.4.3 report, 2020; Kleppmann 2016 on locks; Kulkarni et al. 2014 on hybrid logical clocks; etcd's lessor).

**Q-22. Does the proposed API cover every pattern on the kernel's five operations, and which patterns need atomicity across partitions or methods at the writer?**
- Decides: K `lib` against `kern` and `hyb`; X (`none` or `saga` against `2pc`, `ramp` or `ktxn`); U (`any` against `ldr`); P-01 to P-22; TEST-01, TEST-12, TEST-13.
- E-22: a runnable prototype in Node: one process, but **every resource split into at least 2 in-memory groups over slots**, so the debts of several groups can show (views, fences, saga steps, consumer offsets and derived outputs in different groups). Injected faults: a leader change (the uncommitted tail lost, the log-end state dropped) and one slot move during each pattern's check. data's fold through the substrate seam; the five operations (append, read, snapshot, change members, hand over); L2 (conditions, ops, TTL, dedup) as a library; the API exactly as [API.md](API.md)'s draft writes it. Every pattern (DESIGN-V5 §5.1 plus P-19 to P-22: request and reply, delayed jobs and waiting takes, a shape change with an upcaster across three versions) as an example of at most 40 lines with a check. Client histories are recorded and run through Porcupine and Elle (TEST-13), and every check runs again under 100 seeds of TEST-12's shuffle across partitions. Also: a check-then-set method called by two callers at once, on a non-writer and on the writer; the time to create a node and run a scenario.
- Threshold: all patterns run on the five operations and pass their checks and the outside checkers with leader changes and moves injected → K `lib` confirmed. A pattern needing a sixth operation, or atomic visibility across partitions, is named with its cheapest fix; X `saga` is enough only if no MUST needs atomic visibility. Check-then-set safe only at the writer → U `ldr`, or a condition on every such write, is required. An example that passes only without the shuffle leans on order that will not last. A new node plus a scenario ≤ 5 ms → TEST-01 holds.
- Cost: 26 agent-h (three agents), 1.5 CPU-h; not timing. Literature alone: no.

**Q-23. Can live views (top-k, group, sum, filter) over a resource held by several groups be merged exactly?**
- Decides: P-12 for every multi-group candidate (MIN, DRAFT, CELL, LANE, SPLIT); DATA-04, DATA-05.
- E-23: with data at HEAD, run each operator over one group and over 4 and 16 slot groups; merge the per-group outputs by each operator's merge rule; compare with the one-group result after each of 1e5 random commits, slot moves included.
- Threshold: every operator P-12 names merges exactly → multi-group resources keep P-12. One that cannot → a stated one-group ceiling (SC-10), or data gains a merge contract (a SCHEDULE_VERSION bump, planned now).
- Cost: 6 agent-h, 0.5 CPU-h; not timing. Literature alone: no.

**Q-24. Do sagas with fenced locks meet P-15's MUST (every unit finishes or is undone, even with paused holders), and can RAMP meet its SHOULD cheaply?**
- Decides: X `saga` (every candidate but PD and ISR) against `ramp`, `2pc` and `ktxn`; P-15; DEV-01.
- E-24: a Python model (shared harness) of the saga library: an intent row, steps on partitions in up to 3 groups, locks with fencing tokens, a paused holder that wakes late, a crash at every step, a later holder that finishes or undoes. Beside it, **RAMP-Fast** on the same groups: writes carry (unit id, sibling partitions) in two rounds, and readers repair fractured reads in a second round by unit id. Gives, for each: held or a counterexample, the rule count, whether writers must follow `#locks` (fences across groups), and for RAMP the read cost in rounds. Histories go through Elle (no fractured read for RAMP).
- Threshold: the saga holds with ≤ 3 novel rules → `saga` is enough for the MUST. RAMP holds read atomicity with ≤ 2 novel rules → P-15's SHOULD is priced at that, and X `ramp` is open to every slot row; otherwise atomic visibility is priced from published designs (Kafka's `read_committed`, Percolator).
- Cost: 8 agent-h, 2 CPU-h; not timing. Literature alone: partly (Garcia-Molina and Salem 1987).

## 6. Scale, hosting and client links

**Q-25. What does each candidate's failure detector cost when idle at n = 100 members?**
- Decides: PERF-12, SC-07, X8; MIN and DRAFT (one ping per member pair) against ISR and SLOG (sessions to a controller).
- E-25: (a) count frames/s at n = 100 from a Python placement model (resources, `copies` 3, each candidate's groups) for per-group heartbeats, per-pair pings with quiet groups, and controller sessions; (b) measure one Node and one Rust process holding 99 links that ping every 500 ms, plus 2,000 quiet groups: CPU % and memory; (c) run 100 small Node processes on the box: total idle CPU.
- Threshold: ≤ 1% of a core per process and ≤ about 20,000 frames/s in all → PERF-12 holds. Above → that candidate needs a bound on peers per member, priced as one more mechanism.
- Cost: 4 agent-h, 1 CPU-h; timing (light: the CPU %). Literature alone: partly (CockroachDB's store liveness).

**Q-26. How many groups does a hosted log-tier process hold for 1,000 sleeping projects, and what does a dormant group cost?**
- Decides: SC-11, DEP-04, decision 17 (`#meta` per project, or one shared metadata group); axis N (`proc`, `pool`, `tier`); the group counts of MIN, MIN-P, CELL (16 per resource), LANE (64 per project), SLOG and OBJ.
- E-26: model groups per process for 1,000 projects of 1 to 20 resources, per candidate and per N option (projects with 100,000 resources are E-36's); with E-11's harness, measure a quiet group's memory, a dormant group's cost (state on disk only, loaded on wake) and its wake time; check that a quiet project sends 0 frames.
- Threshold: 1,000 projects in ≤ 2 GB, 0 frames for quiet projects, one project writable ≤ 1.5 s after wake → SC-11 and DEP-04 hold. A candidate over budget needs dormant groups (one mechanism) or decision 17b.
- Cost: 4 agent-h, 1 CPU-h; not timing (the wake time runs under `flock -x`). Literature alone: no.

**Q-27. Can one Node server hold 10,000 idle client links, over TLS, inside its memory budget?**
- Decides: SC-12, DEP-07, DEP-13; whether the client edge must be native or a proxy, for every candidate.
- E-27: a Node server with 10,000 idle links, plain TCP and TLS, a heartbeat every 30 s: memory per link and idle CPU; then 1,000 active subscribers at 10 messages/s each.
- Threshold: 10,000 TLS links in ≤ 500 MB and ≤ 1% of a core → a TS edge stands. Above → a native edge or a proxy is planned now. Browsers over WebSocket are E-40; a reconnect storm on this server is E-39.
- Cost: 3 agent-h, 0.3 CPU-h; not timing (memory; the CPU line runs under `flock -x`). Literature alone: no.

## 7. Durability tiers and test tiers

**Q-28. How fast is a commit when the object store is the log (a conditional PUT per commit)?**
- Decides: OBJ against every disk-based candidate; S `+tier`; SC-05, DEP-04, PERF-08.
- E-28: literature first: S3's performance guidance, S3 Express One Zone, S3 conditional writes (If-None-Match, August 2024; If-Match, November 2024), and the latencies and request prices WarpStream and SlateDB publish. Also, for OPS-13: how WarpStream, Neon and Kafka's tiered storage erase one partition or one tenant from shared segments (per-tenant keys and crypto-shredding, or segment rewrites) and what it costs. Then MinIO (one binary) on this disk: conditional PUT p50 and p99 for 1 KB to 1 MB, to separate the protocol's cost from the network's.
- Threshold: a real store's p99 PUT > 10 × C → OBJ fails PERF-08 at `persisted` and stays only as a storage tier (sleep, wake, forks, history). The request cost at 1,000 commits/s is stated per month; if batching to cut it pushes p99 past the bar, the same verdict.
- Cost: 4 agent-h, 0.2 CPU-h; not timing (the MinIO part is light timing). Literature alone: yes, mostly (AWS's S3 documents; WarpStream's and SlateDB's docs).

**Q-29. Can this box run the power-loss test tier (LazyFS, a filesystem that drops unsynced writes) that F-01 and F-10 need from phase 2, and how much disk must L0 keep in reserve for a full disk?**
- Decides: no candidate; it prevents a phase-2 surprise in F-01, F-10, F-20 and the real-disk tier, and fixes L0's reserved space now.
- E-29: (a) build LazyFS (dsrhaslab/lazyfs, FUSE 3) and mount it; run a Node journal writer with fdatasync; inject a cache clear and torn writes; check that synced records survive and unsynced ones vanish. (b) **Disk full:** on a 64 MB tmpfs or loop filesystem, a solo journal writer and E-02's pipeline: fill it; list which operations need disk (a remove, a term change, a snapshot, a retention pass); measure the reserve each needs; check that a full follower stops acknowledging; free space and check that writes resume.
- Threshold: (a) works → the tier is planned on this box; blocked → say exactly why now, and plan an in-sim disk model plus a second box. (b) The reserve per operation kind and the refusal order are written into L0's format now (DEV-09).
- Cost: 5 agent-h, 0.4 CPU-h; not timing. Literature alone: no.

## 8. Gaps found in review

These sixteen questions came from two completeness critics. Each is a place where a later phase could surprise us, or where the verdict could not be the same for every reader.

**Q-30. Do consumer groups and derived resources stay exactly once when the outputs and the cursor sit in different groups, across a restart longer than the dedup horizon?**
- Decides: D (`win`, `sess`, `pid`, `keys`, `srcpos`); X (`saga` against `ramp` and `ktxn`); P-08, P-17, F-02; every row with several groups per resource.
- E-30: extend E-20's model (shared harness) with source A (2 slots), output B (2 groups), and the cursor in a third group (`#groups` or a row of B); a consumer that crashes at every step and restarts after (a) less than and (b) more than the dedup horizon. D options as E-20, plus `srcpos` (the attempt id is the source position, kept for the source's retention). Property: B = f(A) exactly; Elle on the outputs (TEST-13).
- Threshold: if only `srcpos` holds, or only putting the cursor in one partition with its outputs, D carries a retention-length key table: priced in DEV-01 with its memory per consumer, and P-08 and P-17 name the rule. If nothing holds without X `2pc` or `ktxn`, X moves.
- Cost: 5 agent-h, 1 CPU-h; not timing. Literature alone: partly (Kafka Streams' exactly-once, KIP-129 and KIP-447).

**Q-31. Does the subscribe protocol (L3) keep its promises across failover, slot moves and relays?**
- Decides: P-03, P-05, P-07, F-04, W `any`, SC-14's far reads; every row that serves subscriptions from followers; the cursor shape that DEV-09 fixes in phase 1.
- E-31: an exhaustive Python model in slot_move.py's style: one client, two servers (leader and follower), one relay (which may sit across a far link), groups A and B with one slot moving from A to B, a leader crash, and a follower that reloads a snapshot. Modes `state` (conflated) and `log`; credits of one record. Properties: `log` gets every committed record of its partitions once, in order; `state` after each snapshot equals the fold of the committed log for its partitions, with no ghost rows; nobody answers from an unloaded fold; a resolved write is visible to its writer's own subscription; after `moved`, `END` or `retry`, a fault-free path reaches a serving replica. Mutants as DEV-10 says.
- Threshold: all hold at the stated bounds within 1 h. Any counterexample is a rule change in DESIGN-V5 §4.4 before phase 1 fixes the cursor shape.
- Cost: 8 agent-h, 3 CPU-h; not timing. Literature alone: no (v4's M11 resync and M12 spoke monitors in `sim/` show where this layer broke before).

**Q-32. Which mechanisms share state in each row, and does every such pair sit inside one model?**
- Decides: DEV-02 (M and S) for every row; judging rule 3's tie-break.
- E-32: (a) for each row, list its state variables and, for each mechanism, which variables it reads and writes, mechanically from the row's report; pairs that share a variable form the matrix. (b) One composed model of the riskiest crossing that two or more rows share: slot move × leader change × a voter change of A or B × log drop or snapshot × dedup carry; bounds as E-15; properties are the union of E-15's and E-14's. (c) Every pair left out of (b) gets a written independence argument, which a second agent checks.
- Threshold: a row with a pair that is neither modelled nor shown independent fails DEV-02's MUST. A counterexample in (b) that neither single model finds is reported as the strongest evidence against the rows that share the crossing.
- Cost: 10 agent-h, 6 CPU-h; not timing. Literature alone: no.

**Q-33. Does genesis found exactly one cluster per project and always finish, and does a restore keep tokens and cursors honest?**
- Decides: SC-01, SC-02, DEP-18, OPS-01, OPS-07; the mechanism count of every row with `#meta` (all but V4 and BUY).
- E-33: an exhaustive model of DESIGN-V5 §4.2's genesis: 3 seeds plus one one-box run folder; seeds start in any order and restart with or without their dir; links drop; the `cluster-id` file is created, or found stale; a dir is briefly unreadable. Safety: at most one cluster id ever commits a client write for a project. Liveness: once a majority of seeds is up and linked, founding completes. Then a restore to a past position (OPS-07): new slot epochs, fence tokens above every token handed out, sessions cleared. Mutants as DEV-10 says, including "a stale folder ignores a briefly unreadable dir".
- Threshold: holds → the draft's genesis stands as one counted mechanism. A two-cluster trace → it is replaced by an explicit `fero init` on the first start across boxes (CockroachDB's shape), which costs SC-02's "no setup" across boxes; the user decides.
- Cost: 5 agent-h, 1 CPU-h; not timing. Literature alone: partly (Consul's `bootstrap_expect`, etcd's `initial-cluster-state`, CockroachDB's `init`).

**Q-34. Can one Node process wake 10 GB of rows to writable within a minute, with GC pauses under 1 s?**
- Decides: SC-05, SC-10's rows per process, F-06; F `all` against `ldr`; L `ts` against a native fold; decision 13; conflict X15.
- Known (measured here with `node -e`): Node 22.22.0's default heap limit on this box is 2.05 GiB. At DEP-13's 2 KB a row, about 1e6 small rows fit on the default heap; 10 GB is about 5e6 rows.
- E-34: generate a 10 GB snapshot of small rows; load it through `api/substrate.ts` into data at HEAD (a) on the main thread, (b) on a worker plus a main-thread projection (decision 13). Measure time to the first committed write, RSS, the `--max-old-space-size` needed, and max and p99.9 GC pause under 10k writes/s afterwards. The box has 15 GB of RAM, so (b) may not fit; if not, that is said, and 5 GB is run and scaled.
- Threshold: ≤ 60 s and a max pause < 1 s → F `all` in TS meets SC-05. Otherwise state off the V8 heap (a native fold, LEAN's leader-only fold, or SC-06's cold rows) is planned now, and SC-05's bar is stated per storage form.
- Cost: 4 agent-h, 1 CPU-h; timing. Literature alone: partly (V8's heap limits).

**Q-35. On a shared journal, how much do big records and a busy tenant hurt everyone else's p99?**
- Decides: SC-11's neighbour clause, SC-15; S `jrnl` against `walg` for the log tier; N `tier` and `pool`; DEP-12.
- Known (a critic's probe on this box, `$SP/critic/hol/`, Node 22.22.0, `writev` + `fdatasync`, 3 runs of 1,000 batches): batches of 64 × 100 B had p99 0.39-0.43 ms; one 1 MB record in every 10th batch raised it to 1.76-1.82 ms, 4.2×. This run re-checks it.
- E-35: on E-12's journal: (a) one partition writing 1 MB records beside 100 B writers; (b) 100 tenants on one log-tier process, tenant A at its quota in 1 MB and in 64 KB batches, tenant B at 100 writes/s. Variants: big records outside the shared batch (their own file, a pointer in the log); batches capped at 64 KB; round-robin batching across tenants; one journal per tenant. Measure the victim's commit p99 alone and beside the load, 3 runs, under `flock -x`.
- Threshold: victim p99 ≤ 1.2× (SC-15) and ≤ 1.1× between tenants (SC-11) → the shared journal holds. Above → the cheapest passing variant is priced now as a mechanism, and L0's format carries it (DEV-09).
- Cost: 3 agent-h, 0.5 CPU-h; timing. Literature alone: partly (Kafka's `message.max.bytes` guidance).

**Q-36. What does a project with 100,000 small resources cost?**
- Decides: SC-13, SC-10; G `res`, `shard`, `pslot` and `lane` (MIN against MIN-P and LANE); the `#meta` table format that DEV-09 fixes in phase 1; X18.
- E-36: with E-11's harness and a model of `#meta`, at 1e2, 1e4 and 1e5 resources: create and open latency, `#meta` bytes per voter, groups per process, and idle frames, for MIN (a group per resource, 1,024 slot rows each), MIN-P (groups owned by the project), LANE (64 lanes) and a run-length-coded slot table. Also the fixed cost per slot (sequence, dedup and fence state) × resources, which E-18 leaves out.
- Threshold: above 2 KB per idle resource, or above 2,000 groups per process at 1e5 → the slot table is run-length coded from phase 1 and resources share groups (MIN-P's rule), or the ceiling is stated with its error (SC-13).
- Cost: 4 agent-h, 1 CPU-h; not timing (the open time runs under `flock -x`). Literature alone: partly (TiKV's cross-table merge; CockroachDB's coalescing).

**Q-37. Does each row keep acknowledged writes when one voter keeps its id but loses or corrupts one fsynced entry below the commit point?**
- Decides: F-22, F-10; axis Z (`crash`, `rejoin`, `par`); R `vsr`; DEV-01.
- E-37: add to E-14's etcdraft.tla an action that drops or corrupts one durable entry on one server without changing its id; check the 8 invariants plus "no committed entry is lost". A counterexample is expected (FAST'18). Then model the cheapest fix (a checksum per entry; a damaged replica refuses to vote or ack until a peer repairs it) and count it as DEV-10 says. Also a fault with one bad entry on each of two replicas at different offsets: how often each Z option stays writable without F-12's operator step.
- Threshold: a fix of ≤ 2 rules keeps Raft, with Z `par` or `rejoin` as the count says; more → R `vsr` (VR Revisited plus protocol-aware recovery, as TigerBeetle runs it) is costed as a candidate row.
- Cost: 6 agent-h, 4 CPU-h; not timing. Literature alone: partly (Ganesan et al., FAST'17; Alagappan et al., FAST'18).

**Q-38. Does Raft with PreVote, CheckQuorum and leader transfer stay live under partial partitions, one-way loss and a fail-slow leader?**
- Decides: F-17, F-18, F-05, DEP-01 (rolls use leader transfer); X17; every Raft row; DEV-01 (a store-liveness lease or a slow-leader rule would be a mechanism).
- Known: DESIGN-V5 §4.2 relies on all three; etcd's raft has them in code; its TLA+ spec has none (Q-14).
- E-38: (a) a small Go harness on etcd's raft (`$SP/dl/raftsrc/raft/`) with all three on, under Jensen et al.'s non-transitive topologies, the Cloudflare 2020 topology, and one-way loss; (b) the same harness with one node's fsync and step 10× slower; (c) one real-TCP run of three etcd 3.5.17 members with packets dropped by `iptables`, if the box allows it. Gives time to a writable leader, leader changes per 10 × `election.ms`, and commit p99 outside the window.
- Threshold: a stuck or flapping trace while a connected majority exists, or a slow leader that holds on past 5 × `election.ms`, names the extra mechanism needed (for example CockroachDB-style leader leases on store liveness), and it is priced in DEV-01 now. None → Raft as published meets F-17 and F-18.
- Cost: 8 agent-h, 3 CPU-h; not timing (part (c) is light timing). Literature alone: partly (Howard 2020; Jensen, Howard and Mortier, HAOC'21).

**Q-39. What happens at twice capacity, and in a reconnect storm?**
- Decides: F-19, F-13, X17; admission control as a mechanism (DEV-01); the client's retry rules, which are API shape.
- E-39: E-02's pipeline (TS and Rust) at 0.5, 1, 1.5 and 2× its measured maximum, with clients that retry on refusal with and without jittered backoff: goodput, admitted p99, retries a second. E-27's server with 10,000 subscribers, killed and resubscribing: time until all have resubscribed, the server's p99, bytes and CPU.
- Threshold: goodput ≥ 80% of peak at 2× and full resubscription ≤ 10 s with p99 ≤ 2 × steady → bounded queues plus retry-after are enough. Otherwise admission control (or server-side cursor tokens for resubscription) is priced now as a mechanism.
- Cost: 5 agent-h, 1 CPU-h; timing. Literature alone: partly (Bronson et al., HotOS'21; Huang et al., OSDI'22).

**Q-40. Can a browser or an edge worker be a full client over WebSocket?**
- Decides: P-19, P-05, SC-12, DEP-07; L0's transports and L3's client shape (DEV-09); with Q-27, whether the client edge must be native.
- E-40: a browser client (headless Chromium if one can be fetched; else a WebSocket client in a Worker-like runtime) against a Node server: the gzip size of `data` plus the client; deliveries a second per server core over WebSocket against TCP; cold-client time (start, import, connect, TLS, door, first committed write) in Node and in a Worker-like runtime.
- Threshold: bundle ≤ 60 KB gzip, WebSocket fan-out ≥ 0.7 × TCP's and a cold client within P-19's bar → P-19 holds in TS. Fan-out below 0.7 × TCP's → a native edge (Q-27) is planned now. A bundle above the bar → a client build of `data` is planned now (a data-side change).
- Cost: 5 agent-h, 0.5 CPU-h; timing (light). Literature alone: no.

**Q-41. What does each row cost the hosted platform, per project per month?**
- Decides: DEP-21; OBJ and SLOG against the Raft rows for hosting; axis N; decision 2b.
- E-41: literature and a spreadsheet: a cost table per row at DEP-21's three loads, from cited AWS, S3 and Fly prices, each row's placement rules and DEP-13's bytes per row: memory-hours, bytes across failure domains, object-store requests, and the log tier's share.
- Threshold: a row more than 2× the cheapest at any load needs a written reason in VERDICT.md. If OBJ or SLOG is the cheapest by more than 2× at 5,000 writes/s, the hosted shape is reopened (decision 2b). E-28's MinIO timing decides nothing here; the cited prices do.
- Cost: 3 agent-h, no CPU; not timing. Literature alone: yes.

**Q-42. Can a recorder of every kernel input run all the time, cheaply, and replay a production incident in the sim?**
- Decides: OPS-11(d) (M) and its always-on clause (S); the recorder's format, which is L0 shape (DEV-09).
- E-42: E-02's pipeline at 50k appends/s, recording every kernel input (frames, ticks, disk completions) beside the journal: CPU %, bytes a second, and replay fidelity (byte-identical effects when replayed).
- Threshold: ≤ 3% CPU and ≤ 2 × the journal's bytes → always on from phase 1. Otherwise it is sampled, and the gap is stated.
- Cost: 3 agent-h, 0.5 CPU-h; timing. Literature alone: no.

**Q-43. Do two `data` versions, and two Node versions, fold the same records to the same rows?**
- Decides: OPS-12, F-21, DATA-04, DEP-10; what the fold-version entry must pin before phase 1 fixes the record header.
- E-43: fold one seeded stream of 1e6 records (arrays, deletes, nested paths) with `data` at two commits one `SCHEDULE_VERSION` bump apart, and on Node 22 and Node 26 (fetched); diff the snapshots byte for byte.
- Threshold: none picks a row, since OPS-12 is a MUST either way. Any difference names a clause or a Node behaviour (STATUS already notes array rows whose screen "can still depend on arrival order") that the fold version must pin, and it becomes a pin of its own.
- Cost: 3 agent-h, 0.5 CPU-h; not timing. Literature alone: no.

**Q-44. How much of fero runs on an outside log, and which semantics need fero's own kernel?**
- Decides: BUY as the floor for DEV-01 and DEV-05; which MUSTs a published system meets more cheaply.
- E-44: a two-day prototype of P-01, P-09, P-10 and P-14 on nats-server 2.10.22 (`$SP/dl/nats/`) with JetStream, with `data` folding the stream on the client: KV with per-key revision compare-and-set, the `Nats-Msg-Id` dedup window, work-queue retention. Report fero's lines of code, the requirements it meets, and the gaps (for example, a condition over a row against JetStream's per-key revision check).
- Threshold: none picks BUY (it fails TEST-10, DEP-20 and G2 by construction). Every row's DEV-05 is reported as a multiple of BUY's lines, and any MUST that BUY meets more cheaply is named in that row's report.
- Cost: 16 agent-h, 1 CPU-h; not timing. Literature alone: partly (JetStream's docs).

**Q-45. How is fero driven by each competitor's own tool?**
- Decides: which rows of PERF-02 to PERF-07 are comparable at all (PERF-01); which gateways are phase-1 work rather than phase 5; DEV-05's gateway lines.
- E-45: for each row of PERF-02 to PERF-07, name the driver: a gateway, a ported load loop, or a driver plugin. Build the cheapest on E-22's prototype: a RESP shim (GET, SET, INCR) for memtier and redis-benchmark; a NATS PUB, SUB and HPUB shim for `nats bench`; an OMB driver of about 300 lines; an etcd v3 gRPC front with Put, Range, Txn and LeaseKeepAlive. Any harness of fero's own uses HdrHistogram with coordinated-omission correction and the competitor's client count, pipeline and sizes. Run each once against the prototype to show it drives.
- Threshold: a row with no faithful driver is "not comparable" in VERDICT.md, never "won". The gateways the bars need become requirements with their command lists, and each row's DEV-05 counts them.
- Cost: 10 agent-h, 1 CPU-h; not timing. Literature alone: no.

## 9. The plan

**What each axis waits on.**

| Axis (SPACE §2) or requirement group | Experiments |
|---|---|
| L language, H where fero runs | E-02, E-03, E-04, E-07, E-08, E-09, E-27, E-34, E-40 |
| I Raft core | E-10, E-14, E-38 |
| G, P, O groups, partitions, positions | E-11, E-12, E-15, E-17, E-18, E-19, E-23, E-26, E-36 |
| C control plane | E-14, E-16, E-33 |
| K, U, X semantics' home, user code, atomicity | E-03, E-22, E-24, E-30 |
| D dedup, T time | E-20, E-21, E-30 |
| F fold | E-05, E-06, E-34 |
| Q rungs, R `obj`, S storage | E-02, E-09, E-12, E-28, E-35 |
| Y routing | E-01, E-20 |
| M threads and I/O | E-02, E-12 |
| Z storage faults | E-14, E-29, E-37 |
| N tenancy | E-26, E-35, E-41 |
| R `rlog` and `vsr`; BUY | E-13, E-16, E-37, E-44 |
| the subscribe layer (L3) | E-31 |
| composition (DEV-02) | E-32 |
| operations (F-19 to F-21, OPS-11, OPS-12, DEP-21) | E-05, E-29, E-39, E-41, E-42, E-43 |
| the competitor bars' drivers (PERF-01) | E-45 |
| test and deploy tiers | E-06, E-13, E-22, E-29, E-33 |

**Track A: fetch, build and read, now, all in parallel** (compiles under `flock -s`). Build fio, memtier_benchmark, the nats CLI, etcd's `benchmark`, crane plus the Redpanda image, MinIO, CommunityModules-deps.jar, LazyFS (E-29(a) is done here), the napi-rs toolchain and raft-rs. Added after review: Porcupine (Go), Elle (its command-line jar), Maelstrom (a jar), the deno_core and rquickjs crates, Node 26 (E-43), and a headless Chromium if one can be fetched (E-40). Do the reading parts of E-28 (now with erase), E-10(c), E-11, E-20, E-21, E-41 (prices) and E-44 (JetStream's docs). Each fetch goes in `$SP/dl/<name>/` with its URL and checksum in the experiment's `fetch.sh`.

**Track B: models and prototypes, in parallel** (`flock -s`; at most three heavy jobs at once on 4 vCPU):
1. E-14 first: E-16, E-37 and E-38's model questions build on its verdict.
2. The shared harness (E-17's first step), then E-17 (one agent per option) and E-18: together they decide axis P; E-19's size part with them.
3. E-15, E-20, E-21, E-24, E-30, E-31, E-33, in any order, on the shared harness.
4. E-16 and E-37, once E-14 is done; E-38(a, b) at any time.
5. E-22 once API.md has a first draft, with E-23 beside it, then E-45 on its prototype. E-10(a, b), the port trial, and E-44, at any time: much agent time, little CPU.
6. The model parts of E-25(a), E-26 and E-36; E-43.
7. E-32 last: it reads every row's report.

**Track C: the timing queue, one run at a time under `flock -x`.** A timing run waits until every `flock -s` holder is done, so Track B works in blocks and leaves the box free for Track C's blocks.
1. E-01: it fixes C for everything after it, and says whether this box's flushes are honoured.
2. E-02: TS, TS on one and on several workers, Rust, Go; real disk and tmpfs.
3. E-09e etcd, E-09a Redis, E-09b NATS, E-09c Kafka, E-09d Redpanda, as their tools finish in Track A.
4. E-03 and E-04: with E-02 and E-09 they decide axis L.
5. E-05, E-06, E-07, then E-34.
6. E-12, then E-35, then E-11 (Go and Rust rows first; the TS row when E-10's port runs).
7. E-13, E-08, E-39, E-42.
8. The light ones: E-25(b, c), E-27's CPU line, E-19's ns, E-26's wake, E-28's MinIO part, E-36's open time, E-38(c), E-40.

**Totals** (reasoned estimates): about 340 agent-hours (207 before review); about 27 hours of the box alone for the timing queue (the competitors, the many-groups run E-11 and the pipeline take 13 of them); about 64 CPU-hours of model checking, about 22 wall hours at three jobs at a time. The first decision, the language (E-01, E-02, E-09, E-03, E-04), needs about 11 hours of the box alone and can land first; axis P (E-17, E-18) runs beside it.

**What this box cannot show.** Real round trips between machines; independent disks (three replicas share one disk's fsyncs, so matched runs stay fair but absolute numbers are pessimistic; E-02's tmpfs variant emulates them); whether its flushes reach the platter (E-01 checks, and bars are also stated against a cited figure); filesystems other than ext4 (E-12's verdict says so); NVMe; Redpanda's thread-per-core at its intended size; write scaling beyond 4 cores (SC-03 past 4 processes is sim only); real regions (SC-14 is sim only); real S3 latency (cited in E-28). Each experiment's README says which of these its numbers miss.

**How results flow back.** Each experiment's README ends with one line: "Q-nn: the answer. Moves: candidate, up or down, on requirement ids." The candidate reports and [VERDICT.md](VERDICT.md) cite those lines. If an experiment is blocked, its question keeps its literature answer, marked cited, and the gap is listed in VERDICT.md; under the judging rule, the MUSTs it would have closed stay **open**, never failed.

## 10. Added after the user's permission (2026-11-06)

On 2026-11-06 the user wrote: "allow Redpanda, memtier_benchmark and LazyFS and anything else you need". The first runs had fallen back where the session's safety check refused a tool (TOOLS.md). These entries take back what that cost, and add one check the new tools make cheap.

**Q-09a, memtier addendum.** E-09a ran Redis with redis-benchmark only. E-09a2 runs memtier_benchmark, PERF-02's first-named tool, on the same three setups (`default`, `aof`, `aof-r3`), with its HdrHistogram output and a mixed GET/SET load, and drives E-45's RESP gateway with it too. Threshold: memtier's numbers agree with redis-benchmark's within the spread, or the difference is explained; PERF-02's bar is stated from memtier. Folder `E09a2-redis-memtier/`. Timing.

**Q-22, real-Elle addendum.** E-22 checked its histories with a Go port of Elle (from PingCAP's tipocket), since Clojars was blocked. E-22b re-checks the same saved histories (`$SP/e22v`) with real Elle 0.2.8 (list-append, the saga workload) and real Knossos 0.3.16 (a sample of the register histories, beside Porcupine). Threshold: the same verdict on every history, including the 26 self-test histories; any disagreement is root-caused to a checker bug or a history-export bug. Folder `E22b-real-elle/`. Heavy.

**Q-14, completion addendum.** E-14's liveness sweep at 3 to 4 servers did not finish; five healing scenarios were defined but not run; the DEV-10 mutants ran only in random simulation; and local stand-ins replaced the CommunityModules jar. E-14b finishes these with the real CommunityModules jar, TLC checkpoints (`-checkpoint`, `-recover`) to split long runs into holds of 30 minutes or less, and whatever coarsening the liveness check needs (stated). Threshold: Q-14's own. Folder `E14b-membership-liveness/`. Heavy.

**Q-46. Does the TypeScript port of etcd raft (E-10), run as real processes, give a linearizable key-value store under partitions?**
- Decides: trust in every `port` row (MIN, MIN-TS, MIN-P, LEAN, RLOG, DRAFT, CELL, LANE, SPLIT): DEV-04, DEV-05, TEST-10, TEST-13. E-10 checked the port's Raft steps byte for byte in one process; nothing yet checks it end to end, with a log, a state machine, reads, and real message passing between processes.
- E-46: wrap E-10's port as a Maelstrom node (Jepsen's workbench: real node processes, a simulated network with partitions, Knossos and Elle as checkers). Run Maelstrom's `lin-kv` workload with 3 and 5 nodes, partitions and process pauses, reads through ReadIndex and through the log; then a planted bug (reads served by a follower without ReadIndex) that the checker must catch.
- Threshold: every clean run valid; the planted bug caught → the port carries a real store. A real anomaly → a bug in the port or its host, root-caused before any `port` row is rated.
- Cost: 4 agent-h, 2 CPU-h; heavy, not timing. Folder `E46-maelstrom-raft/`.

## Considered and not added

Two critics reviewed this file on 2026-11-06. Their findings were folded in above. Both proposed new questions from Q-30 up, with clashing numbers, so they were merged and renumbered: the many-resources questions became Q-36; the 10 GB question and the heap finding became Q-34; the two neighbour questions became Q-35; the storage-fault axis and the bad-entry question became Q-37; browsers Q-40; cost Q-41; the recorder Q-42; fold equality Q-43; BUY Q-44; the drivers Q-45. These parts were left out or placed elsewhere:
- **A separate question for SIDE's local seam:** folded into E-03, which already measures the napi seam it is judged against.
- **E-18 pricing the fixed cost per slot × resources:** moved to E-36, which owns resource counts.
- **Q-12's verdict on XFS or NVMe:** cannot be measured on this box's one ext4 disk; E-12's verdict states the limit instead.
- **Questions of their own for disk full, request and reply, delayed jobs, shape changes, the order shuffle, the divergence hash and erase:** folded into E-29(b), E-22 (the patterns and the shuffle), E-05 (the hash) and E-28 (erase), which already have the setup each needs.
- **An experiment for per-user access (OPS-10):** not added. The check is a signature and a set lookup; its shape (relays check once per approved follow set, not per delta) is a rule written in OPS-10, and its suite is a phase test.
- **An experiment for regions (SC-14):** not added now. Far reads are a relay case of E-31's model, and false failovers over long links are F-06's sim; multi-region writes are out of scope unless the user reopens them.
