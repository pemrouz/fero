// E-65 X1: the asker's fold spread over W worker threads (worker.mjs), each holding the rows of its share of
// slots. One JSON line per process; run.sh runs each three times under the timing lock.
//
//   node workers.mjs fold --W=0..3 --rows=N --recs=H [--views]
//     H records of the write mix, encoded as fero frames of 256 and split by slot to the worker that owns them,
//     are sent to the workers (16 frames a message, at most 8 messages in flight per worker); records a second
//     over all of them, from the first send to the last answer. W=0: the main thread decodes and folds them
//     itself (today's R0 on one thread). --views: each worker also reports what each message changed (a count,
//     a sum, and each changed score's before and after), and the main thread keeps the live answer: the count,
//     the sum, and an exact median in one sorted column (it holds no rows).
//   node workers.mjs read --W=1..3 --rows=N
//     what a read over every row costs the main thread when the rows are in workers: a get by round trip (one
//     at a time, and 64 in flight), every row as encoded pages decoded on the main thread, one numeric column
//     of every row (Float64Array) and an exact median from it.
import { Worker } from 'node:worker_threads'
import { args, out, loadData, loadCodec, loadavg, makeGen, slotOf, inserts, gc, median } from './lib.mjs'
import { SortedCol } from './compact.mjs'

const A = args(), mode = process.argv[2], W = A.W ?? 2, N = A.rows ?? 1e6, H = A.recs ?? 1e6, views = !!A.views
const C = await loadCodec()
const base = { exp: 'E-65', opt: 'X1', bench: 'workers-' + mode, W, rows: N, views, node: process.version, loadavg: loadavg() }
const ownerOf = (k) => (slotOf(k) % 16) % Math.max(1, W)

async function start() {
  const ws = []
  for (let id = 0; id < W; id++) {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { id, W, N, views }, execArgv: ['--experimental-strip-types', '--no-warnings'], resourceLimits: { maxOldGenerationSizeMb: 1500 } })
    ws.push(w)
  }
  await Promise.all(ws.map((w) => new Promise((res) => { const f = (m) => { if (m.type === 'ready') { w.off('message', f); res() } }; w.on('message', f) })))
  return ws
}
const num = (x) => (typeof x === 'number' && x === x ? x : undefined)

