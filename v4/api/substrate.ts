//! ── api/substrate — the ONE seam onto the `data` sibling library (data v4) ────
// fero v4 runs on data v4 (../../data/v4) — the tree that landed fero's
// DESIGN-DATA3 wishlist. The v2-era probed contract points are now ANSWERED
// NATIVELY and pinned by the executable SCHEDULE suite (fero CI runs data's
// conformance/schedule.test.ts against data HEAD — package.json test chain):
//
//   - the record-apply ingress is the seam's HOT LANE (data W7): fero Recs
//     apply VERBATIM — numeric type tags, path keys, at-keyed root inserts —
//     zero reshape, values installed by reference, clause-10 tolerances
//     (idempotent removes, per-record isolation) built in.
//   - the ECHO PROBLEM IS STRUCTURALLY GONE (DESIGN-DATA3 §4.1): fero owns the
//     write surface (the LENS below traps assignment/delete and routes to
//     Bind.issue BEFORE data sees anything), so no capture sink exists to echo
//     into. The v3 match-and-consume family (#expected, verb-rewrite matching,
//     the healRoot microtask) is deleted, not ported.
//   - subscriptions are data v4 handles with SYNCHRONOUS dispose and strong
//     scope-owned refs — records().stop() is a real detach, and the operator
//     chain behind a derived view is held by the graph, not a WeakRef dance.
//   - [value] reads are FRESH dense materializations (not v2's live mutable
//     alias) — the same call sites, safer semantics; deep clones remain only
//     where a value crosses to USER ownership (methods.ts, fold.ts).
//
// One deliberate v2-parity retention: fero's `data` surface stays assignment-
// writable and (root or child) THENABLE — that is fero's public API (plan §9),
// now implemented by fero's OWN lens rather than inherited from data.

import {
  $, value as VALUE, node as NODE, lane, ingest, DataNode, exportContract,
} from '../../../data/v4/api/index.ts'
import { REC, type Rec } from '../kernel/env.ts'

//! ORIGIN — the token every substrate apply carries. Nothing in fero suppresses on it today
// (no capture sink exists to protect); it exists so any sink — diagnostics, a user tap, a
// future spoke-forwarder — can OPT OUT of replication-applied noise declaratively
// (connect(..., { origin: ORIGIN }) sees only non-fero commits). Kernel-level, one compare.
export const ORIGIN: symbol = Symbol('fero')

//! proxy — mint a resource container (a data v4 source handle; non-callable, non-thenable —
// fero's thenable/assignable public shape is the LENS, layered by api/data.ts).
export const proxy = (initial: unknown = {}): any => $(initial)

//! snapshot — the dense current value (v4 [value]: a fresh container per read; rows shared
// by reference under the path-copy immutability law).
export const snapshot = (p: any): unknown => p[VALUE]

//! contract — data's machine-readable manifest (reserved names + operator categories); the
// scoped facade derives its operator set from this instead of a hand-copied list.
export const contract = exportContract

//! isProxy — the return-type dispatch probe (plan §9): anything carrying a data v4 node —
// a raw handle, an operator view, or a fero lens (which forwards the symbol) — is
// subscribable; every other value is a value. v4 handles are NOT thenable, so the v3
// blind-await hazard shrinks to fero's own lens (which keeps the v2-parity thenable).
export const isProxy = (x: unknown): boolean =>
  x !== null && (typeof x === 'object' || typeof x === 'function') && (x as any)[NODE] instanceof DataNode

//! lanes — one pre-resolved hot lane per handle (data W7): profile, source, and origin all
// fixed at first use; per-apply work is the loop + writes only. Rejects surface through a
// per-call slot so applyRec can vivify orphan cells (below) without per-lane closures.
const lanes = new WeakMap<object, (recs: readonly Rec[]) => { applied: number; rejected: number }>()
let rejects: { record: unknown; error: unknown }[] | null = null
const laneOf = (p: any) => {
  let l = lanes.get(p)
  if (l === undefined) {
    l = lane(p, { origin: ORIGIN, onReject: (rj) => rejects?.push(rj) }) as (recs: readonly Rec[]) => { applied: number; rejected: number }
    lanes.set(p, l)
  }
  return l
}

