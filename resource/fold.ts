// resource/fold.ts — the distributed-aggregate registry + fold engine (Milestone Q2/Q3).
//
// Two parts. (1) The `AGG` registry: the "two halves of a decomposable aggregate" for every
// supported op, co-located — each entry pairs an owner-scoped PARTIAL builder with the
// associative COMBINE that folds per-holder partials into the global answer. Stateless +
// module-level (a fero() instance pays nothing to reference it); `partial` is a factory over a
// per-instance context, so only the serializable {op,col,val} spec crosses the wire, never a
// closure — every holder reconstructs the same operator. (2) `makeFold(...)`: the per-instance
// fold ENGINE — owner-scoped partial construction (`buildPartial`/`ownedView`/`composite`), the
// live re-scoping partial (`livePartial`), the querying-side one-shot + live gather
// (`gatherOnce`/`gatherLive`), and the lazy fold handle (`foldAggregate`). It closes over a fero()
// node's shared state (the raw `data` proxy, the mesh, the two aggregate registries, clientSubs)
// passed BY REFERENCE, plus `invoke` (the in-process method dispatcher) — the one injected edge
// back to the composer, which doesn't itself depend on the fold engine. The `data` facade and the
// dispatch surface that drive this engine live in [./dispatch.ts].

import { $, value as VALUE, view as VIEWSYM } from '../../data/index.ts'
import { applyRecord } from '../log/index.ts'
import { type ChangeRecord } from '../transport/message.ts'
import { type Mesh } from '../transport/index.ts'
import { lazyHandle, FOLD_ONCE, FOLD_HANDLES, snapshot } from './handle.ts'

// Combine rules for distributed aggregates (Milestone Q2): how N owner-scoped
// partials fold into the global answer. Each is associative + commutative so the
// fold is order-independent across holders.
//   sum/count → Σ (a missing/undefined partial folds as identity 0).
//   max/min   → extremum over the DEFINED partials, skipping undefined (an empty
//               holder publishes undefined, and Math.max(undefined,x) is NaN), so
//               all-undefined ⇒ undefined (matches data's own empty-set semantics).
export type Rule = (values: unknown[]) => unknown
// The SERIALIZABLE aggregate spec that crosses the wire (never a closure): an op plus an optional
// column/value. `FoldSpec` adds the `fold:true` flag a CLIENT sets so a server coordinator folds the
// global rather than returning its own partial. Both narrow from the `unknown`/`any` a method arg
// arrives as — every engine hop below is annotated with which shape it holds, so the spec's identity
// is a type, not three scattered prose notes.
export type AggSpec = { op: string; col?: unknown; val?: unknown }
export type FoldSpec = AggSpec & { fold?: true }
// `?? 0` (null/undefined → identity), NOT `|| 0`: the only legitimate identity is an
// ABSENT partial (undefined seed / a holder owning nothing). `|| 0` would ALSO swallow
// a NaN partial — and data's SumValue (+v) poisons a holder's whole owner-scoped sum to
// NaN on a non-numeric column value — masking a dropped shard as a confidently-wrong
// finite number while the single-node (R≥members) path returns NaN. With `?? 0`, NaN
// propagates to the global, matching single-node. (count partials are always finite, so
// this only affects sum's garbage-in case.)
const sumRule: Rule = (vs) => vs.reduce((a: number, b) => a + (b == null ? 0 : (b as number)), 0)
// NOTE (garbage-in, documented): a non-numeric / NaN column value makes max/min
// ORDER-DEPENDENT (the comparator does no coercion and NaN comparisons are always
// false) — a known edge that resolves once the write path validates/coerces numerics;
// the empty-partial (undefined) case IS handled (skipped), so 0/negatives are exact.
const extremum =
  (better: (a: number, b: number) => boolean): Rule =>
  (vs) => {
    let m: number | undefined
    for (const v of vs) if (v !== undefined && (m === undefined || better(v as number, m))) m = v as number
    return m
  }
