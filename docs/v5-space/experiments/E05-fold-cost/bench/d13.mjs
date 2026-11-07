// E-05 part 4: bytes per row in decision 13's form (DESIGN-V5 decision 13a: in TypeScript the kernel runs on a
// worker thread and owns the rows in a compact form; the main thread holds a projection of the rows it reads).
//   node --expose-gc d13.mjs <rows> <worker form> <projection>
//   worker form: compact  rows as bytes: each row's key and value encoded with fero's codec into an arena of
//                         4 MiB buffers, plus a Map from row key to its offset (one copy of each row's bytes)
//                data     rows as objects in a data source on the worker too (the naive form)
//   projection:  all      the main thread folds every row through fero's seam (a server that serves views over
//                         everything it holds)
//                none     the main thread holds no rows
// The worker gets rows the way a replica does (fero frames of 256 insert records), keeps them in its form,
// and sends each frame's bytes to the main thread, which decodes and folds them. Each thread's V8 heap is read
// after three full collections; the arena is counted apart (it lives outside the V8 heap, in ArrayBuffers).
// The worker then hashes its compact rows (F-21 on the kernel thread: the bytes are already encoded).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import v8 from 'node:v8'

if (isMainThread) {
  const { S, fill: _f, decodeFrame, laneFor, gc, out, now, median } = await import('./common.mjs')
  const [N, FORM, PROJ] = [+process.argv[2], process.argv[3], process.argv[4]]
  gc()
  const m0 = v8.getHeapStatistics().used_heap_size
  const rss0 = process.memoryUsage().rss
  const p = PROJ === 'all' ? S.proxy({}) : null
  const lane = p ? laneFor(p) : null
  const w = new Worker(new URL(import.meta.url), { workerData: { N, FORM }, env: process.env })
  const t0 = now()
  const report = await new Promise((resolve, reject) => {
    w.on('error', reject)
    w.on('message', (m) => {
      if (m.frame) { if (lane) lane(decodeFrame(new Uint8Array(m.frame))) }
      else if (m.ready) { gc(); w.postMessage({ measure: true }) }
      else if (m.report) resolve(m.report)
    })
  })
  const loadMs = Number(now() - t0) / 1e6
  gc()
  const m1 = v8.getHeapStatistics().used_heap_size
  const rss1 = process.memoryUsage().rss
  w.postMessage({ hash: true })
  const hash = await new Promise((resolve) => w.on('message', (m) => { if (m.hashed) resolve(m.hashed) }))
  await w.terminate()
  const mainPer = (m1 - m0) / N
  const total = mainPer + report.worker_heap_per_row + report.arena_per_row
  out({
    exp: 'E-05', part: 'd13', rows: N, worker_form: FORM, projection: PROJ,
    main_heap_per_row: Math.round(mainPer), worker_heap_per_row: Math.round(report.worker_heap_per_row), worker_arena_per_row: Math.round(report.arena_per_row),
    total_per_row: Math.round(total), rss_per_row: Math.round((rss1 - rss0) / N), rss_mb: Math.round(rss1 / 2 ** 20), load_ms: Math.round(loadMs),
    worker_hash_digest: hash.digest, worker_hash_ms: hash.ms, worker_hash_ms_min: hash.min, worker_hash_ms_max: hash.max,
  })
  void median; void _f
} else {
  const { S, C, row, key, fill, laneFor, gc, now, median, INSERT } = await import('./common.mjs')
  const { xxh32 } = await import('./xxh.mjs')
  const { N, FORM } = workerData
  const heapNow = () => v8.getHeapStatistics().used_heap_size
  gc()
  const h0 = heapNow()
  // the compact form: an arena of 4 MiB chunks; each row = varint length + codec(key) + codec(value)
  const CH = 4 << 20
  const chunks = []
  let cur = null, at = CH
  const index = new Map() // row key -> global offset (chunk * CH + at)
  const w = new C.Writer()
  const put = (k, value) => {
    w.len = 0; w.str(k); w.value(value)
    const need = w.len + 3
    if (at + need > CH) { cur = Buffer.allocUnsafeSlow(CH); chunks.push(cur); at = 0 }
    const off = (chunks.length - 1) * CH + at
    cur[at] = w.len & 0x7f | 0x80; cur[at + 1] = (w.len >>> 7) & 0x7f | 0x80; cur[at + 2] = w.len >>> 14 // fixed 3-byte length
    cur.set(w.buf.subarray(0, w.len), at + 3)
    at += need
    index.set(k, off)
  }
  const src = FORM === 'data' ? S.proxy({}) : null
  const lane = src ? laneFor(src) : null
  for (let i = 0; i < N; i += 256) {
    const recs = []
    for (let j = i; j < Math.min(N, i + 256); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(j, 0) })
    const frame = C.encodeFrame(recs) // what arrives from the leader
    if (FORM === 'compact') for (const rv of new C.Frame(frame).records()) put(rv.at, rv.value)
    else lane(new C.Frame(frame).records().map((rv) => rv.rec()))
    const copy = frame.buffer.byteLength === frame.length ? frame.buffer : frame.slice().buffer
    parentPort.postMessage({ frame: copy }, [copy])
  }
  parentPort.postMessage({ ready: true })
  parentPort.on('message', (m) => {
    if (m.measure) {
      gc()
      const h1 = heapNow()
      const arena = chunks.length * CH
      parentPort.postMessage({ report: { worker_heap_per_row: (h1 - h0) / N, arena_per_row: arena / N } })
    } else if (m.hash) {
      const ts = []
      let digest
      for (let r = 0; r < 3; r++) {
        const t0 = now()
        let a = 0, b = 0
        if (FORM === 'compact') {
          for (const off of index.values()) {
            const c = chunks[(off / CH) | 0], o = off % CH
            const len = (c[o] & 0x7f) | ((c[o + 1] & 0x7f) << 7) | (c[o + 2] << 14)
            a = (a + xxh32(c, o + 3, o + 3 + len, 1)) >>> 0; b = (b + xxh32(c, o + 3, o + 3 + len, 2)) >>> 0
          }
        } else {
          src.each((k, rw) => { w.len = 0; w.str(k); w.value(rw); a = (a + xxh32(w.buf, 0, w.len, 1)) >>> 0; b = (b + xxh32(w.buf, 0, w.len, 2)) >>> 0 })
        }
        ts.push(Number(now() - t0) / 1e6)
        digest = a.toString(16) + b.toString(16)
      }
      parentPort.postMessage({ hashed: { digest, ms: +median(ts).toFixed(1), min: +Math.min(...ts).toFixed(1), max: +Math.max(...ts).toFixed(1) } })
    }
  })
  void fill
}
