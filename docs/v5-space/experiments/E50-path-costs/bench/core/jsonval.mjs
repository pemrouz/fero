// B7: a record's value as JSON text, decoded by V8's native parser, against v4's own value codec (B4's 'v4' rows).
// Every copy and every client decodes every record it folds (V5-6, fold-all), so the decoder's speed is paid
// 4 or more times per write. upkeep-bench b2 timed JSON with ONE JSON.parse per 256 rows; a log record is decoded
// with its own envelope. Three forms, frames of 256 of E-05's small row, no checksum (priced apart in B4/b1):
//   rec   per record: [varint key bytes][key][varint value bytes][value as JSON]: TextDecoder + JSON.parse per record
//   batch per frame: the 256 keys as in rec, then the 256 values as ONE JSON array: one JSON.parse per frame
//   v4    fero v4's codec (kernel/codec.ts, imported read-only from the repo): Framer + full decode (key and value of each record)
// Encode is timed too (JSON.stringify + encodeInto; v4's Outbox). A self-check compares every decoded value.
//   node --experimental-strip-types --no-warnings jsonval.mjs        prints one JSON line
import { Outbox, Framer, VERB } from '../../../../../../kernel/codec.ts'
import { isDeepStrictEqual } from 'node:util'

const N = 256
const row = (i) => ({ name: 'user' + i, email: `user${i}@example.org`, region: 'eu-west', room: 'r' + (i % 100), n: i, active: true, tags: ['a', 'b'] })
const keys = Array.from({ length: N }, (_, i) => 'u' + (100000 + i))
const vals = Array.from({ length: N }, (_, i) => row(100000 + i))
const te = new TextEncoder(), td = new TextDecoder()
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1]
const bench = (fn) => {
  let reps = 1
  for (;;) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(); if (performance.now() - t > 30) break; reps *= 2 }
  reps = Math.max(1, Math.round(reps * 6))
  const rounds = []
  for (let r = 0; r < 7; r++) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(); rounds.push((performance.now() - t) * 1e6 / reps / N) }
  return +median(rounds).toFixed(1)
}
const buf = new Uint8Array(1 << 20)
const varint = (b, p, v) => { while (v > 127) { b[p++] = (v & 127) | 128; v >>>= 7 } b[p++] = v; return p }
const putStr = (b, p, s) => { const at = p + 1; const { written } = te.encodeInto(s, b.subarray(at)); b[p] = written; return at + written } // short strings: 1-byte length
const encRec = () => {
  let p = 0
  for (let i = 0; i < N; i++) {
    p = putStr(buf, p, keys[i])
    const s = JSON.stringify(vals[i])
    const lenAt = p; p += 2 // 2-byte varint room: values here are < 16 KiB
    const { written } = te.encodeInto(s, buf.subarray(p))
    buf[lenAt] = (written & 127) | 128; buf[lenAt + 1] = written >>> 7
    p += written
  }
  return buf.slice(0, p)
}
const encBatch = () => {
  let p = 0
  for (let i = 0; i < N; i++) p = putStr(buf, p, keys[i])
  const { written } = te.encodeInto(JSON.stringify(vals), buf.subarray(p))
  return buf.slice(0, p + written)
}
const rdVar = (b, st) => { let v = 0, s = 0, x; do { x = b[st.p++]; v += (x & 127) * 2 ** s; s += 7 } while (x & 128); return v }
const decRec = (b) => {
  const out = new Array(N), st = { p: 0 }
  for (let i = 0; i < N; i++) {
    const kn = rdVar(b, st); const key = td.decode(b.subarray(st.p, st.p + kn)); st.p += kn
    const vn = rdVar(b, st); const value = JSON.parse(td.decode(b.subarray(st.p, st.p + vn))); st.p += vn
    out[i] = { key, value }
  }
  return out
}
const decBatch = (b) => {
  const out = new Array(N), st = { p: 0 }
  for (let i = 0; i < N; i++) { const kn = rdVar(b, st); out[i] = { key: td.decode(b.subarray(st.p, st.p + kn)), value: undefined }; st.p += kn }
  const vs = JSON.parse(td.decode(b.subarray(st.p)))
  for (let i = 0; i < N; i++) out[i].value = vs[i]
  return out
}
const recs = keys.map((k, i) => ({ type: 1, key: [k], value: vals[i] }))
const o = new Outbox()
const encV4 = () => { o.begin(VERB.RECORDS, { origin: 'leader', baseSeq: 1, epoch: 3 }); for (const r of recs) o.put(r); return o.finish() }
const decV4 = (f) => { const out = []; for (const v of new Framer().push(f)[0].records()) out.push({ key: v.key[0], value: v.value }); return out }
const fr = { rec: encRec(), batch: encBatch(), v4: encV4() }
const check = (out) => out.length === N && out.every((x, i) => x.key === keys[i] && isDeepStrictEqual(x.value, vals[i]))
const res = {}
for (const [name, enc, dec] of [['rec', encRec, decRec], ['batch', encBatch, decBatch], ['v4', encV4, decV4]]) {
  res[name] = { ok: check(dec(fr[name])), bytes_per_record: +(fr[name].length / N).toFixed(1), encode_ns: bench(enc), decode_ns: bench(() => dec(fr[name])) }
}
console.log(JSON.stringify({ bench: 'jsonval', node: process.version, ...res }))
