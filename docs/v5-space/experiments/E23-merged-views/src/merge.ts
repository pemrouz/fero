// E-23 run A: can live views over a resource held by several groups be merged
// exactly?
//
// One resource, 1,024 fixed slots, G groups. Each group is its own data
// source (its fold) with its own data views over it: the "partials". A
// merger combines the partials by each operator's merge rule into one merged
// output (M). Beside it, one data source holds every row with the same views:
// the one-group result (L). And an independent fold computes each query over
// the committed state from scratch (Q). After each of N random commits
// (single-row writes, multi-row commits inside one group, slot moves, groups
// added and removed, and in the "failover" mix, a group's views rebuilt), M,
// L and Q are compared.
//
// Two merge flavours per operator:
//   - "data": the partial is exactly what data exposes today (the view's
//     rows or scalar value); the merger re-applies the operator over the union
//     of partial rows, or combines the scalars.
//   - "C" (contract): the partial a merge contract would add (an exact float
//     sum, a key tie-break, pruned counts, a key-chosen representative, the
//     sorted column), built here outside data from public data API (comparator
//     views, filters, sinks).
//
// usage: node --experimental-strip-types merge.ts --groups=1|4|16|elastic
//          --domain=int|float|dirty --mix=moves|failover
//          --move=atomic|fence-first|open-first --commits=100000 --seed=1

import {
  rng, SLOTS, slotOf, canon, ExactSum, makeRow, genPoints, genRoom, applyTruth,
  cmpTotal, rankable, r7, proj, type Row, type Domain, type Rec,
} from './lib.ts'

const DATA = process.env.DATA_DIR ?? '/home/user/pemrouz/data'
const D: any = await import(DATA + '/api/index.ts')
const { $, value: VALUE, node: NODE, lane, batch } = D

const arg = (name: string, def: string): string => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : def
}
const GROUPS = arg('groups', '4')
const DOMAIN = arg('domain', 'int') as Domain
const MIX = arg('mix', 'moves')
const MOVE = arg('move', 'atomic')
const COMMITS = Number(arg('commits', '100000'))
const SEED = Number(arg('seed', '1'))
const KEYS = Number(arg('keys', '3000'))
const ONLY = arg('ops', '') // comma list to restrict ops (debug)
const K = 10
const FULL_EVERY = 1000
const MEDIAN_EVERY = 100

const R = rng(SEED)
const strict = { onReject: (rj: any) => { throw new Error('lane reject: ' + String(rj.error?.message ?? rj.error)) } }

