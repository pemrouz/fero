# E-13: handover, failover, catch-up per GB, and a slot move's unwritable window

## The question

Q-13 ([QUESTIONS.md](../../QUESTIONS.md) §3): on this box, how long are a planned handover, a failover, a catch-up per GB, and a slot move's unwritable window?

Words used here:
- **Handover**: the leader of a Raft group gives leadership to another member on purpose (etcd's `move-leader`, Raft's leader transfer). Rolls (DEP-01) use it.
- **Failover**: the leader dies (here `kill -9`) and the others elect a new one after the **election timeout** E.
- **Catch-up**: a new member copies the group's data until it is current.
- **Slot move**: one slot of a resource moves from group A to group B. In DESIGN-V5 that is three commits in a row: A's fence (A stops taking writes for the slot), the `#meta` row (the catalog says B owns it), B's open. The slot cannot take writes from the fence until B is open: that is the **window**.

It decides F-05 (handover ≤ 10 ms in TS, failover ≤ 2.5 s), SC-08(b) (a move's window ≤ 10 ms in TS), SC-08(f), DEP-01 (3 copies roll in ≤ 10 s), and RLOG's writer handover.

**Thresholds** (QUESTIONS.md): etcd's handover gap ≤ 10 ms → the TS bar is reachable here; above → it is disk-bound and restated as C plus a margin. 3 × commit p99 > 10 ms → SC-08(b) is restated, or the move is cut to fewer commits before phase 1. C = 0.73 ms on this box ([E-01](../E01-floors/README.md)).

## Method

**etcd** ([etcd.py](etcd.py), [load/main.go](load/main.go)). Three etcd 3.5.17 members on loopback, each with its own data dir on the one disk (fsync on, as etcd always does), heartbeat 100 ms, PreVote on (etcd always runs CheckQuorum). A fresh cluster per run. The load is a Go program on etcd's own client (v3.5.17): 2,000 logical puts a second of 256 B from 16 writers, open loop; a failed attempt is retried (same key, same value) after 1 ms until it is acknowledged, as F-05's "clients retry by themselves" asks. Every logical write records its first try and its acknowledgement on one clock, and the driver's events are marked on the same clock.
- **(a) Handover**: 5 `etcdctl move-leader` per run, 3.5 s apart, 3 runs (15 transfers). Measured: the longest gap between any two acknowledgements from 0.2 s before to 3 s after the transfer, the time to the first acknowledgement of a write started after it, and the longest logical write (first try to ack, retries in). The same longest gap over a quiet 3 s window before the first transfer is the baseline.
- **(b) Failover**: `kill -9` of the leader under the same load, election timeout 1,000 and 2,000 ms, 3 runs each.
- **(c) Catch-up**: the cluster is filled with 1 GB (16,384 puts of 64 KiB with etcd's `benchmark` tool, quota 8 GB), then a fourth member is added and started. Measured: time from `member add` to the new member's applied index reaching the cluster's (polled every 50 ms). Two modes: `log` (etcd's default snapshot count, so the new member receives the log) and `snap` (`--snapshot-count 1000`, so it receives a snapshot of the 1 GB database).
- The first runs used a 2 s per-attempt client timeout. A second set used 100 ms and read each election's time from the members' own logs (`became leader at term`), see below.

**Slot move on the real TS Raft** ([move/host.ts](move/host.ts), [move/move.mjs](move/move.mjs)). QUESTIONS.md asks for this "once E-10's port runs": it runs. The host is E-11's TS host unchanged in its Raft loop (E-10's port of etcd raft, one journal with one fdatasync per loop round, one link per peer, quiet groups), three processes on loopback, 16 groups, ticks of 500 ms and election after 4 ticks (the draft's TS settings). Added: a move chain. Process 1 proposes A's fence entry (group 0, led by process 1); when it commits, process 1 tells process 2, which proposes the `#meta` row in group 1; when that commits, process 2 tells process 3, which proposes B's open in group 2; when that commits, process 3 tells process 1, which records the window from proposing the fence. So the window includes two loopback hops between leaders, as a real move would. One move every 50 ms (200 per 10 s window), background writes of 100 B at 0, 2,000 and 10,000 a second over all 16 groups, and chains of 1, 2 or 3 commits (1 = A's fence only; 2 = fence, then B's open). 3 runs each, interleaved.

**Timing rules.** All timed parts ran under `$SP/bin/timing`, 3 runs, load average recorded in every row (1.0 to 4.3 for etcd: the members' own work; 0.9 to 3.3 for the slot moves). Tables show the median and the range.

**Files.** [run.sh](run.sh) (`build`, `etcd`, `etcd-t100`, `move`, `table`), [fetch.sh](fetch.sh), [summarize_move.py](summarize_move.py). Raw: [results/etcd-move.jsonl](results/etcd-move.jsonl), [results/etcd-kill.jsonl](results/etcd-kill.jsonl), [results/etcd-join.jsonl](results/etcd-join.jsonl), [results/move.jsonl](results/move.jsonl), the 100 ms runs in `results/*-t100.jsonl`. Tables: [results/tables.md](results/tables.md), [results/move-table.md](results/move-table.md). A smoke run (not a measurement): `results/move-smoke.jsonl`.

## Results

All measured here.

### etcd: handover, failover, catch-up (client timeout 2 s)

| part | events | longest gap between acks, ms | first ack of a new write after the event, ms | longest logical write, ms | quiet-window gap, ms | quiet p99, ms |
|---|---|---|---|---|---|---|
| handover (`move-leader`) | 15 in 3 runs | **9.8** (4.9-24.4) | 2.0 (1.2-6.0) | **2,002** (9.8-2,006) | 5.5 (4.4-22.9) | 4.0 (3.9-6.3) |
| failover, E = 1,000 ms | 3 in 3 runs | 1,547 (1,035-2,002) | 1,548 (1,036-2,005) | 2,008 | 5.2 | 4.3 |
| failover, E = 2,000 ms | 3 in 3 runs | 4,004 (4,004-4,005) | 4,005 (4,005-4,006) | 4,011 | 4.4 | 3.4 |

| catch-up of a new member | runs | database | caught up, s | s per GB |
|---|---|---|---|---|
| from the log | 3 | 1.04 GB | 6.0 (5.3-6.2) | **5.7** (5.2-6.0) |
| from a snapshot | 3 | 1.03 GB | 7.1 (3.7-7.1) | **6.8** (3.5-6.9) |

- **A handover barely pauses the group, but it loses writes.** The longest gap between any two acks around a transfer is 9.8 ms (median of 15), against 5.5 ms in a quiet window of the same length: the transfer adds about 4 ms. The first write started after the transfer is acknowledged in 2 ms. But in 8 of 15 transfers at least one write that reached the old leader during the transfer was dropped: etcd answers some with `raft proposal dropped` at once (15 times) and leaves others to the client's timeout (33 times), so those writes took the full 2 s timeout plus a retry. A client that waits for its timeout sees a 2 s pause, not 10 ms.
- **A failover is quantised by the client's timeout here.** With a 2 s per-attempt timeout every first new ack lands at a multiple of it (1.0-2.0 s at E = 1 s; exactly 4.0 s at E = 2 s, two timeouts). The cluster elected earlier; the 100 ms runs below separate the two.
- **Catch-up runs at 150 to 290 MB/s** (5.2 to 6.9 s per GB; the new member wrote 2.1-2.3 GB of WAL and database in log mode, 1.2 GB from a snapshot). The leader kept its other work meanwhile (no load ran during the join).

### etcd with a 100 ms client timeout, elections from the logs

The same runs with a 100 ms per-attempt timeout, so the client sees the cluster within 0.1 s, and each election's time read from the members' own logs.

| part | events | longest gap between acks, ms | first ack of a new write, ms | longest logical write, ms | new leader elected after the kill (logs), ms |
|---|---|---|---|---|---|
| handover | 15 in 3 runs | **9.7** (5.0-30.8) | 2.5 (1.0-6.7) | **103** (7.7-106) | - |
| failover, E = 1,000 ms | 3 in 3 runs | 1,146 (1,026-1,418) | 1,143 (1,024-1,419) | 1,229 | **1,141** (938-1,330) |
| failover, E = 2,000 ms | 3 in 3 runs | 2,044 (2,034-3,362) | 2,044 (2,038-3,363) | 2,144 | **2,042** (2,033-3,343) |

- **Handover**: the same 10 ms group gap; the writes caught in the transfer now cost one 100 ms timeout and a retry (9 of 15 transfers), instead of 2 s. So what a client pays at a handover is its own timeout, unless the server refuses at once.
- **Failover is the election timeout plus about 5 ms.** The first new write is acknowledged 2-20 ms after the new leader is elected. etcd draws each member's election timer from [E, 2E), so a failover takes between E and 2E: 0.94-1.33 s at E = 1 s, 2.03-3.34 s at E = 2 s.

### Slot move on E-10's TS Raft port: the unwritable window

| background writes/s | commits in the move | window p50, ms | p90 | **p99** | max | background write p99 on process 1, ms |
|---|---|---|---|---|---|---|
| 0 | 1 | 1.72 (1.68-1.82) | 2.23 | 4.72 (4.34-5.62) | 16.5 | - |
| 0 | 2 | 3.27 (3.19-3.34) | 4.18 | 7.09 (6.29-8.35) | 8.7 | - |
| 0 | **3** | 4.14 (4.01-4.21) | 5.49 | **8.74** (8.67-10.85) | 11.5 | - |
| 2,000 | 1 | 0.80 (0.79-0.80) | 1.09 | 1.89 (1.78-3.45) | 4.8 | 4.78 |
| 2,000 | 2 | 1.76 (1.76-1.80) | 2.36 | 4.72 (4.46-4.72) | 5.0 | 4.21 |
| 2,000 | **3** | 2.68 (2.63-2.81) | 3.43 | **5.04** (4.50-5.04) | 6.8 | 4.11 |
| 10,000 | 1 | 1.05 (0.99-1.07) | 1.77 | 4.56 (4.11-6.70) | 8.7 | 8.18 |
| 10,000 | 2 | 2.42 (2.26-2.47) | 3.70 | 12.77 (8.80-13.28) | 29.6 | 7.31 |
| 10,000 | **3** | 3.74 (3.56-3.85) | 5.36 | **16.70** (14.11-19.14) | 31.0 | 7.73 |

- Each commit in the chain costs about 0.9 ms at the median (one fdatasync on two of three journals, one round trip, one hop to the next leader).
- **The p99 follows the background load**, because each step waits behind whatever batch is in the journal: 5.0 ms at 2,000 writes/s, 8.7 ms idle (an idle group is quiet and its first write wakes it), 16.7 ms at 10,000 writes/s, where the background writes' own p99 is 7.7 ms.
- QUESTIONS.md's reasoned estimate, 3 × E-02's commit p99, gives 8.2 ms at 10,000/s and 13 ms at 50,000/s (E-02 TS: 2.73 and 4.33 ms). The real Raft port at 10,000/s is worse (16.7 ms), since E-11's host is a full Raft with a slower tail than E-02's floor pipeline.

### RLOG's writer handover and DEP-01's roll (reasoned, flagged)

- **RLOG**: one epoch commit plus the new writer's fold catch-up. The epoch commit is one commit: 1.9 ms p99 at 2,000/s and 4.6 ms at 10,000/s in the table above (row "1 commit"). RLOG's servers are full learners that fold all the time, so the tail is the records in flight, a few ms of writes: at 10,000/s and 5 ms that is 50 records, 0.2 ms at E-05's 223,000 records/s. So about 2 to 5 ms: within F-05's 10 ms (reasoned from measured parts). A cold writer that must replay 1e6 rows takes 4.5 s (E-05).
- **DEP-01** (3 copies roll in ≤ 10 s): per copy, one handover (about 10 ms of group pause) plus a restart and a catch-up of the writes missed meanwhile (at 5.7 s per GB, 2 s of 2,000 writes/s of 256 B is 1 MB: about 6 ms). The restart itself was not measured on etcd; E-26 measured a cold start of three TS processes to a first write in each of 20 woken groups at 265-318 ms. So three copies roll in about 3 × (0.3 s + 10 ms + a few ms) ≈ 1 s on this box, well inside 10 s (reasoned from measured parts; a real machine or container restart adds its own seconds).

## Against the thresholds

- **etcd's handover gap ≤ 10 ms?** At the median, just (9.8 ms; the quiet window's own longest gap is 5.5 ms); at the worst of 15, no (24.4 ms). On this disk a handover costs about one extra fsync-bound commit of pause, so the TS bar of 10 ms is reachable but not with margin, and it should be stated as "C plus the box's normal longest inter-commit gap plus 5 ms". The bigger finding is that **etcd drops writes caught in the transfer**: F-05's "clients retry by themselves" then pays the client's timeout. fero's handover must refuse such writes at once with a redirect (so the client retries in a round trip), never drop them silently; E-38 (a) found the same rule from the other side (etcd refuses proposals while a transfer is pending).
- **3 × commit p99 > 10 ms?** Reasoned: 8.2 to 13 ms. Measured on the real port: 5.0 ms at 2,000/s, 8.7 ms idle, **16.7 ms at 10,000/s**. So SC-08(b) as written (≤ 10 ms per move) holds for a three-commit move only on lightly loaded groups. One commit fits everywhere measured (p99 ≤ 4.7 ms), two fit up to 2,000/s. So before phase 1 the move should be cut to fewer commits (for example A's fence carries the hand-off and B opens on the `#meta` row it watches, so the client-visible window is one or two commits), or SC-08(b) is restated as a p50 bar (≤ 4 ms here) plus a p99 bar tied to load.
- **F-05 failover ≤ 2.5 s (TS) / 1.25 s (native) at p99**: with E = 1 s, 1.02-1.42 s client-visible (TS bar met; the native bar missed once, at 1.42 s); with E = 2 s, the draft's TS setting, 2.04-3.36 s, so the TS bar is missed whenever the timer lands in the upper part of [E, 2E). The bar holds if E ≤ 1.25 s with etcd's jitter, or E = 2 s with DESIGN-V5's smaller jitter (0.25 E, which E-38 (a) also recommends): E + 0.25E + a few ms = 2.5 s, just at the bar. A constant in the port, not a mechanism.
- **F-05 handover ≤ 10 ms**: the group's pause is 9.7-9.8 ms at the median (worst 24-31 ms), so it is met at the median on this disk and not at the tail; the writes caught in the transfer pay the client's timeout unless fero refuses them at once.

## What this box cannot show

- Real round trips between machines: here a hop is about 0.06 ms; across a datacenter it is 0.2-0.5 ms per hop, which adds about 1 ms to a three-commit move.
- Independent disks: all three members fsync on one disk, so each commit waits behind the others' fsyncs; E-02's emulated independent disks cut TS p99 by about half.
- The catch-up rate is this disk's (about 0.8-1 GB/s raw, E-01) shared by four members; NVMe would be faster, a network-attached volume slower.
- Only etcd's Go server was measured for (a)-(c); the TS port was measured only for the slot move.

## Verdict

Q-13: on this disk etcd pauses its group 9.7-9.8 ms at a handover (median of 15; worst 31 ms) but drops writes caught in the transfer, which then pay the client's timeout (100 ms or 2 s here); a failover takes the election timer plus about 5 ms (0.94-1.42 s at E = 1 s, 2.03-3.36 s at E = 2 s); a new member catches up at 5.2-6.9 s per GB; and a three-commit slot move on E-10's TS Raft is unwritable 2.7-4.1 ms at the median but 5.0 ms (2,000 writes/s), 8.7 ms (idle) and 16.7 ms (10,000 writes/s) at p99, while a one-commit move stays at or under 4.7 ms p99. Moves: every Raft row with slot moves (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, RLOG, SLOG, EMB-V8, SIDE) down a little on SC-08(b) until the move is cut to one or two client-visible commits or the bar is restated as p50 plus a load-tied p99 (DEV-09: decide before phase 1); every Raft row needs E ≤ 1.25 s or DESIGN-V5's 0.25 E jitter to meet F-05's 2.5 s failover (a constant), and a "refuse at once, never drop" rule for writes caught in a handover (F-05, DEP-01); RLOG's writer handover (one epoch commit plus a warm fold tail, about 2-5 ms, reasoned) stays within F-05; catch-up per GB does not separate the rows.