// avg folds the per-holder {sum, count} PAIRS and divides LAST (Σsum/Σcount) — exact,
// unlike average-of-averages. Empty (Σcount === 0) ⇒ undefined, matching data's AvgValue.
const avgRule: Rule = (vs) => {
  let s = 0
  let c = 0
  // `?? 0` (not `|| 0`) on .sum so a NaN-poisoned local shard (data's SumValue does `+v`,
  // NaN on a non-numeric column) PROPAGATES to the global, matching single-node `data.avg`
  // and sumRule's own ?? 0 — `|| 0` would mask it to a confidently-wrong finite number.
  // count is always finite (a row count). (A REMOTE NaN already arrives as null via the JSON
  // wire codec — the documented value-codec limitation — where ?? and || agree.)
  for (const v of vs) if (v != null) { s += (v as any).sum ?? 0; c += (v as any).count ?? 0 }
  return c === 0 ? undefined : s / c
}
// some = OR: any holder with a match ⇒ Σ(match counts) > 0. Empty ⇒ 0 ⇒ false.
const someRule: Rule = (vs) => {
  let s = 0
  for (const v of vs) if (v != null) s += (v as number) || 0
  return s > 0
}
// every = AND: all rows match ⇒ Σmatch === Σtotal across holders. Empty ⇒ 0===0 ⇒ true.
const everyRule: Rule = (vs) => {
  let m = 0
  let t = 0
  for (const v of vs) if (v != null) { m += (v as any).match || 0; t += (v as any).total || 0 }
  return m === t
}
// rows = UNION (Milestone Q3): fold each holder's owner-scoped row-set OBJECT into the whole
// resource. Object.assign by key — owner-scoping makes the keysets disjoint (no collision), and
// even under transient ring disagreement (two holders briefly claiming a key) the merge is
// idempotent (the key lands once, same replicated value), unlike a scalar Σ which would double.
// A missing/undefined partial (an empty-owned holder, or a wire-failed remote) folds as the
// empty contribution. This is the "download everything to one node" gather — the whole-resource
// snapshot/stream holistic operators (sort/distinct/group/reduce) compute over locally.
const unionRule: Rule = (vs) => Object.assign({}, ...vs.filter((o) => o != null && typeof o === 'object'))

// ── Distributed aggregate registry (Milestone Q2/Q3) ──
// One entry per op pairs its owner-scoped PARTIAL builder with the associative COMBINE that
// folds partials into the global answer — the two halves of a decomposable aggregate,
// co-located so adding/changing an op is ONE edit. `combine` is stateless + module-level (a
// fero() instance pays nothing to reference it) and associative + commutative (order-
// independent across holders). `partial` is a factory over a per-instance context (the
// owner-scoped `owned` view + the `composite` builder); only the {op,col,val} spec crosses the
// wire, never a closure — every holder reconstructs the same operator from the spec.
type PartialCtx = { owned: any; col?: any; val?: any; composite: (out: any, fields: Record<string, any>) => any }
export const AGG: Record<string, { partial: (c: PartialCtx) => any; combine: Rule }> = {
  sum: { partial: ({ owned, col }) => owned.sum(col), combine: sumRule },
  count: { partial: ({ owned }) => owned.length(), combine: sumRule },
  max: { partial: ({ owned, col }) => owned.max(col), combine: extremum((a, b) => a > b) },
  min: { partial: ({ owned, col }) => owned.min(col), combine: extremum((a, b) => a < b) },
  // avg ships a {sum, count} PAIR (data's AvgValue exposes only the quotient — average-of-
  // averages is wrong). count = #owned rows with a DEFINED projected value (matching AvgValue);
  // avgRule divides Σsum/Σcount last.
  avg: {
    partial: ({ owned, col, composite }) => {
      const defined = col != null ? (r: any) => r?.[col] != null : (r: any) => r != null
      return composite($({ sum: 0, count: 0 }), { sum: owned.sum(col), count: owned.filter(defined).length() })
    },
    combine: avgRule,
  },
  // some/every take a DECLARATIVE predicate (col[, val]) — a closure can't cross the wire
  // (use a named method for that). some ships this holder's MATCH COUNT (someRule: Σ>0 ⇒ any
  // match); every ships {match, total} (everyRule: Σmatch===Σtotal ⇒ all; empty ⇒ 0===0 ⇒ true).
  some: { partial: ({ owned, col, val }) => owned.filter(col, val).length(), combine: someRule },
  every: {
    partial: ({ owned, col, val, composite }) =>
      composite($({ match: 0, total: 0 }), { match: owned.filter(col, val).length(), total: owned.length() }),
    combine: everyRule,
  },
  // 'rows' (Q3): this holder's OWNER-SCOPED row set itself (not a scalar) — the per-shard
  // partial a whole-resource GATHER unions by key (unionRule) into the whole resource (the
  // "download everything" before holistic ops run locally). Owner-scoped ⇒ a disjoint cover
  // (each row once, 1× wire); the union is idempotent by key, so it tolerates ring churn.
  rows: { partial: ({ owned }) => owned, combine: unionRule },
}

