# fero v5: one log per shard, Raft for each

A design, a plan and a backtest for the next fero, against `main` at d7c9efe (v4, 1,216 tests) and data at 63fea66. Nothing here is built.

**What this draft changes.**
- The last draft put the log first: log nodes, loglets, chains and a metadata Raft group, with servers on top. That was three protocols, about twice the code ([V5-LOG-FIRST-REVIEW.md](V5-LOG-FIRST-REVIEW.md)).
- This draft uses **one protocol, Raft, once per shard**, as CockroachDB, TiKV and Redpanda do. The cluster's own facts are one more shard. There is no separate metadata group and no outside store.
- **Every resource starts as one shard**, which is one Raft group, and splits as it grows. So a small project runs as plain Raft, and a big one is many groups, with no second mechanism.
- **The cluster heals itself.** Each shard's leader keeps its own replicas where a ring says they belong. An optional **planner** (the `fero` CLI, or fero deploy's platform) sends hints, and each shard checks them against its own log, so a stale planner cannot break anything.
- **Two kinds of replica.** A full replica is a server: it folds rows and can lead. A log replica keeps the log only. Log replicas let two machines survive a crash with a witness, and let fero deploy keep its servers few and disposable.
- Scaling up and down is designed in from the start, not added later.
- Everything above the log carries over (sections 3, 4.3 to 4.6, 5): ops, subscriptions, methods, libraries. It only ever needed one writer per shard, with an ordered log.

**How it was checked.**
- v4's DECISIONS, STATUS, design records and HISTORY were catalogued into 1,313 hard cases, plus 102 invariants, 36 monitors and 20 SCHEDULE clauses ([V5-BACKTEST.md](V5-BACKTEST.md)).
- Four agents judged the earlier drafts against every case. An independent reviewer signed off on the third draft and on the log-first draft (section 13).
- This draft's L1 is re-checked against the cases that touch it, and reviewed afresh (sections 7 and 13).

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
  - Every shard is a small Raft group: three voting replicas by default. Its leader is the shard's only writer.
  - A write counts once a majority of the shard's voters has it on disk.
  - The cluster's facts (members, resources, where shards are) are one more shard, `#meta`.
  - Snapshots and old log go to object storage when there is one.
  - Section 4.
- **Who decides what.**
  - **Safety** is each shard's Raft. Nothing outside it can make two writers commit.
  - **Healing** is each shard's leader, by one rule: keep its replicas where the stored placement, or else the ring, says.
  - **Plans** come from an optional planner, as hints each shard checks.
  - Section 4.2.
- **Scaling, up and down.**
  - Each resource starts as one shard. Shards split by size and load, and a split copies nothing: both children start on the parent's replicas.
  - A new server gets about `copies`/n of all replicas from the ring. Each is a snapshot from the object store (or from the leader) plus a short tail.
  - Durability depends on each shard's voters, not on how many servers run. Log replicas can be voters when servers are few.
  - Limits remain, said plainly in 4.2:
    - one partition is one writer;
    - a server that becomes a replica copies that shard.
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
  - L1 is one published design, Raft, run once per shard, with the engineering multi-Raft systems publish: one journal per process, batched messages, and quiet idle groups.
  - Everything a pattern needs above L2 is a library.
- **Development speed.** v4's October went 15, then 40, then 34 open bugs over about 700 commits, because many novel mechanisms interact. v5 uses fewer novel mechanisms, each checked by a model checker before code, and L1 is one protocol with a public TLA+ spec. Section 10.
- **fero test and fero deploy.** All 14 kernel needs from "fero deploy: the journey" and all 11 pieces from "fero test" have a home.
  - A tape is a log, a fork is a pointer to a snapshot, and sleep and wake are reading a snapshot back.
  - The roll gets the two things the deploy doc asks for: a drain with no timeout (Raft's leadership transfer), and a caught-up signal that is a number.
  - fero deploy's platform is the planner.
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
| **shard** | a hash range of partitions with one log, one Raft group and one leader at a time. Invisible to users | `hash('room42')` falls in shard 7's range |
| **log** | one shard's records in order, with offsets (Raft's indexes) that never go back | shard 7, offsets 0, 1, 2, … |
| **replica** | one member's copy of one shard's log. A **voter** counts toward the shard's majority; a **learner** gets the log but does not vote | shard 7 on S1, S2, S3 |
| **full replica** | a replica on a server: it folds the rows, serves them, and can lead | S1's replica of shard 7 |
| **log replica** | a replica that keeps the log only: it votes, never serves, and leads only to repair (4.2) | a witness's replica of shard 7 |
| **leader** | the voter that writes the shard, chosen by Raft | shard 7's leader is S2 |
| **version** | the shard's incarnation and the offset of a row's last write | `b42` at (7, 1, 902) |
| **state** | the rows: the fold of the log | what `f.data` shows |
| **server** | a process that runs resources: it holds full replicas, leads some of them, serves reads and runs methods | an app process; a copy in fero deploy |
| **log member** | a process with only the log role: it holds log replicas, and nothing else | a witness on a third machine; fero deploy's log tier |
| **`#meta`** | the cluster's own shard: members, the catalog, and where shards are | |
| **planner** | anything that sends placement hints: the `fero` CLI, fero deploy's platform, an operator. Optional | |
| **object store** | where snapshots and old log segments go: S3 or a compatible store, or a local folder | |
| **client** | a process that follows some partitions and writes through a server | a webserver |
| **relay** | a client that also serves other clients | an edge tier |

**Keys, partitions and shards.**
- **A key** is a top-level key of the resource's object, as today.
- **A partition** is one or more keys that stay ordered and atomic together. By default, exactly one key.
- **A shard** groups many partitions so that a commit, an fsync, a Raft round and a change of leader are paid per shard, not per partition.
- **A shard never splits a partition.** A hot partition is bounded by one writer's core. The app splits it (`room42-0` … `room42-3`) if it must.
- **Reading one partition does not mean reading its shard.**
  - Live updates are routed per partition.
  - The current rows come from a snapshot, by key.
  - A replay of one partition's history uses a per-segment index of where each partition's records are (4.1), so it skips the others.

**Shard count.**
- Each resource starts as one shard (`shards` sets another power of two).
- From then on, shards split by themselves, by size and load (4.2), and merges come in phase 5. The count follows the data, with no fixed cap, and a split copies nothing.

**Order.**
- One partition is totally ordered, whoever writes to it. Partitions are not ordered against each other.
- A cell keeps the value of its last record in log order. There are no stamps and no per-cell elections; the only elections are Raft's, one per shard.

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

**`durability`** has two rungs, per resource.

| Rung | A write is confirmed when | It survives |
|---|---|---|
| `'persisted'` (default) | a majority of the shard's voters has it on disk | the loss of any minority of those voters, and a power loss of all of them |
| `'none'` | the leader took it; no replicas, no disk | nothing: transient pub/sub only |

- **`persisted`.** Group commit on every member (4.1) makes it cost one fsync and one network round trip, with the leader's own fsync in parallel. Nothing a reader saw is ever undone.
- **`none`.** Such a resource must have `rows: false`. Its records go straight from the leader to subscribers, best effort. Its cursors carry the leader's term; a subscriber whose term is gone resumes at `latest` and is told so.
- **Per write, `confirm: 'sent'`** lets a plain write's promise resolve once its leader has appended it, before it commits.
  - The answer carries the attempt id, never an offset, so nothing is ever matched by an offset a new leader may reuse.
  - The write stays in the client's pending queue until its commit is acknowledged, and is resent after a failover like any waiting write, so dedup finds it if it committed. It is lost only if the client itself stops first.
  - Its outcome stays in `cluster.writes`, and a client's view shows it only once it commits (V4-7).
  - It is refused on writes with conditions or ops, whose answers need the commit (4.3).
