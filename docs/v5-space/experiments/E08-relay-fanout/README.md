# E-08: deliveries a second from one relay core, in Node and in Rust

**Question (Q-08).** How many deliveries a second can one relay core push, in Node and in Rust? A relay is the process that follows a resource's committed records and pushes each one to the client links that subscribed to it (P-05's WebSocket fan-out by room; PERF-11's fan-out pin). "Delivery" means one record arriving on one subscriber link.

**Decides.** PERF-11, P-05, PERF-03 against NATS; whether relays must be native early, whatever the kernel's language.

**Threshold (QUESTIONS.md).** Node ≥ 100,000/s and Rust ≥ 3,000,000/s per relay core → the bars stand. Node below 100,000/s, or more than 2 × below E-09b's NATS fan-out → relays are native from phase 3. E-09b measured NATS at about 2.5 million deliveries per server core-second (1 → 16 subscribers, 16 B), so "2 × below" is about 1.26 million per core; this experiment also measures NATS at E-08's own record size (100 B), the fairer yardstick.

## Method

Code: [relay.mjs](relay.mjs) (Node), [rs/src/bin/relay.rs](rs/src/bin/relay.rs) (Rust, `mio` 1.2.4), [rs/src/bin/subs.rs](rs/src/bin/subs.rs) (subscriber processes), [rs/src/bin/feed.rs](rs/src/bin/feed.rs) (the source), [bench.mjs](bench.mjs) (the driver), [nats.py](nats.py) (the NATS yardstick).

