# resource — the public `fero(name, opts)` surface (L2)

The whole library in one call. `resource` composes L1's record machinery (log + `applyRecord`) onto an L0 mesh and exposes the three reactive surfaces from [plan §1](../plan.md) — `data`, `methods`, `cluster` — plus `destroy`. It is the centerpiece: every read, write, and replication hop on the user's hot path passes through here. It also owns the replication *discipline* that turns the day-0 hypothesis ("change records on the wire = change records in memory") into a convergent, view-synchronous, linearizable-per-partition store.

`await fero(...)` **is** the ready signal — it resolves once the cluster is reachable, or after `wait` ms with no peers (the "I'm first" case). There is no `.ready` / `.on('connected')`.

## Files

| File | Role |
|---|---|
| [index.ts](index.ts) | `fero(name, opts)` → `{ data, methods, cluster, destroy }`. The replication core (Lamport clock + dedup + LWW), the write-capture sink, owner-routed forwarding (F1), the write-gate (V1e), scoped R-way holding + orphan shedding (P/P4), hold-relative reads + the `data` facade (Q1), the distributed-aggregate fold/gather engine (Q2/Q3), and method dispatch. |
| [view.ts](view.ts) | `ViewManager` — the view-synchronous membership state machine (Milestone V). Forms a committed `{ epoch, members }` via a Paxos-flavoured ballot and drives the DHT ring so ownership is stable within an epoch. The clean, isolated unit index.ts aspires to. |
| [storage.ts](storage.ts) | `fileStorage(path)` — the built-in append-only-file WAL adapter for the `storage` seam (one JSON change-record per line). Bring-your-own by implementing `{ load, append }`. |

## Public surface

```js
import { fero, value, fileStorage } from 'fero'

// read-only client — no listen port
const sessions = await fero('sessions')

// server — function values are methods, everything else is config (by value type)
const sessions = await fero('sessions', {
  login:   async ({ email, pw }, c) => { …; return { ok, id } }, // RPC
  read:    (_, c) => c.data.filter(s => s.active),               // per-client projection
  // overridable defaults: read · aggregate · update · insert · remove
  replicas: 3,                          // R-way holding (default ∞ = full replication)
  storage:  fileStorage('./s.wal'),     // durable WAL
})
```

| Export | Shape |
|---|---|
| `fero(name, opts?)` | `Promise<Fero>` — `await` is the ready signal |
| `Fero` | `{ data, methods, cluster, destroy }` |
| `Context` | `{ data, cluster, methods, log, name, peer? }` — every method's 2nd arg |
| `Cluster` | `{ peers, me?, uuid, owner(key), replicas(key), epoch, members, writable }` |
| `Method` | `(arg, context) => any` |
| `Storage` | `{ load(), append(record) }` — the durable-log seam |
| `value`, `fileStorage` | re-exports |

**Three surfaces.** `data` is a `$()` ViewProxy: read via property access (`sessions.data.user42`), write via assignment (`sessions.data.user42 = {…}`), every `data` operator works. `methods` is RPC + subscriptions on one handle — `await` it for a one-shot value, use it reactively (`.tap`/`.filter`/`[value]`) for a live subscription; `then` is the only access that doesn't subscribe. `cluster` exposes membership/ownership.

**Recognition rule:** value type, not key name. A function is a method (overriding the same-named default); anything else is config. No reserved key names.

## How it works

The whole module is one closure, `fero()` ([index.ts:111](index.ts)), holding shared mutable state (`clock`, `seen`, `versions`, `pending`, `orphans`, `heldCache`, the aggregate registries) that every inner function reads and writes. The shared-closure design is deliberate for the replication core — these maps must stay coherent per write — and it is the reason the file is large.

