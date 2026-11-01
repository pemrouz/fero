# fero v5: one log, three retentions, five layers

A design, a plan and a backtest for the next fero kernel. Written 2026-11-01 against `main` at d7c9efe (v4, 1,216 tests) and data at 63fea66. The evidence behind the backtest is in [V5-BACKTEST.md](V5-BACKTEST.md); measurements are in section 9. Nothing here is built.

**Contents.** 1 The answers · 2 The model · 3 Retention: history, rows, caches · 4 The layers and their primitives · 5 How each pattern is built · 6 fero test and fero deploy on v5 · 7 The backtest, summarised · 8 Performance, layer by layer · 9 Measured today · 10 Keeping development fast · 11 The plan · 12 Decisions for you · 13 The review

## 1. The answers

- **Retention applies to two different things, and both are knobs.** `history` is how much of the log of deltas a resource keeps; `rows` is which rows its state keeps. They are orthogonal: a stream keeps history and no rows, a map keeps rows and no history, a tape keeps both. A row removed by a `rows` rule is a change like any other, so it is written to the log as a remove. A third knob, `cache`, is per node and never written anywhere: it is which rows this process keeps in memory. Section 3.
- **Caches are the same mechanism.** A Redis-style cache is a resource with `rows: { ttl, max }`; a near cache on a webserver is a `cache` limit on a client; a read-through cache over a database is a resource with a `load` function. Section 3.3.
- **The layers.** L0 io, L1 replication, L2 fold and ops, L3 flow, L4 surface, L5 libraries. The protocol primitives are eight wire verbs and five record fields; everything a pattern needs above that is a library. Section 4.
- **The backtest.** Every hard case v4 recorded (catalogued from DECISIONS, STATUS, the design records and HISTORY) is mapped to v5 in [V5-BACKTEST.md](V5-BACKTEST.md). Summary in section 7.
- **Performance.** Every layer has a budget, a technique and a competitor bar, and each becomes a pin. Section 8.
- **Development speed.** v4's October: about 700 commits, open bugs 15 to 40 to 34, DECISIONS doubled, up to eight review rounds per lane. The cause is the number of mechanisms that interact; the fix is fewer mechanisms, each a published algorithm, checked by a model checker before code. Section 10.
- **fero test and fero deploy.** All fourteen kernel needs from "fero deploy: the journey" and all eleven pieces from "fero test" have a home; several become free (tapes are logs, forks are copy-on-write snapshots, caught-up is an offset). Section 6.

## 2. The model

| Word | What it is | Example |
|---|---|---|
| **resource** | One `fero(name)`: a map of rows, its methods, its rules | `fero('bookings')` |
| **row** | The value under one top-level key | `bookings.data.b42` |
| **cell** | A path inside a row; the unit of a write | `b42.status` |
| **record** | One change to one cell or row: set, remove, insert. data's delta, with a header (section 4.3) | `{ set, ['b42','status'], 'booked' }` |
| **partition** | The unit of order, atomicity and following. By default one row. A `partition` function can group rows | `partition: (k) => k.split('/')[0]` puts `room42/m1` and `room42/m2` in `room42` |
| **shard** | A hash bucket of partitions with one log, one leader and R replicas. Invisible to users | `hash('room42') & 15` → shard 7 of 16 |
| **log** | One shard's records in order, each with an offset | shard 7: offsets 0, 1, 2, … |
| **state** | The rows: the fold of the log | what `f.data` shows |
| **member** | A process that holds shard replicas and votes | a copy in fero deploy |
| **client** | A process that follows some partitions and writes through a member | a webserver |
| **relay** | A client that also serves other clients | an edge fan-out tier |

**Keys, partitions and shards.** A key is a top-level key of the resource's object, as today. A partition is one or more keys that must stay ordered and atomic together: by default exactly one key, so nothing changes for existing code. A shard is many partitions sharing one log, so that a commit, an fsync, a replication frame, a leader election and a catch-up are paid per shard, not per partition. A shard never splits a partition. A single hot partition is bounded by one leader's core, like a Redis key or a Kafka partition; the app splits it (`room42-0` … `room42-3`) if it must.

**Shard count.** A power of two per resource, 16 by default, set at creation. A shard that grows past a size or load bound splits by taking one more hash bit: shard 7 of 16 becomes shards 7 and 23 of 32. The split is a metadata record at an offset; both children start there, so every cursor still resolves (section 4.2). Merging is the reverse. Splits are phase 5; fixed counts work until then.

**What a record's position means.** Every record carries two numbers: its shard offset (contiguous within the shard) and its partition sequence (contiguous within the partition). The partition sequence is what users see: it is a row's version, a cursor's position and a condition's `version`. The shard offset is internal: it is what replication, fsync and retention count.

