//! ── api/substrate — the ONE seam onto the `data` sibling library (data v4) ────
// fero v4 runs on data v4 (../../data, the v4 tree promoted to its root) — the tree that landed fero's
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
  $, value as VALUE, node as NODE, lane, ingest, batch as dataBatch, DataNode, exportContract,
} from '../../data/api/index.ts'
import { REC, type Rec } from '../kernel/env.ts'

//! ORIGIN — the token every substrate apply carries. Nothing in fero suppresses on it today
// (no capture sink exists to protect); it exists so any sink — diagnostics, a user tap, a
// future spoke-forwarder — can OPT OUT of replication-applied noise declaratively
// (connect(..., { origin: ORIGIN }) sees only non-fero commits). Kernel-level, one compare.
export const ORIGIN: symbol = Symbol('fero')

//! proxy — mint a resource container (a data v4 source handle; non-callable, non-thenable —
// fero's thenable/assignable public shape is the LENS, layered by api/data.ts).
export const proxy = (initial: unknown = {}): any => $(initial)

//! batch — data's consolidated commit: every set inside fn lands as ONE batch, so a bare tap on the
// container fires once with the whole picture (V4-8's cluster fold; the composer's one use).
export const batch = <R>(fn: () => R): R => dataBatch(fn)

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

//! applyRec — one committed Rec into the handle via the hot lane (V4-7: only commits are ever
// projected). ORPHAN-CELL
// VIVIFY: field-granular LWW lawfully commits a nested cell before (or after the removal
// of) its row — data v4 keeps deep-writes-cannot-invent-rows LOUD (clause 10c), so the
// substrate supplies fero's replication semantics here: a rejected deep write vivifies the
// row ({}) and re-applies, byte-for-byte what data v2's auto-vivifying [view].res did.
// Everything else that rejects is a genuine fault and rethrows.
export const applyRec = (p: any, r: Rec): void => {
  //! SAVE/RESTORE, not set/null: applyRec re-enters through data's effect phase (a user
  // tap issuing a write → issue → the epoch-0 fast-path commit → #onApply → applyRec while the
  // outer lane is mid-flush), and a
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
      const msg = String((rj.error as Error)?.message ?? '')
      if (r.type === REC.update && r.key.length > 1 && msg.includes('not live')) {
        rejects = [] // the retry's rejects stay LOUD — a post-vivify failure is a genuine fault
        laneOf(p)([{ type: REC.update, key: [r.key[0]], value: {} }, r])
        if (rejects.length > 0) throw rejects[0].error
        return
      }
      //! a REMOVE under an ARRAY (V4-18): data refuses to leave a sparse hole in an array ("write the
      // spliced array instead") — and it silently ignores a field WRITE under one, so a field cell
      // under an array-valued row never shows. A committed remove there is the same non-event: the
      // array stays whole, exactly as on a node that never saw the field. Throwing here killed the
      // process (the I-30 class) in the arrival orders where a newer field was re-applied over an
      // older array row; a replicated record cannot be refused, so the no-op is the only honest fold.
      if (r.type === REC.remove && r.key.length > 1 && msg.includes('array element')) return
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
//! A LIVE SCALAR arrives as { value } (I-27): a method that returns a live number (`ctx.data.count`)
// or a plain number on the SUB leg streams ROOT records carrying the bare leaf, and a mirror is
// object-born — data has no scalar-born source, so it refused the number. A ROOT record (key [] and no
// `at`) whose value is a primitive is reshaped here into a WHOLE-VALUE update of { value: v } (whole-
// value, so the old keys drop on an object → scalar flip), and a root REMOVE (the cell went away) empties
// the mirror instead of leaving the last value standing. `at` is the guard: an object-born source's
// keyed insert is ALSO key [] (`{ type:'insert', key:[], value, at:'k' }`) and must pass untouched.
// The one-shot call is untouched: it stays the bare number.
//! Returns the reject data still raised (null when the record folded) instead of swallowing it, so a
// caller can tell a mirror that went stale from one that folded.
export const applyStreamRec = (p: any, r: { type: string; key?: string[]; value?: unknown; at?: unknown }): unknown => {
  if (r.type === 'move') return null
  const key = Array.isArray(r.key) ? r.key : []
  let type = r.type, value = r.value
  if (key.length === 0 && r.at === undefined) {
    if (type === 'remove') { type = 'update'; value = {} }
    else if (type === 'update' && value !== null && value !== undefined && typeof value !== 'object') value = { value }
  }
  const rec = { type, key, value, ...(r.at !== undefined ? { at: r.at } : {}) }
  //! the same ORPHAN-CELL VIVIFY as applyRec: the gather lawfully projects a parent
  // tombstone FIRST and re-projects the live nested cell after (fold.ts two-phase order —
  // the Q3a seed-0 shape), which needs the deep update to re-invent the row exactly as
  // data v2's auto-vivifying res did. Everything else that rejects is RETURNED: fold.ts
  // ignores it (it wraps every cell in isolation anyway).
  let rejected: unknown = null
  ingest(p, [rec as never], { origin: ORIGIN, onReject: (rj) => (rejected = rj.error) })
  if (
    rejected !== null && r.type === 'update' && rec.key.length > 1 &&
    String((rejected as Error)?.message ?? '').includes('not live')
  ) {
    let again: unknown = null
    ingest(p, [{ type: 'update', key: [rec.key[0]], value: {} } as never, rec as never], { origin: ORIGIN, onReject: (rj) => (again ??= rj.error) })
    return again
  }
  return rejected
}

//! ── the LENS: fero's OWN write surface (DESIGN-DATA3 §4.1) ────────────────────
// data v4 removed assignment writes; fero's public API keeps them (plan §9 — zero events,
// assignment IS a write). The lens is fero's thin Proxy over the v4 handle: reads and
// RESERVED names (operators, get/connect/tap/…) delegate to v4; child access returns a
// nested lens (so deep assignment works); set/delete mint fero Recs and hand them to the
// SINK (Bind.issue — validation, the write-route join, owner routing) BEFORE data sees
// anything; the proxy changes only when a commit applies (V4-7: no optimistic copy). A
// root replace ([value] =, or assigning the lens itself) throws PRE-COMMIT — the v3
// throw-then-heal dance is unnecessary by construction. `then` keeps fero's v2-parity
// await-for-snapshot on the UNSCOPED surface (the scoped facade overrides it with the
// gather — api/index.ts).
const LENS = Symbol('fero.lens')
const RESERVED_NAMES: ReadonlySet<string> = new Set(contract().reserved)

//! `inflight(key)` — the binding's settlement index: true while one of OUR writes to that cell is
// on the wire. The no-op delete filter asks it before swallowing: since V4-7 the fold does not
// hold our uncommitted writes, so `data.k = v; delete data.k` must still issue the remove.
//! `up` — the PARENT handle (absent at the root): remove() reads it to refuse an array element.
//! hole — data refuses to delete an own key of an ARRAY (an element would leave a sparse hole), and it
// refuses only AFTER the commit, when the record applies. A local delete is refused HERE instead, before
// anything is stamped, with data's message — the way a root replace is (V4-18; the substrate's no-op in
// applyRec is for a REPLICATED remove, which cannot be refused). The root's parent is the resource
// object, never an array, so a depth-1 delete reads nothing more.
const hole = (parent: unknown, path: string[], k: string): void => {
  if (Array.isArray(parent) && Object.hasOwn(parent, k))
    throw new Error(`fero: remove() of array element [${[...path, k].join('.')}] would leave a sparse hole — write the spliced array instead`)
}

export const lens = (h: any, path: string[], sink: (recs: Rec[]) => void, inflight: (key: string[]) => boolean = () => false, up?: any): any =>
  new Proxy(Object.create(null) as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === LENS) return h
      //! a lens COERCES to its cell (ISSUES I-25): data's handle answers Symbol.toPrimitive with its
      // debug label, so `data.k = data.k + 1` committed the STRING '[data source#1 .k]1' and `data.k++`
      // committed NaN — both replicated, nothing threw. Now a primitive coerces as itself (an absent cell
      // is undefined: NaN in arithmetic, exactly as a plain object's missing field), and an object as a
      // plain object would (String(v) / Number(v)) — never a label into a cell. `data.k++` therefore reads
      // k and routes k+1 through the set trap below.
      if (prop === Symbol.toPrimitive)
        return (hint: string) => { const v = h[VALUE]; return v !== null && typeof v === 'object' ? (hint === 'number' ? Number(v) : String(v)) : v }
      if (typeof prop === 'symbol') return h[prop] // [value] / [node] / iterator
      if (prop === 'valueOf') return () => h[VALUE]
      if (prop === 'then')
        //! v2 parity: await data (or any child) resolves its current snapshot. then is
        // consume-once per touch; a method handler returning a lens is guarded by the
        // host's isProxy-before-await discipline exactly as in v3.
        return (F?: (v: unknown) => unknown, R?: (e: unknown) => unknown) => Promise.resolve(h[VALUE]).then(F, R)
      if (prop === 'get')
        //! the total, collision-safe child read — returns a WRITE-CAPABLE lens (keyedRead
        // and user code route here for partition names shadowed by RESERVED)
        return (k: unknown) => lens(h.get(String(k)), [...path, String(k)], sink, inflight, h)
      //! data's WRITE builtins must NOT delegate raw (the re-evaluation BLOCKER): h.set/
      // update/patch mutate the LOCAL projection only — no validation, no join, no
      // replication — a silent public-surface desync backdoor contradicting §4.1's
      // "validation covers both by construction". The v2-parity typed idioms ROUTE through
      // the same sink as assignment/delete (Bind.issue — so the validate hook, the join,
      // and post-destroy pin cover them identically); the verbs that cannot be made
      // replication-correct through a lens THROW with the fero-shaped alternative.
      if (prop === 'set')
        return (k: unknown, v: unknown) => void sink([{ type: REC.update, key: [...path, String(k)], value: v }])
      if (prop === 'update')
        return (v: unknown) => {
          if (path.length === 0)
            throw new Error('fero: replace keys (data.k = v), not the resource root — a whole-root overwrite does not replicate')
          sink([{ type: REC.update, key: path, value: v }])
        }
      if (prop === 'remove')
        return () => {
          if (path.length === 0)
            throw new Error('fero: remove() on the resource root is not a write — destroy() the resource instead')
          //! same no-op delete filter as deleteProperty (leaf equivalence, data clause 10c)
          if (h[VALUE] === undefined && !inflight(path)) return
          if (path.length > 1 && up !== undefined) hole(up[VALUE], path.slice(0, -1), path[path.length - 1])
          sink([{ type: REC.remove, key: path }])
        }
      if (prop === 'patch')
        return (pairs: unknown) => {
          if (!Array.isArray(pairs) || pairs.some((p) => !Array.isArray(p) || p.length !== 2))
            throw new Error('fero: patch() takes [key, value] TUPLE pairs — patch([[k1, v1], [k2, v2]])')
          sink((pairs as [unknown, unknown][]).map(([k, v]) => ({ type: REC.update, key: [...path, String(k)], value: v })))
        }
      //! the three refusals below put their pointer on a SECOND line: the one-line forms ran 120-140
      // characters and were the only lines in the example transcripts that wrapped at 80. The clause
      // before ` — ` is byte-identical to before (examples/04-rows prints exactly that clause).
      if (prop === 'insert')
        return () => {
          throw new Error('fero: insert() mints a data-side key that would not replicate — fero owns the key:\n  write a keyed child (data.k = v) or methods.insert()')
        }
      if (prop === 'ingest')
        return () => {
          throw new Error("fero: ingest() is the replication ingress — public writes go through\n  assignment / set / update / patch (they route to fero's issue())")
        }
      if (prop === 'raf')
        return () => {
          throw new Error('fero: raf() writes the local projection directly and would not replicate — coalesce\n  in your own frame callback and assign')
        }
      if (prop === 'dispose')
        return () => {
          throw new Error("fero: dispose() belongs to the projection's lifecycle — destroy() the resource instead")
        }
      if (prop === 'first' || prop === 'last')
        //! wrap as lenses — the raw handles data returns carry the typed write verbs,
        // which would reopen the backdoor one child down (l.first().update(v))
        return () => {
          const snap = (h[VALUE] ?? {}) as Record<string, unknown>
          const keys = Object.keys(snap)
          const k = prop === 'first' ? keys[0] ?? '0' : keys[keys.length - 1] ?? '0'
          return lens(h.get(k), [...path, k], sink, inflight, h)
        }
      if (RESERVED_NAMES.has(prop)) return h[prop] // operators + READ built-ins: v4's own dispatch
      const child = h.get(prop)
      return lens(child, [...path, prop], sink, inflight, h)
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
      // equivalence, data clause 10c) target issues NOTHING — unless one of our own writes to it is
      // still on the wire (V4-7: the fold does not show it yet, but it is not absent). One O(depth)
      // leaf read, one map probe.
      if ((h.get(String(prop)) as any)[VALUE] === undefined && !inflight([...path, String(prop)])) return true
      if (path.length > 0) hole(h[VALUE], path, String(prop))
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

//! mark — the highest live node id in the handle's data runtime. Ids are monotonic, so every node
// minted after a mark carries a greater id; the Host takes one before a handler runs and hands it to
// disposeMinted after (I-29). One walk of the runtime's node registry: ~2µs on a twenty-node graph.
export const mark = (p: any): number => {
  let m = 0
  for (const n of (unwrap(p)[NODE] as DataNode<unknown>).runtime.graph()) if (n.id > m) m = n.id
  return m
}

//! disposeMinted — release the derived views a handler minted for ONE invocation (I-29): from the
// view it returned, walk up the parents and dispose every DERIVED node (an operator, or a scalar such
// as sum()) newer than `mark` — the chain the handler built (ctx.data.filter(…).sort(…)) and nothing
// older: never a source (the resource, a child path of it, the gather's proxy) and never a view that
// existed before the call (a shared module-level view a handler hands out). Data keeps every derived
// node in its parents' `children` until dispose() and re-evaluates it on every commit — without this a
// server carried one dead filter per subscription or one-shot read it ever served.
export const disposeMinted = (view: any, mark: number): void => {
  const n = unwrap(view)?.[NODE]
  if (!(n instanceof DataNode)) return
  const walk = (x: DataNode<unknown>): void => {
    if (x.kind === 'source' || x.id <= mark || x.disposed) return
    const parents = x.parents
    x.dispose()
    for (const parent of parents) walk(parent)
  }
  walk(n)
}

//! derived — how many views hang directly off a handle's node (data's `children`): the I-29 leak-guard
// scalar, the way `served` is the host's — a server that closed every subscription reads 0 again.
export const derived = (p: any): number => (unwrap(p)[NODE] as DataNode<unknown>).children.length
