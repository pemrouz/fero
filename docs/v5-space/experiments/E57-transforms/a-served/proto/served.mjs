// E-57 group A: served views (class C) and pushdown (class B), built small on data's real engine (data 63fea66, read
// only), on top of E-55's prototype (its data import, `D` and `SourceNode`, from proto/lens.mjs).
//
// What is here:
//   - a Copy: one replica of a resource. It folds a log commit by commit into data sources (depth 1: one source; depth
//     2: one per partition) and serves subscriptions:
//       class C: SUB { method, arg }: one ENTRY per (method, canonical argument, method version), shared by equal
//                calls, built by the method's `view` function over the copy's whole store (PLAN 3.1);
//       class B: SUB { part, ops }: a plain chain of operators over one partition, one entry per (part, chain);
//                past views.shapes the copy serves it as class A;
//       class A: SUB { part }: the partition's rows cross whole; the chain runs on the client.
//     An entry has an instance id unique across copies, a frame sequence, a ring of the last K frames, holders and
//     counts against views.client and views.max (lingering entries count), a linger, a data scope that owns every
//     data node the view made, and the size check of views.rows. One frame text per entry per commit, encoded once and
//     shared by every subscriber. A SUB answers from the ring, else (after waiting until the store reaches the
//     client's `seen`) with a picture.
//   - a Client: selections shared by equal calls; applies frames (with data's order channel: `at` on adds, `move`
//     records) and pictures (as ONE commit of differences); calls one sink per frame or picture with c = { diff, order }.
//   - the operators data does not have (PLAN N2, C3), built as small nodes outside data, as PLAN 9 says to:
//     by(field).sum(f) and by(field).length() with an exact sum per bucket and no empty buckets (C5), and an exact
//     sum (C3, E-23's Shewchuk partials).
// Every planted bug is a switch in E57_MUTATE (comma separated); none is ever set in a measured run.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { D, SourceNode } from '../../../E55-lens-prototype/proto/lens.mjs'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../../data', import.meta.url))
const KS = await import(pathToFileURL(DATA + '/kernel/scope.ts').href)
export { D, SourceNode, KS }
export const MUT = new Set((process.env.E57_MUTATE ?? '').split(',').filter(Boolean))

// ── canonical bytes of an argument (object keys sorted) ──────────────────────────────────────────────────
export function canon(v, sorted = true) {
  if (v === null || typeof v !== 'object') return v === undefined ? 'u' : JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => canon(x, sorted)).join(',') + ']'
  const ks = Object.keys(v)
  if (sorted) ks.sort()
  return '{' + ks.map((k) => JSON.stringify(k) + ':' + canon(v[k], sorted)).join(',') + '}'
}

// ── the exact sum (C3): E-23's ExactSum (src/lib.ts), Shewchuk's partials with Python's fsum rounding ─────────
export class ExactSum {
  constructor() { this.p = []; this.n = 0 }
  add(x) { this.n++; this.grow(x) }
  sub(x) { this.n--; this.grow(-x) }
  grow(x) {
    const p = this.p
    let i = 0
    for (let j = 0; j < p.length; j++) {
      let y = p[j]
      if (Math.abs(x) < Math.abs(y)) { const t = x; x = y; y = t }
      const hi = x + y
      const lo = y - (hi - x)
      if (lo !== 0) p[i++] = lo
      x = hi
    }
    p.length = i
    if (x !== 0 || i === 0) p.push(x)
  }
  value() {
    const partials = this.p
    let n = partials.length, hi = 0
    if (n > 0) {
      n--; hi = partials[n]
      let lo = 0
      while (n > 0) { const x = hi; n--; const y = partials[n]; hi = x + y; const yr = hi - x; lo = y - yr; if (lo !== 0) break }
      if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) { const y = lo * 2; const x = hi + y; const yr = x - hi; if (y === yr) hi = x }
    }
    return hi
  }
}
class FloatSum { constructor() { this.s = 0; this.n = 0 } add(x) { this.n++; this.s += x } sub(x) { this.n--; this.s -= x } value() { return this.s } } // planted: 'floatsum'
const newSum = () => (MUT.has('floatsum') ? new FloatSum() : new ExactSum())

