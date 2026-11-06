// seam — the ONE place the prototype touches `data` (DATA-02), in the shape of fero v4's
// api/substrate.ts. DATA names data's folder (default: this machine's /home/user/pemrouz/data).
// Committed records fold through data's hot lane verbatim (DATA-01, DATA-03): numeric type tags,
// path keys, values by reference. fero owns the write surface: the lens below traps assignment and
// delete and hands fero records to a sink BEFORE data sees anything, so the fold shows a write only
// when it commits (V4-7).

import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { join } from 'node:path'
import type { Rec } from './kernel.ts'
import { deepFreeze } from './util.ts'

export const DATA_DIR = process.env.DATA ?? '/home/user/pemrouz/data'
const D: any = await import(pathToFileURL(join(DATA_DIR, 'api/index.ts')).href)
const VALUE: symbol = D.value
const NODE: symbol = D.node

export const contract = D.exportContract()
export const OPERATORS: ReadonlySet<string> = new Set(Object.keys(contract.operators))
export const RESERVED: ReadonlySet<string> = new Set(contract.reserved)

/** Where the user's own code lands when it throws as data closes a commit (a view's function, a tap):
 *  never into a kernel step (DATA-06). */
export type Fault = (e: unknown) => void

/** a fresh source: one resource's fold on one process (array-born for an ordered view's mirror) */
export const source = (array = false): any => D.$(array ? [] : {})

const lanes = new WeakMap<object, (recs: readonly Rec[]) => { applied: number; rejected: number }>()
let rejects: { record: unknown; error: unknown }[] = []
const laneOf = (src: any) => {
  let l = lanes.get(src)
  if (!l) { l = D.lane(src, { onReject: (r: any) => rejects.push(r) }); lanes.set(src, l!) }
  return l!
}

/** Fold committed records into a source through data's hot lane, in log order. A record data
 *  refuses comes back as a reason (the prototype treats any as a divergence); what the user's views
 *  and taps throw goes to `fault`. One known tolerance kept from v4: a replicated remove of an
 *  array's own element folds as a no-op (V4-18). */
export const fold = (src: any, recs: readonly Rec[], fault: Fault): string | null => {
  const prev = rejects
  rejects = []
  try {
    try { laneOf(src)(recs) } catch (e) { fault(e) }
    const mine = rejects
    if (mine.length === 0) return null
    const msg = String((mine[0].error as Error)?.message ?? mine[0].error)
    if (msg.includes('array element')) return null
    return msg
  } finally {
    rejects = prev
  }
}

/** One data batch: the taps fire once for everything fn folds. */
export const batch = (fn: () => void): void => { D.batch(fn) }

/** The dense value of a handle (a fresh container per read; rows shared by reference). */
export const valueOf = (h: any): any => h[VALUE]
/** One row, frozen on the way out (DATA-07: a read by reference cannot change what a node holds). */
export const rowOf = (src: any, key: string): unknown => deepFreeze(src.get(key)[VALUE])
export const hasRow = (src: any, key: string): boolean => src.get(key)[VALUE] !== undefined
export const keysOf = (src: any): string[] => Object.keys(src[VALUE] ?? {})
export const isView = (x: unknown): boolean => {
  try { return x !== null && (typeof x === 'object' || typeof x === 'function') && (x as any)[NODE] instanceof D.DataNode } catch { return false }
}
export const unwrapLens = (x: any): any => (x !== null && typeof x === 'object' && x[LENS] ? x[LENS] : x)

/** A record subscription on a view or source: v2-profile records with an opening whole-value
 *  record (data's connect). Used to stream a method's view to a caller's mirror. */
export const records = (h: any, fn: (r: { type: string; key: string[]; value?: unknown; at?: unknown }) => void): { stop(): void } => {
  const s = h.connect({}, fn)
  return { stop: () => s.dispose() }
}
/** Fold stream records into a mirror (data's tolerant ingest: a whole-value update diffs). A live
 *  view's stream keeps data's 'move' records: an ordered view (za, az, top) folded through the lane
 *  emits them, and a mirror without them loses its order (bug fix, E-22 step 2; the log's records
 *  have no moves, a view stream's do). */
export const ingest = (mirror: any, recs: readonly object[], fault: Fault): void => {
  try { D.ingest(mirror, recs, { onReject: () => {} }) } catch (e) { fault(e) }
}

