// E-64 O3: shared helpers. The merge contract's pieces (the total order with key ties, typed bucket keys, the
// numeric projection, the exact sum, the seeded source, the dirty domain) come unchanged from E-57 group B, so
// the partials and the combiner are judged by the contract E-57 checked. Nothing here imports data.
export {
  rng, SLOTS, slotOf, canon, num, svz, bkey, rowCmp, WideSum, E23Sum, applyRec, recKey, makeRow, genPoints, genRoom, keyName, cmpVal, cmpStr,
} from '../../../E57-transforms/b-merge/src/lib.mjs'
export { OrderIndex2 } from '../../../E57-transforms/b-merge/src/index.mjs'
import { WideSum, toUnits, fromUnits } from '../../../E57-transforms/b-merge/src/lib.mjs'

// a slot hash for any slot count (the bench uses 4,096, LAYERS' count; the sim uses E-57's 1,024: more rows a slot)
export function slotOfN(key, S) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return (h >>> 0) % S
}

// the max over numbers (the numeric projection), with +0 above -0 so the answer is one value whatever the order
export const maxBetter = (x, y) => x > y || (x === y && x === 0 && Object.is(y, -0) && !Object.is(x, -0))

// An exact sum's whole state, as a partial hands it out (a copy, so the receiver may keep it)
export function sumState(w) {
  return { p: w.p.slice(), big: w.big, nan: w.nan, pinf: w.pinf, ninf: w.ninf, nf: w.nf, nz: w.nz, n: w.n }
}
export const emptySum = () => ({ p: [], big: null, nan: 0, pinf: 0, ninf: 0, nf: 0, nz: 0, n: 0 })
// add (sign 1) or take out (sign -1) one exact-sum state into an accumulator: exact, since the partials of a
// state are non-overlapping doubles whose sum is the state's exact sum, and the counters add as integers
export function putState(acc, st, sign) {
  acc.nan += sign * st.nan; acc.pinf += sign * st.pinf; acc.ninf += sign * st.ninf
  acc.nf += sign * st.nf; acc.nz += sign * st.nz; acc.n += sign * st.n
  if (st.big !== null) {
    let N = st.big
    while (N !== 0n) { const d = fromUnits(N); N -= toUnits(d); addD(acc, sign * d) }
  }
  for (const x of st.p) addD(acc, sign * x)
}
function addD(acc, x) {
  if (x === 0) return
  if (acc.big !== null) acc.bigAdd(toUnits(x))
  else acc.grow(x)
}
export const newAcc = () => new WideSum()
