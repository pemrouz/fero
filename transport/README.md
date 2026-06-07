# transport — peers · DHT · handshake · wire codec (L0)

L0 owns everything between *an address string* and *a change record delivered to L1*. It turns a set of `host:port` candidates into a self-organizing, full-mesh cluster that routes and replicates `data` change records over TCP. Its foundational hypothesis — proven by the day-0 spike — is that **a `data` change record is the wire format**: `{type, key:string[], value, at?}` goes onto the socket as-is, so there is no serializer between "what `data` emits" and "what crosses the wire."

L0 deliberately holds **no state**: no log, no proxy of resource data, no conflict resolution, no view-change consensus. It carries frames and exposes a thin routing/membership seam (`Mesh`); L1 (log/view) and L2 (resource) own everything stateful. Power users reach it via `import { transport } from 'fero/internals'`.

## Files

| File | Role |
|---|---|
| [index.ts](index.ts) | Composition root: `transport(opts) → Mesh`. Wires discovery → pool → handshake → DHT, and routes every inbound verb to its hook (`dispatch()`). |
| [message.ts](message.ts) | The wire codec + framer — the hottest file in the repo. Length-prefixed framing, lazy-deserialise `RecordView`s, provenance ext, `encodeFrame`/`encodeFrames`/`Framer`. |
| [peer.ts](peer.ts) | One peer: TCP socket lifecycle, reconnect, the microtask-batched outbox, and the PING/PONG failure detector (`suspect`). |
| [peers.ts](peers.ts) | The peer pool: one reactive `$()` proxy of membership/status keyed by address; derived `.filter` projections instead of imperative lists. |
| [dht.ts](dht.ts) | Consistent hashring (two parallel sorted arrays + binary search). `owner(key)` and `owners(key,R)`; `hash32` (djb2 + fmix32). |
| [handshake.ts](handshake.ts) | The bounded INIT → SYNC → DONE membership handshake — identity + gossiped server addresses. Membership-only by design. |
| [retries.ts](retries.ts) | Jittered, capped exponential backoff for reconnection (injectable jitter source for deterministic tests). |
| [discovery/static.ts](discovery/static.ts) | Static rendezvous: emit the host×port space (+ optional broker) as candidate `insert` records into a `$()` proxy the pool taps. |

## Public surface

L1/L2 only ever construct one thing and consume the `Mesh` it returns:

```ts
import { transport } from 'fero/internals'

const mesh = transport({
  name: 'sessions',
  host: '10.0.0.1', port: 3000,        // present ⇒ server
  hosts: ['10.0.0.2', '10.0.0.3'], ports: [3000],
  dht: { replicas: 3 },
  onRecord: (record, peer) => log.apply(record),   // inbound replication
  onConnect: (addr) => antiEntropy(addr),          // a dialed peer caught up
  onCall:    (method, arg, from) => dispatchRPC(method, arg, from),
  // …onSubscribe / onWrite / onViewCommit / … one hook per verb
})

mesh.send(record)                       // route to owner(key) (local if me)
mesh.replicateTo(mesh.owners(k, R), record)
mesh.installView(committedMembers)      // adopt a committed view (drives the ring)
const reply = await mesh.call('login', arg)
await mesh.ready                        // resolves when reachable, or after `wait` ms
```

The `Mesh` seam (routing `owner`/`owners`/`send`/`replicateTo`/`broadcast`/`forward`; membership `installView`/`viewMembers`/`viewSend`; catch-up `digestTo`/`catchupTo`; RPC `call`/`subscribe`/`deltaTo`; `peers`/`me`/`uuid`/`ready`/`destroy`) is wide because L1/L2 genuinely use most of it — it is a flat routing API, not a god-class. `TransportOpts` mirrors it: config keys + one `onX` hook per inbound verb, each wired to exactly one case in `dispatch()`.

The wire codec is exported directly (and under `fero/internals`): `VERB`, `ChangeRecord`, `partitionOf`, `encodeFrame`, `encodeFrames`, `Framer`, `Frame`, `RecordView`, `decodeFrame`.

## How it works