// ── the LENS: fero's write surface over a data handle ──────────────────────
export const LENS = Symbol('fero.lens')
export interface LensHooks {
  /** a write the lens trapped: fero records, or an op value at a path */
  sink(recs: Rec[]): void
  /** throws 'shortfall' if this process does not hold the row (a value read of it) */
  need(key: string): void
  /** throws 'holistic' if this process holds only part of the resource (an operator, an enumeration) */
  whole(): void
}
export const lens = (h: any, path: string[], hooks: LensHooks): any => {
  // a value read of a row (or below) needs the row held; of the root, the whole picture
  const readCheck = (): void => { if (path.length === 0) hooks.whole(); else hooks.need(path[0]) }
  return new Proxy(printable(() => h[VALUE]) as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === LENS) return h
      if (prop === Symbol.toPrimitive)
        return (hint: string) => { readCheck(); const v = h[VALUE]; return v !== null && typeof v === 'object' ? (hint === 'number' ? Number(v) : String(v)) : v }
      if (typeof prop === 'symbol') return h[prop]
      // not thenable: v5 has no `await f.data` (API.md §2: get, follow, read)
      if (prop === 'then') return undefined
      if (prop === 'valueOf' || prop === 'snapshot') return () => { readCheck(); return deepFreeze(h[VALUE]) }
      if (prop === 'get') return (k: unknown) => lens(h.get(String(k)), [...path, String(k)], hooks)
      if (prop === 'set') return (k: unknown, v: unknown) => void hooks.sink([{ type: 0, key: [...path, String(k)], value: v }])
      if (prop === 'update') return (v: unknown) => {
        if (path.length === 0) throw new Error('fero: replace keys (data.k = v), not the resource root')
        hooks.sink([{ type: 0, key: path, value: v }])
      }
      if (prop === 'remove') return () => {
        if (path.length === 0) throw new Error('fero: remove() on the resource root is not a write; destroy() the resource instead')
        hooks.sink([{ type: 2, key: path }])
      }
      if (prop === 'insert' || prop === 'ingest' || prop === 'raf' || prop === 'dispose' || prop === 'patch')
        return () => { throw new Error(`fero: ${String(prop)}() is not a fero write; assign (data.k = v) or use set()`) }
      if (OPERATORS.has(prop) || prop === 'keys' || prop === 'values') {
        hooks.whole()
        return (...a: unknown[]) => h[prop](...a)
      }
      if (RESERVED.has(prop)) return h[prop]
      return lens(h.get(prop), [...path, prop], hooks)
    },
    set(_t, prop, v) {
      if (typeof prop === 'symbol') throw new Error('fero: replace keys (data.k = v), not the resource root')
      hooks.sink([{ type: 0, key: [...path, String(prop)], value: v }])
      return true
    },
    deleteProperty(_t, prop) {
      hooks.sink([{ type: 2, key: [...path, String(prop)] }])
      return true
    },
    has(_t, prop) { return prop === LENS || Reflect.has(h, prop) },
    ownKeys() { if (path.length === 0) hooks.whole(); return Reflect.ownKeys(h) },
    getOwnPropertyDescriptor(_t, prop) { return Reflect.getOwnPropertyDescriptor(h, prop) },
  })
}

/** a Proxy target that console.log prints as its value (Node inspects a proxy's target, not its traps) */
const printable = (value: () => unknown): object => {
  const t = Object.create(null)
  Object.defineProperty(t, inspect.custom, { configurable: true, value: (_d: number, o: object) => { try { return inspect(value(), o) } catch (e) { return `[${(e as Error).message}]` } } })
  return t
}

/** A Proxy that reads like a plain object of frozen rows, but throws 'shortfall' for a row this
 *  process does not hold and 'holistic' when enumerating a partial picture. */
export const snapshotProxy = (src: any, hooks: Pick<LensHooks, 'need' | 'whole'>): any =>
  new Proxy(printable(() => deepFreeze(src[VALUE])), {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then' || prop === 'toJSON') {
        if (prop === 'toJSON') return () => { hooks.whole(); return deepFreeze(src[VALUE]) }
        return undefined
      }
      hooks.need(prop)
      return rowOf(src, prop)
    },
    has(_t, prop) { if (typeof prop === 'symbol') return false; hooks.need(prop); return hasRow(src, prop) },
    ownKeys() { hooks.whole(); return keysOf(src) },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop === 'symbol' || !hasRow(src, prop)) return undefined
      return { value: rowOf(src, prop), enumerable: true, configurable: true, writable: false }
    },
    set() { throw new Error('fero: snapshot is read-only; write through data or set()') },
    deleteProperty() { throw new Error('fero: snapshot is read-only; remove() instead') },
  })
