// E-66 probe: how much of data's engine reads rows as objects. A count over data's source (DATA, read only), class
// by class: what a column store inside data (option C2) would have to change. Not timed; nothing runs data.
//   holds   state fields that keep row objects (a Map of key -> row, or of bucket -> rows): these keep every row
//           they hold alive on the V8 heap, so a column store under them gains nothing for that view (a field
//           that is declared but never set, as OrderedView's `rows` since data's M6 work, is not counted)
//   maybe   state fields whose values are `unknown` (a Map, or a Record keyed by string), set in the class: they keep
//           a projection, and the projection is the row itself when no field or function is named (or, for
//           ToValueNode's `mirror`, always). Read by hand: COMPACT.md section 2, row 3
//   inherits  the class extends a class with `holds` or `maybe`, so it keeps what its base keeps
//   rowAt   calls that fetch a row by key from a parent (the way M6 views read rows without keeping them)
//   delta   reads of a change's `row` or `prev` (data's delta carries both rows by reference)
//   fn      calls of the app's own function on a row (filter, map, group, reduce, a comparator, a projection)
//   col     the class can name one field (`this.col`), so it could read that column with no row object
//   pass    full passes over a parent (`each(` or `snapshot()`)
// The other columns are approximate: a class's body runs to the next class, so free functions after a class
// count for it, and helpers above a file's first class count for none.
//   node ops-count.mjs   (DATA defaults to ../data next to this repo)
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA, out } from '../../E65-every-row/X1/src/lib.mjs'

const files = [...readdirSync(join(DATA, 'ops')).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => 'ops/' + f), 'kernel/node.ts']
const rows = []
for (const f of files) {
  const src = readFileSync(join(DATA, f), 'utf8'), lines = src.split('\n')
  const starts = []
  lines.forEach((l, i) => { const m = /^(?:export )?(?:abstract )?class (\w+)(?:<[^>]*>)?(?: extends (\w+))?/.exec(l); if (m) starts.push([m[1], i, m[2] ?? null]) })
  starts.forEach(([name, at, ext], j) => {
    const body = lines.slice(at, j + 1 < starts.length ? starts[j + 1][1] : lines.length).join('\n')
    const holds = [...body.matchAll(/declare (\w+): [^\n]*Map<(?:RowKey|string), (?:T|Out|Map<RowKey, T>|\{[^}]*Map<string, T>[^}]*\})>/g)].map((m) => m[1]).filter((n) => new RegExp('this\\.' + n + ' = ').test(body)) // declared and set
    const maybe = [...body.matchAll(/declare (\w+): (?:Map<(?:RowKey|string), unknown>|Record<string, unknown>)/g)].map((m) => m[1]).filter((n) => new RegExp('this\\.' + n + ' = ').test(body))
    const c = (re) => (body.match(re) || []).length
    rows.push({ file: f, line: at + 1, cls: name, ext, holds, maybe, rowAt: c(/\browAt\((?!key: RowKey)/g), delta: c(/\.(?:row|prev)\b(?!\w)/g),
      fn: c(/this\.(?:fn|pred|userCmp|projFn|addFn|removeFn|proj)\(/g), col: /this\.col\b/.test(body), pass: c(/\.each\(|\.snapshot\(\)/g) })
  })
}
const by = new Map(rows.map((r) => [r.cls, r]))
const keeps = (r, k) => r ? (r[k].length > 0 || keeps(by.get(r.ext), k)) : false // through `extends`, within data's ops
for (const r of rows) { r.inherits = !r.holds.length && !r.maybe.length && (keeps(by.get(r.ext), 'holds') || keeps(by.get(r.ext), 'maybe')) ? r.ext : null; out(r) }
const names = (pred) => rows.filter(pred).map((r) => r.cls).sort()
const sum = (k) => rows.reduce((s, r) => s + (Array.isArray(r[k]) ? r[k].length : typeof r[k] === 'boolean' ? +r[k] : r[k]), 0)
out({ total: { classes: rows.length, holding_rows: names((r) => r.holds.length), maybe_rows: names((r) => r.maybe.length),
  with_subclasses: { holding: names((r) => keeps(r, 'holds')).length, maybe: names((r) => !keeps(r, 'holds') && keeps(r, 'maybe')).length }, rowAt: sum('rowAt'), delta: sum('delta'), fn: sum('fn'), col: sum('col'), pass: sum('pass') } })