// ── stats ─────────────────────────────────────────────────────────────────────
type Stat = { n: number; bad: number; ex?: string }
const stats = new Map<string, Stat>()
let STEP = 0
let PHASE = 'commit'
function tally(name: string, ok: boolean, ex: () => string): void {
  if (PHASE === 'mid-move') name = 'mid-move: ' + name
  let s = stats.get(name)
  if (s === undefined) stats.set(name, (s = { n: 0, bad: 0 }))
  s.n++
  if (!ok) {
    s.bad++
    if (s.ex === undefined) s.ex = `step ${STEP} (${PHASE}): ${ex()}`.slice(0, 400)
  }
}
const short = (v: unknown): string => {
  const s = canon(v)
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

// ── the one-group source and the truth ────────────────────────────────────────
const Lsrc = $({})
const laneL = lane(Lsrc, strict)
const truth = new Map<string, Row>()
// an index of the truth by bucket (String(room)), kept beside it
const byRoom = new Map<string, Set<string>>()
function truthApply(r: Rec): void {
  const k = (r.type === 1 ? r.at : r.key[0]) as string
  const before = truth.get(k)
  if (before !== undefined) byRoom.get(String(before.room))!.delete(k)
  applyTruth(truth, r)
  const after = truth.get(k)
  if (after !== undefined) {
    const b = String(after.room)
    let s = byRoom.get(b)
    if (s === undefined) byRoom.set(b, (s = new Set()))
    s.add(k)
  }
}

// ── groups ──────────────────────────────────────────────────────────────────────
type Group = { gid: number; src: any; lane: (r: Rec[]) => unknown }
const groups = new Map<number, Group>()
const owner = new Int32Array(SLOTS)
let nextGid = 0

// ── mergers ───────────────────────────────────────────────────────────────────
// RowUnion: a merged data source fed by the partial views' row deltas. Each key
// is held from exactly one group (the slot-move rule "each slot from exactly one
// of them"): a remove from a group that no longer owns the key is ignored.
class RowUnion {
  ms = $({})
  laneM = lane(this.ms, strict)
  q: Rec[] = []
  ownerOf = new Map<string, number>()
  sinks = new Map<number, { dispose(): void }>()
  hook(gid: number, view: any): void {
    const h = view.sink({
      init: (snap: Map<string, Row>) => {
        const seen = new Set<string>()
        for (const [k, row] of snap) { seen.add(k); this.put(gid, k, row) }
        for (const [k, g] of this.ownerOf) if (g === gid && !seen.has(k)) this.drop(gid, k)
      },
      apply: (b: any) => {
        for (const d of b.rows) {
          if (d.op === 'remove') this.drop(gid, d.key)
          else this.put(gid, d.key, d.row)
        }
      },
    })
    this.sinks.set(gid, h)
  }
  put(gid: number, k: string, row: Row): void { this.ownerOf.set(k, gid); this.q.push({ type: 0, key: [k], value: row }) }
  drop(gid: number, k: string): void {
    if (this.ownerOf.get(k) !== gid) return
    this.ownerOf.delete(k)
    this.q.push({ type: 2, key: [k] })
  }
  unhook(gid: number, dropRows: boolean): void {
    this.sinks.get(gid)?.dispose()
    this.sinks.delete(gid)
    if (dropRows) for (const [k, g] of this.ownerOf) if (g === gid) this.drop(gid, k)
  }
  drain(): void {
    if (this.q.length === 0) return
    const r = this.q
    this.q = []
    this.laneM(r)
  }
}

// BucketMerge: per bucket, per group, the group's partial bucket value. Group
// buckets merge by union of members; count buckets by sum. The merged result is
// kept in a plain Map (a data source would add nothing to the check).
class BucketMerge {
  parts = new Map<string, Map<number, any>>()
  arrival = new Map<string, Map<number, number>>()
  seq = 0
  touched = new Set<string>()
  sinks = new Map<number, { dispose(): void }>()
  merged = new Map<string, any>()
  combine: (vals: { gid: number; v: any; at: number }[]) => any
  dropEmpty: boolean
  constructor(combine: (vals: { gid: number; v: any; at: number }[]) => any, dropEmpty: boolean) { this.combine = combine; this.dropEmpty = dropEmpty }
  hook(gid: number, view: any): void {
    const h = view.sink({
      init: (snap: Map<string, any>) => {
        const seen = new Set<string>()
        for (const [b, v] of snap) { seen.add(b); this.set(gid, b, v) }
        for (const [b, m] of this.parts) if (m.has(gid) && !seen.has(b)) this.del(gid, b)
      },
      apply: (bt: any) => {
        for (const d of bt.rows) {
          if (d.op === 'remove') this.del(gid, d.key)
          else this.set(gid, d.key, d.row)
        }
      },
    })
    this.sinks.set(gid, h)
  }
  set(gid: number, b: string, v: any): void {
    let m = this.parts.get(b)
    if (m === undefined) this.parts.set(b, (m = new Map()))
    let a = this.arrival.get(b)
    if (a === undefined) this.arrival.set(b, (a = new Map()))
    if (!m.has(gid)) a.set(gid, this.seq++)
    m.set(gid, v)
    this.touched.add(b)
  }
  del(gid: number, b: string): void {
    const m = this.parts.get(b)
    if (m === undefined || !m.has(gid)) return
    m.delete(gid)
    this.arrival.get(b)!.delete(gid)
    this.touched.add(b)
  }
  unhook(gid: number): void {
    this.sinks.get(gid)?.dispose()
    this.sinks.delete(gid)
    for (const [b, m] of this.parts) if (m.has(gid)) this.del(gid, b)
  }
  drain(): void {
    for (const b of this.touched) {
      const m = this.parts.get(b)!
      if (m.size === 0) { this.parts.delete(b); this.arrival.delete(b); this.merged.delete(b); continue }
      const a = this.arrival.get(b)!
      const v = this.combine([...m].map(([gid, v]) => ({ gid, v, at: a.get(gid)! })))
      if (this.dropEmpty && v === undefined) this.merged.delete(b)
      else this.merged.set(b, v)
    }
    this.touched.clear()
  }
}

// data's own bucket key order (JS enumeration order), so a merged bucket's
// member object is built in the order data builds its own.
const IDX = /^(0|[1-9][0-9]*)$/
const cmpKeys = (a: string, b: string): number => {
  const ia = IDX.test(a), ib = IDX.test(b)
  if (ia && ib) return Number(a) - Number(b)
  if (ia) return -1
  if (ib) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

// ── a contract partial outside data: a sink on the group's source ────────────────
// fn(add/remove of one row) maintains a fero-side structure; this is the shape a
// data operator with a merge contract would take.
function rowSink(src: any, on: (prev: Row | undefined, row: Row | undefined) => void): { dispose(): void } {
  return src.sink({
    init: (snap: Map<string, Row>) => { for (const row of snap.values()) on(undefined, row) },
    apply: (b: any) => {
      for (const d of b.rows) on(d.op === 'add' ? undefined : d.prev, d.op === 'remove' ? undefined : d.row)
    },
  })
}

// ── the pure queries, computed once per check from the truth ─────────────────────
type QV = {
  sum: number; len: number; tracked: number; avg: number | undefined
  max: unknown; min: unknown; some: boolean; every: boolean
  top: Row[]
}
let qCache: QV | null = null
let qSorted: number[] | null = null
const SOME = (r: Row) => (r.points as any) >= 99
const EVERY = (r: Row) => (r.points as any) >= 1
const PRED = (r: Row) => (r.points as any) >= 50
const ROOM = (r: Row) => r.room
function Q(): QV {
  if (qCache !== null) return qCache
  const es = new ExactSum()
  let max: number | undefined, min: number | undefined
  let some = false, every = true
  const top: Row[] = []
  for (const row of truth.values()) {
    const x = proj(row, 'points')
    if (x !== undefined) es.add(+(x as any))
    if (rankable(x)) {
      if (max === undefined || x > max) max = x
      if (min === undefined || x < min) min = x
    }
    if (SOME(row)) some = true
    if (!EVERY(row)) every = false
    if (top.length < K || cmpTotal(row, top[top.length - 1]) < 0) {
      let lo = 0, hi = top.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpTotal(top[mid], row) < 0) lo = mid + 1; else hi = mid }
      top.splice(lo, 0, row)
      if (top.length > K) top.pop()
    }
  }
  const sum = es.value()
  return (qCache = { sum, len: truth.size, tracked: es.n, avg: es.n === 0 ? undefined : sum / es.n, max, min, some, every, top })
}
function qSortedVals(): number[] {
  if (qSorted !== null) return qSorted
  const v: number[] = []
  for (const row of truth.values()) if (rankable(row.points)) v.push(row.points)
  return (qSorted = v.sort((a, b) => a - b))
}
type QB = { group: Map<string, Record<string, Row>>; counts: Map<string, number>; rep: Map<string, { k: string; v: unknown }> }
let qbCache: QB | null = null
function qBuckets(): QB {
  if (qbCache !== null) return qbCache
  const group = new Map<string, Record<string, Row>>()
  const counts = new Map<string, number>()
  const rep = new Map<string, { k: string; v: unknown }>()
  for (const [k, row] of truth) {
    const b = String(ROOM(row))
    let g = group.get(b)
    if (g === undefined) group.set(b, (g = {}))
    g[k] = row
    counts.set(b, (counts.get(b) ?? 0) + 1)
    const r = rep.get(b)
    if (r === undefined || k < r.k) rep.set(b, { k, v: ROOM(row) })
  }
  return (qbCache = { group, counts, rep })
}

