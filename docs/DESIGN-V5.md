# fero v5: one log per shard, Raft for each

A design, a plan and a backtest for the next fero, against `main` at d7c9efe (v4, 1,216 tests) and data at 63fea66. Nothing here is built.

**What this draft changes.**
- The last draft put the log first: log nodes, loglets, chains and a metadata Raft group, with servers on top. That was three protocols, about twice the code ([V5-LOG-FIRST-REVIEW.md](V5-LOG-FIRST-REVIEW.md)).
- This draft uses **one protocol, Raft, once per shard**, as CockroachDB, TiKV and Redpanda do. The cluster's own facts are one more shard. There is no separate metadata group and no outside store.
- **Fixed slots, free shards.** Every resource has 1,024 slots that never change, and starts as one shard (one Raft group) holding all of them. As it grows, slots move to new shards, and back as it shrinks. So a small project runs as plain Raft, a big one is many groups, and one mechanism, moving a slot, does both directions (decision 20).
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
  - Each resource has 1,024 fixed slots, and starts as one shard holding all of them. A shard that gets too big or busy hands half its slots to a new shard; a quiet one hands its slots back and is deleted. Moving a slot is the one mechanism for both.
  - A reader's position is a partition and a number from its slot's own counter, so moving a slot breaks no cursor, version or fence.
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
| **slot** | a fixed hash bucket of partitions: 1,024 per resource, never changed. A partition hashes to one slot forever. Invisible to users | `hash('room42')` is slot 412 |
| **shard** | a Raft group holding some of a resource's slots, with one log and one leader at a time. Invisible to users | shard 7 holds slots 0 to 511 |
| **log** | one shard's records in order, with offsets (Raft's indexes) that never go back | shard 7, offsets 0, 1, 2, … |
| **replica** | one member's copy of one shard's log. A **voter** counts toward the shard's majority; a **learner** gets the log and never stands, but answers vote requests (4.2) | shard 7 on S1, S2, S3 |
| **full replica** | a replica on a server: it folds the rows, serves them, and can lead | S1's replica of shard 7 |
| **log replica** | a replica that keeps the log only: it votes, never serves, and leads only to repair (4.2) | a witness's replica of shard 7 |
| **leader** | the voter that writes the shard, chosen by Raft | shard 7's leader is S2 |
| **version** | the slot's sequence number at a row's last write (below, "Positions") | `b42` at 9,001 |
| **state** | the rows: the fold of the log | what `f.data` shows |
| **server** | a process that runs resources: it holds full replicas, leads some of them, serves reads and runs methods | an app process; a copy in fero deploy |
| **log member** | a process with only the log role: it holds log replicas, and nothing else | a witness on a third machine; fero deploy's log tier |
| **`#meta`** | the cluster's own shard: members, the catalog, and where shards are | |
| **planner** | anything that sends placement hints: the `fero` CLI, fero deploy's platform, an operator. Optional | |
| **object store** | where snapshots and old log segments go: S3 or a compatible store, or a local folder | |
| **client** | a process that follows some partitions and writes through a server | a webserver |
| **relay** | a client that also serves other clients | an edge tier |

**Keys, partitions, slots and shards.**
- **A key** is a top-level key of the resource's object, as today.
- **A partition** is one or more keys that stay ordered and atomic together. By default, exactly one key.
- **A slot** groups partitions under a name that never changes, so the system has a small, fixed set of things to move, and readers have fixed names to count by.
- **A shard** groups slots so that a commit, an fsync, a Raft round and a change of leader are paid per shard, not per partition.
- **Nothing splits a partition,** and a move never splits a slot. A hot partition is bounded by one writer's core. The app splits it (`room42-0` … `room42-3`) if it must.
- **Reading one partition does not mean reading its shard.**
  - Live updates are routed per partition.
  - The current rows come from a snapshot, by key.
  - A replay of one partition's history uses the per-slot and per-partition indexes of each segment (4.1), so it skips the others.

**Slots and shards.**
- Each resource has 1,024 slots, fixed when it is defined (`slots` sets another power of two; it cannot change later).
- It starts as one shard holding every slot. From then on, the shard rule (4.2) adds shards as load grows and removes them as it falls, moving slots between them. That allows up to 1,024 shards per resource, and there is no shard count to choose.

