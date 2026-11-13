// b3: the decode of a wake or a catch-up, per row shape, with every decoded row KEPT as a fold keeps it.
// The skeptic's check of PATHS.md (its big.mjs and small.mjs, moved here) found that b2 and core/jsonval decode a
// frame and throw the rows away, so the young generation frees them at once. A wake keeps every row, so the
// collector moves them to the old generation and walks them; E-34's 10 GB load spent 35.6 s of its 51.8 s decode
// in GC. This bench decodes N rows once, as a wake does, either keeping each decoded row (keep=1) or not (keep=0).
// Shapes (E-34's row maker, bench/common.mjs there):
//   field  one field record: row key, the field 'n', a number (the commonest write)
//   small  E-05's small row as E-34 makes it (about 100 B as JSON)
//   big    the same plus a 1,900-character text field (E-34's 2 KB row)
// Forms, 256 records to a frame, no checksum (b1 prices it apart):
//   v4     fero v4's codec (kernel/codec.ts, imported read-only): Frame, then rec() on each record
//   rec    the record format PATHS.md's PA-1 proposes: per record a 1-byte key length, the key, a varint length and
//          the value as JSON text; TextDecoder for the key, TextDecoder + JSON.parse for the value
//   json   a snapshot chunk: one JSON array of 256 [key, row] pairs, one JSON.parse per frame
//   v8     the same chunk through v8.serialize / v8.deserialize (V8's own format)
// Usage: node --experimental-strip-types --max-old-space-size=6144 b3-kept.mjs <shape> <form> <keep 0|1> [rows]
// Prints one JSON line: µs per row of wall and CPU time for the decode pass, and the GC time inside it.
import v8 from 'node:v8'
import { PerformanceObserver } from 'node:perf_hooks'
import { encodeFrame, Frame } from '../../../../../../kernel/codec.ts'

const [shape, form] = [process.argv[2], process.argv[3]]
const keep = process.argv[4] === '1'
const N = Number(process.argv[5] ?? (shape === 'big' ? 250_000 : 1_000_000))
if (!['field', 'small', 'big'].includes(shape) || !['v4', 'rec', 'json', 'v8'].includes(form)) throw new Error('usage: b3-kept.mjs <field|small|big> <v4|rec|json|v8> <0|1> [rows]')
const BODY = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor '.repeat(25).slice(0, 1900)
const row = (i) => {
  const r = { name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: i, active: (i & 1) === 0, tags: ['a', 'b'] }
  if (shape === 'big') r.body = BODY.slice(0, 1890) + String(i % 1e9).padStart(10, '0')
  return r
}
const key = (i) => 'k' + i
const te = new TextEncoder(), td = new TextDecoder()

// ---- encode N records, 256 to a frame (not timed)
const bufs = []
const scratch = new Uint8Array(4 << 20)
const varint = (b, p, v) => { while (v > 127) { b[p++] = (v & 127) | 128; v >>>= 7 } b[p++] = v; return p }
const putShort = (b, p, s) => { const { written } = te.encodeInto(s, b.subarray(p + 1)); b[p] = written; return p + 1 + written }
for (let a = 0; a < N; a += 256) {
  const b = Math.min(N, a + 256)
  if (form === 'v4') {
    const recs = []
    for (let i = a; i < b; i++) recs.push(shape === 'field' ? { type: 0, key: ['n'], at: key(i), value: i * 7 + 0.5 } : { type: 1, key: [], at: key(i), value: row(i) })
    bufs.push(encodeFrame(recs, { origin: 'n1', baseSeq: a + 1, epoch: 1 }))
  } else if (form === 'rec') {
    let p = 0
    for (let i = a; i < b; i++) {
      p = putShort(scratch, p, key(i))
      if (shape === 'field') p = putShort(scratch, p, 'n')
      const s = JSON.stringify(shape === 'field' ? i * 7 + 0.5 : row(i))
      const enc = te.encode(s)
      p = varint(scratch, p, enc.length); scratch.set(enc, p); p += enc.length
    }
    bufs.push(scratch.slice(0, p))
  } else {
    const items = []
    for (let i = a; i < b; i++) items.push(shape === 'field' ? [key(i), 'n', i * 7 + 0.5] : [key(i), row(i)])
    bufs.push(form === 'json' ? te.encode(JSON.stringify(items)) : v8.serialize(items))
  }
}
const bytes = bufs.reduce((s, b) => s + b.length, 0)

// ---- decode once, timed
const rdVar = (b, st) => { let v = 0, s = 0, x; do { x = b[st.p++]; v += (x & 127) * 2 ** s; s += 7 } while (x & 128); return v }
globalThis.gc?.()
let gcMs = 0, gcN = 0
const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { gcMs += e.duration; gcN++ } })
obs.observe({ entryTypes: ['gc'] })
const kept = keep ? new Array(N) : null
let k = 0, sink = 0
const t0 = performance.now(), c0 = process.cpuUsage()
for (const b of bufs) {
  if (form === 'v4') {
    const F = new Frame(b); F.prov()
    for (const rv of F.records()) { const r = rv.rec(); if (keep) kept[k++] = r; else sink += shape === 'field' ? r.value : r.value.n }
  } else if (form === 'rec') {
    const st = { p: 0 }
    while (st.p < b.length) {
      let l = b[st.p++]; const kk = td.decode(b.subarray(st.p, st.p + l)); st.p += l
      let f
      if (shape === 'field') { l = b[st.p++]; f = td.decode(b.subarray(st.p, st.p + l)); st.p += l }
      const vn = rdVar(b, st); const value = JSON.parse(td.decode(b.subarray(st.p, st.p + vn))); st.p += vn
      const r = shape === 'field' ? { key: kk, field: f, value } : { key: kk, value }
      if (keep) kept[k++] = r; else sink += shape === 'field' ? value : value.n
    }
  } else {
    const items = form === 'json' ? JSON.parse(td.decode(b)) : v8.deserialize(b)
    if (keep) for (const it of items) kept[k++] = it; else sink += shape === 'field' ? items[0][2] : items[0][1].n
  }
}
const wall = performance.now() - t0, c = process.cpuUsage(c0)
await new Promise((r) => setTimeout(r, 50)); obs.disconnect()
if (keep && k !== N) throw new Error(`kept ${k} of ${N}`)
console.log(JSON.stringify({ bench: 'b3-kept', shape, form, keep, rows: N, bytes_per_row: +(bytes / N).toFixed(1),
  us_per_row: +(wall * 1000 / N).toFixed(3), cpu_us_per_row: +((c.user + c.system) / N).toFixed(3), gc_us_per_row: +(gcMs * 1000 / N).toFixed(3), gcs: gcN,
  heap_mb: Math.round(process.memoryUsage().heapUsed / 1e6), node: process.version, sink: Number.isFinite(sink) ? 0 : 1 }))