if (mode === 'fold') {
  // the records, split by owner and encoded (not timed)
  const recs = makeGen(N)(H)
  const per = Array.from({ length: Math.max(1, W) }, () => [])
  for (const r of recs) per[ownerOf(r.type === 1 ? r.at : r.key[0])].push(r)
  const msgs = per.map((rs) => { const ms = []; let bufs = []; for (let i = 0; i < rs.length; i += 256) { const f = C.encodeFrame(rs.slice(i, i + 256)); bufs.push(f.buffer); if (bufs.length === 16) { ms.push(bufs); bufs = [] } } if (bufs.length) ms.push(bufs); return ms })
  const col = new SortedCol(); let sum = 0, len = 0, mainBusy = 0
  if (W === 0) { // the main thread folds them itself
    const D = await loadData(), src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
    for (const b of inserts(N)) lane(b)
    if (views) {
      src[Symbol.for('data.v4.node')].each((k, row) => { const x = num(row.score); if (x !== undefined) col.insert(x) })
      src.sink({ apply(b) { for (const d of b.rows) { const o = d.op === 'add' ? undefined : d.prev, n = d.op === 'remove' ? undefined : d.row; if (!o) len++; if (!n) len--; const oc = num(o?.cents), nc = num(n?.cents); if (oc !== undefined) sum -= oc; if (nc !== undefined) sum += nc; const os = num(o?.score), ns = num(n?.score); if (os !== ns) { if (os !== undefined) col.remove(os); if (ns !== undefined) col.insert(ns) } } } })
    }
    gc()
    const t0 = performance.now()
    for (const m of msgs[0]) for (const ab of m) { const rs = []; for (const rv of new C.Frame(new Uint8Array(ab)).records()) rs.push(rv.rec()); lane(rs) }
    const ms = performance.now() - t0
    out({ ...base, records: H, ms: +ms.toFixed(0), records_per_s: Math.round(H / (ms / 1000)), main_busy_pct: 100 })
  } else {
    const ws = await start()
    if (views) { const cols = await Promise.all(ws.map((w) => new Promise((res) => { const f = (m) => { if (m.type === 'col') { w.off('message', f); res(m.a) } }; w.on('message', f); w.postMessage({ type: 'column', f: 'score' }) }))); for (const a of cols) for (const x of a) col.insert(x) }
    gc()
    const t0 = performance.now()
    let left = W
    await new Promise((res) => ws.forEach((w, i) => {
      const q = msgs[i]; let next = 0, inflight = 0
      const send = () => { while (inflight < 8 && next < q.length) { const bufs = q[next++]; w.postMessage({ type: 'frames', bufs }, bufs); inflight++ } }
      w.on('message', (m) => {
        if (m.type !== 'ack' && m.type !== 'delta') return
        const t = performance.now()
        inflight--
        if (m.type === 'delta') { sum += m.dsum; len += m.dlen; const p = m.pairs; for (let j = 0; j < p.length; j += 2) { if (p[j] === p[j]) col.remove(p[j]); if (p[j + 1] === p[j + 1]) col.insert(p[j + 1]) } }
        send()
        mainBusy += performance.now() - t
        if (next >= q.length && inflight === 0) { if (--left === 0) res() }
      })
      send()
    }))
    const ms = performance.now() - t0
    const busy = await Promise.all(ws.map((w) => new Promise((res) => { const f = (m) => { if (m.type === 'busy') { w.off('message', f); res(m.busy) } }; w.on('message', f); w.postMessage({ type: 'busy' }) })))
    // the check: the median the main thread kept from deltas equals the exact median of every worker's rows now
    let check
    if (views) {
      const cols = await Promise.all(ws.map((w) => new Promise((res) => { const f = (m) => { if (m.type === 'col') { w.off('message', f); res(m.a) } }; w.on('message', f); w.postMessage({ type: 'column', f: 'score' }) })))
      let n = 0; for (const a of cols) n += a.length
      const all = new Float64Array(n); let o2 = 0; for (const a of cols) { all.set(a, o2); o2 += a.length }
      all.sort()
      const h = (n - 1) * 0.5, lo = Math.floor(h), exact = h === lo ? all[lo] : all[lo] + (h - lo) * (all[lo + 1] - all[lo])
      check = { kept: col.median(), exact, values_kept: col.n, values_now: n, equal: col.median() === exact && col.n === n }
    }
    out({ ...base, records: H, ms: +ms.toFixed(0), records_per_s: Math.round(H / (ms / 1000)), main_busy_pct: +((100 * mainBusy) / ms).toFixed(1), worker_busy_pct: busy.map((b) => +((100 * b) / ms).toFixed(0)), median_check: check })
    for (const w of ws) await w.terminate()
  }
} else if (mode === 'read') {
  const ws = await start()
  const pending = new Map(); let q = 0
  ws.forEach((w) => w.on('message', (m) => { if (m.type === 'row') { const f = pending.get(m.q); pending.delete(m.q); f(m.row) } }))
  const get = (k) => new Promise((res) => { const id = q++; pending.set(id, res); ws[ownerOf(k)].postMessage({ type: 'get', q: id, k }) })
  const rr = (await import('./lib.mjs')).rng(3)
  const keys = Array.from({ length: 20000 }, () => 'k' + Math.floor(rr() * N))
  for (let i = 0; i < 500; i++) await get(keys[i]) // warm
  let t0 = performance.now()
  for (let i = 0; i < 2000; i++) await get(keys[i])
  const rttUs = ((performance.now() - t0) * 1000) / 2000
  t0 = performance.now()
  let idx = 0
  await Promise.all(Array.from({ length: 64 }, async () => { while (idx < keys.length) await get(keys[idx++]) }))
  const pipeNs = ((performance.now() - t0) * 1e6) / keys.length
  // every row, as pages decoded here
  const reps = []
  for (let r = 0; r < 3; r++) {
    gc()
    t0 = performance.now(); let rows = 0
    await Promise.all(ws.map((w) => new Promise((res) => { const f = (m) => { if (m.type === 'page') { for (const rv of new C.Frame(m.f).records()) { const x = rv.rec(); rows += x.value ? 1 : 0 } } else if (m.type === 'scanned') { w.off('message', f); res() } }; w.on('message', f); w.postMessage({ type: 'scan' }) })))
    reps.push({ ms: performance.now() - t0, rows })
  }
  const scan = median(reps.map((x) => x.ms)), rows = reps[0].rows
  const creps = []
  for (let r = 0; r < 3; r++) {
    t0 = performance.now()
    const cols = await Promise.all(ws.map((w) => new Promise((res) => { const f = (m) => { if (m.type === 'col') { w.off('message', f); res(m.a) } }; w.on('message', f); w.postMessage({ type: 'column', f: 'score' }) })))
    let n = 0; for (const a of cols) n += a.length
    const all = new Float64Array(n); let o = 0; for (const a of cols) { all.set(a, o); o += a.length }
    all.sort()
    creps.push(performance.now() - t0)
  }
  out({ ...base, get_rtt_us: +rttUs.toFixed(1), get_pipelined_ns: Math.round(pipeNs), scan_rows: rows, scan_ms: +scan.toFixed(0), scan_ns_per_row: +((scan * 1e6) / rows).toFixed(0), column_median_ms: +median(creps).toFixed(0) })
  for (const w of ws) await w.terminate()
}