//! applyRec — one committed/optimistic Rec into the handle via the hot lane. ORPHAN-CELL
// VIVIFY: field-granular LWW lawfully commits a nested cell before (or after the removal
// of) its row — data v4 keeps deep-writes-cannot-invent-rows LOUD (clause 10c), so the
// substrate supplies fero's replication semantics here: a rejected deep write vivifies the
// row ({}) and re-applies, byte-for-byte what data v2's auto-vivifying [view].res did.
// Everything else that rejects is a genuine fault and rethrows.
export const applyRec = (p: any, r: Rec): void => {
  //! SAVE/RESTORE, not set/null: applyRec re-enters through data's effect phase (a user
  // tap issuing a write → #optimistic → applyRec while the outer lane is mid-flush), and a
  // module-level slot nulled by the inner call corrupted the outer's. Note the flush-time
  // wrinkle: a lane call made INSIDE an effect defers its whole batch (clause 5), so its
  // rejects surface during the OUTER call's drain — vivify is exact for the replication
  // path (applies arrive outside data effects) and best-effort for effect-issued writes.
  const prev = rejects
  rejects = []
  try {
    laneOf(p)([r])
    const mine = rejects
    if (mine.length > 0) {
      const rj = mine[0]
      if (r.type === REC.update && r.key.length > 1 && String((rj.error as Error)?.message ?? '').includes('not live')) {
        rejects = [] // the retry's rejects stay LOUD — a post-vivify failure is a genuine fault
        laneOf(p)([{ type: REC.update, key: [r.key[0]], value: {} }, r])
        if (rejects.length > 0) throw rejects[0].error
        return
      }
      throw rj.error
    }
  } finally {
    rejects = prev
  }
}

//! records — a RECORD-interface subscription: fn gets v2-profile change records
// {type:'update'|'insert'|'remove'|'move', key, value, at?} with an initial whole-value
// snapshot on attach (v4 V2RecordSink parity) and values CLONED (the stream crosses to
// wire/user ownership). stop() is a REAL synchronous detach now (v4 SubscriptionHandle),
// and the operator chain behind a derived view is graph-held — the v3 anchor/WeakRef
// pinning contract is gone.
export const records = (p: any, fn: (rec: { type: string; key: string[]; value?: unknown; at?: string }) => void): { stop(): void } => {
  const h = (p as { connect: (a: object, f: unknown) => { dispose(): void } }).connect({}, fn)
  return { stop: () => h.dispose() }
}

//! applyStreamRec — fold one v2-profile stream record into a local mirror handle via the
// seam's tolerant ingest (whole-value updates diff against current state — the resubscribe
// snapshot root-replace rides this, legally). 'move' records are skipped: mirrors are
// keyed (object-born) sources, and positional identity is not a mirror shape — the
// documented consequence stands (sort on the client proxy); the serve side keeps its skip.
export const applyStreamRec = (p: any, r: { type: string; key?: string[]; value?: unknown; at?: unknown }): void => {
  if (r.type === 'move') return
  const rec = { type: r.type, key: Array.isArray(r.key) ? r.key : [], value: r.value, ...(r.at !== undefined ? { at: r.at } : {}) }
  //! the same ORPHAN-CELL VIVIFY as applyRec: the gather lawfully projects a parent
  // tombstone FIRST and re-projects the live nested cell after (fold.ts two-phase order —
  // the Q3a seed-0 shape), which needs the deep update to re-invent the row exactly as
  // data v2's auto-vivifying res did. Everything else that rejects keeps v2-armor
  // tolerance (fold.ts wraps every cell in isolation anyway).
  let rejected: unknown = null
  ingest(p, [rec as never], { origin: ORIGIN, onReject: (rj) => (rejected = rj.error) })
  if (
    rejected !== null && r.type === 'update' && rec.key.length > 1 &&
    String((rejected as Error)?.message ?? '').includes('not live')
  ) {
    ingest(p, [{ type: 'update', key: [rec.key[0]], value: {} } as never, rec as never], { origin: ORIGIN, onReject: () => {} })
  }
}

