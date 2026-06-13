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
per-origin high-water **digests** (`Log.marks()` / resource's `seen`) and
each ships the records the other lacks (`Log.recordsSince(vector)`, framed by
`catchupTo`). The receiver folds them through dedup + LWW. Reconnect is automatic:
a dropped dial → Peer retry → handshake re-fires → digest again. The handshake
itself stays **membership-only** — state-sync is an L1/L2 `onConnect` concern, not
carried in the handshake frames.

**Open follow-ups → IDEAS:** Merkle/range digest for huge logs; stream the diff
instead of allocating the tail; asymmetric reachability (catch-up over an
inbound-only link); a partition-heal chaos test (L4).

## B1 — Epoch-aware catch-up: skip-log permanent epoch-losers · Adopted

**Context.** [B](#b--catch-up-on-reconnect-via-per-origin-digest--adopted--980ead9)
folds catch-up records through the same `applyInbound` dedup+LWW path as live
replication. With epoch-fenced LWW ([V1d](#v--view-synchronous-membership--adopted--5c45e61--1d8c533)),
a record committed under a SUPERSEDED view (lower `epoch`) can never win — a newer
view already wrote the key. Yet `applyInbound` still **logged** every such record
("loser stays logged"), so a fresh joiner or a healing peer accumulated the full
dead history of every key that changed hands across a view change, and re-shipped it
on the next anti-entropy round. Pure waste — those records can only ever lose.

**Decision.** In `applyInbound`, BEFORE `log.append`, short-circuit a record whose
versionKey already holds a **strictly-higher-epoch** winner (`cur.epoch > record.epoch`):
emit the `observe` `lost` event and return — **don't log it, don't apply it**. The
dedup high-water (`seen`) STILL advances, so anti-entropy never re-fetches the dead
record (a sticky skip). A SAME-epoch loser is unchanged — it stays logged (it's part
of the per-origin history a tie or another key may need).

**Why it's safe (no data loss / no divergence).**
- We skip ONLY when we already hold + logged the dominating winner (the skip condition
  reads `versions`, set when a winner is applied). So every LIVE value stays present;
  only a superseded copy is dropped. By construction the winner is always there to ship.
- Each `(origin,partition)` stream arrives **in order** from its single owner (the
  invariant the whole dedup/LWW core rests on — [F1](#f1--owner-routed-writes-via-forwarding-owner-re-sequencing-phase-1--adopted)).
  So a live value below a skipped seq was processed — and logged — EARLIER in the run;
  `seen` advancing past the skipped seq honestly still means "every live value ≤ this
  seq is present." The log gains gaps only at dead seqs.
- The log stays the complete history of WINNERS, so a peer catching up from us still
  receives every live value (and gets each superseded key's winner, which we logged).

**`seen` may now exceed `log.marks()`** by exactly the skipped seqs. The one consumer
that conflated them — `shedConfirmed` (P4 orphan shedding) — now confirms an R-set
member against `log.marks()` (the **shippable** high-water), NOT `seen`. Requiring a
peer to reach a skipped seq we can never re-ship would hang the shed forever; shedding
at the lower log mark is safe because the skipped seqs are superseded (the peer holds
their winner). Outgoing digests stay `seen`-based (so peers don't re-ship us dead
records). The inspect `marks` field stays `seen` (it is, accurately, the dedup digest).

**Consequences.**
- Smaller logs + less catch-up bandwidth on a cluster that has changed ownership — the
  per-key dead history no longer rides along forever; it persists only at original-era
  holders (further trimmable by the deferred log-compaction workstream).
- Steady-state hot paths are untouched: a LOCAL write goes through `commitLocal` (not
  `applyInbound`); `shedConfirmed` runs only on a digest when orphans exist. `index.perf`
  / `log.perf` thresholds hold; the full suite + chaos (partition/heal, crash/recover,
  churn, soak) converge. A deterministic restore-seam test drives the skip directly
  (epoch-loser skipped-but-seen; same-epoch loser still logged).
- Supersedes B/V1d's "loser stays logged" for the strictly-lower-epoch case ONLY.

**Open follow-ups → [IDEAS](IDEAS.md):** the rest of the Catch-up & anti-entropy
hardening workstream (Merkle/range digest, smarter peer-selection, stream the diff,
asymmetric reachability) is unaffected.

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
(`commitForwarded`), so it commits under `origin=owner`, logs, and replicates the
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
  owner and the optimistic local value dropped (`discardOptimistic`).
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

### P4a — Invalidate stale shed-confirmations on an orphan high-water bump · Adopted

**Context.** P4's `shedConfirmed` accumulates, per orphan partition, the set of R-set members
confirmed caught up (`shedReady`), and sheds once EVERY member is in it — the multi-confirm
safety that gives "no under-replication window". A confirmation was recorded against the orphan's
high-water *at that moment* and never re-validated. But `commitLocal`'s **never-drop fallback** (a
write whose owner is unreachable while we still hold quorum) appends a FRESH winner to an
already-orphaned partition, RAISING its shippable high-water — and left `shedReady` untouched.

**The bug (found by [B1](#b1--epoch-aware-catch-up-skip-log-permanent-epoch-losers--adopted)'s
adversarial review, confirmed by a logic-mirror reproduction).** A member confirmed against the
OLD (lower) mark stays in `shedReady`; after the high-water rises, another member confirming
against the NEW mark completes the R-set and triggers `shed()` — even though the first member
never received the new record (and, being the unreachable owner, couldn't have). The orphan drops
with the new write on fewer than R replicas → under-replication, and permanent loss if the lone
acquirer then fails. This defeats P4's own invariant, on exactly the owner-down condition P4
exists to survive. It is **independent of B1** — the original `seen`-based gate grew the same way
via `commitLocal`; B1 only changed the gate's *source* (`seen`→`log.marks()`), not this staleness.

**Decision.** When `commitLocal` commits a record onto an orphan (`!rset.includes(me)`), clear
`shedReady[p]`. The fresh winner raised the high-water, so every prior confirmation is stale —
force ALL R-set members to re-confirm against the new mark before we shed. Conservative (the P4
posture throughout): re-confirming costs at most a few anti-entropy rounds; the unreachable owner
that forced the never-drop is exactly the member that must re-confirm, so it can't be skipped. The
only growth path for an orphan's high-water is this never-drop commit (inbound records for a
partition we don't hold are held-gated out before `applyInbound`), so this one site is the
complete fix. Scoped-only; R=∞ never orphans.

**Consequences.** A never-drop write into an orphan now converges to the full R-set and sheds only
after every member (incl. the healed owner) re-confirms — no under-replication, no loss. A new test
drives the never-drop-into-orphan path (which the other P4 tests never hit — they have no
isolation, so every write forwards) via an isolated owner and asserts convergence + clean shed; the
existing multi-confirm shed tests are unchanged.

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
- **Fold (Q2b).** `await data.sum('v')` is a one-shot gather (`gatherOnce`); reactive use opens
  a live fold (`gatherLive`) that subscribes to every holder's partial and refolds per delta.
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
  `RULES.rows` = `Object.assign({}, …partials)` (union by key). `gatherOnce`/`gatherLive`/`foldAggregate`
  are reused verbatim — the gather is just a fold whose partials are row-set OBJECTS and whose combine
  is union. Union-by-key is IDEMPOTENT, so it tolerates transient ring disagreement a scalar Σ can't
  (two holders briefly claiming a key land it once, not twice); deletes/ownership-moves converge via
  full-union-recompute + root-replace. The **closure problem dissolves**: holistic ops run LOCALLY on
  the gathered proxy (`methods.read().az('v')`, `.reduce(fn)`) — only ROWS cross the wire, never
  functions, and `data`'s positional `'move'` deltas stay local (no [DECISIONS E] dependency).
- **Client gather, server-as-coordinator (Q3a).** A client's `read()` routes to the server it dialed,
  which folds (`serveCall` ⇒ `gatherOnce`; `serveSubscribe` ⇒ `gatherLive`). The reactive subscribe branch
  is UNGATED on R (membership-robust — `gatherLive.reconcileMembers` re-arms on commit). A branch gated on
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
  `c.methods.read()` replied with the fold's empty in-progress union because `forWire()`'s
  isViewProxy/`[VALUE]` probe opened the live fold (fix: resolve a returned handle via `gatherOnce`,
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
gather's `gatherLive` — shared transport-layer infra, an `onPeerGone` hook + a peer→subId reverse index);
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

## R — Defensive decode against malformed/hostile frames · Adopted · `33afd1d`

**Context.** L0's lazy decoder ([message.ts](transport/message.ts)) trusted every length and count it
read off the wire. Fine on localhost; once a frame comes from an untrusted peer it is a remote DoS /
over-read surface. A 1-byte header claiming a ~4 GiB `bodyLen` grows the framer's reassembly `carry`
unbounded waiting for bytes that never arrive (OOM from a few bytes). A record `count = 2^28` drives
`new Array(count)` + a billion-iteration loop. An oversized `recLen` / key-segment / value length reads
past the buffer (or mis-aligns the next record). A reserved value-type nibble decodes to silent
`undefined`; a truncated f64 or a non-JSON object body throws a raw `RangeError`/`SyntaxError` that
escapes the framer's `try/catch` (the parse is lazy, forced downstream in `dispatch`/apply) and crashes
the receiving process. The [IDEAS] "[P1] Defensive decode" item flagged the `count`/`recLen` cases; the
fix covers the whole surface.

**Decision.** Bound every wire-supplied length/count against the bytes that actually remain; a violation
throws a typed `FrameError` (an `Error` subclass) so callers can distinguish a wire fault from a real bug.
- **Framer** caps `bodyLen` at `MAX_FRAME` (256 MiB, per-`Framer` overridable) BEFORE the straddle check,
  so a bogus header is rejected on sight instead of growing `carry`.
- **`records()`** rejects a `count` or `recLen` larger than the remaining body (each record needs ≥1 byte
  for its own `recLen` varint) — the headline `new Array(2^28)` / over-read fix; a truncated varint runs
  `off` past the body and is caught by the same `> length - off` test.
- **`prov()` + `RecordView`** bound the provenance origin, the key `nseg` + each segment, `at`, and str/obj
  value lengths; guard the f64 read (`off + 8 ≤ len`); wrap `JSON.parse` (corrupt object body →
  `FrameError`); and reject reserved vtype nibbles (7, 9–15) via a `default` case.
- **peer.ts** wraps the lazy `#onFrame` dispatch in a `try/catch`: a `FrameError` → `destroy()` the peer
  (mirroring the framer's existing structural-fault handling); any other throw still propagates, so a
  genuine handler/apply bug is NOT masked as "bad frame".

The guards are integer comparisons inside loops the decoder already walked — zero allocations, no
measurable cost (`message.perf` unchanged: decode 1.18 ms / 14 ms, scan 0.49 ms / 6 ms). Coverage: 13
malformed-frame unit tests (count/recLen overrun, oversized `bodyLen`, reserved vtype, truncated f64,
bad JSON, header-only graceful-wait) + two seeded fuzz loops — 3000 valid records round-trip (bounds
never false-positive) and 4000 single-byte-corruption trials assert every fault is a `FrameError`, never
a crash ([message.test.ts](transport/message.test.ts)).

**Consequences.**
- A malformed/hostile frame now deterministically drops the offending peer rather than crashing the
  receiver or amplifying a few header bytes into GBs of allocation.
- Bounds are *resource-proportional*, not checksum-authenticated: a peer that transmits 256 MB of
  valid-looking framing still allocates proportionally. The fix closes the small-input → huge-allocation
  / out-of-bounds vector, not authenticated flooding (a connection cap / backpressure is a separate
  workstream).
- `MAX_FRAME` is a module constant with a per-`Framer` override, not yet a `fero()` config knob — a single
  legitimate catch-up frame is bounded at 256 MiB (revisit if "stream the diff" lands a larger batch).
- The [L4](#l4--chaos-test-harness--reversible-partition-seam--adopted) record notes these guards in
  passing as "already covered"; this record is their authoritative provenance.

**Open follow-ups → [IDEAS](IDEAS.md):** none specific. Relates to the value-codec / wire-evolution
workstream — a CBOR value seam would move object decoding off `JSON.parse` entirely.

## S — Decomposing the `fero()` god-closure (composer + fold / dispatch / handle) · Adopted · `ceb4262` → `7c8db02`

**Context.** L2 was one 1337-line closure: the replication core (sink, dedup/LWW, holding, shedding)
co-lived with the aggregate engine, the RPC/subscription dispatch, the lazy handles, and the `data`
facade. plan §9 always intended a `dispatch.ts`/`projection.ts` split; two earlier increments had landed
the cheap parts (the `AGG` registry, the `lazyHandle` skeleton). The remaining lift was risky because
the inner functions are **mutually recursive** (`serveCall`/`serveSubscribe` → `gatherOnce`/`gatherLive`;
`gatherOnce` → `invoke` → `defaults.aggregate` → `buildPartial`) and several mutate shared state the
composer's `onCommit`/`aeTimer` loops iterate — so a naïve split risks a forward-reference cycle, a
by-value copy of state that should be shared, or a hot-path regression.

**Decision.** Split into a thin **composer** (`index.ts`) plus three modules, keeping the replication
core in the composer:
- **[handle.ts](resource/handle.ts)** — the stateless leaf: `lazyHandle`, `forWire`/`isViewProxy`,
  `FOLD_ONCE`/`FOLD_HANDLES`, `noop`. A *neutral* module both other modules import, so there is no
  `dispatch.ts ↔ fold.ts` import cycle and `FOLD_HANDLES` stays one shared identity (a handle registered
  by the fold engine is recognised by `forWire` called from the dispatch side).
- **[fold.ts](resource/fold.ts) `makeFold({...})`** — the aggregate engine (`ownedView`, `composite`,
  `buildPartial`, `livePartial`, `gatherOnce`, `gatherLive`, `foldAggregate`), joining the `AGG` registry.
- **[dispatch.ts](resource/dispatch.ts) `makeDispatch({...})`** — the RPC + subscription servers, the
  local/client method surfaces, the remote-read handles, and the `data` facade.
- **`index.ts`** keeps the core (write-capture sink, `applyInbound`/`commitLocal`/`commitForwarded`,
  `holds`/`heldCache`, P4 shedding, the Lamport/dedup/LWW state) as the composer body.

Two wiring choices made the split linear (no forward-ref): **(1) `invoke` stays in the composer** and is
injected into *both* factories — it doesn't itself depend on the engine, so the cycle resolves as
`invoke → makeFold(invoke) → makeDispatch(fold)`; every `fold.*` / `dispatch.*` call site is inside a
runtime arrow, so the `const`s late-bind. **(2) the `data` facade lives in `dispatch.ts`** (with
`readKey`/`makeHandle`/`clientHandle`), not in `fold.ts` as first planned — that removes the
`fold → clientHandle`/`readKey` back-edges and leaves `fold.ts` a pure engine. Shared mutable state
(`aggregateRebinds`, `aggregateReconciles`, `clientSubs`) is passed **by reference** so the composer's
loops and the modules' mutations stay coherent; `subscriptions` became private to dispatch, exposed to
the diagnostics seam only via `dispatch.servedCount`.

**Consequences.**
- `index.ts`: **1337 → 745 lines**; the replication core is now the visible heart of the composer.
- **No behaviour change** — the moved bodies are verbatim modulo `fold.`/`dispatch.` namespacing. Verified
  by tests (149/149) and perf (17/17 serialized — Q2 partial build + live writes, Q3 union-fold, L2 writes
  + method dispatch, owner lookups, encode), and by a 4-lens adversarial review (capture fidelity /
  wiring+TDZ / identity+GC / verbatim+hot-path): all clean. The R=∞ full-replication hot path is
  byte-identical (the facade isn't built; `methodSurface === localMethods`), and the measured **write** path
  (sink → `commitLocal`) was never moved.
- The construction window between `transport()` and `const dispatch` has no interleaving `await` (only
  `storage.load()` before the mesh and `mesh.ready` after dispatch), and `onCall` is `Promise.resolve().then`
  -deferred — so a mesh hook routing to `dispatch.*` can never fire before `dispatch` initialises.

**Open follow-ups → [IDEAS](IDEAS.md):** the L3 chain planner is the natural next home for the
holistic-op guard in `dispatch.ts`. No further core decomposition planned — the core is deliberately whole.

## T — Re-key inbound peers on handshake DONE (stable peer identity) · Adopted

**Context.** A TCP server `accept()`s an inbound socket and keyed the resulting `Peer` (and its
`cluster.peers` row) by the socket's *ephemeral* `remoteAddress:remotePort` with a provisional
role `client`. That address can't be dialed back, and a peer that is really a server got
mislabeled as a `client` — so `cluster.peers` carried a **phantom ephemeral client row** for
every inbound server link, and the point-to-point hooks (`onSubscribe`/`onViewPrepare`/`onWrite`/…)
tagged the sender with an unstable ephemeral address. The handshake already learns the peer's real
uuid + listen address; nothing re-keyed from it. This is the keystone of the "Identity, dedup &
connection hygiene" cluster ([IDEAS](IDEAS.md)) — dedup-by-uuid and dead-row pruning both need the
stable listen-key + uuid this establishes.

**Decision.** `Peers.identify(peer, id)` runs on handshake **DONE** (wired through the L0 `done`
hook, which now carries the learned `Identity`). An accepted inbound peer owns **no** `cluster.peers`
row until then (deferred from `accept()`), so a half-handshake inbound never leaks a row:
- a **server** inbound socket is re-keyed to its **listen address** (uuid + role stamped) and becomes
  a receive/serve **shadow** — its membership identity is the **dialed** peer's row, which is the
  routable/ring identity. Both the dialed (A→B) and inbound (B→A) sockets are **kept** (each carries
  one direction; `broadcast` stays dialed-only), so this is NOT yet connection-dedup.
- a **client** inbound socket (no listen address) is published under its ephemeral address as role
  `client` — unchanged externally, just deferred to DONE and now carrying a uuid.
- a **dialed** peer already owns a correctly-keyed row — `identify` only stamps its uuid.

`Peer.address`/`role` became mutable and a `uuid` field was added; `Peers` tracks a `#published`
WeakSet (row owners: dialed peers + identified clients) and a `#shadows` **Map keyed by listen
address** (re-keyed inbound servers). The Map does double duty: a **send fallback** in `peer()`
(`#conns.get(addr) ?? #shadows.get(addr)`, dialed wins) so an inbound-only link is still reachable
point-to-point, and the teardown set. `#mirror` writes rows only for published peers. **Reap keys
by the inbound socket, not the dialed peer:** a served subscription always arrives over an inbound
socket (a client row, or a server shadow), so `onPeerGone` fires for **`!dialed`** peers only —
a *dialed* peer serves nothing, and post-re-key its listen address collides with the shadow's
served-sub key, so firing it would **false-reap** the shadow's still-live subs on a one-directional
drop. The shadow is therefore the sole server-pair reap trigger (and is pruned from `#shadows` as it
fires). The keys align because L2 opens a served sub only after a view commit — well after the DONE
that re-keys — so `onSubscribe` and the reap both see the listen address (the transport tests gate
the subscribe on the dialer's `onConnect`, which fires after DONE, to make that ordering deterministic).

**Adversarial review (pre-commit, fixes folded in).** A 4-lens review caught two majors my single pass
missed: a *dialed*-socket one-directional drop **false-reaping** the shadow's live subs (the listen
address now collides — fixed by the `!dialed` gate, which also subsumes a double-`onPeerGone`); and the
shadow being **send-invisible** (parked outside `#conns`), regressing served delivery on an inbound-only
link (fixed by the `peer()` fallback + keying `#shadows` by address). Two duplicate-DONE / self-address
landmines (re-key twice → strand the dialed peer; re-key to `me`) were guarded in `identify`. Two
asymmetric regression tests + the deterministic-ordering test gates were added.

**Consequences.**
- `cluster.peers` shows each server exactly once under its dialed listen address (uuid-stamped); no
  phantom ephemeral client rows. The view layer's `#reachable()` is unchanged — it already ringed
  only dialed server rows, and a server shadow owns none.
- Off the hot path — `identify` runs once per handshake, not per record; `peer()`'s fallback is one
  extra Map lookup only when `#conns` misses. Tests 151/151, perf 17/17 (L2 writes ~71 ms vs the 150 ms
  gate; the peers status-transition perf flat in N). The R=∞ path is byte-identical.
- The `onSubscribe`/reap address shifted from ephemeral to the listen address for server↔server subs;
  the transport reap + view-frame tests were updated to assert the stable address.

### T2 — uuid self-reject · Adopted

**Context.** `add()`'s self-guard is a host:port STRING compare against `me`, so a dial to one of our
OWN alternate addresses (multi-NIC, `localhost` vs `127.0.0.1`) reaches a different string, connects,
and would mesh the node with ITSELF — a self-loop in `cluster.peers`. The handshake already carries our
uuid back to us; nothing compared it.

**Decision.** `Peers` takes a `uuid` opt; `identify()` self-rejects when the peer's identity carries OUR
uuid — destroys the connection, removes it from `#conns`/`#shadows`, and (for a dial) records the address
in `#selfAddrs` so discovery/gossip/heal can't redial it. `add()` refuses a known `#selfAddrs` address.
The self-reject sits ABOVE the existing `id.listen === me` guard (so a true self reached via gossip-revival
with `id.listen === me` is torn down, not left as an idle zombie socket), and BELOW the idempotency guard
(a first-time self peer is neither shadow nor published, so it isn't skipped). The `done` hook gates
`onConnect` on `peer.status === STATUS.connected`, so a self-rejected (destroyed) peer doesn't fire the
catch-up/ready trigger. A dialed self's row is **pruned** (T3 routes the self-reject through `#prune`),
so the self-address leaves no lingering row.

**Adversarial review (clean).** A no-false-positive argument holds: `transport()` defaults `uuid` to
`crypto.randomUUID()`, so two distinct nodes that both omit it still differ — the only match is a genuine
uuid collision, which the design intentionally treats as mutual refusal. Verified: correct teardown keys
for both dialed (alt-address) and inbound (ephemeral) self peers; `onConnect` never wrongly suppressed
(a normal dialed peer is always `connected` at `done`); `ready` still resolves (pool `onConnect` fires at
TCP-connect + the `wait` backstop). Tests 152/152, perf 17/17.

**Known limitation (by design).** `#selfAddrs` is add-only — correct & bounded for true self alt-addresses;
for a uuid-*collision* peer the address stays blocked until process restart (a misconfiguration is refused
deterministically). Self-healing a fixed collision is the place to revisit if ever wanted.

**Open follow-ups → [IDEAS → Identity, dedup & connection hygiene](IDEAS.md):** connection-dedup to
one bidirectional socket (connected-wins by uuid — re-key now *surfaces* the collision). A rapid
B-reconnect that re-identifies a new shadow before the old one's close processes can leak the old
shadow's served subs (bounded; folds into the churn-leak item).

### T3 — prune dead rows on terminal departure · Adopted

**Context.** A peer that left for good still leaked a `disconnected` row in `cluster.peers` forever (and a
`#conns` entry): an inbound CLIENT that dropped, a dial that gave up (finite `retries.max`), a half-handshake
inbound that closed, and the T2 self-reject's dialed row. A slow leak under churn (the IDEAS "Prune dead rows").

**Decision.** `Peer` gained an `onGone` callback fired on the two TERMINAL departures — an inbound socket
close (`#onClose`, `!dialed`: never redials) and a dial giving up (`#scheduleReconnect`, `delay < 0` → onGone
then destroy). `Peers.#prune(peer)` removes the `#conns` entry and the row (via `peers[view].res.remove`):
- **Guarded `#conns` delete:** `#conns.delete` runs only if `#conns.get(peer.address) === peer`. A server
  shadow's `peer.address` is its LISTEN address — the DIALED peer's `#conns` key — so an unguarded delete would
  strand the live dial. The guard makes `#prune` a safe no-op for a shadow (shadows are pruned from `#shadows`
  by `#mirror` on their own disconnect; `#prune` doesn't touch `#shadows`).
- **Guarded row delete:** only if `#published.delete(peer)` (a shadow/unidentified inbound owns no row).
- The T2 self-reject now routes through `#prune` too (no lingering self row).

The terminal gating means a *transient* dialed drop (retries left → `throttled`) keeps its row, `isolate()`/
`pool.destroy()`/self-reject's own `destroy()` don't double-fire onGone (the `#destroyed` short-circuit in
`#onClose`), and a give-up can't resurrect the row (`#published.delete` precedes the `destroy()`→`#mirror`).

**Adversarial review (clean).** Traced the shadow-vs-dialed guard (no strand), every onGone-firing condition
(exactly the two terminal cases; isolate's row survives for `heal`), the `res.remove` contract (canonical,
idempotent, updates the `connected` projection + the view's `#reachable` snapshot in O(delta)), the churn
re-add (fresh peer+row, no stale block), and give-up ordering (no resurrection). Also closes the prior
half-handshake `#conns` leak. Default `retries.max` is `Infinity`, so the give-up branch is opt-in; the
inbound-close prune is the steady-state win.

**Consequences.** A churned/departed client or a given-up dial leaves no phantom row. Zero steady-state cost
(terminal-path only; the row-remove is one `delete` + one change record). Tests 154/154 (2 new prune tests,
bite-verified), perf 17/17.

**Open follow-ups → [IDEAS](IDEAS.md):** a max=Infinity dial to a permanently-dead address still retries
forever (row cycles, never gives up) — an eviction-driven explicit `forget(address)` (the view layer knows
the peer is gone) or a TTL is the remaining lever; pairs with the reactive dial loop / dead-candidate backoff.

### T4 — heartbeat-only dedup (full socket-collapse deferred) · Adopted

**Context — full dedup is a NO-GO now (design pass).** The workstream's last item was connection-dedup:
collapse each server pair's TWO TCP sockets (A→B + B→A) to ONE bidirectional socket, halving sockets +
heartbeat traffic. A three-lens design workflow (membership-first / simplicity-first / race-first) +
adversarial critiques verified two FATAL flaws in full socket-collapse, against the live code:
- **Silent R=∞ convergence regression.** There is no periodic anti-entropy under full replication
  (`resource/index.ts` `aeTimer` is armed only when `scoped`); convergence relies ENTIRELY on dialer-gated
  `onConnect` catch-up (`transport/index.ts` `done` hook). Full dedup makes the "loser" `!dialed`, so its
  catch-up never re-fires → silent divergence on the exact path CLAUDE.md protects. The fix (periodic AE
  under R=∞) would itself change the protected steady state.
- **It re-opens the T/T2/T3 seams.** A "promoted" survivor would be `!dialed && #published && row-owner` —
  a shape `#published`/`#mirror`/`#prune` are built to make impossible — plus it breaks the chaos
  `isolate`-both-dials partition invariant (→ false-green chaos tests) and has a verified formation FLAP
  (the winner reaches its dedup precondition a round-trip before the loser and tears the loser's still-live
  dial). Full dedup is a multi-week effort gated on three prerequisites; the promote-the-shadow blueprint is
  staged in IDEAS.

**Decision — ship the cheaper partial that captures the win that actually bites.** At 100s of peers the
binding constraint is PROBE BANDWIDTH (N² PING/PONG every interval), not FD count. So: keep BOTH sockets,
but per socket only ONE side ORIGINATES the heartbeat — the **lower-uuid** node — while the higher-uuid node
**watchdogs** (sends no PING; still flags `suspect` on inbound-frame starvation). Both ends compute the same
`this.#uuid < id.uuid` over the same two post-handshake uuids → exactly one originator per socket, no
negotiation (a tie is impossible: T2 self-reject intercepts equal uuids before the election). The originator
probes both its sockets to the peer; the watchdog reuses the EXISTING `#missed`/`#hbMisses` machinery — only
the PING `write` is gated (`peer.ts` `#beat`), so suspect semantics are identical; `identify()` sets
`peer.setOriginate(this.#uuid < id.uuid)` (a raw pool with no `#uuid` keeps the default → both probe).

**Why it's safe where full dedup is not.** Bidirectional failure detection is preserved: the originator
detects death via unanswered PINGs; the watchdog detects it via PING starvation (`#missed` climbs when the
originator falls silent). The watchdog's row-owning socket carries NO data stream to mask a dead originator
(data + served-sub RECORDS flow over the originator's dialed socket, landing on the watchdog's *shadow*, not
its dialed row-owner), so starvation detection is clean. ZERO change to membership / broadcast / `#published`
/ `#shadows` / `#reachable` / failover / isolate; the R=∞ data path is byte-identical (heartbeat is off it).
Both nodes still dial → reciprocal catch-up preserved (no convergence regression). The suspect→eviction
signal fires for both nodes (the lower-uuid via its dialed-peer originator, the higher-uuid via its
dialed-peer watchdog — both own the peer's row).

**Adversarial review (clean).** Traced the election (exactly one originator per socket; empty-`''`/no-uuid
defaults to probe; equal-uuid intercepted by T2), bidirectional detection (originator-dies and watchdog-dies
both detected), no idle false-trip (both ends share `#hbInterval`; 3-beat margin absorbs skew), reconnect
re-election (idempotency guard doesn't skip a reconnected dialed peer), and the suspect→`#reachable` path.
Tests 173/173 (3 new: watchdog-detects-starvation, watchdog-stays-healthy, election-by-uuid — bite-verified),
perf 17/17.

**Caveat (documented).** The watchdog's detection margin is bounded by PING *delivery* jitter (not a PONG
round-trip). With default `misses=3` this is comfortable; at `misses=1` the watchdog would have tighter slack
than an originator — fine at the defaults, noted for anyone tuning aggressively.

**Open follow-ups → [IDEAS → Identity, dedup & connection hygiene](IDEAS.md):** FULL socket dedup
(promote-the-shadow blueprint) staged behind its three prerequisites — (1) periodic anti-entropy under R=∞
OR a non-dialer-gated catch-up trigger; (2) subscription failover / re-dispatch; (3) incarnation/epoch
fencing — plus a chaos `isolate`/`heal` rework and (the clean long-term home) a unified per-peer `link`
abstraction replacing the `#conns`/`#shadows`/`#published` trichotomy.

## U — Routing hot path: allocation-free `holds()`; hash-memo + key0 measured-rejected · Adopted + Investigated

**Context.** The [IDEAS → Routing hot path](IDEAS.md) workstream listed three per-routed-record
micro-optimizations. Each was taken to a NUMBER (CLAUDE.md: "decide with a perf number, not a guess")
rather than assumed. Baseline on the 5-peer × 200-vnode ring (`dht.perf.ts`): `owner()` ~0.13µs,
`owners(_,3)` ~0.30µs — both already an order under their gates, so the bar for "a real win" was high.

**Decision — ADOPT the allocation-free ring predicate; REJECT the other two on the measurements.**

- **Allocation-free `DHT.holds(key, addr, R)` · Adopted.** `holds()` answers
  `owners(key, R).includes(addr)` — the exact per-record question the resource `holds()` first-touch and
  the catch-up digest filter ask — but `owners()` allocated a `string[]` + a dedup `Set` EACH call, pure
  GC pressure on a yes/no. The predicate walks the ring clockwise from the owning slot counting DISTINCT
  owners (Set-free: a candidate is "new" iff it didn't appear in an earlier slot of THIS walk — the inner
  scan checks ALL prior slots, since wraparound scatters a peer's vnodes), returning the moment `addr` is
  the k-th distinct owner for k ≤ R, or false once R distinct non-matching owners pass. The `#members.size
  ≤ R` short-circuit (`#members.has(addr)`) mirrors `owners()`' all-members result + the resource's
  `R ≥ viewSize` gate. Exposed on the `Mesh` seam and wired into the two un-memoized `.includes` call
  sites (`resource/index.ts`: `heldCache` first-touch + the catch-up filter). **Measured: ~0.18µs vs
  `owners().includes`'s ~0.30µs (≈40% faster) AND zero per-call allocation.** Correctness is pinned by an
  EXHAUSTIVE equivalence test — `holds() === owners().includes()` over memberships 0–8 × R 1..m+2 × 250
  keys × (members + a non-member), ~82k assertions — not by reasoning. The **R=∞ full-replication path is
  byte-identical**: resource `holds()` returns `true` at `!scoped || R ≥ viewSize` BEFORE reaching
  `mesh.holds`, and the catch-up filter is gated `scoped && R < viewSize`, so full replication never calls
  it (`index.perf` L2 write path flat at ~71ms / 150ms gate). A 4-lens adversarial review (equivalence /
  integration / full-rep invariant / perf-discipline) found no defects.

- **Hot-key hash memo · Investigated — rejected.** A `key→hash` Map memo inside `owner()`/`owners()` was
  measured against re-hashing: **re-hash 3.83ms vs Map-memo 4.13ms for 100k lookups over 5000 distinct
  keys — the memo is SLOWER.** djb2 + fmix32 over a short routing key is cheaper than a Map lookup, and an
  UNBOUNDED memo also leaks one entry per distinct key ever routed. Rejected as specified. *Narrow caveat
  (unmeasured, parked P3):* a BOUNDED LRU (≈256 entries, ~1.5KB) could win for a pathological skew — a
  handful of hot keys among millions of routed keys, where re-hash dominates and GC of the unbounded map
  would have hurt — but no such workload has been profiled; revisit only if production profiling shows
  hash cost or GC pressure on the routing path.

- **`RecordView.key0` / `partitionKey` accessor · Investigated — rejected.** The idea: the DHT routes on
  `key[0]` only, so decode just the first key segment instead of the whole `string[]`. The analysis (and
  the review) found it a STEADY-STATE REGRESSION, not a win: every record whose partition is inspected and
  that is KEPT goes on to decode its FULL key downstream anyway — `applyInbound` → `log.append`
  ([log/log.ts](log/log.ts) `partitionOf`, UNCONDITIONAL even under full replication) → `applyRecord`
  (reads `record.key`). So a key0 accessor would decode segment 0 AND later the full key on the kept path
  (an extra short decode), winning only on DROPPED records at the scoped held-gate — which, since the
  owner replicates only to the R-set, is the EXCEPTIONAL over-ship / transient-ring case, not steady
  state. The catch-up filter is no exception either: its log records were already key-decoded (and
  memoised) at apply time, so `partitionOf` there hits the memo. Under full replication the held-gate
  short-circuits, so key0 would never even run on the protected path. No clean steady-state win → not
  built.

**Consequences.** One concrete, verified hot-path win (allocation-free `holds()`); two candidate
optimizations closed with a measured/analyzed rationale so they aren't re-litigated. The remaining
Routing-hot-path IDEAS items (`partitionOf` `key0` and the hash bake-off) are resolved/superseded here;
the allocation-free predicate item is done. Hash-function CHOICE (djb2+fmix32 vs wy/xxhash32) stays open
as a separate bake-off ([IDEAS open question 8]).

**Open follow-ups → [IDEAS](IDEAS.md):** bounded-LRU hash memo (P3, only if profiling demands it); the
hash-function bake-off (open question 8); the `RecordView.key0` self-delivery / send-path micro-opts stay
unbuilt by the same kept-path-decodes-anyway reasoning.

## O — Observe: a pull-spine snapshot + one gated push-hook (the L4 network observer) · Adopted

**Context.** A running cluster carries state invisible from outside — the DHT ring + ownership, the
committed view (epoch/members/writable gate), per-origin high-water marks, LWW winners *and losers*,
orphan/shed bookkeeping, and the live change-record stream with provenance. A plain read-only client sees
only its hardcoded trinity + its projection. The goal (locked user decisions): a **standalone web
dashboard** that **attaches from outside** a running cluster and covers three view families incrementally
— [a] topology+ring, [b] live data + provenance/contention, [c] replication health. Hard constraint: the
observe path stays OFF the steady-state replication hot path and costs ~zero when unwatched; the browser
can't be a fero peer (transport is TCP), so a bridge is required.

**Decision — two channels behind a uniform change-record contract, chosen over a new wire verb and over a browser-direct WebSocket.**

- **Pull spine — `__inspect` + `makeSnapshot()` (families [a]/[c]).** A gated `__`-prefixed method returns a
  per-node `InspectSnapshot` read BY REFERENCE from already-in-memory internals (`seen`/`versions`/`log`/
  ring/`mesh.peers`), materialized only when called (~1/s poll). Pure read — cannot perturb LWW/dedup/
  versions. Multi-node keyed by uuid. The DHT ring ships as a **scale-independent `coverage(k)` sampling**
  (fixed K segments regardless of cluster size), not members×vnodes arcs.
- **Push hook — `__observe` + `makeObserve()` (family [b]).** A gated method streams ONE bounded
  drop-oldest ring-buffer ViewProxy carrying the live provenance/contention events. Fed only from the
  EXISTING commit/apply call-sites (no second `data` sink, no `log.onAppend` listener): `lost` before the
  LWW loser early-return (a loser never lands in a snapshot — the push channel exists for exactly this),
  `won` after a winning inbound record, `local`/`forwarded` ONCE in `commitLocal` (distinguished by the
  in-scope `committingForward` flag — forwarded writes funnel through `commitLocal`, so emitting at
  `commitForwarded` too would DOUBLE-COUNT), `dropped` only under `observe:{verbose}`, plus `view`/
  `writable` chained into the membership hooks. Each event is a FLAT scalar provenance record (origin/seq/
  epoch/key) — never the value payload (that rides the poll snapshot).
- **Bridge — SSE over a Node relay, not WebSocket.** A read-only fero client (or the in-process diagnostics
  seam for harness war games) polls `__inspect` and subscribes `__observe`, relaying both to the browser
  over `EventSource` (zero browser deps). The dashboard imports only `data/dist` and renders reactively.
  Rejected: a `VERB.OBSERVE`/MAGIC wire bump (a real version change touching the two hottest files for a
  debug feature, breaking mixed-version observability) and a browser-direct WS transport (a second from-
  scratch wire codec + a `ws` dep + an unauthenticated reachable port).

**Consequences.**
- **Un-configured node = byte-identical** (no `__inspect`/`__observe` registered, gate `undefined`). A
  **configured-but-UNWATCHED node** adds only predicted-false `observe?.…` branches at the four emit-sites:
  optional chaining short-circuits before the args evaluate, so it does no real work. **Measured: unwatched/
  plain write ratio 0.96–0.99× (within 15% gate); the L2 write-path gate (10k writes < 150ms) holds
  unchanged at ~62ms.**
- **Watched is real cost.** While a subscriber is attached, each write also builds a ProvRecord + a
  data-proxy slot write + sink delivery — **~3× the bare local write (measured 2.8–2.9×)**, paid ONLY while
  watching, with the ring buffer bounding memory. A batched/off-tick flush to shrink the active path is a
  deferred optimization ([tools/observe/IDEAS.md](tools/observe/IDEAS.md)).
- **Leak-as-perf-failure (the lifecycle guard).** `__observe` is **subscription-only** (handled in
  `serveSubscribe`, never in the method table — an RPC call to it is unknown-method, so it can't arm the
  gate without a live subscriber). The streamed proxy carries a `close` that fires via the existing
  `serveUnsubscribe`/`reapPeer` chokepoint → refcounted `detach()` nulls the gate on the LAST observer.
  A test attaches+drops a subscriber UNGRACEFULLY then times writes: if the gate leaked armed they'd be
  ~3× and it goes red. **Confirmed: post-drop ratio 0.98×.**
- **Trust boundary (open refinement).** A configured node discloses full internals to ANY peer that can
  reach the unauthenticated fero TCP port — the `__` prefix and the localhost bridge bind are NOT access
  boundaries (same posture as the data path, "servers trust each other"). The in-process `[diagnostics]`
  seam (`snapshot`/`observe`/`observing`) is ALWAYS available (holding the ref is full trust); only the
  WIRE methods are gated by `observe:`. **Non-goal:** fault-injection (`drop`/`isolate`/`heal`) stays
  in-process via `[diagnostics]`, NEVER wire-reachable. A per-`__`-method caller allowlist
  (`observe:{ from, remote }`, tightening once `peer.auth` lands) is tracked in [IDEAS](IDEAS.md).
- **`lost`/`dropped` are rare BY DESIGN** (the write-gate stops a minority diverging; single-sequencer
  ordering + digest-driven anti-entropy stop re-delivery — measured 0 drops under kill/restart churn).
  Covered at the controller level; a deterministic split-brain loser is a Slice-5 war-game scenario.
- Two adversarial multi-agent reviews ran before this landed. The first (26 agents: correctness / leak /
  perf / bridge / trust) found no defects in the node-side slice. A second, full-project review (72 agents)
  then surfaced SIX real defects — five in the bridge/closer layer, all **fixed in this same change**:
  (1) the bridge armed the ~3× watched write tax on every server with zero dashboard viewers → push legs
  now arm only while an SSE client is connected (idle ⇒ all subs dropped); (2) a socket bounce inside one
  poll interval killed the push leg permanently (server reaped the sub, the bridge never re-subscribed) →
  the snapshot now carries `observing` and the bridge re-subscribes when it holds a sub against
  `observing:false` (blind spot: a SECOND bridge keeping the gate armed masks the first's dead leg —
  [tools/observe/IDEAS.md](tools/observe/IDEAS.md)); (3) a same-address restart left the old uuid's
  snapshot as a permanent ghost in the rollup (the address-keyed prune can't see it) → an addr→uuid map
  prunes the predecessor; (4) the initial ring-buffer dump (and any replay) was re-accounted as fresh
  events, corrupting rates/conflict counts on every (re)subscribe → the dump now only seeds a
  per-subscription `t` watermark and deltas dedup against it; (5) the `[diagnostics].observe` closer was
  not idempotent and read the CURRENT gate instead of its own instance — a double-close (or a stale closer
  after a disarm/re-arm cycle) could disarm the gate under a live subscriber, and a closed observer kept
  receiving callbacks while others held the gate armed → closers are latched, instance-guarded, and
  delivery-gated. Plus smaller hardening: a fractional `observe:{buffer}` < 1 no longer collapses the ring
  to one NaN slot; `__observe` no longer shadows a same-named user method when observe is OFF; the bridge's
  static-file containment check is path-segment-aware; the saturated grid event buffer drops oldest in O(1)
  instead of an O(N) splice per event. Each fix carries a regression test (observe.test.ts, bridge.test.ts).

**Open follow-ups → [IDEAS](IDEAS.md) "Observability" + [tools/observe/IDEAS.md](tools/observe/IDEAS.md):**
per-`__`-method auth allowlist; cluster-side gather inspect for thousands of nodes (a drop-in source
adapter, deliberately not v1 — it goes blind during the partition the tool exists to show); batched
off-tick emit; the Slice-5 scale tier (view-group clusters, lag leaderboard, convergence timeline).

## W — Log compaction: collapse superseded same-key updates · Adopted

**Context.** The per-partition log ([log/log.ts](log/log.ts)) is append-only: a key written N times
accumulates N records even though only the LATEST value is live. Under owner-routing ([F1](#f1--owner-routed-writes-via-forwarding-owner-re-sequencing-phase-1--adopted))
a hot key's canonical records mostly share ONE origin (the owner), so a high-churn key grows the log —
and every replica's log, and the catch-up it ships — without bound. This is the headline [P1] item of the
"Bounded memory & compaction" workstream. Built design-first: an adversarial design-verification workflow
(6 lenses + cross-checks) ran BEFORE any code and killed the naive rule three ways (below).

**Decision — `Log.compact()`: drop only strictly-superseded same-origin `update`s.** Within each
partition segment, group origin-bearing real-path (`key.length≥1`) **`update`** records by
`(origin, versionKey)`; drop a record D iff a **strictly-higher-seq** update S in the same group has
`epoch ≥ D.epoch` (same origin, so `(epoch,seq)` decides LWW). Rebuild the segment AND the dropped
records' provenance-index groups by object identity (order preserved → still seq-ascending). Driven by an
unref'd `compactTimer` (config `compact: <ms>|false`, default 30s) in BOTH replication modes — the append
hot path is **untouched** (zero per-append bookkeeping; the R=∞ write path stays byte-identical, measured
~119ms/10k vs the 150ms threshold). `versionKey` moved from L2 to [log/log.ts](log/log.ts) (shared, like
`originKey`) so compaction's "same cell" is byte-identical to L2's LWW key and can never drift.

**Why it's safe (the design review's three traps, all sidestepped by "updates only").**
- **Arrays / positional inserts.** `versionKey` folds the positional `at` into the key, but two same-`at`
  array inserts are DISTINCT live elements (each splices/shifts), not an overwrite. Collapsing them would
  delete an element. → **Inserts are never dropped.**
- **Nested-remove orphan.** `res.remove` of a NESTED path (`key.length≥2`) THROWS when an ancestor is
  absent, so dropping any update that vivified that ancestor would crash a fresh joiner's catch-up. The
  post-implementation review caught the precise trap: a `set / delete / set` cycle on a nested field
  (`lock.held=true; delete lock.held; lock.held=false`) — the first update is value-dominated by the
  third, but the `remove` sits BETWEEN them, so dropping the first strands the remove before any
  vivifier. → **Removes are never dropped, AND a partition whose segment holds any nested remove is left
  untouched this pass** — with no nested remove, no replay can hit an absent ancestor whatever we drop (a
  top-level remove of a missing key is already a no-op). A nested `update` auto-vivifies its ancestors
  (verified against `data`), so pure update-churn (no nested removes) collapses fully.
- **Epoch inversion.** On a `{pinned uuid, storage}` restart the Lamport clock is restored but the view
  epoch resets to 1, so a higher-seq local write can carry a LOWER epoch than a restored record — it is
  NOT the LWW winner. Raw max-seq would drop the true (higher-epoch, lower-seq) winner. → The `epoch ≥`
  dominance guard keeps both; nothing is lost. (The inversion is ALSO a pre-existing divergence bug,
  independent of compaction — see [IDEAS → Bounded memory](IDEAS.md) / durable-epoch recovery.)

**Why `marks()` / catch-up / shed stay correct.** Because we drop D only when a STRICTLY-higher-seq
survivor exists, a group's overall-highest-seq record is **never** dropped — so `marks()` (= each index
group's last seq) is preserved EXACTLY, P4 shed-confirmation (gates on `log.marks()`) is undisturbed, and
seq-keyed `recordsSince` still converges any peer (a dropped record is strictly superseded by a same-origin
higher-seq survivor the peer either receives or has already passed). The proxy is the source of truth
([H](#h--proxy-as-source-arch-b-not-log-as-source-arch-a--adopted)), so dropping dead log history never
affects a read. Compaction is intra-origin (a cross-origin loser lives in a different group → never
dropped; LWW resolves it at the receiver). Shed/B1 lenses confirmed clean. A post-implementation
adversarial code review caught the nested set/delete/set crash above (now fixed + regression-tested) and
confirmed the suffix-max-epoch supersession loop, the segment/index identity rebuild, the config parsing,
and the timer lifecycle otherwise clean.

**Consequences.** A high-churn key collapses to ~1 record per owner-tenure (bounded by distinct owners, not
write count) in both full and scoped modes; a 200×-rewritten key shrinks a 2-node cluster's logs from ≥200
to ≤5 records, with the live state and a fresh joiner's catch-up unchanged (end-to-end test). Compaction is
purely IN-MEMORY: the WAL ([C](#c--persistence-via-a-storage-seam--wal--adopted--980ead9)) still retains
every record (restore dedups on load — correct, but restore cost is O(historical writes)); WAL compaction
stays deferred. `compact: false` disables it.

**Open follow-ups → [IDEAS](IDEAS.md):** insert/remove-churn collapse (re-insert/delete cycles, arrays —
need element-identity, not positional `at`); a per-partition dirty-set so the timer is O(written) not
O(partitions); WAL compaction (snapshot+truncate / `onCompact` hook) + durable shed; `versions`/`seen`
tombstone GC with a safety horizon; durable view-epoch recovery (the stable-uuid-restart inversion).

## X — Write-path consistency hardening: epoch-dominance stamp, client forwarding, ack-confirmed forwards · Adopted

**Context.** A full-project adversarial review (72 agents) surfaced three write-path holes that all end in
SILENT divergence or loss — none caught by the existing suite because each needs a specific
view-lag / client / owner-crash interleaving.

**Decision — three independent fixes, one consistency story.**

- **Epoch-dominance stamp (supersedes part of [V1d](#v--view-synchronous-membership--adopted--5c45e61--1d8c533)).**
  `commitLocal` stamped `viewEpoch()` UNCONDITIONALLY. A node whose committed view lags the epoch of a
  winner it already holds for the key (a restored WAL, a missed/in-flight `VIEW_COMMIT`, the join window)
  then committed its deliberate overwrite at the LOWER epoch — every peer holding the newer-epoch winner
  sticky-fenced it ([B1](#b1) skip: `seen` advances so AE never re-ships), while the writer applied it
  locally. Permanent per-key divergence until the next write touches the key. Fix: a local write happening
  NOW against locally-known state is not the stale-view straggler V1d fences — it knowingly supersedes the
  held winner, so it commits at `max(viewEpoch, cur.epoch)`; the merged Lamport seq (`clock ≥ cur.seq`)
  wins LWW within that epoch on every replica. One compare on the write path (index.perf unchanged).
- **Client writes forward, never commit-local ([F1](#f1--owner-routed-writes-via-forwarding-owner-re-sequencing-phase-1--adopted) extended to clients).**
  A read-only client has no `ViewManager`, so `viewEpoch()` ≡ 1 and the F1 branch (which required
  `me !== undefined`) never fired — `client.data.x = v` committed LOCALLY at epoch 1 and broadcast. Any
  formed cluster (epoch ≥ 2) fenced every such record wherever a server-written winner existed, while the
  client kept it locally: silent permanent divergence. Fix: a client routes the assignment to a picked
  server (it re-sequences under its provenance/epoch via the `committingForward` guard — no re-route
  ping-pong); the optimistic local copy stays (read-your-writes; the canonical view rides subscriptions).
  Unreachable or unconfirmed ⇒ the write buffers (bounded drop-oldest, the V1e posture) and drains on
  `onConnect` + a periodic unref'd sweep.
- **Ack-confirmed forwards (closes the [Q1](#q1--hold-relative-reads-owner-routed-read--datax-facade--adopted) never-drop gap).**
  `mesh.forward`'s boolean was socket-write success, NOT delivery: an owner crashing inside the
  failure-detector lag accepts the frame into a dying kernel buffer, and a scoped non-holder had already
  discarded its optimistic copy — the write then existed NOWHERE (silent loss, violating never-drop). Fix:
  an id-tagged `WRITE` is `ACK`ed by the receiver AFTER its synchronous `onWrite` commit; `forward(addr,
  rec, onOutcome)` arms a `callTimeout` fallback — no ack ⇒ `onOutcome(false)` ⇒ the caller commits under
  its own provenance (a server: an orphan a non-holder P4-sheds once the R-set confirms; a client:
  re-buffer). At-least-once: a duplicate (owner committed, ack lost) converges via LWW. The legacy
  boolean `forward(addr, rec)` is unchanged (no `onOutcome` ⇒ no ack tracking), so the broadcast/digest
  paths are untouched.

**Consequences.**
- Epoch can now differ across same-tick local writes — `encodeFrames` already splits a run on an epoch
  change and compaction's dominance guard already handles epoch inversion (both pre-pinned by tests).
- The client write path adds a `forwardToServer` + a bounded pending buffer + an unref'd flush timer
  (client-only; a server's path is unchanged). `mesh.pickServer()` is now public (the client picks its
  forward target the same way `call`/`subscribe` do).
- Forward bookkeeping (`forwards` map: id → {timer, onOutcome}) is cleared on transport `destroy()` so a
  torn-down node fires no late fallbacks.
- Tests: a divergence repro per fix (restored-epoch-7 overwrite applies on a lagging-view peer; a client
  assignment reaches a 2-server cluster and replicates instead of fencing; an offline client write buffers
  then flushes on connect; a real owner ACKs `true` while a swallowing receiver times out to `false`).

**Open follow-ups → [IDEAS](IDEAS.md):** preserve a buffered write's ORIGINAL attempt-epoch on flush
(V deferral, now also relevant to the client buffer); the reject-stale-epoch fence from an EVICTED node
(needs per-partition owner lineage — still open, distinct from this same-node-lag fix); read-your-writes
on a client whose forward is still in flight (it reads its optimistic local copy, correct, but a routed
read could momentarily race the owner's commit).

## Y — Membership reconciliation: periodic view re-announce (split-brain heal + missed-commit recovery) · Adopted

**Context.** [V](#v--view-synchronous-membership--adopted--5c45e61--1d8c533)'s view state crossed the wire
ONLY in the one-shot ballot (`PREPARE`/`ACK`/`COMMIT`). The full-project review found two failures that
both end in a PERMANENT split — neither caught before because each needs a partition/heal or a dropped
frame at a specific instant:

- **Split-brain survives heal.** A view proposal fired only on a member-set DELTA (`sortedEqual(proposed,
  members)` early-return). Partition `{A,B}|{C,D,E}` with eviction on: the majority commits `{C,D,E}@2`,
  the minority (which holds the global-lowest address A) stays on `{A..E}@1`, write-gated. On heal A — the
  merged-set coordinator — is back on its STALE 5-member view with reachable == members, so it saw NO
  delta and never re-proposed; `{C,D,E}` went quiet the instant it saw A's lower address. Two committed
  epochs, forever.
- **A dropped `VIEW_COMMIT` strands a member.** `#tryCommit` ignored `viewCommit`'s boolean — a member
  whose socket was momentarily un-writable (the admit race) missed the commit and stayed on the prior
  epoch; nothing else carried view state, so it never caught up, and its writes were epoch-fenced.

**Decision — re-announce the committed view, reuse `VIEW_COMMIT` (no new wire verb).** Every `announce`
ms (default 600), the lowest-address reachable member of its OWN committed view re-broadcasts
`{epoch, members}` to ALL reachable peers (not just members). One announcer per view (so each side of a
partition speaks — the merged coordinator alone wouldn't surface the OTHER side's higher epoch). On the
receiver, `onCommit`:
- always advances `#seenEpoch` (the highest committed epoch heard from any reachable peer);
- installs a higher epoch ONLY if its members INCLUDE us — this is both the real ballot commit AND the
  missed-commit recovery; a node hearing a higher view it's EXCLUDED from does NOT self-orphan (its
  coordinator merges it back in).
The coordinator now re-proposes on a member-set delta **OR** when `#seenEpoch > epoch` — so the
stale-side coordinator detects "a higher view exists" and proposes a fresh unifying view even when its own
member set is unchanged. The reconciliation always lands at an epoch above BOTH prior views (the
fresh-ballot rule), re-admitting the evicted minority.

**Consequences.**
- No new wire verb (mixed-version safe: an old node just ignores the extra `VIEW_COMMIT` re-sends). One
  announcer per view × O(reachable) tiny control frames every 600ms — cold-path traffic, far under the
  heartbeat budget; throttled independently of the 150ms coordinator tick.
- Genuinely-evicted (crashed) nodes are unreachable, so they never receive the re-announce and stay
  evicted — the reconcile fires ONLY when a stale node is reachable again (a heal), which is exactly when
  re-admitting it is correct. Forcibly removing a still-running reachable node is the separate
  explicit-eviction / reject-stale-epoch concern (still open in [IDEAS](IDEAS.md)).
- Supersedes V's implicit "view state rides only the ballot" assumption; the ballot is unchanged
  (PREPARE/ACK/COMMIT, joint-consensus quorum, soft coordinator) — this only adds a reconciling backstop.
- Tests: a new deterministic `membership.test.ts` (5 cases: convergence, minority write-gate, the
  split-brain-heal reconcile, missed-commit recovery, no-self-orphan) driving the state machine through a
  mock mesh — the consensus-core unit gap the review flagged; plus an end-to-end chaos scenario
  (eviction during a partition with the global-lowest in the minority → heal → one view).

**Open follow-ups → [IDEAS](IDEAS.md):** incarnation/epoch fencing for a flapping rejoiner; explicit
`forget(address)` / reject-stale-epoch from an intentionally-removed node (distinct from heal-reconcile);
faster missed-commit recovery than the announce period (retry the specific un-acked members on the next
tick).

## Z — Optimistic apply narrowed + tiered write confirmation (the `confirm` surface) · Adopted · `3d5787a`→`9f0edd6`

**Context.** A user question — "in which cases does fero do optimistic writes, and are they
all safe?" — plus an adversarial audit found the optimistic local apply was doing three
different jobs by role, and not all were safe:
- A **scoped non-holder** write was a deterministic, silent, cluster-wide LOST WRITE. The
  set-trap materialized the value, the sink forwarded it to the owner, then
  `discardOptimistic` dropped the local copy via a proxy `remove` guarded by an `applying`
  boolean. When `data` changed re-entrant writes from inline to a deferred `_pending` drain
  (data `c870bde`), that boolean was already cleared by the time the deferred remove
  re-emitted through the sink — so the remove leaked out as a FORWARDED delete and wiped the
  just-written value on the owner + R-set. Two P2 tests were red on a clean tree; the
  cross-repo seam (a fero invariant depending on data's execution-order, with no CI gate)
  is itself a finding — see [IDEAS](IDEAS.md) "Testing & chaos backlog".
- A **read-only client** kept a never-reconciled optimistic copy on its raw `data` proxy → a
  permanent client-local STALE READ on `data[value]`/operators (keyed `await data.x` already
  routed remotely, which masked it).
- The **owner** apply is authoritative (not optimistic); the **holder** apply has a
  reconciliation path (the canonical record reconciles via LWW). Both are fine.

A judged design panel set the direction: NARROW optimism to where a reconciliation path
exists, and add an explicit await-for-guarantee API for when you DO care about durability.

**Decision.**
1. **Narrow optimistic apply.** `discardOptimistic` rides a partition `Set` (`discarding`)
   the sink consumes when the deferred remove drains — surviving data's cascade drain the
   boolean did not (the lost-write fix). A **client** discards its optimistic copy on forward
   (reads route remotely; `data[value]` is honestly-empty, not stale-forever). Owner + holder
   apply unchanged — optimism survives only where a reconciliation path exists.
2. **Honest WRITE-ACK.** The owner ACKs the TRUE outcome — `{committed, seq, epoch}`, or a
   NACK `{reason:'withheld'}` when the quorum-less write-gate buffered it — not mere receipt
   (closing a silent acknowledged-loss: a forwarder/client used to release its never-drop
   fallback on a false ack). A non-commit (NACK or timeout) fires the existing never-drop
   fallback. `WriteOutcome` is threaded onWrite → WRITE-handler → ACK → forward onOutcome.
3. **Tiered `confirm` surface.** `methods.update({key, value, confirm?, timeout?})` (and
   insert/remove). Default = fire-and-forget (zero tracking; the bare `data.x = v` assignment
   is the same path). `confirm:'accepted'` resolves once applied locally (read-your-write on
   this node, not a durability claim); `confirm:'committed'` resolves `{tier,key,seq,epoch}`
   once the OWNER sequenced + logged it, rejecting `{requestedTier,reachedTier,reason,
   localCommit}` on withheld/timeout (localCommit carries the seq when a never-drop fallback
   committed it under our provenance, so a retry isn't blind). Confirmation rides `methods`,
   NOT assignment, because `await (data.x = v)` awaits the RHS `v` per the JS spec — which
   resolves the §11.1 / "Assignment ↔ `methods.update` parity" thread: it is the same write,
   and the method form is the one you can await. `committed` = SEQUENCED, not necessarily the
   LWW winner (a higher-seq concurrent write can supersede — hence seq/epoch on the resolve).

**Consequences.**
- Scoped-non-holder writes and client snapshot reads are correct; the discard rides a Set
  robust to data's re-entrancy timing (no longer an implicit cross-repo execution-order
  contract).
- `committed` is a real durability claim (owner-sequenced + logged + owner-fsync when storage
  is set); a quorum-less owner NACKs instead of falsely acking, so the never-drop fallback
  keeps the write alive on the forwarder rather than only in volatile owner `pending`.
- Fire-and-forget stays the zero-overhead hot path (the no-confirm method returns `doWrite()`
  directly; `index.perf.ts` unchanged). The latency ladder is MEASURED (`confirm.perf.ts`):
  accepted/committed-owner ~local (sub-ms), committed-forwarded ~1 owner RTT (~4× local).
- Tests: P2 placement/convergence green again + a focused scoped-non-holder regression; a
  client no-sticky-copy regression; the transport ack test rewritten to the outcome contract
  + a withholding-NACK leg; 6 confirm tests. resource 82, transport 85, chaos 7.

**`replicated` landed** (`0823a10`, `7c93b31`) — a WRITER-side W-quorum probe, NOT a tag on
the replication stream: tagging would put an ack-id on an out-of-order point-to-point data
frame and advance a replica's dedup high-water past a record it then drops (a silent gap).
Instead the record replicates in-order untouched, and the writer probes the key's R-set with
(origin, seq) via a separate REPL_PROBE control frame; a replica HOLDS a probe it can't yet
satisfy until applyInbound advances its high-water to seq, then REPL_ACKs. W = majority of the
effective replica count (the same majority the ViewManager uses); owner + local holder count
toward it; timeout ⇒ reject 'quorum' (committed, just under-confirmed). Owner-write and
forwarded-write unify (the committed-ACK carries the owner's origin so a forwarder can probe).

**Membership-churn recount landed** (this commit) — probeReplicated snapshots the R-set once
at commit, so a view change mid-probe could strand it: an evicted target never acks (the per-cid
timer was the only exit), and a freshly-admitted R-set member was never probed (the new path to W
went unused). `recountProbes()`, chained off the ViewManager `onCommit` (after the ring installs,
alongside markOrphans/resync), re-evaluates every in-flight tally against the NEW R-set/W: it
drops acks/probes from members the new R-set no longer contains (durability is "W of the CURRENT
R-set"), settles `true` at once if the survivors already meet W, and probes the freshly-admitted
members (they acquire the partition via resync, then ack). The per-cid timer stays armed as the
liveness backstop for the genuine can't-reach-W case. Two chaos tests pin both outcomes — stranded
peers under a held view reject 'quorum' (timer, no hang, no tally leak); an eviction-driven view
change re-probes the survivors and RESOLVES what an evicted target alone could not — and a
`[diagnostics].confirms()` seam asserts the writer-side tally drains to 0. resource 84, chaos 9.

**`cluster.writes` introspection landed** (this commit) — the operability answer to "show how
long each guarantee takes", AT RUNTIME rather than only via the perf suite. A gated, bounded
ring-buffer ViewProxy (resource/writes.ts): every `confirm` write shows up as a record that goes
`pending` → `confirmed`/`rejected` carrying its measured `latency` + (committed/replicated)
`seq`/`epoch` + (rejected) `reason`. Reactive, so `cluster.writes.filter('state','pending')` is
what's in flight and `cluster.writes.filter('tier','replicated').avg('latency')` is how long the W
bar costs — no firehose: fire-and-forget writes (the steady hot path) are NOT recorded (no
guarantee to time). Built LAZILY on first `cluster.writes` access (an un-introspected node never
allocates the ring; the emit-sites are `writesLog?.…` predicted-false branches until then) and —
unlike observe — NOT nulled on detach: its emit-sites are already off the steady record path, the
ring is bounded (drop-oldest, can't leak), and staying armed lets a late `await cluster.writes` see
the running history. Two perf guards: fire-and-forget is byte-for-byte untouched (it's confirm-only)
and the armed recording cost stays bounded. resource 87 + writes 5, perf +2.

**`origin` on the resolve landed** (this commit) — the resolve now carries
`{tier,key,seq,epoch,origin}` (and the reject's `localCommit` + the cluster.writes record carry
`origin` too). It already flowed internally — `lastCommit` stamps the owner's uuid, the WRITE-ACK
relays it, the replicated probe keys on it — so this just exposes it. With `(epoch, seq, origin)`
a caller has the committed record's FULL LWW coordinates and can detect a dominating later write
superseding theirs (committed = SEQUENCED, not necessarily WON). origin is the OWNER's provenance
(this node for an owned write, the owner's uuid for a forwarded/client write — NOT the forwarder's).

**Open follow-ups → [IDEAS](IDEAS.md):** the `persisted` tier (a real `fsync(2)` —
`appendFileSync` only reaches the page cache — plus durable-view-epoch recovery); the
flush-on-return escalation policy (escalate bare assignments to 'committed' only, never the
network tiers); cid-dedup on the owner for non-idempotent retries (LWW value-sets are already
idempotent); the SERVER-local assignment auth-interception parity gap (#6) stays open by design
(the re-entrancy guard).
