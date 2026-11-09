# E-26: dormant groups for 1,000 sleeping projects

## The question

Q-26 ([QUESTIONS.md](../../QUESTIONS.md) §6): how many groups does a hosted log-tier process hold for 1,000 sleeping projects, and what does a dormant group cost?

Words: a **group** is one Raft log (E-11). A **quiet** group is in memory but sends nothing while idle. A **dormant** group is on disk only: its state is a small record in a store, and it is loaded when a message or a write arrives (**wake**). **N options** (SPACE §2): `proc` (each project has its own processes: a sleeping project has none), `tier` (a shared log tier holds every project's groups), `pool` (a shared server pools tenants).

It decides SC-11 (one log-tier process holds ≥ 1,000 sleeping projects; a quiet project sends nothing), DEP-04 (a small project writable ≤ 1.5 s after wake), decision 17 (`#meta` per project or one shared), axis N, and the group counts of MIN, MIN-P, CELL, LANE, SLOG and OBJ.

**Threshold** (QUESTIONS.md): 1,000 projects in ≤ 2 GB, 0 frames for quiet projects, one project writable ≤ 1.5 s after wake → SC-11 and DEP-04 hold. A candidate over budget needs dormant groups (one mechanism) or decision 17b.

## Method

**The count** ([model.py](model.py)): 1,000 projects with 1 to 20 resources each (uniform, seeded: 10,652 resources), `copies` 3, each candidate's groups per project (SPACE §4.1), on a log tier of 3 or 6 processes. Memory per quiet group from E-11 (RSS growth per group at 10,000 groups: TS 16 KB, Go 6.5 KB, Rust 4.0 KB); memory per dormant group measured here.

**The measurement** ([host.ts](host.ts), [lifecycle.mjs](lifecycle.mjs)). The host is E-11's TS host on E-10's port of etcd raft (the same Raft loop, one journal with one fdatasync per round, quiet groups, link pings every 500 ms, ticks of 500 ms, election after 4 ticks), with groups that come and go:
- **sleep**: a quiet, fully committed group is written to the process's dormant store (one append-only file; a 24-byte record: group, term, vote, commit, last index, last term; one append and one fdatasync per command) and dropped from memory. A dormant group costs one Map entry.
- **wake**: process 1 reads the record (one `pread`), rebuilds the group and campaigns at once; a follower rebuilds it when the first message for it arrives. "Writable" = one new entry committed and applied on process 1.
- **create**: a new group on all three processes, process 1 campaigns at once and writes one entry; **meta**: one 200 B row committed in group 0 (`#meta`).
- **boot**: the project's three processes start cold and process 1 wakes the project's 20 groups from the store (N `proc`: scale to zero and back).

Per run: three processes with 16 awake groups and S = 100, 10,000 or 100,000 dormant groups already in each store; 20 creates; a 5 s idle window counting frames and Raft messages; the 20 new groups put to sleep; 20 single wakes; 3 wakes of all 20 at once; memory; then 3 cold boots. 3 runs per S.

**Timing rules.** Each run block held `$SP/bin/timing` (one run of every S per hold, 3 holds), load average recorded (0.05 to 6.4: the first S = 100 run started just after E-25 (c) had stopped 100 processes; its numbers match the others). Medians and ranges below.

**Files.** [run.sh](run.sh), [summarize.py](summarize.py), [model.py](model.py). Raw: [results/lifecycle.jsonl](results/lifecycle.jsonl). Tables: [results/lifecycle.md](results/lifecycle.md), [results/model.md](results/model.md). A smoke run (not a measurement): `results/smoke.jsonl`. Nothing was downloaded. E-36 uses the same runs for its create and open times.

## Results

### Measured: a dormant group, a wake, a quiet project

| dormant groups per process | wake 1 group: p50 / p90 / max, ms | wake a project of 20 groups, ms | cold boot of 3 processes + 20 groups, ms | RSS per process, MB | idle Raft messages/s | idle frames/s per process |
|---|---|---|---|---|---|---|
| 100 | 3.51 / 5.11 / 5.30 | 11.5 (10.0-14.5) | 281 (265-310) | 95.9 | **0.00** | 3.2 (link pings only) |
| 10,000 | 3.41 / 4.52 / 4.86 | 12.1 (9.8-13.5) | 294 (269-305) | 95.5 | **0.00** | 3.2 |
| 100,000 | 3.33 / 4.39 / 5.35 | 12.3 (10.6-16.3) | 300 (292-318) | 101.3 | **0.00** | 2.8 |

- **A dormant group costs 57 B of memory** ((101.3 − 95.9) MB / 99,900 groups) and 24 B on disk, against 16 KB (TS), 6.5 KB (Go) or 4 KB (Rust) for a quiet group in memory (E-11): about 280 times less than TS.
- **Waking is fast and does not depend on how many groups sleep**: one group is writable 3.3-3.5 ms after the wake (median; a `pread`, an election with PreVote, one commit); a project of 20 groups in 10-16 ms; the same with 100 or 100,000 dormant groups beside it.
- **A cold boot** (three Node processes start, link up, wake 20 groups, commit in each) takes **265-318 ms**, most of it Node's start and module loading.
- **A quiet project sends nothing**: 0 Raft messages a second; the 2.8-3.2 frames a second per process are the link pings between the three processes, shared by every project on them.

### Counted: groups and memory for 1,000 sleeping projects (log tier of 3 processes)

| candidate | N | groups per process | memory, quiet groups in memory (TS / Rust) | memory, dormant groups |
|---|---|---|---|---|
| MIN, RUST, MIN-TS, LEAN, SRV, SIDE | proc | 0 (a sleeping project has no process) | 0 | 0 |
| MIN-P | proc | 0 | 0 | 0 |
| DRAFT (`#meta` per project) | tier | 11,652 | 0.19 GB / 0.05 GB | 0.7 MB |
| DRAFT with one shared metadata group (17b) | tier | 10,653 | 0.17 GB / 0.04 GB | 0.6 MB |
| MIN-P on a tier | tier | 2,000 | 0.03 GB / 0.01 GB | 0.1 MB |
| CELL (16 per resource) | tier | 171,432 | **2.74 GB** / 0.69 GB | 10 MB |
| LANE (64 per project) | tier | 65,000 | 1.04 GB / 0.26 GB | 4 MB |
| SPLIT, RLOG, EMB-V8 (pool) | tier, pool | 11,652 | 0.19 GB / 0.05 GB | 0.7 MB |
| SLOG | tier | 10,652 | 0.17 GB / 0.04 GB | 0.6 MB |
| OBJ | tier | 0 (the log is the object store) | 0 | 0 |

(A tier of 6 processes halves the counts. Each process also has its base: about 95 MB for Node here.)

## Against the threshold

| bar | result |
|---|---|
| 1,000 sleeping projects in ≤ 2 GB per process | every row passes with quiet groups in memory **except CELL in TS (2.74 GB)**; every row passes with dormant groups (≤ 10 MB) |
| 0 frames for quiet projects | holds: 0 Raft messages; link pings are per process pair, not per project |
| writable ≤ 1.5 s after wake | holds by 100 × in a live tier (10-16 ms for 20 groups) and by 5 × from a cold start of three processes (265-318 ms); the rows' fold of a small project's data adds about 1.4 ms per 312 rows at E-05's 223,000 records/s (reasoned) |

So SC-11 and DEP-04 hold for every row on this box, and dormant groups are needed only for CELL in TS (or wherever a tier holds more than about 100,000 groups per process in TS). Dormant groups are cheap (one store record and one Map entry per group; wake by `pread` and an immediate campaign), but they are one more mechanism (DEV-01), with precedent: CockroachDB's quiesced ranges stay in memory, and the dormant form here is closer to TiKV's hibernate regions (cited from memory, not checked here). Decision 17b (one shared metadata group) saves only 1,000 of 11,652 groups and is not needed for this bar.

## What this box cannot show

- A real machine start: the cold boot here starts three Node processes on a warm box; a Fly machine start adds its own seconds (v4 measured 1.4 s for a wake with 312 rows, J's record), so DEP-04's 1.5 s is tight for N `proc` on real hosting, and loose for N `tier`.
- Cold disk reads: the dormant store was in the page cache. A cold read of one 24-byte record from this disk is about 0.1-0.2 ms (E-01's read side was not measured; reasoned).
- Rust and Go wake times were not measured; the wake is mostly an election and a commit, which E-11 shows are faster there.
- 1,000 real projects were not started; the memory is counted from per-group measurements.

## Verdict

Q-26: for 1,000 sleeping projects a log-tier process holds 0 (N `proc`) to 171,432 (CELL) groups; with quiet groups in memory every row fits 2 GB except CELL in TS (2.74 GB), and a dormant group costs 57 B of memory and 24 B on disk, wakes in 3.3-3.5 ms (a project of 20 in 10-16 ms, a cold start of three processes in 265-318 ms) with no change from 100 to 100,000 dormant groups, and a quiet project sends 0 messages. Moves: MIN, MIN-P, RUST, MIN-TS, LEAN, SRV, SIDE (N `proc`) up on SC-11 and DEP-04 on this box (nothing resident while asleep; the real machine start is the risk); DRAFT, SPLIT, SLOG, RLOG, LANE, EMB-V8 hold SC-11 without dormant groups; CELL down on SC-11 in TS unless it prices dormant groups (+1 mechanism, DEV-01); OBJ neutral (nothing in memory); decision 17b is not needed for this bar.