// ── the operators ─────────────────────────────────────────────────────────────
type Ctx = { full: boolean; median: boolean; keys: Set<string>; buckets: Set<string> }
interface Op {
  name: string
  attach(g: Group): void
  detach(g: Group): void
  rebuild(g: Group): void
  drain(): void
  check(c: Ctx): void
}

// Per-group data views, disposed and rebuilt as a group comes, goes or fails over.
class Views {
  v = new Map<number, any>()
  build: (src: any) => any
  constructor(build: (src: any) => any) { this.build = build }
  make(g: Group): any { const x = this.build(g.src); this.v.set(g.gid, x); return x }
  drop(g: Group): void { this.v.get(g.gid)?.dispose(); this.v.delete(g.gid) }
}
const rowsOf = (h: any): Map<string, Row> => {
  const m = new Map<string, Row>()
  h[NODE].each((k: string, r: Row) => m.set(k, r))
  return m
}
const keysOf = (h: any): string[] => {
  const ks: string[] = []
  h[NODE].each((k: string) => ks.push(k))
  return ks
}

// filter: partial = the group's filtered rows; merge = disjoint union.
class FilterOp implements Op {
  name = 'filter'
  L = Lsrc.filter(PRED)
  views = new Views((s) => s.filter(PRED))
  m = new RowUnion()
  attach(g: Group) { this.m.hook(g.gid, this.views.make(g)) }
  detach(g: Group) { this.m.unhook(g.gid, true); this.views.drop(g) }
  rebuild(g: Group) { this.m.unhook(g.gid, false); this.views.drop(g); this.attach(g) }
  drain() { this.m.drain() }
  check(c: Ctx) {
    const M = this.m.ms[NODE], L = this.L[NODE]
    tally('filter M=L count', M.rowCount() === L.rowCount(), () => `${M.rowCount()} vs ${L.rowCount()}`)
    const ks = c.full ? truth.keys() : c.keys
    for (const k of ks) {
      const t = truth.get(k)
      const q = t !== undefined && PRED(t) ? canon(t) : 'absent'
      const m = M.hasRow(k) ? canon(M.rowAt(k)) : 'absent'
      const l = L.hasRow(k) ? canon(L.rowAt(k)) : 'absent'
      tally('filter M=L', m === l, () => `${k}: ${m} vs ${l}`)
      tally('filter M=Q', m === q, () => `${k}: ${m} vs ${q}`)
      tally('filter L=Q', l === q, () => `${k}: ${l} vs ${q}`)
    }
  }
}