**Proxy-as-source (arch B, [DECISIONS H](../DECISIONS.md)).** The `data` proxy is the source of truth; the log is a history sidecar. `data`'s set/delete traps already materialize state *and* emit change records, so a single write-capture sink ([index.ts:442](index.ts)) stamps each emitted record with provenance and turns it into a log append + a peer send. The empty attach-snapshot is swallowed (`primed`); inbound re-emissions are skipped (the `applying` guard at [index.ts:209](index.ts)). The sink host is pinned through `destroy`'s closure because `data` holds sinks by `WeakRef`. (L1's `distribute()` is arch A — the *log* is the write API; L2 inverts it because assignment is the write surface and routing assignments through the log would loop.)

**Convergent replication ([DECISIONS A](../DECISIONS.md), V1d).** `clock` ([index.ts:155](index.ts)) is a Lamport clock — merged up on every inbound record, bumped on every local write — so a local write is always causally newest and *wins* LWW; without this a local write could lose to a high-numbered remote and the nodes would diverge permanently. LWW is lexicographic `(epoch, seq, origin)` ([index.ts:236](index.ts)): a write under a newer view epoch wins (epoch fencing — a straggler from a superseded view can't clobber the current one), then Lamport seq, then origin uuid breaks ties — every node elects the same winner. Per-`seenKey` high-water marks dedup re-delivered records and double as the anti-entropy digest. `versionKey` folds an insert's `at` into the key path so an insert and a later update contend as one key, while distinct leaves get field-level LWW. The `{epoch,seq,origin}` stamp is mutated in place (not reallocated) — version churn was the dominant write-path allocation cost ([DECISIONS G](../DECISIONS.md); guarded by `index.perf.ts`).

**Owner-routed writes by forwarding ([DECISIONS F1](../DECISIONS.md)).** If we don't own a partition and the owner is connected, the sink hands the raw write off via `mesh.forward`; the owner re-applies it through `applyLocalWrite` ([index.ts:603](index.ts)) with `committingForward` set so it commits as-is rather than re-checking ownership (no ping-pong while rings transiently disagree). The structural safety property: **exactly one broadcaster per record** — which is why forwarding is sound where owner-*relay* (the reverted F) was not.

**Write-gate ([DECISIONS V1e](../DECISIONS.md)).** `commitLocal` ([index.ts:557](index.ts)) buffers into a bounded `pending` queue when `viewMgr.canWrite` is false, so a partition's minority side stays read-only (can't diverge) and flushes when quorum returns. The gate is one cached boolean — no per-write membership scan.

**Scoped R-way holding ([DECISIONS P](../DECISIONS.md), P4).** `replicas: R` holds each partition on R replicas (owner + R-1 ring successors); the default ∞ is full replication, byte-identical to the pre-P path. R picks the granularity of log/dedup/anti-entropy. `holds(key)` ([index.ts:350](index.ts)) — memoised per key, cleared on view commit — gates inbound delivery, scoped vs broadcast replication, and the facade read. Acquisition heals via reciprocal anti-entropy (`resync` + the `onDigest` reply leg) driven by view commit *and* a periodic `aeTimer`. P4 shedding keeps an orphan until `shedConfirmed` ([index.ts:528](index.ts)) verifies **every** current R-set member is caught up (single-confirm is unsafe when a partition's whole R-set moves), then `shed` removes it from proxy/log/seen/versions — so the partition is never under-replicated during handoff.

**Hold-relative reads ([DECISIONS Q1](../DECISIONS.md)).** Reads are synchronous-and-local for a held partition, a remote handle for one we don't hold. The `dataFacade` Proxy ([index.ts:1218](index.ts)) classifies a top-level get — symbol/built-in → raw proxy; decomposable aggregate → fold; holistic op → loud local-only guard; registered operator → raw; otherwise a partition key → `readKey` (local child or `remoteRead`). `makeHandle` ([index.ts:946](index.ts)) is a thenable + lazy ViewProxy over `Proxy(noop)`: `then` ⇒ one-shot RPC, any real access ⇒ open a subscription. Under full replication the facade isn't built (raw proxy returned) so the hot path is unchanged.

**Distributed aggregates ([DECISIONS Q2](../DECISIONS.md), Q3).** With R-way holding no node materializes the whole resource, so an aggregate over all of it is computed partial-per-shard + folded. The dedup is **owner-scoping**: each holder aggregates only the partitions it *owns* (`ownedView`, [index.ts:640](index.ts)), so the union across holders is a disjoint cover regardless of R. A serializable spec `{op,col,val}` crosses the wire — never a closure — and `buildPartial` ([index.ts:669](index.ts)) reconstructs the owner-scoped operator on each symmetric holder. `foldOnce`/`openFold`/`foldAggregate` fold the partials by an associative `RULES` combine. **Self is not a wire target** (`pool.peer(me)` is undefined), so the querier's own shard is obtained in-process (`livePartial`) and folded alongside the remote partials — miss it and you get a 1/N undercount. Whole-resource `read()` is the same fold with a `{op:'rows'}` partial + a union rule: `read()` *is* the explicit "download everything", after which holistic ops (`read().az('v')`, `.distinct()`, `.reduce(fn)`) run locally on the gathered proxy. `livePartial` ([index.ts:725](index.ts)) re-scopes on every view commit via a generation guard, because `data`'s `filter` never re-runs its predicate on an ownership move under a stable row and its `FunctionSink` can't be synchronously disconnected.

**Membership ([view.ts](view.ts), [DECISIONS V](../DECISIONS.md)).** `ViewManager` forms a committed `{ epoch, members }` via a single-decree, Paxos-flavoured ballot: the lowest-address reachable node is the soft coordinator; `PREPARE → PROMISE/ACK → COMMIT` with promise semantics make `epoch` a unique per-view token; joint-consensus quorum (a majority of *both* old and new view) means at most one view commits per epoch even under a partition. It drives the DHT ring via `mesh.installView`, and exposes `canWrite` (the write-gate) as a cached boolean.

**Invariants to preserve.** Each `(origin, partition)` stream arrives in seq order from a single source (the dedup/LWW core depends on it — F1's reason for being); the R=∞ path must stay byte-identical (the facade isn't built); the `applying` / `committingForward` / `primed` guards keep the single sink from looping; and `snapshot()` must **not** probe an unknown symbol on a `data` ViewProxy (it throws) — hence the side-effect-free `FOLD_HANDLES` WeakSet ([index.ts:1265](index.ts)).

## Design notes

- Replication core: [DECISIONS A](../DECISIONS.md) (LWW-by-Lamport), [G](../DECISIONS.md) (the single `sclone` is not redundant — don't "dedup" the clone), [H](../DECISIONS.md) (proxy-as-source).
- Catch-up / persistence: [DECISIONS B](../DECISIONS.md) (per-origin digest), [C](../DECISIONS.md) (storage seam + WAL).
- RPC / subscriptions: [DECISIONS D](../DECISIONS.md) (client RPC), [E](../DECISIONS.md) (live subscriptions on one handle).
- Owner-routing / membership: [DECISIONS F](../DECISIONS.md) (why relay failed), [F1](../DECISIONS.md) (forwarding), [V](../DECISIONS.md) (view-synchronous membership), [F2](../DECISIONS.md) (why per-partition sequencing was deferred).
- Partitioned holding / reads / aggregates: [DECISIONS P](../DECISIONS.md), [P4](../DECISIONS.md), [Q1](../DECISIONS.md), [Q2](../DECISIONS.md), [Q3](../DECISIONS.md).

**Key trade-off:** this is a CP posture across membership changes — a partition's minority side is read-only (writes buffer) rather than divergent. Full replication (R=∞) is the default and stays on the original byte-identical hot path; everything scoped is gated on `R < members`, so the perf invariants in `index.perf.ts` / `aggregate.perf.ts` / `gather.perf.ts` hold on every increment. The distributed gather is honestly O(N) ("download everything") — guarded against superlinearity, not against itself.

## Open work

See [IDEAS.md](../IDEAS.md):

- **Open questions** 1 (commit-ack / flush-on-return), 2 (failover re-dispatch / re-subscribe), 3 (cross-partition ordering), 6 (assignment ↔ `methods.update` parity — assignments bypass the method by design), 10 (conflict-merge model).
- **Partitioned holding (open question 7)** — P3 digest compaction, durable shed (WAL compaction), the V deferrals, and the `holds()` allocation-free ring predicate.
- **Aggregates (open question 7 / Aggregates)** — the named-method fold / user-supplied combine (the scalable alternative to the O(N) gather), the L3 chain planner (`top`/`limit`-K, `length(fn)`, bare `group`, chained aggregates), median/percentile terminals, gather/fold hardening, and `some/every('col')` under full replication.
- **Failover & re-dispatch**, **Method / RPC semantics**, and **Surfaces / API completeness** workstreams.
- **Decomposing the `fero()` god-closure** (plan §9's never-built `dispatch.ts`/`projection.ts` split). Landed so far: the `buildPartial` switch + `RULES` table are now one per-op `AGG` registry in [fold.ts](fold.ts); the `makeHandle`/`foldAggregate` duplication is one `lazyHandle` skeleton. **Remaining (do in a clean window, perf-gate each step on `index/aggregate/gather.perf.ts`):**
  1. **`dispatch.ts`** — lift `invoke`/`serveCall`/`serveSubscribe`/`serveUnsubscribe` + `makeHandle`/`clientHandle`/`lazyHandle`/`snapshot`/`isViewProxy`/`FOLD_*` into `makeDispatch({ allMethods, context, mesh, invoke deps, fold entry points })`. Off the per-write hot path.
  2. **fold engine** — lift `ownedView`/`composite`/`buildPartial`/`livePartial`/`foldOnce`/`openFold`/`foldAggregate` into `makeFold({ data, mesh, me, viewMembers, AGG, registries })`, joining `AGG` in [fold.ts](fold.ts). Accept wide param lists — that *is* the real coupling; the win is a ~500-line core + named units, not artificial purity.
  3. **Do NOT extract the replication core** (the write-capture sink, `applyInbound`/`commitLocal`/`applyLocalWrite`, `holds`, the P4 shedding). It is the cohesive heart AND the measured hot path (version-map churn was the dominant write cost — [DECISIONS A/G](../DECISIONS.md)); leave it in `index.ts` as the thin composer's body. This is the part that needs a before/after `index.perf.ts` number, so it stays put.