**The wire format is the data format.** A frame is `MAGIC | flags | verb | bodyLen:u32 | [u48 id] | [prov] | body`. `bodyLen` is a *fixed* u32 so the framer never byte-loops to find a boundary — one `readUInt32LE` per frame ([message.ts:302](message.ts)). `Framer.push` ([message.ts:293](message.ts)) is straddle-safe: a frame split across TCP chunks is held as a single subarray `carry` (no per-byte copy); a `Buffer.concat` happens *only* on a genuine straddle.

**Decode is lazy all the way down.** `Frame.records()` ([message.ts:388](message.ts)) walks the per-record length varints and slices a `RecordView` each — *without parsing any key or value*. `RecordView` ([message.ts:428](message.ts)) reads `type` from one byte and decodes `key`/`at`/`value` only on first access (memoised). A record relayed onward (router → replica) is re-sliced and re-sent untouched — **zero key/value parse on the relay path.** The value codec is a swappable seam: scalars (null/undefined/false/true) carry **zero** value bytes (tag-only), ints are zigzag-varint, f64 is 8 LE bytes, object values fall back to JSON behind `encodeValue`/`decodeValue` (a CBOR swap is [open work](../IDEAS.md), gated on a perf number).

**Provenance is the replication backbone.** With `FLAG_PROV` the body opens with `[origin][baseSeq][epoch]`, and every record in that frame is **one origin's consecutive writes** (`seq = baseSeq + index`) within **one view-epoch**. `encodeFrames` ([message.ts:270](message.ts)) splits a mixed-origin batch into the fewest frames each satisfying that single-origin-contiguous-seq invariant — a run breaks on an origin change, a Lamport-seq gap, or an epoch change. This invariant is load-bearing: per-origin high-water dedup and anti-entropy both assume in-order-per-origin arrival. It is also the structural reason owner-*forwarding* is safe where owner-*relay* was not — see [DECISIONS F1](../DECISIONS.md).

**Composition, not a god-class** ([index.ts](index.ts)). Discovery emits candidate `insert`s into a `$()` proxy → the pool dials each → the handshake gossips each peer's known servers so the mesh closes into a full mesh → `dispatch()` routes inbound frames. **Self** is a ring member and a `cluster.peers` row but has no socket — a record whose `owner === me` is delivered locally, never written to a wire. The ring is driven **solely by the committed view** (`installView`, [index.ts:274](index.ts)), not by live connections, so ownership is **stable within an epoch** (Milestone V).

**`dispatch()` is the routing core** ([index.ts:149](index.ts)). Every control/membership verb (`CALL`, `SUBSCRIBE`, `WRITE`, `DIGEST`, `VIEW_*`) routes to its **own** hook so a control frame can *never* fall through to `onRecord` (the data path). The subtle default case: a `RECORDS` frame **with** a frame id is a subscription delta (routed by sub id); **without** one it's plain replication (delivered to `onRecord`). A frame with an id but **no matching sub** is a stale delta for a closed subscription and is **dropped** — falling through would mis-apply a `{key:[]}` delta as a root replace and clobber state (the Q2c churn bug, [DECISIONS Q2](../DECISIONS.md)).

**DHT** ([dht.ts](dht.ts)). Two parallel sorted arrays — `#hashes: Uint32Array` ascending + `#owners: string[]` aligned — make lookup an allocation-free, branch-light binary search. ~1000 entries (5 peers × 200 vnodes) is ~4 KB and cache-resident, vs the legacy RBTree of heap-scattered nodes. `hash32` is djb2-accumulate + an **fmix32 avalanche finalizer**, and the finalizer is *not* optional: without it an address's vnodes (`addr*0`…`addr*9`, differing only in the last char) cluster on the ring and skew distribution. The sole-member fast path ([dht.ts:126](dht.ts)) skips the hash + search entirely — the solo-server write hot path is allocation- and search-free.

**Failure detection** ([peer.ts](peer.ts)). TCP `close` never fires for a hard-crashed or silently-partitioned peer, so a half-open connection looks alive forever. An app-level PING/PONG heartbeat fixes it: after `misses` unanswered probes the peer flips **`suspect`** — the reachability signal the view layer keys off (it never trusts raw `STATUS.connected` for liveness). `suspect` is kept **orthogonal** to `status` (the socket may still be open) so it doesn't disturb status-based routing. Likewise `role` (server|client) is separate from `status` — the legacy code overloaded one field with both.

