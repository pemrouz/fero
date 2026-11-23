// E-65 X1: results/*.jsonl -> the tables of results/summary.md. A timed cell is "median (lowest-highest)" over
// the runs; a seeded line is one process. Lines that only carry a load average are skipped.
import { readFileSync, existsSync } from 'node:fs'
const R = new URL('../results/', import.meta.url)
const lines = (f) => existsSync(new URL(f, R)) ? readFileSync(new URL(f, R), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.exp) : []
const fails = (f) => existsSync(new URL(f, R)) ? readFileSync(new URL(f, R), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.failed && typeof o.failed === 'string') : []
const loads = (f) => existsSync(new URL(f, R)) ? readFileSync(new URL(f, R), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.cmd).map((o) => +o.loadavg.split(' ')[0]) : []
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
const fmt = (x) => x === undefined || x === null ? '-' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)
const cell = (xs) => { xs = xs.filter((x) => typeof x === 'number'); if (!xs.length) return '-'; if (xs.length === 1) return fmt(xs[0]); return `${fmt(med(xs))} (${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))})` }
const group = (rows, keyf) => { const m = new Map(); for (const r of rows) { const k = keyf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r) } return m }
const table = (head, rows) => '| ' + head.join(' | ') + ' |\n|' + head.map(() => '---').join('|') + '|\n' + rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n') + '\n'
const loadNote = (f) => { const l = loads(f); return l.length ? `load average (1 min) at the start of each process: median ${med(l).toFixed(2)}, range ${Math.min(...l).toFixed(2)}-${Math.max(...l).toFixed(2)}, n=${l.length}\n` : '' }
let o = '# E-65 X1: results\n\nPrinted by `node src/summarize.mjs` from the JSON lines in this folder. A timed cell is the median of the runs and, in brackets, the lowest and highest run.\n\n'

