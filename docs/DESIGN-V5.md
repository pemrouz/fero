# fero v5: the log first, servers on top

A design, a plan and a backtest for the next fero, against `main` at d7c9efe (v4, 1,216 tests) and data at 63fea66. Nothing here is built.

**What this draft changes.**
- Earlier drafts made servers hold the data and copy it to each other: first with Kafka's protocol, then with Raft per shard ([V5-REPLICATION.md](V5-REPLICATION.md) compares those).
- This draft puts **the log first**. Each shard's log lives on log nodes, with object storage under them. Servers sit on top as disposable writers and caches.
- Scaling up and down is designed in from the start, not added later.
- Everything above the log carries over (sections 3, 4.3 to 4.6, 5): ops, subscriptions, methods, libraries. It only ever needed one writer per shard, with an ordered log.

**How it was checked.**
- v4's DECISIONS, STATUS, design records and HISTORY were catalogued into 1,313 hard cases, plus 102 invariants, 36 monitors and 20 SCHEDULE clauses ([V5-BACKTEST.md](V5-BACKTEST.md)).
- Four agents judged the earlier drafts against every case, and an independent reviewer signed off on the third (section 13).
- This draft's new L1 is being re-checked against the cases that touch it, and reviewed afresh (sections 7 and 13).

**Contents.**
1. The answers
2. The model
3. Retention: history, rows, caches
4. The layers and their primitives
5. How each pattern is built
6. fero test and fero deploy on v5
7. The backtest, summarised
8. Performance, layer by layer
9. Measured today
10. Keeping development fast
11. The plan
12. Decisions for you
13. The reviews

## 1. The answers

- **The shape.**
  - Every shard's log is written by one server at a time, and stored on log nodes (machines that keep the log on disk).
  - A write counts once a quorum of log nodes has it on disk.
  - Old log and snapshots move to object storage.
  - Servers hold rows in memory only as a cache, so a server can stop at any time and another can take over from the log.
  - One small Raft group keeps the cluster's facts. It is the only consensus in the system.
  - Section 4.
- **Scaling, up and down.**
  - Servers start and stop at will, and never copy rows from each other's disks: a server reads what it needs from storage.
  - When the log tier is separate (as in fero deploy), durability never depends on the servers.
  - When servers are also the log nodes (the default when self-hosting), losing servers also loses copies, until they are re-copied.
  - Log nodes are added for space and throughput: new log stretches simply go to them.
  - Shards split by themselves as load grows, without copying data between servers: a child reads the parent's snapshot and tail from storage.
  - Limits remain, said plainly in 4.2:
    - with every server holding every row, more servers add CPU and clients, not room for rows;
    - one partition is one writer.
  - Section 4.2.
- **Retention applies to two things, and they are separate knobs.**
  - `history` is how much of the log of deltas a resource keeps. `rows` is which rows its state keeps.
  - A stream keeps history and no rows; a map keeps rows and no history; a tape keeps both.
  - A row removed by a `rows` rule is appended to the log as a remove.
  - A third knob, `cache`, is per process and never written anywhere.
  - The log is never the only copy of the state: snapshots are, beside it. So dropping history never loses the current state.
  - Section 3.
- **Caches are the same mechanism.**
  - A Redis-style cache is `rows: { ttl, max }`.
  - A near cache is `cache: { memory }` on a client.
  - A read-through cache is a `load` function.
  - Section 3.3.
- **The layers.**
  - L0 storage and io; L1 the log; L2 fold and ops; L3 flow; L4 surface; L5 libraries.
  - L1 is three published designs: Raft for the facts, BookKeeper's quorum log for each stretch of a shard's log, and Delos's chain of stretches for the whole log.
  - Everything a pattern needs above L2 is a library.
- **Development speed.** v4's October went 15, then 40, then 34 open bugs over about 700 commits, because many novel mechanisms interact. v5 uses fewer novel mechanisms, each checked by a model checker before code. Section 10.
- **fero test and fero deploy.** All 14 kernel needs from "fero deploy: the journey" and all 11 pieces from "fero test" have a home.
  - A tape is a log, a fork is a pointer to a snapshot, and sleep and wake are reading a snapshot back.
  - The number of copies of the data no longer depends on the number of servers.
  - Section 6.

## 2. The model

