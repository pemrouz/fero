// E-23 run E: a merger that receives the groups' partials late and interleaved.
//
// In a real cluster the merger hears from each group over its own link, at its
// own pace. So its picture is a cut: each group at some committed position.
// This run checks that the merged view equals the query over exactly the rows
// of that cut, at every delivery.
//
// Each group's commit produces a "delivery": the partial changes its views
// emitted (rows in and out of filter, top-k windows and group buckets; the new
// scalar sum; the exact-sum value deltas) plus the commit's records. Deliveries
// queue per group, in the group's own order. The merger takes them from random
// groups, 0 to 3 per step, so it runs behind and interleaves groups in an
// order no other process shares. A slot move is one delivery placed in both
// groups' queues (the pairing rule: the merger applies A's fence and B's open
// at one cut); it can be taken only when it heads both queues. After each
// delivery the merged views are compared with the query over the union of the
// rows each group had at its delivered position (the "cut truth").
//
// usage: node --experimental-strip-types async.ts --groups=16 --domain=int --commits=100000 --seed=1

import { rng, SLOTS, slotOf, canon, ExactSum, makeRow, genPoints, genRoom, applyTruth, cmpTotal, proj, type Row, type Domain, type Rec } from './lib.ts'

const DATA = process.env.DATA_DIR ?? '/home/user/pemrouz/data'
const D: any = await import(DATA + '/api/index.ts')
const { $, value: VALUE, node: NODE, lane, batch } = D

const arg = (name: string, def: string): string => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : def
}
const G = Number(arg('groups', '16'))
const DOMAIN = arg('domain', 'int') as Domain
const COMMITS = Number(arg('commits', '100000'))
const SEED = Number(arg('seed', '1'))
const KEYS = 3000
const K = 10
const R = rng(SEED)
const R2 = rng(SEED * 31 + 7) // the merger's delivery order
const strict = { onReject: (rj: any) => { throw new Error('lane reject: ' + String(rj.error?.message ?? rj.error)) } }
const PRED = (r: Row) => (r.points as any) >= 50
const ROOM = (r: Row) => r.room
const keyOf = (r: Rec) => (r.type === 1 ? r.at : r.key[0]) as string

// ── one delivery: what a group's partials emitted for one of its commits ──────
type RowD = { view: 'filter' | 'topk' | 'topkC'; op: 'put' | 'drop'; k: string; row?: Row }
type BucketD = { op: 'set' | 'del'; b: string; v?: Record<string, Row> }
type Delivery = {
  id: number
  parts: Map<number, { recs: Rec[]; rows: RowD[]; buckets: BucketD[]; sum: number; exact: [number | undefined, number | undefined][] }>
  pending: number // queues it still heads-or-waits in
}

type Group = { gid: number; src: any; lane: (r: Rec[]) => unknown; sum: any; cur: Delivery['parts'] extends Map<number, infer P> ? P | null : never; truth: Map<string, Row> }
const groups: Group[] = []
const queues: Delivery[][] = []
const owner = new Int32Array(SLOTS)
for (let s = 0; s < SLOTS; s++) owner[s] = Math.floor((s * G) / SLOTS)

for (let gid = 0; gid < G; gid++) {
  const src = $({})
  const g: Group = { gid, src, lane: lane(src, strict), sum: src.sum('points'), cur: null, truth: new Map() }
  const rowsSink = (view: RowD['view'], h: any) => h.sink({
    apply: (b: any) => { for (const d of b.rows) g.cur!.rows.push(d.op === 'remove' ? { view, op: 'drop', k: d.key } : { view, op: 'put', k: d.key, row: d.row }) },
  })
  rowsSink('filter', src.filter(PRED))
  rowsSink('topk', src.za('points', K))
  rowsSink('topkC', src.az(cmpTotal, K))
  src.group(ROOM).sink({
    apply: (b: any) => { for (const d of b.rows) g.cur!.buckets.push(d.op === 'remove' ? { op: 'del', b: d.key } : { op: 'set', b: d.key, v: d.row }) },
  })
  src.sink({
    apply: (b: any) => {
      for (const d of b.rows) {
        const o = d.op === 'add' ? undefined : proj(d.prev, 'points')
        const n = d.op === 'remove' ? undefined : proj(d.row, 'points')
        if (o !== n) g.cur!.exact.push([o === undefined ? undefined : +(o as any), n === undefined ? undefined : +(n as any)])
      }
    },
  })
  groups.push(g)
  queues.push([])
}

