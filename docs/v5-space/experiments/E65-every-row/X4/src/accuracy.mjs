// E-65 X4: accuracy and size of the sketches, against exact answers (counted; no timing).
//   static: N values of one mix inserted once, one sketch and 16 merged; DD (relative error a), KLL (k), and when
//           LIBS names a folder holding node_modules, @datadog/sketches-js and tdigest.
//   churn:  N live values, then U updates (a value removed, a new one added, the mix drifting): DD, KLL with a
//           second sketch for removes, KLL rebuilt from the live values once churn passes c times the count, and
//           KLL that ignores removes.
//   band:   how many exact values the live exact form holds at the asker: the median's bucket and w = 2 non-empty
//           buckets each side, for N and a.
import { createRequire } from 'node:module'
import { mapping, Hist } from './dd.mjs'
import { KLL, TurnstileKLL } from './kll.mjs'
import { rng } from './rng.mjs'

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d }
const part = process.argv[2], SEED = +arg('seed', 1)
const r = rng(SEED * 104729 + 7)
const gen = {
  lognormal: () => Math.exp(2 * r.normal()),
  pareto: () => 1 / Math.pow(1 - r(), 1 / 1.1),
  ints: () => r.int(101),
  wide: () => (r() < 0.5 ? -1 : 1) * Math.pow(10, 600 * r() - 300),
  latency: () => (r() < 0.98 ? 5 + 20 * r() : 1000 + 4000 * r()), // a bimodal tail
}
const QS = [0.5, 0.9, 0.99, 0.999]
function lb(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m } return lo }
function ub(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m } return lo }
// errors of an answer v for rank rk over the sorted truth s: relative value error and rank error (as a share of n)
function err(s, rk, v) {
  const e = s[rk]
  const rel = e === v ? 0 : Math.abs(v - e) / Math.abs(e)
  const lo = lb(s, v), hi = ub(s, v) - 1
  const re = rk < lo ? lo - rk : rk > hi ? rk - hi : 0
  return { rel, rank: re / s.length }
}
const worst = (acc, e) => ({ rel: Math.max(acc.rel, e.rel), rank: Math.max(acc.rank, e.rank) })
const Z = () => ({ rel: 0, rank: 0 })
let libs = null
if (process.env.LIBS) {
  const req = createRequire(process.env.LIBS + '/')
  libs = { DD: req('@datadog/sketches-js').DDSketch, TD: req('tdigest').TDigest }
}

if (part === 'static') {
  const dist = arg('dist', 'lognormal'), N = +arg('n', 1e5), G = 16, K = +arg('k', 200), A = +arg('alpha', 0.01)
  const m = mapping(A)
  const vals = Float64Array.from({ length: N }, gen[dist])
  const s = Float64Array.from(vals).sort()
  const dd = new Hist(m), kll = new KLL(K, r), parts = []
  for (let g = 0; g < G; g++) parts.push(new KLL(K, r))
  for (let i = 0; i < N; i++) { dd.add(vals[i], 1); kll.add(vals[i]); parts[i % G].add(vals[i]) }
  const km = new KLL(K, r); for (const p of parts) km.merge(p)
  const out = { part, dist, n: N, alpha: A, k: K, dd: Z(), kll: Z(), kllMerged16: Z(), ddBuckets: dd.size, kllItems: kll.size, kllMergedItems: km.size }
  for (const q of QS) {
    const rk = Math.floor((N - 1) * q)
    out.dd = worst(out.dd, err(s, rk, dd.atRank(rk)))
    out.kll = worst(out.kll, err(s, rk, kll.atRank(rk)))
    out.kllMerged16 = worst(out.kllMerged16, err(s, rk, km.atRank(rk)))
  }
  if (libs) {
    const ld = new libs.DD({ relativeAccuracy: A }), td = new libs.TD()
    let ok = true
    for (let i = 0; i < N; i++) { if (vals[i] !== 0) ld.accept(vals[i]); td.push(vals[i]) }
    td.compress()
    out.libDD = Z(); out.libTD = Z(); out.tdCentroids = td.size()
    for (const q of QS) {
      const rk = Math.floor((N - 1) * q)
      if (dist !== 'ints' && dist !== 'wide') out.libDD = worst(out.libDD, err(s, rk, ld.getValueAtQuantile(q)))
      out.libTD = worst(out.libTD, err(s, rk, td.percentile(q)))
    }
  }
  console.log(JSON.stringify(out))
} else if (part === 'churn') {
  const N = +arg('n', 1e5), U = +arg('u', 1), K = +arg('k', 200), C = +arg('c', 0.5), A = 0.01
  const m = mapping(A), dd = new Hist(m)
  const ts = new TurnstileKLL(K, r), ign = new KLL(K, r)
  // rebuilt: a fresh KLL of the live values at each rebuild, plus a turnstile of the changes since
  let rb = new TurnstileKLL(K, r), churn = 0, rebuilds = 0, rebuildItems = 0
  let shift = 0
  const draw = () => Math.exp(1.5 * r.normal() + shift)
  const live = new Float64Array(N)
  for (let i = 0; i < N; i++) { live[i] = draw(); dd.add(live[i], 1); ts.add(live[i]); ign.add(live[i]); rb.add(live[i]) }
  const out = { part, n: N, updatesPerRow: U, k: K, c: C, dd: Z(), turnstile: Z(), rebuild: Z(), ignoreRemoves: Z() }
  const total = N * U
  for (let u = 0; u < total; u++) {
    shift = (3 * u) / Math.max(1, total) // the mix drifts by 3 sigma over the run
    const i = r.int(N), o = live[i], v = draw()
    live[i] = v
    dd.add(o, -1); dd.add(v, 1)
    ts.remove(o); ts.add(v); ign.add(v)
    rb.remove(o); rb.add(v); churn++
    if (churn > C * N) { rb = new TurnstileKLL(K, r); for (let j = 0; j < N; j++) rb.add(live[j]); churn = 0; rebuilds++; rebuildItems += N }
  }
  const s = Float64Array.from(live).sort()
  for (const q of QS) {
    const rk = Math.floor((N - 1) * q)
    out.dd = worst(out.dd, err(s, rk, dd.atRank(rk)))
    out.turnstile = worst(out.turnstile, err(s, rk, ts.atRank(rk)))
    out.rebuild = worst(out.rebuild, err(s, rk, rb.atRank(rk)))
    out.ignoreRemoves = worst(out.ignoreRemoves, err(s, rk, ign.atRank(Math.floor((ign.n - 1) * q))))
  }
  Object.assign(out, { rebuilds, rebuildItemsPerWrite: total ? rebuildItems / total : 0, turnstileItems: ts.ins.size + ts.del.size, ddBuckets: dd.size })
  console.log(JSON.stringify(out))
} else if (part === 'band') {
  const dist = arg('dist', 'lognormal'), N = +arg('n', 1e6), A = +arg('alpha', 0.01), W = 2
  const m = mapping(A), dd = new Hist(m)
  for (let i = 0; i < N; i++) dd.add(gen[dist](), 1)
  const ids = dd.sorted(), out = { part, dist, n: N, alpha: A, buckets: ids.length }
  for (const q of [0.5, 0.99]) {
    const l = dd.locate(Math.floor((N - 1) * q)), i = ids.indexOf(l.b)
    let held = 0
    for (let j = Math.max(0, i - W); j <= Math.min(ids.length - 1, i + W); j++) held += dd.c.get(ids[j])
    out[`band${q * 100}`] = held; out[`share${q * 100}`] = held / N
  }
  console.log(JSON.stringify(out))
}
