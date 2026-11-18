// E-54: step through a resource's versions on top of its log, ten ways.
//   IMMUTABLE=<immutable.es.js> node --expose-gc structs.mjs <rows> <way> [K]
// Env: H (records of history built before the clocks start on steps; default 1e6), STEADY_S and RATE (the
// steady write phase after it, E-07's method; default 10 s at 50,000 records a second).
//
// The log is the truth (V5-1): an array of change records, version v = the state after the first v records.
// Every way holds the log and the start (version 0) and adds its own structure while the records are folded:
//   base     nothing: a Map folded from the log. Any older version is a refold from the start (what fero v4's
//            debug viewer does today, tools/debug/model.mjs stateAt)
//   rev      (a) a Map plus each record's prior row, by reference (data's UpdateDelta.prev): a step back sets
//            the prior row, a step forward applies the record again
//   revleaf  (a) the same, but a field write keeps only the prior field value (what the wire's
//            WireRecord.prev carries); a step back path-copies the row
//   diff     (d) Baker's rerooting: every version is a node; the newest holds the Map, older ones are diffs
//            pointing at it; moving to a version reverses the diffs on the way (cost: the distance)
//   ckpt     (b) a Map copy every K records (rows shared by reference); a version = the copy before it plus a
//            replay of up to K records
//   imm      (c) Immutable.js 5.1.9 Map (a HAMT), one root kept per version
//   hamt     (c) a small HAMT written here (hamt.mjs), one root per version: the lean floor
//   fat      (e) fat nodes: per key a version list (versions and rows, arrays), binary search to read
//   fatlog   (e) fat nodes as back-pointers into the log: per record, the index of the previous record of the
//            same key (4 B) and the row it made; a read walks back from the key's newest record
// Measured: the cost per write while history is kept (ns, bytes kept, bytes of garbage), GC pauses and
// event-loop delay under steady writes, then step back, step forward, jump, read one row at a version, and a
// whole frozen picture at a version; every answer is checked against a refold from the start.
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import * as HM from './hamt.mjs'
import { UPDATE, INSERT, REMOVE, HOT, tape, initMap, pathCopy, applyMap, rng, gc, heapUsed, now, ns, out, mb, sumUp, sample, gcWatch, gcSummary, eld, eldSummary, freedWatch } from './common.mjs'

const N = +process.argv[2]
const WAY = process.argv[3]
const K = +(process.argv[4] ?? 0)
const H = +(process.env.H ?? 1e6)
const STEADY_S = +(process.env.STEADY_S ?? 10)
const RATE = +(process.env.RATE ?? 50000)
const I = WAY === 'imm' ? await import(pathToFileURL(process.env.IMMUTABLE).href) : null

const gw = gcWatch()
const tGen = performance.now()
const { recs, keysEver } = tape(N, H + STEADY_S * RATE + 4000)
const T = recs.length
const genMs = performance.now() - tGen

const TOMB = Object.freeze({ tomb: true })
const applyRow = (r, x) => x.type === REMOVE ? undefined : x.key.length === 1 ? x.value : pathCopy(r, x.key[1], x.value)
const fieldOf = (x) => x.type === UPDATE && x.key.length === 2 ? x.key[1] : null

// ── the ten ways. Each: init(m0), write(i), back(), fwd(), jump(v), readAt(v, k), picture(v), toMap(pic), at() ──
class Base {
  init(m0) { this.m0 = m0; this.m = new Map(m0); this.c = null; this.cur = 0 }
  write(i) { applyMap(this.m, recs[i]); this.cur = i + 1 }
  jump(v) {
    if (this.c === null || v < this.cur) { this.c = new Map(this.m0); this.cur = 0 }
    for (let i = this.cur; i < v; i++) applyMap(this.c, recs[i])
    this.cur = v
  }
  back() { this.jump(this.cur - 1) }
  fwd() { this.jump(this.cur + 1) }
  readAt(v, k) { let r = this.m0.get(k); for (let i = 0; i < v; i++) if (recs[i].key[0] === k) r = applyRow(r, recs[i]); return r }
  picture(v) { const c = new Map(this.m0); for (let i = 0; i < v; i++) applyMap(c, recs[i]); return c }
  at(k) { return (this.c ?? this.m).get(k) }
  cursorMap() { return this.c }
}

