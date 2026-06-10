# IDEAS — open questions & future work

The single ledger of what's **not yet done** across L0 (transport), L1 (log/view)
and L2 (resource). Settled decisions and the rationale behind the current shape
live in [DECISIONS.md](DECISIONS.md); this file is *only* open work — the place to
look for what needs attention. When an entry cites a landed milestone for context,
it links the [DECISIONS.md](DECISIONS.md) record rather than restating it.

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
7. **Value codec.** Adopt a CBOR / `data`-owned binary value form behind the
   `encodeValue`/`decodeValue` seam? `JSON.parse` of object values is ~85% of decode
   cost (~2.4ms vs ~0.35ms lazy-scan for 1000 object records) — decide with a perf
   number, not a guess. (transport/message)
8. **Hash function.** Lock in djb2-accumulate + fmix32, or switch to wy/xxhash32
   after a `dht.perf.ts` bake-off? The fmix32 finalizer is load-bearing (without it
   an address's vnodes cluster). (transport/dht)
9. **Conflict-merge model.** Stay LWW-by-Lamport, or adopt CRDT / OR-set
   (intent-preserving merge vs simplicity)? And within LWW, refine the Lamport order
   with an HLC/wall-clock hybrid ([DECISIONS A](DECISIONS.md))? (resource, log)

> The routed/partitioned model has landed ([DECISIONS F1/V/P/Q1/Q2/Q3](DECISIONS.md));
> its open remainders live in the Partitioned ownership, Catch-up & anti-entropy,
> Bounded memory, and Distributed query workstreams below.

---

## Workstreams

### Identity, dedup & connection hygiene — [P1] (transport: peer, peers, handshake, index)
The biggest correctness cluster — these items share one underlying gap: there is no
stable peer identity until the handshake. **Inbound re-key has landed**
([DECISIONS T](DECISIONS.md)): an accepted server socket is re-keyed to its learned
listen address on handshake DONE (uuid stamped on the `Peer` + row), so it no longer
leaks a phantom ephemeral `client` row, and `onSubscribe`/reap key under a stable
dialable address. The remaining items build on that identity:
- **Heartbeat-only dedup — LANDED** ([DECISIONS T4](DECISIONS.md)): per socket only the
  lower-uuid node originates PINGs; the higher-uuid node watchdogs (flags suspect on
  inbound starvation). Halves N² probe traffic — the constraint that actually bites at
  scale — with zero membership/broadcast/isolate change. **Full socket dedup (collapse the
  two sockets per pair to one) is DEFERRED** — a design pass found it has a *fatal* silent
  R=∞ convergence regression (the loser goes `!dialed`, and catch-up is dialer-gated with no
  periodic AE under full replication), re-opens the T/T3 `#published`/`#mirror`/`#prune`
  invariants (the "promoted" survivor is `!dialed && published && row-owner`), breaks the
  chaos `isolate`-both-dials partition seam, and has a formation flap. **Prerequisites before
  full dedup:** (1) periodic anti-entropy under R=∞ *or* a non-dialer-gated catch-up trigger;
  (2) subscription failover / re-dispatch (a promoted-peer bounce must re-subscribe); (3)
  incarnation/epoch fencing. Plus a chaos `isolate`/`heal` rework and (the clean home) a
  unified per-peer `link` abstraction. The promote-the-shadow blueprint is captured in the
  design run for when those land. (transport: peer, peers; resource: catch-up/membership)
- **Prune dead rows — LANDED** ([DECISIONS T3](DECISIONS.md)): a terminal departure (an
  inbound client / half-handshake close, or a dial that gives up) prunes the row + `#conns`
  entry via `onGone` → `#prune`; the self-reject row is pruned too; shadows self-prune from
  `#shadows`. Remaining: a `max=Infinity` dial to a permanently-dead address retries forever
  (row cycles, never gives up) — an **eviction-driven explicit `forget(address)`** (the view
  knows the peer is gone) or a TTL is the lever (pairs with the reactive dial loop /
  dead-candidate backoff). Plus the rapid-reconnect shadow-overwrite leak noted in T.
- **uuid self-identity + self-reject — LANDED** ([DECISIONS T2](DECISIONS.md)): a peer
  presenting our own uuid is rejected (a self-loop via an alternate address — multi-NIC,
  `localhost` vs `127.0.0.1` — or a uuid collision) and the address remembered so
  discovery/gossip/heal can't redial it. Remaining: `#selfAddrs` is add-only — clear a
  stale block if a uuid collision is later fixed (defensible to leave; misconfig).
- **[P3] Incarnation numbers** for flapper fencing beyond the stability debounce
  ([DECISIONS V](DECISIONS.md) deferral) — pairs with uuid self-identity.

> The peer-disconnect (`onPeerGone`) hook + `peer→subId` reverse index that reaps a
> gone peer's served subscriptions (incl. forwarded subs and the Q3 `read()` gather's
> `gatherLive`) on ungraceful disconnect is **already built** — `peers.ts` fires
> `onPeerGone` on the status→disconnected transition, `dispatch.ts` keeps the reverse
> index + `reapPeer`, covered by the resource reap tests. (Was listed open here; it
> landed alongside Q1/Q3.)

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

