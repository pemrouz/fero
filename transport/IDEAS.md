# L0 transport — ideas & suggestions ledger

A running list of improvements deliberately *not* done in the first cut, captured
as I build so they aren't lost. Organized by concern. Each item tags the module
and a rough priority. This is design debt + future-work, not a spec — the spec is
plan.md §9 and the L0 design.

Legend: **[P1]** do soon / **[P2]** when it matters / **[P3]** nice-to-have.

---

## message.ts

### Perf
- **[P1] Zero-copy serialize-into-outbox.** `encodeFrame()` allocates a fresh
  `Writer` + result `Buffer` per call. The per-peer outbox (peer.ts) should
  instead write records straight into a *reused, preallocated* buffer and
  back-patch `count`/`bodyLen` on flush — eliminating the per-flush allocation.
  This is the design's headline send-side win; v1 peer.ts uses the simpler
  encodeFrame-per-tick path. Needs a streaming `Outbox` API (see API below).
- **[P1] `RecordView.key0` fast path for routing.** The DHT routes on `key[0]` only;
  the current `key` getter decodes the *whole* `string[]`. A `key0` accessor that
  decodes just the first segment avoids building the array + utf8-decoding the
  rest on the hottest path (every routed record).
- **[P2] CBOR (or a `data`-owned binary value form) behind the seam.** Measured:
  full decode is ~2.4ms vs ~0.35ms lazy-scan for 1000 object records — i.e.
  `JSON.parse` of object values is ~85% of decode cost. Swapping
  `encodeValue`/`decodeValue` is where the next decode win lives. Decide with a
  perf number, not a guess.
- **[P2] Prefix-delta keys** (reserved `keyDelta` tag bit). Collapse the shared
  leading segments across records in a batch (`['users','42','name']`,
  `['users','42','age']` → one `shared` varint) — the steady-state sibling-burst
  shape. Deferred for v1 to keep the codec simple + avoid intra-batch decode
  coupling; flag bit is reserved so it adds with no wire break.
- **[P2] Columnar body** (reserved `COL`/`UNIFORM` bits). Struct-of-arrays
  (types column, keys section, values blob, value directory) for large batches:
  a route/filter pass that reads only types+keys touches contiguous memory and
  never pulls value bytes into cache. `UNIFORM` drops the per-record `recLen`
  when every record is one fixed-width vtype. Pure perf layer; gate on a
  `message.perf.ts` batch-size threshold.
- **[P3] Avoid double `Buffer.byteLength`.** `keySize`/`writeKey` recompute each
  segment's utf8 length; sizing recomputes string value lengths. A single-pass
  prepare (or caching) removes the redundant scans. Minor (V8 makes it cheap).
- **[P3] Remove-value elision.** `remove` records carry their value bytes today
  (lossless), but the apply contract (`res.remove(key)`) ignores them. Eliding
  (force `vtype=undefined`) saves bytes on the remove path; trade = not
  byte-lossless for removes (fine for replication; matters for an audit log).

### API
- **[P1] Streaming `Outbox` encoder** — append records within a tick, flush one
  frame, reuse the buffer. Backs the zero-copy send path above; peer.ts wants it.
- **[P2] Expose varint/zigzag primitives** — currently module-private. handshake
  (heads tables, diffs) and dht will want them; promote to a shared `codec` seam.
- **[P2] `RecordView.key0` / `RecordView.partitionKey`** accessor (see Perf).
- **[P3] Frame verb dispatch hook** — a `dispatch[verb]` table so peer.ts routes
  RECORDS/ACK/INIT/… without a switch; design already calls for it.

### Correctness / robustness
- **[P1] Defensive decode against malformed/hostile frames.** `records()` trusts
  `count` and each `recLen`: a corrupt/hostile frame with `count = 2^28` makes
  `new Array(count)` → OOM, and an oversized `recLen` over-reads the buffer.
  Bound `count` and every length against the remaining body bytes; reject
  (destroy peer) on violation. Important once frames come from the network.