//! ── the LENS: fero's OWN write surface (DESIGN-DATA3 §4.1) ────────────────────
// data v4 removed assignment writes; fero's public API keeps them (plan §9 — zero events,
// assignment IS a write). The lens is fero's thin Proxy over the v4 handle: reads and
// RESERVED names (operators, get/connect/tap/…) delegate to v4; child access returns a
// nested lens (so deep assignment works); set/delete mint fero Recs and hand them to the
// SINK (Bind.issue — validation, overlay, owner routing) BEFORE data sees anything. A
// root replace ([value] =, or assigning the lens itself) throws PRE-COMMIT — the v3
// throw-then-heal dance is unnecessary by construction. `then` keeps fero's v2-parity
// await-for-snapshot on the UNSCOPED surface (the scoped facade overrides it with the
// gather — api/index.ts).
const LENS = Symbol('fero.lens')
const RESERVED_NAMES: ReadonlySet<string> = new Set(contract().reserved)

export const lens = (h: any, path: string[], sink: (recs: Rec[]) => void): any =>
  new Proxy(Object.create(null) as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === LENS) return h
      if (typeof prop === 'symbol') return h[prop] // [value] / [node] / iterator / toPrimitive
      if (prop === 'then')
        //! v2 parity: await data (or any child) resolves its current snapshot. then is
        // consume-once per touch; a method handler returning a lens is guarded by the
        // host's isProxy-before-await discipline exactly as in v3.
        return (F?: (v: unknown) => unknown, R?: (e: unknown) => unknown) => Promise.resolve(h[VALUE]).then(F, R)
      if (prop === 'get')
        //! the total, collision-safe child read — returns a WRITE-CAPABLE lens (keyedRead
        // and user code route here for partition names shadowed by RESERVED)
        return (k: unknown) => lens(h.get(String(k)), [...path, String(k)], sink)
      if (RESERVED_NAMES.has(prop)) return h[prop] // operators + built-ins: v4's own dispatch
      const child = h.get(prop)
      return lens(child, [...path, prop], sink)
    },
    set(_t, prop, v) {
      if (typeof prop === 'symbol')
        throw new Error('fero: replace keys (data.k = v), not the resource root — a whole-root overwrite does not replicate')
      sink([{ type: REC.update, key: [...path, String(prop)], value: v }])
      return true
    },
    deleteProperty(_t, prop) {
      //! no-op delete filter (v2 parity — the substrate used to filter these before the
      // capture sink ever saw them): deleting an absent (or undefined-valued — the leaf
      // equivalence, data clause 10c) target issues NOTHING. One O(depth) leaf read.
      if ((h.get(String(prop)) as any)[VALUE] === undefined) return true
      sink([{ type: REC.remove, key: [...path, String(prop)] }])
      return true
    },
    has(_t, prop) {
      if (prop === LENS || prop === 'then') return true
      return Reflect.has(h, prop)
    },
    ownKeys(_t) {
      return Reflect.ownKeys(h)
    },
    getOwnPropertyDescriptor(_t, prop) {
      return Reflect.getOwnPropertyDescriptor(h, prop)
    },
  })

//! unwrap — the underlying v4 handle of a lens (or the value itself when not a lens):
// internal consumers (the gather's projection, diagnostics) that want raw v4 semantics.
export const unwrap = (x: any): any => (x !== null && typeof x === 'object' || typeof x === 'function' ? (x[LENS] ?? x) : x)
