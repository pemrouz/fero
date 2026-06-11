# fero v2 — plan

A from-scratch rewrite of [`fero`](../fero/) on top of [`data`](../data/). This document is the working spec — iterate here before code.

---

## 1. Goal

`fero(name, opts?)` returns a distributed, replicated reactive resource. The returned object has three reactive surfaces (`data`, `methods`, `cluster`) and one lifecycle method (`destroy`). Everything reactive composes through `data`'s operator graph; everything callable goes through `methods`.

The whole public API:

```js
fero(name)                                            // read-only client
fero(name, { someMethod, otherMethod })               // shorthand: methods only
fero(name, { someMethod, …config })                   // methods + config keys
fero.all([names], opts)                               // bulk

// returns
{ data, methods, cluster, destroy }
```

**Zero events, zero hooks.** Everything that used to be `.on(...)` is now `data.connect(...)` or `cluster.peers.connect(...)`. Everything that used to be a "hook" (`write`, `read`, `after`) is a method with a fero-provided default.

---

## 2. Why on top of `data`

`data`'s change records (`{type:'update'|'insert'|'remove', key, value, at?}`) are exactly the right shape for a replicated log entry. There is no translation layer between "what `data` emits internally" and "what crosses the wire."

- Operators compose. `data.filter(...).group('country').sum('value')` returns a ViewProxy whose change stream IS the wire format for a per-client subscription.
- Reads collapse into property access. `sessions.data.user42[value]` and `await sessions.data.user42` replace the old `GET` / `SUBSCRIBE` verbs.
- Mutations collapse into assignment. `sessions.data.user42.active = false` replaces `update/add/push/patch`.
- The DOM render layer and the devtools panel come along for free — the same proxy a client mutates is the one a view binds to.

---

## 3. Layered architecture

The public API (one `fero()` call) is the only surface 95% of consumers see. Internally, the implementation is four layers, each independently usable and testable:

```
┌─────────────────────────────────────────────────────────────┐
│ L4 │ tooling                  CLI · devtools · chaos tests  │
├────┼────────────────────────────────────────────────────────┤
│ L3 │ planner (later)          distributed operator graph    │
│    │                          (ship the chain, roll up)     │
├────┼────────────────────────────────────────────────────────┤
│ L2 │ resource                 fero(name, opts) — the user   │
│    │                          API: data + methods + cluster │
├────┼────────────────────────────────────────────────────────┤
│ L1 │ log + view               per-key append-only log of    │
│    │                          change records, projected     │
│    │                          as $() ViewProxy              │
├────┼────────────────────────────────────────────────────────┤
│ L0 │ transport                peers · DHT · UDP discovery   │
│    │                          · INIT/SYNC/DONE handshake    │
├────┼────────────────────────────────────────────────────────┤
│  data    (sibling repo)       $() · operators · render      │
└─────────────────────────────────────────────────────────────┘
```

L0–L2 ship in v1. L3 is the big rethink — a planner that splits an operator chain into per-partition + roll-up + local stages — and only earns its keep once L0–L2 are solid.

---

## 4. The full surface

### Construction

```js
import { fero, value } from 'fero'

// — read-only client —
const sessions = await fero('sessions')

// — server, methods only (shorthand) —
const sessions = await fero('sessions', {
  login:  async (arg, context) => { … return { ok, id } },
  logout: async (arg, context) => { … },
})

// — server, full config —
const sessions = await fero('sessions', {
  // any function key is a method
  login(arg, context)            { … return reply },
  logout(arg, context)           { … },

  // overridable defaults for direct mutation
  update(change, context)        { /* default: context.data[change.key] = change.value */ },
  // insert(change, context)
  // remove(change, context)

  // subscription methods (return ViewProxies)
  read(_, context)               { return context.data /* projection per peer */ },
  activeUsers(_, context)        { return context.data.filter(s => s.active) },
  leaderboard(_, context)        { return context.data.group('country').sum('value').top(10) },

  // non-function keys are config
  storage: { restore, insert, update, remove },
  hosts:   ['10.0.0.1'],
  ports:   [3000, 4000],
  client:  false,
  udp:     { ip: '224.0.0.251', port: 5354, ttl: 128 },
  hash:    djbx,
})
```

**Recognition rule:** *value type, not key name*. Functions become methods (overriding defaults where applicable). Non-functions become config. No reserved key names, no case rules.

