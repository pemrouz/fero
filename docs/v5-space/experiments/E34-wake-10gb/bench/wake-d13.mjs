// E-34 (b): wake in decision 13's form: the kernel on a worker thread owns the rows in a compact form, and the
// main thread holds a projection of them.
//   node [--max-old-space-size=MB] wake-d13.mjs <snapshot> <small|big> <all|none> [seconds=30] [rate=10000]
// Worker: reads the snapshot (fero frames, crc checked) and keeps the frames' bytes as they are, in an arena of
// 64 MiB buffers outside the V8 heap, with a Map from row key to where its latest record sits (offset and
// length packed in one number): the compact form. With projection `all` it hands each frame's bytes to the main thread
// (transferred), which decodes them and folds them into a data source through fero's seam.
// A write: main -> worker (one message per tick); the worker encodes the records as one frame, appends it to
// a journal file (fdatasync for the first write and every 100 ms after), appends it to the arena and points
// the index at it (a field update first reads the row from its frame and re-encodes the whole row), then hands
// the committed frame back; the main thread folds it with substrate.applyRec (projection `all`).
// Time to the first committed write is from process start to the main thread holding the first write.
// GC pauses are recorded on both threads, for the load and the write phase apart.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import v8 from 'node:v8'
import { performance } from 'node:perf_hooks'
import { S, C, row, key, laneFor, decodeFrame, readFrames, gcWatch, gcSummary, eld, eldSummary, mb, out, UPDATE, INSERT } from './common.mjs'