**Positions.**
- Every record carries its slot's own sequence number, stamped by the shard's leader in log-end order. A new leader stamps on from its log end: its committed entries, and the entries of earlier terms it keeps, which its first entry of its own term commits (4.3). Stamping from the committed state alone would give a kept entry's number to a second record.
- A reader's position in a partition is the partition and that number. The slot comes from the partition's hash, so it is never said. The numbers rise, with gaps where other partitions of the same slot wrote.
- A reader of a whole resource holds one number per slot: at most 1,024, about 8 KB.
- A row's version and a lock's fence token are slot numbers too, compared as (epoch, sequence), so a number reused after a recovery never looks newer than it is. None of them names a shard, so moving a slot breaks no cursor, version or fence.
- A slot also has an epoch, which changes only when `fero recover --unclean` may have lost its records. A position from an older epoch is refused `unknown-log`, and the reader takes a fresh snapshot.
- **Why a counter per slot, not per partition.** By default a partition is one row: a counter per partition would be millions of counters, which would have to outlive their rows (or a row deleted and made again would count from 1, and a reader would skip or repeat), and a whole-resource reader would need one number per partition. The cost of per-slot numbers: they are not gap-free per partition, so "how far behind am I in this room" is not a subtraction. An app that needs a gap-free count keeps one with `incr`.

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
| pub/sub | `0` | `false` | `durability: 'none'` from phase 5; until then the persisted log | NATS core, Redis pub/sub |
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
- **`none` and `confirm: 'sent'` land in phase 5** (decision 21). They are the only parts that are not the one log: `none` is a second delivery path, and `sent` needs its own failover rule. Until then, pub/sub is `history: 0, rows: false` on the persisted log: one group-commit fsync, about a millisecond. NATS's fan-out is L3's, and unchanged.

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
- Each snapshot writes only the rows changed since the previous one, plus a removal marker for each row removed since. Layers are laid out by slot, with a per-slot index, so a slot move or a one-slot reader reads only its slot's bytes. A background merge folds layers together in order, as an LSM tree does, and drops the markers once no older layer remains below them.
- A cold start applies the base, then each layer in order, so a removed row stays removed.
- So a big object with small changes means small snapshots.
- A snapshot is cut from copy-on-write state, so it is the state at exactly one offset. It records which slots its shard holds open at that offset, so a replica loading it never takes a moved slot's old rows as live.

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
L1  the log               Raft per shard · #meta · healing · log replicas · slot moves · planner hints
L0  storage and io        one journal per process · group commit · segments · object store · snapshots · transports
```

- **Layer boundaries.** A layer talks only to the one below it, through an interface with its own test suite.
- **The kernel is L0 and L1, and offers five operations on a shard's log:** append, read from a cursor, snapshot, change members, and hand over leadership. L2 and L3 are fero's standard library on top: the fold, conditions, ops, dedup and subscriptions, hosted on the leader and on full replicas. So the kernel's spec is Raft's plus one snapshot property, and L2 and L3 each have their own model (10.2, decision 21). The 3 µs conditional-op pin (8) is measured across this seam.
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
| a few processes on one box (example 01) | each process | 1 (the member that created the shard) while there are fewer than three candidates, the others learners; 3 from three | none | a local folder |
| self-hosted cluster | each app process | 3 (or `copies`), plus learners up to `standbys` | optional: a witness on a third machine when there are two | optional: S3 or compatible. Without it, snapshots and history stay on replicas' disks |
| fero deploy | each copy, with its own disk | 3: the copies, topped up with log replicas when there are fewer than three copies | the platform's shared log tier | S3 |

### 4.1 L0: storage and io

**On every member** (a server or a log member).
- **One journal per process.** Every Raft entry, term and vote, for every shard the process holds, goes into one journal file. One `fdatasync` covers a batch: at most every millisecond, or every megabyte. So a process with 1,000 shards pays one fsync per batch, not 1,000. This is group commit, as CockroachDB and TiKV share one log engine across their groups.
- **Segments.** After the journal fsync, entries are written to segment files per shard, with an index from offset to position, and per-slot and per-partition indexes, so a replay of one partition skips the rest, and a slot can be read out on its own for a move. The journal is truncated only once the segments that cover it are fsynced.
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
  - no slot move is still copying from it;
  - no fork references it.
- **Old offsets** are read from segments, on replicas' disks or in the object store: slower than recent ones, and cached by the server that reads them.

**On a server.**
- **The rows it folds** are in memory, as a copy-on-write structure, so a snapshot can be cut at one offset, and one slot can be cut out of it for a move.
- **State larger than memory** is opt-in per resource. Cold rows are read through from the latest snapshot layers in the object store or on local disk, with the hot set in memory.
- **Its disk holds its replicas' logs and its own snapshots.** Without log members, that is where durability is.

**Transports.**
- TCP, TLS, WebSocket (browsers, with no bridge), and in-process (worlds and the simulator).
- Frames are v4's: encoded once, with a crc32c, and the same bytes are the journal row and the wire (V3-8).
- A frame is sent at the end of the event-loop turn that made it (decision 9). One frame to a peer carries the messages of every shard the two share.
- **Sizes are capped.** A Raft batch is at most 1 MB, a catch-up `APPEND` at most 4 MB, and a frame bundling many shards is cut at 1 MB. A record bigger than a batch is cut into frames between begin and end markers, as big rows are (4.4).
- **Member verbs only on member links.** Raft verbs are accepted only on links from members that passed the door; on a client link they close it, as v4 drops VIEW and VOTE there. Planner and admin `ASK`s (hints, define, alter, recover) need the admin key, checked at the door (L0) before the payload reaches the standard library, so a client link can never carry a `recover`. The forward-once rule of 4.3 applies to every `ASK` that carries a write.

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
  - **A learner answers vote requests** by the normal log rule, and never stands itself, as etcd's raft lets learners vote. A candidate counts only the votes of its own configuration's voters, so this is safe; and it matters when a learner was promoted by an entry it has not yet received. Otherwise a leader that dies mid-promotion, or a leave cut off halfway (example 01), leaves a shard needing a vote its new voter will not give.
  - **A membership change takes effect when it commits,** as in etcd's raft (decision 22), one change pending at a time. So a member demoted by an entry not yet committed is still a voter: it still stands, and the demotion counts only once a majority holds it. The healing spike found the other reading (a change takes effect when appended) stuck: a cut-off leader demotes a member with an entry only that member receives, that member then holds the longest log, refuses its vote to the others, and never stands, so a live majority waits for ever. On commit, or on append with "a member demoted by an uncommitted entry still stands and does not count its own vote", it does not.
  - PreVote and CheckQuorum, so a returning replica cannot unseat a working leader, and a cut-off leader steps down within `election.ms`.
  - A replica is its member id plus its disk incarnation (4.1).
  - Leadership transfer on a planned stop or move, so neither waits for an election timeout.
- **Who stands for election.**
  - Raft's randomized timeouts: each full voter stands after `election.ms` plus a random part of up to `election.jitter` (500 ms in TypeScript, 250 ms native). The random part only needs to be large against a round trip (about a millisecond in one region), so two survivors almost never stand at once, even when many shards fail over together. The Raft paper's range, one to two timeouts, would add a second to every failover on average.
  - Two kinds of candidate wait longer. A member whose clock is more than `skew.max` (1 s) from its peers' median waits twice as long, and `cluster.health` says so; it can still lead when it alone can win. A log replica stands only when no full voter has **won** an election for twice `election.ms`; a full voter that keeps standing and losing (its log is behind) does not hold it back (below).
  - Raft's vote rule decides who can win: a candidate's log must be at least as up to date as the voter's.
  - Leadership is spread afterwards, by the hand-back (healing, below), not by who stands first.
- **The commit.**
  - The leader sends each batch to every voter and learner at once, and writes its own journal in parallel.
  - A batch commits when a majority of voters, the leader counted once its own fsync lands, have it on disk.
  - The leader stamps the commit offset on later batches. When a commit lands with nothing else in flight, it sends the commit offset at once, on a small ping, then goes quiet. So a follower, and a client it serves, never waits for the next batch to see a write.
- **Reads.** Every full replica folds committed entries, and serves reads and subscriptions (4.4). A `fresh` read uses Raft's read index: the leader confirms with a majority that it still leads (one round trip, no fsync), then answers once its fold reaches the commit offset it had then. The read index is a message of the shard's own, carrying its term, and it wakes a quiet shard. Link pings never stand in for it.
- **A new leader** commits an entry of its own term, which also commits every earlier entry in its log. It answers nothing until its fold reaches its log end.
- **The model.** Raft's published TLA+ spec with Ongaro's fix, plus properties for fero's additions:
  - a log replica that leads never accepts a client write;
  - a replica that cannot vouch for its log never votes under its old identity;
  - healing, planner hints and the entries of a slot move are ordinary entries, so every Raft property covers them;
  - at most one shard has a slot open at any time, and a slot's sequence and epoch never go back.

#### Log replicas

- **What they are.** A log replica votes and keeps the log, but never folds rows or serves clients. A log member holds log replicas for many shards. Spanner's witness replicas are the precedent.
- **Why.** Durability needs voters, not servers. With log replicas:
  - two machines survive either one's crash, with a witness on a third failure domain;
  - fero deploy's smallest projects have three voters;
  - a project's servers can sleep, while its log replicas and the object store keep everything.
- **When healing uses them.** Only when a shard has fewer server candidates than `copies` (below), or a planner places them.
- **What they store.** A log replica stores the tail of every shard it votes in, up to the next snapshot, so its disk grows with write volume. v4's witness held no records; this one holds the log, since that is what lets it count toward a commit.
- **Leading only to repair.** A log replica cannot judge conditions, ops or rules, so it never takes a client write. When it leads, it does only this:
  1. commit an entry of its own term;
  2. if a full voter is live, bring it up to date and hand it leadership;
  3. else add a full replica (a server with the resource's code hashes) as a learner, which loads the latest snapshot from the object store and the tail from the log replica; promote it; then hand it leadership.

  Until then the shard refuses writes with the reason, `no-writer`, and `cluster.health` says which server it waits for.
- **Without an object store,** a log replica cannot build a new full replica from its log alone, since it never holds a snapshot. It waits for a full voter to come back with its disk, and says so.

#### Who writes, and handover

- **One writer per shard:** its Raft leader. For a moment, two replicas may each think they lead, in different terms. Only one can commit, because a commit needs a majority and any two majorities overlap. A deposed leader's in-flight writes were never answered as committed (4.3, "no answer before commit"). From phase 5, a `sent` write was told only that it was appended, and its client resends it (3.2).
- **A planned handover** (a roll, a drain, a move).
  1. The leader stops taking new writes to the shard. Writes that arrive meanwhile wait, or get `moved` with the target.
  2. It brings the target up to its log end, then sends Raft's TimeoutNow, and the target stands at once.

  The pause is about one round trip and one fsync. If a failover happens meanwhile, the higher term wins, as always.
- **A failover** (a crash, a hang).
  - The followers miss the leader for `election.ms`. The full voter whose timeout fires first runs PreVote, then the election.
  - A server that led hundreds of shards fails over in parallel: their elections run at once, with their messages batched into shared frames.
- **Warm and cold.** Every full replica folds its shard, so it is warm. Only a log replica's repair is cold: seconds per gigabyte.
- **The writer's time.** `t = max(last t in the log, clamp(clock, peers' median − skew.max, peers' median + skew.max))`, where the peers' clocks ride the link pings. So a clock that jumps ahead (a VM resumed after a year) cannot stamp a far-future `t` that expires every TTL and lease, and a clock hours behind cannot hold `t` still, freezing every TTL, lease and `ctx.now()`. A skewed member waits longer to stand (above), never barred.

#### Failure detection

Two members that share a shard exchange a link ping every `ping.ms` (500 ms) when no other frame went their way, sent from the kernel's own thread (decision 13). Every shard the two share uses that ping. While a shard is busy, its Raft messages ride the same frames.

| Event | Detected after (default) | What happens |
|---|---|---|
| a leader's process stops | `election.ms` plus up to `election.jitter`: 2 to 2.5 s in TypeScript, 1 to 1.25 s native; tunable down to 500 ms | each of its shards elects (above) |
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
  - **candidates** are servers with the resource's code hashes and room, that are not `retiring` or `gone` in `#meta`, and that the leader's own link has reached within `evict.after`; log members count too when there are fewer such servers than `copies`. A `draining` member stays a candidate: draining gives up leadership, not replicas;
  - **voters:** `copies` of them (3 by default), the top candidates by rank, servers first;
  - **learners:** the next servers by rank, up to `standbys` full replicas in all;
  - **a shard created with fewer than three candidates** starts with one voter, the member that created it (in example 01, the first process), and the others as learners. A shard with two voters could not survive either one's crash, so it grows from one to three as candidates arrive, passing through two only for the moment of the change. Its one voter stays the incumbent across restarts.
  - **healing raises a voter count only to an odd number:** from one to three once three candidates are live, never to two. With an even number of candidates, the extra one is a learner. So a shard a leave left with one voter takes a returning member back as a learner until a third candidate arrives.
  - **two voters step back to one.** A shard can still end at two: a leave from three with no learner, or growth from one to three cut short by a crash between its two promotions. With fewer than three live candidates, neither voter `retiring`, and `copies` not 2, the leader demotes the other voter to a learner. This is the one step by which healing lowers a voter count, and it matches the choice for two machines (Leaving, below). The healing spike found the shard otherwise sits at two for good, where either crash stops its writes.
- **The steps.** When the shard's replicas differ from the target, the leader makes one change at a time, each a Raft entry:
  - **healing never lowers a shard's voter count,** except two voters stepping back to one (above). Only a `leave` (below) or an operator does;
  - **a swap promotes first, then removes.** Every replacement, of a gone voter or of a live voter not in the target, goes: add the replacement as a learner; let its log reach the leader's commit offset, exactly, not merely within `lag.max`; promote it; then, once its log reaches the commit offset again, its own promotion included, remove the old voter in the very next step. If the new voter is gone first, that step removes it instead, and the old voter stays. The healing spike showed this second check is the one that carries the weight: without it, a new voter that pauses and misses its own promotion leaves the newest commit on two of three voters. So the shard holds one extra voter only between those two steps, never two fewer, and a gone voter that comes back while its replacement catches up is still a voter. No step lowers the number of answering voters holding a committed entry;
  - **a gone voter** is one whose link has been down past `evict.after`, or that `#meta` marks `gone`. With no replacement candidate it stays in the configuration: the shard is under-replicated and says so, and its live majority still commits. So a 10-minute partition of one of three members never shrinks a shard below three voters. It is removed with no replacement only when the voters left are still an odd number at or above the target, which settles a swap or a leave cut off between its two steps;
  - **a retiring voter is left to its own leave** while the leave runs, so only one of them promotes a replacement. After `leave.ms`, healing treats it as any other voter not in the target;
  - a new replica loads a snapshot (from the object store, or streamed from the leader) and the tail. It counts as caught up when it is within `lag.max` of the leader's commit offset. One that has not caught up within `catchup.max` (10 min), say on a shard too hot to follow, is reported as a `cluster.health` row naming the shard and the member, and a planner's `place` can move the shard elsewhere.