**Order.** One partition is totally ordered, whoever writes to it. Partitions are not ordered against each other, as today. A cell keeps the value of its last record in log order: there are no stamps and no elections, so v4's overlapping-cells rule (V4-18: a whole-row write hides older field writes, a newer field write shows on top) is simply log order.

## 3. Retention: history, rows, caches

### 3.1 Three knobs

| Knob | Applies to | Decided by | Written to the log? | Values |
|---|---|---|---|---|
| `history` | the log of deltas, after commit | the resource's config | no: dropping history changes nothing anyone sees | `0` (default), `'7d'`, `'10GB'`, `1e6` (records), `'all'` |
| `rows` | the state: which rows exist | the shard leader, using leader time | **yes**: a row it removes is a `remove` record with a reason (`ttl`, `max`, `where`) | `true` (default: keep every row), `false` (no state: a stream), `{ ttl, max, evict, where }` |
| `cache` | one process's memory | that process | never | `{ memory: '200MB' }` on a client or relay; members keep their whole replicas |

**Why history and rows are orthogonal.** History answers "what happened"; rows answer "what is". Dropping history never changes a row. Removing a row never drops history: the remove itself is appended. In an append-only resource (every write a new row) the two hold the same items, but they are still kept by different rules: history by age or size in log order, rows by key with a TTL or a count.

**Why `rows` removals are records.** Replicas, subscribers and replays must agree on which rows exist. If each replica expired rows on its own clock they would disagree for a moment, and a replay would disagree forever. So the leader decides, using its clock (section 4.3), and appends the remove.

**What `rows` can evict by.** Write time (`ttl` since the last write, `evict: 'oldest'`), count (`max`) and content (`where: (row) => row.status === 'done'`). Not by read recency: reads happen on every replica and never reach the leader, so the leader cannot know which rows are idle. Read recency is what `cache` is for.

### 3.2 What each combination is