class Rev {
  constructor(leaf) { this.leaf = leaf }
  init(m0) { this.m = m0; this.prev = []; this.cur = 0 }
  write(i) {
    const x = recs[i], k = x.key[0], f = this.leaf ? fieldOf(x) : null
    if (f === null) this.prev.push(this.m.get(k))
    else { const r = this.m.get(k); this.prev.push(Object.hasOwn(r, f) ? r[f] : TOMB) }
    applyMap(this.m, x)
    this.cur = i + 1
  }
  undo(r, i) { // the row before record i, from the row after it
    const x = recs[i], p = this.prev[i], f = this.leaf ? fieldOf(x) : null
    if (f === null) return p
    if (p === TOMB) { const c = { ...r }; delete c[f]; return c }
    return pathCopy(r, f, p)
  }
  back() { const i = --this.cur, k = recs[i].key[0]; const p = this.undo(this.m.get(k), i); if (p === undefined) this.m.delete(k); else this.m.set(k, p) }
  fwd() { applyMap(this.m, recs[this.cur++]) }
  jump(v) { while (this.cur > v) this.back(); while (this.cur < v) this.fwd() }
  readAt(v, k) {
    if (v >= this.cur) { let r = this.m.get(k); for (let i = this.cur; i < v; i++) if (recs[i].key[0] === k) r = applyRow(r, recs[i]); return r }
    if (!this.leaf) { for (let i = v; i < this.cur; i++) if (recs[i].key[0] === k) return this.prev[i]; return this.m.get(k) }
    let r = this.m.get(k)
    for (let i = this.cur - 1; i >= v; i--) if (recs[i].key[0] === k) r = this.undo(r, i)
    return r
  }
  picture(v) { this.jump(v); return new Map(this.m) }
  at(k) { return this.m.get(k) }
  cursorMap() { return this.m }
}

class VN { constructor() { this.k = null; this.v = undefined; this.nx = null; this.m = null } }
class Diff {
  init(m0) { const r = new VN(); r.m = m0; this.vs = [r]; this.cur = 0 }
  write(i) {
    const t = this.vs[i], m = t.m, x = recs[i], k = x.key[0]
    const nv = new VN(); nv.m = m
    t.m = null; t.k = k; t.v = m.get(k); t.nx = nv
    applyMap(m, x)
    this.vs.push(nv)
    this.cur = i + 1
  }
  reroot(t) {
    if (t.m !== null) return
    const path = []
    for (let x = t; x.m === null; x = x.nx) path.push(x)
    for (let j = path.length - 1; j >= 0; j--) {
      const a = path[j], b = a.nx, m = b.m, old = m.get(a.k)
      if (a.v === undefined) m.delete(a.k); else m.set(a.k, a.v)
      b.m = null; b.k = a.k; b.v = old; b.nx = a
      a.m = m; a.nx = null; a.k = null; a.v = undefined
    }
  }
  back() { this.reroot(this.vs[--this.cur]) }
  fwd() { this.reroot(this.vs[++this.cur]) }
  jump(v) { this.reroot(this.vs[v]); this.cur = v }
  readAt(v, k) { let x = this.vs[v]; while (x.m === null) { if (x.k === k) return x.v; x = x.nx } return x.m.get(k) }
  picture(v) { this.jump(v); return new Map(this.vs[v].m) }
  at(k) { return this.vs[this.cur].m.get(k) }
  cursorMap() { return this.vs[this.cur].m }
}

class Ckpt {
  init(m0) { this.m = m0; this.ck = []; this.c = null; this.cur = 0 }
  write(i) { if (i % K === 0) this.ck.push(new Map(this.m)); applyMap(this.m, recs[i]); this.cur = i + 1 }
  seg(v) { return Math.min(Math.floor(v / K), this.ck.length - 1) }
  jump(v) {
    if (this.c === null || v < this.cur || v - this.cur > K) { const s = this.seg(v); this.c = new Map(this.ck[s]); this.cur = s * K }
    for (let i = this.cur; i < v; i++) applyMap(this.c, recs[i])
    this.cur = v
  }
  back() { this.jump(this.cur - 1) }
  fwd() { this.jump(this.cur + 1) }
  readAt(v, k) { const s = this.seg(v); let r = this.ck[s].get(k); for (let i = s * K; i < v; i++) if (recs[i].key[0] === k) r = applyRow(r, recs[i]); return r }
  picture(v) { const s = this.seg(v), c = new Map(this.ck[s]); for (let i = s * K; i < v; i++) applyMap(c, recs[i]); return c }
  at(k) { return (this.c ?? this.m).get(k) }
}