- **A third rung, `'memory'`** (a majority holds it, disks written within a second, as Kafka's default), is decision 4b.

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
| the state | the rows now | always | snapshots in the object store, or each full replica's own without one; in memory on full replicas | reads, conditions, starting a replica, new subscribers |
| the tail | every record after the latest snapshot | always, whatever `history` says | every replica's log, on disk | recovery (snapshot plus tail), live followers |
| history | older records | `history` | segments, moved to the object store, or kept in replicas' logs without one | replay, tapes, cursors further back |

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
L5  libraries, adapters   queue · groups · locks · presence · rate limits · loaders · RESP / Kafka / WebSocket gateways · fero CLI and planner
L4  surface               fero(name) · views · methods · rules · identity · config · worlds (fero test)
L3  flow                  subscriptions: selector + mode + cursor · credits · conflation · relays · near caches
L2  fold and ops          records → rows · conditions · writer ops · writer time · dedup · row retention
L1  the log               Raft per shard · #meta · healing · log replicas · splits · planner hints
L0  storage and io        one journal per process · group commit · segments · object store · snapshots · transports
```

- **Layer boundaries.** A layer talks only to the one below it, through an interface with its own test suite.
- **L0 to L3 are deterministic.** They take events (frames, ticks, disk and object-store completions) and return effects, as v4's kernel does (V3-1). The simulator runs them unchanged, with L4 user code as sim steps under the world's virtual clock.

### 4.0 The shape

```
                 clients, relays, browsers
                          │  subscribe · write · call
        ┌─────────────────┼─────────────────┐
     server S1         server S2         server S3     full replicas: fold rows, serve, run methods
        │                 │                 │
        │   shard 7:  S2 leads; S1 and S3 follow   ─┐
        │   shard 9:  S1 leads; S2 and S3 follow    ├─ one Raft group per shard
        │   #meta:    S3 leads; S1 and S2 follow   ─┘  (#meta is the cluster's own shard)
        │                 │                 │
        └──── log members (optional): log replicas that vote and keep the log, never serve
        └──── object store (optional): snapshots and old log segments
     planner (optional): the fero CLI or fero deploy's platform, sending hints each shard checks
```

**Where each part runs.** The same code in every setup; only placement differs.

| Setup | Servers | Voters per shard | Log members | Object store |
|---|---|---|---|---|
| one process: local dev, fero test, a single copy | 1 | 1: itself | none | a local folder |
| a few processes on one box (example 01) | each process | 1 (the first member) while there are fewer than three, the others learners; 3 from three members | none | a local folder |
| self-hosted cluster | each app process | 3 (or `copies`), plus learners up to `standbys` | optional: a witness on a third machine when there are two | optional: S3 or compatible. Without it, snapshots and history stay on replicas' disks |
| fero deploy | each copy, with its own disk | 3: the copies, topped up with log replicas when there are fewer than three copies | the platform's shared log tier | S3 |

### 4.1 L0: storage and io

**On every member** (a server or a log member).
- **One journal per process.** Every Raft entry, term and vote, for every shard the process holds, goes into one journal file. One `fdatasync` covers a batch: at most every millisecond, or every megabyte. So a process with 1,000 shards pays one fsync per batch, not 1,000. This is group commit, as CockroachDB and TiKV share one log engine across their groups.
- **Segments.** After the journal fsync, entries are written to segment files per shard, with an index from offset to position, and a per-partition index so a replay of one partition skips the rest. The journal is truncated only once the segments that cover it are fsynced.
- **Cuts.** When a new leader overwrites a follower's uncommitted tail (Raft's log-matching repair), the follower writes a cut record (shard, last offset kept) to the journal before the new entries, and starts that shard's next segment file from there; files are never truncated in place. Boot replays cuts in order, and runs the predecessor check on the chain as cut.
- **What `persisted` waits for.** The journal fsync that covers the entry, on a majority of the shard's voters. A term or vote is never used before its own fsync.
- **Boot checks.** Every record carries a crc32c and its predecessor's offset (v4's chain, V3-8).
  - **A torn or short record at the end of the journal** is truncated. No completed fsync covered it, so it was never acknowledged, and the replica still vouches for everything before it. So a power loss of every voter loses only what no one was told committed.
  - **Damage** is a bad record followed by a good one, or a missing segment. It affects only the shards whose records are damaged. If a damaged journal record's shard cannot be read, every shard with a record after it in the journal is affected.
- **A replica that cannot vouch for its log comes back as a new replica.** That is a replica whose disk is new, whose records are damaged (above), or that stopped uncleanly under `durability: 'memory'` (decision 4b). It never votes with the old identity: the shard's leader adds it back as a learner and removes the old one (4.2).
- **A dir knows whose it is.** Its boot record names its cluster id and project. A process opening a dir of another cluster or project refuses, naming both, rather than adopt it.
- **Disks that lie.** A disk that acknowledged an fsync and then lost the write cannot be detected on its own. If it is among the only majority that committed an entry, and the others are lost, that entry is lost. This residual case is named here, not hidden.
- **A disk incarnation** is a random 128-bit id, written when the dir is created. A new or wiped disk can never repeat an old one, so it can never vote as the replica it replaced.
- **Directory fsyncs.** Creating or renaming any file fsyncs its directory. One failed fsync condemns the store (v4's fsyncgate latch): the process stops acknowledging, and its replicas come back as new ones.
- **One process per dir.**
  - v4's lock file and lease thread stay (V4-59).
  - Every file carries the lease's epoch in its name, and a holder writes only files of its own epoch.
  - A new holder renames the old epoch's directory to `retired-<epoch>`, and writes and fsyncs a boot record naming it and the end offset it will read to. Only then does it read that directory, read-only and never past the end. Files roll by new file and unlink, never by truncating in place.
  - So a process frozen past its lease cannot shorten or extend what the new holder reads.

**The object store.**
- **An interface with five calls:** put, get (with a byte range), list, delete, and put-if-absent.
- **Implementations:** S3 or a compatible store, and a local folder. The local folder works only when every process is on one box.
- **Without an object store** in a multi-box cluster, each full replica keeps its own snapshots and the shard's history on its disk, and a new replica gets a snapshot streamed from the leader (Raft's InstallSnapshot).
- **Old segments** are uploaded by the shard's leader, with their partition index, and named in the shard's log.
- **Snapshots.**
  - Every full replica cuts its own snapshots, for its own restarts.
  - Only the leader uploads them: put-if-absent, under a name keyed by (shard incarnation, offset).
  - A snapshot is named in the shard's log, by an entry, only after its put is confirmed.
  - A replica acknowledges a snapshot installed from the leader or the object store only after it is fsynced.
- **When a replica may drop its log below offset i.** All of these must hold, and the covering snapshot is fsynced locally, or its put confirmed, first:
  - a snapshot covers i where the shard can still reach it: for a full replica, its own snapshot, or a merged base named in the object store (a single incremental layer covers nothing on its own); for a log replica, a merged base named in the object store, or else i is at or below the offset every full voter has snapshotted past, which the leader stamps on its appends;
  - the segment is uploaded, or the shard's `history` allows dropping it;
  - no split child still needs it;
  - no fork references it.
- **Old offsets** are read from segments, on replicas' disks or in the object store: slower than recent ones, and cached by the server that reads them.

**On a server.**
- **The rows it folds** are in memory, as a copy-on-write structure, so a snapshot can be cut at one offset, and a split can cut the fold in two without copying.
- **State larger than memory** is opt-in per resource. Cold rows are read through from the latest snapshot layers in the object store or on local disk, with the hot set in memory.
- **Its disk holds its replicas' logs and its own snapshots.** Without log members, that is where durability is.

**Transports.**
- TCP, TLS, WebSocket (browsers, with no bridge), and in-process (worlds and the simulator).
- Frames are v4's: encoded once, with a crc32c, and the same bytes are the journal row and the wire (V3-8).
- A frame is sent at the end of the event-loop turn that made it (decision 9). One frame to a peer carries the messages of every shard the two share.
- **Sizes are capped.** A Raft batch is at most 1 MB, a catch-up `APPEND` at most 4 MB, and a frame bundling many shards is cut at 1 MB. A record bigger than a batch is cut into frames between begin and end markers, as big rows are (4.4).
- **Member verbs only on member links.** Raft verbs are accepted only on links from members that passed the door; on a client link they close it, as v4 drops VIEW and VOTE there. Plan verbs need the admin key.

### 4.2 L1: the log

One published design, run once per shard, plus the engineering that published multi-Raft systems use:

| Job | Design | Source |
|---|---|---|
| order and copy one shard's log, and change its writer | Raft, with PreVote, CheckQuorum, learners, one-at-a-time membership changes and leadership transfer | Ongaro and Ousterhout, 2014; Ongaro's thesis and his 2015 fix; the TLA+ spec |
| run thousands of groups per process | one journal; one frame per peer; quiet idle groups | CockroachDB's and TiKV's multi-Raft |
| keep the cluster's facts | one more shard, `#meta` | CockroachDB's system ranges |
| place replicas | a ring over members (rendezvous hashing), applied by each shard's own leader | v4's ring; CockroachDB's replicate queue, run per range |

#### Clusters, genesis and discovery

- **One cluster per project.** Its resources are entries in its catalog. This replaces v4's one cluster per resource, with its own port, membership and heartbeats each.
- **A cluster id**, minted at genesis, rides every HELLO. Different ids never link, and both sides say so, naming both ids and the fix.
- **Exactly one genesis**, which creates `#meta`.
  - Across boxes, the founding members start with the same `seeds` list, which becomes `#meta`'s first voters. A seed founds only when it reaches a majority of the seeds and none of them has a cluster id. They then hold `#meta`'s first election, and the winner's first entry carries the cluster id it mints; no seed takes client traffic before it has applied that entry. A seed restarted without its dir finds a cluster id at another seed, and joins as a new replica. Seeds compare a hash of their `seeds` lists in HELLO, and refuse to found on a mismatch, naming both lists. A process that has a one-box `cluster-id` file never founds from `seeds`: the file wins, and it joins that cluster or waits.
  - On one box, the first process of a project's run creates `cluster-id` in the run's folder under `.fero/` with an exclusive create, and is `#meta`'s only voter.
  - Everyone else joins: it writes its member record to `#meta`, through any member.
  - A process given cross-box `hosts` and no `seeds` never founds a cluster; it joins its hosts' cluster, or waits and says "no seeds configured".
  - **A stale run folder.**
    - A process that finds `cluster-id` but reaches no member within `connect.wait` waits. It says which member it needs, and where that member's dir is.
    - If no dir in the run folder holds any of the cluster's `#meta`, and none is still locked by a live process (the dirs were wiped), the file is stale. The process renames it aside, says so, and founds a new cluster with a new id.
    - Otherwise `fero recover --new-cluster` can rebuild `#meta` from its own copy. That copy may be behind, and the command says so.
- **Finding a resource.** A name resolves to its project's cluster through the box directory or `hosts`, as today. Remote names carry the project: `shop/stock`.

#### A shard is a Raft group

- **Its replicas.** Each shard has `copies` voters (3 by default), and learners up to `standbys` full replicas in all. Its leader is its only writer.
- **Raft as published, plus the fixes practice added.**
  - Term, vote and entries are fsynced before any reply that depends on them.
  - Membership changes one voter at a time, and a new leader first commits an entry of its own term (Ongaro's 2015 fix).
  - A new voter joins as a learner and is promoted only once it has caught up (etcd's rule).
  - PreVote and CheckQuorum, so a returning replica cannot unseat a working leader, and a cut-off leader steps down within `election.ms`.
  - A replica is its member id plus its disk incarnation (4.1).
  - Leadership transfer on a planned stop or move, so neither waits for an election timeout.
- **Who stands for election.**
  - Each full voter has a rank for the shard: a rendezvous hash of (shard, member). So leaders spread across servers, as a ring would place them.
  - Rank 1 stands after `election.ms`. Each lower rank waits one more `election.step` (200 ms), plus jitter, so one candidate usually stands alone.
  - A replica whose fold is behind its own log by more than `lag.max` waits one more step, so warm replicas win.
  - A member whose clock is more than `skew.max` (1 s) from its peers' median is ranked last, and `cluster.health` says so. It can still lead when it alone can win.
  - A log replica stands only when no full voter has **won** an election for twice `election.ms`. A full voter that keeps standing and losing (its log is behind) does not hold it back (below).
  - Raft's vote rule still decides who can win: a candidate's log must be at least as up to date as the voter's. Ranks change only who tries first.
- **The commit.**
  - The leader sends each batch to every voter and learner at once, and writes its own journal in parallel.
  - A batch commits when a majority of voters, the leader counted once its own fsync lands, have it on disk.
  - The leader stamps the commit offset on later batches. When a commit lands with nothing else in flight, it sends the commit offset at once, on a small ping, then goes quiet. So a follower, and a client it serves, never waits for the next batch to see a write.
- **Reads.** Every full replica folds committed entries, and serves reads and subscriptions (4.4). A `fresh` read uses Raft's read index: the leader confirms with a majority that it still leads (one round trip, no fsync), then answers once its fold reaches the commit offset it had then. The read index is a message of the shard's own, carrying its term, and it wakes a quiet shard. Link pings never stand in for it.
- **A new leader** commits an entry of its own term, which also commits every earlier entry in its log. It answers nothing until its fold reaches its log end.
- **The model.** Raft's published TLA+ spec with Ongaro's fix, plus properties for fero's additions:
  - ranked candidacy changes only who tries first, never who can win;
  - a log replica that leads never accepts a client write;
  - a replica that cannot vouch for its log never votes under its old identity;
  - healing, planner hints and splits are ordinary entries, so every Raft property covers them.

#### Log replicas

- **What they are.** A log replica votes and keeps the log, but never folds rows or serves clients. A log member holds log replicas for many shards. Spanner's witness replicas are the precedent.
- **Why.** Durability needs voters, not servers. With log replicas:
  - two machines survive either one's crash, with a witness on a third failure domain;
  - fero deploy's smallest projects have three voters;
  - a project's servers can sleep, while its log replicas and the object store keep everything.
- **When healing uses them.** Only when a shard has fewer server candidates than `copies` (below), or a planner places them.
- **Leading only to repair.** A log replica cannot judge conditions, ops or rules, so it never takes a client write. When it leads, it does only this:
  1. commit an entry of its own term;
  2. if a full voter is live, bring it up to date and hand it leadership;
  3. else add a full replica (a server with the resource's code hashes) as a learner, which loads the latest snapshot from the object store and the tail from the log replica; promote it; then hand it leadership.

  Until then the shard refuses writes with the reason, `no-writer`, and `cluster.health` says which server it waits for.
- **Without an object store,** a log replica cannot build a new full replica from its log alone, since it never holds a snapshot. It waits for a full voter to come back with its disk, and says so.

#### Who writes, and handover

- **One writer per shard:** its Raft leader. For a moment, two replicas may each think they lead, in different terms. Only one can commit, because a commit needs a majority and any two majorities overlap. A deposed leader's in-flight writes were never answered as committed (4.3, "no answer before commit"). A `sent` write was told only that it was appended, and its client resends it (3.2).
- **A planned handover** (a roll, a drain, a move).
  1. The leader stops taking new writes to the shard. Writes that arrive meanwhile wait, or get `moved` with the target.
  2. It brings the target up to its log end, then sends Raft's TimeoutNow, and the target stands at once.

  The pause is about one round trip and one fsync. If a failover happens meanwhile, the higher term wins, as always.
- **A failover** (a crash, a hang).
  - The followers miss the leader for `election.ms`. The top-ranked live full voter runs PreVote, then the election.
  - A server that led hundreds of shards fails over in parallel: their elections run at once, with their messages batched into shared frames.
- **Warm and cold.** Every full replica folds its shard, so it is warm. Only a log replica's repair is cold: seconds per gigabyte.
- **The writer's time.** `t = max(last t in the log, min(clock, peers' median + skew.max))`, where the peers' clocks ride the link pings. So a clock that jumps ahead (a VM resumed after a year) cannot stamp a far-future `t` that expires every TTL and lease. A clock behind only holds `t` still until it catches up. A skewed member is ranked last for leadership (above), never barred.

#### Failure detection

Two members that share a shard exchange a link ping every `ping.ms` (500 ms) when no other frame went their way, sent from the kernel's own thread (decision 13). Every shard the two share uses that ping. While a shard is busy, its Raft messages ride the same frames.

| Event | Detected after (default) | What happens |
|---|---|---|
| a leader's process stops | `election.ms`: 2 s in TypeScript, 1 s native; tunable down to 500 ms | each of its shards elects, ranked (above) |
| a follower stops | — | its shards carry on with a majority. After `evict.after`, each shard's leader replaces it (healing) |
| a leader loses touch with a majority | `election.ms` | CheckQuorum: it steps down, and its pending answers are `unknown` |
| a quiet shard's leader dies | `election.ms` of missed link pings | the followers wake the shard and elect |
| a member's main thread (methods, views) stalls past 5 s while its kernel thread is fine | the kernel's watchdog | it answers method calls `busy`, so clients go to another server. Its shards keep being written on the kernel thread, and `cluster.health` says why |
| a member is gone past `evict.after` (10 min), or a planner says it is `gone` | that long, or at once | each shard's leader replaces it, one change at a time |
| `#meta` loses its majority | — | writes and failovers carry on everywhere. Joins, new resources and directory updates wait |

- **Quiet shards.** A leader whose shard has had no writes for two ticks, and whose live voters have all reached its commit offset, sends one "quiet at offset i" to its followers, and stops sending for that shard, as CockroachDB's ranges quiesce. A follower told "quiet at i" while below i asks the leader to wake, as CockroachDB's lagging-follower rule does. Any write wakes it. A quiet shard costs nothing on the wire beyond its members' link pings. When a link comes back, each side reports its log end for the shards the two share, and a leader wakes any shard whose follower is behind, so a member restarting in a roll catches up without waiting for a write.
- **CheckQuorum on a quiet shard** uses the link pings: a leader that has lost its links to a majority of the shard's voters for `election.ms` steps down. That is all link pings do for a shard: they detect failure, and never confirm leadership for a read. CockroachDB's store liveness is the precedent for sharing one heartbeat per member pair across groups.
- **Why 2 s.** Failover could be faster, but a 500 ms timeout flaps on a JavaScript GC pause. 2 s is still half of v4's eviction, and native or tuned clusters can go lower.

#### Healing: one rule, run by each shard's leader

There is no controller. Each shard's leader keeps its own shard's replicas where they belong.

- **The target.** A placement stored in the shard's log, if a planner set one. Otherwise the ring:
  - **candidates** are servers with the resource's code hashes and room, that are not draining or gone; log members count too when there are fewer such servers than `copies`;
  - **voters:** `copies` of them (3 by default), the top candidates by rank, servers first;
  - **learners:** the next servers by rank, up to `standbys` full replicas in all;
  - **a shard created with fewer than three candidates** starts with one voter, the member that created it (in example 01, the first process), and the others as learners. A shard with two voters could not survive either one's crash, so it grows from one to three as candidates arrive, passing through two only for the moment of the change. Its one voter stays the incumbent across restarts.
- **The steps.** When the shard's replicas differ from the target, the leader makes one change at a time, each a Raft entry:
  - **healing never lowers a shard's voter count.** Only a `leave` (below) or an operator does;
  - **a gone voter** (its link down past `evict.after`, or reported `gone`) is removed only when a replacement candidate exists, and that replacement is added as a learner in the next step, and promoted once caught up. The shard has two voters only between those steps. Removing the gone one first costs nothing: it was already not answering;
  - **with no replacement,** the gone voter stays in the configuration. The shard is under-replicated and says so, and its live majority still commits. So a 10-minute partition of one of three members never shrinks a shard below three voters;
  - **a live voter not in the target** is removed only after its replacement is a voter whose log reaches the leader's commit offset, exactly, not merely within `lag.max`. So no step lowers the number of voters holding a committed entry;
  - a new replica loads a snapshot (from the object store, or streamed from the leader) and the tail. It counts as caught up when it is within `lag.max` of the leader's commit offset. One that has not caught up within `catchup.max` (10 min), say on a shard too hot to follow, is reported, and a planner can place the shard elsewhere.
- **Under-replication is never silent.** `cluster.health` and one stderr line say when a shard has fewer live voters than `copies`, and why.
- **A removed replica** learns it from the leader's refusal, or from `#meta`'s shard record. It stops standing for elections and serving its rows at once; PreVote keeps it from disturbing the shard meanwhile. It deletes its copy once `#meta` shows the shard's current configuration without it, as CockroachDB's replica GC does.
- **A copy on a returning disk is reused.** Until it is deleted, if healing adds that member back as a learner, it starts from the log it has, and the leader sends only the tail it lacks (Raft's log matching repairs any divergence). So a member back after `evict.after` copies only what changed.
- **Leaders spread.** When the rank-1 full voter has been live and caught up for `settle.ms` (30 s), the leader hands leadership to it. So leadership returns after a failover, without flapping. A member takes back at most ten leaderships a second, so a member returning as rank 1 for 3,000 shards does not take them in one tick.
- **Pacing.** Each member loads at most two snapshots at a time and answers `busy` to more, and a leader that hears `busy` backs off. With rendezvous hashing, a new member takes about `copies`/n of the replicas, and a gone one gives up only its own.
- **Members.** The leader reads members from `#meta`, which every member follows, and liveness from its own links. A stale view only delays or repeats a step: every step is a Raft change in the shard's own log, so it is safe whatever the view.
- **Splits** are also the leader's own decision, by size and load (below).

#### The planner (optional)

- **Who.** Anything holding the admin key: the `fero` CLI (`fero run --copies 3`, `fero scale`, `fero drain`), fero deploy's platform (its rolls and autoscaler), or an operator's script. A cluster runs without one.
- **What it sends.** Hints. A shard hint names the shard config it read: the offset of the shard's last membership change.

| Hint | Does |
|---|---|
| `drain(member)` | written to `#meta`. Leaders hand over the shards it leads, then healing moves its replicas off, since a draining member is never a target |
| `gone(member, life)` | written to `#meta`. Leaders replace it now, instead of after `evict.after`. A leader whose link to that life is up ignores it |
| `lead(shard, member)` | a leadership transfer to that full voter |
| `place(shard, members)` | stores a target in the shard's log, which healing then follows. `place(shard, null)` returns the shard to the ring |
| `split(shard, at?)` | the leader splits now (below) |

- **Why a stale planner is harmless.** A shard applies a hint only if its config is still the one the hint names. Otherwise it refuses `stale-plan`, with the current config. And every change a hint causes is a Raft change in the shard's own log. So two planners at once can waste moves, never break anything. A lease row in `#meta` keeps two from fighting.
- **What a planner adds.** Placement by load and memory, not only the ring; drains before stops; acting at once on a machine it knows is gone; splits ahead of load.
- **Precedents.** Redis Cluster fails over by itself, and rebalances with an outside tool (`redis-cli --cluster rebalance`). CockroachDB has no central planner. TiKV requires one (PD), which fero avoids.

#### `#meta`, the cluster's own shard

- **A system resource, replicated like any shard:** 3 voters from three members (5 if set), chosen by the same ring and healed by the same rule. Every member follows it as a subscriber (4.4), so every member has the members and the directory.
- **Log members fold `#meta` too.** It has no user code, so a log member holds a full replica of `#meta` and can lead it like a server. So `#meta` has a writer whenever a majority of its voters lives, and a new server can always write its member record. Without this, a project whose servers are all gone, with only log replicas left, could never let a new server join (the wake case in 6.1).

| Record | Holds |
|---|---|
| member | id, life (random per process start), disk incarnation, roles (server, log), addresses (listen and advertised), capacity, code hashes it can run, kernel version, join offset, state (live, draining, gone) |
| resource | name, config (4.5), allowed code hashes, seed applied, write gate (open, or read-only with a reason) |
| shard | resource, hash range, incarnation, split lineage, and its last known replicas and leader. **This is a hint:** each shard's own log is the truth, and leaders refresh this record after each change, the newest config winning |
| cluster | id, cluster version, current and next door secret, CA key envelopes, revoked certificates, the planner lease |

- **What `#meta` is not.** It is not on the write path, and not in any shard's failover. While its majority is lost, writes and failovers carry on. Joins, new resources and directory updates wait.

#### Scaling up and down

**What moves, and from where.**
- A server that becomes a replica of a shard copies it: the latest snapshot from the object store (or streamed from the leader) and the tail from the leader. So adding a server moves data to it: about `copies`/n of all replicas, paced.
- Durability depends on each shard's voters, not on how many servers run, and log replicas can be voters.

| Change | What happens |
|---|---|
| add a server | it joins `#meta`. Rings now rank it, and each shard whose target now includes it adds it, one change at a time, paced by snapshot loads |
| remove a server | with a planner: it is drained first (leaders hand over, then replace its replicas), then it stops. Without one, Ctrl-C is a `leave` (below) |
| add a log member | it joins. Shards with fewer server candidates than `copies` place voters on it |
| a shard gets big or busy | it **splits** (below) |
| scale to zero (sleep) | needs log replicas: the servers stop, and the log replicas and the object store keep everything |
| wake | a server starts. Each shard's leading log replica brings it up to date, or adds it, then hands it leadership (repair, above) |

**Splits.**
- **A split is the leader's act:** one entry in the shard's log, at offset X, naming two children. Each has half the hash range, one more hash bit, and the parent's replicas.
- **Every replica, as it applies the entry, creates both children.** Each child starts as a Raft group whose first state is the parent's state at X, filtered to its range: a copy-on-write cut of the fold on full replicas, and on log replicas a reference to the parent's log. No data moves between machines.
- **Children's offsets continue from X + 1,** so a partition's versions and cursors never go back. A row last written at offset 902 in the parent has version 902 in its child, so an `if: { version }` read before the split still holds after it.
- **Children start in the parent's term at X,** so `none` cursors and fences stay monotonic. The parent's leader stands first in each child, so the children have leaders within a round trip. A replica that has not applied the split yet holds the children's messages until it does.
- **The leader appends nothing to the parent after the split entry,** from the moment it appends it, not the moment it commits, so no parent offset can collide with a child's.
- **If the leader dies before the split entry commits,** the entry may be dropped like any uncommitted entry. If it committed, every replica has it.
- **After the split,** the parent refuses writes `moved`, naming the children, and cursors on the parent resolve to the children by the lineage.
- **Each child inherits** the parent's dedup outcomes, highest call ids and fence tokens, filtered to its partitions.
- **The parent's log up to X** is kept until each child has a snapshot of its own.
- **Healing then spreads** the children's replicas and leaders by their own ranks.
- **When they land.** Splits land in phase 4, where fero deploy first needs them, after phase 2's sweep is green without them. Merges are phase 5.

**What stays limited,** said plainly:
1. **One partition, one writer.**
2. **A new replica copies its shard.** Adding a server moves about `copies`/n of all replicas to it, from the object store where there is one.
3. **Memory.** Each full replica holds its shards' rows. Room grows with servers only while `standbys` is below the server count; at the default, every server up to five holds every row.
4. **Fold CPU.** Every full replica folds every write of its shards.
5. **A commit** costs at least one fsync and one round trip to a majority of voters.
6. **Two voters cannot survive a crash.** So below three candidates a shard has one voter, and a crash of its machine stops that shard's writes until it returns, unless a witness makes three.
7. **Many groups.** Each shard costs its Raft state in memory, and frames while it is busy. Quiet shards cost only their members' link pings. Phase 2 pins 10,000 idle shards per process.
8. **Wake time.** A snapshot read: about a second when small, about a minute for 10 GB.

#### Leaving, restarting and stopping

| Stop | Used by | What happens |
|---|---|---|
| `leave` | Ctrl-C, SIGTERM or `destroy()` when not under a supervisor; scale-in without a planner | **First** it marks itself `draining` in `#meta`, so no healing step, its own shards' included, targets it again. **Leadership:** it hands over every shard it leads. **Votes:** in each shard where it is a voter, the leader first promotes a caught-up learner, if there is one, so the voter count holds; then it removes the leaver, if the remaining live voters stay a majority of the new set. So two members leaving one after the other do not leave a shard with one voter while learners remain. Dead voters (links down past `evict.after`, never a mere GC pause) are removed first, when that is what lets the leave carry (as V4-60). A shard where neither is safe keeps it as a voter, and `destroy()` names it, along with any dead voter it removed. **One voter:** if it is a shard's only voter, it promotes a learner first, then hands over, then leaves. Bounded by `leave.ms` (4 s). Healing later adds replacements |
| `restart` | the same signals under a supervisor (`FERO_SUPERVISED`), rolls, restart-all | hands over every shard it leads, and stays a replica of all of them |

- **A crash** is a restart that skipped the handover.
- **Two machines.**
  - Each shard has one voter, the first member, and the other machine is a learner. A crash of the learner's machine changes nothing. A crash of the voter's machine stops writes until it returns, as in v4.
  - An acknowledged write is then on one disk until the learner has it, usually within a millisecond. `copies: 2` makes two voters instead: every write is on both disks, and a crash of either stops writes. The log-first draft gave both at once only by needing a witness to carry on.
  - A **witness on a third failure domain** (a log member on a tiny third machine, or a small cloud VM) makes three voters: two full and one log. Then either machine's crash is survived: the other leads, with the witness for its majority.
  - A witness on one of the two machines only heals the other machine's crash, as in v4 (DESIGN-LEAVE §7b).
  - fero deploy tops up from its log tier, so two copies survive either one's crash.
- **Example 01** (two processes on one box, no witness).
  - The first process founds the cluster. It is every shard's voter, and the second is a learner.
  - Ctrl-C on the first is a `leave`: it promotes the second, hands over, then leaves. The other carries on alone, and says so.
  - Ctrl-C on the second: it stops being a learner, and nothing else changes.
  - A crash of the second changes nothing. A crash of the first: the other is read-only until it returns, as in v4.

#### Mixed versions, recovery and routing

- **Mixed versions.** Frames carry the protocol version. The cluster version lives in `#meta`, and is raised only when every member runs the new kernel, as Kafka's `metadata.version` is.
- **Operator recovery.**
  - `fero recover --unclean <shard>`, when a shard's voters have permanently lost their majority. One surviving replica forces a configuration of itself, as TiKV's `unsafe-recover` and CockroachDB's `debug recover` do for one range. It reports what may be lost, and bumps the shard's incarnation in `#meta`, so stale cursors are refused instead of waiting.
  - **The residual case:** if the "lost" majority was only partitioned, it may still elect under the old incarnation. Its leader learns the bump from `#meta` when it can reach it, and stops; until then two writers exist under two incarnations, and the command says so before it runs.
  - `fero recover --new-cluster`, the same for `#meta` (etcd's force-new-cluster is the whole-cluster precedent). It bumps `#meta`'s incarnation and keeps the cluster id, so cursors on healthy shards stay valid.
- **Routing.**
  - The partition-to-shard function is a fixed 64-bit hash with a full avalanche finaliser, versioned with the frame format.
  - A leader refuses a record whose partition is not in its shard (`wrong-shard`).
  - Clients send writes to their server, which maps each row key to its shard (a custom `partition` function runs only on servers) and forwards to the shard's leader. It finds the leader from its own replicas, or from `#meta`'s directory. A stale answer costs one `moved`, which names the current leader, or the children of a split.
- **Who dials whom.** Members dial only members `#meta` names, plus their `hosts` and the box directory. Never an address a client claims.
- **Hosted.** Each project's `#meta` is a shard like the others, on the project's own copies and log replicas, and quiet ones cost nothing. A log-tier process runs one log member per project, sharing the process and its journal, with a quota each.

### 4.3 L2: fold and ops

**The record.** A batch has one header: the leader's term, the base offset and the writer's time `t`. Each record inside has its own offset (base plus index), its own attempt id, and data's delta.

| Field | Why |
|---|---|
| term | which leader wrote it; a deposed leader cannot commit (4.2) |
| offset | the log's order; versions; cursors; retention |
| writer time `t` | TTLs, leases, `ctx.now()` at the writer; `max(previous t, clock)`, carried across writers |
| attempt id (issuer, call id) | dedup of retried writes. The issuer is the process id plus its life, so a restarted process never repeats an id |

**At the writer, in this order:**
1. **Dedup.**
   - **What it checks.** If the attempt id is in the shard's log, committed or in the writer's uncommitted tail, the writer answers with the original offset, and nothing else runs.
   - **No answer before commit.** Every answer (a dedup answer, a refusal such as `conflict`) is judged against the writer's log-end state, so it waits until the commit offset reaches the version it was judged against. If the leader loses leadership first, the answer is `unknown`, and the issuer retries at the new leader.
   - **What the issuer promises.** Its call ids rise. It has at most `issuer.window` (1,024) attempts outstanding in all, counted from its oldest unacknowledged one. The window is a cluster key, so every issuer and every writer use the same one. It stops retrying an attempt after half the horizon (5 min).
   - **What the writer keeps.** Per issuer and shard: the highest call id seen, and every committed outcome above the floor (a commit, or an appended refusal), kept by id. An issuer silent for the retry horizon (5 min) is forgotten, from memory and from snapshots, so this state is bounded by active issuers.
   - **The floor.** An attempt at or below (highest id seen) − `issuer.window` that is not among the outcomes is a late duplicate of a committed write, and is refused `stale-attempt`. Above the floor, an attempt not among the outcomes never committed, and is judged fresh.
   - **No late arrivals.** An attempt carries a time budget its issuer sets to half the horizon, and every hop subtracts the time it held it, on its own monotonic clock. A server forwards an attempt only over the link to the leader it had when it took the attempt; after any break it answers `retry`, and the issuer resends. Resends back off with jitter, from `election.step` up to `election.ms`, and a `no-writer` or `moved` answer carries a retry-after, so an election never brings a retry storm. A leader closes a link that misses pings for `election.ms`, so a frozen server's late forward never lands. These bound how late a copy can arrive; what makes every answer unique is the log: committed outcomes, and the appended refusals of resent attempts (below).
   - **Across leaders.** The outcomes, and each issuer's highest call id seen, are part of the shard's state, so snapshots carry both. A new leader holds every committed entry (Raft's leader completeness), and folds its whole log before it answers. So the floor never drops below where the old leader had moved it.
2. **Shape checks that need the current row.**
   - Array holes (`sparse-hole`, V4-28/33).
   - An insert under an existing row.
   - A field write to a row that does not exist is refused `absent-row` (decision 14).
3. **`validation` and `rules.write`**, with the current row.
4. **Conditions**, against the writer's state at this point in its log.
5. **Ops**, which compute the value to append.

**Refusals.**
- **A refusal of a resent attempt is an outcome.** An attempt says whether it has been sent before: an issuer's resend after `retry`, `unknown` or a timeout, or a call's re-run (4.5). The writer appends the refusal of a resent attempt as an entry with no data, under its attempt id. So a stale earlier copy that arrives later, even at a later leader, finds it and gets the same answer. A refusal already waits for a commit, so this adds no wait.
- **A first send's refusal is not appended.** No other copy of it exists: an issuer sends once until told to retry, and a server forwards an attempt once and never re-forwards it. So an idle queue's `empty` answers, and a rate limit's refusals, write nothing to the log.
- **After a definitive answer** an issuer never resends that attempt. A new try of the same change is a new attempt, judged afresh.

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
- A new leader's log may end with entries of earlier terms not yet committed. Raft never drops them from its own log, and its first entry of its own term commits them, so they belong in its log-end state, and it has no overlay to drop.

**Row retention** (3.1) runs on the writer's tick, as records with a reason.

**The fold** is data's: records apply through its hot lane in offset order, the same on writers, followers, clients and replays, with no LWW comparison anywhere.

### 4.4 L3: flow

One verb serves followers, clients, relays, consumers and the viewer: **subscribe**, with a selector, a mode and a cursor.

| Part | Values |
|---|---|
| selector | `resource`; `partitions: [...]` (a follow set); `prefix`; `view` (a server-side view, 4.5); `shard` (servers and relays) |
| mode | `state`: a snapshot, then deltas, conflated per row for a slow reader. `log`: every record from the cursor, never conflated |
| cursor | the cluster id, the resource's incarnation, then per shard its incarnation, the offset last seen, and (for a `none` resource) the leader's term; or `'latest'`, `'earliest'` |

- **Who serves.**
  - Any full replica of the shard that is ready: its leader, a follower or a learner. A replica is ready once its snapshot has loaded and its fold has reached the commit offset it was told when it started; until then it answers `moved`, naming a ready one. Always up to the commit offset, and never before its fold has reached the subscriber's cursor.
  - Older offsets come from segments, on replicas' disks or in the object store.
  - A follower that falls behind the tail and reloads a snapshot ends its `log` subscriptions on that shard with `expired`, and re-snapshots its `state` subscriptions.
  - A one-shot read at a server that neither folds nor relays the partition is refused `moved`, naming a full replica. A relay answers only after its upstream snapshot has landed, never from an empty fold.
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
| `read(key, { fresh: true })` | a linearizable read: the leader confirms with a majority that it still leads (Raft's read index), then answers once its fold reaches the commit offset. One round trip, no fsync |
| `set`, `update`, `remove`, `incr`, `push` | writes, with `{ if, ttl, confirm }`; `confirm: 'sent'` only on a plain write (3.2) |
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
    - Its writes carry attempt ids derived from the call key, their order and a hash of their content, marked as resent. So a re-run's identical writes dedupe, and a re-run that writes something different is refused `call-diverged`.
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
  - Each server registers the code hashes it can run. Healing and the planner make a server a full replica of a shard only if it has the resource's hashes, and a leader refuses a target without them.
- **Identity and security.**
  - A client presents a token signed by the cluster; `ctx.peer` carries its claims. The shared client key stays as the simplest token.
  - TLS with a cluster CA, so clients verify servers.
    - The CA key lives in `#meta` only as envelopes encrypted to each of `#meta`'s voters' keys.
    - Joins use single-use join tokens (`fero join-token`); fero deploy mints one per machine.
    - A client checks a server against the CA fingerprint in its own credential.
    - Each member gets its own certificate at join. A removed member's certificate is revoked in `#meta`.
  - The secret rotates through `#meta`: current and next, during a window.
- **`cluster.writable`** is true when every shard of the resource has a leader on a full replica that heard from a majority of its voters within `election.ms`. `cluster.shards` details each shard: its voters, learners and leader, and how many of them are live.
- **Fewer members than `copies`.** A shard created with fewer than three candidates has one voter, healing never lowers a voter count, and `cluster.health` and one stderr line say when a shard has fewer live voters than `copies` (4.2). So two processes on one box is visibly one voter and one learner.
- **Defining and changing a resource.**
  - The first `fero(name, opts)` that creates a resource writes its config to the catalog, which is the source of truth from then on.
  - A later open with different options is refused, naming the difference, unless an `alter` in progress allows its code hash.
  - `fero.alter(name, change)` changes a resource online: a roll adds the new hash before and removes the old after.
- **Config, in three scopes.**

| Scope | Lives in | Keys | Changes |
|---|---|---|---|
| node | the config cascade, as today | `uuid`, `dir`, `listen`, `advertise`, `hosts`, `seeds`, roles (`server`, `log`), `object` (the object store), `secret`, `secret.client`, `rendezvous`, `heartbeat.ms`, `redial.*`, `leave.ms`, `journal.cap`, `diag.allow`, `signals`, `memory`, `cache`, `connect.wait` | restart that node |
| cluster | `#meta` | `#meta`'s `copies`, default `copies`, `ping.ms`, `election.ms`, `election.step`, `evict.after`, `settle.ms`, `catchup.max`, `skew.max`, `lag.max`, `issuer.window`, cluster version | online through `fero.alter('#meta', change)`, which checks each key's range and the keys against each other (say, `election.ms` above twice `ping.ms`, `skew.max` below `election.ms`) and refuses with the reason |
| resource | the catalog | `shards` (the starting count, default 1), `copies` (voters per shard, default 3), `standbys` (full replicas per shard, voters and learners), `partition`, `history`, `rows`, `durability`, `validation`, `rules`, `methods`, `load` | online through `fero.alter`; code by allowed hash |

- **Worlds** (fero test): a bound world resolves names to stand-ins, makes server markers into solo nodes, and supplies `now` and `id`. A solo node is the same code: a server that is the only voter of every shard, over a local-folder object store.

### 4.6 L5: libraries and adapters

L5 is built only from L4 calls; each library is a file with its own tests, and none adds a wire verb:
- the queue, consumer groups, locks, presence, rate limits and loaders (5.3);
- the RESP, Kafka-protocol and WebSocket gateways;
- the `fero` CLI: `run`, `test`, `deploy`, `ls`, `debug`, `recover`, `join-token`, and the planner's verbs (`drain`, `gone`, `lead`, `place`, `split`), which fero deploy's platform also uses.

### 4.7 The wire

| Family | Verbs | Layer |
|---|---|---|
| link | `HELLO`, `DOOR`, `PING`, `DIAG` | L0 |
| raft | `VOTE`, `VOTED`, `APPEND`, `APPENDED`, `SNAPSHOT`, `TIMEOUT-NOW`, `QUIET` | L1 |
| plan | `PLAN`, `PLAN-ACK` | L1 |
| writes | `WRITE`, `WRITE-ACK` | L1, L2 |
| flow | `SUB`, `SNAP`, `DELTA`, `END`, `CREDIT`, `FOLLOW`, `UNFOLLOW` | L3 |
| methods | `CALL`, `RESULT`, `SUBREC` | L4 |
| admin | `DEFINE`, `ALTER`, `RECOVER` | L4 |

28 verbs in eight families, each owned by one layer. PreVote is a `VOTE` with a flag. Every Raft verb carries its shard, and one frame carries many shards' messages.

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

- **A message** is appended once by its room's shard leader, committed on a majority of the shard's voters, and delivered to the webservers that follow that room, encoded once.
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

**What Raft per shard changes for the platform.**
- **The copies are the replicas.** Each copy has its own disk, as the deploy doc already plans, and holds the shards it replicates.
- **Log replicas top up.** With fewer than three copies, the platform's log tier supplies log replicas, so every project, the free tier included, has three voters. "Two copies are refused" can go: two copies and one log replica survive either copy's crash.
- **Sleep and wake.** A sleeping project's log replicas and S3 keep everything. Waking, a copy loads its shards (from its own disk, or from S3), and each shard's log replica hands it leadership: about a second for a small project.
- **The platform is the planner** (4.2). A roll drains each copy before it stops. The autoscaler adds copies, and drains them before removing them. A machine Fly destroyed is reported `gone` at once, so its replicas are replaced without waiting `evict.after`.

**The fourteen needs.**

| # | Need (from "fero deploy: the journey") | On v5 |
|---|---|---|
| 1 | the `fero` command and the npm build | L5 |
| 2 | `file`, `scale`, `size` from the file | node-scope config |
| 3 | a box directory that lists names, runs and folders | unchanged; one project is one cluster |
| 4 | a caught-up signal | a number: for each shard the copy replicates, how far its log and its fold are behind the leader's commit offset. `cluster.me.caughtUp` when every gap is under `lag.max` |
| 5 | a full restart, and a restart after one-by-one stops | each shard elects once a majority of its voters is back, in any order; there are no eligible-leader rules |
| 6 | a joining copy skips its seed | a seed is applied once, when the resource is created |
| 7 | listen and advertised addresses apart; bracketed IPv6 | the member record holds both |
| 8 | TLS for clients, one public address | L0 transport and the cluster CA; clients route through any server |
| 9 | a client leaves a server whose writes are shut | `moved` and `cluster.writable` say so; the client moves |
| 10 | the supervisor sets the secret over the call | a supervisor layer above the call |
| 11 | a new version's contract reported before it joins | the allowed-hash list: the deploy adds the hash first |
| 12 | no deleted row comes back | structural: one log per shard; removal markers live only inside snapshot layers, merged in order on one machine, never collected across copies as v4's tombstones were; snapshots that replace |
| 13 | refuse writes with a reason while reads go on | the resource's write gate (unpaid); a server memory bound (near full) |
| 14 | group commit | one journal per process, for every shard it holds (4.1) |
| later | rolling a contract change | allowed hashes over normalised source |
| later | state larger than memory | cold rows read through from snapshot layers |
| new | moving a v4 `dir` to v5 | `fero migrate`: v4's WAL and snapshot become one v5 snapshot per shard |

**A roll on v5.**
1. The platform drains copy 1 of leadership: each shard it leads is handed to a warm voter, in about one round trip and one fsync.
2. Copy 1 restarts on the new files, with its disk, and catches up as a follower.
3. When `caughtUp` says so, the next copy goes.

Clients see at most a pause of one handover per shard, and no election timeout.

### 6.2 fero test

| # | Piece | On v5 |
|---|---|---|
| 1 | the world in `fero()` | a solo node is the whole stack in one process: a server that is the only voter of every shard, over a local-folder object store and the in-process transport |
| 2 | the clock and ids | writer time under the world's clock; `fero.id()` from the world's seed |
| 3 | input keys | call keys in `#calls` |
| 4 | `fero test` as a verb | L5 |
| 5 | components ship their stand-ins | unchanged |
| 6 | the test block in the viewer | captures carry offsets, so inputs, records and asks line up |
| 7 | the spec and the layout | unchanged |
| 8 | the store: forks, versions, proposals | **a fork is a new shard whose first state is the parent's snapshot at an offset**: segments and snapshots are immutable, so a fork costs one `#meta` record |
| 9 | the tape at the live edge | a resource with `history: '14d'` and rows keyed by match key |
| 10 | the ai component and `fero change` | unchanged |
| 11 | app steps in the simulator | methods run as sim steps against L0 to L3, under the same seeds. The planner is one more sim client, whose hints arrive stale, duplicated and out of order |

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

**This draft (Raft per shard).** The same agents re-judge the same 876 cases against this draft; the results land here, above the log-first ones they replace.

**The log-first rewrite (the last draft).**
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
| L0 | persisted appends per process | about 250/s | 50k/s | 500k/s | one journal for every shard, one fdatasync per ≤ 1 ms batch, `writev` | Kafka per broker, etcd |
| L1 | appends per shard leader | 14k/s through the api, 73k/s raw | 150k/s | 2M/s | pipelined, batched across shards per peer link | Redpanda (Raft per partition) |
| L1 | commit latency, p99, persisted | — | fsync p99 + 2 ms | fsync p99 + 0.5 ms | send to every voter at once, commit at a majority; the leader's own fsync runs in parallel | Kafka acks=all, etcd |
| L1 | planned handover (a roll step) | — | 10 ms | 2 ms on NVMe; about 6 ms on a disk with 4 ms fsyncs | bring a warm voter to the log end, then TimeoutNow: one round trip and the new term's fsync | — |
| L1 | failover to writable | about 4 s | 2.2 s | 1.1 s | `election.ms`, then PreVote, the vote and the first own-term commit (a few ms) | KRaft (9 s default) |
| L1 | adding a server, per GB of its replicas | v4: about 7 s per GB, copied from peers | 10 to 20 s from S3 in one stream; 2 to 5 s with parallel reads | the same | snapshot layers read in parallel; the tail from the leader | — |
| L1 | idle traffic, n = 100 | about 20k frames/s | about 20,000 frames/s when every pair shares a shard (100 × 99 × 2 a second); about 10,000 with `ping.ms` at 1 s | the same | one link ping per member pair that shares a shard, each way, each `ping.ms`; quiet shards send nothing of their own | CockroachDB's store liveness and quiesced ranges |
| L2 | fold per record | about 10 µs | 2 µs | 0.2 µs | header-only decode, no per-record objects | — |
| L2 | conditional op at the writer | none | 3 µs | 0.5 µs | lookup and compare in the append path | Redis INCR server time |
| L3 | fan-out per relay core | about 9k/s (about 110 µs per relayed record) | 100k deliveries/s | 3M/s | per-shard index, encode once, `writev` | NATS core |
| L4 | read of a held row | in-process | under 100 ns | the same | immutable rows | Redis GET: a network round trip |
| L4 | method call, caller is the writer | — | 10 µs | 5 µs | in-process | Redis Lua |
| L4 | `fresh` read | — | one round trip | one round trip | Raft's read index, no fsync | etcd's linearizable read |
| L4 | view update per change | 5,000 filter views: about 500 µs a write | 1 µs per affected view | the same | shared declarative views, `group` routing | — |

**Where fero can win outright:**
- reads of held rows;
- ops whose caller is the writer;
- fan-out that carries state;
- scaling compute without moving data;
- running one system instead of three.

**Where it should match:**
- raw log bytes per disk and network card;
- commit latency, which costs one fsync plus one round trip to a majority, as any replicated log does.

**What Raft per shard costs:**
- A server that becomes a replica copies its share of the data, from the object store when there is one.
- Many small groups: their Raft state in memory, and a link ping per member pair. Quiet groups send nothing of their own.
- Idle frames grow with member pairs, not shards: about v4's level at n = 100, more than the log-first draft (which pinged one controller).

**What carries the targets:**
- **Bytes end to end.** Batches stay encoded from leader to follower, and only the fold decodes.
- **No work per view per record.** Shared `group` routing: one lookup per record, not one predicate per view. Measured on v4: 5,000 filters cost 450 to 510 µs a write; one `group`, 10 to 20 µs.
- **Nothing on a timer that grows with data.** v4's compaction rescans every large lane each heartbeat (43% of CPU in a two-member run; a separate task is queued). In v5, retention drops or uploads whole segments.
- **Group commit:** one journal per process.

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
- Log members need no JavaScript at all. Natively, a log member is a small, separate program.

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
   - L1 is Raft, as published, with the fixes practice added: one protocol, with a public TLA+ spec, run once per shard with the engineering CockroachDB and TiKV publish.
   - Gone: lanes, stamps, digests, tombstones, compaction frontiers, orphans, sheds, latches, teachers, floors, FEED words, in-sync sets and eligible leaders; and the last draft's loglets, seals, chains, sessions and controller.
   - The new mechanisms are not only in L2 and L3 (the log-end overlay, budgeted dedup, per-row conflation, snapshot-replace, the read-your-writes wait, writer time and fences).
   - fero adds some to L0 and L1 too:
     - ranked candidacy, and leadership handed back after `settle.ms`;
     - log replicas, which lead only to repair;
     - healing's one rule, and planner hints checked against the shard's config;
     - splits as one entry, with lineage for cursors;
     - snapshot layers with removal markers, and their coupling to log retention.
   - Each is an ordinary Raft entry or a choice of who stands, so Raft's properties cover log consistency for them. They do not cover replica counts, durability or the uniqueness of answers, and the review found its critical bugs exactly there (section 13). So the safety core is simpler than the log-first draft's, and the policy layer is about as novel. All of it gets models (point 2), and merges wait until phase 5.
   - L1 is about the size of plain Raft per shard (5 to 6k lines, V5-LOG-FIRST-REVIEW), half the log-first draft's, and phase 2 still carries scaling.
   - Each layer's doc opens with its mechanism list. Adding one means naming what it replaces, or why it cannot be a library.
2. **Check every layer against a model before code.**
   - **L1 in TLA+, as one spec.**
     - Raft's published model, plus Ongaro's fix, is the base.
     - fero's additions are added to it: ranked candidacy, log replicas that lead only to repair, replicas that cannot vouch for their log, healing's steps, planner hints, and splits as entries.
     - Properties beyond Raft's own:
       - no healing or leave step reduces the number of vouching voters that hold a committed entry, unless a replacement voter already holds it;
       - under-replication is always reported;
       - a split is two groups with lineage, and no offset collides;
       - the repair program of log replicas, including `#meta`, always reaches a full leader when a server is available;
       - a torn tail never makes a replica unable to vouch.
     - Checked exhaustively at small sizes: 3 to 4 members, 2 shards and a split, a log replica, crashes, partitions, restarts, power loss, a lying disk, a stale planner, snapshot layers against log deletion, and an object store that is slow or down.
   - **L3 in TLA+:** cursors (including their resolution through split lineage), snapshots that replace, credits, failover, and `confirm: 'sent'` across a failover.
   - **L2 against a reference model:** a 200-line sequential interpreter of records, conditions, ops and dedup, run against the code on random sequences, including a refusal followed by a stale copy on another link.
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
| 1. Specify | the L1 TLA+ spec (Raft, plus fero's additions), the L3 spec, the L2 reference model; the L0 to L4 interfaces; every backtest case as a named test | the model checker is green; every case has a test name |
| 2. The log | **The simulator first:** v4's executive gains many shards per node, member roles, and an object store whose calls complete as sim events. Then L0 (the journal for every shard, segments, the object-store interface with its local-folder version) and L1 (Raft per shard with its multi-Raft engineering, `#meta`, healing, ranked candidacy, handover) in TypeScript, with v5 monitors and trace validation | 1,000-seed sweeps green with servers joining, leaving and crashing; kill -9 of everything, and a simulated power loss, lose no persisted write; 10,000 idle shards per process pinned; the L0 to L2 TS pins |
| 3. Surface | L2, L3 and L4 (v4's api ported: data binding, methods, door, config, rules, identity); the carried v4 bugs fixed; prototypes of the queue, groups and locks libraries | examples 01 to 44 pass; every backtest case passes or is marked not applicable with its reason |
| 4. Platform | the S3 object store; **log replicas, the witness and the hosted log tier; splits; the planner and its hints; load-aware placement**; sleep and wake; worlds, call keys, tapes, forks, caught-up, rolls; TLS and the CA; `fero migrate`; the npm build | the café from "fero test" runs on v5; fero deploy milestones 1 and 2 run against a local log tier with an S3-compatible store |
| 5. Native and reach | the Rust L0 to L3 (and a native log member) behind the same interface; merges of shards; relays; `rules.read`; mergeable views across shards; the finished libraries; the RESP, Kafka and WebSocket gateways | every row of section 8 is a green pin in the native column, on the pinned runner |

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
- The ring, as healing's placement rule (rendezvous hashing).

**What is replaced.** The kernel's log, streams, scope, most of write, membership (by Raft per shard) and confirm (by majority commits); FEED words, digests, tombstone GC and compaction.

## 12. Decisions for you

Reply "defaults" to take every pick, or name a change ("3b").

1. **Replace v4's kernel.** a) v5's kernel under v4's api and tools, v4 frozen for features (my pick). b) Evolve v4 one mechanism at a time.
2. **The shape of L1.** Two independent reviews compare these: [V5-REPLICATION.md](V5-REPLICATION.md) and [V5-LOG-FIRST-REVIEW.md](V5-LOG-FIRST-REVIEW.md).
   - a) **Raft per shard** (this draft; my pick).
     - One protocol, with a public TLA+ spec. Every resource starts as one shard, so a small project is plain Raft.
     - The cluster heals itself; a planner is optional; log replicas give witnesses and fero deploy's top-up.
     - The cost: a server that becomes a replica copies its shards, and many small groups need multi-Raft's engineering.
   - b) **The log first** (the last draft).
     - Durability on a separate log tier; servers disposable; storage scales on its own.
     - The cost: about twice the L1 code, three protocols, and a storage tier to operate. Its reviewer: choose it "only if fero deploy is the primary product".
   - c) Kafka's in-sync sets under a controller (the earlier drafts).
3. **Language.** a) TypeScript first, Rust behind the same interface in phase 5 (my pick). b) Rust from the start.
4. **Durability.**
   - a) `persisted` (a majority of voters on disk) and `none` per resource, plus `confirm: 'sent'` for a plain write that need not wait for its commit (my pick).
   - b) Also `memory` per resource: a majority holds it, and disks are written within a second, as Kafka's default. The price: a replica that stops uncleanly comes back as a new one (4.1), so an unclean stop of a majority at once needs `fero recover`.
   - c) `persisted` and `none` only.
