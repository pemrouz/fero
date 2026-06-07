// resource/fold.ts — the distributed-aggregate registry (Milestone Q2/Q3).
//
// The "two halves of a decomposable aggregate" for every supported op, co-located: each
// AGG entry pairs an owner-scoped PARTIAL builder with the associative COMBINE that folds
// per-holder partials into the global answer. Stateless + module-level (a fero() instance
// pays nothing to reference it); `partial` is a factory over a per-instance context, so only
// the serializable {op,col,val} spec crosses the wire, never a closure — every holder
// reconstructs the same operator. L2 ([./index.ts]) builds a node's partial via
// `AGG[op].partial(ctx)` and folds remote partials via `AGG[op].combine`.

import { $ } from '../../data/index.ts'

// Combine rules for distributed aggregates (Milestone Q2): how N owner-scoped
// partials fold into the global answer. Each is associative + commutative so the
// fold is order-independent across holders.
//   sum/count → Σ (a missing/undefined partial folds as identity 0).
//   max/min   → extremum over the DEFINED partials, skipping undefined (an empty
//               holder publishes undefined, and Math.max(undefined,x) is NaN), so
//               all-undefined ⇒ undefined (matches data's own empty-set semantics).
export type Rule = (values: unknown[]) => unknown
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
