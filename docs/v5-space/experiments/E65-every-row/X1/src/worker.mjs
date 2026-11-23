// E-65 X1: one fold worker of the asker. It holds the rows of its share of slots (blocks b with b mod W = its
// id) in one data source, decodes the frames it is sent with fero v4's codec, folds them in lanes, and answers
// the main thread: a get, a scan of its rows (as encoded pages, or one numeric column), and, with views, what
// each batch changed in the live answer (a count, a sum, and the before and after of each changed score).
import { parentPort, workerData } from 'node:worker_threads'
import { loadData, loadCodec, inserts, slotOf } from './lib.mjs'

const { id, W, N, views } = workerData
const D = await loadData(), C = await loadCodec()
const NODE = Symbol.for('data.v4.node')
const mine = (k) => (slotOf(k) % 16) % W === id
const src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } }), node = src[NODE]
for (const b of inserts(N)) { const m = b.filter((r) => mine(r.at)); if (m.length) lane(m) }
const num = (x) => (typeof x === 'number' && x === x ? x : undefined)
let dsum = 0, dlen = 0, pairs = [], sink = null
if (views) {
  sink = src.sink({ apply(b) {
    for (const d of b.rows) {
      const o = d.op === 'add' ? undefined : d.prev, n = d.op === 'remove' ? undefined : d.row
      if (!o) dlen++; if (!n) dlen--
      const oc = num(o?.cents), nc = num(n?.cents); if (oc !== undefined) dsum -= oc; if (nc !== undefined) dsum += nc
      const os = num(o?.score), ns = num(n?.score); if (os !== ns) pairs.push(os ?? NaN, ns ?? NaN)
    }
  } })
}
let busy = 0
parentPort.on('message', (m) => {
  const t0 = performance.now()
  if (m.type === 'frames') {
    let n = 0
    for (const ab of m.bufs) { const recs = []; for (const rv of new C.Frame(new Uint8Array(ab)).records()) recs.push(rv.rec()); lane(recs); n += recs.length }
    if (views) { const p = Float64Array.from(pairs); pairs = []; parentPort.postMessage({ type: 'delta', n, dsum, dlen, pairs: p }, [p.buffer]); dsum = 0; dlen = 0 }
    else parentPort.postMessage({ type: 'ack', n })
  } else if (m.type === 'get') {
    parentPort.postMessage({ type: 'row', q: m.q, row: node.get(m.k) })
  } else if (m.type === 'scan') { // every row of this share, 4,096 to a page, as fero frames of insert records
    let page = [], pages = 0
    const send = () => { const f = C.encodeFrame(page); parentPort.postMessage({ type: 'page', f }, [f.buffer]); page = []; pages++ }
    node.each((k, row) => { page.push({ type: 1, key: [], at: k, value: row }); if (page.length === 4096) send() })
    if (page.length) send()
    parentPort.postMessage({ type: 'scanned', pages })
  } else if (m.type === 'column') { // one numeric field of every row, as a Float64Array
    const a = new Float64Array(node.rowCount()); let i = 0
    node.each((k, row) => { const x = num(row?.[m.f]); if (x !== undefined) a[i++] = x })
    const out = a.slice(0, i)
    parentPort.postMessage({ type: 'col', a: out }, [out.buffer])
  } else if (m.type === 'busy') { parentPort.postMessage({ type: 'busy', busy }); busy = 0; return }
  busy += performance.now() - t0
})
parentPort.postMessage({ type: 'ready', rows: node.rowCount() })
