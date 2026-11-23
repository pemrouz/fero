// E-66 probe: what one read of a held row costs when the rows sit in a compact column store, against a row that
// sits in `data` as an object. E-65 X1 timed only two column reads: a whole row made into a new object (2.5 to
// 3.4 µs) and one field of every row in a scan (11 to 18 ns). This times the ways in between, by key, as `.value.k`,
// a judge and an operator's comparator read rows:
//   data      data's own store (`node.get(k)`, the path an operator's `rowAt(k)` takes), then the field(s)
//   mat       the column store makes a new plain object of the row (X1's `get`), then the field(s)
//   fly       a small row view object (a "flyweight"): one class with a getter per field, made per read, reading
//             the columns at the row's id; nothing is copied until a field is read
//   proxy     the same view as a Proxy with one `get` trap
//   id        no object at all: the field straight from its column, by the row's id
//   fly-map, id-map   the same as fly and id, but the key finds its id through a JavaScript `Map` (keys on the V8
//             heap, as data's `keySlot` keeps them) instead of X1's hash table in typed arrays
// Three reads: `one` (the score field of a random row), `all` (all eight fields), `cmp` (two random rows'
// scores compared: one step of an ordered view's bisect). Keys are made before timing; every form reads the same
// keys in the same order. One JSON line a form; the column forms share one process.
//   node --expose-gc --max-old-space-size=3000 rowread.mjs --form=data|col --rows=1000000 [--reads=2000000]
import { args, out, loadData, inserts, loadavg, rng, FIELDS } from '../../E65-every-row/X1/src/lib.mjs'
import { ColumnStore } from '../../E65-every-row/X1/src/compact.mjs'

const A = args(), N = A.rows ?? 1e6, R = A.reads ?? 2e6, form = A.form ?? 'data'
const NODE = Symbol.for('data.v4.node')
const base = { exp: 'E-66', probe: 'rowread', rows: N, reads: R, node: process.version, loadavg: loadavg() }

// the keys, made once: 262,144 random live keys, read in a ring
const r = rng(7), KS = 1 << 18, keys = new Array(KS)
for (let i = 0; i < KS; i++) keys[i] = 'k' + Math.floor(r() * N)

let sink = 0 // keeps the reads from being optimised away
const take = (v) => { sink += typeof v === 'number' ? v : typeof v === 'string' ? v.length : v ? 1 : 0 }

function time(label, fn) { // ns a read: the median of three passes of R reads, after one warm pass
  fn(R >> 2)
  const ns = []
  for (let p = 0; p < 3; p++) { const t = process.hrtime.bigint(); fn(R); ns.push(Number(process.hrtime.bigint() - t) / R) }
  ns.sort((a, b) => a - b)
  return +ns[1].toFixed(1)
}
// the three reads, over any `row(k)` that returns something with the eight fields
function reads(row) {
  return {
    one: time('one', (n) => { for (let i = 0; i < n; i++) take(row(keys[i & (KS - 1)]).score) }),
    all: time('all', (n) => { for (let i = 0; i < n; i++) { const x = row(keys[i & (KS - 1)]); for (let f = 0; f < 8; f++) take(x[FIELDS[f]]) } }),
    cmp: time('cmp', (n) => { for (let i = 0; i < n; i++) take(row(keys[i & (KS - 1)]).score - row(keys[(i + 1) & (KS - 1)]).score) }),
  }
}

if (form === 'data') {
  const D = await loadData()
  const src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
  for (const b of inserts(N)) lane(b)
  const node = src[NODE]
  out({ ...base, form: 'data', ns: reads((k) => node.get(k)) })
} else {
  const cs = new ColumnStore({ cap: N })
  for (const b of inserts(N)) cs.apply(b)
  const ix = cs.ix
  // the flyweight: one class, a getter per field, reading the columns at this.id
  class RowView { constructor(id) { this.id = id } }
  for (const f of cs.names) Object.defineProperty(RowView.prototype, f, { get() { return cs._readField(this.id, f) }, enumerable: true })
  const handler = { get: (t, f) => (cs.shape[f] ? cs._readField(t.id, f) : undefined) }
  const viaIx = (k) => ix.find(k)
  const m = new Map() // the key -> id map a column store inside data would keep (data's keySlot)
  for (let id = 0; id < ix.next; id++) if (cs.pres[id]) m.set(ix.keyOf(id), id)
  const viaMap = (k) => m.get(k)
  // checked: every form gives the same fields as the made object, on 1,000 keys
  let bad = 0
  for (let i = 0; i < 1000; i++) {
    const k = keys[i], want = cs.get(k), fv = new RowView(viaIx(k)), pv = new Proxy({ id: viaMap(k) }, handler)
    for (const f of FIELDS) if (want[f] !== fv[f] || want[f] !== pv[f] || want[f] !== cs._readField(viaMap(k), f)) bad++
  }
  if (bad) throw new Error('E-66 rowread: forms disagree on ' + bad + ' fields')
  const res = {
    mat: reads((k) => cs.get(k)),
    fly: reads((k) => new RowView(viaIx(k))),
    proxy: reads((k) => new Proxy({ id: viaIx(k) }, handler)),
    'fly-map': reads((k) => new RowView(viaMap(k))),
  }
  // no object: the field straight from its column (the `one` and `cmp` reads; `all` reads eight columns)
  const idr = (find) => ({
    one: time('one', (n) => { for (let i = 0; i < n; i++) take(cs._readField(find(keys[i & (KS - 1)]), 'score')) }),
    all: time('all', (n) => { for (let i = 0; i < n; i++) { const id = find(keys[i & (KS - 1)]); for (let f = 0; f < 8; f++) take(cs._readField(id, FIELDS[f])) } }),
    cmp: time('cmp', (n) => { for (let i = 0; i < n; i++) take(cs._readField(find(keys[i & (KS - 1)]), 'score') - cs._readField(find(keys[(i + 1) & (KS - 1)]), 'score')) }),
  })
  res.id = idr(viaIx); res['id-map'] = idr(viaMap)
  out({ ...base, form: 'col', checked_fields: 8000, ns: res })
}
if (sink === 0.5) console.log(sink)
