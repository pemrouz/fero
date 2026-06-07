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

**Doing F correctly needs one of (→ [IDEAS → Partitioned ownership & routing](IDEAS.md)):**
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

**Still open → [IDEAS → Partitioned ownership & routing](IDEAS.md):** F1 keeps full
broadcast, so it does NOT yet cut fan-out. **F2** — per-partition sequencing + R-way replication
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

**Still open → [IDEAS → Partitioned ownership & routing](IDEAS.md):** stronger epoch
fencing (REJECT a stale-epoch write from an evicted node — needs the per-partition owner lineage +
uuid↔address) and the commit-ack drain land with **F2** (per-partition sequencing +
R-way replication — the fan-out scaling win) and **F3** (owner failover continuity).
Buffered writes currently flush under the current epoch (win LWW on rejoin) — preserving
the attempt-epoch is an F2 refinement. Two-established-cluster merge works via the
lowest-coordinator + epoch-ordering path but isn't dedicated-tested (chaos backlog);
a sub-quorum remnant stays read-only (CP) — a force-to-solo (AP) degrade is deliberately
not offered. Incarnation numbers (flapper fencing beyond the debounce) deferred.

## F2 — Per-partition sequencing / R-way replication: deferred to partitioned holding · Investigated · (no code)

**Context.** F1 + V give owner-routed writes with stable per-epoch ownership. The last
owner-routing goal ([IDEAS → Partitioned ownership & routing](IDEAS.md)) was F2: cut replication fan-out from
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

> **Superseded by Milestone P (F2 *and* F3).** The user took the deliberate decision F2
> was gated on ("go option 2 — partitioned holding, non-local reads become async"). F2's
> two findings still hold and shaped P's design: per-partition sequencing is done WITH
> scoping (not under full broadcast), and the per-origin core is preserved unchanged for
> R=∞. **F3 (owner-failover version continuity) is obviated, not deferred:** it was the
> *per-partition-sequencing* answer to handoff — the next owner continues the partition's
> single counter, with `(version, owner)` breaking split-brain ties. P keeps the
> **per-origin** core instead, so a handoff O1→O2 needs no shared counter to continue
> (each owner writes under its own uuid-keyed stream) and split-brain ties resolve by
> `(epoch, seq, origin)` LWW (V1d), not `(version, owner)`. The only residue of F3 still
> open is the **reject-stale-epoch-from-an-evicted-node** fence (owner lineage +
> uuid↔address), tracked under [IDEAS → Partitioned ownership & routing](IDEAS.md).

## P — Partitioned holding (R-way replication) · Adopted · `b079b26` (P0) → P2

**Context.** The user chose "option 2" from the F2 deferral: make holding R-way (each
partition on R replicas, not every node) so storage + write fan-out scale O(R) not O(N),
accepting that non-local reads become async/routed (Milestone Q1). Reads become
**hold-relative**: synchronous for partitions a node holds, `await`/subscribe for those it
doesn't. Built centerpiece-first as increments, each gated by the full suite AND an
**adversarial review workflow** (the reviews caught two classes of real defect before
commit — see below).

**P0 — replica-set seam (`b079b26`).** `cluster.replicas(key)` (owner + R-1 ring
successors) + a `replicas: R` config, default ∞ = full replication (byte-identical to
pre-P). Pure routing surface; the ring math (`dht.owners`) already existed.

**P1 — DROPPED (not committed).** The plan was to re-key dedup/catch-up to
(origin,partition) "under the full-replication safety net" first. The P1 review found this
**regresses the anti-entropy path for zero full-replication benefit**: (a) the digest
grows O(origins) → O(origins×partitions) ≈ every key, re-sent on every reconnect; (b)
`recordsSince` grouped by (origin,partition) yields gapped seqs (the Lamport clock is
global), so `encodeFrames` emits one frame per record instead of one. Root cause was a
*planning* error — per-(origin,partition) only helps once holding is scoped; under full
replication per-origin is strictly better. Reverted; folded into P2, gated on R.

