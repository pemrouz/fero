// E-67 (copied from E-64 O1 src/lib.mjs; only the import path changed): shared helpers. The merge contract's definitions (the total order, typed bucket keys,
// the numeric projection, the exact sum) are taken from E-57 group B as they are, so the merger is judged by the
// same contract E-57 checked. The ordered index is E-57's D8c prototype (a chunked sorted array, O(log N)).
// Nothing here imports data: partials and merger are plain code, and the oracle is written apart from both.
export { rng, SLOTS, slotOf, canon, num, bkey, rowCmp, cmpVal, cmpStr, WideSum, toUnits, fromUnits, applyRec, recKey, makeRow, genPoints, genRoom, keyName } from '../../E57-transforms/b-merge/src/lib.mjs'
export { OrderIndex2 } from '../../E57-transforms/b-merge/src/index.mjs'
import { toUnits, fromUnits, num, WideSum } from '../../E57-transforms/b-merge/src/lib.mjs'

// The oracle's exact sum: every finite value as an exact BigInt in units of 2^-1074, rounded once at the end.
// Independent of WideSum's partials. NaN is not a number for the projection; the infinities count apart.
export function exactSum(values) {
  let t = 0n, pinf = 0, ninf = 0, nf = 0, nz = 0
  for (const x of values) {
    if (x === Infinity) { pinf++; continue }
    if (x === -Infinity) { ninf++; continue }
    nf++
    if (x === 0) { if (Object.is(x, -0)) nz++; continue }
    t += toUnits(x)
  }
  if (pinf > 0 && ninf > 0) return NaN
  if (pinf > 0) return Infinity
  if (ninf > 0) return -Infinity
  if (nf > 0 && nz === nf) return -0
  const r = fromUnits(t)
  return r === 0 ? 0 : r
}

// Add (sign +1) or take away (sign -1) one WideSum's exact state into another. Exact: each component is added
// with WideSum's own exact step, and the counts add. Used by the merger for a group's whole contribution.
export function wsMerge(dst, src, sign) {
  dst.n += sign * src.n
  dst.nan += sign * src.nan; dst.pinf += sign * src.pinf; dst.ninf += sign * src.ninf
  dst.nf += sign * src.nf; dst.nz += sign * src.nz
  if (src.big !== null) { dst.bigAdd(sign > 0 ? src.big : -src.big); return }
  for (const c of src.p) {
    if (c === 0) continue
    if (dst.big !== null) { dst.bigAdd(sign > 0 ? toUnits(c) : -toUnits(c)); continue }
    dst.grow(sign > 0 ? c : -c)
  }
}
export const newSum = () => new WideSum()
export const isNum = (x) => num(x) !== undefined