// ── seeded runs ──
const sims = lines('sims.jsonl')
if (sims.length) {
  o += '## Seeded runs: the split stores and the compact stores\n\n'
  o += table(['part', 'form', 'S', 'G', 'domain', 'planted', 'seeds', 'failed', 'checks', 'slot moves', 'records held (B1)', 'resends dropped (B2)', 'rows moved (B4)', 'float sum off exact', 'first failure'],
    sims.map((s) => [s.part, s.form, s.S ?? '-', s.G ?? '-', s.dom, s.mutate, s.seeds, s.failed, (s.checks ?? 0).toLocaleString('en-US'), s.moves ?? '-', s.held ?? '-', s.dups ?? '-', s.moved_rows || '-', s.floatSumChecks ? `${s.floatSumOff} of ${s.floatSumChecks}` : '-', s.first_fail ? `seed ${s.first_fail.seed}: ${String(s.first_fail.err).slice(0, 70).replace(/\|/g, '/')}` : '-']))
  o += '\n' + loadNote('sims.jsonl') + '\n'
}
const bud = lines('budget.jsonl')
if (bud.length) {
  o += '## Seeded runs: the memory-budget guard (budget 32 MB of heap, heap limit 128 MB)\n\n'
  o += table(['policy', 'seeds', 'failed', 'why', 'live heap at the warning, % of budget (min, p50, max)', 'live heap at the refusal (min, p50, max)', 'guard check ns', 'largest forced collection ms'],
    bud.map((b) => [b.policy, b.seeds, b.failed, Object.entries(b.reasons).map(([k, v]) => `${k}: ${v}`).join('; ') || '-', `${b.warn_live_pct.min}, ${b.warn_live_pct.p50}, ${b.warn_live_pct.max}`, `${b.refuse_live_pct.min}, ${b.refuse_live_pct.p50}, ${b.refuse_live_pct.max}`, b.check_ns_p50, b.confirm_gc_ms_max || '-']))
  const m = bud[0].model
  o += `\nThe model fitted at start (heap bytes a row = a x JSON bytes + b): a = ${m.a}, b = ${m.b}; points ${m.points.map((p) => `${p.json_b} B of JSON -> ${p.heap_b} B of heap`).join(', ')}.\n` + loadNote('budget.jsonl') + '\n'
}
const cap = lines('cap.jsonl')
if (cap.length) {
  o += '## Past 16,777,216 rows a source (counted, one run each, heavy lock)\n\n'
  o += table(['form', 'rows asked', 'rows held', 'stopped by', 'seconds', 'heap MB', 'off-heap MB', 'RSS MB'], cap.map((c) => [c.form, c.rows.toLocaleString('en-US'), c.held.toLocaleString('en-US'), c.error ?? '-', c.seconds, c.heap_mb, c.offheap_mb, c.rss_mb]))
  o += '\n'
}
const pd = lines('probe-drop.jsonl')
if (pd.length) {
  o += '## Does data free a dropped source? (checked, a probe, three rounds of 1e5 small rows a way)\n\n'
  o += table(['way', 'heap MB at start', 'heap MB after each round', 'kept MB a round'], ['drop', 'dispose', 'clear'].map((w) => [w, pd[0][w].start_mb, pd[0][w].after_each_round_mb.join(', '), pd[0][w].kept_mb_per_round]))
  o += '\n'
}
const mem = lines('mem.jsonl')
if (mem.length) {
  o += '## Bytes a row at 1e6 rows (heavy lock; runs agree closely)\n\n'
  const g = group(mem, (m) => m.form)
  o += table(['form', 'heap after load', 'off-heap after load', 'RSS after load', 'heap after 1e6 more writes', 'off-heap after', 'RSS after', 'file', 'runs'],
    [...g].map(([f, ms]) => [f, cell(ms.map((m) => m.heap_b_row_load)), cell(ms.map((m) => m.offheap_b_row_load)), cell(ms.map((m) => m.rss_b_row_load)), cell(ms.map((m) => m.heap_b_row_churn)), cell(ms.map((m) => m.offheap_b_row_churn)), cell(ms.map((m) => m.rss_b_row_churn)), cell(ms.map((m) => m.file_b_row)), ms.length]))
  o += '\n'
}
// ── timed ──
const T = lines('timing.jsonl')
if (T.length) {
  const fold = T.filter((t) => t.bench === 'fold')
  o += '## Fold: ns a record at 1e6 rows, the write mix in lanes of 256 (timing lock)\n\n'
  const g = group(fold, (t) => t.form + '|' + t.views)
  o += table(['form', 'live views', 'ns a record', 'records a second', 'runs'], [...g].map(([k, ts]) => [ts[0].form, ts[0].views ? 'yes' : 'no', cell(ts.map((t) => t.ns_per_record)), cell(ts.map((t) => t.records_per_s)), ts.length]))
  const md = T.filter((t) => t.bench === 'median')
  o += '\n## A live median: ns a record (fold and median), and one read of the median\n\n'
  const gm = group(md, (t) => t.form + '|' + t.rows)
  o += table(['median form', 'rows', 'ns a record', 'read ns', 'runs'], [...gm].map(([k, ts]) => [ts[0].form, ts[0].rows.toLocaleString('en-US'), cell(ts.map((t) => t.ns_per_record)), cell(ts.map((t) => t.read_ns)), ts.length]))
  const rd = T.filter((t) => t.bench === 'read')
  o += '\n## Reads over every row at 1e6 rows\n\n'
  const gr = group(rd, (t) => t.form)
  o += table(['form', 'get ns', 'one field, ns a row', 'every row as an object, ns a row', 'exact median once, ms', 'column sum ns a row', 'SQL sum ns a row', 'index median ms', 'runs'],
    [...gr].map(([f, ts]) => [f, cell(ts.map((t) => t.get_ns)), cell(ts.map((t) => t.field_scan_ns_per_row)), cell(ts.map((t) => t.rows_as_objects_ns_per_row)), cell(ts.map((t) => t.median_once_ms)), cell(ts.map((t) => t.column_sum_ns_per_row)), cell(ts.map((t) => t.sql_sum_ns_per_row)), cell(ts.map((t) => t.index_median_ms)), ts.length]))
  const gcs = T.filter((t) => t.bench === 'gc')
  o += '\n## GC pauses: loading 5e6 rows, then 10 s of 50,000 writes a second (ms)\n\n'
  const gg = group(gcs, (t) => t.form)
  o += table(['form', 'load s', 'heap MB', 'off-heap MB', 'load: longest pause', 'load: longest major', 'writes: longest pause', 'writes: longest major', 'loop delay p99', 'loop delay max', 'achieved/s', 'runs'],
    [...gg].map(([f, ts]) => [f, cell(ts.map((t) => t.load_s)), cell(ts.map((t) => t.heap_mb)), cell(ts.map((t) => t.offheap_mb)), cell(ts.map((t) => t.gc_load_max_ms)), cell(ts.map((t) => t.gc_load_major_ms)), cell(ts.map((t) => t.gc_writes_max_ms)), cell(ts.map((t) => t.gc_writes_major_ms)), cell(ts.map((t) => t.eld_p99_ms)), cell(ts.map((t) => t.eld_max_ms)), cell(ts.map((t) => t.achieved)), ts.length]))
  const pr = T.filter((t) => t.bench === 'probe')
  if (pr.length) o += `\nReading this process's memory (ns a call): v8.getHeapStatistics() ${cell(pr.map((p) => p.heap_statistics_ns))}; process.memoryUsage() ${cell(pr.map((p) => p.memory_usage_ns))}; process.memoryUsage.rss() ${cell(pr.map((p) => p.rss_ns))}.\n`
  o += '\n' + loadNote('timing.jsonl')
  const f = fails('timing.jsonl'); if (f.length) o += `\nFailed processes: ${f.map((x) => x.failed).join('; ')}. (The two GC lines of run 1 failed from a bench bug: the write pool wrapped and replayed a field write on a row deleted since, which data refuses. The pool was fixed and both lines were run again as run 1; their command lines carry a note.)\n`
}
const Wk = lines('workers.jsonl')
if (Wk.length) {
  o += '\n## Worker threads: the fold of 1e6 records over 1e6 rows, split by slot (timing lock)\n\n'
  const g = group(Wk.filter((w) => w.bench === 'workers-fold'), (w) => w.W + '|' + w.views)
  o += table(['workers', 'live views (count, sum, exact median kept on the main thread)', 'records a second, all workers', 'main thread busy %', 'each worker busy %', 'kept median = a fresh sort at the end', 'runs'],
    [...g].map(([k, ws]) => [ws[0].W === 0 ? '0 (main folds)' : ws[0].W, ws[0].views ? 'yes' : 'no', cell(ws.map((w) => w.records_per_s)), cell(ws.map((w) => w.main_busy_pct)), ws[0].worker_busy_pct ? ws.map((w) => w.worker_busy_pct.join('/')).join('; ') : '-', ws.some((w) => w.median_check) ? `${ws.filter((w) => w.median_check?.equal).length} of ${ws.filter((w) => w.median_check).length}` : '-', ws.length]))
  const gr = group(Wk.filter((w) => w.bench === 'workers-read'), (w) => w.W)
  o += '\n## Worker threads: reads over every row from the main thread (1e6 rows)\n\n'
  o += table(['workers', 'get, one at a time (round trip us)', 'get, 64 in flight (ns each)', 'every row as pages decoded here (ns a row)', 'one column, then an exact median (ms)', 'runs'],
    [...gr].map(([k, ws]) => [k, cell(ws.map((w) => w.get_rtt_us)), cell(ws.map((w) => w.get_pipelined_ns)), cell(ws.map((w) => w.scan_ns_per_row)), cell(ws.map((w) => w.column_median_ms)), ws.length]))
  o += '\n' + loadNote('workers.jsonl')
  const f = fails('workers.jsonl'); if (f.length) o += `\nFailed processes: ${f.map((x) => x.failed).join('; ')}\n`
}
process.stdout.write(o)