// ── the merger ────────────────────────────────────────────────────────────────
const msF = $({}), lF = lane(msF, strict)
const msT = $({}), lT = lane(msT, strict), outT = msT.za('points', K)
const msC = $({}), lC = lane(msC, strict), outC = msC.az(cmpTotal, K)
const own = { filter: new Map<string, number>(), topk: new Map<string, number>(), topkC: new Map<string, number>() }
const lanes = { filter: lF, topk: lT, topkC: lC }
const bucketParts = new Map<string, Map<number, Record<string, Row>>>()
const sumPart = new Array<number>(G).fill(0)
const exactM = new ExactSum()
function deliver(d: Delivery): void {
  const q: Record<RowD['view'], Rec[]> = { filter: [], topk: [], topkC: [] }
  for (const [gid, p] of d.parts) {
    for (const r of p.rows) {
      const o = own[r.view]
      if (r.op === 'put') { o.set(r.k, gid); q[r.view].push({ type: 0, key: [r.k], value: r.row }) }
      else if (o.get(r.k) === gid) { o.delete(r.k); q[r.view].push({ type: 2, key: [r.k] }) }
    }
    for (const b of p.buckets) {
      let m = bucketParts.get(b.b)
      if (m === undefined) bucketParts.set(b.b, (m = new Map()))
      if (b.op === 'set') m.set(gid, b.v!); else m.delete(gid)
      if (m.size === 0) bucketParts.delete(b.b)
    }
    sumPart[gid] = p.sum
    for (const [o, n] of p.exact) { if (o !== undefined) exactM.sub(o); if (n !== undefined) exactM.add(n) }
    for (const r of p.recs) applyTruth(groups[gid].truth, r)
  }
  batch(() => { for (const v of ['filter', 'topk', 'topkC'] as const) if (q[v].length) lanes[v](q[v]) })
}

// ── checks: the merged views vs the query over the cut's rows ────────────────
type Stat = { n: number; bad: number; ex?: string }
const stats = new Map<string, Stat>()
let STEP = 0
function tally(name: string, ok: boolean, ex: () => string) {
  let s = stats.get(name)
  if (s === undefined) stats.set(name, (s = { n: 0, bad: 0 }))
  s.n++
  if (!ok) { s.bad++; if (s.ex === undefined) s.ex = `step ${STEP}: ${ex()}`.slice(0, 300) }
}
let deliveries = 0, lagMax = 0, lagSum = 0, lagN = 0
function check(): void {
  // the cut's rows
  const cut = new Map<string, Row>()
  for (const g of groups) for (const [k, r] of g.truth) cut.set(k, r)
  // filter
  let nf = 0, badF = false
  for (const [k, r] of cut) if (PRED(r)) { nf++; if (msF[NODE].rowAt(k) !== r && canon(msF[NODE].rowAt(k)) !== canon(r)) badF = true }
  tally('filter M=Q(cut)', !badF && msF[NODE].rowCount() === nf, () => `${msF[NODE].rowCount()} vs ${nf}`)
  // top-k
  const top: Row[] = []
  for (const row of cut.values()) {
    if (top.length < K || cmpTotal(row, top[top.length - 1]) < 0) {
      let lo = 0, hi = top.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpTotal(top[mid], row) < 0) lo = mid + 1; else hi = mid }
      top.splice(lo, 0, row)
      if (top.length > K) top.pop()
    }
  }
  const keys = (h: any) => { const ks: string[] = []; h[NODE].each((k: string) => ks.push(k)); return ks }
  const score = (ks: string[]) => canon(ks.map((k) => cut.get(k)?.points))
  const qk = top.map((r) => r.id)
  const tk = keys(outT), ck = keys(outC)
  tally('topk (data) M=Q(cut) scores', score(tk) === score(qk), () => `${score(tk)} vs ${score(qk)}`)
  tally('topk (data) M=Q(cut) order', canon(tk) === canon(qk), () => `${canon(tk)} vs ${canon(qk)}`)
  tally('topkC M=Q(cut) order', canon(ck) === canon(qk), () => `${canon(ck)} vs ${canon(qk)}`)
  // sum
  const es = new ExactSum()
  for (const r of cut.values()) { const x = proj(r, 'points'); if (x !== undefined) es.add(+(x as any)) }
  let s = 0
  for (const v of sumPart) s += v
  tally('sum (data) M=Q(cut)', Object.is(s, es.value()), () => `${s} vs ${es.value()}`)
  tally('sumC M=Q(cut)', Object.is(exactM.value(), es.value()), () => `${exactM.value()} vs ${es.value()}`)
  // group: every bucket, as values
  const qb = new Map<string, string[]>()
  for (const [k, r] of cut) { const b = String(ROOM(r)); if (!qb.has(b)) qb.set(b, []); qb.get(b)!.push(k) }
  let badG = qb.size !== bucketParts.size
  if (!badG) for (const [b, ks] of qb) {
    const m = bucketParts.get(b)
    if (m === undefined) { badG = true; break }
    let n = 0
    for (const v of m.values()) for (const k of Object.keys(v)) { n++; if (cut.get(k) !== v[k] && canon(cut.get(k)) !== canon(v[k])) badG = true }
    if (n !== ks.length) badG = true
  }
  tally('group M=Q(cut)', !badG, () => `buckets ${bucketParts.size} vs ${qb.size}`)
}