- **Under-replication is never silent.** `cluster.health` and one stderr line say when a shard has fewer live voters than `copies`, or fewer than the voters in its configuration, and why. The second catches a shard holding four voters, one dead, after a cut-off swap, whose three live voters equal `copies`.
- **A removed replica** learns it from the leader's refusal, or from `#meta`'s shard record. It stops standing for elections and serving its rows at once; PreVote keeps it from disturbing the shard meanwhile. It deletes its copy once `#meta` shows the shard's current configuration without it, as CockroachDB's replica GC does.
- **A copy on a returning disk is reused.** Until it is deleted, if healing adds that member back as a learner, it starts from the log it has, and the leader sends only the tail it lacks (Raft's log matching repairs any divergence). So a member back after `evict.after` copies only what changed. If its copy was deleted meanwhile, it asks for a snapshot, as any new replica does.
- **Leaders spread.** Each shard's preferred leader is the full voter the ring ranks first for it. When it has been live and caught up for `settle.ms` (30 s), the leader hands leadership to it, as Kafka's preferred-leader rebalance does. So leadership returns after a failover, without flapping. A member takes back at most ten leaderships a second, so a member returning as the preferred leader of 3,000 shards does not take them in one tick.
- **Pacing.** Each member loads at most two snapshots at a time and answers `busy` to more, and a leader that hears `busy` backs off. With rendezvous hashing, a new member takes about `copies`/n of the replicas, and a gone one gives up only its own.
- **Members.** The leader reads members from `#meta`, which every member follows, and liveness from its own links. **Who writes `gone`:** a planner, or else `#meta`'s own leader, from its own links: a member its links have not reached for `evict.after` is marked `gone`, and the mark is cleared when that life reaches it again. So the ring stops ranking a dead member with no planner, and a member back after an hour is a candidate again, taken back by a swap like any other. A stale view only delays or repeats a step: every step is a Raft change in the shard's own log, so it is safe whatever the view.
- **Slot moves** are also decided by each shard's leader, by size and load (the shard rule, below).

#### The planner (optional)

- **Who.** Anything holding the admin key: the `fero` CLI (`fero run --copies 3`, `fero scale`, `fero drain`), fero deploy's platform (its rolls and autoscaler), or an operator's script. A cluster runs without one.
- **What it sends.** Hints. A shard hint names the shard config it read: the offset of the shard's last membership change.

| Hint | Does |
|---|---|
| `drain(member)` | written to `#meta`. Leaders hand over the shards it leads, and it is no shard's preferred leader while drained. It keeps its replicas. A roll drains each copy before it restarts it |
| `retire(member)` | written to `#meta`. As `drain`, and healing moves its replicas off, since a retiring member is never a candidate. A scale-in retires a copy before it stops it; a `leave` retires itself. Where no replacement exists, say three members and `copies: 3`, the member stays a voter and the retire stays pending, and `cluster.health` says why: going below `copies` is a `leave` (Ctrl-C), which may lower a count, not a `retire` |
| `undrain(member)` | clears `drain` or `retire` |
| `gone(member, life)` | written to `#meta`. Leaders replace it now, instead of after `evict.after`. A leader whose link to that life is up ignores it |
| `lead(shard, member)` | a leadership transfer to that full voter. It also sets the shard's preferred leader, so the `settle.ms` hand-back does not undo it |
| `place(shard, members)` | stores a target in the shard's log, which healing then follows. `place(shard, null)` returns the shard to the ring |
| `move(slot, shard)` | moves one slot now (below) |
| `shards(resource, n)` | asks the shard rule for n shards; slots are moved until there are |

- **Why a stale planner is harmless.** A shard applies a hint only if its config is still the one the hint names. Otherwise it refuses `stale-plan`, with the current config. And every change a hint causes is a Raft change in the shard's own log. So two planners at once can waste moves, never break anything. A lease row in `#meta` keeps two from fighting.
- **What a planner adds.** Placement by load and memory, not only the ring; drains before restarts and retirements before stops; acting at once on a machine it knows is gone; slot moves ahead of load.
- **Precedents.** Redis Cluster fails over by itself, and rebalances with an outside tool (`redis-cli --cluster rebalance`). CockroachDB has no central planner. TiKV requires one (PD), which fero avoids.

#### `#meta`, the cluster's own shard

- **A system resource, replicated like any shard:** 3 voters from three members (5 if set), chosen by the same ring and healed by the same rule. Every member follows it as a subscriber (4.4), so every member has the members and the directory.
- **Log members fold `#meta` too.** It has no user code, so a log member holds a full replica of `#meta` and can lead it like a server. So `#meta` has a writer whenever a majority of its voters lives, and a new server can always write its member record. Without this, a project whose servers are all gone, with only log replicas left, could never let a new server join (the wake case in 6.1).

| Record | Holds |
|---|---|
| member | id, life (random per process start), disk incarnation, roles (server, log), addresses (listen and advertised), capacity, code hashes it can run, kernel version, join offset, state (live, draining, retiring, gone) |
| resource | name, config (4.5), allowed code hashes, seed applied, write gate (open, or read-only with a reason) |
| shard | resource, incarnation, the slots it holds (together, the slot table), and its last known replicas and leader. **This is a hint:** each shard's own log is the truth, and leaders refresh this record after each change, the newest config winning |
| cluster | id, cluster version, current and next door secret, CA key envelopes, revoked certificates, the planner lease |

- **What `#meta` is not.** It is not on the write path, and not in any shard's failover. While its majority is lost, writes and failovers carry on. Joins, new resources and directory updates wait.

#### Scaling up and down

**What moves, and from where.**
- A server that becomes a replica of a shard copies it: the latest snapshot from the object store (or streamed from the leader) and the tail from the leader. So adding a server moves data to it: about `copies`/n of all replicas, paced.
- Durability depends on each shard's voters, not on how many servers run, and log replicas can be voters.

| Change | What happens |
|---|---|
| add a server | it joins `#meta`. Rings now rank it, and each shard whose target now includes it adds it, one change at a time, paced by snapshot loads |
| remove a server | with a planner: it is retired first (leaders hand over, then replace its replicas), then it stops. Without one, Ctrl-C is a `leave` (below) |
| add a log member | it joins. Shards with fewer server candidates than `copies` place voters on it |
| a shard gets big or busy | it hands half its slots to a new shard (the shard rule, below) |
| a shard gets small and quiet | it hands its slots to a sibling and is deleted |
| scale to zero (sleep) | needs log replicas: the servers stop, and the log replicas and the object store keep everything |
| wake | a server starts. Each shard's leading log replica brings it up to date, or adds it, then hands it leadership (repair, above) |

**Moving a slot.** The one way data changes shards, pull-style, as Redis Cluster's IMPORTING and Vitess's cut-over do. To move slot s from shard A to shard B (a move may carry a set of slots at once, with the same steps, so a grow is one move of many slots, not many moves):

**Two kinds of rule.** A step that **waits for** an entry acts only once that entry is committed, since a leader can be deposed before its entry commits. A guard that **forbids** a step once an entry exists counts the leader's whole log, committed or not, since an entry still in its tail may yet commit. The slot-move spike found that reading the second kind as "committed only" lets two shards hold s.

0. **A's leader commits `exporting(s, to B)`.** From then A owns the move: a new A leader that finds `exporting` in its log carries the move on, or cancels it. The move is named by that entry's position, and every message of the move carries the name, so a late message from an ended move is ignored. B refuses a name it has already imported or aborted. B's reports also carry B's incarnation, since after a recovery the same name can reach a new B. One move of a slot at a time: A appends `exporting` only while s is open in its log and no earlier `exporting` since then is still under way.
1. **B's leader commits `importing(s, from A)`,** then copies s while A still takes writes: by subscribing to s at A in `state` mode, or from A's latest snapshot in the object store and A's tail. B writes the copy into its own log, as import entries or a snapshot layer named by one, invisible to views and reads, and commits it. Only then does B tell A it is **ready**, with the position its copy reached, and it repeats that report until A answers with `fenced` or a cancel. Until `open` commits, B answers writes to s `retry`, with a retry-after, never `moved(A)`.
2. **A's leader commits `fenced(s, to B, N)`** on B's ready report, where N is s's last sequence number in its log. The fence records the incarnation of B whose report it acted on. From the moment `fenced` is in its log, A takes no write to s: it answers `retry` until `fenced` commits, then `moved(B)`. Only once `fenced` commits does A send that incarnation of B, and no other, what changed since its ready position, then `END(N)`, then the carried state (below). Nothing follows the fence, so that delta is complete.
3. **B's leader writes `s → B` into the slot table in `#meta`, then commits `open(s, N)`,** once the delta, `END(N)` and the carried state are committed in its own log. It serves s only after `open` commits. If `#meta` has no majority, the move waits here.

- **The slot is unwritable for about three commits:** A's fence; then the `#meta` row, while B commits the small delta; then B's open. The bulk was committed at B before the fence.
- **Writes in flight at A when it fences** were appended before the fence, so they commit or fail at A as usual, and A answers them; their effects are in the delta.
- **Cancelling.** Before `fenced` is in its log, A cancels on its own: it commits `cancel(s)` and tells B, which drops its copy. A never fences once `cancel` is in its log. After the fence only B can give the move up: it commits `abort(s)`, only while its log has no `open`, and never opens once `abort` is in its log. It always writes `s → A` back, since after a recovery its log may not show an earlier `s → B`. Then it reports the abort, with its incarnation and s's epoch at B, until A answers. A, on a committed `abort` from the incarnation its fence names or a newer one, commits `unfenced(s)`, which reopens s at A at N, in the higher of N's epoch and the one the abort carries. So once B's records of s may have been lost, A stamps in a new epoch, and no position names two records.
- **Carried state:** the slot's rows and its sequence and epoch; per issuer, the committed outcomes tagged with s (4.3), and the issuer's highest call id, merged by `max` at B; A's whole table of highest fence tokens per lock, also merged by `max`, since locks live in `#locks`, not in s, and B may already hold a higher token from another slot; and the names of the segments that hold s's records below N, A's own and those A was carried, so the list grows over chained moves and B can serve `log` readers once A is gone.
- **Why the `max` merge is safe.** A writer that saw id h knows the issuer issued h. By the issuer's window (4.3), every id at or below h − `issuer.window` already has a definitive answer, whichever shard gave it. So raising B's floor forgets only answered attempts. Without the merge, a late copy of a committed write could land at B as fresh.
- **Crashes.** Each leader resumes from its own log. A new A leader with `exporting` waits for B's ready report, cancels, or, with a committed `fenced`, re-sends from B's position. A new B leader with `importing` re-subscribes at A and repeats its reports. A recovered shard is the exception (recovery, below): it does not resume a move of a slot it leaves shut.
- **A lost B.** If B's voters are all lost after the fence, s stays fenced at A until an operator runs `fero recover --unclean` for B. With a surviving copy of B, recovery settles s (below). With none, the command gives each slot B took back to the shard that fenced it to B, by `unfenced` at its fence in a new epoch, and lists as lost whatever B may have taken.
- **Views mid-move.** A server that replicates both A and B takes each slot from exactly one of them: A's copy until it has applied B's `open`, then B's. B's imported copy is invisible to views and reads until then, so a slot never counts twice or not at all. A server that replicates A but not B switches s off when it applies A's `fenced`, since it will never see B's writes: from then it answers reads of s `moved(B)`, and its subscribers of s get `END`.
- **The slot table** in `#meta` names, for each slot, the shard that holds it open, or is about to: B writes `s → B` before it opens, and after an abort writes `s → A` back before A reopens. So whenever a shard holds s open, the table names it; the table is never behind an open. **Every write of a slot's row carries a version:** the slot's epoch, the move's name, the writer's incarnation, then the step (1 for `s → B`, 2 for `s → A` back). `#meta` keeps the highest, so a late `s → B` never lands over a write-back. A version by the writer's log position would not do: positions from two shards, or from before and after a recovery, do not compare. Routing treats it as a hint, and a stale route costs one `moved`. Recovery treats it as the authority (4.2, recovery), which is safe only because it is never behind.
- **`state` readers** need nothing: positions are per slot (2). A subscriber of s at A gets `END` at the fence, with its position, and resubscribes at B.
- **`log` readers** (a tape, a derived resource, `read({ from })`) at a position below N are answered by B `moved(A)`, or `expired` once `history` has lapsed. s's records before N stay in A's segments or the object store, and a replay across a move reads A's segments for s, then B's. Once A is deleted, B serves s's records below N itself, from the carried segment names in the object store; without an object store, A is kept until `history` has lapsed for every slot it moved.
- **A shard is deleted** only once its segments are uploaded or its `history` has lapsed, and once the slot table has shown none of its slots for a grace period (`settle.ms`). Meanwhile its former members answer `moved` from the table, so a client with a stale route is never left dialling nothing. With `history: 'all'` and no object store, a shard that moved slots out is never deleted: a shrink there moves the slots, and the old shard stays, holding no slot, to serve old records.
- **The model.** At most one shard holds s open (a committed `open`, `unfenced` or genesis, with no later committed `fenced`); no slot sequence number is stamped on committed records by two shards; a slot's sequence never goes back; every write committed to s at A is at B when B opens; no acknowledged write goes missing; no attempt commits twice; an attempt its issuer was told was refused never commits; whenever a shard holds s open, the table names it; and with no more faults, every move finishes or is cancelled. [The slot-move spike](v5-spec/slot_move.md) checks these by exhaustive search on small bounds (up to 7.5 million states: shards A, B and C, two moves, one unclean recovery of either shard), with every guard read as above. Leaving out any one of the rules above breaks a property, except two kept as defense in depth: B serving only after `open` commits, and recovery asking the other shards.

**The shard rule,** the only automatic policy for data, run by each shard's leader as healing is:
- **Grow.** Over `shard.bytes` (4 GB) or `shard.rate` (half the leader's measured write capacity), the leader creates a shard (one `#meta` record, whose first voter is the creating leader's own process; healing places the rest) and moves the half of its slots that splits its measured load evenly, ties broken by slot number, as one move.
- **Shrink.** Under a quarter of both for `shrink.after` (6 h), so a daily cycle does not move gigabytes each night and back each morning; not the resource's last shard; and only when its smallest sibling stays under half of both limits after taking its slots, so a shrink never sets off a grow. Then it moves its slots there and is deleted (above).
- **One move at a time per resource,** by a lease row in `#meta`, paced like snapshot loads.
- **A hot slot** can get a shard of its own. A hot partition is still one writer.
- **The planner** may say `move(slot, shard)` and `shards(resource, n)`, checked like any hint.
- **When.** Positions take the slot shape in phase 1, before any move exists, so nothing changes shape later. Phases 2 and 3 run one shard per resource. Moves land in phase 4, where fero deploy first needs them, and shrinking comes with them.

**What stays limited,** said plainly:
1. **One partition, one writer.** A hot slot can get a shard of its own, but one partition is never split.
2. **A new replica copies its shard.** Adding a server moves about `copies`/n of all replicas to it, from the object store where there is one.
3. **Memory.** Each full replica holds its shards' rows. Room grows with servers only while `standbys` is below the server count; at the default, every server up to five holds every row.
4. **Fold CPU.** Every full replica folds every write of its shards.
5. **A commit** costs at least one fsync and one round trip to a majority of voters.
6. **Two voters cannot survive a crash.** So below three candidates a shard has one voter, and a crash of its machine stops that shard's writes until it returns, unless a witness makes three.
7. **Many groups.** Each shard costs its Raft state in memory, and frames while it is busy. Quiet shards cost only their members' link pings. Phase 2 pins 2,000 idle shards per process.
8. **Wake time.** A snapshot read: about a second when small, about a minute for 10 GB.
9. **Member pairs.** Idle link pings grow with the pairs of members that share shards: about 20,000 frames/s at n = 100. Phase 2 pins that; larger clusters raise `ping.ms`, or bound how many peers each member shares shards with.

#### Leaving, restarting and stopping

| Stop | Used by | What happens |
|---|---|---|
| `leave` | Ctrl-C, SIGTERM or `destroy()` when not under a supervisor; scale-in without a planner | **First** it marks itself `retiring` in `#meta`, so no healing step, its own shards' included, targets it again. If `#meta` has no majority, the leave goes on without the mark after `leave.ms`. **Leadership:** it hands over every shard it leads. **Votes:** in each shard where it is a voter, the leader first promotes a caught-up learner, if there is one, so the voter count holds; then it removes the leaver once that learner's log reaches the leader's commit offset, exactly, its own promotion included, as a swap does, and only if the remaining live voters stay a majority of the new set. Removing it sooner left the newest commit on two of three voters in the healing spike. So two members leaving one after the other do not leave a shard with one voter while learners remain. Dead voters are removed first, when that is what lets the leave carry (as V4-60). For a leave, a voter is dead when its link has been down past `election.ms` and it still does not answer the leader's probes for the rest of `leave.ms` (4 s), longer than any GC pause the timeouts tolerate. A paused voter answers in time, and is kept. A shard where neither is safe keeps it as a voter, and `destroy()` names it, along with any dead voter it removed. **One voter:** if it is a shard's only voter, it promotes a learner first, then hands over, then leaves. Bounded by `leave.ms` (4 s). Healing later adds replacements |
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
  - `fero recover --unclean <shard>`, when a shard's voters have permanently lost their majority. One surviving replica forces a configuration of itself, as TiKV's `unsafe-recover` and CockroachDB's `debug recover` do for one range. It reports what may be lost, and bumps the shard's incarnation in `#meta` and the epoch of each slot it holds, so stale cursors are refused instead of waiting.
  - **Recovery and moves.** The surviving copy may be from before a move's fence, or from before an `unfenced`. So a recovered shard reopens a slot only when the slot table gives it that slot and its copy holds the slot's rows. It re-fences every slot the table places elsewhere, and never reopens one. It also asks every reachable shard of the resource, and refuses to reopen a slot any of them holds open or is importing. Before it reopens a slot, it writes the slot's table row at the slot's new epoch, which beats every table write made before the recovery, so an `s → B` still in flight can never land over it. A slot it cannot settle (the table gives it a slot its copy lacks, or a shard does not answer) stays shut and is listed. For every slot it leaves shut, it ends its part in every move of that slot in its copy: it aborts an import, cancels an export it has not fenced, and never reopens the slot through a fence made before the recovery; the slot then settles by the other shard's rules, or by the operator. The command shows the whole list before it runs. Of these rules, the slot-move spike shows the table write at the new epoch carries the weight; asking the other shards is defense in depth. The table can be the authority here only because a move writes it before it opens (4.2, the slot table).
  - **The residual case:** if the "lost" majority was only partitioned, it may still elect under the old incarnation. Its leader learns the bump from `#meta` when it can reach it, and stops; until then two writers exist under two incarnations, and the command says so before it runs.
  - `fero recover --new-cluster`, the same for `#meta` (etcd's force-new-cluster is the whole-cluster precedent). It bumps `#meta`'s incarnation and keeps the cluster id, so cursors on healthy shards stay valid. Members compare `#meta`'s incarnation in HELLO: one with a lower incarnation stops its `#meta` replica, adopts the higher one, and comes back as a new replica of it. So an old voter returning with its dir never revives the old `#meta`. On the bump, every shard leader re-writes its shard record and the slots it holds open, and every server re-registers its resources, so a `#meta` rebuilt from a copy that was behind learns every shard and resource made since.
  - **Both commands refuse** while any voter they would drop answers, and name it. A voter that cannot be reached is named too, so the operator sees what may still come back.
- **Routing.**
  - The partition-to-slot function is a fixed 64-bit hash with a full avalanche finaliser, versioned with the frame format.
  - A leader refuses a record whose partition is not in its shard (`wrong-shard`).
  - Clients send writes to their server, which maps each row key to its shard (a custom `partition` function runs only on servers) and forwards to the shard's leader. It finds the leader from its own replicas, or from `#meta`'s directory. A stale answer costs one `moved`, which names the current leader, or the shard a slot moved to.
- **Who dials whom.** Members dial only members `#meta` names, plus their `hosts` and the box directory. Never an address a client claims.
- **Hosted.** Each project's `#meta` is a shard like the others, on the project's own copies and log replicas, and quiet ones cost nothing. A log-tier process runs one log member per project, sharing the process and its journal, with a quota each.

### 4.3 L2: fold and ops

**The record.** A batch has one header: the leader's term, the base offset and the writer's time `t`. Each record inside has its own offset (base plus index), its slot's sequence number, its own attempt id, and data's delta.

| Field | Why |
|---|---|
| term | which leader wrote it; a deposed leader cannot commit (4.2) |
| offset | the shard log's order; Raft; retention |
| slot sequence | versions, cursors and fence tokens: per slot, so they survive moves (2, "Positions"). One varint |
| writer time `t` | TTLs, leases, `ctx.now()` at the writer; `max(previous t, clock)`, carried across writers |
| attempt id (issuer, call id) | dedup of retried writes. The issuer is the process id plus its life, so a restarted process never repeats an id |

**At the writer, in this order:**
1. **Dedup.**
   - **What it checks.** If the attempt id is in the shard's log, committed or in the writer's uncommitted tail, the writer answers with the original position (slot, epoch, sequence), and nothing else runs. An outcome carried by a slot move keeps its position, which an offset could not.
   - **No answer before commit.** Every answer (a dedup answer, a refusal such as `conflict`) is judged against the writer's log-end state, so it waits until the commit offset reaches the version it was judged against. If the leader loses leadership first, the answer is `unknown`, and the issuer retries at the new leader.
   - **What the issuer promises.** Its call ids rise. Its ids span less than `issuer.window` (1,024): its highest issued id minus its oldest unacknowledged id is always below the window. The window is a cluster key, so every issuer and every writer use the same one. It stops retrying an attempt after half the retry horizon: the horizon is 10 minutes, so retries stop at 5.
   - **What the writer keeps.** Per issuer and shard: the highest call id seen, and every committed outcome above the floor (a commit, or an appended refusal), kept by id. Each outcome is tagged with its slot, so a slot move carries it (4.2). An issuer silent for the whole retry horizon (10 min) is forgotten, from memory and from snapshots, so this state is bounded by active issuers.
   - **The floor.** An attempt at or below (highest id seen) − `issuer.window` that is not among the outcomes is a late duplicate of an answered attempt, and is refused `stale-attempt`. Above the floor, an attempt not among the outcomes never committed, and is judged fresh.
   - **No late arrivals.** An attempt carries a time budget its issuer sets to half the horizon, and every hop subtracts the time it held it, on its own monotonic clock. A server forwards an attempt only over the link to the leader it had when it took the attempt; after any break it answers `retry`, and the issuer resends. Resends back off with jitter, from 200 ms up to `election.ms`, and a `no-writer` or `moved` answer carries a retry-after, so an election never brings a retry storm. A leader closes a link that misses pings for `election.ms`, so a frozen server's late forward never lands. These bound how late a copy can arrive; what makes every answer unique is the log: committed outcomes, and the appended refusals of resent attempts (below).
   - **Across leaders.** The outcomes, and each issuer's highest call id seen, are part of the shard's state, so snapshots carry both. A new leader holds every committed entry (Raft's leader completeness), and folds its whole log before it answers. So the floor never drops below where the old leader had moved it.
2. **Shape checks that need the current row.**
   - Array holes (`sparse-hole`, V4-28/33).
   - An insert under an existing row.
   - A field write to a row that does not exist is refused `absent-row` (decision 14), and one whose parent field does not exist is refused `absent-path`, so a write under a removed field never recreates it silently.
3. **`validation` and `rules.write`**, with the current row.
4. **Conditions**, against the writer's state at this point in its log.
5. **Ops**, which compute the value to append.

**Refusals.**
- **A refusal of a resent attempt is an outcome.** An attempt says whether it has been sent before: an issuer's resend after `retry`, `unknown` or a timeout, or a call's re-run (4.5). The writer appends the refusal of a resent attempt as an entry with no data, under its attempt id. So a stale earlier copy that arrives later, even at a later leader, finds it and gets the same answer. A refusal already waits for a commit, so this adds no wait. A `stale-attempt` refusal is the one exception, never appended: the floor that gives it comes from the highest id, already in the log, and only rises, so every copy gets the same answer anyway. Appended, it would sit below the floor, be dropped at once, and let a duplicating link grow the log with no write behind it.
- **A first send's refusal is not appended.** So an idle queue's `empty` answers, and a rate limit's refusals, write nothing to the log.
- **An issuer that has resent accepts only an answer to its latest copy.** Each copy carries its copy number. A first send can still be in flight when a timeout resends it, so its unappended refusal may arrive first; the issuer ignores it and waits for the latest copy's answer. That answer always agrees with the log: if either copy committed, the other is a dedup hit, and a refused resent copy is appended for the other to find.
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

**Row retention** (3.1) runs on the writer's tick, as records with a reason. The writer keeps an expiry heap, so a tick costs what expires, not what is held. A `rows: { max }` limit is per resource, enforced per shard as its share of the slots. A lease condition (`{ expired: 'lease' }`) is judged by that shard's writer time, which may differ between shards by up to `skew.max`.

**The fold** is data's: records apply through its hot lane in offset order, the same on writers, followers, clients and replays, with no LWW comparison anywhere.

### 4.4 L3: flow

One verb serves followers, clients, relays, consumers and the viewer: **subscribe**, with a selector, a mode and a cursor.

| Part | Values |
|---|---|
| selector | `resource`; `partitions: [...]` (a follow set); `prefix`; `view` (a server-side view, 4.5); `slots` (servers, relays and slot moves) |
| mode | `state`: a snapshot, then deltas, conflated per row for a slow reader. `log`: every record from the cursor, never conflated |
| cursor | the cluster id, the resource's incarnation, then per slot its epoch and the sequence last seen: one entry for each followed partition's slot, or up to 1,024 for a whole resource; or `'latest'`, `'earliest'` |

- **Who serves.**
  - Any full replica of the shard that is ready: its leader, a follower or a learner. A replica is ready once its snapshot has loaded and its fold has reached the commit offset it was told when it started; until then it answers `moved`, naming a ready one. Readiness is also per slot: a shard serves a slot only while it holds it open, so B answers `retry` for s until its `open` commits and its fold has applied it, and A answers `moved(B)` once its fence commits. Always up to the commit offset, and never before its fold has reached the subscriber's cursor.
  - Older offsets come from segments, on replicas' disks or in the object store.
  - A follower that falls behind the tail and reloads a snapshot ends its `log` subscriptions on that shard with `expired`, and re-snapshots its `state` subscriptions.
  - A one-shot read at a server that neither folds nor relays the partition is refused `moved`, naming a full replica. A relay answers only after its upstream snapshot has landed, never from an empty fold.
  - A server that stops folding or relaying a partition ends that part of each subscription with `END` and the cursor, so the subscriber resubscribes elsewhere and never waits on a silent server.
  - A server asked for a partition it does not fold subscribes upstream itself, and becomes a relay for it.
- **Cursors know their log.** A cursor whose cluster id or resource incarnation does not match, or whose slot epoch is older than the slot's, is refused `unknown-log`. A cursor whose epoch is newer than the server's means the server is behind: it answers `retry`, and a reader never drops back to an older epoch. Past retention, `expired` with the earliest available.
- **A snapshot replaces.** It replaces the subscriber's whole view of the selected partitions, applied as one diff between begin and end markers, so ghost rows cannot survive and nothing flickers.
- **Deltas carry their slot sequences**, so a filtered subscriber's cursor is exact, and stays exact across a slot move.
- **Credits.**
  - A subscriber grants credit in bytes, and a grant always admits at least one record.
  - A `state` subscriber that falls behind is conflated per row. A `log` subscriber is paused and resumes from its cursor.
  - Every link's queue is bounded; a link that overflows is closed with its reason, and the peer returns with its cursor.
- **Routing.** A per-shard index maps partitions to subscribers: one lookup per record, plus one write per matching subscriber, encoded once.
- **Failover.** A subscriber whose server goes away resubscribes elsewhere with its cursor. `log` misses nothing; `state` gets the deltas since, or a fresh snapshot that replaces.
- **Big rows and snapshots** are cut into frames by size, between begin and end markers, so a snapshot lands as one apply.

**Writes from a client.**
- **Read-your-writes.** A write resolves when it has committed and, if this client follows the partition, its own subscription has passed the write's position.
- **Failover.** The client resubscribes from its own cursor, and its waiting writes' positions go along as a minimum. The new server answers only once its fold has reached them, so a resolved write is always visible and no record in between is skipped.
- **Reads after a write.** A client's reads carry the highest position it has seen per slot, and a server answers only once its fold has reached it.
- **The pending-write queue** is bounded by count (512, strictly below `issuer.window`, so the window's span rule always holds) and bytes (64 MB). When full, a new write is refused `backpressure`.

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
    - Its writes carry attempt ids whose issuer is the call key and whose call id is the write's order k, so a re-run on any server issues the same ids. Each record also carries a hash of its content. So a re-run's identical writes dedupe, and a dedup hit whose content hash differs is refused `call-diverged`. A keyed call may make at most `issuer.window` writes. Detection is per slot, said plainly: a re-run whose k-th write goes to another slot is not caught. So handlers must be deterministic given their input and `ctx`, as fero test already asks: `ctx.now()` is the call claim's writer time, and `ctx.id()` is derived from the call key and a counter, so a re-run sees the same values.
  - **Fences.**
    - Every write a call makes carries `if: { fence: { lock: callKey, token } }`.
    - The runner renews the lease while it runs, and stops writing if its last renewal is older than the lease minus a margin (a round trip plus `skew.max`).
    - A call is re-run only within half the retry horizon. Past that it is marked `unknown`, with the positions it wrote.
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
    - The CA key lives in `#meta` only as envelopes encrypted to each of `#meta`'s voters' keys. Log members can be `#meta` voters, so on fero deploy the platform's log tier holds each project's CA envelopes: the platform is trusted with them, and says so.
    - Joins use single-use join tokens (`fero join-token`); fero deploy mints one per machine.
    - A client checks a server against the CA fingerprint in its own credential.
    - Each member gets its own certificate at join. A removed member's certificate is revoked in `#meta`.
  - The secret rotates through `#meta`: current and next, during a window.
- **`cluster.writable`** is true when every shard of the resource has a leader on a full replica that heard from a majority of its voters within `election.ms`. `cluster.shards` details each shard: its voters, learners and leader, and how many of them are live.
- **Fewer members than `copies`.** A shard created with fewer than three candidates has one voter, healing never lowers a voter count, and `cluster.health` and one stderr line say when a shard has fewer live voters than `copies`, or than its configuration holds (4.2). So two processes on one box is visibly one voter and one learner.
- **Defining and changing a resource.**
  - The first `fero(name, opts)` that creates a resource writes its config to the catalog, which is the source of truth from then on.
  - A later open with different options is refused, naming the difference, unless an `alter` in progress allows its code hash.
  - `fero.alter(name, change)` changes a resource online: a roll adds the new hash before and removes the old after.
- **Config, in three scopes.**

| Scope | Lives in | Keys | Changes |
|---|---|---|---|
| node | the config cascade, as today | `uuid`, `dir`, `listen`, `advertise`, `hosts`, `seeds`, roles (`server`, `log`), `object` (the object store), `secret`, `secret.client`, `rendezvous`, `heartbeat.ms`, `redial.*`, `leave.ms`, `journal.cap`, `diag.allow`, `signals`, `memory`, `cache`, `connect.wait` | restart that node |
| cluster | `#meta` | `#meta`'s `copies`, default `copies`, `ping.ms`, `election.ms`, `election.jitter`, `evict.after`, `settle.ms`, `catchup.max`, `skew.max`, `lag.max`, `issuer.window`, `shard.bytes`, `shard.rate`, `shrink.after`, cluster version | online through `fero.alter('#meta', change)`, which checks each key's range and the keys against each other (say, `election.ms` above twice `ping.ms`, `skew.max` below `election.ms`) and refuses with the reason. `issuer.window` may only be raised online: a lower window would put in-flight attempts below the floor |
| resource | the catalog | `slots` (1,024, fixed when defined), `copies` (voters per shard, default 3), `standbys` (full replicas per shard, voters and learners), `partition`, `history`, `rows`, `durability`, `validation`, `rules`, `methods`, `load` | online through `fero.alter`; code by allowed hash |

- **Worlds** (fero test): a bound world resolves names to stand-ins, makes server markers into solo nodes, and supplies `now` and `id`. A solo node is the same code: a server that is the only voter of every shard, over a local-folder object store.

### 4.6 L5: libraries and adapters

L5 is built only from L4 calls; each library is a file with its own tests, and none adds a wire verb:
- the queue, consumer groups, locks, presence, rate limits and loaders (5.3);
- the RESP, Kafka-protocol and WebSocket gateways;
- the `fero` CLI: `run`, `test`, `deploy`, `ls`, `debug`, `recover`, `join-token`, and the planner's verbs (`drain`, `retire`, `undrain`, `gone`, `lead`, `place`, `move`, `shards`), which fero deploy's platform also uses.

### 4.7 The wire

| Family | Verbs | Layer |
|---|---|---|
| link | `HELLO`, `DOOR`, `PING`, `DIAG` | L0 |
| raft | `VOTE`, `VOTED`, `APPEND`, `APPENDED`, `SNAPSHOT`, `TIMEOUT-NOW`, `QUIET` | L1 |
| ask | `ASK`, `ANSWER` | L2 to L4 |
| flow | `SUB`, `SNAP`, `DELTA`, `END`, `CREDIT` | L3 |

18 verbs in four families, each owned by one layer.
- **`ASK` and `ANSWER`** carry everything that asks a member to do something: a write, a method call, a planner hint, a define or an alter, a recover. The payload is the standard library's to read, and the answer comes after commit (4.3). An `ANSWER` is accepted only on the link its `ASK` went out on; any other is dropped, so a forged one cannot settle an attempt.
- **A follow set is a `SUB`,** and a slot move's copy is a `SUB` of that slot.
- PreVote is a `VOTE` with a flag. Every Raft verb carries its shard, and one frame carries many shards' messages.

## 5. How each pattern is built

### 5.1 The table

| Pattern | Built from | Layer |
|---|---|---|
| live shared state | a resource, `rows: true` | L4 |
| cache with expiry, session store | `rows: { ttl, max }`, `touch` | L2 |
| near cache, client data sync | `cache: { memory }`, follow sets | L3 |
| read-through cache | `load` | L4 |
| websocket fan-out by room | follow sets on relays; rooms as partitions | L3 |
| pub/sub | `history: 0, rows: false`; `durability: 'none'` from phase 5 | L2, L3 |
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
  - Protected writes carry `if: { fence: { lock, token } }`. Each shard keeps the highest token seen per lock, in its state, and a slot move carries it. A limit, said plainly: fence tables are per shard, so a stale holder writing to a shard that has never seen the lock is accepted there. So every shard's writer follows `#locks`, as writers already follow `#sessions` for presence, and refuses a fence token below the lock's current version that it has seen. That closes the gap to the follow lag, which the holder's lease margin (a round trip plus `skew.max`) covers. A condition on another shard's row is impossible (conditions are judged at one writer, 4.3), so that is how a saga's steps stay safe against a paused holder.
  - A lock records the positions its holder wrote at, so the next holder's reads can carry them as minimums.
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
| 8 | the store: forks, versions, proposals | **a fork is a new resource whose shards start from the parent's shards' snapshots**: segments and snapshots are immutable, so a fork costs one `#meta` record per shard. On a solo node, or a resource of one shard, the fork is one consistent cut; across shards it is consistent per slot, since shards' offsets are unrelated |
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

**Fixed slots (decisions 20d and 21a).**
- Two agents re-judged the 290 cases whose answers named splits, lineage, incarnations, offsets, ranks, merges, `none`, `sent` or the old wire verbs, against the draft with fixed slots folded in. The reviewer's slot edits (M1 to M3) landed while they worked, so some judged the text before them.

| Source | Re-judged | Gone | Same | n/a | Open | Better than before | Worse than before |
|---|---|---|---|---|---|---|---|
| DECISIONS, STATUS, LEAVE, DOOR | 140 | 43 | 88 | 1 | 8 | 4 | 5 |
| SCALE, M6, M7, CHECKPOINT, HISTORY, DIRECTORY, CONFIG, monitors | 150 | 45 | 93 | 2 | 10 | 13 | 9 |
| **Total** | **290** | **88** | **181** | **3** | **18** | **17** | **14** |

**The 18 open, and their answers.**

| Rows | The case | Answer (section) |
|---|---|---|
| D-010, D-344, S-109, C-210 | a new leader at the receiving shard could lose a moved slot's rows or outcomes | the receiving shard commits everything it copied to its own log before `open` (4.2) |
| D-260, S-161, H-062 | recovery could reuse numbers, reopen a moved slot, or drop a reader back an epoch | versions and tokens compare as (epoch, sequence); a recovered shard holds exactly the slots the table gives it; a newer cursor epoch gets `retry` (2, 4.2, 4.4) |
| D-251, C-077 | a moved slot's history had no home, and a shrink deleted it | `log` readers below the fence go to the old shard's segments, then the object store; a shard is deleted only once its history is safe (4.2) |
| C-010, H-074 | dedup answered with an offset that means nothing after a move | it answers with the position (slot, epoch, sequence) (4.3) |
| D-063 | a forged `ANSWER` on a client link | accepted only on the link its `ASK` went out on (4.7) |
| D-407 | a read reached a slot mid-move | readiness is per slot (4.4) |
| C-125 | a grow was hundreds of moves, each reading a whole snapshot | one move carries a set of slots; snapshot layers have a per-slot index (3.4, 4.2) |
| C-201 | a server holding both shards counted a slot twice or not at all | its views take each slot from exactly one shard (4.2) |
| C-214 | the shard rule could flap with load cycles | `shrink.after` (6 h), and a shrink that cannot set off a grow (4.2) |
| H-192 | a write under a removed field recreated it | refused `absent-path` (4.3) |
| H-210 | a re-run whose k-th write went to another slot was not caught | named as a limit; handlers must be deterministic given input and `ctx`, whose `now` and `id` the call claim fixes (4.5) |

**What got worse,** and stays so: a slot move copies data, where a split copied nothing; a grow can briefly make every whole-resource reader resubscribe once; divergent method re-runs are caught only per slot. **What got better:** no cursor lineage anywhere, per-resource `copies` kept, shrinking comes with growing, and the quiet-shard and leave rules now have answers in the text.

**This draft (Raft per shard).**
- The same four agents re-judged the same 876 cases against this draft, and compared each answer with the log-first one.
- The review's edits landed while they worked, so some judged the reviewed text. Every case they found open is answered below.

| Source | Re-judged | Gone | Same | n/a | Open | Better than log-first | Worse than log-first |
|---|---|---|---|---|---|---|---|
| DECISIONS | 269 | 121 | 139 | 1 | 8 | 5 | 6 |
| STATUS, LEAVE, DOOR | 208 | 90 | 110 | 0 | 8 | 8 | 12 |
| SCALE, M6, M7, CHECKPOINT | 182 | 82 | 84 | 12 | 4 | 10 | 10 |
| HISTORY, DIRECTORY, CONFIG, monitors | 217 | 62 | 145 | 0 | 10 | 12 | 4 |
| **Total** | **876** | **355** | **478** | **13** | **30** | **35** | **32** |

**What got better than log-first.**
- One protocol: there is no seal, recovery read or chain swap to get wrong.
- The cursor, snapshot-reload and `END` rules now hold in the draft's own text (C-015 to C-017, C-060, C-069, H-160).
- A damaged replica cannot vote, and there is no quorum knob to set below a majority (C-142, C-220).
- Example 01, the witness's failure domain and idle issuers are spelled out (D-075, D-195, D-036).

**What got worse than log-first:** the price of servers holding the copies again.
- Idle pings grow with member pairs: about 20,000 frames/s at n = 100, v4's level, against the log-first draft's 3,000 (section 8).
- A new replica copies its shard. A returning disk's copy is reused, but each placement change moves data (C-183, C-214).
- Two machines without a witness: a one-voter shard stops when its machine crashes, and an acknowledged write is on one disk until the learner has it (S-146, H-049). `copies: 2` and the witness are the stated alternatives.
- A witness now stores the log of every shard it votes in (S-185).
- Removal, catch-up and leave now rest on healing's rules, not on servers holding nothing durable (H-167, H-172, H-177, S-207). Each has its rule and its case.

**The 30 open, and this draft's answers.**

| Rows | The case | Answer (section) |
|---|---|---|
| D-050, H-057 | founders could each mint a cluster id, or disagree on `seeds` | the winner of `#meta`'s first election mints it; seeds compare list hashes; a `cluster-id` file wins (4.2) |
| D-081, D-085 | healing could add back a member that is leaving | a leave marks it `retiring` first (4.2) |
| D-084, C-033 | a quiet shard leaves a lagging follower stale | quiet only when every live voter has the commit offset; a returning link reports log ends (4.2) |
| D-119 | Raft verbs on a client link | member links only; plan verbs need the admin key (4.1) |
| D-303 | no caps on batches or bundled frames | 1 MB batches and frames, 4 MB catch-up appends (4.1) |
| D-343, H-110, H-128 | log dropped before its cover is fsynced | journal truncation, log drops and snapshot installs all wait for the fsync (4.1) |
| D-407 | a learner still loading serves reads | a replica serves only once ready (4.4) |
| S-037, S-196, S-201 | a learner promoted by an entry it has not received refuses its vote | learners answer vote requests by the log rule, as etcd's raft does (4.2) |
| S-207, S-208 | a leave right after a crash leaves the stayer read-only | a voter silent past `election.ms` that ignores probes for the rest of `leave.ms` is removed first (V4-60) (4.2) |
| S-049, S-222, S-183 | a recovered `#meta` and an old one share the cluster id | `#meta`'s incarnation rides HELLO, and the lower one stops and rejoins; `recover` refuses while a voter it would drop answers (4.2) |
| C-129 | idle traffic above the stated target | section 8 states about 20,000 frames/s at n = 100; phase 2 pins it (4.2, 8) |
| C-178 | a Raft log cut on disk | a cut record and a new segment, replayed at boot (4.1) |
| C-192 | a replica removed while it was down | it learns from the leader or `#meta`, stops, and deletes its copy (4.2) |
| H-052 | a stale `cluster-id` while a dir is still locked | a locked dir is not stale (4.2) |
| H-076 | resend storms at elections | jittered backoff, and a retry-after on `no-writer` and `moved` (4.3) |
| H-081 | `issuer.window` against a fixed floor | a cluster key, and the floor uses it (4.3) |
| H-112 | the lying-disk residual | named in 4.1 |
| H-116 | a process opens another project's dir | the boot record names cluster and project (4.1) |
| H-172 | a live voter removed before its replacement holds every commit | removal waits for the commit offset, exactly (4.2) |
| H-276 | cluster keys change unchecked | `fero.alter('#meta')`, with range and cross-key checks (4.5) |

Each answer is also a case in V5-BACKTEST part 2 (R-59 to R-79). The fixed-slots answers are R-83 to R-108.

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
- Failover went from about 0.6 s (draft 2) to 2.2 s, the GC-safe timeout, still half of v4's. This draft keeps 2.2 s (`election.ms`).
- The rest were its 23 open cases.

Its 23 open cases were answered in that draft (git history, commit 0ad07a8), and re-judged against this one above.

The per-case files in [v5-backtest/](v5-backtest) carry each case's latest verdict: the fixed-slots one for the 290 cases that touch slots, positions or moves, else the Raft-per-shard one for the cases that touch L0 or L1.

## 8. Performance, layer by layer

Each row is a target, how it is reached, and the bar to beat, measured with the competitor's own tool on the same box, under fero's never-widen rule. "TS" is the TypeScript kernel (phases 2 to 4); "native" is the Rust core (phase 5).

| Layer | Measure | Today (v4) | TS | Native | How | Bar |
|---|---|---|---|---|---|---|
| L0 | persisted appends per process | about 250/s | 50k/s | 500k/s | one journal for every shard, one fdatasync per ≤ 1 ms batch, `writev` | Kafka per broker, etcd |
| L1 | appends per shard leader | 14k/s through the api, 73k/s raw | 50k/s | 2M/s | pipelined, batched across shards per peer link | Redpanda (Raft per partition) |
| L1 | commit latency, p99, persisted | — | fsync p99 + 5 ms (GC and the group-commit window on two machines) | fsync p99 + 0.5 ms | send to every voter at once, commit at a majority; the leader's own fsync runs in parallel | Kafka acks=all, etcd |
| L1 | slot move | — | about 10 ms unwritable | about 4 ms | copy and commit the bulk first; then three commits: A's fence, the `#meta` row with B's delta, B's open | Redis Cluster's resharding |
| L1 | planned handover (a roll step) | — | 10 ms | 2 ms on NVMe; about 6 ms on a disk with 4 ms fsyncs | bring a warm voter to the log end, then TimeoutNow: one round trip and the new term's fsync | — |
| L1 | failover to writable | about 4 s | about 2.2 s on average, 2.5 s at worst | about 1.1 s, 1.25 s at worst | `election.ms`, then PreVote, the vote and the first own-term commit (a few ms) | KRaft (9 s default) |
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
   - L1 is Raft, as published, with the fixes practice added: one protocol, with a public TLA+ spec, run once per shard with the engineering CockroachDB and TiKV publish. Its core is ported from etcd's raft, not written afresh (decision 22).
   - Gone: lanes, stamps, digests, tombstones, compaction frontiers, orphans, sheds, latches, teachers, floors, FEED words, in-sync sets and eligible leaders; and the last draft's loglets, seals, chains, sessions and controller.
   - The new mechanisms are not only in L2 and L3 (the log-end overlay, budgeted dedup, per-row conflation, snapshot-replace, the read-your-writes wait, writer time and fences).
   - fero adds some to L0 and L1 too:
     - leadership handed back after `settle.ms`, as Kafka's preferred-leader rebalance does;
     - log replicas, which lead only to repair;
     - healing's one rule, and planner hints checked against the shard's config;
     - slot moves (fence, copy, open), with per-slot sequences so cursors need no lineage;
     - snapshot layers with removal markers, and their coupling to log retention.
   - Each is an ordinary Raft entry or a choice of who stands, so Raft's properties cover log consistency for them. They do not cover replica counts, durability or the uniqueness of answers, and the review found its critical bugs exactly there (section 13). So the safety core is simpler than the log-first draft's, and the policy layer is about as novel. All of it gets models (point 2). The kernel itself is five operations on a log, with L2 and L3 as a library over it (decision 21).
   - Plain Raft per shard is about 5 to 6k lines (V5-LOG-FIRST-REVIEW). Healing, slot moves, `#meta`, repair, leave and the planner add to that, so expect L1 near the log-first draft's size; porting etcd's raft (decision 22) shrinks the share that is fero's to get right.
   - Each layer's doc opens with its mechanism list. Adding one means naming what it replaces, or why it cannot be a library.
2. **Check every layer against a model before code.**
   - **L1 in TLA+, as one spec.**
     - Raft's published model, plus Ongaro's fix, is the base.
     - fero's additions are added to it: log replicas that lead only to repair, replicas that cannot vouch for their log, healing's steps, planner hints, and slot moves.
     - Properties beyond Raft's own:
       - no healing step reduces the number of answering, vouching voters that hold a committed entry, unless a replacement voter already holds it, except two voters stepping back to one; a leave may, only when no caught-up learner exists, when the learner it promoted fails before the leaver is removed, or by removing dead voters, and says so;
       - under-replication is always reported;
       - at most one shard has a slot open at any time, and a slot's sequence and epoch never go back;
       - the repair program of log replicas, including `#meta`, always reaches a full leader when a server is available;
       - a torn tail never makes a replica unable to vouch.
     - Checked exhaustively at small sizes: 3 to 4 members, 2 shards and a slot move with crashes on both sides, a log replica, crashes, partitions, restarts, power loss, a lying disk, a stale planner, snapshot layers against log deletion, and an object store that is slow or down.
   - **L3 in TLA+:** cursors as per-slot positions, across failovers and slot moves; snapshots that replace; credits; and, for phase 5, `confirm: 'sent'` across a failover.
   - **L2 against a reference model:** a 200-line sequential interpreter of records, conditions, ops and dedup, run against the code on random sequences, including a refusal followed by a stale copy on another link, and a slot move mid-retry. Raft's client sessions (Ongaro's thesis, chapter 6) are tried against the dedup floor here, in phase 1 (decision 21), and kept only if the model and the pins both say so.
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
| 1. Specify | the L1 TLA+ spec (Raft, plus fero's additions), the L3 spec, the L2 reference model with the client-session trial; the L0 to L4 interfaces, with the record header and cursors in the slot shape; every backtest case as a named test | the model checker is green; every case has a test name |
| 2. The log | **The simulator first:** v4's executive gains many shards per node, member roles, and an object store whose calls complete as sim events. Then L0 (the journal for every shard, segments, the object-store interface with its local-folder version) and L1 (Raft per shard, its core ported from etcd's raft, with its multi-Raft engineering, `#meta`, healing, handover; one shard per resource) in TypeScript, with v5 monitors and trace validation | 1,000-seed sweeps green with servers joining, leaving and crashing; kill -9 of everything, and a simulated power loss, lose no persisted write; 2,000 idle shards per process pinned; the L0 to L2 TS pins |
| 3. Surface | L2, L3 and L4 (v4's api ported: data binding, methods, door, config, rules, identity); the carried v4 bugs fixed; prototypes of the queue, groups and locks libraries | examples 01 to 44 pass; every backtest case passes or is marked not applicable with its reason |
| 4. Platform | the S3 object store; **log replicas, the witness and the hosted log tier; slot moves and the shard rule; the planner and its hints; load-aware placement**; sleep and wake; worlds, call keys, tapes, forks, caught-up, rolls; TLS and the CA; `fero migrate`; the npm build | the café from "fero test" runs on v5; fero deploy milestones 1 and 2 run against a local log tier with an S3-compatible store |
| 5. Native and reach | the Rust L0 to L3 (and a native log member) behind the same interface; `durability: 'none'` and `confirm: 'sent'`; relays; `rules.read`; mergeable views across shards; the finished libraries; the RESP, Kafka and WebSocket gateways | every row of section 8 is a green pin in the native column, on the pinned runner |

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
   - a) `persisted` (a majority of voters on disk) and `none` per resource, plus `confirm: 'sent'` for a plain write that need not wait for its commit (my pick). `none` and `sent` land in phase 5 (decision 21).
   - b) Also `memory` per resource: a majority holds it, and disks are written within a second, as Kafka's default. The price: a replica that stops uncleanly comes back as a new one (4.1), so an unclean stop of a majority at once needs `fero recover`.
   - c) `persisted` and `none` only.
5. **One cluster per project.** a) Resources are catalog entries (my pick). b) One cluster per resource, as v4.
6. **What Ctrl-C, SIGTERM and `destroy()` do.** a) `leave`, and `restart` under `FERO_SUPERVISED` (my pick). b) Always `restart`.
7. **Defaults.**
   - a) My pick:
     - 1,024 slots per resource, one starting shard, then the shard rule (`shard.bytes` 4 GB, `shard.rate` half the leader's measured capacity);
     - `copies` 3 voters (1 for a shard created below three candidates, never lowered by healing); `standbys`: every server, up to 5;
     - `#meta`: 1 voter, then 3 from three members;
     - a 100 ms tick, `ping.ms` 500 ms, `election.ms` 2 s (1 s native), `election.jitter` 500 ms (250 ms native), `evict.after` 10 min, `settle.ms` 30 s, `catchup.max` 10 min;
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
20. **The unit of replication.** **Chosen: d,** folded into this draft. Both second opinions keep one ordered log, one writer and Raft as the right unit, and both would delete splits, where most of the policy layer's bugs were found.
    - a) **Shards per resource that split** by size and load (this draft). Per-resource `copies`, and no fixed limit; but the most policy: splits, child groups, and up to 10,000 groups per process.
    - b) **Project-wide lanes** (the reviewer). A project has a fixed number of Raft groups (64 by default), and every resource's partitions hash into them, so groups scale with members, not data. `#meta` is lane 0, with no user code. Deletes splits, child groups, per-resource shard records and the 10,000-group pin. Costs: `copies` becomes a project key; resources share a lane's leader and commit batch; scale-out moves whole lanes, and going past the lane count means moving key ranges between lanes (Vitess's cut-over), in phase 5. Precedents: MongoDB's replica sets, Vitess, Pulsar's bundles.
    - c) **A fixed shard count per resource** (16), re-keyed by a library into a new generation when outgrown ([V5-PRIMITIVE.md](V5-PRIMITIVE.md)).
    - d) **Fixed slots, free groups** (an independent judge of a to c; my pick; [V5-UNITS.md](V5-UNITS.md)). Each resource has 1,024 slots that never change, and a partition hashes to one slot forever. A resource starts as one Raft group holding every slot, and groups are added and removed as load needs. Each record carries its slot's own sequence number, so versions, cursors and fence tokens are (slot, seq) and never depend on which group holds a slot. One mechanism, moving a slot (fence it, copy it, open it, as Redis Cluster and Couchbase do), does scale-up, scale-down, rebalancing and hot slots. Deletes splits, merges and cursor lineage, and keeps per-resource `copies`. Costs: one varint per record, cursors over a whole resource up to about 8 KB, and data copied once per move.
