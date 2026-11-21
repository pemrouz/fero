// E-62 item 6: a field's `-N`: reading the row's log back until N changes of the field are found, with a busy
// sibling field beside it (V5-15 pick 2; API.md 3.10 "-N"; LAYERS 10 item 39; ANYPATH 6 item 5; unpriced).
//   node --expose-gc --experimental-strip-types fieldback.mjs <ratio: sibling writes per field write> <whole: % of the
//   row's writes that replace the whole row>
// The log is E-19's slot layout in memory (log.mjs). 10^5 partitions; one row W (depth 1: the row is its partition)
// takes 1 % of all records: writes to its field f, to its busy sibling g (`ratio` of them per write to f), and whole-row
// writes (`whole` % of W's writes; half of them change f, half keep it). V5-15 pick 2: `-N` on a field counts the
// commits whose records reached it: at or under the field, or above it (the whole row) and changing its value.
// Two ways to find the 5th last change of W.f:
//   back   the serving copy reads W's slot back through the slot index, newest first: the partition key compared as
//          bytes; for W's records, the second key read (g: beside, skipped; f: at, its value decoded; none: the whole
//          row, decoded for f); a record changed f when its value differs from the next older value of f
//   fwd    the same window read FORWARD with the same key filter as `back` (g's records skipped on their key bytes,
//          f's values decoded), its start given: to show what the direction costs on its own
//   fold   LAYERS 10 item 39's reading: the reading process takes W's records from that place (here the place `back`
//          found, so the window is exactly right) and folds them forward through data, with data's rule on f
//          (a change at f, or above f and changing its value); the time of that fold alone, its window given. Every
//          record of W in the window is decoded and written, the sibling's too
// For contrast: `-N` on the row W itself (the count by key: 5 commits of W).
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Log, header, keyIs, keyStr, value, H } from './log.mjs'
import { rng, out, slotOf, gc } from './common.mjs'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))
const { Runtime } = await import(pathToFileURL(DATA + '/kernel/runtime.ts').href)
const { SourceNode, leafAt } = await import(pathToFileURL(DATA + '/kernel/node.ts').href)

const RATIO = +(process.argv[2] ?? 100), WHOLE = +(process.argv[3] ?? 0) / 100, N = 5
const P = 1e5, R = +(process.env.RECORDS ?? 2e6), SHARE = 0.01
const r = rng(6206)
const log = new Log({ cap: Math.ceil(R * 40 + 1e6) })
const pk = Array.from({ length: P }, (_, i) => 'p' + i), ps = Int32Array.from(pk, (k) => slotOf(k))
const WK = 'w', WS = slotOf(WK)
let f = 0, g = 0, nf = 0, ng = 0, nw = 0, nwChange = 0
const wrow = () => JSON.stringify({ f, g, name: 'row-w', tags: ['a', 'b'] })
log.append(WS, [WK], wrow()) // the row's first write: the whole row
for (let i = 1; i < R; i++) {
  if (r() < SHARE) {
    const x = r() * (1 + RATIO) // one write to f per RATIO writes to g, before whole-row writes are taken out
    if (r() < WHOLE) { nw++; g++; if (r() < 0.5) { f++; nwChange++ } log.append(WS, [WK], wrow()) }
    else if (x < 1) { nf++; f++; log.append(WS, [WK, 'f'], String(f)) }
    else { ng++; g++; log.append(WS, [WK, 'g'], String(g)) }
  } else { const p = Math.floor(r() * P); log.append(ps[p], [pk[p], 'n'], String(i)) }
}
log.seal()
const wkb = Buffer.from(WK, 'latin1'), fkb = Buffer.from('f', 'latin1')

