# The evidence ledger: what each experiment answered

One entry per experiment: its closing answer, copied word for word from its README. The line says what was found, then which candidates it moves up or down, on which requirement. Built by `python3 tools/evidence.py`; edit the READMEs, never this file. Candidates are the rows of [SPACE.md](SPACE.md) §4; requirement ids are in [REQUIREMENTS.md](REQUIREMENTS.md); questions are in [QUESTIONS.md](QUESTIONS.md).

## 1. Answers

### E-1: E-01: this box's floors (fsync, flush honesty, loopback round trip)

Folder: [experiments/E01-floors](experiments/E01-floors/README.md)

Q-01: C = 0.73 ms on this box (fsync p99 3 writers 676 µs + loopback RTT p99 58 µs; 1 writer 481 µs, so 3 writers = 1.4 ×, not disk-bound by the 2 × rule); flushes are honoured as far as the guest can see (a flush adds ~140 µs and waits behind bulk data), but host durability is unproven, so bars are stated against C and against the cited gp3 figure (1-9 ms). Moves: no candidate up or down by itself; it fixes C for PERF-01, PERF-08 and F-05, adds a cost every candidate's storage (axis S) must pay (keep snapshot and catch-up writes from starving commit fsyncs: E-34, F-19), and makes E-12 restate its jbd2 premise.

### E-2: E-02: how fast a replication pipeline can be in TypeScript, Rust and Go

Folder: [experiments/E02-pipeline](experiments/E02-pipeline/README.md)

Q-02: a TS kernel is viable on this floor: 5.5 µs of CPU per committed append at 50k/s (bar 20 µs), p99 4.3 ms (bar C + 5 = 5.7 ms), ceiling about 2.8M (real disk) to 4M (independent disks emulated) 100 B appends/s per process; on this disk every build hits the same disk-bandwidth ceiling, so throughput did not separate the languages; with the disk out of the way Rust is about 2.5 × TS (10.1M vs 4.0M/s) and Go 1.8 ×, and both have a 3 × tighter p99 (0.67-0.75 vs 2.4 ms); CPU per append is mostly a fixed 0.2-0.3 core per process in every language, so Rust meets 2 µs only above about 130k/s; kwN did not scale (0.8-1.03 ×); preallocated segments beat growing files 1.3-1.9 ×. Moves: MIN, DRAFT and LEAN (`ts→rs`) up on PERF-08 (TS column), PERF-09 and DEP-12 (decision 3b gains nothing here); MIN-TS up on PERF-09 at this box's floor (ties MIN) but down on PERF-08's native column (tail); RUST and SRV (Rust or Go) up only on the native tail (PERF-08 native) and the CPU-bound ceiling, not on CPU per append at moderate rates; M `kwN` down (not planned for phase 2 on this evidence; S `jrnl` one journal per process); S up for preallocated segments.

### E-3: E-03: what a call between JavaScript and Rust costs

Folder: [experiments/E03-napi-cost](experiments/E03-napi-cost/README.md)

Q-03: a call from Rust into a JS function costs 107 ns from inside a napi call (bar 300 ns) but 3.8 µs through a threadsafe function from a Rust thread (52 ns per record at batch 256; a SharedArrayBuffer ring 14 ns); handing a 256-record batch to data's JS fold costs under 1 ns per record for the crossing (the follower's real cost is fero v4's decode, 712 ns per record, which a TS kernel pays too; Rust-built objects cost 888 ns); deno_core ops cost 2.6 ns and data's fold runs at 0.80 × Node inside it, while QuickJS folds 16 × slower; a Rust daemon reaches Node at 15 ns per record over a /dev/shm ring (1.5 × napi's 10.3 ns) but 44 ns over a Unix socket (4.3 ×) and 33 µs per request/reply. Moves: RUST up on G1, DEV-05, PERF-10, DATA-09 and X3 (L2 and rules stay in JS, data folds in JS, on the condition that the core is called on the JS thread or crosses threads in batches); EMB-V8 kept as a live candidate (up on G2 and G6); the rquickjs variant of EMB-V8 pruned (fold 16-18 × Node); SIDE kept only with a shared-memory ring and a small mmap addon (a socket alone fails the 2 × bar), and down on PERF-10 (each synchronous call to the daemon costs about 33 µs, against 3 µs and 10 µs bars).

### E-4: E-04: one Rust kernel in WASM for the sim, and whether a TS and a Rust kernel stay byte-identical

Folder: [experiments/E04-wasm-kernel](experiments/E04-wasm-kernel/README.md)

Q-04: yes: a Rust kernel compiled to WASM meets TEST-01 as the sim's kernel (200 chaos seeds 102 ms with K and 384 ms with raft-rs 0.7.0 against 1 s; a fresh node plus a scenario 0.054 ms p99 against 5 ms, data's fold in JS) if the sim reuses one instance per worker and resets state inside it (a fresh instance per test gives 7.3-7.9 ms p99, over the bar, from V8's collections of instance memory); a crossing costs about 100 ns per event and WASM runs at 1.4 × native, but a real Raft library in WASM is only at parity with the TS port in the sim (1,346 vs 1,374 ns/event) because messages must be serialised; a TS and a Rust twin stayed byte-identical over 1,000 seeds (883,902 events) on the first run, and the guard caught all five planted traps (map order, UTF-16 sort, UTF-16 length, 32-bit varint, i64 counter) only by comparing state as well as effects and only in seeds whose inputs reach the trap. Moves: RUST up on TEST-01, TEST-10, DEV-07 and X2 (one kernel's bytes in the sim, the site and the server; no TS kernel needed); L `wasm` up as the sim and site form of any native kernel; MIN, DRAFT and LEAN (`ts→rs`) up on X2 (going native later no longer means two kernels) and neutral on TEST-01 (their TS kernel passes too); MIN-TS unchanged; every row that keeps two kernels or a native fold takes TEST-10's guard as specified here (state compared; inputs ≥ 2^32, ≥ 2^53, fractions, non-ASCII, astral and BMP-high keys).

### E-5: E-05: what data's fold costs

Folder: [experiments/E05-fold-cost](experiments/E05-fold-cost/README.md)

Q-05: the fold is affordable on every replica: 0.22-1.90 µs per record in 256-record batches up to 1e6 rows (fero v4's one commit per record: 0.62-2.63 µs), 315-338 B of heap per ~100 B row (510-528 B in decision 13's two-thread form; both far under 2 KB), 1e6 rows replayed in 4.5 s (223,000 records/s, 36 s per GB, mostly fero v4's 2.7 µs decode), and a 1e6-row hash in 259 ms on a worker holding encoded rows (1,919 ms from objects); but decode plus fold is about twice E-02's follower CPU per append, and data's `group` view costs O(rows per bucket) per commit (2,574 µs a record at 1e6 rows). Moves: MIN and every F `all` row up on P-01, DEP-13 and F-21 (with decision 13's encoded rows); LEAN up a little on CPU (a folding follower doubles its CPU per record) but down on F-05 without its warm standby (a cold rebuild passes 2.5 s above about 560,000 rows); every candidate down on P-12 until data's `group` emits per-row deltas (a data-side change, DATA-05); no move on L (the decode's cost is the record format's, DEV-09).

### E-6: E-06: fork and rewind for fero test

Folder: [experiments/E06-fork-rewind](experiments/E06-fork-rewind/README.md)

