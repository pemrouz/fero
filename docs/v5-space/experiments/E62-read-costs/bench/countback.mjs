// E-62 item 2: counting back for `-N` on a real log (V5-13; CONNECT 3.4 and 9; API.md 3.10 "-N"), with a cold
// partition beside a hot one. The log is E-19's slot layout in memory (log.mjs): 4,096 slots, batches of 256 records,
// a slot and a length in each record header, the key first in the payload.
//   node --expose-gc countback.mjs <scenario: even-1e4 | even-1e5 | even-1e6 | hot-1 | hot-10> [N=5]
// even-P   P partitions, every record to a random one (seeded); 50 target partitions picked at random among those
//          that hold at least N commits (so `-N` exists), and 20 others to warm the code on
// hot-H    10^5 partitions; one hot partition takes H % of all records; three cold partitions in the hot one's slot were
//          written N times each at an age of 10^5, 10^6 and 3.9 × 10^6 records, and never since
// A commit is a batch: `-N` is the N-th last batch that holds a record of the partition. Four ways to find it:
//   slot      the slot index (each slot's records in log order), newest first; each record's key compared as bytes
//   slot+dec  the same, each key decoded to a string first (what a reader that decodes keys pays)
//   scan      no slot index: walk the batches newest first, every record header read, keys compared in the slot
//   prev      each record carries the gap back to its partition's previous record in the slot; start at the
//             partition's newest version (the leader keeps it: the per-row version store) and hop back
// For each: the records whose header is read, the keys compared, and the time: the FIRST read right after the CPU's
// caches are cleared (by reading a buffer bigger than the last-level cache), which is what a reader opening once
// pays, and the median of 5 reads after it (warm). CONNECT 3.4's reasoned count is about N × P / 4,096 of the slot's
// records when writes spread evenly; it priced each key at 0.5-0.8 µs (v4's decoder). The log also counts what a
// byte gap (log.mjs) would take in place of the sequence gap.
import { Log, SLOTS, BATCH, header, keyIs, keyStr, H } from './log.mjs'
import { rng, out, slotOf, gc } from './common.mjs'

const SC = process.argv[2] ?? 'even-1e5', N = +(process.argv[3] ?? 5)
const r = rng(6202)
const kb = (k) => Buffer.from(k, 'latin1')
const valueText = (i) => String(i % 100000)

function build({ P, R, hot = 0, colds = [] }) {
  const log = new Log({ cap: Math.ceil(R * 34 + 1e6), prev: true })
  const pk = Array.from({ length: P }, (_, i) => 'p' + i)
  const ps = Int32Array.from(pk, (k) => slotOf(k))
  let hotKey = null, hotSlot = -1
  const coldKeys = []
  if (hot > 0) {
    hotKey = pk[0]; hotSlot = ps[0]
    for (let j = 0; coldKeys.length < colds.length; j++) { const k = 'c' + j; if (slotOf(k) === hotSlot) coldKeys.push(k) }
  }
  // the cold partitions' records: N each, 1,000 records apart (so in N different batches), ending at their age
  const coldAt = new Map()
  colds.forEach((age, ci) => { for (let t = 0; t < N; t++) coldAt.set(R - age - (N - 1 - t) * 1000, ci) })
  for (let i = 0; i < R; i++) {
    const ci = coldAt.get(i)
    if (ci !== undefined) { log.append(hotSlot, [coldKeys[ci], 'n'], valueText(i)); continue }
    if (hot > 0 && r() < hot) { log.append(hotSlot, [hotKey, 'n'], valueText(i)); continue }
    const p = Math.floor(r() * P)
    log.append(ps[p], [pk[p], 'n'], valueText(i))
  }
  log.seal()
  return { log, pk, ps, hotKey, hotSlot, coldKeys }
}

