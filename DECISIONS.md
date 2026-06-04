# Decision records

Why the code is shaped the way it is. Each record is a decision **already made** —
its context, the call, the consequences, and a pointer to any open follow-ups in
[IDEAS.md](IDEAS.md). This file is settled history: append a record when a
milestone lands, never delete one (supersede it with a later record). Open
questions and future work live in [IDEAS.md](IDEAS.md), not here.

Status legend: **Adopted** (in the code) · **Reverted** (built, then backed out) ·
**Investigated** (measured, no change).

---

## A — Last-writer-wins conflict resolution · Adopted · `980ead9`

**Context.** Concurrent same-key writes on different nodes must converge, not
diverge.

**Decision.** Every record carries provenance — an origin uuid + a Lamport `seq`.
Concurrent writes to the same key path resolve last-writer-wins by lexicographic
`(seq, origin)`. Per-origin high-water marks dedup re-delivered records. The
logical clock lives in [resource/index.ts](resource/index.ts), not the Log — the
Log just stores records (with provenance) as the per-origin history catch-up
forwards.

**Consequences — intended semantics, not bugs.**
- LWW order is *Lamport*, not wall-clock: a write that is "later" in real time can
  lose to a higher-`seq` write that actually happened earlier.
- Field granularity: a whole-object write (`k1`) and a nested write (`k1.score`)
  are independent version keys, so they **merge** rather than one clobbering the
  other.
- Convergence is on **values, not key insertion order** — a node that wrote `b`
  then received `a` holds `{b,a}`; its peer holds `{a,b}`. Correct for a KV store,
  but cross-replica equality must be order-insensitive (`sameState` in tests), and
  any order-dependent feature must impose its own ordering.

**Open follow-ups → IDEAS:** HLC/wall-clock refinement; unbounded `versions`/`seen`
maps (tie to compaction); CRDT/OR-set as an alternative merge.

## B — Catch-up on (re)connect via per-origin digest · Adopted · `980ead9`

**Context.** A late joiner or a briefly-disconnected peer must converge without
anyone staying connected throughout.

**Decision.** When a dialed peer's handshake completes (transport `onConnect`,
gated to the dialer so catch-up runs once per direction), the two nodes exchange
per-origin high-water **digests** (`Log.originHeads()` / resource's `seen`) and
each ships the records the other lacks (`Log.recordsSince(vector)`, framed by
`catchupTo`). The receiver folds them through dedup + LWW. Reconnect is automatic:
a dropped dial → Peer retry → handshake re-fires → digest again. The handshake
itself stays **membership-only** — state-sync is an L1/L2 `onConnect` concern, not
carried in the handshake frames.

**Open follow-ups → IDEAS:** Merkle/range digest for huge logs; stream the diff
instead of allocating the tail; asymmetric reachability (catch-up over an
inbound-only link); a partition-heal chaos test (L4).

## C — Persistence via a storage seam + WAL · Adopted · `980ead9`

**Context.** State must survive a process restart.

**Decision.** A `storage` seam `{ load, append }` (plan §4). On boot, replay
`storage.load()` through the **same accept path** as inbound records (rebuilding
`seen`/clock/`versions` + the proxy), then append every accepted record via
`log.onAppend`. A built-in append-only-file WAL ships
([resource/storage.ts](resource/storage.ts) `fileStorage`); bring-your-own
implements `{ load, append }`. Restored records keep their **original** origin
uuid — the new instance continues under its own uuid, history stays attributed.

**Open follow-ups → IDEAS:** `fileStorage` does a synchronous write per record
(batch/async/coalesce for high write rates); the WAL grows unbounded
(snapshot+truncate compaction).

## D — Client→server RPC · Adopted · `980ead9`

**Context.** A read-only client (`fero(name)`, no port) needs to invoke server
methods.

**Decision.** The client gets a Proxy method surface; every call ships a `CALL`
frame (`{ method, arg }`, correlated by frame id) to its connected server, which
runs the handler with `context.peer` = the caller and replies `RESOLVE`/`REJECT`.
A ViewProxy return (e.g. the default `read`) collapses to a snapshot for the reply.
Calls time out (default 5s) so a dead server doesn't hang the promise. Bonus: a
client also receives a one-time state catch-up on connect (the digest exchange),
so its `data` is populated even before any subscription.

**Open follow-ups → IDEAS:** re-dispatch on connected-server failover (today: first
connected server, no retry/re-route); `context.methods` inside a remote handler
runs locally (fine under full replication).

## E — Live subscriptions (server-push) · Adopted · `27e687f`

**Context.** A method result consumed reactively should stream live deltas, not
just return a snapshot.

**Decision.** `methods.X(arg)` returns one unified handle. `await` it ⇒ a one-shot
RPC (snapshot/ack). Use it reactively (`.tap`/`.filter`/`.connect`/`[value]`) ⇒ it
opens a live subscription (`SUBSCRIBE` verb); the server runs the method per client
and, if it returns a ViewProxy (default `read` → whole `data`, or a custom
`data.filter(...)` projection), connects a sink that streams the initial snapshot +
every delta back over the client's connection (`RECORDS` frames tagged with the sub
id); the client folds them into a local ViewProxy. `then` is the **only** access
that does not subscribe — so await-or-not picks the mode (plan §1).