Q-06: yes, by undo, not by copy: at the café's size (1e3 rows) a rerun from a snapshot costs 0.6-1.2 ms and a whole fork 1.6 ms (bar 10 ms); at 1e6 rows copying a snapshot back into data costs 0.66-1.1 s a rerun (bar 100 ms; Immutable.js snapshots make keeping them free but not restoring them, 0.72 s), while undoing the rerun's records by their inverses costs 0.03-0.05 ms at every size with no data change; exactness needs one small data change (a removed row restored at its old key position), views add their per-commit cost (data's `group`: about 165 ms a rerun at 1e6 rows), and a runnable fork costs O(rows) (2.6 s, about 250 B a row at 1e6). Moves: no candidate up or down (every row runs data the same way); TEST-07 met by design for every candidate that runs data in process (reruns undo in tape order; fero test states that a jump costs the inputs between); TEST-06 met in storage only, with an in-memory fork stated at O(rows); DATA-04 gains one small item (restore a removed row at its key position), and structural sharing in data is not planned now.

### E-7: E-07: GC pauses, and a kernel on a worker thread

Folder: [experiments/E07-gc-worker](experiments/E07-gc-worker/README.md)

Q-07: the worst main-thread GC pause was 0.77-0.98 s (loading 5e6 small rows, a 1.7 GB heap, 8 GB limit), 0.2-0.41 s at 1e6 rows of 2 KB (2.2 GB), at most 45 ms under 10,000-50,000 steady writes a second, and 5e6 small rows at Node's default 2 GB heap ran out of memory after 1.2-1.45 s full GCs; a kernel on a worker crosses to the main thread at 27-40 ns per record (batch 256) and 77-155 ns (batch 16), but 0.8-2.2 µs one record at a time and 0.9-6.2 µs by structured clone, and it kept its heartbeat within 5 ms and write p99 ≤ 4 ms through a 5 s main-thread stall and 0.3-0.5 s forced GCs, where a main-thread kernel went silent 2.6-5.1 s. Moves: decision 13a (M `kw`, so MIN, DRAFT, LEAN, MIN-P, RLOG and MIN-TS) up on F-14 and F-06, on the condition that the seam carries byte batches; rows on the main thread (F `all` in TS) down a little on F-06 (thin margin past about 5e6 small rows; a sized heap is required: DEP-13 and F-13 gain "heap sized from rows, rows bounded per process"); SIDE down on its own reason (GC and stalls cannot stop replication: 13a gives that in one process), RUST and SRV unchanged (no GC on their kernel); X6 resolved as "kernel on its own thread, election.ms 2 s in TS".

### E-8: E-08: deliveries a second from one relay core, in Node and in Rust

Folder: [experiments/E08-relay-fanout](experiments/E08-relay-fanout/README.md)

Q-08: one relay core pushes 0.57-1.50 M deliveries/s in Node with no added wait (0.87/0.57 M fanning out per feed read, 1.50/1.17 M per event-loop turn, at 1,000/10,000 subscribers in 64 rooms, 100 B) and 20.6/32.3 M with 10 ms rounds, and 13.4/11.9 M in Rust (rounds of up to 1 MB), against core NATS's 5.8 M per server core-second at 100 B; each socket write costs 8-14 µs in both languages on this VM and both used the same CPU at equal load, so records per write, not language, set the rate; at moderate load p99 was 1.2 ms (Node) and 3.5 ms (Rust) with 1,000 subscribers, but 0.22-0.25 s with 10,000 in both. Moves: MIN-TS and every `ts→rs` row up on PERF-11 (a TS relay meets 100 k by 6-15 × and passes NATS with a few ms of per-room coalescing; native relays are not needed for throughput); RUST, SRV, SIDE and EMB-V8 not up on PERF-11 for language reasons (their edge is the same kernel-bound write); every candidate gains one rule for P-05 and L3: a relay coalesces each room for a bounded few ms and spreads sockets over cores (about 1,000 per core keeps a round near 10 ms), stated against P-05's latency bar.

### E-9a: E-09a: Redis 7.0 on this box, with redis-benchmark

Folder: [experiments/E09a-redis](experiments/E09a-redis/README.md)

Q-09 (Redis): Redis 7.0.15 with 200 clients does, at its default (one core, no fsync), SET 140,600 / GET 144,400 / INCR 149,700 per s at pipeline 1 (p99 2.6-2.8 ms) and 812,000 / 867,000 / 934,000 per s at pipeline 16 (p99 5.9-7.3 ms), about 7 µs and 1 µs of CPU per request; at PERF-02's matched setting (appendfsync always) SET 88,600/s (p99 4.6 ms) and 362,000/s (p99 27 ms), INCR 103,000 and 569,000/s; with two async replicas SET 75,500 and 260,000/s; SET + WAIT 1 (the closest to `persisted` that Redis 7.0 has) 45,400 and 70,000/s; all rows sit below E-02's TS ceilings (matched 5-60 ×, default only 3-5 ×), so E-02 does not stop TS on PERF-02, and the default pipeline-16 rows are a thin margin, decided by E-45's RESP gateway. Moves: no candidate down on PERF-02 at matched guarantees; candidates whose only rung is Q `maj-d` (MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) and OBJ (`put`) down on PERF-02's default rows unless they add Q `maj-m` (+1 on DEV-01) or the user accepts the loss by name; DRAFT, CELL, SPLIT (Q `mix`) and ISR (`isr`) unchanged; MIN-TS down a little on PERF-02's default pipeline-16 rows (per-request CPU of about 1 µs needed), RUST and SRV up a little there.

### E-9a2: E-09a2: Redis 7.0 with memtier_benchmark (the memtier addendum to E-09a)

Folder: [experiments/E09a2-redis-memtier](experiments/E09a2-redis-memtier/README.md)

Q-09a (memtier): memtier_benchmark 2.5.2 at PERF-02's shape on Redis 7.0.15 (measured here, 3 runs each, HdrHistogram kept) agrees with redis-benchmark run beside it within 7 % at pipeline 1 and within the spread on 8 of 10 pipeline-16 pairs, and is otherwise up to 14 % lower at pipeline 16 (Redis busy 3-6 % less and 5-11 % more CPU per request under memtier, not a CPU shortage); redis-benchmark's latency reads 2-7 % low on Redis and 18-19 % low on a fero gateway at pipeline 16, memtier's matches Little's law; the box moved up to 36 % between three boots, so the bar is the memtier Redis row of the same hold, which here read SET 91,600/s p99 4.9 ms and 379,000/s p99 24 ms, INCR 107,000 and 576,000/s, GET 820,000/s at pipeline 16 (`appendfsync always`, boot 3), and 144,000-155,000/s p99 2.7-2.9 ms and 620,000-839,000/s p99 7-9 ms at the default (boot 1); a 1:10 SET:GET mix under `appendfsync always` costs Redis 19-34 % of its GET rate and 27-53 % on GET p50, while E-45's gateway answered held GETs in 1.3 ms beside 121-ms SETs; memtier drove every row through E-45's RESP gateway over the E-22 simulator with 0 errors (a simulator, 6-54 × below Redis, needing an 8 GB heap). Moves: no candidate up or down (E-09a's moves on PERF-02 stand); PERF-01 gains a same-hold, same-tool, round-robin rule; PERF-02 takes its latencies from memtier and gains a 1:10 mixed row; P-01's TS write bar is looser than PERF-02's matched SET p99 at 200 connections, so a TS candidate must reach about 92,000 `persisted` SETs/s at 200 connections with p99 under 4.9 ms on this box to win that row.

### E-9b: E-09b: NATS 2.10 (core and JetStream) on this box, with the nats CLI

Folder: [experiments/E09b-nats](experiments/E09b-nats/README.md)

Q-09 (NATS): NATS 2.10.22 here does core pub/sub 2.25 M msgs/s (16 B, 1 → 1), 694 k/s (1 KiB), 4.13 M deliveries/s to 16 subscribers (2.5 M per server core), publish-to-receive p50 0.09 / p99 0.27 ms; JetStream with 3 file replicas and fsync always 1,228 acks/s at 1 client (p99 1.31 ms) and 3,700 msgs/s async (one fsync per message), and at its default (memory at a majority) 3,280 acks/s (p99 0.55 ms) and 98,000 msgs/s async (CPU-bound, 23 µs per message); E-02 does not stop TS on any JetStream throughput row, but core pub/sub sits only 1.9 × under TS's socket-free `none` ceiling, NATS's fan-out per core is 25 × PERF-11's TS bar, and JetStream's single-publisher p99 beats E-02's real-disk TS and Rust tails (matched) and C itself (default). Moves: MIN-TS down on PERF-03 and PERF-11 (fan-out and core pub/sub need native speed; relays native unless E-08's Node relay reaches about 1.26 M deliveries/s per core), RUST, SRV, SIDE and EMB-V8 up on PERF-03 and PERF-11; candidates with only Q `maj-d` (MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) and OBJ down on PERF-04's default rows unless they add Q `maj-m` (+1 on DEV-01) or the user accepts the loss by name; every candidate up on PERF-04's matched throughput rows (group commit against one fsync per message), and open on PERF-04's single-publisher p99 (needs the tail of E-02's emulated-disk Rust run, 0.67 ms, not its real-disk TS run).

### E-9c: E-09c: Kafka 4.4 (KRaft, three nodes) on this box, with Kafka's own tools

Folder: [experiments/E09c-kafka](experiments/E09c-kafka/README.md)