**P2 — scoped R-way replication.** Granularity is **gated on R, fixed per instance**, so
full replication (R=∞) keeps the per-origin path byte-for-byte:
- **Log/dedup granularity** (`Log({scoped})`, resource `seenKey`): R=∞ keys by origin
  (compact digest, coalesced frames); finite R keys by (origin,partition) so each
  partition's stream is independently complete (single owner-sequencer → gap-free), the
  digest is bounded to held partitions, and an acquired partition re-syncs from seq 0.
- **Held-set materialization**: `holds(key)` = me ∈ owners(key,R) (short-circuits to true
  when R≥members — no ring scan on the hot path). The `onRecord` wrapper drops inbound
  records for partitions we don't hold; a foreign write we originate is forwarded to the
  owner and the optimistic local value dropped (`dropLocal`).
- **Scoped delivery**: the owner commits and `replicatePeers(change,R)` to the OTHER
  replicas (vs `broadcast`); R≥members falls back to broadcast (avoids an owners() scan).
- **Scoped catch-up**: the digest carries the sender's LISTEN address; the responder
  filters `recordsSince` to partitions the requester holds (per the ring), so it ships
  only what the requester replicates — yet still re-ships a partition the requester is
  ACQUIRING (absent from its vector). `recordsSince` sorts by (origin,seq) so frames
  coalesce.
