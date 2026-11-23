// E-65 X1: the asker's own memory budget as the limit, instead of a fixed row count. Seeded runs on data's real
// engine (DATA, read only), at a small scale (a budget of tens of MB, so a forced collection is cheap).
//
//   node --expose-gc --max-old-space-size=<2 x budget> budget.mjs --policy=P --budget=64 [--seeds=200]
//
// A holder (one data source, as hold: 'all') takes a seeded stream: inserts, field writes that make rows
// longer, whole-row rewrites in another shape, deletes. Row shapes are drawn per seed: small (about 100 B of
// JSON), big (1 to 3 KB of text), wide (30 numbers), nested (a list and an object). After every batch of 512
// records the holder's GUARD reads its estimate of what it holds and says: ok, warn (at 80 % of the budget),
// or refuse (at 95 %: it takes no more rows, so the hold ends with `not-held`).
//
// Policies (the estimate the guard reads):
//   heapnow   V8's used heap now (getHeapStatistics), garbage included
//   model     a fixed model: each row costs a x (its JSON bytes) + b, fitted once on small rows at start
//   aftergc   the used heap read right after the last major collection (a perf_hooks 'gc' entry), plus the
//             model's growth since then
//   scaled    the model times the ratio of the used heap to the model seen right after the last major collection
//   confirm   scaled, and when it crosses 80 % or 95 % the guard collects in full and reads the true live heap
//             before it warns or refuses (a forced collection: its pause is reported)
//   first     planted: rows x (bytes a row of the first 1,000 rows), never updated
//
// The oracle: the LIVE heap (after a forced full collection), read every 16 batches and at every warn and
// refuse. A seed fails if live heap passes the budget with no refusal (the process would run out), if the
// warning comes when live heap is outside 70 to 90 % of the budget, or if the refusal comes below 85 %.
// Every number is relative to the heap after the store is made empty, so the module's own heap is not counted.
import { rng, args, out, loadData, gc, loadavg } from './lib.mjs'
import v8 from 'node:v8'
import { PerformanceObserver } from 'node:perf_hooks'

const A = args()
const policy = A.policy ?? 'aftergc', B = (A.budget ?? 64) * 2 ** 20, seeds = A.seeds ?? 200, first = A.first ?? 1
const D = await loadData()
const used = () => v8.getHeapStatistics().used_heap_size
const live = () => { gc(); return used() }

// the major-collection watcher: the used heap right after each mark-sweep-compact
// (the oracle's own forced collections are left out: their start times fall inside the oracle's spans)
let lastLive = -1, lastModelAtGc = 0, modelNow = 0
const oracleSpans = []
const inOracle = (t) => { for (let i = oracleSpans.length - 1; i >= 0 && i >= oracleSpans.length - 4; i--) if (t >= oracleSpans[i][0] && t <= oracleSpans[i][1]) return true; return false }
const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) if ((e.detail?.kind ?? e.kind) === 4 && !inOracle(e.startTime)) { lastLive = used(); lastModelAtGc = modelNow } })
obs.observe({ entryTypes: ['gc'] })

function shapeRow(r, shape) {
  if (shape === 'small') return { user: 'u' + Math.floor(r() * 1000), cents: Math.floor(r() * 1e4), score: Math.floor(r() * 1e6), paid: r() < 0.5, sku: 'sku-' + Math.floor(r() * 1e5), title: 'item ' + Math.floor(r() * 1e9).toString(36), at: 1.7e12 + Math.floor(r() * 1e10), qty: 1 + Math.floor(r() * 5) }
  if (shape === 'big') return { user: 'u' + Math.floor(r() * 1000), text: 'x'.repeat(1000 + Math.floor(r() * 2000)) + Math.floor(r() * 1e9), at: Math.floor(r() * 1e9) }
  if (shape === 'wide') { const o = {}; for (let i = 0; i < 30; i++) o['f' + i] = r() * 1e6; return o }
  return { tags: Array.from({ length: 10 }, () => 'tag' + Math.floor(r() * 1e6)), meta: { a: Math.floor(r() * 9), b: 'b' + Math.floor(r() * 1e4), c: [r(), r()] }, n: Math.floor(r() * 1e6) }
}
const bytesOf = (v) => JSON.stringify(v).length
// data's default runtime keeps a dropped source's rows reachable (a probe: 13.9 MB per 1e5 small rows stayed
// after the handle was dropped, and went only once every row was removed), so a hold that ends removes its rows
const NODE = Symbol.for('data.v4.node')
function dropAll(src, lane) { const b = []; src[NODE].each((k) => b.push({ type: 2, key: [k] })); for (let i = 0; i < b.length; i += 4096) lane(b.slice(i, i + 4096)); src.dispose() }