// ── the comparators of C1: a number field, ties by row key (rows carry their key as `id`) ────────────────────
export const cmpDesc = (f) => (a, b) => { const x = a[f], y = b[f]; if (x !== y) return x > y ? -1 : 1; return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }
export const cmpAsc = (f) => (a, b) => { const x = a[f], y = b[f]; if (x !== y) return x < y ? -1 : 1; return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }

// ── prototype nodes: buckets with one aggregate, and an exact sum. Each is an effect on a data node (a source or
// a view), made inside the entry's data scope, so the scope's dispose ends it (data's own SubscriptionHandle). ─────
export class BucketNode {
  // keeps each row's (bucket, value) itself, so it never depends on a delta's `prev`
  constructor(parent, field, valField) {
    this.kind = 'buckets'; this.f = field; this.v = valField; this.b = new Map(); this.rows = new Map(); this.out = null
    parent.each((k, row) => this.add(k, row))
    this.sub = parent.connect({ wantsOrder: false, origin: null, apply: (batch) => this.apply(batch) })
  }
  acc(bk) { let a = this.b.get(bk); if (!a) { a = { s: this.v ? newSum() : null, n: 0 }; this.b.set(bk, a) } return a }
  add(k, row) { const bk = this.bk(row), x = this.v ? row[this.v] : 0; this.rows.set(k, [bk, x]); const a = this.acc(bk); a.n++; if (this.v) a.s.add(x) }
  del(k) { const [bk, x] = this.rows.get(k); this.rows.delete(k); const a = this.b.get(bk); a.n--; if (this.v) a.s.sub(x) }
  bk(row) { const x = row[this.f]; return typeof x === 'string' ? x : String(x) }
  val(bk) { const a = this.b.get(bk); return !a || a.n === 0 ? undefined : this.v ? a.s.value() : a.n }
  apply(batch) {
    const before = new Map()
    const touch = (bk) => { if (!before.has(bk)) before.set(bk, this.val(bk)) }
    for (const d of batch.rows) {
      const had = this.rows.get(d.key)
      if (had) { touch(had[0]); this.del(d.key) }
      if (d.op !== 'remove') { touch(this.bk(d.row)); this.add(d.key, d.row) }
    }
    const recs = []
    for (const [bk, old] of before) {
      const a = this.b.get(bk)
      if (a.n === 0) { if (!MUT.has('keepempty')) this.b.delete(bk); if (old !== undefined) recs.push(MUT.has('keepempty') ? ['b', bk, 0] : ['x', bk]) }
      else { const nv = this.val(bk); if (!Object.is(nv, old)) recs.push(['b', bk, nv]) }
    }
    if (recs.length && this.out) this.out(recs)
  }
  picture() { const r = []; for (const [bk, a] of this.b) if (a.n > 0 || MUT.has('keepempty')) r.push(['b', bk, this.v ? a.s.value() : a.n]); return r }
  size() { return this.b.size }
  connect(out) { this.out = out }
}
export class SumNode {
  constructor(parent, field) {
    this.kind = 'scalar'; this.f = field; this.s = newSum(); this.vals = new Map(); this.out = null
    parent.each((k, row) => { this.vals.set(k, row[field]); this.s.add(row[field]) })
    this.last = this.s.value()
    this.sub = parent.connect({ wantsOrder: false, origin: null, apply: (batch) => {
      for (const d of batch.rows) {
        if (this.vals.has(d.key)) { this.s.sub(this.vals.get(d.key)); this.vals.delete(d.key) }
        if (d.op !== 'remove') { this.vals.set(d.key, d.row[field]); this.s.add(d.row[field]) }
      }
      const v = this.s.value()
      if (!Object.is(v, this.last)) { this.last = v; if (this.out) this.out([['s', v]]) }
    } })
  }
  picture() { return [['s', this.s.value()]] }
  size() { return 1 }
  connect(out) { this.out = out }
}

// JSON has no undefined: an empty aggregate (max of no rows) travels as ['s'] with no value
const sRec = (v) => (v === undefined ? ['s'] : ['s', v])

