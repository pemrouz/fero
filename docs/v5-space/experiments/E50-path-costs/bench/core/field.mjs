// B8: PA-1 for field records (one field set to a number, the commonest write), which core/jsonval does not cover
// (it times E-05's small row only). Moved here from the skeptic's check of PATHS.md (its field.mjs), with the encode
// timed too and a self-check. 256 records to a frame, hot loop, decoded values thrown away (b3 keeps them):
//   v4    fero v4's codec (kernel/codec.ts, imported read-only): encodeFrame; Frame, then rec() on each record
//   rec   per record a 1-byte length and the row key, a 1-byte length and the field name, a 1-byte length and the
//         value as JSON text: TextDecoder for the key and the field, TextDecoder + JSON.parse for the value
// No checksum (b1 prices it). Usage: node --experimental-strip-types field.mjs     prints one JSON line
import { encodeFrame, Frame } from '../../../../../../kernel/codec.ts'

const N = 256
const te = new TextEncoder(), td = new TextDecoder()
const recs = Array.from({ length: N }, (_, i) => ({ type: 0, key: ['n'], at: 'u' + (100000 + i), value: i * 7 + 0.5 }))
const encV4 = () => encodeFrame(recs, { origin: 'n1', baseSeq: 1, epoch: 1 })
const buf = new Uint8Array(1 << 16)
const put = (p, s) => { const { written } = te.encodeInto(s, buf.subarray(p + 1)); buf[p] = written; return p + 1 + written }
const encRec = () => { let p = 0; for (const r of recs) { p = put(p, r.at); p = put(p, r.key[0]); p = put(p, JSON.stringify(r.value)) } return buf.slice(0, p) }
const v4 = encV4(), js = encRec()
let sink = 0
const decV4 = (out) => { const F = new Frame(v4); F.prov(); let i = 0; for (const rv of F.records()) { const r = rv.rec(); sink += r.value; if (out) out[i++] = [r.at, r.key[0], r.value] } }
const decRec = (out) => {
  let q = 0
  for (let i = 0; i < N; i++) {
    let l = js[q]; const at = td.decode(js.subarray(q + 1, q + 1 + l)); q += 1 + l
    l = js[q]; const f = td.decode(js.subarray(q + 1, q + 1 + l)); q += 1 + l
    l = js[q]; const v = JSON.parse(td.decode(js.subarray(q + 1, q + 1 + l))); q += 1 + l
    sink += v; if (out) out[i] = [at, f, v]
  }
}
const check = (dec) => { const out = new Array(N); dec(out); return out.every((x, i) => x[0] === recs[i].at && x[1] === 'n' && x[2] === recs[i].value) }
const bench = (fn) => { for (let i = 0; i < 2000; i++) fn(); const r = []; for (let k = 0; k < 7; k++) { const t = performance.now(); for (let i = 0; i < 4000; i++) fn(); r.push((performance.now() - t) * 1e6 / 4000 / N) } r.sort((a, b) => a - b); return +r[3].toFixed(1) }
console.log(JSON.stringify({ bench: 'field', ok: check(decV4) && check(decRec),
  v4_encode_ns: bench(encV4), rec_encode_ns: bench(encRec), v4_decode_ns: bench(() => decV4()), rec_decode_ns: bench(() => decRec()),
  v4_bytes: +(v4.length / N).toFixed(1), rec_bytes: +(js.length / N).toFixed(1), node: process.version }))