// the model, fitted once on small rows and big rows (two points, a line): heap per row = a x JSON bytes + b
async function fit() {
  const pts = []
  for (const shape of ['small', 'big']) {
    const src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } }), r = rng(7)
    const h0 = live(); let jb = 0
    const n = shape === 'small' ? 20000 : 4000
    for (let i = 0; i < n; i += 500) { const b = []; for (let j = i; j < i + 500; j++) { const v = shapeRow(r, shape); jb += bytesOf(v); b.push({ type: 1, key: [], at: 'f' + j, value: v }) } lane(b) }
    const h1 = live()
    pts.push({ jb: jb / n, hb: (h1 - h0) / n })
    dropAll(src, lane)
  }
  const a = (pts[1].hb - pts[0].hb) / (pts[1].jb - pts[0].jb), b = pts[0].hb - a * pts[0].jb
  return { a, b, pts }
}
const M = await fit()
gc()

async function runSeed(seed) {
  const r = rng(seed)
  const shapes = ['small', 'big', 'wide', 'nested']
  const w = shapes.map(() => r()), ws = w.reduce((x, y) => x + y, 0)
  const pickShape = () => { let u = r() * ws; for (let i = 0; i < 4; i++) { u -= w[i]; if (u <= 0) return shapes[i] } return 'small' }
  const pGrow = r() * 0.4, pRewrite = r() * 0.3, pDel = r() * 0.1
  const src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
  const base = live()
  const rowsB = new Map() // key -> JSON bytes (what the model counts)
  let model = 0, n = 0, keyN = 0, firstPerRow = 0
  const keys = []
  const modelOf = (jb) => M.a * jb + M.b
  lastLive = -1
  let ratio = 1, confirmMs = 0
  const est = () => {
    if (policy === 'heapnow') return used() - base
    if (policy === 'model') return model
    if (policy === 'first') return firstPerRow ? n * firstPerRow : model
    if (policy === 'aftergc') return lastLive >= 0 ? lastLive - base + (model - lastModelAtGc) : model
    // scaled and confirm: the model times the ratio of live heap to model seen at the last major collection
    if (lastLive >= 0 && lastModelAtGc >= 0.05 * B) ratio = Math.min(4, Math.max(0.5, (lastLive - base) / lastModelAtGc))
    return model * ratio
  }
  // confirm: at each new tenth of the budget the estimate passes (from 50 %), and before it warns or refuses,
  // the guard collects in full and reads the true live heap; the ratio is set again from it
  let nextTenth = 0.5
  const confirm = () => { const t = performance.now(); gc(); const L = used() - base; confirmMs = Math.max(confirmMs, performance.now() - t); lastLive = L + base; lastModelAtGc = model; return L }
  let warnAt = null, refuseAt = null, fail = null, batches = 0, checkNs = 0, checks = 0, maxLive = 0
  const judge = () => { const t = performance.now(); const L = live() - base; oracleSpans.push([t - 1, performance.now() + 1]); maxLive = Math.max(maxLive, L); return L / B }
  for (let step = 0; step < 4000 && refuseAt === null; step++) {
    const recs = []
    for (let i = 0; i < 512; i++) {
      const u = r()
      if (keys.length && u < pGrow) { // a field write that makes a row longer
        const k = keys[Math.floor(r() * keys.length)]
        if (!rowsB.has(k)) continue
        const v = 'g'.repeat(50 + Math.floor(r() * 400))
        recs.push({ type: 0, key: [k, 'grow' + Math.floor(r() * 3)], value: v })
        const nb = rowsB.get(k) + v.length + 10; model += modelOf(nb) - modelOf(rowsB.get(k)); rowsB.set(k, nb)
      } else if (keys.length && u < pGrow + pRewrite) {
        const k = keys[Math.floor(r() * keys.length)]
        if (!rowsB.has(k)) continue
        const v = shapeRow(r, pickShape()), nb = bytesOf(v)
        recs.push({ type: 0, key: [k], value: v }); model += modelOf(nb) - modelOf(rowsB.get(k)); rowsB.set(k, nb)
      } else if (keys.length && u < pGrow + pRewrite + pDel) {
        const j = Math.floor(r() * keys.length), k = keys[j]
        if (!rowsB.has(k)) continue
        recs.push({ type: 2, key: [k] }); model -= modelOf(rowsB.get(k)); rowsB.delete(k); n--
        keys[j] = keys[keys.length - 1]; keys.pop()
      } else {
        const k = 'r' + keyN++, v = shapeRow(r, pickShape()), nb = bytesOf(v)
        recs.push({ type: 1, key: [], at: k, value: v }); keys.push(k); rowsB.set(k, nb); model += modelOf(nb); n++
        if (n === 1000 && !firstPerRow) firstPerRow = model / n
      }
    }
    lane(recs); batches++
    await new Promise(setImmediate) // one turn of the event loop per batch, as an asker takes one frame a turn (the gc observer runs between turns)
    modelNow = model
    const t0 = process.hrtime.bigint()
    const e = est()
    checkNs += Number(process.hrtime.bigint() - t0); checks++
    let ew = e, er = e
    if (policy === 'confirm' && e >= nextTenth * B && nextTenth < 0.8) { const L = confirm(); ratio = Math.max(0.5, L / model); while (nextTenth * B <= L) nextTenth += 0.1 }
    if (policy === 'confirm' && warnAt === null && e >= 0.8 * B) ew = confirm()
    if (policy === 'confirm' && e >= 0.95 * B) er = confirm() >= 0.9 * B ? e : 0
    if (warnAt === null && ew >= 0.8 * B) { warnAt = judge(); if (warnAt < 0.7 || warnAt > 0.9) fail ??= `warned at ${(warnAt * 100).toFixed(0)} % of the budget` }
    if (er >= 0.95 * B) { refuseAt = judge(); if (refuseAt < 0.85) fail ??= `refused at ${(refuseAt * 100).toFixed(0)} %`; if (warnAt === null) fail ??= 'refused with no warning first' ; if (refuseAt > 1) fail ??= `refused only at ${(refuseAt * 100).toFixed(0)} %` }
    else if (batches % 16 === 0 && used() - base >= B) { const L = judge(); if (L > 1) { fail ??= `live heap ${(L * 100).toFixed(0)} % of the budget, not refused`; break } } // used heap bounds live heap: collect only when it passes the budget
  }
  if (refuseAt === null && !fail) fail = 'never reached the budget (raise the steps)'
  dropAll(src, lane)
  return { fail, warnAt, refuseAt, n, maxLive: maxLive / B, checkNs: checkNs / checks, confirmMs, mix: shapes.map((s, i) => s + ':' + (w[i] / ws).toFixed(2)).join(' ') }
}