// a data view as a served view: its picture (in order, with positions) and its wire records (data's wireSink, the
// order channel included: `at` on an add, `move` records)
export function adapt(v) {
  if (v instanceof BucketNode || v instanceof SumNode) return v
  const h = v, n = h[D.node]
  if (n.kind === 'scalar') {
    return {
      kind: 'scalar', node: n,
      picture: () => [sRec(h[D.value])],
      size: () => 1,
      connect(out) { let last = h[D.value]; n.connect({ wantsOrder: false, origin: null, apply: () => { const x = h[D.value]; if (!Object.is(x, last)) { last = x; out([sRec(x)]) } } }) },
    }
  }
  return {
    kind: 'rows', node: n,
    picture() {
      const order = n.currentOrder(), snap = n.snapshot(), out = []
      if (order) order.forEach((k, i) => out.push(['a', k, snap.get(k), i]))
      else n.each((k, row) => out.push(['a', k, row]))
      return out
    },
    size: () => n.rowCount(),
    connect(out) {
      D.wireSink(h, (b) => {
        if (b.seq === 0) return
        const recs = []
        for (const x of b.records) {
          if (x.t === 'add') recs.push(x.at === undefined ? ['a', x.k, x.v] : ['a', x.k, x.v, x.at])
          else if (x.t === 'remove') recs.push(['r', x.k])
          else if (x.t === 'update') recs.push(x.path?.length ? ['u', x.k, x.v, x.path] : ['u', x.k, x.v])
          else if (x.t === 'move') recs.push(['m', x.k, x.from, x.to])
        }
        if (recs.length) out(recs)
      }, { initial: false })
    },
  }
}

// ── the method tables (two versions, for redeploys). Per method: its version (F-17: per method, not per table), a
// shape id (what a typed client was compiled against), a cost class (XA-9), and the view. ctx has the copy's data
// only: no claims, no peer. ──────────────────────────────────────────────────────────────────────────────────────
export function table(tv) {
  const t = {
    best: { ver: 1, shape: 'row', cost: 'ordered', view: (n, ctx) => (MUT.has('arrival') ? ctx.data.za('points', Math.min(n, 100)) : ctx.data.az(cmpDesc('points'), Math.min(n, 100))) },
    after: { ver: 1, shape: 'row', cost: 'ordered', view: (cur, ctx) => { const c = cmpDesc('points'), at = { points: cur[0], id: cur[1] }; return ctx.data.filter((r) => c(r, at) > 0).az(c, 20) } },
    byTeam: { ver: 1, shape: 'num', cost: 'bucket', view: (_, ctx) => ctx.by('team').sum('pts') },
    spread: { ver: 1, shape: 'num', cost: 'bucket', view: (_, ctx) => ctx.by('pts').length() },
    total: { ver: 1, shape: 'num', cost: 'scalar', view: (_, ctx) => ctx.sum('pts') },
    mine: { ver: 1, shape: 'num', cost: 'scalar', view: (user, ctx) => ctx.data.filter((r) => r.name === user).length(), allow: (user, claims) => claims?.sub === user },
    band: { ver: 1, shape: 'num', cost: 'scalar', view: (a, ctx) => ctx.data.filter((r) => r.points >= a.lo && r.points <= a.hi).length() },
    // a handler (not a view): a view made inside the call ends with the call (PLAN K8)
    countAbove: { ver: 1, run: (t, ctx) => ctx.data.filter((r) => r.points > t).length()[D.value] },
  }
  if (tv >= 2) {
    // v2 changes two methods: best sorts by pts (and its shape changes: a typed v1 client is stale), byTeam sums points
    t.best = { ver: 2, shape: 'row2', cost: 'ordered', view: (n, ctx) => (MUT.has('arrival') ? ctx.data.za('pts', Math.min(n, 100)) : ctx.data.az(cmpDesc('pts'), Math.min(n, 100))) }
    t.byTeam = { ver: 2, shape: 'num', cost: 'bucket', view: (_, ctx) => ctx.by('team').sum('points') }
  }
  return t
}
// the impure view of XA-8: a threshold read from the copy's own clock when the view is built
export function impureTable(clock) {
  return { recent: { ver: 1, shape: 'row', cost: 'ordered', view: (_, ctx) => { const th = clock() - 30; return ctx.data.filter((r) => r.at > th).az(cmpDesc('at'), 10) }, threshold: () => clock() - 30 } }
}

