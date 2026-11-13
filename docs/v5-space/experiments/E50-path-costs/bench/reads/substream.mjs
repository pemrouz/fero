// B3: a live subscription's changes, served and applied the way fero v4's method plane does it, against one frame per
// committed batch. fero v4's codec and seam, unchanged.
//   node --expose-gc substream.mjs
// Server side, per change per subscriber:
//   subrec   encodeControl(VERB.SUBREC, { id, recs: [rec] }) — one control frame per record per subscriber
//            (api/methods.ts:349-358 → kernel/node.ts:856-859), each with its own header and crc
//   batch    one RECORDS frame per 256 changes, encoded once (Outbox), the same bytes for every subscriber: per
//            subscriber nothing is encoded (the cost is the encode divided by the subscriber count)
// Client side, per change (a mirror of 1,000 rows):
//   subrec   Frame(bytes).value (the whole control value decoded) then applyStreamRec (data's ingest, one call per
//            record: api/substrate.ts:228-262)
//   batch    decode one frame of 256 (Frame.records(), rec()) then ONE lane call for the 256 (E-05's b256)
import { S, D, C, row, key, nsPer, out, fill, laneFor, decodeFrame } from './common.mjs'
const SUBS = [1, 100]
const mkRecs = (kind, base) => Array.from({ length: 256 }, (_, i) => {
  const j = (base + i * 7) % 1000
  return kind === 'row' ? { type: 0, key: [key(j)], value: row(j, base + i) } : { type: 0, key: [key(j), 'n'], value: base + i }
})
const v2 = (r) => ({ type: 'update', key: r.key, value: r.value })
const res = {}
for (const kind of ['row', 'field']) {
  const recs = mkRecs(kind, 1)
  const r2 = recs.map(v2)
  // server side
  const subrec = nsPer((c) => { for (let k = 0; k < c; k++) for (let i = 0; i < 256; i++) C.encodeControl(C.VERB.SUBREC, { id: 7, recs: [r2[i]] }) }, 200) / 256
  const ob = new C.Outbox()
  const batchEnc = nsPer((c) => { for (let k = 0; k < c; k++) { ob.begin(C.VERB.RECORDS); for (const r of recs) ob.add(r); ob.finish() } }, 400) / 256
  for (const n of SUBS) res[`${kind}/serve, ${n} subscribers, per change per subscriber`] = { subrec: +subrec.toFixed(1), batch: +(batchEnc / n).toFixed(2) }
  // client side
  const frames = r2.map((r) => C.encodeControl(C.VERB.SUBREC, { id: 7, recs: [r] }))
  const batchFrame = C.encodeFrame(recs)
  const pA = S.proxy({}); fill(pA, 1000)
  const pB = S.proxy({}); fill(pB, 1000)
  const lane = laneFor(pB)
  const applySub = nsPer((c) => { for (let k = 0; k < c; k++) for (let i = 0; i < 256; i++) { const v = new C.Frame(frames[i]).value; S.applyStreamRec(pA, v.recs[0]) } }, 200) / 256
  const applyBatch = nsPer((c) => { for (let k = 0; k < c; k++) lane(decodeFrame(batchFrame)) }, 400) / 256
  res[`${kind}/apply on the client, per change`] = { subrec: +applySub.toFixed(1), batch: +applyBatch.toFixed(1), 'frame bytes per change': { subrec: +(frames.reduce((a, f) => a + f.length, 0) / 256).toFixed(1), batch: +(batchFrame.length / 256).toFixed(1) } }
}
out({ bench: 'substream', ns: res })
