//! Neutral L2 leaf: lazy remote-handle skeleton + wire-form reducer, shared by dispatch & fold (breaks the import cycle).
// resource/handle.ts — the lazy remote-handle skeleton + the wire-form reducer (L2 leaf).
//
// The pieces fero's read/aggregate surfaces share but that hold NO per-instance state, so
// they live at module scope, imported by both the dispatch surface ([./dispatch.ts]) and the
// fold engine ([./fold.ts]). Keeping them in ONE neutral leaf — rather than in either of those
// two mutually-referencing modules — is what avoids a dispatch↔fold import cycle, and it keeps
// `FOLD_HANDLES` a single shared identity (a handle registered by the fold engine is recognised
// by `forWire` called from the dispatch side). Nothing here is public (re-exported by neither
// index.ts nor internals.ts).

import { value as VALUE, view as VIEWSYM } from '../../data/index.ts'

//! noop target for the callable client-handle Proxy (mirrors data's ViewProxy).
const noop = () => {}

//! lazyHandle: the Proxy(noop) both handles share — a thenable (one-shot resolve) AND a live ViewProxy (opens on first real access).
// The shared skeleton for fero's two lazy remote handles — makeHandle (read / RPC) and
// foldAggregate (distributed-aggregate / gather). Both are a `Proxy(noop)` that is BOTH a
// thenable (`then` ⇒ a one-shot resolve — the ONLY access that does not open the live thing)
// AND a live `data` ViewProxy (any real prop access lazily `open()`s a subscription/fold once
// and delegates to it). The symbol handling is subtle and was the source of two Q3b defects,
// so it lives in ONE place: `extraGet` runs FIRST — before the symbol reject — so a caller's
// own symbol (foldAggregate's FOLD_ONCE) resolves instead of being swallowed; an unknown
// symbol returns undefined (probing it on a real ViewProxy throws "Cannot convert a Symbol
// to a string"); VIEWSYM/VALUE pass through to the delegate. `set` is optional (the read
// handle routes a depth-1 nested write to the raw proxy; the fold handle has none).
export const lazyHandle = (opts: {
  then: (onF: any, onR: any) => any
  open: () => any
  extraGet?: (prop: string | symbol) => { v: unknown } | undefined
  set?: (prop: string, v: unknown) => void
}): any => {
  let delegate: any // the live proxy, created (and the subscription/fold opened) on first real access
  return new Proxy(noop, {
    //! GUARD ORDER IS LOAD-BEARING — two Q3b defects came from reordering this. Keep 1→5:
    get(_t, prop) {
      // 1 · extraGet FIRST — a caller's own symbol (foldAggregate's FOLD_ONCE) must resolve here,
      //     BEFORE step 3 would swallow it as an unknown symbol.
      const extra = opts.extraGet?.(prop)
      if (extra) return extra.v
      // 2 · `then` ⇒ the one-shot resolve — the ONLY access that does NOT open the live thing.
      if (prop === 'then') return opts.then
      // 3 · reject unknown symbols BEFORE step 5 — probing one on a real ViewProxy throws "Cannot
      //     convert a Symbol to a string". VIEWSYM/VALUE pass through to the delegate.
      if (typeof prop === 'symbol' && prop !== VIEWSYM && prop !== VALUE) return undefined
      // 4 · constructor/toJSON never open a subscription.
      if (prop === 'constructor' || prop === 'toJSON') return undefined
      // 5 · any real prop ⇒ open the live subscription/fold once, then delegate.
      if (delegate === undefined) delegate = opts.open()
      return delegate[prop]
    },
    set(_t, prop, v) {
      if (typeof prop === 'string') opts.set?.(prop, v)
      return true
    },
  })
}

//! Resolver tag on a foldAggregate/gather handle: `handle[FOLD_ONCE]` yields a `() => Promise<global>`
// that resolves a ONE-SHOT gather WITHOUT opening the handle's live fold.
export const FOLD_ONCE = Symbol('fero.gatherOnce')
//! FOLD_HANDLES: identity WeakSet of live fold/gather handles — forWire probes it (no symbol read) to gatherOnce-resolve them.
// Identity set of live fold/gather handles (foldAggregate's Proxies). Closed loop: SOLE writer is
// foldAggregate (fold.ts); SOLE reader is forWire() (below). forWire() membership-checks this — a
// side-effect-free WeakSet probe — to decide whether to resolve a returned handle via gatherOnce. We
// do NOT probe the FOLD_ONCE symbol on every method return: reading an unknown symbol off a `data`
// ViewProxy throws "Cannot convert a Symbol value to a string" (Q3b review M2 fix).
export const FOLD_HANDLES = new WeakSet<object>()

//! A `data` ViewProxy carries the view symbol; a plain value does not.
export function isViewProxy(v: unknown): boolean {
  return v != null && (typeof v === 'object' || typeof v === 'function') && (v as any)[VIEWSYM] !== undefined
}

//! forWire: collapse a method's return for the wire — fold handle → gatherOnce global, ViewProxy → [value] (unconditional), else passthrough.
// Reduce a method's return value for the wire: a ViewProxy collapses to its
// snapshot (its [value]); everything else passes through. Lets `await read()`
// return a plain object across the network while a local server can hand back
// the live proxy. A ViewProxy is detected by its VIEW symbol (isViewProxy) and its
// [value] returned UNCONDITIONALLY — even when that value is `undefined`, which a
// scalar aggregate legitimately is for an empty set (an empty max/min/avg partial).
// The old `snap !== undefined` heuristic returned the PROXY itself in that case, so
// an empty-holder partial crossed the wire as a serialized proxy and NaN-poisoned
// the extremum fold; the read() path never hit it (its root is always an object).
export function forWire(v: unknown): unknown {
  //! Fold-handle branch: membership-check FOLD_HANDLES (not a symbol probe), resolve its one-shot global — never open the live fold.
  // A fold/gather HANDLE (foldAggregate) resolves its ONE-SHOT global via gatherOnce — detected by a
  // side-effect-free FOLD_HANDLES membership check (NOT by probing the FOLD_ONCE symbol on every
  // value: an unknown symbol read off a `data` ViewProxy throws "Cannot convert a Symbol to a
  // string"). Resolving here means a method that RETURNS such a handle (`(_,c)=>c.methods.read()`)
  // replies with the awaited global, instead of the isViewProxy/[VALUE] probe opening the fold and
  // shipping its empty in-progress union (Q3b review M2). Returns a Promise the CALL handler awaits.
  if (typeof v === 'function' && FOLD_HANDLES.has(v as object)) return (v as any)[FOLD_ONCE]()
  return isViewProxy(v) ? (v as any)[VALUE] : v
}
