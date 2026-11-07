// E-06 part 2: rerun one recorded input on the exact state just before it (TEST-07), four ways.
//   IMMUTABLE=<immutable.es.js> node --expose-gc rewind.mjs <rows> <method> [K] [view]
// The resource: n rows filled through fero's seam, with no view (view=0, the default) or one group view with a
// sink (view=1; data's group view costs O(bucket rows) per commit, E-05, so it is run apart).
// The tape: inputs of two records each (a field update of an existing row, then a whole-row rewrite of
// another; the state stays at n rows), folded one record at a time through substrate.applyRec, as fero v4 folds.
// A rerun = get the state just before input i, apply input i's two records, read the row it wrote.
//   snap      every K inputs keep data's dense snapshot (substrate.snapshot); a rerun copies the nearest one
//             (Object.assign: data adopts an object and writes into it, so the kept one must not be handed over),
//             adopts it as a fresh source, builds the view, replays the inputs since, then runs input i
//   imm       the same, but the kept states are Immutable.js Maps updated beside data on every record (a
//             snapshot is then a pointer); a rerun turns the nearest Map back into an object for data
//   immfloor  no data at all: state is an Immutable Map with a version kept per input; a rerun is the version
//             before i plus two set() calls. The floor if data's own store shared structure.
//   undo      no snapshots: while walking the tape in order, run input i, then undo its records by their
//             inverses (each inverse read from the row before the record lands), then apply i for real.
//             Cost is per record, not per row; it serves reruns in tape order (fero test's replay walks
//             the tape in order), and a jump costs the records between.
// Reported: the time per rerun (median, p90, max over 20 sampled inputs), the time and heap to keep the
// snapshots, and the per-record cost of keeping them while the tape is applied.
import { S, I, VALUE, fill, groupView, row, key, tape, rng, gc, now, ms, median, pct, out, UPDATE, INSERT, REMOVE } from './common.mjs'

const N = +process.argv[2]
const METHOD = process.argv[3]
const K = +(process.argv[4] ?? 0)
const VIEW = (process.argv[5] ?? '0') === '1'
const SAMPLES = +(process.env.SAMPLES ?? 20)
// tape length: snap keeps at most ten snapshots (each holds every row), the others walk 20,000 inputs
// (undo with the group view walks 300: every record under data's group view costs O(bucket rows), E-05)
const T = METHOD === 'snap' ? Math.max(2 * K, Math.min(10 * K, 20000)) : METHOD === 'imm' ? Math.max(2 * K, 20000) : METHOD === 'undo' && VIEW ? 300 : 20000
const tp = tape(N, T)
const r = rng(99)
const picks = Array.from({ length: SAMPLES }, () => r() % T).sort((a, b) => a - b)

const p = S.proxy({})
fill(p, N)
// the view lives on the source that runs the reruns: the parent for undo, each restored fork for snap and imm
const pv = VIEW && METHOD === 'undo' ? groupView(p) : null
gc()
const applyInput = (h, recs) => { for (const x of recs) S.applyRec(h, x) }
const readBack = (h, recs) => { const k = recs[recs.length - 1].at ?? recs[recs.length - 1].key[0]; return h.get(k)[VALUE] }

// apply a record to an Immutable Map of rows, with data's path-copy meaning
const immApply = (m, x) => {
  if (x.type === REMOVE) return x.key.length === 1 ? m.delete(x.key[0]) : m.update(x.key[0], (rw) => { if (!rw) return rw; const c = { ...rw }; delete c[x.key[1]]; return c })
  if (x.type === INSERT) return m.set(x.at ?? x.key[0], x.value)
  if (x.key.length === 1) return m.set(x.key[0], x.value)
  return m.update(x.key[0], (rw) => ({ ...(rw ?? {}), [x.key[1]]: x.value })) // two-level paths only on this tape
}

