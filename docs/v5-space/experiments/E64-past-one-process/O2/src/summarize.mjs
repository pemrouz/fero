// E-64 O2: the tables of README.md from results/*.jsonl. Ranges are min to max over the timed runs.
import { readFileSync, existsSync } from 'node:fs'
const R = process.argv[2]
const load = (f) => (existsSync(R + '/' + f) ? readFileSync(R + '/' + f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.exp === 'E-64') : [])
const rng = (xs, d = 1) => { if (!xs.length) return '—'; const a = Math.min(...xs), b = Math.max(...xs); return a === b ? a.toFixed(d) : a.toFixed(d) + ' to ' + b.toFixed(d) }
const fmt = (n) => (n === null || n === undefined ? '—' : typeof n === 'number' ? n.toLocaleString('en-US') : String(n))
const lines = []
const p = (s = '') => lines.push(s)

const d = load('d.jsonl')
p('## D1 and D2: count-by and exact sum-by from the change stream')
p()
p('Seeds of 1,500 steps (one source write a step), checked every 50 steps and at the end after a drain; long runs are one seed of 50,000 steps.')
p()
p('| form | groups | shares | P | domain | down | seeds | failed | checks | moves | crashes | zombies applied | refusals gap / dup / fenced | batches | bucket deltas | source changes | checks with partitions at different cuts | rows counted twice or nowhere (checks) |')
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const o of d.filter((o) => !o.mutate)) {
  const seeds = o.mode === 'seeds' ? fmt(o.seeds) : '1 × ' + fmt(o.world.entries)
  const failed = o.mode === 'seeds' ? o.seedsFailed : o.failed ? 1 : 0
  const ref = o.mode === 'seeds' ? `${fmt(o.gapRefusals)} / ${fmt(o.dupRefusals)} / ${fmt(o.fencedRefusals)}` : `${fmt(o.target.gap)} / ${fmt(o.target.dup ?? 0)} / ${fmt(o.target.fenced ?? 0)}`
  const moves = o.mode === 'seeds' ? o.moves : o.world.moves
  const crashes = o.crashes
  const zomb = o.zombiesApplied
  const writes = o.writes
  const deltas = o.mode === 'seeds' ? o.deltas : o.target.deltas
  const ch = o.mode === 'seeds' ? o.sourceChanges : o.world.changes
  const cd = o.mode === 'seeds' ? o.cutsDifferChecks : o.cutsDiffer
  const an = o.mode === 'seeds' ? `${fmt(o.crossAnomalies)} (${fmt(o.anomalyChecks)})` : `${fmt(o.anomalies)} (${fmt(o.anomalyChecks)})`
  p(`| ${o.form === 'replace' ? 'D2 replace' : 'D1 marks'} | ${o.groups} | ${o.shares} | ${o.P ?? '—'} | ${o.dom} | ${o.down ? 'yes' : 'no'} | ${seeds} | ${failed} | ${fmt(o.checks)} | ${fmt(moves)} | ${fmt(crashes)} | ${fmt(zomb)} | ${ref} | ${fmt(writes)} | ${fmt(deltas)} | ${fmt(ch)} | ${fmt(cd)} | ${an} |`)
}
p()
p('Planted bugs (G = 4, S = 4), and one control:')
p()
p('| form | planted | P | domain | seeds | seeds failed |')
p('|---|---|---|---|---|---|')
for (const o of d.filter((o) => o.mutate)) p(`| ${o.form === 'replace' ? 'D2' : 'D1'} | ${o.mutate} | ${o.P ?? '—'} | ${o.dom} | ${fmt(o.seeds)} | ${fmt(o.seedsFailed)} |`)
p()

const t1 = load('t1.jsonl')
p('## T1: a top-k per share with a bounded buffer, and the merge of the shares')
p()
p('| groups | shares | k | kp | kmax | planted | seeds | failed | checks | changes | refills (of them restarts) | rows scanned by refills | largest buffer |')
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const o of t1) {
  const seeds = o.mode === 'seeds' ? fmt(o.seeds) : '1 × ' + fmt(o.steps)
  const failed = o.mode === 'seeds' ? o.seedsFailed : o.failed ? 1 : 0
  p(`| ${o.groups} | ${o.shares} | ${o.k} | ${o.kp} | ${o.kmax} | ${o.mutate ?? '—'} | ${seeds} | ${failed} | ${fmt(o.checks)} | ${fmt(o.changes)} | ${fmt(o.refills)} (${fmt(o.restarts)}) | ${fmt(o.refillRows)} | ${o.maxBuf} |`)
}
p()

const t2 = load('t2.jsonl')
p('## T2: refills of a bounded top-k buffer (k = 10, kmax = 2 kp), per 1e6 changes')
p()
p('Each cell: refills per 1e6 changes; rows scanned per change in brackets. Every check of the buffer against a full sort passed unless marked.')
p()
const kps = [...new Set(t2.map((o) => o.kp))].sort((a, b) => a - b)
p('| rows | workload | ' + kps.map((k) => 'kp = ' + k).join(' | ') + ' |')
p('|---|---|' + kps.map(() => '---').join('|') + '|')
for (const n of [...new Set(t2.map((o) => o.rows))]) for (const wl of ['up', 'walk', 'uniform', 'churn', 'topdel']) {
  const cells = kps.map((kp) => { const o = t2.find((x) => x.rows === n && x.workload === wl && x.kp === kp); return o ? `${fmt(o.refillsPerMillion)} (${fmt(o.rowsScannedPerChange)})${o.bad ? ' BAD ' + o.bad : ''}` : '—' })
  if (cells.every((c) => c === '—')) continue
  p(`| ${fmt(n)} | ${wl} | ${cells.join(' | ')} |`)
}
p()

