# fero v5: one log, three retentions, six layers

A design, a plan and a backtest for the next fero kernel, against `main` at d7c9efe (v4, 1,216 tests) and data at 63fea66. Nothing here is built.

**How it was checked.** v4's DECISIONS, STATUS, design records and HISTORY were catalogued into 1,313 hard cases, plus 102 invariants, 36 monitors and 20 SCHEDULE clauses. Each case was judged against the first draft by the agent that catalogued it; the second draft (this one) answers what they found open or wrong. The mapping is in [V5-BACKTEST.md](V5-BACKTEST.md). An independent review is in section 13.

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
13. The review

## 1. The answers

- **Retention applies to two things, and they are separate knobs.**
  - `history` is how much of the log of deltas a resource keeps.
  - `rows` is which rows its state keeps.
  - A stream keeps history and no rows; a map keeps rows and no history; a tape keeps both.
  - A row removed by a `rows` rule is a change like any other, so it is appended to the log as a remove.
  - A third knob, `cache`, is per process and is never written anywhere: it is which rows this process keeps in memory.
  - Section 3.
- **Caches are the same mechanism.**
  - A Redis-style cache is a resource with `rows: { ttl, max }`.
  - A near cache on a webserver is a `cache` limit on a client.
  - A read-through cache over a database is a resource with a `load` function.
  - Section 3.3.
- **The layers.** L0 io, L1 replication, L2 fold and ops, L3 flow, L4 surface, L5 libraries.
  - L1 is two published algorithms: Raft for one metadata log, Kafka's replication for shard logs.
  - The wire is about twenty verbs in seven families, each owned by one layer.
  - Everything a pattern needs above L2 is a library.
  - Section 4.
- **The backtest.**
  - Across the 1,313 cases, the first draft answered 1,064 and missed or got wrong 191.
  - This draft answers all but the items listed in section 7.
  - Those are open decisions or phase-5 designs, each named.
- **Performance.** Every layer has a target, a technique and a competitor bar, with one number for the TypeScript kernel and one for the native core. Section 8.
- **Development speed.** v4's October:
  - About 700 commits.
  - Open bugs went 15, then 40, then 34.
  - DECISIONS doubled.
  - Up to eight review rounds per lane.

  The cause is how many mechanisms interact. The cure is fewer, published mechanisms, a model checker before code, and rules that bound a lane. Section 10.
- **fero test and fero deploy.** All 14 kernel needs from "fero deploy: the journey" and all 11 pieces from "fero test" have a home. Several become nearly free: tapes are logs, forks are copy-on-write snapshots, and caught-up is an offset. Section 6.

## 2. The model

