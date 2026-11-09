# E-42: an always-on recorder of kernel inputs

## The question

Q-42 ([QUESTIONS.md](../../QUESTIONS.md) §8): can a recorder of every kernel input run all the time, cheaply, and replay a production incident in the sim?

The **kernel** is the deterministic core: it reacts only to its inputs (frames from peers, ticks, client writes, disk completions) and produces effects (frames sent, journal writes, commits). If every input is recorded in order, a failing production run can be fed back into the same kernel code in the simulator and must produce the same effects, byte for byte. It decides OPS-11 (d) (a recorder whose dump replays as a failing seed, MUST) and its always-on clause (SHOULD: ≥ 24 h at ≤ 3% CPU within a stated disk budget), and the recorder's format, which is L0 shape (DEV-09).

**Threshold** (QUESTIONS.md): ≤ 3% CPU and ≤ 2 × the journal's bytes → always on from phase 1. Otherwise it is sampled, and the gap is stated.

## Method

**The pipeline** is E-02's TypeScript replication pipeline ([../E02-pipeline/ts/pipeline.ts](../E02-pipeline/ts/pipeline.ts)), copied into [pipeline.ts](pipeline.ts) unchanged in its protocol, journal (one `writev` and one `fdatasync` per round) and batching, main-thread mode: a leader and two followers, three processes on loopback, 50,000 appends a second of 100 B (E-42's rate; E-02's TS bar per process), one group, `persisted` rung, growing journal files, 2 s warm-up, 8 s window, 1 s drain.

