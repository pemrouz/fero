// b2: how much work each level of reading a batch costs, per record, for the same rows in three forms.
// Rows are E-05's small row (about 100 B). Form 1 is fero v4's codec (kernel/codec.ts, imported read-only): insert
// records, 256 to a frame, each frame with its crc32c, as a log segment or a v4 snapshot holds them. Levels on form 1:
//   crc        crcFrame over the frame and nothing else: what a follower that only journals and acks must do
//   scan       crc + provenance + Frame.records(): every record's boundary found, values skipped
//   key        scan + each record's key (RecordView.key, at): what a worker-side compaction by row key reads
//   full       scan + rec() on each record: every value decoded to JS objects, what the fold needs
// Forms 2 and 3 hold the same rows as snapshot chunks of 256 [rowKey, row] pairs:
//   crc-native and full-crc-native: the same with Node's native zlib.crc32 over the frame in place of v4's JS crc32c
//   json       JSON.stringify -> utf8 bytes; read back with TextDecoder + JSON.parse
//   v8         v8.serialize; read back with v8.deserialize (V8's structured-clone wire format)
// Encode is timed too: what a snapshot cut from the main thread's rows, or a catch-up that re-encodes, pays per row.
// Usage: node --experimental-strip-types b2-decode.mjs <run> [rows]
import v8 from 'node:v8'
import zlib from 'node:zlib'
import os from 'node:os'
import { encodeFrame, Frame, crcFrame, HEADER } from '../../../../../../kernel/codec.ts'

const run = Number(process.argv[2] ?? 1)
const N = Number(process.argv[3] ?? 200_000)
const PER = 256
const regions = ['eu', 'us', 'ap', 'sa', 'af', 'me', 'oc', 'an']
const row = (i) => ({ name: 'user' + i, email: 'user' + i + '@example.test', region: regions[i % 8], room: 'room' + (i % 100), n: i, active: (i & 1) === 0, tags: ['a', 'b'] })
const rows = Array.from({ length: N }, (_, i) => row(i))
const keys = rows.map((_, i) => 'r' + i)
const chunks = []
for (let i = 0; i < N; i += PER) chunks.push([i, Math.min(N, i + PER)])

// ---- encoders
const encV4 = () => chunks.map(([a, b], k) => {
  const recs = []
  for (let i = a; i < b; i++) recs.push({ type: 1, key: [], value: rows[i], at: keys[i] })
  return encodeFrame(recs, { origin: 'n1', baseSeq: a + 1, epoch: 1 })
})
const te = new TextEncoder(), td = new TextDecoder()
const encJson = () => chunks.map(([a, b]) => { const out = []; for (let i = a; i < b; i++) out.push([keys[i], rows[i]]); return te.encode(JSON.stringify(out)) })
const encV8 = () => chunks.map(([a, b]) => { const out = []; for (let i = a; i < b; i++) out.push([keys[i], rows[i]]); return v8.serialize(out) })

let sink = 0
const readU32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000
const levels = {
  crc: (frames) => { for (const f of frames) { if (crcFrame(f, f.length) !== readU32(f, 7)) throw new Error('crc'); sink ^= f[2] } },
  scan: (frames) => { for (const f of frames) { if (crcFrame(f, f.length) !== readU32(f, 7)) throw new Error('crc'); const F = new Frame(f); F.prov(); sink ^= F.records().length } },
  key: (frames) => { for (const f of frames) { if (crcFrame(f, f.length) !== readU32(f, 7)) throw new Error('crc'); const F = new Frame(f); F.prov(); for (const rv of F.records()) sink ^= rv.at.length } },
  full: (frames) => { for (const f of frames) { if (crcFrame(f, f.length) !== readU32(f, 7)) throw new Error('crc'); const F = new Frame(f); F.prov(); for (const rv of F.records()) sink ^= rv.rec().value.n } },
  'crc-native': (frames) => { for (const f of frames) sink ^= zlib.crc32(f) },
  'full-crc-native': (frames) => { for (const f of frames) { sink ^= zlib.crc32(f); const F = new Frame(f); F.prov(); for (const rv of F.records()) sink ^= rv.rec().value.n } },
  'scan-no-crc': (frames) => { for (const f of frames) { const F = new Frame(f); F.prov(); sink ^= F.records().length } },
  'full-no-crc': (frames) => { for (const f of frames) { const F = new Frame(f); F.prov(); for (const rv of F.records()) sink ^= rv.rec().value.n } },
}
const decJson = (bufs) => { for (const b of bufs) { const a = JSON.parse(td.decode(b)); sink ^= a[0][1].n } }
const decV8 = (bufs) => { for (const b of bufs) { const a = v8.deserialize(b); sink ^= a[0][1].n } }
const decJsonCrc = (bufs) => { for (const b of bufs) { sink ^= zlib.crc32(b); const a = JSON.parse(td.decode(b)); sink ^= a[0][1].n } }
const decV8Crc = (bufs) => { for (const b of bufs) { sink ^= zlib.crc32(b); const a = v8.deserialize(b); sink ^= a[0][1].n } }

const time = (fn) => {
  globalThis.gc?.()
  const t = process.hrtime.bigint(), c = process.cpuUsage()
  const out = fn()
  const u = process.cpuUsage(c)
  return { wall: Number(process.hrtime.bigint() - t), cpu: (u.user + u.system) * 1000, out }
}
const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1]
const load = os.loadavg()[0]
const say = (o) => console.log(JSON.stringify({ bench: 'b2', run, rows: N, load, ...o }))
const R = 5
const measure = (form, level, fn, arg) => {
  fn(arg)
  const w = [], c = []
  for (let r = 0; r < R; r++) { const t = time(() => fn(arg)); w.push(t.wall); c.push(t.cpu) }
  say({ form, level, us_per_record: +(med(w) / N / 1000).toFixed(3), cpu_us_per_record: +(med(c) / N / 1000).toFixed(3) })
}
// encode
const enc = { v4: encV4, json: encJson, v8: encV8 }
const out = {}
for (const [form, fn] of Object.entries(enc)) {
  out[form] = fn()
  const w = [], c = []
  for (let r = 0; r < R; r++) { const t = time(fn); w.push(t.wall); c.push(t.cpu) }
  const bytes = out[form].reduce((s, b) => s + b.length, 0)
  say({ form, level: 'encode', us_per_record: +(med(w) / N / 1000).toFixed(3), cpu_us_per_record: +(med(c) / N / 1000).toFixed(3), bytes_per_row: +(bytes / N).toFixed(1) })
}
for (const [level, fn] of Object.entries(levels)) measure('v4', level, fn, out.v4)
measure('json', 'full', decJson, out.json)
measure('v8', 'full', decV8, out.v8)
measure('json', 'full-crc-native', decJsonCrc, out.json)
measure('v8', 'full-crc-native', decV8Crc, out.v8)
if (sink === 0.5) console.log('')