- **Acquisition re-sync** (the P2-review blocker fix): anti-entropy was only triggered by
  `onConnect`, never on view commit, so a node that joined and acquired partitions on the
  ring rebalance **never received their history → silent R→R-1 under-replication (data
  loss)**. Fixed by re-syncing on `ViewManager.onCommit` (immediate, after the new ring
  installs) AND a **periodic anti-entropy timer** (`antiEntropy`, default 1000ms, scoped
  only) — the robust backstop for the commit-order race (a commit-triggered digest can
  reach a peer that hasn't committed the new view yet) and ordinary drift. The reciprocal
  digest heals both directions, so a current holder ships the acquirer its share.

**Consequences / known limitations (carried to IDEAS, gated on later milestones).**
- **Orphans tolerated.** A former replica after a ring expansion, a write committed during
  the formation window, a never-drop fallback at an unreachable owner, or a transiently
  misrouted forward can leave an *extra copy* of a partition on a non-replica. These are
  not data loss — acquisition re-sync ensures the partition's true R-set holds it — but
  they violate "exactly R replicas". **Shedding** them safely needs P4's drained barrier
  (shedding before the new replica has acquired would lose data), so it's deferred to P4.
- **Digest is O(held keys)** per node (bounded by R/N of the keyspace). A Merkle/range-hash
  compaction is the deferred **P3** refinement; until then periodic AE re-ships the full
  per-(origin,partition) vector.
- **`holds()` allocates** (owners() array) per inbound record when R<members; an
  allocation-free ring predicate is a perf follow-up.

**Decision.** Holding is R-way and durability-safe under membership change (acquisition
heals to R). Full replication (R=∞) is unchanged and remains the default. Reads stay
synchronous-and-local for held partitions; **Q1** makes non-local reads `await`/subscribe.
P4 (orphan shedding) and P3 (digest compaction) refine it.

### P4 — Confirmed orphan shedding · Adopted

**Context.** P2 left ORPHANS — partitions a node holds but no longer replicates (a former
replica after a ring expansion; a write committed locally at a non-replica via the
never-drop fallback or a misrouted forward). P2 healed durability (the true R-set acquires
the data via anti-entropy) but tolerated the orphan as an EXTRA copy, violating "exactly R
replicas". P4 sheds them.

**Design — keep-until-confirmed (no consensus change).** The "no under-replication window"
property falls out of *when* we shed, not of gating the view-change ballot: an orphan is
KEPT until a current R-set member is confirmed caught up, so the partition stays ≥R
replicated throughout the handoff (the old holder holds the fort until the new R-set has
it), then the orphan drops.
- `orphans: Set` — populated on view commit (`markOrphans` scans `log.partitions()` for
  `!holds`) and in `commitLocal` (a write committed where `!holds(p)`).
- `shedConfirmed(peerMarks, peerMe)` runs on every digest (both reciprocal legs): for each
  orphan, if the sender is a current R-set member AND its marks cover ALL our
  (origin,partition) records, record it caught up; **shed only once EVERY R-set member is
  confirmed**. Single-confirmation is UNSAFE — if a partition's R-set moves entirely
  (`{A,B}→{C,D}`), shedding A as soon as C is caught up (before D acquired) leaves the
  partition on `{C}` alone (1 < R). Conservative throughout: a missing/lower peer mark
  keeps the orphan — **no data can ever be lost**.
- `shed(p)` is a COMPLETE in-memory removal: proxy (guarded), log segment + provenance
  index (`Log.drop`), `seen` marks, `versions`. After it, the node no longer advertises p
  in its digest.
- Perf: `commitLocal` computes the R-set ONCE (`mesh.owners` → `mesh.replicateTo(rset,…)` +
  the orphan check reuse it) instead of a second `holds()` ring scan per scoped write
  (review finding). All P4 work is scoped-gated; R=∞ is untouched.

**Adversarial review.** The window bug above was found independently and fixed
(multi-confirm) before the review; the review's verifiers actually *under-called* it
(dismissed), confirming the value of not relying on a single check. A 4-node FULL-R-set-move
test exercises the multi-confirm path (no loss, eventual exactly-R).

**Known limitations (deferred, documented).**
- **Durable shed.** `shed()` is in-memory only; the append-only WAL (`fileStorage`) still
  holds the partition, and restore replays it through `applyInbound` (no held-gate on the
  restore path), so a scoped node WITH storage resurrects a shed orphan across a restart
  (re-advertises it until it rejoins and re-sheds — self-healing, no data loss). A durable
  shed needs a tombstone / WAL compaction — folded into the already-deferred WAL-compaction
  work (IDEAS). Only affects `{replicas:R, storage:…}`.
- **NUL in keys.** Shed's suffix matching (and the existing `versionKey` / `originKey`) use
  `\x00` as a separator, assuming top-level keys contain no NUL byte — an inherited library
  assumption, not new to P4.

**Decision.** A partitioned cluster converges to EXACTLY R replicas per partition, with no
under-replication window during handoff and no data loss. The drained-ballot variant (gate
commit on catch-up) is unnecessary given keep-until-confirmed, so it's dropped from the
roadmap.

## Q1 — Hold-relative reads (owner-routed `read` + `data.x` facade) · Adopted

**Context.** With R-way holding, a node materializes only the partitions it replicates, so
non-local reads must be routed. Reads become **hold-relative**: synchronous-and-local for a
partition the node holds, a **remote handle** (await ⇒ one-shot, reactive ⇒ subscribe) for
one it doesn't. The user chose "both" — an explicit owner-routed read engine PLUS a
transparent `data.x` facade over it.

**Design.**
- **Keyed read**: the default `read` method is now `read()` ⇒ whole data, `read(key)` ⇒ the
  child view. On a holder, `c.data[key]` is the live local child — snapshot for an RPC,
  streamed for a subscription, through the existing serve machinery.
- **Owner-routed handle** (`makeHandle`/`remoteRead`): a thenable+ViewProxy targeting a
  specific peer. A server is fully meshed with the owner → routes straight to `owner(key)`;
  a client routes to a picked server which **forwards** the read to the owner (read-
  forwarding in `serveCall`/`serveSubscribe` for any `read(key)` it doesn't hold — so a
  client reaches every partition through one server). `transport.call/subscribe` gained an
  optional target-peer arg.
- **`data.x` facade**: a Proxy over the returned `data` — a top-level KEY access is
  hold-relative (`readKey`); operators, built-ins, symbols, writes (top-level + depth-1
  nested) pass through to the raw proxy. Built only for a scoped server or a client; a
  full-replication server returns the RAW proxy (transparent no-op — hot path unchanged).
  `holds()` is memoised per key (cleared on view commit) so a facade read is O(1), not an
  O(R) ring scan per access.

**Adversarial review (fixes folded in).** Confirmed + fixed: prototype-name keys leaking
through `prop in Operators` (→ own-key `hasOwnProperty` check); root write-ops
`data.update/insert/remove` misread as keys (→ added to the passthrough set); depth-1
nested writes into a non-held partition silently dropped (→ a `set` trap on the read handle
routes them to the raw proxy → owner); a per-read ring scan (→ the holds() memo).

**Known limitations (documented; the explicit owner-routed read is the robust fallback).**
- **Operator-name key collision**: a partition genuinely named like an operator (`filter`,
  `group`, `map`, …) or a built-in (`connect`, `update`, …) can't be READ through `data.x`
  (the facade returns the operator) — read it via the snapshot (`data[value][key]`) or the
  routed method; writes are unaffected.
- **Deep nested writes** (`data.x.y.z = v`) into a NON-held partition aren't routed
  (depth-1 is) — use a top-level assignment `data.x = {…}` or operate on the holding node.
- **`await data.x.field`** on a non-held key resolves the not-yet-populated subscription
  rather than a one-shot of the field — `await data.x` then read the field.
- **Read-your-writes** can lag if a write's owner-forward FAILS (committed as a local
  orphan, but the read routes to the stale owner until anti-entropy reconciles).
