# Glossary

A reference for reviewers: every domain term, identifier, acronym, and milestone code used across fero, defined in the project’s own vocabulary. fero is a distributed, replicated, reactive-resource library built on the sibling [`data`](../data/) reactive-collections lib — `fero(name, opts) → { data, methods, cluster, destroy }`.

> Generated to aid review. Look up any unfamiliar symbol you hit in the diff here. File:line sources are findability hints from this branch — a few may drift by a handful of lines as comments are added/removed.

## Renamed in this branch

The readability refactor renamed these. Old → new, and why:

| Old | New | Why |
|---|---|---|
| `log/partition.ts` | `log/log.ts` | the file defines `class Log`, not a `Partition` |
| `resource/view.ts` | `resource/membership.ts` | kills the 3-way "view" name collision |
| `applyLocalWrite` | `commitForwarded` | funnels a forwarded write back through the sink into `commitLocal` |
| `dropLocal` | `discardOptimistic` | discards an optimistic value applied before a forward |
| `foldOnce` | `gatherOnce` | one-shot global gather (await) — names the once-vs-live axis |
| `openFold` | `gatherLive` | live global gather (subscription) — names the once-vs-live axis |
| `snapshot` (handle.ts) | `forWire` | reduce a method return to wire form; surfaces its hidden Promise branch |

## Contents

