// L2 method-dispatch + read/subscription surface: makeDispatch() wires inbound RPC/sub servers, method surfaces, lazy remote-read handles, and the `data` facade.

import { $, view as VIEWSYM, Operators } from '../../data/index.ts'
import { applyRecord } from '../log/index.ts'
import { type ChangeRecord } from '../transport/message.ts'
import { type Mesh } from '../transport/index.ts'
import { AGG, type Fold, type AggSpec } from './fold.ts'
import { lazyHandle, isViewProxy, forWire } from './handle.ts'
import type { Method, Context } from './index.ts'

// The shared node state + injected `invoke`/`fold` engines makeDispatch closes over by reference.
export type DispatchDeps = {
  allMethods: Record<string, Method>
  defaults: Record<string, Method>
  context: Context
  mesh: Mesh
  me: string | undefined
  scoped: boolean
  R: number
  viewSize: () => number
  holds: (key: string) => boolean
  data: any
  clientSubs: Set<() => void>
  invoke: (method: string, arg: unknown, peer?: string) => unknown
  fold: Fold
  onObserve?: () => { proxy: any; close: () => void }
}

// Build the per-node dispatch surface; `me === undefined` marks a read-only client (no handlers, no listen port).
export const makeDispatch = ({ allMethods, defaults, context, mesh, me, scoped, R, viewSize, holds, data, clientSubs, invoke, fold, onObserve }: DispatchDeps) => {
  const isClient = me === undefined

  // `gathersWholeRead` = scoped && default-read: a no-key read() must gather the whole resource (never swap a user's projection).
  const usingDefaultRead = allMethods.read === defaults.read
  const gathersWholeRead = scoped && usingDefaultRead

  // The owner to forward a scoped read(key) to, or undefined to serve it locally (held / full-rep / we own it).
  const forwardTarget = (method: string, arg: unknown): string | undefined => {
    if (method !== 'read' || typeof arg !== 'string' || !scoped || holds(arg)) return undefined
    const owner = mesh.owner(arg)
    return owner !== undefined && owner !== me ? owner : undefined
  }

  // Drop the `fold` flag → the partial spec a fold fans out to holders (prevents recursion).
  const stripFold = (arg: any): AggSpec => ({ op: arg?.op, col: arg?.col, val: arg?.val })
  // Inbound RPC: read-forward to owner, else gather whole-read (Q3) / fold a client aggregate (Q2e), else invoke locally.
  const serveCall = (method: string, arg: unknown, address: string): unknown => {
    const fwd = forwardTarget(method, arg)
    if (fwd !== undefined) return mesh.call('read', arg, fwd)
    // No-key read() under scoping → one-shot gather of every holder's owner-scoped rows (full-rep stays a local snapshot).
    if (method === 'read' && arg == null && R < viewSize() && gathersWholeRead) return fold.gatherOnce({ op: 'rows' }, AGG.rows.combine)
    // Client-routed aggregate with {fold:true} → this server coordinates a one-shot gather of holder partials.
    if (method === 'aggregate' && (arg as any)?.fold) {
      const s = stripFold(arg)
      return fold.gatherOnce(s, AGG[s.op]?.combine)
    }
    return forWire(invoke(method, arg, address))
  }

  // One served subscription's retained handles: host (sink pin), src (source-proxy pin), unsub (upstream close), close (fold/gather teardown).
  // Plus `to`/`meta`: the L4 subscription-topology tags (downstream addr + method/key/kind/owner) — set ONCE at subscribe, never on the per-delta send path.
  type SubMeta = { method: string; key?: string; kind: string; owner?: string }
  type ServedSub = { host?: object; src?: object; unsub?: () => void; close?: () => void; to?: string; meta?: SubMeta }
  const subscriptions = new Map<string, ServedSub>()
  // Reverse index address → its open subIds so an ungraceful disconnect can reap served subs instead of leaking them.
  const subsByPeer = new Map<string, Set<number>>()
  const addSub = (address: string, subId: number, entry: ServedSub) => {
    entry.to = address
    subscriptions.set(`${address}:${subId}`, entry)
    let ids = subsByPeer.get(address)
    if (!ids) subsByPeer.set(address, (ids = new Set()))
    ids.add(subId)
  }
  // Stream a live ViewProxy to a subscriber: connect a delta sink and retain host + src + optional close under (address, subId).
  const streamProxy = (address: string, subId: number, proxy: any, close?: () => void, meta?: SubMeta) => {
    const host = proxy.connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change))
    addSub(address, subId, { host, src: proxy, close, meta })
  }
  // Inbound subscribe: read-forward / live whole-read gather / live client aggregate fold / served partial / projection stream.
  const serveSubscribe = (subId: number, method: string, arg: unknown, address: string) => {
    // Read-forward a non-held read key: subscribe FROM the owner and relay its deltas (upstream closed on unsubscribe).
    const fwd = forwardTarget(method, arg)
    if (fwd !== undefined) {
      const unsub = mesh.subscribe('read', arg, (record: ChangeRecord) => mesh.deltaTo(address, subId, record), fwd)
      if (unsub) addSub(address, subId, { unsub, meta: { method: 'read', key: arg as string, kind: 'forward', owner: fwd } })
      return
    }
    // Reactive no-key read() under scoping → live gather streamed to the client; ungated on R (re-arms per commit, never goes silently partial).
    if (method === 'read' && arg == null && gathersWholeRead) {
      const g = fold.gatherLive({ op: 'rows' }, AGG.rows.combine)
      streamProxy(address, subId, g.proxy, g.close, { method: 'read', kind: 'gather' })
      return
    }
    // Reactive client aggregate {fold:true} → build the fold here and stream the live global result (torn down on unsubscribe).
    if (method === 'aggregate' && (arg as any)?.fold) {
      try {
        const s = stripFold(arg)
        const f = fold.gatherLive(s, AGG[s.op]?.combine)
        streamProxy(address, subId, f.proxy, f.close, { method: 'aggregate', key: s.op, kind: 'fold' })
      } catch {
      }
      return
    }
    // Served aggregate partial → a livePartial that re-scopes on this holder's own view commit and pushes over the existing sub (no re-subscribe).
    if (method === 'aggregate') {
      try {
        const lp = fold.livePartial(arg as AggSpec, (v) => mesh.deltaTo(address, subId, { type: 'update', key: [], value: v }))
        addSub(address, subId, { close: lp.close, meta: { method: 'aggregate', key: (arg as AggSpec)?.op, kind: 'partial' } })
      } catch {
      }
      return
    }
    // L4 observe push-hook (subscription-only): stream this node's bounded provenance/contention buffer; attach on subscribe, disarm via the close on reap.
    if (method === '__observe' && onObserve) {
      const o = onObserve()
      streamProxy(address, subId, o.proxy, o.close, { method: '__observe', kind: 'observe' })
      return
    }
    // Default path: invoke the method — stream it if it returns a ViewProxy, else ship the plain value once.
    let result: unknown
    try {
      result = invoke(method, arg, address)
    } catch {
      return
    }
    if (isViewProxy(result)) {
      streamProxy(address, subId, result, undefined, { method, key: typeof arg === 'string' ? arg : undefined, kind: 'projection' })
    } else {
      mesh.deltaTo(address, subId, { type: 'update', key: [], value: result })
    }
  }
  // Tear down one served sub: close upstream/fold, drop the host, and unwind the subsByPeer reverse index.
  const serveUnsubscribe = (subId: number, address: string) => {
    const k = `${address}:${subId}`
    const sub = subscriptions.get(k)
    sub?.unsub?.()
    sub?.close?.()
    subscriptions.delete(k)
    const ids = subsByPeer.get(address)
    if (ids && ids.delete(subId) && ids.size === 0) subsByPeer.delete(address)
  }
  // A peer dropped without UNSUBSCRIBE → reap every sub we served it; the chokepoint that stops the gatherLive leak.
  const reapPeer = (address: string) => {
    const ids = subsByPeer.get(address)
    if (!ids) return
    for (const subId of [...ids]) serveUnsubscribe(subId, address)
  }

  // Local method surface: a server invokes handlers in-process; context.methods points here so method-to-method calls run locally.
  const localMethods: Record<string, (arg?: any) => any> = {}
  for (const k of Object.keys(allMethods)) localMethods[k] = (arg?: any) => invoke(k, arg)
  context.methods = localMethods

  // A remote-access HANDLE: thenable (await ⇒ one-shot RPC) AND live ViewProxy (reactive ⇒ server-pushed subscription); to() picks the target.
  const makeHandle = (method: string, arg: unknown, to?: () => string | undefined, writeKey?: string) =>
    lazyHandle({
      then: (onF, onR) => mesh.call(method, arg, to?.()).then(onF, onR),
      open: () => {
        const live = $({})
        const res = (live as any)[VIEWSYM].res
        const unsub = mesh.subscribe(method, arg, (record: ChangeRecord) => applyRecord(res, record), to?.())
        if (unsub) clientSubs.add(unsub)
        return live
      },
      // Depth-1 nested write into a non-held partition → route through the raw proxy's write-capture sink to the owner (read handle only).
      set: writeKey !== undefined ? (prop, v) => ((data as any)[writeKey][prop] = v) : undefined,
    })
  const clientHandle = (method: string, arg: unknown) => makeHandle(method, arg)

  // Owner-routed remote read (Q1): a non-held partition returns a handle that fetches/subscribes from a holder (server → owner, client → picked server).
  const remoteRead = (key: string) => makeHandle('read', key, !isClient ? () => mesh.owner(key) : undefined, key)

  // Hold-relative read: a synchronous local child for a held partition, a remote handle for one we don't hold.
  const readKey = (key: string) => (holds(key) ? data[key] : remoteRead(key))

  // Swap a scoped server's default no-key read() for a memoized gather handle so holistic ops run over the whole resource, not a local partial.
  if (!isClient && gathersWholeRead) {
    const baseRead = localMethods.read
    let gather: any
    localMethods.read = (arg?: any) => (arg == null ? (gather ??= fold.foldAggregate({ op: 'rows' })) : baseRead(arg))
  }

  // The public `methods` surface: a client returns a remote handle per name; a server exposes localMethods.
  const methodSurface: Record<string, (arg?: any) => any> = isClient
    ? (new Proxy({}, { get: (_t, name: string) => (arg?: any) => clientHandle(name, arg) }) as any)
    : localMethods

  // `data` facade machinery (Q1): classify a top-level get into a held child, remote handle, distributed aggregate, or holistic guard.
  // Built-ins that pass straight through to the raw proxy (incl. update/insert/remove, else they'd read as partition keys).
  const BUILTIN = new Set(['connect', 'raf', 'patch', 'first', 'last', 'then', 'toJSON', 'constructor', 'update', 'insert', 'remove'])
  // Operator check via hasOwnProperty (NOT `in`): `in` walks Object.prototype and would misclassify keys like toString/valueOf.
  const isOperator = (prop: string) => Object.prototype.hasOwnProperty.call(Operators, prop)
  // Decomposable aggregate terminals (Q2): over the whole resource these are a fan-out + fold, not a local-partial operator.
  const DECOMPOSABLE = new Set(['sum', 'max', 'min', 'avg', 'some', 'every', 'length'])
  const distributable = scoped || isClient // the facade only exists for scoped||isClient; intercept aggregates in both
  // Build a serializable aggregate spec from a facade call, or null if it can't cross the wire (closure / bucketed length(fn)).
  const specOf = (op: string, args: unknown[]): AggSpec | null => {
    if (op === 'length') return args[0] !== undefined ? null : { op: 'count' }
    if (typeof args[0] === 'function') return null
    if (op === 'some' || op === 'every') return { op, col: args[0], val: args[1] }
    return { op, col: args[0] }
  }
  // distributed(op): non-serializable warns + runs local; client routes to a coordinator; else run local (R≥members) or fold.
  const distributed = (op: string) => (...args: unknown[]) => {
    const spec = specOf(op, args)
    if (spec === null) {
      console.warn(`fero: data.${op}(${typeof args[0] === 'function' ? 'fn' : '…'}) can't be distributed — ${typeof args[0] === 'function' ? 'a closure can\'t cross the wire' : 'bucketed length(fn) is deferred (Q3)'}. Returning a LOCAL result only. Use a declarative argument (a column${op === 'some' || op === 'every' ? '[, value]' : ''}) or a named aggregator method.`)
      return (data as any)[op](...args)
    }
    if (isClient) return clientHandle('aggregate', { ...spec, fold: true })
    const canRunLocal = R >= viewSize() && op !== 'some' && op !== 'every'
    if (canRunLocal) return (data as any)[op](...args)
    return fold.foldAggregate(spec)
  }
  // Q3 boundary guard: holistic/ordered ops can't fold from partials — run local but WARN LOUDLY (once per op) to gather via read() first.
  const HOLISTIC = new Set(['az', 'za', 'top', 'limit', 'group', 'distinct', 'reduce'])
  const holisticWarned = new Set<string>()
  const holisticGuard = (op: string) => (...args: unknown[]) => {
    if (!isClient && R >= viewSize()) return (data as any)[op](...args)
    if (!holisticWarned.has(op)) {
      holisticWarned.add(op)
      console.warn(`fero: data.${op}(...) is HOLISTIC over the WHOLE resource and can't fold from per-shard partials — returning a LOCAL result (held partitions only). Run it AFTER methods.read() (which gathers the whole resource) — e.g. methods.read().${op}(...) — or derive it as its own named resource. (group(...).sum(...) needs the L3 chain planner; decomposable aggregates — sum/count/max/min/avg/some/every — distribute via the facade with no read.)`)
    }
    return (data as any)[op](...args)
  }
  // The returned `data` facade: a classifying Proxy for scoped/client, else the raw proxy (full-rep hot path unchanged).
  const dataFacade =
    scoped || isClient
      ? new Proxy(data, {
          // CLASSIFICATION LADDER — branch order is load-bearing: symbols/built-ins → aggregate → holistic → operator → readKey.
          get(t, prop) {
            if (typeof prop === 'symbol' || BUILTIN.has(prop as string)) return (t as any)[prop]
            if (distributable && DECOMPOSABLE.has(prop as string)) return distributed(prop as string)
            if (distributable && HOLISTIC.has(prop as string)) return holisticGuard(prop as string)
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

  // servedSubs: a bounded snapshot of the live subscription topology — {to, method, key?, kind, owner?} per sub.
  const SUBS_CAP = 100
  const servedSubs = (): { to: string; method: string; key?: string; kind: string; owner?: string }[] => {
    const out: { to: string; method: string; key?: string; kind: string; owner?: string }[] = []
    for (const s of subscriptions.values()) {
      if (!s.meta || s.to === undefined) continue
      out.push({ to: s.to, method: s.meta.method, key: s.meta.key, kind: s.meta.kind, owner: s.meta.owner })
      if (out.length >= SUBS_CAP) break
    }
    return out
  }

  return {
    serveCall,
    serveSubscribe,
    serveUnsubscribe,
    reapPeer,
    localMethods,
    methodSurface,
    dataFacade,
    servedCount: () => subscriptions.size,
    servedSubs,
  }
}

export type Dispatch = ReturnType<typeof makeDispatch>
