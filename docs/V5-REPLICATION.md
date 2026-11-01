# v5 replication: a second opinion

An independent review of decision 2 in [DESIGN-V5.md](DESIGN-V5.md) (how L1 replicates and places shards), written on 2026-11-01 by a reviewer not shown the author's or my leaning. It compares the Kafka shape (a), Raft per shard (b), ring-computed views with Viewstamped Replication (c), and a virtual shared log (d), and recommends (b). Saved as written.


Sources: DESIGN-V5 §2–13 as asked, N-01..N-25, the four catalogue files, v4's records and `ring.ts`, the deploy and test docs.

## 0. The short answer

Choose **(b), multi-Raft**, with the metadata group running the *same* Raft code, node-level sessions as the failure detector, and the controller as a *placement policy*, never a safety component. Not (a): Kafka's ISR protocol is published by accretion (KIP-101, 279, 320, 841, 903, 966 over seven years), its safety rests on the controller∘ISR∘epoch composition the design itself calls "where most of v5's own hard cases live", and it pays p99 commit at the *slowest* replica. Not (c): a ring-computed leader is what v4 was; it still needs per-shard acknowledged epochs, and once you have those you have Raft/VR per shard, so the ring buys only the leader *choice*, and the worse one. A shared-log design (d) is the right *hosted* evolution later, not an L1 for an embedded library whose members must fold every row anyway. Ring-placed chains (FAWN-KV, CRAQ) are the published form of the author's intuition: fail-stop, so a GC pause stalls the chain, and FAWN-KV's join is v4's handover.

## 1. Comparison

