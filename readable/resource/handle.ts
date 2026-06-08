// Neutral L2 leaf: lazy remote-handle skeleton + wire-form reducer, shared by dispatch & fold (breaks the import cycle).

import { value as VALUE, view as VIEWSYM } from '../../data/index.ts'

// noop target for the callable client-handle Proxy (mirrors data's ViewProxy).
const noop = () => {}

// lazyHandle: the Proxy(noop) both handles share — a thenable (one-shot resolve) AND a live ViewProxy (opens on first real access).
export const lazyHandle = (opts: {
  then: (onF: any, onR: any) => any
  open: () => any
  extraGet?: (prop: string | symbol) => { v: unknown } | undefined
  set?: (prop: string, v: unknown) => void
}): any => {
  let delegate: any
  return new Proxy(noop, {
    // GUARD ORDER IS LOAD-BEARING — two Q3b defects came from reordering this. Keep 1→5:
    get(_t, prop) {
      const extra = opts.extraGet?.(prop)
      if (extra) return extra.v
      if (prop === 'then') return opts.then
      if (typeof prop === 'symbol' && prop !== VIEWSYM && prop !== VALUE) return undefined
      if (prop === 'constructor' || prop === 'toJSON') return undefined
      if (delegate === undefined) delegate = opts.open()
      return delegate[prop]
    },
    set(_t, prop, v) {
      if (typeof prop === 'string') opts.set?.(prop, v)
      return true
    },
  })
}

// Resolver tag on a foldAggregate/gather handle: `handle[FOLD_ONCE]` yields a `() => Promise<global>`
export const FOLD_ONCE = Symbol('fero.gatherOnce')
// FOLD_HANDLES: identity WeakSet of live fold/gather handles — forWire probes it (no symbol read) to gatherOnce-resolve them.
export const FOLD_HANDLES = new WeakSet<object>()

// A `data` ViewProxy carries the view symbol; a plain value does not.
export function isViewProxy(v: unknown): boolean {
  return v != null && (typeof v === 'object' || typeof v === 'function') && (v as any)[VIEWSYM] !== undefined
}

// forWire: collapse a method's return for the wire — fold handle → gatherOnce global, ViewProxy → [value] (unconditional), else passthrough.
export function forWire(v: unknown): unknown {
  // Fold-handle branch: membership-check FOLD_HANDLES (not a symbol probe), resolve its one-shot global — never open the live fold.
  if (typeof v === 'function' && FOLD_HANDLES.has(v as object)) return (v as any)[FOLD_ONCE]()
  return isViewProxy(v) ? (v as any)[VALUE] : v
}