// ── The per-instance fold ENGINE (Milestone Q2b/Q2c/Q3) ──
// Built once per fero() node. The shared state it closes over is passed BY REFERENCE so the
// composer's view-commit / anti-entropy loops and `destroy` stay coherent with what the engine
// mutates (aggregateRebinds/aggregateReconciles/clientSubs). `invoke` is the in-process method
// dispatcher (it runs the local `aggregate` method = buildPartial); it lives in the composer and
// does NOT depend on this engine, so injecting it keeps construction linear (fold built before the
// dispatch surface that consumes its entry points).
export type FoldDeps = {
  data: any // the RAW $({}) source-of-truth proxy — ownedView filters it (never the dataFacade, which would recurse into remote handles)
  mesh: Mesh // L0 routing/membership: owner / viewMembers / subscribe / call
  me: string | undefined // this server's listen address; undefined on a read-only client. Self is NOT a wire target.
  invoke: (method: string, arg: unknown, peer?: string) => unknown // in-process dispatcher; invoke('aggregate', spec) = this node's local partial
  aggregateRebinds: Set<() => void> // live owner-scoped partials to re-scope on a view commit (walked by the composer's onCommit)
  aggregateReconciles: Set<() => void> // live folds to reconcile holders on commit + AE tick (walked by the composer)
  clientSubs: Set<() => void> // teardown callbacks drained by destroy (a fold handle's gatherLive close lands here)
}