- **Subscription cleanup on ungraceful disconnect** (a pre-existing gap, now also affecting
  forwarded subscriptions) — needs a peer-disconnect hook; deferred (IDEAS).

**Decision.** Reads are hold-relative: local+sync where held, owner-routed remote handle
where not, with a transparent `data.x` facade for ergonomics over a robust explicit engine.
The facade is best-effort sugar with documented edges; the routed read is the guarantee.

## Q2 — Decomposable distributed aggregates (owner-scoped fan-out + fold) · Adopted · Q2a–Q2f

**Context.** With R-way holding ([P](#p--partitioned-holding-r-way-replication--adopted--b079b26-p0--p2))
no single node materializes the whole resource, so an aggregate over ALL of it
(`data.sum('value')`, `.length()` (count), `.max/min/avg`, `.some/every`) can't run locally.
Q2 is the first slice of the L3 "distributed operator graph" the architecture files under
"later": each holder runs the aggregate LOCALLY over its shard, streams a partial, and the
querying node folds the partials into the global — one row change → one partial delta → an
O(holders) global update. Built as V-style increments (Q2a–Q2f), the risky ones gated by an
adversarial-review workflow (it earned its keep — see below).

**Decision — owner-scoped fan-out + fold.**
- **Dedup = OWNER-scoping (Q2a).** A partition lives on R replicas but has exactly ONE
  owner, so each holder aggregates ONLY the partitions it OWNS (`data.filter((_v,k) =>
  mesh.owner(k) === me).<op>()` over the RAW proxy). The union across holders is a DISJOINT
  cover of the keyspace — every row counted exactly once regardless of R. A serializable spec
  `{op,col[,val]}` crosses the wire (the `aggregate` default method); each symmetric holder
  reconstructs the same owner-scoped operator locally — the NAME/shape travels, not a closure.
- **Fold (Q2b).** `await data.sum('v')` is a one-shot gather (`foldOnce`); reactive use opens
  a live fold (`openFold`) that subscribes to every holder's partial and refolds per delta.
  SELF IS NOT A WIRE TARGET (`pool.peer(me)` is undefined) — the querier's own shard is
  obtained IN-PROCESS and folded alongside the N-1 remote partials (miss it ⇒ a 1/N
  undercount, the blocker the review caught). Combine rules: sum/count → Σ; max/min →
  extremum skipping `undefined`; avg → Σsum/Σcount (divide LAST); some → Σ(match) > 0; every
  → Σmatch === Σtotal.
- **View-change rebind + churn (Q2c).** data's `filter` only re-runs its predicate on a ROW
  change, never when a partition changes OWNER under a stable row — so each node RE-SCOPES its
  own owner-scoped partials on its own commit (`livePartial`, a generation-guarded rebuild
  since data's `FunctionSink` can't be synchronously disconnected). Subscriptions PERSIST
  across a commit (a stable holder pushes its re-scoped value), so the coordinator only
  reconciles membership (add new / drop departed / RETRY the admit race on the aeTimer).
  Acquired partitions heal in (the rebuilt partial stays connected to the live `data`).
- **avg + some/every (Q2d).** avg ships a `{sum,count}` PAIR (AvgValue exposes only the
  quotient, which can't combine); some/every take a DECLARATIVE predicate `(col[,val])` — a
  closure can't cross the wire, so an inline closure on the facade is REJECTED LOUDLY.
- **Client server-as-coordinator (Q2e).** A read-only client can't owner-scope/fold, so its
  facade aggregates route to its connected server with `{fold:true}`; the server folds and
  streams the GLOBAL back. The fan-out STRIPS the flag (holders return partials) — no recursion.
- **Q3 boundary guard (Q2f).** Holistic/ordered ops (az/za/top/limit, group, distinct,
  reduce) and length(fn)/closures can't fold from partials — on a scoped facade they return a
  LOCAL result but WARN LOUDLY (once per op), never silently mistaken for the global.

**Adversarial reviews caught real defects before commit.**
- Q2b: the SELF-routing 1/N undercount; a `sumRule` `|| 0` masking a NaN partial to 0 (→
  `?? 0`, propagate NaN like the single-node path); a GC-freeze of derived partial chains
  (data's `FunctionSink` doesn't back-ref its source → retain the source proxy alongside the
  sink host, also hardening Q1 custom-read subscriptions).
- Q2c: a BLOCKER reproduced at ~30% — `mesh.subscribe` returned a truthy unsub even when the
  SUBSCRIBE was DROPPED on a not-yet-writable socket (the admit race), so the retry was
  suppressed and a holder's shard dropped FOREVER. Fixed by gating subscribe on a new
  `peer.writable` (not `write()`'s false, which also covers backpressure). Plus a
  data-corruption path found by hand: a stale subscription delta (a frame with an id but no
  matching sub, arriving after a churn unsubscribe) fell through to `onRecord` and clobbered
  the root → drop id'd frames with no sub (plain replication never carries a frame id).
- Q2 capstone (the integrated surface): `data.some/every('col')` CRASHED ("fn is not a
  function") on the `R ≥ members` facade branch — it forwarded the column STRING to data's raw
  some/every, which need a predicate FN; the only some/every test took the `R < members` fold
  path. Fixed by routing some/every through the fold even at `R ≥ members` (the fold
  reconstructs the predicate from `(col,val)`; correct for any R). Also: `avgRule` kept `|| 0`
  where sumRule had been fixed to `?? 0`, so a NaN-poisoned local shard masked to 0 → `?? 0`.
  (Full replication's `some/every('col')` is a documented limitation, not a regression — →
  [IDEAS / Aggregates].)

**Consequences.**
- Full replication (R=∞) is UNCHANGED: the facade isn't built (raw proxy returned), so the
  hot read/write paths are byte-identical (`index.perf.ts` 150ms threshold holds on every
  increment). Every Q2 path is gated on `scoped` / `R < members`.
- Steady-state (after a membership change settles) the fold is exact; transients during
  settling are eventual-consistent (same posture as P2 acquisition / Q1 read-your-writes).
- Decomposable = a fixed associative combine over disjoint per-OWNER partials, each a single
  streamable ViewProxy (or a `{sum,count}`/`{match,total}` pair). HOLISTIC (gather-to-one /
  user combine) and CHAINED aggregates (a grouped aggregate `group.sum`, or any aggregate past
  the facade's first hop) are L3-planner work — drawn and POLICED by the boundary guard, not
  crossed silently.

**Still open → [IDEAS → Distributed query & aggregates](IDEAS.md).** The **named-method fold** (a method
returning a decomposable aggregate, run per-holder over owner-scoped data, combine derived
from the operator type — the function-carrying dispatch for closure predicates + grouped
aggregates); **group bucket→rows + top/limit-K + length(fn)** (the L3 chain planner / a
gather engine; top-K needs `applyRecord` 'move' support — [DECISIONS E](#e--live-subscriptions-server-push--adopted--27e687f));
**gather-hardening** (a bounded one-shot deadline + a partial-result signal vs the
slow/departed-holder silent undercount); **per-handle GC teardown** of an abandoned fold +
**ungraceful-disconnect** subscription cleanup; **chained-aggregate auto-detection** past the
facade's first hop.

## Q3 — Whole-resource read() = distributed gather (holistic ops after read) · Adopted · Q3a–Q3b

**Context.** Q2 distributes the DECOMPOSABLE aggregates (a fixed associative combine over disjoint
owner-scoped partials). The HOLISTIC ops — unbounded sort (`az/za/top/limit`), `distinct`, bare
`group`, general `reduce`, exact median/percentile — can't fold from per-shard partials: the global
answer needs the full multiset co-located, and the user logic (`reduce`'s closure, a sort
comparator) can't cross the wire (Q2's hard rule). The user's framing settled the API shape: the
efficiently-distributable ops work WITHOUT a read; **anything needing the whole resource comes AFTER
`read()` — `read()` IS the download** — which forces the O(N) cost to be visible in the code; and a
holistic result can be promoted to its own **derived named resource**. So Q3 is not a new `gather()`
primitive — it makes whole-resource `read()` an actual distributed gather (today it silently returns
the contacted node's local shard under scoping — fine under full replication, a partial under R-way).

**Decision — `read()` (no key) under scoping folds owner-scoped ROWS into the whole resource.**
- **Gather = the Q2 fold with a union rule (Q3a).** A new internal spec `{op:'rows'}` returns the
  holder's owner-scoped `ownedView()` (a disjoint cover — each partition shipped once, 1× wire);
  `RULES.rows` = `Object.assign({}, …partials)` (union by key). `foldOnce`/`openFold`/`foldAggregate`
  are reused verbatim — the gather is just a fold whose partials are row-set OBJECTS and whose combine
  is union. Union-by-key is IDEMPOTENT, so it tolerates transient ring disagreement a scalar Σ can't
  (two holders briefly claiming a key land it once, not twice); deletes/ownership-moves converge via
  full-union-recompute + root-replace. The **closure problem dissolves**: holistic ops run LOCALLY on
  the gathered proxy (`methods.read().az('v')`, `.reduce(fn)`) — only ROWS cross the wire, never
  functions, and `data`'s positional `'move'` deltas stay local (no [DECISIONS E] dependency).
- **Client gather, server-as-coordinator (Q3a).** A client's `read()` routes to the server it dialed,
  which folds (`serveCall` ⇒ `foldOnce`; `serveSubscribe` ⇒ `openFold`). The reactive subscribe branch
  is UNGATED on R (membership-robust — `openFold.reconcileMembers` re-arms on commit). A branch gated on
  membership-at-subscribe let a `read()` opened while members≤R stream the server's local `c.data`
  forever and go silently PARTIAL once a join sharded the resource (the Q3a review's confirmed major —
  grow-past-R regression test added). The stateless `serveCall` one-shot keeps the `R<viewSize()`
  local-read optimization (it re-evaluates per call).
- **Server gather + holistic-after-read (Q3b).** A scoped server's own no-key `methods.read()` is the
  gather HANDLE — `await` ⇒ one-shot global, reactive ⇒ live gather. Only the DEFAULT `read` is swapped
  (a user-supplied `read` is their projection); MEMOIZED to one handle per node. In-handler
  `c.methods.read()` is the same handle (await ⇒ global, reactive ⇒ live, sync `[value]` ⇒ the
  in-progress union); a handler reads `c.data` for the local held state.

**Adversarial review caught real defects before commit.**
- Q3a: a BLOCKER — the reactive gather gate evaluated once at subscribe went silently partial when the
  cluster grew past R (fix: ungate the subscribe branch on R; the gather is correct at any R and
  re-arms on commit; the grow-past-R regression was verified to FAIL under the old gate).
- Q3b: three majors, all from mutating `localMethods.read` in place + returning a live handle —
  **M1** a custom `read` was silently swapped for the raw gather under scoping (fix: gate the override
  AND the Q3a wire branches on `allMethods.read === defaults.read`); **M2** a handler RETURNING
  `c.methods.read()` replied with the fold's empty in-progress union because `snapshot()`'s
  isViewProxy/`[VALUE]` probe opened the live fold (fix: resolve a returned handle via `foldOnce`,
  detected by a side-effect-free `FOLD_HANDLES` WeakSet — probing the resolver symbol on a `data`
  ViewProxy throws "Cannot convert a Symbol to a string", which the first fix attempt hit and the
  existing client-read tests caught); **M3** a fresh `foldAggregate` per reactive call leaked an
  O(resource) union-fold into `aggregateReconciles` forever (fix: memoize one handle per node).

**Consequences.**
- Full replication (R=∞) is UNCHANGED: the facade isn't built and `read()` isn't overridden / gathered,
  so the hot read/write paths are byte-identical (`index.perf.ts` holds). Every Q3 path is gated on
  `scoped`. New `gather.perf.ts` guards the rows-partial build (~4ms/10k) + union fold (~10ms/10k).
- The gather is honestly O(N): O(total rows) transfer + an O(total) union recompute per shard delta (a
  live holistic-after-read recomputes the whole answer). That's the explicit "download everything" cost
  — guarded against superlinearity, not against itself. Calling a holistic op DIRECTLY on `data` (no
  read) still returns a LOUD local-only result (never a silent gather) and the warning points at
  `methods.read().<op>()` / a derived named resource.
- median/percentile (deferred — `data` has no such operator; the user computes over the gathered set),
  and the user-supplied COMBINE path (ship per-shard partials, fold without the full gather) are NOT in
  Q3 — the combine needs per-holder logic, i.e. pre-deployed functions (the named-method fold seam).

**Still open → [IDEAS → Distributed query & aggregates](IDEAS.md).** **median/percentile/quantile** terminals over
the gathered set; the **user-supplied combine / named-method fold** (the scalable alternative to the
O(N) gather); **gather-hardening** (a bounded one-shot deadline + partial-result signal; the
union-recompute is O(N)/delta — an incremental per-key merge is the perf follow-up); **per-handle GC**
of an abandoned gather handle + the **ungraceful-disconnect** subscription leak (now also via the
gather's `openFold` — shared transport-layer infra, an `onPeerGone` hook + a peer→subId reverse index);
and **server-side `methods.read(key)`** owner-routing (today LOCAL — the `data[key]` facade routes).

## L4 — Chaos test harness + reversible partition seam · Adopted

**Context.** The L2 suite proved SINGLE faults via full-node `destroy()` (failover, eviction,
quorum-loss, acquisition, shedding), each re-implementing the same N-node spin-up. Two gaps
remained ([IDEAS testing/chaos backlog](IDEAS.md)): no reusable harness, and no FAITHFUL network
partition — every failure test KILLED the node, so the *alive-but-unreachable* path (the V0 failure
detector's whole reason to exist) and partition→HEAL convergence were untested. The only
fault-injection primitive, `diagnostics.drop` (→ `peer.destroy`), is terminal and one-directional —
it can sever but never heal.

**Decision.**
- **Reversible isolation seam** (`Peers.isolate/heal` → `mesh.isolate/heal` →
  `instance[diagnostics].isolate/heal`). `isolate(address)` severs the dialed link AND adds the
  address to a `#blocked` set so it can't redial — directly OR via handshake gossip-revival (a bridge
  node re-announcing it through `learn` → `addServer` → `add`). Used SYMMETRICALLY (the harness
  isolates both sides) it is a true bidirectional partition: every broadcast / catch-up / forward
  travels over the DIALER's outbound socket, so cutting both dials cuts both directions and the
  inbound sockets close with them. `heal(address)` unblocks + re-dials by listen address → reconnect →
  handshake → anti-entropy → view re-admit (a rejoin WITHOUT a process restart). **Zero steady-state
  cost**: an isolated peer leaves `#conns`, so `broadcast`/`sendTo` skip it with no new check;
  `#blocked` is consulted ONLY in the cold `add()` dial path (empty set ⇒ a no-op in production) —
  `index.perf.ts` is byte-unchanged.
- **Reusable harness** ([tests/chaos/harness.ts](tests/chaos/harness.ts)) — one
  `cluster({ n, replicas, … })` factory with the lifecycle the ~30 inline tests duplicated (spin-up,
  `formed`, `node(addr)`, `place`, `converged`, `kill`/`restart`/`add`, `client`) plus the chaos ops
  (`partition`/`heal`, leak counters). Built on `#utils` + the diagnostics seam.
- **Cluster chaos tests** ([tests/chaos/cluster.test.ts](tests/chaos/cluster.test.ts)) — 5-node
  multi-origin convergence; network partition→heal (majority writes, minority read-only + buffers,
  both reconverge); crash→recover (WAL restore + catch-up); membership churn (re-agrees on one view,
  converges); a seeded randomized soak. `npm test` now globs `tests/chaos/*.test.ts`.
- **Wire-robustness gaps filled** — a real-socket large frame (>1 TCP segment reassembles end-to-end,
  [peer.test.ts](transport/peer.test.ts)); the handshake state machine + control-frame straddle +
  malformed-identity ([handshake.test.ts](transport/handshake.test.ts), which did not exist). The
  malformed/hostile-frame decode guards + the encode→decode and single-byte-corruption fuzz loops were
  ALREADY covered ([message.test.ts](transport/message.test.ts)) — that IDEAS entry was stale and is
  trimmed.

**Consequences.**
- A true partition is now testable end-to-end: the minority side goes read-only (V1e write-gate) and
  buffers, the majority progresses, heal flushes the buffer + anti-entropy reconciles, all nodes
  reconverge — exercising the V0 detector + eviction + write-gate + rejoin path a plain kill never did.
- The randomized soak is topology-sensitive (random ports → random ring → random coordinator/majority),
  so it asserts the END invariant (re-merge + convergence + every *majority-committed* key present), not
  a fixed timeline. Multi-node TCP timing means every assertion is `until`-polled and the suite stays
  serial (`--test-concurrency=1`, see [F1](#f1--owner-routed-writes-via-forwarding-owner-re-sequencing-phase-1--adopted)).

**Still open → [IDEAS](IDEAS.md):** row-pruning leak under churn (a dead peer leaves a `disconnected`
row — the churn test asserts convergence + single-view agreement, not leak-free, until pruning lands);
`client refused before ready`; DHT distribution-bound tightening + `owners()` distinct-R under churn;
dial-cap/jitter chaos once the reactive dial loop lands.