5. **One cluster per project.** a) Resources are catalog entries (my pick). b) One cluster per resource, as v4.
6. **What Ctrl-C, SIGTERM and `destroy()` do.** a) `leave`, and `restart` under `FERO_SUPERVISED` (my pick). b) Always `restart`.
7. **Defaults.**
   - a) My pick:
     - one starting shard per resource, then split;
     - `copies` 3 voters (1 for a shard created below three candidates, never lowered by healing); `standbys`: every server, up to 5;
     - `#meta`: 1 voter, then 3 from three members;
     - a 100 ms tick, `ping.ms` 500 ms, `election.ms` 2 s (1 s native), `election.step` 200 ms, `evict.after` 10 min, `settle.ms` 30 s, `catchup.max` 10 min;
     - `history: 0`, `rows: true`.
   - b) Name your own.
8. **Log replicas.** a) Optional: servers are the replicas by default; log members serve as a witness on a third machine, and as fero deploy's log tier (my pick). b) None: every replica is a server, so two machines cannot survive a crash.
9. **The object store outside fero deploy.**
   - a) Optional (my pick):
     - a local folder on one box;
     - S3 when configured;
     - across boxes without one, full replicas keep snapshots and history on their disks, and a log replica can repair only when a full replica returns.
   - b) Required everywhere: simpler code paths, but local dev needs an S3-compatible store.
