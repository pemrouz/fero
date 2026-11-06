// E-23 run B: is each data view a function of the committed state alone?
//
// Merging needs this first. A server that follows every group folds all of
// them into one source, but no two servers interleave the groups' commits the
// same way (there is no order across partitions: TEST-12). And a view rebuilt
// after a failover, or on a follower that started from a snapshot, starts from
// state, not history (P-16: "a rebuilt projection equals the live one byte for
// byte"). So for every data operator:
//   F2 vs F1  : the same commits, each group's own order kept, groups
//               interleaved differently (a seeded shuffle with lag);
//   rebuilt   : a fresh view over F1's source vs F1's live view;
//   snapshot  : a fresh source loaded from F1's rows in key order (a snapshot
//               loader), with fresh views, vs F1's live views.
// Each is compared two ways: as values (rows as a set, ordered views as a key
// sequence, scalars by bits) and as bytes (data's own output order, keys in
// data's enumeration order).
//
// usage: node --experimental-strip-types interleave.ts --groups=4 --domain=int --commits=100000 --seed=1

import { rng, SLOTS, slotOf, canon, makeRow, genPoints, genRoom, applyTruth, cmpTotal, rankable, type Row, type Domain, type Rec } from './lib.ts'

const DATA = process.env.DATA_DIR ?? '/home/user/pemrouz/data'
const D: any = await import(DATA + '/api/index.ts')
const { $, value: VALUE, node: NODE, lane } = D

const arg = (name: string, def: string): string => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : def
}
const G = Number(arg('groups', '4'))
const DOMAIN = arg('domain', 'int') as Domain
const COMMITS = Number(arg('commits', '100000'))
const SEED = Number(arg('seed', '1'))
const KEYS = Number(arg('keys', '3000'))
const SYNC = 200
const K = 10
const R = rng(SEED)
const R2 = rng(SEED * 7919 + 1) // the shuffle's own stream, so F1's commits do not depend on it
const strict = { onReject: (rj: any) => { throw new Error('lane reject: ' + String(rj.error?.message ?? rj.error)) } }

const SOME = (r: Row) => (r.points as any) >= 99
const EVERY = (r: Row) => (r.points as any) >= 1
const PRED = (r: Row) => (r.points as any) >= 50
const ROOM = (r: Row) => r.room
// Every view here is data's own operator; topkC and maxC are data's
// comparator and filter forms, the contract's shape written with today's API.
const VIEWS: [string, (s: any) => any][] = [
  ['filter', (s) => s.filter(PRED)],
  ['topk za(points,10)', (s) => s.za('points', K)],
  ['topkC az(cmpTotal,10)', (s) => s.az(cmpTotal, K)],
  ['az(points) full order', (s) => s.az('points')],
  ['limit(10)', (s) => s.limit(K)],
  ['sum', (s) => s.sum('points')],
  ['length', (s) => s.length()],
  ['avg', (s) => s.avg('points')],
  ['max', (s) => s.max('points')],
  ['min', (s) => s.min('points')],
  ['maxC (numbers only)', (s) => s.filter((r: Row) => rankable(r.points)).max('points')],
  ['some', (s) => s.some(SOME)],
  ['every', (s) => s.every(EVERY)],
  ['median', (s) => s.median('points')],
  ['group(room)', (s) => s.group(ROOM)],
  ['length(room) counts', (s) => s.length(ROOM)],
  ['distinct(room)', (s) => s.distinct(ROOM)],
]

// byte-faithful encoding: data's order kept (no key sorting), NaN/Infinity/undefined kept
function enc(v: unknown): string {
  if (v === undefined) return 'u'
  if (v === null) return 'n'
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'T' : 'F'
  if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).map((k) => JSON.stringify(k) + ':' + enc(o[k])).join(',') + '}'
}
// a view's output: scalars by value; collections as [key,row] pairs in data's order
function bytes(h: any): string {
  const n = h[NODE]
  if (n.kind === 'scalar') return enc(h[VALUE])
  const parts: string[] = []
  n.each((k: string, r: unknown) => parts.push(JSON.stringify(k) + '=' + enc(r)))
  return parts.join(';')
}
function values(h: any, ordered: boolean): string {
  const n = h[NODE]
  if (n.kind === 'scalar') return canon(h[VALUE])
  const parts: string[] = []
  n.each((k: string, r: unknown) => parts.push(JSON.stringify(k) + '=' + canon(r)))
  if (!ordered) parts.sort()
  return parts.join(';')
}
const ORDERED = new Set(['topk za(points,10)', 'topkC az(cmpTotal,10)', 'az(points) full order', 'limit(10)'])

type Stat = { n: number; bad: number; ex?: string }
const stats = new Map<string, Stat>()
let STEP = 0
function tally(name: string, ok: boolean, ex: () => string) {
  let s = stats.get(name)
  if (s === undefined) stats.set(name, (s = { n: 0, bad: 0 }))
  s.n++
  if (!ok) { s.bad++; if (s.ex === undefined) s.ex = `step ${STEP}: ${ex()}`.slice(0, 300) }
}

// ── two full followers ───────────────────────────────────────────────────────
const F1 = $({}), L1 = lane(F1, strict)
const F2 = $({}), L2 = lane(F2, strict)
const V1 = VIEWS.map(([, b]) => b(F1))
const V2 = VIEWS.map(([, b]) => b(F2))
const truth = new Map<string, Row>()
const groupOf = (k: string) => Math.floor((slotOf(k) * G) / SLOTS)
const queues: Rec[][][] = Array.from({ length: G }, () => [])

