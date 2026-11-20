// E-58: one seeded run, one JSON line out.
//   node run.mjs oracle <depth 1|2> <seeds> [main|shape|edge|merge]   parts 1 and 2 (edge, merge: added after the review)
//   node run.mjs split <seeds>                              part 3
//   node run.mjs filter <seeds>                             part 4
//   node run.mjs versions <seeds> <sibling share 0..1>      part 5
// E58_MUTATE names a planted bug (see each part's header). A seed "fails" when any rule its part checks breaks.
import { MUT } from './common.mjs'

const [part, ...args] = process.argv.slice(2)
const t0 = process.hrtime.bigint()
const S = Object.create(null)
let seeds = 0, failedSeeds = 0
const firstFailed = [], failKinds = Object.create(null)
const take = (seed, failed) => {
  seeds++
  if (failed.size > 0) { failedSeeds++; if (firstFailed.length < 5) firstFailed.push(seed); for (const k of failed) failKinds[k] = (failKinds[k] ?? 0) + 1 }
}
let out = {}
if (part === 'oracle') {
  const { runSeed } = await import('./oracle.mjs')
  const depth = Number(args[0]), n = Number(args[1] ?? 1000), mode = args[2] ?? 'main'
  if (!['main', 'shape', 'edge', 'merge'].includes(mode)) { console.error('mode: main, shape, edge or merge'); process.exit(2) }
  for (let s = 1; s <= n; s++) take(s, runSeed(s, { depth, shape: mode === 'shape', edge: mode === 'edge', mergeFields: mode === 'merge' }, S))
  out = { depth, mode }
} else if (part === 'split') {
  const { runSeed } = await import('./split.mjs')
  const n = Number(args[0] ?? 1000)
  for (let s = 1; s <= n; s++) take(s, runSeed(s, S))
} else if (part === 'filter') {
  const { runSeed } = await import('./filter.mjs')
  const n = Number(args[0] ?? 1000)
  for (let s = 1; s <= n; s++) take(s, runSeed(s, S))
} else if (part === 'versions') {
  const { runSeed } = await import('./versions.mjs')
  const n = Number(args[0] ?? 1000), sib = Number(args[1] ?? 0.5)
  for (let s = 1; s <= n; s++) take(s, runSeed(s, { sib }, S))
  out = { sibling: sib }
} else { console.error('usage: run.mjs oracle|split|filter|versions …'); process.exit(2) }
const sec = Number(process.hrtime.bigint() - t0) / 1e9
const stats = Object.fromEntries(Object.entries(S).sort(([a], [b]) => (a < b ? -1 : 1)))
console.log(JSON.stringify({ exp: 'E-58', part, ...out, node: process.version, mutate: MUT || null, seeds, failedSeeds, firstFailed, failKinds, sec: Math.round(sec * 1000) / 1000, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), stats }))