10. **The witness.** a) A log member on a third failure domain, from phase 4, since two-machine self-hosting needs it (my pick). b) Earlier, in phase 2.
11. **When a frame leaves.** a) At the end of the event-loop turn that made it (my pick, as v4). b) Send a turn's first small frame at once.
12. **Streaming method results.** a) Stream a method's returned view, `move` records carried (my pick). b) Snapshots only.
13. **Where the TypeScript kernel runs.** a) On a worker thread, with user code on the main thread (my pick). b) On the main thread, as v4.
14. **A field write to a missing row.** a) Refused `absent-row` (my pick). b) It creates the row.
15. **fero deploy before v5.** a) Build deploy milestones 1 and 2 on v4 now, then move to v5 at phase 4 (my pick). b) Wait for v5.
16. **The development rules of 10.2.** a) Adopt them for v5 from phase 1 (my pick). b) For v4 too, now.
17. **Hosted metadata.** a) Each project's `#meta` is a shard on its own copies and log replicas; quiet ones cost nothing (my pick). b) One shared metadata group per log-tier cell, with a namespace per project.
18. **How followers get the log.** a) The leader pushes to every voter and learner, as Raft does (my pick). b) Learners tail a voter instead, to spare the leader's network.
19. **The planner.** a) Optional: healing by each shard's leader is the default, and the CLI and fero deploy's platform send hints (my pick). b) Required, as TiKV's PD: one planner decides all placement.

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

