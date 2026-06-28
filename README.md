# fero — distributed, replicated reactive resources

`fero(name, opts?)` returns a distributed, replicated reactive resource. One call gives you three reactive surfaces and a teardown:

```js
const { data, methods, cluster, destroy } = await fero('sessions', { /* methods + config */ })
```

Built on [`data`](../data/) (the sibling reactive-collections library). `data` provides `$()` proxies with incremental operators; **fero makes those proxies distributed.** The currency is the same in both: a change record `{ type, key, value, at? }` is what `data` emits, what the log stores, and what crosses the wire — there is no translation layer.

```js
import { fero, value } from 'fero'

// read-only client
const sessions = await fero('sessions')
sessions.data.user42.active            // reactive child view
await sessions.data.user42             // async snapshot

// server (any function key is a method; non-functions are config)
const sessions = await fero('sessions', {
  login: async ({ email, pw }, ctx) => { /* … */ return { ok, id } },
  activeUsers: (_, ctx) => ctx.data.filter(s => s.active),   // returns a ViewProxy ⇒ subscription
  replicas: 3,                                                // config (non-function)
})
```

`await fero(...)` **is** the ready signal — it resolves once the cluster is reachable, or after `wait` ms with no peers (the "I'm first" case). There is no `.ready` and no `.on('connected')`. Zero events, zero hooks: everything reactive flows through `data`'s change stream, which you `connect`/`tap`.

> **Status — pre-1.0.** The L0–L2 stack (transport, log, resource) and the first L3 slices (distributed aggregates, gather) are built and tested; the planner layer, LAN multicast discovery, and several hardening items are deferred. See [DECISIONS.md](DECISIONS.md) for what landed and why, and [IDEAS.md](IDEAS.md) for open work. **Packaging:** fero ships raw TypeScript with no build step — the `.` / `./internals` entries below resolve to source `.ts` ([index.ts](index.ts), [internals.ts](internals.ts)), run via `--experimental-strip-types` like the test suite; there is no `dist/` yet.

## Install

```js
import { fero, value } from 'fero'                       // the whole public API
import { transport, log, view } from 'fero/internals'    // power-user escape hatch
```

Two entries: the default (`fero`, `value`, `fileStorage`) and `fero/internals` — a bare log, the view projection, or a custom transport, for a project that wants the layers without the `fero()` verb wrapper, without forking.

## The three surfaces

### `data` — reactive state

```js
// reads — property access; await for a snapshot
sessions.data.user42.active
await sessions.data.user42
sessions.data.filter(s => s.active).length()

// writes — assignment is FIRE-AND-FORGET (sugar over methods.update/insert/remove)
sessions.data.user42 = { name: 'P', active: true }   // update
sessions.data.user42.active = false                  // nested update
delete sessions.data.user42                          // remove
sessions.data.events.push(e)                         // insert

// change stream — connect or tap
sessions.data.connect([])
sessions.data.tap(c => render(c))
```

A bare assignment is **fire-and-forget** — it doesn't wait for the cluster (and `await (data.x = v)` can't help: JS evaluates an assignment to its right-hand side, not the write). When you DO care, write through `methods` and pick a guarantee to `await` ([DECISIONS Z](DECISIONS.md)):

```js
sessions.data.acct7 = balance                                      // fire-and-forget
await sessions.methods.update({ key: ['acct7'], value: balance, confirm: 'accepted' })   // applied locally (~0)
await sessions.methods.update({ key: ['acct7'], value: balance, confirm: 'committed' })  // owner sequenced + logged (~1 RTT)
const r = await sessions.methods.update({ key: ['acct7'], value: balance, confirm: 'replicated' }) // W of the R-set hold it (~2 RTT)
const r = await sessions.methods.update({ key: ['acct7'], value: balance, confirm: 'persisted' })   // W of the R-set DURABLY appended it (needs storage)
// r = { tier, key, seq, epoch, origin }   — rejects { reason:'withheld'|'timeout'|'quorum', reachedTier, localCommit } if it can't reach the bar
```