21. **The other proposed cuts.** **Chosen: a,** folded into this draft. a) Take all four (my pick): the kernel becomes five operations on a log (append, read, snapshot, change members, hand over), with L2 and L3 as fero's standard library over it; drop ranked candidacy, keeping Raft's random timers and the `settle.ms` hand-back, as Kafka's preferred-leader rebalance does; defer `durability: 'none'` and `confirm: 'sent'` to phase 5, so pub/sub is `history: 0, rows: false` on the persisted log until then; try Raft's client sessions (Ongaro's thesis, chapter 6) against the dedup floor in phase 1. b) Name the ones to keep or drop.
22. **Where the Raft core comes from.**
    - a) **Port etcd's raft to TypeScript** (my pick). It is already a pure state machine: messages and ticks in, a "ready" batch of entries to save, messages to send and entries to apply out. That is the shape of fero's deterministic kernel, and it carries years of production fixes (PreVote, CheckQuorum, learners, leadership transfer, read index). The Rust phase uses raft-rs, TiKV's port of the same code, so both kernels share one design. Both are Apache 2.0: the ported files keep that licence and a NOTICE inside fero's MIT repository.
    - b) Write Raft from the paper and its TLA+ spec. No outside code, but every subtle bug etcd already fixed is fero's to find again.