**The replication question.** A second reviewer compared Kafka's shape, Raft per shard, ring-computed views and a shared log ([V5-REPLICATION.md](V5-REPLICATION.md)). It recommended Raft per shard, and called the shared log "the right hosted evolution, later". The log-first draft took the shared log anyway; this draft returns to Raft per shard, keeping that draft's object store, and adding healing without a controller, an optional planner, and log replicas.

**The log-first rewrite.** The second reviewer critiqued it ([V5-LOG-FIRST-REVIEW.md](V5-LOG-FIRST-REVIEW.md)).
- **Its verdict:** "the skeleton is sound: seal-then-CAS is the right fence", the same shape as Neon's safekeepers and Pulsar over BookKeeper. But not ready for phase 1 as written.
- **Its recommendation:** choose log-first "only if fero deploy is the primary product", accepting about twice the L1 code, a third protocol and a storage tier to run. Otherwise, Raft per shard.

Its eight conditions for phase 1, and that draft's answers:

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

**The Raft-per-shard review.** A fresh reviewer read this draft's L1.
- **Its verdict:** "No. I would not sign off on phase 1 from this document as written; I would with the five edits below (E1–E5), which are small in text and large in consequence."
- **On simplicity:** "Simpler in the safety core: one protocol, one spec. Not simpler in the policy layer", where every critical finding lived. Section 10.2 now says so.

