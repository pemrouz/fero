// E-58 probe (added after the review): three edges of data's per-path reader (data:api/index.ts connectPath) on data
// at 63fea66, each shown once on a small resource.
//   A-C. An array's `length`: a lens on it gets no record when an element is appended at the end, nor a lens on an
//        element when a write to `length` cuts the list. A lens on a row that is itself an array, the same.
//   D-E. A field write at the key `__proto__`: a lens on `p` reads the new value and gets no record; the row's own keys do
//        not change, so a picture made through JSON reads `undefined`. Nothing outside the row is changed.
//   F.   On a client fed through JSON, `op.merge({ b })` written as the whole merged row runs a link on an object field
//        that did not change, every time; written as one field record per merged key, never.
//   DATA=<data's folder> node --experimental-strip-types data-edges.mjs
import { pathToFileURL } from 'node:url'
const DATA = process.env.DATA
if (!DATA) { console.error('set DATA to data\'s folder (at 63fea66); run.sh sets it'); process.exit(2) }
const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
const { SourceNode } = await import(pathToFileURL(DATA + '/kernel/node.ts').href)
const show = (x) => JSON.stringify(x)
const mk = (rows) => { const rt = new D.Runtime(); return { rt, src: new SourceNode(rt, rows) } }
const watch = (src, path) => { const recs = []; let h = D.handleFor(src); for (const k of path) h = h.get(k); h.connect({}, (r) => recs.push(r), { clone: true }); recs.shift(); return recs }
{
  const { rt, src } = mk({ r0: { list: [1, 2] } }); const recs = watch(src, ['r0', 'list', 'length'])
  rt.batch(() => src.write('r0', ['list', '2'], 3))
  console.log('A append at the end, lens on r0.list.length: length now', src.get('r0').list.length, '; records', show(recs))
}
{
  const { rt, src } = mk({ r0: { list: [1, 2] } }); const recs = watch(src, ['r0', 'list', '1'])
  rt.batch(() => src.write('r0', ['list', 'length'], 1))
  console.log('B r0.list.length = 1, lens on r0.list.1: list now', show(src.get('r0').list), '; records', show(recs))
}
{
  const { rt, src } = mk({ r0: [10, 20] }); const recs = watch(src, ['r0', 'length'])
  rt.batch(() => src.write('r0', ['2'], 30))
  console.log('C a row that is an array, append at the end, lens on r0.length: row now', show(src.get('r0')), '; records', show(recs))
}
{
  const { rt, src } = mk({ r0: { a: { y: 1 } } }); const recs = watch(src, ['r0', 'p'])
  rt.batch(() => src.write('r0', ['__proto__'], { p: 1 }))
  const row = src.get('r0')
  console.log('D r0.__proto__ = { p: 1 }, lens on r0.p: reads', row.p, '; records', show(recs), '; own keys', show(Object.keys(row)),
    '; through JSON r0.p reads', JSON.parse(JSON.stringify({ r0: row })).r0.p, '; ({}).p is', ({}).p)
}
{
  const { rt, src } = mk({ r0: { a: { y: 1 } } }); const recs = watch(src, ['r0', 'a', 'q'])
  rt.batch(() => src.write('r0', ['a', '__proto__', 'q'], 2))
  console.log('E r0.a.__proto__.q = 2, lens on r0.a.q: reads', src.get('r0').a.q, '; records', show(recs), '; own keys of r0.a', show(Object.keys(src.get('r0').a)), '; ({}).q is', ({}).q)
}
for (const form of ['the whole merged row', 'one field record per merged key']) {
  const rt = new D.Runtime(); const c = new SourceNode(rt, { r0: { a: { x: 1, y: [1, 2] }, b: 0 } })
  const lane = D.lane(c, { onReject: (x) => console.log('reject', String(x.error).slice(0, 80)) })
  let runs = -1; D.handleFor(c).get('r0').get('a').connect({}, () => runs++, { clone: false })
  for (let i = 1; i <= 100; i++) {
    const recs = form === 'the whole merged row' ? [{ type: D.HOT.update, key: ['r0'], value: { ...c.get('r0'), b: i } }] : [{ type: D.HOT.update, key: ['r0', 'b'], value: i }]
    lane(JSON.parse(JSON.stringify(recs)))
  }
  console.log('F 100 op.merge({ b }) on a client, sent as', form + ': a link on r0.a, which never changed, ran', runs, 'times')
}
