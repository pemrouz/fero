//! ── api/methods — the method plane's HOST and CALLER (M5c) ───────────────────
// The kernel routes CALL/SUB/UNSUB/RESULT/SUBREC frames (kernel purity: a user
// handler is arbitrary async code and can never run inside step()); this module
// is both ends of the conversation:
//
//   HOST   — runs on every server: dispatches invokes to user methods, streams
//            live subscriptions, and enforces flush-on-return (a handler's
//            return awaits the commit of every write IT issued — plan §9,
//            BUILT: AsyncLocalStorage attributes writes to the invocation that
//            made them, across awaits, without a wrapper data facade).
//   CALLER — runs on every client: mints rpc ids, settles call promises off
//            RESULT frames, folds SUBREC streams into local $() proxies, and
//            owns the failover policies (v2's OQ2 hole, closed): on a primary
//            change, live subscriptions RE-SUBSCRIBE to the new feeder (a fresh
//            initial snapshot root-replaces the local proxy — views re-render),
//            retry-tagged calls re-dispatch, everything else fails fast with a
//            typed reason instead of waiting out its timeout.
//
// Consumption mode stays return-type dispatch (plan §9): the HOST probes the
// handler's return with isProxy (a ViewProxy is subscribable; a value is a
// value), and the CALLER's Handle picks the mode by how it is touched — await
// (`then`) is a one-shot CALL; any reactive touch opens the live subscription.
// RE-EXECUTION WARNING, stated: a retried CALL runs the handler AGAIN — method
// invocations are not cid-deduped (only the writes they issue are), so retry
// is per-call opt-in and belongs on idempotent methods only.
//
// Subscription streams ride data's RECORD interface (substrate.records): values
// cloned by the substrate, an initial whole-value snapshot on attach for free,
// and data-native string types on the wire (the SUBREC body is an opaque value
// to the kernel). 'move' records (bounded-sort rotations) are SKIPPED with this
// documented consequence: subscribe to the source and sort on the CLIENT proxy
// (operators work there) — a server-side windowed sort is not a streamable
// shape in M5c.

import { AsyncLocalStorage } from 'node:async_hooks'
import { VERB } from '../kernel/codec.ts'
import type { Rec } from '../kernel/env.ts'
import type { Runtime } from '../shell/runtime.ts'
import { applyStreamRec, isProxy, proxy, records, snapshot } from './substrate.ts'
import type { Coords, Refused } from './data.ts'
import type { ScopedError } from './types.ts'

//! settle — flush-on-return's wait (V4-5): every tracked write reaches an outcome; a write the validator
// REFUSED (api/data.ts Refused) fails the handler with the reason — a reply that claims an effect that
// never happened is §9's banned silent partial, and under `methods:` the handler is the client's only
// door. The kernel's own string outcomes ('superseded' | 'dropped' | 'destroyed') stay swallowed here,
// as before — whether they should fail the call too is a separate decision (retry semantics).
const settle = async (tracked: Promise<Coords>[]): Promise<void> => {
  for (const r of await Promise.allSettled(tracked))
    if (r.status === 'rejected' && (r.reason as Refused | null)?.refused === true)
      throw new Error(`write refused (${(r.reason as Refused).key}): ${(r.reason as Refused).reason}`)
}

//! SYSTEM — the reserved method-name prefix (unreachable from fero() opts: the composer rejects it):
// internal RPCs (confirm-over-the-wire) share the method plane without stealing any user name.
export const SYSTEM = '\u0000'

//! Context — the second argument every handler receives. `data` is the server's own resource surface
// (writes route through the ONE ingest: validation + overlay + owner routing all apply); `flush()`
// awaits everything this handler has written SO FAR at 'committed' (the mid-body barrier — the
// implicit one runs at return).
export interface Context {
  data: any
  flush(): Promise<void>
  //! live (M6): true when this invocation opens a SUBSCRIPTION — a dual-mode handler (the scoped
  // default read) returns the live gather proxy on the SUB leg and the one-shot value on CALL.
  live?: boolean
  //! peer (V4-3): the invoking link's uuid — the caller's identity as admitted at HELLO; undefined for a
  // local invoke (host.invokeLocal). The directory host keys registrations by it (api/directory.ts).
  peer?: string
}