| Word | What it is | Example |
|---|---|---|
| **project** | the resources one program serves; one cluster | `shop` |
| **resource** | one `fero(name)`: a map of rows, its methods, its rules | `fero('bookings')` |
| **row** | the value under one top-level key | `bookings.data.b42` |
| **cell** | a path inside a row; the unit of a write | `b42.status` |
| **record** | one change to one cell or row (data's delta) plus the header of 4.3 | `{ set, ['b42','status'], 'booked' }` |
| **partition** | the unit of order, atomicity and following. By default one row; a `partition` function can group rows | `room42/m1` and `room42/m2` in `room42` |
| **shard** | a hash bucket of partitions with one log and one writer at a time. Invisible to users | `hash('room42') & 15` is shard 7 of 16 |
| **log** | one shard's records in order, with offsets that never go back | shard 7, offsets 0, 1, 2, … |
| **loglet** | one stretch of a shard's log, written by one server, stored on a few log nodes | shard 7, offsets 900 to 1,412, on log nodes A, C, E |
| **chain** | a shard's loglets in order, kept in the metadata | shard 7: loglet 1, then 2, then 3 (open) |
| **version** | the shard's incarnation and the offset of a row's last write | `b42` at (7, 1, 902) |
| **state** | the rows: the fold of the log | what `f.data` shows |
| **server** | a process that runs resources: it writes the shards it leads, folds rows, serves reads, runs methods. Disposable | an app process; a copy in fero deploy |
| **log node** | a process that stores loglets on disk and serves them. In small setups every server is also a log node | a disk in the cluster |
| **voter** | a log node or server that votes in the metadata group: one, three or five per cluster | |
| **object store** | where sealed loglets and snapshots go: S3 or a compatible store, or a local folder | |
| **client** | a process that follows some partitions and writes through a server | a webserver |
| **relay** | a client that also serves other clients | an edge tier |

**Keys, partitions and shards.**
- **A key** is a top-level key of the resource's object, as today.
- **A partition** is one or more keys that stay ordered and atomic together. By default, exactly one key.
- **A shard** groups many partitions so that a commit, an fsync, a write to the log nodes and a change of writer are paid per shard, not per partition.
- **A shard never splits a partition.** A hot partition is bounded by one writer's core. The app splits it (`room42-0` … `room42-3`) if it must.
- **Reading one partition does not mean reading its shard.**
  - Live updates are routed per partition.
  - The current rows come from a snapshot, by key.
  - A replay of one partition's history uses a per-loglet index of where each partition's records are (4.1), so it skips the others.

**Shard count.**
- Each resource starts with 16 shards (`shards` sets another power of two).
- From then on, shards split and merge by themselves, by size and load (4.2). The count follows the data, with no fixed cap, and changing it moves no data.

**Order.**
- One partition is totally ordered, whoever writes to it. Partitions are not ordered against each other.
- A cell keeps the value of its last record in log order. There are no stamps and no elections.

## 3. Retention: history, rows, caches

### 3.1 Three knobs

| Knob | Applies to | Decided by | Written to the log? | Values |
|---|---|---|---|---|
| `history` | the log of deltas, after commit | the resource's config | no: dropping history changes nothing anyone sees | `0` (default: only what recovery needs), `'7d'`, `'10GB'`, `1e6` records, `'all'` |
| `rows` | the state: which rows exist | the shard's writer, using its time | **yes**: a row it removes is a `remove` record with a reason (`ttl`, `max`, `where`) | `true` (default), `false` (no state: a stream), `{ ttl, max, evict, where }` |
| `cache` | one process's memory | that process | never | `{ memory: '200MB' }` on a client or relay |

**Why history and rows are separate.** History answers "what happened"; rows answer "what is". Dropping history never changes a row. Removing a row never drops history, because the remove is appended.

**Why `rows` removals are records.** Servers, subscribers and replays must agree on which rows exist. So the writer decides, by its clock (4.3), and appends the remove.

**What `rows` can evict by.**
- Write time (`ttl` since the last write or `touch`; `evict: 'oldest'`), count (`max`), and content (`where`).
- Approximate read recency (`evict: 'lru'`): servers sample their reads and send batched touches to the writer, which evicts by sampled recency, as Redis's approximated LRU does.
- Exact read recency is what `cache` is for, per process.

### 3.2 What each combination is

| Pattern | `history` | `rows` | Other | Like |
|---|---|---|---|---|
| live map (today's fero) | `0` | `true` | | Redis hash, KTable |
| cache with expiry | `0` | `{ ttl: '10m', max: 1e6 }` | | Redis with `maxmemory` |
| session store | `0` | `{ ttl: '30m' }` | `touch` resets the ttl | Redis sessions |
| stream | `'7d'` | `false` | | Kafka topic |
| stream with a current picture | `'7d'` | `true` | a reader starts from a snapshot, then reads the log | Kafka compacted topic |
| event store | `'all'` | as needed | | EventStoreDB |
| pub/sub | `0` | `false` | `durability: 'none'` | NATS core, Redis pub/sub |
| queue | `0`, or `'7d'` for audit | messages are rows; an ack removes one | the queue library (5.3) | SQS, JetStream work queue |
| tape (fero test) | `'14d'` | `{ ttl: '14d' }`, keyed by match key | replay reads the log in order; an ask finds its answer by match key | a recording |
| presence | `0` | `{ while: 'session' }` | | ZooKeeper ephemeral node |

**`durability`** has two rungs.

| Rung | A write is confirmed when | It survives |
|---|---|---|
| `'persisted'` (default) | a quorum of the loglet's log nodes has it on disk | the loss of any minority of those log nodes, and a power loss of all of them |
| `'none'` | the writer took it; no log nodes, no disk | nothing: transient pub/sub only |

- **`persisted`.** Group commit on the log nodes (4.1) makes it cost one fsync and one network round trip. Nothing a reader saw is ever undone.
- **`none`.** Such a resource must have `rows: false`. Its records go straight from the writer to subscribers, best effort. Its cursors carry the writer's epoch; a subscriber whose epoch is gone resumes at `latest` and is told so.

### 3.3 Caches, all from the same parts

- **A replicated cache** is a resource with `rows: { ttl, max }`.
  - Every server that follows it holds the same rows.
  - The writer expires them, and subscribers see the removes.
- **A near cache** is a client with `cache: { memory }`.
  - It follows the partitions it reads, and drops the least recently read when it runs out of room.
  - A held row is a sync read. A row not held is `await f.get(key)`: one hop, after which it is followed. The sync `data[key]` of a row not held throws `shortfall`.
- **A read-through cache over another system** is a resource with a `load` function.
  - A miss asks the shard's writer, which runs `load(key)` once however many readers miss, and writes the row with `if: { version }` set to what it saw at the miss. A write that landed meanwhile wins.

### 3.4 Retention, snapshots and recovery

v4's logs are its state, and compaction trims them. v5 keeps three things apart.

| What | Holds | Kept by | Lives on | Needed for |
|---|---|---|---|---|
| the state | the rows now | always | snapshots in the object store (or on log nodes without one); in memory on servers that fold the shard | reads, conditions, starting a server, new subscribers |
| the tail | every record after the latest snapshot | always, whatever `history` says | the open loglet and recent sealed ones, on log nodes | recovery (snapshot plus tail), live followers |
| history | older records | `history` | sealed loglets, moved to the object store, or kept on log nodes without one | replay, tapes, cursors further back |

**Retention never touches the state or the tail.** A new snapshot is taken after N records or M bytes of tail, so a limit on `history` can always be met; anything it drops is inside a snapshot already.

**Snapshots are incremental layers.**
- Each snapshot writes only the rows changed since the previous one, plus a removal marker for each row removed since. A background merge folds layers together in order, as an LSM tree does, and drops the markers once no older layer remains below them.
- A cold start applies the base, then each layer in order, so a removed row stays removed.
- So a big object with small changes means small snapshots.
- A snapshot is cut from copy-on-write state, so it is the state at exactly one offset.

**A window of deltas alone cannot rebuild a picture.** So:
- A `state` subscriber always starts from a snapshot, then gets deltas. One that falls behind gets a fresh snapshot.
- A `log` reader whose cursor is older than history is refused `expired`, with the earliest cursor kept.
- A stream with `rows: false` has no picture to rebuild. An app that must rebuild everything from deltas sets `history: 'all'`.

## 4. The layers and their primitives

```
L5  libraries, adapters   queue · groups · locks · presence · rate limits · loaders · RESP / Kafka / WebSocket gateways · fero CLI
L4  surface               fero(name) · views · methods · rules · identity · config · worlds (fero test)
L3  flow                  subscriptions: selector + mode + cursor · credits · conflation · relays · near caches
L2  fold and ops          records → rows · conditions · writer ops · writer time · dedup · row retention
L1  the log               metadata (Raft) · chains of loglets · the loglet protocol · writers and handover · scaling
L0  storage and io        log node storage · group commit · object store · snapshots · transports
```

- **Layer boundaries.** A layer talks only to the one below it, through an interface with its own test suite.
- **L0 to L3 are deterministic.** They take events (frames, ticks, disk and object-store completions) and return effects, as v4's kernel does (V3-1). The simulator runs them unchanged, with L4 user code as sim steps under the world's virtual clock.

### 4.0 The shape

```
            clients, relays, browsers
                     │  subscribe · write · call
        ┌────────────┼────────────┐
     server       server       server        disposable: write the shards they lead,
        │            │            │          fold rows, serve, run methods
        └──── append · read · seal ────┐
     log node     log node     log node      durable: loglets on disk, a quorum per write
        │            │            │
        └──────── object store ─────────     sealed loglets and snapshots
      metadata: one Raft group (1, 3 or 5 voters) holds members, the catalog and every shard's chain
```

**Where each part runs.** The same code in every setup; only placement differs.

| Setup | Servers | Log nodes | Metadata voters | Object store |
|---|---|---|---|---|
| one process: local dev, fero test, a single copy | 1 | the same process; each loglet has one copy | the same process | a local folder |
| a few processes on one box (example 01) | each process | each process; up to three copies per loglet | the first process, then three once there are three; the rest follow | a local folder |
| self-hosted cluster | each app process | each app process, or separate machines | three or five of them | optional: S3 or compatible. Without it, sealed loglets and snapshots stay on the log nodes, with E copies each |
| fero deploy | each copy, disposable, may sleep | a shared tier the platform runs | on the log tier, one group per project | S3 |

### 4.1 L0: storage and io

**On a log node.**
- **One journal per log node.** Every append, to any loglet, goes into one journal file. One `fdatasync` covers a batch: at most every millisecond, or every megabyte. This is group commit.
- **An entry store.** After the journal fsync, entries are written to entry files grouped by loglet, with an index from (loglet, offset) to position, and a per-partition index so a replay of one partition skips the rest. The journal is truncated once the entry files cover it (BookKeeper's journal and entry log).
- **What `persisted` waits for.** The journal fsync that covers the record, on a quorum of the loglet's log nodes. A Raft vote, term or entry is never answered before its own fsync.
- **Sealing is durable.** A log node records that a loglet is sealed (4.2) in its journal before it answers, and from then on refuses appends to it.
- **Boot checks.** Every record carries a crc32c and its predecessor's offset (v4's chain, V3-8). A log node drops a loglet's copy from the first record that fails, and reports it so the copy can be repaired from the others.
- **Directory fsyncs.** Creating or renaming any file fsyncs its directory. One failed fsync condemns the store (v4's fsyncgate latch): the log node stops acknowledging and is replaced.
- **One process per dir.**
  - v4's lock file and lease thread stay (V4-59).
  - Every file carries the lease's epoch in its name, and a holder writes only files of its own epoch.
  - A new holder renames the old epoch's directory to `retired-<epoch>`, and writes and fsyncs a boot record naming it and the end offset it will read to. Only then does it read that directory, read-only and never past the end. Files roll by new file and unlink, never by truncating in place.
  - So a process frozen past its lease cannot shorten or extend what the new holder reads.

**The object store.**
- **An interface with five calls:** put, get (with a byte range), list, delete, and put-if-absent.
- **Implementations:** S3 or a compatible store, and a local folder. The local folder works only when every process is on one box.
- **Without an object store** in a multi-box cluster, sealed loglets stay on their log nodes, and snapshots are written to E log nodes, as loglets are. Cold servers read them there.
- **Sealed loglets** are uploaded as segment files, with their partition index.
- **Snapshots are cut by the shard's writer only.**
  - Each is written put-if-absent, under a name keyed by (shard incarnation, offset).
  - It is named in the metadata, by compare-and-swap, only after the put is confirmed.
- **When a loglet's copies may be deleted.** All of these must hold:
  - its upload is confirmed, or a merged snapshot base at or above its end is named and stored (a single incremental layer covers nothing on its own);
  - no background merge is reading it;
  - no fork or split child still needs it;
  - the shard's `history` allows it.
- **Old offsets** are read from the object store: slower than log nodes, and cached by the server that reads them.

**On a server.**
- **The rows it folds** are in memory, as a copy-on-write structure, so a snapshot can be cut at one offset.
- **State larger than memory** is opt-in per resource. Cold rows are read through from the latest snapshot layers in the object store or on local disk, with the hot set in memory.
- **Nothing on a server's disk is needed for durability.** A server may keep a local cache of snapshots to start faster.

**Transports.**
- TCP, TLS, WebSocket (browsers, with no bridge), and in-process (worlds, the simulator, and a server that is its own log node).
- Frames are v4's: encoded once, with a crc32c, and the same bytes are the journal row and the wire (V3-8).
- A frame is sent at the end of the event-loop turn that made it (decision 9).

### 4.2 L1: the log

Three published designs, each doing one job:

| Job | Design | Source |
|---|---|---|
| keep the cluster's facts | Raft | Ongaro and Ousterhout, 2014; the TLA+ spec |
| store one stretch of a shard's log | a quorum log with one writer, sealing and recovery | Apache BookKeeper's ledger protocol, with Vanlightly's TLA+ spec; Delos's NativeLoglet |
| join stretches into one log, and change writers | a chain of loglets, changed by compare-and-swap on the metadata | "Virtual Consensus in Delos", OSDI 2020 |

#### Clusters, genesis and discovery

- **One cluster per project.** Its resources are entries in its catalog. This replaces v4's one cluster per resource, with its own port, membership and heartbeats each.
- **A cluster id**, minted at genesis, rides every HELLO. Different ids never link, and both sides say so, naming both ids and the fix.
- **Exactly one genesis.**
  - Across boxes, the first voters start with the same `voters` list.
  - On one box, the first process of a project's run creates `cluster-id` in the run's folder under `.fero/` with an exclusive create.
  - Everyone else joins as a learner.
  - A process given cross-box `hosts` and no `voters` never founds a cluster; it joins its hosts' cluster, or waits and says "no voters configured".
  - **A stale run folder.**
    - A process that finds `cluster-id` but reaches no voter within `connect.wait` waits. It says which voter it needs, and where that voter's dir is.
    - If no dir in the run folder holds any of the cluster's metadata (the dirs were wiped), the file is stale. The process renames it aside, says so, and founds a new cluster with a new id.
    - Otherwise `fero recover --new-cluster` can make it a cluster from its own copy of the metadata. A learner's copy may be behind, and the command says so.
- **Finding a resource.** A name resolves to its project's cluster through the box directory or `hosts`, as today. Remote names carry the project: `shop/stock`.

#### The metadata

One Raft group: one, three or five voters, which may include a witness that holds only the metadata. Every other process follows it as a learner. Its leader is the **controller**. It holds:

| Record | Holds |
|---|---|
| member | id, life (random per process start), session epoch, disk incarnation, roles (server, log node, voter, witness), addresses (listen and advertised), capacity, code hashes it can run, kernel version |
| resource | name, config (4.5), allowed code hashes, seed applied, write gate (open, or read-only with a reason) |
| shard | resource, number, incarnation, split lineage, its **chain** (below), its snapshots, the server that should write it, the servers that should follow it |
| cluster | id, cluster version, current and next door secret, CA key envelopes, revoked certificates |

Raft as published, plus the fixes practice added:
- Term, vote and entries are fsynced before any reply.
- Membership changes one voter at a time, and a new leader first commits an entry of its own term (Ongaro's 2015 fix).
- PreVote and CheckQuorum, so a returning voter cannot unseat a working leader, and a cut-off leader steps down.
- A voter is its member id plus its disk incarnation. A member back without its disk rejoins as a learner, and is replaced by two single-voter changes.
- Leadership transfer on a planned stop, so a roll never waits for an election timeout.

**What the metadata is not.**
- It is not on the write path. A server appends to its open loglet without touching the metadata.
- So **writes continue while the metadata group is down**. What waits is any change: a new writer, a split, a new member.

#### A shard's log: a chain of loglets

```
shard 7:  [loglet 1: offsets 0–899, sealed, in the object store]
          [loglet 2: offsets 900–1,412, sealed, on log nodes A C E]
          [loglet 3: offsets 1,413–…, open, writer S2, on log nodes B C D]
```

- **The chain is a metadata record.** Each entry names the loglet, its first offset, its last offset once sealed, its writer and epoch, and its log nodes.
- **Offsets run on across loglets**, so the shard has one log, and a version or cursor never goes backwards.

#### The loglet protocol (BookKeeper's)

A loglet has one writer, and E log nodes (its copies: 3 by default). A write commits when Q of them have it on disk. Q is always a majority of E or more (2 of 3; 3 of 5), never less: below a majority, losing a minority could lose a committed write.

1. **Append.**
   - The writer sends each batch to all E log nodes.
   - A batch is committed when it and every batch before it in the loglet have Q copies on disk.
   - The committed point is the end of that prefix, never a batch past a gap.
   - The writer stamps the committed point on later batches.
   - When a commit lands with nothing else in flight, it sends the committed point at once, on a small ping, then goes quiet. This is BookKeeper's explicit last-add-confirmed. So a standby, and a client it serves, never waits for the next batch to see a write.
2. **Seal.**
   - Only two actors ever seal a loglet:
     - its own writer, to stop at a known end (a handover, a split, a change of log nodes);
     - a server taking the shard over (below).
   - A sealer sends `SEAL` with its epoch.
   - A log node records the seal on disk, then refuses every ordinary append to that loglet.
3. **Recovery**, after a seal by a server taking over.
   - **The seal set.** The sealer needs seal acknowledgements from at least E − Q + 1 log nodes whose copy of the loglet is whole. A log node that found its copy damaged at boot (4.1) says so, and does not count.
   - **Reading forward.** It then reads from every log node of the loglet it can reach, starting at the highest committed point any of them reports.
   - **Absent versus unknown.**
     - A batch is **absent** only when every node in a set of E − Q + 1 whole copies **that have recorded the seal** answers "I do not have it".
     - A "no" from a node that has not recorded the seal counts for nothing, since the old writer can still land the batch there.
     - A node that does not answer is **unknown**, never absent: the sealer waits for it, or reaches more nodes.
     - Treating silence as absence is the class of bug Vanlightly's TLA+ work found in BookKeeper's recovery.
   - **Recovery writes.**
     - Each batch found, up to the first absent one, is re-written to Q log nodes with a recovery write carrying the sealer's epoch.
     - Sealed log nodes accept recovery writes from that epoch, and nothing else (BookKeeper's recovery add).
   - **The end.** The first absent batch fixes the loglet's last offset.
   - A batch that never committed may be kept or dropped by this. Its writer was never told it committed (4.3, "no answer before commit").
4. **Close.**
   - Every close of a loglet is one compare-and-swap on the shard's chain, against the chain version the closer read. It records the last offset and opens the next loglet.
   - If two closers race, exactly one swap succeeds. The other re-reads the chain and adopts the winner's end.

**What a reader may see of a loglet.**
- **An open loglet:** up to the committed point its writer last stamped.
- **A closed loglet:** up to the end the chain records, never past it, even if a losing recovery re-wrote batches beyond it.
- **A sealed loglet not yet closed:** nothing beyond the last committed point the reader already had. Readers wait for the close.

**One reconfigurer per thing.**
- **The writer changes its loglet's log nodes.**
  - It does so when a log node's link closes, or when that node misses three acknowledgements in a row past `ack.ms` (1 s in TypeScript, 200 ms native).
  - It then seals its own loglet at its committed end, and opens the next on other log nodes, by the same compare-and-swap.
  - So one GC pause on a log node does not re-open every loglet it holds. BookKeeper likewise changes ensembles on a failed connection, not on one slow acknowledgement.
- **The controller changes writers, and only that.**
- So a log node's failure is repaired by the shard's writer within `ack.ms`, not by a session lapse.

**What a loglet survives.** With E = 3 and Q = 2: writes continue with one log node down, and recovery needs two whole copies. With E = 5 and Q = 3: two down.

**Disks that lie.**
- A log node that shut down uncleanly checks every copy's chain at boot (crc and predecessor), and marks any copy it cannot vouch for as damaged, so it does not count toward recovery.
- A disk that acknowledged an fsync and then lost the write cannot be detected on its own.
- Recovery narrows this by reading every copy it can reach, not only the seal set, and waits up to `recovery.wait` (1 s) for all E before it closes.
- The residual case, a lying disk among exactly Q copies with the others unreachable, is named here, not hidden.

**The models.** Each rule above is a property in the L1 TLA+ spec, starting from Vanlightly's BookKeeper spec:
- recovery never closes below a committed batch;
- unknown is never absent;
- a closed loglet's end is the same for every reader;
- sealed nodes accept only the sealer's recovery writes.

#### Writers, handover and failover

- **One writer per shard:** whoever opened its open loglet.
- **Changing writer.** Seal and recover the open loglet. Then one compare-and-swap of the chain closes it, and opens a new loglet with the new writer, an epoch one higher, and fresh log nodes.
- **Two servers can never both write a shard.** If two try to take it over, the swap lets exactly one through. The loser's loglet is sealed, so its appends fail.
- **A planned handover** (a roll, a scale-down, a rebalance).
  1. The old writer stops taking writes, and waits for its in-flight batches to commit.
  2. It seals its own loglet at that end.
  3. It closes the loglet by the same compare-and-swap, naming the warm follower as the next writer.

  If a failover already took the shard, the swap fails, and the old writer adopts the winner's end. The pause is one seal and one metadata commit: a few milliseconds on fast disks.
- **A failover** (a crash, or a hang).
  - The server's session lapses (below). The controller assigns each of its shards to another server, preferring warm followers.
  - Each new writer seals, recovers and swaps.
  - A server that wrote hundreds of shards fails over in parallel: seals run at once, and the controller batches the chain changes into a few metadata entries.
- **Warm and cold takeover.**
  - A warm follower already folds the shard, so it takes over at once.
  - A cold server first reads the latest snapshot and the tail, from the object store, or from log nodes when there is none. That takes seconds per gigabyte.
  - `standbys` sets how many servers keep each shard warm (default: every server, up to 5).
- **How followers read.**
  - A standby tails the shard's loglet from the log nodes, long-polling on the committed point, as Pulsar's readers tail BookKeeper.
  - The writer does not push to standbys, only to its own subscribers.
  - Phase 2 measures this against the writer pushing to two standbys before it is fixed.
- **Who decides who writes.**
  - The controller, by a placement policy: v4's ring over the live servers by default, weighted by load and memory.
  - The policy is not in the safety path; sealing and the swap are. A stale decision costs one extra handover, never two writers.
- **The writer's time.** `t = max(last t in the log, clock)`. A server more than `skew.max` (1 s) off the controller's clock is not given shards.

#### Sessions and failure detection

Every server and log node keeps a session with the controller: a heartbeat each tick (100 ms by default), sent from the kernel's own thread (decision 13).

| Event | Detected after (default) | What happens |
|---|---|---|
| a server's session lapses | `session.ms`: 2 s in TypeScript, 1 s native; tunable down to 500 ms | its session epoch is fenced: writers refuse forwards carrying it. Its shards go to new writers. It re-registers with a new epoch when it returns |
| a log node's link to a writer closes, or it misses three acknowledgements past `ack.ms` | `ack.ms`: 1 s in TypeScript, 200 ms native | that writer seals and re-opens its loglet on other log nodes (one reconfigurer) |
| a log node's session lapses | `session.ms` | no new loglets go to it; sealed loglets it held are re-copied from their other copies, or from the object store |
| the controller changes | — | session timers restart, so a controller failover never fences a healthy cluster. A server that died just before is detected after up to twice `session.ms` |
| a server's main thread (methods, views) stalls past 5 s while its kernel thread is fine | the kernel's watchdog | it answers method calls `busy`, so clients go to another server. Its shards keep being written on the kernel thread, and `cluster.health` says why |
| a member is gone past `evict.after` (10 min) | that long | if it was a voter, a learner is promoted first, then the gone voter removed, one change at a time |

- **Sessions only decide who should write; sealing makes it safe.** A server that wakes after its session lapsed finds its loglet sealed, and its appends refused.
- **Why 2 s.** Failover could be faster, but a 500 ms timeout flaps on a JavaScript GC pause. 2 s is still half of v4's eviction, and native or tuned clusters can go lower.

#### Scaling up and down

**What moves, and from where.**
- Servers never copy rows from each other's disks.
- A server that starts following a shard reads its snapshot and tail from the object store or the log nodes. So data does move to the new server, from storage, as a Raft learner's catch-up would from a peer.
- Durability never depends on how many servers there are.

| Change | What happens |
|---|---|
| add a server | it registers. The controller gives it shards to follow, then to write, paced, one handover at a time. It reads each shard's snapshot and tail as it starts following |
| remove a server | each shard it writes is handed over to a warm follower; then it stops |
| add a log node | new loglets are placed on it. To spread faster, writers roll busy loglets early (seal at a known end and re-open), so their next loglets land on it |
| remove a log node | no new loglets go to it, and writers roll the open loglets it holds. It leaves once every sealed loglet it holds is uploaded or re-copied. That can take longer than `leave.ms`: it stays as a draining log node until done. A forced stop is a restart, so nothing only it holds is dropped |
| a shard gets big or busy | it **splits** (below) |
| a shard is empty and quiet | it may merge with its sibling. The merged shard's offsets start after the larger of the two ends; it combines both shards' dedup outcomes and fence tokens (safe, because the issuer window is global). Merging shards that hold data is phase 5 |
| scale to zero (sleep) | each writer seals its loglet at a known end; servers stop; log nodes and the object store keep everything |
| wake | a server reads snapshots, then opens new loglets |

**Splits.**
- **A split is the writer's act.** Told to split, it stops taking writes to the shard and seals its own loglet at its end X. One compare-and-swap then closes the parent and opens two children, each starting at X + 1 with one more hash bit.
- **If the writer dies mid-split,** the server that takes over recovers the parent's end X′, and opens the children at X′ + 1 in the same swap. A seal cannot choose its offset; the swap records whatever end recovery found.
- **A child's cold start** is the parent's latest snapshot at or below X, plus the parent's tail up to X, filtered by the child's hash bit. The parent's loglets from that snapshot to X are kept until each child has written its own snapshot.
- **Each child inherits** the parent's dedup outcomes and fence tokens, filtered to its partitions.
- **When they land.** Splits land in phase 4, where fero deploy first needs them, after phase 2's sweep is green without them.

**Pacing.** The controller:
- makes one change per shard at a time;
- waits for a follower to be warm before handing over;
- paces splits by a budget per minute;
- refuses a scale-down whose servers could not hold the shards they would follow.

**What stays limited,** said plainly:
1. **Memory.** With `standbys` at every server, every server holds every row. Adding servers adds clients and CPU, not room for rows. Room grows only with fewer standbys and partial follow sets (then some reads hop), or with state larger than memory (then cold reads hit storage).
2. **Fold CPU.** Every standby folds every write of its shards. So a project's write rate is bounded by one server's fold rate, unless servers follow subsets.
3. **One partition, one writer.**
4. **The metadata's write rate.** Every close, split and snapshot name is a Raft commit. Loglets roll by size, or on a change of writer or log nodes, never by time, and changes are batched.
5. **Chain length.** Every roll adds a loglet, so chains are trimmed as their loglets are deleted.
6. **Wake time.** A snapshot read: about a second when small, about a minute for 10 GB.
7. **Under-replication windows.**
   - Between a log node failing and its writer re-opening (up to `ack.ms`), batches commit on fewer copies.
   - When servers are also log nodes, every server crash under-replicates every loglet it held, until they are re-copied.
8. **A commit** costs at least one fsync and one round trip to the log nodes.

#### Leaving, restarting and stopping

| Stop | Used by | What happens |
|---|---|---|
| `leave` | Ctrl-C, SIGTERM or `destroy()` when not under a supervisor; scale-in | **Shards:** hands over every shard it writes. **Votes:** if it is a voter, a learner is promoted first, then it leaves the metadata group, one change at a time. The last voter of a cluster hands its vote to another member before it goes. **Storage:** if it is a log node, it drains (above). The server part is bounded by `leave.ms` (4 s), and `destroy()` says whether it was clean |
| `restart` | the same signals under a supervisor (`FERO_SUPERVISED`), rolls, restart-all | hands over every shard it writes, and transfers metadata leadership if it holds it. Stays a voter and a log node |

- **A crash** is a restart that skipped the handover.
- **Two machines.**
  - Each loglet has E = 2 and Q = 2. One machine's crash pauses writes until the survivor seals (it needs one whole copy: its own) and re-opens each loglet with one copy.
  - That swap needs the metadata, and two voters cannot outvote a crash. So two machines need a **witness on a third failure domain**: a tiny process on a third machine, or a small cloud VM, holding only the metadata.
  - A witness on one of the two machines only heals the other machine's crash, as in v4 (DESIGN-LEAVE §7b).
  - The survivor then writes with one copy: the explicit price of two machines.
  - fero deploy needs none of this, since its data's copies are on the log tier.
- **Example 01** (two processes on one box, no witness).
  - The first process is the only voter, and each loglet has both processes as copies.
  - Ctrl-C on either is a `leave`: it hands over its shards, and the voter hands its vote over first. The other carries on with one copy, and says so.
  - A crash of the non-voter: the voter re-opens each loglet with one copy and carries on.
  - A crash of the voter: the other is read-only until it returns, as in v4.

#### Mixed versions, recovery and routing

- **Mixed versions.** Frames carry the protocol version. The controller raises the cluster version only when every member runs the new kernel, as Kafka's `metadata.version` does.
- **Operator recovery.**
  - `fero recover --new-cluster`, when the metadata quorum is permanently lost. One surviving voter rewrites the configuration to itself, as etcd's force-new-cluster does, and a new cluster id is minted.
  - `fero recover --unclean <shard>`, when fewer than E − Q + 1 copies of an open loglet survive. It closes the loglet at the longest surviving copy, reports what may be lost, and bumps the shard's incarnation, so stale cursors are refused instead of waiting.
- **Routing.**
  - The partition-to-shard function is a fixed 64-bit hash with a full avalanche finaliser, versioned with the frame format.
  - A writer refuses a record whose partition is not in its shard (`wrong-shard`).
  - Clients send writes to their server, which maps each row key to its shard (a custom `partition` function runs only on servers). Clients may cache the writer a server named for a row key, and follow `moved` hints.
- **Who dials whom.** Servers and log nodes dial only members the metadata names, plus their `hosts` and the box directory. Never an address a client claims.
- **Hosted metadata.** fero deploy runs one metadata group per log-tier cell, with each project in its own namespace and quota, as Delos runs one MetaStore. Not one group per project: 10,000 projects would be 10,000 Raft groups.

### 4.3 L2: fold and ops

**The record.** A batch has one header: the loglet's epoch, the base offset and the writer's time `t`. Each record inside has its own offset (base plus index), its own attempt id, and data's delta.

| Field | Why |
|---|---|
| epoch | which writer wrote it; stale writers are sealed out (4.2) |
| offset | the log's order; versions; cursors; retention |
| writer time `t` | TTLs, leases, `ctx.now()` at the writer; `max(previous t, clock)`, carried across writers |
| attempt id (issuer, call id) | dedup of retried writes. The issuer is the process id plus its life, so a restarted process never repeats an id |

**At the writer, in this order:**
1. **Dedup.**
   - **What it checks.** If the attempt id is in the shard's log, committed or in the writer's uncommitted tail, the writer answers with the original offset, and nothing else runs.
   - **No answer before commit.** Every answer (a dedup answer, a refusal such as `conflict`) is judged against the writer's log-end state, so it waits until the committed point reaches the version it was judged against. If the writer loses the shard first, the answer is `unknown`, and the issuer retries at the new writer.
   - **What the issuer promises.** Its call ids rise. It has at most 1,024 attempts outstanding in all, counted from its oldest unacknowledged one (`issuer.window`). It stops retrying an attempt after half the horizon (5 min).
   - **What the writer keeps.** Per issuer and shard: the highest call id seen, and every committed outcome above the floor, kept by id. An issuer silent for the retry horizon (5 min) is forgotten, from memory and from snapshots, so this state is bounded by active issuers.
   - **The floor.** An attempt at or below (highest id seen) − 1,024 that is not among the outcomes is a late duplicate of a committed write, and is refused `stale-attempt`. Above the floor, an attempt not among the outcomes never committed, and is judged fresh.
   - **No late arrivals.** An attempt carries a time budget its issuer sets to half the horizon, and every hop subtracts the time it held it, on its own monotonic clock. A server that forwards an attempt adds its session epoch, and writers refuse forwards from a fenced epoch.
   - **Across writers.** The outcomes, and each issuer's highest call id seen, are part of the shard's state, so snapshots carry both. A new writer takes the higher of the snapshot's and the recovered tail's highest id, so the floor never drops below where the old writer had moved it.
2. **Shape checks that need the current row.**
   - Array holes (`sparse-hole`, V4-28/33).
   - An insert under an existing row.
   - A field write to a row that does not exist is refused `absent-row` (decision 14).
3. **`validation` and `rules.write`**, with the current row.
4. **Conditions**, against the writer's state at this point in its log.
5. **Ops**, which compute the value to append.

A refusal is not appended. A retried refused write is judged afresh.

| Kind | Forms | Refusal |
|---|---|---|
| conditions | `if: { absent }`, `{ present }`, `{ version: v }`, `{ equals: x }`, `{ fence: { lock, token } }`, `{ expired: 'lease' }` | `conflict`, with the current version |
| ops | `incr(n, { min, max })`, `push(x)`, `merge(obj)`, `max(x)`, `min(x)`, `touch` | `conflict` when a bound fails |
| claim | `claim({ partition, n, where, lease })`: the first `n` unclaimed rows of a partition matching `where`, leased from `t` | `empty` |
| batch | many records to one partition: all or none | the first refusal |

**Appending results.**
- The writer appends only results. Followers, subscribers and replays apply plain values and never re-run a condition, op or rule. So writer-side user code may be non-deterministic.
- That code (`rules.write`, `where`, `partition`) runs on the kernel thread, loaded from the resource's code by hash.
  - It must be synchronous, and runs under a time budget (10 ms; a `vm` timeout in TypeScript).
  - The `vm` call's cost is a phase 2 pin against the 3 µs conditional-op target. If it breaks the pin, rules run unguarded, and a watchdog quarantines any rule that holds the kernel thread past the budget.
  - Rules are pure functions of the peer, the record and the current row. By design, they cannot read app state.
  - Because the budget cuts a rule off at 10 ms, a heavy rule delays the kernel thread's heartbeat by at most that.
  - A throw refuses the write `rule-threw`; a timeout `rule-timeout`. A rule that keeps timing out is quarantined until an `alter`.
- `load` is asynchronous, off the append path, and lands as an ordinary write.
- Every computed value is checked for encodability and size before it is appended.

**Two states on the writer.**
- The *committed state* is the fold up to the committed point. Readers and subscribers see it.
- The *log-end state* adds the uncommitted batches in flight. Dedup, rules and conditions are judged against it, and answers wait for commit.
- A new writer starts from the committed state of the recovered loglet, so it has no overlay to drop.

**Row retention** (3.1) runs on the writer's tick, as records with a reason.

**The fold** is data's: records apply through its hot lane in offset order, the same on writers, followers, clients and replays, with no LWW comparison anywhere.

### 4.4 L3: flow

One verb serves followers, clients, relays, consumers and the viewer: **subscribe**, with a selector, a mode and a cursor.

| Part | Values |
|---|---|
| selector | `resource`; `partitions: [...]` (a follow set); `prefix`; `view` (a server-side view, 4.5); `shard` (servers and relays) |
| mode | `state`: a snapshot, then deltas, conflated per row for a slow reader. `log`: every record from the cursor, never conflated |
| cursor | the cluster id, the resource's incarnation, then per shard its incarnation, the offset last seen, and (for a `none` resource) the writer's epoch; or `'latest'`, `'earliest'` |

- **Who serves.**
  - Any server that folds the shard: its writer, or a follower. Always up to the committed point, and never before its fold has reached the subscriber's cursor.
  - Standbys fold by tailing the log nodes (4.2), and read the object store for older offsets.
  - A follower that falls behind the tail and reloads a snapshot ends its `log` subscriptions on that shard with `expired`, and re-snapshots its `state` subscriptions.
  - A one-shot read at a server that neither folds nor relays the partition is refused `moved`, with the current writer. A relay answers only after its upstream snapshot has landed, never from an empty fold.
  - A server that stops folding or relaying a partition ends that part of each subscription with `END` and the cursor, so the subscriber resubscribes elsewhere and never waits on a silent server.
  - A server asked for a partition it does not fold subscribes upstream itself, and becomes a relay for it.
- **Cursors know their log.** A cursor whose cluster id, resource incarnation or shard incarnation does not match is refused `unknown-log`. Past retention, `expired` with the earliest available.
- **A snapshot replaces.** It replaces the subscriber's whole view of the selected partitions, applied as one diff between begin and end markers, so ghost rows cannot survive and nothing flickers.
- **Deltas carry their offsets**, so a filtered subscriber's cursor is exact.
- **Credits.**
  - A subscriber grants credit in bytes, and a grant always admits at least one record.
  - A `state` subscriber that falls behind is conflated per row. A `log` subscriber is paused and resumes from its cursor.
  - Every link's queue is bounded; a link that overflows is closed with its reason, and the peer returns with its cursor.
- **Routing.** A per-shard index maps partitions to subscribers: one lookup per record, plus one write per matching subscriber, encoded once.
- **Failover.** A subscriber whose server goes away resubscribes elsewhere with its cursor. `log` misses nothing; `state` gets the deltas since, or a fresh snapshot that replaces.
- **Big rows and snapshots** are cut into frames by size, between begin and end markers, so a snapshot lands as one apply.

**Writes from a client.**
- **Read-your-writes.** A write resolves when it has committed and, if this client follows the partition, its own subscription has passed the write's offset.
- **Failover.** The client resubscribes from its own cursor, and its waiting writes' offsets go along as a minimum. The new server answers only once its fold has reached them, so a resolved write is always visible and no record in between is skipped.
- **Reads after a write.** A client's reads carry the highest offset it has seen per shard, and a server answers only once its fold has reached it.
- **The pending-write queue** is bounded by count (1,024) and bytes (64 MB). When full, a new write is refused `backpressure`.

### 4.5 L4: surface

- **`fero(name, opts)`** returns the resource, as today: `data`, `methods`, `cluster`, `snapshot`, `destroy`. New:

| Call | Does |
|---|---|
| `follow(keys)` | a live view of exactly those partitions |
| `read({ from })` | log mode, from a cursor |
| `read(key, { fresh: true })` | a linearizable read: the writer appends a no-op and answers once it commits, which fails if its loglet has been sealed. It costs one commit: an fsync and a round trip |
| `set`, `update`, `remove`, `incr`, `push` | writes, with `{ if, ttl, confirm }` |
| `cluster.writes.lookup(id)` | the outcome of an attempt |

- **Honest partial views.** On a process that follows only some partitions, a sync read of an unfollowed row throws `shortfall`, and an operator over all of `data` throws `holistic`.
- **Views** are data's incremental operators.
  - A view returned from a method is served live, from the server that folds the shard.
  - Views of the same declarative shape are shared.
  - A `group` bucket can be streamed (a data change).
- **Rows handed out are immutable**, so reads by reference are safe and O(1).
- **Methods** run on the server the caller reached, as today, and `methods:` stays the door.
  - **Call keys.** A call with a key claims a row in `#calls` (with a lease) before its handler runs, and stores the result, so a finished call never runs twice within the key's TTL.
  - **Re-runs.**
    - A handler whose server dies mid-call is re-run when its lease lapses.
    - Its writes carry attempt ids derived from the call key, their order and a hash of their content. So a re-run's identical writes dedupe, and a re-run that writes something different is refused `call-diverged`.
  - **Fences.**
    - Every write a call makes carries `if: { fence: { lock: callKey, token } }`.
    - The runner renews the lease while it runs, and stops writing if its last renewal is older than the lease minus a margin (a round trip plus `skew.max`).
    - A call is re-run only within half the retry horizon. Past that it is marked `unknown`, with the offsets it wrote.
- **Rules.**
  - `validation` runs where a write first enters. A retry skips it, and the writer runs it again after dedup.
  - `rules.write(peer, record, current)` runs at the writer, with the current row.
  - `rules.read(peer, partition)` runs where a subscription is served.
- **Code on writers.**
  - The `partition` function runs only on servers.
  - Each server registers the code hashes it can run, and the controller gives a shard only to a server that has its resource's hashes.
- **Identity and security.**
  - A client presents a token signed by the cluster; `ctx.peer` carries its claims. The shared client key stays as the simplest token.
  - TLS with a cluster CA, so clients verify servers.
    - The CA key lives in the metadata only as envelopes encrypted to each voter's key.
    - Joins use single-use join tokens (`fero join-token`); fero deploy mints one per machine.
    - A client checks a server against the CA fingerprint in its own credential.
    - Each member gets its own certificate at join. A removed member's certificate is revoked in the metadata.
  - The secret rotates through the metadata: current and next, during a window.
- **`cluster.writable`** is true when every shard of the resource has a writer whose open loglet reached Q acknowledgements within `ack.ms`. `cluster.shards` details each shard, including how many copies its loglets really have.
- **Fewer log nodes than `copies`.** A loglet gets as many copies as there are log nodes, and `cluster.health` and one stderr line say so. So two processes on one box after one leaves is visibly one copy.
- **A floor.**
  - A writer never re-opens a loglet below `copies.min`: 2 by default, whenever at least two log nodes have live sessions.
  - Below the floor, the shard refuses writes with the reason, rather than shrink silently.
  - With a single log node (one process, the free tier), one copy is the stated setup.
- **Defining and changing a resource.**
  - The first `fero(name, opts)` that creates a resource writes its config to the catalog, which is the source of truth from then on.
  - A later open with different options is refused, naming the difference, unless an `alter` in progress allows its code hash.
  - `fero.alter(name, change)` changes a resource online: a roll adds the new hash before and removes the old after.
- **Config, in three scopes.**

| Scope | Lives in | Keys | Changes |
|---|---|---|---|
| node | the config cascade, as today | `uuid`, `dir`, `listen`, `advertise`, `hosts`, `voters`, roles (`server`, `log`, `voter`), `object` (the object store), `secret`, `secret.client`, `rendezvous`, `heartbeat.ms`, `redial.*`, `leave.ms`, `journal.cap`, `diag.allow`, `signals`, `memory`, `cache`, `issuer.window` | restart that node |
| cluster | the metadata | voter count, witness, default `copies`, `session.ms`, `ack.ms`, `evict.after`, `skew.max`, placement weights, cluster version | online |
| resource | the catalog | `shards` (the starting count), `copies` (E, default 3), `copies.min` (2), `quorum` (Q, a majority of E or more), `standbys` (warm followers per shard), `partition`, `history`, `rows`, `durability`, `validation`, `rules`, `methods`, `load` | online through `fero.alter`; code by allowed hash |

- **Worlds** (fero test): a bound world resolves names to stand-ins, makes server markers into solo nodes, and supplies `now` and `id`. A solo node is the same code: a server that is its own log node and voter, over a local-folder object store.

### 4.6 L5: libraries and adapters

L5 is built only from L4 calls; each library is a file with its own tests, and none adds a wire verb:
- the queue, consumer groups, locks, presence, rate limits and loaders (5.3);
- the RESP, Kafka-protocol and WebSocket gateways;
- the `fero` CLI: `run`, `test`, `deploy`, `ls`, `debug`, `recover`, `join-token`.

### 4.7 The wire

| Family | Verbs | Layer |
|---|---|---|
| link | `HELLO`, `DOOR`, `PING`, `DIAG` | L0 |
| metadata | `VOTE`, `APPEND`, `SNAPSHOT` (Raft); `SESSION` | L1 |
| loglet | `LOG-APPEND`, `LOG-ACK`, `LOG-READ`, `LOG-DATA`, `LOG-SEAL`, `LOG-SEALED` | L1 |
| writes | `WRITE`, `WRITE-ACK` | L1, L2 |
| flow | `SUB`, `SNAP`, `DELTA`, `END`, `CREDIT`, `FOLLOW`, `UNFOLLOW` | L3 |
| methods | `CALL`, `RESULT`, `SUBREC` | L4 |
| admin | `DEFINE`, `ALTER`, `RECOVER` | L4 |

29 verbs in seven families, each family owned by one layer and one published protocol.

## 5. How each pattern is built

### 5.1 The table

| Pattern | Built from | Layer |
|---|---|---|
| live shared state | a resource, `rows: true` | L4 |
| cache with expiry, session store | `rows: { ttl, max }`, `touch` | L2 |
| near cache, client data sync | `cache: { memory }`, follow sets | L3 |
| read-through cache | `load` | L4 |
| websocket fan-out by room | follow sets on relays; rooms as partitions | L3 |
| pub/sub | `history: 0, rows: false, durability: 'none'` | L2, L3 |
| stream, replay | `history: '7d'`, `read({ from })`; old offsets from the object store | L1, L3 |
| consumer groups | the groups library | L5 |
| work queue | the queue library, on the `claim` op | L5 |
| locks, leader election | the locks library | L5 |
| counters, rate limits | `incr` with bounds; rows with a `ttl` per window | L2 |
| leaderboards, live aggregates | views; across shards, mergeable partials | L4 |
| presence | `rows: { while: 'session' }` | L2 |
| invariants (stock, balances) | conditions, `rules.write`, or one partition | L2, L4 |
| transactions across partitions | locks with fencing plus an intent row (sagas) | L5 |
| event sourcing, CQRS | facts as rows, or `history: 'all'`; views as projections | L2, L4 |
| derived resources | a reader of one resource's log writing another, its cursor stored as a fenced row | L5 |
| tapes, forks, replays | section 6 | L1, L4 |

### 5.2 One example in full: the websocket rooms

```ts
const chat = await fero('chat', { partition: (k) => k.split('/')[0], history: '1d' })   // a room is a partition
const web = await fero('chat', { cache: { memory: '200MB' } })                           // a webserver: follows only its rooms
socket.on('join', (room) => web.follow(room).tap((r) => socket.send(r)))                 // snapshot, then deltas
socket.on('say', (room, text) => web.data[`${room}/${fero.id()}`] = { text, at: fero.now() })
```

- **A message** is appended once by its room's shard writer, committed on a quorum of log nodes, and delivered to the webservers that follow that room, encoded once.
- **A webserver** never receives a room it does not follow. One that reconnects passes its cursor and misses nothing within a day.

### 5.3 The libraries

- **Queue.**
  - A message is a row. `take(n)` is one `claim` at the writer: the first `n` unclaimed rows, leased from `t`, with `deliveries` incremented.
  - `ack` removes the row. A lapsed lease makes it claimable again. Past `deliveries`, it moves to `${name}.dead`.
  - FIFO per partition. Parallel workers spread over partitions, assigned by the groups library.
- **Consumer groups.**
  - The members of a group are rows with leases in `#groups`.
  - The assignment of shards to members is a pure function of the live members and the generation.
  - Offsets are rows written with a fence on the generation, so a zombie consumer cannot commit.
- **Locks.**
  - A lock is a row in `#locks`, claimed with `if: { absent }` or `{ expired: 'lease' }`. Its token is the claim's version.
  - Protected writes carry `if: { fence: { lock, token } }`. Each shard keeps the highest token seen per lock, in its state, and its children inherit it at a split.
  - A lock records the offsets its holder wrote at, so the next holder's reads can carry them as minimums.
- **Transactions across partitions** (sagas: readers can see the intermediate states).
  1. Take the locks in key order.
  2. Write an intent row.
  3. Apply each step with a fence.
  4. Remove the intent.

  A later holder that finds an intent finishes it.
- **Presence.**
  - A session is a row in `#sessions` with a lease the client renews.
  - Rows written `while: 'session'` carry its id.
  - Each shard's writer follows `#sessions` and removes a lapsed session's rows.

## 6. fero test and fero deploy on v5

### 6.1 fero deploy

**What the log-first shape changes for the platform.**
- **The copies of the data live on the shared log tier and in S3, not on the project's servers.** So a project's servers (its "copies" in the deploy doc) are disposable compute, chosen for clients and CPU alone.
- **Durability is the same at every tier.** The free tier's single server writes to the same three-copy log tier as a paid project.
- **Sleep and wake.** A sleeping project has no servers. Waking loads snapshots from S3 and opens new loglets: about a second for a small project.
- **"Two copies are refused" stops mattering.** Servers can be one, two or ten; the data's copies are the log tier's business.

**The fourteen needs.**

| # | Need (from "fero deploy: the journey") | On v5 |
|---|---|---|
| 1 | the `fero` command and the npm build | L5 |
| 2 | `file`, `scale`, `size` from the file | node-scope config |
| 3 | a box directory that lists names, runs and folders | unchanged; one project is one cluster |
| 4 | a caught-up signal | a server is caught up when it is a warm follower of every shard it is meant to take: `cluster.me.caughtUp` |
| 5 | a full restart, and a restart after one-by-one stops | servers hold nothing durable; restart-all is servers stopping and starting, and the log tier never stops |
| 6 | a joining copy skips its seed | a seed is applied once, when the resource is created |
| 7 | listen and advertised addresses apart; bracketed IPv6 | the member record holds both |
| 8 | TLS for clients, one public address | L0 transport and the cluster CA; clients route through any server |
| 9 | a client leaves a server whose writes are shut | `moved` and `cluster.writable` say so; the client moves |
| 10 | the supervisor sets the secret over the call | a supervisor layer above the call |
| 11 | a new version's contract reported before it joins | the allowed-hash list: the deploy adds the hash first |
| 12 | no deleted row comes back | structural: one log per shard; removal markers live only inside snapshot layers, merged in order on one machine, never collected across copies as v4's tombstones were; snapshots that replace |
| 13 | refuse writes with a reason while reads go on | the resource's write gate (unpaid); a server memory bound (near full) |
| 14 | group commit | the log nodes' journal |
| later | rolling a contract change | allowed hashes over normalised source |
| later | state larger than memory | cold rows read through from snapshot layers |
| new | moving a v4 `dir` to v5 | `fero migrate`: v4's WAL and snapshot become one v5 snapshot per shard |

**A roll on v5.**
1. Server 1 hands over each shard it writes to a warm follower: a few milliseconds each.
2. It restarts on the new files and loads its shards as a follower.
3. When `caughtUp` says so, the next server goes.

Clients see at most a pause of one handover per shard.

### 6.2 fero test

| # | Piece | On v5 |
|---|---|---|
| 1 | the world in `fero()` | a solo node is the whole stack in one process: server, log node and voter, over a local-folder object store and the in-process transport |
| 2 | the clock and ids | writer time under the world's clock; `fero.id()` from the world's seed |
| 3 | input keys | call keys in `#calls` |
| 4 | `fero test` as a verb | L5 |
| 5 | components ship their stand-ins | unchanged |
| 6 | the test block in the viewer | captures carry offsets, so inputs, records and asks line up |
| 7 | the spec and the layout | unchanged |
| 8 | the store: forks, versions, proposals | **a fork is a new chain whose first loglet points at the parent's snapshot at an offset**: loglets and snapshots are immutable, so a fork costs one metadata record |
| 9 | the tape at the live edge | a resource with `history: '14d'` and rows keyed by match key |
| 10 | the ai component and `fero change` | unchanged |
| 11 | app steps in the simulator | methods run as sim steps against L0 to L3, under the same seeds |

## 7. The backtest, summarised

**Before this draft.**
- Four agents catalogued 1,313 hard cases from v4's records, judged them against the first draft, and re-judged against the second.
- The third draft answered the 39 still open, and an independent reviewer signed off.
- The verdicts per case are in [v5-backtest/](v5-backtest).

| Source | Rows | Gone | Same | n/a | Open (draft 1) | Closed (draft 2) | Decision | Phase 5 | Still open (draft 2), answered in draft 3 |
|---|---|---|---|---|---|---|---|---|---|
| DECISIONS | 414 | 131 | 190 | 46 | 47 | 40 | 1 | 0 | 6 |
| STATUS, LEAVE, DOOR | 306 | 106 | 123 | 19 | 58 | 34 | 6 | 0 | 18 |
| SCALE, M6, M7, CHECKPOINT | 259 | 121 | 58 | 43 | 37 | 30 | 1 | 2 | 4 |
| HISTORY, DIRECTORY, CONFIG, monitors | 334 | 68 | 184 | 28 | 54 | 38 | 4 | 1 | 11 |
| **Total** | **1,313** | **426** | **555** | **136** | **196** | **142** | **12** | **3** | **39** |

**The log-first rewrite.**
- The same four agents re-judged every case whose answer touched L0 or L1 (876 of the 1,313) against the rewrite: membership, leave, eviction, handover, durability, client failover, discovery and scale. Answers in L2 to L5 carried over.
- They also compared each case's answer with the earlier one: better, the same, or worse.

| Source | Re-judged | Gone | Same | n/a | Open | Better than before | Worse than before |
|---|---|---|---|---|---|---|---|
| DECISIONS | 269 | 129 | 136 | 1 | 3 | 29 | 3 |
| STATUS, LEAVE, DOOR | 208 | 103 | 102 | 0 | 3 | 30 | 4 |
| SCALE, M6, M7, CHECKPOINT | 182 | 88 | 77 | 12 | 5 | 13 | 3 |
| HISTORY, DIRECTORY, CONFIG, monitors | 217 | 60 | 145 | 0 | 12 | 19 | 11 |
| **Total** | **876** | **380** | **460** | **13** | **23** | **91** | **21** |

**What got better.**
- A server crash no longer costs a copy of the data.
- Restart-all comes back in any order, with no eligible-leader rules.
- Moves, transfers and catch-up pins are gone.
- Read-your-writes holds across failover.

**What got worse.**
- Failover went from about 0.6 s (draft 2) to 2.2 s. That is the GC-safe `session.ms` (4.2), still half of v4's.
- The rest were the 23 open cases below, now answered.

**The 23 open after the rewrite, and this draft's answers.**

| Rows | The case | Answer (section) |
|---|---|---|
| S-059 | a log node's leave is bounded by `leave.ms` but must wait for its loglets to be covered | it stays as a draining log node until covered; a forced stop is a restart (4.2) |
| S-065 | a server could redial an address a client claimed | servers dial only members the metadata names, `hosts` and the directory (4.2) |
| S-095, H-024 | a hung main thread keeps its session, since heartbeats come from the kernel thread | the kernel's watchdog answers calls `busy`; shards keep being written (4.2) |
| C-016, C-017 | resubscribing with a raised cursor skips records | the waiting writes' offsets go along as a minimum, not as the cursor (4.4) |
| C-060 | a follower that reloads a snapshot leaves its subscribers stale | it ends `log` subscriptions `expired` and re-snapshots `state` ones (4.4) |
| C-142, H-112 | a truncated copy, or a lying disk, counts toward recovery and loses a committed batch | damaged copies do not count; recovery reads every reachable copy and waits up to `recovery.wait`; the residual case is named (4.2) |
| C-220 | `quorum` below a majority breaks the durability promise | Q is a majority of E or more, never less (4.2) |
| D-036 | dedup state never forgets an issuer | an issuer silent for the horizon is forgotten, from memory and snapshots (4.3) |
| D-075, H-064 | the last voter's leave, and example 01's crashes | the last voter hands its vote over first; example 01's four cases are spelled out (4.2) |
| D-407 | a relay answers from an empty fold | a relay answers only after its upstream snapshot lands; otherwise `moved` (4.4) |
| H-052 | a stale `cluster-id` file strands new processes | wiped dirs make the file stale, so a new cluster is founded and said; otherwise wait and say, or `recover` (4.2) |
| H-055 | two cluster ids never merge | by design; both refusals name both ids and the fix (4.2) |
| H-089 | merges do not inherit dedup outcomes or fences | merges of empty shards combine both; data merges are phase 5 (4.2) |
| H-125 | a loglet re-opened with fewer log nodes shrinks to one copy silently | `copies.min` (2); below it the shard refuses writes with the reason (4.5) |
| H-128 | a snapshot on a local folder in a multi-box cluster is a single copy | across boxes without an object store, snapshots go to E log nodes; a local folder is for one box only (4.1) |
| H-134, H-138 | snapshot layers without removal markers resurrect removed rows | layers carry removal markers, applied and merged in order (3.4) |
| H-160 | a server that stops serving a partition goes silent | it ends that part of each subscription with `END` and the cursor (4.4) |
| H-236 | a parked dialer never retries | it retries at v4's slow heartbeat revival (11) |
| H-254 | the directory refuses a restarted identity in the same process | keyed by life; accepted once the earlier link closes (11) |

The per-case files in [v5-backtest/](v5-backtest) carry each case's latest verdict: the log-first one where it was re-judged.

## 8. Performance, layer by layer

Each row is a target, how it is reached, and the bar to beat, measured with the competitor's own tool on the same box, under fero's never-widen rule. "TS" is the TypeScript kernel (phases 2 to 4); "native" is the Rust core (phase 5).

| Layer | Measure | Today (v4) | TS | Native | How | Bar |
|---|---|---|---|---|---|---|
| L0 | persisted appends per log node | about 250/s | 50k/s | 500k/s | one journal, one fdatasync per ≤ 1 ms batch, `writev` | BookKeeper, Kafka per broker |
| L1 | appends per shard writer | 14k/s through the api, 73k/s raw | 150k/s | 2M/s | pipelined, batched across shards per log node link | Redpanda |
| L1 | commit latency, p99, persisted | — | fsync p99 + 2 ms | fsync p99 + 0.5 ms | send to E log nodes at once, commit at Q; when the writer is also a log node, its own fsync runs in parallel | Kafka acks=all, BookKeeper |
| L1 | planned handover (a roll step) | — | 20 ms | 5 ms on NVMe; about 15 ms on a disk with 4 ms fsyncs | three fsyncs in a row (the last commit, the seal, the metadata entry) and a warm follower | — |
| L1 | failover to writable | about 4 s | 2.2 s | 1.1 s | `session.ms`, then seal, recover and swap (a few ms) | KRaft (9 s default) |
| L1 | adding a server, per GB of its shards | v4: about 7 s per GB, copied from peers | 10 to 20 s from S3 in one stream; 2 to 5 s with parallel reads | the same | snapshot layers read in parallel; the tail from log nodes | — |
| L1 | idle traffic, n = 100 | about 20k frames/s | under 3,000 frames/s | the same | sessions to the controller (about 2,000 frames/s); one idle ping per loglet after its last batch, then silence | — |
| L2 | fold per record | about 10 µs | 2 µs | 0.2 µs | header-only decode, no per-record objects | — |
| L2 | conditional op at the writer | none | 3 µs | 0.5 µs | lookup and compare in the append path | Redis INCR server time |
| L3 | fan-out per relay core | about 9k/s (about 110 µs per relayed record) | 100k deliveries/s | 3M/s | per-shard index, encode once, `writev` | NATS core |
| L4 | read of a held row | in-process | under 100 ns | the same | immutable rows | Redis GET: a network round trip |
| L4 | method call, caller is the writer | — | 10 µs | 5 µs | in-process | Redis Lua |
| L4 | `fresh` read | — | one commit | one commit | a no-op append | etcd's linearizable read |
| L4 | view update per change | 5,000 filter views: about 500 µs a write | 1 µs per affected view | the same | shared declarative views, `group` routing | — |

**Where fero can win outright:**
- reads of held rows;
- ops whose caller is the writer;
- fan-out that carries state;
- scaling compute without moving data;
- running one system instead of three.

**Where it should match:**
- raw log bytes per disk and network card;
- commit latency, which costs one fsync plus one round trip to the log nodes, as any replicated log does.

**What the log-first shape costs:**
- When log nodes are separate machines, a write takes one more network hop than when the writer is itself a copy. That is about 0.1 to 0.3 ms in one region.
- A cold server takes seconds per gigabyte to start, which warm followers hide.

**What carries the targets:**
- **Bytes end to end.** Batches stay encoded from writer to log node to follower, and only the fold decodes.
- **No work per view per record.** Shared `group` routing: one lookup per record, not one predicate per view. Measured on v4: 5,000 filters cost 450 to 510 µs a write; one `group`, 10 to 20 µs.
- **Nothing on a timer that grows with data.** v4's compaction rescans every large lane each heartbeat (43% of CPU in a two-member run; a separate task is queued). In v5, retention seals and uploads whole loglets.
- **Group commit on log nodes.**

**Measuring.** On a pinned quiet runner:

| Against | Tool |
|---|---|
| Redis and Valkey, through the RESP gateway | memtier |
| NATS | `nats bench` |
| Kafka, Redpanda, Pulsar | the OpenMessaging Benchmark |
| etcd, for locks | etcd's benchmark |
| reads, views and fan-out | fero's own pins |

**TypeScript first, native next.**
- L0 to L3 are a deterministic machine behind one interface. Build them in TypeScript under the simulator, then in Rust behind the same interface, and compare effects byte for byte under the same seeds.
- In TypeScript, a server's kernel runs on a worker thread (decision 13). It owns the rows in a compact form, and the main thread holds an immutable projection of the rows the process reads or serves views over.
- Log nodes need no JavaScript at all. Natively, a log node is a small, separate program.

## 9. Measured today

Measured on `main` (d7c9efe) on this session's container (Node 22, a cloud VM). These locate costs; they are not a baseline.
- GitHub's data `v4` branch is at 63fea66, which is SCHEDULE_VERSION 4. fero's `main` needs 5, so two rows marked *data 63fea66* may differ on the newer data.
- The full battery could not run faithfully here: 50 failures in its first 196 tests, so it was stopped.

| What | Result |
|---|---|
| 100k writes, solo node, through the api | about 62k/s; GC 14%, `kernel/node.ts apply` 10%, outcome bookkeeping about 11% |
| 100k writes, two members, seen on the second | about 14k/s; 43% of CPU in compaction's `winner` |
| per-write cost with K live room views (*data 63fea66*) | 5,000 filters: 450 to 510 µs; one `group` of 5,000 buckets: 10 to 20 µs |
| a client that opens one room's server view | holds all 1,000 rows; its room mirror held 10 |
| a method that streams one `group` bucket (*data 63fea66*) | refused by data |
| two claims via `validation` reading local state | both committed, both told `ok` |
| a check-then-set method, both calls on the owner | second refused ✓; elsewhere, both `ok` |
| persisted writes (STATUS, platform spike R3) | about 250 a second per member |

## 10. Keeping development fast

### 10.1 What slowed v4

| Measure (on `main`, October 2026) | Value |
|---|---|
| commits | about 700: fix 225, docs 215, test 156, feat 51, perf 20 |
| lines added | tests and sim +31.0k; site +37.7k; docs +12.5k; kernel, api and shell +10.2k |
| the tree | 9.1k lines of kernel, api and shell code, with 6.9k lines of comments in them (43%); 38.5k lines of tests and sim; 15.6k lines of docs |
| open bugs in STATUS | 15 (5 Oct), 29 (10 Oct), 40 (15 Oct), 34 (22 Oct) |
| DECISIONS.md | 1,338 lines to 2,995 |
| review rounds | lanes of four, seven and eight rounds |
| also | reviewer capacity limits; parallel sessions that collided; no CI and no pinned runner; fero's `main` needs data commits not on GitHub |

**Why.** The open bugs sit where several mechanisms meet: tombstone GC and compaction and a short lane; a shed and a paused link and a resync; a leave and a stalled survivor. Five causes:
1. **Many novel mechanisms that interact.** Each new one had to be proven against all the others.
2. **Protocols with no literature.** The pp floor law, the teacher latch, FEED words, the knock window, held members.
3. **Proof by discovery,** by sweeps and reviews after the code exists.
4. **Many documents per change.**
5. **One kernel-wide golden trajectory,** which any rule change moves.

### 10.2 What keeps v5 fast

1. **Published mechanisms, each in one layer.**
   - L1 is Raft, BookKeeper's loglet and Delos's chain: three published designs, two with public TLA+ specifications (Raft's; Vanlightly's of BookKeeper).
   - Gone: lanes, stamps, digests, tombstones, compaction frontiers, orphans, sheds, latches, teachers, floors, FEED words, in-sync sets and eligible leaders.
   - The new mechanisms are not only in L2 and L3 (the log-end overlay, budgeted dedup, per-row conflation, snapshot-replace, the read-your-writes wait, writer time and fences).
   - Log-first adds some in L0 and L1 too:
     - split lineage in the chain;
     - cursors resolved through it;
     - snapshot layers with removal markers, and their coupling to loglet retention;
     - the composition of Raft, loglets and chains with sessions and placement. Delos has no public TLA+, so that glue is fero's own to model.
   - All of these get models (point 2), and merges of shards that hold data wait until phase 5.
   - L1 is about twice the code of Raft per shard (V5-LOG-FIRST-REVIEW), and phase 2 is bigger for carrying scaling. That is the price of designing scaling in now rather than bolting it on.
   - Each layer's doc opens with its mechanism list. Adding one means naming what it replaces, or why it cannot be a library.
2. **Check every layer against a model before code.**
   - **L1 in TLA+, as three specs that compose.**
     - Raft is trusted from its published model, plus Ongaro's fix.
     - The loglet starts from Vanlightly's BookKeeper spec.
     - The chain and its compare-and-swap follow Delos.
     - Checked exhaustively at small sizes: 3 log nodes, 2 shards, 2 servers, crashes, partitions, restarts, power loss, a lying disk, a split during recovery, snapshot layers against loglet deletion, and an object store that is slow or down.
   - **L3 in TLA+:** cursors (including their resolution through split lineage), snapshots that replace, credits, failover.
   - **L2 against a reference model:** a 200-line sequential interpreter of records, conditions, ops and dedup, run against the code on random sequences.
   - **The simulator checks the code against the specs** by replaying each seeded run through them (trace validation).
3. **Layer contracts.** Each layer has an interface, an invariant list, and a suite that runs in under 30 seconds. The full battery runs in CI. Golden trajectories are per layer.
4. **Monitors are tested.** Each has a mutant it must catch, and counts how often it armed; a monitor that never armed is reported as vacuous.
5. **One current doc per layer,** edited in place. DECISIONS records at ten lines or fewer. STATUS one line per item. Comments say why. The site's claims come from tests.
6. **Lanes with a stopping rule.**
   - Each lane has acceptance criteria written before it starts.
   - Reviews continue while a round finds a critical, and stop at the first that finds none.
   - Findings outside the lane become one-line STATUS items with a failing seed.
   - One integrator merges, and ids are assigned at merge.
7. **Bug intake.** Every bug arrives as a failing seed or test, tagged with its layer and invariant. The preferred fix removes a mechanism.
8. **A swamp guard.** If open bugs grow for two weeks, or a lane passes four rounds, stop and re-plan.
9. **CI from day one,** with each repo pinning the other's commit.

## 11. The plan

Scaling is built in phase 2, with the kernel, not bolted on later. Each phase ends on a test, not a date.

| Phase | Builds | Done when |
|---|---|---|
| 0. Decide | section 12; v4 frozen for features (deploy-blocking fixes only); CI and a pinned runner; data's commits pushed | decisions recorded; CI green on v4 |
| 1. Specify | the L1 TLA+ specs (Raft composition, loglet, chain), the L3 spec, the L2 reference model; the L0 to L4 interfaces; every backtest case as a named test | the model checker is green; every case has a test name |
| 2. The log | **The simulator first:** v4's executive gains node kinds (servers, log nodes, voters) and an object store whose calls complete as sim events. Then L0 (log node journal and entry store, the object-store interface with its local-folder version, snapshots on log nodes) and L1 (metadata Raft, loglets, chains, handover, failover, sessions, simple placement) in TypeScript, with v5 monitors and trace validation | 1,000-seed sweeps green with servers and log nodes joining, leaving and crashing; kill -9 of everything, and a simulated power loss, lose no persisted write; the follower read path measured; the L0 to L2 TS pins |
| 3. Surface | L2, L3 and L4 (v4's api ported: data binding, methods, door, config, rules, identity); the carried v4 bugs fixed; prototypes of the queue, groups and locks libraries | examples 01 to 44 pass; every backtest case passes or is marked not applicable with its reason |
| 4. Platform | the S3 object store; separate log nodes and the hosted log tier; **splits, load-aware placement and pacing; the witness**; sleep and wake; worlds, call keys, tapes, forks, caught-up, rolls; TLS and the CA; `fero migrate`; the npm build | the café from "fero test" runs on v5; fero deploy milestones 1 and 2 run against a local log tier with an S3-compatible store |
| 5. Native and reach | the Rust L0 to L3 (and a native log node) behind the same interface; merges of shards that hold data; relays; `rules.read`; mergeable views across shards; the finished libraries; the RESP, Kafka and WebSocket gateways | every row of section 8 is a green pin in the native column, on the pinned runner |

**The carried v4 bugs, fixed in phase 3.** These are in parts v5 keeps, each fixed with its failing test first:

| Bug | Fix |
|---|---|
| S-055, S-056, H-265: a lost refusal, or a client with a member's uuid, redials for ever | the refusal is a TLS alert or a reasoned close; a dialer that sees the same refusal twice parks, and retries only at the slow heartbeat revival v4 already has, with one line saying why |
| S-068, S-117: arrays with named fields, and explicit `undefined`, differ after a snapshot | named fields on arrays refused at the write; snapshots use the record codec |
| S-071, S-072, S-073: views leak or are released while held | views belong to a scope; release by scope, never by GC |
| S-074: a tap that writes on every change runs to data's cap | a tap-issued write more than 100 links deep is refused `tap-loop` |
| S-080: `reduce` with a Map or Set never re-emits | data compares non-plain accumulators by version |
| S-093: a throw between the dir lock and the runtime leaves it locked | try/finally |
| S-094: hosts are not checked for characters | RFC 1123 names and IPv6 literals only |
| S-125: `secret.client` accepts any 16+ characters | exactly 43 base64url characters |
| S-128, H-299: config coerces a numeric uuid; a variable clobbers another subtree | optcascade gains a strings list and per-subtree merges |
| S-292: a local process can hide directory entries | entries keyed by project, run, member and life; a duplicate is refused while the earlier holder's link is open, and accepted once it closes, so a restart in the same process re-registers |

**Real-disk and real-network tiers** run from phase 2, including power-loss runs on LazyFS (a filesystem that loses unsynced writes, as Jepsen uses).

**What carries over from v4.**
- The codec and frames.
- The simulator, the shrinker and the debugger (captures gain offsets).
- The journal.
- The door, the directory and the config cascade.
- The data engine and the method plane.
- The examples and their checks.
- The perf harness.
- The ring, as the placement policy.

**What is replaced.** The kernel's log, streams, scope, most of write, membership (by Raft) and confirm (by quorum commits); FEED words, digests, tombstone GC and compaction.

## 12. Decisions for you

Reply "defaults" to take every pick, or name a change ("3b").

1. **Replace v4's kernel.** a) v5's kernel under v4's api and tools, v4 frozen for features (my pick). b) Evolve v4 one mechanism at a time.
2. **The shape of L1.** Two independent reviews compare these: [V5-REPLICATION.md](V5-REPLICATION.md) and [V5-LOG-FIRST-REVIEW.md](V5-LOG-FIRST-REVIEW.md).
   - a) **The log first** (this draft; my pick).
     - Durability is on log nodes and object storage; servers are disposable; storage scales on its own.
     - The reviewer: choose it "only if fero deploy is the primary product".
     - The cost: about twice the L1 code (10 to 11k lines against 5 to 6k), a third protocol to model, and a storage tier to operate. Its conditions for phase 1 are met in this draft.
     - My reason: fero deploy, fero studio and agents are where fero is going, and they are where this shape wins (6.1).
   - b) **Raft per shard, with servers as the copies.**
     - One protocol and one node kind: cheaper and simpler below the hosted tier, never-cold failover, and free follower reads.
     - But scaling servers moves their data, and durability depends on how many servers run.
   - c) Kafka's in-sync sets under a controller (the earlier drafts).
3. **Language.** a) TypeScript first, Rust behind the same interface in phase 5 (my pick). b) Rust from the start.
4. **Durability.** a) `persisted` (a quorum of log nodes on disk) and `none` only (my pick). b) Also `committed`, acknowledged before fsync.
5. **One cluster per project.** a) Resources are catalog entries (my pick). b) One cluster per resource, as v4.
6. **What Ctrl-C, SIGTERM and `destroy()` do.** a) `leave`, and `restart` under `FERO_SUPERVISED` (my pick). b) Always `restart`.
7. **Defaults.**
   - a) My pick:
     - 16 starting shards, then split and merge;
     - `copies` 3 with a majority quorum, or as many log nodes as there are when fewer;
     - `standbys`: every server, up to 5;
     - one voter, or 3 once there are three members;
     - a 100 ms tick, `session.ms` 2 s, `ack.ms` 1 s (200 ms native), `evict.after` 10 min;
     - `history: 0`, `rows: true`.
   - b) Name your own.
