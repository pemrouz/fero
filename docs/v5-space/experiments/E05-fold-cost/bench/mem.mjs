// E-05 part 2: bytes per row after GC, and the heap limit.
//   node --expose-gc mem.mjs <rows> <views> [form]
//   form: seam  (default) rows folded into a data source through fero's seam (a full replica on the main thread)
//         map   the same row objects in a plain Map (the floor any JS fold pays for holding the rows)
// Heap is read after three full collections: before the rows; after the rows; "after churn" (one field update
// to every row and every other row replaced whole: what a long-running replica holds once its rows have been
// rewritten); then with the views built over those rows ("with views"; built after the rows, data's bulk
// path: data's group view rebuilds a touched bucket's whole object on every commit, so building it first and
// folding a million rows under it is quadratic, see the fold part).
import { S, D, C, row, key, fill, decodeFrame, attachViews, gc, heap, limit, out, UPDATE, INSERT } from './common.mjs'

const N = +process.argv[2]
const VIEWS = process.argv[3] ?? 'none'
const FORM = process.argv[4] ?? 'seam'
if (!global.gc) throw new Error('run with --expose-gc')

// encoded size of a row in fero's codec and as JSON (what a row costs on disk and on the wire)
const sample = row(123456, 42)
const enc = C.encodeFrame([{ type: 1, key: [], at: key(123456), value: sample }]).length - C.HEADER - 4 // minus header and record count
const json = JSON.stringify(sample).length

let holder, subs = []
gc()
const h0 = heap()
if (FORM === 'seam') {
  holder = S.proxy({})
  fill(holder, N)
} else if (FORM === 'map') {
  holder = new Map()
  for (let i = 0; i < N; i += 256) {
    const recs = []
    for (let j = i; j < Math.min(N, i + 256); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(j, 0) })
    for (const r of decodeFrame(C.encodeFrame(recs))) holder.set(r.at, r.value)
  }
} else throw new Error('unknown form ' + FORM)
gc()
const h1 = heap()
// churn: every row's field n, then every other row replaced whole
if (FORM === 'seam') {
  const lane = D.lane(holder, { origin: S.ORIGIN })
  for (let i = 0; i < N; i += 256) {
    const a = [], b = []
    for (let j = i; j < Math.min(N, i + 256); j++) { a.push({ type: UPDATE, key: [key(j), 'n'], value: j + 1 }); if (j & 1) b.push({ type: UPDATE, key: [key(j)], value: row(j, 2) }) }
    lane(a); lane(b)
  }
} else {
  for (let i = 0; i < N; i++) { const r = holder.get(key(i)); holder.set(key(i), i & 1 ? row(i, 2) : { ...r, n: i + 1 }) }
}
gc()
const h2 = heap()
if (FORM === 'seam') subs = attachViews(holder, VIEWS)
gc()
const h3 = heap()
const per = (a, b, f) => Math.round((b[f] - a[f]) / N)
out({
  exp: 'E-05', part: 'mem', form: FORM, rows: N, views: VIEWS,
  heap_per_row: per(h0, h1, 'heapUsed'), rss_per_row: per(h0, h1, 'rss'),
  heap_per_row_after_churn: per(h0, h2, 'heapUsed'), rss_per_row_after_churn: per(h0, h2, 'rss'),
  heap_per_row_with_views: per(h0, h3, 'heapUsed'), views_heap_per_row: per(h2, h3, 'heapUsed'),
  heap_used_mb: Math.round(h3.heapUsed / 2 ** 20), rss_mb: Math.round(h3.rss / 2 ** 20),
  heap_size_limit_mb: Math.round(limit() / 2 ** 20),
  row_json_bytes: json, row_codec_bytes: enc,
})
for (const s of subs) s.dispose()
if (holder === undefined) throw new Error('unreachable')