`await fero(...)` resolves once the cluster is reachable (or after `connect.wait` elapses with no peers found — the "I'm the first" case). It IS the ready signal; there is no `.ready` / `.on('connected')`.

### `sessions.data` — reactive state

```js
// reads
sessions.data[value]                              // snapshot
sessions.data.user42.active                       // child view (reactive)
await sessions.data.user42                        // async snapshot
sessions.data.filter(s => s.active).length()     // any data operator
sessions.data.group('country').sum('value').top(10)

// writes (sugar over methods.update / methods.insert / methods.remove)
sessions.data.user42 = { name: 'P', active: true }   // UPDATE
sessions.data.user42.active = false                  // nested UPDATE
delete sessions.data.user42                          // REMOVE
sessions.data.events.push(e)                         // INSERT

// change stream — just connect
sessions.data.connect([])                            // array of all changes
sessions.data.connect(audit, change => audit.add(change))
sessions.data.tap(c => render(c))                    // operator form
```

### `sessions.methods` — RPC + subscriptions

A method returns whatever it wants. The caller's `await` decision picks the consumption mode.

```js
// RPC: returns single value
const reply = await sessions.methods.login({ email, pw })

// subscription: returns ViewProxy — don't await
const view = sessions.methods.activeUsers()
view.tap(rows => render(rows))

// snapshot of a subscription: await it (ViewProxies are thenable)
const snapshot = await sessions.methods.activeUsers()

// the write defaults are callable too
await sessions.methods.update({ key: ['user42'], value: { … } })
```