23. **Cuts a fresh reviewer proposes.** a) Take them (my pick):
    - require an object store across boxes (decision 9b): it deletes five branches (log-replica repair without one, history after a shard is deleted, a shrink blocked on history, snapshots streamed from a busy leader, and waiting for a full voter to return). One box keeps the local folder; self-hosters can run MinIO;
    - cut `copies: 2`: two voters cannot survive a crash, so it is a mode with a liveness cliff and no gain over one voter and a learner;
    - cut `evict: 'lru'`: sampled touches are write traffic for what `cache: { memory }` already gives per process;
    - cut the `vm` time budget for rules, and keep the watchdog quarantine;
    - cut `confirm: 'sent'` outright, rather than defer it;
    - grow by `shard.rate` only when some server does not yet lead a shard of the resource, since below `standbys` servers every server folds every write anyway.
    b) Name the ones to keep. A seventh, collapsing the leave rules into `gone` from `#meta`'s leader, waits for the healing spike.

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

**The backtest re-check of this draft** found 30 more cases open, all answered (section 7, cases R-59 to R-79).

**The sign-off re-read.** The same reviewer re-read the draft after both rounds.
- **Its verdict:** "Yes: I would sign off on phase 1 from this document, on two one-sentence edits (F1, F2 below). Without them, no." Both are made.
- **F1:** the E3 shortcut did not hold. A timeout resends while the first copy is still in flight, so a first send's unappended refusal could reach the issuer before its resent copy committed. Now an issuer that has resent accepts only an answer to its latest copy (4.3).
- **F2:** a leave during a roll could leave a shard that healing then raised to two voters. Healing now raises a voter count only to an odd number (4.2).
- **Also made:** `issuer.window` may only be raised online; a `#meta` rebuilt by `recover` is refilled by every leader and server; and three minor items.
- **Confirmed safe:** the learner-vote rule ("neither depends on the voter knowing its own role"), and the leave probe rule, as V4-60's choice of availability over copies.
- **On a simpler primitive,** it proposed project-wide lanes in place of shards that split; see [V5-PRIMITIVE.md](V5-PRIMITIVE.md) for a second view, and decision 20.

