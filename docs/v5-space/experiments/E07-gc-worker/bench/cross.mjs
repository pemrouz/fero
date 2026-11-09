// E-07 (b): the cost of a kernel on a worker thread trading records with the main thread (decision 13a).
//   node cross.mjs <transfer|clone|sab> [batch=256] [seconds=5] [size=100]
// The main thread sends batches of `batch` records (E-02's record layout: u32 group, u32 index, u32 len, then
// `size` payload bytes) to a worker, which walks each record (reads group and index, as a kernel stamps them)
// and sends the batch back (the committed records the main thread will fold), and the main thread walks them
// again. Up to 32 batches are in flight. So each record crosses twice: in (a write issued) and out (a commit).
//   transfer  each batch is an ArrayBuffer, transferred both ways (postMessage(ab, [ab])); buffers are reused
//   clone     each batch is an array of plain objects ({ g, i, payload }), structured-cloned both ways
//   sab       two single-producer single-consumer rings in SharedArrayBuffers (64 slots of one batch each), with
//             a postMessage doorbell per drain in each direction, so both threads keep their event loops
//   sab-block the same rings, but both threads block in Atomics.wait (the raw floor; a thread that blocks
//             cannot serve its sockets or timers, so a real kernel cannot run this way)
// Prints records a second, wall ns per record per crossing, and each thread's busy time per record
// (performance.eventLoopUtilization on each thread; in `sab-block` the worker's busy time is wall time minus the
// time it spent inside Atomics.wait, and the main thread's ELU counts its own blocking waits as busy).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'

const RH = 12, SLOTS = 64, WIN = 32
const walk = (u8, n) => { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let off = 0, s = 0; for (let r = 0; r < n; r++) { s += dv.getUint32(off, true) + dv.getUint32(off + 4, true); off += RH + dv.getUint32(off + 8, true) } return s }