| Pattern | `history` | `rows` | Other | Like |
|---|---|---|---|---|
| live map (today's fero) | `0` | `true` | | Redis hash, KTable |
| cache with expiry | `0` | `{ ttl: '10m', max: 1e6 }` | | Redis with `maxmemory` |
| session store | `0` | `{ ttl: '30m' }` | `touch` resets the ttl | Redis sessions |
| stream | `'7d'` | `false` | | Kafka topic |
| compacted stream | `'all'` | `true` | readers start at a snapshot | Kafka compacted topic |
| event store | `'all'` | as needed | | EventStoreDB |
| pub/sub | `0` | `false` | `durability: 'none'` | NATS core, Redis pub/sub |
| queue | `0` or `'7d'` for audit | messages are rows; ack removes | the queue library (5.3) | SQS, JetStream work queue |
| tape (fero test) | `'14d'` | `false` | | a recording |
| presence | `0` | `{ while: 'session' }` | | ZooKeeper ephemeral node |

`durability` is the default rung for writes: `'none'` (leader only, no fsync: transient pub/sub), `'committed'` (an in-sync quorum holds it, the default), `'persisted'` (an in-sync quorum has fsynced it). A write can ask for more than the default, never less.

### 3.3 Caches, all from the same parts

- **A replicated cache** is a resource with `rows: { ttl, max }`. Every replica holds the same rows; the leader expires them; subscribers see the removes.
- **A near cache** is a client with `cache: { memory }`. It follows the partitions it reads, keeps them fresh by subscription while it holds them, and drops the least recently read when it runs out of room (an unfollow). A miss is one hop to a member. This is how a webserver or a browser holds a slice of a resource too big for it.
- **A read-through cache over another system** is a resource with a `load` function: a read of a missing row asks the partition's leader, which runs `load(key)` once however many readers miss at once, writes the row, and answers. With `rows: { ttl }` it is a Redis-style cache in front of Postgres, with every reader live.

## 4. The layers and their primitives

```
L5  libraries, adapters      queue · consumer groups · locks · presence · rate limits · loaders · RESP / Kafka / WebSocket gateways · fero CLI
L4  surface                  fero(name) · data views · methods · rules · identity · config · worlds (fero test)
L3  flow                     subscriptions: selector + mode + cursor · credits · conflation · relays · near caches
L2  fold and ops             records → rows · conditions · leader ops · leader time · dedup · row retention
L1  replication              metadata log (the controller) · shard logs · leader epochs · in-sync sets · catch-up
L0  io                       segments · snapshots · group commit · transports (TCP, TLS, WebSocket, in-process)
```

A layer talks only to the one below it, through an interface with its own test suite. L0 to L2 are deterministic: they take events (frames, ticks, disk completions) and return effects, as v4's kernel does (V3-1), so the simulator runs them unchanged and a native implementation can replace them behind the same interface (section 8.4).

### 4.1 L0: io

- **Segments.** Each shard's log is a sequence of segment files (append-only, 64 MB by default). The log is the WAL: there is no second copy. A segment is deleted when history retention, every replica's fetch position and the latest snapshot are all past it.
- **Snapshots.** Each shard's state is snapshotted at an offset every N records or M seconds. Boot is the latest snapshot plus the log after it. A follower too far behind installs a snapshot, then fetches.
- **Group commit.** Appends to all shards on a member go into one batch; one `fdatasync` per batch, at most every millisecond or every 1 MB. `persisted` waits for the fsync that covers the record. (Today: one fsync per write step, about 250 persisted writes a second per member; STATUS "Group commit".)
- **State larger than memory** (phase 5, opt-in per resource): rows live in an on-disk keyed store with the hot set in memory. Views and first pictures read through it.
- **Transports.** TCP, TLS (clients first, then members), WebSocket (browsers, without a bridge), in-process (worlds and the simulator). Frames are v4's: encode once, crc32c, the bytes are the segment row and the wire (V3-8).

### 4.2 L1: replication

Two logs, one protocol family, both published algorithms with public TLA+ specifications.

**The metadata log** is one Raft group over the voters: every member, plus an optional witness that stores only this log. Its leader is the **controller**. It holds:

| Record | Holds |
|---|---|
| member | id, addresses (listen and advertised, apart), role (voter, witness, learner), state (up, stopped, leaving) |
| resource | name, config (section 4.5), code hashes allowed (methods, rules, partition function, validation), seed applied (yes/no), write gate (open, read-only with a reason) |
| shard | resource, number, replicas in order, leader, leader epoch, in-sync set, split lineage |

Membership is Raft's: a new member joins as a learner, catches up, then becomes a voter by a single-member configuration change. **A clean stop is not a leave.** A stopped member stays a voter and keeps its shards; it is marked `stopped`, its shards get new leaders from their in-sync sets, and when it comes back it catches up and rejoins them. Only `leave` (scale-in) changes the configuration, after the controller has moved every shard replica off the member. This removes v4's "only the last member to stop can bring the cluster back" (STATUS, decided-not-changed) and makes restart-all an ordinary restart.

**The shard logs** use Kafka's replication protocol under that controller (the KRaft design):

- The leader appends writes to its log in order and serves `FETCH` from followers; a follower's fetch position is its acknowledgement.
- **Commit** = every member of the in-sync set has the record. The high-water mark rides on every fetch answer. Subscribers and readers only ever see records below it, so nothing anyone saw is ever undone.
- **In-sync set.** A follower that lags more than `lag.ms` is removed by the controller at the leader's request, and added back when it catches up. Writes need at least `minInSync` replicas in the set (default 2 at R = 3); below that a shard refuses writes and keeps serving reads.
- **Leader change.** The controller picks the new leader from the in-sync set (so it has every committed record) and bumps the shard's leader epoch. Every record carries the epoch it was written in.
- **Truncation.** A replica coming back asks the leader where its last epoch ended (Kafka's OffsetForLeaderEpoch, KIP-101) and truncates anything after it before fetching. A record that was never committed is dropped, never merged. Its writer was never told it committed.
- **Fencing.** Every write and fetch carries the leader epoch it expects; an older epoch is refused (`stale-epoch`), as today.
- **Moving a replica** (scale-out, scale-in, rebalance): add the new replica as a follower, let it catch up from a snapshot and the log, let it join the in-sync set, then remove the old one. There is no orphan, shed, latch or teacher: a move is a follower catching up.
- **Two members.** With a witness voting in the metadata log, either member's crash heals: the controller shrinks the in-sync set to the survivor. `minInSync: 1` is then the explicit choice that a lost disk can lose committed writes, the trade every two-copy system makes.

**Cursors across splits.** A split is a metadata record naming the parent shard, the offset and the two children. A cursor `(shard 7, offset 900)` past the split resolves to the children at their start.

### 4.3 L2: fold and ops

**The record header** (five fields beyond data's delta):

| Field | Why |
|---|---|
| leader epoch | fencing and truncation (4.2) |
| shard offset | replication, fsync, retention, cursors |
| partition sequence | a row's version; user cursors; `if: { version }` |
| leader time `t` | TTLs, leases, `ctx.now()` on the leader; monotonic per shard (`max(previous, clock)`), carried across leader changes |
| attempt id (issuer, call id) | dedup of retried writes, carried across leader changes because it is in the log |

A batch shares one header; records inside it differ only by partition and sequence.

**Ops the leader evaluates.** A write may carry a condition and may be an op; the leader evaluates both against its state at that point in its log and appends only the result, so followers, subscribers and replays apply plain values and never re-run anything.

| Kind | Forms | Refusal |
|---|---|---|
| conditions | `if: { absent }`, `{ present }`, `{ version: n }`, `{ equals: v }`, `{ fence: token }`, `{ expired: 'lease' }` | `conflict`, with the current version |
| ops | `incr(n, { min, max })`, `push(v)`, `merge(obj)`, `max(v)`, `min(v)`, `touch` | `conflict` when a bound fails |
| batch | many records to one partition, all or none | the first refusal |

**Dedup comes before conditions.** A retried write whose first attempt committed gets the first attempt's answer, including its refusal, not a fresh judgement. Without this, a retried winning claim would be told "already claimed" by itself. The dedup window (attempt id → outcome) is part of the shard state, so a new leader has it.

**Row retention** (3.1) runs on the leader's tick: rows past their `ttl`, over `max`, or matching `where` are removed by records with a reason.

**The fold** is data's: records apply through the hot lane in offset order. Followers, clients and replays run the same fold. There is no LWW comparison anywhere in the fold.

### 4.4 L3: flow

One verb serves followers, clients, relays, consumers and the viewer: **subscribe** with a selector, a mode and a cursor.

| Part | Values |
|---|---|
| selector | `resource` (all of it), `partitions: [...]` (a follow set), `prefix`, `view` (a server-side view id, 4.5), `shard` (followers and relays only) |
| mode | `state`: a snapshot, then deltas; may conflate a slow reader to the latest value per cell. `log`: every record from the cursor; never conflates; a cursor past retention is refused `expired` with the earliest available |
| cursor | `{ shard: offset }` or, for one partition, a sequence number; `'latest'`, `'earliest'` |

- **Credits.** A subscriber grants credit in bytes; the server sends while it has credit. A `state` subscriber that falls behind is conflated; a `log` subscriber that falls behind is paused, and resumes from its cursor. Nothing is dropped silently and nothing buffers without bound. (v4: drop-oldest, then anti-entropy heals.)
- **Who serves.** Any replica of the shard, up to its high-water mark. A member serving a client a partition it does not replicate subscribes upstream itself: that makes it a relay for that partition.
- **Routing.** A per-shard index from partition to subscribers: a record costs one lookup and one write per matching subscriber, encoded once.
- **Follow sets** are the `partitions` selector, changed live with `follow`/`unfollow` frames. They are the near cache's mechanism (3.3) and the webserver's (the rooms case).
- **Failover.** A subscriber whose server goes away resubscribes elsewhere with its cursor. In `log` mode it misses nothing; in `state` mode it gets the deltas since its cursor or, past retention, a fresh snapshot.

### 4.5 L4: surface

- **`fero(name, opts)`** returns the resource as today: `data` (a live object over what this process holds), `methods`, `cluster`, `snapshot`, `destroy`. New: `follow(keys)`, `read({ from })` (log mode), `set`/`update`/`remove`/`incr`/`push` with `{ if, ttl, confirm }`.
- **Views** are data's operators, incremental. A view returned from a method is a server-side view: the serving member maintains it and streams it (v4's `09-live`). Views with the same declarative shape are shared. A `group` bucket can be streamed (data change: `connect()` on an operator child).
- **Methods** run on the member the caller reached, as today. Their writes carry conditions and ops to the leaders. **Call keys:** a call with a key runs once; the key and its result are a row in `#calls` with a TTL, claimed with `if: { absent }` before the handler runs (closes v4's re-execution warning; "fero test" piece 3).
- **Rules.** `validation` stays (a schema check where a write enters). New: `rules.write(peer, record, current)`, evaluated by the leader with the current row, so a rule can depend on state ("only the booker may cancel", "stock never below 0"); and `rules.read(peer, partition)`, evaluated where a subscription is served.
- **Identity.** A client presents a token signed by the cluster (claims: subject, roles, expiry). `ctx.peer` carries the claims. The shared client key (`secret.client`) stays as the simplest token.
- **Config**, in three scopes:

| Scope | Lives in | Keys | Changes |
|---|---|---|---|
| node | the config cascade, as today | `uuid`, `dir`, `listen`, `advertise`, `hosts`, `secret`, role, memory | restart that node |
| cluster | the metadata log | voters, witness, default `replicas`, `minInSync`, `lag.ms` | online |
| resource | the metadata log, from the first `fero(name, opts)` or `fero.define` | `shards`, `replicas`, `partition`, `history`, `rows`, `durability`, `validation`, `rules`, `methods`, `load` | online; keys that carry code are allowed by hash, and during a roll both the old and the new hash are allowed |

  This replaces the cluster contract's refusal at the door (V4-60, DESIGN-DOOR §4): a version whose hash is not allowed is refused with the hash it needs, and a deploy adds the new hash before the roll and removes the old after.
- **Worlds** (fero test): a bound world resolves names to stand-ins, makes server markers into solo nodes, and supplies `now` and `id`. Unchanged from the "fero test" design; v5 adds that a solo node is the same L0-L2 code with one replica.

### 4.6 L5: libraries and adapters

Built only from L4 calls. Each is a file with its own tests, and none adds a wire verb: the queue, consumer groups, locks, presence, rate limits and loaders of section 5; a RESP gateway (Redis clients), a Kafka-protocol gateway, a WebSocket gateway for browsers; the `fero` CLI (`run`, `test`, `deploy`, `ls`, `debug`).

### 4.7 The whole protocol

Eight wire verbs, each owned by one layer:

| Verb | Layer | Purpose |
|---|---|---|
| `HELLO` / `DOOR` | L0/L1 | identity, proof, role, protocol version (v4's) |
| `VOTE` / `APPEND` (metadata only) | L1 | Raft for the metadata log |
| `WRITE` / `WRITE-ACK` | L1/L2 | a batch of writes to a shard leader; the answer: offsets and sequences, or a refusal with a reason |
| `FETCH` / `DATA` | L1 | followers pulling a shard log; the answer carries records and the high-water mark |
| `SUB` / `SNAP` / `DELTA` / `CREDIT` / `END` | L3 | subscriptions for everyone else |
| `FOLLOW` / `UNFOLLOW` | L3 | change a subscription's follow set |
| `CALL` / `RESULT` / `SUBREC` | L4 | methods, as v4 |
| `PING` / `DIAG` | L0 | liveness; the debugger's channel, as v4 |

Everything else in sections 3 and 5 is records and L4/L5 code.

## 5. How each pattern is built

### 5.1 The table

| Pattern | Built from | Layer |
|---|---|---|
| live shared state | a resource, `rows: true` | L4 |
| cache with expiry, session store | `rows: { ttl, max }`, `touch` | L2 |
| near cache, client data sync | `cache: { memory }`, follow sets | L3 |
| read-through cache | `load` | L4 |
| websocket fan-out by room | follow sets on relays; rooms as partitions | L3 |
| pub/sub | `history: 0, rows: false, durability: 'none'` | L2/L3 |
| stream, replay | `history: '7d'`, `read({ from })` | L1/L3 |
| consumer groups | the groups library (5.3) | L5 |
| work queue | the queue library (5.3) | L5 |
| locks, leader election | the locks library (5.3) | L5 |
| counters, rate limits | `incr` with bounds; rows with `ttl` per window | L2 |
| leaderboards, live aggregates | views; across shards, mergeable partials (phase 5) | L4 |
| presence | `rows: { while: 'session' }` | L2 |
| invariants (stock, balances) | conditions, `rules.write`, or one partition | L2/L4 |
| transactions across partitions | locks with fencing plus an intent row (5.3) | L5 |
| event sourcing, CQRS | facts as rows or `history: 'all'`; views as projections | L2/L4 |
| derived resources | a method or a client that reads one resource's log and writes another, its cursor stored with a fence | L5 |
| tapes, forks, replays (fero test) | section 6 | L1/L4 |

### 5.2 One example in full: the websocket rooms

```ts
// the resource: a room is a partition, a message is a row in it
const chat = await fero('chat', { partition: (k) => k.split('/')[0], history: '1d' })

// a webserver: a client that follows only its sockets' rooms, and holds at most 200 MB
const web = await fero('chat', { cache: { memory: '200MB' } })
socket.on('join', (room) => web.follow(room).tap((r) => socket.send(r)))   // snapshot, then deltas
socket.on('say', (room, text) => web.data[`${room}/${fero.id()}`] = { text, at: fero.now() })
```

A message is appended once to its room's shard, replicated to the shard's in-sync set, and delivered by each serving member to the webservers that follow that room, encoded once. A webserver never receives a room it does not follow. A webserver that reconnects passes its cursor and misses nothing within a day.

### 5.3 The libraries

- **Queue.** A message is a row: `{ body, lease: null, deliveries: 0 }`. `take` claims one with `if: { expired: 'lease' }` and sets `lease = { by, until: now + visibility }` plus `incr deliveries`, in one batch. `ack` removes the row. A lease that runs out makes the row claimable again; past `deliveries` it moves to `${name}.dead`. FIFO per partition; a queue that must be FIFO overall uses one partition.
- **Consumer groups.** Members of a group are rows with leases in `#groups`; the assignment of shards to members is a pure function of the live members and the generation; offsets are rows written with `if: { fence: generation }`, so a zombie consumer cannot commit.
- **Locks.** A lock is a row in `#locks`, claimed with `if: { absent }` or `{ expired: 'lease' }`; its token is the claim's partition sequence. Writes it protects carry `if: { fence: token }`, and each partition's leader remembers the highest token it has seen. A lock records the offsets its holder wrote at, so the next holder can wait until its own copy has them before it reads.
- **Transactions across partitions.** Take the locks in key order, write an intent row (`{ steps, done: [] }`), apply each step with a fence, mark it done, remove the intent. A later holder that finds an intent finishes it. Single-partition work needs none of this: one batch with a condition.
- **Presence.** A session is a row in `#sessions` with a lease the client renews. Rows written `while: 'session'` carry the session id; each shard leader subscribes to `#sessions` and removes a lapsed session's rows.

## 6. fero test and fero deploy on v5

### 6.1 fero deploy: the fourteen needs

| # | Need (from "fero deploy: the journey") | On v5 |
|---|---|---|
| 1 | the `fero` command and the npm build | L5; unchanged by the kernel |
| 2 | `file`, `scale`, `size` from the file | node scope config (4.5) |
| 3 | a box directory that lists names, runs and folders | unchanged; names carry project and run |
| 4 | a caught-up signal | exact: a member is caught up when it is in the in-sync set of every shard it replicates; `cluster.me.caughtUp` |
| 5 | a full restart, and restart after one-by-one stops | a stop is not a leave (4.2): any order of stops and starts comes back |
| 6 | a joining copy skips its seed | a seed is applied once, when the controller creates the resource, and recorded there; a joiner fetches shards |
| 7 | listen and advertised addresses apart, bracketed IPv6 | member record holds both (4.2) |
| 8 | TLS for clients, one public address | L0 transport; clients route through any member |
| 9 | a client leaves a server whose writes are shut | a client's writes go to shard leaders through its server; a server that cannot reach a leader says so and the client moves |
| 10 | the supervisor sets the secret over the call | node config precedence (a supervisor layer above the call) |
| 11 | a new version's contract reported before it joins | the allowed-hash list (4.5): `fero deploy` adds the hash first, so the check is a lookup |
| 12 | no deleted row comes back | structural: removes are records in one log per shard; there are no tombstones to collect and no other lanes to resurrect from |
| 13 | refuse writes with a reason while reads go on | the resource's write gate in the metadata log (unpaid), and a member memory bound (near full) |
| 14 | group commit | L0 (4.1) |
| later | rolling a contract change; a reformat that rolls | allowed hashes; hashes taken over normalised source |
| later | state larger than memory | L0 on-disk state store, phase 5 |

**The roll on v5.** Stop copy 1 (its shards' leaders move within one lag window; clients move), restart it on the new files, wait for `caughtUp`, repeat. Restart-all: stop all, start all; voters and shards are in each disk's metadata log.

### 6.2 fero test: the eleven pieces

| # | Piece | On v5 |
|---|---|---|
| 1 | the world in `fero()` | L4, unchanged; a solo node is L0-L2 with one replica and the in-process transport |
| 2 | the clock and ids | leader time `t` (4.3) under the world's clock; `fero.id()` from the world's seed |
| 3 | input keys | call keys in `#calls` (4.5) |
| 4 | `fero test` as a verb | L5 |
| 5 | components ship their stand-ins | unchanged |
| 6 | the test block in the viewer | the capture now carries offsets, so inputs, records and asks line up by position |
| 7 | the spec and the layout | unchanged |
| 8 | the store (forks, versions, proposals) | records in system resources, as designed; **a fork's rows are a copy-on-write snapshot** of each shard at an offset (segments are immutable, so a fork costs a pointer) |
| 9 | the tape at the live edge | **a tape is a resource with `history: '14d', rows: false`**: the edge appends each input and answer; replay reads it with `read({ from })` |
| 10 | the ai component and `fero change` | unchanged |
| 11 | app steps in the simulator, agents | methods run as sim steps against L0-L2 in the simulator; the same kernel bytes |

## 7. The backtest, summarised

*To be filled from [V5-BACKTEST.md](V5-BACKTEST.md).*

## 8. Performance, layer by layer

Each row is a target with the technique that reaches it and the bar it must beat. Each becomes a perf pin, measured with the competitor's own benchmark tool on the same box, under fero's never-widen rule.

| Layer | Measure | Target | How | Bar |
|---|---|---|---|---|
| L0 | persisted appends per member | ≥ 200k records/s on NVMe | group commit across shards, one `fdatasync` per ≤ 1 ms batch, `writev` | Kafka/Redpanda per broker; today 250/s |
| L0 | snapshot install | ≥ 500 MB/s | streamed segments, no decode | — |
| L1 | replicated appends per leader core | ≥ 1M records/s (100-byte records, batched) | pipelined fetch, per-connection batches across shards, no decode on followers | Redpanda; today 14k/s through the API, 73k/s raw |
| L1 | commit latency, LAN | p50 < 0.3 ms, p99 < 1 ms (no fsync); p99 < 3 ms with fsync | long-poll fetch on persistent links, fsync in parallel with replication | Kafka acks=all; Redpanda |
| L1 | leader failover | < 1 s to writable | controller-driven, in-sync set already has everything | Kafka KRaft; v4 eviction about 4 s |
| L2 | fold per record | < 0.2 µs | header-only decode, cell writes into a compact store, no per-record objects | — |
| L2 | conditional op at the leader | < 1 µs | state lookup + compare in the append path | Redis INCR server time |
| L3 | fan-out per relay core | ≥ 2M deliveries/s | per-shard subscriber index, encode once, `writev` per socket | NATS core |
| L3 | subscribers per relay | ≥ 100k sockets | credit flow, conflation, no per-subscriber timers | Centrifugo, Phoenix |
| L4 | read of a held row | < 100 ns | in-process object, lazy materialisation | Redis GET: a network round trip |
| L4 | method call, caller on the leader | < 5 µs | in-process | Redis Lua over the network |
| L4 | view update per change | O(change), < 1 µs per affected view | data's incremental operators; shared declarative views; `group` routing | — |

### 8.1 What carries the targets

- **Batches of bytes end to end.** Writes, replication, fsync, fan-out and catch-up move encoded batches. Only the fold decodes, and only the header plus the cells it touches.
- **No work per view per record.** Predicate subscriptions route through shared `group` indexes, so 5,000 room views cost one hash lookup per record, not 5,000 predicate calls (measured on v4 last week: 5,000 `filter` views cost 450 to 510 µs per write; one `group` cost 10 to 20 µs).
- **Nothing on a timer that scales with data.** v4's compaction rescans every large lane on every heartbeat (43% of CPU in a two-member run; a separate task is queued). In v5, retention drops whole segments and snapshots are incremental.
- **Group commit** (STATUS: 250 persisted writes/s today).

### 8.2 Where fero can win outright, and where it should match

- **Win:** reads of held rows (in process, against a network round trip), ops where the caller is the leader, fan-out that carries state (a late joiner gets the room's current rows, then live deltas, in one subscription), and one system to run instead of three.
- **Match:** raw log bytes per disk and per NIC, which bound every system equally.

### 8.3 Measuring

A pinned quiet runner (STATUS already wants one). memtier for the RESP gateway against Redis and Valkey; `nats bench` against NATS; the OpenMessaging Benchmark against Kafka and Redpanda; etcd's benchmark for the locks library; fero's own pins for reads, views and fan-out. Results go into `tools/perf/results` like today's baseline.

### 8.4 JavaScript first, native next

L0-L2 are a deterministic machine behind one interface (events in, effects out). Build them in TypeScript first, under the simulator, until the semantics stop moving; then implement the same interface in Rust (N-API for Node, WASM for browsers, a C ABI for other languages) and run both under the same seeds, comparing effects byte for byte. L3 fan-out and L0 io move with them. L4 stays JavaScript: views, methods and rules are user code. This is how the per-core targets above are reached: the JavaScript kernel should reach the L4 targets and a tenth of the L0-L1 ones.

## 9. Measured today

*Filled in below as the measurements finish.*

## 10. Keeping development fast

### 10.1 What slowed v4 (measured on `main`, October 2026)

| Measure | Value |
|---|---|
| commits in October | about 700: fix 225, docs 215, test 156, feat 51, perf 20 |
| lines added in October | tests and sim +31.0k · site +37.7k · docs +12.5k · kernel, api, shell +10.2k |
| the tree today | 9.1k lines of kernel/api/shell code, 6.9k lines of comments in them (43%), 38.5k lines of tests and sim, 15.6k lines of docs |
| open bugs in STATUS | 15 (5 Oct) → 29 (10 Oct) → 40 (15 Oct) → 34 (22 Oct) |
| DECISIONS.md | 1,338 lines (5 Oct) → 2,995 (22 Oct) |
| review rounds | lanes with four, seven and eight rounds are recorded |
| full battery | BATTERY_TIME |

Bugs were found about as fast as they were fixed. Reading the catalogs (section 7), the open ones sit where two or more mechanisms meet: tombstone GC and compaction and a short lane; a shed and a paused link and a resync; a leave and a stalled survivor and the knock window; a tap's write and the owner's own commit. That is the cost of the design, not of the people or the process.

1. **Too many mechanisms that interact.** Lanes, Lamport stamps, digests and synced-gating, tombstone GC, the compaction frontier, ballots with held members and the knock window, ring forwarding with dedup windows, and for scoped clusters holders, orphans, sheds, latches, teachers, floors, FEED words and drains. Each new one must be proven against all the others, so each costs more than the last.
2. **Novel protocols.** The pp floor law, the one-teacher latch, FEED words, the knock window and held members have no literature, so every property is discovered by sweeps and reviews.
3. **Proof by discovery.** Sweeps and reviews run after the code exists; each round finds the next case; a lane can run eight rounds.
4. **Many documents per change.** A fix touches code comments (43% of lines), DECISIONS, STATUS, README, sometimes HISTORY and the site's claims check.
5. **One kernel-wide golden trajectory.** Any rule change "moves trajectories" and needs its own decision before it lands (STATUS, the short-lane fix).

### 10.2 What keeps v5 fast

1. **Fewer mechanisms, all published.** L1 is Raft for the metadata log and Kafka's replication for shards: published algorithms, public TLA+ specifications (Ongaro's Raft; Gustafson's model of Kafka replication), and a decade of Jepsen reports. Gone: lanes, stamps, digests, tombstones, compaction frontiers, orphans, sheds, latches, teachers, floors, FEED words. A **mechanism list** sits at the top of each layer's doc; adding one means naming what it replaces or why it cannot be a library.
2. **Model-check before code.** L1 is specified in TLA+ starting from those two specs and checked exhaustively at small sizes (3 voters, 2 shards, crashes, partitions, restarts). The simulator then checks the code against the spec: each seeded trajectory's metadata and shard events are replayed through the spec (trace validation). Cases are found in an afternoon of model checking, not in review round eight.
3. **Layer contracts.** Each layer has an interface, an invariant list and a suite that runs in under 30 seconds. A change inside a layer runs that layer's suite and the contract suites of its neighbours; the full battery runs in CI. Golden trajectories are per layer, so a change in L3 never moves an L1 trajectory.
4. **One current doc per layer.** Edited in place to say what is true now. DECISIONS records stay, at ten lines or fewer, linking to the commit. STATUS is one line per item. Comments say why, not what happened, at about a fifth of the lines. The site's claims are generated from tests, not checked against prose.
5. **Bounded lanes.** A lane has acceptance criteria written before it starts: the layer invariants it must keep, the tests it adds, the perf pins it must hold. One adversarial review, scoped to those. A finding outside the lane's scope becomes a one-line STATUS item with a failing seed, and does not extend the lane.
6. **Bug intake.** Every bug arrives as a failing seed or test, tagged with its layer and the invariant it breaks. The preferred fix removes a mechanism.

## 11. The plan

Each phase ends on a test, not a date.

| Phase | Builds | Done when |
|---|---|---|
| 0. Decide | the answers in section 12; v4 frozen for features (deploy-blocking fixes only) | the decisions are recorded |
| 1. Specify | L1 in TLA+; the L0-L4 interfaces; the invariant list per layer; the backtest rows as test titles | the model checker is green for 3 voters, 2 shards, crashes, partitions and restarts; every backtest row has a named test |
| 2. Kernel | L0, L1 and L2 in TypeScript under v4's simulator (reused) with v5 monitors | 1,000-seed sweeps green; kill -9 of a whole cluster restores every `persisted` write; trace validation against the spec; the L0-L2 TypeScript perf pins |
| 3. Surface | L3 (subscriptions, follow sets, relays, clients) and L4 (v4's api ported: data binding, methods, door, config, rules, identity) | examples 01 to 44 pass unchanged except where v5 changes a documented rule; every backtest row's test passes or is marked not applicable with the reason |
| 4. Platform | worlds, call keys, tapes, forks, caught-up, roll and restart-all, TLS, the npm build | the café from "fero test" runs on v5; milestones 1 and 2 of "fero deploy" run against a local three-copy cluster |
| 5. Scale and speed | the Rust L0-L2 behind the same interface with differential runs; shard splits; state larger than memory; mergeable views across shards; the libraries; the RESP, Kafka and WebSocket gateways | every row of section 8 is a green pin against the named competitor on the pinned runner |

**What carries over from v4.** The codec and frames (V3-8), the simulator, the shrinker and the debugger (captures gain offsets), the journal (V3-2), the door, the directory, the config cascade, the data engine, the method plane, the confirm ladder's names, the examples and their checks (the acceptance suite), the perf harness and its rules.

**What is replaced.** `kernel/log.ts`, `streams.ts`, `scope.ts`, most of `write.ts`, `membership.ts` (by Raft over the metadata log), `confirm.ts` (by high-water marks and in-sync sets), the FEED words, digests, tombstone GC and compaction.

## 12. Decisions for you

Reply "defaults" to take every pick, or name a change ("3b").

1. **Replace v4's kernel.** a) v5's kernel under v4's api and tools, v4 frozen for features (my pick). b) Evolve v4 one mechanism at a time.
2. **Shard replication.** a) Kafka's protocol under a Raft controller: one Raft group, in-sync sets, works with two copies and a witness (my pick). b) Raft per shard (Redpanda, CockroachDB): no controller, but thousands of Raft groups, and two copies cannot survive a crash.
3. **Language.** a) TypeScript first, Rust behind the same interface in phase 5 (my pick). b) Rust from the start: faster sooner, slower to change while the semantics move.
4. **When a write shows.** a) When the in-sync set holds it (v5): a little later than v4's owner stamp, and never undone (my pick). b) At the leader's append, with a rollback when a leader change truncates it.
5. **Defaults.** a) 16 shards, 3 replicas, `minInSync` 2, `durability: 'committed'`, `history: 0`, `rows: true` (my pick). b) Name your own.
6. **The witness.** a) In phase 2, as a metadata-only voter (my pick). b) Later.
7. **The model checker.** a) TLA+, starting from the public Raft and Kafka specifications (my pick). b) Quint or P.
8. **The development rules of 10.2.** a) Adopt them for v5 from phase 1 (my pick). b) Adopt them for v4 too, now.

## 13. The review

*Filled in after the review.*
