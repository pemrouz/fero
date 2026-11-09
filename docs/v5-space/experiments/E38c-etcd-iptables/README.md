# E-38(c): three real etcd members with links cut by iptables

## The question

Q-38 ([QUESTIONS.md](../../QUESTIONS.md) §8): does Raft with PreVote, CheckQuorum and leader transfer stay live under partial partitions, one-way loss and a fail-slow leader? Parts (a) and (b), a deterministic simulation of etcd's raft code, are in [E38-raft-gray-failures](../E38-raft-gray-failures/README.md). This folder is part (c): **one real-TCP run of three etcd 3.5.17 members with packets dropped by `iptables`**, to check the simulation against real sockets, real timers and real disks. It gives the time to a writable leader, the leader changes, and commit p99 outside the fault window.

Words: **E** is the election timeout (here 1,000 ms). **PreVote**: a member asks "would you vote for me?" before it raises its term. **CheckQuorum**: a leader that has not heard from a majority for E steps down. A **partial partition** cuts some links but not all. **One-way loss** drops packets in one direction only.

Thresholds (QUESTIONS.md, from F-17 and F-18): every group with a connected majority is writable within 2E, with at most one leader change per 10E; a slow leader that holds on past 5E names a mechanism to price.

## Method

[gray.py](gray.py). Each member runs in its own network namespace (`e38m1` to `e38m3`, addresses 10.38.0.1-3 on a Linux bridge; the load client sits on the bridge at 10.38.0.254). A fault is a set of `iptables -A INPUT -s <sender> -j DROP` rules in the receiving member's namespace, so "m2 drops what m1 sends" is a rule in m2 only: real one-way packet loss under TCP. The client's own traffic is never cut.