- [Architecture & layers](#architecture-layers) (11)
- [Data model (the data sibling)](#data-model-the-data-sibling) (12)
- [Transport (L0)](#transport-l0) (28)
- [Log & view (L1)](#log-view-l1) (14)
- [Resource & methods (L2)](#resource-methods-l2) (22)
- [Replication & consistency](#replication-consistency) (44)
- [Distributed aggregates (Q2/Q3)](#distributed-aggregates-q2q3) (19)
- [Membership & views (V)](#membership-views-v) (14)
- [Milestones (the letter codes)](#milestones-the-letter-codes) (36)
- [Conventions & process](#conventions-process) (6)

## Architecture & layers

**arch A vs arch B** — Arch A (L1's distribute/view) derives state FROM the log (the log is the write API); arch B (L2 resource) inverts it — the proxy is the source of truth and the log a history sidecar — because routing assignment writes back through the log would loop. So distribute() is the standalone demonstrator, not the production replication path. <sub>*log/README.md:60-61 (DECISIONS H)*</sub>

**L0 — transport** — The lowest fero layer: peer pool, DHT consistent-hashring, view-membership control frames, binary wire framing, and RPC/subscription routing. Exposed as transport(opts) → Mesh; holds no state of its own. <sub>*plan.md §3; transport/*</sub>

**L1 — log + view** — Per-partition append-only log of change records, with view(log) projecting the log tail as a $() ViewProxy, plus offset-vector + anti-entropy sync primitives. Standalone-usable; lives in log/. <sub>*plan.md §3; log/*</sub>

**L2 — resource** — The public API layer: fero(name, opts) returning the three surfaces, plus the replication core (provenance/dedup/LWW), view-synchronous membership, R-way holding, owner-routed writes, and distributed aggregates. Lives in resource/. <sub>*plan.md §3; resource/*</sub>

**L3 — planner** — The deferred 'big rethink': a distributed-operator-graph planner that splits an operator chain into per-partition + roll-up + local stages. Its first slices (Q2/Q3) ship inside L2 today rather than in planner/. <sub>*plan.md §3,§10*</sub>

**L4 — tooling** — The top layer: CLI, devtools cluster tab, examples, and chaos tests. Only the chaos-harness + reversible-partition seam slice has landed; CLI/devtools/examples are still to come. <sub>*plan.md §3,§10; DECISIONS.md L4*</sub>

**Mesh** — The thin routing/membership seam transport(opts) returns — a flat object of routing (owner/owners/send/replicateTo/broadcast/forward), membership (installView/viewMembers/viewPrepare/viewAck/viewCommit), catch-up (digestTo/catchupTo), RPC (call/subscribe/deltaTo) plus peers/me/uuid/ready/destroy. Deliberately wide (L1/L2 use most of it) but owns no data store — not a god-class. <sub>*transport/index.ts (type Mesh, function transport)*</sub>

**onRecord / onConnect / onDigest / onCall / onSubscribe / onWrite / onView* / onPeerGone hooks** — The TransportOpts callback surface — exactly one onX hook per inbound verb, each wired to one case in dispatch(). E.g. onRecord = inbound replication records, onWrite = a peer forwarded a write-request for a partition we own, onPeerGone = a peer's connection dropped (reap its served subscriptions). <sub>*transport/index.ts:39-53 (TransportOpts)*</sub>

**S — Decomposing the fero() god-closure** — The split of the 1337-line L2 closure into a thin composer (index.ts, keeping the replication core) plus handle.ts (lazy handles + FOLD_HANDLES), fold.ts makeFold (aggregate engine), and dispatch.ts makeDispatch (RPC/subscription servers + data facade). No behaviour change. <sub>*DECISIONS.md S (ceb4262 → 7c8db02)*</sub>

**self (me) as local member** — Self is a ring member (owns partitions) and a row in cluster.peers, but has NO socket — a record whose owner === me is delivered locally (deliverLocal → onRecord), never written to a wire. Seeded via dht.add(me) so a pre-view write owns locally and broadcasts (converges) rather than misroutes. <sub>*transport/index.ts:149 (me seeding), send()*</sub>

**transport(opts)** — The L0 composition root / public entry: wires discovery → peer pool → handshake → DHT and returns a Mesh. Pure composition (no god-class); delivers inbound records to onRecord (L1 consumes them) and never owns a data store. <sub>*transport/index.ts:89*</sub>

## Data model (the data sibling)

**[value] (the value symbol)** — The value Symbol used to read a proxy's raw underlying data (proxy[value]) or replace it (proxy[value]=x) — NOT proxy.value, which would create a child view named 'value'. fero uses it for snapshots and the reactive-vs-snapshot facade dispatch. <sub>*../data/CLAUDE.md common gotchas*</sub>

**AggSpec / FoldSpec** — AggSpec is the SERIALIZABLE aggregate spec that crosses the wire (never a closure): { op, col?, val? }. FoldSpec adds the fold:true flag a CLIENT sets so a server coordinator folds the global rather than returning its own partial. <sub>*resource/fold.ts:36 (AggSpec), :37 (FoldSpec)*</sub>

**change record** — data's emitted delta {type:'update'|'insert'|'remove', key, value, at?} — identical in memory, in the log, and on the wire, so there is no translation layer (the change-record-IS-the-wire-format principle). <sub>*plan.md §2; ../data/CLAUDE.md*</sub>

**ChangeRecord** — The single record/wire/log unit: {type:'update'|'insert'|'remove'|'move', key:string[], value?, at?} optionally stamped with provenance origin/seq/epoch. It is data's change record, the L1 log entry, AND the wire format — put on the socket as-is with no intervening serializer (the day-0 hypothesis). <sub>*transport/message.ts:100-108*</sub>

**Context** — Every method's 2nd arg: { data, cluster, methods, log, name, peer? }. peer is the calling peer's listen address (set for routed RPC, undefined for an in-process method-to-method call); context.methods is localMethods so in-handler calls run locally. <sub>*resource/index.ts:68 (type Context)*</sub>

**FunctionSink** — data's sink that calls fn(change) per event (from connect(obj, fn)); held by the view only via WeakRef, so long-lived replication must pin it. fero's owner-scoped partials and write-capture emit through it, and it can't be synchronously disconnected (hence generation-guarded rebuilds in Q2c). <sub>*../data/core.ts:990; DECISIONS.md Q2*</sub>

**Method** — The method-handler type (arg, context) => any. A method assigning to context.data is a trusted local commit replicated by the sink — it does NOT re-invoke the method (recursion-safety, plan §5). <sub>*resource/index.ts:53 (type Method)*</sub>

**operators** — data's chainable incremental transforms (filter, between, az/za/top/limit, length, sum/avg/max/min, some/every, intersect/union/except, group/distinct, map/to/reduce, tap, keys/values) producing derived ViewProxies whose change stream IS the wire format for a subscription. <sub>*../data/CLAUDE.md; plan.md §2*</sub>

**partition** — A record's top-level key (or its at for a root insert) — the unit the log segments by and the unit ownership moves on via the DHT, so segments map cleanly onto rebalancing/shedding. <sub>*transport/message.ts:110-114 (partitionOf); log/log.ts*</sub>

**partitionOf(record)** — Derives the partition a record belongs to: its first key element (key[0]), or its at if the key is empty (the BI0 root-insert case where the logical key lives in at). Used by L0 to route to an owner and by L1 to segment the log. <sub>*transport/message.ts:110-114*</sub>

**record-as-log-entry model** — The foundational L1 design where a data change record ({type, key, value, at?}) IS a log entry verbatim — no translation — so the log is just ordered records segmented by partition. <sub>*log/README.md:3; log/log.ts:1-3*</sub>

**ViewProxy** — data's $()-wrapped reactive collection that fero distributes: reads via property access (data.user42), writes via assignment, operators (.filter/.group/.tap/.connect) chain off it, and await yields a snapshot. data, methods results, and cluster.peers are all ViewProxies. <sub>*../data/CLAUDE.md; plan.md §1-2*</sub>

## Transport (L0)

**controlFrame(verb, value, id?)** — Builds a CONTROL frame carrying exactly one record whose value IS the payload — the shape every non-data verb (CALL/RESOLVE/REJECT, SUBSCRIBE/UNSUBSCRIBE, DIGEST, VIEW_*, JOIN_REQUEST) uses. Decode the payload back with frame.value; names the shape so callers stop hand-spelling encodeFrame([{key:[],value}], {verb,id}). <sub>*transport/message.ts:288 (controlFrame)*</sub>

**DHT (consistent hashring)** — A pure in-memory routing function (emits no bytes) mapping a partition key to its owning peer + the next R-1 distinct peers clockwise. Two parallel sorted arrays — #hashes: Uint32Array (ascending) + #owners: string[] (aligned) — so lookup is an allocation-free, branch-light binary search. Consumes committed-view membership via installView; the ring changes only on a view commit. <sub>*transport/dht.ts:43 (class DHT)*</sub>

**dialed vs accepted (inbound/outbound)** — A Peer is dialed (outbound — we connected, redial on drop, and initiate the handshake) or accepted (inbound — wrapped from an accepted socket, never redialed). broadcast fans out ONLY over dialed connections so each record is delivered once in a full mesh (each pair has two directional sockets). <sub>*transport/peer.ts:107 (get dialed); transport/peers.ts:224 (broadcast)*</sub>

**dispatch()** — The routing core inside transport(): routes every inbound frame by verb to its own hook so a control/membership frame can NEVER fall through to onRecord (the data path). First tries handshake handle() (INIT/SYNC/DONE), then switches on frame.verb; fails closed on an unrecognized verb (drop + warn once per verb). <sub>*transport/index.ts:167 (function dispatch)*</sub>

**encodeFrame / encodeFrames** — encodeFrame encodes a batch of change records into ONE length-prefixed RECORDS frame (one socket.write), optionally writing a u48 id and provenance. encodeFrames splits a mixed-origin batch into the FEWEST frames each satisfying the single-origin, contiguous-seq, single-epoch invariant — a run breaks on an origin change, a Lamport-seq gap, or an epoch change. <sub>*transport/message.ts:214 (encodeFrame), 297 (encodeFrames)*</sub>

**FLAG_PROV / provenance ext** — When FLAG_PROV is set the body opens with [origin str][baseSeq varint][epoch varint] before the record count, and every record is ONE origin's consecutive writes (seq = baseSeq + index) within ONE view-epoch. L1/L2 use this for dedup, anti-entropy catch-up, and LWW; the single-origin-contiguous-seq invariant is load-bearing. <sub>*transport/message.ts:30 (FLAG_PROV)*</sub>

**Frame** — A zero-copy view over one complete framed buffer: MAGIC | flags | verb | bodyLen:u32 | [u48 id] | [prov] | body. Getters (flags/verb/id/origin/baseSeq/epoch/value) and records() decode lazily; .value is the single payload of a control frame (records()[0].value). <sub>*transport/message.ts:356 (class Frame)*</sub>

**Framer** — One per peer; push(chunk) returns the complete frames in the stream so far and retains a frame split across TCP chunks as a single subarray carry (no per-byte copy) until the rest arrives — a Buffer.concat happens ONLY on a genuine straddle. bodyLen is a fixed u32 (one readUInt32LE per frame, no byte-loop) bounded against MAX_FRAME before the straddle check (anti-OOM). <sub>*transport/message.ts:320 (class Framer)*</sub>

**hash32 (djb2 + fmix32)** — The ring hash: djb2 accumulation (seed 5381, *33) finished with an fmix32 avalanche finalizer. The finalizer is NOT optional — plain djb2 diffuses poorly on trailing chars, so an address's vnodes (differing only in the last char) would cluster and skew distribution; fmix32 spreads low-bit differences across all 32 bits. Injectable (pending a bake-off vs wy/xxhash). <sub>*transport/dht.ts:26 (hash32)*</sub>

**identify()** — Resolves an accepted inbound peer's real identity from the completed handshake: an inbound SERVER becomes a shadow re-keyed to its listen address, an inbound CLIENT is published under its ephemeral address as role 'client', a dialed peer gets its uuid stamped. Idempotent (guards a replayed DONE re-keying twice) and self-rejects by uuid. <sub>*transport/peers.ts:109 (identify)*</sub>

**isolate / heal** — Fault injection (chaos harness) reversible link isolation. isolate(address) severs our dialed link AND blocks any redial (direct retry or gossip-revival) so the cut PERSISTS — symmetrically applied it is a true bidirectional partition. heal() reverses it: unblock + re-dial → reconnect → handshake → anti-entropy heal → view re-admit. Distinct from drop() (terminal, one-directional). <sub>*transport/peers.ts:239 (isolate), 251 (heal); transport/index.ts:384*</sub>

**MAGIC / FrameError / MAX_FRAME** — MAGIC (0xFE) = protocol marker + version byte (bumped on wire change). FrameError = a distinct type thrown on a malformed/hostile frame (bad magic, oversized body, count/length overrun, reserved value type) so the peer drops the connection on a wire fault without swallowing a handler bug. MAX_FRAME = the 256 MiB per-frame body ceiling guarding against OOM from one bad header. <sub>*transport/message.ts:24,87,93*</sub>

**onPeerGone / reap** — Fired when a peer transitions TO disconnected (socket close/destroy) — the signal L2 reaps that peer's served subscriptions on, since a socket close never sends UNSUBSCRIBE. Gated to the status CHANGE (so a suspect flip doesn't spuriously reap) and to !dialed (subscriptions are served over inbound sockets — a dialed peer serves none). <sub>*transport/peers.ts:189 (#mirror → #onPeerGone); transport/peer.ts:208*</sub>

**outbox (microtask-batched send)** — The per-peer send path: send(record) queues into #outbox and schedules a flush; flush() coalesces all records queued in one microtask into the fewest frames (own writes = one origin/contiguous seqs → one frame; a relayed cross-origin batch splits via encodeFrames) and writes once per tick. Relies on the single-origin-contiguous invariant. <sub>*transport/peer.ts:252 (send/#schedule/flush)*</sub>

**Peer** — One peer: the TCP socket lifecycle + a small connection state machine (dial/reconnect, the microtask-batched outbox, the PING/PONG failure detector). Zero events (not an EventEmitter) — surfaces state via injected onStatus/onFrame/onGone callbacks. role (server|client) is kept separate from status (connection state). <sub>*transport/peer.ts:54 (class Peer)*</sub>

**Peers (peer pool)** — The peer pool: ONE source of truth — peers, a data $() proxy keyed by address holding membership+status (exposed as cluster.peers) — with membership 'lists' (e.g. connected) as derived .filter projections maintained in O(delta). The headline L0 rethink replacing fero-old's six imperative arrays rebuilt on every transition. Socket machinery (Peer instances) lives in a side #conns Map. <sub>*transport/peers.ts:35 (class Peers)*</sub>

**pickServer / hasServer** — pickServer picks a connected SERVER peer (not self) to route a call/subscription to when no explicit to is given (v1 takes the first match). hasServer() reports whether such a peer exists — i.e. whether the cluster is reachable for a client call. <sub>*transport/index.ts:255 (pickServer), 350 (hasServer)*</sub>

**RECORDS frame (id vs no-id)** — The steady-state DATA path (highest-throughput inbound). A RECORDS frame WITH a frame id is a subscription delta (routed by sub id); WITHOUT one it is plain replication (delivered to onRecord). A frame with an id but no matching sub is a STALE delta for a closed subscription and is DROPPED (else it would mis-apply a {key:[]} delta as a root replace — the Q2c churn bug). <sub>*transport/index.ts:223 (VERB.RECORDS case); DECISIONS Q2*</sub>

**RecordView** — A lazy-decoded change record: type is one byte; key/at/value are decoded (and memoised) only when read, so a relayed record is re-sliced and re-sent with zero key/value parse. Stamped with provenance (origin/seq/epoch) by Frame.records() when the frame carries it. <sub>*transport/message.ts:481 (class RecordView)*</sub>

**Retries (backoff)** — Jittered, capped exponential backoff for server reconnection (injectable jitter source for deterministic tests). next() returns base*2^n capped at cap ± jitter; reset() on a successful connect; after max attempts next() returns -1 and peer.ts destroys the peer. Drives the STATUS.throttled state. <sub>*transport/retries.ts (class Retries)*</sub>

**shadow (#shadows)** — An identified inbound SERVER socket, re-keyed to its learned listen address. Owns no cluster.peers row and is not in #conns (so broadcast/the ring never see it), but serves as a point-to-point SEND fallback (when no dial-back exists) and the sole server-pair subscription-reap trigger. The DIALED peer to that listen address is the routable/ring identity and wins when present. <sub>*transport/peers.ts:53 (#shadows), identify()*</sub>

**staticDiscovery / Candidate / broker** — Static (non-multicast) rendezvous — the sensible default for cloud/WSL2 where IPv4 multicast is dropped. Emits the cartesian host × port space (plus an optional well-known #broker, just another static candidate) as candidate insert records into a $() proxy keyed by 'host:port', self-filtered. The pool taps it and dials; staggering/rate-limiting is the pool's job. <sub>*transport/discovery/static.ts (staticDiscovery, type Candidate)*</sub>

**STATUS** — The peer connection-state enum, re-exported as part of the L0 public surface: disconnected(0), connecting(1), throttled(2) (waiting out a reconnect backoff), connected(3). The view layer never trusts raw STATUS.connected for liveness — it keys off suspect instead. <sub>*transport/peer.ts:32 (const STATUS)*</sub>

**VERB** — The dense 1-byte frame-verb enum (byte 2) enabling flat dispatch: RECORDS(1), ACK(2), INIT/SYNC/DONE(3-5), RESOLVE/REJECT(6,7 RPC reply), DIGEST(8 anti-entropy), CALL(9 RPC request), SUBSCRIBE/UNSUBSCRIBE(10,11), WRITE(12 forward-to-owner), PING/PONG(13,14 liveness), VIEW_PREPARE/ACK/COMMIT(15-17), JOIN_REQUEST(18). <sub>*transport/message.ts:36 (const VERB)*</sub>

**vnodes (VNODES)** — Virtual nodes per peer (default 200) — each address hashes to 200 ring slots (addr+'*'+i) for a smooth distribution and ~1/N key movement on churn. ~1000 entries (5 peers × 200) is ~4KB and cache-resident, vs the legacy RBTree of heap-scattered nodes. <sub>*transport/dht.ts:17 (const VNODES)*</sub>

**VT (value-type nibble) / zigzag varint / encodeValue seam** — The value codec (tag bits 4-7): scalars null/undefined/false/true carry ZERO value bytes (tag-only), int is a zigzag varint (int32 range), f64 is 8 LE bytes, str is varint-len + utf8, obj falls back to JSON utf8 behind a swappable encodeValue/decodeValue seam (a CBOR swap is gated on a perf number). <sub>*transport/message.ts:67 (const VT), 192 (zigzag)*</sub>

**writable (admit race gate)** — Whether a control frame can be written RIGHT NOW (socket exists and is writable). A peer row can exist while its socket is still connecting (the admit race — a member enters the committed view a tick before its socket finishes), and write() would silently DROP a control frame; gating subscribe() on writable makes a not-yet-connected peer report failure and be retried rather than recorded as subscribed. <sub>*transport/peer.ts:118 (get writable); transport/index.ts:362*</sub>

**Writer** — A growable scratch encode buffer (u8/varint/f64/str writers with doubling ensure()) backing the standalone encodeFrame() used by tests, handshake, and the slow-start path. The per-peer outbox will later serialize straight into a preallocated buffer with no growth. <sub>*transport/message.ts:132 (class Writer)*</sub>

## Log & view (L1)

**#index (provenance index)** — The Log's private parallel map of provenance-key → records kept seq-ascending, populated only for records carrying origin; it backs recordsSince/marks and lets a peer's missing tail be a binary-search slice. <sub>*log/log.ts:58,80-86*</sub>

**#segments** — The Log's private Map<partition, ChangeRecord[]> of ordered records — the durable history a node replays on restart and the source since/diff/heads read from. <sub>*log/log.ts:57*</sub>

**applyRecord(res, record)** — The terminal apply contract — the inverse of the wire codec and the one place records become state: maps update→res.update, insert→res.insert(value,key,at), remove→res.remove onto a data res ('move' intentionally unhandled). Shared with L2. <sub>*log/index.ts:26-33*</sub>

**diff()** — diff(base) returns every record past the caller's per-partition offsets — the full offset-vector delta to bring a peer at base up to head; partitions absent from base stream from 0. <sub>*log/log.ts:118-127*</sub>

**distribute()** — The standalone arch-A demonstrator: {data, log, mesh} wiring a log+view onto an L0 transport mesh where local appends broadcast to peers and inbound records append locally; an inbound guard flag makes replication one-hop (no echo storm). v1 is full replication via dialed broadcast — NOT the production replication path. <sub>*log/index.ts:45-71*</sub>

**head / head()** — A partition's current head is its entry count (#segments.get(p).length); append returns the new head and head(partition) reads it. Heads are the offsets the offset-vector sync uses. <sub>*log/log.ts:73-90,99-102*</sub>

**heads()** — The offset vector {partition → head} across all partitions — the digest a peer sends in offset-vector sync, to which the holder replies with diff(theirHeads). <sub>*log/log.ts:104-110*</sub>

**inbound guard / no-echo** — The one-line echo guard in distribute(): an inbound flag set while applying a received record stops the onAppend listener from re-broadcasting it, keeping replication one-hop so peers don't re-echo records. <sub>*log/index.ts:50,57-68*</sub>

**Log (class)** — The L1 append-only log: a #segments map (partition→ordered records, the durable history + replication source) plus a parallel #index provenance map, exposing append/onAppend and the two sync vocabularies (offset-vector and provenance anti-entropy). <sub>*log/log.ts:56-189*</sub>

**log() / Log opts** — log() returns a fresh full-replication Log; scoped granularity is opted into via new Log({ scoped: true }). The public L1 surface re-exports Log and value alongside view/applyRecord/distribute. <sub>*log/index.ts:22-24; log/log.ts:50-64*</sub>

**onAppend()** — Internal plumbing (not a public event) to observe appends synchronously; the view and the replicator both subscribe here, and it returns an unsubscribe. <sub>*log/log.ts:92-97*</sub>

**since()** — since(partition, offset) returns the records appended to a partition at or after an offset — the per-partition catch-up tail (a segment slice). <sub>*log/log.ts:112-116*</sub>

**size** — Total record count across all segments — the Log's overall entry count (sum of segment lengths). <sub>*log/log.ts:184-188*</sub>

**view(log)** — Projects a log into a $() ViewProxy: creates $({}), replays every existing record through applyRecord, then subscribes via onAppend so each future append projects too — pure read-side, log→view, one direction. <sub>*log/index.ts:35-43*</sub>

## Resource & methods (L2)

**clientHandle** — A makeHandle with no target — routed to a picked connected server. The methodSurface of a read-only client is a Proxy that returns clientHandle(name, arg) for every method access. <sub>*resource/dispatch.ts:245 (clientHandle)*</sub>

**cluster (surface)** — { peers, me?, uuid, owner(key), replicas(key), epoch, members, writable } — peers is the L0 ViewProxy; me is this server's listen address (undefined for a read-only client); owner/replicas expose the DHT ring; epoch/members/writable expose committed membership and the write-gate. <sub>*resource/index.ts:55 (type Cluster), :657 (cluster)*</sub>

**data (surface)** — A $() ViewProxy of the resource state: reads via property access (r.data.user42), writes via assignment (r.data.user42 = {…}). Returned as dispatch.dataFacade — the hold-relative facade on a scoped/client node, the raw proxy under full replication. <sub>*resource/index.ts (return) + dispatch.ts dataFacade*</sub>

**data facade (dataFacade)** — A Proxy over the raw data proxy whose classification ladder (load-bearing order) routes a top-level get: symbols/built-ins → raw; decomposable aggregate → distributed(); holistic op → loud guard; registered operator → raw; otherwise a partition key → readKey (held-local child | remote handle). Built only for scoped||client; a full-replication server returns the raw proxy (hot path unchanged). <sub>*resource/dispatch.ts:383 (dataFacade)*</sub>

**destroy** — Teardown: drops the mesh and the write-capture sink, clears the anti-entropy timer, destroys the ViewManager, and drains every clientSubs unsubscribe. <sub>*resource/index.ts:735 (destroy)*</sub>

**diagnostics seam** — A Symbol-keyed internals handle on a returned fero() instance (off the typed/enumerable public API): servedSubscriptions (live served-subscription count), drop (abruptly close a peer's connection — no UNSUBSCRIBE), and isolate/heal (the reversible bidirectional partition primitive the chaos harness uses). <sub>*resource/index.ts:748 ([diagnostics]), :759*</sub>

**drop()** — Fault injection: abruptly close a peer's connection with NO UNSUBSCRIBE/teardown frames — the way a real network drop looks. Drives onPeerGone (L2 reaps that peer's served subscriptions, since a socket close never sends UNSUBSCRIBE). Terminal and one-directional, unlike isolate/heal. <sub>*transport/index.ts:376 (drop)*</sub>

**fero(name, opts)** — The whole library in one async call: the L2 composer that builds the replication core onto an L0 mesh and returns { data, methods, cluster, destroy }. await fero(...) IS the ready signal — resolves once the cluster is reachable or after wait ms with no peers (the 'I'm first' case). <sub>*resource/index.ts:116 (function fero)*</sub>

**gathersWholeRead / usingDefaultRead** — The combined rule scoped && allMethods.read === defaults.read, named once: a no-key read() on a scoped node must GATHER the whole resource (no node holds it all), but only when read is the BUILT-IN — a user's own read projection is never silently swapped for the raw gather. <sub>*resource/dispatch.ts:50-51*</sub>

**hold-relative reads** — Reads are synchronous-and-local for a partition we hold, a remote handle for one we don't. The dataFacade's readKey implements the split (Q1): holds(key) ? data[key] : remoteRead(key). <sub>*resource/dispatch.ts:257 (readKey), :383 (dataFacade)*</sub>

**holds(key)** — The core ring predicate — does this node replicate a partition's records? Full replication ⇒ always (short-circuits when R≥members, no ring scan); scoped (finite R) ⇒ only if we're in the partition's R-set on the committed-view ring; a read-only client holds nothing. Gates inbound delivery, scoped-vs-broadcast replication, and the facade read. <sub>*resource/index.ts:358 (const holds)*</sub>

**lazyHandle** — The shared skeleton for fero's two lazy remote handles (Proxy(noop)): a thenable (then ⇒ one-shot resolve, the ONLY access that does not open the live thing) AND a live data ViewProxy (any real prop access lazily open()s a subscription/fold once and delegates). Guard order 1→5 is load-bearing (two Q3b defects came from reordering). <sub>*resource/handle.ts:26 (lazyHandle)*</sub>

**makeDispatch** — Builds, once per fero() node, everything between 'a method name arrives' and 'a value/stream goes back': the inbound RPC + subscription servers (serveCall/serveSubscribe/serveUnsubscribe/reapPeer), the local + client method surfaces, the lazy remote-read handles, and the data facade. Closes over node state by reference plus injected invoke + fold. <sub>*resource/dispatch.ts:43 (makeDispatch)*</sub>

**makeHandle** — A remote-access HANDLE built on lazyHandle: await ⇒ a one-shot RPC (mesh.call), real access ⇒ a server-pushed live subscription (mesh.subscribe applied through applyRecord). to() picks the target peer lazily; the read handle passes a writeKey to route a depth-1 nested write to the raw proxy. <sub>*resource/dispatch.ts:228 (makeHandle)*</sub>

**methods (surface)** — RPC + subscriptions on one namespace: default update/insert/remove/read/aggregate, each overridable by a same-named opts function. A method returns whatever it wants; the caller's await-or-not picks the consumption mode (Promise for value, ViewProxy for live subscription). <sub>*resource/index.ts (defaults, allMethods) + dispatch.ts methodSurface*</sub>

**orphans / shedding** — An orphan is a partition a node holds but no longer replicates per the committed ring (a former replica after ring expansion, or a write committed locally at a non-replica) — an extra copy violating 'exactly R replicas'. KEPT until a current R-set member is confirmed caught up, then shed; never losing data. Scoped-only (P4). <sub>*resource/index.ts:505 (const orphans); DECISIONS P4*</sub>

**proxy-as-source (arch B) vs distribute (arch A)** — In L2 the PROXY is the write API (assignment is the write surface) — the write-capture sink turns proxy emissions into log appends + broadcasts. Contrasted with L1's distribute() (arch A) where the LOG is the write API; L2 inverts it because routing assignments through the log would loop. <sub>*resource/index.ts:21-32 (MODEL comment)*</sub>

**read-forwarding / forwardTarget** — Q1: a scoped read(key) for a partition we don't hold routes to its owner (which holds it → no re-forward). forwardTarget returns the owner to forward to or undefined to serve locally; serveCall awaits mesh.call('read', key, owner), serveSubscribe relays the owner's deltas. <sub>*resource/dispatch.ts:56 (forwardTarget), :68/:128*</sub>

**remoteRead** — Owner-routed remote read (Q1): reading a partition this node doesn't hold returns a handle that fetches (await) or subscribes from a HOLDER — a server routes straight to owner(key), a client routes to a picked server (which read-forwards to the owner). <sub>*resource/dispatch.ts:252 (remoteRead)*</sub>

**serveCall / serveSubscribe / serveUnsubscribe / reapPeer** — The inbound-RPC and subscription servers. serveCall runs a method here (with read-forwarding / client-coordinator gather branches) and ships the return; serveSubscribe streams a ViewProxy's deltas (or one value); serveUnsubscribe tears one down; reapPeer reaps a dropped peer's served subscriptions (the chokepoint that stops the gatherLive leak). <sub>*resource/dispatch.ts:68/128/195/208*</sub>

**Storage / fileStorage** — The durable-log seam { load, append }: load returns persisted records at boot (replayed through applyInbound before the mesh exists), append persists each accepted record. fileStorage(path) is the built-in append-only-file WAL adapter (one JSON change-record per line, synchronous fsync per write). <sub>*resource/index.ts:88 (type Storage); resource/storage.ts:15 (fileStorage)*</sub>

**streamProxy / ServedSub / subsByPeer** — Subscription-server plumbing: streamProxy connects a delta sink to a live ViewProxy and retains it under (address, subId) — plus src (the source proxy, so a derived projection's filter→op chain isn't GC'd) and an optional close teardown. subsByPeer is the reverse index address → open subIds that lets reapPeer reap an ungraceful disconnect instead of leaking sinks/openFolds. <sub>*resource/dispatch.ts:105 (ServedSub), :113 (subsByPeer), :124 (streamProxy)*</sub>

## Replication & consistency

**anti-entropy (digest / recordsSince)** — The reciprocal provenance catch-up: nodes exchange per-origin (or per-(origin,partition) when scoped) high-water digests and ship recordsSince(vector). Triggered on (re)connect, on view commit, and by a periodic antiEntropy timer (default 1000ms) — the backstop against the commit-order race and drift. Distinct from the offset-vector path. <sub>*DECISIONS.md B, P2; log/log.ts:156-182*</sub>

**applyInbound** — Accept a record into local state: dedup by per-seenKey high-water, Lamport-merge the clock, append to the log (full per-origin history), LWW-resolve, and apply only the winner to the proxy. Shared by inbound replication AND restore-from-storage replay; neither broadcasts (the applying guard). <sub>*resource/index.ts:218 (applyInbound)*</sub>

**applying (guard)** — A boolean set true while applyInbound (or discardOptimistic/shed) applies a record to the proxy, so the write-capture sink skips the re-emission — it was already logged/applied in onRecord and must not be re-logged or re-broadcast. <sub>*resource/index.ts:208 (let applying)*</sub>

**catch-up** — Bringing a (re)connecting peer current: since/diff do it by offset, recordsSince does it by provenance — the latter being what L2's catch-up ships on (re)connect. <sub>*log/log.ts:6-13*</sub>

**clock (Lamport clock) / seq** — This node's logical clock (a per-origin seq), merged up on every inbound record and bumped (++clock) on every local write — so a local write is always causally newest and WINS the LWW comparison, preventing permanent divergence against a high-numbered remote. Lives in resource/index.ts (not the Log), global per node; per-origin high-water marks of it dedup re-delivered records. <sub>*resource/index.ts:165 (let clock); DECISIONS.md A*</sub>

**commitForwarded** — Apply a peer-forwarded write to our proxy as a LOCAL write (un-guarded, so the sink runs) with committingForward set so the sink commits it as-is rather than re-evaluating ownership — turning the forwarder's optimistic write into our authoritative, sequenced one with no re-forward ping-pong. <sub>*resource/index.ts:631 (commitForwarded)*</sub>

**commitLocal** — Commit a record under OUR provenance: stamp origin=us + Lamport seq + view epoch, record the LWW winner, append to the log, and replicate (scoped: replicateTo the R-set; else broadcast). Used for partitions we own and as the never-drop fallback when an owner is unreachable; also the write-gate chokepoint (buffers into pending when canWrite is false). <sub>*resource/index.ts:585 (commitLocal)*</sub>

**committingForward (guard)** — A boolean set true while a FORWARDED write is applied locally (commitForwarded): the sink skips the F1 forward branch and commits it as-is in commit-local instead of re-checking ownership, so a forwarded write never bounces while ring views transiently disagree. <sub>*resource/index.ts:211 (let committingForward)*</sub>

**DIGEST (anti-entropy)** — A peer's anti-entropy digest — a per-origin (or per-(origin,partition) when scoped) high-water vector used for catch-up. digestTo ships it point-to-point (prebuilt control frame straight to the socket, not the batched outbox, so catch-up never disturbs the single-origin-contiguous invariant); catchupTo ships the records a peer lacks. <sub>*transport/message.ts:44; transport/index.ts:340 (digestTo/catchupTo)*</sub>

**discardOptimistic** — Silently remove a foreign partition we optimistically applied (set trap ran) but don't hold, after forwarding its write to the owner. Guarded by applying so the removal doesn't re-enter the sink (no echo, no spurious forwarded 'remove'). <sub>*resource/index.ts:514 (discardOptimistic)*</sub>

**drop() / shedding (Log)** — drop(partition) removes a partition's segment plus every (origin,partition) index group whose key ends with '\x00'+partition, when a scoped node sheds a partition it no longer replicates (Milestone P4); scoped-only, and afterward the node stops claiming the partition in its digest. <sub>*log/log.ts:133-144*</sub>

**exactly one broadcaster per record** — The structural safety property F1 forwarding guarantees: the partition owner is the single sequencer/broadcaster for its keys, so each (origin,partition) stream arrives in seq order from one source — which is why forwarding is sound where owner-relay (the reverted F) was not. <sub>*resource/README.md (Owner-routed writes / Invariants)*</sub>

**fencing (epoch fencing)** — Using the epoch to reject stale writes: epoch-fenced LWW (V1d) makes a newer-view write win so a straggler from a superseded view can't clobber current state. The still-open reject-stale-epoch-from-an-evicted-node fence needs per-partition owner lineage + uuid↔address. <sub>*DECISIONS.md V1d, V, F2; IDEAS.md*</sub>

**flushPending** — Once quorum returns, re-commit everything buffered in the write-gate pending queue, in order — so a partition's minority side that went read-only resumes without divergence. <sub>*resource/index.ts:645 (flushPending)*</sub>

**frame coalescing (encodeFrames interplay)** — In scoped mode recordsSince re-sorts its output by (origin, seq) so an origin's records across partitions coalesce into the fewest downstream frames — encodeFrames breaks a run on an origin change or seq gap — recovering single-frame full-replication behavior where held seqs are contiguous. <sub>*log/log.ts:160-164,179-181; transport/message.ts:291-309*</sub>

**full replication (scoped:false)** — The default mode where every node holds every partition, so one origin's whole seq stream is a single contiguous run and the #index is keyed by bare origin — a compact O(origins) digest whose catch-up frames coalesce into one. <sub>*log/log.ts:24-28,52*</sub>

**heldCache** — Per-key memo of the holds() owners() ring scan, cleared on every view commit (the ring is constant between commits). Keeps holds() O(1) in steady state on the inbound, write, and facade-read hot paths instead of an O(R) ring walk per access. <sub>*resource/index.ts:357 (const heldCache)*</sub>

**high-water vector / high-water mark** — A {provenance-key → highest seq} map summarizing what a node already holds; marks() produces the one a node sends and recordsSince(vector) consumes the peer's to compute the missing tail. <sub>*log/log.ts:9-15,146-182*</sub>

**index granularity (per-origin vs per-(origin,partition))** — The R-gated choice, fixed at construction, of whether #index keys on origin (full) or (origin,partition) (scoped); only one index is ever maintained so full replication pays nothing, and the scoped key prevents a per-origin mark from conflating partitions and silently dropping records on rebalance. <sub>*log/log.ts:24-36*</sub>

**last-writer-wins (LWW) — (epoch, seq, origin)** — Conflict resolution: concurrent same-key writes resolve lexicographically by (epoch, seq, origin) — a write under a NEWER membership view wins (epoch fencing), then Lamport seq decides within a view, then origin uuid breaks exact ties. Every node elects the same winner; the loser stays logged but doesn't mutate state. Whole-object and nested-field writes are independent version keys (field-level LWW). <sub>*resource/index.ts:230-240; DECISIONS.md A, V1d*</sub>

**markOrphans** — On a view commit (ring rebalanced), scan held partitions and note any we no longer replicate (per holds()) as orphans-to-shed. A write committed locally at a non-replica adds itself directly in commitLocal. <sub>*resource/index.ts:541 (const markOrphans)*</sub>

**marks()** — This log's own high-water digest {provenance-key → highest seq held} — the vector a node SENDS a peer so the peer can compute what to ship back; per-origin in full mode, per-(origin,partition) in scoped, naturally bounded to held partitions. <sub>*log/log.ts:146-154*</sub>

**offset-vector sync** — One of the Log's two sync vocabularies: heads/since/diff driven by per-partition entry-count offsets — the simple position-based catch-up primitive (distinct from provenance anti-entropy). <sub>*log/log.ts:6-8*</sub>

**origin / seq / epoch (provenance)** — Provenance carried on records and in the prov frame ext: origin = the uuid of the node that originated the write; seq = that origin's per-node monotonic sequence number (appended seq-ascending, an upstream invariant); epoch = the membership view-epoch the write was committed under (Milestone V), fenced at apply for epoch-fenced LWW (V1d). <sub>*transport/message.ts:105-107; DECISIONS V*</sub>

**originKey()** — The origin + '\x00' + partition composite key for scoped mode (neither part contains the \0 separator, which the resource's versionKey also relies on); exported and shared with L2 so the digest a node sends and the records a peer ships back agree byte-for-byte. <sub>*log/log.ts:42-46*</sub>

**owner-routed writes / single sequencer** — Writes route through the partition owner: a write to a non-owned key is forwarded (VERB.WRITE) to owner(K), which re-sequences it under its own provenance and broadcasts the canonical record. Exactly ONE owner stamps a partition's writes in order, giving a gap-free per-partition stream — making writes linearizable per partition and forwarding safe where relay was not. <sub>*DECISIONS.md F1; README.md*</sub>

**owner(key) / owners(key,R)** — owner(key) = the single peer that owns a partition (the first ring slot clockwise from hash(key), with a sole-member fast path that skips the hash+search). owners(key, replicas) = that owner plus the next distinct peers clockwise — the R-set for R-way replication. <sub>*transport/dht.ts:113 (owner), 123 (owners)*</sub>

**pending (write-gate buffer)** — The bounded (drop-oldest, MAX_PENDING) queue commitLocal buffers writes into while canWrite is false (can't reach a majority of the view) — instead of stamping/logging/broadcasting; flushPending drains it in order when quorum returns. <sub>*resource/index.ts:180 (pending)*</sub>

**primed (guard)** — A boolean that makes the write-capture sink swallow the empty attach-snapshot of the fresh proxy on the very first fire — so connect's initial snapshot isn't mistaken for a real write. <sub>*resource/index.ts:469 (let primed)*</sub>

**R / scoped / replicas** — Replication factor (Milestone P): replicas: R holds each partition on R replicas (owner + R-1 ring successors); the default ∞ holds every partition on every server (full replication, byte-identical to pre-P). scoped = R !== Infinity; R picks the granularity of log/dedup/anti-entropy. <sub>*resource/index.ts:138 (const R), :141 (scoped)*</sub>

**R-set / replicateTo** — Scoped replication (Milestone P): the owner + next R-1 replicas clockwise (owners(key,R)) form the R-set; replicateTo(addresses, record) ships a committed record to exactly that set, excluding self (the committer already applied+logged it via commitLocal). The caller passes the precomputed owners so the ring is walked once per write. <sub>*transport/index.ts:62,307; DECISIONS P/P4*</sub>

**rebalance-acquisition case** — When a node acquires a partition ((origin,partition) key absent from its vector); recordsSince then ships that group in full from seq 0, so a record's seq can sit below another origin's high-water yet still ship because there's no mark for that key. <sub>*log/log.ts:156-159*</sub>

**recordsSince()** — The anti-entropy primitive: given a peer's {provenance-key → highest seq} high-water vector, return every record whose seq exceeds the peer's mark for its key (binary search per group); keys absent from the vector ship in full, so a rebalance-acquired partition re-syncs from seq 0. <sub>*log/log.ts:156-182*</sub>

**resync / aeTimer (anti-entropy)** — Scoped-only reciprocal anti-entropy: resync sends our high-water digest to every other committed-view member asking for what we lack (the reply leg heals both directions) — the ACQUISITION path on a ring rebalance. Driven by ViewManager.onCommit (immediate) and a periodic aeTimer backstop. Off under full replication (onConnect catch-up suffices). <sub>*resource/index.ts:377 (resync), :434 (aeTimer)*</sub>

**scoped (mode)** — The holding mode (set once at construction via LogOpts.scoped / new Log({scoped:true})) for finite-R replication: the #index is keyed (origin,partition) instead of by origin, so a node materializing only a subset of partitions tracks each partition's stream independently. <sub>*log/log.ts:50-54,60-64*</sub>

**seen** — Dedup high-water map keyed by seenKey(origin, partition): per-origin under full replication (a compact digest), per-(origin,partition) under scoped holding. Doubles as the anti-entropy digest a node sends (Object.fromEntries(seen)). <sub>*resource/index.ts:170 (const seen)*</sub>

**seenKey** — The provenance key a record dedups / catches-up under: origin alone under full replication, originKey(origin, partition) under scoped holding. Mirrors the log's index granularity so the digest a node sends and the records a peer ships back agree on the key. <sub>*resource/index.ts:198 (const seenKey)*</sub>

**shed** — Fully drop an orphan partition: remove it from the proxy, the log (segment + provenance index), the dedup high-water (seen), and the LWW version map — a complete handoff off this node. Called ONLY once a current R-set member is confirmed caught up, so the partition is never under R-replicated. <sub>*resource/index.ts:528 (const shed)*</sub>

**shedConfirmed / shedReady** — On each inbound digest, for each orphan we hold, if the sending peer is a current R-set member whose high-water marks cover ALL our (origin,partition) records, record it as caught up in shedReady. Shed only once EVERY R-set member is confirmed (single-confirmation is unsafe when a whole R-set moves, e.g. {A,B}→{C,D}); conservative — a missing/lower mark keeps the orphan. <sub>*resource/index.ts:556 (shedConfirmed), :509 (shedReady)*</sub>

**versionKey** — The key path a record contends on for LWW. An insert folds at into the path so an insert and a later update to the same key contend as one key; distinct leaves (k1 vs k1.score) are independent → field-level LWW. Single-segment cases reuse an existing string (no join allocation on the hot path). <sub>*resource/index.ts:188 (const versionKey)*</sub>

**versions** — keyPath → current LWW winner stamp { epoch, seq, origin }. The stamp is MUTATED in place on re-write (not reallocated) because version churn was the dominant write-path allocation cost (DECISIONS G; guarded by index.perf.ts). <sub>*resource/index.ts:175 (const versions)*</sub>

**WRITE (write-request forwarding)** — A peer forwards a write-request for a partition the recipient owns (WRITE verb, point-to-point, not the batched broadcast outbox). The owner commits it locally (origin=owner) and replicates — becoming the single sequencer for the partition. Owner FORWARDING (one broadcaster per record) is safe where owner RELAY was not. <sub>*transport/message.ts:48; transport/index.ts:181,332; DECISIONS F/F1*</sub>

**write-capture sink** — The single data.connect({}, fn) sink that observes every change record the proxy's set/delete traps emit, stamps it with provenance, then routes it: prime-swallow, applying-skip, F1 forward-to-owner, or commit-local. The proxy is the write surface (arch B); this sink turns assignments into log appends + peer broadcasts. <sub>*resource/index.ts:470 (data.connect / writeHost)*</sub>

**write-gate / canWrite** — The CP chokepoint (V1e): a node commits/broadcasts only while it can reach a MAJORITY of its committed view (canWrite, a cached boolean recomputed each tick + on commit). When false it is read-only and BUFFERS writes (bounded, drop-oldest) via commitLocal's pending queue, flushing on quorum return — so a partition's minority side can't diverge. Exposed as cluster.writable; supersedes F1's never-drop local commit for a quorum-less node. <sub>*resource/membership.ts:53/268 (canWrite); resource/index.ts:180/:590/:645; DECISIONS V1e*</sub>

## Distributed aggregates (Q2/Q3)

**AGG registry** — One module-level entry per op pairing its owner-scoped PARTIAL builder with the associative COMBINE rule that folds per-holder partials into the global answer — the two halves of a decomposable aggregate, co-located so adding/changing an op is one edit. Stateless; partial is a factory over a per-instance PartialCtx so only the {op,col,val} spec crosses the wire. <sub>*resource/fold.ts:101 (export const AGG)*</sub>

**aggregateRebinds / aggregateReconciles** — Two registries the composer's onCommit/aeTimer walk. aggregateRebinds: each live owner-scoped partial re-scopes itself when ITS ring changes (walked on commit only). aggregateReconciles: each live fold reconciles its remote-holder subscription set — add admitted members, drop departed, RETRY the admit race (walked on commit AND on the periodic AE tick). <sub>*resource/index.ts:399-400; fold.ts (rescope/reconcileMembers)*</sub>

**buildPartial** — This node's owner-scoped PARTIAL for a serializable spec {op,col,val}: dispatches into the AGG registry, scoping over ownedView (the RAW proxy) so the union across holders is a disjoint cover. The spec (never a closure) is what crosses the wire to symmetric holders; the local aggregate method IS buildPartial. <sub>*resource/fold.ts:187 (buildPartial)*</sub>

**composite** — A composite partial builder (avg's {sum,count}, every's {match,total}) mirroring two O(1) aggregate sub-views onto one object ViewProxy via a plain anchor + assignment, with aggRetain pinning the sub-views (data's FunctionSink doesn't back-ref its source, so they'd otherwise GC and freeze the stream). <sub>*resource/fold.ts:170 (const composite)*</sub>

**decomposable aggregate** — An aggregate whose global answer can be computed from per-shard partials folded by an associative combine — sum/count/max/min/avg/some/every. The data facade intercepts these (DECOMPOSABLE set) as a fan-out + fold rather than a local operator (which would see only this node's held partitions = a partial). <sub>*resource/dispatch.ts:315 (DECOMPOSABLE)*</sub>

**disjoint cover** — The correctness property owner-scoping guarantees: because every partition has exactly one owner, the union of all holders' owner-scoped partials covers every row exactly once (no R-fold double-count). Holds at any replica count. <sub>*resource/fold.ts:158-161 (owner-scoping note)*</sub>

**distributed(op) / specOf** — The facade interceptor for a scoped server's data.sum/max/min/avg/some/every/length over the WHOLE resource: specOf builds a serializable spec or null (a closure predicate or bucketed length(fn) can't distribute → warn + local fallback); a client routes to a server-coordinator; canRunLocal (R≥members) runs locally; otherwise fold.foldAggregate(spec). <sub>*resource/dispatch.ts:320 (specOf), :344 (distributed)*</sub>

**FOLD_HANDLES** — An identity WeakSet of live fold/gather handles (foldAggregate's Proxies). Sole writer is foldAggregate, sole reader is forWire — membership-checked (not by probing the FOLD_ONCE symbol, which throws 'Cannot convert a Symbol to a string' on a data ViewProxy) to decide whether to resolve a returned handle via gatherOnce. <sub>*resource/handle.ts:66 (FOLD_HANDLES)*</sub>

**FOLD_ONCE** — A resolver-tag symbol on a foldAggregate/gather handle: handle[FOLD_ONCE] yields a () => Promise<global> that resolves a ONE-SHOT gather WITHOUT opening the handle's live fold. Exposed via lazyHandle's extraGet (runs before the symbol reject). <sub>*resource/handle.ts:60 (FOLD_ONCE)*</sub>

**foldAggregate** — The querying-side FOLD HANDLE (mirrors makeHandle): a lazyHandle that is BOTH a thenable (await ⇒ gatherOnce one-shot) and a live ViewProxy (real access ⇒ open()s gatherLive). Registers in FOLD_HANDLES and exposes FOLD_ONCE via extraGet so forWire can resolve a returned handle without opening the live fold. <sub>*resource/fold.ts:286 (foldAggregate)*</sub>

**forWire** — Reduce a method's return value for the wire: a fold/gather HANDLE resolves its one-shot global via gatherOnce (detected by a side-effect-free FOLD_HANDLES membership check); a ViewProxy collapses to its [value] (returned UNCONDITIONALLY, even undefined — an empty scalar aggregate); everything else passes through. <sub>*resource/handle.ts:82 (forWire)*</sub>

**gatherLive** — A LIVE fold: a result proxy whose root is refolded on every partial delta, with close() to tear down. The querier's own shard is an in-process livePartial; remote holders are subscriptions in subs, each re-scoping its own served partial and pushing over the EXISTING subscription. reconcileMembers (run on commit + aeTimer) adds new members / drops departed / retries the admit race. <sub>*resource/fold.ts:247 (gatherLive)*</sub>

**gatherOnce** — One-shot distributed GATHER: the local owner-scoped partial in-process (self is NOT a wire target) plus a call to every OTHER view member, folded once through the associative rule. A connected-but-unresponsive holder folds as the identity after timeout (a known silent undercount). Stateless — reflects the current ring per call. <sub>*resource/fold.ts:233 (gatherOnce)*</sub>

**gatherOnce/gatherLive 'rows' / unionRule** — The whole-resource GATHER (Q3): each holder's owner-scoped row-set OBJECT is the {op:'rows'} partial, folded by unionRule (Object.assign by disjoint key — idempotent under ring churn). This is the explicit 'download everything to one node' the user chains holistic ops after. <sub>*resource/fold.ts:90 (unionRule), :129 (rows entry)*</sub>

**holistic op guard (holisticGuard)** — The Q3 boundary guard for HOLISTIC/ordered operators (az/za/top/limit/group/distinct/reduce) that CAN'T fold from per-shard partials. Calling them directly on data runs over only held partitions and would silently look global, so the facade returns that local result but WARNS LOUDLY (once per op); the correct path is methods.read() (which gathers the whole resource) then the op over THAT. <sub>*resource/dispatch.ts:373 (HOLISTIC), :375 (holisticGuard)*</sub>

**livePartial** — A LIVE owner-scoped partial (Q2c): streams buildPartial(spec)'s value to onValue and RE-SCOPES itself on a view commit via a GENERATION guard (data's filter won't re-run its predicate on an ownership move under a stable row, and its FunctionSink can't be synchronously disconnected). Used by both a holder's served partial and a fold's local self-partial. <sub>*resource/fold.ts:201 (livePartial)*</sub>

**makeFold** — The per-instance distributed-aggregate fold ENGINE built once per fero() node — exposes ownedView/buildPartial/livePartial/gatherOnce/gatherLive/foldAggregate. Closes over shared state by reference (data, mesh, the two aggregate registries, clientSubs) plus the injected invoke, the one edge back to the composer. <sub>*resource/fold.ts:149 (makeFold)*</sub>

**ownedView / owner-scoping** — data.filter((_v,k) => mesh.owner(k) === me) — scopes a partial to the partitions this node OWNS. Owner-scoping (not holder-scoping) is the dedup: a partition lives on R replicas but has exactly ONE owner, so the union across holders is a DISJOINT cover — every row counted once regardless of R. The basis for Q2 aggregate partials and the Q3 rows gather. <sub>*resource/fold.ts:162 (const ownedView)*</sub>

**partial / combine** — The two halves of a decomposable aggregate in an AGG entry: partial builds this holder's owner-scoped sub-answer (e.g. owned.sum(col), or a {sum,count} composite for avg); combine is the associative + commutative Rule folding N partials into the global (sumRule/extremum/avgRule/someRule/everyRule/unionRule). <sub>*resource/fold.ts:30 (type Rule), :101 (AGG entries)*</sub>

## Membership & views (V)

**canWrite (write-gate)** — A cached boolean on ViewManager: can I reach a MAJORITY of my committed view? Recomputed each tick and on commit. False ⇒ writes must NOT commit (they buffer via commitLocal's pending queue) so two partition sides can't both accept and diverge — the write path reads one flag, no per-write member scan. <sub>*resource/membership.ts:53/268*</sub>

**epoch** — The monotonically-numbered token of a committed view {epoch, members}, made unique per view by the ballot's promise semantics (one proposer per epoch). Ownership is stable within an epoch; carried on ChangeRecord and used in epoch-fenced LWW. <sub>*DECISIONS.md V, V1a, V1d*</sub>

**handshake (INIT/SYNC/DONE)** — The bounded join protocol (≤3 messages): the dialer sends INIT, the accepter answers SYNC, the dialer acks DONE. v1 is MEMBERSHIP-ONLY — it exchanges Identity (uuid, role, listen) and gossips known server addresses so the mesh self-organizes into a full mesh; state reconciliation is deferred to L1. <sub>*transport/handshake.ts (initiate, handle)*</sub>

**heartbeat (PING/PONG)** — The app-level liveness probe: every interval ms send a PING (empty body); the peer answers PONG, and any inbound frame counts as proof of life (resets the miss counter and clears suspicion). PING/PONG frames are consumed in peer.ts #onData and never reach dispatch. Default 1000ms / 3 misses. <sub>*transport/peer.ts:27-30, #startHeartbeat/#beat/#onData*</sub>

**Identity** — The handshake payload, carried AS a change record ({type:'update', key:[], value: Identity}) through the same message.ts codec the data path uses (no second serializer): { uuid, role:'server'|'client', listen? ('host:port' servers accept on), peers[] (known server listen addresses — gossiped so the mesh closes) }. <sub>*transport/handshake.ts:14 (type Identity)*</sub>

**installView / viewMembers / view (committed view)** — Committed-view membership (Milestone V). installView(members) is the ONLY thing that mutates the DHT ring — it rebuilds the ring to EXACTLY the committed members so ownership is stable within an epoch. The ring is driven solely by the committed view, never by raw connect/disconnect; until L2's ViewManager installs a view a server rings only itself. <sub>*transport/index.ts:315 (installView); DECISIONS V*</sub>

**JOIN_REQUEST** — A node asks to be admitted to the cluster; the request is folded into the next committed view by the coordinator. Routes to its own onJoinRequest hook. <sub>*transport/message.ts:54; transport/index.ts:198*</sub>

**joint-consensus quorum** — A view commit needs a majority of BOTH the old view and the new view; two disjoint subsets can't both be a majority of the same set, so at most one view ever commits per epoch even under a partition — the safety guarantee of view-synchronous membership. <sub>*resource/membership.ts:220 (#tryCommit)*</sub>

**soft coordinator** — The lowest-address REACHABLE node, which proposes view changes — everyone agrees on 'lowest address' so no election is needed within a view, and when it dies the next-lowest takes over automatically (failover). A node never proposes if it isn't the coordinator. <sub>*resource/membership.ts:112 (#coordinator), :118*</sub>

**suspect (failure detector)** — The failure detector's verdict: 'likely-dead-but-socket-still-open'. TCP close never fires for a hard-crashed/silently-partitioned peer, so after misses unanswered PING probes the peer flips suspect — the reachability signal the membership/view layer keys off (it never trusts raw STATUS.connected). Kept orthogonal to status so it doesn't disturb status-based data-path routing. <sub>*transport/peer.ts:99 (get suspect), #beat; DECISIONS V*</sub>

**uuid self-reject** — A dial to one of our OWN alternate addresses (multi-NIC, localhost vs 127.0.0.1) completes a handshake carrying OUR uuid; add()'s host:port string self-guard misses it, so identify() catches it by uuid, prunes + destroys the connection, and remembers the address (#selfAddrs) so discovery can't redial it into a self-loop. <sub>*transport/peers.ts:122 (identify), #selfAddrs*</sub>

**view / epoch (View)** — A numbered View { epoch, members } the cluster agrees on in lockstep; the DHT ring is rebuilt SOLELY from a committed view (V1b) and ownership is STABLE within it. Promise semantics make epoch a unique per-view token; every committed write is stamped with the current epoch and fenced at apply (V1d). <sub>*resource/membership.ts:34 (type View); DECISIONS V, V1b*</sub>

**ViewManager** — The view-synchronous membership state machine (Milestone V): forms a committed { epoch, members } via a single-decree Paxos-flavoured ballot (lowest-address reachable node = soft coordinator; PREPARE → PROMISE/ACK → COMMIT; joint-consensus quorum) and drives the DHT ring via mesh.installView so ownership is stable within an epoch. Exposes canWrite (the write-gate). <sub>*resource/membership.ts:50 (class ViewManager)*</sub>

**viewPrepare / viewAck / viewCommit (VIEW_* frames)** — Two-phase view-change control frames (Milestone V): VIEW_PREPARE = phase-1 proposal (a ballot {epoch, members, proposerId}), VIEW_ACK = phase-1 promise (carries the member's high-water vector), VIEW_COMMIT = phase-2 install of the agreed {epoch, members}. Named per-phase senders (the V1a layering seam) so L2's ViewManager never spells a raw wire verb; each routes to its own onView* hook and never falls through to onRecord. <sub>*transport/index.ts:286 (sendViewFrame), 322-324; message.ts:51-53*</sub>

## Milestones (the letter codes)

**A — Last-writer-wins conflict resolution** — Milestone establishing that every record carries provenance (origin uuid + Lamport seq) and concurrent same-key writes resolve LWW by lexicographic (seq, origin); per-origin high-water marks dedup re-delivered records. <sub>*DECISIONS.md A (980ead9)*</sub>

**B — Catch-up on (re)connect via per-origin digest** — Milestone: on handshake completion two nodes exchange per-origin high-water digests (Log.marks / resource seen) and each ships the records the other lacks (recordsSince), folded through dedup + LWW. Reconnect is automatic. <sub>*DECISIONS.md B (980ead9)*</sub>

**C — Persistence via a storage seam + WAL** — Milestone: a storage seam {load, append} (built-in append-only-file fileStorage) replays load() through the same accept path as inbound records on boot, then appends every accepted record. <sub>*DECISIONS.md C (980ead9)*</sub>

**D — Client→server RPC** — Milestone: a read-only client gets a Proxy method surface; each call ships a CALL frame (correlated by frame id) to its connected server, which runs the handler and replies RESOLVE/REJECT, with a 5s default timeout. <sub>*DECISIONS.md D (980ead9)*</sub>

**E — Live subscriptions (server-push)** — Milestone: methods.X(arg) returns one unified handle — await ⇒ one-shot RPC snapshot; reactive use (.tap/.filter/[value]) ⇒ opens a SUBSCRIBE that streams the initial snapshot + every delta (RECORDS frames). then is the only access that does not subscribe. <sub>*DECISIONS.md E (27e687f)*</sub>

**F — Owner-routed writes reverted; full-mesh broadcast retained** — Milestone (Reverted): owner-relay forwarding split one origin's seq stream across paths, arriving out of order and dropping late lower seqs as false duplicates (silent data loss); reverted to full-mesh broadcast where each writer broadcasts its own writes in order. <sub>*DECISIONS.md F (1d691f2)*</sub>

**F1 — Owner-routed writes via forwarding (owner re-sequencing)** — Milestone: a write to key K is committed by owner(K) — if not owned, the raw write is FORWARDED (VERB.WRITE) to the owner, which commits it under origin=owner and broadcasts the canonical record. Exactly one broadcaster per record (vs F's multi-path relay), so the in-order-per-origin invariant holds. Linearizable per partition. <sub>*DECISIONS.md F1*</sub>

**F2 — Per-partition sequencing / R-way replication** — Milestone (Investigated, then superseded by P): cutting fan-out from O(N) broadcast to O(R) by replicating each partition only to its R replicas. Found incompatible with synchronous reads and a regression under full broadcast; deferred to partitioned holding (Milestone P). <sub>*DECISIONS.md F2*</sub>

**F3 — Owner-failover version continuity** — The planned per-partition-sequencing answer to handoff (next owner continues the partition's counter, (version, owner) breaking split-brain ties). Obviated by P keeping the per-origin core; only its reject-stale-epoch-from-evicted-node fence remains open. <sub>*DECISIONS.md F1/F2; IDEAS.md Partitioned ownership*</sub>

**G — sclone on the write path is not redundant** — Milestone (Investigated, no change): the single sclone per write is required because the log needs a deep owned copy (data mutates nested objects in place) and broadcast piggybacks on it for free. The real win (store encoded bytes in the log) is deferred. <sub>*DECISIONS.md G (index.perf.ts)*</sub>

**H — Proxy-as-source (arch B), not log-as-source (arch A)** — Milestone: L2 inverts L1's dependency — the proxy is the source of truth and the log is a history sidecar (arch B) — because routing assignment writes back through the log (arch A) would loop. Captures the deliberate L1/L2 divergence. <sub>*DECISIONS.md H*</sub>

**L4 — Chaos test harness + reversible partition seam** — Milestone: a reusable cluster() harness plus a reversible isolation seam (Peers.isolate/heal → mesh.isolate/heal, off the public API) that severs a dialed link AND blocks redial, enabling a true bidirectional network partition and partition→heal convergence tests. Zero steady-state cost. <sub>*DECISIONS.md L4; tests/chaos/*</sub>

**P — Partitioned holding (R-way replication)** — Milestone: holding is made R-way (each partition on R replicas, default ∞ = full) so storage + write fan-out scale O(R) not O(N), accepting that non-local reads become async/routed. R=∞ stays byte-identical. Built as P0/P2/P4. <sub>*DECISIONS.md P (b079b26)*</sub>

**P0 — replica-set seam** — P increment: cluster.replicas(key) (owner + R-1 ring successors) + a replicas: R config, default ∞ = full replication (byte-identical to pre-P). Pure routing surface over existing ring math (dht.owners). <sub>*DECISIONS.md P (b079b26)*</sub>

**P2 — scoped R-way replication** — P increment: granularity gated on R — R=∞ keys dedup by origin (per-origin path unchanged), finite R keys by (origin,partition) so each partition's stream is gap-free from its single owner-sequencer; held-set materialization via holds(key), scoped delivery (replicateTo the R-set), scoped catch-up, and acquisition re-sync. <sub>*DECISIONS.md P (P2)*</sub>

**P4 — Confirmed orphan shedding** — P increment: sheds ORPHANS (partitions a node holds but no longer replicates) via keep-until-confirmed — an orphan is kept until EVERY current R-set member is confirmed caught up (shedConfirmed on each digest), then shed(p) removes it in-memory. Converges to exactly R replicas with no under-replication window. <sub>*DECISIONS.md P4*</sub>

**Q1 — Hold-relative reads** — Milestone: with R-way holding, reads become hold-relative — synchronous-and-local for a held partition, an owner-routed remote handle (await ⇒ one-shot, reactive ⇒ subscribe) for one not held. Built as a keyed read + makeHandle/remoteRead engine + a transparent data.x facade. <sub>*DECISIONS.md Q1*</sub>

**Q2 — Decomposable distributed aggregates** — Milestone (L3 first slice): whole-resource aggregates (sum/length(count)/max/min/avg/some/every) run via owner-scoped fan-out + fold — each holder aggregates only the partitions it OWNS (a disjoint cover), streams a partial, and the querier folds the partials with a fixed associative combine. Built as Q2a–Q2f. <sub>*DECISIONS.md Q2*</sub>

**Q2a — owner-scoping (dedup)** — Q2 increment: each holder aggregates ONLY the partitions it owns (filter where mesh.owner(k)===me over the raw proxy), so the union across holders is a disjoint cover — every row counted exactly once regardless of R. A serializable spec {op,col[,val]} crosses the wire, not a closure. <sub>*DECISIONS.md Q2*</sub>

**Q2b — fold** — Q2 increment: await ⇒ one-shot gather (gatherOnce); reactive ⇒ live fold (gatherLive). Self is NOT a wire target — the querier's own shard is obtained in-process and folded alongside the N-1 remote partials (missing it = a 1/N undercount, the review-caught blocker). <sub>*DECISIONS.md Q2*</sub>

**Q2c — view-change rebind + churn** — Q2 increment: each node re-scopes its owner-scoped partials on its own view commit (livePartial, generation-guarded), since data's filter only re-runs on a row change not an ownership change; subscriptions persist across a commit so the coordinator only reconciles membership. <sub>*DECISIONS.md Q2*</sub>

**Q2d — avg + some/every** — Q2 increment: avg ships a {sum,count} PAIR (combined as Σsum/Σcount, divide last) since AvgValue exposes only the quotient; some/every take a declarative predicate (col[,val]) because a closure can't cross the wire (an inline closure is rejected loudly). <sub>*DECISIONS.md Q2*</sub>

**Q2e — client server-as-coordinator** — Q2 increment: a read-only client can't owner-scope/fold, so its facade aggregates route to its connected server with {fold:true}; the server folds and streams the global back, while the fan-out strips the flag so holders return partials (no recursion). <sub>*DECISIONS.md Q2*</sub>

**Q2f — boundary guard** — Q2 increment: holistic/ordered ops (az/za/top/limit, group, distinct, reduce) and length(fn)/closures can't fold from partials — on a scoped facade they return a LOCAL result but WARN LOUDLY (once per op), never silently mistaken for the global. <sub>*DECISIONS.md Q2*</sub>

**Q3 — Whole-resource read() = distributed gather** — Milestone: a no-key read() under scoping folds every holder's owner-scoped ROWS into the whole resource (the Q2 fold with a union rule), so holistic ops run AFTER read() over the gathered proxy locally — read() IS the explicit download. Built as Q3a–Q3b. <sub>*DECISIONS.md Q3*</sub>

**Q3a — gather = the Q2 fold with a union rule** — Q3 increment: an internal spec {op:'rows'} returns the holder's owner-scoped ownedView (a disjoint cover); RULES.rows is union-by-key (Object.assign), idempotent so it tolerates transient ring disagreement. Client gather routes to the dialed server as coordinator; the reactive subscribe branch is ungated on R (re-arms on commit). <sub>*DECISIONS.md Q3*</sub>

**Q3b — server gather + holistic-after-read** — Q3 increment: a scoped server's own no-key methods.read() is the gather HANDLE (await ⇒ one-shot global, reactive ⇒ live gather), memoized to one handle per node. Only the default read is swapped (a user read is their projection); guarded by a FOLD_HANDLES WeakSet so a returned handle resolves via gatherOnce. <sub>*DECISIONS.md Q3*</sub>

**R — Defensive decode against malformed/hostile frames** — Milestone: L0's lazy decoder bounds every wire-supplied length/count against the bytes that remain (framer caps bodyLen at MAX_FRAME 256 MiB; records()/prov()/RecordView guard counts, segments, f64, JSON); a violation throws a typed FrameError, which peer.ts maps to dropping the peer rather than crashing. <sub>*DECISIONS.md R (33afd1d)*</sub>

**T — Re-key inbound peers on handshake DONE** — Milestone: Peers.identify(peer,id) on handshake DONE re-keys an accepted inbound server socket to its learned LISTEN address (uuid stamped) as a receive/serve 'shadow', so cluster.peers shows each server once with no phantom ephemeral client row. The keystone of the identity/dedup cluster. Includes T2 (uuid self-reject) and T3 (prune dead rows). <sub>*DECISIONS.md T, T2, T3*</sub>

**V — View-synchronous membership** — Milestone: the cluster agrees on a sequence of numbered views {epoch, members} via a Paxos-flavoured ballot; ownership is stable within an epoch and the minority side of a partition is read-only (CP). Built across V0 + V1a–V1e. <sub>*DECISIONS.md V (5c45e61 → 1d8c533)*</sub>

**V0 — failure detector** — V increment: PING/PONG heartbeat + setKeepAlive; after N missed probes a peer is flagged 'suspect' (orthogonal to socket status). The reachability signal everything else keys off, since TCP close never fires for a crash/silent partition. <sub>*DECISIONS.md V (5c45e61)*</sub>

**V1a — layering seam** — V increment: VIEW_* verbs + explicit dispatch to hooks (a view frame never reaches onRecord); an epoch field on ChangeRecord; mesh.installView/viewMembers. Zero behaviour change. <sub>*DECISIONS.md V (a0b6db5)*</sub>

**V1b — ring-from-view + merge** — V increment: the DHT ring is rebuilt SOLELY from a committed view (dht.track removed). The view forms via a Paxos-flavoured ballot (lowest-address reachable node is soft coordinator; PREPARE→PROMISE→COMMIT) with joint-consensus quorum; also made anti-entropy reciprocal. <sub>*DECISIONS.md V (62499b8)*</sub>

**V1c — failover + eviction** — V increment: a member unreachable past an eviction grace is dropped; a dead coordinator is superseded by the next-lowest reachable automatically. Fresh-epoch ballots + promise-release timeouts prevent a coordinator dying mid-2PC from wedging the cluster. <sub>*DECISIONS.md V (4b5360b)*</sub>

**V1d — epoch-fenced LWW** — V increment: LWW extended to (epoch, seq, origin) so a write under a newer view wins and a straggler from a superseded view can't clobber the current one. Within a view (constant epoch) behaviour is unchanged. <sub>*DECISIONS.md V (cf024f7)*</sub>

**V1e — write-gate** — V increment: a node writes only while it can reach a majority of its view (a cached boolean); otherwise it is read-only and BUFFERS writes (bounded, drop-oldest), flushing when quorum returns. So a partition's minority side can't diverge. Exposed as cluster.writable. <sub>*DECISIONS.md V (1d8c533)*</sub>

## Conventions & process

**#utils** — A Node import-map subpath (package.json → utils/index.ts) for shared test/perf helpers named noun.verb() — ports.free(), until(), bench.time() (one warmup + median-of-5), apply() — so fixtures aren't copy-pasted and every *.perf.ts measures identically. Used via import { ... } from '#utils'. <sub>*CLAUDE.md conventions*</sub>

**change-record-IS-the-wire-format** — fero's foundational hypothesis (proven Day 0): change records on the wire = change records in memory. data's {type,key,value,at?} is exactly a replicated log entry, so there is no translation layer between what data emits and what crosses the wire. <sub>*plan.md §2,§10*</sub>

**CP posture / read-only-minority** — fero's consistency stance across membership changes: the minority side of a partition is unavailable (read-only + buffering) rather than divergent. A sub-quorum remnant stays read-only; a force-to-solo (AP) degrade is deliberately not offered. <sub>*DECISIONS.md V; IDEAS.md Parked alternatives*</sub>

**IDEAS vs DECISIONS ledgers** — Two root ledgers: IDEAS.md holds ONLY open work grouped by cross-cutting workstream with [P1/P2/P3] priority; DECISIONS.md is the append-only 'why' — a record per landed milestone (context/decision/consequences), never deleted (superseded). <sub>*CLAUDE.md; IDEAS.md; DECISIONS.md*</sub>

**per-file test/perf siblings** — Convention: foo.ts has foo.test.ts and (for hot paths) foo.perf.ts. node:test + node:assert; perf asserts median-of-5 performance.now() thresholds via ok(elapsed<N). A threshold is never widened to make a test pass. <sub>*CLAUDE.md; README.md Performance/Dev workflow*</sub>

**rethink-not-reskin** — User-feedback rule: the new {data, methods, cluster} shape — no events, no hooks, return-type dispatch for methods — is a deliberate rethink, not a one-to-one port of legacy fero's API; don't drift back toward the old shape. <sub>*CLAUDE.md (feedback_rethink_not_reskin)*</sub>

## Notes for reviewers (overloads, layering, gaps)

A few terms appeared in multiple collectors with compatible (not conflicting) definitions, merged to the most precise source: ChangeRecord (transport/message.ts is canonical over the log restatement); partitionOf/partition; holds(key) (resource/index.ts:358 over the DECISIONS-level summary); epoch / view / joint-consensus quorum (kept the resource/membership.ts implementation pointers over the DECISIONS pointers); anti-entropy and ownedView/owner-scoping (kept the code-line sources over the milestone-letter sources). No outright contradictions were found.

Two real divergences worth flagging: (1) write-gate vs commitLocal's never-drop fallback — collector 3 describes commitLocal as 'the never-drop fallback when an owner is unreachable,' while the V1e write-gate (collectors 3 and 4) says a quorum-less node buffers/drops-oldest. These are not contradictory but layered: F1's never-drop is superseded by the V1e gate for a node that can't reach a majority. (2) 'drop()' is overloaded across layers — a transport fault-injection primitive (close a peer's socket, no UNSUBSCRIBE) AND a Log method (drop(partition) sheds a segment + its scoped index groups). I kept both under distinct terms ('drop()' in Resource/L2 for the fault primitive, 'drop() / shedding (Log)' in Replication) to avoid a false merge.

Gap: collectors reference but never define several supporting identifiers — sclone (the per-write deep copy in Milestone G), aggRetain/agrRetain pinning, MAX_PENDING's concrete bound, and the eviction-grace / promise-release timeout constants in V1c. A reviewer hitting those in a diff would not find an entry here; they live only in code/DECISIONS prose the collectors summarized.

## Review-hardening additions (DECISIONS O/X/Y + the full-project review fixes)

Terms introduced by the post-review hardening pass (the L4 observe slice + the write-path/membership/transport fixes). Listed here rather than threaded into every section above, since they're a coherent later layer.

**observing (InspectSnapshot field)** — Whether a node's `__observe` push gate is armed (≥1 live subscriber). Rides the ~1s poll so the observer BRIDGE can detect its own dead push leg: if it holds a sub against a node reporting `observing:false`, the server-side sub was reaped (a socket bounce inside one poll interval) and the bridge re-subscribes. <sub>*resource/inspect.ts; resource/index.ts (observing closure)*</sub>

**re-announce (#reannounce / #seenEpoch)** — The membership reconcile backstop ([DECISIONS Y](DECISIONS.md)). The lowest-address reachable member of its own committed view periodically re-broadcasts `{epoch,members}` (reusing VIEW_COMMIT) to ALL reachable peers. A node that MISSED its commit (it's a member) adopts it; a node BEHIND a higher epoch records `#seenEpoch`, which makes its coordinator re-propose a unifying view — healing a post-partition split-brain the member-set-delta-only trigger left deadlocked. <sub>*resource/membership.ts:#reannounce / onCommit / #coordinate*</sub>

**epoch-dominance stamp** — `commitLocal` stamps `max(viewEpoch, heldWinner.epoch)`, never below the epoch of a winner it already holds for the key — so a view-lagged node's deliberate overwrite can't self-fence into permanent divergence (the B1 sticky-skip). The merged Lamport seq still decides LWW within that epoch. <sub>*resource/index.ts (commitLocal); [DECISIONS X](DECISIONS.md)*</sub>

**ack-confirmed forward (WRITE-ACK)** — `mesh.forward(addr, rec, onOutcome)` treats socket-write success as NOT delivery: the owner ACKs an id-tagged WRITE after its synchronous commit; no ACK within `callTimeout` ⇒ `onOutcome(false)` ⇒ the caller's never-drop fallback (commit-local on a server, re-buffer on a client). Closes the silent-loss window when an owner crashes inside the failure-detector lag. The legacy boolean `forward(addr, rec)` is unchanged. <sub>*transport/index.ts (forward, VERB.ACK); [DECISIONS X](DECISIONS.md)*</sub>

**client write forwarding** — A read-only client (no ViewManager ⇒ `viewEpoch` ≡ 1) no longer commits assignments locally at epoch 1 (which any formed cluster fences); it forwards to a picked server, buffering (bounded drop-oldest) when unreachable and flushing on (re)connect + a periodic sweep. <sub>*resource/index.ts (forwardToServer / flushClientPending); [DECISIONS X](DECISIONS.md)*</sub>

**sendDelta (delta outbox lane)** — Served-subscription deltas queue into a per-subId lane on the per-peer outbox and flush as ONE id-tagged RECORDS frame per sub per microtask — instead of the old immediate encode+write per record inside the writer's sink chain. <sub>*transport/peer.ts (sendDelta / flush); transport/index.ts (deltaTo)*</sub>

**#fireGone (terminal-departure latch)** — A once-latch so EVERY terminal path (inbound close, dial give-up, AND `destroy()` — framing fault / FrameError / mesh.drop / self-reject) fires `onGone` exactly once → `#prune`. Before it, a `destroy()`ed dialed peer stayed in `#conns` as a redial-blocking corpse. <sub>*transport/peer.ts:#fireGone*</sub>

**identity validation (identityOf)** — The handshake INIT/SYNC/DONE identity is type-validated before use: a wrong-typed payload (`peers:[42]`) is a `FrameError` (→ peer drop), not a TypeError that unwinds through the socket handler and kills the process. null/absent still degrades to a minimal client id; unknown extra fields still pass (version compat). <sub>*transport/handshake.ts:identityOf*</sub>
