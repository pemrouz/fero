// codec.ts — what fero v4's own codec (kernel/codec.ts, imported unchanged) costs on the write path, per record.
// Records are E-05's small row (about 100 B) as whole-row sets, and a field set (one number), in frames of N.
//   encode      : Outbox.begin + put x N + finish (one frame: header, crc32c over the frame, one slice copy)
//   crcOnly     : crcFrame over that frame alone (to split the encode's crc share out)
//   scan        : Framer.push (crc check) + Frame.records() (boundary scan: header, key and value SKIPPED)
//   key         : scan + each record's key (what a router needs)
//   full        : scan + key + value (what the fold needs; what a re-encoding relay or leader pays)
//   copyOf      : the V4-52 deep copy a local write takes at issue (api/data.ts unsendable -> copyBounded ~ copyOf)
//   encodable   : the walk alone, no copy
// Then one 1 MiB value (a string and a Uint8Array): encode, full decode, crc.
import { Outbox, Framer, VERB, crcFrame, copyOf, encodable, MAX_FRAME } from '../../../../../../kernel/codec.ts'

const LIMIT = { depth: 64, bytes: MAX_FRAME }
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
const out: Record<string, unknown>[] = []
for (const N of [1, 16, 256]) {
  for (const kind of ['row', 'field']) {
    const recs = Array.from({ length: N }, (_, i) => kind === 'row'
      ? { type: 1, key: ['u' + i], value: row(i) }
      : { type: 1, key: ['u' + i, 'n'], value: i * 7 })
    const o = new Outbox()
    const enc = () => { o.begin(VERB.RECORDS, { origin: 'leader', baseSeq: 1, epoch: 3 }); for (const r of recs) o.put(r as any); return o.finish()! }
    const frame = enc()
    const r: Record<string, unknown> = { N, kind, frameBytes: frame.length, bytesPerRec: +(frame.length / N).toFixed(1) }
    r.encode = bench(enc, N)
    r.crcOnly = bench(() => crcFrame(frame, frame.length), N)
    r.scan = bench(() => new Framer().push(frame)[0].records(), N)
    r.key = bench(() => { for (const v of new Framer().push(frame)[0].records()) v.key }, N)
    r.full = bench(() => { for (const v of new Framer().push(frame)[0].records()) { v.key; v.value } }, N)
    r.copyOf = bench(() => { for (const x of recs) copyOf(x.value, LIMIT, 0, 0) }, N)
    r.encodable = bench(() => { for (const x of recs) encodable(x.value, LIMIT, 0, 0) }, N)
    out.push(r)
  }
}
const big: Record<string, unknown>[] = []
for (const kind of ['str', 'u8']) {
  const value = kind === 'str' ? 'x'.repeat(1 << 20) : new Uint8Array(1 << 20).map((_, i) => i)
  const rec = { type: 1, key: ['blob'], value }
  const o = new Outbox()
  const enc = () => { o.begin(VERB.RECORDS, { origin: 'leader', baseSeq: 1, epoch: 3 }); o.put(rec as any); return o.finish()! }
  const frame = enc()
  big.push({
    kind, frameBytes: frame.length,
    encode_us: +(bench(enc, 1) / 1e3).toFixed(1),
    crcOnly_us: +(bench(() => crcFrame(frame, frame.length), 1) / 1e3).toFixed(1),
    scan_us: +(bench(() => new Framer().push(frame)[0].records(), 1) / 1e3).toFixed(1),
    full_us: +(bench(() => { for (const v of new Framer().push(frame)[0].records()) { v.key; v.value } }, 1) / 1e3).toFixed(1),
    copyOf_us: +(bench(() => copyOf(value, LIMIT, 0, 0), 1) / 1e3).toFixed(1),
    sliceCopy_us: +(bench(() => frame.slice(), 1) / 1e3).toFixed(1),
  })
}
console.log(JSON.stringify({ bench: 'codec', node: process.version, unit: 'ns per record', rows: out, big }))