**Open follow-ups → IDEAS:** per-client projection re-binding on auth change (v1
runs `read` once at subscribe); failover re-subscribe; client-side `'move'` deltas
for ordered projections (`applyRecord` ignores `move`); per-handle GC teardown;
AsyncIterator consumption mode.

## F — Owner-routed writes reverted; full-mesh broadcast retained · Reverted · `1d691f2`

**Context.** Partition-owner routing (`publish` → partition owner → owner relays to
replicas) would cut replication fan-out below full-mesh broadcast.

**Decision (reverted).** A 3-node test exposed a *fundamental* conflict: owner-relay
delivers one writer's records to a third node via **two** paths (some direct, some
relayed through the owner), so they arrive **out of order** — but the replication
core assumes a given origin's records arrive **in seq order** (the per-origin
high-water dedup drops any `seq ≤ seen[origin]`; the anti-entropy digest is a single
per-origin high-water). Out-of-order arrival drops late lower seqs as false
duplicates → silent data loss → divergence. Reverted to full-mesh **broadcast**:
every writer broadcasts its own writes in-order, so dedup / anti-entropy / LWW are
all sound. The general mixed-origin `encodeFrames` framing (a real robustness win,
needed by either future approach) was kept.

**Doing F correctly needs one of (→ [IDEAS open question 7](IDEAS.md)):**
1. **Gap-tolerant dedup + gap-aware anti-entropy** — track a contiguous water + an
   above-water gap set per origin (TCP-SACK-style), and make `recordsSince` ship by
   gaps, not just water. Bounded if delivery is mostly-ordered.
2. **Owner re-sequencing** — the owner stamps each partition's writes with its own
   ordered seq and relays under `origin = owner`, so every replica sees one in-order
   stream per `(owner, partition)`. Cleaner, but introduces an
   optimistic(`origin=writer`) + canonical(`origin=owner`) duality to reconcile.

**Out of scope regardless:** partitioned *holding* (a node materializing only its
owned partitions) — it makes reads async/routed and breaks the synchronous `data.x`
API.

## F1 — Owner-routed writes via forwarding (owner re-sequencing, phase 1) · Adopted

