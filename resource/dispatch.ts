// resource/dispatch.ts — the method-dispatch + read/subscription surface (L2).
//
// makeDispatch({...}) builds, once per fero() node, everything between "a method name arrives"
// and "a value/stream goes back": the inbound RPC + subscription servers (serveCall /
// serveSubscribe / serveUnsubscribe / reapPeer), the local + client method surfaces, the lazy
// remote-read handles (makeHandle / clientHandle / remoteRead / readKey), and the `data` facade
// that classifies a top-level get into a held-local child, a remote handle, a distributed
// aggregate, or a loud holistic-op guard.
//
// It closes over a fero() node's shared state passed BY REFERENCE (the merged method table, the
// Context, the mesh, holds, clientSubs, the raw `data` proxy) plus two injected functions from
// the composer: `invoke` (the in-process method dispatcher) and `fold` (the makeFold() engine —
// serveCall/serveSubscribe route aggregate/gather reads into it, and distributed() opens fold
// handles). Both are built before makeDispatch runs, so the wiring is linear (no forward-ref):
// the composer builds invoke → fold → dispatch. The replication core (the write-capture sink,
// applyInbound/commitLocal, holds, P4 shedding) stays in index.ts — this module never touches it
// beyond calling the injected `holds`.

import { $, view as VIEWSYM, Operators } from '../../data/index.ts'
import { applyRecord } from '../log/index.ts'
import { type ChangeRecord } from '../transport/message.ts'
import { type Mesh } from '../transport/index.ts'
import { AGG, type Fold, type AggSpec } from './fold.ts'
import { lazyHandle, isViewProxy, snapshot } from './handle.ts'
import type { Method, Context } from './index.ts'

export type DispatchDeps = {
  allMethods: Record<string, Method> // merged {...defaults, ...methods}; invoke lookup + the default-read identity gate
  defaults: Record<string, Method> // the built-in method table — the identity target for `allMethods.read === defaults.read`
  context: Context // every method's 2nd arg; makeDispatch sets context.methods = localMethods (in-handler calls run locally)
  mesh: Mesh // L0 routing/membership: call / subscribe / owner / deltaTo / viewMembers
  me: string | undefined // this server's address; undefined ⇒ a read-only client (isClient)
  scoped: boolean // finite R — gates the read-forward / no-key-gather / aggregate-fold branches off in full replication
  R: number // replication factor — the R<viewSize() no-key-gather gate + the R≥members local-aggregate fast path
  viewSize: () => number // mesh.viewMembers().length
  holds: (key: string) => boolean // CORE-owned ring predicate (mutates heldCache); dispatch only CALLS it
  data: any // the RAW root ViewProxy — readKey's held-local child + makeHandle's depth-1 nested-write path (re-enters the core sink)
  clientSubs: Set<() => void> // teardown callbacks drained by destroy — a remote-read subscription / fold close lands here
  invoke: (method: string, arg: unknown, peer?: string) => unknown // composer's in-process dispatcher (runs a handler with context)
  fold: Fold // the makeFold() engine: foldOnce / openFold / livePartial / foldAggregate
}

