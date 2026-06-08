// resource/fold.ts — the distributed-aggregate registry (AGG) + per-instance fold ENGINE (makeFold).

import { $, value as VALUE, view as VIEWSYM } from '../../data/index.ts'
import { applyRecord } from '../log/index.ts'
import { type ChangeRecord } from '../transport/message.ts'
import { type Mesh } from '../transport/index.ts'
import { lazyHandle, FOLD_ONCE, FOLD_HANDLES, forWire } from './handle.ts'

// `Rule`: associative+commutative COMBINE folding N owner-scoped partials → the global answer.
export type Rule = (values: unknown[]) => unknown
// `AggSpec`/`FoldSpec`: the serializable {op,col,val} spec that crosses the wire (never a closure).
export type AggSpec = { op: string; col?: unknown; val?: unknown }
export type FoldSpec = AggSpec & { fold?: true }
// sumRule: Σ partials with `?? 0` (absent=identity), NOT `|| 0` — so a NaN-poisoned shard propagates.
const sumRule: Rule = (vs) => vs.reduce((a: number, b) => a + (b == null ? 0 : (b as number)), 0)
// extremum (max/min): fold the DEFINED partials only, skipping undefined ⇒ all-undefined ⇒ undefined.
const extremum =
  (better: (a: number, b: number) => boolean): Rule =>
  (vs) => {
    let m: number | undefined
    for (const v of vs) if (v !== undefined && (m === undefined || better(v as number, m))) m = v as number
    return m
  }