### Routing hot path — [P2→P3] (transport: message, dht, index)
Everything on the per-routed-record path. The three headline items landed/closed in
[DECISIONS U](DECISIONS.md): the **allocation-free ring predicate `dht.holds(key, addr,
R)`** shipped (replaces `owners().includes` on the un-memoized held-gate / catch-up
paths — ~40% faster, zero-alloc); the **hot-key hash memo** measured net-negative
(re-hash beats a Map memo on short keys, + an unbounded map leaks) and the
**`RecordView.key0` accessor** a steady-state regression (kept records re-decode the
full key downstream via `log.append`→`applyRecord`) — both rejected. What's left:
- **[P3] Bounded-LRU hash memo** (≈256 entries) — the ONE unmeasured hash-memo case
  ([DECISIONS U](DECISIONS.md)): a handful of hot keys among millions of routed keys,
  where re-hash dominates and an unbounded map's GC would have hurt. Build only if
  production profiling shows hash cost / GC pressure on the routing path.
- **Hash bake-off** → [open question 8] (the hash CHOICE — djb2+fmix32 vs wy/xxhash32 —
  separate from the memo).
- **[P3] Self-delivery fast-path** for `owner === me` (a self-routed write still
  allocates the record).
- **[P3]** `shedConfirmed` is O(orphans × seen) per digest (fine — orphans are
  transient; a large rebalance on a huge keyspace could want a per-partition seen
  index). **[P3] Incremental `track()`** (parse the single insert/remove for O(1)
  bookkeeping vs re-diffing the whole membership set) / **rebuild without the
  `[hash,owner][]` tuple array** (sort an index permutation into typed arrays).

### Bounded memory & compaction — [P1] (log, resource)
Several unbounded structures interlock. **In-memory log compaction has LANDED**
([DECISIONS W](DECISIONS.md)): `Log.compact()` collapses strictly-superseded same-origin
`update`s (latest-update-per-key) on an unref'd timer in both modes, append path untouched,
`marks()`/catch-up/shed preserved. Remaining:
- **Insert/remove-churn collapse.** W collapses only `update`s, and skips a partition entirely
  if its segment holds any NESTED remove (`key.length≥2`) — dropping a vivifier of the remove's
  ancestor would crash replay (the impl review's set/delete/set blocker). A re-insert/delete
  cycle, an array partition (positional `at` isn't a stable element identity — naive grouping
  loses array elements), or churn that shares a top-level partition with a nested remove is
  therefore not collapsed. Refinements: a per-vivifier rule (drop an update only when no later
  nested remove depends on the ancestor it vivifies), OR — the cleaner root fix the design review
  recommended — make `data`'s `res.remove` a no-op on an absent ancestor (also hardens view()
  replay + cross-origin remove reordering), after which W's simple update-collapse is fully safe.
  Element-identity keys are the separate array mechanism. (log, data)
