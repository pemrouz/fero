# E-44: how much of fero runs on an outside log

**Question (Q-44, [QUESTIONS.md](../../QUESTIONS.md) §8).** How much of fero runs on an outside log, and which semantics need fero's own kernel? The outside log is NATS JetStream (a replicated stream store inside nats-server), the reference for the row BUY (SPACE §4): fero's upper layers on someone else's log.

**Threshold.** None picks BUY: it fails TEST-10 (the simulator cannot run their bytes), DEP-20 (plain `node`) and goal 2 (it cannot beat what it is built on) by construction. Every row's DEV-05 is reported as a multiple of BUY's lines, and any MUST that BUY meets more cheaply is named.

**What was asked for.** A prototype of P-01 (live shared state), P-09 (work queue), P-10 (locks) and P-14 (invariants) on nats-server 2.10.22 with JetStream, with `data` folding the stream on the client; the lines of code; the requirements it meets; the gaps.

## What was built

| File | What |
|---|---|
| [buy.mjs](buy.mjs) | The prototype: **164 lines** (no blanks, no comments). `fero(name)` (rows, writes, conditions, `incr`), `lock(name)`, `queue(name)`. |
| [checks.mjs](checks.mjs) | The acceptance checks of the four patterns (REQUIREMENTS §1), with the stream's leader killed along the way. 199 lines. |
| [msgid_probe.mjs](msgid_probe.mjs) | A side probe of one JetStream behaviour (below). |
| [cluster.sh](cluster.sh) | Three nats-server 2.10.22 processes on this box, clustered, JetStream on file storage, three replicas per stream, `sync_interval: always` (an fsync before each ack: the setting that matches fero's `persisted`, as in E-09b). |

Run it: `./fetch.sh` (the official `nats` client 2.29.3 from npm), then `./run.sh` (about 9 minutes). Raw output: [results/](results). Machine: 4 vCPU, one disk, Node 22.22.0, `data` at 63fea66. Not a timing run: the box was shared (load 4 to 10), so every time below is marked rough.

### How each pattern sits on JetStream

- **A resource (P-01) is a stream that keeps the last message per subject, one subject per row.** A write publishes the whole row to its subject. Every client reads the whole stream in order with an ordered consumer and folds it through `data`'s hot lane into a `data` source, which is what the app reads, taps and builds views on. A write answers when the stream has acknowledged it and the client's own fold has passed it (read your writes).
- **A condition (P-14) is a check-and-write.** JetStream can refuse a publish unless the subject's last message has a given sequence number (`Nats-Expected-Last-Subject-Sequence`). So `incr(-1, { min: 0 })` reads the row's last message, computes the new row, and publishes it with that expectation; on a refusal it reads again and retries. A row's version is its last message's sequence number.
- **A lock (P-10) is the one message on its subject, in a stream whose messages die of age.** Acquire is "publish only if the subject is empty". The holder rewrites it every third of the lease. The fencing token is the stream sequence of the acquire. A protected write is a check-and-write that also carries the token in a header, and refuses if the row has seen a higher one.
- **A queue (P-09) is a stream with work-queue retention** (an acked message is removed), a pull consumer whose ack wait is the lease and whose delivery limit is the queue's. The dead-letter queue is a second stream; a mover copies a message there when JetStream says its deliveries are used up.

## Results

Every line is in [results/](results) (`p01.jsonl`, `p14.jsonl`, `p10.jsonl`, `p09.jsonl`, `dedup.jsonl`, `failover.jsonl`, `probe.jsonl`, `burn.jsonl`, `burn-one-id.jsonl`). The queue and failover lines come from a second run, after two fixes to the prototype that the first run showed were needed (below); the others from the first full run.

### What BUY meets (measured)

| Requirement | Check | Result |
|---|---|---|
| P-01 | three clients on three servers, 900 writes, the stream's leader killed with `kill -9` in the middle; a fourth client folds from the start afterwards | all four hold the same 50 rows; no acknowledged write lost |
| P-01 | read your writes | 900 of 900 |
| P-01 | others' changes arrive live | client A's `data` sink saw 900 commits |
| P-01 | a held-row read is local | 81 ns through the `data` handle (8 µs through a fresh dense snapshot of 50 rows); no round trip |
| P-14 | two sells of the last item through two servers | exactly one `ok`, 100 rounds of 100 |
| P-14 | 8 writers, 400 decrements of a stock of 100 with `min: 0`, a leader kill in the middle | 100 `ok`, 300 refused `bounds`, 0 left |
| P-14 | a refused conditional write says why and never shows up | yes (`version`) |
| P-10 | 4 contenders, 60 acquires, a leader kill | never two holders; nobody gave up |
| P-10 | tokens strictly rise, across the failover | 1 to 60, rising |
| P-10 | a holder that stops (a long pause): the lock passes on | after 1,007 ms for a 1,000 ms lease, with a higher token |
| P-10 | a write under an older token than the row has seen | refused `fenced` |
| P-09 | 300 enqueues, each retried with its id | 300 duplicates dropped; 300 in the queue |
| P-09 | 4 workers, 10 % of handouts "crash" (no ack), a leader kill | all 294 good jobs acked exactly once; none lost; 49 handed out more than once |
| P-09 | never two live leases on one message | 0 |
| P-09 | after 3 deliveries a job goes to the dead-letter queue | all 6 poison jobs, 3 handouts each; the queue is empty |
| P-09 | an empty take writes nothing | the stream's last sequence does not move |

So with 164 lines and no kernel of its own, BUY passes the main acceptance test of each of the four patterns, through a leader kill.

### What BUY does not meet (measured, except where marked)

| # | Gap | Evidence |
|---|---|---|
| 1 | **F-05, failover time.** Bar: writable again within 2.5 s. | Three kills of the stream's leader: the longest wait for an acknowledgement was **5.4, 5.2 and 7.2 s** (rough). In the P-01 check, where a write also waits for the client's own fold, the longest write took 44 s. JetStream's election timer is its own (4 to 9 s in its source, from memory, not re-read here); fero cannot change it. |
| 2 | **F-02, exactly once per attempt.** | A retried attempt lands once inside the dedup window (2 minutes by default) and twice after it (shown with a 1 s window). And an `incr` whose answer was lost, retried after one other write to the row, is counted again: the counter read 3 where 2 was right. The attempt id lives only in the row's last message. |
| 3 | **A refused publish burns its message id.** | [msgid_probe.mjs](msgid_probe.mjs): on a stream with 3 replicas, a publish refused for a wrong expected sequence still has its `Nats-Msg-Id` remembered; the next publish with that id is answered "duplicate" and **not stored**. With 1 replica it is stored. The prototype's first version used one id for every try of an attempt and lost updates with no fault at all: with 8 clients adding to one counter, **58 of 200 increments were answered `ok` and never stored** (`results/burn-one-id.jsonl`; with an id per try, 200 of 200: `results/burn.jsonl`). The id must name one try, not the attempt, so it cannot serve gap 2. |
| 4 | **P-14 over more than one row.** | The check is per subject. A partition of several rows cannot be judged as one, except against the whole stream's last sequence, which any other write breaks. (JetStream 2.10; reasoned from its headers.) |
| 5 | **P-14's cost: the judge is the client.** PERF-10's bar is 3 µs per conditional op at the writer. | 100 decrements of one row from one client: 415 ms (about 4 ms each: a read and a publish, each a round trip, with an fsync on three servers). The same row from 8 clients: 305 publishes for 200 decrements, **34 % wasted on retries** (rough). Under contention the work grows with the writers. |
| 6 | **P-10: the token check is not enforced.** | A write with no token to a protected row was accepted. The check runs in the client library; JetStream cannot tie a write to a token. A stale holder that uses another tool, or old code, gets through. |
| 7 | **P-10: one lock, one lease length.** | Expiry is the stream's maximum age (2.10 has no expiry per message), so each lease length is its own stream with its own sequence. The same lock name under two leases was held by two holders at once, with tokens 93 and 1. |
| 8 | **P-09: the dead-letter move can be missed.** | JetStream announces "deliveries used up" once, on a plain subject that is not stored. With no mover listening at that moment, the job stayed in the queue stream and was never handed out again. A scan (a read of every sequence below the consumer's position, when nothing is in flight) moved it. |
| 9 | **P-09: FIFO per partition with several workers.** | With one shared consumer, 4 workers held two jobs of one partition at once 13 times in 60 jobs, and finished 12 out of order. It holds only with one consumer per partition (0 and 0), and then a take is one pull per partition and the server keeps a consumer per partition. |
| 10 | **By construction** (SPACE §4): TEST-10 (the simulator cannot run nats-server's bytes, so no seed, no shrink, no replay: TEST-01, TEST-09, OPS-11(d)), DEP-20 and SC-01 (a second program to run; `node app.ts` alone is not enough), goal 2 (E-09b: JetStream matched reaches 1,228 acks/s for one publisher). | not run; structural |

### Two things the first run taught the prototype

- **A take must hand over what is there.** The first `take` waited up to a second to fill its batch, with messages already inside it. Their leases ran meanwhile. With a 600 ms lease this showed as jobs handed out twice inside a lease, acked twice, and good jobs in the dead-letter queue (7 and 8 there, for 6 poison jobs). A take now returns 30 ms after the last message arrives, and the check's lease (2.5 s) is longer than a take's wait. After that: 0, 0 and 6.
- **A message id per try** (gap 3).

Both are the kind of rule a reference model or a simulator finds. Here they were found by counting, on a real cluster, after the fact.

## Lines of code (DEV-05)

BUY's lines are fero-owned lines only: no tests, no nats-server, no client library.

| Part | BUY | fero's prototype for the same thing (E-22, counted the same way) |
|---|---|---|
| connect, retry, publish, read latest | 31 | - |
| a resource: rows, writes, conditions, `incr`, read your writes (P-01, P-14) | 50 | L2 561 + L3 427 + L4 856 + seam 125 = 1,969 (these carry all 22 patterns, not two) |
| a lock (P-10) | 21 | 64 |
| a queue (P-09), with the strict form, the mover and the scan | 62 | 112 |
| the log, replication, failover (L0, L1) | 0 (nats-server's) | about 5,000 to 6,000 for Raft per shard; about twice that for log-first (REQUIREMENTS DEV-05's own estimates) |
| **total** | **164** | |

**Every row as a multiple of BUY's 164 lines** (reasoned, from DEV-05's estimates plus E-22's 2,517 lines above L1; no candidate's kernel exists to count):

| Row | Estimated fero-owned lines | × BUY |
|---|---|---|
| MIN, MIN-TS, MIN-P, LEAN, RUST, SRV, SIDE, EMB-V8, DRAFT, CELL, LANE (Raft per group) | about 5,500 + 2,500 = 8,000 | about 49 × |
| SLOG, RLOG, SPLIT (log-first, or split rules) | about 11,000 + 2,500 = 13,500 | about 82 × |
| V4 (measured in REQUIREMENTS §5: 9,100 lines of kernel, api and shell) | 9,100 | 55 × |

The multiple is large because BUY's 164 lines cover four patterns and none of the log. Above the log the gap is small: BUY's lock is 21 lines against 64, its queue 62 against 112. **BUY's saving is the kernel (L0 and L1) and the writer-side judge (L2); it is not the libraries.**

## Which MUSTs BUY meets more cheaply, and which need fero's own kernel

**Met more cheaply by BUY** (so each row's report should say what its own lines buy over this):

- **P-01** for clients that hold the whole resource: one log, every client folds it with `data`. 80 lines. (F-01 comes with it: three replicas and an fsync before the ack.)
- **P-14 for one row at a time**, by check-and-write. Correct through a leader kill; the price is gap 5.
- **P-10's mutual exclusion and rising tokens**, in 21 lines.
- **P-09's core**: enqueue with dedup, leases, a delivery limit, none lost, an empty take that writes nothing.

**Need a kernel fero owns** (each is a gap above that cannot be closed from the client):

- **Fast failover (F-05).** The election timer belongs to the log.
- **Exactly once per attempt past a window (F-02).** It needs a per-attempt table that the log's writer keeps and replicates. A message-id window is not one, and gap 3 shows the two cannot even be combined.
- **A judge at the writer (P-14, PERF-10, P-11).** A condition over a partition of several rows, and an op that costs microseconds and no retries under contention, need the writer to hold the state and decide. A client can only guess and retry.
- **Fencing that every write passes through (P-10).** Only the writer can refuse a stale token for every client.
- **Leases by the writer's clock, per lock (P-10, P-02, P-13).** JetStream 2.10 expires by stream.
- **An atomic "ack or dead-letter" and per-partition order (P-09).** Both need the queue's state machine at the writer.
- **A simulator of the same bytes (TEST-10), and one process (SC-01, DEP-20).**

## What the prototype leaves out

- **18 of 22 patterns.** P-02 (expiry per row), P-03 (follow part of a resource, with `shortfall`), P-08, P-15, P-17 and the rest were not tried. Some are known to fit JetStream badly (expiry per row needs 2.11).
- **Values are JSON.** `undefined`, `NaN` and bytes do not survive; fero's codec would carry them.
- **Deletes leave a marker per row for good** (as JetStream's own KV does). A create-if-absent after a delete must use the marker's version, not 0.
- **A new client reads one message per live row.** There is no snapshot; with many rows the first fold is one stream read.
- **Speed.** Nothing here is a benchmark. E-09b has JetStream's own numbers on this box.
- **nats-server 2.11 and later** add expiry per message and other tools. The task named 2.10.22.
- **JetStream's own safety under faults.** One leader kill per check is not a Jepsen run. Its durability with `sync_interval: always` is taken as given.
- **The NATS documentation was not re-read in this session** (the network blocks it). Each JetStream feature used is named by its header or setting, and its behaviour is measured here. The pages: [headers](https://docs.nats.io/nats-concepts/jetstream/headers), [streams](https://docs.nats.io/nats-concepts/jetstream/streams), [consumers](https://docs.nats.io/nats-concepts/jetstream/consumers).

## Verdict

BUY is what the threshold expects: a floor and a mirror, not a contender. In 164 lines it passes the main acceptance test of P-01, P-14, P-10 and P-09 through a leader kill. Ten gaps remain, and nine of them are measured. They mark exactly where a kernel of fero's own earns its lines: failover time, a per-attempt table, the judge at the writer, enforced fencing, leases per row, and atomic queue moves.

Q-44: four patterns (P-01, P-14, P-10, P-09) run on JetStream 2.10.22 in 164 fero-owned lines and pass their main acceptance checks through a leader kill (900 writes none lost, exactly one of two sells 100 of 100, 60 lock acquires with no overlap and rising tokens, 294 jobs acked once and 6 dead-lettered), but ten gaps need fero's own kernel: failover 5.2 to 7.2 s against F-05's 2.5 s, exactly-once only inside a dedup window and only until the row's next write (F-02), conditions on one row only and judged by client retries (34 % of publishes wasted with 8 writers; about 4 ms an op), fencing by convention, one lease length per lock stream, a dead-letter notice that can be missed, FIFO per partition only with a consumer per partition, and TEST-10, DEP-20 and goal 2 by construction; and a clustered stream remembers the message id of a publish it refused, which lost 58 of 200 increments with no fault until the id named one try. Moves: BUY stays the reference row (out by construction; its lines are the floor: every Raft row is about 49 × and every log-first row about 82 × its 164 lines, almost all of it L0 to L2); every row with K `lib` (MIN and its family, DRAFT, LEAN, RLOG, SLOG, CELL, LANE, SPLIT, EMB-V8, SIDE) up a little on DEV-05's reason (the libraries above the log are small either way: lock 64 against 21 lines, queue 112 against 62; the lines that matter are L1 and L2, and they buy F-05, F-02, P-14 and PERF-10, which BUY cannot meet); D `win` (a dedup window alone: DRAFT, LANE, SPLIT, SLOG, V4) down a little on F-02 (the window fails past its horizon here, as E-20 and E-30 model); P-09 and P-10 for every row gain two rules found here (a take hands over what it has at once; a lock name has one lease).
