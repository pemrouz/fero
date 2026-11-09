// E-07 (a): GC pauses and event-loop delay on the MAIN thread while it holds N data rows and takes steady writes.
//   node --max-old-space-size=MB gc.mjs <rows> <small|big> [rate=10000] [seconds=30]
// Load: N rows reach a fresh data source through fero's seam as a replica fills one: insert records encoded in
// fero frames of 256, decoded, folded through data's lane. Then GC once (so the write phase starts clean) and
// the write phase: every 1 ms tick, the writes due at `rate` a second (at most 2,000 a tick, so a pause is
// followed by a catch-up burst, as queued writes would be) are encoded into one frame, decoded and folded
// through the lane. The mix keeps the row count flat: half field updates, a quarter whole-row rewrites, an
// eighth new rows, an eighth removes of the oldest live row. GC pauses (perf_hooks 'gc' entries) and event-loop
// delay (monitorEventLoopDelay, 1 ms resolution) are recorded for the write phase. One JSON line on stdout.
import v8 from 'node:v8'
import { performance } from 'node:perf_hooks'
import { S, C, row, key, laneFor, decodeFrame, gcWatch, gcSummary, eld, eldSummary, mb, out, UPDATE, INSERT, REMOVE } from './common.mjs'

const [N_, shape = 'small', RATE_ = '10000', SEC_ = '30'] = process.argv.slice(2)
const N = +N_, RATE = +RATE_, SEC = +SEC_
const gw = gcWatch()
const p = S.proxy({})
const lane = laneFor(p)

// ── load ──
const t0 = performance.now()
for (let i = 0; i < N; i += 256) {
  const recs = []
  for (let j = i; j < Math.min(N, i + 256); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(shape, j, 0) })
  lane(decodeFrame(C.encodeFrame(recs)))
}
const tLoaded = performance.now()
globalThis.gc?.()
const afterLoad = { heap_used_mb: mb(v8.getHeapStatistics().used_heap_size), rss_mb: mb(process.memoryUsage().rss) }

// ── write phase ──
gw.mark('write')
const h = eld()
let written = 0, oldest = 0, next = N, stamp = 1, x = 12345, maxBurst = 0
const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x }
let foldMs = 0
const tW0 = performance.now()
await new Promise((resolve) => {
  const tick = () => {
    const t = performance.now()
    const due = Math.min(2000, Math.floor((t - tW0) * RATE / 1000) - written)
    if (due > 0) {
      if (due > maxBurst) maxBurst = due
      const recs = []
      for (let i = 0; i < due; i++) {
        const m = (written + i) & 7
        const live = next - oldest
        const j = oldest + (rnd() % live)
        if (m < 4) recs.push({ type: UPDATE, key: [key(j), 'n'], value: ++stamp })
        else if (m < 6) recs.push({ type: UPDATE, key: [key(j)], value: row(shape, j, ++stamp) })
        else if (m === 6) { recs.push({ type: INSERT, key: [], at: key(next), value: row(shape, next, ++stamp) }); next++ }
        else { recs.push({ type: REMOVE, key: [key(oldest)] }); oldest++ }
      }
      const a = performance.now()
      lane(decodeFrame(C.encodeFrame(recs)))
      foldMs += performance.now() - a
      written += due
    }
    if (t - tW0 >= SEC * 1000) resolve()
    else setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
})
const tW1 = performance.now()
h.disable()
gw.stop()
const hs = v8.getHeapStatistics()
const live = Object.keys(p[Symbol.for('data.v4.value')] ?? {}).length
out({
  exp: 'E-07', part: 'gc', rows: N, shape, rate: RATE, seconds: SEC, node: process.version,
  load_s: +((tLoaded - t0) / 1000).toFixed(2), heap_limit_mb: mb(hs.heap_size_limit), after_load: afterLoad,
  end_heap_used_mb: mb(hs.used_heap_size), max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
  live_rows_end: live || null,
  write_seconds: +((tW1 - tW0) / 1000).toFixed(1), writes: written, writes_per_s: Math.round(written / ((tW1 - tW0) / 1000)), max_burst: maxBurst,
  fold_cpu_share: +(foldMs / (tW1 - tW0)).toFixed(3),
  gc_load: gcSummary(gw, 'load'), gc_write: gcSummary(gw, 'write'), eld_write_ms: eldSummary(h),
  top5_write: gw.list.filter((e) => gw.phaseOf(e.start) === 'write').sort((a, b) => b.ms - a.ms).slice(0, 5).map((e) => [+e.ms.toFixed(1), e.kind]),
})