Q-09 (Kafka): Kafka 4.4.0 (KRaft, 3 nodes with 1 GB heaps; Kafka's own tools with OMB's settings, as OMB itself does not fit 4 vCPU beside three brokers) takes, at its default (`acks=all`, no fsync), 240,043 × 1 KiB records/s (234 MiB/s) at 7.3 µs of broker CPU per record, end-to-end p99 638 ms at half of max (120,021/s, with the box CPU-full) and 15 ms at 50,000/s, and a single-record ack p50 0.61 / p99 1.64 ms; matched (`flush.messages=1`) 86,344/s (84 MiB/s), p99 869 ms at half (43,171/s), ack p50 2.53 / p99 5.34 ms; share groups with 4 consumers drain 232,258/s at the default once assigned, after a wait of one share-group heartbeat before a new consumer's first record (5.30 s at the default 5,000 ms, 1.19 s with the broker floor lowered to 1,000 ms; 78,534/s over a whole timed run). The matched max is 3.3 × under E-02's TS 1 KiB `persisted` ceiling, so TS is not stopped on PERF-05's matched row; the default max is only 1.18 × under it (1.45 × under Rust's) at about the TS pipeline's CPU per record, and E-02 has no 1 KiB `memory` run; E-02's TS floor beats Kafka's p99 at half by 33 × (default) and 45 × (matched). Moves: candidates with only Q `maj-d` (MIN, RUST, SRV, LEAN, LANE, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) and OBJ down on PERF-05's default max row unless they add `maj-m` (+1 on DEV-01) or the user accepts the loss by name (E-45's F7, now with a number); MIN-TS down a little more there (no CPU margin), RUST and SRV up a little (1.45 ×); every candidate up on PERF-05's two p99-at-half rows; no candidate moves on PERF-05's matched max; ISR (`isr`) and DRAFT, CELL, SPLIT (`mix`) unchanged; the share-group work-queue row stays not comparable until fero's Kafka gateway speaks ShareFetch and ShareAcknowledge (E-45).

### E-9d: E-09d: Redpanda 26.2 (three nodes) on this box, with Kafka's own tools

Folder: [experiments/E09d-redpanda](experiments/E09d-redpanda/README.md)

Q-09 (Redpanda): Redpanda 26.2.6 runs here (3 nodes, `--smp 1 --memory 2G --overprovisioned`, Kafka's own tools) and at its default (fsync at a majority before `acks=all`, so PERF-06's matched row) takes 175,420 × 1 KiB records/s (171 MiB/s, OMB settings) on about 1 broker core (5.8 µs/record + about 1.1 µs kernel I/O), end-to-end p99 43 ms at half of max (87,710/s) and 19 ms at 50,000/s, and a single-record ack p50 0.70 / p99 1.65 ms; with write caching 187,199/s, p99 16 ms at half, ack p50 0.24 / p99 0.79 ms; no share groups (UNSUPPORTED). That is 2.0 × Kafka's matched rate and only 1.62 × under E-02's TS 1 KiB `persisted` ceiling (1.99 × under Rust's): the thinnest matched margin in E-09, with no CPU margin for TS, and its single-record tail beats E-02's real-disk tails; E-02's TS p99 at half (19 ms) beats Redpanda's 43 ms. Moves: MIN-TS down on PERF-06 (max MB/s and single-record p99 rows: thin disk margin, no CPU margin, wider tail); RUST, SRV, SIDE and EMB-V8 up a little on PERF-06 (2 × ceiling, tighter tail); MIN, DRAFT, LEAN (`ts→rs`) not down at matched throughput by the threshold, but PERF-06 is the row most likely to need the native build before G2 is claimed (decision 3); every candidate up on PERF-06's p99-at-half row; no `memory` rung is needed for PERF-06 (its default is the matched row), and E-45's "Redpanda cannot run here" is superseded: PERF-06 becomes comparable when fero's Kafka gateway runs at speed.

### E-9e: E-09e: etcd 3.5.17 on this box, with its own benchmark tool

Folder: [experiments/E09e-etcd](experiments/E09e-etcd/README.md)

Q-09 (etcd): etcd 3.5.17 with 3 members (fsync before every answer, which is both matched and its default) reaches 1,118 puts/s at 1 client (p50 0.85, p99 1.73 ms) and 22,800/s at 1,000 clients (p99 90 ms, CPU-bound on 4 vCPU), linearizable reads 2,230/s (p50 0.43 ms) and 53,200/s, serializable 5,135/s (p50 0.18 ms) and 66,100/s, txn-put about the same as put, compare-and-set 778/s and 10,200/s, lease keep-alive 51,000/s, lock acquire p50 1.04 / p99 2.02 ms; every throughput row is 40-120 × below E-02's TS pipeline ceiling at about 9 × its CPU per write, so E-02 does not stop TS on any PERF-07 throughput row (E-45 decides), but etcd's single-client p99 (1.73 ms) beats E-02 TS's measured commit p99 (2.4-4.3 ms) and equals Rust's (1.58 ms). Moves: MIN, DRAFT, LEAN (`ts→rs`) and MIN-TS not down on PERF-07 throughput; MIN-TS down a little on PERF-07's single-client rows and PERF-08's native column (TS tail), RUST and SRV up a little there; no candidate moves on DEV-01 (etcd's default needs no `memory` rung); P-10's bar (acquire ≤ C) stands above etcd's own lock.

### E-10: E-10: how big etcd's raft is, a faithful TypeScript port, raft-rs's gaps, and npm's Raft libraries

Folder: [experiments/E10-raft-port](experiments/E10-raft-port/README.md)

Q-10: etcd raft is about 4,100 code lines of library plus 1,600 of test harness; a faithful TypeScript port of all of it passes 41 of 41 datadriven files and 4,000 of 4,000 random Go-filled scripts (with reads and crash-restarts) byte for byte, took 16 agent-minutes to first green (about 21,000 Go lines per agent-hour) and projects to 2–5 agent-hours with Go's unit tests (bar: 80), with no Go construct blocking it; etcd's files catch about 74% of behaviour-changing mutants of the port, files plus fuzz about 89%; raft-rs 0.7.0 cannot run etcd's 28 interaction files and lacks etcd's async-write contract, ForgetLeader, StepDownOnRemoval and the 2024–2026 fixes; no npm library has a comparable oracle. Moves: MIN (and every `port` row: MIN-TS, LEAN, MIN-P, RLOG, DRAFT, CELL, LANE, SPLIT, and SLOG's and ISR's metadata group) up on DEV-04 and DEV-05, and the `ts→rs` rows up on TEST-10 (a byte-for-byte differential against a second implementation is cheap); RUST, EMB-V8, SIDE and SRV's Rust variant (`raft-rs`) down on DEV-04 (a drifted fork without etcd's oracle; not blocked); `jslib` out.

### E-11: E-11: the cost of N Raft groups in one process, 10 to 10,000

Folder: [experiments/E11-many-groups](experiments/E11-many-groups/README.md)

Q-11: with quiet groups (one link ping per process pair every 500 ms), 2,000 idle groups per process cost 0.04% (Rust raft-rs), 0.10% (Go etcd raft) and 0.15% (TS port) of a core and 3.9 / 8.0 KB of RSS per group in Rust / Go (TS: 3.5 KB live heap but 26 KB of RSS per group), flat up to 10,000 groups, so PERF-12 holds on CPU in all three and on memory in Rust and Go; without quiet groups, ticking costs 4.9-13% at 100 ms ticks and 0.98-3.3% at 500 ms (only Rust at 500 ms under 1%), so quieting cannot wait; at 10,000 writes/s, 16 groups cost the same or less than one (cluster CPU 1.31 vs 1.29 cores in Go, 1.06 vs 1.53 Rust, 1.48 vs 1.83 TS; p99 within 1.3 ×), while spreading the load over 10,000 groups at one write a second each costs +14-47% CPU and 5-12 × p99 (TS 121 ms). Moves: every Raft row with many groups per process (MIN, DRAFT, RUST, LEAN, MIN-P, MIN-TS, RLOG, SRV, EMB-V8, SIDE, CELL, LANE, SPLIT) up on PERF-12, provided quiet groups (the draft's quiet shards, CockroachDB's precedent) are in phase 2 (DEV-01: a precedented mechanism, now required early); CELL and LANE neither up nor down on busy cost (no penalty at 16-64 groups); MIN-P up a little against MIN on SC-13 (fewer, busier groups beat many thinly written ones: at 10,000 groups with uniform writes, p99 5-12 × and CPU +14-47%); MIN-TS and the `ts→rs` rows down a little on PERF-12's memory clause until Node's heap is sized or rows leave the V8 heap (TS RSS 16-26 KB per group against 3.5 KB live).

### E-12: E-12: one shared journal against one log file per group

Folder: [experiments/E12-journal](experiments/E12-journal/README.md)

Q-12: one shared journal beats a log file per group on commit latency from 256 groups up in every variant (p99 2-6.6 ms against 9-854 ms: 4.5-47 × at 256 groups, 9-186 × at 2,000; 1.3-11.5 × at 16), with 8-30 × fewer fdatasyncs and 3.5-10 × less CPU per append, in Node and Rust, on ext4 without and with jbd2 and on XFS, with 4, 32 or one sync thread per group; per-group files reach the 0.8 × throughput bar only at 256 groups (0.86-1.27 × with growing files, 0.53-0.68 × preallocated) and miss it at 2,000 (0.29-0.93 ×); the best journal here preallocates and keeps one flush stream (striping over 4 files: ceiling 1.2-2.6 ×, p99 5-24 × worse at moderate load). Moves: S `jrnl` up and `walg` down on DEP-12, PERF-08 and SC-10 (groups per process ≥ 2,000), so every row with S `jrnl` (DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE) keeps it and its one small mechanism (cuts, segment indexes); ISR (`walg +tier`) down on PERF-08 at many partitions per process; M `kwN` down a little (one journal per worker means several flush streams, which cost latency on this disk).

### E-13: E-13: handover, failover, catch-up per GB, and a slot move's unwritable window

Folder: [experiments/E13-handover](experiments/E13-handover/README.md)

Q-13: on this disk etcd pauses its group 9.7-9.8 ms at a handover (median of 15; worst 31 ms) but drops writes caught in the transfer, which then pay the client's timeout (100 ms or 2 s here); a failover takes the election timer plus about 5 ms (0.94-1.42 s at E = 1 s, 2.03-3.36 s at E = 2 s); a new member catches up at 5.2-6.9 s per GB; and a three-commit slot move on E-10's TS Raft is unwritable 2.7-4.1 ms at the median but 5.0 ms (2,000 writes/s), 8.7 ms (idle) and 16.7 ms (10,000 writes/s) at p99, while a one-commit move stays at or under 4.7 ms p99. Moves: every Raft row with slot moves (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, RLOG, SLOG, EMB-V8, SIDE) down a little on SC-08(b) until the move is cut to one or two client-visible commits or the bar is restated as p50 plus a load-tied p99 (DEV-09: decide before phase 1); every Raft row needs E ≤ 1.25 s or DESIGN-V5's 0.25 E jitter to meet F-05's 2.5 s failover (a constant), and a "refuse at once, never drop" rule for writes caught in a handover (F-05, DEP-01); RLOG's writer handover (one epoch commit plus a warm fold tail, about 2-5 ms, reasoned) stays within F-05; catch-up per GB does not separate the rows.

### E-14: E-14: membership changes that take effect on commit, checked with TLC on etcd's raft spec

Folder: [experiments/E14-membership-on-commit](experiments/E14-membership-on-commit/README.md)

Q-14: Yes, with one more rule: on commit, healing.py's stuck state R2-1 recovers (TLC, a 72-step path) while on append it stays stuck (TLC, all 2,905 states); but etcd's own TLA+ spec reaches two leaders in one term because it lets a member campaign while a committed change is unapplied, which etcd's code forbids and DESIGN-V5 §4.2 must state; the full liveness sweep at 3 to 4 servers did not finish here. Moves: every row that ports etcd's raft (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-16 and F-07 (no R2-1 stall) with +1 rule in DEV-10's count, not a mechanism; I `own` down (the spec alone misses the guard); every Raft row's DEV-03 still open (6 of 22 mutants caught, liveness rules unchecked).

### E-14b: E-14b: membership on commit, finished (the real CommunityModules jar, the liveness sweep, the healing scenarios, the mutants)

Folder: [experiments/E14b-membership-liveness](experiments/E14b-membership-liveness/README.md)

Q-14: Yes from three voters up, with one stated limit and two more rules: on commit with the campaign guard broke no real safety property in any run and has no stuck state in the finished scenarios that start from three or more voters (four voters demoting one, the R2-1 shape: 5,165,341 states, complete; the lost-disk replacement and the swap did not finish), while on append stays stuck at R2-1; but growing from two voters to three has a one-message window in which losing the leader stalls the group until that leader returns (model-checked; etcd's code does the same; on append does not stall there), learners must vote, and a lost disk must never return under its old id; the real CommunityModules jar changes no E-14 result, and 11 of 22 mutants are caught (85% of those not equivalent). Moves: every row that ports etcd's raft (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-16 and DEV-03, down a little on F-07 (the two-voter window: a stated limit and an operator step if the old leader's disk is lost, no new mechanism), +1 counted rule (learners vote) beside E-14's campaign guard; I `own` down again (etcd's TLA+ spec runs only with CommunityModules' Java FoldBag, and two of its shipped invariants are stronger than Raft needs).

### E-14c: E-14c: membership on commit, completed (Raft's real invariants, the lost-disk and swap scenarios, mutant r19)

Folder: [experiments/E14c-membership-completion](experiments/E14c-membership-completion/README.md)

Q-14: Yes, with one planner rule that DESIGN-V5 §4.2 already has: on commit with the campaign guard broke none of Raft's real invariants in any state reached (the two shipped invariants that stopped E-14b are replaced, and the replacements catch a returning lost disk, a minority commit and a vote without the log check as early as the shipped set), and in the lost-disk replacement and the swap it has no stuck state when healing grows before it shrinks (0 of 340,671 and 0 of 235,702 judged states, plan always finishes), against 112 and 692 stuck states, every one E-14b's two-voter window, when the leader may shrink first; r19 is caught as a liveness bug (a removed leader takes the group back), so 12 of 13 non-equivalent mutants are caught (92%). The full runs at E-14b's bounds do not finish on this box (4.6 and 3.6 million states, no invariant broken); the liveness verdicts use six bounds above the judged term that give the full model's numbers on six scenarios. Moves: every row that ports etcd's raft (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-16 and DEV-03 (both open healing scenarios now judged, r19 settled), F-07 as E-14b left it (the window stays only for a group that really is at two voters), +2 counted rules already in etcd or in DESIGN-V5 §4.2 (only a voter stands; healing grows first), no new mechanism; DRAFT and MIN the same, since both must order a swap grow-first: DRAFT states it, MIN's controller must.

### E-15: E-15: the slot move in TLA+, checked against slot_move.py

Folder: [experiments/E15-slot-move-tla](experiments/E15-slot-move-tla/README.md)

Q-15: Yes: TLC on a TLA+ spec of the slot move agrees with slot_move.py on all 74 runs both explored in full (the same failing properties, state counts and shortest-trace lengths, up to 7.5 million states at Q-15's bound of three shards, two moves and one unclean recovery), all 117 slot_move.py counterexamples replay in TLC, and both catch the same 16 of 18 mutants, so neither model has a bug and the five-fix move stands; but DEV-10's 154 mechanical mutants are caught only 35 times (39% of the 90 that change anything at `move` and `write0`, bar 85%), because most of the fixed protocol's guards are spare at these bounds (31 rules), and links without incarnation checks break nothing (m131). Moves: every `slot` row (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, SLOG, OBJ, RLOG, EMB-V8, SIDE) up on DEV-03's model clause for the slot move (a second checker, TLC, agrees run for run; the largest bound finishes in 23 minutes); DEV-03's 85% mutant clause stays open for P `slot` (39% here); DEV-01 and DEV-10 count the slot move at 31 rules, and the link incarnation check is not one of them.

### E-16: E-16: one controller loop on `#meta`'s leader, against healing by every group's leader

Folder: [experiments/E16-controller-loop](experiments/E16-controller-loop/README.md)

Q-16: No: one controller loop on `#meta`'s leader is neither smaller nor safer than healing by each group's leader. As first written it had a new stuck state with a live majority (two faults, 8 steps, 92 states: a promotion decided before the learner died stays runnable, never times out and blocks every other decision); it needs 18 rules against 14 (16 with a counterexample: the same healing rules plus an epoch check, two re-checks of who is alive at the group's leader, and a timeout); and with a member fault as well it cannot finish healing in 24% to 62% of the judged states while `#meta` is down (a delay, not a stuck state). Once fixed, both are safe and live at every bound (4 members, up to two faults, model-checked), and RLOG's writer handover adds 9 rules, all needed. Moves: DRAFT, CELL, LANE, SPLIT (`self`, `self+p`) up on DEV-01, DEV-02 and SC-08(e); MIN, RUST, SRV, LEAN, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE (`cent-co`) down on DEV-01, DEV-02 (4 more rules, and commands that interact with each group's config epoch) and SC-08(e) (healing stops while `#meta` is down), unless they switch C to `self`; PD, ISR, SLOG, OBJ (`cent`) carry the same 4 rules (reasoned: PD's region epoch and operator timeout); RLOG +9 rules for the writer handover.

### E-17: E-17: how many rules each way of mapping partitions onto groups needs

Folder: [experiments/E17-partitioning](experiments/E17-partitioning/README.md)

Q-17: Slot moves win axis P: among the options that meet SC-03, SC-04 and SC-08 they need the fewest rules, 26 on the shared bounds and 28 once the move is also safe in a real log and at bigger bounds, against 33 and 37 for split + merge, and `pslot` needs exactly as many when its key is counted the same way (part 2's 4 extra rules name the slot key in any slot move); re-key is 2 to 10 rules bigger and fails SC-08(b) and (f), now model-checked (a write to a partition that never moves waits for the re-key, and that partition's rows are copied), tying a one-decider slot move only on the give-up price (34 to 35 against 33 to 34); lanes need 2 more rules and fail SC-03 and SC-04 by design (reasoned); every count reproduced exactly under a second agent (model-checked, crash-only faults). Moves: MIN and every slot row up on DEV-01 and DEV-03; MIN-P up on DEV-01 (it ties MIN on axis P); CELL down on SC-08(b), SC-08(f) and DEV-01; SPLIT down on DEV-01 and DEV-02; LANE down on SC-03 and SC-04.

### E-17b: E-17 (part 2): pslot, split + merge, and lanes + range moves, on the shared harness

Folder: [experiments/E17b-partitioning-part2](experiments/E17b-partitioning-part2/README.md)

Q-17 (part 2): slot moves stay the smallest option that meets SC-03, SC-04 and SC-08: 26 necessary rules (26 to 27 on bigger bounds), against 30 for `pslot` (slot's rules plus 4 that name the resource in each move entry), 33 to 34 for split + merge (two protocols: a 9-rule split and an 11-rule merge, plus lineage) and 28 to 29 for lanes + range moves (the slot move plus 2 lineage rules, 26 with records carried), which also fails SC-03's floor and SC-04 by design; a slot move fused the way a split is written needs about 22 (model-checked, crash-only faults; the 22 reasoned from a 24-rule probe with naming). Moves: MIN and every slot row up on DEV-01 and DEV-03 (smallest of all six options, smaller still if DESIGN-V5 §4.2's move is fused); MIN-P down on DEV-01 by 4 rules against MIN, with no new mechanism; SPLIT down on DEV-01 and DEV-02 (two protocols, lineage kept for ever), up on SC-08(f) for splits; LANE down on SC-03, SC-04 and DEV-09 (its per-lane offsets need an epoch and lineage), with its phase-5 range move priced at slot's rules plus 2.

### E-17c: E-17 (part 3): the independent re-run, and the hunt for missed and extra rules

Folder: [experiments/E17c-partitioning-rerun](experiments/E17c-partitioning-rerun/README.md)

Q-17 (part 3): Yes, E-17's counts reproduce exactly under a second agent (20 ablations re-derived from scratch with the same sets, per-rule verdicts, 517 mutants and state sets; 5 give-up sets checked fresh, 179 of 179 rules agreeing), and the hunt changes their meaning in three places: `pslot`'s 4 extra rules name the slot key in any slot move (probe `slotkey`: slot needs the same 4 when counted the same way), re-key's SC-08(b) and (f) failures are now model-checked (L8, F8), and split + merge needs `split.open` once a third group exists; once guards for a real log add 0 to 3 rules to every option, so on the same footing slot moves need 28, `pslot` 28, lanes 30, re-key 30 to 38 and split + merge 37 (model-checked, crash-only faults). Moves: MIN-P up on DEV-01 (it ties MIN on axis P; part 2's 4-rule penalty is withdrawn); CELL down on SC-08(b) and SC-08(f) (now model-checked); SPLIT down on DEV-01 (37 against 28); MIN and every slot row up on DEV-01 and DEV-03 (their counts stand under a second agent and stay the smallest on every footing).

### E-18: E-18: do 1,024 slots spread load well enough, with hot keys, as groups grow?

Folder: [experiments/E18-slot-balance](experiments/E18-slot-balance/README.md)

Q-18: Change the default to 4,096 slots now: 1,024 slots keep max/mean ≤ 1.25 to 64 groups on seven of eight loads but not on Pareto 1.16 room sizes, where two big rooms share a slot in about 1 % of draws (max/mean 1.386 in part A; 4,096 slots pass that draw and fail 0 to 0.5 % of the time), and they meet F_w only narrowly (72 effective writers in the worst draw, against 135 at 4,096 and 32 at 256), while SC-10's definition, read literally, caps every design at 12 to 22 under Zipf 0.99 and must add "with partitions above half a writer's share split by the app"; 4,096 slots also copy 4 times less data per hotspot move, at 4 times the per-slot state and cursor entries, which E-19 and E-36 must confirm (1,024 is the fallback). Moves: MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, RLOG, EMB-V8, SIDE, DRAFT, SLOG and OBJ up on SC-03 and SC-10 (a stated ceiling of 135 writers per resource at 4,096 slots, above F_w) and on DEV-09 (the slot count is fixed now); DRAFT down on SC-03 (its halving grow rule alone leaves groups between half and full load, max/mean 1.5 to nearly 2 between powers of two, so it needs up to twice the groups for a load unless it adds MIN's one-move balancer); CELL and LANE down on SC-03 and SC-10 (16 cells give 7 to 15, and 64 lanes 23 to 53, writers' worth of one resource under skew, with no move to fix it); SPLIT and PD unchanged (key-level splits balance at most 5 % better to 64 groups and meet the same hot-partition ceiling, though they copy less per hotspot move); every candidate equally down on SC-10 until it is restated.

### E-19: E-19: what slot-shaped positions cost

Folder: [experiments/E19-slot-positions](experiments/E19-slot-positions/README.md)

Q-19: slot-shaped positions cost +3.9 B per record (+4.9 B past about 16.7M writes per resource; +1.9 B with an implicit per-slot sequence) and at most 22 ns (Node) or 5 ns (Rust), and a whole-resource cursor is 1.0-3.3 KB delta-coded (14 KB raw), with moves adding nothing; a client cursor of 1-10 partitions is 22-79 B, and a 10,000-client storm is 32 MB, so no server-side cursor token is needed. Moves: O `slot` (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, RLOG, SLOG, OBJ, EMB-V8, SIDE) holds on P-03, P-05, P-07 and SC-10's cursor ceiling, provided DEV-09 fixes delta-coded cursors and the per-record sequence form (implicit, or restate the 4 B bar to 5 B) in phase 1; `off` rows (CELL, LANE, SPLIT) gain nothing that decides: 4-5 B per record and 10-40× smaller whole-resource cursors, but positions that a re-key or split changes.

### E-20: E-20: which dedup option holds exactly once with the fewest rules?

Folder: [experiments/E20-dedup](experiments/E20-dedup/README.md)

Q-20: `sess` (client sessions, Raft thesis 6.3): 13 rules, no time rule, 309 B per active client, against the draft's `win` at 17; `keys` has 12 but memory per write (13 GB per busy writer at a 10-minute TTL), so it serves user keys only; under `fwd` `sess` adds `forward.once` (14 rules), or none if every refusal is appended. Moves: `sess` rows (MIN and its family, CELL, OBJ) up on F-02, DEV-01 and DEV-10; Y `smart` up by one hop rule over `fwd` (two under `win` and `keys`), counted in every `fwd` row; `win` rows (DRAFT, LANE, SPLIT, SLOG) down on DEV-10 (4 more rules) unless they switch D to `sess`; ISR's `pid` down on DEV-10 and memory (16 rules, 2.1 KB per producer); `keys` up on TEST-03 only.

### E-21: E-21: which time rule gives correct TTLs and safe leases?

Folder: [experiments/E21-time](experiments/E21-time/README.md)

Q-21: writer time = the median of the members' clocks (the draft's clamp with a window of 0), never going back, plus the fence for locks: 7 rules, every check passes and a clock jump causes no failover (F-06); two more rules (step down when fewer than a majority of the known clocks agree) make the group stop instead of expiring rows by a wrong time when most clocks are wrong (9 rules, the only set without clock hardware that holds on all nine families and keeps F-06). The draft's window of `skew.max` misses P-02 by up to 600 ms when the leader's clock jumps; CockroachDB's guard on the leader's own clock also needs 7 rules but turns every leader clock jump into a failover (60 of 60 runs), against F-06 as written; `mono` misses by a whole TTL. Moves: every `clamp` row (DRAFT, MIN and its family, CELL, LANE, SPLIT, ISR, SLOG, OBJ) keeps T `clamp` with its window set to 0 (7 rules; 9 with the agreement guard, for groups that must not expire rows wrongly when most clocks are wrong), down on P-02 and F-06 until it does, up on P-02, P-10, F-06 and TEST-02 once it does; `hlc` up on P-02 and P-10, down on F-06 (a failover per leader clock jump) unless F-06 is amended; `mono` down on P-02; `tt` up on P-02 only where clocks are bounded (not a default, DEP-01).

### E-22: E-22: the API on five kernel operations, under faults, the shuffle and outside checkers

Folder: [experiments/E22-api-prototype](experiments/E22-api-prototype/README.md)

Q-22: the API covers all 22 patterns on the kernel's five operations with no sixth, and every pattern check, Porcupine (183,159 partition histories, all linearizable) and Elle hold under forced leader changes, slot moves and 100 seeds of the shuffle, after three rules the checkers forced: a refusal waits for the commit of what it was judged on (Porcupine found a refusal by a write that was then lost), a session-bound write waits for its session, and saga locks belong to the unit (Elle found G0 between units in 10 to 19 of 100 histories without it); no MUST needs atomic visibility (fractured reads remain, P-15's SHOULD), nothing is safe only at the writer, and TEST-01 holds (a fresh node plus a scenario 0.14 ms median, 3.6 ms p99, against 5 ms; 200 chaos seeds 0.65 s against 1 s). Moves: MIN and its K `lib` family up on P-01 to P-22, TEST-01, TEST-02, TEST-12 and TEST-13; X `saga` up for the MUSTs at two more L5 rules (DEV-01); U `ldr` down; every candidate takes F1's refusal wait and F2's session order.

### E-22b: E-22b: E-22's histories re-checked with real Elle and real Knossos

Folder: [experiments/E22b-real-elle](experiments/E22b-real-elle/README.md)

Q-22: real Elle 0.2.8 and Knossos 0.3.16 confirm E-22's checker verdicts: Knossos gives Porcupine's verdict on all 185,959 saved partitions (the 94 known-bad caught by both, no unknowns) and on 18 of 18 self-tests; real Elle gives the port's verdict on all 1,800 `saga`, `owned` and `nolock` verdicts (G0 in 16, 19 and 10 of 100 without F3, 0 with it; fractured reads stay) and on 8 of 8 self-tests, and is stricter on 33 of 300 `undo` histories, traced by an ablation to a newer Elle rule for never-read appends (a checker difference, on a variant E-22 had already failed); no export bug changed a verdict, but E-22's completions-only export leaves real-time order unchecked. Moves: no candidate moves; MIN and its K `lib` family keep E-22's up on P-15 and TEST-13, now on the real tools; X `saga` with F3's rules confirmed for P-15's MUST; TEST-13 sharpened: Elle means real Elle, not the port, and every history carries an invoke and a completion with times.

### E-23: E-23: can live views over a resource held by several groups be merged exactly?

Folder: [experiments/E23-merged-views](experiments/E23-merged-views/README.md)

Q-23: Not today, yes with a merge contract in data. `filter`, `group`, `length`, `some`, `every` and numeric `max`/`min` already merge exactly across 1 to 16 groups with slot moves, grows, shrinks and failovers (0 mismatches in 225.6 million checks, and at every cut of a lagging merger), but `top-k` (ties by arrival) and `sum` (a float running total; `NaN` poisoning) do not, even between replicas of one group, and a column that mixes numbers and strings breaks data's sorted index; ties by row key, an exactly rounded sum and one total order on values make all four exact at a cost of about 0.2 µs per commit, and fero's merger needs four rules (a cut, one owner per key, paired move halves, resync on rebuild). Moves: MIN, DRAFT, CELL, LANE, SPLIT and MIN's variants up on P-12 (no one-group ceiling needed for the views it names), conditional on the contract; every candidate equally (no ranking change) down on DATA-01, DATA-04, DATA-05 and P-16 until data's contract lands (a SCHEDULE_VERSION bump, planned now); SC-10 gains one stated ceiling (`limit`, `reverse`, `reduce` and exact quantiles need one process that folds every group).

### E-24: E-24: sagas with fenced locks, and RAMP

Folder: [experiments/E24-sagas-ramp](experiments/E24-sagas-ramp/README.md)

Q-24: Sagas with fenced locks meet P-15's MUST, but not as drafted. DESIGN-V5 5.3 makes a write cycle between two units (G0, 17 steps) and lets a paused holder's late step land after its unit was undone (12 steps); writers following `#locks` does not close that (it needs a bound on delay) and is not needed. With E-22's F3 (Percolator's rule) and "a failed run undoes every step" (or Kafka's epoch bump), all-or-nothing, no G0 and "every unit ends" hold on seven bounds, each explored in full, up to 2.9 million states: 38 rules by ablation, 1 of them novel (the threshold is 3), 41 of 44 non-equivalent mutants caught. RAMP-Fast keeps read atomicity for plain writes with 1 novel rule (the threshold is 2; 19 rules, 20 of 20 mutants; one read round, or two for 8 to 12% of reads), but for fero's operations real Elle finds fractured reads (10 in 36,000 reads), and the fix needs at least 3 novel rules and has no fixed bound on rounds. Moves: X `saga` (every row but PD and ISR) up on P-15's MUST and unchanged on DEV-01 (one novel rule still, a different one: "undo every step" replaces "writers follow `#locks`"); X `ramp` up on P-15's SHOULD for units of plain sets only (1 novel rule, open to every slot row); for units with operations the SHOULD stays unmet by `saga` and by `ramp`, and is priced from `ktxn` or `2pc` (Kafka's `read_committed`, Percolator).

### E-25: E-25: what the failure detector costs when idle, at n = 100 members

Folder: [experiments/E25-idle-fd](experiments/E25-idle-fd/README.md)

Q-25: idle, a member with 99 links pinged every 500 ms plus 2,000 quiet groups uses 0.95% of a core in Node and 0.33% in Rust (about 21 and 9 µs per frame), and pairwise pings at n = 100 make 19,800 frames/s in all, so PERF-12 holds for every quiet-group row at exactly n = 100, narrowly in TS; without quiet groups every row is over (31,672-39,600 frames/s, up to 12.8M messages/s), 100 members on one 4-vCPU box cost 1.26 cores, and the count grows as n², so past 100 members a bound on peers per member is needed. Moves: MIN, DRAFT, MIN-TS, MIN-P, LEAN, CELL, LANE, SPLIT, RLOG up on PERF-12 at n = 100 (narrow in TS), RUST, SRV, EMB-V8, SIDE up more (a third of TS's CPU); every pairwise-ping row down a little on SC-07 and X8 until a peers-per-member bound (+1 placement rule) is planned; ISR down on PERF-12 above about 1e4 partitions (idle fetches are pairwise); SLOG up on X8 (sessions to a controller: 400 frames/s); OBJ neutral on frames but its leases must go quiet or cost requests.

### E-26: E-26: dormant groups for 1,000 sleeping projects

Folder: [experiments/E26-dormant-groups](experiments/E26-dormant-groups/README.md)

Q-26: for 1,000 sleeping projects a log-tier process holds 0 (N `proc`) to 171,432 (CELL) groups; with quiet groups in memory every row fits 2 GB except CELL in TS (2.74 GB), and a dormant group costs 57 B of memory and 24 B on disk, wakes in 3.3-3.5 ms (a project of 20 in 10-16 ms, a cold start of three processes in 265-318 ms) with no change from 100 to 100,000 dormant groups, and a quiet project sends 0 messages. Moves: MIN, MIN-P, RUST, MIN-TS, LEAN, SRV, SIDE (N `proc`) up on SC-11 and DEP-04 on this box (nothing resident while asleep; the real machine start is the risk); DRAFT, SPLIT, SLOG, RLOG, LANE, EMB-V8 hold SC-11 without dormant groups; CELL down on SC-11 in TS unless it prices dormant groups (+1 mechanism, DEV-01); OBJ neutral (nothing in memory); decision 17b is not needed for this bar.

### E-27: E-27: 10,000 idle client links in one Node server, over TLS

Folder: [experiments/E27-idle-links](experiments/E27-idle-links/README.md)

Q-27: one Node 22 server holds 10,000 idle plain-TCP links in 89 MB (3.7 KB a link) at 0.88 % of a core (heartbeat every 30 s), but 10,000 TLS 1.3 links in 538 MB (49.7 KB a link, 4 KB of it JS heap) at 1.63 % of a core, both just over the bar (500 MB, 1 %; Node 26.13: 549 MB, 1.15 %); 1,000 active subscribers at 10 messages/s each cost 8.8 % (TCP) and 17 % (TLS) of a core with p99 2.0 and 3.2 ms. Moves: every candidate with a TS edge (MIN, DRAFT, LEAN, MIN-TS, MIN-P, CELL, LANE, SPLIT, SLOG, RLOG, OBJ) down a little on SC-12 and DEP-07 until a TLS terminator in front of the TS edge (or a native edge) is planned now (an ops component, not a kernel mechanism: +0 on DEV-01, +1 deploy piece on DEP); SRV, RUST, EMB-V8 and SIDE, whose edges can be native, up a little on SC-12 (reasoned: a native TLS stack's per-connection memory was not measured here); SC-12's link counts themselves hold on under a fifth of a core.

### E-28: E-28 (timing part): MinIO as an object-store log

Folder: [experiments/E28-minio-log](experiments/E28-minio-log/README.md)

Q-28: on this disk a conditional PUT to MinIO costs 1.37 ms p50 and 2.67 ms p99 for 1 KB (3.7 × C; 4.3 ms p99 with 4-drive erasure coding, 7-11 ms at 1 MB), so the conditional-PUT protocol itself is cheap, but a real object store adds its network and replication (S3 Standard about 30 ms typical and 80 ms tails; Express One Zone single-digit ms, cited), which puts p99 above 10 × C = 7.3 ms, and 1,000 commits/s costs about $13,000 a month on S3 Standard ($2,900 on Express One Zone, cited prices). Moves: OBJ down on PERF-08 at `persisted` (fails the 10 × C line on a real store) and stays as a storage tier only (S `+tier` up as the home for sleep, wake, forks and history: SC-05, DEP-04); no disk-based row moves; decision 2b (hosted shape) is not reopened by latency, and E-41's cost table decides the rest.

### E-29: E-29: the power-loss test tier, and what a full disk needs

Folder: [experiments/E29-power-loss-disk-full](experiments/E29-power-loss-disk-full/README.md)

Q-29: yes, this box runs the power-loss tier (LazyFS 0.3.1: 2,640 power cuts and torn writes, 10,020 acknowledged batches, 0 lost; all four broken journals caught, one of them the journal's own first bug, found in 2 of 1,200 rounds), but LazyFS does not model lost directory entries or failed syncs, which need the simulator's disk model; and for a full disk L0 keeps one preallocated segment (at least 1 MiB) for removes, votes, member changes and retention marks (48 to 96 B each, 0 new blocks inside a preallocated segment) plus room for one snapshot (the rows' bytes again), refuses data first, and a full follower stops acknowledging and resumes by itself (three processes, tmpfs and ext4: pass). Moves: no candidate up or down; every row gains six L0 format rules for DEV-09 (preallocated segments, a marked reserve segment, snapshot headroom in the hard limit, segment ends by name, chained sequence numbers, short write = ask again) and F-20 holds with them; every row with snapshots on its own disk (all but OBJ) must state "a volume holds the rows twice" in SC-10 or send snapshots to the object store; F-10's failed-fsync and directory-fsync clauses stay open until the simulator's disk model covers them.

### E-30: E-30: derived outputs exactly once, with the cursor in another group and a long restart

Folder: [experiments/E30-derived-once](experiments/E30-derived-once/README.md)

Q-30: no `win`, `sess`, `pid` or `keys` option keeps consumer-group and derived outputs exactly once across a restart past the horizon; the cursor kept beside the outputs (per consumer, source slot and B slot, the highest source sequence applied, written in the output's entry and carried on a B slot move; 5 rules, 29 B a mark) does, and so does a retention-length key table (`srcpos`, 85 B per output for the whole retention); no 2pc is needed. Moves: every row's D gains `srchi-slot` for derived resources and consumer groups (P-08, P-17, F-02 up; DEV-01 +1 mechanism, precedent: storing consumer offsets in the same store as the outputs, the "Storing Offsets Outside Kafka" section of the KafkaConsumer javadoc, https://kafka.apache.org/36/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html); X `2pc` and `ktxn` do not move; `srcpos` alone is down on memory (DEV-01's price: terabytes at a week's retention); ISR's `pid` down on P-08 and P-17 unless it adds transactions.

### E-31: E-31: the subscribe protocol across failover, slot moves and relays

Folder: [experiments/E31-subscribe](experiments/E31-subscribe/README.md)

Q-31: Yes, after one rule change. As drafted, a follower that reloaded a snapshot tells a `log` reader `expired` while the leader holds every record (model-checked, 7 steps, one fault). With "a replica that lacks the reader's next record answers `END`; only the holding group's leader says `expired`", every property holds on ten bounds, each explored in full (up to 7.6 million states, 15 minutes of CPU in all): a leader crash, a follower's reload, a dropped link, a slot move and a relay, in `state` and `log` modes, every feature at once with one fault, and the move with two; only every feature at once with two faults is partial (no counterexample in 3 million states each). Cursors must be per-slot sequences: group offsets break both modes at the first move (5 steps). The move's carried segment names are a needed rule (a false `expired` in 8 steps without them). DEV-10: 26 rules by ablation, 27 with the segment names; 31 of 32 non-equivalent mutants caught (97%). Moves: every row that serves subscriptions from followers (W `any`: DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8; LEAN and SIDE for logs) keeps P-03, P-05, P-07 and F-04 once DESIGN-V5 4.4 says `END` (a changed answer, no new mechanism); O `slot` rows (DRAFT, MIN and its variants, RUST, SRV, LEAN, SLOG, OBJ) up on P-03, P-07 and DEV-09 (the cursor shape stands, with no translation at a move); O `off` rows down on P-07 and DEV-09 wherever a partition's records go on in another group's log (CELL's re-key; LANE if a lane's range ever moves; SPLIT only through its lineage rule); SC-14's far reads unchanged (a relay with any delay keeps every property; lag is not modelled).

### E-32: E-32: does the design hold where its mechanisms meet?

Folder: [experiments/E32-composition](experiments/E32-composition/README.md)

Q-32 (b): yes at these bounds, within stated limits: one model with a slot move, a leader change, a voter swap in A or B, a log drop behind a snapshot and the carried dedup state, interleaved freely (the design runs keep DESIGN-V5 4.1's guard, so a source never drops its log while a move copies from it; without the guard all 15 full bounds it touches hold too), keeps every property it checks (E-15's 1 to 8 but not 9, E-14's QL, LC and CF, E-16's P2, P3 and P8, E-20's ONCE and REFUSED, E-30's ONCE and DONE, E-17's reader cursor; E-31's protocol and E-15's slot table are not in it) on 28 bounds in full (up to 2,612,006 states, each under an hour) and on the review's two reader bounds with two writes (in full), while 3 bounds are partial and not a pass (`any` and `all` at 2.5 million states, the review's two-crash bound at 3 million, no counterexample), so every bound run in full has one member fault and no election ever meets a voter behind the log; once three rules are written: E-20's floor guards every path that judges a copy, E-17's lock-token refusal included (a write both applied and refused in 6 steps without it, found by composing, no move needed; Raft thesis 6.3); a snapshot keeps the floor, outcomes, mark and highest lock token beside the rows (5 to 20 steps without each); and the move carries the floor and the mark (16 to 19 steps); 20 of the 24 rules added at the crossing are needed, DESIGN-V5 4.1's "no move still copying" is not, and 95 of 136 mutants are caught (70%, under DEV-03's 85%; 85% where dedup meets the move and the log drop); 4 bugs the review planted are all caught, 2 only on the review's bounds. Moves: COMP (and MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, RLOG, EMB-V8, SIDE once they take C `self`) up on DEV-02 (K-01 inside one model at one member fault; K-02 in part: one session's floor, the highest token rather than a fence table, no epoch, no segment names), F-02 and P-08, +20 counted rules on DEV-10 and no new mechanism on DEV-01; DEV-03 up on its model clause, its mutant clause still open for the slot move; DRAFT, LANE, SPLIT, SLOG (`win`) not checked here, and owed the same floor rule by reasoning.

Q-32 (a) and (c): the matrix exists and is built by code (773 distinct pairs after four read-set fixes); every pair is placed (329 distinct pairs are argued independent in at least one row, for a second agent to check), and DEV-02's MUST stays open for every row until E-32 (b) finishes and the open pairs of section 7 get their models. Moves: no row up or down on DEV-02 (M) beyond "open"; every row fails DEV-02 (S); the rows with the most open row-pairs carry unmodelled mechanisms of their own (ISR, SLOG, OBJ, PD and V4 their own replication; DRAFT, CELL, LANE and SPLIT log replicas and, with COMP, the leader-run slow-leader rule).

**Q-32 (c), second agent:** the per-row counts add up and pairs.json is current; 59 of the 773 distinct pairs change class. E-32 (b) finished and holds 14 more pairs; 42 distinct pairs (198 row-pairs) move to open (39 whose argument broke, 3 whose model held only a stand-in), so every row still has open pairs and DEV-02's MUST stays open everywhere. Moves: no row up or down on DEV-02 (M) beyond "open"; ISR and SLOG carry the most new open pairs (27 and 24), from #meta records their data side acts on; every row with forks gains FORKPIN, every row with a tier and a restore mark gains RESTORENAME, and every row with writer time gains WTAIL (ISR, SLOG and OBJ the same question in their own model).

### E-33: E-33: genesis founds exactly one cluster; a restore keeps tokens and cursors honest

Folder: [experiments/E33-genesis-restore](experiments/E33-genesis-restore/README.md)

Q-33: No as drafted: founding on "a majority of seeds with no id" makes two clusters with writes after one lost dir and one crash (10 steps, model-checked), because a seed cannot tell "never ran" from "lost its dir"; `fero init` (3 rules, costs SC-02's no-setup across boxes) or a conditional create of the cluster id in the object store (4 rules, no setup, needs the store at the first start) each hold at the same bounds, `seeds` must never run beside a dir that holds an id (grow from one box by `hosts`), one box holds, and a restore stays honest only with an epoch above an outside high-water mark and a fresh session generation (8 rules, every mutant caught). Moves: MIN, RUST, LEAN, MIN-P, MIN-TS, SIDE, SLOG, OBJ (an object store across boxes, SPACE 4.1) up on SC-02 and DEP-18 with genesis = the conditional create (one mechanism, 4 rules); DRAFT, CELL, LANE, SPLIT, SRV, EMB-V8, RLOG (no store required across boxes as drafted) down on SC-02 (one `fero init`, 3 rules) unless they require the store; PD and ISR unchanged (their systems already found by an explicit step: PD's initial cluster, KRaft's `kafka-storage format --cluster-id`); every row's OPS-07 holds only with the restore's high-water epoch and a fresh session generation (8 rules; one more store write per epoch).

### E-34: E-34: waking 10 GB of rows

Folder: [experiments/E34-wake-10gb](experiments/E34-wake-10gb/README.md)

Q-34: no for 10 GB of 2 KB rows: one Node process wakes them to the first committed write in 86-122 s (median 94 s; 11.1 GB of heap, so `--max-old-space-size` of about 12-13 GB), CPU-bound in fero v4's JS crc32c (24 s) and decode (52 s, 36 s of it GC), not the disk (about 6 s) or data's fold (8 s); 5 GB wakes in 36 s and 5e6 small rows in 22-24 s (1.7-2.0 GB of heap: the default 2 GB heap holds it with one 0.6 s pause in three runs, about 3 GB is comfortable); main-thread GC pauses stay under 1 s everywhere (at most 0.46 s in a load and 0.21 s under 10,000 writes a second with 11 GB of heap); one `data` source holds at most 16,777,216 rows (V8's `Map` limit; an adopted plain object stalls just past 8.4 million keys). Moves: F `all` in TS meets SC-05 only up to about 5-6 GB of 2 KB rows (or about 13e6 small rows) per process here, so SC-05's bar is stated per storage form and a faster wake (a native crc32c, a record format V8 decodes natively, taking writes while the fold catches up) is planned now; F-06 up for TS on the main thread (pauses under 1 s even at 11 GB); decision 13's compact worker down a little on F-06 and F-14 (0.25-0.49 s pauses on the kernel's thread; keep its index off the V8 heap); SC-10 gains the ceiling of 16.8M rows per `data` source; SRV (rows folded natively) and RUST (crc and log in Rust) up a little on SC-05 (reasoned from the breakdown, not measured).

### E-35: E-35: big records and a busy tenant on a shared journal

Folder: [experiments/E35-neighbours](experiments/E35-neighbours/README.md)

Q-35: on this one disk, a 1 MiB record 10 times a second raised other partitions' p99 in the same journal by 1.18-1.26 × (SC-15's 1.2 × bar: holds, just; 64 KiB batch caps make it worse at 2.2-3.9 ×; a side file gives 1.12 × but slows big records 4 ×), while a tenant at a 10-40 MiB/s quota in 1 MiB records raised another tenant's p99 by 1.40-1.59 × on a shared journal and 1.20-1.36 × with a journal per tenant (SC-11's 1.1 × bar: fails; it holds only up to about 1 MiB/s of big records per tenant on the shared journal and about 5 MiB/s with a journal per tenant), because tenants share the disk; the critic's 4.2 × probe reproduces (4.8 ×) but overstates the clause, as it puts a big record in 10% of batches. Moves: S `jrnl` holds SC-15 with no new mechanism (every `jrnl` row up on SC-15); the rows that pool tenants in one log process (N `tier`: DRAFT, CELL, LANE, SPLIT, SLOG, RLOG, OBJ; N `pool`: EMB-V8) down on SC-11 and OPS-14 until they price one more mechanism, a per-tenant byte budget on the log tier (about 1 MiB/s of big-record bytes per tenant on this disk) or a volume per tenant; N `proc` rows (MIN, RUST, LEAN, MIN-P, MIN-TS, SRV, SIDE) up on SC-11 (reasoned, not tested here: a process and volume per project, J's promise, keeps tenants off one disk); L0's format needs no pointer record kind for this (DEV-09 unaffected), but frames of at most 64 KiB, which SC-15's 64 MB rows already need, are not by themselves a fix.

### E-36: E-36: a project with 100,000 small resources

Folder: [experiments/E36-many-resources](experiments/E36-many-resources/README.md)

Q-36: a project with 100,000 small resources costs, per idle resource, about 86 KB in memory and 8.2 KB of `#meta` per voter (824 MB at 1e5) with MIN as drafted, but 1.4 KB with a run-length slot table, sparse per-slot state and dormant groups, 0.4-1.2 KB with MIN-P and 0.2 KB with LANE; a create answers in 4.6-5.3 ms (MIN) or 1.6-1.8 ms (MIN-P, LANE) against 10.7 ms, and a cold open in 3.3-3.5 ms at the median (tail 5.4-7.6 ms) against 5 ms, flat from 100 to 100,000 resources. Moves: MIN (and MIN-TS, RUST, LEAN, DRAFT, RLOG, SRV, SIDE, EMB-V8: a group per resource) down on SC-13 and SC-10 as drafted, recoverable only with three phase-1 format choices (run-length slot table and sparse per-slot state, DEV-09) plus dormant groups (+1 mechanism, DEV-01); MIN-P up on SC-13, SC-10 and X18 (no dormant groups needed; settings must be equal per group); LANE up on SC-13's memory clause (0.2 KB) but its writer cap stays (E-18); every row: SC-13's "small" must be defined as "few slots touched" or per-slot state priced per touched slot (about 85 B in a JS Map).

### E-37: E-37: one bad entry on a voter that keeps its id

Folder: [experiments/E37-bad-entry](experiments/E37-bad-entry/README.md)

Q-37: No for Raft as published (a voter that keeps its id and cuts one bad entry as a torn tail lets a lagging leader overwrite a committed write: TLC, one fault, 32 states); Z `rejoin` fixes it in 2 rules (checksum plus wipe; never vote under the old id) and meets F-22's MUST, but two replicas with one bad entry each are never writable without F-12; Z `par` (checksum, refuse to vote or stand, repair the entry from any peer that knows it committed and whose own copy is good) keeps every state with two bad entries at different offsets writable (565,222 states, 0 stuck), and with the same offset every state where a good copy is left (1,362,748 states; the 4 stuck have no good copy anywhere, F-12), at 7 rules each shown necessary (mutants 8 of 9 caught, 1 undecided), so by the threshold R `vsr` is costed as a candidate row for F-22's SHOULD. Moves: every Raft row (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-22 (M) and F-10 with Z `rejoin` (+2 rules, already DESIGN-V5 4.1), and needs Z `par` (+7 rules: PAR's repair inside Raft) for F-22 (S); PD (Raft with Z `crash`) down on F-22 (M) until it takes a checksum and `rejoin`; ISR and OBJ (Z `crash`, not Raft) not checked here; R `vsr` gains a reason to be costed (F-22 S), against Raft + `par`; DEV-01 +1 mechanism for `par` (the per-entry bad mark and peer repair), none for `rejoin` beyond the incarnation the rows already count.

### E-38: E-38: etcd's raft with PreVote, CheckQuorum and leader transfer under gray failures

Folder: [experiments/E38-raft-gray-failures](experiments/E38-raft-gray-failures/README.md)

Q-38: No: etcd's Raft with PreVote, CheckQuorum and transfer never flapped, but stayed stuck with a connected majority in 5 of 280 five-node partial partitions (Raft's vote rule), took 3 to 3.9 E (not 2E) when the leader kept only one-way links (CheckQuorum every E/4 fixes it, a constant), and never gave up leadership for slowness (F-18 fails). Moves: every Raft row (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE, PD) down on F-18 and DEV-01 (+1 mechanism: a slow-leader rule) and down on F-17 unless F-17 is restated to "a connected majority that includes an up-to-date replica"; rows with async leader writes up on F-18's p99 clause.

### E-38c: E-38(c): three real etcd members with links cut by iptables

Folder: [experiments/E38c-etcd-iptables](experiments/E38c-etcd-iptables/README.md)

Q-38: on real TCP with iptables, etcd 3.5.17 with PreVote and CheckQuorum never flapped (24 runs), made no election when the leader kept a majority, and elected a new leader 1.16-2.06 E after it lost one (one-way loss into the leader included: 1.32-2.06 E, faster than the simulation's 3.2-3.4 E, since TCP turns busy one-way loss into two-way loss), but a member cut from the leader stalled its own clients for the whole fault, dropped writes cost clients a timeout, and a leader capped at 10% CPU kept leadership for 20E with p99 32 × worse. Moves: every Raft row (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE, PD) up a little on F-17 at the group level (real TCP is kinder than the model), down on F-18 (the slow-leader rule is confirmed as needed, +1 mechanism in DEV-01), and each needs the edge rule "refuse at once with a redirect, never drop or hold a write the member cannot forward" (F-05, F-17 client level: a rule, not a mechanism); rows whose clients are smart (SRV, PD, ISR) meet the client-level clause by routing.

### E-39: E-39: twice capacity, and a reconnect storm

Folder: [experiments/E39-overload-storm](experiments/E39-overload-storm/README.md)

Q-39: no; at 1-2 × the measured maximum (TS 1.53 M/s, Rust 2.62 M/s, E-02's pipeline with a client front), the unbounded queue, the bounded queue with refusals, bounded + retry-after + full-jitter backoff, and that plus a commit-path-first leader all collapsed to 0-50 % goodput and did not recover at 0.5 × (TS: the backlog sits in socket buffers before admission; Rust: retries until a 2 s deadline multiply the load), while a client-side credit window of 5 ms of capacity kept 79-82 % (TS) and 88-89 % (Rust) goodput at 2 × with admitted p99 0.8 × steady and recovery in 0-6 s; a 10,000-subscriber reconnect storm resubscribed in 1.5 s over TCP (p99 1.2 × steady) and 5.6-7.1 s over TLS (p99 27-45 × steady, resumption or not). Moves: every candidate prices admission control now as one mechanism in DEV-01 (credit windows on the client wire, plus a handshake budget at the edge), resolving X17's overload half; F-19 holds only with it (TS on the 80 % line, Rust 88 %); RUST, SRV, SIDE and EMB-V8 up a little on F-19 (more headroom, a cheaper refusal path); candidates with a TS TLS edge down on F-19's storm clause until TLS moves off the delivery thread (with E-27: a TLS terminator); no candidate needs server-side cursor tokens for resubscription at 10,000 (cursors plus a short history sufficed).

### E-40: E-40: a browser or an edge worker as a full client over WebSocket

Folder: [experiments/E40-browser-client](experiments/E40-browser-client/README.md)

Q-40: yes; `data` plus a prototype client (door, follow with cursor, writes that resolve on commit, fero's frame codec) is 27.9 KB gzip (all of `data` 26.6 KB), a Node relay pushes 0.89 × (1,000 subscribers) to 0.95 × (10,000) as many deliveries per core over WebSocket as over plain TCP, and a cold client reaches its first committed write over wss in 13 ms (Chromium Web Worker) and 17 ms (Chromium page) from its connect call, 58 ms in Node (43 ms of it loading Node's WebSocket client), with imports of 4-22 ms and one TLS handshake plus two round trips by design. Moves: every candidate up on P-19 and DEP-07 (the client is TypeScript in every row; browsers and edge workers need no bridge, and no client build of `data` is needed, so that data-side change is avoided); L0 gains WebSocket as a first-class transport carrying the same frames, and L3's client shape fixes the pipelined door (DEV-09); with E-27, the WebSocket edge is affordable in TS per core (0.89-0.95 × TCP), so Q-40 adds no reason for a native edge beyond E-27's TLS-memory finding.

### E-41: E-41: what each candidate costs the hosted platform

Folder: [experiments/E41-hosted-cost](experiments/E41-hosted-cost/README.md)

Q-41: on Fly a project costs $0.00 to $0.60 asleep, $4.94 to $7.26 at 10 writes/s for every row that runs inside the app (DRAFT's shared third voter cheapest, MIN 1.5 ×) and $79 to $129 at 5,000 writes/s, with OBJ 17 to 28 × the cheapest (a PUT per commit window: $131 a month at 10 writes/s) and SRV, PD and BUY 2.4 to 3.7 × at 10 writes/s (the app's machines beside the servers); on AWS traffic between zones is 85 % of the bill at 5,000 writes/s and levels every three-copy row at about $620; neither OBJ nor SLOG is cheapest by 2 ×, so decision 2b is not reopened; all prices are cited from search summaries, not the vendors' pages (this session cannot open them). Moves: OBJ down on DEP-21 (fails the $10 bar by 13 ×); SRV, PD and BUY down on DEP-21 at small loads (over both bars when awake); DRAFT, CELL, LANE, SPLIT, SLOG, RLOG and EMB-V8 up a little on DEP-21 (a shared tier or pool saves a third, if OPS-14 and J allow it); MIN, MIN-TS, MIN-P, RUST, SIDE, LEAN and ISR hold DEP-21 (LEAN's saving shows only above about 2 GB of rows per copy; RUST and SRV gain nothing from their language at these loads); every row: DEP-21's $10 bar needs the subscribers placed (inside, or at most 5 % of the writes each).

### E-42: E-42: an always-on recorder of kernel inputs

Folder: [experiments/E42-recorder](experiments/E42-recorder/README.md)

Q-42: yes in the `ref` form: at 50,000 appends/s the recorder of every kernel input costs 1.1-1.7% of a core per process (+5-11% of the pipeline's own CPU) and 0.15-0.4% of the journal's bytes (1.7 GB a day of events on the leader), every one of 18 recordings replayed byte for byte (75-115 × faster than real time), and a one-step reordering changed the effects in 8 of 10 follower cases, so the check is live; the disk budget is the journal kept for the replay window (441 GB a day at this rate, 8.8 GB at 1,000 appends/s). Moves: no candidate up or down on its own (every row with a deterministic kernel, MIN, MIN-TS, MIN-P, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE, gets OPS-11 (d) and its always-on clause from phase 1 at this cost); BUY and V4 cannot (no recordable kernel of theirs); DEV-09 gains three format rules (whole-frame inputs, bulk bytes by journal reference, journal retention tied to the recorder's window).

### E-43: E-43: do two `data` versions, and two Node versions, fold the same records to the same rows?

Folder: [experiments/E43-fold-versions](experiments/E43-fold-versions/README.md)

Q-43: Node 22 and Node 26 fold 1,000,000 records to the same rows in all 32 folds (18,000,000 per-record comparisons, 0 differ), and so do `data` commits one SCHEDULE_VERSION bump apart for 2 → 3 and 3 → 4 (0 differ); but two commits that both say SCHEDULE_VERSION 4 differ after 47,994 records and in 578 final rows (commit 515c0cf changed a deep write under a text value and did not raise the number), fero's seam and `data`'s lane end 1,512 rows apart on purpose, 8 of 61 JavaScript behaviours differ between the two Node versions (`**` in its last bit, Unicode 17, a zone rule, an error text, 12 built-ins), a `sum` view depends on the records and not the rows (0, NaN or 0.10000000000000003 where a rebuild gives 0.1), and one 41-byte record can make a 10 MB row or a 4 s write; the bump 4 → 5 that fero v4 needs is not published, so it was not run. Moves: no candidate up or down by itself; every row gains five pins for OPS-12, DEP-10 and F-21 before phase 1 fixes the record header (the fold version names `data`'s build and fero's way in, not SCHEDULE_VERSION; user functions run at the writer only, or are fenced, or a Node change restarts all copies; F-21 hashes rows, never views; P-12 and P-16 need rebuilt or drift-free aggregates at snapshots; the writer bounds what one record may do); every row with F `all` and W `any` (replicas and clients that fold and serve reads: MIN and its family, DRAFT, CELL, LANE, SPLIT, SLOG, RLOG, ISR, PD, EMB-V8) down a little on P-12 and P-16 until the view rule is chosen, where LEAN, SIDE and OBJ (one folding replica at a time) are exposed only at failover; RUST, SRV and EMB-V8 gain a ready input for DATA-09 (this stream and its per-record digests); DATA-04 needs a data-side change (a number or digest that a test forces to move with the fold).

### E-44: E-44: how much of fero runs on an outside log

Folder: [experiments/E44-outside-log](experiments/E44-outside-log/README.md)

Q-44: four patterns (P-01, P-14, P-10, P-09) run on JetStream 2.10.22 in 164 fero-owned lines and pass their main acceptance checks through a leader kill (900 writes none lost, exactly one of two sells 100 of 100, 60 lock acquires with no overlap and rising tokens, 294 jobs acked once and 6 dead-lettered), but ten gaps need fero's own kernel: failover 5.2 to 7.2 s against F-05's 2.5 s, exactly-once only inside a dedup window and only until the row's next write (F-02), conditions on one row only and judged by client retries (34 % of publishes wasted with 8 writers; about 4 ms an op), fencing by convention, one lease length per lock stream, a dead-letter notice that can be missed, FIFO per partition only with a consumer per partition, and TEST-10, DEP-20 and goal 2 by construction; and a clustered stream remembers the message id of a publish it refused, which lost 58 of 200 increments with no fault until the id named one try. Moves: BUY stays the reference row (out by construction; its lines are the floor: every Raft row is about 49 × and every log-first row about 82 × its 164 lines, almost all of it L0 to L2); every row with K `lib` (MIN and its family, DRAFT, LEAN, RLOG, SLOG, CELL, LANE, SPLIT, EMB-V8, SIDE) up a little on DEV-05's reason (the libraries above the log are small either way: lock 64 against 21 lines, queue 112 against 62; the lines that matter are L1 and L2, and they buy F-05, F-02, P-14 and PERF-10, which BUY cannot meet); D `win` (a dedup window alone: DRAFT, LANE, SPLIT, SLOG, V4) down a little on F-02 (the window fails past its horizon here, as E-20 and E-30 model); P-09 and P-10 for every row gain two rules found here (a take hands over what it has at once; a lock name has one lease).

### E-45: E-45: driving fero with each competitor's own tool

Folder: [experiments/E45-drivers](experiments/E45-drivers/README.md)

Q-45: every row of PERF-02 to PERF-07 has a faithful driver except the ones named not comparable; four L5 gateways built only from API.md's verbs (RESP, NATS with a JetStream subset, Kafka from Kafka's own message specs, etcd v3 gRPC; about 1,300 lines of TypeScript) let redis-benchmark, `nats bench`, `nats latency`, `nats bench js`, Kafka's producer, consumer and end-to-end tools and etcd's `benchmark` drive the E-22 prototype end to end with zero errors (measured here), PERF-07's lock row is a ported lock loop over `lock()`, and OMB needs no driver of its own; not comparable until built or runnable: the memtier, OMB and Redpanda runs (tools blocked here), Kafka share groups, JetStream redelivery and message-id dedup, etcd's own lock recipe and multi-key Txns; the drivers need five API changes fixed in phase 1 (a number form for versions, reads from a version, byte values, issue order for a process's writes in flight to one partition, measured broken in 12 of 100 seeds, and caller idempotency keys) and make Q-A9's missing `memory` rung concrete for PERF-02's and PERF-05's default rows. Moves: no candidate up or down on PERF-02 to PERF-07 (the drivers are L5 over L4, so every candidate that keeps API.md's L4 runs them unchanged); every candidate takes the same five API changes, on DATA-03, DEV-09 and PERF-01.

### E-46: E-46: the TypeScript port of etcd raft as a real key-value store, checked by Maelstrom

Folder: [experiments/E46-maelstrom-raft](experiments/E46-maelstrom-raft/README.md)

Q-46: yes — E-10's TypeScript port of etcd raft, driven unchanged by a 273-line Maelstrom node (in-memory log, key-value state machine, ReadIndex and log reads, optional snapshots), was linearizable in all 26 clean `lin-kv` runs on 3 and 5 nodes under partitions and SIGSTOP pauses (350 elections, 55,167 ok operations, 0 failures in Knossos or Porcupine, 0 replica-hash mismatches, all 143 snapshots accounted for), and the planted follower-read bug was caught in 8 of 8 runs; every anomaly traced to the harness or to Maelstrom/Jepsen, none to the port; a subtler planted bug (a replaced leader reading locally) left a wrong read in only 1 of 4 runs, which Porcupine flagged in 0.5 s while Knossos ran 18 minutes without an answer. Moves: every `port` row (MIN, MIN-TS, MIN-P, LEAN, RLOG, DRAFT, CELL, LANE, SPLIT) up on DEV-04 (the ported core holds end to end, snapshots included, which E-10 never ran) and slightly up on DEV-05 (the whole host loop around it is under 300 lines); TEST-13 sharpened, no candidate moves on it: a Maelstrom adapter is cheap, but needs `--concurrency 2n` (else reads miss half the keys), an outside pauser (Maelstrom 0.2.4 has no pause or kill), Porcupine beside Knossos with a time limit, and more load or runs for bugs that live in short windows; TEST-10 unchanged (no second implementation here).

## 2. Which experiments name each requirement

A requirement is listed when an answer line above names it. A requirement that is missing here has no experiment that moves a candidate on it.

| Requirement | Experiments |
|---|---|
| P-01 | E-5, E-9a2, E-22, E-44 |
| P-02 | E-21 |
| P-03 | E-19, E-31 |
| P-05 | E-8, E-19, E-31 |
| P-07 | E-19, E-31 |
| P-08 | E-30, E-32 |
| P-09 | E-44 |
| P-10 | E-9e, E-21, E-44 |
| P-12 | E-5, E-23, E-43 |
| P-14 | E-44 |
| P-15 | E-22, E-22b, E-24 |
| P-16 | E-23, E-43 |
| P-17 | E-30 |
| P-19 | E-40 |
| P-22 | E-22 |
| PERF-01 | E-1, E-9a2, E-45 |
| PERF-02 | E-9a, E-9a2, E-45 |
| PERF-03 | E-9b |
| PERF-04 | E-9b |
| PERF-05 | E-9c, E-45 |
| PERF-06 | E-9d |
| PERF-07 | E-9e, E-45 |
| PERF-08 | E-1, E-2, E-9e, E-12, E-28 |
| PERF-09 | E-2 |
| PERF-10 | E-3, E-44 |
| PERF-11 | E-8, E-9b |
| PERF-12 | E-11, E-25 |
| SC-02 | E-33 |
| SC-03 | E-17, E-17b, E-18 |
| SC-04 | E-17, E-17b |
| SC-05 | E-28, E-34 |
| SC-07 | E-25 |
| SC-08 | E-13, E-16, E-17, E-17b, E-17c |
| SC-10 | E-12, E-18, E-19, E-23, E-29, E-34, E-36 |
| SC-11 | E-26, E-35 |
| SC-12 | E-27 |
| SC-13 | E-11, E-36 |
| SC-14 | E-31 |
| SC-15 | E-35 |
| F-02 | E-20, E-30, E-32, E-44 |
| F-04 | E-31 |
| F-05 | E-1, E-5, E-13, E-38c, E-44 |
| F-06 | E-7, E-21, E-34 |
| F-07 | E-14, E-14b, E-14c |
| F-10 | E-29, E-37 |
| F-12 | E-37 |
| F-13 | E-7 |
| F-14 | E-7, E-34 |
| F-16 | E-14, E-14b, E-14c |
| F-17 | E-38, E-38c |
| F-18 | E-38, E-38c |
| F-19 | E-1, E-39 |
| F-20 | E-29 |
| F-21 | E-5, E-43 |
| F-22 | E-37 |
| DEV-01 | E-9a, E-9b, E-9c, E-9e, E-11, E-15, E-16, E-17, E-17b, E-17c, E-20, E-22, E-24, E-26, E-27, E-30, E-32, E-36, E-37, E-38, E-38c, E-39 |
| DEV-02 | E-16, E-17, E-17b, E-32 |
| DEV-03 | E-14, E-14b, E-14c, E-15, E-17, E-17b, E-17c, E-32 |
| DEV-04 | E-10, E-46 |
| DEV-05 | E-3, E-10, E-44, E-46 |
| DEV-07 | E-4 |
| DEV-09 | E-5, E-13, E-17b, E-18, E-19, E-29, E-31, E-35, E-36, E-40, E-42, E-45 |
| DEV-10 | E-14, E-15, E-20, E-31, E-32 |
| DEP-01 | E-13, E-21 |
| DEP-04 | E-26, E-28 |
| DEP-07 | E-27, E-40 |
| DEP-10 | E-43 |
| DEP-12 | E-2, E-12 |
| DEP-13 | E-5, E-7 |
| DEP-18 | E-33 |
| DEP-20 | E-44 |
| DEP-21 | E-41 |
| TEST-01 | E-4, E-22 |
| TEST-02 | E-21, E-22 |
| TEST-03 | E-20 |
| TEST-06 | E-6 |
| TEST-07 | E-6 |
| TEST-10 | E-4, E-10, E-44, E-46 |
| TEST-12 | E-22 |
| TEST-13 | E-22, E-22b, E-46 |
| DATA-01 | E-23 |
| DATA-03 | E-45 |
| DATA-04 | E-6, E-23, E-43 |
| DATA-05 | E-5, E-23 |
| DATA-09 | E-3, E-43 |
| OPS-07 | E-33 |
| OPS-11 | E-42 |
| OPS-12 | E-43 |
| OPS-14 | E-35, E-41 |
