// E-65 X4: timed costs, one cell per process. Inside a run: a warm-up, then the median of 5 rounds.
//   ops      one sketch: DD bucket add/subtract, KLL add; with LIBS: @datadog/sketches-js accept, tdigest push
//   merge    16 sketches of N / 16 values each merged into one, and a quantile read on the result
//   coalesce a group folds W writes into one tick's bucket changes; the asker adds them
//   band     the asker's live form at G groups over N values: one write's (old, new) into the counts and band,
//            and an exact median read
//   onetime  an exact median asked of G groups over N values (two ranks), with and without live counts
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { mapping, Hist } from './dd.mjs'
import { KLL } from './kll.mjs'
import { Asker } from './asker.mjs'
import { readRank } from './onetime.mjs'
import { rng } from './rng.mjs'

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d }
const cell = process.argv[2], N = +arg('n', 1e6), G = +arg('g', 16), A = +arg('alpha', 0.01), ROUNDS = 5
const r = rng(+arg('seed', 1))
const gen = () => Math.exp(r.normal())
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1]
function rounds(fn) { fn(); const t = []; for (let i = 0; i < ROUNDS; i++) t.push(fn()); return med(t) }
const time = (f) => { const t0 = performance.now(); f(); return performance.now() - t0 }
const out = { cell, n: N, g: G, alpha: A, loadavg: (await import('node:os')).loadavg().map((x) => +x.toFixed(2)) }
const m = mapping(A)
let libs = null
if (process.env.LIBS) { const req = createRequire(process.env.LIBS + '/'); libs = { DD: req('@datadog/sketches-js').DDSketch, TD: req('tdigest').TDigest } }