**Fixed slots, free shards.** An independent judge weighed shards that split, project lanes, fixed shards per resource, and fixed slots with free shards ([V5-UNITS.md](V5-UNITS.md)): "fix the names, free the groups." The user chose that (20d) and the smaller cuts (21a), and this draft folds both in. Positions are a partition and its slot's own number, not a counter per partition, so state stays bounded and whole-resource readers stay small (2).

**The review of fixed slots.** The same reviewer: "Yes, on three edits to 'Moving a slot' and recovery (M1–M3)." All three are made.
- **M1:** every move step acts only on committed entries, and A fences only after B's `importing` commits. Before, a leader deposed after appending `fenced` could leave two shards writing one slot.
- **M2:** `log` readers below a move's fence are sent back to the old shard's segments, and a shard is deleted only once its history is safe and no route points at it.
- **M3:** a recovered shard re-fences every slot the table places elsewhere, and versions and fence tokens compare as (epoch, sequence).
- **Also made:** fence tables carried whole and merged by `max`; why the `max` merge of call ids is safe, with the window stated as a span of ids; `shrink.after` (6 h) and a shrink that cannot set off a grow; the admin key checked at the door for `ASK`s; positions, not offsets, in dedup answers; and the stale rows.
- **Its view of the shape:** "Fixed names, per-slot counters, groups free to move, no lineage. With M1–M3 and the stale rows fixed, this is the document I would start phase 1 from." 