Every run: a fresh cluster (heartbeat 100 ms, E = 1,000 ms, `--pre-vote=true`; etcd's server always runs CheckQuorum), leadership moved to m1, then a steady load from E-13's Go client ([../E13-handover/load](../E13-handover/load/main.go)): 1,000 logical puts a second of 256 B over 16 writers, each write retried until acknowledged, with a 1 s per-attempt timeout. **Each writer is pinned to one member** (`-pin`), so a member cut from the leader stalls only its own writers, and the group's writability is the gap between acknowledgements over all writers. The fault starts at 6 s, is healed at 26 s (20E later), and the run ends at 30 s. Elections are read from the members' own logs ("became leader at term", with their timestamps).

Scenarios (m1 leads when the fault starts):

| scenario | links cut |
|---|---|
| none | baseline |
| cloudflare | m1-m2 both ways; both still reach m3 (the Cloudflare 2020 shape) |
| follower-link | m2-m3 both ways |
| leader-isolated | m1 cut from both, both ways |
| leader-cannot-send | m2 and m3 drop what m1 sends |
| leader-cannot-hear | m1 drops what m2 and m3 send (one-way loss into the leader) |
| oneway-to-follower | m2 drops what m1 sends |
| slow-cpu | no link cut: m1's CPU capped at 10% of one core (cgroup v1 `cpu.cfs_quota_us` 10 ms per 100 ms), a fail-slow leader for F-18 |

**Timing rules.** The whole block ran once under `$SP/bin/timing` (3 runs of each scenario, interleaved), load average recorded per run (0.8 to 3.4). Medians and ranges below.

**Files.** [run.sh](run.sh), [fetch.sh](fetch.sh). Raw: [results/runs.jsonl](results/runs.jsonl). Table: [results/tables.md](results/tables.md). Two smoke runs (not measurements): `results/smoke.jsonl`.

## Results

All measured here.

| scenario | elections in the fault (per run) | elected at (members' logs), E | longest gap between acks, all writers, E | flapping | p99 before, ms | p99 from 2E after the fault, ms | longest stall of the writers pinned to m1, m2, m3, s |
|---|---|---|---|---|---|---|---|
| none | 0, 0, 0 | - | 0.024 | no | 2.6 | 3.5 | 0, 0, 0 |
| cloudflare | 0, 0, 0 | - | 0.024 | no | 2.0 | 2.9 | 0, **20** (the whole fault), 0 |
| follower-link | 0, 0, 0 | - | 0.022 | no | 3.1 | 3.6 | 0, 0, 0 |
| leader-isolated | 1, 1, 1 | **1.16, 1.52, 1.31** | 2.000 (1.999-2.001) | no | 2.8 | 2.4 | 20, 2.0, 2.0 |
| leader-cannot-send | 1, 1, 1 | **1.65, 1.62, 1.16** | 2.002 | no | 2.7 | 2.4 | 20, 2.0, 2.0 |
| leader-cannot-hear | 1, 1, 1 | **1.36, 2.06, 1.32** | 2.005 (2.004-3.003) | no | 4.7 | 2.5 | 20, 2.0 (2.0-3.0), 2.0 |
| oneway-to-follower | 0, 0, 0 | - | 0.023 | no | 3.5 | 2.4 | 0, **20**, 0 |
| slow-cpu | 0, 0, 0 | - | 0.195 (0.182-0.198) | no | 3.1 | **100.2** (99.4-100.6); max 186-200 | 0.2, 0.2, 0.2 |

- **No flapping, ever**: at most one election per fault, none after the heal, in 24 runs.
- **Faults that leave the leader with a connected majority cause no election and no group pause** (cloudflare, follower-link, oneway-to-follower: longest gap 22-25 ms, as in the baseline). But **the cut-off member's own writers stall for the whole fault** (20 s): that member cannot reach the leader, and etcd's server waits for its forwarded writes until the client's timeout, then the retry goes to the same member. A client must be routed away from a member that cannot reach its leader (a fast refusal with a redirect, or a smart client), or the group is writable while some clients are not.
- **When the leader loses its majority, one election follows at 1.16 to 1.65 E** (isolated, cannot send), and at 1.32 to 2.06 E when the leader only loses what it hears. The client-visible gap is 2.0 E (3.0 E once), because writes already forwarded to the old leader are lost and wait out the 1 s attempt timeout, twice: the same "dropped, not refused" behaviour E-13 saw at handover.
- **The simulation's slow case did not appear on real TCP.** E-38 (a) measured one-way loss into the leader at 3.21 to 3.44 E: the leader cannot hear, but its heartbeats still reach the followers and keep them in their lease. On TCP, a stream whose ACKs are dropped stops sending new data once its window fills (under this load, within milliseconds), so the followers stop hearing the leader too and elect at once. The message-level model is pessimistic for busy links; an idle link (heartbeats only) could keep the slow case alive for longer (reasoned, not run).
- **The fail-slow leader never gave up leadership** (20E at 10% of a core): no election, while p99 commit went from 3.1 ms to 100 ms (32 ×) and the worst commit to 200 ms, the CFS period. This agrees with E-38 (b): nothing in Raft or etcd deposes a slow leader that still sends heartbeats.

## Against the threshold

- **F-17 (partial partitions, one-way loss):** holds at the group level on real TCP for every three-node case run here: no flapping, at most one election, and a new leader at 1.16-2.06 E (writable within 2E in 8 of 9 elections by the logs; the client saw 2E because of its retry timeout). The `writable within 2E` column of [results/tables.md](results/tables.md) counts the client-visible gap and so marks these runs as just over 2E; the elections themselves are within it but one. It fails at the client level for the cut-off member's own clients (stalled 20 s) unless the edge refuses fast and redirects.
- **F-18 (fail-slow):** fails, as in E-38 (b): a leader slowed to 10% of a core stays leader for the whole 20E window and p99 rises 32 ×. The slow-leader rule that E-38 prices (one mechanism in DEV-01) is confirmed on the real system.

## What this box cannot show

- Real networks: all three members and the client share one VM; there is no latency, only loss. `tc netem` does not exist in this kernel (TOOLS.md).
- Five members, and the five-node stuck shapes of E-38 (a), were not run on real TCP.
- One disk for all three members; a fail-slow disk (`io.max` or dm-delay) was not run, only a CPU cap.
- Idle links: the load kept every link busy, which is what turned one-way loss into two-way loss quickly.

## Verdict

Q-38: on real TCP with iptables, etcd 3.5.17 with PreVote and CheckQuorum never flapped (24 runs), made no election when the leader kept a majority, and elected a new leader 1.16-2.06 E after it lost one (one-way loss into the leader included: 1.32-2.06 E, faster than the simulation's 3.2-3.4 E, since TCP turns busy one-way loss into two-way loss), but a member cut from the leader stalled its own clients for the whole fault, dropped writes cost clients a timeout, and a leader capped at 10% CPU kept leadership for 20E with p99 32 × worse. Moves: every Raft row (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE, PD) up a little on F-17 at the group level (real TCP is kinder than the model), down on F-18 (the slow-leader rule is confirmed as needed, +1 mechanism in DEV-01), and each needs the edge rule "refuse at once with a redirect, never drop or hold a write the member cannot forward" (F-05, F-17 client level: a rule, not a mechanism); rows whose clients are smart (SRV, PD, ISR) meet the client-level clause by routing.
