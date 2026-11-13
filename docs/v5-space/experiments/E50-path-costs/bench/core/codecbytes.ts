// B4: what v4's record format spends in bytes, and what one small format change saves.
// v4's Writer.str always writes a string's length as 3 bytes (a non-minimal varint, so one encodeInto pass needs no
// sizing pass: kernel/codec.ts Writer.str). A small row has about 14 strings (a key segment, 7 field names, 4 string
// values, 2 tag strings), so about 28 of its bytes are length padding. 'short' patches Writer.prototype.str at run
// time: a string of at most 42 UTF-16 units (so at most 126 UTF-8 bytes) takes a 1-byte length; every other string
// takes v4's path. The decoder reads any varint, so it reads both forms unchanged (checked below, record by record).
// Also: the frame envelope with real names (a 36-character uuid as origin and as issuer), against E-19's v5 header.
//   node --experimental-strip-types --no-warnings codecbytes.ts      prints one JSON line
import { Outbox, Framer, VERB, Writer } from '../../../../../../kernel/codec.ts'
import v8 from 'node:v8'
import { isDeepStrictEqual } from 'node:util'

const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1]
const bench = (fn: () => unknown, perCall: number) => {
  let reps = 1
  for (;;) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(); if (performance.now() - t > 30) break; reps *= 2 }
  reps = Math.max(1, Math.round(reps * 6))
  const rounds: number[] = []
  for (let r = 0; r < 7; r++) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(); rounds.push((performance.now() - t) * 1e6 / reps / perCall) }
  return +median(rounds).toFixed(1)
}
const row = (i: number) => ({ name: 'user' + i, email: `user${i}@example.org`, region: 'eu-west', room: 'r' + (i % 100), n: i, active: true, tags: ['a', 'b'] })
const UUID = '6f1c2a9e-3b7d-4e21-9a55-0c8d2f7b1e43'
const prov = { origin: UUID, baseSeq: 1234567, epoch: 3 }
const attempt = { issuer: UUID.replace('6f', '7a'), baseCid: 98765 }

const v4str = (Writer.prototype as any).str
const utf8 = new TextEncoder()
function shortStr(this: any, s: string) {
  if (s.length <= 42 && this.len + 1 + s.length * 3 <= this.limit) {
    this.ensure(1 + s.length * 3)
    const at = this.len++
    const { written } = utf8.encodeInto(s, this.buf.subarray(this.len))
    this.buf[at] = written
    this.len += written
  } else v4str.call(this, s)
}
const setMode = (m: string) => { (Writer.prototype as any).str = m === 'short' ? shortStr : v4str }

const recsOf = (kind: string, N: number) => Array.from({ length: N }, (_, i) => kind === 'row'
  ? { type: 1, key: ['u' + (100000 + i)], value: row(100000 + i) }
  : { type: 1, key: ['u' + (100000 + i), 'n'], value: i * 7 })
const enc = (o: Outbox, recs: any[], withAttempt: boolean) => { o.begin(VERB.RECORDS, prov, withAttempt ? attempt : undefined); for (const r of recs) o.put(r); return o.finish()! }
const decodeAll = (f: Uint8Array) => { const out: any[] = []; for (const v of new Framer().push(f)[0].records()) out.push({ key: v.key, value: v.value }); return out }

const rows: Record<string, unknown>[] = []
for (const m of ['v4', 'short']) {
  setMode(m)
  for (const kind of ['row', 'field']) {
    const one = enc(new Outbox(), recsOf(kind, 1), true)
    const recs = recsOf(kind, 256)
    const o = new Outbox()
    const f256 = enc(o, recs, true)
    const f256plain = enc(new Outbox(), recs, false)
    const back = decodeAll(f256)
    const same = back.length === 256 && back.every((b, i) => isDeepStrictEqual(b.key, recs[i].key) && isDeepStrictEqual(b.value, recs[i].value))
    // envelope = what one frame adds beyond its records: frame(1) - per-record bytes (from the 256-record frame)
    const perRec = (f256.length - (one.length - 0)) / 255
    rows.push({
      format: m, kind, roundTrip: same,
      frame1_bytes: one.length, frame256_bytes: f256.length, frame256_noattempt_bytes: f256plain.length,
      bytes_per_record_in_256: +(f256.length / 256).toFixed(1),
      record_bytes: +perRec.toFixed(1),
      envelope_bytes_one_frame: +(one.length - perRec).toFixed(1),
      encode_ns: bench(() => enc(o, recs, true), 256),
      decode_ns: bench(() => decodeAll(f256), 256),
    })
  }
}
setMode('v4')
const r0 = row(100000)
const others = {
  json_record_bytes: Buffer.byteLength(JSON.stringify([1, ['u100000'], r0])),
  v8_serialize_record_bytes: v8.serialize([1, ['u100000'], r0]).length,
  field_names_bytes: Object.keys(r0).join('').length,
  strings_per_row_record: 1 + Object.keys(r0).length + 4 + 2,
}
console.log(JSON.stringify({ bench: 'codecbytes', node: process.version, rows, others }))