const reruns = []
let takeMs = [], keepUs = 0, keptMB = 0, nsnap = 0, distance = []
if (METHOD === 'snap' || METHOD === 'imm') {
  const snaps = []
  let m = METHOD === 'imm' ? I.Map(S.snapshot(p)) : null
  gc()
  const h0 = process.memoryUsage().heapUsed
  let keepT = 0n
  for (let i = 0; i < T; i++) {
    if (i % K === 0) {
      const t0 = now()
      snaps.push({ at: i, s: METHOD === 'snap' ? S.snapshot(p) : m })
      takeMs.push(ms(t0))
    }
    applyInput(p, tp[i])
    if (m) { const t0 = now(); for (const x of tp[i]) m = immApply(m, x); keepT += now() - t0 }
  }
  gc()
  keptMB = (process.memoryUsage().heapUsed - h0) / 2 ** 20
  nsnap = snaps.length
  keepUs = Number(keepT) / 1e3 / (T * 2)
  for (const i of picks) {
    const s = snaps[Math.floor(i / K)]
    gc()
    const t0 = now()
    const f = S.proxy(METHOD === 'snap' ? Object.assign({}, s.s) : s.s.toObject())
    const fv = VIEW ? groupView(f) : null
    for (let j = s.at; j < i; j++) applyInput(f, tp[j])
    applyInput(f, tp[i])
    if (readBack(f, tp[i]) === undefined) throw new Error('rerun lost its row')
    reruns.push(ms(t0))
    distance.push(i - s.at)
    fv?.dispose()
  }
} else if (METHOD === 'immfloor') {
  let m = I.Map(S.snapshot(p))
  const versions = []
  gc()
  const h0 = process.memoryUsage().heapUsed
  const t0 = now()
  for (let i = 0; i < T; i++) { versions.push(m); for (const x of tp[i]) m = immApply(m, x) }
  keepUs = ms(t0) * 1e3 / (T * 2)
  gc()
  keptMB = (process.memoryUsage().heapUsed - h0) / 2 ** 20
  nsnap = T
  for (const i of picks) {
    const t1 = now()
    let v = versions[i]
    for (const x of tp[i]) v = immApply(v, x)
    const x = tp[i][tp[i].length - 1]
    if (v.get(x.at ?? x.key[0]) === undefined) throw new Error('lost')
    reruns.push(ms(t1))
    distance.push(0)
  }
} else if (METHOD === 'undo') {
  // inverse of one record against the source's current state (read before the record lands)
  const inverse = (h, x) => {
    const k = x.at ?? x.key[0]
    const prev = h.get(k)[VALUE]
    if (prev === undefined) return { type: REMOVE, key: [k] } // the record made the row (an orphan cell vivifies it)
    if (x.type === INSERT || x.key.length === 1) return { type: UPDATE, key: [k], value: prev }
    if (x.type === REMOVE && x.key.length === 1) return { type: INSERT, key: [], at: k, value: prev }
    const f = x.key[1]
    return Object.hasOwn(prev, f) ? { type: UPDATE, key: [k, f], value: prev[f] } : { type: REMOVE, key: [k, f] }
  }
  let checked = 0, orderKept = 0, orderChecks = 0
  let pi = 0
  for (let i = 0; i < T; i++) {
    if (pi < picks.length && picks[pi] === i) {
      while (pi < picks.length && picks[pi] === i) pi++
      const check = N <= 100000 && orderChecks < 5
      const before = check ? S.snapshot(p) : null
      const t0 = now()
      const inv = []
      for (const x of tp[i]) { inv.push(inverse(p, x)); S.applyRec(p, x) }
      if (readBack(p, tp[i]) === undefined) throw new Error('rerun lost its row')
      for (let j = inv.length - 1; j >= 0; j--) S.applyRec(p, inv[j])
      reruns.push(ms(t0))
      distance.push(0)
      if (check) {
        const after = S.snapshot(p)
        const kb = Object.keys(before), ka = Object.keys(after)
        if (kb.length !== ka.length || kb.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) throw new Error('undo did not restore the state at input ' + i)
        checked++
        orderChecks++
        if (kb.every((k, j) => k === ka[j])) orderKept++
      }
    }
    applyInput(p, tp[i])
  }
  // one more rerun whose input removes a row: its undo puts the row back, but at the END of data's key order
  let removeOrderKept = null
  if (N <= 100000) {
    const x = { type: REMOVE, key: [key(N >> 1)] }
    const kb = Object.keys(S.snapshot(p))
    const inv = { type: INSERT, key: [], at: key(N >> 1), value: p.get(key(N >> 1))[VALUE] }
    S.applyRec(p, x); S.applyRec(p, inv)
    const ka = Object.keys(S.snapshot(p))
    removeOrderKept = kb.length === ka.length && kb.every((k, j) => k === ka[j])
  }
  out({ exp: 'E-06', part: 'undo-check', rows: N, states_checked: checked, key_order_kept: orderKept, of: orderChecks, remove_undo_keeps_key_order: removeOrderKept })
} else throw new Error('method: snap | imm | immfloor | undo')

pv?.dispose()
out({
  exp: 'E-06', part: 'rewind', rows: N, method: METHOD, K, view: VIEW, tape_inputs: T, samples: SAMPLES,
  rerun_ms_median: +median(reruns).toFixed(3), rerun_ms_p90: +pct(reruns, 0.9).toFixed(3), rerun_ms_max: +Math.max(...reruns).toFixed(3),
  replayed_inputs_median: median(distance),
  snapshots: nsnap, take_ms_median: takeMs.length ? +median(takeMs).toFixed(3) : 0, kept_heap_mb: +keptMB.toFixed(1),
  keep_us_per_record: +keepUs.toFixed(3),
})