- **Per-partition dirty-set.** W's timer sweeps every partition (O(partitions)/tick, like
  marks/resync) and length-gates the small ones; track partitions appended-to since the last
  pass so the sweep is O(written), not O(total). (log)
- **WAL compaction.** The persistence WAL grows unbounded ([DECISIONS C](DECISIONS.md)) — W
  is IN-MEMORY only, so the on-disk file keeps every record (restore dedups on load — correct,
  but restore cost is O(historical writes)). snapshot+truncate, or an `onCompact` hook that
  rewrites the segment file. **Durable shed** folds in here: P4's `shed()` is in-memory only,
  so a scoped node with `storage` resurrects a shed orphan on restart (the WAL still holds the
  partition; restore has no held-gate — self-healing on rejoin, no data loss, but it
  re-advertises until it re-sheds). A tombstone / held-gate-on-restore is the fix; only affects
  `{replicas:R, storage:…}` ([DECISIONS P4](DECISIONS.md)).
- **`versions`/`seen` maps** grow unbounded ([DECISIONS A](DECISIONS.md)) — NOT folded into W
  (W preserves the dedup high-water): a removed key's `versions` tombstone is still needed to
  reject a stale resurrecting write, so GC needs a safety horizon. (resource)
- **Durable view-epoch recovery.** A `{pinned uuid, storage}` node restores its Lamport clock
  on restart but boots `ViewManager` at epoch 1 ([membership.ts](resource/membership.ts)); a
  post-restart local write then carries a LOWER epoch than its own restored records and is
  epoch-fenced (V1d), so it diverges from peers and doesn't reconverge. Surfaced by the W
  design review (it's also what forces W's `epoch ≥` dominance guard). Restore the view epoch
  to `max(restored)` on boot (or floor a fresh node's local-write epoch above the restored
  max). Only affects pinned-uuid + storage. (resource, membership)
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
Builds on [DECISIONS B](DECISIONS.md) and [DECISIONS P](DECISIONS.md) (the scoped digest).
- **Epoch-aware catch-up — LANDED** ([DECISIONS B1](DECISIONS.md)): `applyInbound` now
  SKIPS logging+applying a record whose key already holds a strictly-higher-epoch winner
  (a permanent loser under epoch fencing) — `seen` still advances (sticky, no re-fetch),
  `shedConfirmed` confirms against `log.marks()` not `seen`. Smaller logs + less re-ship
  after an ownership change.
- **Merkle/range digest.** Today's digest is O(keys): per-origin under full replication,
  per-(origin,partition) and O(held keys) under scoping ([DECISIONS P](DECISIONS.md) — the
  deferred "P3 compaction"), re-sent every `antiEntropy` ms by periodic AE. Replace with a
  Merkle / range-hash tree: exchange a root, drill only into differing subtrees (O(log keys)
  + the diff).
- **Smarter peer-selection.** Periodic AE digests every view member each round (O(N²)
  fan-out) — digest a random subset per round instead.
- **Stream the diff.** `diff()`/`recordsSince` builds one large array; stream it
  (generator / chunked frames) so a fresh join doesn't spike sender memory.
- **Asymmetric reachability.** Catch-up ships over the *dialed* connection only —
  verify behaviour when ONLY an inbound connection exists.

### Partitioned ownership & routing — [P2] (transport: dht, index; log; resource)
The routed/projected model (plan §5–6) has landed
([DECISIONS F1/V/P/Q1](DECISIONS.md)); the ring is per-epoch stable. Remaining:
- **Reject-stale-epoch fence** (the open residue of F3) — REJECT a stale-epoch write
  from an evicted node; needs per-partition owner lineage + a uuid↔address map
  ([DECISIONS V/F2](DECISIONS.md)).
