# E-38: etcd's raft with PreVote, CheckQuorum and leader transfer under gray failures

**Question (Q-38).** Does Raft with PreVote, CheckQuorum and leader transfer stay live under partial partitions, one-way loss and a fail-slow leader?

This folder answers parts (a) and (b). Part (c), a real-TCP run of three etcd members with `iptables`, is not done here (it is light timing work, left to the timing queue).

## In short

- **No flapping, anywhere.** With PreVote and CheckQuorum on, every run had at most one election after its fault (counted from the fault to the end, 60 E): all 64 three-node directed-link topologies, 300 random five-node ones, the named cases (the Cloudflare 2020 shape, our reading of Jensen et al.'s three), one-way loss, and leader transfers. Measured here, in a deterministic simulation that runs etcd's raft code.
- **Stuck with a connected majority: 5 of 280 five-node runs**, never with three nodes. Raft's vote rule needs an up-to-date server among the well-connected ones; the old leader's last uncommitted entries can sit only on a poorly connected follower. Restating F-17 to "a connected majority that includes an up-to-date replica" fixes the wording; meeting F-17 as worded needs a new election rule (one mechanism).
- **Slower than 2E** (2.95 to 3.89 E) when the leader keeps only one-way links: CheckQuorum is the only way out, and etcd runs it once per election timeout. Running it every E/4 (with DESIGN-V5's smaller jitter) brings the named cases to 1.52 E: a constant in the port, not a mechanism.
- **Each half alone fails**: PreVote without CheckQuorum is stuck for good in 5 topologies (the Cloudflare shape); neither flaps in 21 of 74 runs; CheckQuorum alone is slow (up to 25.5 E).
- **Leader transfer** to a target the leader cannot reach pauses writes for one E; to a target that cannot reach a majority, one forced election (at most 1.94 E). Transfer only to a target that has just acknowledged the log end.
- **Fail-slow: F-18 fails.** Nothing in Raft gives up leadership because it is slow. A 10× slower leader keeps leading for ever at 200 writes/s; at 2,000/s it is deposed only when its heartbeats starve, 3.4 to 10.2 E later, with stalls of seconds. A slow-leader rule is needed (one mechanism; TiKV's PD evicts leaders from slow stores). Async leader writes (DESIGN-V5's "the leader writes its own journal in parallel") keep a slow leader disk to at most 1.9× p99; fsync-before-send makes it 16 to 26× at 200 writes/s.

## Words used here

- **E** is `election.ms`, the election timeout. Every time below is in units of E.
- **PreVote**: before a real election, a server asks "would you vote for me?" without raising its term, so a server that cannot win does not disturb the group. **CheckQuorum**: a leader that has not heard from a majority for a while steps down; and a follower that heard from a leader recently ignores vote requests (a "lease").
- **Leader transfer**: the leader brings a chosen voter up to date and tells it to stand at once (`TimeoutNow`).
- **Partial partition** (non-transitive): A and B talk, B and C talk, A and C do not. **One-way loss**: messages from A to B are lost, B to A get through.
- **Connected majority**: a server with working links both ways to a majority of the group (itself included). This is the least a Raft leader needs. (A stricter reading, a majority in which every pair talks both ways, is also recorded per run.)
- **Writable in 2E**: after the fault, the longest time with no committed write is at most 2E, and writes are still committing at the end. **Flaps**: more than one election in some window of 10E (counted from 2E after the fault, so the first failover is not counted).
- **Fail-slow**: a server that still works, only slower; here 10 times slower CPU per raft step, 10 times slower fsync, or both.

## Method

A deterministic simulation in Go ([harness/sim.go](harness/sim.go), [harness/main.go](harness/main.go)) that runs etcd's raft library itself: `go.etcd.io/raft/v3` at commit c51f010 (the same commit as E-14's TLA+ spec), as `RawNode`s. Nothing of raft is re-implemented.

- **Each node** has a single raft loop: every message, tick or proposal costs CPU time (20 µs a step); the loop steps everything queued, then handles one `Ready`, as etcd's node loop does. With **async writes** (etcd's `AsyncStorageWrites`, and fero's design: "the leader writes its own journal in parallel"), an append thread group-commits each batch with one fsync (2 ms) and only then sends the acknowledgements; the leader sends appends before its own fsync. With **sync writes** (etcd's classic loop), the raft loop fsyncs before it sends anything.
- **The network** is a set of directed links, each up or down, with FIFO delivery per link and 250 ± 100 µs latency.
- **Raft settings**: `ElectionTick` 10, `HeartbeatTick` 1 (one tick = E/10), `PreVote` and `CheckQuorum` on, `StepDownOnRemoval` on, E = 1,000 ms.
- **The client** writes 200 times a second (2,000 in the high-load fail-slow runs). It is an oracle: it sends each write to whichever node leads with the highest term, and resends after 1 s without a commit. So the numbers measure the group, not a client's routing.
- **A run**: start, let a leader settle, transfer leadership to node 1 at 8 s, apply the fault at 15 s, run to 75 s (60 E after the fault). Every case runs with 3 to 5 seeds.
- **Reproducible**: etcd's election jitter reads `crypto/rand`; [harness/patch-raft.sh](harness/patch-raft.sh) adds a seeded source (and two timer knobs, off by default), so a run replays from its seed. That is the only change to raft.