// class B: a plain chain, as data calls on a partition (C1 comparators for az/za; the exact sum for sum)
export function buildChain(h, ops) {
  let cur = h
  for (const [op, ...a] of ops) {
    switch (op) {
      case 'gt': cur = cur.gt(a[0], a[1]); break
      case 'lt': cur = cur.lt(a[0], a[1]); break
      case 'between': cur = cur.between(a[0], [a[1], a[2]]); break
      case 'az': cur = MUT.has('arrival') ? cur.az(a[0], a[1]) : cur.az(cmpAsc(a[0]), a[1]); break
      case 'za': cur = MUT.has('arrival') ? cur.za(a[0], a[1]) : cur.az(cmpDesc(a[0]), a[1]); break
      case 'sum': return new SumNode(cur[D.node], a[0])
      case 'length': return cur.length()
      case 'max': return cur.max(a[0])
      case 'min': return cur.min(a[0])
      default: throw new Error('no op ' + op)
    }
  }
  return cur
}

// a count of data's live views on a source, from data's own graph: every node below it that is not disposed, plus
// the live effects on the source itself (the prototype nodes)
export function liveViews(src) {
  const seen = new Set(), stack = [...src.children]
  while (stack.length) { const n = stack.pop(); if (seen.has(n) || n.disposed) continue; seen.add(n); stack.push(...n.children) }
  return seen.size + src.effects.filter((e) => !e.dead).length
}

let copyIncarnations = 0 // for instance ids: (copy id, incarnation, counter) is unique across copies (F-4)

