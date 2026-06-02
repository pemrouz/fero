# L2 resource — ideas & suggestions ledger

Companion to [../transport/IDEAS.md](../transport/IDEAS.md) and
[../log/IDEAS.md](../log/IDEAS.md). Improvements deferred from the first cut of
L2 (`fero(name, opts)`), by concern. Legend: **[P1]** soon / **[P2]** when it
matters / **[P3]** nice-to-have.

v1 L2 is **server / full-replication** mode: every server materializes every
record (via L1's dialed-broadcast), the `data` proxy is the source of truth, and
methods run **locally** with a `context`. The headline gaps below — client→server
RPC, per-client `read()` projections, DHT-partitioned routing — are what turn
"every node is a full replica" into the routed, projected model plan.md §5–6
describes.

---

## Perf
- **[INVESTIGATED — Milestone G — not the win it looked like] `sclone` on the
  write path.** Every write emits through a `data` FunctionSink, which `sclone`s
  the value (~23ms of a ~45ms 10k-write run). The original plan was to skip the
  clone on the broadcast path (which serializes to bytes immediately, retaining
  nothing) and clone only for the log. But after Milestones B+C the **log is now
  essential** (catch-up + persistence both read it back), and the log needs a
  DEEP owned copy because `data` mutates nested objects in place (`BU2`). So the
  single `sclone` is required for the log regardless — broadcast piggybacks on it
  for free. There is **no redundant clone to cut**: the obvious quick win is moot.
  The real (larger) win is structural — **store encoded records (bytes / lazy
  `RecordView`) in the log instead of live objects**: bytes are immutable (no
  clone needed) and catch-up re-ships them verbatim (zero re-encode). That's the
  "lazy-RecordView buffer retention" item in [../log/IDEAS.md](../log/IDEAS.md) —
  a real redesign, deferred. (Note: the Milestone-A version-map alloc churn — a
  separate, real regression — WAS fixed; see [index.perf.ts](index.perf.ts).)
- **[P2] Double materialization (proxy + log).** The proxy holds full current
  state; the log holds every record. The log now earns its keep (catch-up reads
  it; persistence persists it). The remaining cost is memory — addressed by
  gating log retention behind a `durable`/`catchup` config so a throughput-only
  deployment skips it. Ties to log/IDEAS compaction.
- **[P3] Method dispatch allocates a closure per method at construct time.**
  Fine (one-time), noted for completeness.

## Correctness / robustness
- **[DONE — Milestone D] Client→server RPC.** A read-only client (`fero(name)`,
  no port) gets a Proxy method surface: every call ships a `CALL` frame (method +
  arg, correlated by frame id) to its connected server, which runs the handler
  with `context.peer` = the caller and replies `RESOLVE`/`REJECT`. A ViewProxy
  return (e.g. default `read`) collapses to a snapshot for the reply. Calls time
  out (default 5s) so a dead server doesn't hang the promise. Bonus: a client also
  receives a one-time state catch-up on connect (the digest exchange), so its
  `data` is populated even before subscriptions exist. Remaining: (a) the live
  ViewProxy-subscription consumption mode (Milestone E — server pushes deltas to
  the client's inbound connection); (b) re-dispatch on connected-server failover
  (plan §11.2) — today a call picks the first connected server with no retry/
  re-route; (c) `context.methods` from within a remote handler still runs locally
  (fine for full replication).
- **[ATTEMPTED then REVERTED — Milestone F] Owner-routed writes conflict with
  in-order-per-origin dedup.** I built owner-routing (`publish` → partition owner →
  owner relays to replicas) and a 3-node test immediately exposed a *fundamental*
  conflict: owner-relay delivers one writer's records to a third node via TWO paths
  (some direct, some relayed through the owner), so they arrive **out of order**.
  But the whole replication core assumes a given origin's records arrive **in seq
  order** — the per-origin high-water dedup drops any `seq <= seen[origin]`, and the
  anti-entropy digest is a single per-origin high-water. Out-of-order arrival makes
  the dedup drop late-arriving lower seqs as false duplicates → silent data loss →
  divergence. So owner-routing was reverted to the correct full-mesh **broadcast**
  model (every writer broadcasts its own writes in-order → dedup/anti-entropy/LWW
  all sound). Doing F correctly needs ONE of:
  1. **Gap-tolerant dedup + gap-aware anti-entropy** — track a contiguous water +
     an above-water gap set per origin (TCP-SACK-style), and make `recordsSince`
     ship by gaps, not just water. Bounded if delivery is mostly-ordered.
  2. **Owner re-sequencing** — the owner stamps each partition's writes with its
     OWN ordered seq and relays under origin=owner, so every replica sees one
     in-order stream per (owner, partition). Cleaner conceptually but introduces an
     optimistic(origin=writer)+canonical(origin=owner) duality to reconcile.
  The general `encodeFrames` mixed-origin framing (a real robustness win, needed by
  either approach) was kept. Also still open from plan §5: **commit-ack** (handler
  awaits durable commit — assignment can't express the await per open-q #1, needs a
  committing method primitive) and **no cross-partition atomicity** (§11.3).
  Partitioned *holding* (a node materializes only owned partitions) stays out of
  scope — it makes reads async/routed and breaks the synchronous `data.x` API.
- **[P2] `read()` is full passthrough — no per-client projection.** plan §6.2:
  the connected server runs `read(_, {peer, data})` once per client at subscribe
  time, returning that client's projection; re-invoked on auth change, diffed,
  deltas shipped. v1 `read()` returns the whole `data` proxy to everyone.
- **[DONE — Milestone A] Conflict rule: last-writer-wins.** Records now carry
  provenance (origin uuid + a Lamport `seq`); concurrent same-key writes resolve
  by lexicographic (seq, origin) per key path, so nodes converge instead of
  diverging. Per-origin high-water marks dedup re-delivered records. Caveats /
  refinements still open: (a) LWW order is Lamport, not wall-clock — a "later"
  write by one clock can lose to a higher-seq write that was actually earlier in
  real time; a hybrid logical clock (HLC) would track wall-time. (b) Field-level
  granularity: a whole-object write (`k1`) and a nested write (`k1.score`) are
  independent version keys, so they MERGE rather than one clobbering the other —
  document this is the intended semantics, not a bug. (c) `versions`/`seen` maps
  grow unbounded — tie their compaction to the log-compaction work (log/IDEAS).
- **[P2] `destroy()` doesn't drain in-flight.** Tears down the mesh immediately;
  a write mid-broadcast may not reach peers. Probably fine (best-effort), but a
  `flush`-then-close would be cleaner.
- **[P3] Attach-snapshot swallowing assumes empty initial state.** The write-
  capture sink drops its first emission (the empty attach-snapshot of an empty
  proxy). If we later support seeded initial state (`fero(name, {initial})`),
  that first emission carries real data and must be logged/broadcast, not dropped.

## API
- **[P2] `cluster` should itself be a ViewProxy.** plan §1 wants `cluster`
  queryable/connectable (`cluster.peers`, `cluster.partitions`, `cluster.me`).
  v1 exposes a plain object with `peers` (a ViewProxy) + `me`/`uuid`/`owner`.
  Wrap the whole thing in `$()` so `cluster.connect(...)` works, and add
  `partitions` once DHT-partitioned holding exists.
- **[P2] Write sugar (`data.x = y`) vs `methods.update` parity.** plan §123 calls
  assignment "sugar over methods.update/insert/remove". Today assignment goes
  straight through the sink (bypassing the `update` method), so overriding
  `update` does NOT intercept plain assignments. Decide: should a custom `update`
  method see assignment writes too? (Probably yes for an auth/validation hook —
  route assignments through the method.) Open design point.
- **[P2] `context.methods` auth identity.** plan §6.1: method-to-method calls should
  preserve the caller's auth identity. v1 `context.methods` just calls the bound fn
  with the same `context` (no per-call peer/auth). Revisit with RPC.
- **[P3] Default `insert` key/at semantics.** v1 targets `at ?? key` and sets that
  single key. The full change-record `insert` (parent `key` path + child `at`)
  for nested inserts isn't handled by the default method — only top-level. Nested
  inserts work via direct assignment; document or generalize.

## Testing
- **[NOTE] Convergence is on VALUES, not key order.** Two replicas can hold the
  same map with different object key insertion order (a node that wrote `b` then
  received `a` holds `{b,a}`; its peer holds `{a,b}`). This is correct for a KV
  store, but means cross-replica equality checks must be order-insensitive
  (`sameState` in the tests), and any future feature that depends on iteration
  order (e.g. ordered projections) must impose its own ordering, not rely on the
  proxy's. The chaos test caught this.
- **[P2] N-node convergence + membership churn** — 3+ nodes, a node joins late
  (motivates catch-up), a node drops (motivates re-subscribe). Chaos (L4). The
  crash-recovery path (kill, peer writes, restart, catch-up) IS now covered.
- **[P2] Method-returns-ViewProxy subscription** — once RPC lands: a method
  returning `data.filter(...)` consumed as a live subscription vs `await`ed as a
  snapshot (return-type dispatch, plan §1).
- **[P3] Config vs method recognition edge cases** — a config value that is a
  function-like (class, async fn), an opts key colliding with a default method
  name (override semantics already covered by one test; expand).

## Alternatives
- **[P2] Log-as-source (arch A) vs proxy-as-source (arch B).** L1's `distribute()`
  derives the view from the log (arch A — the log is the write API). L2 inverts it
  (arch B — the proxy is the source, the log is a history sidecar) because
  assignment is L2's write surface and arch A would loop. Worth converging the two
  someday: make `distribute()` also proxy-sourced, with the log as a pure sidecar,
  so L1 and L2 share one replication core. Captured so the divergence is a
  deliberate choice, not drift.