// ordered windows: top-k as data writes it (za('points', K)), top-k with the
// contract's total order (az(cmpTotal, K): ties by key), limit(K) (arrival order).
class OrderedOp implements Op {
  L: any
  views: Views
  m: RowUnion
  out: any
  name: string
  qKeys: (() => string[]) | null
  constructor(name: string, build: (s: any) => any, qKeys: (() => string[]) | null) {
    this.name = name
    this.qKeys = qKeys
    this.L = build(Lsrc)
    this.views = new Views(build)
    this.m = new RowUnion()
    this.out = build(this.m.ms)
  }
  attach(g: Group) { this.m.hook(g.gid, this.views.make(g)) }
  detach(g: Group) { this.m.unhook(g.gid, true); this.views.drop(g) }
  rebuild(g: Group) { this.m.unhook(g.gid, false); this.views.drop(g); this.attach(g) }
  drain() { this.m.drain() }
  check(_c: Ctx) {
    const mk = keysOf(this.out), lk = keysOf(this.L)
    const score = (ks: string[]) => canon(ks.map((k) => truth.get(k)?.points))
    const set = (ks: string[]) => canon([...ks].sort())
    tally(`${this.name} M=L order`, canon(mk) === canon(lk), () => `${canon(mk)} vs ${canon(lk)}`)
    tally(`${this.name} M=L set`, set(mk) === set(lk), () => `${set(mk)} vs ${set(lk)}`)
    tally(`${this.name} M=L scores`, score(mk) === score(lk), () => `${score(mk)} vs ${score(lk)}`)
    if (this.qKeys === null) return
    const qk = this.qKeys()
    tally(`${this.name} M=Q order`, canon(mk) === canon(qk), () => `${canon(mk)} vs ${canon(qk)}`)
    tally(`${this.name} L=Q order`, canon(lk) === canon(qk), () => `${canon(lk)} vs ${canon(qk)}`)
    tally(`${this.name} L=Q set`, set(lk) === set(qk), () => `${set(lk)} vs ${set(qk)}`)
    tally(`${this.name} L=Q scores`, score(lk) === score(qk), () => `${score(lk)} vs ${score(qk)}`)
  }
}

// scalars as data writes them: the merger reads each group's scalar and combines.
class ScalarOp implements Op {
  L: any
  views: Views
  M: unknown = undefined
  name: string
  combine: (vals: unknown[], gids: number[]) => unknown
  q: (() => unknown) | null
  every: 'commit' | 'median'
  constructor(
    name: string,
    build: (s: any) => any,
    combine: (vals: unknown[], gids: number[]) => unknown,
    q: (() => unknown) | null,
    every: 'commit' | 'median' = 'commit',
  ) {
    this.name = name
    this.combine = combine
    this.q = q
    this.every = every
    this.L = build(Lsrc)
    this.views = new Views(build)
  }
  attach(g: Group) { this.views.make(g) }
  detach(g: Group) { this.views.drop(g) }
  rebuild(g: Group) { this.views.drop(g); this.views.make(g) }
  drain() {
    const gids = [...this.views.v.keys()].sort((a, b) => a - b)
    this.M = this.combine(gids.map((g) => this.views.v.get(g)[VALUE]), gids)
  }
  check(c: Ctx) {
    if (this.every === 'median' && !c.median) return
    const m = canon(this.M), l = canon(this.L[VALUE])
    tally(`${this.name} M=L`, m === l, () => `${m} vs ${l}`)
    if (this.q === null) return
    const q = canon(this.q())
    tally(`${this.name} M=Q`, m === q, () => `${m} vs ${q}`)
    tally(`${this.name} L=Q`, l === q, () => `${l} vs ${q}`)
  }
}

// scalars under the contract: a fero-side partial per group (ExactSum etc.).
class PartialOp<P> implements Op {
  parts = new Map<number, { p: P; h: { dispose(): void } }>()
  M: unknown = undefined
  name: string
  fresh: () => P
  on: (p: P, prev: Row | undefined, row: Row | undefined) => void
  merge: (ps: P[]) => unknown
  q: () => unknown
  lView: any | null
  every: 'commit' | 'median'
  constructor(
    name: string,
    fresh: () => P,
    on: (p: P, prev: Row | undefined, row: Row | undefined) => void,
    merge: (ps: P[]) => unknown,
    q: () => unknown,
    lView: any | null,
    every: 'commit' | 'median' = 'commit',
  ) {
    this.name = name; this.fresh = fresh; this.on = on; this.merge = merge; this.q = q; this.lView = lView; this.every = every
  }
  attach(g: Group) {
    const p = this.fresh()
    const h = rowSink(g.src, (prev, row) => this.on(p, prev, row))
    this.parts.set(g.gid, { p, h })
  }
  detach(g: Group) { this.parts.get(g.gid)?.h.dispose(); this.parts.delete(g.gid) }
  rebuild(g: Group) { this.detach(g); this.attach(g) }
  drain() {} // the merge is a pure function of the partials at the cut: done at check time
  check(c: Ctx) {
    if (this.every === 'median' && !c.median) return
    const gids = [...this.parts.keys()].sort((a, b) => a - b)
    this.M = this.merge(gids.map((g) => this.parts.get(g)!.p))
    const m = canon(this.M), q = canon(this.q())
    tally(`${this.name} M=Q`, m === q, () => `${m} vs ${q}`)
    if (this.lView !== null) {
      const l = canon(this.lView[VALUE])
      tally(`${this.name} M=L`, m === l, () => `${m} vs ${l}`)
    }
  }
}