8. **Where log nodes run when self-hosting.** a) In the same processes as the servers, by default, with separate log nodes as an option (my pick). b) Always separate.
9. **The object store outside fero deploy.**
   - a) Optional (my pick):
     - a local folder on one box;
     - S3 when configured;
     - across boxes without one, log nodes keep sealed loglets and snapshots.
   - b) Required everywhere: simpler code paths, but local dev needs an S3-compatible store.
10. **The witness.** a) Supported from phase 4, run on a third failure domain, since two-machine self-hosting needs it (my pick). b) Earlier, in phase 2.
11. **When a frame leaves.** a) At the end of the event-loop turn that made it (my pick, as v4). b) Send a turn's first small frame at once.
12. **Streaming method results.** a) Stream a method's returned view, `move` records carried (my pick). b) Snapshots only.
13. **Where the TypeScript kernel runs.** a) On a worker thread, with user code on the main thread (my pick). b) On the main thread, as v4.
14. **A field write to a missing row.** a) Refused `absent-row` (my pick). b) It creates the row.
15. **fero deploy before v5.** a) Build deploy milestones 1 and 2 on v4 now, then move to v5 at phase 4 (my pick). b) Wait for v5.
16. **The development rules of 10.2.** a) Adopt them for v5 from phase 1 (my pick). b) For v4 too, now.
17. **Hosted metadata.** a) One metadata group per log-tier cell, with a namespace and quota per project (my pick). b) One group per project.
18. **How standbys read.** a) They tail the log nodes, as Pulsar's readers do (my pick, measured in phase 2). b) The writer pushes to them.