**The scenarios** (node 1 leads when the fault starts):
- **Named** ([main.go](harness/main.go), `named`): baseline; leader crash; the Cloudflare 2020 shape (one link down between the leader and a follower, both still reach the third: a chain); a link down between two followers; the leader isolated; one-way loss in each direction and both; and in five nodes, our reading of Jensen, Howard and Mortier's three cases (quorum loss: the leader keeps a two-way link to one follower only; constrained election: the leader dies while the up-to-date followers reach few others; a chain), and the Cloudflare shape in five nodes.
- **Sweeps**: every directed-link topology of three nodes (64: each of the 6 one-way links up or down), with and without a leader crash at the same moment, 3 seeds; 150 random directed-link topologies of five nodes per seed, 2 seeds, with and without a leader crash.
- **Ablation**: the 64 three-node topologies with PreVote and CheckQuorum each on and off.
- **Leader transfer** under a partial partition: one second after the fault, the leader is asked to transfer to node 2, which is cut from the leader, cut from the others, or reachable one way only.
- **Fail-slow**: from the fault on, node 1 (the leader) or node 2 (a follower) is 10 times slower in CPU, fsync or both, with async and sync writes, at 200 and 2,000 writes a second.
- **Timer variants** (named scenarios only): "fero timers" is the random part of the election timeout at 0.25 E (DESIGN-V5's `election.jitter`, against etcd's E) and CheckQuorum every E/2; a second variant runs CheckQuorum every E/4. These need a one-line change to raft each (the knobs in patch-raft.sh).

## Results

All runs: [results/summary.txt](results/summary.txt) (made by [summarize.py](summarize.py) from the raw `results/*.jsonl` (gzipped), one JSON line per run). Every claim below is **measured here** in the simulation, unless marked otherwise.

### (a) Partial partitions and one-way loss, PreVote and CheckQuorum on (etcd's own timers)

**Every directed-link topology of three nodes** (64; 37 of them leave a connected majority), 3 seeds each, without and with a leader crash at the same moment:

| | runs with a connected majority | writable in 2E | writable later | never writable | flapping |
|---|---|---|---|---|---|
| links fail, leader stays up | 111 | 96 | 15 | **0** | **0** |
| links fail and the leader crashes | 48 | 48 (at most 1.42 E) | 0 | **0** | **0** |
| no connected majority | 225 | 0 | 0 | 225 (as it must) | 0 |

