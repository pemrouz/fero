// E-23 run D: what does the merge layer cost per commit?
//
// The same 220,000 pre-generated commits (int domain; the first 20,000 warm
// up, the next 200,000 are timed) through one variant per process:
//   one     one source holding every row, with the four views P-12 names:
//           filter, top-k (za), sum, group: the one-group cost
//   base    16 group sources, no views: the cost of 16 folds
//   views   16 group sources, each with the four views: the partials
//   merge   views + the merger: rows of filter and top-k into a merged source
//           (top-k re-applied there), sum by per-group deltas, group by
//           per-bucket union
//   viewsC  16 group sources with the contract's partials: top-k with a total
//           order (az with a key tie-break), the exact sum as a row sink,
//           filter and group as before
//   mergeC  viewsC + its merger (top-k re-applied, exact-sum deltas merged)
// One line of JSON per run. Run it under the CPU lock ($SP/bin/timing).
//
// usage: node --experimental-strip-types bench.ts --variant=merge

import { rng, SLOTS, slotOf, makeRow, genPoints, genRoom, applyTruth, cmpTotal, ExactSum, proj, type Row, type Rec } from './lib.ts'
import { readFileSync } from 'node:fs'

const DATA = process.env.DATA_DIR ?? '/home/user/pemrouz/data'
const D: any = await import(DATA + '/api/index.ts')
const { $, value: VALUE, lane } = D

const arg = (name: string, def: string): string => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : def
}
const VARIANT = arg('variant', 'merge')
const G = 16
const K = 10
const WARM = 20000
const TIMED = 200000
const KEYS = 3000
const load = readFileSync('/proc/loadavg', 'utf8').trim()

// ── pre-generate the commits (not timed) ───────────────────────────────────────
const R = rng(42)
const truth = new Map<string, Row>()
const live: string[] = []
const liveIdx = new Map<string, number>()
const groupOf = (k: string) => Math.floor((slotOf(k) * G) / SLOTS)
const commits: { g: number; recs: Rec[] }[] = []
const keyOf = (r: Rec) => (r.type === 1 ? r.at : r.key[0]) as string
for (let i = 0; i < WARM + TIMED; i++) {
  const k = live.length > 0 && R() < 0.6 ? live[Math.floor(R() * live.length)] : 'p' + Math.floor(R() * KEYS)
  const exists = truth.has(k)
  const u = R()
  let rec: Rec
  if (!exists || u < 0.2) { const row = makeRow(k, 'int', R); rec = exists ? { type: 0, key: [k], value: row } : { type: 1, key: [], at: k, value: row } }
  else if (u < 0.65) rec = { type: 0, key: [k, 'points'], value: genPoints('int', R) }
  else if (u < 0.78) rec = { type: 0, key: [k, 'room'], value: genRoom('int', R) }
  else rec = { type: 2, key: [k] }
  applyTruth(truth, rec)
  if (truth.has(k)) { if (!liveIdx.has(k)) { liveIdx.set(k, live.length); live.push(k) } }
  else if (liveIdx.has(k)) { const j = liveIdx.get(k)!; const last = live.pop()!; if (last !== k) { live[j] = last; liveIdx.set(last, j) } liveIdx.delete(k) }
  commits.push({ g: groupOf(keyOf(rec)), recs: [rec] })
}

const PRED = (r: Row) => (r.points as any) >= 50
const ROOM = (r: Row) => r.room

// ── mergers (the same logic as merge.ts, without the checking) ────────────────
let deltas = { filter: 0, topk: 0, sum: 0, group: 0 }
class RowUnion {
  ms = $({}); laneM = lane(this.ms); q: Rec[] = []; ownerOf = new Map<string, number>()
  name: 'filter' | 'topk'
  constructor(name: 'filter' | 'topk') { this.name = name }
  hook(gid: number, view: any) {
    view.sink({
      init: (snap: Map<string, Row>) => { for (const [k, row] of snap) this.put(gid, k, row) },
      apply: (b: any) => { for (const d of b.rows) { deltas[this.name]++; if (d.op === 'remove') this.drop(gid, d.key); else this.put(gid, d.key, d.row) } },
    })
  }
  put(gid: number, k: string, row: Row) { this.ownerOf.set(k, gid); this.q.push({ type: 0, key: [k], value: row }) }
  drop(gid: number, k: string) { if (this.ownerOf.get(k) !== gid) return; this.ownerOf.delete(k); this.q.push({ type: 2, key: [k] }) }
  drain() { if (this.q.length) { const r = this.q; this.q = []; this.laneM(r) } }
}
const IDX = /^(0|[1-9][0-9]*)$/
const cmpKeys = (a: string, b: string) => { const ia = IDX.test(a), ib = IDX.test(b); if (ia && ib) return Number(a) - Number(b); if (ia) return -1; if (ib) return 1; return a < b ? -1 : a > b ? 1 : 0 }
class GroupUnion {
  parts = new Map<string, Map<number, Record<string, Row>>>(); touched = new Set<string>(); merged = new Map<string, Record<string, Row>>()
  hook(gid: number, view: any) {
    view.sink({
      init: (snap: Map<string, any>) => { for (const [b, v] of snap) this.set(gid, b, v) },
      apply: (bt: any) => { for (const d of bt.rows) { deltas.group++; if (d.op === 'remove') this.del(gid, d.key); else this.set(gid, d.key, d.row) } },
    })
  }
  set(gid: number, b: string, v: any) { let m = this.parts.get(b); if (!m) this.parts.set(b, (m = new Map())); m.set(gid, v); this.touched.add(b) }
  del(gid: number, b: string) { this.parts.get(b)?.delete(gid); this.touched.add(b) }
  drain() {
    for (const b of this.touched) {
      const m = this.parts.get(b)!
      if (m.size === 0) { this.parts.delete(b); this.merged.delete(b); continue }
      const ks: string[] = []; const all: Record<string, Row> = {}
      for (const v of m.values()) for (const k of Object.keys(v)) { ks.push(k); all[k] = v[k] }
      ks.sort(cmpKeys)
      const o: Record<string, Row> = {}
      for (const k of ks) o[k] = all[k]
      this.merged.set(b, o)
    }
    this.touched.clear()
  }
}

