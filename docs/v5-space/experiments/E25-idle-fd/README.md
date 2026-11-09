# E-25: what the failure detector costs when idle, at n = 100 members

## The question

Q-25 ([QUESTIONS.md](../../QUESTIONS.md) §6): what does each candidate's failure detector cost when idle at n = 100 members?

A **failure detector** is how members notice that another member died. Raft groups do it with heartbeats from each group's leader. With **quiet groups** (a group with no writes stops its heartbeats; E-11), members instead send one **link ping** per pair of members every `ping.ms` (500 ms). Rows with a controller (ISR, SLOG) keep a **session** from each member to the controller. It decides PERF-12 (2,000 idle groups use ≤ 1% of a core; idle frames ≤ one ping per member pair per `ping.ms`, about 20,000 a second at n = 100), SC-07 (1 to 100 members) and conflict X8.

**Threshold** (QUESTIONS.md): ≤ 1% of a core per process and ≤ about 20,000 frames/s in all → PERF-12 holds. Above → that candidate needs a bound on peers per member, priced as one more mechanism.

## Method

- **(a) A placement model** ([model.py](model.py)): n = 100 members, `copies` 3, groups placed at random (seeded), 1e3, 1e4 and 1e5 resources (20 per project), each candidate's group count (SPACE §4.1). It counts idle frames a second for: per-group heartbeats (messages, and frames when all heartbeats from one member to another in a tick share a frame), per-pair pings with quiet groups (a pair is linked if it shares a group), controller sessions (ISR also has Kafka's idle follower fetches, one per follower-leader member pair every 500 ms, `replica.fetch.wait.max.ms`; KRaft broker heartbeats every 2 s; both Kafka defaults, cited from memory), and OBJ's lease renewals by conditional PUT. A count, not a measurement.
- **(b) One process with 99 links** ([node/member.mjs](node/member.mjs), [rs/src/main.rs](rs/src/main.rs)): a Node 22 or a Rust process listens; a Node "farm" process opens 99 TCP links to it and pings on each every 500 ms (it stands in for the other 99 members and is not measured). The measured process sends an 8-byte ping (E-11's frame) on each link every 500 ms, and every 100 ms checks that each link heard something in the last 2 s. It also holds 0 or 2,000 quiet Raft groups: E-10's TS port in Node, raft-rs 0.7.0 in Rust, built and never ticked, as E-11's hosts build them. CPU (user + system, all threads) over a 30 s window after 5 s of warm-up, and RSS.
- **(c) 100 Node processes on this box**: 100 members in a full mesh (4,950 TCP links), each pinging each peer every 500 ms (19,800 frames/s in all); and, as a floor, 100 "bare" Node processes with a listening socket and nothing else. Total CPU from `/proc/<pid>/stat` over a 30 s window, and total RSS.

**Timing rules.** (b) and (c) ran under `$SP/bin/timing`, 3 runs each, load average recorded. Medians and ranges below. Node 22.22.0, Rust 1.97.0.

**Files.** [bench.mjs](bench.mjs) (driver), [run.sh](run.sh), [fetch.sh](fetch.sh) (the crates for raft-rs, pinned by `rs/Cargo.lock`), [summarize.py](summarize.py). Raw: [results/runs.jsonl](results/runs.jsonl). Tables: [results/model.md](results/model.md), [results/tables.md](results/tables.md).

## Results

### (a) Idle frames per second at n = 100 (model)

| candidate | idle scheme | 1e3 resources | 1e4 | 1e5 | without quiet groups, coalesced frames/s (500 ms tick) at 1e4 | heartbeat messages/s at 1e4 |
|---|---|---|---|---|---|---|
| MIN, RUST, MIN-TS, LEAN, SRV, EMB-V8, SIDE, DRAFT, SPLIT, RLOG | pings | 8,904-9,056 | 19,744-19,768 | **19,800** | 34,212-34,488 | 80,000 |
| MIN-P (16 groups per project) | pings | 7,616 | 19,616 | 19,800 | 31,672 | 64,000 |
| CELL (16 per resource) | pings | 19,796 | 19,800 | 19,800 | 39,600 | 1,280,000 |
| LANE (64 per project) | pings | 16,976 | 19,800 | 19,800 | 39,564 | 256,000 |
| ISR (Kafka-style) | sessions + idle fetches | 7,288 | **34,456** | **39,700** | 34,356 | 80,000 |
| SLOG | sessions to a controller | 400 | 400 | 400 | 34,440 | 80,000 |
| OBJ | leases by conditional PUT | 0 frames, 500 PUTs/s | 0, 5,000 PUTs/s | 0, 50,000 PUTs/s | - | - |

- With quiet groups, idle frames are set by **linked member pairs**, not by groups: from about 10,000 groups up, every pair is linked and the count is the full mesh, 100 × 99 × 2 = **19,800 frames/s**, 198 per member. At n = 101 it is 20,200; at n = 1,000, 2.0 million ([results/model.md](results/model.md)).
- **Without quiet groups** every row is over the bar: 31,672 to 39,600 frames/s even when heartbeats share frames, and 64,000 to 12.8 million messages a second.
- ISR's idle follower fetches are pairwise too, at 500 ms each way, so above about 1e4 partitions it sits at about twice the pings' count (cited Kafka defaults; reasoned).
- SLOG's servers keep one session each (400 frames/s); its log tier's own Raft groups are a few members and add little (reasoned).
- OBJ sends no frames, but a lease renewed every 2 s per group costs a PUT each time: 500 to 50,000 PUTs a second, which is money (E-41 prices it), unless its leases go quiet too.

### (b) One process, 99 links pinged every 500 ms

| build | quiet groups held | CPU, % of one core | frames out/s | frames in/s | suspected peers | RSS, MB |
|---|---|---|---|---|---|---|
| Node | 0 | 0.83 (0.82-0.90) | 191 | 195 | 0 | 55.1 |
| Node | 2,000 | **0.95** (0.94-0.99) | 188 | 195 | 0 | 97.2 |
| Rust | 0 | 0.35 (0.34-0.40) | 198 | 194 | 0 | 7.9 |
| Rust | 2,000 | **0.33** (0.32-0.37) | 198 | 194 | 0 | 11.9 |

- A ping costs about **21 µs of CPU per frame sent or received in Node** (0.83% for 386 frames/s, with its timer wakeups) and **9 µs in Rust**.
- 2,000 quiet groups add no CPU in Rust and about 0.1 point in Node (a larger heap to scan), and 21 KB of RSS each in Node and 2 KB in Rust (E-11 measured 16-26 KB and 4 KB).

### (c) 100 Node processes on this box

| mode | total CPU, cores | per process, % of a core | worst process | total RSS | per process |
|---|---|---|---|---|---|
| bare (no links) | 0.000 (under the 10 ms tick resolution over 30 s) | 0.000 | 0.00% | 4.44 GB | 45.5 MB |
| full mesh, pings every 500 ms | **1.26** (1.256-1.264) | **1.27** | 1.47% | 5.42 GB | 55.5 MB |

- The whole n = 100 cluster's idle detector, on one 4-vCPU box, costs 1.26 cores: 1.27% per process, more than (b)'s 0.83% for the same 99 links, because 100 processes share 4 vCPUs and each wakeup costs a context switch. On its own machine a member pays (b)'s figure.

## Against the threshold

| clause | Node (TS rows) | Rust (RUST, SRV, EMB-V8, SIDE) |
|---|---|---|
| ≤ 1% of a core per process, 99 links + 2,000 quiet groups | 0.95%: holds, by 5% of the bar | 0.33%: holds |
| ≤ about 20,000 frames/s in all at n = 100 | 19,800 with quiet groups and pings: holds, exactly at n = 100 | the same |
| 100 members sharing one 4-vCPU box | 1.27% per process: over | not run |

So PERF-12 holds at n = 100 for every row with quiet groups and pairwise pings (MIN, DRAFT, RUST, SRV, LEAN, MIN-TS, MIN-P, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE), narrowly in TS, and only up to n = 100: the frame count grows as n², so SC-07's "past 100, the limit and its knob are said" needs the knob now. The cheapest knob is a bound on linked peers per member (placement keeps each member's groups within k peers; whether a production system does exactly this was not checked here, so its precedent is open): k = 32 gives 6,400 frames/s at n = 100 and 64,000 at n = 1,000. That is one more placement rule (DEV-01: +1; its precedent is to be counted as DEV-10 says). Without quiet groups no row passes, so quiet groups stay a phase-2 requirement (as E-11 found). ISR passes only below about 1e4 partitions with Kafka's defaults; SLOG passes easily (sessions to one controller); OBJ passes on frames but pays PUTs for leases.

