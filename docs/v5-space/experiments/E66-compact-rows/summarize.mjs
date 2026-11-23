// E-66: the timed results in short, as ranges over the three runs (min to max of each run's median).
import { readFileSync, existsSync } from 'node:fs'
const R = new URL('./results/', import.meta.url)
const lines = (f) => existsSync(new URL(f, R)) ? readFileSync(new URL(f, R), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const rng = (xs) => { const a = Math.min(...xs), b = Math.max(...xs); return a === b ? `${a}` : `${a} to ${b}` }
const o = []
const rr = lines('rowread.jsonl')
if (rr.length) {
  o.push(`## One read of a held row, ns, at ${rr[0].rows} rows (${new Set(rr.map((r) => r.run)).size} runs)`, '', '| Form | one field | all eight fields | compare two rows |', '|---|---|---|---|')
  const forms = [['data', (r) => r.form === 'data' && r.ns], ...['mat', 'fly', 'proxy', 'fly-map', 'id', 'id-map'].map((f) => [f, (r) => r.form === 'col' && r.ns[f]])]
  for (const [name, get] of forms) { const xs = rr.map(get).filter(Boolean); if (xs.length) o.push(`| ${name} | ${rng(xs.map((x) => x.one))} | ${rng(xs.map((x) => x.all))} | ${rng(xs.map((x) => x.cmp))} |`) }
  o.push('', `loadavg at start: ${rr.map((r) => r.loadavg).join('; ')}`, '')
}
const kg = lines('keymap-gc.jsonl')
if (kg.length) {
  o.push('## One forced full collection (three in a row per run; the range is over every collection of every run)', '', '| Form | Rows | Pause ms | Heap MB | Off-heap MB | RSS MB |', '|---|---|---|---|---|---|')
  for (const n of [...new Set(kg.map((r) => r.rows))]) for (const f of ['map', 'ix', 'keys']) {
    const xs = kg.filter((r) => r.rows === n && r.form === f); if (!xs.length) continue
    o.push(`| ${f} | ${n} | ${rng(xs.flatMap((x) => x.forced_gc_ms))} | ${rng(xs.map((x) => x.heap_used_mb))} | ${rng(xs.map((x) => x.off_heap_mb))} | ${rng(xs.map((x) => x.heap_mb))} |`)
  }
  o.push('', `loadavg at start: ${kg.map((r) => r.loadavg).join('; ')}`, '')
}
const rm = lines('rowmake.jsonl')
for (const n of [...new Set(rm.map((r) => r.rows))]) {
  const rm1 = rm.filter((r) => r.rows === n)
  o.push(`## Review: a row made for the fixed shape, ns, at ${n} rows (${new Set(rm1.map((r) => r.run)).size} runs)`, '', '| Form | one field | all eight fields | keep the row |', '|---|---|---|---|')
  const forms = [['data', (r) => r.form === 'data' && r.ns], ...['mat', 'lit', 'lit-frz', 'lit-notext', 'lit-frz-map', 'fly', 'fly-map'].map((f) => [f, (r) => r.form === 'col' && r.ns[f]])]
  for (const [name, get] of forms) { const xs = rm1.map(get).filter(Boolean); if (xs.length) o.push(`| ${name} | ${rng(xs.map((x) => x.one))} | ${rng(xs.map((x) => x.all))} | ${rng(xs.map((x) => x.keep))} |`) }
  o.push('', `loadavg at start: ${rm1.map((r) => r.loadavg).join('; ')}`, '')
}
if (rm.length) {
  const ck = lines('rowmake-check.jsonl')
  if (ck.length) o.push(`Every form checked against data's own rows: ${ck.map((c) => `${c.fields} fields at ${c.rows} rows, ${c.bad} differ`).join('; ')}`, '')
}
const ki = lines('keyindex.jsonl')
if (ki.length) {
  o.push(`## Review: the key index grown from empty to ${ki[0].rows} keys (${new Set(ki.map((r) => r.run)).size} runs)`, '', 'A stall is one insert that took 1 ms or more. The rebuild columns count stalls with no collection in them; the four longest that came at the same key count in every run are listed. ix keeps its index in typed arrays, off the heap.', '', '| Form | Keys inserted | Stopped at | Longest rebuild stall, ms | The four longest, by key count (ms) | Longest stall with a collection, ms | Insert all, ms | Heap MB at the end |', '|---|---|---|---|---|---|---|---|')
  for (const f of ['map', 'blocks', 'ix']) {
    const xs = ki.filter((r) => r.form === f); if (!xs.length) continue
    const at = new Map(); for (const x of xs) for (const [ms, n] of x.rebuild_top) { if (!at.has(n)) at.set(n, []); at.get(n).push(ms) }
    const tops = [...at].filter(([, v]) => v.length === xs.length).sort((a, b) => b[0] - a[0]).map(([n, v]) => `${n}: ${rng(v)}`).join('; ') || 'none in every run'
    o.push(`| ${f} | ${rng(xs.map((x) => x.inserted))} | ${xs.map((x) => x.cap_at ?? '—').join(', ')} | ${rng(xs.map((x) => x.rebuild_ms))} | ${tops} | ${rng(xs.map((x) => x.gc_stall_ms))} | ${rng(xs.map((x) => x.total_ms))} | ${rng(xs.map((x) => x.heap_mb))} |`)
  }
  o.push('', `loadavg at start: ${ki.map((r) => r.loadavg).join('; ')}`, '')
}
console.log(o.join('\n'))