| Edit | The bug it closes | What changed |
|---|---|---|
| E1 | healing shrank a shard to one voter after a 10-minute partition | healing never lowers a voter count; a gone voter is removed only when a replacement exists; under-replication is reported (4.2) |
| E2 | a torn tail after a power loss made every voter unable to vouch | a torn tail is truncated; only damage mid-log makes a replica a new one (4.1) |
| E3 | a refused write later committed from a stale queued copy | the refusal of a resent attempt is appended under its id (4.3). The reviewer asked for every refusal; first sends are left out, since no other copy of them exists, so an idle queue's `empty` answers write nothing |
| E4 | a `sent` write resolved on an offset the next leader reused | `sent` answers carry the attempt id, and the write stays pending and is resent after failover (3.2) |
| E5 | a sleeping project with only log replicas could never let a new server join | log members fold `#meta` and can lead it (4.2) |

Also made: a clamp on writer time; a log replica stands when no full voter has *won*; the read index is per shard, with quiet only when followers are caught up; random disk incarnations; a leave removes only voters dead past `evict.after`; paced hand-backs; honest idle-frame numbers; versions and terms across a split; `recover --new-cluster` keeps the cluster id; removed replicas, `gone` hints for live members, learner catch-up bounds, the unclean-recovery residual, and the corrected recovery precedents. The new cases are R-47 to R-58, and the model gains the properties the reviewer listed (10.2).

