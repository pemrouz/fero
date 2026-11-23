// E-66 review probe: what making a row from columns costs when the code is written for the fixed shape, not
// X1's generic `get` (which loops over field names with presence bits and decodes text a byte at a time).
// Same rows, keys and timing loop as rowread.mjs. Forms, by key:
//   mat           X1's cs.get(k), the "made row" of rowread.mjs
//   lit           one object literal of the fixed shape; the text field by Buffer's utf8Slice
//   lit-frz       lit, then Object.freeze (a row handed to app code must be frozen)
//   lit-notext    lit with the text field left out (how much of the cost is the text)
//   lit-frz-map   lit-frz, the key found through a JavaScript Map (as data's keySlot keeps keys)
//   fly, fly-map  rowread.mjs's row view object (a getter per field), here also read with `keep`
//   data          data's own store, node.get(k)
// Reads: `one` (score), `all` (eight fields), `keep` (the row stored in a 1,024-slot ring, then its score: the
// object must really exist, so V8 cannot drop it). Keys via X1's typed index unless the form says `-map`.
//   node --expose-gc --max-old-space-size=3000 rowmake.mjs --form=col|data|check --rows=1000000 [--reads=1000000]
// `check` loads both stores at --rows and compares every form with data's own rows, field by field.
import { args, out, loadData, inserts, loadavg, rng, FIELDS } from '../../E65-every-row/X1/src/lib.mjs'
import { ColumnStore } from '../../E65-every-row/X1/src/compact.mjs'

const A = args(), N = A.rows ?? 1e6, R = A.reads ?? 1e6, form = A.form ?? 'col'
const NODE = Symbol.for('data.v4.node')
const base = { exp: 'E-66', probe: 'rowmake', rows: N, reads: R, node: process.version, loadavg: loadavg() }
const r = rng(7), KS = 1 << 18, keys = new Array(KS)
for (let i = 0; i < KS; i++) keys[i] = 'k' + Math.floor(r() * N)
let sink = 0
const take = (v) => { sink += typeof v === 'number' ? v : typeof v === 'string' ? v.length : v ? 1 : 0 }
const ring = new Array(1024).fill(null)
function time(fn) { fn(R >> 2); const ns = []; for (let p = 0; p < 3; p++) { const t = process.hrtime.bigint(); fn(R); ns.push(Number(process.hrtime.bigint() - t) / R) } ns.sort((a, b) => a - b); return +ns[1].toFixed(1) }
function reads(row) {
  return {
    one: time((n) => { for (let i = 0; i < n; i++) take(row(keys[i & (KS - 1)]).score) }),
    all: time((n) => { for (let i = 0; i < n; i++) { const x = row(keys[i & (KS - 1)]); for (let f = 0; f < 8; f++) take(x[FIELDS[f]]) } }),
    keep: time((n) => { for (let i = 0; i < n; i++) { const x = row(keys[i & (KS - 1)]); ring[i & 1023] = x; take(x.score) } }),
  }
}
async function dataRows() {
  const D = await loadData(), src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
  for (const b of inserts(N)) lane(b)
  return src[NODE]
}
function colForms() {
  const cs = new ColumnStore({ cap: N })
  for (const b of inserts(N)) cs.apply(b)
  const ix = cs.ix, C = cs.cols, dstr = cs.dstr, toff = cs.toff, tlen = cs.tlen
  const U = C.user, CE = C.cents, S = C.score, P = C.paid, SK = C.sku, AT = C.at, Q = C.qty
  const tb = cs.tbytes, buf = Buffer.from(tb.buffer, tb.byteOffset, tb.length)
  const m = new Map()
  for (let id = 0; id < ix.next; id++) if (cs.pres[id]) m.set(ix.keyOf(id), id)
  const viaIx = (k) => ix.find(k), viaMap = (k) => m.get(k)
  // the fixed shape, written out: what a column backing would generate from a declared schema
  const make = (id) => ({ user: dstr[U[id]], cents: CE[id], score: S[id], paid: P[id] === 1, sku: dstr[SK[id]], title: buf.utf8Slice(toff[id], toff[id] + tlen[id]), at: AT[id], qty: Q[id] })
  const makeNoText = (id) => ({ user: dstr[U[id]], cents: CE[id], score: S[id], paid: P[id] === 1, sku: dstr[SK[id]], at: AT[id], qty: Q[id] })
  class RowView { constructor(id) { this.id = id } }
  for (const f of cs.names) Object.defineProperty(RowView.prototype, f, { get() { return cs._readField(this.id, f) }, enumerable: true })
  return {
    mat: (k) => cs.get(k),
    lit: (k) => make(viaIx(k)),
    'lit-frz': (k) => Object.freeze(make(viaIx(k))),
    'lit-notext': (k) => makeNoText(viaIx(k)),
    'lit-frz-map': (k) => Object.freeze(make(viaMap(k))),
    fly: (k) => new RowView(viaIx(k)),
    'fly-map': (k) => new RowView(viaMap(k)),
  }
}

if (form === 'data') {
  const node = await dataRows()
  out({ ...base, form: 'data', ns: reads((k) => node.get(k)) })
} else if (form === 'check') { // every form against data's own row, on every 1,000th key read (checked)
  const node = await dataRows(), forms = colForms()
  let fields = 0, bad = 0
  for (let i = 0; i < 1000; i++) {
    const k = keys[i], want = node.get(k)
    for (const [name, row] of Object.entries(forms)) {
      const got = row(k)
      for (const f of FIELDS) { if (name === 'lit-notext' && f === 'title') continue; fields++; if (got[f] !== want[f]) bad++ }
    }
  }
  out({ ...base, form: 'check', against: 'data', fields, bad })
  if (bad) process.exit(1)
} else {
  const forms = colForms(), ns = {}
  for (const [name, row] of Object.entries(forms)) ns[name] = reads(row)
  out({ ...base, form: 'col', ns })
}
if (sink === 0.5) console.log(sink)