if (!isMainThread) {
  const { mode, batch, size, sabs } = workerData
  const bytes = batch * (RH + size)
  let waitMs = 0
  if (mode === 'transfer') {
    parentPort.on('message', (ab) => { if (ab === 'stop') return parentPort.postMessage({ waitMs }); walk(new Uint8Array(ab), batch); parentPort.postMessage(ab, [ab]) })
  } else if (mode === 'clone') {
    parentPort.on('message', (arr) => { if (arr === 'stop') return parentPort.postMessage({ waitMs }); let s = 0; for (const r of arr) s += r.g + r.i; arr.s = s; parentPort.postMessage(arr) })
  } else {
    const [aCtl, aBuf, bCtl, bBuf] = sabs
    const A = new Int32Array(aCtl), Ad = new Uint8Array(aBuf), B = new Int32Array(bCtl), Bd = new Uint8Array(bBuf)
    let tail = 0, head = 0
    // move every batch waiting in ring A into ring B (walking it on the way); returns how many moved
    const drain = () => {
      let n = 0
      while (Atomics.load(A, 0) !== tail && head - Atomics.load(B, 1) < SLOTS) {
        const src = Ad.subarray((tail % SLOTS) * bytes, (tail % SLOTS + 1) * bytes)
        walk(src, batch)
        Bd.set(src, (head % SLOTS) * bytes)
        tail++; Atomics.store(A, 1, tail)
        head++; Atomics.store(B, 0, head)
        n++
      }
      return n
    }
    if (mode === 'sab') {
      // event-loop friendly: data in the rings, a postMessage doorbell per drain in each direction
      parentPort.on('message', (m) => { if (m === 'stop') return parentPort.postMessage({ waitMs }); if (drain() > 0) parentPort.postMessage(1) })
    } else {
      // sab-block: the raw floor; this thread blocks in Atomics.wait and never returns to its event loop
      for (;;) {
        while (Atomics.load(A, 0) === tail) { const w = performance.now(); Atomics.wait(A, 0, tail, 100); waitMs += performance.now() - w; if (Atomics.load(A, 2) === 1) break }
        if (Atomics.load(A, 0) === tail && Atomics.load(A, 2) === 1) break
        if (drain() > 0) Atomics.notify(B, 0)
      }
      parentPort.postMessage({ waitMs })
    }
  }
} else {
  const [mode = 'transfer', BATCH = '256', SEC = '5', SIZE = '100'] = process.argv.slice(2)
  const batch = +BATCH, size = +SIZE, bytes = batch * (RH + size)
  const fill = (u8) => { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let off = 0; for (let r = 0; r < batch; r++) { dv.setUint32(off, r & 15, true); dv.setUint32(off + 4, r, true); dv.setUint32(off + 8, size, true); off += RH + size } }
  const template = new Uint8Array(bytes); fill(template)
  let sabs
  if (mode.startsWith('sab')) sabs = [new SharedArrayBuffer(16), new SharedArrayBuffer(bytes * SLOTS), new SharedArrayBuffer(16), new SharedArrayBuffer(bytes * SLOTS)]
  const w = new Worker(new URL(import.meta.url), { workerData: { mode, batch, size, sabs } })
  await new Promise((r) => w.once('online', r))
  let sent = 0, back = 0
  const elu0m = performance.eventLoopUtilization()
  const elu0w = w.performance.eventLoopUtilization()
  const t0 = performance.now(), tEnd = t0 + +SEC * 1000
  if (mode === 'transfer' || mode === 'clone') {
    const pool = []
    const mk = () => {
      if (mode === 'clone') { const arr = new Array(batch); const pl = template.subarray(RH, RH + size); for (let r = 0; r < batch; r++) arr[r] = { g: r & 15, i: sent * batch + r, payload: pl.slice() }; return arr }
      const ab = pool.pop() ?? new ArrayBuffer(bytes); new Uint8Array(ab).set(template); return ab
    }
    await new Promise((resolve) => {
      const pump = () => { while (sent - back < WIN && performance.now() < tEnd) { const m = mk(); sent++; if (mode === 'clone') w.postMessage(m); else w.postMessage(m, [m]) } if (sent === back) resolve() }
      w.on('message', (m) => {
        if (m && m.waitMs !== undefined) return
        back++
        if (mode === 'clone') { let s = 0; for (const r of m) s += r.g + r.i } else { walk(new Uint8Array(m), batch); pool.push(m) }
        pump()
      })
      pump()
    })
  } else {
    const [aCtl, aBuf, bCtl, bBuf] = sabs
    const A = new Int32Array(aCtl), Ad = new Uint8Array(aBuf), B = new Int32Array(bCtl), Bd = new Uint8Array(bBuf)
    let tail = 0
    const produce = () => { let n = 0; while (sent - back < WIN && sent - Atomics.load(A, 1) < SLOTS && performance.now() < tEnd) { Ad.set(template, (sent % SLOTS) * bytes); sent++; n++; Atomics.store(A, 0, sent) } return n }
    const consume = () => { let h = Atomics.load(B, 0); while (tail < h) { walk(Bd.subarray((tail % SLOTS) * bytes, (tail % SLOTS + 1) * bytes), batch); tail++; back++; Atomics.store(B, 1, tail); h = Atomics.load(B, 0) } }
    if (mode === 'sab') {
      await new Promise((resolve) => {
        w.on('message', (m) => { if (m !== 1) return; consume(); if (produce() > 0) w.postMessage(0); if (back === sent && performance.now() >= tEnd) resolve() })
        if (produce() > 0) w.postMessage(0)
      })
    } else {
      // sab-block: this thread blocks too (Atomics.wait is allowed on Node's main thread, but it stops the event loop)
      for (;;) {
        consume()
        if (produce() > 0) Atomics.notify(A, 0)
        if (performance.now() >= tEnd && back === sent) break
        if (Atomics.load(B, 0) === tail) Atomics.wait(B, 0, tail, 100)
      }
    }
    Atomics.store(A, 2, 1); Atomics.notify(A, 0)
  }
  const t1 = performance.now()
  const elum = performance.eventLoopUtilization(elu0m)
  const eluw = w.performance.eventLoopUtilization(elu0w)
  if (mode !== 'sab-block') w.postMessage('stop')
  const st = await new Promise((r) => w.on('message', (m) => { if (m && m.waitMs !== undefined) r(m) }))
  await w.terminate()
  const recs = back * batch, wall = t1 - t0
  // the worker's busy time: its event-loop utilisation (transfer, clone); for sab the worker never returns to its
  // loop, so busy = wall minus the time it spent blocked in Atomics.wait
  const workerBusyMs = mode === 'sab-block' ? wall - st.waitMs : eluw.active
  console.log(JSON.stringify({
    exp: 'E-07', part: 'cross', mode, batch, size, node: process.version, seconds: +(wall / 1000).toFixed(2), records: recs,
    recs_per_s: Math.round(recs / (wall / 1000)),
    wall_ns_per_rec_per_crossing: +((wall * 1e6) / (recs * 2)).toFixed(1),
    main_busy_ns_per_rec: +((elum.active * 1e6) / recs).toFixed(1), main_elu: +elum.utilization.toFixed(3),
    worker_busy_ns_per_rec: +((workerBusyMs * 1e6) / recs).toFixed(1), worker_busy_share: +(workerBusyMs / wall).toFixed(3),
  }))
}