// ── the four ways; each returns { batch, headers, keys } (batch: the record number of the N-th commit's batch start) ──
function bySlot(log, slot, key, decode) {
  const b = log.buf, offs = log.sOff[slot], recs = log.sRec[slot], k = kb(key)
  let headers = 0, keys = 0, count = 0, lastBatch = -1
  for (let i = offs.length - 1; i >= 0; i--) {
    header(b, offs[i], log.prev); headers++; keys++
    const hit = decode ? keyStr(b, H.payload, 0) === key : keyIs(b, H.payload, 0, k) === 1
    if (!hit) continue
    const bt = recs[i] >> 8
    if (bt !== lastBatch) { lastBatch = bt; if (++count === N) return { batch: bt, headers, keys } }
  }
  return { batch: count === 0 ? -1 : lastBatch, headers, keys, short: count }
}
function byScan(log, slot, key) {
  const b = log.buf, k = kb(key)
  let headers = 0, keys = 0, count = 0
  for (let bt = log.batchOff.length - 1; bt >= 0; bt--) {
    // walk this batch's records forward (varints read forward only); note whether any is the partition's
    let q = log.batchOff[bt]
    const rd = () => { let v = 0, m = 1, x; do { x = b[q++]; v += (x & 127) * m; m *= 128 } while (x & 128); return v }
    rd(); rd(); q += 8; const cnt = rd()
    let hit = false
    for (let i = 0; i < cnt; i++) {
      const off = q
      header(b, off, log.prev); headers++
      if (H.slot === slot) { keys++; if (!hit && keyIs(b, H.payload, 0, k) === 1) hit = true }
      q = H.end
    }
    if (hit && ++count === N) return { batch: bt, headers, keys }
  }
  return { batch: -1, headers, keys, short: count }
}
function byPrev(log, slot, key) {
  const b = log.buf, offs = log.sOff[slot], recs = log.sRec[slot]
  let s = log.last.get(key), headers = 0, count = 0, lastBatch = -1
  while (s !== undefined && s > 0) {
    const i = s - 1 // a record's sequence in its slot is its place in the slot's list plus one
    header(b, offs[i], true); headers++
    const bt = recs[i] >> 8
    if (bt !== lastBatch) { lastBatch = bt; if (++count === N) return { batch: bt, headers, keys: 0 } }
    if (H.gap === 0) break
    s -= H.gap
  }
  return { batch: count === 0 ? -1 : lastBatch, headers, keys: 0, short: count }
}

// clearing the caches: read one byte in every 64 of a buffer bigger than the last-level cache (FLUSH_MB, default
// 1,024; this box reports 504 MiB), so the log's records and its index are read from memory again
const FL = Buffer.alloc(+(process.env.FLUSH_MB ?? 1024) * 1048576, 1)
let flsink = 0, flushing = false, flushes = 0
const flush = () => { if (!flushing) return; let x = 0; for (let i = 0; i < FL.length; i += 64) x += FL[i]; flsink = (flsink + x) & 1023; flushes++ }
// one read right after the caches are cleared (cold), then `reps` more (warm: their median)
const time = (fn, reps) => {
  flush()
  let t0 = process.hrtime.bigint(), res = fn()
  const cold = Number(process.hrtime.bigint() - t0) / 1e3, xs = []
  for (let i = 0; i < reps; i++) { t0 = process.hrtime.bigint(); res = fn(); xs.push(Number(process.hrtime.bigint() - t0) / 1e3) }
  xs.sort((a, b) => a - b)
  return { res, cold, us: reps > 0 ? xs[xs.length >> 1] : cold }
}
const q50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
const q90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))] }
const r1 = (x) => Math.round(x * 10) / 10