class Imm {
  init(m0) { this.r = [I.Map(m0)]; this.cur = 0 }
  write(i) {
    const m = this.r[i], x = recs[i], k = x.key[0]
    this.r.push(x.type === REMOVE ? m.remove(k) : x.key.length === 1 ? m.set(k, x.value) : m.set(k, pathCopy(m.get(k), x.key[1], x.value)))
    this.cur = i + 1
  }
  back() { this.cur-- } fwd() { this.cur++ } jump(v) { this.cur = v }
  readAt(v, k) { return this.r[v].get(k) }
  picture(v) { return this.r[v] }
  toMap(p) { const o = new Map(); p.forEach((v, k) => { o.set(k, v) }); return o }
  at(k) { return this.r[this.cur].get(k) }
}

class Hamt {
  init(m0) { this.r = [HM.fromMap(m0)]; this.cur = 0 }
  write(i) {
    const m = this.r[i], x = recs[i], k = x.key[0]
    this.r.push(x.type === REMOVE ? HM.del(m, k) : x.key.length === 1 ? HM.set(m, k, x.value) : HM.set(m, k, pathCopy(HM.get(m, k), x.key[1], x.value)))
    this.cur = i + 1
  }
  back() { this.cur-- } fwd() { this.cur++ } jump(v) { this.cur = v }
  readAt(v, k) { return HM.get(this.r[v], k) }
  picture(v) { return this.r[v] }
  toMap(p) { const o = new Map(); HM.each(p, (v, k) => { o.set(k, v) }); return o }
  at(k) { return HM.get(this.r[this.cur], k) }
}

class FatE { constructor(vs, rs) { this.vs = vs; this.rs = rs } }
class Fat {
  init(m0) { this.f = m0; this.cur = 0 } // a key's value is its row until its first change, then a FatE
  write(i) {
    const x = recs[i], k = x.key[0], e = this.f.get(k)
    const cur = e instanceof FatE ? e.rs[e.rs.length - 1] : e
    const nv = x.type === REMOVE ? TOMB : x.key.length === 1 ? x.value : pathCopy(cur, x.key[1], x.value)
    if (e instanceof FatE) { e.vs.push(i + 1); e.rs.push(nv) }
    else if (e === undefined) this.f.set(k, new FatE([i + 1], [nv]))
    else this.f.set(k, new FatE([0, i + 1], [e, nv]))
    this.cur = i + 1
  }
  back() { this.cur-- } fwd() { this.cur++ } jump(v) { this.cur = v }
  look(e, v) {
    if (!(e instanceof FatE)) return e
    const vs = e.vs
    let lo = 0, hi = vs.length - 1, j = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (vs[mid] <= v) { j = mid; lo = mid + 1 } else hi = mid - 1 }
    if (j < 0) return undefined
    const r = e.rs[j]
    return r === TOMB ? undefined : r
  }
  readAt(v, k) { return this.look(this.f.get(k), v) }
  picture(v) { const o = new Map(); for (const [k, e] of this.f) { const r = this.look(e, v); if (r !== undefined) o.set(k, r) } return o }
  at(k) { return this.readAt(this.cur, k) }
}

class FatLog {
  init(m0) { this.m0 = m0; this.head = new Map(); this.bk = new Int32Array(1024); this.val = []; this.cur = 0 }
  row(i) { const r = this.val[i]; return r === TOMB ? undefined : r }
  write(i) {
    const x = recs[i], k = x.key[0], h = this.head.get(k)
    if (i >= this.bk.length) { const b = new Int32Array(this.bk.length * 2); b.set(this.bk); this.bk = b }
    this.bk[i] = h === undefined ? -1 : h
    this.head.set(k, i)
    const cur = h === undefined ? this.m0.get(k) : this.row(h)
    this.val.push(x.type === REMOVE ? TOMB : x.key.length === 1 ? x.value : pathCopy(cur, x.key[1], x.value))
    this.cur = i + 1
  }
  back() { this.cur-- } fwd() { this.cur++ } jump(v) { this.cur = v }
  readAt(v, k) { let i = this.head.get(k) ?? -1; while (i >= v) i = this.bk[i]; return i < 0 ? this.m0.get(k) : this.row(i) }
  picture(v) {
    const o = new Map()
    for (const k of this.m0.keys()) { const r = this.readAt(v, k); if (r !== undefined) o.set(k, r) }
    for (const k of this.head.keys()) if (!this.m0.has(k)) { const r = this.readAt(v, k); if (r !== undefined) o.set(k, r) }
    return o
  }
  at(k) { return this.readAt(this.cur, k) }
}