## 13. The reviews

**The third draft (servers as copies, Kafka's in-sync sets).** An independent reviewer reviewed it three times, and signed off on phase 1.

| Round | Verdict | What it found | What changed |
|---|---|---|---|
| 1 | "Not as it stands. The L1 skeleton is sound and well chosen" | answers before commit; fences compared across shards; call re-runs; seven significant points | answers held until commit; fences per lock; content-hashed calls; and the rest |
| 2 | "Closer, and the L1/L3 skeleton now reads as sound" | fenced lives never un-fenced; a per-shard dedup window double-committed; two members read-only | session epochs; a global issuer window and a floor; `minInSync` 1 at two copies |
| 3 | "With those two edits I sign off on phase 1" | dedup outcomes kept by commit order; a retired epoch read unpinned | outcomes kept by id; a boot record pinning the read |

What it said to keep, all of which this draft keeps:
- one log per shard, with offsets as versions, removals as records, and history, rows and cache as separate knobs;
- appending only results;
- cursors with a log identity, snapshot-replace and per-row conflation;
- TypeScript first behind a deterministic interface.

**The replication question.** A second reviewer compared Kafka's shape, Raft per shard, ring-computed views and a shared log ([V5-REPLICATION.md](V5-REPLICATION.md)). It recommended Raft per shard, and called the shared log "the right hosted evolution, later". This draft takes the shared log now, because scaling was meant to be designed in from the start.

**The log-first rewrite.** The second reviewer critiqued it ([V5-LOG-FIRST-REVIEW.md](V5-LOG-FIRST-REVIEW.md)).
- **Its verdict:** "the skeleton is sound: seal-then-CAS is the right fence", the same shape as Neon's safekeepers and Pulsar over BookKeeper. But not ready for phase 1 as written.
- **Its recommendation:** choose log-first "only if fero deploy is the primary product", accepting about twice the L1 code, a third protocol and a storage tier to run. Otherwise, Raft per shard.

Its eight conditions for phase 1, and this draft's answers:

| Condition | Answer |
|---|---|
| the recovery rule: unknown is not absent; the committed point on a sealed, unclosed loglet; every close a CAS | 4.2, the loglet protocol, written as TLA+ properties |
| one reconfigurer per loglet | the writer changes log nodes; the controller changes writers (4.2) |
| splits recorded at the recovered end; merges cut | splits are the writer's act, or recovery's end; data merges in phase 5 (4.2) |
| the retention rule for snapshot layers | deletion needs a merged base, no reader, no fork or child, and `history` (4.1) |
| the follower read path decided | standbys tail the log nodes; measured in phase 2 (4.2, decision 18) |
| the witness's failure domain, and the hosted metadata | a third failure domain (4.2); one group per log-tier cell (4.2, decision 17) |
| "no data moved" said truly | 4.2, "what moves, and from where", and the stated limits |
| L-cases for the new sequences | V5-BACKTEST L-28 to L-37 |

**The sign-off review of the log-first draft.** The reviewer who signed off on the third draft reviewed this one fresh.
- **Its verdict:** "No, by two edits", both one sentence:
  - a "no" counts toward a batch's absence only from a copy that has recorded the seal;
  - the per-issuer highest call id is shard state, carried in snapshots.
- **Also asked for:** §1 qualified, so that durability never depending on servers is said only for a separate log tier.
- **Then:** "With those two, and §1 qualified … I sign off on phase 1 starting from this document." All three are made.
- **Its four further items,** due before phase 2, are made too:
  - `copies.min` counts log nodes with live sessions;
  - `ack.ms` is 1 s in TypeScript and needs three misses or a closed link;
  - the committed point is sent the moment a commit lands;
  - splits and the witness move to phase 4, with the simulator's new node kinds budgeted in phase 2.
- **What it confirmed holds on this L1:** the dedup floor and global window; fences per lock; call re-runs; read-your-writes; cursors; and "no answer before commit" composed with recovery.