// avgRule: fold {sum,count} PAIRS, divide LAST (Σsum/Σcount) — exact, unlike average-of-averages.
const avgRule: Rule = (vs) => {
  let s = 0
  let c = 0
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
// unionRule (rows): Object.assign each holder's owner-scoped row-set by key — disjoint cover, idempotent.
const unionRule: Rule = (vs) => Object.assign({}, ...vs.filter((o) => o != null && typeof o === 'object'))

// ── Distributed aggregate registry (Milestone Q2/Q3) ──
type PartialCtx = { owned: any; col?: any; val?: any; composite: (out: any, fields: Record<string, any>) => any }
export const AGG: Record<string, { partial: (c: PartialCtx) => any; combine: Rule }> = {
  sum: { partial: ({ owned, col }) => owned.sum(col), combine: sumRule },
  count: { partial: ({ owned }) => owned.length(), combine: sumRule },
  max: { partial: ({ owned, col }) => owned.max(col), combine: extremum((a, b) => a > b) },
  min: { partial: ({ owned, col }) => owned.min(col), combine: extremum((a, b) => a < b) },
  avg: {
    partial: ({ owned, col, composite }) => {
      const defined = col != null ? (r: any) => r?.[col] != null : (r: any) => r != null
      return composite($({ sum: 0, count: 0 }), { sum: owned.sum(col), count: owned.filter(defined).length() })
    },
    combine: avgRule,
  },
  some: { partial: ({ owned, col, val }) => owned.filter(col, val).length(), combine: someRule },
  every: {
    partial: ({ owned, col, val, composite }) =>
      composite($({ match: 0, total: 0 }), { match: owned.filter(col, val).length(), total: owned.length() }),
    combine: everyRule,
  },
  rows: { partial: ({ owned }) => owned, combine: unionRule },
}

// ── The per-instance fold ENGINE (Milestone Q2b/Q2c/Q3) ──
// `FoldDeps`: the fero() node's shared state the engine closes over BY REFERENCE + the injected `invoke`.
export type FoldDeps = {
  data: any
  mesh: Mesh
  me: string | undefined
  invoke: (method: string, arg: unknown, peer?: string) => unknown
  aggregateRebinds: Set<() => void>
  aggregateReconciles: Set<() => void>
  clientSubs: Set<() => void>
}

// `makeFold`: build the engine — local/global × one-shot/live, all owner-scoped so the union dedups.
export const makeFold = ({ data, mesh, me, invoke, aggregateRebinds, aggregateReconciles, clientSubs }: FoldDeps) => {
  // ownedView: filter the RAW proxy to the keys THIS node owns — the disjoint per-shard scope.
  const ownedView = () => (data as any).filter((_v: unknown, k: string) => mesh.owner(k) === me)

  // composite: mirror two O(1) sub-views onto one object proxy (avg/every), aggRetain pinning them.
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

  // buildPartial: this node's owner-scoped partial for a spec, dispatched through the AGG registry.
  const buildPartial = (spec: AggSpec): any => {
    const entry = AGG[spec?.op]
    if (!entry) throw new Error(`fero: unknown aggregate op "${spec?.op}"`)
    return entry.partial({ owned: ownedView(), col: spec?.col, val: spec?.val, composite })
  }

  // livePartial: stream the owner-scoped partial, re-scoping (via a GENERATION guard) on each commit.
  const livePartial = (spec: AggSpec, onValue: (v: unknown) => void) => {
    let gen = 0
    let proxy: any
    let host: any
    const build = () => {
      const myGen = ++gen
      proxy = buildPartial(spec)
      // Emit the whole partial SNAPSHOT (not c.value): an OBJECT partial (avg/every) emits per-KEY
      host = proxy.connect({}, () => {
        if (gen === myGen) onValue(forWire(proxy))
      })
    }
    build()
    const rescope = () => build()
    aggregateRebinds.add(rescope)
    return {
      close: () => {
        aggregateRebinds.delete(rescope)
        gen++
        void proxy
        void host
      },
    }
  }

  // gatherOnce: local partial in-process + a call to every OTHER view member, folded once via `rule`.
  const gatherOnce = async (spec: AggSpec, rule: Rule): Promise<unknown> => {
    const local = forWire(invoke('aggregate', spec))
    const others = mesh.viewMembers().filter((m) => m !== me)
    const remotes = await Promise.all(others.map((o) => (mesh.call('aggregate', spec, o) as Promise<unknown>).catch(() => undefined)))
    return rule([local, ...remotes])
  }

  // gatherLive: a result proxy refolded on every partial delta — local livePartial + per-holder subs.
  const gatherLive = (spec: AggSpec, rule: Rule) => {
    const live: any = $({})
    const liveRes = (live as any)[VIEWSYM].res
    const partials = new Map<string, unknown>()
    const recombine = () => applyRecord(liveRes, { type: 'update', key: [], value: rule([...partials.values()]) })
    let localPartial: { close: () => void } | undefined
    const subs = new Map<string, () => void>()
    // reconcileMembers: drop departed holders, subscribe new ones, retry the admit race — never re-sub a stable holder.
    const reconcileMembers = () => {
      const members = new Set(mesh.viewMembers())
      for (const [m, unsub] of subs) if (!members.has(m)) { unsub(); subs.delete(m) }
      for (const m of [...partials.keys()]) if (m !== me && !members.has(m)) partials.delete(m)
      for (const m of members) {
        if (m === me || subs.has(m)) continue
        if (!partials.has(m)) partials.set(m, undefined)
        const unsub = mesh.subscribe('aggregate', spec, (rec: ChangeRecord) => { partials.set(m, rec.value); recombine() }, m)
        if (unsub) subs.set(m, unsub)
      }
      recombine()
    }
    localPartial = livePartial(spec, (v) => { partials.set(me!, v); recombine() })
    reconcileMembers()
    aggregateReconciles.add(reconcileMembers)
    const close = () => {
      aggregateReconciles.delete(reconcileMembers)
      for (const unsub of subs.values()) unsub()
      subs.clear()
      localPartial?.close()
    }
    return { proxy: live, close }
  }

  // foldAggregate: the lazy fold handle — await ⇒ gatherOnce, real access ⇒ gatherLive; FOLD_ONCE/FOLD_HANDLES wired for forWire().
  const foldAggregate = (spec: AggSpec) => {
    const rule = AGG[spec.op]?.combine
    const handle = lazyHandle({
      then: (onF, onR) => gatherOnce(spec, rule).then(onF, onR),
      extraGet: (prop) => (prop === FOLD_ONCE ? { v: () => gatherOnce(spec, rule) } : undefined),
      open: () => {
        const opened = gatherLive(spec, rule)
        clientSubs.add(opened.close)
        return opened.proxy
      },
    })
    FOLD_HANDLES.add(handle)
    return handle
  }

  return { ownedView, buildPartial, livePartial, gatherOnce, gatherLive, foldAggregate }
}

export type Fold = ReturnType<typeof makeFold>
