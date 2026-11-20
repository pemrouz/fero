// E-58 timing T2: what data's read rule costs a field link, beside E-55's rule, on E-55's prototype and data's engine.
// One row of 20 fields at depth 1 (its own partition); L taps on L different fields of it; each commit writes one
// field picked at random (so most commits are beside most links).
//   e55   tap(c => work()): E-55's rule, the link is called on every commit to its row
//   leaf  tap(c => { if (hits(c)) work() }): data's rule run per link: a change at or below the field calls; a change
//         above it calls only if the field's value changed (Object.is, as data:api/index.ts connectPath); beside never
//   none  no links: the write and the commit alone
// Prints one JSON line: ns per commit (median of 15 rounds, the three ways interleaved round by round), the extra per
// link per commit, and the calls to work().
//   node rule.mjs <links>
import { fero, leafAt } from '../../E55-lens-prototype/proto/lens.mjs'

const L = Number(process.argv[2] ?? 10)
const F = 20
const fields = Array.from({ length: F }, (_, i) => 'f' + i)
let work = 0
function hits(c, sub) {
  const ds = c.changes
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i], p = d.path
    if (d.op !== 'update') return true // a row add or remove: the field appeared or went (data diffs it; rare here)
    let j = 0
    while (j < p.length && j < sub.length && p[j] === sub[j]) j++
    if (j === sub.length) return true // at or below
    if (j === p.length && !Object.is(leafAt(d.prev, sub), leafAt(d.row, sub))) return true // above, and changed
  }
  return false
}
function setup(kind) {
  const f = fero('t2', { depth: 1, data: { w: Object.fromEntries(fields.map((k) => [k, 0])) } })
  const links = []
  if (kind !== 'none') for (let i = 0; i < L; i++) {
    const sub = [fields[i % F], 'v'].slice(0, 1)
    links.push(kind === 'e55' ? f.data.w[sub[0]].tap((c) => { if (!c.first) work++ }) : f.data.w[sub[0]].tap((c) => { if (!c.first && hits(c, sub)) work++ }))
  }
  return { f, links }
}
const commits = 50000
const out = { exp: 'E-58', bench: 'rule', links: L, fields: F, node: process.version, commits }
const run = (f, n) => { let x = 0; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; f.set(['w', fields[x % F]], i) } }
const kinds = ['none', 'e55', 'leaf']
const S = Object.fromEntries(kinds.map((k) => [k, setup(k)]))
for (const k of kinds) run(S[k].f, commits) // warm
// the ways interleaved round by round, so drift on the box falls on all three alike
const xs = Object.fromEntries(kinds.map((k) => [k, []])), works = Object.fromEntries(kinds.map((k) => [k, 0]))
for (let round = 0; round < 15; round++) for (const k of kinds) {
  globalThis.gc?.()
  work = 0
  const t0 = process.hrtime.bigint()
  run(S[k].f, commits)
  xs[k].push(Number(process.hrtime.bigint() - t0) / commits)
  works[k] += work
}
for (const k of kinds) {
  const v = xs[k].sort((a, b) => a - b)
  out[k] = { nsPerCommit: Math.round(v[7]), nsLo: Math.round(v[0]), nsHi: Math.round(v[14]), workCallsPerCommit: +(works[k] / (15 * commits)).toFixed(3) }
}
out.e55ExtraPerLinkNs = +((out.e55.nsPerCommit - out.none.nsPerCommit) / L).toFixed(1)
out.leafExtraPerLinkNs = +((out.leaf.nsPerCommit - out.none.nsPerCommit) / L).toFixed(1)
out.leafMinusE55PerLinkNs = +((out.leaf.nsPerCommit - out.e55.nsPerCommit) / L).toFixed(1)
console.log(JSON.stringify(out))