// buckets: group (member union), lengthBuckets (count sum), distinct (representative).
class BucketOp implements Op {
  L: any
  views: Views
  m: BucketMerge
  name: string
  q: ((b: string) => unknown) | null
  qKeys: (() => Iterable<string>) | null
  cadence: 'touched' | 'median'
  constructor(
    name: string,
    build: (s: any) => any,
    combine: (vals: { gid: number; v: any; at: number }[]) => any,
    q: ((b: string) => unknown) | null,
    qKeys: (() => Iterable<string>) | null,
    cadence: 'touched' | 'median',
  ) {
    this.name = name; this.q = q; this.qKeys = qKeys; this.cadence = cadence
    this.L = build(Lsrc)
    this.views = new Views(build)
    this.m = new BucketMerge(combine, false)
  }
  attach(g: Group) { this.m.hook(g.gid, this.views.make(g)) }
  detach(g: Group) { this.m.unhook(g.gid); this.views.drop(g) }
  rebuild(g: Group) { this.m.sinks.get(g.gid)?.dispose(); this.m.sinks.delete(g.gid); this.views.drop(g); this.attach(g) }
  drain() { this.m.drain() }
  check(c: Ctx) {
    if (this.cadence === 'median' && !c.median && !c.full) return
    const Lsnap: Map<string, unknown> = this.L[NODE].snapshot()
    const all = this.cadence === 'median' || c.full
    const bs = all ? new Set([...Lsnap.keys(), ...this.m.merged.keys(), ...(this.qKeys ? this.qKeys() : [])]) : c.buckets
    tally(`${this.name} M=L buckets`, this.m.merged.size === Lsnap.size, () => `${this.m.merged.size} vs ${Lsnap.size}`)
    for (const b of bs) {
      const m = this.m.merged.has(b) ? canon(this.m.merged.get(b)) : 'absent'
      const l = Lsnap.has(b) ? canon(Lsnap.get(b)) : 'absent'
      tally(`${this.name} M=L`, m === l, () => `${b}: ${m} vs ${l}`)
      if (this.q === null) continue
      const qv = this.q(b)
      const q = qv === undefined ? 'absent' : canon(qv)
      tally(`${this.name} M=Q`, m === q, () => `${b}: ${m} vs ${q}`)
      tally(`${this.name} L=Q`, l === q, () => `${b}: ${l} vs ${q}`)
    }
  }
}

// contract buckets: a fero-side partial per group (pruned counts; min-key representative).
class BucketPartialOp implements Op {
  parts = new Map<number, { p: Map<string, Map<string, unknown>>; h: { dispose(): void } }>()
  name: string
  view: (holders: Map<string, unknown>[]) => unknown
  q: (b: string) => unknown
  constructor(name: string, view: (holders: Map<string, unknown>[]) => unknown, q: (b: string) => unknown) { this.name = name; this.view = view; this.q = q }
  attach(g: Group) {
    const p = new Map<string, Map<string, unknown>>() // bucket → row key → projected value
    const h = rowSink(g.src, (prev, row) => {
      if (prev !== undefined) {
        const b = String(ROOM(prev)); const m = p.get(b)!
        m.delete(prev.id); if (m.size === 0) p.delete(b)
      }
      if (row !== undefined) {
        const b = String(ROOM(row)); let m = p.get(b)
        if (m === undefined) p.set(b, (m = new Map()))
        m.set(row.id, ROOM(row))
      }
    })
    this.parts.set(g.gid, { p, h })
  }
  detach(g: Group) { this.parts.get(g.gid)?.h.dispose(); this.parts.delete(g.gid) }
  rebuild(g: Group) { this.detach(g); this.attach(g) }
  drain() {}
  check(c: Ctx) {
    const qb = c.full || c.median ? qBuckets() : null
    const bs = qb !== null ? new Set([...qb.counts.keys(), ...this.allBuckets()]) : c.buckets
    for (const b of bs) {
      const hs: Map<string, unknown>[] = []
      for (const { p } of this.parts.values()) { const m = p.get(b); if (m !== undefined) hs.push(m) }
      const mv = hs.length === 0 ? undefined : this.view(hs)
      const m = mv === undefined ? 'absent' : canon(mv)
      const qv = this.q(b)
      const q = qv === undefined ? 'absent' : canon(qv)
      tally(`${this.name} M=Q`, m === q, () => `${b}: ${m} vs ${q}`)
    }
  }
  allBuckets(): Set<string> {
    const s = new Set<string>()
    for (const { p } of this.parts.values()) for (const b of p.keys()) s.add(b)
    return s
  }
}

// per-bucket truth lookups for the touched-bucket checks (cheap, O(bucket))
function qRep(b: string): unknown {
  const set = byRoom.get(b)
  if (set === undefined || set.size === 0) return undefined
  let best: string | undefined
  for (const k of set) if (best === undefined || k < best) best = k
  return ROOM(truth.get(best!)!)
}
function qGroupBucket(b: string): Record<string, Row> | undefined {
  const set = byRoom.get(b)
  if (set === undefined || set.size === 0) return undefined
  const keys = [...set]
  keys.sort(cmpKeys)
  const o: Record<string, Row> = {}
  for (const k of keys) o[k] = truth.get(k)!
  return o
}