// the generator: as run A's, without moves (a full follower holds every group)
const pool = (i: number) => 'p' + i
const live: string[] = []
const liveIdx = new Map<string, number>()
function opFor(k: string): Rec {
  const exists = truth.has(k)
  const u = R()
  if (!exists || u < 0.2) {
    const row = makeRow(k, DOMAIN, R)
    return exists ? { type: 0, key: [k], value: row } : { type: 1, key: [], at: k, value: row }
  }
  if (u < 0.65) {
    const p = genPoints(DOMAIN, R)
    return p === undefined ? { type: 2, key: [k, 'points'] } : { type: 0, key: [k, 'points'], value: p }
  }
  if (u < 0.78) return { type: 0, key: [k, 'room'], value: genRoom(DOMAIN, R) }
  return { type: 2, key: [k] }
}
function nextCommit(): Rec[] {
  if (R() < 0.05) {
    const g = Math.floor(R() * G)
    const want = 3 + Math.floor(R() * 6)
    const ks = new Set<string>()
    for (let t = 0; t < 400 && ks.size < want; t++) { const k = pool(Math.floor(R() * KEYS)); if (groupOf(k) === g) ks.add(k) }
    if (ks.size > 0) return [...ks].map(opFor)
  }
  const k = live.length > 0 && R() < 0.6 ? live[Math.floor(R() * live.length)] : pool(Math.floor(R() * KEYS))
  return [opFor(k)]
}
const keyOf = (r: Rec) => (r.type === 1 ? r.at : r.key[0]) as string

function sync(): void {
  // F2 catches up on every group, in a random order of groups
  for (;;) {
    const ne = queues.map((q, i) => (q.length ? i : -1)).filter((i) => i >= 0)
    if (ne.length === 0) break
    L2(queues[ne[Math.floor(R2() * ne.length)]].shift()!)
  }
  let i = 0
  for (const [name] of VIEWS) {
    const o = ORDERED.has(name)
    const a = V1[i], b = V2[i]
    i++
    const va = values(a, o), vb = values(b, o)
    tally(`${name.padEnd(22)} interleave values`, va === vb, () => `${va.slice(0, 120)} | ${vb.slice(0, 120)}`)
    tally(`${name.padEnd(22)} interleave bytes`, bytes(a) === bytes(b), () => 'byte order differs')
  }
}
function rebuildAndSnapshot(): void {
  // a fresh view over the same source (a failover that rebuilds views)
  // (a second handle on the same source node, so data's view sharing cannot
  // hand back the live view of the same shape)
  const H = D.handleFor(F1[NODE])
  let i = 0
  for (const [name, build] of VIEWS) {
    const o = ORDERED.has(name)
    const live = V1[i++]
    const f = build(H)
    if (f[NODE] === live[NODE]) throw new Error('rebuilt view is the live view')
    const va = values(live, o), vb = values(f, o)
    tally(`${name.padEnd(22)} rebuilt values`, va === vb, () => `${va.slice(0, 120)} | ${vb.slice(0, 120)}`)
    tally(`${name.padEnd(22)} rebuilt bytes`, bytes(live) === bytes(f), () => 'byte order differs')
    f.dispose()
  }
  // a follower that starts from a snapshot: rows loaded in key order
  const S = $({})
  const LS = lane(S, strict)
  LS(snapshotRows(true).map(([k, row]) => ({ type: 1, key: [], at: k, value: row })))
  i = 0
  for (const [name, build] of VIEWS) {
    const o = ORDERED.has(name)
    const live = V1[i++]
    const f = build(S)
    const va = values(live, o), vb = values(f, o)
    tally(`${name.padEnd(22)} snapshot values`, va === vb, () => `${va.slice(0, 120)} | ${vb.slice(0, 120)}`)
    tally(`${name.padEnd(22)} snapshot bytes`, bytes(live) === bytes(f), () => 'byte order differs')
    f.dispose()
  }
}
// F1's rows, in F1's own order (false) or sorted by key (true)
function snapshotRows(sorted: boolean): [string, Row][] {
  const rows: [string, Row][] = []
  F1[NODE].each((k: string, r: Row) => rows.push([k, r]))
  if (sorted) rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return rows
}

const t0 = performance.now()
for (STEP = 1; STEP <= COMMITS; STEP++) {
  const recs = nextCommit()
  L1(recs)
  queues[groupOf(keyOf(recs[0]))].push(recs)
  for (const r of recs) {
    applyTruth(truth, r)
    const k = keyOf(r)
    if (truth.has(k)) { if (!liveIdx.has(k)) { liveIdx.set(k, live.length); live.push(k) } }
    else if (liveIdx.has(k)) { const i = liveIdx.get(k)!; const last = live.pop()!; if (last !== k) { live[i] = last; liveIdx.set(last, i) } liveIdx.delete(k) }
  }
  // F2 lags: it applies 0 to 2 queued commits from random groups per step
  const n = Math.floor(R2() * 3)
  for (let j = 0; j < n; j++) {
    const ne = queues.map((q, i) => (q.length ? i : -1)).filter((i) => i >= 0)
    if (ne.length === 0) break
    L2(queues[ne[Math.floor(R2() * ne.length)]].shift()!)
  }
  if (STEP % SYNC === 0) sync()
  if (STEP % (SYNC * 10) === 0) rebuildAndSnapshot()
}
sync()
rebuildAndSnapshot()

console.log(`E-23 interleave  groups=${G} domain=${DOMAIN} commits=${COMMITS} seed=${SEED} keys=${KEYS}  rows at end ${truth.size}  ${((performance.now() - t0) / 1000).toFixed(1)} s`)
for (const n of [...stats.keys()].sort()) {
  const s = stats.get(n)!
  console.log(`  ${s.bad === 0 ? 'ok  ' : 'DIFF'} ${n.padEnd(42)} ${String(s.bad).padStart(5)} / ${String(s.n).padStart(5)}${s.ex ? '   first: ' + s.ex : ''}`)
}
