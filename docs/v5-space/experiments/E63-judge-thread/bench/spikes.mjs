// E-63 side probe: where a judging thread's long blocks come from. One thread, no I/O, no waiting: the steady
// load's row work, 50 writes a tick (one tick = 1 ms of the 50,000-a-second load, E-63's mix), on 1,000,000 small
// rows, for 15,000 ticks (15 s of load, run flat out). Each tick's time is recorded.
//   node --expose-gc spikes.mjs <map | map2 | mapint | lane | lane+ver | compact | map2shard | upkeep> [rows]
//   map       a JavaScript Map of row objects (B's copy without its versions)
//   map2      the same plus a Map of versions (B's copy as built)
//   mapint    one Map of 1,000,000 keys to small numbers, with the same churn (no row objects: almost no garbage)
//   lane      data's lane, one call a tick (the fold every copy runs on its main thread)
//   lane+ver  the same plus the Map of versions main keeps beside data's rows (A and every main thread here)
//   compact   CompactRows (B2's copy: no object per row)
// Added after review (rows defaults to 1,000,000; 900,000 leaves the Maps room for the whole run):
//   map2shard  map2 with each Map cut into 256 Maps by the key's slot (Bs's copy, common.mjs ShardedMap)
//   upkeep     compact, then, after the ticks, the upkeep the full runs never reach, each timed as one block:
//              the index moved into twice the slots (rehash_ms) and the arena copied without its dead space
//              (compact_ms)
// Reported: tick time p50, p99, p99.9, max; ticks over 10 ms and over 50 ms; GC pauses in the same window.
import { performance } from 'node:perf_hooks'
import * as K from './common.mjs'

const [variant = 'map', rowsArg] = process.argv.slice(2)
const N = rowsArg ? +rowsArg : 1e6, TICKS = 15000, PER = 50
let x = 0x9e3779b9; const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0 }
let rows = null, vers = null, lane = null, node = null, compact = null
if (variant === 'map2shard') { rows = new K.ShardedMap(); vers = new K.ShardedMap(); K.loadRows(N, 'small', (recs) => { for (const r of recs) { rows.set(r.at, r.value); vers.set(r.at, 0) } }) }
else if (variant === 'map' || variant === 'map2' || variant === 'mapint') { rows = new Map(); if (variant === 'map2') vers = new Map(); K.loadRows(N, 'small', (recs) => { for (const r of recs) { rows.set(r.at, variant === 'mapint' ? 0 : r.value); vers?.set(r.at, 0) } }) }
else if (variant === 'lane' || variant === 'lane+ver') {
  const p = K.S.proxy({}); lane = K.D.lane(p, { origin: K.S.ORIGIN, onReject: (rj) => { throw rj.error } }); node = p[K.D.node]
  if (variant === 'lane+ver') vers = new Map()
  K.loadRows(N, 'small', (recs) => { lane(recs); for (const r of recs) vers?.set(r.at, 0) })
} else if (variant === 'compact' || variant === 'upkeep') { compact = new K.CompactRows(N * 1.3, N * 220 * 1.5 + (64 << 20)); K.loadRows(N, 'small', (recs) => { for (const r of recs) compact.set(r.at, r.value, 0) }) }
else throw new Error('unknown variant ' + variant)
globalThis.gc?.(); globalThis.gc?.()
const gcl = K.gcLog()
let oldest = 0, next = N, stamp = 1, ver = 1
const times = new Float64Array(TICKS)
const t0 = performance.timeOrigin + performance.now()
for (let t = 0; t < TICKS; t++) {
  const a = performance.now()
  const recs = []
  for (let i = 0; i < PER; i++) {
    const m = rnd() % 100, j = oldest + (rnd() % (next - oldest)), k = K.key(j)
    let rec
    if (m < 65 && m >= 55) rec = { type: K.UPDATE, key: [k], value: K.row('small', j, ++stamp) } // conditional whole-row set
    else if (m < 55) rec = { type: K.UPDATE, key: [k, 'n'], value: ++stamp } // field write or incr
    else if (m < 80) rec = { type: K.UPDATE, key: [k], value: K.row('small', j, ++stamp) }
    else if (m < 90) { rec = { type: K.UPDATE, key: [K.key(next)], value: K.row('small', next, ++stamp) }; next++ }
    else { rec = { type: K.REMOVE, key: [K.key(oldest)] }; oldest++ }
    if (lane) recs.push(rec)
    const rk = rec.key[0]
    if (rows && variant === 'mapint') { if (rec.type === K.REMOVE) rows.delete(rk); else rows.set(rk, ++ver) }
    else if (rows) { if (rec.type === K.REMOVE) { rows.delete(rk); vers?.delete(rk) } else { const v = rec.key.length === 1 ? rec.value : { ...rows.get(rk), n: rec.value }; rows.set(rk, v); vers?.set(rk, ++ver) } }
    else if (compact) { if (rec.type === K.REMOVE) compact.delete(rk); else compact.set(rk, rec.key.length === 1 ? rec.value : { ...compact.get(rk), n: rec.value }, ++ver) }
    else if (vers) { if (rec.type === K.REMOVE) vers.delete(rk); else vers.set(rk, ++ver) }
  }
  if (lane) lane(recs)
  times[t] = performance.now() - a
}
const t1 = performance.timeOrigin + performance.now()
let upkeep = null
if (variant === 'upkeep') { // each as one block, as a store with no incremental upkeep would run it
  const before = compact.bytes(), a = performance.now(); compact.rehash(); const b = performance.now(); compact.compact(); const c = performance.now()
  upkeep = { before, rehash_ms: +(b - a).toFixed(1), compact_ms: +(c - b).toFixed(1), after: compact.bytes() }
}
await new Promise((r) => setTimeout(r, 100)) // the GC observer delivers its entries on a later turn
const s = Float64Array.from(times).sort(), q = (f) => +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(3)
let over10 = 0, over50 = 0; for (const v of times) { if (v > 10) over10++; if (v > 50) over50++ }
const top = [...times].map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([v, i]) => [+v.toFixed(1), i])
console.log(JSON.stringify({ exp: 'E-63', part: 'spikes', variant, rows: N, ticks: TICKS, per_tick: PER, node: process.version,
  run_s: +((t1 - t0) / 1000).toFixed(2), tick_ms: { p50: q(0.5), p99: q(0.99), p999: q(0.999), max: +s[s.length - 1].toFixed(2) }, ticks_over_10ms: over10, ticks_over_50ms: over50, longest_ticks: top,
  gc: gcl.summary(t0, t1), upkeep: upkeep ?? undefined, rows_end: rows ? rows.size : node ? node.rowCount() : compact.size }))