if (isMainThread) {
  const [file, shape, PROJ, SEC = '30', RATE = '10000'] = process.argv.slice(2)
  const gw = gcWatch()
  const p = PROJ === 'all' ? S.proxy({}) : null
  const lane = p ? laneFor(p) : null
  const VALUE = Symbol.for('data.v4.value')
  const tOpen = performance.now()
  const w = new Worker(new URL(import.meta.url), { workerData: { file, shape, PROJ }, env: process.env })
  let onCommitted = null, workerDone = null, rows = 0, applied = 0
  const loaded = new Promise((resolve, reject) => {
    w.on('error', reject)
    w.on('message', (m) => {
      if (m.frame) { const rs = decodeFrame(new Uint8Array(m.frame)); if (lane) lane(rs); applied += rs.length }
      else if (m.loaded) { rows = m.rows; resolve(m) }
      else if (m.committed) onCommitted(m)
      else if (m.done) workerDone(m)
    })
  })
  const winfo = await loaded
  const tLoaded = performance.now()
  if (PROJ === 'all' && applied !== rows) throw new Error('projection incomplete')
  // the first committed write
  const send = (recs) => new Promise((resolve) => { onCommitted = resolve; w.postMessage({ write: recs }) })
  const applyCommitted = (m) => { if (p) for (const r of decodeFrame(new Uint8Array(m.committed))) S.applyRec(p, r) }
  applyCommitted(await send([{ type: INSERT, key: [], at: 'first', value: row(shape, rows + 1, 1) }]))
  const tFirst = performance.now()
  if (p && p.get('first')[VALUE] === undefined) throw new Error('first write not visible')
  const afterLoad = { rss_mb: mb(process.memoryUsage().rss), main_heap_used_mb: mb(process.memoryUsage().heapUsed), worker_heap_used_mb: winfo.heap_mb, arena_mb: winfo.arena_mb }
  // the write phase: a tick per ms sends what is due; a tick waits for the worker's commit before the next
  gw.mark('write')
  const h = eld()
  let written = 0, next = rows + 2, stamp = 2
  let x = 12345
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x }
  const tW0 = performance.now()
  while (performance.now() - tW0 < +SEC * 1000) {
    await new Promise((r) => setTimeout(r, 1))
    const due = Math.min(1000, Math.floor((performance.now() - tW0) * +RATE / 1000) - written)
    if (due <= 0) continue
    const recs = []
    for (let i = 0; i < due; i++) {
      const m = (written + i) & 3
      const j = rnd() % rows
      if (m < 2) recs.push({ type: UPDATE, key: [key(j), 'n'], value: ++stamp })
      else if (m === 2) recs.push({ type: UPDATE, key: [key(j)], value: row(shape, j, ++stamp) })
      else { recs.push({ type: INSERT, key: [], at: key(next), value: row(shape, next, ++stamp) }); next++ }
    }
    applyCommitted(await send(recs))
    written += recs.length
  }
  const tW1 = performance.now()
  h.disable()
  gw.stop()
  const wstats = await new Promise((resolve) => { workerDone = resolve; w.postMessage({ finish: true }) })
  await w.terminate()
  const hs = v8.getHeapStatistics()
  out({
    exp: 'E-34', part: 'wake-d13', file: file.split('/').pop(), shape, projection: PROJ, rows, snapshot_gb: +(winfo.bytes / 1e9).toFixed(2),
    node_start_to_open_s: +(tOpen / 1000).toFixed(2), worker_load_s: winfo.load_s, load_s: +((tLoaded - tOpen) / 1000).toFixed(2), first_write_ms: +(tFirst - tLoaded).toFixed(1),
    wake_to_first_write_s: +(tFirst / 1000).toFixed(2),
    heap_limit_mb: mb(hs.heap_size_limit), after_load: afterLoad, max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
    gc_load_main: gcSummary(gw, 'load'), gc_load_worker: wstats.gc_load,
    write_seconds: +((tW1 - tW0) / 1000).toFixed(1), writes: written, writes_per_s: Math.round(written / ((tW1 - tW0) / 1000)),
    gc_write_main: gcSummary(gw, 'write'), gc_write_worker: wstats.gc_write, eld_write_main_ms: eldSummary(h),
  })
} else {
  const { file, shape, PROJ } = workerData
  const gw = gcWatch()
  const t0 = performance.now()
  // the arena: frames' bytes back to back in 64 MiB buffers; index: row key -> global offset of its frame
  const CH = 64 << 20
  const chunks = []
  let cur = null, at = CH
  const index = new Map()
  const put = (u8) => {
    if (at + u8.length > CH) { cur = Buffer.allocUnsafeSlow(Math.max(CH, u8.length)); chunks.push(cur); at = 0 }
    const off = (chunks.length - 1) * CH + at
    cur.set(u8, at)
    at += u8.length
    return off
  }
  // a record's place: offset * 65536 + its span (tag to end). Frames here carry no provenance, so the first
  // record starts 15 bytes in (11-byte header + the u32 record count), each next one right after the last.
  const place = (frameOff, rvs, fn) => { let o = frameOff + C.HEADER + 4; for (const rv of rvs) { fn(rv, o * 65536 + rv.span); o += rv.span } }
  const valueAt = (pl) => {
    const off = Math.floor(pl / 65536), span = pl % 65536
    const c = chunks[Math.floor(off / CH)], o = off % CH
    return new C.RecordView(c, c[o], o + 1, o + span, '', 0, 0).value
  }
  let rows = 0
  const info = readFrames(file, (u8) => {
    const off = put(u8)
    place(off, new C.Frame(u8).records(), (rv, pl) => { index.set(rv.at ?? rv.key[0], pl); rows++ })
    if (PROJ === 'all') { const copy = new Uint8Array(u8).buffer; parentPort.postMessage({ frame: copy }, [copy]) }
  })
  const load_s = +((performance.now() - t0) / 1000).toFixed(2)
  const heap = v8.getHeapStatistics().used_heap_size
  parentPort.postMessage({ loaded: true, rows, bytes: info.bytes, load_s, heap_mb: mb(heap), arena_mb: mb(chunks.length * CH) })
  gw.mark('write')
  const journal = (process.env.JOURNAL ?? '/tmp') + '/e34-journal-d13-' + process.pid
  const jfd = fs.openSync(journal, 'w')
  let lastSync = -1e9
  const current = (k) => { const pl = index.get(k); return pl === undefined ? undefined : valueAt(pl) }
  parentPort.on('message', (m) => {
    if (m.write) {
      // a field update becomes the whole new row, so every row's latest version sits whole in one frame
      const recs = m.write.map((r) => r.key.length > 1 ? { type: UPDATE, key: [r.key[0]], value: { ...current(r.key[0]), [r.key[1]]: r.value } } : r)
      const f = C.encodeFrame(recs)
      fs.writeSync(jfd, f)
      const t = performance.now()
      if (t - lastSync >= 100) { fs.fdatasyncSync(jfd); lastSync = t }
      const off = put(f)
      place(off, new C.Frame(f).records(), (rv, pl) => index.set(rv.at ?? rv.key[0], pl))
      const back = C.encodeFrame(m.write).buffer
      parentPort.postMessage({ committed: back }, [back])
    } else if (m.finish) {
      gw.stop()
      fs.closeSync(jfd); fs.unlinkSync(journal)
      parentPort.postMessage({ done: true, gc_load: gcSummary(gw, 'load'), gc_write: gcSummary(gw, 'write') })
    }
  })
}
