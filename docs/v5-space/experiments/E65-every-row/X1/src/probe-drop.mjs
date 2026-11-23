// E-65 X1 probe: does data free a source's rows when the asker drops the source? A hold that ends (or is ended
// past the memory budget) must give its memory back. Three rounds of 1e5 small rows per way:
//   drop     the handle and the lane are dropped (set to null)
//   dispose  src.dispose(), then dropped
//   clear    every row removed through the lane first, then disposed and dropped
// After each round: the heap after a full collection.
import { loadData, out, gc, heapUsed } from './lib.mjs'
const D = await loadData()
const NODE = Symbol.for('data.v4.node')
const mb = () => { gc(); return +(heapUsed() / 2 ** 20).toFixed(1) }
const res = {}
for (const way of ['drop', 'dispose', 'clear']) {
  const after = [], start = mb()
  for (let round = 0; round < 3; round++) {
    let src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
    for (let i = 0; i < 100000; i += 1000) { const b = []; for (let j = i; j < i + 1000; j++) b.push({ type: 1, key: [], at: way + round + 'k' + j, value: { a: j, s: 'x' + j, t: 'title ' + j } }); lane(b) }
    if (way === 'clear') { const b = []; src[NODE].each((k) => b.push({ type: 2, key: [k] })); lane(b) }
    if (way !== 'drop') src.dispose()
    src = null; lane = null
    after.push(mb())
  }
  res[way] = { start_mb: start, after_each_round_mb: after, kept_mb_per_round: +((after[2] - start) / 3).toFixed(1) }
}
out({ exp: 'E-65', opt: 'X1', bench: 'probe-drop', rows_per_round: 100000, node: process.version, ...res })