- **Never stuck, never flapping**, while a connected majority exists. At most one election after a fault, in every run.
- **The 2E bar is missed in 5 of 37 topologies**: those where the leader is left with no follower it can both reach and hear, while one-way links to it remain and the two followers still talk both ways (links down: 2→1 and 3→1; 1→3 and 2→1; 1→2 and 3→1; and those plus one more). Writable again after 2.95 to 3.53 E. The leader cannot commit, but at least one follower still hears it and stays in its lease; only CheckQuorum ends it, and etcd checks once per election timeout, so the leader steps down 1 to 2 E after the fault, and a follower stands about 1 to 2 E after that.
- **The named cases**, 5 seeds each ([summary](results/summary.txt), first table): the Cloudflare 2020 shape (a leader–follower link down) and a follower–follower link down cause **no election at all** and no pause; the leader isolated, or unable to send, fails over in at most 1.41 E; one-way loss into the leader takes 3.21 to 3.44 E. In five nodes, our reading of Jensen et al.'s quorum-loss case fails over in 1.45 E, the constrained election in 1.33 E, and the chain causes no election.

**Timers.** The same named cases with DESIGN-V5's jitter (0.25 E, against etcd's E) and CheckQuorum every E/2: one-way loss into the leader drops to 2.11 to 2.13 E (still over 2E in 2 and 3 of 5 seeds). **With CheckQuorum every E/4: at most 1.52 E, all seeds within 2E**; a leader crash 1.12 E. That is a constant in the port (how often the leader counts its followers), not a new mechanism; its cost is that a leader whose followers all pause for more than E/4 (500 ms at the TS E of 2 s) steps down.

**Ablation: what PreVote and CheckQuorum each buy** (the 64 topologies, 2 seeds; 74 runs with a connected majority):

| PreVote | CheckQuorum | writable in 2E | writable later | never writable again | flapping | worst gap |
|---|---|---|---|---|---|---|
| off | off | 46 | 26 | 2 | **21** | 60 E (stuck) |
| off | on | 64 | 10 | 0 | 0 | 25.5 E |
| on | off | 64 | 0 | **10** | 0 | 60 E (stuck) |
| on | on | 64 | 10 | **0** | **0** | 3.43 E |

- Without either, a server cut off from the leader one way keeps starting elections and the leader keeps changing (up to 19 elections in a run): the flapping of Howard's 2020 analysis.
- **PreVote without CheckQuorum is stuck for good** in those same 5 topologies: the leader cannot commit but never learns it, the follower that still hears it never stands, and the cut-off follower's pre-votes are refused because its log is behind. No write commits for the rest of the run (60 E). This is the shape of the Cloudflare November 2020 outage, as Howard explains it [cited, from memory: H. Howard, "Raft does not guarantee liveness in the face of network faults", 2020; Cloudflare, "A Byzantine failure in the real world", 2020; neither fetched in this session].
- Both together remove the stuck and the flapping cases; the slow ones remain (above).

**Five nodes, random directed-link topologies** (150 per seed, each link down with a probability drawn between 0.1 and 0.5; 2 seeds; without and with a leader crash at the same moment):

| | runs with a connected majority | writable in 2E | writable later (3.0 to 3.9 E) | never writable again | flapping |
|---|---|---|---|---|---|
| links fail, leader stays up | 280 | 213 | 62 | **5** | 0 |
| links fail and the leader crashes | 240 | 240 (at most 1.87 E) | 0 | 0 | 0 |

**The 5 stuck runs** (from the topology, computed; the log part reasoned): in each, no election is ever won after the fault. The old leader keeps a one-way link to one or two followers, so its last entries (appended, never committed) reach only those. Then the only server with two-way links to a majority (the star centre) has a shorter log than one of the members it needs, and that member refuses its vote by Raft's up-to-date rule; the member with the longest log has two-way links to too few servers to win itself. Example (seed 1): links down 1→2, 1→4, 1→5, 2→1, 3→1, 4→2, 4→3, 4→5, 5→1, 5→3, 5→4. Two-way pairs: 2↔3 and 2↔5 only, so 2 is the centre and needs both 3 and 5; leader 1 still reaches 3 (1→3), so 3 holds entries 2 lacks and refuses; 3's only two-way link is to 2. No server can win, for good. This is Jensen et al.'s "constrained election" in a shape our named case did not hit. It needs many links down at once (6 to 11 of 20 directed links here), and it never happened when the leader also crashed, or in any three-node topology.