const b = load('bytes.jsonl')
if (b.length) {
  const o = b[0]
  p('## Bytes a record, fero v4\'s codec, frames of 256')
  p()
  p(`| log as is | + before-image of 2 fields (user, cents) | + 3 fields (also score) | + the whole row before | records that need one | an enriched item (key, 2 fields before and after) |`)
  p('|---|---|---|---|---|---|')
  p(`| ${o.log_b_per_record} B | +${o.proj2_prev_b_per_record} B (+${(o.proj2_share * 100).toFixed(1)} %) | +${o.proj3_prev_b_per_record} B (+${(o.proj3_share * 100).toFixed(1)} %) | +${o.row_prev_b_per_record} B (+${(o.row_share * 100).toFixed(1)} %) | ${(o.records_needing_prev * 100).toFixed(1)} % | ${o.enriched2_b_per_record} B |`)
  p()
}

const t = load('timing.jsonl')
if (t.length) {
  p('## Timed costs (three runs, each alone under the timing lock; range over the runs)')
  p()
  p('A copy\'s fold, lanes of 256 records, ns a record:')
  p()
  p('| rows | plain fold | + a no-op sink | + the enricher | changes per record |')
  p('|---|---|---|---|---|')
  for (const n of [...new Set(t.filter((o) => o.bench === 'enrich').map((o) => o.rows))]) {
    const g = (v) => rng(t.filter((o) => o.bench === 'enrich' && o.rows === n && o.variant === v).map((o) => o.ns_per_record), 0)
    const c = t.find((o) => o.bench === 'enrich' && o.rows === n && o.variant === 'enrich')?.changesPerRecord
    p(`| ${fmt(n)} | ${g('plain')} | ${g('sink')} | ${g('enrich')} | ${c ?? '—'} |`)
  }
  p()
  p('R0\'s way, one store holding every row, with a count-by and exact sum-by kept from data\'s deltas:')
  p()
  p('| rows | heap a row | fold, ns a record | fold and view | the view\'s share |')
  p('|---|---|---|---|---|')
  for (const n of [...new Set(t.filter((o) => o.bench === 'r0').map((o) => o.rows))]) {
    const xs = t.filter((o) => o.bench === 'r0' && o.rows === n)
    p(`| ${fmt(n)} | ${rng(xs.map((o) => o.heap_b_per_row), 0)} B | ${rng(xs.map((o) => o.ns_fold), 0)} | ${rng(xs.map((o) => o.ns_fold_and_view), 0)} | ${rng(xs.map((o) => o.ns_view), 0)} |`)
  }
  p()
  p('The delta runner, no rows held; 1e6 enriched items:')
  p()
  p('| buckets | window W | sum | runner, ns an item | target merge, ns a bucket delta | bucket deltas an item | batches an item |')
  p('|---|---|---|---|---|---|---|')
  const rs = t.filter((o) => o.bench === 'runner')
  for (const key of [...new Set(rs.map((o) => `${o.buckets}|${o.W}|${o.sum}`))]) {
    const [bk, w, s] = key.split('|'); const xs = rs.filter((o) => `${o.buckets}|${o.W}|${o.sum}` === key)
    p(`| ${fmt(+bk)} | ${w} | ${s} | ${rng(xs.map((o) => o.ns_runner_per_item), 0)} | ${rng(xs.map((o) => o.ns_target_per_delta), 0)} | ${xs[0].deltas_per_item} | ${xs[0].writes_per_item} |`)
  }
  p()
  p('A refill\'s scan at a copy (every row of a data store, keep the best kp = 20):')
  p()
  p('| rows | ms a scan | ns a row |')
  p('|---|---|---|')
  for (const n of [...new Set(t.filter((o) => o.bench === 'scan').map((o) => o.rows))]) {
    const xs = t.filter((o) => o.bench === 'scan' && o.rows === n)
    p(`| ${fmt(n)} | ${rng(xs.map((o) => o.ms_per_scan), 1)} | ${rng(xs.map((o) => o.ns_per_row), 1)} |`)
  }
  p()
  p('Decoding with fero v4\'s codec (frames of 256, each record made a plain object), ns a record:')
  p()
  p('| a record of the log (what R0\'s host decodes, every record) | an enriched item (what a runner decodes, its share only) |')
  p('|---|---|')
  p(`| ${rng(t.filter((o) => o.bench === 'decode' && o.which === 'log').map((o) => o.ns_per_record), 0)} | ${rng(t.filter((o) => o.bench === 'decode' && o.which === 'enriched').map((o) => o.ns_per_record), 0)} |`)
  p()
  const loads = readFileSync(R + '/timing.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.loadavg).map((o) => +o.loadavg.split(' ')[0])
  if (loads.length) p(`One-minute load average at process start: ${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)}.`)
}
process.stdout.write(lines.join('\n') + '\n')