const t0 = Date.now()
let failed = 0, firstFail = null, reasons = {}, warnL = [], refL = [], ns = [], confirmMax = 0
for (let s = first; s < first + seeds; s++) {
  const res = await runSeed(s)
  if (res.fail) { failed++; firstFail ??= { seed: s, fail: res.fail, mix: res.mix }; const k = res.fail.replace(/[0-9]+ %/, 'N %'); reasons[k] = (reasons[k] ?? 0) + 1 }
  if (res.warnAt !== null) warnL.push(res.warnAt)
  if (res.refuseAt !== null) refL.push(res.refuseAt)
  ns.push(res.checkNs); confirmMax = Math.max(confirmMax, res.confirmMs)
  gc()
  if (A.debug) console.error('seed', s, res.fail, res.n, (used() / 2 ** 20).toFixed(0) + ' MB after')
}
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100).toFixed(1) }
out({ exp: 'E-65', opt: 'X1', bench: 'budget', policy, budget_mb: B / 2 ** 20, seeds, failed, reasons, warn_live_pct: { min: q(warnL, 0), p50: q(warnL, 0.5), max: q(warnL, 0.9999) }, refuse_live_pct: { min: q(refL, 0), p50: q(refL, 0.5), max: q(refL, 0.9999) }, check_ns_p50: Math.round([...ns].sort((a, b) => a - b)[ns.length >> 1]), confirm_gc_ms_max: +confirmMax.toFixed(1), model: { a: +M.a.toFixed(2), b: +M.b.toFixed(0), points: M.pts.map((p) => ({ json_b: +p.jb.toFixed(0), heap_b: +p.hb.toFixed(0) })) }, first_fail: firstFail, seconds: (Date.now() - t0) / 1000, node: process.version, loadavg_end: loadavg() })
obs.disconnect()