// back: returns the slot-index place of the N-th last change of W.f, and what it read
function back() {
  const b = log.buf, offs = log.sOff[WS]
  let headers = 0, keys = 0, wrecs = 0, decoded = 0, wholeDecoded = 0, changes = 0
  let newer = -1, newerVal // the newest record seen so far that carries f, and its value of f
  for (let i = offs.length - 1; i >= 0; i--) {
    header(b, offs[i], false); headers++; keys++
    if (keyIs(b, H.payload, 0, wkb) !== 1) continue
    wrecs++
    const k1 = keyIs(b, H.payload, 1, fkb)
    let v
    if (k1 === 0) continue // a sibling field: beside f
    if (k1 === 1) { v = value(b, H.payload, H.end); decoded++ } // at f
    else { v = value(b, H.payload, H.end).f; decoded++; wholeDecoded++ } // the whole row, above f
    if (newer >= 0 && v !== newerVal) { if (++changes === N) return { at: newer, headers, keys, wrecs, decoded, wholeDecoded } }
    newer = i; newerVal = v
  }
  if (newer >= 0 && ++changes === N) return { at: newer, headers, keys, wrecs, decoded, wholeDecoded } // the row's first write
  return { at: -1, headers, keys, wrecs, decoded, wholeDecoded, short: changes }
}
// the row's own -N: the count by key (5 commits of W)
function backRow() {
  const b = log.buf, offs = log.sOff[WS], recs = log.sRec[WS]
  let headers = 0, count = 0, last = -1
  for (let i = offs.length - 1; i >= 0; i--) {
    header(b, offs[i], false); headers++
    if (keyIs(b, H.payload, 0, wkb) !== 1) continue
    const bt = recs[i] >> 8
    if (bt !== last) { last = bt; if (++count === N) return { headers } }
  }
  return { headers }
}
// fwd: the same window as the fold, forward, with back's key filter; the state just before `from` is given (f = -1,
// as the fold's), so the record at `from` counts as a change
function fwd(from) {
  const b = log.buf, offs = log.sOff[WS]
  let headers = 0, wrecs = 0, decoded = 0, changes = 0, last = -1
  for (let i = from; i < offs.length; i++) {
    header(b, offs[i], false); headers++
    if (keyIs(b, H.payload, 0, wkb) !== 1) continue
    wrecs++
    const k1 = keyIs(b, H.payload, 1, fkb)
    if (k1 === 0) continue // a sibling field: skipped on its key bytes
    const v = k1 === 1 ? value(b, H.payload, H.end) : value(b, H.payload, H.end).f
    decoded++
    if (v !== last) changes++
    last = v
  }
  return { headers, wrecs, decoded, changes }
}
// fold: W's records from slot-index place `from`, forward, through data's store, with data's rule on f
function foldPrep(from) {
  const b = log.buf, offs = log.sOff[WS], recs = []
  for (let i = from; i < offs.length; i++) {
    header(b, offs[i], false)
    if (keyIs(b, H.payload, 0, wkb) !== 1) continue
    const k1 = keyStr(b, H.payload, 1)
    recs.push({ path: k1 === undefined ? [] : [k1], off: offs[i] })
  }
  return recs
}
function fold(from, recs) {
  // the state just before `from` comes from a past read: given here (the row as it stood), not timed
  const src = new SourceNode(new Runtime(), { w: { f: -1, g: -1, name: 'row-w', tags: ['a', 'b'] } })
  let calls = 0
  const h = src.connect({ wantsOrder: false, origin: null, apply: (bt) => { for (const d of bt.rows) { const p = d.path ?? []; if (p.length === 0 ? !Object.is(leafAt(d.prev, ['f']), leafAt(d.row, ['f'])) : p[0] === 'f') calls++ } } })
  const b = log.buf
  const t0 = process.hrtime.bigint()
  for (const x of recs) { header(b, x.off, false); const v = value(b, H.payload, H.end); src.write(WK, x.path, v) }
  const us = Number(process.hrtime.bigint() - t0) / 1e3
  h.dispose()
  return { us, records: recs.length, calls }
}

const time = (fn, reps) => { const xs = []; let res; for (let i = 0; i < reps; i++) { const t0 = process.hrtime.bigint(); res = fn(); xs.push(Number(process.hrtime.bigint() - t0) / 1e3) } xs.sort((a, b) => a - b); return { res, us: Math.round(xs[xs.length >> 1] * 10) / 10 } }
for (let j = 0; j < 30; j++) { back(); backRow() } // warm, not kept
gc()
const a = time(back, 7), rw = time(backRow, 7)
for (let j = 0; j < 30; j++) fwd(a.res.at) // warm, not kept
const fw = time(() => fwd(a.res.at), 7)
const recs = foldPrep(a.res.at)
fold(a.res.at, recs); fold(a.res.at, recs) // warm
const fx = []; let fr
for (let i = 0; i < 7; i++) { fr = fold(a.res.at, recs); fx.push(fr.us) }
fx.sort((x, y) => x - y)
// check: the fold's count of changes to f over the window equals N (the window starts at the N-th last change)
out({
  item: 6, bench: 'fieldback', ratio: RATIO, whole_pct: WHOLE * 100, N, P, R, row_share: SHARE,
  row_writes: { f: nf, g: ng, whole: nw, whole_changing_f: nwChange }, slot_records: log.sOff[WS].length,
  back: { ...a.res, us: a.us }, row_minus_n: { ...rw.res, us: rw.us }, fwd: { ...fw.res, us: fw.us },
  fold: { records: fr.records, us: Math.round(fx[3] * 10) / 10, us_per_record: Math.round(fx[3] / fr.records * 1000) / 1000, changes_seen: fr.calls },
  check: { fold_changes_equal_N: fr.calls === N, fwd_changes_equal_N: fw.res.changes === N },
})
