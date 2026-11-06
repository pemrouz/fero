// Summarise run D: per operator and variant, the median and spread (max - min)
// of ns per commit over 3 runs; the merge layer's cost (merge - views) per
// commit and per partial delta; and the one-group cost beside it.
import { readFileSync } from 'node:fs'
const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.startsWith('{'))
const by = new Map<string, any[]>()
for (const l of lines) { const j = JSON.parse(l); const k = j.op + '/' + j.variant; if (!by.has(k)) by.set(k, []); by.get(k)!.push(j) }
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const get = (op: string, v: string) => {
  const rs = by.get(op + '/' + v)
  if (!rs) return null
  const ns = rs.map((r) => r.nsPerCommit)
  return { n: rs.length, med: med(ns), spread: Math.max(...ns) - Math.min(...ns), deltas: rs[0].deltas, sanity: [...new Set(rs.map((r) => r.sanity))].join(','), load: rs.map((r) => r.loadavg.split(' ')[0]).join(' ') }
}
console.log('16 groups, int domain, 200,000 timed commits per run, 3 runs per row (median, spread = max - min)')
console.log('op       variant  runs  ns/commit  spread  sanity  1-min load at start of each run (inside the lock)')
for (const op of ['all', 'filter', 'topk', 'sum', 'group']) {
  for (const v of ['base', 'one', 'views', 'merge', 'viewsC', 'mergeC']) {
    const r = get(op, v)
    if (r) console.log(`${op.padEnd(8)} ${v.padEnd(8)} ${String(r.n).padStart(4)}  ${String(r.med).padStart(9)}  ${String(r.spread).padStart(6)}  ${r.sanity.padEnd(6)}  ${r.load}`)
  }
}
console.log('')
console.log('merge layer cost (merge - views, medians), per commit and per partial delta it consumed:')
for (const op of ['filter', 'topk', 'sum', 'group']) {
  for (const [m, w] of [['merge', 'views'], ['mergeC', 'viewsC']]) {
    const a = get(op, m), b = get(op, w), one = get(op, 'one')
    if (!a || !b) continue
    const d = (a.deltas as Record<string, number>)[op]
    const perCommit = d / 200000
    const cost = a.med - b.med
    console.log(`${op.padEnd(7)} ${m.padEnd(7)} ${String(cost).padStart(6)} ns/commit; ${perCommit.toFixed(2)} partial deltas/commit; ${(cost / perCommit).toFixed(0).padStart(6)} ns per delta; the partials (views) ${b.med} ns/commit vs one group ${one?.med ?? '-'} ns/commit`)
  }
}