| | (a) KRaft shape | (b) multi-Raft | (c) ring views + VR | (d) virtual log (Delos/BookKeeper) |
|---|---|---|---|---|
| Safety argument | Published by practice: Raft + ISR/leader-epoch/ELR; no single spec; 7 KIPs of patches | Published, one algorithm (Ongaro 2014; etcd/raft), used twice | Novel composition: externally driven VR reconfiguration; nearest paper is Vertical Paxos (Lamport/Malkhi/Zhou 2009) | Published (Delos OSDI'20: seal + metastore CAS; BookKeeper fencing) |
| Formal model | raft.tla for the controller; Vanlightly's TLA+ of ISR/KRaft, partial; fero must model the composition | raft.tla + etcd's; fero models only leases, config pacing, snapshots | None; written from scratch | Loglet contract modelled in Delos; internals vary |
| Availability 1/2/3/5 | 1 ok. 2+W: either crash survives (ISR→1, durability price). 3: 2 crashes at minISR 1. 5: 4 | 1 ok. 2: one direction (voter+learner) or read-only; +W needs a per-shard witness (TiKV-style). 3: 1 crash. 5: 2 | As (b); design says "three copies" | As (a): write quorum per loglet is free; 2+W survives either crash |
| Failover | session.ms + controller ≈ 2.2 s; **blocked during a controller election** (up to 2×) | Controller nominates (`TimeoutNow`) ≈ session.ms + 1 RTT; followers' timers are the fallback | session.ms + Raft list change + a view change on *every* moved shard at once | session.ms + seal (1 RTT) + CAS (1 Raft commit) |
| Commit latency / throughput | max over ISR fsyncs (+ pull long-poll); matches Kafka | median of R fsyncs; push, pipelined, coalesced per link; Redpanda-class | majority, as (b) | quorum write; extra hop if sequencer ≠ storage |
| Roll / restart-all / scale | controlled shutdown; ISR; catch-up pin; paced | leadership transfer; restart = transfer only; learner → joint swap (etcd 3.4); paced | no pacing: a list change moves every affected shard now; drain/orphan logic returns | scale-out moves no log; members still copy state to serve |
| Metadata / idle, n≈100, 10k shards | 1 shard record each; sessions + 1 fetch long-poll per partner pair (~3.5k frames/s) | catalog caches shard→leader; idle groups **quiesce** (CockroachDB), so idle ≈ sessions | smallest metadata; per-shard primary heartbeats unless coalesced | one chain entry per reconfig; coalesced |
| Hot spots | controller moves leader | leadership transfer per shard | none: leader = ring | move the sequencer = cheap reconfig |
| Client routing | cache + `not-leader` hint | same | computable, but needs the list epoch *and* hints during view changes | cache |
| Size / novel parts | Raft 2.5k + ISR 2k + controller rules 1.5k; novel: session epochs, minISR cap, pin | Raft 2.5k shared + multi-raft plumbing 0.8k + placement 0.8k; **0 novel safety mechanisms** | Raft 2.5k + VR-ext 2k + ring 0.3k; novel: multi-replica ring moves, overlapping views, pacing | Raft 1.5k + loglet/seal 1k + state placement (novel for fero) |
| Fit deploy / test / dev | good / good / good | good / good / good | no 2-copy mode; dev fine | best for hosted v2 |

## 2. Failure sequences

**(a)** A1 *fenced replica rejoins ISR* (KIP-841): a leader's AlterPartition re-adds a replica whose session lapsed; the session epoch in the proposal must be modelled. A2 *unclean restart joins ISR before re-fetch* (KIP-903): closed by life/session epoch. A3 *controller failover while a shard leader is dead*: nothing fails over until sessions re-arm (design: up to 2×session.ms); under (b) followers elect without the controller. A4 *lag.ms stall*: one replica's 300 ms GC pause stalls commits on every shard it follows until the controller shrinks the ISR; with `replicas:'all'` at 5 copies p99 = max of 5 Node processes. A5 *HW regression* (KIP-279 class): closed by epoch-chained fetch and N-03. A6 *ISR={leader}, leader dies*: unavailable until it returns (correct).

**(b)** B1 *election storm*: a member leading 3k shards dies → 3k campaigns; closed by controller nomination + randomized timers + vote batching per link (CockroachDB/TiKV practice); needs a pin. B2 *the swap*: remove-then-add leaves a 2-voter group; use joint consensus. B3 *single-server change bug* (Ongaro 2015): the new leader commits a no-op first, per shard too. B4 *reborn empty-disk voter double-votes*: voter id = (member, disk incarnation); the controller re-adds it per shard. B5 *stale fresh read by a deposed leader*: read-index or an epoch lease on the session. B6 *learner never catches up*: the same bounded pin as (a).

**(c)** C1 *one list change moves several replicas of a shard*: at n=3→4, R=3, every shard's set changes; a shard losing 2 of 3 replicas needs its new leader to read from 2 of the old 3, and the departing replicas must keep serving that quorum until the new majority is durable. That is per-shard drain/orphan/shed state (D-018, C-021..C-030, C-086 return) plus thousands of simultaneous unpaced snapshot copies. C2 *list change mid view change*: a shard still completing epoch e when e+1 lands must chain quorums over three configurations or serialise; VRR §7 assumes one reconfiguration at a time committed *by the group*; Vertical Paxos needs each ballot's read phase to finish before the next activates. D-158/D-222 return in shard form. C3 *slow-but-alive leader*: the ring keeps choosing it; the remedies are eviction from the list (moves 1/n of all replicas cluster-wide) or a per-shard view counter, which is a per-shard election, i.e. (b). C4 *lagging new leader*: the ring may pick a replica that just joined; it must install a snapshot from the old majority before serving: v4's teacher/latch pause (C-034, C-061). Raft's election restriction and leadership transfer pick the most complete replica. C5 *restart-all*: no list change, but each replica must hold a durable per-shard epoch or an old leader's late frames are accepted (C-002, C-120, D-198: the zombie). C6 *single copy*: trivial; growing 1→3 view-changes every shard at once from {A}, unpaced.

**(d)** D1 two recoverers seal and CAS: serialised by the metastore. D2 checkTail after seal with holes: Delos's hole-filling is the subtle part; BookKeeper's LAC + fencing is simpler. D3 rows live on members, so a new member folds the shard anyway; "scale-out moves no data" is true of the log, not the state.

## 3. The author's intuition, answered

"Nodes could use the ring to coordinate where writes go without talking; only the ring need be in lockstep." Three things must be in lockstep beyond the ring, and the ring supplies none of them:

1. **A per-shard, majority-acknowledged, durable epoch.** Nodes install a new list at different moments, so for a while the old leader (list epoch e) and the new one (e+1) are both "right". The ring is *computed*, never *acknowledged*; the old leader's writes are refused only if a majority of the shard's replicas have durably recorded a higher epoch and reject lower ones. That record is Raft's term / VR's view number. v4's zombie lane (C-120) and late frames (C-002, D-198) are this gap.
2. **The log tail at each epoch switch.** The new leader must read from a majority of the *old* replicas before serving, and they must keep serving until the new majority is durable. That is a per-shard view-change state machine; v4's orphans, sheds, latches, teachers and floors were exactly this, and produced most of its bugs.
3. **Pacing and choice.** Placement coupled to the list means every list change moves every affected shard *now*, led by whoever the hash says, slow or lagging. Raft per shard decouples them: placement is a policy the controller paces; the shard's own log is the truth about its members and leader.

So the ring is a fine *placement policy* (v4's `ring.ts` can stay as the controller's default `desiredReplicas()`), not a coordination mechanism. Raft is "simpler overall" because the three items above *are* Raft, specified once, with a checker. v1 and v4 are the two data points.

## 4. Recommendation

**(b)**, on these conditions: one Raft implementation for the metadata group and every shard; node sessions as the failure detector; idle groups quiesce and per-link Raft traffic coalesces into one frame per node pair per tick; the controller nominates successors on session lapse and paces moves; shard safety never depends on the controller.

I would choose differently if fero deploy committed to 2-copy tiers (then (a)'s metadata witness + ISR→1 beats a per-shard witness); if surviving two crashes of three mattered more than p99 commit (then (a)); or if storage were disaggregated from app servers (then (d), the metadata Raft already in place). I would not choose (c) under any condition I can name.

**§4.2 under (b), in outline.**
- *One Raft core* (`kernel/raft.ts`): Ongaro's algorithm plus the practice fixes already listed for the metadata log; TLA+ = raft.tla with fero's additions (leases, config pacing, snapshot-at-offset). Two uses: the metadata group (3 or 5 voters, a witness allowed) and one group per shard (voters = its replicas; `replicas:'all'` = every member a voter; at 2 members, voter + learner, today's asymmetry).
- *Placement is policy.* The controller computes desired replica sets (any deterministic function; the ring is fine) and drives them by proposing config changes to each shard's leader; a shard's committed configuration is the truth; the catalog caches shard→leader for routing and `caughtUp`.
- *Liveness.* Sessions as designed. On a lapse the controller sends `TimeoutNow` to its chosen follower per led shard; followers' randomized timers (2-3× session.ms) are the fallback. Heartbeats quiesce when a shard is idle and coalesce per node pair otherwise. `fresh` reads use read-index or an epoch lease from the session.
- *Commit* = majority durable (fsync before ack; L0 group commit covers all shards). Commit index plays the high-water mark; followers serve subscribers up to it; N-03 unchanged. A new leader commits a no-op in its term before judging anything.
- *Moves*: add learner → snapshot + log catch-up (bounded pin, `move.throttle`) → one joint-consensus entry swaps learner for old voter → old replica removed. `leave` = transfer leaderships, then config-change out of each shard and the metadata group; `restart` = transfer only.
- *Fencing*: every append, fetch and forwarded write carries the shard's term (`stale-term`); session epochs still fence forwards.
- *Recovery*: `fero recover --unclean <shard>` forces a single-voter configuration on the most complete replica and bumps the incarnation (etcd's force-new-cluster, per shard).

## 5. Backtest deltas versus (a)

**Easier under (b).** N-01 (no controller role in shard safety); N-02 (majority + CheckQuorum, no minISR special case); N-04 (Raft's Log Matching and election restriction replace KIP-101/279/320/903); N-22 (controller off the per-shard critical path); N-24 (by role). v4 rows: C-002, C-120, D-198, C-249 (zombie/stale frames: term fencing, one proof); D-006, D-157/S-003, D-219..D-226, D-253..D-268, D-327..D-331, S-038, S-039 (the V4-55 hold/release family: gone under both, under (b) by one published rule); C-034/C-061/D-245 (latching teachers: election restriction); S-048/S-049/D-370 (one-by-one stops then restart-all: each shard recovers by its own log, no catalog decision).

**Harder under (b).** N-19 (a config change per shard instead of one metadata rule); the witness rows (D-075, D-195, STATUS "witness member", decision 12.8): either-crash survival at two copies needs a per-shard witness; defer with the witness (deploy refuses two copies); C-031/C-044/C-129 (idle traffic): equal only with quiescence; one new case, B1 (election storm), needs a pin.

**Unchanged.** N-03, N-05..N-18, N-20, N-21, N-23, N-25; the handover family C-021..C-030 (gone in both); the dedup rows C-003, C-082, C-247, C-248 (L2).