// ── build the variant ──────────────────────────────────────────────────────────
const OP = arg('op', 'all') // all | filter | topk | sum | group
const has = (o: string) => OP === 'all' || OP === o
type Fold = { src: any; lane: (r: Rec[]) => unknown }
const fold = (): Fold => { const src = $({}); return { src, lane: lane(src) } }
let apply: (c: { g: number; recs: Rec[] }) => void
let sink = 0 // keeps results alive so nothing is optimised away
let sanity: () => string = () => 'n/a'
if (VARIANT === 'one') {
  const f = fold()
  const v: any[] = []
  if (has('filter')) v.push(f.src.filter(PRED))
  if (has('topk')) v.push(f.src.za('points', K))
  if (has('sum')) v.push(f.src.sum('points'))
  if (has('group')) v.push(f.src.group(ROOM))
  apply = (c) => { f.lane(c.recs); sink += v.length }
} else {
  const gs = Array.from({ length: G }, fold)
  const withViews = VARIANT !== 'base'
  const contract = VARIANT === 'viewsC' || VARIANT === 'mergeC'
  const merging = VARIANT === 'merge' || VARIANT === 'mergeC'
  const fU = new RowUnion('filter'), tU = new RowUnion('topk'), gU = new GroupUnion()
  const topOut = merging && has('topk') ? (contract ? tU.ms.az(cmpTotal, K) : tU.ms.za('points', K)) : null
  const sums: any[] = []
  const mergedExact = new ExactSum()
  let total = 0
  const lastSum: number[] = new Array(G).fill(0)
  gs.forEach((g, gid) => {
    if (!withViews) return
    if (has('filter')) { const fv = g.src.filter(PRED); if (merging) fU.hook(gid, fv) }
    if (has('topk')) { const tv = contract ? g.src.az(cmpTotal, K) : g.src.za('points', K); if (merging) tU.hook(gid, tv) }
    if (has('group')) { const gv = g.src.group(ROOM); if (merging) gU.hook(gid, gv) }
    if (!has('sum')) return
    if (contract) {
      // the exact sum as a contract partial: a row sink; its deltas are (old, new) values
      const es = new ExactSum()
      g.src.sink({
        apply: (b: any) => {
          for (const d of b.rows) {
            const o = d.op === 'add' ? undefined : proj(d.prev, 'points')
            const n = d.op === 'remove' ? undefined : proj(d.row, 'points')
            if (o === n) continue
            if (o !== undefined) es.sub(+(o as any))
            if (n !== undefined) es.add(+(n as any))
            if (merging) { deltas.sum++; if (o !== undefined) mergedExact.sub(+(o as any)); if (n !== undefined) mergedExact.add(+(n as any)) }
          }
        },
      })
    } else sums.push(g.src.sum('points'))
  })
  const sumOn = has('sum')
  apply = (c) => {
    gs[c.g].lane(c.recs)
    if (!merging) return
    fU.drain(); tU.drain(); gU.drain()
    if (!sumOn) return
    if (!contract) {
      // a sum partial changed only in the committing group: apply its delta
      const s = sums[c.g][VALUE] as number
      if (s !== lastSum[c.g]) { deltas.sum++; total += s - lastSum[c.g]; lastSum[c.g] = s }
      sink += total
    } else sink += mergedExact.value()
  }
  // untimed sanity, after the run: the merged sum and top-10 scores equal the truth's
  sanity = () => {
    if (!merging) return 'n/a'
    const bad: string[] = []
    if (sumOn) {
      let t = 0
      for (const r of truth.values()) t += r.points as number
      const got = contract ? mergedExact.value() : total
      if (got !== t) bad.push(`sum ${got} vs ${t}`)
    }
    if (topOut !== null) {
      const want = [...truth.values()].map((r) => r.points as number).sort((a, b) => b - a).slice(0, K)
      const top: number[] = []
      topOut[D.node].each((_k: string, r: Row) => top.push(r.points as number))
      if (JSON.stringify(top) !== JSON.stringify(want)) bad.push(`top ${JSON.stringify(top)} vs ${JSON.stringify(want)}`)
    }
    if (has('filter')) { let n = 0; for (const r of truth.values()) if (PRED(r)) n++; if (fU.ms[D.node].rowCount() !== n) bad.push('filter count') }
    if (has('group')) { let n = 0; for (const b of gU.merged.values()) n += Object.keys(b).length; if (n !== truth.size) bad.push('group rows') }
    return bad.length ? 'BAD ' + bad.join('; ') : 'ok'
  }
}

for (let i = 0; i < WARM; i++) apply(commits[i])
deltas = { filter: 0, topk: 0, sum: 0, group: 0 }
const t0 = process.hrtime.bigint()
for (let i = WARM; i < WARM + TIMED; i++) apply(commits[i])
const ns = Number(process.hrtime.bigint() - t0)
console.log(JSON.stringify({ variant: VARIANT, op: OP, commits: TIMED, ms: +(ns / 1e6).toFixed(1), nsPerCommit: Math.round(ns / TIMED), deltas, rows: truth.size, loadavg: load, sanity: sanity(), sink: sink === Infinity ? 0 : 1 }))