**Context.** [F](#f--owner-routed-writes-reverted-full-mesh-broadcast-retained--reverted--1d691f2)
reverted owner-routing because owner-*relay* (forwarding a writer's own provenance)
split one origin's seq stream across paths → out-of-order → dedup data loss. The goal
stands: route writes through the partition owner so each partition has a single
sequencer. This is approach 2 (owner re-sequencing), built so it cannot hit the relay
bug.

**Decision.** A write to key K is committed by `owner(K)`. If we own the partition we
commit locally as before; otherwise we FORWARD the raw (unstamped) write to the owner
via a new `VERB.WRITE` frame. The owner applies it through its OWN write-capture sink
(`applyLocalWrite`), so it commits under `origin=owner`, logs, and replicates the
canonical record back. Full-mesh **broadcast is retained** — the owner is the sole
broadcaster of its committed records, each in seq order over one connection, so the
in-order-per-origin invariant the dedup/LWW core relies on still holds. *This is the
structural reason forwarding is safe where relay was not: exactly one broadcaster per
record, never multi-path.* `mesh.forward` returns `false` if the owner isn't a
connected peer, so the write falls back to a local commit rather than being dropped.

**A forwarded write commits at its recipient — it never re-forwards.** Re-checking
ownership on the receiving side bounces the write whenever ring views transiently
disagree during mesh formation (each node computing a different owner), ping-ponging
until membership converges (observed as multi-second convergence stalls under load).
The `committingForward` flag makes the sink commit a forwarded write as-is; a brief
ring disagreement at worst commits at a not-yet-true owner, which still broadcasts and
converges by LWW (as the pre-F1 model did).

**Consequences.**
- **Linearizable per partition** — concurrent same-key writes from different nodes all
  route to one owner, which serializes them (vs pre-F1, where each committed locally
  and LWW arbitrated after the fact).
- **Optimistic local apply** — the synchronous `data.x = y` set-trap materializes the
  value locally before the sink forwards it; the canonical `origin=owner` record
  reconciles on return. A brief local flicker is possible if the owner orders a
  concurrent write first.
- **A forwarder's log-append order is decoupled from its write order** — a forwarded
  write lands in the forwarder's log only when the canonical record returns, so
  log/replication order no longer tracks write order. This *reinforces* [A](#a--last-writer-wins-conflict-resolution--adopted--980ead9)'s
  "convergence is on values, not key order": cross-replica **and** cross-log
  comparisons must be order-insensitive (`sameState` in tests).
- The sole-member DHT `owner()` fast path keeps the solo-server write hot path
  allocation- and search-free — perf unchanged (~49ms/10k writes vs the 150ms
  threshold).
- The functional suite now runs serially (`--test-concurrency=1`): it spins up real
  TCP clusters that contend for ports + CPU when run concurrently, flaking the
  timing-sensitive multi-node convergence tests. Perf stays parallel.

**Still open → [IDEAS open question 7](IDEAS.md):** F1 keeps full broadcast, so it does
NOT yet cut fan-out. **F2** — per-partition sequencing + R-way replication
(`mesh.replicate` to the R owners; dedup/catch-up keyed per partition via the log's
`heads()`/`diff()`) — is the scaling win. **F3** — owner failover / version continuity
on handoff (the next clockwise replica, already caught up, continues the partition's
counter; `(version, owner)` breaks split-brain ties). Plus commit-ack [open question 1].

## G — `sclone` on the write path is not redundant · Investigated · `index.perf.ts`

**Context.** Every write emits through a `data` FunctionSink that `sclone`s the
value (~23ms of a ~45ms 10k-write run). The plan was to skip the clone on the
broadcast path (which serializes to bytes immediately and retains nothing) and clone
only for the log.

**Finding — no change.** After decisions B + C the **log is essential** (catch-up and
persistence both read it back), and it needs a **deep owned** copy because `data`
mutates nested objects in place. So the single `sclone` is required for the log
regardless; broadcast piggybacks on it for free — there is no redundant clone to
cut. (Separately, the Milestone-A version-map allocation churn *was* a real
regression and was fixed.)

**The real win is structural, deferred → IDEAS:** store encoded records
(bytes / lazy `RecordView`) in the log instead of live objects — bytes are immutable
(no clone) and catch-up re-ships them verbatim (zero re-encode).

## H — Proxy-as-source (arch B), not log-as-source (arch A) · Adopted

**Context.** L1's `distribute()` derives the view *from the log* (arch A — the log
is the write API). L2's write surface is assignment (`data.x = y`).

**Decision.** L2 inverts the dependency — the **proxy** is the source of truth, the
log is a history sidecar (arch B) — because routing assignment writes back through
the log (arch A) would loop. Captured so the L1/L2 divergence is a deliberate choice,
not drift.

**Open follow-up → IDEAS:** converge the two someday (make `distribute()` also
proxy-sourced, log a pure sidecar) so L1 and L2 share one replication core.

## V — View-synchronous membership · Adopted · `5c45e61` → `1d8c533`

**Context.** [F1](#f1--owner-routed-writes-via-forwarding-owner-re-sequencing-phase-1--adopted)
makes the partition owner the single writer, but ownership was derived from *live
connections* (`dht.track(servers)`), so the ring churned on every connect/disconnect
and nodes transiently disagreed on `owner(K)` (F1 needed `committingForward` to paper
over it). Under incremental mass-join (200 nodes) the ring would never stabilise.
A design review (go-with-fixes) confirmed the fix is **view-synchronous membership**:
the cluster agrees on a sequence of numbered views `{epoch, members}` and ownership is
stable within an epoch. The review caught the implementation-blocking gaps folded in
below (no failure detector; locally-derived epochs; one-directional catch-up).

**Decision.** Built across six increments (a prerequisite + five):
- **V0 — failure detector** (`5c45e61`). PING/PONG heartbeat + `setKeepAlive`; after
  N missed probes a peer is flagged `suspect` (orthogonal to `status` — the socket may
  still be open). TCP `close` never fires for a crash/silent partition, so this is the
  reachability signal everything else keys off.
- **V1a — layering seam** (`a0b6db5`). `VIEW_*` verbs + explicit dispatch → hooks (a
  view frame never reaches `onRecord`); an `epoch` field on `ChangeRecord` carried in
  the prov frame; `mesh.installView`/`viewMembers`. Zero behaviour change.
- **V1b — ring-from-view + merge** (`62499b8`). The DHT ring is rebuilt SOLELY by a
  committed view (`dht.track` removed). The view forms via a Paxos-flavoured ballot:
  the lowest-address **reachable** node is the soft coordinator; PREPARE→PROMISE→COMMIT
  with **promise semantics** (one proposer per epoch) make `epoch` a unique per-view
  token; **joint-consensus** quorum (majority of BOTH old and new view) means at most
  one view commits per epoch even under a partition. Fixed two real latent bugs:
  `mesh.forward` ignoring `peer.write`'s result (silent dropped write); one-directional
  anti-entropy (catch-up is now **reciprocal**, so a node that missed a write while a
  link was down heals on reconnect).
- **V1c — failover + eviction** (`4b5360b`). A member unreachable past an eviction
  grace is dropped; a dead coordinator is superseded by the next-lowest reachable
  automatically. Fresh-epoch ballots + promise-release timeouts keep a coordinator
  dying mid-2PC from wedging the cluster.
- **V1d — epoch-fenced LWW** (`cf024f7`). LWW extended to `(epoch, seq, origin)`: a
  write under a newer view wins, so a straggler from a superseded view can't clobber
  the current one. Within a view (constant epoch) behaviour is unchanged.
- **V1e — write-gate** (`1d8c533`). A node writes only while it can reach a majority of
  its view (a CACHED boolean); otherwise it is read-only and BUFFERS writes (bounded,
  drop-oldest) instead of committing/broadcasting, flushing when quorum returns. So a
  partition's minority side can't diverge — only the (≤1) majority side progresses.
  Supersedes F1's never-drop local commit for a quorum-less node. `cluster.writable`
  exposes it.

**Consequences.** Ownership is stable within an epoch (the foundation F2/F3 need).
This is a CP posture across membership changes: the minority side of a partition is
*unavailable* (read-only) rather than divergent. Steady-state perf is unchanged — the
coordinator tick is unref'd and idle when stable, the write path reads one cached
boolean; ~44ms/10k writes. Heal/rejoin (an evicted node restarts and is re-admitted),
4-node convergence, and reciprocal catch-up are tested; failover ~1.2s.

**Still open → [IDEAS open question 7](IDEAS.md):** stronger epoch fencing (REJECT a
stale-epoch write from an evicted node — needs the per-partition owner lineage +
uuid↔address) and the commit-ack drain land with **F2** (per-partition sequencing +
R-way replication — the fan-out scaling win) and **F3** (owner failover continuity).
Buffered writes currently flush under the current epoch (win LWW on rejoin) — preserving
the attempt-epoch is an F2 refinement. Two-established-cluster merge works via the
lowest-coordinator + epoch-ordering path but isn't dedicated-tested (chaos backlog);
a sub-quorum remnant stays read-only (CP) — a force-to-solo (AP) degrade is deliberately
not offered. Incarnation numbers (flapper fencing beyond the debounce) deferred.

## F2 — Per-partition sequencing / R-way replication: deferred to partitioned holding · Investigated · (no code)

**Context.** F1 + V give owner-routed writes with stable per-epoch ownership. The last
owner-routing goal ([open question 7](IDEAS.md)) was F2: cut replication fan-out from
O(N) full broadcast to O(R) by replicating each partition to only its R replicas, with
per-partition sequencing (+ F3 owner-failover continuity).

**Finding — deferred. Two reasons, both fundamental.**

1. **R-way fan-out is incompatible with fero's synchronous reads.** `data.x` reads are
   synchronous-and-local *because every node materializes the full state*. Replicating a
   partition to only R nodes means every other node can't serve a local read of it —
   reads must become async/routed (**partitioned holding**, plan §5–6's routed model).
   That changes a core API (synchronous `data.x`). So fan-out reduction is not a
   transparent optimization; it's a deliberate read-semantics decision.

2. **Per-partition sequencing under FULL broadcast is a regression, not a clean refactor.**
   Per-partition dedup (a per-partition high-water) is only safe if a partition's version
   stream arrives **in order from a single source**. Under full broadcast that source is
   the partition's owner, which **changes at every view-change handoff** — so the stream
   spans owners O1→O2 over different links, can arrive out of order, and the high-water
   drops the late lower versions (the original-F data loss, relocated to handoffs). The
   current **per-ORIGIN** model is *robust* to handoffs precisely because each owner is
   its own independent origin (separate uuid-keyed dedup stream), with `(epoch, seq,
   origin)` LWW resolving per key. Per-partition sequencing is safe ONLY with a single
   in-order source per partition — i.e. R-way + a coordinated, **drained** handoff
   (commit-ack), so the epoch transition is a barrier, not a broadcast race. It therefore
   belongs WITH partitioned holding, built to that shape — not speculatively under
   broadcast, where it would *reduce* robustness for zero scaling benefit.

**Decision.** **Stop at Milestone V.** Keep the per-origin + epoch-fenced-LWW core — it
is correct, convergent, and more handoff-robust under full broadcast than per-partition
would be. **Partitioned holding** (routed/async non-local reads + R-way + per-partition
sequencing + commit-ack drain + the V deferrals above) is a future milestone, gated on a
deliberate decision to make non-local reads async. Until then fero is a fully-replicated,
view-synchronous, linearizable-per-partition store with synchronous local reads — which
is the right default for its target scale.