- **Shape.** One relay process, one thread, plain TCP on loopback. 64 rooms. 1,000 or 10,000 subscriber links, held by two subscriber processes (Rust, epoll), link i in room i mod 64, so each room has about 16 (or 156) subscribers and each record is delivered about 16 (or 156) times. A feed process (Rust) streams 100 B records into the relay over one link, round robin over the rooms; each record carries its send time (`CLOCK_MONOTONIC`, which every process on the box shares).
- **The relay.** In each tick the records that arrived are grouped by room; each room's bytes are copied once into one buffer (each record encoded once, P-05), and that same buffer is written to every subscriber of the room: one write per socket per tick (Rust: one `writev` of up to 64 queued buffers). A subscriber whose queue passes 4 MiB pauses the feed until it drains below half (bounded memory, F-13; backpressure to the source). What a tick is: the Rust relay reads its feed until it would block (up to 1 MB), then fans out; the Node relay ran three ways: `tick=data` (fan out after every read, at most 64 KB: the first runs), `tick=immediate` (gather every read of one event-loop turn, fan out once in `setImmediate`) and `tick=win10` (gather for 10 ms).
- **Rates.** `max`: the feed sends as fast as the relay reads (TCP backpressure through the pause above), so the relay runs flat out on one core. `half`: an open-loop feed at half of that configuration's median max. Because the cost per delivery rises as rounds shrink, `half` still filled a core, so `halfcpu` sweeps down (3 s probes, halving the rate) until the relay uses at most about 0.6 of a core and measures latency there; the probes themselves give the cost per delivery against the load.
- **Measured.** Deliveries a second counted by the subscribers inside an 8 s window after 2 s of warm-up; each process's CPU from `/proc/<pid>/stat` over the same window; deliveries per relay core-second = deliveries / the relay's CPU seconds (the relay's CPU apart from the clients' and the feed's). Delivery latency = arrival time (read once per `read()` call) minus the record's stamp, in a log histogram (about 4 % resolution); the table gives the worse of the two subscriber processes.
- **The NATS yardstick** ([nats.py](nats.py)). nats-server 2.10.22 (core, no JetStream) with the nats CLI 0.5.1 (`nats bench sub --clients 16`, then `nats bench pub`, 100 B, 2 million messages); server CPU from `/proc` over the publish.
- **Timing.** Holds of the timing lock (`./run.sh s1k`, `s10k`, `halfcpu`, `ticks`), 3 runs per configuration, load average recorded before each run. Medians with the lowest and highest run in brackets.

Reproduce: `./run.sh build`, then `./run.sh s1k`, `s10k`, `halfcpu`, `ticks`, then `./run.sh summary`. Machine: 4 vCPU, 15 GB, Linux 6.18 (Firecracker VM), Node 22.22.0, Rust 1.97.0. Raw lines: [results/](results).

## Results

Raw lines: [results/runs.jsonl](results/runs.jsonl) (relays) and [results/nats.jsonl](results/nats.jsonl) (NATS), each with its load average; [summarize.py](summarize.py) prints the table.

<!-- tables:start (python3 summarize.py results/runs.jsonl) -->

| relay | tick | wire | subscribers | rate | runs | deliveries/s | records in/s | relay cores | deliveries per relay core-second | subscriber cores (2 procs) | p50 µs | p99 µs | p99.9 µs | load avg |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| node | data | tcp | 1,000 | max | 3 | 861,394 (728,278-1,004,526) | 55,129 (46,610-64,290) | 1.00 (0.99-1.00) | 871,195 (731,019-1,008,307) | 0.60 (0.55-0.66) | 637,534 (536,871-738,198) | 838,861 (671,089-973,078) | 905,970 (704,643-1,040,187) | 1.0 (1.0-1.1) |
| node | data | tcp | 1,000 | half = 27,565/s | 3 | 430,767 (430,668-430,951) | 27,569 (27,563-27,581) | 0.99 (0.99-1.00) | 434,208 (431,847-434,470) | 0.54 (0.53-0.58) | 11,010 (9,437-11,534) | 24,117 (19,923-24,117) | 29,360 (25,166-41,943) | 1.3 (1.2-1.4) |
| node | data | tcp | 1,000 | half CPU = 1,723/s | 3 | 26,922 (26,922-26,922) | 1,723 (1,723-1,723) | 0.38 (0.38-0.42) | 70,154 (63,909-70,848) | 0.20 (0.20-0.20) | 295 (295-295) | 1,180 (1,016-1,376) | 3,801 (3,277-3,932) | 1.2 (1.2-1.3) |
| node | immediate | tcp | 1,000 | max | 3 | 1,470,850 (1,376,241-1,792,683) | 94,134 (88,079-114,732) | 0.98 (0.98-0.99) | 1,500,867 (1,400,754-1,801,691) | 0.56 (0.55-0.61) | 369,099 (301,990-385,876) | 520,094 (402,653-520,094) | 536,871 (419,430-536,871) | 1.9 (1.7-2.0) |
| node | win10 | tcp | 1,000 | max | 3 | 20,981,088 (20,885,985-21,280,232) | 1,342,790 (1,336,703-1,361,935) | 1.02 (1.02-1.02) | 20,569,694 (20,426,391-20,837,436) | 0.56 (0.56-0.56) | 58,720 (58,720-60,817) | 113,246 (109,052-113,246) | 121,635 (117,440-134,218) | 1.1 (1.0-1.2) |
| rust | read-until-empty | tcp | 1,000 | max | 3 | 13,344,688 (13,216,392-14,121,978) | 854,060 (845,849-903,807) | 0.99 (0.99-0.99) | 13,428,617 (13,316,264-14,282,658) | 0.69 (0.69-0.70) | 60,817 (52,429-88,080) | 100,663 (79,692-125,829) | 117,440 (92,275-142,606) | 1.6 (1.4-1.6) |
| rust | read-until-empty | tcp | 1,000 | half = 427,030/s | 3 | 6,671,469 (6,668,548-6,672,564) | 426,974 (426,787-427,044) | 0.99 (0.99-0.99) | 6,744,423 (6,730,359-6,757,027) | 0.68 (0.66-0.68) | 9,962 (9,437-10,486) | 22,020 (20,972-23,069) | 29,360 (27,263-29,360) | 1.6 (1.6-1.7) |
| rust | read-until-empty | tcp | 1,000 | half CPU = 3,337/s | 3 | 52,141 (52,139-52,141) | 3,337 (3,337-3,337) | 0.48 (0.47-0.51) | 109,192 (102,741-110,351) | 0.32 (0.31-0.33) | 295 (262-295) | 3,539 (3,146-33,554) | 7,340 (7,078-109,052) | 1.1 (1.1-1.2) |
| node | data | tcp | 10,000 | max | 3 | 563,209 (540,720-563,391) | 3,605 (3,461-3,606) | 0.98 (0.98-0.98) | 573,241 (550,351-573,425) | 0.50 (0.50-0.51) | 5,905,580 (5,905,580-5,905,580) | 9,663,676 (9,663,676-9,663,676) | 9,663,676 (9,663,676-9,663,676) | 3.1 (2.4-4.2) |
| node | data | tcp | 10,000 | half = 1,803/s | 3 | 282,375 (281,978-283,480) | 1,807 (1,805-1,814) | 0.98 (0.98-0.99) | 286,312 (286,272-290,005) | 0.52 (0.49-0.53) | 142,606 (142,606-142,606) | 268,436 (268,436-285,213) | 318,767 (301,990-318,767) | 1.5 (1.4-1.9) |
| node | data | tcp | 10,000 | half CPU = 1,000/s | 3 | 156,895 (156,735-157,220) | 1,004 (1,003-1,006) | 0.98 (0.98-0.98) | 160,020 (159,122-160,711) | 0.56 (0.40-0.59) | 117,440 (109,052-150,995) | 251,658 (234,881-301,990) | 301,990 (285,213-385,876) | 0.7 (0.5-0.7) |
| node | immediate | tcp | 10,000 | max | 3 | 1,157,232 (1,075,880-1,219,753) | 7,406 (6,886-7,806) | 0.99 (0.99-0.99) | 1,171,881 (1,090,879-1,235,193) | 0.52 (0.46-0.54) | 4,563,403 (4,294,967-4,831,838) | 5,637,145 (5,637,145-6,442,451) | 5,905,580 (5,905,580-6,442,451) | 1.4 (1.2-1.6) |
| node | win10 | tcp | 10,000 | max | 3 | 32,092,552 (30,418,512-34,016,179) | 205,392 (194,678-217,704) | 1.00 (0.99-1.03) | 32,294,391 (29,532,536-34,101,432) | 0.84 (0.78-0.88) | 352,322 (335,544-369,099) | 637,534 (570,425-771,752) | 838,861 (603,980-973,078) | 1.2 (1.1-1.4) |
| rust | read-until-empty | tcp | 10,000 | max | 3 | 11,783,301 (10,852,363-11,831,477) | 75,413 (69,455-75,721) | 0.98 (0.97-0.99) | 11,917,371 (11,130,629-12,057,556) | 0.74 (0.72-0.77) | 771,752 (738,198-1,409,286) | 1,040,187 (973,078-1,677,722) | 1,073,742 (1,073,742-1,744,830) | 1.7 (1.4-1.8) |
| rust | read-until-empty | tcp | 10,000 | half = 37,707/s | 3 | 5,898,662 (5,882,607-5,909,310) | 37,751 (37,649-37,820) | 0.97 (0.97-0.98) | 6,049,910 (6,041,188-6,053,071) | 0.65 (0.64-0.65) | 134,218 (134,218-142,606) | 268,436 (260,047-268,436) | 301,990 (268,436-301,990) | 1.6 (1.5-1.7) |
| rust | read-until-empty | tcp | 10,000 | half CPU = 1,000/s | 3 | 156,276 (155,904-156,492) | 1,000 (998-1,002) | 0.98 (0.98-0.98) | 158,857 (158,681-159,076) | 0.60 (0.59-0.61) | 113,246 (109,052-113,246) | 218,104 (218,104-234,881) | 234,881 (226,492-285,213) | 1.2 (1.0-1.3) |

The halfcpu sweeps (one 3 s probe per rate, halving from half the max rate until the relay used at most 0.6 of a core): how the cost per delivery changes with the load.

| relay | wire | subscribers | records in/s | deliveries/s | relay cores | deliveries per relay core-second | p99 µs |
|---|---|---|---|---|---|---|---|
| node | tcp | 1,000 | 27,565 | 430,794 | 0.99 | 435,146 | 18,874 |
| node | tcp | 1,000 | 13,783 | 215,296 | 0.99 | 216,741 | 22,020 |
| node | tcp | 1,000 | 6,892 | 107,559 | 1.00 | 107,919 | 20,972 |
| node | tcp | 1,000 | 3,446 | 53,728 | 0.63 | 84,834 | 3,801 |
| node | tcp | 1,000 | 1,723 | 26,925 | 0.38 | 71,482 | 786 |
| rust | tcp | 1,000 | 427,030 | 6,672,923 | 1.00 | 6,695,240 | 23,069 |
| rust | tcp | 1,000 | 213,515 | 3,337,434 | 0.99 | 3,382,534 | 17,826 |
| rust | tcp | 1,000 | 106,758 | 1,669,770 | 0.99 | 1,686,636 | 25,166 |
| rust | tcp | 1,000 | 53,379 | 833,711 | 0.99 | 844,977 | 25,166 |
| rust | tcp | 1,000 | 26,690 | 417,002 | 0.99 | 422,637 | 16,253 |
| rust | tcp | 1,000 | 13,345 | 208,725 | 0.99 | 211,545 | 18,874 |
| rust | tcp | 1,000 | 6,673 | 104,275 | 0.91 | 115,009 | 19,923 |
| node | tcp | 10,000 | 1,803 | 282,899 | 0.99 | 285,756 | 301,990 |
| node | tcp | 10,000 | 1,000 | 156,459 | 0.99 | 158,039 | 301,990 |
| node | tcp | 10,000 | 1,000 | 158,080 | 0.98 | 161,306 | 301,990 |
| node | tcp | 10,000 | 1,000 | 156,909 | 0.99 | 157,962 | 268,436 |
| node | tcp | 10,000 | 1,000 | 156,820 | 0.99 | 158,940 | 285,213 |
| node | tcp | 10,000 | 1,000 | 159,434 | 0.98 | 162,688 | 285,213 |
| node | tcp | 10,000 | 1,000 | 158,683 | 0.98 | 161,372 | 285,213 |
| rust | tcp | 10,000 | 37,707 | 5,942,695 | 0.99 | 6,023,001 | 243,270 |
| rust | tcp | 10,000 | 18,854 | 2,990,765 | 0.99 | 3,031,181 | 268,436 |
| rust | tcp | 10,000 | 9,427 | 1,474,116 | 0.98 | 1,499,101 | 201,327 |
| rust | tcp | 10,000 | 4,714 | 740,259 | 0.98 | 757,944 | 260,047 |
| rust | tcp | 10,000 | 2,357 | 370,887 | 0.98 | 378,456 | 226,492 |
| rust | tcp | 10,000 | 1,179 | 183,221 | 0.98 | 186,327 | 218,104 |
| rust | tcp | 10,000 | 1,000 | 158,761 | 0.99 | 160,365 | 243,270 |

<!-- tables:end -->

**NATS at 100 B, 1 → 16 subscribers, `nats bench`, 3 runs:** 2,826,204 deliveries/s (2,731,247-2,843,291) with the server at 0.49 cores (0.48-0.50): **5.8 million deliveries per server core-second** (5.4-5.8 M). (E-09b measured 2.5 M per server core-second at 16 B in its own runs, with the server at 1.64 cores; why NATS used more CPU per delivery there was not investigated. With no added wait, Node at its best tick (1.17-1.50 M) is 1.7-2.1 × below the 2.5 M figure and 3.9-5 × below the 5.8 M one; with 10 ms rounds it is above both.)

Latency at `max` is the latency of a saturated relay whose subscriber queues are allowed to fill (up to 4 MiB each), so it is large by design and says nothing about a relay at normal load. The `half` rows are not a half-loaded relay either: at half the max rate both relays still used a full core (see below). Latency at a moderate load is in the `half CPU` rows.

### What the numbers say

1. **At max, Node pushes 0.87 million deliveries per core-second with 1,000 subscribers and 0.57 million with 10,000** when it fans out after every read of its feed (`tick=data`), and **1.50 and 1.17 million** when it gathers one event-loop turn first (`tick=immediate`). Rust pushes **13.4 and 11.9 million**. NATS, matched at 100 B, does 5.8 million per server core-second. Node clears PERF-11's TS bar (100,000) by 6-15 ×; Rust clears the native bar (3 million) by 4 ×.
2. **The cost is per socket write, and it is the same in both languages: about 8-14 µs of relay CPU per write on this VM.** At max both relays ran about 80-130 fan-out rounds a second of about 1,000 (or 10,000) writes each; the difference is what each write carried. The Rust relay reads its feed until empty (up to 1 MB, about 10,400 records a round, 160 records per write); the Node relay read about 500 records a round (8 per write) with `tick=data` and about 1,000-1,300 (15 per write) with `tick=immediate`. Dividing the relay's CPU by its writes gives 8-14 µs per write for Node and 11-14 µs for Rust. A write on loopback runs the kernel's whole TCP send and receive path and wakes the reader, all charged to the writer, which on this VM costs far more than the code above it.
3. **At the same offered load, Node and Rust spend about the same CPU.** In the sweeps (see the sweep table), at about 6,700-6,900 records a second to 1,000 subscribers Node used 1.00 core and Rust 0.91; at about 27,000 a second both used 0.99 (430,000 and 417,000 deliveries a second); at 1,000 records a second to 10,000 subscribers both used 0.98. The 10-15 × gap at max is records per write, not language.
4. **Latency follows from the rounds.** At a load where each relay used about half a core (1,000 subscribers: Node at 1,723 records/s, Rust at 3,337), delivery p99 was 1.2 ms (Node) and 3.5 ms (Rust). With 10,000 subscribers even 1,000 records a second filled a core in both (each record is 156 writes of one record each), and p99 was 0.22-0.25 s. A relay serving 10,000 sockets of a room that gets frequent small records must coalesce per room (a few ms) or spread its sockets over cores.
5. **Bigger rounds close the gap and more.** With one fan-out per 10 ms (`tick=win10`), the Node relay at max carried about 950-1,100 records per write and pushed **20.6 million deliveries per core-second with 1,000 subscribers and 32.3 million with 10,000**, more than the Rust relay's reads-until-empty rounds (13.4 and 11.9 million) and more than NATS's 5.8 million in its own run. Each write then cost 28-54 µs (it carries about 100 KB), but carried a thousand deliveries. The price is latency: a round waits up to 10 ms, which P-05's delivery bar (C + one hop, under 1 ms here) does not allow; between `immediate` (no added wait) and 10 ms lies a choice of a few ms per room.

## What this box cannot show

- **Real networks and bare metal.** Loopback has no packet loss, no small MTU and no round trip worth the name; a relay on a real NIC pays interrupts and per-packet costs instead of loopback's receive path. The 8-14 µs per write measured here includes this Firecracker VM's cost of waking a reader on another vCPU; on bare metal a loopback write is usually a few µs (reasoned, not measured). The ratios (Node against Rust at equal load, records per write) should carry over; the absolute numbers will not.
- **Separate client machines.** The two subscriber processes and the feed share the 4 vCPUs with the relay (their CPU is reported). The relay's own CPU is measured apart, so the per-core number holds, but the totals at 10,000 links are partly limited by the clients.
- **TLS and WebSocket.** Plain TCP here; WebSocket framing is E-40's, TLS is E-27's.
- **Many relay cores.** One thread each. Relays scale out by process (one per core); that is reasoned, not measured.

## Verdict

**A Node relay is not too slow because it is Node: on this box a relay's throughput is set by how many records each socket write carries, and the language is a minor term.** Each write costs about 8-14 µs here in Node and in Rust alike, and at the same offered load both relays used the same CPU. At max, Node pushed 0.57-1.50 million deliveries per core-second when it fans out per read or per event-loop turn (no added latency), 3.9-10 × below NATS's 5.8 million, which by E-08's rule would make relays native; with 10 ms rounds the same Node relay pushed 20.6-32.3 million, above both Rust (11.9-13.4 million with its own rounds) and NATS. So the rule's premise (language) does not hold; the decision is a latency budget: per-room coalescing of a few ms makes a TS relay meet PERF-11 many times over, and with no coalescing at all neither language fans small records out to 10,000 sockets on one core quickly (p99 0.22-0.25 s at 1,000 records a second).

Q-08: one relay core pushes 0.57-1.50 M deliveries/s in Node with no added wait (0.87/0.57 M fanning out per feed read, 1.50/1.17 M per event-loop turn, at 1,000/10,000 subscribers in 64 rooms, 100 B) and 20.6/32.3 M with 10 ms rounds, and 13.4/11.9 M in Rust (rounds of up to 1 MB), against core NATS's 5.8 M per server core-second at 100 B; each socket write costs 8-14 µs in both languages on this VM and both used the same CPU at equal load, so records per write, not language, set the rate; at moderate load p99 was 1.2 ms (Node) and 3.5 ms (Rust) with 1,000 subscribers, but 0.22-0.25 s with 10,000 in both. Moves: MIN-TS and every `ts→rs` row up on PERF-11 (a TS relay meets 100 k by 6-15 × and passes NATS with a few ms of per-room coalescing; native relays are not needed for throughput); RUST, SRV, SIDE and EMB-V8 not up on PERF-11 for language reasons (their edge is the same kernel-bound write); every candidate gains one rule for P-05 and L3: a relay coalesces each room for a bounded few ms and spreads sockets over cores (about 1,000 per core keeps a round near 10 ms), stated against P-05's latency bar.