So **a connected majority is not enough for Raft**: it also needs a server with an up-to-date log among those with two-way links to a majority. No setting of PreVote, CheckQuorum or the timers changes that; it is Raft's vote rule.

### (a) Leader transfer under a partial partition

One second after the fault, the leader is asked to transfer to node 2 (5 seeds; 3 and 5 nodes):

| node 2 is | 3 nodes | 5 nodes |
|---|---|---|
| reachable both ways | transfer in milliseconds, no gap | the same |
| cut off from the leader | **writes pause 0.99 E**, then the transfer is abandoned and the old leader carries on | the same |
| reachable from the leader only one way | **writes pause 0.99 E**, the same | the same |
| cut off from the other followers | it wins with the old leader's vote; no gap | **one forced election it cannot win; writes pause up to 1.94 E**, then the old leader wins again |

- etcd's leader refuses proposals while a transfer is pending, and gives up after one election timeout. So a transfer to a member it cannot reach costs E of write pause. DESIGN-V5's handover (§4.2: bring the target to the log end, then TimeoutNow) should transfer only to a target that has just acknowledged the log end; then the first two rows cannot happen, and DEP-01's rolls keep their 10 ms pause.
- A forced campaign (TimeoutNow skips PreVote and the lease) by a target that cannot reach a majority costs one election (row 4). Within 2E, with no flapping.

### (b) A fail-slow node

One node 10 times slower from the fault on, 5 seeds each (all rows: [summary](results/summary.txt), last table):