export const makeDispatch = ({ allMethods, defaults, context, mesh, me, scoped, R, viewSize, holds, data, clientSubs, invoke, fold }: DispatchDeps) => {
  const isClient = me === undefined

  // `read` is still the built-in (user didn't override it). A no-key read() on a scoped node must
  // GATHER the whole resource (no node holds it all) — but only when read is the default; a user's own
  // `read` projection is never silently swapped for the raw gather. `gathersWholeRead` names that
  // combined rule once, instead of spelling `scoped && allMethods.read === defaults.read` at each site.
  const usingDefaultRead = allMethods.read === defaults.read
  const gathersWholeRead = scoped && usingDefaultRead

  // The owner to forward a read to, or undefined to serve it locally (Q1): a scoped `read(key)` for a
  // partition we don't hold routes to its owner (which holds it → no re-forward). Full replication, a
  // held key, or our own ownership ⇒ undefined (serve locally). Shared by serveCall + serveSubscribe.
  const forwardTarget = (method: string, arg: unknown): string | undefined => {
    if (method !== 'read' || typeof arg !== 'string' || !scoped || holds(arg)) return undefined
    const owner = mesh.owner(arg)
    return owner !== undefined && owner !== me ? owner : undefined
  }

  // Read-forwarding (Q1): a `read(key)` for a partition we don't hold (a client
  // routed here, but we're not the owner) forwards to the owner, which holds it —
  // returning a Promise the transport awaits before replying. The owner holds the
  // key so it serves (no re-forward). Only in scoped mode; full replication holds all.
  // Strip the `fold` flag → the partial spec a fold fans out to holders (no recursion).
  const stripFold = (arg: any): AggSpec => ({ op: arg?.op, col: arg?.col, val: arg?.val })
  const serveCall = (method: string, arg: unknown, address: string): unknown => {
    const fwd = forwardTarget(method, arg)
    if (fwd !== undefined) return mesh.call('read', arg, fwd)
    // Whole-resource read() under scoping (Milestone Q3): a client called read() with NO key.
    // No single node holds the whole resource, so GATHER it — fold every holder's owner-scoped
    // rows into the union (the {op:'rows'} partial, fold stripped → no recursion) — and reply
    // with the global snapshot. This is the explicit "download everything" the user chains
    // holistic ops after. R≥members / full replication hold everything, so read() stays a local
    // c.data snapshot there (the hot path is byte-identical — the gather only arms when scoped).
    if (method === 'read' && arg == null && R < viewSize() && gathersWholeRead) return fold.foldOnce({ op: 'rows' }, AGG.rows.combine)
    // A CLIENT routed a distributed aggregate here (Milestone Q2e): a client can't
    // owner-scope or fold, so it sends {fold:true} and THIS server (a coordinator) returns
    // the GLOBAL via a one-shot gather. The gather fans out PARTIAL requests (fold stripped)
    // to holders, so there's no recursion. (A server's own facade aggregate uses
    // foldAggregate directly, never this path; a server-to-server fan-out has no fold flag
    // → the partial path below.)
    if (method === 'aggregate' && (arg as any)?.fold) {
      const s = stripFold(arg)
      return fold.foldOnce(s, AGG[s.op]?.combine) // a Promise; the CALL handler awaits it before replying
    }
    return snapshot(invoke(method, arg, address))
  }

  // Server side of a subscription: run the method here; if it returns a ViewProxy
  // (a projection — the default `read` returns the whole `data`, a custom one may
  // return `data.filter(...)`), connect a sink and stream every change (the
  // initial snapshot first, then deltas) to the subscriber. A plain value is shipped
  // once. The sink host is retained per (address, subId) so it keeps firing until
  // the client unsubscribes (data holds sinks only by WeakRef).
  // `src` retains the served SOURCE proxy alongside its sink host: data's FunctionSink
  // (core.ts) back-refs only `this.fn`, not its source, so a derived projection (a custom
  // read's `data.filter(...)`, or an `aggregate` partial) would GC its filter→op chain and
  // freeze the stream after a full GC on a long-running server — pinning only the host
  // isn't enough. (The default read returns the root `data`, retained anyway, so this only
  // bites derived views.) Held until the client unsubscribes.
  // One served subscription's retained handles: `host` (the sink pin), `src` (the source-proxy pin —
  // see note above), `unsub` (a forwarded upstream's close), `close` (a livePartial/openFold teardown).
  type ServedSub = { host?: object; src?: object; unsub?: () => void; close?: () => void }
  const subscriptions = new Map<string, ServedSub>()
  // Reverse index address → its open subIds, so an ungraceful disconnect (a socket drop, which never
  // delivers an UNSUBSCRIBE frame) can REAP that peer's served subscriptions instead of leaking them
  // (subscription-hygiene fix; before this a dropped client/coordinator leaked its sink hosts, Q1
  // read-forward upstreams, and — worst — Q3 gather / Q2 fold openFolds, each pinning an
  // aggregateReconciles entry re-run every commit + AE tick FOREVER). Keyed by the EXACT address (no
  // `host:port` string-splitting — `:` appears in the key). addSub keeps it in lockstep with `subscriptions`.
  const subsByPeer = new Map<string, Set<number>>()
  const addSub = (address: string, subId: number, entry: ServedSub) => {
    subscriptions.set(`${address}:${subId}`, entry)
    let ids = subsByPeer.get(address)
    if (!ids) subsByPeer.set(address, (ids = new Set()))
    ids.add(subId)
  }
  const serveSubscribe = (subId: number, method: string, arg: unknown, address: string) => {
    // Read-forwarding (Q1): subscribe a non-held read key FROM the owner and relay its
    // deltas to the subscriber; the upstream unsub is closed on unsubscribe.
    const fwd = forwardTarget(method, arg)
    if (fwd !== undefined) {
      const unsub = mesh.subscribe('read', arg, (record: ChangeRecord) => mesh.deltaTo(address, subId, record), fwd)
      if (unsub) addSub(address, subId, { unsub })
      return
    }
    // A CLIENT's reactive whole-resource read() under scoping (Milestone Q3): build the live
    // GATHER here (the union of every holder's owner-scoped rows, refolded on any shard delta)
    // and stream it to the client; the client runs its holistic ops over the gathered proxy
    // locally. Same openFold machinery as a distributed aggregate, with the union rule. Torn
    // down on unsubscribe.
    //   NOT gated on R<viewSize() (unlike the stateless serveCall one-shot) — this branch runs
    // ONCE at subscribe and is never re-evaluated, so gating on membership-at-subscribe would let a
    // read() opened while members≤R (server momentarily holds all) stream that server's LOCAL c.data
    // forever, then go SILENTLY PARTIAL once a join shards the resource and the server sheds keys
    // (the Q3a review's confirmed defect). The gather is correct at ANY R — owner-scoping is a
    // disjoint cover regardless of replica count — and openFold's reconcileMembers re-arms on each
    // commit, so an ungated gather is membership-robust. Mirrors the aggregate subscribe branch
    // (also ungated). Full replication never builds the facade / sends a scoped read, so R=∞ is
    // unaffected. (serveCall keeps the R<viewSize() optimization: it re-evaluates per call, so a
    // complete-local read at members≤R is always current.)
    if (method === 'read' && arg == null && gathersWholeRead) {
      const g = fold.openFold({ op: 'rows' }, AGG.rows.combine)
      const host = (g.proxy as any).connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change))
      addSub(address, subId, { host, src: g.proxy, close: g.close })
      return
    }
    // A CLIENT's reactive distributed aggregate (Milestone Q2e): build the FOLD here and
    // stream the global result to the client; the fold fans out partial requests (fold
    // stripped) so there's no recursion. Torn down on unsubscribe (close).
    if (method === 'aggregate' && (arg as any)?.fold) {
      try {
        const s = stripFold(arg)
        const f = fold.openFold(s, AGG[s.op]?.combine)
        const host = (f.proxy as any).connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change))
        addSub(address, subId, { host, src: f.proxy, close: f.close })
      } catch {
        // unknown op → no stream (RPC path surfaces errors)
      }
      return
    }
    // A served aggregate partial (Milestone Q2c) is a livePartial: it re-scopes itself on
    // THIS holder's own view commit (ownership moved → owner-scope changes) and pushes the
    // new value over this EXISTING subscription, so the coordinator never re-subscribes a
    // stable holder. Streamed as a root-update delta.
    if (method === 'aggregate') {
      try {
        const lp = fold.livePartial(arg as AggSpec, (v) => mesh.deltaTo(address, subId, { type: 'update', key: [], value: v }))
        addSub(address, subId, { close: lp.close })
      } catch {
        // an unknown op throws in buildPartial — yield no stream (RPC path surfaces errors)
      }
      return
    }
    let result: unknown
    try {
      result = invoke(method, arg, address)
    } catch {
      return // a failed subscription just yields no stream (RPC path surfaces errors)
    }
    if (isViewProxy(result)) {
      const host = (result as any).connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change))
      addSub(address, subId, { host, src: result as object }) // src retains the source chain (see map decl)
    } else {
      mesh.deltaTo(address, subId, { type: 'update', key: [], value: result })
    }
  }
  const serveUnsubscribe = (subId: number, address: string) => {
    const k = `${address}:${subId}`
    const sub = subscriptions.get(k)
    sub?.unsub?.() // forwarded subscription → close the upstream; local → just drop the host (sink GC'd)
    sub?.close?.() // a livePartial / openFold (served aggregate or gather) → deregister its rescope/reconcile + drop refs
    subscriptions.delete(k)
    const ids = subsByPeer.get(address)
    if (ids && ids.delete(subId) && ids.size === 0) subsByPeer.delete(address)
  }
  // A peer's connection dropped (socket close / destroy) without an UNSUBSCRIBE — reap every
  // subscription we served it (idempotent: routes each through serveUnsubscribe). Iterates a COPY,
  // since serveUnsubscribe mutates subsByPeer. No-op for a peer we never served (a dial failure, or a
  // server that only ever called/replicated). This is the chokepoint that stops the openFold leak.
  const reapPeer = (address: string) => {
    const ids = subsByPeer.get(address)
    if (!ids) return
    for (const subId of [...ids]) serveUnsubscribe(subId, address)
  }

  // The local method surface (server) calls handlers in-process. A read-only
  // client (no listen port) has no handlers — each method returns a HANDLE that
  // is both a thenable and a live ViewProxy: `await methods.x(arg)` is a one-shot
  // RPC (snapshot/ack), while reactive use (`methods.x(arg).tap(...)`, `.filter`,
  // `[value]`) opens a server-pushed live subscription. await-or-not picks the
  // mode (plan §1) — `then` is the only access that does NOT subscribe.
  const localMethods: Record<string, (arg?: any) => any> = {}
  for (const k of Object.keys(allMethods)) localMethods[k] = (arg?: any) => invoke(k, arg)
  context.methods = localMethods // method-to-method calls run locally

  // A remote-access HANDLE: a thenable (await ⇒ one-shot RPC) that is ALSO a live
  // ViewProxy (reactive use ⇒ a server-pushed subscription). `to()` picks the target
  // peer lazily — a specific owner (owner-routed reads) or undefined ⇒ a picked
  // connected server. `then` is the only access that does NOT subscribe.
  const makeHandle = (method: string, arg: unknown, to?: () => string | undefined, writeKey?: string) =>
    lazyHandle({
      then: (onF, onR) => mesh.call(method, arg, to?.()).then(onF, onR), // await ⇒ one-shot RPC
      open: () => {
        // any real data/operator access ⇒ subscribe + delegate to the live proxy
        const live = $({})
        const res = (live as any)[VIEWSYM].res
        const unsub = mesh.subscribe(method, arg, (record: ChangeRecord) => applyRecord(res, record), to?.())
        if (unsub) clientSubs.add(unsub)
        return live
      },
      // Nested write into a non-held partition (`data.x.y = v`): route to the RAW proxy so it
      // flows through the write-capture sink → owner. Only the READ handle passes a writeKey (a
      // method handle has none — set is then absent). Depth-1 only; deeper writes into a non-held
      // partition aren't routed (use a top-level `data.x = {…}` or the holding node) — documented.
      set: writeKey !== undefined ? (prop, v) => ((data as any)[writeKey][prop] = v) : undefined,
    })
  const clientHandle = (method: string, arg: unknown) => makeHandle(method, arg) // routed to a picked server

  // Owner-routed remote read (Q1): reading a partition this node doesn't hold returns
  // a handle that fetches (await) or subscribes from a HOLDER. A server is fully
  // meshed with the owner → route straight to owner(key); a client routes to a picked
  // server (which forwards to the owner — read-forwarding, a follow-up). `await
  // data.x` is one-shot; `data.x.tap(...)`/`.filter`/`[value]` opens a live remote view.
  const remoteRead = (key: string) => makeHandle('read', key, !isClient ? () => mesh.owner(key) : undefined, key)

  // The read surface: synchronous-and-local for a partition we hold, a remote handle
  // for one we don't (hold-relative reads). The `data` facade returned below is sugar
  // over this. Internal machinery keeps using the raw `data` (held partitions only).
  const readKey = (key: string) => (holds(key) ? data[key] : remoteRead(key))

  // Server-side whole-resource read() gather (Milestone Q3b). A scoped SERVER holds only its
  // R-set, so its own no-key `methods.read()` would otherwise return a LOCAL partial — wrong for
  // the holistic ops (`methods.read().az('v')`, `.distinct()`, `.reduce(...)`) the user runs AFTER
  // read. Replace the DEFAULT no-key read with the gather HANDLE (foldAggregate over {op:'rows'}):
  // `await methods.read()` is a one-shot gather, reactive use opens the live gather and the holistic
  // op runs over the merged whole-resource proxy locally.
  //   • Only when read is the DEFAULT (allMethods.read === defaults.read): a user-supplied `read` is
  //     THEIR projection — never silently swap it for the raw gather (which would diverge from the
  //     full-rep path, where the custom read runs over complete state). [Q3b review M1]
  //   • MEMOIZED to ONE handle per node: the spec is the constant {op:'rows'}, so a single
  //     foldAggregate (one live openFold, membership-robust via reconcile) backs every call. A fresh
  //     handle per reactive call would leak an O(resource) union-fold into aggregateReconciles —
  //     re-run every commit + AE tick — forever. [Q3b review M3]
  //   • Keyed `methods.read(key)` is LOCAL (this node's held child view, via baseRead). Owner-routing
  //     for a non-held key is the `data` facade (`data[key]` → remoteRead) or an inbound client RPC
  //     (serveCall read-forwarding) — NOT this surface. [Q3b review m4]
  //   • In-handler `context.methods.read()` is this same gather handle (context.methods IS
  //     localMethods): `await` ⇒ global, reactive ⇒ live, sync `[value]` ⇒ the in-progress union;
  //     a handler wanting the LOCAL held state reads `c.data` directly. [Q3b review m5; DECISIONS Q3]
  // Ungated on R (membership-robust — openFold re-arms on commit). Full replication (scoped=false)
  // keeps the raw-c.data read — that node holds everything, so local IS global.
  if (!isClient && gathersWholeRead) {
    const baseRead = localMethods.read
    let gather: any
    localMethods.read = (arg?: any) => (arg == null ? (gather ??= fold.foldAggregate({ op: 'rows' })) : baseRead(arg))
  }

  const methodSurface: Record<string, (arg?: any) => any> = isClient
    ? (new Proxy({}, { get: (_t, name: string) => (arg?: any) => clientHandle(name, arg) }) as any)
    : localMethods

  // The `data` facade (Q1): top-level KEY access is hold-relative — the local child
  // view if we hold the partition, a remote handle (await/subscribe to a holder) if
  // not. Operators (`.filter`, `.group`, …), the built-ins, symbols (`[value]`,
  // iterator), and writes pass straight through to the underlying proxy, so the full
  // data surface is preserved and operators run over the LOCAL (held) partitions. We
  // distinguish a partition key from an operator/built-in via the data lib's
  // `Operators` table. Only built when this node can have non-held keys (a scoped
  // server, or any client); a full-replication server returns the raw proxy — a
  // transparent no-op — so its hot read path is unchanged.
  // Built-ins that pass straight through to the raw proxy (the data-lib apply-trap
  // ops that are NOT in the Operators table): the reactive built-ins, the terminal
  // write ops (update/insert/remove), and JS internals. Without update/insert/remove
  // here, `data.update(...)` would be misread as a partition key named "update".
  const BUILTIN = new Set(['connect', 'raf', 'patch', 'first', 'last', 'then', 'toJSON', 'constructor', 'update', 'insert', 'remove'])
  // own-key check (NOT `prop in Operators`): Operators is a plain object literal, so
  // `in` walks Object.prototype and would wrongly classify partition keys named
  // toString/valueOf/hasOwnProperty/… as operators (returning a stale local child
  // instead of a remote handle). hasOwnProperty.call matches only registered operators.
  const isOperator = (prop: string) => Object.prototype.hasOwnProperty.call(Operators, prop)
  // Decomposable aggregate terminals (Q2): on a scoped SERVER, `data.sum('v')` over the
  // WHOLE resource is a fan-out + fold, not a local operator (which would see only this
  // node's held partitions = a partial). count is `length()` with no arg; `length(fn)`
  // (bucketed) and top/limit-K are holistic-shaped → Q3 (the loud guard lands in Q2f).
  // A client cannot owner-scope or fold (no me/view) → its aggregates route to a server
  // (server-as-coordinator, Q2f); until then the facade leaves them to the raw operator.
  const DECOMPOSABLE = new Set(['sum', 'max', 'min', 'avg', 'some', 'every', 'length'])
  const distributable = scoped || isClient // the facade only exists for scoped||isClient; intercept aggregates in both
  // Build a SERIALIZABLE aggregate spec from a facade call, or null if it can't be
  // distributed (a closure predicate, or length(fn) bucketed — both deferred). count is
  // length() with no arg.
  const specOf = (op: string, args: unknown[]): AggSpec | null => {
    if (op === 'length') return args[0] !== undefined ? null : { op: 'count' } // length(fn) bucketed → Q3
    if (typeof args[0] === 'function') return null // a closure can't cross the wire
    if (op === 'some' || op === 'every') return { op, col: args[0], val: args[1] }
    return { op, col: args[0] }
  }
  const distributed = (op: string) => (...args: unknown[]) => {
    const spec = specOf(op, args)
    if (spec === null) {
      // Not distributable (a closure predicate, or length(fn) bucketed → Q3). Warn LOUDLY
      // and fall back to the LOCAL operator (held partitions only on a server; empty on a
      // client) rather than silently returning a local partial as if it were the global.
      console.warn(`fero: data.${op}(${typeof args[0] === 'function' ? 'fn' : '…'}) can't be distributed — ${typeof args[0] === 'function' ? 'a closure can\'t cross the wire' : 'bucketed length(fn) is deferred (Q3)'}. Returning a LOCAL result only. Use a declarative argument (a column${op === 'some' || op === 'every' ? '[, value]' : ''}) or a named aggregator method.`)
      return (data as any)[op](...args)
    }
    // A CLIENT (no me/view) can't owner-scope or fold — route the aggregate to a server,
    // which builds the fold and streams the GLOBAL back (server-as-coordinator, Q2e). The
    // `fold:true` flag tells the server to fold rather than return its own partial.
    if (isClient) return clientHandle('aggregate', { ...spec, fold: true })
    // R≥members ⇒ this node holds the whole resource → run the aggregate LOCALLY over
    // complete state (re-checked per access as membership grows). Matches "all data local
    // ⇒ run locally unchanged". EXCEPT some/every: their DECLARATIVE (col) form has no raw
    // data-lib equivalent (data's some/every require a PREDICATE FN — `data.some('active')`
    // would throw "fn is not a function"), so they always go through the fold, which
    // reconstructs the predicate from (col,val) in buildPartial. The fold is correct for
    // any R (owner-scoping is a disjoint cover regardless of how many nodes hold each
    // partition); at R≥members it just fans out to members that each happen to hold all.
    //   NOTE — under FULL replication (R=∞, the default) the facade is NOT built (the raw
    //   proxy is returned, to keep that hot path byte-identical), so this code never runs
    //   there: `data.sum/max/min/avg('col')` / `data.length()` work (data accepts a column),
    //   but `data.some/every('col')` falls through to data's raw some/every and throws — use
    //   the NATIVE predicate form `data.some(s => s.active)` under full replication (you hold
    //   all the data, so the local some/every IS the global). The declarative col form is the
    //   scoped-distributed sugar. Not a Q2 regression (data's some/every always needed a fn);
    //   making the col form uniform needs a data-lib some(col)/every(col) overload — IDEAS.
    if (R >= viewSize() && op !== 'some' && op !== 'every') return (data as any)[op](...args)
    return fold.foldAggregate(spec)
  }
  // Q3 boundary guard. These operators are HOLISTIC or ordered — the global answer needs the
  // full multiset co-located — so they CAN'T fold from per-shard partials. The Q3 path is to
  // GATHER first: `methods.read()` (no key) downloads the whole resource (Q3a/Q3b), and the
  // holistic op runs over THAT — `methods.read().az('v')`, `.distinct()`, `.reduce(...)` — or you
  // derive it as its own named resource. Calling the op DIRECTLY on `data` (no read) runs over
  // only this node's held partitions and would SILENTLY look like a global answer, so we return
  // that local result but WARN LOUDLY (once per op). top/limit-K specifically: data's sort emits
  // positional BMV1 'move' deltas applyRecord ignores ([DECISIONS E]); a grouped aggregate
  // (group(c).sum(v)) needs the L3 chain planner — both still deferred. A full-replication node
  // never builds the facade, so this never fires there (local IS global).
  const HOLISTIC = new Set(['az', 'za', 'top', 'limit', 'group', 'distinct', 'reduce']) // registered chainable operators (sort family = az/za/top/limit)
  const holisticWarned = new Set<string>()
  const holisticGuard = (op: string) => (...args: unknown[]) => {
    if (!isClient && R >= viewSize()) return (data as any)[op](...args) // holds everything → local is global
    if (!holisticWarned.has(op)) {
      holisticWarned.add(op)
      console.warn(`fero: data.${op}(...) is HOLISTIC over the WHOLE resource and can't fold from per-shard partials — returning a LOCAL result (held partitions only). Run it AFTER methods.read() (which gathers the whole resource) — e.g. methods.read().${op}(...) — or derive it as its own named resource. (group(...).sum(...) needs the L3 chain planner; decomposable aggregates — sum/count/max/min/avg/some/every — distribute via the facade with no read.)`)
    }
    return (data as any)[op](...args)
  }
  const dataFacade =
    scoped || isClient
      ? new Proxy(data, {
          // CLASSIFICATION LADDER — branch order is load-bearing: symbols/built-ins first, then
          // decomposable aggregate, then the holistic guard, then operators, and ONLY a non-operator
          // key falls through to readKey (the hold-relative local-child | remote-handle split).
          // Reordering misclassifies keys (e.g. a partition named like an aggregate).
          get(t, prop) {
            if (typeof prop === 'symbol' || BUILTIN.has(prop as string)) return (t as any)[prop]
            if (distributable && DECOMPOSABLE.has(prop as string)) return distributed(prop as string)
            if (distributable && HOLISTIC.has(prop as string)) return holisticGuard(prop as string) // Q3 boundary: loud, never silent
            if (isOperator(prop as string)) return (t as any)[prop]
            return readKey(prop as string)
          },
          set(t, prop, v) {
            ;(t as any)[prop] = v
            return true
          },
          deleteProperty(t, prop) {
            delete (t as any)[prop]
            return true
          },
        })
      : data

  return {
    serveCall,
    serveSubscribe,
    serveUnsubscribe,
    reapPeer,
    localMethods,
    methodSurface,
    dataFacade,
    servedCount: () => subscriptions.size, // the diagnostics seam's live-subscription count
  }
}

export type Dispatch = ReturnType<typeof makeDispatch>
