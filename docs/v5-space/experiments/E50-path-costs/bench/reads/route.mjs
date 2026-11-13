// B2: what it costs a serving copy to route one committed record to the subscribers that follow its partition, and to
// cut a subscriber's own frame out of a committed batch. fero v4's codec (kernel/codec.ts), imported unchanged.
//   node --expose-gc route.mjs
// Batch: one frame of 256 records, all updates of whole ~100 B rows (kind=row) or of one field (kind=field), over
// 100,000 partitions spread over 4,096 slots (the partition is the row key). Followers follow F partitions.
// Ways, per record of the batch (the frame's crc check and boundary scan are paid once per frame and shown apart):
//   (each way below includes the frame's boundary scan, Frame.records(); 'slot test only' leaves it out)
//   full     rv.rec() (key and value decoded, copied out) then a Map lookup of the partition: v4's inbound path
//            (kernel/write.ts:828 materialises the record, then :875-877 hands it to each client link)
//   key      rv.key[0] (the key decoded, the value skipped) then the Map lookup
//   slot     the record's slot read as a number (v5 carries it in the record header, E-19; here a side array stands in
//            for one varint read), a bitmap test, and the key decode + Map lookup only when the slot has a follower
// Cutting a subscriber's frame (sel = records it gets out of 256):
//   reencode  v4's way: Outbox.begin/add(rec)/finish per link (kernel/link.ts:166-171) — encode from objects
//   copy+crc  copy the selected records' bytes into a new frame, patch count and length, one crc (v4's JS crc32c)
//   copy+zcrc the same with node's native zlib.crc32 (another polynomial; the native speed is the point)
import zlib from 'node:zlib'
import { C, row, key, nsPer, out, median, gc, now } from './common.mjs'
const P = 100000, SLOTS = 4096
const slotOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0) % SLOTS }
const mk = (kind, base) => {
  const recs = [], slots = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    const j = (base + i * 7919) % P, k = key(j)
    recs.push(kind === 'row' ? { type: 0, key: [k], value: row(j, i) } : { type: 0, key: [k, 'n'], value: i })
    slots[i] = slotOf(k)
  }
  return { bytes: C.encodeFrame(recs), recs, slots }
}
const res = {}
for (const kind of ['row', 'field']) {
  const B = mk(kind, 1)
  const frame = B.bytes
  // per-frame costs
  const crcV4 = nsPer((c) => { for (let j = 0; j < c; j++) C.crcFrame(frame, frame.length) }, 20000) / 256
  const scan = nsPer((c) => { for (let j = 0; j < c; j++) new C.Frame(frame).records() }, 20000) / 256
  for (const F of [0, 10, 1000, 100000]) {
    // follow set: F partitions (F = P: every partition followed, so every record hits)
    const follow = new Map(), bitmap = new Uint8Array(SLOTS)
    for (let j = 0; j < F; j++) { const k = key((j * 104729) % P); follow.set(k, [1]); bitmap[slotOf(k)] = 1 }
    if (F === P) for (let j = 0; j < P; j++) { follow.set(key(j), [1]); bitmap[slotOf(key(j))] = 1 }
    let hits = 0
    // every way pays the frame's boundary scan (fresh RecordViews each round, so nothing is memoised); totals per record
    const full = nsPer((c) => { for (let r = 0; r < c; r++) { const v = new C.Frame(frame).records(); for (let i = 0; i < 256; i++) { const rec = v[i].rec(); if (follow.get(rec.key[0]) !== undefined) hits++ } } }, 400) / 256
    const keyOnly = nsPer((c) => { for (let r = 0; r < c; r++) { const v = new C.Frame(frame).records(); for (let i = 0; i < 256; i++) if (follow.get(v[i].key[0]) !== undefined) hits++ } }, 400) / 256
    const slot = nsPer((c) => { for (let r = 0; r < c; r++) { const v = new C.Frame(frame).records(); for (let i = 0; i < 256; i++) if (bitmap[B.slots[i]] === 1 && follow.get(v[i].key[0]) !== undefined) hits++ } }, 400) / 256
    const slotNoScan = nsPer((c) => { for (let r = 0; r < c; r++) { let h = 0; for (let i = 0; i < 256; i++) if (bitmap[B.slots[i]] === 1) h++; hits += h } }, 4000) / 256
    const hitRate = B.recs.filter((r) => follow.has(r.key[0])).length / 256
    res[`${kind}/F=${F}`] = { hitRate, 'scan+full': +full.toFixed(1), 'scan+key': +keyOnly.toFixed(1), 'scan+slot': +slot.toFixed(1), 'slot test only': +slotNoScan.toFixed(1) }
  }
  // cutting a subscriber's frame: sel of 256 records
  const views = new C.Frame(frame).records()
  const starts = new Array(256); let at = 15
  for (let i = 0; i < 256; i++) { starts[i] = at; at += views[i].span }
  const ob = new C.Outbox()
  for (const sel of [1, 16, 256]) {
    const pick = Array.from({ length: sel }, (_, i) => Math.floor(i * 256 / sel))
    const recs = pick.map((i) => B.recs[i])
    const reenc = nsPer((c) => { for (let r = 0; r < c; r++) { ob.begin(C.VERB.RECORDS); for (const x of recs) ob.add(x); ob.finish() } }, 2000) / sel
    const cut = (crc) => (c) => {
      for (let r = 0; r < c; r++) {
        let len = 15; for (const i of pick) len += views[i].span
        const o = new Uint8Array(len); o.set(frame.subarray(0, 15), 0); let w = 15
        for (const i of pick) { const s = starts[i], e = s + views[i].span; o.set(frame.subarray(s, e), w); w += e - s }
        o[3] = (len - 11) & 255; o[4] = ((len - 11) >> 8) & 255; o[5] = ((len - 11) >> 16) & 255; o[6] = 0
        o[11] = sel & 255; o[12] = sel >> 8; o[13] = 0; o[14] = 0
        const v = crc(o); o[7] = v & 255; o[8] = (v >>> 8) & 255; o[9] = (v >>> 16) & 255; o[10] = v >>> 24
      }
    }
    const copyV4 = nsPer(cut((o) => C.crcFrame(o, o.length)), 2000) / sel
    const copyZ = nsPer(cut((o) => zlib.crc32(o)), 2000) / sel
    // check: the cut frame decodes to the selected records (v4 crc form)
    res[`${kind}/cut sel=${sel}`] = { reencode: +reenc.toFixed(1), 'copy+crc': +copyV4.toFixed(1), 'copy+zcrc': +copyZ.toFixed(1) }
  }
  res[`${kind}/per-frame`] = { 'crc check (v4 JS)': +crcV4.toFixed(1), scan: +scan.toFixed(1), bytesPerRecord: +(frame.length / 256).toFixed(1) }
}
// self-check: a cut frame is a valid frame that decodes to the picked records
{
  const B = mk('row', 3), views = new C.Frame(B.bytes).records(); const pick = [0, 5, 77]
  let len = 15; const starts = []; let at = 15; for (let i = 0; i < 256; i++) { starts[i] = at; at += views[i].span }
  for (const i of pick) len += views[i].span
  const o = new Uint8Array(len); o.set(B.bytes.subarray(0, 15)); let w = 15
  for (const i of pick) { o.set(B.bytes.subarray(starts[i], starts[i] + views[i].span), w); w += views[i].span }
  o[3] = (len - 11) & 255; o[4] = ((len - 11) >> 8) & 255; o[5] = 0; o[6] = 0; o[11] = 3; o[12] = 0; o[13] = 0; o[14] = 0
  const v = C.crcFrame(o, o.length); o[7] = v & 255; o[8] = (v >>> 8) & 255; o[9] = (v >>> 16) & 255; o[10] = v >>> 24
  const back = [...new C.Framer().push(o)][0].records().map((r) => JSON.stringify(r.rec()))
  const want = pick.map((i) => JSON.stringify(B.recs[i]))
  res.selfcheck = JSON.stringify(back) === JSON.stringify(want)
}
out({ bench: 'route', ns: res })
