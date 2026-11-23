// E-65 X1: what each way of holding every row in the asker costs. One JSON line per process; run.sh runs each
// three times, each process alone on the box under the timing lock (memory and the ceiling runs under heavy).
// data (DATA, read only) folds the data forms; the compact and disk forms are compact.mjs and sqlite.mjs.
//
//   node --expose-gc bench.mjs fold   --form=F --rows=N [--recs=H] [--views]
//        load N rows, then fold the write mix in lanes of 256: ns a record (at most about 3 s of records).
//        --views: live views over every row as well (one, proj: data's sum, length, za(score, 10), median;
//        blocks: the same per source and combined, the median from one sorted column fed by every source;
//        column: a sum, a count and the sorted column, fed by the store's own changes)
//   node --expose-gc bench.mjs mem    --form=F --rows=N       heap, off-heap and RSS bytes a row, after the load
//        and after N more writes of the mix (sqlite: the file's bytes a row)
//   node --expose-gc bench.mjs read   --form=F --rows=N       a get; a scan of one field; every row as an
//        object; a one-time exact median of score (gather and sort); column: a numeric column sum;
//        sqlite: SUM in SQL, and with --form=sqlite-ix the median by walking an index
//   node --expose-gc bench.mjs gc     --form=F --rows=N [--rate=50000] [--secs=10]
//        GC pauses while loading N rows, then under steady writes (1 ms ticks, as E-07)
//   node --expose-gc bench.mjs median --form=M --rows=N       a live median's cost a record: M = none (no view),
//        data (data's median on one source), data16 (data's median on each of 16 sources: not a combined
//        answer, only its cost), sorted (one sorted column fed by the source's row deltas)
//   node --expose-gc bench.mjs cap    --form=one|blocks16|column --rows=N   load tiny rows ({ n }) or small rows
//        (column) until N or a throw: does the form pass data's 16,777,216 rows a source?
//   node bench.mjs probe                                      the cost of reading this process's memory
// Forms: one, blocks16, blocks64, proj (user, cents, score), arena, kvdisk (keys and addresses in memory,
// values in a file), column, sqlite, sqlite-ix.
import { args, out, loadData, loadavg, gc, heapUsed, inserts, makeGen, GcWatch, now, nsSince, median } from './lib.mjs'
import { useData, OneStore, BlockStores, ProjStore } from './dstores.mjs'
import { ArenaStore, ColumnStore, SortedCol } from './compact.mjs'
import { SqliteStore } from './sqlite.mjs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import v8 from 'node:v8'

const A = args()
const mode = process.argv[2], form = A.form ?? 'one', N = A.rows ?? 1e6
const D = await loadData(); useData(D)
const TMP = mkdtempSync(join(process.env.X1_TMP ?? tmpdir(), 'e65-x1-'))
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))
const NODE = Symbol.for('data.v4.node')
const ab = () => { const m = process.memoryUsage(); return m.arrayBuffers + m.external }
const base = { exp: 'E-65', opt: 'X1', bench: mode, form, rows: N, node: process.version, loadavg: loadavg() }

function make(f, cap = 0) {
  switch (f) {
    case 'one': return new OneStore()
    case 'blocks16': return new BlockStores(16)
    case 'blocks64': return new BlockStores(64)
    case 'proj': return new ProjStore(['user', 'cents', 'score'])
    case 'arena': return new ArenaStore()
    case 'kvdisk': return new ArenaStore({ file: join(TMP, 'kv') })
    case 'column': return new ColumnStore({ cap })
    case 'sqlite': return new SqliteStore(join(TMP, 'db'))
    case 'sqlite-ix': return new SqliteStore(join(TMP, 'db'), { index: 'score' })
  }
  throw new Error('no form ' + f)
}
function load(s, n) { for (const b of inserts(n)) s.apply(b) }
function fold(s, recs, budgetMs = 3000) { // ns a record over what was done inside the budget
  const t0 = now(); let done = 0
  for (let i = 0; i < recs.length; i += 256) { s.apply(recs.slice(i, i + 256)); done = Math.min(recs.length, i + 256); if ((i & 4095) === 0 && nsSince(t0) > budgetMs * 1e6) break }
  return { ns: nsSince(t0) / done, done }
}
// live views on the column store: fed by its own changes (old row, new row)
function columnViews(s) {
  const col = new SortedCol(); let sum = 0, len = 0
  const num = (x) => (typeof x === 'number' && x === x ? x : undefined)
  s.onChange = (k, o, n) => {
    if (o !== undefined) { len--; const c = num(o.cents); if (c !== undefined) sum -= c; const x = num(o.score); if (x !== undefined) col.remove(x) }
    if (n !== undefined) { len++; const c = num(n.cents); if (c !== undefined) sum += c; const x = num(n.score); if (x !== undefined) col.insert(x) }
  }
  s.field('score', (x) => col.insert(x)); len = s.count(); s.field('cents', (c) => { sum += c })
  return { read: () => ({ sum, len, top: [col.kth(col.n - 1)], med: col.median() }) }
}

