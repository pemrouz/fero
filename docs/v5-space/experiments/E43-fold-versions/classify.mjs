// E-43: join two explain files (the same root records, folded by A and by B) and count the roots by what the
// record met in the row (the "situation"), with one example each.
//   node classify.mjs <a.explain.jsonl> <b.explain.jsonl> [A name] [B name]
import fs from 'node:fs'
const [A, B, AN = 'A', BN = 'B'] = process.argv.slice(2)
const rd = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.index, o] }))
const a = rd(A), b = rd(B)
const groups = new Map()
for (const [i, x] of a) {
  const y = b.get(i); if (!y) continue
  const sameBefore = x.before === y.before
  const key = (sameBefore ? x.situation : '(rows already apart) ' + x.situation) + ' || ' + AN + ': ' + (x.outcome === 'applied' ? 'taken' : 'refused') + ' | ' + BN + ': ' + (y.outcome === 'applied' ? 'taken' : 'refused')
  const g = groups.get(key) ?? { n: 0, example: null }
  g.n++
  if (g.example === null) g.example = { index: i, record: x.record, before: x.before, [AN]: { outcome: x.outcome, after: x.after }, [BN]: { outcome: y.outcome, after: y.after } }
  groups.set(key, g)
}
const out = [...groups.entries()].sort((p, q) => q[1].n - p[1].n).map(([k, g]) => ({ situation: k, roots: g.n, example: g.example }))
console.log(JSON.stringify(out, null, 1))