- **[P2] Buffer / typed-array values.** `JSON.stringify(Buffer)` →
  `{type:'Buffer',data:[…]}` and `JSON.parse` won't revive it (old fero shipped a
  reviver). v1 assumes plain-JSON values. A CBOR seam fixes this natively; until
  then, document the limitation or add a reviver.
- **[P2] NaN/Infinity inside objects.** Top-level numeric NaN/Infinity round-trip
  via f64 (better than JSON). But *nested* in an object value, `JSON.stringify`
  turns them into `null` — lossy. CBOR seam or a custom replacer would fix.
- **[P3] Documented assumptions:** little-endian host (x64/arm64); individual
  varint values < 2^32 (frame/keys/values never 4GB). Both safe for target
  deployment; note as explicit non-portabilities in the file.

### Testing
- **[P1] Malformed-frame tests** — truncated `bodyLen`, `count` > body, `recLen`
  overrun, reserved vtype nibble (7, 9–15) — must error gracefully, never crash
  or over-read. Pairs with the defensive-decode item.
- **[P2] Property/fuzz test** — random change records → encode → decode →
  deepEqual, thousands of iterations, to shake out edge cases the hand-written
  cases miss.
- **[P3] Perf coverage gaps** — add a scalar-heavy batch (exercises int/f64, no
  JSON) and an N=10k batch (catch superlinearity) to `message.perf.ts`.

### Alternatives considered
- **Whole-frame CBOR** — uniform + handles binary, but forfeits the scalar-nibble
  and binary-key wins; rejected for the hot path, viable behind the value seam.
- **Varint `bodyLen`** (vs fixed u32) — saves ~3 bytes on small frames, but costs
  a varint read in the framer's hot loop; fixed u32 keeps the framer branch-light.
- **Magic-byte version nibble** — reserved for wire evolution; v1 burns the whole
  byte as a constant marker.

---

## peer.ts

### Perf
- **[P1] Zero-copy outbox** (see message.ts). v1 collects records in an array and
  calls `encodeFrame()` once per microtask — correct + one write per tick, but it
  allocates a Writer + result Buffer per flush. The win is a preallocated per-peer
  buffer written in place, `count`/`bodyLen` back-patched, `write(sub.subarray)`.
- **[P2] Backpressure.** `socket.write()`'s return value is ignored. On `false`
  (kernel send buffer full) we should stop draining the outbox and resume on
  `'drain'`; otherwise a slow consumer causes unbounded kernel buffering.
- **[P2] Bounded outbox.** Records queued while disconnected grow without limit.
  Cap it (drop-oldest, or push backpressure to the `data` source) so a long
  partition can't OOM the sender.
- **[P3] Cumulative piggybacked ACK (YACK).** Legacy flow control via hw/lw
  watermarks patched into a prebuilt frame (peer.js:18,313). Deferred — v1 peer
  has no ack path; lands with L2 write-ack semantics.

### Correctness / robustness
- **[P1] Inbound peer identity.** `accept()` keys the peer by the socket's
  *ephemeral* `remoteAddress:remotePort`, which is NOT the peer's listening
  address and can't be dialed back. Real identity (listening host:port + uuid)
  arrives in the handshake — handshake.ts must **re-key** inbound peers. Until
  then inbound peers are provisionally mis-identified.
- **[P2] Duplicate connections.** If two nodes dial each other at once, two
  sockets exist for one logical pair. Legacy resolved by address with
  connected-wins (peer.js:85-95); v2 should dedup by uuid post-handshake.
- **[P3] Error visibility.** `'error'` is swallowed (relying on `'close'`);
  surface connection errors to L4 diagnostics rather than dropping them.

### Testing
- **[P2] Reconnect end-to-end** — kill server, restart, assert a dialed peer
  reconnects and resumes (use a small/fake-timer backoff to stay deterministic).
- **[P2] Real-socket large/straddled frame** — push a record bigger than one TCP
  segment and assert reassembly (straddle is unit-tested, not yet over a socket).
- **[P3] max-attempts → destroy** lifecycle test.

### API
- **[P3] `send()` returning a flush/ack handle** — supports L2's await-or-not
  write semantics (ties to plan §11.1 / the resolved open question 1).