- **Read-your-writes on a failed owner-forward.** When a write's owner-forward fails it
  commits as a local orphan, but a subsequent read routes to the stale owner until
  anti-entropy reconciles ([DECISIONS Q1](DECISIONS.md)) — tighten.
- **Stale shed-confirmation across an orphan write — LANDED** ([DECISIONS P4a](DECISIONS.md)):
  `commitLocal` now clears `shedReady[p]` when its never-drop fallback appends a fresh winner to
  an orphan, so a confirmation earned against the old high-water can't be reused to shed before
  the new record is R-replicated (was a pre-existing P4 under-replication/data-loss bug, surfaced
  by [B1](DECISIONS.md)'s adversarial review).
- **`owners()` distinct-R correctness under churn** — assert exactly R distinct owners
  across view changes (test → chaos backlog).
- **[P3] Vnode count vs cluster size** (200/peer → 20k+ ring entries at 100s of
  peers; revisit count or ring structure — jump/HRW in parked alternatives).

### Failover & re-dispatch — [P2] (resource)
Both halves of [open question 2], from [DECISIONS D + E](DECISIONS.md).
- RPC re-dispatch when the connected server fails (today: first connected server, no
  retry/re-route).
- Subscription re-subscribe elsewhere when the connected server drops.
- **Outbox-flush-before-ring-rebuild** — flush pending sends before the ring rebuilds
  on a view change ([DECISIONS V](DECISIONS.md) deferral).
- **Preserve a buffered write's attempt-epoch on flush.** V1e buffers writes when
  quorum-less and flushes them under the *current* epoch (so they win LWW on rejoin);
  preserving the original attempt-epoch is the refinement ([DECISIONS V](DECISIONS.md)).

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
- **Commit-ack** primitive [open question 1] — including the **commit-ack drain**
  (PREPARE-ACK high-water vectors) the V/F1 handoff wants
  ([DECISIONS V/F1](DECISIONS.md)); **cross-partition atomicity** [open question 3].
- **Per-client projection re-binding** on auth change (plan §6.2): re-invoke `read`,
  diff, ship the delta; v1 runs `read` once at subscribe (a custom `read` returning
  `data.filter(s => visible(s, peer))` gives a per-client view, just not re-bound).
- **Client-side `'move'` deltas** for ordered projections (sort/top) — `applyRecord`
  ignores `move`, so unordered projections converge but ordered ones don't. (Also the
  L3 `top/limit-K` planner dependency — see Distributed query & aggregates.)
- **`context.methods` auth identity** (plan §6.1): preserve the caller's auth across
  method-to-method calls (v1 reuses the same `context`, no per-call peer/auth); a
  remote handler's `context.methods` runs locally.
- **[P3] Per-handle GC teardown** of an abandoned fold/gather/subscription handle —
  the consumer-abandonment counterpart to the `onPeerGone` disconnect teardown in
  Identity, dedup & connection hygiene.
- **[P3]** Default `insert` nested key/`at` semantics (only top-level handled; nested
  works via direct assignment). `send()` returning a flush/ack handle to back
  await-or-not write semantics.