| writes | load | slowed (on the leader) | leader changed | p99 commit before → after |
|---|---|---|---|---|
| async (the leader fsyncs in parallel, fero's design) | 200/s | CPU | **never** | 3.0 → 3.8 ms (3 nodes), 5.2 ms (5) |
| async | 200/s | fsync | **never** | 3.0 → 3.4 ms |
| async | 200/s | both | **never** | 3.0 → 6.2 ms (2.1×), 7.4 ms (5 nodes, 2.5×) |
| async | 2,000/s | fsync | **never** | 3.1 → 5.5 ms (1.8×) |
| async | 2,000/s | CPU, or both | yes, after **3.4 to 8.3 s** (3.4 to 8.3 E) | stalls of 2.3 to 4.2 E; p99 over a second |
| sync (fsync before send, etcd's classic loop) | 200/s | fsync | **never** | 5.0 → 82 ms (16×) |
| sync | 2,000/s | CPU | **never** (3 nodes); after 7.2 to 10.2 s (5 nodes) | 12.8 → 599 ms (47×) |

- **Raft as published never gives up leadership because it is slow.** A slow leader keeps leading as long as it sends heartbeats in time. At 200 writes a second that is for ever. At 2,000 a second, a leader whose CPU is 10 times slower falls behind, its heartbeats starve, and its followers elect another, but only after 3.4 to 10.2 E, with commits stalled for seconds on the way.
- **A slow follower costs almost nothing** (at most 1.7×), as expected.
- **Async writes contain a slow disk on the leader**: with the leader fsyncing in parallel, two fast followers form the commit majority, and p99 stays within 1.1 to 1.9×. With fsync before send, the same disk makes p99 16 to 26 times worse at 200 writes/s (8 times at 2,000/s, where batches are larger).

## Against the threshold

- **F-17 (partial partitions, one-way loss).** No flapping run anywhere: at most one election after a fault, in every run of every suite. No stuck run in all 64 three-node topologies, all named cases, the leader-transfer cases, and every five-node run where the leader also crashed. **But 5 of 280 five-node runs with a connected majority were stuck for good** (above): Raft's vote rule needs an up-to-date server among the well-connected ones. By the threshold this names the extra mechanism needed to meet F-17 as worded: either a voter that refuses a vote only because its own log is longer hands the candidate its tail (a rule that changes Raft's election, novel as far as we know; one mechanism in DEV-01), or F-17 is restated to what Raft gives: "every group with a connected majority **that includes a replica holding every entry any reachable replica holds**" (no mechanism). We recommend the restatement: the shape needs 6 or more of 20 directed links down at once in five nodes and never arose with three nodes. **The 2E bar fails** where the leader keeps only one-way links: 2.95 to 3.89 E with etcd's timers (three and five nodes). It holds (1.52 E at worst, named cases) with CheckQuorum every E/4 and DESIGN-V5's jitter, a constant in the port. A transfer to a target the leader cannot reach pauses writes for E.
- **F-18 (fail-slow).** **Fails**: a leader 10 times slower is never replaced at moderate load, and at high load only after 3.4 to 10.2 E (past the 5E bar in 19 of the 30 runs where it was replaced), with multi-second stalls. Nothing in Raft or etcd's raft watches for slowness. This **names the extra mechanism**: a slow-leader rule, for example "a leader whose own step or fsync latency stays above k times its followers' for a window hands leadership to its most caught-up follower", or, for MIN's controller loop, "evict leaders from a member whose latency score is k times its peers'". TiKV has the second: PD's evict-slow-store scheduler fed by each store's slow score [cited, from memory: TiKV/PD documentation on slow-store detection; not fetched in this session]. It is one mechanism with its own state (a latency score per member) and rules (when to move leadership, when to stop), and it interacts with healing and leader spreading (DEV-02). It is priced in DEV-01 now: novel or not under DEV-10(b) depends on whether the counters accept PD's scheduler as the same state and rules in the same role.
- **The p99 clause of F-18** (outside the window, p99 commit at most 2 × steady) holds with async writes for a slow disk (1.1 to 1.9×) and fails for a slow CPU at high load or a slow disk with sync writes.

## What the model leaves out

- **Real networks and disks.** Links are up or down, with a fixed small latency; there is no TCP connection setup, no retransmit timer, no bandwidth limit, no fsync variance. A real one-way loss on TCP usually breaks the connection both ways after a while.
- **Time is ticks.** Raft's clocks advance in ticks of E/10, so times are accurate to about 0.1 E.
- **One group,** no snapshots, no membership changes, no read index, no quiet groups (DESIGN-V5's quiescing), no link pings shared across groups: CheckQuorum here is raft's own, per group.
- **A slow node is slow uniformly.** Real fail-slow faults are often intermittent (a disk that stalls for seconds), or hit one resource only.
- **The client is an oracle,** so client-side detection of a new leader costs nothing here.
- **E = 1 s.** Results in units of E carry over to other values while E is large against a round trip and an fsync; at the TS default of E = 2 s they do.
- **This box.** The simulation is deterministic and does not depend on the box's speed: all times are simulated.

## How to rerun

```sh
./fetch.sh            # Go 1.26.10 and etcd's raft at c51f010, through proxy.golang.org (checked by go.sum)
./run.sh              # all suites, about 1 CPU-hour single-threaded, each suite under the heavy lock
./run.sh named slow   # some suites
python3 summarize.py results > results/summary.txt
```

Machine: 4 vCPU, 15 GB, Linux 6.18; Go 1.26.10; raft `go.etcd.io/raft/v3 v3.7.0-rc.0.0.20261023205317-c51f010c851e`. The results do not depend on the machine: every time is simulated, and a run replays from its seed. The named, transfer and slow suites ran with the final harness; the 3-node and 5-node sweeps and the ablation too (an earlier client that polled every 5 ms per write while no leader existed was replaced before them; it changed run time, not behavior).

Q-38: No: etcd's Raft with PreVote, CheckQuorum and transfer never flapped, but stayed stuck with a connected majority in 5 of 280 five-node partial partitions (Raft's vote rule), took 3 to 3.9 E (not 2E) when the leader kept only one-way links (CheckQuorum every E/4 fixes it, a constant), and never gave up leadership for slowness (F-18 fails). Moves: every Raft row (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE, PD) down on F-18 and DEV-01 (+1 mechanism: a slow-leader rule) and down on F-17 unless F-17 is restated to "a connected majority that includes an up-to-date replica"; rows with async leader writes up on F-18's p99 clause.