let result
const t0 = process.hrtime.bigint()
if (SC.startsWith('even')) {
  const P = Number(SC.split('-')[1]), R = P >= 1e6 ? 8e6 : 4e6
  const { log, pk, ps } = build({ P, R })
  const buildS = Number(process.hrtime.bigint() - t0) / 1e9
  // targets: partitions with at least N commits (batches that hold one of their records), so `-N` exists; picked at
  // random by the seeded generator. 20 others warm the code first (not timed), so the targets' records are not warm.
  const commits = new Map()
  for (let s = 0; s < SLOTS; s++) {
    const offs = log.sOff[s], recs = log.sRec[s], lastB = new Map()
    for (let i = 0; i < offs.length; i++) { header(log.buf, offs[i], true); const k = log.buf.latin1Slice(H.payload + 2, H.payload + 2 + log.buf[H.payload + 1]); const bt = recs[i] >> 8; if (lastB.get(k) !== bt) { lastB.set(k, bt); commits.set(k, (commits.get(k) ?? 0) + 1) } }
  }
  const cands = pk.filter((k) => (commits.get(k) ?? 0) >= N)
  const T = 50, picked = new Set()
  while (picked.size < T + 20) picked.add(cands[Math.floor(r() * cands.length)])
  const all = [...picked], targets = all.slice(0, T), warm = all.slice(T)
  const recsOf = (k) => { let n = 0; const s = ps[Number(k.slice(1))]; for (const off of log.sOff[s]) { header(log.buf, off, true); if (log.buf.latin1Slice(H.payload + 2, H.payload + 2 + log.buf[H.payload + 1]) === k) n++ } return n }
  const targetRecords = targets.map(recsOf)
  for (const k of warm) { const s = ps[Number(k.slice(1))]; for (let j = 0; j < 20; j++) { bySlot(log, s, k, false); bySlot(log, s, k, true); byPrev(log, s, k) } }
  for (const k of warm.slice(0, 2)) byScan(log, ps[Number(k.slice(1))], k)
  gc()
  flushing = true
  const rows = { slot: [], 'slot+dec': [], scan: [], prev: [] }
  let agree = 0
  targets.forEach((k, ti) => {
    const s = ps[Number(k.slice(1))]
    const a = time(() => bySlot(log, s, k, false), 5)
    const d = time(() => bySlot(log, s, k, true), 5)
    const p = time(() => byPrev(log, s, k), 5)
    rows.slot.push({ headers: a.res.headers, keys: a.res.keys, us: a.us, cold: a.cold })
    rows['slot+dec'].push({ headers: d.res.headers, keys: d.res.keys, us: d.us, cold: d.cold })
    rows.prev.push({ headers: p.res.headers, keys: 0, us: p.us, cold: p.cold })
    let same = a.res.batch === d.res.batch && a.res.batch === p.res.batch && a.res.short === undefined
    if (ti < 10) { const c = time(() => byScan(log, s, k), 0); rows.scan.push({ headers: c.res.headers, keys: c.res.keys, us: c.us, cold: c.cold }); same = same && c.res.batch === a.res.batch }
    if (same) agree++
  })
  const sum = (xs) => ({ targets: xs.length, headers_med: q50(xs.map((x) => x.headers)), headers_p90: q90(xs.map((x) => x.headers)), keys_med: q50(xs.map((x) => x.keys)), us_med: r1(q50(xs.map((x) => x.us))), us_p90: r1(q90(xs.map((x) => x.us))), cold_med: r1(q50(xs.map((x) => x.cold))), cold_p90: r1(q90(xs.map((x) => x.cold))) })
  result = { P, R, buildS: r1(buildS), reasoned_slot_records: Math.round(N * P / SLOTS), slot_records_mean: Math.round(R / SLOTS), partitions_with_N_commits: cands.length, target_records_med: q50(targetRecords), records_per_partition_mean: r1(R / P), bytes_per_record: r1(log.bytesPerRecord()), prev_bytes_per_record: Math.round(log.prevBytes / log.n * 100) / 100, bgap_bytes_per_record: Math.round(log.bgapBytes / log.n * 100) / 100, ways: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, sum(v)])), agree_of: [agree, T], flushes, flush_mb: FL.length / 1048576 }
} else {
  const H100 = Number(SC.split('-')[1]), P = 1e5, R = 4e6
  const ages = [1e5, 1e6, 3.9e6]
  const { log, hotKey, hotSlot, coldKeys } = build({ P, R, hot: H100 / 100, colds: ages })
  const buildS = Number(process.hrtime.bigint() - t0) / 1e9
  gc()
  const cases = {}
  const one = (k) => {
    const a = time(() => bySlot(log, hotSlot, k, false), 5)
    const d = time(() => bySlot(log, hotSlot, k, true), 5)
    const p = time(() => byPrev(log, hotSlot, k), 5)
    const c = time(() => byScan(log, hotSlot, k), 2)
    const same = a.res.batch === d.res.batch && a.res.batch === p.res.batch && a.res.batch === c.res.batch
    return { slot: { headers: a.res.headers, keys: a.res.keys, us: r1(a.us), cold: r1(a.cold) }, 'slot+dec': { headers: d.res.headers, us: r1(d.us), cold: r1(d.cold) }, scan: { headers: c.res.headers, keys: c.res.keys, us: r1(c.us), cold: r1(c.cold) }, prev: { headers: p.res.headers, us: r1(p.us), cold: r1(p.cold) }, batch_age_records: R - a.res.batch * BATCH, agree: same }
  }
  one(hotKey); coldKeys.forEach((k) => one(k)) // a warm pass first, not kept
  for (let j = 0; j < 50; j++) { bySlot(log, hotSlot, hotKey, false); bySlot(log, hotSlot, hotKey, true); byPrev(log, hotSlot, hotKey) }
  gc()
  flushing = true
  cases.hot = one(hotKey)
  coldKeys.forEach((k, i) => { cases['cold, age ' + ages[i]] = one(k) })
  result = { P, R, hot_share: H100 / 100, slot_records: log.sOff[hotSlot].length, buildS: r1(buildS), bytes_per_record: r1(log.bytesPerRecord()), prev_bytes_per_record: Math.round(log.prevBytes / log.n * 100) / 100, bgap_bytes_per_record: Math.round(log.bgapBytes / log.n * 100) / 100, cases, flushes, flush_mb: FL.length / 1048576 }
}
out({ item: 2, bench: 'countback', scenario: SC, N, ...result, flsink: flsink >= 0 })