## What this box cannot show

- One member per machine: (b) measures one process with 99 links, which is what each member would pay on its own machine; (c) puts all 100 on 4 vCPUs, which inflates the per-process cost by about 1.5 ×.
- Real failure detection was not exercised: no peer failed (0 suspected peers in every run). Detection time is the suspect timeout (2 s here) plus a ping interval.
- TLS on the peer links was not run (E-27 found TLS links cost about 13 × the memory of plain ones in Node).
- The model's counts for ISR and OBJ rest on cited defaults, not on runs of Kafka or an object store.

## Verdict

Q-25: idle, a member with 99 links pinged every 500 ms plus 2,000 quiet groups uses 0.95% of a core in Node and 0.33% in Rust (about 21 and 9 µs per frame), and pairwise pings at n = 100 make 19,800 frames/s in all, so PERF-12 holds for every quiet-group row at exactly n = 100, narrowly in TS; without quiet groups every row is over (31,672-39,600 frames/s, up to 12.8M messages/s), 100 members on one 4-vCPU box cost 1.26 cores, and the count grows as n², so past 100 members a bound on peers per member is needed. Moves: MIN, DRAFT, MIN-TS, MIN-P, LEAN, CELL, LANE, SPLIT, RLOG up on PERF-12 at n = 100 (narrow in TS), RUST, SRV, EMB-V8, SIDE up more (a third of TS's CPU); every pairwise-ping row down a little on SC-07 and X8 until a peers-per-member bound (+1 placement rule) is planned; ISR down on PERF-12 above about 1e4 partitions (idle fetches are pairwise); SLOG up on X8 (sessions to a controller: 400 frames/s); OBJ neutral on frames but its leases must go quiet or cost requests.