**The fresh review.** A reviewer who had seen none of the earlier rounds read the whole draft. Its verdict: "No, not from this text as it stands. Yes after five short edits (C1, C2, S1, S2, S3)." All its findings are made, and decision 23 holds its proposed cuts.
- **C1, critical:** recovery could reopen a moved slot when the slot table lagged B's `open`. Now B writes the table before it opens, and recovery writes it at the slot's new epoch before it reopens.
- **C2, critical:** a move had no record at A until the fence, so A's next leader knew nothing of it. Now A commits `exporting` first and owns the move.
- **S1:** the bulk copy is committed at B before the fence, so the slot is unwritable for a few commits, not minutes.
- **S2:** `drain` is leadership only, for rolls; `retire` moves replicas, for leaves and scale-in.
- **S3:** with no planner, `#meta`'s leader writes `gone`, and each leader trusts its own link.
- **S4 to S9:** writers follow `#locks`, so a saga's fences hold across shards; writer time is clamped on both sides; call-key ids are (call key, k) with the content hash in the record; a replica of A alone switches a slot off at the fence; swaps promote first; the TypeScript targets are 50k/s and fsync + 5 ms.
- **On the earlier rounds:** "Two of my findings are their own edits taken one step short."

**The spikes.** The fresh review showed that reading alone keeps finding bugs in the policy layer. So two small model checkers, plain Python with no outside tools, searched every reachable state of the two newest protocols on small bounds. Each ran twice: once on the text, and again after the fixes. Both are in [v5-spec/](v5-spec).
- **[The slot move](v5-spec/slot_move.md),** up to 8.2 million states a run.
  - Round 1 found the design sound, and three sentences wrong as written: guards that forbid a step must count the whole log, a new leader stamps from its log end, and `stale-attempt` is never appended.
  - Round 2 added an unclean recovery and found five more: a recovered shard ends its moves, table rows are versioned, recovery writes the table at the new epoch, a fence names B's incarnation, and `unfenced` reopens in a new epoch.
  - With all of them, every property holds, and 16 of 18 one-rule mutants are caught.
- **[Healing and leave](v5-spec/healing.md),** up to 6.1 million states a run, two to four members.
  - Raft's own safety held throughout.
  - Round 1 found three gaps (a leave removing the leaver too early, a shard settling at four voters, and under-replication left unreported) and that a shard could sit at two voters.
  - Round 2, on the revised text, found a live majority stuck waiting for a cut-off leader, unless a change takes effect only when it commits, and a swap removing the old voter before the new one holds its own promotion.
  - With all fixes, no state with a live majority is stuck, nothing settles at two or four voters or flaps, and 19 of 22 mutants are caught.
- **What they leave out:** Raft's insides in the move model; `#meta`, log replicas and snapshots in the healing model; two recoveries in one run; real time. TLA+ in phase 1 (10.2) is still the full check.