---

## peers.ts

### Perf
- **[P2] Reactive dial loop + connection cap.** v1 dials immediately on `add()`
  with no cap. The design wants a reactive cap — dial only while
  `connected + inflight < max`, driven by tapping the projections — plus
  pool-pressure-scaled jitter to avoid a thundering herd on a big join.

### Correctness / robustness
- **[P1] Row pruning.** Rows persist forever; a peer that gives up leaves a
  `disconnected` row behind (slow leak). Need `forget(address)` / TTL, wired to
  Peer destroy.
- **[P1] Inbound re-keying** (mirror of peer.ts item). Once the handshake learns
  a peer's real listening address + uuid, re-key its row/connection from the
  ephemeral remote.
- **[P2] uuid-based self + dedup.** `me` is a single "host:port" string; a node
  with multiple interfaces, or a dial+accept race, needs uuid identity to reject
  self and dedup duplicate connections.

### Testing
- **[P2] Churn** — rapid connect/disconnect cycles must not leak projection
  entries or connections.
- **[P2] Dial-cap / jitter** behavior once the reactive loop lands.

### API
- **[P2] More projections** — `connectedServers`, `clients` as the design listed,
  or leave them for consumers to derive off `peers`.
- **[P3] `cluster.me`** row (plan §11.5) — a derived row for this node.

### Alternatives
- **[P3] Numeric vs string status enum.** Numeric compares fast but reads poorly;
  `STATUS_NAME` bridges for debug/devtools. Revisit if profiling says it's free
  to use strings.

---

## retries.ts

### Alternatives
- **[P3] Decorrelated jitter** (AWS-style: `sleep = min(cap, random(base, prev*3))`)
  spreads retries better under contention than ±jitter·backoff. Drop-in if a
  thundering-herd reconnect shows up in chaos tests.
- **[P3] Per-pool retry budget** (vs per-peer) to bound total reconnect storms.

---

## dht.ts

### Perf
- **[P2] Hash bake-off.** Default is djb2-accumulate + fmix32 finalizer. The
  finalizer is load-bearing (without it, an address's vnodes cluster — see the
  comment + the bug the movement test caught). Bench vs wyhash/xxhash32 in
  dht.perf.ts before locking it in; lookup is per-routed-record hot.
- **[P2] Hot-key hash memo.** `owner()` re-hashes the key every call; routing
  keys (`key[0]`, e.g. `user42`) repeat heavily. A small memo (key→hash) cuts
  the hash from the hottest path (legacy re-hashed every message, dht.js:40).
- **[P3] Incremental track().** `track()` re-diffs the whole membership set per
  change record (O(M)); could instead parse the single insert/remove record for
  O(1) bookkeeping (rebuild is still O(M), but the diff scan goes away).
- **[P3] Rebuild without tuple array.** `#rebuild()` allocates an `[hash,owner][]`
  to sort; could sort an index permutation into preallocated typed arrays.

### Correctness / robustness
- **[P1] Ring = connected SERVERS only.** Clients don't own partitions, but
  `track()` rings whatever's in the projection it's given. index.ts must pass a
  server-filtered projection (e.g. `peers.filter(p=>p.role==='server' && …)`),
  or the DHT must learn roles. Wrong ring membership = misrouted writes.
- **[P3] Vnode count vs cluster size.** 200 vnodes/peer is fine to ~dozens of
  peers; at 100s, the ring is 20k+ entries and rebuild cost grows — revisit
  vnode count or switch ring structure (see Alternatives).

### Testing
- **[P2] Tighten distribution/movement bounds.** Current tolerances are loose to
  avoid flakiness; a fixed deterministic hash + larger key set could assert
  tighter balance and the ~1/N movement law more precisely.
- **[P3] Replication `owners()` under churn** — distinct-R correctness as
  members join/leave mid-walk.

### Alternatives
- **[P2] Jump consistent hash** (Lamping–Veach) — O(1) lookup, no vnode memory,
  but assumes densely-numbered buckets and complicates weighted/named nodes.
