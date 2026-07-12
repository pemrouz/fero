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
import type { Coords } from './data.ts'

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
  #subs = new Map<string, { stop(): void }>()

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
    if (mode === VERB.UNSUB) {
      const sub = this.#subs.get(link + '|' + id)
      if (sub) { sub.stop(); this.#subs.delete(link + '|' + id) }
      return
    }
    const fn = m.startsWith(SYSTEM) ? this.#system[m.slice(1)] : this.#methods[m]
    if (!fn) return this.#reply(link, id, false, `unknown method '${m.startsWith(SYSTEM) ? m.slice(1) : m}'`)
    //! each invocation gets its own write collector; the handler runs OUTSIDE the kernel step (async),
    // and its return implicitly flushes — the reply provably follows its own commits
    const tracked: Promise<Coords>[] = []
    const ctx: Context = {
      data: this.#data,
      flush: async () => { await Promise.all(tracked.splice(0).map((p) => p.catch(() => {}))) },
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
        await Promise.all(tracked.map((p) => p.catch(() => {}))) // flush-on-return
      } catch (err) {
        return this.#reply(link, id, false, err instanceof Error ? err.message : String(err))
      }
      if (mode === VERB.CALL) {
        //! a returned ViewProxy collapses to its snapshot for a one-shot call (v2's forWire, kept;
        // no clone — the reply's codec copies the value into frame bytes synchronously inside step)
        return this.#reply(link, id, true, isProxy(result) ? snapshot(result) : result)
      }
      //! SUB: a proxy streams (initial snapshot rides the record interface's attach emit); a plain
      // value degrades to a single-shot stream (one root update) — same consumption shape either way
      if (!isProxy(result)) {
        this.#rt.node.step({ kind: 'subOut', link, id, recs: [{ type: 'update', key: [], value: result } as unknown as Rec] })
        return
      }
      const live = result
      const stream = records(live, (rec) => {
        if (rec.type === 'move') return // documented M5c limitation (banner): sort client-side instead
        this.#rt.node.step({ kind: 'subOut', link, id, recs: [rec as unknown as Rec] })
      })
      //! the anchor for the stream is the sub entry itself — strongly held until UNSUB/reap
      this.#subs.set(link + '|' + id, { stop: () => stream.stop() })
    })()
  }

  #reply(link: number, id: number, ok: boolean, value: unknown) {
    this.#rt.node.step({ kind: 'reply', link, id, ok, value })
  }

  //! reapLink — the caller's link died: stop its streams (the composer folds JK.linkDown into this).
  reapLink(link: number) {
    for (const [key, sub] of this.#subs)
      if (key.startsWith(link + '|')) { sub.stop(); this.#subs.delete(key) }
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
    rt.onResult = (id, ok, value) => this.#onResult(id, ok, value)
    rt.onSubRecs = (id, recs) => this.#onSubRecs(id, recs)
  }

  //! call — one-shot RPC. `retry` re-dispatches on primary failover (idempotent methods ONLY — the
  // banner's re-execution warning); default is fail-fast with a typed reason.
  call(m: string, a: unknown, opts: { timeout?: number; retry?: boolean } = {}): Promise<unknown> {
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
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      this.#rt.node.step({ kind: 'rpc', id, mode: VERB.CALL, m, a })
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

  #onResult(id: number, ok: boolean, value: unknown) {
    const c = this.#calls.get(id)
    if (!c) return
    //! 'unreachable' is a PRE-DISPATCH failure (the kernel never shipped the frame ⇒ the handler never
    // ran) — holding it for the next primary is safe for EVERY call, retry-tagged or not; the call's
    // own timeout still bounds the wait. Post-dispatch failures settle by policy (see onPrimaryChange).
    if (!ok && value === 'unreachable') { c.held = true; return }
    this.#calls.delete(id)
    if (ok) c.resolve(value)
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

//! handle — the tagged dual-mode Handle (plan §9): `await` (then) is a one-shot CALL; any reactive
// touch opens the live subscription ONCE and delegates every subsequent trap to the local mirror
// proxy. Reserved surface on a handle: then / open / close / mode — everything else is the live view.
// Writes through a handle throw: subscription results are read-only projections.
export const handle = (caller: Caller, m: string, a: unknown, opts: { timeout?: number; retry?: boolean } = {}): any => {
  let live: { id: number; proxy: any } | null = null
  const open = () => (live ??= caller.subscribe(m, a))
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => caller.call(m, a, opts).then(onF, onR)
      if (prop === 'open') return () => open().proxy
      if (prop === 'close') return () => { if (live) { caller.unsubscribe(live.id); live = null } }
      if (prop === 'mode') return live ? 'live' : 'oneshot'
      return open().proxy[prop]
    },
    set() { throw new Error(`methods.${m}: subscription handles are read-only — write via data or methods.update`) },
    has(_t, prop) { return prop === 'then' || prop === 'open' || prop === 'close' || prop === 'mode' || (prop in open().proxy) },
  })
}