| Word | What it is | Example |
|---|---|---|
| **project** | The resources one program serves; one cluster | `shop` |
| **resource** | One `fero(name)`: a map of rows, its methods, its rules | `fero('bookings')` |
| **row** | The value under one top-level key | `bookings.data.b42` |
| **cell** | A path inside a row; the unit of a write | `b42.status` |
| **record** | One change to one cell or row (data's delta: set, remove, insert) plus the header of section 4.3 | `{ set, ['b42','status'], 'booked' }` |
| **partition** | The unit of order, atomicity and following. By default one row; a `partition` function can group rows | `partition: (k) => k.split('/')[0]` puts `room42/m1` and `room42/m2` in `room42` |
| **shard** | A hash bucket of partitions with one log, one leader and R replicas. Invisible to users | `hash('room42') & 15` is shard 7 of 16 |
| **offset** | A record's position in its shard's log, never reused | shard 7, offset 902 |
| **version** | The offset of a row's last write; never reused, so a recreated row never repeats an old version | `b42` at version (7, 902) |
| **log** | One shard's records in order | |
| **state** | The rows: the fold of the log | what `f.data` shows |
| **member** | A process that holds shard replicas | a copy in fero deploy |
| **voter** | A member (or a witness) that votes in the metadata log: three or five per cluster | |
| **client** | A process that follows some partitions and writes through a member | a webserver |
| **relay** | A client that also serves other clients | an edge tier |

**Keys, partitions and shards.**
- **A key** is a top-level key of the resource's object, as today.
- **A partition** is one or more keys that must stay ordered and atomic together. By default it is exactly one key, so existing code means what it meant.
- **A shard** is many partitions sharing one log, so that a commit, an fsync, a replication frame, a leader election and a catch-up are paid per shard, not per partition.
- **A shard never splits a partition.** A single hot partition is bounded by one leader's core, like a Redis key or a Kafka partition, and the app splits it (`room42-0` … `room42-3`) if it must.

**Shard count.**
- A power of two per resource, 16 by default, set when the resource is created.
- Until splits ship (phase 5), a resource's leaders are capped at its shard count. With R = 3, 16 shards spread over at most 48 members.
- A resource meant for a large cluster sets `shards` higher. After phase 5, a shard that grows past a size or load bound splits by taking one more hash bit (shard 7 of 16 becomes 7 and 23 of 32).

**Order.**
- One partition is totally ordered, whoever writes to it. Partitions are not ordered against each other, as today.
- A cell keeps the value of its last record in log order. There are no stamps and no elections.
- v4's overlapping-cells rule (V4-18) is simply log order: a whole-row write hides the older field writes, and a newer field write shows on top.

## 3. Retention: history, rows, caches

### 3.1 Three knobs

| Knob | Applies to | Decided by | Written to the log? | Values |
|---|---|---|---|---|
| `history` | the log of deltas, after commit | the resource's config | no: dropping history changes nothing anyone sees | `0` (default: keep only what replication and the latest snapshot need), `'7d'`, `'10GB'`, `1e6` records, `'all'` |
| `rows` | the state: which rows exist | the shard leader, using leader time | **yes**: a row it removes is a `remove` record with a reason (`ttl`, `max`, `where`) | `true` (default), `false` (no state: a stream), `{ ttl, max, evict, where }` |
| `cache` | one process's memory | that process | never | `{ memory: '200MB' }` on a client or relay; members keep their replicas whole |

**Why history and rows are separate.**
- History answers "what happened"; rows answer "what is".
- Dropping history never changes a row. Removing a row never drops history: the remove itself is appended.
- In an append-only resource (every write a new row) the two hold the same items, but different rules keep them: history by age or size in log order, rows by key with a TTL or a count.

**Why `rows` removals are records.**
- Replicas, subscribers and replays must agree on which rows exist.
- If each replica expired rows on its own clock, they would disagree for a moment, and a replay would disagree forever.
- So the leader decides, by its clock (section 4.3), and appends the remove.

**What `rows` can evict by.**
- It can evict by write time (`ttl` since the last write or `touch`; `evict: 'oldest'`), by count (`max`) and by content (`where`).
- It cannot evict by read recency. Reads happen on every replica and never reach the leader, so the leader cannot know which rows are idle. Read recency is what `cache` is for.

### 3.2 What each combination is

| Pattern | `history` | `rows` | Other | Like |
|---|---|---|---|---|
| live map (today's fero) | `0` | `true` | | Redis hash, KTable |
| cache with expiry | `0` | `{ ttl: '10m', max: 1e6 }` | | Redis with `maxmemory` |
| session store | `0` | `{ ttl: '30m' }` | `touch` resets the ttl | Redis sessions |
| stream | `'7d'` | `false` | | Kafka topic |
| compacted stream | `'all'` | `true` | readers may start at a snapshot | Kafka compacted topic |
| event store | `'all'` | as needed | | EventStoreDB |
| pub/sub | `0` | `false` | `durability: 'none'` | NATS core, Redis pub/sub |
| queue | `0`, or `'7d'` for audit | messages are rows; an ack removes one | the queue library (5.3) | SQS, JetStream work queue |
| tape (fero test) | `'14d'` | `false` | | a recording |
| presence | `0` | `{ while: 'session' }` | | ZooKeeper ephemeral node |

**`durability`** is the default rung for a resource's writes. A write can ask for more than the default, never less.

| Rung | A write is confirmed when | It survives | Default for |
|---|---|---|---|
| `'none'` | the leader appended it; no fsync, no replication | nothing: transient pub/sub only | — |
| `'committed'` | every in-sync replica has appended it | any crash that leaves one in-sync replica running; **not** a power loss that takes the whole in-sync set at once | resources that ask for it |
| `'persisted'` | every in-sync replica has fsynced it | any crash, including a power loss of every replica | every resource (decision 4) |

Group commit (4.1) makes `persisted` cost about a millisecond, so it is the default. The high-water mark that readers see follows the resource's rung:
- **`persisted`:** nothing a reader saw is ever undone.
- **`committed`:** a power loss of the whole in-sync set can undo records readers saw. That is the explicit price of the faster rung.
- **`none`:** records are delivered at the leader's append, may be lost, and are never part of anyone's state. That is what transient pub/sub means.

### 3.3 Caches, all from the same parts

- **A replicated cache** is a resource with `rows: { ttl, max }`. Every replica holds the same rows, the leader expires them, and subscribers see the removes.
- **A near cache** is a client with `cache: { memory }`.
  - It follows the partitions it reads and keeps them fresh by subscription while it holds them.
  - When it runs out of room it drops the least recently read: an unfollow.
  - A miss is one hop to a member.
  - This is how a webserver or a browser holds a slice of a resource too big for it.
- **A read-through cache over another system** is a resource with a `load` function.
  - A read of a missing row asks the partition's leader, which runs `load(key)` once however many readers miss at once, writes the row, and answers.
  - With `rows: { ttl }` it is a Redis-style cache in front of Postgres, and every reader stays live.

## 4. The layers and their primitives

```
L5  libraries, adapters      queue · consumer groups · locks · presence · rate limits · loaders · RESP / Kafka / WebSocket gateways · fero CLI
L4  surface                  fero(name) · data views · methods · rules · identity · config · worlds (fero test)
L3  flow                     subscriptions: selector + mode + cursor · credits · conflation · relays · near caches
L2  fold and ops             records → rows · conditions · leader ops · leader time · dedup · row retention
L1  replication              metadata log (the controller) · shard logs · epochs · in-sync sets · catch-up · sessions
L0  io                       journal · segments · snapshots · group commit · transports (TCP, TLS, WebSocket, in-process)
```

- **Layer boundaries.** A layer talks only to the one below it, through an interface with its own test suite.
- **L0 to L2 are deterministic.** They take events (frames, ticks, disk completions) and return effects, as v4's kernel does (V3-1). The simulator runs them unchanged, and a native implementation can replace them behind the same interface (8.4).

### 4.1 L0: io

- **One journal per member, segments per shard.**
  - Every append on a member, to any shard and to the metadata log, goes into one journal file. **One `fdatasync` covers a batch**: at most every millisecond, or every megabyte.
  - Each shard's records are then written to that shard's segment files in the background and fsynced there.
  - The journal is truncated once every shard's segments cover it.
  - This is how one fsync serves thousands of shards, and still lets each shard keep and drop its own segments.
- **What `persisted` waits for.** The journal fsync that covers the record. A vote, a term and a metadata entry are never answered before theirs.
- **Snapshots.**
  - Each shard's state is snapshotted at an offset, every N records or M seconds, from a copy-on-write state, so a snapshot is the state at exactly one offset (N-10).
  - A snapshot is written to a temporary file, fsynced, renamed, and the directory fsynced. Only then may anything it replaces be deleted.
  - Boot is the latest snapshot plus the log after it.
- **When a segment is deleted.** All four must hold:
  - A fsynced snapshot at or below the high-water mark covers it.
  - The resource's `history` allows it.
  - Every in-sync replica's fetch position is past it.
  - No snapshot install in progress still needs it.

  A replica outside the in-sync set never holds a segment back: it installs a snapshot instead.
- **Boot checks.**
  - Every record carries a crc32c and its predecessor's offset and epoch (v4's chain, V3-8).
  - A member truncates its log at the first record that fails either check, and fetches the rest from the leader.
  - A member that shut down uncleanly, or found a hole, is out of every in-sync set until it has re-fetched to the high-water mark (4.2).
- **Directory fsyncs.** Creating or renaming a segment, a snapshot or the boot record fsyncs the directory too. One failed fsync condemns the store (v4's fsyncgate latch, N-20).
- **One process per dir.** v4's lock file and its lease thread stay (V4-59). The journal writer checks the lease before each batch. A process that was frozen past its lease, and finds the lock taken, stops before writing.
- **State larger than memory** (phase 5, opt-in per resource): rows live in an on-disk keyed store, with the hot set in memory. Views and first pictures read through it.
- **Transports.**
  - TCP, TLS, WebSocket (browsers, with no bridge) and in-process (worlds and the simulator).
  - Frames are v4's: encoded once, with a crc32c, and the same bytes are the journal row and the wire (V3-8).
  - A frame is sent at the end of the event-loop turn that made it (v4's V4-63 behaviour; decision 9).

### 4.2 L1: replication

Two logs, one protocol family, both published algorithms.

**Clusters, genesis and discovery.**
- **One cluster per project.**
  - A cluster is the set of member processes of one project, one run in the naming plan of 22 October. Its resources are entries in its catalog, not clusters of their own.
  - A process that opens resources of two projects is a member of two clusters.
  - This replaces v4's one cluster per resource, each with its own port, membership and heartbeats.
- **A cluster id**, minted at genesis, rides every HELLO. Members with different ids never link, and both say so, so a split at birth is loud, never two silent halves (v4's genesis split, H-054).
- **Exactly one genesis.**
  - Across boxes, the first voters start with the same `voters` list, and Raft elects within it.
  - On one box, the box directory grants the founder role for a project and run atomically.
  - Everyone else joins as a learner.
  - With no directory and no hosts, a process is a cluster of one.
- **Finding a resource.** A name resolves to its project's cluster through the directory or `hosts`, as today. Remote names carry the project: `shop/stock`.

**The metadata log** is one Raft group over three or five voters, which may include a witness that stores only this log. Every other member follows it as a learner. Its leader is the **controller**. It holds:

| Record | Holds |
|---|---|
| member | id, life (a random number per process start), disk incarnation, addresses (listen and advertised, apart), role (voter, witness, learner), state (up, restarting, leaving), code hashes it can run, kernel version |
| resource | name, config (4.5), allowed code hashes, seed applied, write gate (open, or read-only with a reason) |
| shard | resource, number, replicas, leader, leader epoch, in-sync set and its epoch, eligible replicas, split lineage |
| cluster | id, cluster version (the newest protocol every member speaks), current and next door secret |

Raft as published, plus the fixes later practice added:
- **Durability.** Term, vote and entries are fsynced before any reply.
- **Configuration changes** add or remove one voter at a time. A new leader first commits an entry of its own term (Ongaro's 2015 fix for single-server changes).
- **PreVote and CheckQuorum.**
  - A voter rejoining with a higher term cannot unseat a working leader.
  - A leader that cannot reach a majority for an election timeout steps down.
- **Voter identity is the member id plus its disk incarnation.** A member back without its disk cannot vote as its old self. It joins as a learner, and the controller replaces the old incarnation with two single-voter changes.
- **Voters are three or five.**
  - The controller keeps the voter count by promoting learners, one change at a time, when a voter leaves or is evicted.
  - With one or two members there is one voter, or two plus a witness.

**Sessions and failure detection.** Every member keeps a session with the controller: a heartbeat each tick (100 ms by default), sent from the same event loop that does the work.

| Event | Detected after (default) | What the controller does |
|---|---|---|
| a member's session lapses (it crashed, or hangs with its sockets open) | 5 ticks: 500 ms | moves its leaderships to in-sync followers; removes it from every in-sync set |
| a follower gets no data from a live leader | `lag.ms`: 1 s | at the follower's report, moves the leadership |
| a member comes back with a new life | at its first heartbeat | removes it from every in-sync set before it can acknowledge anything (KIP-903) |
| a member stays down past `evict.after` (10 min) | that long | re-creates its replicas elsewhere; if it was a voter, replaces it by single-voter changes |

These give failover in about 600 ms at the default tick. The failover pin uses 100 ms ticks; slower ticks scale it.

**Links.** Members link to the controller, and to the members they share shards with. There is no full mesh.
- One connection per member pair carries every shard fetch between them in one fetch session (Kafka's incremental fetch).
- An idle pair exchanges two frames a second.
- At n = 100 and R = 3, a member keeps a handful of links, not 99. v4 measured its n = 100 mesh at 9,900 PINGs per tick.

**Two ways to stop.**

| Stop | Used by | What happens | Survivors |
|---|---|---|---|
| `leave` | an interactive Ctrl-C, scale-in, `destroy()` | Hands its leaderships to in-sync followers, re-replicates anything only it holds, then removes itself by a configuration change. Bounded by `leave.ms`; `destroy()` says whether it was clean (v4's graceful leave, V4-6) | carry on: three members after two leaves is one writable member |
| `restart` | a supervisor (`fero run`, a roll, restart-all; Ctrl-C under `FERO_SUPERVISED`) | Hands its leaderships over within `leave.ms`, stays a voter and a replica, comes back and catches up | carry on while a majority of voters is up and every shard has an eligible replica |

- **A crash** is a restart that skipped the handover.
- **When the controller is unreachable,** a stop of either kind goes like a crash and says so: in the journal, and `destroy()` resolves `false`.
- **A witness** lets two members survive one crash or restart. Without one, a two-member cluster can lose one member only by `leave`.
- **Leaving below R.** When members fall below a resource's `replicas`, its shards keep min(R, members) replicas, and they grow back as members join.

**The shard logs** use Kafka's replication under the controller (the KRaft design):

- **Appending and fetching.** The leader appends writes in order. Followers `FETCH` from it, and each fetch reports what the follower has appended and what it has fsynced.
- **Every fetch checks divergence.** It carries the epoch and offset the follower last appended. The leader answers with the point where their logs diverge, if they do, and the follower truncates there before appending (KIP-101, KIP-279, KIP-320).
- **The high-water mark** is the lowest appended offset (or, for a `persisted` resource, the lowest fsynced offset) across the in-sync set.
  - While a change to the set is pending, the leader uses the larger of the committed and the proposed sets (Kafka's maximal set). So a member being removed still counts until its removal commits, and a member being added counts as soon as it is proposed.
  - It advances only while the set has at least `minInSync` members.
  - It rides on every fetch answer.
  - Readers and subscribers only ever see records below it.
- **The in-sync set changes only through the controller.**
  - The leader proposes a change carrying its leader epoch and the set's epoch. A stale proposal is refused (Kafka's AlterPartition).
  - A follower lagging more than `lag.ms` is removed.
  - A follower joins when it has appended (or, for `persisted`, fsynced) up to the high-water mark.
- **Eligible leaders** (KIP-966).
  - While the in-sync set is below `minInSync`, no write commits.
  - A replica removed from the set in that state still holds every committed record, so it stays eligible to lead.
  - A shard comes back in any order of restarts, as long as one eligible replica's disk survives.
  - With `minInSync: 1`, commits continue on one replica. If that replica's disk is lost, the commits made since the others left are lost, and only it can bring the shard back without loss. That is the explicit price of two copies.
- **Leader change.**
  - The controller picks the new leader from the eligible replicas, among members that hold the resource's code hashes, and bumps the shard's leader epoch.
  - Every record carries the epoch it was written in.
  - The new leader's whole log, including any uncommitted tail it inherited, is its log from then on.
- **Truncation.** A record that never committed may be dropped by the divergence check, never merged. Its writer was never told it committed.
- **Fencing.** Every write and fetch carries the leader epoch it expects. An older epoch is refused `stale-epoch`.
- **Routing.**
  - The partition-to-shard function is part of the protocol: a 64-bit hash of the partition key with a full avalanche finaliser, so its low bits are as good as its high ones (v4's ring already finalises with fmix32, V4-14). It is versioned with the frame format.
  - A leader refuses a record whose partition is not in its shard (`wrong-shard`).
- **Moving a replica** (scale-out, scale-in, rebalance):
  1. Add a follower.
  2. Let it catch up from a snapshot plus the log.
  3. Let it join the in-sync set (fsynced, for `persisted`).
  4. Remove the old replica.

  There is no orphan, shed, latch or teacher.
  - A follower that cannot catch up stays out of the set, and the controller reports the move as stalled.
  - The old replica stays until the new one has joined.
- **Two members.**
  - With a witness voting in the metadata log, a member's crash heals when both were in sync at the moment of the crash: the controller shrinks the set to the survivor, and `minInSync: 1` keeps it writable.
  - If the survivor had already fallen out of sync, it waits for the crashed member, as N-02 says.

**Mixed versions during a roll.**
- Frames carry the protocol version. A member speaks every version from the cluster version up.
- The controller raises the cluster version only after every member reports the new kernel.
- A feature that needs the new version is off until then, as Kafka's `metadata.version` works.

**Operator recovery.** For losses no protocol survives:
- `fero recover --new-cluster` on a surviving voter, when the metadata quorum is permanently lost. It rewrites the configuration to itself from its own log (etcd's force-new-cluster), and the others rejoin as learners.
- `fero recover --unclean <shard>`, when every eligible replica of a shard is lost. It elects the most complete remaining replica and reports the offsets that may be lost.

Both refuse while a quorum or an eligible replica is up. Both are journalled and recorded in the metadata log.

**Splits** (phase 5).
- A split is a metadata record naming the parent shard, the offset and the two children.
- The children continue the parent's offsets, so a version or a cursor never moves backwards.
- Each child inherits the parent's dedup window, the highest fence token seen per partition (5.3), and its snapshot at the split.

### 4.3 L2: fold and ops

**The record.**
- A batch has one header: the leader epoch, the base offset and the leader time `t`.
- Each record inside it has its own offset (base plus index), its own attempt id, and data's delta.

| Field | Why |
|---|---|
| leader epoch | fencing, divergence (4.2) |
| offset | replication, fsync, retention, versions, cursors |
| leader time `t` | TTLs, leases, `ctx.now()` on the leader. Per shard it is `max(previous t, clock)`, carried across leader changes |
| attempt id (issuer, call id) | dedup of retried writes. The issuer is the client or member id plus its life, so a restarted process never repeats an id |

**At the leader, in this order:**
1. **Dedup.**
   - **What it checks.** If the attempt id is in the leader's log, committed or in the uncommitted tail, the leader answers with the original offset, and nothing else runs.
   - **What the leader keeps.** Per issuer, the highest call id it has committed and the outcomes of the issuer's last 1,024 attempts (v4's `dedupKeep`). An issuer is forgotten only after it has been silent for the retry horizon (5 min). So memory is bounded by active issuers, not by records.
   - **Stale attempts.** An attempt at or below the issuer's highest committed call id that is not among those outcomes is refused `stale-attempt`, never committed.
   - **No late arrivals.** Every hop (client, relay, forwarding member) holds an attempt for at most half the horizon, then answers `unknown`. An issuer stops retrying an attempt after half the horizon. So no attempt can arrive after its issuer has been forgotten.
   - **After the horizon.** `cluster.writes.lookup(id)` still finds an attempt's offset while history keeps it, and says `unknown` otherwise.
2. **Shape checks that need the current row.** Array holes (v4's `sparse-hole`, V4-28/33), and an insert under an existing row.
3. **`rules.write`** (4.5), with the current row.
4. **Conditions**, against the leader's state at this point in its log.
5. **Ops**, which compute the value to append.

A refusal is not appended. A retried refused write is judged afresh, since the refusal had no effect (N-07).

| Kind | Forms | Refusal |
|---|---|---|
| conditions | `if: { absent }`, `{ present }`, `{ version: v }`, `{ equals: x }`, `{ fence: token }`, `{ expired: 'lease' }` | `conflict`, with the current version |
| ops | `incr(n, { min, max })`, `push(x)`, `merge(obj)`, `max(x)`, `min(x)`, `touch` | `conflict` when a bound fails |
| batch | many records to one partition: all or none | the first refusal |

**Appending results.**
- The leader appends only results. Followers, subscribers and replays apply plain values and never re-run a condition, an op or a rule.
- So user code at the leader (`rules.write`, `where`, a `partition` function) may be non-deterministic without forking replicas.
- It must be synchronous. A throw refuses the write `rule-threw`, and the line is printed once per bug (v4's V4-47).
- `load` is asynchronous and runs off the append path: its result arrives later, as an ordinary write.
- Every value a leader computes is checked for encodability and size before it is appended (`unencodable`, `too-large`), as client values are today (V4-48, V4-51).

**Two states per replica.**
- The *committed state* is the fold up to the high-water mark. Readers and subscribers see it.
- The *log-end state* is the committed state plus an overlay of the uncommitted tail. A leader judges dedup, rules and conditions against it.
- A replica that truncates drops the overlay above the truncation point. A replica that becomes leader builds its overlay from its own tail.

**Row retention** (3.1) runs on the leader's tick. Rows past their `ttl`, over `max`, or matching `where` are removed by records that carry a reason.

**The fold** is data's: records apply through its hot lane in offset order. Followers, clients and replays run the same fold, with no LWW comparison anywhere. A write to a cell under an absent row follows data's deep-path law, as today.

### 4.4 L3: flow

One verb serves followers, clients, relays, consumers and the viewer: **subscribe**, with a selector, a mode and a cursor.

| Part | Values |
|---|---|
| selector | `resource` (all of it); `partitions: [...]` (a follow set); `prefix`; `view` (a server-side view, 4.5); `shard` (followers and relays only) |
| mode | `state`: a snapshot, then deltas; may conflate a slow reader to the latest value per cell. `log`: every record from the cursor; never conflates |
| cursor | the cluster id, the resource's incarnation, then per shard the offset and epoch last seen; or `'latest'`, `'earliest'` |

- **Cursors know their log.** A cursor whose cluster id or resource incarnation does not match is refused `unknown-log`, so a cursor against a reborn cluster never waits forever or lands on unrelated records. Past retention, a cursor is refused `expired` with the earliest available.
- **A snapshot replaces.**
  - A `state` subscription's snapshot replaces the subscriber's whole view of the selected partitions: rows absent from it are removed.
  - It is applied as one diff against what the subscriber held, between the begin and end markers, so nothing flickers.
  - Ghost rows cannot survive a resubscribe, a failover or a jump.
- **Deltas carry offsets.** A delta for a filtered selector carries each record's own offset, so the subscriber's cursor is exact even when the server skipped records it did not select.
- **Credits.** A subscriber grants credit in bytes, and the server sends while it has credit.
  - A grant always admits at least one record, so a small credit never stalls a stream.
  - A `state` subscriber that falls behind is conflated **per row**: it gets each changed row as it is now, never cell by cell, so a whole-row write and a later field write keep their log-order meaning (V4-18).
  - A `log` subscriber that falls behind is paused, and resumes from its cursor.
  - Every link's outbound queue, credit-flowed or not, is bounded in frames and bytes (v4's V4-61 bounds). A link that overflows is closed with its reason, and the peer comes back with its cursor.
  - Nothing is dropped silently, and nothing buffers without bound.
- **Who serves.**
  - Any replica of the shard, up to its high-water mark, and never before its high-water mark has reached the subscriber's cursor (N-03).
  - A replica that jumps forward by installing a snapshot ends its `log` subscriptions on that shard with `expired`, and re-snapshots its `state` subscriptions.
  - A member serving a partition it does not replicate subscribes upstream itself: it is a relay for that partition.
  - A one-shot read at a member that no longer replicates the partition, and does not relay it, is refused `moved` with the current replicas.
- **Routing.** A per-shard index maps partitions to subscribers. A record costs one lookup, plus one write per matching subscriber, encoded once.
- **Follow sets** are the `partitions` selector, changed live with `FOLLOW` and `UNFOLLOW`. They are the near cache's mechanism (3.3), and the webserver's in the rooms case.
- **Failover.** A subscriber whose server goes away resubscribes elsewhere with its cursor.
  - In `log` mode it misses nothing.
  - In `state` mode it gets the deltas since its cursor or, past retention, a fresh snapshot (which replaces).
- **Big rows and snapshots** are cut into frames by size (v4's V4-51), with the subscription's begin and end markers around a snapshot, so a snapshot lands as one apply.

**Writes from a client.**
- **Read-your-writes.** A write resolves when the leader has committed it *and*, if this client follows the partition, its own subscription has passed the write's offset. A client sees its own write before its promise resolves.
- **Unfollowed partitions.** For a partition it does not follow, a write resolves at the commit.
- **Unfollow or failover.** On unfollow, or when the subscription ends, waiting writes resolve at their commit.
- **Reads after a write.** A client tracks the highest offset it has seen per shard, and its reads carry it as a minimum. A server answers once its state has reached that offset, so a later read never shows an older row (session consistency).
- **The pending-write queue** is bounded, by count (1,024) and by bytes (64 MB). When it is full, a new write is refused `backpressure`. Nothing already queued is dropped.

### 4.5 L4: surface

- **`fero(name, opts)`** returns the resource, as today: `data` (a live object over what this process holds), `methods`, `cluster`, `snapshot`, `destroy`. New:

| Call | Does |
|---|---|
| `follow(keys)` | a live view of exactly those partitions |
| `read({ from })` | log mode, from a cursor |
| `read(key, { fresh: true })` | a linearizable read: the leader confirms it is still leader with the in-sync set before answering (read-index) |
| `set`, `update`, `remove`, `incr`, `push` | writes, with `{ if, ttl, confirm }` |
| `cluster.writes.lookup(id)` | the outcome of an attempt |

- **Honest partial views.** On a client that follows only some partitions, `data` is a partial view. Sync reads of unfollowed rows throw `shortfall`, and operators on `data` throw `holistic`, as v4's scoped servers do. The handle `follow()` returns is the subset you can see, so no aggregate is silently partial.
- **Views** are data's incremental operators.
  - A view returned from a method is a server-side view: the serving member maintains it and streams it (v4's `09-live`).
  - Views with the same declarative shape are shared.
  - A `group` bucket can be streamed. This needs a change in data: `connect()` on an operator child.
- **Rows handed out are immutable.** data stores rows as frozen objects, and a write builds a new row sharing the unchanged parts. So reads by reference are safe, closing v4's in-place mutation bug (S-075), and they stay O(1).
- **Methods.**
  - They run on the member the caller reached, as today. `methods:` stays the door: with methods declared, clients change data only through them (V4-5).
  - **Call keys.** A call with a key claims a row in `#calls` (`if: { absent }`, with a lease) before its handler runs, and stores the result there. A finished call is never run again within the key's TTL.
  - **A handler that crashes mid-call** is run again when its lease lapses. Its writes carry attempt ids derived from the call key and their order, so the leaders' dedup makes the re-run's repeated writes no-ops. External effects take the call key as their idempotency key, as the "fero test" café already does.
- **Rules.**
  - `validation` stays: a schema check where a write enters.
  - `rules.write(peer, record, current)` runs at the leader with the current row (4.3), so a rule can depend on state ("only the booker may cancel", "stock never below 0").
  - `rules.read(peer, partition)` runs where a subscription is served.
- **Code on leaders.**
  - Every member registers the code hashes it can run.
  - The controller places a shard's leadership only on a member that has the resource's hashes.
  - A member lacking them still replicates, and never leads.
- **Identity and security.**
  - A client presents a token signed by the cluster (claims: subject, roles, expiry), and `ctx.peer` carries the claims. The shared client key (`secret.client`) stays as the simplest token.
  - TLS uses a cluster certificate authority. Members get certificates when they join, so clients verify servers, closing v4's "a client-key holder can pose as a server" (S-123).
  - The secret rotates through the metadata log, which holds the current and the next secret during a window.
  - The box directory stays on loopback, as today.
- **`cluster.writable`** is true when every shard of the resource has a leader and at least `minInSync` in-sync replicas. `cluster.shards` lists each shard's state for the rest.
- **Defining and changing a resource.**
  - The first `fero(name, opts)` that creates a resource writes its config to the metadata log. From then on the catalog is the source of truth.
  - A later open with different options is refused, naming the difference (N-17), unless its code hashes are allowed by an `alter` in progress. This also covers a process restarted with old options after an alter.
  - `fero.alter(name, change)` changes it online. A roll adds the new code hash before the roll and removes the old one after. This replaces the cluster contract's refusal at the door (V4-30, DESIGN-DOOR §4).
- **Config, in three scopes.** Every v4 key keeps its scope unless listed here.

| Scope | Lives in | Keys | Changes |
|---|---|---|---|
| node | the config cascade, as today | `uuid`, `dir`, `listen`, `advertise`, `hosts`, `voters`, `secret`, `secret.client`, `rendezvous`, `heartbeat.ms`, `redial.*`, `leave.ms`, `journal.cap`, `diag.allow`, `signals`, role, `memory` | restart that node |
| cluster | the metadata log | voter count, witness, default `replicas`, `minInSync`, `lag.ms`, `evict.after`, cluster version | online |
| resource | the metadata log | `shards`, `replicas`, `partition`, `history`, `rows`, `durability`, `validation`, `rules`, `methods`, `load` | online through `fero.alter`; code by allowed hash |

- **Worlds** (fero test): a bound world resolves names to stand-ins, makes server markers into solo nodes, and supplies `now` and `id`. This is unchanged from the "fero test" design; v5 adds only that a solo node is the same L0 to L2 code, with one replica.

### 4.6 L5: libraries and adapters

L5 is built only from L4 calls. Each library is a file with its own tests, and none adds a wire verb:
- the queue, consumer groups, locks, presence, rate limits and loaders of section 5;
- a RESP gateway (Redis clients), a Kafka-protocol gateway, a WebSocket gateway for browsers;
- the `fero` CLI: `run`, `test`, `deploy`, `ls`, `debug`, `recover`.

### 4.7 The wire

| Family | Verbs | Layer |
|---|---|---|
| link | `HELLO`, `DOOR`, `PING`, `DIAG` | L0 |
| metadata | `VOTE`, `APPEND`, `SNAPSHOT` (Raft); `SESSION` (member heartbeats) | L1 |
| shard | `FETCH`, `DATA` (with the divergence answer); `ISR` (an in-sync change request) | L1 |
| writes | `WRITE`, `WRITE-ACK` | L1, L2 |
| flow | `SUB`, `SNAP`, `DELTA`, `END`, `CREDIT`, `FOLLOW`, `UNFOLLOW` | L3 |
| methods | `CALL`, `RESULT`, `SUBREC` | L4 |
| admin | `DEFINE`, `ALTER`, `RECOVER` (to the controller) | L4 |

That is 27 verbs in seven families. v4 has about as many; the difference is that each family belongs to one layer and one published protocol.

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
| stream, replay | `history: '7d'`, `read({ from })` | L1, L3 |
| consumer groups | the groups library (5.3) | L5 |
| work queue | the queue library (5.3) | L5 |
| locks, leader election | the locks library (5.3) | L5 |
| counters, rate limits | `incr` with bounds; rows with a `ttl` per window | L2 |
| leaderboards, live aggregates | views; across shards, mergeable partials (phase 5) | L4 |
| presence | `rows: { while: 'session' }` | L2 |
| invariants (stock, balances) | conditions, `rules.write`, or one partition | L2, L4 |
| transactions across partitions | locks with fencing plus an intent row (5.3) | L5 |
| event sourcing, CQRS | facts as rows, or `history: 'all'`; views as projections | L2, L4 |
| derived resources | a reader of one resource's log writing another, its cursor stored as a fenced row | L5 |
| tapes, forks, replays (fero test) | section 6 | L1, L4 |

### 5.2 One example in full: the websocket rooms

```ts
// the resource: a room is a partition, a message is a row in it
const chat = await fero('chat', { partition: (k) => k.split('/')[0], history: '1d' })

// a webserver: a client that follows only its sockets' rooms, and holds at most 200 MB
const web = await fero('chat', { cache: { memory: '200MB' } })
socket.on('join', (room) => web.follow(room).tap((r) => socket.send(r)))   // snapshot, then deltas
socket.on('say', (room, text) => web.data[`${room}/${fero.id()}`] = { text, at: fero.now() })
```

- **A message's path.** It is appended once to its room's shard, replicated to the shard's in-sync set, and delivered by each serving member to the webservers that follow that room, encoded once.
- **No firehose.** A webserver never receives a room it does not follow.
- **Reconnects.** A webserver that reconnects passes its cursor, and misses nothing within a day.

### 5.3 The libraries

- **Queue.**
  - A message is a row: `{ body, lease: null, deliveries: 0 }`.
  - `take` claims one with `if: { expired: 'lease' }`, setting `lease = { by, until: t + visibility }` and incrementing `deliveries`, in one batch.
  - `ack` removes the row.
  - A lease that runs out makes the row claimable again. Past `deliveries`, it moves to `${name}.dead`.
  - Order is FIFO per partition. A queue that must be FIFO overall uses one partition.
- **Consumer groups.**
  - The members of a group are rows with leases in `#groups`.
  - The assignment of shards to members is a pure function of the live members and the generation.
  - Offsets are rows written with `if: { fence: generation }`, so a zombie consumer cannot commit.
- **Locks.**
  - A lock is a row in `#locks`, claimed with `if: { absent }` or `{ expired: 'lease' }`. Its token is the claim's offset.
  - The writes it protects carry `if: { fence: token }`, and each partition's leader remembers the highest token it has seen.
  - A lock records the offsets its holder wrote at, so the next holder can make its reads carry them as minimums (4.4).
- **Transactions across partitions.**
  1. Take the locks in key order.
  2. Write an intent row: `{ steps, done: [] }`.
  3. Apply each step with a fence, and mark it done.
  4. Remove the intent.

  A later holder that finds an intent finishes it. Single-partition work needs none of this: one batch with a condition.
- **Presence.**
  - A session is a row in `#sessions` with a lease the client renews.
  - Rows written `while: 'session'` carry the session's id.
  - Each shard leader subscribes to `#sessions` and removes a lapsed session's rows.

## 6. fero test and fero deploy on v5

### 6.1 fero deploy: the fourteen needs

| # | Need (from "fero deploy: the journey") | On v5 |
|---|---|---|
| 1 | the `fero` command and the npm build | L5; unchanged by the kernel |
| 2 | `file`, `scale`, `size` from the file | node-scope config (4.5) |
| 3 | a box directory that lists names, runs and folders | unchanged; a name carries its project and run, and one project is one cluster |
| 4 | a caught-up signal | exact: a member is caught up when it is in the in-sync set of every shard it replicates. `cluster.me.caughtUp` |
| 5 | a full restart, and a restart after one-by-one stops | under a supervisor every stop is a `restart` (4.2): voters and shards stay, so any order of restarts comes back while a voter majority and an eligible replica per shard return |
| 6 | a joining copy skips its seed | a seed is applied once, when the controller creates the resource, and recorded there; a joiner fetches shards |
| 7 | listen and advertised addresses apart; bracketed IPv6 | the member record holds both |
| 8 | TLS for clients, one public address | L0 transport and the cluster CA (4.5); clients route through any member |
| 9 | a client leaves a server whose writes are shut | a server that cannot reach a shard's leader says so on the write, and the client moves |
| 10 | the supervisor sets the secret over the call | node config precedence: a supervisor layer above the call |
| 11 | a new version's contract reported before it joins | the allowed-hash list (4.5): the deploy adds the hash first, so the check is a lookup |
| 12 | no deleted row comes back | structural: a remove is a record in one log per shard, with no tombstones to collect, no other lane to resurrect from, and snapshots that replace (4.4) for resubscribing clients |
| 13 | refuse writes with a reason while reads go on | the resource's write gate in the metadata log (unpaid), and a member memory bound (near full) |
| 14 | group commit | L0 (4.1) |
| later | rolling a contract change; a reformat that rolls | allowed hashes, taken over normalised source |
| later | state larger than memory | the L0 on-disk store, phase 5 |
| new | moving a v4 `dir` to v5 | `fero migrate`: reads v4's WAL and snapshot into one v5 snapshot per shard at offset 0 |

**The roll on v5.**
1. Copy 1 restarts: its leaderships move to in-sync followers first.
2. It comes back on the new files and catches up.
3. When `caughtUp` says so, the next copy goes.

Restart-all is every copy restarting at once: the voters and shards are in each disk's metadata log.

### 6.2 fero test: the eleven pieces

| # | Piece | On v5 |
|---|---|---|
| 1 | the world in `fero()` | L4, unchanged; a solo node is L0 to L2 with one replica and the in-process transport |
| 2 | the clock and ids | leader time `t` (4.3) under the world's clock; `fero.id()` from the world's seed |
| 3 | input keys | call keys in `#calls`, with crash semantics (4.5) |
| 4 | `fero test` as a verb | L5 |
| 5 | components ship their stand-ins | unchanged |
| 6 | the test block in the viewer | the capture carries offsets, so inputs, records and asks line up by position |
| 7 | the spec and the layout | unchanged |
| 8 | the store: forks, versions, proposals | records in system resources, as designed. **A fork's rows are a copy-on-write snapshot** of each shard at an offset: segments and snapshots are immutable, so a fork costs a pointer |
| 9 | the tape at the live edge | **a tape is a resource with `history: '14d', rows: false`**: the edge appends each input and answer, and a replay reads it with `read({ from })` |
| 10 | the ai component and `fero change` | unchanged |
| 11 | app steps in the simulator; agents | methods run as sim steps against L0 to L2, under the same seeds |

## 7. The backtest, summarised

*Completed in V5-BACKTEST.md; summary filled in when the last mapping lands.*

## 8. Performance, layer by layer

Each row is a target, the technique that reaches it, and the bar it must beat. Each becomes a pin, measured with the competitor's own tool on the same box, under fero's never-widen rule.
- **The TS column** is what the TypeScript kernel must reach in phases 2 to 4.
- **The native column** is what the Rust core must reach in phase 5.

| Layer | Measure | Today (v4) | TS | Native | How | Bar |
|---|---|---|---|---|---|---|
| L0 | persisted appends per member | about 250/s | 50k/s | 500k/s | one journal, one fdatasync per ≤ 1 ms batch, `writev` | Kafka, Redpanda per broker |
| L0 | snapshot install | — | 100 MB/s | 1 GB/s | streamed segments, no decode | — |
| L1 | replicated appends per leader | 14k/s through the api, 73k/s raw | 150k/s | 2M/s | pipelined fetch, batches across shards per link, no decode on followers | Redpanda |
| L1 | commit latency on a LAN, p99 | — | 3 ms persisted | 1 ms persisted | fsync in parallel with replication; long-poll fetch | Kafka acks=all |
| L1 | failover to writable | about 4 s (eviction) | 1 s | 0.5 s | sessions (4.2) | KRaft |
| L1 | idle traffic, n = 100 | 9,900 PINGs a tick | under 1,000 frames/s | the same | no mesh; one fetch session per pair | — |
| L2 | fold per record | about 10 µs (solo write through the api) | 2 µs | 0.2 µs | header-only decode, no per-record objects | — |
| L2 | conditional op at the leader | none | 3 µs | 0.5 µs | lookup and compare in the append path | Redis INCR server time |
| L3 | fan-out per relay core | — | 300k deliveries/s | 3M/s | per-shard index, encode once, `writev` | NATS core |
| L3 | subscribers per relay | — | 20k sockets | 200k | credits, conflation, no per-subscriber timers | Centrifugo, Phoenix |
| L4 | read of a held row | in-process | under 100 ns | the same | immutable rows (4.5) | Redis GET: a network round trip |
| L4 | method call, caller on the leader | — | 10 µs | 5 µs | in-process | Redis Lua |
| L4 | view update per change | 5,000 filter views: about 500 µs a write | 1 µs per affected view | the same | shared declarative views; `group` routing | — |

### 8.1 What carries the targets

- **Batches of bytes end to end.** Writes, replication, fsync, fan-out and catch-up all move encoded batches. Only the fold decodes, and only the header plus the cells it touches.
- **No work per view per record.**
  - Predicate subscriptions route through shared `group` indexes, so 5,000 room views cost one hash lookup per record.
  - Measured on v4: 5,000 `filter` views cost 450 to 510 µs per write, while one `group` cost 10 to 20 µs.
- **Nothing on a timer that scales with data.**
  - v4's unscoped compaction rescans every lane of 4,096 entries or more on every heartbeat: 43% of CPU in a two-member run. A separate task is queued for it.
  - In v5, retention drops whole segments, and snapshots are taken from copy-on-write state.
- **Group commit.**

### 8.2 Where fero can win outright, and where it should match

- **Win:**
  - Reads of held rows: in process, against a network round trip.
  - Ops where the caller is the leader.
  - Fan-out that carries state: a late joiner gets the room's current rows, then live deltas, in one subscription.
  - One system to run instead of three.
- **Match:** raw log bytes per disk and per NIC, which bound every system equally.

### 8.3 Measuring

A pinned quiet runner, which STATUS already wants. For each comparison, the competitor's own tool:

| Against | Tool |
|---|---|
| Redis, Valkey (through the RESP gateway) | memtier |
| NATS | `nats bench` |
| Kafka, Redpanda | the OpenMessaging Benchmark |
| etcd (for the locks library) | etcd's benchmark |
| reads, views, fan-out | fero's own pins |

Results go into `tools/perf/results`, as today's baseline does.

### 8.4 TypeScript first, native next

- **Why native for the hot path.** The native column needs native code. JavaScript's per-object costs and its single event loop cap one process well below it.
- **TypeScript first.** L0 to L2 are a deterministic machine behind one interface: events in, effects out. Build them in TypeScript under the simulator until the semantics stop moving.
- **Then Rust.** Implement the same interface in Rust (N-API for Node, WASM for browsers, a C ABI for other languages). Run both under the same seeds and compare effects byte for byte. L3 fan-out and L0 io move with them.
- **L4 stays JavaScript.** Views, methods and rules are user code.

## 9. Measured today

Measured on `main` (d7c9efe) on this session's container (Node 22, a cloud VM). These numbers locate costs; they are not a baseline.

**The data version.**
- GitHub's data `v4` branch is at 63fea66, which is SCHEDULE_VERSION 4. fero's `main` needs 5 (V4-47), and those data commits exist only on the author's machine.
- So the kernel rows below hold, because they are fero's own code. The two rows marked *data 63fea66* may differ on the newer data.
- The full battery could not be run faithfully here. With data 63fea66 it showed 50 failures in its first 196 tests, so the run was stopped.

| What | Result |
|---|---|
| 100k writes, solo node, through the api | 1.6 s: about 62k/s. Top costs: GC 14%, `kernel/node.ts apply` 10%, the api's outcome bookkeeping (`#forget`, `#issue`, `onOutcome`) about 11% |
| 100k writes, two members, seen on the second | 7.0 s: about 14k/s. 43% of CPU in compaction: `winner` stringifies every key of every lane on every heartbeat |
| per-write cost with K live room views on a solo node (*data 63fea66*) | K filters: 5,000 cost 450 to 510 µs a write; one `group` with 5,000 buckets: 10 to 20 µs |
| a client that opens one room's server view | holds all 1,000 rows; its room mirror held 10 |
| a method that streams one `group` bucket (*data 63fea66*) | refused by data: "connect() on an operator-view child is not supported" |
| two claims via `validation` reading local state | both committed, both callers told `ok` |
| a check-then-set method, both calls on the owner | the second refused ✓; on a non-owner, or one on each, both `ok` |
| persisted writes (STATUS, platform spike R3) | about 250 a second per member: one fsync per write step |

## 10. Keeping development fast

### 10.1 What slowed v4

| Measure (on `main`, October 2026) | Value |
|---|---|
| commits | about 700: fix 225, docs 215, test 156, feat 51, perf 20 |
| lines added | tests and sim +31.0k; site +37.7k; docs +12.5k; kernel, api and shell +10.2k |
| the tree | 9.1k lines of kernel, api and shell code, with 6.9k lines of comments in them (43%); 38.5k lines of tests and sim; 15.6k lines of docs |
| open bugs in STATUS | 15 (5 Oct), 29 (10 Oct), 40 (15 Oct), 34 (22 Oct) |
| DECISIONS.md | 1,338 lines (5 Oct) to 2,995 (22 Oct) |
| review rounds | lanes of four, seven and eight rounds are recorded |
| the record also shows | reviewer capacity limits that stalled lanes; parallel sessions that collided (a renumbering, a fix made twice); an eight-day gap before V4-57; no CI and no pinned runner |
| the two repos on GitHub | fero's `main` needs data at SCHEDULE_VERSION 5; GitHub's data `v4` is at 4. Nobody else can run the battery, and the CI file v4 wrote would fail on its first run |

Bugs were found about as fast as they were fixed. The open ones sit where two or more mechanisms meet:
- tombstone GC, compaction and a short lane;
- a shed, a paused link and a resync;
- a leave, a stalled survivor and the knock window;
- a tap's write and the owner's own commit.

That is the cost of the design, not of the people or the process:
1. **Too many mechanisms that interact.**
   - The kernel has lanes, Lamport stamps, digests and synced-gating, tombstone GC, the compaction frontier, ballots with held members and the knock window, and ring forwarding with dedup windows.
   - Scoped clusters add holders, orphans, sheds, latches, teachers, floors, FEED words and drains.
   - Each new mechanism must be proven against all the others, so each costs more than the last.
2. **Novel protocols.** The pp floor law, the one-teacher latch, FEED words, the knock window and held members have no literature. Every property is discovered.
3. **Proof by discovery.** Sweeps and reviews run after the code exists, and each round finds the next case.
4. **Many documents per change.** A fix touches code comments, DECISIONS, STATUS, README, sometimes HISTORY and the site's claims check.
5. **One kernel-wide golden trajectory.** Any rule change "moves trajectories" and needs its own decision.
6. **The site** was about a third of all October's added lines.

### 10.2 What keeps v5 fast

1. **Fewer mechanisms, all published.**
   - L1 is Raft and Kafka's replication: published algorithms with public TLA+ models (Raft; Kafka's replication) and a decade of Jepsen reports.
   - Gone: lanes, stamps, digests, tombstones, compaction frontiers, orphans, sheds, latches, teachers, floors and FEED words.
   - A **mechanism list** heads each layer's doc. Adding a mechanism means naming what it replaces, or why it cannot be a library.
2. **Check every layer against a model before code.**
   - **L1 in TLA+,** extended with what the public models leave out: single-voter configuration changes, with Ongaro's bug as a property that must fail without the fix; in-sync sets; eligible leaders; sessions. Checked exhaustively at small sizes (3 voters, 2 shards, crashes, partitions, restarts, power loss).
   - **L3's subscription protocol in TLA+ too:** cursors, snapshots that replace, credits, failover.
   - **L2 against a reference model:** a 200-line sequential interpreter of records, conditions, ops and dedup. Random operation sequences run through both, and must agree.
   - **The simulator checks the code against the spec.** Each seeded trajectory's metadata and shard events are replayed through the TLA+ model (trace validation).
3. **Layer contracts.**
   - Each layer has an interface, an invariant list and a suite that runs in under 30 seconds.
   - A change inside a layer runs that layer's suite and its neighbours' contract suites. The full battery runs in CI.
   - Golden trajectories are per layer, so a change in L3 never moves an L1 trajectory.
4. **Monitors are tested too.** Each monitor has a mutant kernel it must catch. v4's mutation runner already does this for some; make it all.
5. **One current doc per layer,** edited in place to say what is true now.
   - DECISIONS records stay, at ten lines or fewer, linking to the commit.
   - STATUS is one line per item.
   - Comments say why, at about a fifth of the lines.
   - The site's claims are generated from tests, and the site lives in its own repo.
6. **Lanes with a stopping rule.**
   - A lane has acceptance criteria written before it starts: the invariants it keeps, the tests it adds, the pins it holds.
   - Reviews continue while a round finds a critical, and stop at the first round that finds none, so a late critical is still caught.
   - A finding outside the lane's scope becomes a one-line STATUS item with a failing seed. It does not extend the lane.
   - One integrator merges. Ids are assigned at merge, and lanes declare the files they touch, so parallel sessions do not collide.
7. **Bug intake.** Every bug arrives as a failing seed or test, tagged with its layer and the invariant it breaks. The preferred fix removes a mechanism.
8. **A swamp guard** (v3's CHECKPOINT, as a rule). If open bugs grow for two weeks running, or a lane passes four rounds, stop and re-plan before more code.
9. **CI and a pinned runner from phase 0.**
   - The CI file v4 wrote and never pushed goes first, with data's matching commit pushed before it.
   - Both repos pin each other's commit: fero records the data commit it was tested with, and CI checks out that commit, not a branch head. So a push can never leave the pair unrunnable.

## 11. The plan

Each phase ends on a test, not a date.

| Phase | Builds | Done when |
|---|---|---|
| 0. Decide | the answers in section 12; v4 frozen for features, with deploy-blocking fixes only; CI and the pinned runner | the decisions are recorded; CI is green on v4 |
| 1. Specify | L1 and L3 in TLA+; the L2 reference model; the L0 to L4 interfaces; the invariant list per layer; every backtest row as a named test | the model checker is green (section 10.2); every row has a test name |
| 2. Kernel | L0, L1 and L2 in TypeScript under v4's simulator (reused), with v5's monitors and trace validation | 1,000-seed sweeps green; kill -9 of a whole cluster, and a simulated power loss, lose no `persisted` write; the L0 to L2 TS pins |
| 3. Surface | L3 (subscriptions, follow sets, relays, clients) and L4 (v4's api ported: data binding, methods, door, config, rules, identity); the carried v4 bugs in data, views, door and config fixed | examples 01 to 44 pass, unchanged except where v5 changes a documented rule; every backtest row passes or is marked not applicable with its reason |
| 4. Platform | worlds, call keys, tapes, forks, caught-up, roll and restart-all, TLS and the cluster CA, `fero migrate`, the npm build | the café from "fero test" runs on v5; milestones 1 and 2 of "fero deploy" run against a local three-copy cluster |
| 5. Scale and speed | the Rust L0 to L2 behind the same interface, with differential runs; shard splits; state larger than memory; mergeable views across shards; the libraries; the RESP, Kafka and WebSocket gateways | every row of section 8 is a green pin in the native column, against its named competitor, on the pinned runner |

**Real-disk and real-network tiers** run from phase 2: v4's real-socket and real-WAL tiers, plus power-loss runs on LazyFS (a filesystem that loses unsynced writes, as Jepsen uses).

**What carries over from v4.**
- The codec and frames (V3-8).
- The simulator, the shrinker and the debugger. Captures gain offsets.
- The journal (V3-2).
- The door, the directory and the config cascade.
- The data engine and the method plane.
- The confirm ladder's names.
- The examples and their checks: the acceptance suite.
- The perf harness and its rules.

**What is replaced.**
- `kernel/log.ts`, `streams.ts`, `scope.ts` and most of `write.ts`.
- `membership.ts`, by Raft over the metadata log.
- `confirm.ts`, by high-water marks and in-sync sets.
- The FEED words, digests, tombstone GC and compaction.

## 12. Decisions for you

Reply "defaults" to take every pick, or name a change ("3b").

1. **Replace v4's kernel.** a) v5's kernel under v4's api and tools, with v4 frozen for features (my pick). b) Evolve v4 one mechanism at a time.
2. **Shard replication.**
   - a) Kafka's protocol under a Raft controller (my pick). One Raft group; in-sync sets; two copies plus a witness work.
   - b) Raft per shard (Redpanda, CockroachDB). No controller, but thousands of Raft groups, and two copies cannot survive a crash.
3. **Language.** a) TypeScript first, then Rust behind the same interface in phase 5 (my pick). b) Rust from the start: faster sooner, slower to change while the semantics move.
4. **Default durability.**
   - a) `persisted`, with group commit (my pick). About a millisecond, and nothing a reader saw is undone.
   - b) `committed`. Faster, but a power loss of every replica can undo what readers saw.
5. **One cluster per project.**
   - a) Resources are catalog entries in their project's cluster (my pick). This matches deploy decision 1a.
   - b) One cluster per resource, as v4 has.
6. **What Ctrl-C does.**
   - a) `leave` when interactive, and `restart` under a supervisor (my pick). Example 01 keeps its story, and deploys get restarts.
   - b) Always `restart`, which needs a witness or three members for Ctrl-C to keep a survivor writable.
7. **Defaults.**
   - a) My pick:
     - 16 shards;
     - 3 replicas, with `minInSync` 2 (1 when a resource has 2 replicas);
     - 3 voters;
     - a 100 ms tick, `lag.ms` 1 s, `evict.after` 10 min;
     - `history: 0`, `rows: true`.
   - b) Name your own.
8. **The witness.** a) In phase 2, as a metadata-only voter (my pick). b) Later.
9. **When a frame leaves** (STATUS, from V4-63).
   - a) At the end of the event-loop turn that made it (my pick, as v4 does).
   - b) Send a turn's first small frame at once.
10. **Streaming method results** (STATUS). a) Stream a method's returned view as today, with `move` records carried (my pick). b) Snapshots only.
11. **The model checker.** a) TLA+ for L1 and L3, plus a reference model for L2 (my pick). b) Quint or P.
12. **The development rules of 10.2.** a) Adopt them for v5 from phase 1 (my pick). b) Adopt them for v4 too, now.

## 13. The review

*Filled in after the independent review.*
