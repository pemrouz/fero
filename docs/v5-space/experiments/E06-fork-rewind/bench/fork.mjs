// E-06 part 1: what it costs to copy (fork) a resource's state in data, at n rows.
//   IMMUTABLE=<immutable.es.js> node --expose-gc fork.mjs <rows>
// The parent is a data source filled through fero's seam, with one group view and a sink (a live resource).
// Ways to fork it, each timed 5 times (median, min, max), the heap collected before each:
//   snapshot       data's dense snapshot (substrate.snapshot = [value]): a fresh object, rows shared by reference
//   adopt          substrate.proxy(that object): data adopts it as the fork's row table
//   first-update   one field update on the fork (an existing row: written in place, no promote)
//   first-insert   one new row on the fork: data's one-shot promote() builds its key map (O(rows))
//   view           the fork's own group view built over its rows (O(rows))
//   fork-total     snapshot + adopt + first insert + view: a fork ready to run the resource's code
//   lane-refill    a fresh source refilled through the lane from the snapshot's rows (one batch per 256)
//   deep-copy      structuredClone of the snapshot (rows not shared): the cost of a copy that shares nothing
//   imm-build      an Immutable.js Map of the rows (a persistent map: copies share structure), built once
//   imm-fork       fork of that Map = keep the reference, then one set() on the fork (O(log32 rows))
//   imm-to-data    the Immutable Map turned back into a plain object and adopted by data (O(rows))
// Also the heap a fork holds (snapshot + promote + view) after a collection.
import { S, I, VALUE, fill, groupView, row, key, laneFor, gc, now, ms, median, out, UPDATE, INSERT } from './common.mjs'

const N = +process.argv[2]
const REPS = 5
const p = S.proxy({})
fill(p, N)
const pv = groupView(p)
gc()

const res = {}
const time = (name, fn, setup = () => null) => {
  const xs = []
  for (let r = 0; r < REPS; r++) { const ctx = setup(); gc(); const t0 = now(); fn(ctx); xs.push(ms(t0)) }
  res[name] = { ms: +median(xs).toFixed(3), min: +Math.min(...xs).toFixed(3), max: +Math.max(...xs).toFixed(3) }
}
let sink
time('snapshot', () => { sink = S.snapshot(p) })
time('adopt', (snap) => { sink = S.proxy(snap) }, () => S.snapshot(p))
time('first-update', (f) => { S.applyRec(f, { type: UPDATE, key: [key(1), 'n'], value: 99 }) }, () => S.proxy(S.snapshot(p)))
time('first-insert', (f) => { S.applyRec(f, { type: INSERT, key: [], at: 'new', value: row(N + 1, 1) }) }, () => S.proxy(S.snapshot(p)))
time('view', (f) => { sink = groupView(f) }, () => S.proxy(S.snapshot(p)))
time('fork-total', () => {
  const f = S.proxy(S.snapshot(p))
  S.applyRec(f, { type: INSERT, key: [], at: 'new', value: row(N + 1, 1) })
  sink = groupView(f)
})
time('lane-refill', (snap) => {
  const f = S.proxy({}), lane = laneFor(f), ks = Object.keys(snap)
  for (let i = 0; i < ks.length; i += 256) lane(ks.slice(i, i + 256).map((k) => ({ type: INSERT, key: [], at: k, value: snap[k] })))
  sink = f
}, () => S.snapshot(p))
time('deep-copy', (snap) => { sink = structuredClone(snap) }, () => S.snapshot(p))
let m
time('imm-build', (snap) => { m = I.Map(snap) }, () => S.snapshot(p))
time('imm-fork', () => { const f = m; sink = f.set('new', row(N + 1, 1)) })
time('imm-to-data', () => { sink = S.proxy(m.toObject()) })
sink = null

// heap one ready fork holds (its snapshot object, the promoted key map, its view), after a collection
gc()
const h0 = process.memoryUsage().heapUsed
let f = S.proxy(S.snapshot(p))
S.applyRec(f, { type: INSERT, key: [], at: 'new', value: row(N + 1, 1) })
const fv = groupView(f)
gc()
const forkBytes = process.memoryUsage().heapUsed - h0
// heap of the Immutable map itself (a second full index of the rows)
const h1 = process.memoryUsage().heapUsed
let m2 = I.Map(S.snapshot(p))
gc()
const immBytes = process.memoryUsage().heapUsed - h1
if (f[VALUE] === undefined || m2.size !== N) throw new Error('fork lost rows')
fv.dispose(); pv.dispose(); f = null; m2 = null
out({ exp: 'E-06', part: 'fork', rows: N, reps: REPS, ...Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v])), fork_heap_mb: +(forkBytes / 2 ** 20).toFixed(1), fork_bytes_per_row: Math.round(forkBytes / N), imm_map_heap_mb: +(immBytes / 2 ** 20).toFixed(1) })