export const makeFold = ({ data, mesh, me, invoke, aggregateRebinds, aggregateReconciles, clientSubs }: FoldDeps) => {
  // The engine's functions split on two axes — LOCAL (this node's owned shard) vs GLOBAL gather
  // (fold across holders), and ONE-SHOT (await) vs LIVE (subscription):
  //                │ one-shot                │ live
  //   ─────────────┼─────────────────────────┼──────────────────────────
  //   local shard  │ buildPartial            │ livePartial
  //   global fold  │ gatherOnce              │ gatherLive
  //   foldAggregate is the lazy handle that is BOTH (await ⇒ gatherOnce, real access ⇒ gatherLive).
  //
  // OWNER-scoping (not holder-scoping) is the dedup: a partition lives on R replicas but has exactly
  // ONE owner, so scoping each holder's partial to the partitions it OWNS makes the union a DISJOINT
  // cover — every row counted once regardless of R. Filters the RAW `data` proxy; `data`'s filter
  // passes the key to its predicate, and ownership exactly partitions the keyspace.
  const ownedView = () => (data as any).filter((_v: unknown, k: string) => mesh.owner(k) === me)

  // A COMPOSITE partial (avg's {sum,count}, every's {match,total}) mirrors two O(1) aggregate
  // sub-views onto one object ViewProxy. (1) A `data` ViewProxy is `typeof === 'function'`, so it
  // can't be a connect ANCHOR — we mirror via a plain anchor + assignment into `out`; (2) data's
  // FunctionSink doesn't back-ref its source, so the sub-views would GC and freeze — `aggRetain`
  // (keyed by the returned proxy) pins them for exactly as long as `out` is reachable.
  const aggRetain = new WeakMap<object, unknown[]>()
  const composite = (out: any, fields: Record<string, any>): any => {
    const anchor = {}
    const retain: unknown[] = [anchor]
    for (const [prop, view] of Object.entries(fields)) {
      view.connect(anchor, () => {
        out[prop] = (view as any)[VALUE]
      })
      retain.push(view)
    }
    aggRetain.set(out, retain)
    return out
  }

  // This node's owner-scoped PARTIAL for a serializable spec ({op,col,val}). Dispatches into the
  // AGG registry (above): each op pairs its owner-scoped PARTIAL builder with the associative
  // COMBINE. Owner-scoped over the RAW proxy via ownedView — so the union across holders is a
  // disjoint cover. The spec (never a closure) is what crosses the wire to symmetric holders.
  const buildPartial = (spec: AggSpec): any => {
    const entry = AGG[spec?.op]
    if (!entry) throw new Error(`fero: unknown aggregate op "${spec?.op}"`)
    return entry.partial({ owned: ownedView(), col: spec?.col, val: spec?.val, composite })
  }

  // A LIVE owner-scoped partial (Q2c): streams buildPartial(spec)'s value to `onValue` (initial +
  // every delta) and RE-SCOPES itself on a view commit (ownership re-evaluated over the new ring).
  // data's filter won't re-run its predicate on an ownership move under a stable row, and its prior
  // FunctionSink CANNOT be synchronously disconnected (data's connect returns the host, not the
  // sink), so a GENERATION guard makes the stale generation's firings no-ops. The rebuilt chain
  // stays connected to the LIVE raw `data`, so an acquired partition's inbound rows re-fire the
  // filter and re-publish — the acquisition-window heal, no synthetic re-fold. Used by BOTH a
  // holder's served partial and a fold's local self-partial.
  const livePartial = (spec: AggSpec, onValue: (v: unknown) => void) => {
    let gen = 0
    let proxy: any // retained so the current generation's chain doesn't GC (FunctionSink doesn't back-ref it)
    let host: any
    const build = () => {
      const myGen = ++gen
      proxy = buildPartial(spec)
      // Emit the whole partial SNAPSHOT (not c.value): an OBJECT partial (avg/every) emits per-KEY
      // change records whose c.value is one field — only the snapshot carries the full {…}.
      host = proxy.connect({}, () => {
        if (gen === myGen) onValue(snapshot(proxy))
      })
    }
    build() // connect's attach-snapshot calls onValue synchronously with the current value
    const rescope = () => build()
    aggregateRebinds.add(rescope)
    return {
      close: () => {
        aggregateRebinds.delete(rescope)
        gen++ // silence any in-flight firing
        void proxy
        void host
      },
    }
  }

  // One-shot distributed GATHER: the local owner-scoped partial in-process (self is not a wire
  // target — mesh.call(...,me) can't route to self) + a call to every OTHER view member, folded
  // once through the associative `rule`. A connected-but-unresponsive holder folds as the identity
  // after the call timeout (a known silent undercount — gather hardening is deferred). Stateless, so
  // it reflects the CURRENT ring per call. Backs `await data.sum(...)`, serveCall's client one-shot,
  // and the no-key read() gather.
  const gatherOnce = async (spec: AggSpec, rule: Rule): Promise<unknown> => {
    const local = snapshot(invoke('aggregate', spec))
    const others = mesh.viewMembers().filter((m) => m !== me)
    const remotes = await Promise.all(others.map((o) => (mesh.call('aggregate', spec, o) as Promise<unknown>).catch(() => undefined)))
    return rule([local, ...remotes])
  }

  // A LIVE fold: a result proxy whose root is refolded on every partial delta, with close() to tear
  // it down. The querier's OWN shard is an in-process livePartial (re-scopes on the querier's own
  // commit); remote holders are subscriptions in `subs`, each re-scoping its OWN served partial and
  // pushing over the EXISTING subscription — so the coordinator never re-subscribes a stable holder,
  // only adds new members / drops departed ones (reconcileMembers, run on commit + aeTimer). One row
  // change → one partial delta → one O(holders) recompute. Serves the local fold handle AND a
  // client's gather/aggregate subscription.
  const gatherLive = (spec: AggSpec, rule: Rule) => {
    const live: any = $({})
    const liveRes = (live as any)[VIEWSYM].res
    const partials = new Map<string, unknown>()
    const recombine = () => applyRecord(liveRes, { type: 'update', key: [], value: rule([...partials.values()]) })
    let localPartial: { close: () => void } | undefined
    const subs = new Map<string, () => void>() // member → unsubscribe (only the ones actually subscribed)
    const reconcileMembers = () => {
      const members = new Set(mesh.viewMembers())
      for (const [m, unsub] of subs) if (!members.has(m)) { unsub(); subs.delete(m) } // departed → close the subscription
      // Drop any partial for a non-member (a subscribed-then-departed holder AND an admit-race member
      // seeded in `partials` but never subscribed, then gone — keying off `partials` reaps both).
      for (const m of [...partials.keys()]) if (m !== me && !members.has(m)) partials.delete(m)
      for (const m of members) {
        if (m === me || subs.has(m)) continue
        if (!partials.has(m)) partials.set(m, undefined) // identity until its first snapshot arrives
        const unsub = mesh.subscribe('aggregate', spec, (rec: ChangeRecord) => { partials.set(m, rec.value); recombine() }, m)
        if (unsub) subs.set(m, unsub) // only mark subscribed on success — an unreachable member is RETRIED next tick (admit race)
      }
      recombine()
    }
    localPartial = livePartial(spec, (v) => { partials.set(me!, v); recombine() })
    reconcileMembers()
    aggregateReconciles.add(reconcileMembers) // commit + aeTimer: add/drop holders + retry the admit race
    const close = () => {
      aggregateReconciles.delete(reconcileMembers)
      for (const unsub of subs.values()) unsub()
      subs.clear()
      localPartial?.close()
    }
    return { proxy: live, close }
  }

  // The querying-side FOLD HANDLE (mirrors makeHandle): a lazyHandle that is a thenable (await ⇒
  // gatherOnce one-shot) AND a live ViewProxy (real access ⇒ open()s gatherLive and delegates). Exposes
  // the FOLD_ONCE resolver via extraGet (runs BEFORE lazyHandle's symbol-reject) so snapshot() can
  // resolve a RETURNED handle to a one-shot global without opening the live fold; registers in
  // FOLD_HANDLES so snapshot() identifies it. Used by the `data` facade's distributed() and the
  // no-key read() gather memo (both in [./dispatch.ts]).
  const foldAggregate = (spec: AggSpec) => {
    const rule = AGG[spec.op]?.combine
    const handle = lazyHandle({
      then: (onF, onR) => gatherOnce(spec, rule).then(onF, onR),
      extraGet: (prop) => (prop === FOLD_ONCE ? { v: () => gatherOnce(spec, rule) } : undefined),
      open: () => {
        const opened = gatherLive(spec, rule)
        clientSubs.add(opened.close) // cleaned on node destroy (per-handle GC is the inherited Q1 item)
        return opened.proxy
      },
    })
    FOLD_HANDLES.add(handle) // SOLE writer of FOLD_HANDLES (sole reader: snapshot() in handle.ts) — so snapshot() resolves a RETURNED handle via gatherOnce (M2)
    return handle
  }

  return { ownedView, buildPartial, livePartial, gatherOnce, gatherLive, foldAggregate }
}

export type Fold = ReturnType<typeof makeFold>