// ── build the operator set ────────────────────────────────────────────────────
const sumPlain = (vals: unknown[]) => { let t = 0; for (const v of vals) t += v as number; return t }
const ops: Op[] = [
  new FilterOp(),
  new OrderedOp('topk', (s) => s.za('points', K), () => Q().top.map((r) => r.id)),
  new OrderedOp('topkC', (s) => s.az(cmpTotal, K), () => Q().top.map((r) => r.id)),
  new OrderedOp('limit', (s) => s.limit(K), null),
  new ScalarOp('sum', (s) => s.sum('points'), sumPlain, () => Q().sum),
  new ScalarOp('length', (s) => s.length(), sumPlain, () => Q().len),
  new ScalarOp('avg', (s) => s.avg('points'), (() => {
    // the best a merger can do with what data exposes: weight each group's avg by its row count
    return (vals: unknown[], gids: number[]) => {
      let t = 0, n = 0
      gids.forEach((g, i) => {
        const len = (lenViews.v.get(g) as any)[VALUE] as number
        if (vals[i] !== undefined) { t += (vals[i] as number) * len; n += len }
      })
      return n === 0 ? undefined : t / n
    }
  })(), () => Q().avg),
  new ScalarOp('max', (s) => s.max('points'), (vals) => {
    let m: any
    for (const v of vals) if (v !== undefined && (m === undefined || (v as any) > m)) m = v
    return m
  }, () => Q().max),
  new ScalarOp('min', (s) => s.min('points'), (vals) => {
    let m: any
    for (const v of vals) if (v !== undefined && (m === undefined || (v as any) < m)) m = v
    return m
  }, () => Q().min),
  new ScalarOp('some', (s) => s.some(SOME), (vals) => vals.some(Boolean), () => Q().some),
  new ScalarOp('every', (s) => s.every(EVERY), (vals) => vals.every(Boolean), () => Q().every),
  new ScalarOp('median', (s) => s.median('points'), (vals) => {
    // median of the group medians: what a merger can do with what data exposes
    const v = (vals.filter((x) => x !== undefined) as number[]).sort((a, b) => a - b)
    return r7(v, 0.5)
  }, () => r7(qSortedVals(), 0.5), 'median'),
  // ── contract partials ──
  new PartialOp<ExactSum>('sumC', () => new ExactSum(), (p, prev, row) => {
    const o = proj(prev, 'points'), n = proj(row, 'points')
    if (o !== undefined) p.sub(+(o as any))
    if (n !== undefined) p.add(+(n as any))
  }, (ps) => { const t = new ExactSum(); for (const p of ps) t.mergeFrom(p); return t.value() }, () => Q().sum, null),
  new PartialOp<ExactSum>('avgC', () => new ExactSum(), (p, prev, row) => {
    const o = proj(prev, 'points'), n = proj(row, 'points')
    if (o !== undefined) p.sub(+(o as any))
    if (n !== undefined) p.add(+(n as any))
  }, (ps) => { const t = new ExactSum(); for (const p of ps) t.mergeFrom(p); return t.n === 0 ? undefined : t.value() / t.n }, () => Q().avg, null),
  new PartialOp<{ v: number[] }>('medianC', () => ({ v: [] }), (p, prev, row) => {
    // the partial is the group's whole sorted numeric column
    const lb = (x: number) => { let lo = 0, hi = p.v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (p.v[m] < x) lo = m + 1; else hi = m } return lo }
    if (prev !== undefined && rankable(prev.points)) p.v.splice(lb(prev.points), 1)
    if (row !== undefined && rankable(row.points)) p.v.splice(lb(row.points), 0, row.points)
  }, (ps) => {
    const all: number[] = []
    for (const p of ps) for (const x of p.v) all.push(x)
    return r7(all.sort((a, b) => a - b), 0.5)
  }, () => r7(qSortedVals(), 0.5), null, 'median'),
  new ScalarOp('maxC', (s) => s.filter((r: Row) => rankable(r.points)).max('points'), (vals) => {
    let m: number | undefined
    for (const v of vals) if (v !== undefined && (m === undefined || (v as number) > m)) m = v as number
    return m
  }, () => Q().max),
  // ── buckets ──
  new BucketOp('group', (s) => s.group(ROOM), (vals) => {
    const ks: string[] = []
    const all: Record<string, Row> = {}
    for (const { v } of vals) for (const k of Object.keys(v)) { ks.push(k); all[k] = v[k] }
    ks.sort(cmpKeys)
    const o: Record<string, Row> = {}
    for (const k of ks) o[k] = all[k]
    return o
  }, qGroupBucket, null, 'touched'),
  new BucketOp('countBy', (s) => s.length(ROOM), (vals) => {
    let n = 0
    for (const { v } of vals) n += v.value
    return { value: n }
  }, (b) => { const g = qGroupBucket(b); return g === undefined ? undefined : { value: Object.keys(g).length } }, null, 'touched'),
  new BucketOp('distinct', (s) => s.distinct(ROOM), (vals) => {
    // data's own rule, at the merger: the representative that arrived first
    let best = vals[0]
    for (const x of vals) if (x.at < best.at) best = x
    return best.v
  }, qRep, () => qBuckets().rep.keys(), 'median'),
  new BucketPartialOp('countByC', (hs) => {
    let n = 0
    for (const h of hs) n += h.size
    return { value: n }
  }, (b) => { const g = qGroupBucket(b); return g === undefined ? undefined : { value: Object.keys(g).length } }),
  new BucketPartialOp('distinctC', (hs) => {
    let bk: string | undefined, bv: unknown
    for (const h of hs) for (const [k, v] of h) if (bk === undefined || k < bk) { bk = k; bv = v }
    return bv
  }, qRep),
]
// the length views avg's data-as-is merge needs (one more partial per group)
const lenViews = new Views((s) => s.length())
const lenOp: Op = {
  name: 'len-for-avg',
  attach: (g) => { lenViews.make(g) }, detach: (g) => lenViews.drop(g),
  rebuild: (g) => { lenViews.drop(g); lenViews.make(g) }, drain: () => {}, check: () => {},
}
const ACTIVE: Op[] = [lenOp, ...ops.filter((o) => ONLY === '' || ONLY.split(',').includes(o.name))]