**Soft naming convention** (recommend in README, don't enforce): verbs for RPC (`login`, `purchase`), nouns for subscriptions (`activeUsers`, `leaderboard`).

### `sessions.cluster` — meta (reactive)

```js
sessions.cluster.peers                                 // ViewProxy<Peer[]>
sessions.cluster.peers.filter('status', 'connected')   // any operator
sessions.cluster.peers.connect([])                     // "peer events" = change records
sessions.cluster.me                                    // local node identity
sessions.cluster.partitions                            // ViewProxy<Partition[]>
sessions.cluster.peers.send(rawMsg)                    // out-of-band escape hatch
```

Because `cluster.peers` is a ViewProxy, peer "events" are just changes on it (`connect` to listen). Same machinery, no new event system.

### Lifecycle

```js
const sessions = await fero('sessions', { … })  // resolves when cluster reachable
await sessions.destroy()                          // tears down sockets, timers, log handles
```

---

## 5. Replication topology

Two regimes, with explicit boundaries:

### Server ↔ server
- **Full mesh, full state.** Servers trust each other; each holds the full log.
- `read` does **not** apply. Servers replicate everything.
- The DHT assigns each partition a single owner; only the owner accepts writes for that partition.
- Discovery via UDP multicast (and optional static `hosts:` list).

### Server → client
- The connected server peer runs `read(_, {peer, data})` **once per client** at subscription time. Returns a ViewProxy = that client's projection.
- fero replicates the projection's state + change stream to the client. Because `data.filter(...)` is incrementally maintained, the wire traffic is automatically only the deltas that pass.
- Auth re-binding: when the client's auth context changes, fero re-invokes `read`, diffs the new projection, sends the resulting inserts/removes.
- Default (`read` omitted): full passthrough. Closed clusters of trusted clients need never write `read`.

---

## 6. Method dispatch

Methods run on the **connected server peer**, not the partition owner. Two reasons:

1. **Latency.** Pure-read methods never leave the connected server. One hop, not two.
2. **Load spread.** Method compute distributes naturally across the cluster.

```
client ──(method call)──> connected server
                              │
                              ├─ reads: local replica (all servers have full state)
                              │
                              └─ writes inside handler:
                                     │
                                     └──(commit)──> partition owner (via DHT)
                                                       │
                                                       ├─ append log
                                                       └─ replicate to all peers
                                                          (including the connected server,
                                                           which mirrors the commit back
                                                           into the local replica)
```

Inside a handler, every `data.x = y` is intercepted: change record built, routed via DHT to the partition owner, committed to the log, replicated. **The reply you `return` is post-commit** — but NOT because each assignment blocks (that framing was revised; see §11.1): assignments are fire-and-forget, and `return` is post-commit because pending writes are flushed-and-awaited on return (the flush-on-return barrier, still open work — [IDEAS](IDEAS.md) open question 1). A method-call write (`await methods.update(...)`) is individually ack'd today via the ack-confirmed owner-forward ([DECISIONS X](DECISIONS.md)).

### Consequences

- **Handler must be tolerant of running on a non-owner.** That's fine — `data` is consistent across servers, so reads are local-correct.
- **Subscriptions returned from methods are server-local.** The connected server peer holds the projection's incremental state and pipes deltas to the client. If that server drops, the client reconnects to another and re-subscribes (hard failure for v1; reconnect machinery comes with chaos tests).
- **No cross-partition atomicity.** Two writes in one handler targeting different partitions hit different owners. Same constraint as old fero; document, don't paper over.
- **Methods themselves don't need a partition key.** The writes inside them are partitioned by `change.key[0]` (configurable). Methods themselves run anywhere.

---

## 7. Handler shape

```js
methodName(arg, context) { … return reply }
```

- **`arg`** — the single object passed at the call site. `methods.login({email, pw})` → `arg = {email, pw}`.
- **`context`** — `{ data, peer, methods, cluster }`.
  - `data` — the local replica's ViewProxy. Reads are local-consistent; writes route via DHT.
  - `peer` — the caller (client or server peer). Carries `{address, status, auth?}`.
  - `methods` — peer methods (call one method from another, with auth identity preserved).
  - `cluster` — same as outer `sessions.cluster`.
- **`return`** is the reply. `throw` is the rejection. No `req.reply()`, no `req.next()`.

### Default method implementations (overridable)

```js
update: (change, { data }) => { data[change.key] = change.value }
insert: (change, { data }) => { data[change.key] = change.value }  // honour change.at
remove: (change, { data }) => { delete data[change.key] }
read:   (_,      { data }) => data                                  // full passthrough
```

Override to add auth, transformation, or audit:

```js
update(change, { peer, data }) {
  if (peer.auth?.id !== change.key[0]) throw new Error('forbidden')
  data[change.key] = change.value   // explicit commit
}
```

Recursion-safety: when a method assigns to `context.data`, it's a *trusted local commit* on the owner — replicates outward but doesn't re-invoke the method. Off-owner writes are the ones that get routed-then-dispatched.

---

## 8. Old → new mapping

| Old | New |
|---|---|
| `cache.set(change)` | `sessions.data.x = y` or `delete sessions.data.x` |
| `cache.update(key, value)` | `sessions.data[key] = value` |
| `cache.add(key, value)` | `sessions.data[key] = value` |
| `cache.push([key,] value)` | `sessions.data.arr.push(value)` |
| `cache.patch(values)` | `Object.assign(sessions.data, values)` |
| `cache.remove(key)` | `delete sessions.data[key]` |
| `cache.subscribe(key)` | `sessions.data[...key].tap(fn)` / `.connect(...)` |
| `cache.next({type:'GET',key})` | `await sessions.data[...key]` |
| `cache.destroy()` | unchanged |
| `await cache.once('connected')` | `await fero(...)` (it IS the ready signal) |
| `req.type==='LOGIN' ? login(req) : …` | `login(arg, context) { … }` |
| `req.type==='UPDATE' ? authz && req.next()` | `update(change, context) { if(!authz) throw; data[k]=v }` |
| `req.type==='SUBSCRIBE' ? authz && req.next()` | `read(_, context) { return data.filter(…) }` |
| `req.reply(v) / return v` | `return v` (or `throw`) |
| `cache.on('commit')` + `.on('change')` | `sessions.data.connect(...)` / `.tap(...)` |
| `cache.on('disconnected' \| 'connecting' \| 'connected' \| 'removed' \| 'client')` | `sessions.cluster.peers.connect(...)` |
| `cache.peers.lists.connected` | `sessions.cluster.peers.filter('status','connected')` |
| `cache.peers.send(...)` | `sessions.cluster.peers.send(...)` |
| `cache.peers.send(...).on('reply')` | `await sessions.methods.X({...})` |
| `connect(db)(fero(...))` | `fero('…', { storage: db })` |
| `fero('…', { from: handler })` | `fero('…', { someMethod, otherMethod })` |

---

## 9. Internals layout

The new folder:

```
fero-v2/                                  # this folder
├── plan.md                               # this file
├── README.md                             # written after v1 lands
├── package.json                          # type: module; deps: data, ll, copt, bintrees
├── index.ts                              # public API: fero(), re-exports value etc.
│
├── transport/                            # L0
│   ├── index.ts                          # transport({…}) → mesh
│   ├── peer.ts                           # ported from old fero, ESM/TS
│   ├── dht.ts                            # consistent hashring
│   ├── handshake.ts                      # INIT/SYNC/DONE
│   ├── retries.ts
│   ├── message.ts                        # binary framing (lazy deserialise)
│   ├── discovery/{multicast,static}.ts
│   └── *.test.ts
│
├── log/                                  # L1
│   ├── index.ts                          # log() + view()
│   ├── log.ts                            # the Log class
│   └── *.test.ts
│
├── resource/                             # L2 — the public surface
│   ├── index.ts                          # fero(name, opts) → { data, methods, cluster, destroy }
│   ├── dispatch.ts                       # method-call dispatch (connected server runs handler;
│   │                                       writes inside handler route to owner)
│   ├── projection.ts                     # read() machinery + per-client subscription state
│   └── *.test.ts
│
├── planner/                              # L3 — later
│
├── cli/                                  # L4
│   ├── ls.ts                             # `fero ls`
│   └── inspect.ts                        # `fero inspect <name>`
│
├── devtools/                             # L4 — cluster tab plugin for data/devtools
│
├── examples/
│   ├── sessions/                         # README example, two processes
│   ├── presence/                         # browser tabs as peers
│   └── chat/                             # collaborative state
│
└── tests/
    ├── unit/                             # piecewise per layer
    └── chaos/                            # spin up N nodes, partition/heal, assert convergence
```

**Power-user escape:** `import { transport, log, view } from 'fero/internals'` so a project that wants a bare log without verbs (or a custom transport) doesn't have to fork.

---

## 10. Build order — centerpiece-first

Per the `feedback_rethink_not_reskin` and `feedback_serve_for_visual_progress` memories: prototype the centerpiece before scaffolding the layers.

1. **Day 0 — wire-format prototype.** ✅ *Done — spike since removed, its hypothesis now carried by L0–L2 (transport / log / resource).* Two Node processes, one TCP socket, `$()` on A replicating to `$()` on B via raw change records. No fero abstractions; just `proxy.connect(...)` piped over a socket on each side. Proved the foundational hypothesis: **change records on the wire = change records in memory**. Round-tripped cleanly for object set, nested set, delete, ordered array insert, and mixed streams; the rest was plumbing. Surfaced two facts for later layers: new-key sets cross the wire as `insert` (with `at` = key) because `data`'s `BU1` upserts split to `BI0` — so L1's first-write log entry is an insert; and `data` holds sinks via `WeakRef`, so long-lived replication must pin the sink.

2. **L0 — transport.** Port peer pool / DHT / handshake / multicast discovery from old fero. Modernise to ESM/TS. Cover with unit tests; the message-framing perf invariants (lazy deserialise, batching) must hold.

3. **L1 — log + view.** Per-partition append-only log. Replication protocol on top of L0. View projects log tail as `$()`. Standalone usable; tested with a 2-node `log.append → view.tap` round-trip.

4. **L2 — resource.** `fero(name, opts) → {data, methods, cluster, destroy}`. Method dispatch (connected server runs handler; writes inside handler route via DHT). Default `update`/`insert`/`remove`/`read`. Per-client projection machinery.

5. **L4 — tooling + examples + chaos tests.** CLI, devtools cluster tab, README example, chaos harness ported from old fero (spin up N nodes, partition the network, assert convergence). *Chaos-harness slice LANDED ([DECISIONS L4](DECISIONS.md)): a reusable `cluster()` harness + a reversible partition seam (`isolate`/`heal`, off the public API), with N-node convergence, network partition→heal, crash→recover, churn, and a randomized soak — plus real-socket large-frame + handshake straddle/malformed-identity coverage. CLI / devtools / examples still to come.*

6. **L3 — planner.** Only once everything below is rock-solid. Inspects the operator dispatch tree, classifies nodes by capability (partition-friendly / reducible / local), rewrites into per-partition + roll-up + local stages. The big rethink. *First slices LANDED — **Q2** decomposable distributed aggregates ([DECISIONS Q2](DECISIONS.md)): whole-resource `data.sum/count/max/min/avg/some/every` as an owner-scoped fan-out + fold (one row → O(holders) global update; full replication byte-identical). **Q3** holistic ops via GATHER ([DECISIONS Q3](DECISIONS.md)): whole-resource `read()` (no key) under scoping folds every holder's owner-scoped ROWS into the whole resource (the Q2 fold with a union rule), so holistic ops run AFTER read over the gathered proxy locally — `methods.read().az('v')` / `.reduce(fn)` / `.distinct()` (the closure never crosses the wire). Decomposable ops work BEFORE read; whole-resource ops come AFTER it (read = the explicit download), and a holistic result can be promoted to a derived named resource. The rest of the planner — chained aggregates (`group(c).sum(v)`, anything past the facade's first hop), the named-method fold / user combine (closure predicates + the SCALABLE alternative to Q3's O(N) gather), bucket→rows group / top-K / length(fn), and median/percentile terminals — is loudly flagged by the Q2f boundary guard (now pointing at `read()`-first) and deferred here.*

---

## 11. Open questions to resolve as we build

1. **Write commit mode inside handlers.** *Resolved — accept the asymmetry between the two write paths; await-or-not settles it where the language allows, no new syntax.*

   The two write paths can't behave the same under `await`, for a hard JS reason:

   - **Method-call writes** (`await methods.update(k, v)` vs `methods.update(k, v)`) — await-or-not works, because a *call* returns a library-controlled value, exactly like the client-side return-type dispatch. `await` ⇒ wait for the commit ack; no `await` ⇒ fire-and-forget. This is the path to reach for when you need durability confirmation mid-handler.
   - **Assignment writes** (`data.user42 = {…}`) — *inherently* fire-and-forget; there is nothing to await. An assignment expression always evaluates to the RHS (per spec), and the `data` proxy's `set` trap is synchronous and returns a boolean (it calls `res.update(...)`; can't substitute a Promise). So `await (data.x = v)` awaits `v` and resolves instantly — no hook for an ack. And `await data.x` is already the snapshot-read thenable trick in `data`, so it can't double as a write barrier either.

   Consequence: the old "default = await each commit before continuing" framing is **not achievable** for the assignment syntax it most wants to support — synchronous assignment can't suspend the handler, and per-write acks would serialize one network round-trip per write anyway. So:

   - Assignments are fire-and-forget by default. For ack-before-`return`, flush + await pending writes when the handler returns (the `return` value is post-commit because of the flush, not because each assignment blocked).
   - When a handler needs an explicit mid-body confirmation, use the awaitable method form (`await methods.update(...)`), **not** a magic assignment. If a barrier is ever wanted, it must be a distinct handle (`await commit()` / `await data.flush()`) — never `await data`, which collides with the snapshot read.

   Nail down the flush-on-return mechanics during L2.

