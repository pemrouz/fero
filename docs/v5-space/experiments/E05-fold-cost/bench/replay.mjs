// E-05 part 3: replay speed from an encoded log (records/s, seconds per GB).
//   node --expose-gc replay.mjs make <file> <log> [fmt]   write the log (not timed): log = load1m | mixed1m
//   node --expose-gc replay.mjs run <file> <views> [fmt]  read, check, decode and fold it into a fresh seam handle
//   fmt: fero (default) fero v4's codec; json: the same frames as a JSON array each (u32 length, u32 crc32c,
//        utf8 JSON), decoded by V8's native JSON.parse: a stand-in for a faster record format than v4's
// The log is fero v4's codec (kernel/codec.ts): RECORDS frames of 256 records, each with its crc32c, back
// to back. The replay is what a restarting replica does: read the bytes, check each frame's crc, decode,
// and fold through data's hot lane in 256-record batches (one data commit per frame).
//   load1m   1e6 insert records of ~100 B rows: rebuilding a 1e6-row state from a snapshot or a log
//   mixed1m  1e5 inserts, then 9e5 records over those rows: 60% field updates, 20% whole-row sets,
//            10% inserts of new rows, 10% deletes
// The file is read from the page cache (just written); a cold read adds the disk's read time (E-01).
import fs from 'node:fs'
import { S, C, row, key, laneFor, attachViews, decodeFrame, gc, now, cpu, out, heap, UPDATE, INSERT, REMOVE } from './common.mjs'

const [cmd, file, arg, FMT = 'fero'] = process.argv.slice(2)
const jsonFrame = (batch) => { const body = Buffer.from(JSON.stringify(batch)); const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(C.crc32c(body), 4); return Buffer.concat([h, body]) }

if (cmd === 'make') {
  const fd = fs.openSync(file, 'w')
  let batch = [], bytes = 0, recs = 0
  const flush = () => { if (batch.length) { const f = FMT === 'json' ? jsonFrame(batch) : C.encodeFrame(batch); fs.writeSync(fd, f); bytes += f.length; recs += batch.length; batch = [] } }
  const put = (r) => { batch.push(r); if (batch.length === 256) flush() }
  if (arg === 'load1m') {
    for (let i = 0; i < 1e6; i++) put({ type: INSERT, key: [], at: key(i), value: row(i, 0) })
  } else if (arg === 'mixed1m') {
    const R = 1e5
    for (let i = 0; i < R; i++) put({ type: INSERT, key: [], at: key(i), value: row(i, 0) })
    let live = R, next = R, dead = 0, s = 1
    let x = 12345
    const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x }
    for (let i = 0; i < 9e5; i++) {
      const m = i % 10
      const j = dead + (rnd() % (next - dead)) // a row in the live window [dead, next)
      if (m < 6) put({ type: UPDATE, key: [key(j), 'n'], value: ++s })
      else if (m < 8) put({ type: UPDATE, key: [key(j)], value: row(j, ++s) })
      else if (m === 8) put({ type: INSERT, key: [], at: key(next), value: row(next++, ++s) })
      else put({ type: REMOVE, key: [key(dead++)] })
    }
    void live
  } else throw new Error('log: load1m | mixed1m')
  flush()
  fs.closeSync(fd)
  out({ exp: 'E-05', part: 'replay-make', log: arg, fmt: FMT, records: recs, bytes, bytes_per_record: +(bytes / recs).toFixed(1) })
} else if (cmd === 'run') {
  const VIEWS = arg ?? 'none'
  gc()
  const p = S.proxy({})
  const lane = laneFor(p)
  const c0 = cpu(), t0 = now()
  const buf = fs.readFileSync(file)
  const tRead = now()
  let pos = 0, recs = 0, tDecode = 0n, tFold = 0n
  while (pos < buf.length) {
    let len, rs, a, b
    if (FMT === 'json') {
      const n = buf.readUInt32LE(pos)
      if (C.crc32c(buf, pos + 8, pos + 8 + n) !== buf.readUInt32LE(pos + 4)) throw new Error('crc mismatch at ' + pos)
      len = 8 + n
      a = now()
      rs = JSON.parse(buf.toString('utf8', pos + 8, pos + 8 + n))
      b = now()
    } else {
      len = C.HEADER + buf.readUInt32LE(pos + 3)
      const u8 = buf.subarray(pos, pos + len)
      if (C.crcFrame(u8, len) !== buf.readUInt32LE(pos + 7)) throw new Error('crc mismatch at ' + pos)
      a = now()
      rs = decodeFrame(u8)
      b = now()
    }
    lane(rs)
    tFold += now() - b; tDecode += b - a
    recs += rs.length
    pos += len
  }
  // views are built after the rows (data's bulk path); folding a million rows under a live group view is
  // quadratic in data at 63fea66 (a touched bucket's object is rebuilt whole on every commit; see the fold part)
  const tv = now()
  const subs = attachViews(p, VIEWS)
  const t1 = now(), c1 = cpu()
  const viewS = Number(t1 - tv) / 1e9
  const total = Number(t1 - t0) / 1e9
  gc()
  out({
    exp: 'E-05', part: 'replay', file: file.split('/').pop(), fmt: FMT, views: VIEWS, records: recs, bytes: buf.length,
    seconds: +total.toFixed(3), cpu_seconds: +((c1 - c0) / 1e6).toFixed(3),
    read_s: +(Number(tRead - t0) / 1e9).toFixed(3), decode_s: +(Number(tDecode) / 1e9).toFixed(3), fold_s: +(Number(tFold) / 1e9).toFixed(3), view_build_s: +viewS.toFixed(3),
    records_per_s: Math.round(recs / total), s_per_gb: +(total / (buf.length / 1e9)).toFixed(2),
    heap_mb: Math.round(heap().heapUsed / 2 ** 20),
  })
  for (const s of subs) s.dispose()
} else throw new Error('make | run')
