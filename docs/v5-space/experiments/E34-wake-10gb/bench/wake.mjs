// E-34 (a): wake a snapshot into data on the MAIN thread, then take writes at 10,000 a second.
//   node [--max-old-space-size=MB] wake.mjs <snapshot> <small|big> [load=lane|adopt] [seconds=30] [rate=10000]
// Wake = process start -> read the snapshot (fero frames, crc checked) -> decode -> fold into a data source
// through fero's seam -> the first committed write. "Committed" here is local: the write's record is encoded,
// appended to a journal file and fdatasync'd, then folded with substrate.applyRec (no replication round trip;
// E-01's C = 0.73 ms would add to it). Two ways to fill the source:
//   lane   the lane, one batch per 256-record frame (how a replica folds; data keys its rows in a Map)
//   adopt  every row put in one plain object, which data adopts ($(obj), substrate.proxy); data builds its key
//          Map only at the first new-key write (its one-shot promote), so that cost lands on the first write
// Then the write phase: every 1 ms tick, the writes due at `rate` a second since the phase began (at most 1,000
// in one tick, so a pause is followed by a catch-up burst, as queued writes would be: half field updates, a
// quarter whole-row rewrites, a quarter new rows) are encoded as one frame, appended to the journal (fdatasync every 100 ms) and folded
// one record at a time with applyRec (fero v4's path). GC pauses (perf_hooks 'gc' entries, this thread) and
// event-loop delay are recorded for the load and the write phase apart.
import fs from 'node:fs'
import v8 from 'node:v8'
import { performance } from 'node:perf_hooks'
import { S, C, row, key, laneFor, decodeFrame, readFrames, gcWatch, gcSummary, eld, eldSummary, mb, out, UPDATE, INSERT } from './common.mjs'

const tStart = performance.now() // ms since this process began (performance.timeOrigin)
const [file, shape, LOAD = 'lane', SEC = '30', RATE = '10000'] = process.argv.slice(2)
const gw = gcWatch()
const journal = (process.env.JOURNAL ?? '/tmp') + '/e34-journal-' + process.pid
const jfd = fs.openSync(journal, 'w')

// ── load ──
const tOpen = performance.now()
let p, rows = 0, info, decodeMs = 0, foldMs = 0
if (LOAD === 'lane') {
  p = S.proxy({})
  const lane = laneFor(p)
  info = readFrames(file, (u8) => { const a = performance.now(); const rs = decodeFrame(u8); const b = performance.now(); lane(rs); foldMs += performance.now() - b; decodeMs += b - a; rows += rs.length })
} else {
  const obj = {}
  info = readFrames(file, (u8) => { const a = performance.now(); const rs = decodeFrame(u8); const b = performance.now(); for (const r of rs) { obj[r.at] = r.value; rows++ } foldMs += performance.now() - b; decodeMs += b - a })
  p = S.proxy(obj)
}
const tLoaded = performance.now()
// ── the first committed write: a new row ──
const commit = (recs, sync) => {
  fs.writeSync(jfd, C.encodeFrame(recs))
  if (sync) fs.fdatasyncSync(jfd)
  for (const r of recs) S.applyRec(p, r)
}
commit([{ type: INSERT, key: [], at: 'first', value: row(shape, rows + 1, 1) }], true)
const tFirst = performance.now()
if (p.get('first')[Symbol.for('data.v4.value')] === undefined) throw new Error('first write not visible')
const afterLoad = { rss_mb: mb(process.memoryUsage().rss), heap_used_mb: mb(process.memoryUsage().heapUsed) }

// ── write phase ──
gw.mark('write')
const h = eld()
let written = 0, next = rows + 2, stamp = 2, lastSync = performance.now()
let x = 12345
const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x }
const tW0 = performance.now()
await new Promise((resolve) => {
  const tick = () => {
    const recs = []
    const due = Math.min(1000, Math.floor((performance.now() - tW0) * +RATE / 1000) - written)
    for (let i = 0; i < due; i++) {
      const m = (written + i) & 3
      const j = rnd() % rows
      if (m < 2) recs.push({ type: UPDATE, key: [key(j), 'n'], value: ++stamp })
      else if (m === 2) recs.push({ type: UPDATE, key: [key(j)], value: row(shape, j, ++stamp) })
      else { recs.push({ type: INSERT, key: [], at: key(next), value: row(shape, next, ++stamp) }); next++ }
    }
    const t = performance.now()
    if (recs.length) commit(recs, t - lastSync >= 100)
    if (t - lastSync >= 100) lastSync = t
    written += recs.length
    if (t - tW0 >= +SEC * 1000) resolve()
    else setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
})
const tW1 = performance.now()
h.disable()
gw.stop()
fs.closeSync(jfd); fs.unlinkSync(journal)
const hs = v8.getHeapStatistics()
out({
  exp: 'E-34', part: 'wake-main', file: file.split('/').pop(), shape, load: LOAD, rows, snapshot_gb: +(info.bytes / 1e9).toFixed(2),
  node_start_to_open_s: +(tOpen / 1000).toFixed(2), load_s: +((tLoaded - tOpen) / 1000).toFixed(2),
  load_parts_s: { read: info.read_s, crc: info.crc_s, decode: +(decodeMs / 1000).toFixed(2), fold: +(foldMs / 1000).toFixed(2), gc: +(gw.list.filter((e) => e.start < tLoaded).reduce((a, e) => a + e.ms, 0) / 1000).toFixed(2) }, first_write_ms: +(tFirst - tLoaded).toFixed(1),
  wake_to_first_write_s: +(tFirst / 1000).toFixed(2), // from process start
  heap_limit_mb: mb(hs.heap_size_limit), after_load: afterLoad, end_heap_used_mb: mb(hs.used_heap_size),
  max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
  gc_load: gcSummary(gw, 'load'),
  write_seconds: +((tW1 - tW0) / 1000).toFixed(1), writes: written, writes_per_s: Math.round(written / ((tW1 - tW0) / 1000)),
  gc_write: gcSummary(gw, 'write'), eld_write_ms: eldSummary(h),
})
void tStart