2. **Re-subscription on connected-server failover.** When the connected server drops, the client reconnects to another and re-runs `read`. Not an API decision — part of chaos test coverage. Document failure semantics.

3. **Cross-partition transactional ordering.** Two writes in one handler targeting different partitions land on different owners. No atomicity guarantee. Same as old fero; document explicitly.

4. **AsyncIterator-returning methods.** Single-value (Promise) and ViewProxy (subscription) cover most cases. Probably no need for an explicit async-iterator path. Revisit if a real use case turns up.

5. **`cluster.me` before connect.** Available during the `fero(...)` await as `{host, port}` (the local server identity, even before any peer is reached) so handlers can compare without a race.

6. **Reserved top-level keys on the returned object** — `data`, `methods`, `cluster`, `destroy`. If a future surface adds more (e.g. `cluster.events`), keep it nested under one of the three reactive surfaces — don't grow the top level.

---

## 12. What this kills vs old fero

- 5 mutation methods → 0 (assignment)
- 2 read methods → 0 (property access)
- 1 mega-dispatcher → N named methods (with defaults for `update`/`insert`/`remove`/`read`)
- 11 events → 0 (everything is a change stream via `connect`)
- 11 listed events incl. `commit`, `change`, `proxy`, `ack`, `reply`, `status`, 5×peer-status
- `req.next()` / `req.reply()` / mixed return-or-side-effect → `return` (or `throw`)
- `peers.lists.{connected,disconnected,connecting,throttled,client,all}` × 6 → one `cluster.peers` ViewProxy
- `SUBSCRIBE`/`GET` wire verbs → gone (subsumed by `data` proxy semantics + `read`)
- `connect(db)(fero(...))` wrapper → `storage:` config key

## 13. What this preserves

- `fero(name, opts?)` headline signature
- `fero.all([…])`
- DHT-based partition ownership
- Per-partition append-only log
- The fast binary wire path (still on the wire, just not visible at the user API)
- Sub-ms RPC latency target (now further helped by methods running on the connected server)
- Trial deployment posture (declarative reactive chains across services)
