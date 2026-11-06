# E-46: the TypeScript port of etcd raft as a real key-value store, checked by Maelstrom

**Question (Q-46).** Does the TypeScript port of etcd raft (E-10), run as real processes, give a linearizable key-value store under partitions?

**Decides** (QUESTIONS.md §10): trust in every `port` row (MIN, MIN-TS, MIN-P, LEAN, RLOG, DRAFT, CELL, LANE, SPLIT): DEV-04, DEV-05, TEST-10, TEST-13. E-10 checked the port's Raft steps byte for byte in one process. Nothing had yet checked it end to end, with a log, a state machine, reads, and real message passing between processes.

**Threshold** (QUESTIONS.md): every clean run valid, and the planted bug caught → the port carries a real store. A real anomaly → a bug in the port or its host, root-caused before any `port` row is rated.

RESULTS_FIRST

## Words used here

- **Maelstrom** is Jepsen's workbench for small distributed systems. It starts each node as a real OS process, talks to it by JSON lines on stdin and stdout, routes every message between nodes through its own simulated network (which can delay, reorder and cut links), and runs clients against the nodes. At the end it checks the clients' history.
- **lin-kv** is Maelstrom's workload for a linearizable key-value store: clients `read`, `write` and `cas` (compare-and-set) small integer keys. Each key's history is checked on its own by **Knossos**, Jepsen's linearizability checker.
- **Linearizable** means every operation seems to take effect at one instant between its call and its reply, in an order every client agrees on. A read never returns an older value than one that some finished operation already showed.
- **ok / fail / info.** `ok` means the operation surely happened. `fail` means it surely did not (a definite error, such as "no leader" or "cas: value did not match"). `info` means the client does not know (a timeout); the checker must allow both outcomes.
- **ReadIndex** is etcd raft's way to serve a read without writing to the log: the leader notes its commit index, confirms by one round of heartbeats that a majority still follows it, and the node answers once it has applied up to that index. A **log read** instead puts the read into the log as an entry and answers when the entry is applied.
- **Partition**: Maelstrom's nemesis (fault injector) cuts links between nodes: one node off, a clean majority and minority, or a ring of overlapping majorities. **Pause**: the node's process is stopped with SIGSTOP and continued with SIGCONT, as a long GC pause or a stalled VM would.
- **Election** here means a term in which some node became leader (counted from the nodes' logs).
- **Snapshot** (MsgSnap): when the leader has dropped the log entries a lagging follower needs, it sends the whole state machine instead.

## Method

### The node ([node/node.ts](node/node.ts), 269 code lines)

One process is one raft replica. It imports E-10's port unchanged (`../../E10-raft-port/port/src/index.ts`; the hashes of the port files used are in [results/port-sha256.txt](results/port-sha256.txt)) and drives a `RawNode` exactly as [USAGE.md](../E10-raft-port/port/USAGE.md) says: tick, step, and for each Ready persist, send, apply, advance.

- **Raft settings:** etcd's `MemoryStorage` (the log in memory), a tick every 50 ms, `ElectionTick` 10 (so 0.5 to 1 s with etcd's jitter), `HeartbeatTick` 1, PreVote and CheckQuorum on, `ReadOnlySafe` (no leases), synchronous storage (not `AsyncStorageWrites`). The election jitter comes from a seeded generator (`E46_SEED` plus the node's index).
- **The wire:** each raft message is one Maelstrom message, its fields copied as they are (absent fields stay absent), bytes in base64.
- **The state machine:** a map from key to value. A `write` or `cas` becomes a log entry `{id, op, key, ...}` proposed through the node that got the request (a follower's proposal is forwarded by raft to the leader). Every node applies every entry; the node that got the request answers when it applies the entry with that id. `cas` on a missing key answers error 20, on a different value error 22; both are definite, and decided in the log order.
- **Reads, four modes** (`E46_READ`):
  - `readindex`: `RawNode.ReadIndex(ctx)` with a unique context; the answer comes when the ReadState for that context arrives and the node has applied up to its index.
  - `log`: the read is proposed as a log entry and answered when applied.
  - `mixed`: each read picks one of the two at random (seeded).
  - `buggy`, **the planted bug**: a follower answers at once from its own state, with no ReadIndex. The leader still uses ReadIndex.
- **Refusals:** a proposal that raft drops (`ErrProposalDropped`: no leader known, so it was neither appended nor forwarded) and a ReadIndex while no leader is known answer error 11, which is definite. Nothing else answers with an error: a lost request times out on the client side and is recorded as `info` (indefinite) for writes and cas.
- **Compaction** (`E46_COMPACT=20`, batch C only): every 20 applied entries the node snapshots the state machine with `CreateSnapshot` and compacts the log to 5 entries behind, so a lagging follower must be caught up by MsgSnap. Maelstrom's network gives no delivery report, so the leader reports each snapshot as finished when it sends it; a lost one is resent after the follower rejects the next append.
- **An extra check besides Knossos:** every node logs a running hash (FNV-1a) of the entries it has applied, every 50 indexes (and at each snapshot it restores). After the run, [summarize.py](summarize.py) checks that every node has the same hash at every index logged by two or more nodes.

### Pauses ([node/pauser.ts](node/pauser.ts))

**Maelstrom 0.2.4 does not offer pauses.** It accepts `--nemesis pause` and does nothing with it: Jepsen's `db-generators` (`jepsen/nemesis/combined.clj`, lines 108-109 in the jar) emits pause operations only when the database implements `jepsen.db/Pause`, and Maelstrom's database (`maelstrom/db.clj`) implements neither `Pause` nor `Kill`. (Read from the jar's own source; a first trial run's history had no pause operation.) So an outside script pauses real processes: each node writes its pid at init; from then on, after a random gap (exponential, mean 4 s), the pauser stops one node with SIGSTOP for 0.2 to 3 s (uniform), then continues it. Half the pauses hit the node whose role file says it leads (as Jepsen's "primaries" target), the rest a random node. A paused node reads nothing; Maelstrom queues its messages and delivers them late. Pauses stop 5 s before the end of the test. Every pause is logged with its time ([results/](results) has one log per run).

Kills (crash and restart) are not run: the log is in memory, so a restarted node would have forgotten its vote and log, which Raft does not allow. E-10's restart fuzz covers restarts from a kept log and HardState.

### The runs ([matrix.txt](matrix.txt), [run-one.sh](run-one.sh), [run.sh](run.sh))

Every run: Maelstrom `test -w lin-kv`, `--rate 50` (operations a second, all clients together), `--concurrency 4n` (4 client threads per node), node-to-node latency exponential with a mean of 5 ms (so messages on one link reorder; Maelstrom keeps client-to-node latency at zero), `--nemesis partition --nemesis-interval 3` (a partition starts or heals about every 3 s), plus the pauser. Clean runs last 100 s.

| Batch | What | Runs |
|---|---|---|
| A | 3 nodes; reads `readindex`, `log`, `mixed`; seeds 1, 2, 3 | 9 |
| B | 5 nodes; the same | 9 |
| C | compaction every 20 entries (snapshots); `mixed`; 3 and 5 nodes; seeds 1, 2 | 4 |
| D | the planted bug (`buggy`); 3 and 5 nodes; seeds 1, 2, 3, with partitions and pauses; and one 60 s run each with no faults at all | 8 |

Maelstrom has no seed option, so its own choices (which partition, which client operation, each latency) differ from run to run and cannot be replayed. The seeds fix only the election jitter, the read-mode choice and the pauser. Each batch held the shared heavy lock once, for about 20 to 30 minutes.

RESULTS_TABLE

## What this box cannot show

- **Disk and crashes.** The log is in memory and no node crashes; Maelstrom 0.2.4 cannot kill or restart a node. So this says nothing about fsync order, torn writes, or a restart from a kept log. E-10's restart fuzz (1,000 scripts with crash-restarts, byte for byte against Go) is the evidence there; E-29 owns storage faults.
- **Real networks and clocks.** Maelstrom's network lives inside one JVM on one 4-vCPU box: no real TCP, no packet loss other than whole-link cuts, no one-way links, no clock skew. Lease-based reads (`ReadOnlyLeaseBased`), which depend on clocks, were not tested; every ReadIndex here is the safe kind. E-38 covers one-way and partial links in simulation.
- **Membership changes, leader transfer, async storage writes, many groups per process.** None are exercised: the voters are fixed, one group per process, synchronous storage. E-10's datadriven files and fuzz cover these inside one process; an end-to-end check of membership changes would need Maelstrom nodes that join and leave, which lin-kv does not do.
- **Speed.** Nothing here is a timing; the box was shared with other agents' heavy jobs during the runs. Latencies in Maelstrom's output are not quoted.
- **Replay.** A Maelstrom run cannot be replayed exactly (no seed). The stores of every run are kept in `$SP/e46/runs/` for inspection; the trimmed results are here.
- **Checker strength.** Knossos checks each key's history on its own, and Maelstrom retires a key after 20 client processes have touched it, so each history stays small enough to check fully. A bug that only shows across keys (none is possible in a single-register store) would not be seen. The planted bug shows the checker catches a stale follower read; it does not prove it catches every subtler bug.

## Files

- [node/node.ts](node/node.ts), [node/run-node.sh](node/run-node.sh): the Maelstrom node. [node/pauser.ts](node/pauser.ts): the pauser.
- [run-one.sh](run-one.sh) one run; [batch.sh](batch.sh) one batch of [matrix.txt](matrix.txt); [run.sh](run.sh) all of it, each batch under the heavy lock; [summarize.py](summarize.py) one run to one JSON line; [table.py](table.py) the table.
- [fetch.sh](fetch.sh): Maelstrom 0.2.4 by URL and sha256.
- [results/](results): [summary.jsonl](results/summary.jsonl) (one line per run), [runs.md](results/runs.md) (the table), one folder per run with Maelstrom's `results.edn` verdict section, the pauser log and the nodes' role and hash lines; [port-sha256.txt](results/port-sha256.txt) and [matrix-code-sha256.txt](results/matrix-code-sha256.txt) (the exact code that ran); [machine.txt](results/machine.txt).

VERDICT_LINE