const WAYS = { base: () => new Base(), rev: () => new Rev(false), revleaf: () => new Rev(true), diff: () => new Diff(), ckpt: () => new Ckpt(), imm: () => new Imm(), hamt: () => new Hamt(), fat: () => new Fat(), fatlog: () => new FatLog() }
if (!WAYS[WAY]) throw new Error('way: ' + Object.keys(WAYS).join(' | '))
if (WAY === 'ckpt' && !(K > 0)) throw new Error('ckpt needs K')
const w = WAYS[WAY]()

// ── setup: the start (version 0) ──
const tInit = performance.now()
w.init(initMap(N))
const initMs = performance.now() - tInit
gc()
const h0 = heapUsed()

// ── build: fold H records while keeping history ──
gw.mark('build')
const freed = freedWatch()
const tb = now()
for (let i = 0; i < H; i++) w.write(i)
const buildNs = ns(tb)
gw.mark('after-build')
gc()
const garbage = freed()
const h1 = heapUsed()

// ── steady writes (E-07's method): every 1 ms tick, the records due at RATE a second, at most 2,000 a tick ──
gw.mark('steady')
const h = eld()
let written = 0, writeMs = 0
const tW0 = performance.now()
await new Promise((resolve) => {
  const tick = () => {
    const t = performance.now()
    const due = Math.min(2000, Math.floor((t - tW0) * RATE / 1000) - written, T - H - written)
    if (due > 0) { const a = performance.now(); for (let j = 0; j < due; j++) w.write(H + written + j); writeMs += performance.now() - a; written += due }
    if (t - tW0 >= STEADY_S * 1000) resolve(); else setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
})
const steadyS = (performance.now() - tW0) / 1000
h.disable()
gw.mark('ops')
gc()
const h2 = heapUsed()
const V = H + written // the newest version
w.cur = V

// ── steps, jumps, reads, pictures (cursor starts at the newest version) ──
// Targets are drawn before the clocks start. Each op is timed alone (p50, p90, max; the timer's own cost is
// `timer`); ops under 100 µs are also timed as one batch of 1,000 on fresh targets (`mean`), which drops
// the timer's cost.
const r = rng(N + 7)
const NS = 1000
const pick = () => ({ v: Array.from({ length: NS }, () => r() % (V + 1)), k: Array.from({ length: NS }, () => 'k' + (r() % keysEver)) })
const A = pick(), B = pick()
const batch = (n, fn) => { const t = now(); for (let i = 0; i < n; i++) fn(i); return +(ns(t) / n).toFixed(1) }
const light = (xs) => xs.length >= NS && sumUp(xs).p50 < 1e5
const timer = sample(NS, 100, () => {})
const backNs = sample(NS, 5000, () => w.back())
const fwdNs = sample(backNs.length, 5000, () => w.fwd())
const backMean = light(backNs) ? batch(NS, () => w.back()) : null
const fwdMean = backMean !== null ? batch(NS, () => w.fwd()) : null
const jumpNs = sample(50, 10000, (i) => w.jump(A.v[i]))
const jumpMean = sumUp(jumpNs).p50 < 1e5 ? batch(NS, (i) => w.jump(B.v[i])) : null
w.jump(V)
const readNs = sample(NS, 5000, (i) => w.readAt(A.v[i], A.k[i]))
const readMean = light(readNs) ? batch(NS, (i) => w.readAt(B.v[i], B.k[i])) : null
const readHotNs = HOT > 0 ? sample(NS, 5000, (i) => w.readAt(A.v[i], 'hot')) : null
let lastPic = null
const picNs = sample(10, 15000, (i) => { lastPic = w.picture(A.v[100 + i]) })
const toMapNs = w.toMap ? sample(5, 10000, (i) => w.toMap(w.picture(A.v[200 + i]))) : null
lastPic = null
w.jump(V)

// ── checks: every answer against a refold from the start (untimed) ──
const cr = rng(99)
const cvs = [0, V, ...Array.from({ length: 12 }, () => cr() % (V + 1))].sort((a, b) => a - b)
const cks = Array.from({ length: 40 }, () => 'k' + (cr() % keysEver))
if (HOT > 0) cks[0] = 'hot'
const pvs = [cvs[4], cvs[9]]
const want = new Map(), wantPic = new Map()
{
  const m = initMap(N)
  let ci = 0
  for (let v = 0; v <= V; v++) {
    while (ci < cvs.length && cvs[ci] === v) { want.set(v, cks.map((k) => JSON.stringify(m.get(k)))); ci++ }
    if (pvs.includes(v) && !wantPic.has(v)) wantPic.set(v, new Map(m))
    if (v < V) applyMap(m, recs[v])
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
let readsChecked = 0, readsWrong = 0
for (const v of cvs) { const ws = want.get(v); cks.forEach((k, j) => { readsChecked++; if (JSON.stringify(w.readAt(v, k)) !== ws[j]) readsWrong++ }) }
const picOk = (pic, v) => { const m = w.toMap ? w.toMap(pic) : pic, e = wantPic.get(v); if (m.size !== e.size) return false; for (const [k, x] of e) if (!same(m.get(k), x)) return false; return true }
let picsWrong = 0
const pics = pvs.map((v) => { const p = w.picture(v); if (!picOk(p, v)) picsWrong++; return p })
// a picture must stay as it was after the cursor moves on (frozen, not aliased)
w.jump(0); w.jump(V); w.jump(cvs[6])
let frozenWrong = 0
pics.forEach((p, j) => { if (!picOk(p, pvs[j])) frozenWrong++ })
// the cursor itself after all the moves: at version cvs[6]
let cursorWrong = 0
{ const ws = want.get(cvs[6]); cks.forEach((k, j) => { if (JSON.stringify(w.at(k)) !== ws[j]) cursorWrong++ }) }
// the unsafe shortcut: hand out the cursor's own Map as the picture (no copy), then move the cursor
let nocopyChanged = null
if (w.cursorMap) { w.jump(pvs[0]); const m = w.cursorMap(); w.jump(Math.min(V, pvs[0] + 1000)); nocopyChanged = !picOk(m, pvs[0]) }
gw.stop()

const nsOf = (xs) => sumUp(xs)
out({
  exp: 'E-54', part: 'structs', way: WAY, K: K || null, rows: N, history: H, hot: HOT || undefined, node: process.version,
  gen_ms: Math.round(genMs), init_ms: Math.round(initMs),
  build: { ns_per_write: +(buildNs / H).toFixed(1), kept_mb: mb(h1 - h0), kept_b_per_version: +((h1 - h0) / H).toFixed(1), garbage_b_per_write: +(garbage / H).toFixed(1), gc: gcSummary(gw, 'build') },
  steady: { seconds: +steadyS.toFixed(1), written, per_s: Math.round(written / steadyS), write_cpu_share: +(writeMs / (steadyS * 1000)).toFixed(3), gc: gcSummary(gw, 'steady'), eld_ms: eldSummary(h), heap_mb: mb(h2), rss_mb: Math.round(process.memoryUsage().rss / 2 ** 20) },
  versions: V,
  ops_ns: { timer: nsOf(timer), back: nsOf(backNs), fwd: nsOf(fwdNs), jump: nsOf(jumpNs), read: nsOf(readNs), picture: nsOf(picNs), to_map: toMapNs && nsOf(toMapNs), read_hot: readHotNs && nsOf(readHotNs) },
  mean_ns: { back: backMean, fwd: fwdMean, jump: jumpMean, read: readMean },
  checks: { reads: readsChecked, reads_wrong: readsWrong, pictures: pvs.length, pictures_wrong: picsWrong, frozen_wrong: frozenWrong, cursor_wrong: cursorWrong, nocopy_picture_changed: nocopyChanged },
})