- **[P3] Rendezvous hashing (HRW)** — no ring rebuild, naturally handles R
  replicas, but O(M) per lookup (M = node count) — wins only for small M.

---

## handshake.ts

### Correctness / robustness
- **[P1] State reconciliation (the deferred half).** v1 is membership-only. The
  catch-up-on-join — exchange per-partition heads, ship only the diff (as verbatim
  change-record buffers), bidirectional merge — lands with L1's log + the conflict
  rule. This is the headline missing piece, not a nice-to-have.
- **[P2] Commit on DONE, not on INIT.** `learn()` merges gossiped peers as soon as
  INIT arrives; a mid-handshake drop leaves a half-merged relationship. Defer the
  commit to DONE (legacy committed early too — same bug).
- **[P2] Guards & negotiation.** Drop INIT from an already-connected peer; refuse
  clients before `ready`; carry a protocol/version byte in INIT for negotiation.
- **[P2] Duplicate-connection dedup by uuid** (connected-wins) — see index.ts.

### Testing
- **[P2]** Control-frame straddle (INIT/SYNC/DONE split across TCP segments),
  malformed identity payload, client refused before ready.

---

## discovery/

### Not yet built
- **[P1] multicast.ts** — LAN zero-config UDP multicast discovery (plan §9). Deferred:
  WSL2/cloud drop multicast, so static/broker is the default. Build as a follow-up,
  test LAN-opt-in / CI-gated. Must emit the SAME candidate `insert` records into a
  $() proxy so the pool taps it identically.

### static.ts
- **[P2] Merge multiple discovery sources.** index takes one static proxy; the
  design wants `discovery: [multicast(...), static(...)]` merged into one candidate
  stream. Generalize to a list.
- **[P2] Broker as cloud default.** `#broker @ a fixed host:port` as the canonical
  rendezvous when there's no host list — env-var or config.
- **[P2] Dead-candidate backoff.** A permanently-down static candidate is redialed
  until the peer's retry cap; coordinate with the pool's dial cap so a big static
  list doesn't storm.

---

## index.ts

### Correctness / robustness
- **[P1] Dual connections + no dedup.** Each server pair forms two TCP
  connections (A→B and B→A outbound, plus inbound accepts) with no dedup. Works
  (directional: route over the outbound to the owner's listen address) but wastes a
  connection per pair. Dedup to one bidirectional conn by uuid (connected-wins) —
  ties to handshake.
- **[P1] Inbound rows are role 'client' + ephemeral-keyed.** An inbound accepted
  socket from a server is labelled 'client' and keyed by its ephemeral port, so it
  pollutes `cluster.peers` with throwaway rows (excluded from the ring, harmless for
  routing, but noisy). Prune on close / re-key from the handshake identity.
- **[P2] Ring consistency under churn.** Nodes briefly disagree on membership
  during connect/disconnect → transient misrouting. Eventual consistency; document,
  and lean on the DHT checksum to detect divergence.
- **[P2] `ready` heuristic.** Resolves on first connection OR a `wait` timeout (the
  "I'm first" case) — crude. Better: resolve when discovery is exhausted with no
  reachable peer.
- **[P2] Client (no-port) path under-tested** — a read-only node that only dials.

### Perf
- **[P2] Partition re-hash per send.** `send()`/`replicate()` hash `partitionOf(record)`
  every call; pair with the DHT hot-key memo.
- **[P3] Self-delivery** hands the original record to onRecord — fine, but a self-routed
  write still allocates the record; could fast-path the owner===me case.

### API
- **[P2] `partitions` + `cluster.me`** surfaces (plan §11.5) — partitions is L1;
  expose `me`/uuid as a derived `cluster.peers` row.
- **[P2] Deliver lazy `RecordView`s, not plain records.** dispatch already passes the lazy
  `RecordView` to onRecord (good — avoids forcing parse); keep that contract through L1.

### Testing
- **[P2] N-node convergence + churn** — the chaos harness (L4): spin up N, partition/
  kill/heal, assert convergence (port fero-old's harness).
- **[P2] replicate() to R owners**, and a read-only client joining.
