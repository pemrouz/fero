// skeptic probe: does data's max follow a numeric projection, and is it a function of the rows only?
import { pathToFileURL, fileURLToPath } from 'node:url'
const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))
const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
const KN = await import(pathToFileURL(DATA + '/kernel/node.ts').href)
const mk = (rows) => { const rt = new D.Runtime(); const s = new KN.SourceNode(rt, rows); return { rt, s, h: D.handleFor(s) } }
const show = (x) => JSON.stringify(x)
// same final rows {a:5, b:'x'}, two arrival orders
for (const order of [['a', 'b'], ['b', 'a']]) {
  const { s, h } = mk({})
  const mx = h.max('v'), mn = h.min('v')
  for (const k of order) s.write(k, [], { v: k === 'a' ? 5 : 'x' })
  console.log('arrival', order.join(','), ' rows', show(Object.fromEntries([['a', 5], ['b', 'x']])), ' max', show(mx[D.value]), ' min', show(mn[D.value]))
}
// a string among numbers
{ const { h } = mk({ a: { v: 5 }, b: { v: 9 }, c: { v: '42' } }); console.log('max over 5, 9, "42":', show(h.max('v')[D.value]), ' min:', show(h.min('v')[D.value])) }
