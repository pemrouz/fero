//! ── api/substrate — the ONE seam onto the `data` sibling library ─────────────
// plan §10 named three substrate contract points (record-apply ingress, a
// non-cloning capture sink, synchronous detach) and a fallback posture: a thin
// typed wrapper over the symbol reach-through, NOT a fork. This file IS that
// wrapper — everything else in api/ consumes these functions and never touches
// data internals. The contract facts below are PROBED against data HEAD (M5a),
// not assumed:
//
//   - a bare-attach sink (an object with verb methods, `proxy.connect(sink)`)
//     gets NO initial emit and NO clones — record values arrive by reference,
//     which is what keeps the capture path off the structuredClone tax that ate
//     ~30-40% of v2's write budget (plan §10). The view holds it by WeakRef
//     only, so the CALLER must retain the sink (Capture does) — and detach is
//     synchronous via view.disconnect(sink).
//   - `[view].res.update/insert/remove(value, key, at?)` honor arbitrary key
//     paths (the proxy-level `.update()` does NOT — it ignores the key arg) and
//     fan out synchronously, auto-creating nested intermediates.
//   - echo verbs are REWRITTEN by the substrate: an update applied to a fresh
//     key echoes as an INSERT (BI0), an insert to an existing key as an UPDATE
//     (BU1), a ref-equal update not at all. Echo suppression therefore matches
//     by CELL + value identity (api/data.ts), never by verb or record equality.
//   - a write issued from inside a sink callback (a user tap reacting to an
//     inbound apply) is deferred to the substrate's pending queue and drained
//     INSIDE the outer apply call — so suppression must consume exactly ONE
//     expected echo and capture everything else, never blanket-flag a window.

import { $, value as VALUE, view as VIEW } from '../../../data/index.ts'
import { REC, type Rec } from '../kernel/env.ts'

//! proxy — mint the user-facing ViewProxy (data's `$`). Typed `any` HERE and only here: data's own
// surface types exist but its proxy is structurally dynamic; api/types.ts re-types fero's surface.
export const proxy = (initial: unknown = {}): any => $(initial)

//! snapshot — the raw current value (data's `[value]` hatch).
export const snapshot = (p: any): unknown => p[VALUE]

//! applyRec — the record-apply ingress: one committed/optimistic Rec into the proxy, fanning to every
// sink synchronously. The v3 record IS the substrate record (REC numeric type aside), so this is pure
// dispatch — the one place the `view` symbol is ever dereferenced for writing.
export const applyRec = (p: any, r: Rec): void => {
  const res = p[VIEW].res
  if (r.type === REC.remove) res.remove(r.key)
  else if (r.type === REC.insert) res.insert(r.value, r.key, String(r.at ?? ''))
  else res.update(r.value, r.key)
}

//! isProxy — the return-type dispatch probe (plan §9: a method returning a ViewProxy is subscribable;
// anything else is a value). The view symbol is the identity test, at this one seam.
export const isProxy = (x: unknown): boolean =>
  (typeof x === 'function' || (typeof x === 'object' && x !== null)) && (x as Record<symbol, unknown>)[VIEW] !== undefined

//! records — a RECORD-interface subscription (data's FunctionSink): fn gets data-native change records
// {type:'update'|'insert'|'remove'|'move', key, value, at?}, values CLONED by the substrate, plus an
// INITIAL whole-value snapshot record on attach — exactly the shape a method-subscription stream wants
// (M5c). The substrate has no public detach for function sinks (GC-driven via the anchor), so stop()
// is a latch + anchor release: emission stops synchronously, collection follows.
export const records = (p: any, fn: (rec: { type: string; key: string[]; value?: unknown; at?: string }) => void): { stop(): void } => {
  let dead = false
  let anchor: object | null = { fero: 'sub' } // the strong ref that keeps the sink alive (substrate lifetimes contract)
  p.connect(anchor, (rec: { type: string; key: string[]; value?: unknown; at?: string }) => { if (!dead) fn(rec) })
  return { stop() { dead = true; anchor = null } }
}

//! applyStreamRec — fold one DATA-NATIVE stream record (string types — the SUBREC body is opaque to
// the kernel) into a local mirror proxy. The root snapshot record replaces wholesale; 'move' records
// are skipped (api/methods.ts banner: windowed sorts are not a streamable shape in M5c — sort on the
// client proxy instead).
export const applyStreamRec = (p: any, r: { type: string; key?: string[]; value?: unknown; at?: unknown }): void => {
  const res = p[VIEW].res
  const key = Array.isArray(r.key) ? r.key : []
  if (r.type === 'update') res.update(r.value, key)
  else if (r.type === 'insert') res.insert(r.value, key, String(r.at ?? ''))
  else if (r.type === 'remove') res.remove(key)
}

//! Capture: the strongly-held write-capture subscription — detach() is synchronous and terminal.
export interface Capture { detach(): void }

//! capture — attach a bare-verb sink translating substrate notifications into Rec[] batches (one
// onRecs call per verb emission: a single assignment is a batch of 1; a patch() is one batch of N).
// Values pass through BY REFERENCE (no clones — the kernel owns records on hand-over, and data has
// already installed the same reference in the proxy, so ownership is genuinely shared-immutable).
// Root replaces (XU0/XR0) are REJECTED loudly: a whole-resource overwrite has no honest per-partition
// wire meaning — replace keys, not the root. The throw surfaces at the user's assignment site
// (substrate contract: sink exceptions rethrow to the mutator after the cascade).
export const capture = (p: any, onRecs: (recs: Rec[]) => void): Capture => {
  const rootReplace = () => {
    throw new Error('fero: replace keys (data.k = v), not the resource root — a whole-root overwrite does not replicate')
  }
  const sink = {
    XU0: rootReplace,
    XR0: rootReplace,
    BU1(U1: unknown[]) {
      const out: Rec[] = []
      for (let i = 0; i < U1.length; i += 2) out.push({ type: REC.update, key: [String(U1[i])], value: U1[i + 1] })
      onRecs(out)
    },
    BU2(U2: unknown[]) {
      const out: Rec[] = []
      for (let i = 0; i < U2.length; i += 2) out.push({ type: REC.update, key: (U2[i] as string[]).map(String), value: U2[i + 1] })
      onRecs(out)
    },
    BI0(I0: unknown[]) {
      const out: Rec[] = []
      for (let i = 0; i < I0.length; i += 2) out.push({ type: REC.insert, key: [], value: I0[i + 1], at: String(I0[i]) })
      onRecs(out)
    },
    BI2(I2: unknown[]) {
      const out: Rec[] = []
      for (let i = 0; i < I2.length; i += 3) out.push({ type: REC.insert, key: (I2[i] as string[]).map(String), value: I2[i + 1], at: String(I2[i + 2]) })
      onRecs(out)
    },
    //! BR1 skips value === undefined rows by SUBSTRATE contract (array shift signals, not removes)
    BR1(R1: unknown[]) {
      const out: Rec[] = []
      for (let i = 0; i < R1.length; i += 2) if (R1[i + 1] !== undefined) out.push({ type: REC.remove, key: [String(R1[i])] })
      if (out.length) onRecs(out)
    },
    BR2(R2: unknown[]) {
      const out: Rec[] = []
      for (let i = 0; i < R2.length; i += 2) out.push({ type: REC.remove, key: (R2[i] as string[]).map(String) })
      onRecs(out)
    },
  }
  p.connect(sink)
  return {
    detach() { p[VIEW].disconnect(sink) },
  }
}