type Handler = (arg: unknown, ctx: Context) => unknown

export class Host {
  #rt: Runtime
  #data: any
  #methods: Record<string, Handler>
  #system: Record<string, Handler>
  #als = new AsyncLocalStorage<Promise<Coords>[]>()
  //! live subscriptions by `link|id` — reaped on UNSUB and on link death (the composer's fold calls
  // reapLink off JK.linkDown; v2's serve-side leak guard, kept)
  #subs = new Map<string, { stop(): void; cancelled: boolean; live: unknown }>()
  //! served (M7 [diagnostics]): the leak-guard scalar — live subscriptions this host currently serves
  get served(): number { return this.#subs.size }

  constructor(rt: Runtime, data: any, methods: Record<string, Handler>, system: Record<string, Handler>) {
    this.#rt = rt
    this.#data = data
    this.#methods = methods
    this.#system = system
    rt.onInvoke = (link, id, mode, m, a) => this.#invoke(link, id, mode, m, a)
  }

  //! tracked — Bind's flush-on-return seam: whatever invocation context is live gets the coordinate
  // promises of every write made inside it (survives awaits — that is the point of ALS).
  tracked = (): Promise<Coords>[] | undefined => this.#als.getStore()

  #invoke(link: number, id: number, mode: number, m: string, a: unknown) {
    const skey = link + '|' + id
    if (mode === VERB.UNSUB) {
      //! UNSUB may arrive DURING the handler/flush, before the stream opens (M5-review #6): the entry
      // already exists (registered up front below), so mark it cancelled + stop whatever it holds. Once
      // cancelled, the deferred open below sees it and never streams.
      const sub = this.#subs.get(skey)
      if (sub) { sub.cancelled = true; sub.stop(); this.#subs.delete(skey) }
      return
    }
    const fn = m.startsWith(SYSTEM) ? this.#system[m.slice(1)] : this.#methods[m]
    if (!fn) return this.#reply(link, id, false, `unknown method '${m.startsWith(SYSTEM) ? m.slice(1) : m}'`)
    //! a SUB registers its entry BEFORE running the handler (M5-review #2/#6): reapLink (link death) and
    // UNSUB run synchronously off kernel steps and would otherwise miss a sub whose #subs.set sits after
    // the flush-on-return await, permanently leaking the stream. The placeholder holds a no-op stop and
    // a cancelled flag; the deferred open replaces stop and checks cancelled.
    const entry = mode === VERB.SUB ? { stop: () => {}, cancelled: false, live: undefined as unknown } : null
    if (entry) this.#subs.set(skey, entry)
    //! each invocation gets its own write collector; the handler runs OUTSIDE the kernel step (async),
    // and its return implicitly flushes — the reply provably follows its own commits
    const tracked: Promise<Coords>[] = []
    const ctx: Context = {
      data: this.#data,
      flush: () => settle(tracked.splice(0)),
      live: mode === VERB.SUB,
      ...(this.#rt.node.links.get(link)?.uuid ? { peer: this.#rt.node.links.get(link)!.uuid } : {}),
    }
    void (async () => {
      let result: unknown
      try {
        //! NEVER blind-await the handler result: a ViewProxy is THENABLE (data's await-for-snapshot
        // feature), so `await proxy` would collapse the live view to a value before isProxy could see
        // it — the exact bug class that silently degrades a subscription to one frozen frame. Probe
        // first; await only genuine promises. Consequence, stated: an ASYNC handler returning a proxy
        // still collapses (promise adoption unwraps thenables — structural to JS) — return live views
        // from SYNC handlers (`read: (a, ctx) => ctx.data`), compute asynchronously via ctx before.
        result = this.#als.run(tracked, () => fn(a, ctx))
        if (!isProxy(result) && result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function')
          result = await result
        await settle(tracked) // flush-on-return — a refused write fails the call (V4-5)
      } catch (err) {
        if (entry && this.#subs.get(skey) === entry) this.#subs.delete(skey)
        //! M6: a thrown ScopedError ships AS the error value (rehydrated typed at the caller);
        // everything else keeps the message-string reply
        if (typeof err === 'object' && err !== null && (err as { scoped?: boolean }).scoped === true)
          return this.#reply(link, id, false, err)
        return this.#reply(link, id, false, err instanceof Error ? err.message : String(err))
      }
      if (mode === VERB.CALL) {
        //! a returned ViewProxy collapses to its snapshot for a one-shot call (v2's forWire, kept;
        // no clone — the reply's codec copies the value into frame bytes synchronously inside step)
        return this.#reply(link, id, true, isProxy(result) ? snapshot(result) : result)
      }
      //! the sub may have been UNSUBbed or its link reaped during the handler/flush — the entry is gone
      // or cancelled; do not open a stream nobody is listening to (M5-review #2/#6)
      if (!entry || entry.cancelled || this.#subs.get(skey) !== entry) return
      //! SUB: a proxy streams (initial snapshot rides the record interface's attach emit); a plain
      // value degrades to a single-shot stream (one root update) — same consumption shape either way
      if (!isProxy(result)) {
        this.#rt.node.step({ kind: 'subOut', link, id, recs: [{ type: 'update', key: [], value: result } as unknown as Rec] })
        this.#subs.delete(skey) // a value SUB has no live stream to hold; drop the placeholder
        return
      }
      //! retain the LIVE proxy on the entry (M5-review #11): records() pins only the leaf FunctionSink
      // via its anchor, NOT the operator chain feeding it — a derived return (ctx.data.filter(...)) is
      // held only by `result`, so without this strong ref the chain is GC'd and the stream goes silent.
      entry.live = result
      const stream = records(result, (rec) => {
        if (rec.type === 'move') return // documented M5c limitation (banner): sort client-side instead
        this.#rt.node.step({ kind: 'subOut', link, id, recs: [rec as unknown as Rec] })
      })
      entry.stop = () => stream.stop()
    })()
  }

  #reply(link: number, id: number, ok: boolean, value: unknown) {
    this.#rt.node.step({ kind: 'reply', link, id, ok, value })
  }

  //! invokeLocal — a SERVER-side one-shot call (no wire): the SAME flush-on-return + non-blind-await +
  // proxy-collapse discipline as a remote CALL (M5-review #5: the old server-local path used a no-op
  // flush and no ALS, so a handler's writes were NOT awaited before the value returned — local and wire
  // invocation of the same handler gave opposite durability). A returned ViewProxy is CLONED to its
  // snapshot (M5-review #10: returning the live proxy value handed the caller a mutable alias of
  // committed kernel state; the wire path serializes to a fresh copy, so local must clone to match).
  async invokeLocal(m: string, a: unknown): Promise<unknown> {
    const fn = this.#methods[m]
    if (!fn) throw new Error(`unknown method '${m}'`)
    const tracked: Promise<Coords>[] = []
    const ctx: Context = { data: this.#data, flush: () => settle(tracked.splice(0)) }
    let result: unknown = this.#als.run(tracked, () => fn(a, ctx))
    if (!isProxy(result) && result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function')
      result = await result
    await settle(tracked) // flush-on-return — a refused write fails the call (V4-5)
    return isProxy(result) ? structuredClone(snapshot(result)) : result
  }

  //! reapLink — the caller's link died: stop its streams AND cancel any still opening in a flush window
  // (the composer folds JK.linkDown into this; the cancelled flag makes the deferred open a no-op).
  reapLink(link: number) {
    for (const [key, sub] of this.#subs)
      if (key.startsWith(link + '|')) { sub.cancelled = true; sub.stop(); this.#subs.delete(key) }
  }

  destroy() {
    for (const [, sub] of this.#subs) sub.stop()
    this.#subs.clear()
  }
}

interface PendingCall {
  m: string
  a: unknown
  retry: boolean
  held: boolean // failed pre-dispatch ('unreachable' = never shipped, never executed) — safe to re-dispatch for EVERY call
  to?: string // M6-review finding 6: a to-routed call has no failover to hold for — it fails fast, typed
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class Caller {
  #rt: Runtime
  #seq = 0
  #calls = new Map<number, PendingCall>()
  #subs = new Map<number, { m: string; a: unknown; proxy: any }>()

  constructor(rt: Runtime) {
    this.#rt = rt
    rt.onResult = (id, ok, value, local) => this.#onResult(id, ok, value, local)
    rt.onSubRecs = (id, recs) => this.#onSubRecs(id, recs)
  }

  //! call — one-shot RPC. `retry` re-dispatches on primary failover (idempotent methods ONLY — the
  // banner's re-execution warning); default is fail-fast with a typed reason.
  call(m: string, a: unknown, opts: { timeout?: number; retry?: boolean; to?: string } = {}): Promise<unknown> {
    const id = ++this.#seq
    const ms = opts.timeout ?? 10_000
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (!this.#calls.delete(id)) return
        reject(new Error(`methods.${m}: timeout after ${ms}ms`))
      }, ms)
      t.unref?.()
      this.#calls.set(id, {
        m, a, retry: opts.retry === true, held: false,
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      //! `to` (M6): a named member instead of the primary — the scoped gather/remote-read fan-out
      this.#rt.node.step({ kind: 'rpc', id, mode: VERB.CALL, m, a, ...(opts.to !== undefined ? { to: opts.to } : {}) })
    })
  }

  //! subscribe — open a live stream into a fresh local proxy. The id doubles as the subscription
  // identity server-side (keyed by link|id there, so the same id re-used on a NEW primary is clean).
  subscribe(m: string, a: unknown): { id: number; proxy: any } {
    const id = ++this.#seq
    const p = proxy({})
    this.#subs.set(id, { m, a, proxy: p })
    this.#rt.node.step({ kind: 'rpc', id, mode: VERB.SUB, m, a })
    return { id, proxy: p }
  }

  unsubscribe(id: number) {
    if (!this.#subs.delete(id)) return
    this.#rt.node.step({ kind: 'rpc', id, mode: VERB.UNSUB })
  }

  #onResult(id: number, ok: boolean, value: unknown, local: boolean) {
    const c = this.#calls.get(id)
    if (!c) return
    //! a LOCAL failure is pre-dispatch (the kernel never shipped the frame ⇒ the handler never ran) —
    // hold it for the next primary (safe for EVERY call — the handler didn't run; the timeout bounds
    // the wait). `local` is the channel bit (M5-review #7): a wire RESULT whose value happens to equal
    // 'unreachable' arrives with local=false and settles as an ordinary handler rejection, never held.
    //! …but ONLY for primary-routed calls. A TO-ROUTED call (M6-review finding 6) names its member —
    // a primary change never makes that member reachable, and the member caller has no
    // onPrimaryChange wired anyway, so "held" would just sit out the full timeout. Reject NOW, typed:
    // the gather's fan-out and the remote-key read turn one dead link into one fast ScopedError
    // instead of an 8s stall per generation.
    if (!ok && local) {
      if (c.to !== undefined) {
        this.#calls.delete(id)
        return c.reject({
          scoped: true, op: c.m.startsWith(SYSTEM) ? c.m.slice(1) : c.m, reason: 'unreachable',
          replicas: this.#rt.node.replicas, missing: [c.to],
          hint: `member ${c.to} has no admitted link — retry when the view heals`,
        } satisfies ScopedError as unknown as Error)
      }
      c.held = true
      return
    }
    this.#calls.delete(id)
    if (ok) c.resolve(value)
    //! M6: a typed ScopedError crosses the wire as the RESULT error value and rehydrates AS-IS —
    // the `scoped: true` discriminant is the contract (api/types.ts); everything else keeps the
    // Error-string wrap
    else if (typeof value === 'object' && value !== null && (value as { scoped?: boolean }).scoped === true) c.reject(value)
    else c.reject(new Error(`methods.${c.m}: ${String(value)}`))
  }

  #onSubRecs(id: number, recs: Rec[]) {
    const sub = this.#subs.get(id)
    if (!sub) return
    for (const r of recs) applyStreamRec(sub.proxy, r as unknown as { type: string; key?: string[]; value?: unknown; at?: unknown })
  }

  //! onPrimaryChange — the failover policies (v2's OQ2, closed): re-subscribe every live sub on the
  // new feeder (same id — server subs are per-link), re-dispatch HELD (never-shipped) and retry-tagged
  // calls, fail the shipped-and-lost rest fast (re-execution is only safe when declared idempotent).
  onPrimaryChange() {
    for (const [id, c] of [...this.#calls]) {
      if (c.held || c.retry) {
        c.held = false
        this.#rt.node.step({ kind: 'rpc', id, mode: VERB.CALL, m: c.m, a: c.a })
      } else {
        this.#calls.delete(id)
        c.reject(new Error(`methods.${c.m}: link-down (the connected server died; pass {retry: true} on idempotent calls)`))
      }
    }
    for (const [id, sub] of this.#subs)
      this.#rt.node.step({ kind: 'rpc', id, mode: VERB.SUB, m: sub.m, a: sub.a })
  }

  destroy() {
    for (const [, c] of this.#calls) c.reject(new Error(`methods.${c.m}: destroyed`))
    this.#calls.clear()
    this.#subs.clear()
  }
}

//! COERCION — property names that are introspection/coercion hooks, NOT reactive reads: touching them
// must never open a subscription (M5-review #8: `String(h)`, template literals, JSON.stringify/toJSON,
// util.inspect, duck-typing all hit the get trap; opening a live sub on any of them leaks a client+
// server subscription with no lifecycle owner). Symbols (Symbol.toPrimitive/toStringTag/iterator, the
// nodejs inspect symbol, etc.) are covered separately by the typeof check.
const COERCION = new Set(['toJSON', 'toString', 'valueOf', 'constructor', 'nodeType', 'length', 'name', 'prototype'])

//! handle — the tagged dual-mode Handle (plan §9): `await` (then) is a one-shot CALL; any reactive
// touch opens the live subscription ONCE and delegates every subsequent trap to the local mirror
// proxy. Reserved surface on a handle: then / open / close / mode — everything else is the live view.
// Writes through a handle throw: subscription results are read-only projections.
export const handle = (caller: Caller, m: string, a: unknown, opts: { timeout?: number; retry?: boolean } = {}): any => {
  let live: { id: number; proxy: any } | null = null
  const open = () => (live ??= caller.subscribe(m, a))
  const reserved = (prop: string | symbol) => prop === 'then' || prop === 'open' || prop === 'close' || prop === 'mode'
  //! a bare touch that is NOT a reactive read (a symbol, a coercion hook) must NOT open the sub. Coercion
  // hooks return a MARKER (so `String(h)`/templates yield '[fero handle]' rather than throwing 'cannot
  // convert to primitive'); toJSON returns undefined (serializes to nothing); every other symbol/passive
  // prop is undefined. If the sub is already live, delegate to the mirror proxy.
  const marker = () => '[fero handle]'
  const passive = (prop: string | symbol): unknown => {
    if (live) return (live.proxy as Record<string | symbol, unknown>)[prop]
    if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return marker
    if (prop === Symbol.toStringTag) return 'FeroHandle'
    if (prop === 'toJSON') return () => undefined
    return undefined
  }
  const isPassive = (prop: string | symbol) => typeof prop === 'symbol' || (typeof prop === 'string' && COERCION.has(prop))
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => caller.call(m, a, opts).then(onF, onR)
      //! catch/finally are thenable-adjacent, NOT reactive touches — `methods.x().catch(...)` must
      // behave like a promise, never open a subscription with a 'catch' operator (M6 papercut)
      if (prop === 'catch') return (onR?: (e: unknown) => unknown) => caller.call(m, a, opts).catch(onR)
      if (prop === 'finally') return (onD?: () => void) => caller.call(m, a, opts).finally(onD)
      if (prop === 'open') return () => open().proxy
      if (prop === 'close') return () => { if (live) { caller.unsubscribe(live.id); live = null } }
      if (prop === 'mode') return live ? 'live' : 'oneshot'
      if (isPassive(prop)) return passive(prop)
      return open().proxy[prop]
    },
    set() { throw new Error(`methods.${m}: subscription handles are read-only — write via data or methods.update`) },
    //! `has` (the `in` operator, duck-typing) must NEVER open a sub either — report only the reserved
    // surface plus, if already live, the live proxy's keys
    has(_t, prop) { return reserved(prop) || (live ? prop in live.proxy : false) },
  })
}