if (mode === 'fold') {
  const s = make(form, N)
  load(s, N)
  const gen = makeGen(N), warm = gen(20000), recs = gen(A.recs ?? 400000)
  let v = null
  if (A.views) { if (form === 'column') v = columnViews(s); else if (s.views) v = s.views({ k: 10 }); else throw new Error('no live views on ' + form) }
  fold(s, warm)
  gc()
  const r = fold(s, recs)
  if (v) v.read()
  out({ ...base, views: !!A.views, records: r.done, ns_per_record: +r.ns.toFixed(1), records_per_s: Math.round(1e9 / r.ns) })
} else if (mode === 'mem') {
  gc(); const h0 = heapUsed(), a0 = ab(), r0 = process.memoryUsage.rss()
  const s = make(form, N)
  load(s, N)
  gc(); const h1 = heapUsed(), a1 = ab(), r1 = process.memoryUsage.rss()
  const gen = makeGen(N); for (let i = 0; i < N; i += 65536) s.apply(gen(Math.min(65536, N - i)))
  gc(); const h2 = heapUsed(), a2 = ab(), r2 = process.memoryUsage.rss()
  const file = form.startsWith('sqlite') ? statSync(s.file).size : form === 'kvdisk' ? statSync(join(TMP, 'kv')).size : 0
  const per = (x) => +(x / N).toFixed(1)
  out({ ...base, heap_b_row_load: per(h1 - h0), offheap_b_row_load: per(a1 - a0), rss_b_row_load: per(r1 - r0), heap_b_row_churn: per(h2 - h0), offheap_b_row_churn: per(a2 - a0), rss_b_row_churn: per(r2 - r0), file_b_row: per(file), count: s.count(), compactions: s.compactions ?? 0, overflow: s.over?.size ?? 0 })
} else if (mode === 'read') {
  const s = make(form, N)
  load(s, N)
  const gen = makeGen(N); s.apply(gen(200000))
  if (form === 'kvdisk') s._flush()
  const r = (await import('./lib.mjs')).rng(5)
  const keys = Array.from({ length: 100000 }, () => 'k' + Math.floor(r() * N))
  const reps = (fn, n = 3) => { const xs = []; for (let i = 0; i < n; i++) { gc(); const t = now(); fn(); xs.push(nsSince(t)) } return median(xs) }
  let sink = 0
  const getNs = reps(() => { for (const k of keys) { const row = s.get(k); if (row) sink += row.qty } }) / keys.length
  const count = s.count()
  const fieldNs = reps(() => { s.field('cents', (v) => { sink += v }) }) / count
  const objNs = reps(() => { s.each((k, row) => { if (typeof row.cents === 'number') sink += row.cents }) }, form.startsWith('sqlite') || form === 'kvdisk' ? 1 : 3) / count
  const medMs = reps(() => { const a = new Float64Array(count); let i = 0; s.field('score', (x) => { if (typeof x === 'number') a[i++] = x }); const b = a.subarray(0, i).sort(); sink += b[i >> 1] }) / 1e6
  const extra = {}
  if (form === 'column') extra.column_sum_ns_per_row = +(reps(() => { sink += s.sumNum('cents') }) / count).toFixed(2)
  if (form.startsWith('sqlite')) extra.sql_sum_ns_per_row = +(reps(() => { sink += s.sumSql('cents') }) / count).toFixed(1)
  if (form === 'sqlite-ix') extra.index_median_ms = +(reps(() => { sink += s.medianIx() }) / 1e6).toFixed(1)
  out({ ...base, count, get_ns: +getNs.toFixed(0), field_scan_ns_per_row: +fieldNs.toFixed(1), rows_as_objects_ns_per_row: +objNs.toFixed(1), median_once_ms: +medMs.toFixed(1), ...extra, sink: sink > 0 })
} else if (mode === 'gc') {
  const W = new GcWatch()
  W.set('load')
  const t0 = now()
  const s = make(form, N)
  load(s, N)
  const loadS = nsSince(t0) / 1e9
  await W.flush(); gc(); await W.flush()
  W.set('writes')
  const rate = A.rate ?? 50000, secs = A.secs ?? 10, gen = makeGen(N)
  const pool = gen(rate * secs + 50000) // never reused: a replayed field write could land on a row deleted since
  const eld = monitorEventLoopDelay({ resolution: 1 }); eld.enable()
  let done = 0, pi = 0
  const start = performance.now()
  await new Promise((res) => {
    const tick = () => {
      const el = performance.now() - start
      const due = Math.min(Math.floor((el / 1000) * rate), done + 2000)
      if (due > done) { const n = Math.min(due - done, pool.length - pi); const b = pool.slice(pi, pi + n); pi += n; for (let i = 0; i < b.length; i += 256) s.apply(b.slice(i, i + 256)); done += n }
      if (el >= secs * 1000) return res()
      setTimeout(tick, 1)
    }
    tick()
  })
  eld.disable(); await W.flush()
  const g = W.report()
  out({ ...base, rate, secs, achieved: Math.round(done / secs), load_s: +loadS.toFixed(1), heap_mb: Math.round(heapUsed() / 2 ** 20), offheap_mb: Math.round(ab() / 2 ** 20), gc_load_max_ms: g.load?.max_ms ?? 0, gc_load_major_ms: g.load?.max_major_ms ?? 0, gc_writes_max_ms: g.writes?.max_ms ?? 0, gc_writes_major_ms: g.writes?.max_major_ms ?? 0, eld_p99_ms: +(eld.percentile(99) / 1e6).toFixed(1), eld_max_ms: +(eld.max / 1e6).toFixed(1) })
} else if (mode === 'median') {
  const s = new OneStore()
  if (form === 'data16') { s.blocks = new BlockStores(16) }
  const st = form === 'data16' ? s.blocks : s
  load(st, N)
  const gen = makeGen(N), warm = gen(5000), recs = gen(A.recs ?? 200000)
  let read = () => undefined
  if (form === 'data') { const m = st.s.src.median('score'); read = () => m[Symbol.for('data.v4.value')] }
  if (form === 'data16') { const ms = st.st.map((x) => x.src.median('score')); read = () => ms.map((m) => m[Symbol.for('data.v4.value')]) }
  if (form === 'sorted') {
    const col = new SortedCol(), num = (x) => (typeof x === 'number' && x === x ? x : undefined)
    st.s.node.each((_, row) => { const x = num(row?.score); if (x !== undefined) col.insert(x) })
    st.s.src.sink({ apply(b) { for (const d of b.rows) { const o = d.op === 'add' ? undefined : num(d.prev?.score), n = d.op === 'remove' ? undefined : num(d.row?.score); if (o === n) continue; if (o !== undefined) col.remove(o); if (n !== undefined) col.insert(n) } } })
    read = () => col.median()
  }
  fold(st, warm); gc()
  const r = fold(st, recs, 4000)
  const t = now(); for (let i = 0; i < 100; i++) read(); const readNs = nsSince(t) / 100
  out({ ...base, records: r.done, ns_per_record: +r.ns.toFixed(1), read_ns: +readNs.toFixed(0) })
} else if (mode === 'cap') {
  const t0 = now(); let held = 0, err = null
  try {
    if (form === 'column') {
      const s = new ColumnStore({ cap: N })
      for (const b of inserts(N, 99, 8192)) { s.apply(b); held += b.length }
    } else {
      const s = form === 'one' ? new OneStore() : new BlockStores(16)
      for (let i = 0; i < N; i += 8192) { const b = []; for (let j = i; j < Math.min(N, i + 8192); j++) b.push({ type: 1, key: [], at: 'k' + j, value: { n: j } }); s.apply(b); held = Math.min(N, i + 8192) }
    }
  } catch (e) { err = String(e?.message ?? e).slice(0, 120) }
  gc()
  out({ ...base, held, error: err, seconds: +(nsSince(t0) / 1e9).toFixed(1), heap_mb: Math.round(heapUsed() / 2 ** 20), offheap_mb: Math.round(ab() / 2 ** 20), rss_mb: Math.round(process.memoryUsage.rss() / 2 ** 20) })
} else if (mode === 'probe') {
  const t = (fn, n = 20000) => { fn(); const t0 = now(); for (let i = 0; i < n; i++) fn(); return +(nsSince(t0) / n).toFixed(0) }
  out({ ...base, form: 'none', heap_statistics_ns: t(() => v8.getHeapStatistics()), memory_usage_ns: t(() => process.memoryUsage(), 5000), rss_ns: t(() => process.memoryUsage.rss()), heap_used_only_ns: t(() => v8.getHeapStatistics().used_heap_size) })
}