if (cell === 'ops') {
  const OPS = 1e6, vals = Float64Array.from({ length: OPS }, gen)
  const h = new Hist(m); for (let i = 0; i < 1e5; i++) h.add(vals[i], 1)
  out.ddAddSubNs = rounds(() => time(() => { for (let i = 0; i < OPS; i++) { h.add(vals[i], 1); h.add(vals[(i * 7919) % OPS], -1) } }) * 1e6 / (2 * OPS))
  // undo the drift the subtract pattern leaves
  out.kllAddNs = rounds(() => { const k = new KLL(200, r); return time(() => { for (let i = 0; i < OPS; i++) k.add(vals[i]) }) * 1e6 / OPS })
  if (libs) {
    out.libDDAcceptNs = rounds(() => { const d = new libs.DD({ relativeAccuracy: A }); return time(() => { for (let i = 0; i < OPS; i++) d.accept(vals[i]) }) * 1e6 / OPS })
    out.libTDPushNs = rounds(() => { const t = new libs.TD(); return time(() => { for (let i = 0; i < 2e5; i++) t.push(vals[i]) }) * 1e6 / 2e5 })
  }
} else if (cell === 'merge') {
  const per = Math.floor(N / G), hs = [], ks = []
  for (let g = 0; g < G; g++) { const h = new Hist(m), k = new KLL(200, r); for (let i = 0; i < per; i++) { const v = gen(); h.add(v, 1); k.add(v) } hs.push(h); ks.push(k) }
  out.ddBucketsPerGroup = hs[0].size
  let dm, km
  out.ddMergeUs = rounds(() => time(() => { dm = new Hist(m); for (const h of hs) dm.merge(h) }) * 1e3)
  out.ddMergedBuckets = dm.size
  out.ddQueryUs = rounds(() => { dm.ids = null; return time(() => dm.atRank(Math.floor((dm.n - 1) / 2))) * 1e3 })
  out.ddQueryWarmUs = rounds(() => time(() => { for (let i = 0; i < 100; i++) dm.atRank(Math.floor((dm.n - 1) * 0.99)) }) * 10)
  out.kllMergeUs = rounds(() => time(() => { km = new KLL(200, r); for (const k of ks) km.merge(k) }) * 1e3)
  out.kllQueryUs = rounds(() => time(() => km.atRank(Math.floor((km.n - 1) / 2))) * 1e3)
  out.kllItems = km.size
  if (libs) {
    const ds = hs.map(() => new libs.DD({ relativeAccuracy: A })), tds = []
    for (let g = 0; g < G; g++) { const t = new libs.TD(); for (let i = 0; i < Math.min(per, 50000); i++) { const v = gen(); ds[g].accept(v); t.push(v) } tds.push(t) }
    out.libDDMergeUs = rounds(() => { const d = new libs.DD({ relativeAccuracy: A }); return time(() => { for (const x of ds) d.merge(x) }) * 1e3 })
    out.libTDMergeUs = rounds(() => { const t = new libs.TD(); return time(() => { for (const x of tds) t.push_centroid(x.toArray()) }) * 1e3 })
  }
} else if (cell === 'coalesce') {
  const W = +arg('w', 10000), mode = arg('mode', 'small')
  const live = Float64Array.from({ length: 1e5 }, gen)
  const asker = new Hist(m); for (const v of live) asker.add(v, 1)
  let changed = 0
  const tick = () => {
    const d = new Map()
    for (let i = 0; i < W; i++) {
      const j = r.int(live.length), o = live[j], v = mode === 'small' ? o * (1 + 0.01 * r.normal()) : gen()
      live[j] = v
      const bo = m.bid(o), bv = m.bid(v)
      if (bo !== bv) { d.set(bo, (d.get(bo) || 0) - 1); d.set(bv, (d.get(bv) || 0) + 1) }
    }
    return d
  }
  out.groupNsPerWrite = rounds(() => time(() => { changed = tick().size }) * 1e6 / W)
  out.changedBucketsPerTick = changed
  const ds = []; for (let i = 0; i < 6; i++) ds.push(tick())
  let k = 0
  out.askerUsPerTick = rounds(() => { const d = ds[k++]; return time(() => { for (const [b, x] of d) if (x !== 0) asker.addBid(b, x) }) * 1e3 })
  out.mode = mode; out.w = W
} else if (cell === 'band') {
  const live = Float64Array.from({ length: N }, gen), owner = Uint8Array.from({ length: N }, () => r.int(G))
  const a = new Asker(m, G)
  const vs = Array.from({ length: G }, () => [])
  for (let i = 0; i < N; i++) vs[owner[i]].push(live[i])
  for (let g = 0; g < G; g++) a.resync(g, vs[g], null)
  const range = a.rangeFor(0.5); a.setWant(range)
  for (let g = 0; g < G; g++) a.installBand(g, range, vs[g].filter((v) => { const b = m.bid(v); return b >= range[0] && b <= range[1] }))
  out.bandHeld = a.bandN; out.buckets = a.all.size
  const D = 2e5
  out.deltaNs = rounds(() => time(() => {
    for (let i = 0; i < D; i++) { const j = r.int(N), o = live[j], v = gen(); live[j] = v; a.delta(owner[j], o, v) }
  }) * 1e6 / D)
  let miss = 0
  out.exactMedianUs = rounds(() => time(() => { for (let i = 0; i < 1000; i++) if (a.exact(0.5) === undefined) miss++ }))
  out.approxMedianUs = rounds(() => time(() => { for (let i = 0; i < 100; i++) a.approx(0.5) }) * 10)
  out.exactMisses = miss
} else if (cell === 'onetime') {
  const cap = +arg('cap', 1024)
  const groups = []
  for (let g = 0; g < G; g++) groups.push({ vals: [], hist: new Hist(m) })
  for (let i = 0; i < N; i++) { const v = gen(), g = groups[r.int(G)]; g.vals.push(v); g.hist.add(v, 1) }
  for (const g of groups) g.vals = Float64Array.from(g.vals)
  const live = new Hist(m); for (const g of groups) live.merge(g.hist)
  const lo = Math.floor((N - 1) / 2)
  const run = (have) => { const a = readRank(groups, lo, m, { cap, haveCounts: have }), b = readRank(groups, lo + 1, m, { cap, haveCounts: have }); return { trips: Math.max(a.trips, b.trips), sent: a.sent + b.sent, scanned: a.scanned + b.scanned } }
  Object.assign(out, { cold: run(null), withCounts: run(live), cap })
  out.coldMs = rounds(() => time(() => run(null)))
  out.withCountsMs = rounds(() => time(() => run(live)))
  out.sortAllMs = rounds(() => { const all = new Float64Array(N); let i = 0; for (const g of groups) { all.set(g.vals, i); i += g.vals.length } return time(() => all.sort()) })
}
console.log(JSON.stringify(out))