**The recorder** (marked "E-42" in the file) appends, per process, one event per kernel input to a buffer and writes it to `rec.<id>` with `writeSync` each MB (page cache, no fsync). Each event is a kind byte, the µs since the previous event (a varint, so a dump is a timeline) and a small integer:
- leader: **submit** (a batch of client writes: its count), **ack** (the raw bytes of each chunk read from a follower), **durable** (the journal's `fdatasync` finished up to batch n);
- follower: **data** (each chunk read from the leader), **durable**.
Two forms: **`full`** also copies the bulk bytes (each submitted batch's records; each chunk from the leader); **`ref`** does not, because the journal already holds the same bytes in the same order, so the replay reads them from the journal (it records only each chunk's length, since TCP chunk boundaries change how the follower's parser runs).

**Replay** (`role=replay-leader|replay-follower`) feeds a recording into the same kernel classes (`LeaderCore`, `FollowerCore`) with no sockets and no disk. **Fidelity**: with `verify=1`, the live processes keep a running CRC32 of every effect (leader: each frame after its header is filled, each commit index; follower: each journal append, each ack), and the replay computes the same digest. **A check that the check can fail**: each recording is also replayed 10 more times, each time with one ack or durable event delivered one event late (positions 1,000 to 10,000), counting how many of these reorderings change the effects.

**Timing rules.** The cost runs (off, `ref`, `full`, interleaved, 3 runs) and the verify runs (3 per form) held `$SP/bin/timing`; load average 1.4 to 2.0 per run. Medians and ranges below. Node 22.22.0.

**Files.** [bench.mjs](bench.mjs) (driver), [run.sh](run.sh), [summarize.py](summarize.py). Raw: [results/runs.jsonl](results/runs.jsonl), [results/verify.jsonl](results/verify.jsonl). Table: [results/tables.md](results/tables.md). A smoke run (not a measurement): `results/smoke-verify.jsonl`. Nothing was downloaded.

## Results

All measured here.

### Cost at 50,000 appends/s

| recorder | committed/s | p99, ms | leader µs/append | follower µs/append | leader cores | follower cores | recorder bytes/s, leader / follower | as a share of the journal's bytes |
|---|---|---|---|---|---|---|---|---|
| off | 49,999 | 3.17 (2.99-4.78) | 4.37 (4.28-4.62) | 3.04 (2.95-3.33) | 0.219 | 0.152 | 0 | 0 |
| **ref** | 49,998 | 2.77 (2.49-3.36) | 4.61 (4.42-4.77) | 3.30 (3.05-3.32) | 0.230 | 0.165 | **19.8 KB / 7.7 KB** | **0.4% / 0.15%** |
| full | 49,993 | 2.86 (2.84-2.98) | 4.71 (4.49-4.80) | 3.37 (3.24-3.46) | 0.235 | 0.169 | 5.11 MB / 5.11 MB | 100% / 100% |

- **CPU**: the recorder adds **0.011-0.013 of a core** (`ref`) or 0.016-0.017 (`full`) per process: **1.1-1.7% of a core**. Per append that is +0.24 to +0.34 µs, or +5 to +11% of this pipeline's own CPU (the medians differ by about the runs' own spread, 0.3 µs). Commit latency did not get worse.
- **Bytes**: `ref` writes 3,200 events a second on the leader (6.2 bytes each) and 1,600 on each follower (4.8 bytes each), so 1.7 GB a day on the leader and 0.67 GB a day on a follower, but it relies on the journal for the bulk bytes. `full` copies the journal: 441 GB a day per process at this rate.

### Fidelity

| recorder | replays byte-identical | events per process (leader, followers) | planted one-step reorderings that changed the effects (of 10 per process; leader, f1, f2) | replay time for an 11 s run |
|---|---|---|---|---|
| ref | **9 of 9** (3 runs × 3 processes) | 34,532 / 17,274 / 17,305 | 0, 8, 8; 0, 8, 8; 2, 8, 8 | 95-147 ms |
| full | **9 of 9** | 35,481 / 17,739 / 17,779 | 0, 8, 8; 0, 8, 8; 1, 8, 8 | 95-131 ms |

- **Every replay reproduced every effect byte for byte**: 18 of 18 recordings.
- **The check can fail**: delivering one event a step late changed the followers' effects in 8 of 10 cases. On the leader only 0-2 of 10 changed anything, because most single swaps of an ack and a durable event happen between two batches and lead to the same commits: the digest catches a reordering only when it changes an effect, which is the property a replay needs.
- A replay runs 75 to 115 times faster than the run it replays.

## Against the threshold

- **≤ 3% CPU**: holds, read as a share of one core, the unit PERF-12 and OPS-11 use: +1.1-1.7% of a core at 50,000 appends/s. Read as a share of the kernel's own CPU it is +5-11%, over 3%. Divided by the events, the extra CPU is about 3-4 µs per recorded event, of the same size as the runs' spread, so the true per-event cost may be lower; a Rust kernel would pay less (reasoned).
- **≤ 2 × the journal's bytes**: holds in both forms: `ref` adds 0.15-0.4%, `full` adds 100%.
- **Always on for 24 h within a stated disk budget**: `ref` costs about 1.7 GB a day of events at 50,000 appends/s plus **keeping the journal for the window to replay** (441 GB a day at this rate of 100 B appends; 8.8 GB a day at 1,000 appends/s). So "always on" is cheap in CPU and event bytes, and the disk budget is the journal's retention: the recorder must pin the journal segments of its window (or copy them out on a dump) before compaction drops them.

So the recorder can be on from phase 1 in the `ref` form. Three things go into L0's format now (DEV-09): (1) a kernel input is a whole frame, not a socket chunk (here the follower's parser depended on TCP chunk boundaries, which had to be recorded; a kernel that takes whole frames needs only frame references); (2) every bulk input is in the journal in arrival order, so the recorder can refer to it; (3) the journal's retention knows about the recorder's window.

## What this box cannot show

- A full kernel: E-02's pipeline has no elections, no ticks of its own and no clients on the network (the load generator sits inside the leader and is recorded as submit events). A Raft kernel has more input kinds (ticks, votes, client requests from sockets); the per-event cost should be similar, the event rate higher.
- A real incident: the replay ran in the same Node version on the same machine; a replay in the simulator of a later release needs the fold-version pin of E-43.
- Rust: not built; the recorder there is a buffer append per event.
- Object-store completions (OPS-11 lists them) were not part of this pipeline.

## Verdict

Q-42: yes in the `ref` form: at 50,000 appends/s the recorder of every kernel input costs 1.1-1.7% of a core per process (+5-11% of the pipeline's own CPU) and 0.15-0.4% of the journal's bytes (1.7 GB a day of events on the leader), every one of 18 recordings replayed byte for byte (75-115 × faster than real time), and a one-step reordering changed the effects in 8 of 10 follower cases, so the check is live; the disk budget is the journal kept for the replay window (441 GB a day at this rate, 8.8 GB at 1,000 appends/s). Moves: no candidate up or down on its own (every row with a deterministic kernel, MIN, MIN-TS, MIN-P, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE, gets OPS-11 (d) and its always-on clause from phase 1 at this cost); BUY and V4 cannot (no recordable kernel of theirs); DEV-09 gains three format rules (whole-frame inputs, bulk bytes by journal reference, journal retention tied to the recorder's window).