### Value codec & wire evolution — [P2] (transport/message)
Gated on [open question 7].
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
- **`data.x` facade edges** (Q1 documented limitations — the routed `read()` is the
  robust fallback): a partition named like an **operator/built-in** (`filter`, `group`,
  `connect`, …) can't be READ through the facade (it returns the operator) — read it via
  the snapshot (`data[value][key]`) or the routed method; **deep nested writes**
  `data.x.y.z = v` into a non-held partition aren't routed (depth-1 is); **`await
  data.x.field`** on a non-held key resolves the subscription, not a one-shot of the field
  ([DECISIONS Q1](DECISIONS.md)).

### Distributed query & aggregates (L3) — [P2→P3] (resource; planner; data)
Decomposable aggregates (Q2) and whole-resource `read()` = gather (Q3) have landed
([DECISIONS Q2/Q3](DECISIONS.md)) — the rest of the L3 distributed-query slice:
- **Named-method fold / user-supplied combine** — a method returning a decomposable
  aggregate (`anyActive: (_,c) => c.data.some(s => s.active)`), run per-holder over
  OWNER-scoped `c.data`, the combine derived from the terminal operator's type (or
  user-supplied). This is the function-carrying dispatch (closure predicates; the seam
  grouped aggregates need; AND the SCALABLE alternative to Q3's O(N) gather — ship
  per-shard partials + a combine, not all rows). Q2 ships only DECLARATIVE specs
  (`col[,val]`) and rejects inline closures loudly. (resource)
- **L3 chain planner** — `top/limit-K` (depends on `applyRecord` 'move' support — see
  Method / RPC semantics + [DECISIONS E](DECISIONS.md) — or a whole-array re-ship),
  `length(fn)` (whole-histogram re-ship, not O(1)), bare `group(col)`, and any
  CHAINED aggregate past the facade's first hop (`data.filter(p).sum()`, `group(c).sum(v)`)
  — all loudly flagged by the Q2f boundary guard, deferred to the planner that splits a
  chain into per-shard + roll-up + local stages. Bare holistic ops already work via
  `read().<op>()`; the planner is the EFFICIENT, no-full-gather path for the foldable ones.
  (planner, resource)
- **median/percentile/quantile** — `data` has no such operator (Q3 defers them; the user
  computes over `methods.read()`). Add as fero terminals over the gathered set, or
  contribute local operators to `data` and distribute via gather. (resource, data)
- **Gather / fold hardening** — a bounded one-shot-gather deadline + a partial-result
  signal (today a slow/departed holder silently undercounts after `callTimeout`); the
  union-recompute is O(total)/delta — an INCREMENTAL per-key merge is the perf follow-up;
  chained-aggregate auto-detect past the facade; per-handle GC of an abandoned gather handle
  (see Method / RPC semantics). (resource, transport)
- **`some/every('col')` under FULL replication** — the declarative column form is the
  scoped-distributed sugar (it folds via `buildPartial`'s `filter(col,val).length()`); under
  R=∞ the facade isn't built (to keep that path byte-identical), so `data.some('col')` falls
  through to data's raw `some`/`every`, which require a predicate FN (throws "fn is not a
  function" — use the native `data.some(fn)` there). Making the col form uniform across R=∞
  needs a `data`-lib `some(col)/every(col)` overload (the `data` lib accepts a column for
  sum/max/min/avg/filter but not some/every) — then fero's full-rep path works unchanged.
  `sum/max/min/avg('col')` + `length()` already work on every config. (data, resource)
- **Server-side `methods.read(key)` owner-routing.** A server's keyed `methods.read(key)`
  reads LOCALLY today (the `data[key]` facade does the routing); route it to `owner(key)`
  like the facade ([DECISIONS Q3](DECISIONS.md)). (resource)

### Robustness & lifecycle — [P2→P3] (transport: peer, index; resource)
Frame-decode hardening — malformed/hostile-frame bounds (count/recLen/length +
oversized-body cap) → typed `FrameError` → peer drop — has LANDED
([DECISIONS R](DECISIONS.md)).
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
- Documented non-portabilities: little-endian host (x64/arm64); varint values < 2^32;
  **NUL (`\x00`) in a top-level key** over-matches the `versionKey`/`originKey`/shed
  suffix separators (an inherited library separator assumption — [DECISIONS P4](DECISIONS.md)).

### Observability & devtools (L4) — [P2] (resource: inspect, observe; tools/observe)
The network observer + standalone dashboard ([DECISIONS O](DECISIONS.md)). Shipped: [a] topology+ring,
[b] live data + provenance/contention stream. The full devtools backlog (per-node drawer, ring zoom,
ticker filter, replay scrubber, multi-cluster merge, contention heatmap, …) lives in its own
[tools/observe/IDEAS.md](tools/observe/IDEAS.md). Cross-cutting open work:
- **Trust boundary** — a configured node discloses internals to any peer on the unauthenticated fero port;
  add a per-`__`-method caller allowlist (`observe:{ from:'localhost' | uuidList, remote:true }`), tightening
  to real auth once `peer.auth` lands. The gate is one `startsWith` on the cold control-frame path.
- **Cluster-side gather inspect** — for thousands of nodes, fan `__inspect` out over the cluster's own
  gossip and return a rollup so the bridge dials ONE node (a drop-in source adapter; deliberately not v1 —
  it goes blind during the partition the tool exists to show).
- **Batched/off-tick emit** — shrink the ~3× watched-write overhead by buffering events in a plain ring and
  flushing to the streamed proxy on a microtask (off the synchronous commit+replicate path).
- **Scale tier / war games (Slice 5)** — view-group clusters, ring-movement heatmap, lag leaderboard,
  convergence timeline; full converged/converging/partition-suspected semantics; deterministic split-brain
  loser generation.

---

## Testing & chaos backlog (mostly L4)
The reusable chaos HARNESS + reversible partition seam, the N-node convergence /
partition→heal / crash→recover / churn / randomized-soak scenarios, the real-socket
large frame, and the handshake straddle + malformed-identity tests have LANDED
([DECISIONS L4](DECISIONS.md)). Concurrent-write divergence, catch-up correctness, and
the malformed-frame + encode→decode / single-byte-corruption fuzz were already covered.
What's still open:
- **Reconnect end-to-end** — fake-timer backoff for determinism; the **max-attempts →
  destroy** give-up lifecycle (kill/restart + rejoin are covered; the deterministic
  backoff and give-up-then-destroy paths are not).
- **Handshake** — **client refused before `ready`** (the guard isn't built yet — see the
  Handshake/membership workstream; straddle + malformed identity are covered).
- **Membership** — a dedicated **two-established-cluster merge** (works via the
  lowest-coordinator + epoch-ordering path, only chaos-adjacent tested);
  **min-cluster-size** behaviour (a sub-quorum remnant stays read-only — the CP posture is
  decided in [DECISIONS V](DECISIONS.md), the behaviour is untested); flapper-fencing once
  incarnation numbers land.
- **Churn leak** (peers) — the churn scenario asserts convergence + single-view
  agreement, but a dropped peer still leaves a `disconnected` row forever; wire row
  pruning (the "Prune dead rows" workstream) and an under-test for it. **dial-cap/jitter**
  behaviour once the reactive dial loop lands.
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
  binary-key wins; viable only behind the value seam [open question 7].
- **Varint `bodyLen`** (vs fixed u32) — saves ~3 bytes/frame but adds a varint read to
  the framer's hot loop; fixed u32 keeps it branch-light.
- **Magic-byte version nibble** — reserved for wire evolution; v1 burns the byte as a
  constant marker.
- **Jump consistent hash** (O(1), no vnode memory, but assumes densely-numbered
  buckets and complicates weighted/named nodes) and **rendezvous/HRW** (no rebuild,
  natural R-replicas, but O(M)/lookup — wins only for small M) — vs the current vnode
  ring.
- **Gap-tolerant dedup + gap-aware anti-entropy** (TCP-SACK-style contiguous-water +
  above-water gap set per origin) — approach 1 to owner-routing in
  [DECISIONS F](DECISIONS.md); F1/P chose owner re-sequencing (approach 2).
- **Drained-ballot handoff barrier** (gate the view-change commit on catch-up) — P4's
  keep-until-confirmed shedding gives the no-under-replication-window property without
  it, so it's dropped from the roadmap ([DECISIONS P4](DECISIONS.md)).
- **Force-to-solo (AP) degrade** — a sub-quorum remnant could be forced writable (AP);
  deliberately not offered (CP posture, [DECISIONS V](DECISIONS.md)).
- **CRDT / OR-set** merge vs LWW-by-Lamport [open question 9]; **WAL + checkpoint**
  (DB-style) as the persistence+compaction shape.