`committed` means the partition owner **sequenced + logged** the write (durable on the owner; `(epoch, seq, origin)` are the record's full LWW coordinates, so you can detect a later concurrent write superseding it — committed = SEQUENCED, not necessarily WON). `replicated` means a **W-quorum of the partition's R-set** holds it in memory (survives the owner crashing). `persisted` means a **W-quorum has resolved `storage.append`** — its strength is exactly the seam's: the built-in `fileStorage` reaches the OS page cache (survives a process crash, not power loss), an fsync'd seam survives power loss. `persisted` requires a storage seam ([DECISIONS Z](DECISIONS.md)).

Under R-way holding (`replicas: R`) a node materializes only the partitions it replicates, so reads are **hold-relative**: synchronous-and-local for a held partition, an `await`/subscribe **remote handle** for one it doesn't ([DECISIONS Q1](DECISIONS.md)). Whole-resource aggregates (`data.sum('value')`, `.count()`, `.max/min/avg`, `.some/every`) fan out to every holder and fold the partials ([DECISIONS Q2](DECISIONS.md)); holistic ops (sort, `distinct`, `group`, `reduce`) run **after** `methods.read()` — the explicit download — over the gathered resource ([DECISIONS Q3](DECISIONS.md)).

### `methods` — RPC + subscriptions

A method returns whatever it wants; the caller's `await`-or-not picks the consumption mode.

```js
const reply = await sessions.methods.login({ email, pw })   // await ⇒ one-shot RPC
const view  = sessions.methods.activeUsers()                // no await ⇒ live subscription
view.tap(rows => render(rows))
const snap  = await sessions.methods.activeUsers()          // await a subscription ⇒ snapshot
```

Defaults `update`/`insert`/`remove`/`read` ship out of the box; override any by passing a same-named function. A handler receives `(arg, context)` where `context = { data, cluster, methods, log, name, peer? }`; `return` is the reply, `throw` is the rejection. Soft convention: verbs for RPC, nouns for subscriptions — recommended, never enforced (no reserved names, no case rules).

### `cluster` — meta

```js
sessions.cluster.peers                                   // L0 ViewProxy<Peer> — queryable + connectable
sessions.cluster.peers.filter('status', 'connected')
sessions.cluster.me                                       // this server's listen address
sessions.cluster.owner(key) / .replicas(key)             // DHT ownership / R-set
sessions.cluster.epoch / .members / .writable            // view-synchronous membership state
sessions.cluster.writes                                  // confirm-write lifecycle ViewProxy (in-flight + per-guarantee latency)
```

`cluster.peers` is a ViewProxy, so peer "events" are just changes on it. (`cluster.partitions` and `cluster`-as-a-ViewProxy are tracked open work — see the Surfaces workstream in [IDEAS.md](IDEAS.md).)

`cluster.writes` answers "how long does each guarantee actually take?" at runtime: a gated, bounded ViewProxy where every `confirm` write goes `pending` → `confirmed`/`rejected` carrying its measured `latency` (and `seq`/`epoch`, or a reject `reason`). It's reactive and queryable like any view —

```js
sessions.cluster.writes.filter('state', 'pending')                  // what's in flight right now
sessions.cluster.writes.filter('guarantee', 'replicated').avg('latency') // how long the W-quorum guarantee costs
```

Fire-and-forget writes aren't recorded (no guarantee to time), and the surface is built lazily on first access — an un-introspected node allocates nothing ([DECISIONS Z](DECISIONS.md)).

## Layered architecture

The single `fero()` call is the only surface 95% of consumers see. Internally it is layers, each independently usable and testable:

```
L4   tooling          chaos harness + network observer/dashboard      (built; CLI deferred)
L3   planner          distributed operator graph                      (deferred; Q2/Q3 slices live in L2 today)
L2   resource         fero(name, opts) — the public API               → resource/
L1   log + view       per-partition append-only log + $() projection  → log/
L0   transport        peers · DHT · view membership · framing         → transport/
──── data (sibling) ──  $() · operators · render
```

| Layer | Module | Owns |
|---|---|---|
| L0 | [transport/](transport/) | peer pool, DHT consistent-hashring, view-membership control frames, binary wire framing, RPC/subscription routing — `transport(opts) → Mesh` |
| L1 | [log/](log/) | per-partition append-only log of change records; `view(log)` projects it as a `$()` ViewProxy; offset-vector + anti-entropy sync primitives |
| L2 | [resource/](resource/) | `fero(name, opts)` — the three surfaces, the replication core (provenance/dedup/LWW), view-synchronous membership, R-way holding, owner-routed writes, distributed aggregates + gather |

L3 is the big rethink (a planner that splits an operator chain into per-partition + roll-up + local stages); its first decomposable slices (Q2/Q3) ship inside L2 and are policed by a boundary guard rather than living in `planner/` yet.

## Replication model in brief

- **Server ↔ server: full mesh.** Every writer broadcasts its own writes in seq order; each server folds inbound records through dedup (per-origin high-water) + last-writer-wins by `(epoch, seq, origin)`, so nodes converge instead of diverging ([DECISIONS A](DECISIONS.md), [B](DECISIONS.md)). With `replicas: R`, holding is scoped to R replicas per partition and writes replicate O(R) instead of O(N) ([DECISIONS P](DECISIONS.md), [P4](DECISIONS.md)); the default (R = ∞) is full replication, byte-for-byte unchanged.
- **Owner-routed writes.** The DHT assigns each partition one owner; a write to a non-owned partition is forwarded to the owner, which re-sequences it under its own provenance and broadcasts the canonical record — one in-order source per partition ([DECISIONS F1](DECISIONS.md)).
- **View-synchronous membership.** The cluster agrees on numbered views `{ epoch, members }` via a Paxos-flavoured ballot; ownership is stable within an epoch, and the minority side of a partition is read-only (CP) rather than divergent ([DECISIONS V](DECISIONS.md)).
- **Server → client: projection.** The connected server runs `read(_, ctx)` once per client and streams that ViewProxy's incremental deltas; because the projection is incrementally maintained, the wire carries only the deltas that pass.
- **Persistence + catch-up.** A `storage` seam (`{ load, append }`, built-in `fileStorage`) replays through the same accept path on boot; a (re)connecting peer exchanges per-origin digests and ships only what the other lacks ([DECISIONS C](DECISIONS.md), [B](DECISIONS.md)).

## Performance

Ultra-low latency is a hard requirement, not an afterthought — fero is on the hot path of every read, write, and replication hop. Every change is validated for perf the same way it's validated for correctness: per-file `*.perf.ts` siblings assert median-of-5 timings against hard thresholds, and a threshold is never widened to make a test pass. The full-replication (R = ∞) path is kept byte-identical as new modes land, so the steady-state write path stays allocation-lean. See [CLAUDE.md](CLAUDE.md) for the discipline.

## Dev workflow

```bash
npm test       # node --test over utils/transport/log/resource/tools/chaos *.test.ts (TS run directly, no build step)
npm run perf   # median-of-5 perf assertions with hard thresholds
npm run observe  # launch the L4 network observer + dashboard against a running cluster
```

TypeScript is the source of truth; `*.js` is gitignored, tests run via `--experimental-strip-types`. Conventions, the layered build order, and the perf invariants are in [CLAUDE.md](CLAUDE.md). The design spec is [plan.md](plan.md); settled rationale is in [DECISIONS.md](DECISIONS.md) (append-only); open work, grouped by workstream, is in [IDEAS.md](IDEAS.md).

## License

MIT