// ── group lifecycle, slot moves, failover ─────────────────────────────────────
function newGroup(): Group {
  const src = $({})
  const g: Group = { gid: nextGid++, src, lane: lane(src, strict) }
  groups.set(g.gid, g)
  for (const o of ACTIVE) o.attach(g)
  return g
}
function deleteGroup(g: Group): void {
  for (const o of ACTIVE) o.detach(g)
  groups.delete(g.gid)
}
const drainAll = () => { for (const o of ACTIVE) o.drain() }

let moves = 0, movedRows = 0, grows = 0, shrinks = 0, rebuilds = 0
function slotsOf(g: Group): number[] {
  const s: number[] = []
  for (let i = 0; i < SLOTS; i++) if (owner[i] === g.gid) s.push(i)
  return s
}
// Move a set of slots A → B. The rows leave A's fold and enter B's.
// atomic: both in one data commit, one merger cut (the design's "views mid-move"
//   rule: a slot is taken from exactly one group at every cut).
// fence-first / open-first: two cuts, A's fence then B's open, or the other way,
//   with a check between (what a merger that does not pair them would show).
function moveSlots(A: Group, B: Group, slots: number[], check: (phase: string) => void): void {
  const set = new Set(slots)
  const rm: Rec[] = [], ins: Rec[] = []
  for (const [k, row] of truth) if (set.has(slotOf(k))) { rm.push({ type: 2, key: [k] }); ins.push({ type: 1, key: [], at: k, value: row }) }
  for (const s of slots) owner[s] = B.gid
  moves++
  movedRows += rm.length
  const keys = new Set(rm.map((r) => r.key[0] as string))
  touchedMove = keys
  if (MOVE === 'atomic') {
    batch(() => { if (rm.length) A.lane(rm); if (ins.length) B.lane(ins) })
    drainAll()
    check('move')
  } else {
    const first = MOVE === 'fence-first' ? () => rm.length && A.lane(rm) : () => ins.length && B.lane(ins)
    const second = MOVE === 'fence-first' ? () => ins.length && B.lane(ins) : () => rm.length && A.lane(rm)
    first(); drainAll(); check('mid-move')
    second(); drainAll(); check('move')
  }
}
let touchedMove: Set<string> | null = null

// ── the commit generator ──────────────────────────────────────────────────────
const live: string[] = []
const liveIdx = new Map<string, number>()
const addLive = (k: string) => { if (!liveIdx.has(k)) { liveIdx.set(k, live.length); live.push(k) } }
const delLive = (k: string) => {
  const i = liveIdx.get(k)
  if (i === undefined) return
  const last = live.pop()!
  if (last !== k) { live[i] = last; liveIdx.set(last, i) }
  liveIdx.delete(k)
}
const pool = (i: number) => 'p' + i

function opFor(k: string): Rec {
  const exists = truth.has(k)
  const u = R()
  if (!exists || u < 0.2) {
    const row = makeRow(k, DOMAIN, R)
    return exists ? { type: 0, key: [k], value: row } : { type: 1, key: [], at: k, value: row }
  }
  if (u < 0.65) {
    const p = genPoints(DOMAIN, R)
    if (p === undefined) return { type: 2, key: [k, 'points'] }
    return { type: 0, key: [k, 'points'], value: p }
  }
  if (u < 0.78) return { type: 0, key: [k, 'room'], value: genRoom(DOMAIN, R) }
  return { type: 2, key: [k] }
}

function nextCommit(): Rec[] {
  const u = R()
  if (u < 0.05) {
    // a multi-row commit: several rows of one group, one log entry (one lane call)
    const gs = [...groups.values()]
    const g = gs[Math.floor(R() * gs.length)]
    const want = 3 + Math.floor(R() * 6)
    const ks = new Set<string>()
    for (let tries = 0; tries < 400 && ks.size < want; tries++) {
      const k = pool(Math.floor(R() * KEYS))
      if (owner[slotOf(k)] === g.gid) ks.add(k)
    }
    if (ks.size > 0) return [...ks].map(opFor)
  }
  // single row: favour live rows for updates so the resource stays busy
  const k = live.length > 0 && R() < 0.6 ? live[Math.floor(R() * live.length)] : pool(Math.floor(R() * KEYS))
  return [opFor(k)]
}