// ── the commit stream (as runs A and B) and the moves ─────────────────────────
const truth = new Map<string, Row>()
const live: string[] = []
const liveIdx = new Map<string, number>()
let nextId = 0
function opFor(k: string): Rec {
  const exists = truth.has(k)
  const u = R()
  if (!exists || u < 0.2) { const row = makeRow(k, DOMAIN, R); return exists ? { type: 0, key: [k], value: row } : { type: 1, key: [], at: k, value: row } }
  if (u < 0.65) { const p = genPoints(DOMAIN, R); return p === undefined ? { type: 2, key: [k, 'points'] } : { type: 0, key: [k, 'points'], value: p } }
  if (u < 0.78) return { type: 0, key: [k, 'room'], value: genRoom(DOMAIN, R) }
  return { type: 2, key: [k] }
}
const newPart = () => ({ recs: [] as Rec[], rows: [] as RowD[], buckets: [] as BucketD[], sum: 0, exact: [] as [number | undefined, number | undefined][] })
function commitAt(g: Group, recs: Rec[], d: Delivery): void {
  const p = newPart()
  g.cur = p
  g.lane(recs)
  g.cur = null
  p.recs = recs
  p.sum = g.sum[VALUE]
  d.parts.set(g.gid, p)
}
let moves = 0, movedRows = 0
function move(): void {
  const A = groups[Math.floor(R() * G)]
  const B = groups[(A.gid + 1 + Math.floor(R() * (G - 1))) % G]
  const mine: number[] = []
  for (let s = 0; s < SLOTS; s++) if (owner[s] === A.gid) mine.push(s)
  if (mine.length === 0) return
  const m = Math.min(mine.length, [1, 8, 64, 256][Math.floor(R() * 4)])
  const slots = new Set(mine.sort(() => R() - 0.5).slice(0, m))
  const rm: Rec[] = [], ins: Rec[] = []
  for (const [k, row] of truth) if (slots.has(slotOf(k))) { rm.push({ type: 2, key: [k] }); ins.push({ type: 1, key: [], at: k, value: row }) }
  for (const s of slots) owner[s] = B.gid
  const d: Delivery = { id: nextId++, parts: new Map(), pending: 2 }
  commitAt(A, rm, d)
  commitAt(B, ins, d)
  queues[A.gid].push(d)
  queues[B.gid].push(d)
  moves++
  movedRows += rm.length
}
function deliverSome(n: number): void {
  for (let j = 0; j < n; j++) {
    // a delivery is takeable when it heads every queue it is in
    const ready: number[] = []
    for (let g = 0; g < G; g++) {
      const d = queues[g][0]
      if (d === undefined) continue
      if (d.parts.size === 1 || [...d.parts.keys()].every((x) => queues[x][0] === d)) ready.push(g)
    }
    if (ready.length === 0) return
    const d = queues[ready[Math.floor(R2() * ready.length)]][0]
    for (const g of d.parts.keys()) queues[g].shift()
    deliver(d)
    deliveries++
    check()
  }
}

const t0 = performance.now()
for (STEP = 1; STEP <= COMMITS; STEP++) {
  if (G > 1 && R() < 1 / 250) move()
  else {
    let recs: Rec[]
    if (R() < 0.05) {
      const g = Math.floor(R() * G), ks = new Set<string>()
      for (let t = 0; t < 400 && ks.size < 3 + Math.floor(R() * 6); t++) { const k = 'p' + Math.floor(R() * KEYS); if (owner[slotOf(k)] === g) ks.add(k) }
      recs = ks.size ? [...ks].map(opFor) : [opFor('p' + Math.floor(R() * KEYS))]
    } else {
      const k = live.length > 0 && R() < 0.6 ? live[Math.floor(R() * live.length)] : 'p' + Math.floor(R() * KEYS)
      recs = [opFor(k)]
    }
    const g = groups[owner[slotOf(keyOf(recs[0]))]]
    const d: Delivery = { id: nextId++, parts: new Map(), pending: 1 }
    commitAt(g, recs, d)
    queues[g.gid].push(d)
    for (const r of recs) {
      applyTruth(truth, r)
      const k = keyOf(r)
      if (truth.has(k)) { if (!liveIdx.has(k)) { liveIdx.set(k, live.length); live.push(k) } }
      else if (liveIdx.has(k)) { const i = liveIdx.get(k)!; const last = live.pop()!; if (last !== k) { live[i] = last; liveIdx.set(last, i) } liveIdx.delete(k) }
    }
  }
  // the merger runs behind: 0 to 2 deliveries per commit (1 on average), so it lags and catches up
  deliverSome(Math.floor(R2() * 3))
  let lag = 0
  for (const q of queues) lag += q.length
  lagMax = Math.max(lagMax, lag); lagSum += lag; lagN++
}
deliverSome(Infinity)

console.log(`E-23 async merger  groups=${G} domain=${DOMAIN} commits=${COMMITS} seed=${SEED}  rows at end ${truth.size}; moves ${moves} (${movedRows} rows); deliveries checked ${deliveries}; merger lag in undelivered commits: mean ${(lagSum / lagN).toFixed(1)}, max ${lagMax}; ${((performance.now() - t0) / 1000).toFixed(1)} s`)
for (const n of [...stats.keys()].sort()) {
  const s = stats.get(n)!
  console.log(`  ${s.bad === 0 ? 'ok  ' : 'DIFF'} ${n.padEnd(30)} ${String(s.bad).padStart(7)} / ${String(s.n).padStart(7)}${s.ex ? '   first: ' + s.ex : ''}`)
}