// ── the copy ──────────────────────────────────────────────────────────────────────────────────────────────
export class Copy {
  constructor(w, id) { this.w = w; this.id = id; this.alive = false; this.inc = 0 }
  start(rows, pos, tv, depth = 1) {
    this.inc = ++copyIncarnations; this.alive = true; this.depth = depth
    this.rt = new D.Runtime()
    if (depth === 1) { this.src = new SourceNode(this.rt, Object.fromEntries(rows)) }
    else { this.parts = new Map(); for (const [p, m] of rows) this.parts.set(p, new SourceNode(this.rt, Object.fromEntries(m))) }
    this.pos = pos; this.startPos = pos; this.folding = pos; this.tv = tv; this.table = this.w.tables(tv, this)
    this.entries = new Map(); this.counter = 0; this.pending = []; this.links = new Map(); this.cli = new Map()
    this.tooBig = new Set(); this.tooBigEver = new Set(); this.shapes = 0; this.costSum = 0
    this.deferred = [] // planted 'disposefirst': map deletes that run later
  }
  part(p) { let s = this.parts.get(p); if (!s) { s = new SourceNode(this.rt, {}); this.parts.set(p, s) } return s }
  // one log commit, one data commit; frames go out from the views' sinks during it
  fold(p, ops) {
    this.folding = p
    this.rt.batch(() => {
      for (const o of ops) {
        const s = this.depth === 1 ? this.src : this.part(o.p)
        if (o.del) { if (s.get(o.k) !== undefined) s.remove(o.k) }
        else if (o.f) s.write(o.k, [o.f], o.v)
        else s.write(o.k, [], o.row)
      }
    })
    this.pos = p
    this.checkSizes()
    this.servePending()
  }
  newInst() { this.counter++; return MUT.has('copyinst') ? String(this.counter) : this.id + '.' + this.inc + '.' + this.counter }
  ctx(src) {
    const data = D.handleFor(src)
    return { data, by: (f) => ({ sum: (v) => new BucketNode(src, f, v), length: () => new BucketNode(src, f, null) }), sum: (v) => new SumNode(src, v) }
  }
  keyOf(m, def) {
    if (m.cls === 'B') return 'B|' + m.part + '|' + canon(m.ops)
    if (m.cls === 'A') return 'A|' + m.part
    const a = canon(m.arg, !MUT.has('unsortedkey'))
    return MUT.has('nover') ? m.method + '|' + a : m.method + '|' + a + '|' + def.ver
  }
  // ── counts against the caps (incremental; the world checks them against an independent count) ──
  inc_(ci, d) { this.cli.set(ci, (this.cli.get(ci) ?? 0) + d) }
  countCopy() { if (!MUT.has('nolingercount')) return this.entries.size; let n = 0; for (const e of this.entries.values()) if (e.lingerAt === null) n++; return n }
  holdersAdd(e, ci) {
    const n = e.holders.get(ci) ?? 0
    e.holders.set(ci, n + 1)
    if (n > 0) return
    if (e.lingerAt !== null) {
      this.w.stats.lingerReuses = (this.w.stats.lingerReuses ?? 0) + 1 // a SUB inside the linger reuses the entry (A6)
      e.lingerAt = null
      if (MUT.has('nolingercount') || MUT.has('doubledec')) this.inc_(ci, 1) // the lingering entry was not counted
      else if (e.last !== ci) { this.inc_(e.last, -1); this.inc_(ci, 1) }
    } else this.inc_(ci, 1)
  }
  holdersDel(e, ci) {
    const n = e.holders.get(ci)
    if (n === undefined) return
    if (n > 1) { e.holders.set(ci, n - 1); return }
    e.holders.delete(ci)
    if (e.holders.size === 0) {
      e.lingerAt = this.w.t + this.w.cfg.linger; e.last = ci
      if (MUT.has('nolingercount') || MUT.has('doubledec')) this.inc_(ci, -1)
    } else this.inc_(ci, -1)
  }
  leaveMap(e) {
    if (this.entries.get(e.key) !== e) return
    this.entries.delete(e.key)
    if (e.cost) this.costSum -= e.cost
    if (e.cls === 'B') this.shapes--
    if (e.lingerAt !== null) { if (!MUT.has('nolingercount') && e.last !== null) this.inc_(e.last, -1) }
    else for (const ci of e.holders.keys()) this.inc_(ci, -1)
  }
  dispose(e) {
    if (e.dead) return
    e.dead = true
    e.scope.dispose()
    this.w.stats.disposed++
  }
  // ── admission: views.max (minus headroom for a view no client held), views.client, the cost budget (XA-9) ──
  admit(ci, held, cost) {
    const cfg = this.w.cfg
    const room = held || MUT.has('noheadroom') ? cfg.viewsMax : cfg.viewsMax - cfg.headroom
    // a SUB from a client that held this view (a failover moved it here) first evicts lingering entries, oldest first,
    // so repeated failovers inside one linger cannot fill the headroom with entries nobody holds (found by XA-2's sim:
    // 1 refusal of a held view in 1,000 seeds before this rule)
    if (held && !MUT.has('noevict')) while (this.countCopy() >= room) {
      let old = null
      for (const e of this.entries.values()) if (e.lingerAt !== null && (old === null || e.lingerAt < old.lingerAt)) old = e
      if (old === null) break
      this.w.stats.evicted = (this.w.stats.evicted ?? 0) + 1
      this.leaveMap(old); this.dispose(old)
    }
    let ok = this.countCopy() < room && (this.cli.get(ci) ?? 0) < cfg.viewsClient
    if (cfg.budget && !MUT.has('countonly')) ok = ok && this.costSum + cost <= cfg.budget
    this.w.checkAdmit(this, ci, held, cost, ok)
    return ok
  }
  build(key, m, def) {
    const cls = m.cls ?? 'C'
    const e = { key, cls, method: m.method, arg: m.arg, part: m.part, ops: m.ops, place: m.place ?? 'P|' + m.part, ver: def?.ver ?? 0, inst: this.newInst(), seq: 0, floor: 0, ring: [], att: new Map(), holders: new Map(), lingerAt: null, last: null, dead: false, scope: KS.scope(), copy: this, cost: 0 }
    let src = this.depth === 1 ? this.src : this.part(m.part)
    KS.runInScope(e.scope, () => {
      let v
      if (cls === 'I') e.view = adapt(D.handleFor(src).az(cmpDesc('points')))
      else if (cls === 'A') e.view = partView(src)
      else e.view = adapt(cls === 'B' ? buildChain(D.handleFor(src), m.ops) : def.view(m.arg, this.ctx(src)))
      if (cls !== 'I') e.view.connect((recs) => this.onViewRecs(e, recs)) // the shared page index sends no frames
    })
    if (def?.threshold) e.th = def.threshold() // XA-8: the impure view's threshold, read from this copy's clock at build
    if (cls === 'B') this.shapes++
    e.cost = cls === 'C' ? this.w.costOf(def, this) : 0
    this.costSum += e.cost
    this.entries.set(key, e)
    this.w.onBuild(this, e)
    return e
  }
  onViewRecs(e, recs) {
    const st = this.w.stats
    if (e.dead) { st.sinkAfterDispose++; return }
    if (e.cls === 'C' && this.table[e.method] && this.table[e.method].ver !== e.ver) { st.oldVersionFrames++; this.w.fail('oldVersionFrame') }
    e.seq++
    const ver = MUT.has('nover') ? this.table[e.method]?.ver ?? e.ver : e.ver
    const text = JSON.stringify({ i: e.inst, q: e.seq, p: this.folding, v: ver, r: recs })
    st.encodes++; st.frameBytes += text.length; st.frames++
    e.ring.push({ q: e.seq, text })
    if (e.ring.length > this.w.cfg.ring) e.floor = e.ring.shift().q
    // one send per link: a client routes a frame to every selection it holds on this instance
    const sent = new Set()
    for (const a of e.att.values()) if (a.live && !sent.has(a.linkId)) { sent.add(a.linkId); this.w.toClient(this, a.linkId, text); st.sends++ }
  }
  checkSizes() {
    const cap = this.w.cfg.viewsRows
    if (!cap) return
    for (const e of [...this.entries.values()]) if (!e.dead && e.cls === 'C' && e.view.kind !== 'scalar' && e.view.size() > cap) {
      this.w.stats.tooBig++
      this.tooBigEver.add(e.key)
      if (!MUT.has('nosticky')) this.tooBig.add(e.key)
      this.endEntry(e, 'view-too-big')
    }
  }
  // END to every subscriber, then out of the map, then dispose (in that order: H-55)
  endEntry(e, reason, to) {
    for (const a of e.att.values()) {
      this.w.toClient(this, a.linkId, { t: 'end', h: a.h, reason, to })
      const l = this.links.get(a.linkId)
      if (l) l.subs.delete(a.h)
    }
    this.pending = this.pending.filter((p) => p.key !== e.key)
    e.att.clear()
    this.leaveMap(e)
    this.dispose(e)
  }
  tick(t) {
    for (const d of this.deferred.splice(0)) { if (d.at > t) this.deferred.push(d); else this.leaveMap(d.e) }
    for (const e of [...this.entries.values()]) if (e.lingerAt !== null && t >= e.lingerAt) {
      if (MUT.has('disposefirst')) { if (!e.dead) { this.dispose(e); this.deferred.push({ at: t + 4, e }) } }
      else { this.leaveMap(e); this.dispose(e) }
    }
  }
  // ── the protocol ──
  link(linkId, ci) { let l = this.links.get(linkId); if (!l) { l = { id: linkId, ci, subs: new Map() }; this.links.set(linkId, l) } return l }
  dropLink(linkId) {
    const l = this.links.get(linkId)
    if (!l) return
    this.links.delete(linkId)
    for (const [h] of [...l.subs]) this.unsub(l, h)
    this.pending = this.pending.filter((p) => p.linkId !== linkId)
  }
  unsub(l, h) {
    const key = l.subs.get(h)
    l.subs.delete(h)
    this.pending = this.pending.filter((p) => !(p.linkId === l.id && p.h === h))
    const e = this.entries.get(key)
    if (!e) return
    e.att.delete(l.id + ':' + h)
    this.holdersDel(e, l.ci)
  }
  send(l, m) { this.w.toClient(this, l.id, m) }
  onMsg(linkId, ci, m) {
    const l = this.link(linkId, ci)
    const st = this.w.stats
    if (m.t === 'unsub') return this.unsub(l, m.h)
    if (m.t === 'call') {
      const def = this.table[m.method]
      let v
      if (MUT.has('handlerleak')) v = def.run(m.arg, this.ctx(this.src))
      else { const s = KS.scope(); try { v = KS.runInScope(s, () => def.run(m.arg, this.ctx(this.src))) } finally { s.dispose() } }
      st.calls++
      return this.send(l, { t: 'ret', id: m.id, v, p: this.pos })
    }
    if (m.t === 'sync') {
      const key = l.subs.get(m.h), e = this.entries.get(key)
      if (!e) return
      if (!MUT.has('earlysync') && this.pos < m.seen) { this.pending.push({ linkId, h: m.h, key, m, sync: true }); return }
      return this.send(l, { t: 'sync', h: m.h, i: e.inst, q: e.seq, p: this.pos, id: m.id })
    }
    if (m.t === 'get' && m.method === 'page' && !MUT.has('pageentry')) return this.pageRead(l, ci, m)
    if (m.t === 'get' && m.method === 'page') m = { ...m, method: 'after' }
    // sub or get
    const cls = m.cls ?? 'C'
    if (this.w.cfg.place && (cls !== 'C' || !MUT.has('freecopy'))) {
      const owner = this.w.owner(m.place)
      if (owner !== this.id) { st.movedAnswers++; return this.send(l, { t: 'end', h: m.h, reason: 'moved', to: owner }) }
    }
    let def = null
    if (cls === 'C') {
      def = this.table[m.method]
      if (!def || !def.view) return this.send(l, { t: 'ref', h: m.h, code: 'no-such-method' })
      if (!MUT.has('tableversion') && (m.minVer?.[m.method] ?? 0) > def.ver) { st.retryOld++; return this.send(l, { t: 'ref', h: m.h, code: 'retry' }) }
      if (m.shape && m.shape !== def.shape) { st.stale++; return this.send(l, { t: 'ref', h: m.h, code: 'stale-client' }) }
      if (def.allow && !MUT.has('allowonce') && !def.allow(m.arg, m.claims)) { st.denied++; return this.send(l, { t: 'ref', h: m.h, code: 'denied' }) }
    }
    const key = this.keyOf(m, def)
    if (this.tooBig.has(key)) return this.send(l, { t: 'ref', h: m.h, code: 'view-too-big' })
    let e = this.entries.get(key)
    let asA = false
    if (!e && cls === 'B' && this.shapes >= this.w.cfg.shapes) { asA = true; st.fallbacks++ } // past views.shapes: serve as class A
    if (asA) {
      const ka = 'A|' + m.part
      e = this.entries.get(ka)
      if (!e) { e = this.build(ka, { cls: 'A', part: m.part }, null) }
      this.send(l, { t: 'asA', h: m.h })
    } else if (!e) {
      if (cls === 'C' && !this.admit(ci, !!m.held, this.w.costOf(def, this))) { st.refusedCap++; return this.send(l, { t: 'ref', h: m.h, code: 'too-many-views' }) }
      if (cls === 'C' && def.allow && MUT.has('allowonce') && !def.allow(m.arg, m.claims)) { st.denied++; return this.send(l, { t: 'ref', h: m.h, code: 'denied' }) }
      e = this.build(key, m, def)
      if (e.view.kind !== 'scalar' && this.w.cfg.viewsRows && e.view.size() > this.w.cfg.viewsRows) { st.tooBig++; this.tooBigEver.add(key); if (!MUT.has('nosticky')) this.tooBig.add(key); this.leaveMap(e); this.dispose(e); return this.send(l, { t: 'ref', h: m.h, code: 'view-too-big' }) }
    } else {
      st.joins++
      // a join adds a view to this client's count unless it already holds the entry (or is the last holder of it
      // lingering): views.client counts live served views per client, joins included
      if (cls === 'C' && m.t !== 'get' && !e.holders.has(ci) && !(e.lingerAt !== null && e.last === ci)) {
        const ok = MUT.has('nojoincap') || (this.cli.get(ci) ?? 0) < this.w.cfg.viewsClient
        this.w.checkJoin(this, ci, ok)
        if (!ok) { st.refusedCap++; return this.send(l, { t: 'ref', h: m.h, code: 'too-many-views' }) }
      }
    }
    if (m.t === 'get') {
      // a get keeps nothing. An entry it built lingers, counted against this client (it was admitted for it); a get
      // that uses an entry already there changes no count (found by A5: shifting a lingering entry's count to the
      // getter let a client pass views.client)
      if (e.holders.size === 0 && e.lingerAt === null) { e.lingerAt = this.w.t + this.w.cfg.linger; e.last = ci; if (!(MUT.has('nolingercount') || MUT.has('doubledec'))) this.inc_(ci, 1) }
      st.gets++
      return this.answer(l, m.h, e, m, true)
    }
    l.subs.set(m.h, e.key)
    e.att.set(linkId + ':' + m.h, { linkId, h: m.h, ci, live: false })
    this.holdersAdd(e, ci)
    this.w.onAttach(this, e, ci, m)
    this.answer(l, m.h, e, m, false)
  }
  // XA-7: a page is a read of one shared ordered index (one per sort, not per cursor): a bisect for the cursor under
  // C1, then the next 20 keys. The index counts once against views.max and lingers; a page read holds nothing.
  pageRead(l, ci, m) {
    const st = this.w.stats
    if (this.pos < (m.seen ?? 0)) { this.pending.push({ linkId: l.id, h: m.h, key: 'IDX|points', m, page: true }); st.waits++; return }
    let e = this.entries.get('IDX|points')
    if (!e) {
      if (!this.admit(null, false, 0)) { st.refusedCap++; return this.send(l, { t: 'ref', h: m.h, code: 'too-many-views' }) }
      e = this.build('IDX|points', { cls: 'I', method: 'page', place: m.place }, { ver: 1, view: null })
      st.pageIndexes++
    }
    e.lingerAt = this.w.t + this.w.cfg.linger; e.last = null
    const n = e.view.node, order = n.currentOrder(), c = cmpDesc('points'), cur = { points: m.arg[0], id: m.arg[1] }
    let lo = 0, hi = order.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (c(n.rowAt(order[mid]), cur) <= 0) lo = mid + 1; else hi = mid }
    const r = []
    for (let i = lo; i < Math.min(lo + 20, order.length); i++) r.push(['a', order[i], n.rowAt(order[i]), i - lo])
    st.gets++; st.pageReads++
    this.send(l, { t: 'pic', h: m.h, i: e.inst, q: e.seq, p: this.pos, v: 1, k: 'rows', get: 1, r })
  }
  answer(l, h, e, m, get) {
    if (!MUT.has('noseenwait') && this.pos < (m.seen ?? 0)) { this.pending.push({ linkId: l.id, h, key: e.key, m, get }); this.w.stats.waits++; return }
    const st = this.w.stats, r = m.resume
    const a = e.att.get(l.id + ':' + h)
    if (!get && r && (r.inst === e.inst || MUT.has('noinstance')) && r.seq >= e.floor && r.seq <= e.seq) {
      // the resume answer carries the ring frames after the client's sequence (texts as encoded once)
      const fs = []
      for (const f of e.ring) if (f.q > r.seq) { fs.push(f.text); st.ringFrames++ }
      const text = '{"t":"res","h":' + h + ',"i":' + JSON.stringify(e.inst) + ',"q":' + e.seq + ',"p":' + this.pos + ',"f":[' + fs.join(',') + ']}'
      st.resumeBytes += text.length
      this.w.toClient(this, l.id, text)
      st.ringResumes++
    } else {
      const text = JSON.stringify({ t: 'pic', h, i: e.inst, q: e.seq, p: this.pos, v: e.ver, k: e.view.kind, get: get ? 1 : 0, r: e.view.picture() })
      st.pictures++; st.pictureBytes += text.length
      if (r) st.resumePictures++
      this.w.toClient(this, l.id, text)
    }
    if (a) a.live = true
  }
  servePending() {
    if (!this.pending.length) return
    const ps = this.pending; this.pending = []
    for (const p of ps) {
      if (this.pos < (p.m.seen ?? 0)) { this.pending.push(p); continue }
      const l = this.links.get(p.linkId), e = this.entries.get(p.key)
      if (!l || !e) continue
      if (p.page) { this.pageRead(l, null, p.m); continue }
      if (p.sync) this.send(l, { t: 'sync', h: p.h, i: e.inst, q: e.seq, p: this.pos, id: p.m.id })
      else this.answer(l, p.h, e, p.m, p.get)
    }
  }
  // a new method table (a deploy): entries whose method's version changed end `redeployed` (F-17: per method)
  deploy(tv) {
    this.tv = tv; this.table = this.w.tables(tv, this)
    if (MUT.has('nover')) return
    for (const e of [...this.entries.values()]) if (e.cls === 'C' && this.table[e.method]?.ver !== e.ver) this.endEntry(e, 'redeployed')
  }
  kill() {
    this.alive = false
    for (const e of [...this.entries.values()]) { this.leaveMap(e); this.dispose(e) }
  }
}

// class A: the partition's rows, as row records (no order)
function partView(src) {
  return {
    kind: 'rows', node: src,
    picture() { const out = []; src.each((k, row) => out.push(['a', k, row])); return out },
    size: () => src.rowCount(),
    connect(out) {
      src.connect({ wantsOrder: false, origin: null, apply: (b) => {
        const recs = []
        for (const d of b.rows) recs.push(d.op === 'add' ? ['a', d.key, d.row] : d.op === 'remove' ? ['r', d.key] : ['u', d.key, d.row])
        if (recs.length) out(recs)
      } })
    },
  }
}