// ── run ───────────────────────────────────────────────────────────────────────
const elastic = GROUPS === 'elastic'
const G0 = elastic ? 1 : Number(GROUPS)
for (let i = 0; i < G0; i++) newGroup()
for (let s = 0; s < SLOTS; s++) owner[s] = Math.floor((s * G0) / SLOTS)

const t0 = performance.now()
const keysTouched = new Set<string>()
const bucketsTouched = new Set<string>()
function checkAll(phase: string, full: boolean, median: boolean): void {
  PHASE = phase
  qCache = null
  qSorted = null
  qbCache = null
  if (touchedMove !== null) for (const k of touchedMove) keysTouched.add(k)
  for (const k of keysTouched) {
    const r = truth.get(k)
    if (r !== undefined) bucketsTouched.add(String(ROOM(r)))
  }
  const c: Ctx = { full, median, keys: keysTouched, buckets: bucketsTouched }
  for (const o of ACTIVE) o.check(c)
}
const MOVE_P = 1 / 250
const REBUILD_P = MIX === 'failover' ? 1 / 1000 : 0
let maxGroups = groups.size
for (STEP = 1; STEP <= COMMITS; STEP++) {
  keysTouched.clear()
  bucketsTouched.clear()
  touchedMove = null
  // an event instead of a commit, now and then
  if (groups.size > 1 || elastic) {
    if (R() < MOVE_P) {
      const evCheck = (phase: string) => checkAll(phase, true, true)
      const gs = [...groups.values()]
      if (elastic && R() < 0.5 && groups.size < 16) {
        const A = gs.filter((g) => slotsOf(g).length >= 2).sort(() => R() - 0.5)[0]
        if (A !== undefined) {
          const s = slotsOf(A).filter(() => R() < 0.5)
          const B = newGroup()
          grows++
          maxGroups = Math.max(maxGroups, groups.size)
          moveSlots(A, B, s, evCheck)
        }
      } else if (elastic && groups.size > 1) {
        const X = gs[Math.floor(R() * gs.length)]
        const others = gs.filter((g) => g !== X)
        const Y = others[Math.floor(R() * others.length)]
        moveSlots(X, Y, slotsOf(X), evCheck)
        deleteGroup(X)
        shrinks++
        drainAll()
        checkAll('shrink', true, true)
      } else if (!elastic) {
        const A = gs.filter((g) => slotsOf(g).length > 0)[Math.floor(R() * gs.filter((g) => slotsOf(g).length > 0).length)]
        const others = gs.filter((g) => g !== A)
        const B = others[Math.floor(R() * others.length)]
        const mine = slotsOf(A).sort(() => R() - 0.5)
        const m = [1, 8, 64, 256][Math.floor(R() * 4)]
        moveSlots(A, B, mine.slice(0, Math.max(1, Math.min(m, mine.length))), evCheck)
      }
      continue
    }
  }
  if (REBUILD_P > 0 && R() < REBUILD_P) {
    const gs = [...groups.values()]
    const g = gs[Math.floor(R() * gs.length)]
    for (const o of ACTIVE) o.rebuild(g)
    rebuilds++
    drainAll()
    checkAll('failover', true, true)
    continue
  }
  const recs = nextCommit()
  for (const r of recs) {
    const k = (r.type === 1 ? r.at : r.key[0]) as string
    keysTouched.add(k)
    const before = truth.get(k)
    if (before !== undefined) bucketsTouched.add(String(ROOM(before)))
  }
  const k0 = (recs[0].type === 1 ? recs[0].at : recs[0].key[0]) as string
  const g = groups.get(owner[slotOf(k0)])!
  laneL(recs)
  g.lane(recs)
  for (const r of recs) {
    truthApply(r)
    const k = (r.type === 1 ? r.at : r.key[0]) as string
    if (truth.has(k)) addLive(k); else delLive(k)
  }
  drainAll()
  checkAll('commit', STEP % FULL_EVERY === 0, STEP % MEDIAN_EVERY === 0)
}
checkAll('end', true, true)
const ms = performance.now() - t0

// ── report ────────────────────────────────────────────────────────────────────
const head = `E-23 merge  groups=${GROUPS} domain=${DOMAIN} mix=${MIX} move=${MOVE} commits=${COMMITS} seed=${SEED} keys=${KEYS}`
console.log(head)
console.log(`  rows at end ${truth.size}; groups at end ${groups.size} (max ${maxGroups}); moves ${moves} (${movedRows} rows moved); grows ${grows}; shrinks ${shrinks}; view rebuilds ${rebuilds}; ${(ms / 1000).toFixed(1)} s`)
const names = [...stats.keys()].sort()
for (const n of names) {
  const s = stats.get(n)!
  console.log(`  ${s.bad === 0 ? 'ok  ' : 'DIFF'} ${n.padEnd(26)} ${String(s.bad).padStart(7)} / ${String(s.n).padStart(8)}${s.ex ? '   first: ' + s.ex : ''}`)
}
