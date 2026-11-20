// XB-1, correctness: the O(log N) ordered index (src/index.mjs) behind a leaderboard. A data source of rows
// { points, other }, values 0..999 (ties common); inserts, removes, sort-field writes, other-field writes, one
// commit each or in batches of 2 to 256. After every commit the window (za('points', 10) by the index) equals a
// sort from scratch of the source's rows (the key sequence, ties by key), and every 25 commits the whole index
// does too. Planted (MUTATE=prev): a remove bisects with the NEW row instead of prev, so stale entries stay.
//   node xb1-index.mjs <seeds> <commits> <rows>
import { rng, canon, rowCmp, applyRec, cmpVal, cmpStr } from '../src/lib.mjs'
import { D, laneOf } from '../src/ops.mjs'
import { WindowIndex } from '../src/index.mjs'

const SEEDS = +(process.argv[2] ?? 1000), COMMITS = +(process.argv[3] ?? 200), ROWS = +(process.argv[4] ?? 2000)
const MUTATE = process.env.MUTATE ?? ''
const T = { seeds: 0, windowChecks: 0, windowBad: 0, fullChecks: 0, fullBad: 0, seedsFailed: 0, misses: 0, batches: 0 }
let first = null
for (let seed = 1; seed <= SEEDS; seed++) {
  const R = rng(seed * 3 + 1)
  const truth = new Map()
  const init = {}
  for (let i = 0; i < ROWS; i++) { const k = 'k' + i; const row = { points: Math.floor(R() * 1000), other: Math.floor(R() * 9) }; init[k] = row; truth.set(k, row) }
  const src = D.$(init)
  const lane = laneOf(src)
  const W = new WindowIndex(src, 'points', 'za', 10, { mutate: MUTATE })
  const cmp = (a, b) => cmpVal('za', a[1].points, b[1].points) || cmpStr(a[0], b[0])
  let bad = 0
  for (let c = 0; c < COMMITS; c++) {
    const n = R() < 0.2 ? 2 + Math.floor(R() * 255) : 1
    if (n > 1) T.batches++
    const recs = [], used = new Set()
    for (let i = 0; i < n; i++) {
      const k = 'k' + Math.floor(R() * (ROWS * 1.1))
      if (used.has(k)) continue
      used.add(k)
      const u = R()
      if (!truth.has(k)) recs.push({ type: 1, key: [], at: k, value: { points: Math.floor(R() * 1000), other: 0 } })
      else if (u < 0.6) recs.push({ type: 0, key: [k, 'points'], value: Math.floor(R() * 1000) })
      else if (u < 0.85) recs.push({ type: 0, key: [k, 'other'], value: Math.floor(R() * 9) })
      else recs.push({ type: 2, key: [k] })
    }
    lane(recs)
    for (const r of recs) applyRec(truth, r)
    const sorted = [...truth].sort(cmp).map((e) => e[0])
    T.windowChecks++
    if (canon(W.win) !== canon(sorted.slice(0, 10))) { T.windowBad++; bad++; if (first === null) first = `seed ${seed} commit ${c}: ${canon(W.win)} vs ${canon(sorted.slice(0, 10))}` }
    if (c % 25 === 24) { T.fullChecks++; const ks = W.ix.keys(); if (canon(ks) !== canon(sorted)) { T.fullBad++; bad++; if (first === null) first = `seed ${seed} commit ${c}: index has ${ks.length} entries, rows ${sorted.length}` } }
  }
  T.misses += W.misses
  W.dispose()
  T.seeds++
  if (bad) T.seedsFailed++
}
console.log(JSON.stringify({ exp: 'E-57', part: 'b-merge', claim: 'XB-1', bench: 'index-oracle', planted: MUTATE || null, seeds: SEEDS, commits: COMMITS, rows: ROWS, ...T, first }))
