# IDEAS — open questions & future work

The single ledger of what's **not yet done** across L0 (transport), L1 (log/view)
and L2 (resource). Settled decisions and the rationale behind the current shape
live in [DECISIONS.md](DECISIONS.md); this file is *only* open work — the place to
look for what needs attention.

Grouped by **workstream** (a theme usually spans several modules) rather than by
file, so cross-cutting work reads as one piece instead of N scattered notes.
Priority: **[P1]** soon · **[P2]** when it matters · **[P3]** nice-to-have. Module
tags in `(parens)`.

**Convention:** when a workstream lands, write its decision record in
[DECISIONS.md](DECISIONS.md) and delete (or trim to the open remainder) its entry
here — don't let "done" notes accumulate in this file.

---

## Open questions

Threads that need attention — some need a design call, others are settled in
plan.md §11 (noted inline) with only an implementation tail left. Not a 1:1 map to
§11.

1. **Commit-ack / flush-on-return.** *Design resolved (plan §11.1):* method-call
   writes are await-or-not (`await methods.update(...)` waits for the ack), plain
   assignments (`data.x = y`) are inherently fire-and-forget — never `await data`
   (it collides with the snapshot-read thenable). *Open:* implement flush-on-return
   (a handler's `return` is post-commit because pending writes are flushed, not
   because each assignment blocked) and decide whether to add an explicit barrier
   handle (`await commit()` / `await data.flush()`). (resource)
2. **Re-subscription / re-dispatch on failover.** When a client's connected server
   drops, where does it re-subscribe and re-route the call, and how is the
   projection re-bound? (plan §11.2) (resource)
3. **Cross-partition ordering in a handler.** No atomicity across partitions —
   document the semantics rather than paper over them. (plan §11.3) (resource)
4. **AsyncIterator-returning methods.** Is a third consumption mode needed beyond
   Promise (snapshot) and ViewProxy (live)? (plan §11.4) (resource)
5. **`cluster.me` surface.** *Design resolved (plan §11.5):* `me` is available as
   `{host, port}` during the `fero(...)` await, before any peer connects. *Open:*
   expose it as a derived `cluster.me`/uuid row on the `cluster` ViewProxy (see the
   Surfaces workstream). (transport, resource)
6. **Assignment ↔ `methods.update` parity.** `data.x = y` goes straight through the
   sink today, bypassing the `update` method, so a custom `update` can't intercept
   plain assignments. Route assignments through the method (for an auth/validation
   hook) or keep them separate? A genuinely-open design point, not in plan §11
   (it sits alongside the §11.1 write-paths). (resource)
7. **Owner-routing: fan-out reduction & failover** (partitioned routing). **F1**
   (owner-routed writes) and **V** (view-synchronous membership — stable ownership
   per epoch) have landed ([DECISIONS F1](DECISIONS.md), [V](DECISIONS.md)). **F2/F3
   investigated and DEFERRED** ([DECISIONS F2](DECISIONS.md)): R-way fan-out reduction
   requires partitioned holding (routed/async non-local reads — it breaks synchronous
   `data.x`), and per-partition sequencing under full broadcast is a *regression* at
   ownership handoffs (the current per-origin model is more robust). So this is now a
   **partitioned-holding** milestone, gated on a deliberate decision to make non-local
   reads async. When taken: **F2** — per-partition sequencing + R-way replication
   (`mesh.replicate` to the R owners; dedup + catch-up keyed *per partition* via
   `Log.heads()`/`diff()`) — and **F3** — owner failover / version continuity on
   handoff (the next clockwise replica, already caught up, continues the partition
   counter, behind a drained view-change barrier). F2 also picks up the V
   deferrals: the stronger **reject-stale-epoch-from-an-evicted-node** fence (needs
   the per-partition owner lineage + a uuid↔address map), the **commit-ack drain**
   (PREPARE-ACK high-water vectors; also [open question 1]), the
   **outbox-flush-before-ring-rebuild** (a no-op under full broadcast, matters once
   replication is ring-routed), and preserving a **buffered write's attempt-epoch**
   on flush (today it flushes under the current epoch). The gap-tolerant-dedup
   alternative from [DECISIONS F](DECISIONS.md) stays parked unless F2's per-partition
   sequencing proves insufficient. (resource, transport, log)

   Membership hardening still open (from the V review, deferred): a dedicated
   **two-established-cluster merge** test (works via lowest-coordinator + epoch
   ordering, but only chaos-adjacent tested); **min-cluster-size** behaviour — a
   sub-quorum remnant stays read-only (CP); a force-to-solo (AP) degrade is
   deliberately not offered; **incarnation numbers** for flapper fencing beyond the
   stability debounce. (resource, transport)