**Pool** ([peers.ts](peers.ts)). The headline L0 rethink: fero-old kept **six** imperative arrays rebuilt on every status transition; here there is **one** source of truth — `peers`, a `$()` proxy keyed by address — and the membership "lists" are derived `.filter(...)` projections `data` maintains in O(delta). `broadcast` fans out **only over dialed (outbound) connections**: in a gossip-formed full mesh every peer has exactly one outbound conn per other peer, so a record is delivered once — avoiding the double-delivery of also sending over inbound sockets.

### Invariants worth not breaking

- **Single-origin, contiguous-seq, single-epoch per frame** (`encodeFrames`). Dedup, anti-entropy, and LWW all assume it.
- **Control frames never reach `onRecord`** — every non-`RECORDS` verb has an explicit case.
- **The ring changes only on `installView`** — never on connect/disconnect (stable ownership within an epoch).
- **`bodyLen` is fixed-width u32** — the framer is a single read per frame, no loop.
- **fmix32 finalizer on `hash32`** — required for even vnode distribution.

## Design notes

- [DECISIONS F / F1](../DECISIONS.md) — why owner *forwarding* (one broadcaster per record) is safe where owner *relay* (multi-path) caused out-of-order dedup data loss. The single-origin-contiguous-seq frame invariant is the structural enabler.
- [DECISIONS V](../DECISIONS.md) — view-synchronous membership: the ring is driven by committed views (`installView`), the failure detector (`suspect`) is the reachability signal, and `epoch` rides in the prov ext for epoch-fenced LWW.
- [DECISIONS P / P4](../DECISIONS.md) — R-way replication: `owners(key,R)` + `replicateTo` ship a committed record only to its R-set instead of broadcasting.
- [DECISIONS Q1 / Q2 / Q3](../DECISIONS.md) — the `call`/`subscribe`/`deltaTo` + sub-id routing that owner-routed reads and distributed aggregates/gather ride on; the stale-delta drop in `dispatch()` was a Q2c fix.
- Key trade-offs: **fixed u32 bodyLen** (3 bytes/frame vs a branch-light framer — chosen for the framer); **JSON object values** behind the codec seam (correctness limits — Buffers/nested NaN — until a CBOR swap, [open question 8](../IDEAS.md)); **djb2+fmix32** hash pending a bake-off ([open question 9](../IDEAS.md)); **inlined varint decode** duplicated across `Frame`/`RecordView` on purpose — do not factor it out, it would allocate on the hot path.

## Open work

The matching workstreams in [IDEAS.md](../IDEAS.md):

- **Identity, dedup & connection hygiene** [P1] — no stable peer identity until the handshake: re-key inbound peers off the learned listen address/uuid, dedup the two-socket-per-pair case (connected-wins), prune dead rows, uuid self-reject.
- **Zero-copy send path** [P1] — replace the `encodeFrame`-per-tick outbox with a streaming `Outbox` into a reused per-peer buffer; add backpressure (honor `socket.write()`'s `false`) and a bounded outbox.
- **Routing hot path** [P1] — `RecordView.key0` (decode only the partition segment), a hot-key hash memo, the hash bake-off, a self-delivery fast path.
- **Robustness & lifecycle** [P1] — defensive decode against malformed/hostile frames (`records()` trusts `count` and each `recLen`; bound both against remaining body bytes).
- **Value codec & wire evolution** [P2] — Buffer/typed-array values, nested NaN/Infinity; expose varint/zigzag as a shared `codec` seam; a `dispatch[verb]` table.
- **Handshake / membership protocol** [P2] — commit on DONE not INIT; guards (drop INIT from a connected peer, version byte).
- **Wire-format micro-optimizations** [P3] — the reserved `FLAG_COL`/`FLAG_UNIFORM`/`KEY_DELTA` bits (columnar body, prefix-delta keys) are placeholders, not yet built.

Cross-cutting open questions: [#8 value codec](../IDEAS.md), [#9 hash function](../IDEAS.md).