8. **Value codec.** Adopt a CBOR / `data`-owned binary value form behind the
   `encodeValue`/`decodeValue` seam? `JSON.parse` of object values is ~85% of decode
   cost (~2.4ms vs ~0.35ms lazy-scan for 1000 object records) — decide with a perf
   number, not a guess. (transport/message)
9. **Hash function.** Lock in djb2-accumulate + fmix32, or switch to wy/xxhash32
   after a `dht.perf.ts` bake-off? The fmix32 finalizer is load-bearing (without it
   an address's vnodes cluster). (transport/dht)
10. **Conflict-merge model.** Stay LWW-by-Lamport, or adopt CRDT / OR-set
    (intent-preserving merge vs simplicity)? (resource, log)

---

## Workstreams

### Identity, dedup & connection hygiene — [P1] (transport: peer, peers, handshake, index)
The biggest correctness cluster — all four modules touch one underlying gap: there
is no stable peer identity until the handshake.
- **Re-key inbound peers.** `accept()` keys a peer by the socket's *ephemeral*
  `remoteAddress:remotePort`, which can't be dialed back and mislabels inbound
  servers as role `client` (polluting `cluster.peers`). The handshake learns the
  real listening host:port + uuid — re-key the row/connection from it.
- **Dedup duplicate connections by uuid (connected-wins).** Each server pair forms
  two TCP connections (A→B and B→A) with no dedup; if two nodes dial at once, two
  sockets exist for one logical pair. Collapse to one bidirectional conn
  post-handshake.
- **Prune dead rows.** Rows persist forever — a peer that gives up leaves a
  `disconnected` row (slow leak). `forget(address)`/TTL wired to Peer destroy; prune
  ephemeral inbound rows on close.
- **uuid self-identity + self-reject.** `me` is a single host:port string; a
  multi-interface node or a dial+accept race needs uuid identity to reject self and
  dedup.

### Zero-copy send path — [P1] (transport: message, peer)
The design's headline send-side win; v1 uses the simpler `encodeFrame`-per-tick path.
- **Streaming `Outbox` encoder.** Append records within a tick, write them into a
  *reused, preallocated* per-peer buffer, back-patch `count`/`bodyLen` on flush,
  `write(sub.subarray)` — eliminating the per-flush `Writer` + result `Buffer`
  allocation.
- **Backpressure.** `socket.write()`'s return value is ignored; on `false` stop
  draining the outbox and resume on `'drain'`, else a slow consumer causes unbounded
  kernel buffering.
- **Bounded outbox.** Records queued while disconnected grow without limit — cap
  (drop-oldest, or push backpressure to the `data` source) so a long partition can't
  OOM the sender.

### Routing hot path — [P1] (transport: message, dht, index)
Everything on the per-routed-record path.
- **`RecordView.key0` / `partitionKey` accessor.** The DHT routes on `key[0]` only;
  the current `key` getter decodes the whole `string[]`. Decode just the first
  segment.
- **Hot-key hash memo.** `dht.owner()` re-hashes the key every call; routing keys
  (`user42`, …) repeat heavily — a small key→hash memo cuts the hash from the hottest
  path. Pairs with index's per-send `partitionOf` re-hash.
- **Hash bake-off** → [open question 9].
- **[P3] Self-delivery fast-path** for `owner === me` (a self-routed write still
  allocates the record).
- **[P3] Incremental `track()`** (parse the single insert/remove for O(1)
  bookkeeping vs re-diffing the whole membership set) / **rebuild without the
  `[hash,owner][]` tuple array** (sort an index permutation into typed arrays).

### Bounded memory & compaction — [P1] (log, resource)
Several unbounded structures interlock and share one compaction pass.
- **Log compaction.** Segments grow forever — collapse to latest-value-per-key
  and/or snapshot+truncate so a high-churn partition doesn't exhaust memory.
- **WAL compaction.** The persistence WAL grows unbounded ([DECISIONS C](DECISIONS.md))
  — snapshot+truncate.
- **`versions`/`seen` maps** grow unbounded ([DECISIONS A](DECISIONS.md)) — tie to the
  same pass.
- **[P3]** `log()` storage-adapter / compaction-policy options; `heads()` allocates
  per call (cache + invalidate on append).

### Store encoded records in the log — [P2] (transport/message, log, resource)
The structural perf redesign [DECISIONS G](DECISIONS.md) identified.
- Inbound records are retained as lazy `RecordView`s pinning whole frame buffers (one
  retained record pins a whole frame). Store bytes / materialize on append: bytes are
  immutable (no `sclone` needed for the log) and catch-up re-ships them verbatim
  (zero re-encode).
- **Gate log retention** behind a `durable`/`catchup` config so a throughput-only
  deployment skips the double materialization (proxy + log).

### Catch-up & anti-entropy hardening — [P2] (log, resource)
Builds on [DECISIONS B](DECISIONS.md).
- **Merkle/range digest** to cut the comparison for huge logs (today's digest is
  per-origin-coarse).
- **Stream the diff.** `diff()`/`recordsSince` builds one large array; stream it
  (generator / chunked frames) so a fresh join doesn't spike sender memory.
- **Asymmetric reachability.** Catch-up ships over the *dialed* connection only —
  verify behaviour when ONLY an inbound connection exists.
- **HLC/wall-clock** refinement of LWW order ([DECISIONS A](DECISIONS.md)).

### Partitioned ownership & routing — [P2] (transport: dht, index; log; resource)
The L2 refinement that turns full replication into the routed/projected model
(plan §5–6). Owner-routed writes (F1) + view-synchronous membership (V) have landed,
so the ring is driven by the committed view and is stable within an epoch — ring
churn / "connected SERVERS only" / transient-misrouting are resolved by V. Remaining:
- **Partitioned holding** (a node materializes only its owned partitions, routes the
  rest) — gated on F2 [open question 7] and on reads being allowed to go async/routed
  (breaks synchronous `data.x` today).
- **`replicate()` to R owners** (F2); `owners()` distinct-R correctness under churn.
- **[P3] Vnode count vs cluster size** (200/peer → 20k+ ring entries at 100s of
  peers; revisit count or ring structure — jump/HRW in parked alternatives).

### Failover & re-dispatch — [P2] (resource)
Both halves of [open question 2], from [DECISIONS D + E](DECISIONS.md).
- RPC re-dispatch when the connected server fails (today: first connected server, no
  retry/re-route).
- Subscription re-subscribe elsewhere when the connected server drops.

### Dial scheduling & discovery — [P1] (transport: peers, retries, discovery)
- **[P1] `multicast.ts`** — LAN zero-config UDP multicast discovery (plan §9), not
  built; deferred because WSL2/cloud drop multicast (static/broker is the default).
  Must emit the SAME candidate `insert` records into a `$()` proxy the pool taps
  identically; CI-gated / LAN-opt-in.
- **Reactive dial loop + connection cap.** v1 dials immediately on `add()` with no
  cap; dial only while `connected + inflight < max`, with pool-pressure-scaled jitter
  to avoid a thundering herd on a big join.
- **Merge multiple discovery sources** — `discovery: [multicast(…), static(…)]` into
  one candidate stream.
- **Broker as cloud default** rendezvous (`#broker @ host:port`) when there's no host
  list — env-var or config.
- **Dead-candidate backoff** — a permanently-down static candidate is redialed to the
  retry cap; coordinate with the dial cap so a big static list doesn't storm.
- **[P3]** Decorrelated jitter (AWS-style `min(cap, random(base, prev*3))`) +
  per-pool retry budget — drop in if a thundering-herd reconnect shows up in chaos.

### Handshake / membership protocol — [P2] (transport/handshake)
(Identity/dedup lives in the first workstream.)
- **Commit on DONE, not INIT.** `learn()` merges gossiped peers as soon as INIT
  arrives; a mid-handshake drop leaves a half-merged relationship.
- **Guards & negotiation.** Drop INIT from an already-connected peer; refuse clients
  before `ready`; carry a protocol/version byte in INIT.

### Method / RPC semantics — [P2] (resource; transport/peer)
From [DECISIONS D + E](DECISIONS.md) and plan §5–6.
- **Commit-ack** primitive [open question 1]; **cross-partition atomicity**
  [open question 3].
- **Per-client projection re-binding** on auth change (plan §6.2): re-invoke `read`,
  diff, ship the delta; v1 runs `read` once at subscribe (a custom `read` returning
  `data.filter(s => visible(s, peer))` gives a per-client view, just not re-bound).
- **Client-side `'move'` deltas** for ordered projections (sort/top) — `applyRecord`
  ignores `move`, so unordered projections converge but ordered ones don't.
- **`context.methods` auth identity** (plan §6.1): preserve the caller's auth across
  method-to-method calls (v1 reuses the same `context`, no per-call peer/auth); a
  remote handler's `context.methods` runs locally.
- **[P3]** Default `insert` nested key/`at` semantics (only top-level handled; nested
  works via direct assignment). `send()` returning a flush/ack handle to back
  await-or-not write semantics.

### Value codec & wire evolution — [P2] (transport/message)
Gated on [open question 8].
- **Buffer / typed-array values** don't round-trip through JSON
  (`{type:'Buffer',data:[…]}` isn't revived); **nested NaN/Infinity** become `null`
  (top-level survives via f64). A CBOR seam fixes both natively; until then document
  the plain-JSON limitation or add a reviver.
- **Expose varint/zigzag primitives** as a shared `codec` seam (handshake heads/diffs
  and dht want them; module-private today).
- **[P3] Frame verb dispatch hook** — a `dispatch[verb]` table so peer.ts routes
  RECORDS/ACK/INIT/… without a switch.

### Surfaces / API completeness — [P2] (resource; log; transport: peers, index)
- **`cluster` as a ViewProxy** (plan §1) so `cluster.connect(…)` works; expose
  `peers`/`partitions`/`me`. `cluster.me`/uuid as a derived `peers` row
  [open question 5]; `partitions` once partitioned holding exists.
- **Subset / projection views** — `view(log, filter)`, or projecting a single
  partition, so L2's per-client `read()` projections can derive from the log. (log)
- **More projections** — `connectedServers`, `clients` — or leave them for consumers
  to derive off `peers`.
- **Deliver lazy `RecordView`s, not plain records** — keep dispatch's
  no-force-parse contract through L1.

### Robustness & lifecycle — [P1→P3] (transport: message, peer, index; resource)
- **[P1] Defensive decode against malformed/hostile frames.** `records()` trusts
  `count` and each `recLen`: `count = 2^28` → `new Array(count)` OOM, an oversized
  `recLen` over-reads the buffer. Bound both against remaining body bytes; reject
  (destroy peer) on violation. Matters once frames come off the network. Pairs with
  the malformed-frame tests below.
- **`destroy()` doesn't drain in-flight** (resource) — a `flush`-then-close is
  cleaner than tearing the mesh down immediately (a write mid-broadcast may not
  reach peers).
- **`ready` heuristic** (index) — resolve when discovery is exhausted with no
  reachable peer, not just on first-connection-or-timeout.
- **[P3]** Attach-snapshot swallowing assumes empty initial state — if
  `fero(name, {initial})` lands, the first emission carries real data and must be
  logged/broadcast, not dropped (resource). Surface connection `'error'` to L4
  diagnostics instead of swallowing it (peer).

### Wire-format micro-optimizations — [P3] (transport: message, peers; resource)
Pure perf tail; gate each on a `*.perf.ts` threshold.
- **Prefix-delta keys** (reserved `keyDelta` bit) — collapse shared leading segments
  across a sibling-burst batch (`['users','42','name']`, `['users','42','age']` → one
  `shared` varint).
- **Columnar body** (reserved `COL`/`UNIFORM` bits) — struct-of-arrays so a
  route/filter pass touches only types+keys, never value bytes; `UNIFORM` drops the
  per-record `recLen` for fixed-width batches.
- **Remove-value elision** — `remove` records carry value bytes the apply contract
  ignores; eliding (force `vtype=undefined`) saves bytes (trade: not byte-lossless
  for removes — matters for an audit log).
- **Avoid double `Buffer.byteLength`** — `keySize`/`writeKey` and value sizing
  recompute utf8 lengths; single-pass prepare or cache.
- **Cumulative piggybacked ACK (YACK)** — watermark flow control; lands with L2
  write-ack semantics.
- Numeric-vs-string status enum (peers); method-dispatch closure-per-method
  (one-time, fine — noted) (resource).
- Documented non-portabilities: little-endian host (x64/arm64); varint values < 2^32.

---

## Testing & chaos backlog (mostly L4)
- **N-node convergence + partition/kill/heal** chaos harness (port fero-old's) — the
  big one; spans transport/log/resource. The crash-recovery path (kill, peer writes,
  restart, catch-up) is covered; partition-heal and late-join are not.
- **Concurrent-write divergence** — two nodes diverging under simultaneous same-key
  writes (motivates LWW).
- **Catch-up correctness** — a node that missed records converges via `diff` on
  reconnect.
- **Reconnect end-to-end** — kill/restart, fake-timer backoff for determinism;
  **max-attempts → destroy** lifecycle.
- **Real-socket large/straddled frame** — a record bigger than one TCP segment
  reassembles (straddle is unit-tested, not yet over a socket).
- **Malformed-frame tests** — truncated `bodyLen`, `count` > body, `recLen` overrun,
  reserved vtype nibble (7, 9–15) — must error gracefully, never crash/over-read.
  Plus a **property/fuzz** encode→decode→deepEqual loop over thousands of random
  records.
- **Handshake** — control-frame straddle (INIT/SYNC/DONE split across segments),
  malformed identity payload, client refused before `ready`.
- **Churn** (peers) — rapid connect/disconnect must not leak projection rows or
  connections; **dial-cap/jitter** behaviour once the reactive loop lands.
- **DHT** — tighten distribution/movement bounds (deterministic hash + larger key
  set asserts the ~1/N movement law); `owners()` distinct-R under churn.
- **Method-returns-ViewProxy** — snapshot (`await`) vs live (reactive) on one handle;
  **config-vs-method recognition** edge cases (class, async fn, opts key colliding
  with a default method name); **client (no-port) path**; `replicate()` to R owners.
- **Perf coverage gaps** — a scalar-heavy batch (int/f64, no JSON) and an N=10k batch
  (catch superlinearity) in `message.perf.ts`.

## Parked alternatives (considered, not chosen)
Recorded so they aren't re-litigated without a new reason.
- **Whole-frame CBOR** — uniform + handles binary, but forfeits the scalar-nibble and
  binary-key wins; viable only behind the value seam [open question 8].
- **Varint `bodyLen`** (vs fixed u32) — saves ~3 bytes/frame but adds a varint read to
  the framer's hot loop; fixed u32 keeps it branch-light.
- **Magic-byte version nibble** — reserved for wire evolution; v1 burns the byte as a
  constant marker.
- **Jump consistent hash** (O(1), no vnode memory, but assumes densely-numbered
  buckets and complicates weighted/named nodes) and **rendezvous/HRW** (no rebuild,
  natural R-replicas, but O(M)/lookup — wins only for small M) — vs the current vnode
  ring.
- **CRDT / OR-set** merge vs LWW-by-ptime [open question 10]; **WAL + checkpoint**
  (DB-style) as the persistence+compaction shape.
