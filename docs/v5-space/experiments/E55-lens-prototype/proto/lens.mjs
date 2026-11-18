// E-55: a small prototype of the shape LENS.md recommends, on data's real engine (data at 63fea66).
//
// What is here (and only this):
//   - the lens: `f.data.a.b` is a Proxy per step over a callable target; a name is a key until it is called;
//     nothing is cached (no child map). A lens is NOT a promise: `then` and six other names that libraries probe
//     read as undefined (review F3), and a read is the verb `lens.get()`. `f.at(...keys)` is the same address
//     with no Proxy; it turns number keys into strings, as a property step does (review F23).
//   - writes on a path (`lens.set(v)`) and the array form `f.set(path, v)`, straight into data's SourceNode.write.
//   - selections: one per partition (depth 1: a row; depth 2: the first key) and one for the whole resource.
//     Equal lenses share one selection: a count, a linger, one upstream subscription, one fold, one commit object.
//   - D1: path subscriptions through a keyed index (one data sink per store, a Map from partition to selection).
//   - here(): a counted hold with a handle (`ready`, `rows`, `value`, `close()`); connect(target, fn | 'prop');
//     tap((c) => …). The commit object c: `first`, `changes` (data's RowDeltas by reference, with `prev`),
//     `now` (the selection's view), `recs()` and `text()` built once per commit and shared.
//   - lifetimes: close(), a scope, the target's own 'close', the count reaching zero (after a linger), and the
//     collector as a net (WeakRef + FinalizationRegistry). Before every delivery the link checks its target.
//   - a client role: a cache store fed by an upstream transport (loopback in-process here; MessagePort in net.mjs),
//     with `f.rows` showing only what is held on purpose (hold: 'all' or a server).
//   - methods on a path (`lens.sell(1)` runs the handler with ctx.at = that lens), `lens.call(name, arg)`.
// Not here: fero's kernel, ASKs, stages, sessions, durability, ops beyond incr, the near cache, asOf (asof.mjs).
import { pathToFileURL, fileURLToPath } from 'node:url'
import util from 'node:util'
import { EventEmitter } from 'node:events'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))
export const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
const KN = await import(pathToFileURL(DATA + '/kernel/node.ts').href)
export const SourceNode = KN.SourceNode
export const leafAt = KN.leafAt
export const VALUE = Symbol.for('fero.e55.value') // a sync read of what this process holds (benches, held reads)
const LENS = Symbol('fero.e55.lens')
const INSPECT = util.inspect.custom
const EMPTY = Object.freeze([])
export const UP = Symbol('fero.e55.upstream') // origin of cache writes made from upstream frames
export const HOT = { update: 0, insert: 1, remove: 2 }
// planted bugs, to show the seeded runs can fail (never set in a measured run): bornseq | settled | cover |
// weakread (a read is served from rows only a weak link holds: the first build's rule, review F1) |
// viewleak (a view right of here() outlives its handle: the first build, review F4)
const MUTATE = process.env.E55_MUTATE ?? ''

// ── errors with codes ──────────────────────────────────────────────────────────────────────────────
export class FeroError extends Error { constructor(code, msg) { super(`${code}: ${msg}`); this.code = code } }

// ── the collector as a net: real (WeakRef + FinalizationRegistry) or injected (the seeded adversary) ──
// token: unregister a link at close (costs about 4x a plain register); without it a closed link stays in the
// registry until its target is collected, and its finalizer then finds it already dead (the default here).
export function realWeak({ token = false } = {}) {
  const reg = new FinalizationRegistry((link) => link.end('collected'))
  return {
    ref: (t) => new WeakRef(t),
    register: token ? (t, link) => reg.register(t, link, link) : (t, link) => reg.register(t, link),
    unregister: token ? (link) => reg.unregister(link) : () => {},
  }
}

// ── scopes: links made inside end when the scope is disposed ─────────────────────────────────────────
let curScope = null
export function scope(fn) {
  const s = {
    links: new Set(),
    dispose() { const ls = [...this.links]; this.links.clear(); for (const l of ls) l.end('scope') },
  }
  if (fn) { const prev = curScope; curScope = s; try { fn() } finally { curScope = prev } }
  return s
}
export function inScope(s, fn) { const prev = curScope; curScope = s; try { return fn() } finally { curScope = prev } }

// ── plain-data operators (D7): may stand left of here(). Functions may not. ─────────────────────────
export const PLAIN = new Set(['gt', 'lt', 'gte', 'lte', 'between', 'az', 'za', 'top', 'limit', 'reverse', 'sum', 'avg', 'length', 'max', 'min'])
export const FUNCS = new Set(['filter', 'map', 'group', 'reduce', 'distinct', 'some', 'every', 'to'])

// ── the commit object: one per selection per commit, shared by every sink of it ─────────────────────
export class Commit {
  constructor(sel, deltas, seq, first, prefix) {
    this.sel = sel; this.seq = seq; this.first = first; this._d = deltas; this._recs = null; this._text = null
    this.prefix = prefix === undefined ? sel.prefix : prefix
  }
  // data's RowDeltas by reference ({ op, key, row, prev, path }). The first call: the picture so far, as adds.
  get changes() { return this._d === null ? (this._d = this.sel.pictureDeltas()) : this._d }
  get now() { return this.sel.view }
  recs() {
    if (this._recs === null) { this._recs = toRecs(this.changes, this.prefix); this.sel.eng.stats.recs++ }
    return this._recs
  }
  text() {
    if (this._text === null) { this._text = JSON.stringify(this.recs()); this.sel.eng.stats.texts++ }
    return this._text
  }
}

// RowDeltas → wire records [type, path, value] (data's HOT lane shape; path is [partition?, row, ...fields])
export function toRecs(ds, prefix) {
  const out = new Array(ds.length)
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i]
    const pre = d.part !== undefined ? d.part : prefix
    const k = pre === null ? [d.key] : [pre, d.key]
    if (d.op === 'add') out[i] = [HOT.insert, k, d.row]
    else if (d.op === 'remove') out[i] = [HOT.remove, k]
    else if (d.deleted === true) out[i] = [HOT.remove, k.concat(d.path)]
    else if (d.path.length > 0) out[i] = [HOT.update, k.concat(d.path), leafAt(d.row, d.path)]
    else out[i] = [HOT.update, k, d.row]
  }
  return out
}

// ── a store: data's source(s) plus the selection machinery. Used by servers and by client caches. ────
// depth 1: one SourceNode; a partition is a row; path subscriptions go through ONE data sink and a Map (D1).
// depth 2: one SourceNode per partition (a two-level store, D3); a partition selection sinks its own source.
export class Store {
  constructor({ depth = 1, seed = {}, runtime = null, linger = 0, weak = null, timers = null, name = 'r', dev = false } = {}) {
    this.name = name
    this.dev = dev // dev checks: a DOM target that stays detached while its link lives (the capture trap's one visible sign)
    this.depth = depth
    this.rt = runtime ?? D.runtime()
    this.linger = linger
    this.weak = weak ?? realWeak()
    this.timers = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }
    this.stats = { selsMade: 0, selsDropped: 0, recs: 0, texts: 0, deliveries: 0, netEnded: 0, collected: 0, checkEnded: 0, firsts: 0, covered: 0, resubs: 0, evicted: 0 }
    this.warnings = [] // dev warnings, one per path (warnCount counts them)
    this.warnCount = new Map()
    this.sels = new Map() // partition key → Sel (the keyed index)
    this.all = null // the whole-resource selection
    this.routing = null // depth 1: the one data sink that routes row deltas to selections
    this.upstream = null // a client cache: the transport
    if (depth === 1) {
      this.src = new SourceNode(this.rt, seed)
    } else {
      this.parts = new Map()
      for (const p of Object.keys(seed)) this.parts.set(p, new SourceNode(this.rt, seed[p]))
    }
  }
  promote() { if (this.depth === 1) this.src.promote(); else for (const s of this.parts.values()) s.promote() }

  // the source holding partition p (depth 2), made on first write
  part(p, make) {
    let s = this.parts.get(p)
    if (s === undefined && make) { s = new SourceNode(this.rt, {}); this.parts.set(p, s); if (this.all !== null && this.all.sinks !== null) this.all.sinkPart(p, s) }
    return s
  }

  // ── reads ──
  readSync(path) {
    if (path.length === 0) return this.depth === 1 ? this.src.snapshot() : this.parts
    if (this.depth === 1) {
      const row = this.src.get(path[0])
      return path.length === 1 ? row : leafAt(row, path.slice(1))
    }
    const s = this.parts.get(path[0])
    if (s === undefined) return undefined
    if (path.length === 1) return s
    const row = s.get(path[1])
    return path.length === 2 ? row : leafAt(row, path.slice(2))
  }
  rowOf(part, key) { return this.depth === 1 ? (part === key || part === null ? this.src.get(key) : undefined) : this.parts.get(part)?.get(key) }

  // ── writes: straight into data's SourceNode.write (one commit outside a batch) ──
  write(path, v) {
    if (this.depth === 1) {
      if (path.length === 0) throw new FeroError('bad-path', 'a write needs a row key')
      if (typeof v === 'function') v = v(this.readSync(path))
      this.src.write(path[0], path.length === 1 ? EMPTY : path.slice(1), v)
      return
    }
    if (path.length < 2) throw new FeroError('bad-path', 'a depth-2 write needs a partition and a row')
    if (typeof v === 'function') v = v(this.readSync(path))
    this.part(path[0], true).write(path[1], path.length === 2 ? EMPTY : path.slice(2), v)
  }
  remove(path) {
    if (this.depth === 1) return this.src.remove(path[0], path.length > 1 ? path.slice(1) : undefined)
    const s = this.parts.get(path[0])
    if (s !== undefined) s.remove(path[1], path.length > 2 ? path.slice(2) : undefined)
  }
  // apply wire records (from upstream) in one data commit per source
  applyRecs(recs) {
    const go = () => {
      for (const r of recs) {
        const k = r[1]
        if (r[0] === HOT.remove) this.remove(k)
        else this.write(k, r[2])
      }
    }
    this.rt.withOrigin(UP, () => this.rt.batch(go))
  }

  // ── selections ──
  // the partition a path falls in; null = the whole resource
  partOf(path) { return path.length === 0 ? null : path[0] }
  sel(part) {
    if (part === null) { if (this.all === null) { const s = this.makeSel(null); this.all = s } return this.all }
    let s = this.sels.get(part)
    if (s === undefined) { s = this.makeSel(part); this.sels.set(part, s) }
    return s
  }
  // A client: one SUB per selection, EXCEPT a partition inside a live whole-resource selection: it is covered
  // (no SUB; ready when the whole is). When the whole ends, the partitions it covered SUB again, and rows no
  // live selection names are evicted. (Found by claim 7's sim: without this the two overlap.)
  makeSel(part) {
    const s = new Sel(this, part)
    this.stats.selsMade++
    if (this.upstream === null) s.ready = true
    else if (part !== null && this.all !== null && !this.all.dropped && MUTATE !== 'cover') {
      s.covered = true; this.stats.covered++
      if (this.all.ready) s.ready = true; else this.all.dependents.push(s)
    } else {
      if (part === null) this.all = s // set before the picture can arrive (a loopback answers at once)
      this.upstream.sub(s)
    }
    s.attachLocal()
    return s
  }
  dropSel(s) {
    if (s.count > 0 || s.dropped) return
    s.dropped = true
    s.flushReads()
    this.stats.selsDropped++
    s.detachLocal()
    if (s.part === null) {
      this.all = null
      if (this.upstream !== null) {
        this.upstream.unsub(s)
        for (const ps of this.sels.values()) if (ps.covered && !ps.dropped) { ps.covered = false; ps.upSeq = s.upSeq; this.stats.resubs++; this.upstream.sub(ps) } // resume from the whole's position
        this.evictUnheld()
      }
    } else {
      this.sels.delete(s.part)
      if (this.upstream !== null) { if (!s.covered) this.upstream.unsub(s); if (this.all === null) this.evict(s.part) }
    }
  }
  // drop rows from a client cache once no live selection names them
  evict(part) {
    const doomed = this.depth === 1 ? (this.src.hasRow(part) ? [[part]] : []) : [...(this.parts.get(part)?.snapshot().keys() ?? [])].map((k) => [part, k])
    if (doomed.length === 0) return
    this.stats.evicted += doomed.length
    this.rt.withOrigin(UP, () => this.rt.batch(() => { for (const p of doomed) this.remove(p) }))
  }
  evictUnheld() {
    const parts = this.depth === 1 ? [...this.src.snapshot().keys()] : [...this.parts.keys()]
    for (const p of parts) if (!this.sels.has(p)) this.evict(p)
  }
  // a picture from upstream: rows equal to what the cache holds are skipped; rows the cache holds in this
  // selection's scope but the picture lacks are removed (a resubscribe after a gap)
  applyPicture(sel, recs) {
    const J = JSON.stringify
    const seen = new Set()
    this.rt.withOrigin(UP, () => this.rt.batch(() => {
      for (const r of recs) {
        const k = r[1]
        seen.add(J(k))
        const cur = this.readSync(k)
        if (cur !== undefined && J(cur) === J(r[2])) continue
        this.write(k, r[2])
      }
      const scopeKeys = sel.part === null
        ? (this.depth === 1 ? [...this.src.snapshot().keys()].map((k) => [k]) : [...this.parts].flatMap(([p, ps]) => [...ps.snapshot().keys()].map((k) => [p, k])))
        : (this.depth === 1 ? (this.src.hasRow(sel.part) ? [[sel.part]] : []) : [...(this.parts.get(sel.part)?.snapshot().keys() ?? [])].map((k) => [sel.part, k]))
      for (const k of scopeKeys) if (!seen.has(J(k))) this.remove(k)
    }))
  }
  ensureRouting() {
    if (this.routing !== null) return
    const idx = this.sels
    this.routing = this.src.connect({
      wantsOrder: false,
      origin: null,
      apply: (b) => {
        const rows = b.rows
        if (rows.length === 1) { const s = idx.get(rows[0].key); if (s !== undefined) s.deliver(rows, b.seq); return }
        let touched = null
        for (let i = 0; i < rows.length; i++) {
          const d = rows[i], s = idx.get(d.key)
          if (s === undefined) continue
          if (s.pend === null) { s.pend = [d]; (touched ??= []).push(s) } else s.pend.push(d)
        }
        if (touched !== null) for (const s of touched) { const p = s.pend; s.pend = null; s.deliver(p, b.seq) }
      },
    })
  }
}

// ── a selection: what one upstream subscription brings, shared by every equal lens in this process ──
export class Sel {
  constructor(eng, part) {
    this.eng = eng; this.part = part; this.links = []; this.count = 0; this.lingerH = null
    this.pend = null; this.ready = false; this.waiting = []; this.dropped = false; this.sink = null
    this.seq = 0 // the last commit (upstream seq on a client) this selection applied
    this.prefix = eng.depth === 2 && part !== null ? part : null
    this._view = null
    this.covered = false; this.dependents = []; this.sinks = null; this.deadN = 0
    this.strong = 0 // live here() holds and taps on this selection: what "held on purpose" means for a read
    this.rw = null // reads waiting for this selection's first picture
  }
  sinkPart(p, ps) { this.sinks.push(ps.connect({ wantsOrder: false, origin: null, apply: (b) => this.deliver(b.rows, b.seq, p) })) }
  get view() { return (this._view ??= new View(this)) }
  attachLocal() {
    const e = this.eng
    if (this.part === null) {
      if (e.depth !== 1) { this.sinks = []; for (const [p, ps] of e.parts) this.sinkPart(p, ps); return } // depth 2: one sink per partition
      this.sink = e.src.connect({ wantsOrder: false, origin: null, apply: (b) => this.deliver(b.rows, b.seq) })
    } else if (e.depth === 1) {
      e.ensureRouting()
    } else {
      const ps = e.part(this.part, true)
      this.sink = ps.connect({ wantsOrder: false, origin: null, apply: (b) => this.deliver(b.rows, b.seq) })
    }
  }
  detachLocal() { if (this.sink !== null) { this.sink.dispose(); this.sink = null } if (this.sinks !== null) { for (const h of this.sinks) h.dispose(); this.sinks = null } }
  acquire() { this.count++; if (this.lingerH !== null) { this.eng.timers.clear(this.lingerH); this.lingerH = null } }
  release() {
    if (--this.count > 0) return
    const e = this.eng
    if (e.linger <= 0) e.dropSel(this)
    else this.lingerH = e.timers.set(() => { this.lingerH = null; e.dropSel(this) }, e.linger)
  }
  // the rows this selection holds, as data RowDeltas of kind add (the first picture)
  pictureDeltas() {
    const e = this.eng, out = []
    if (this.part === null && e.depth === 2) { for (const [p, ps] of e.parts) ps.each((key, row) => out.push({ op: 'add', key, row, part: p })) }
    else if (this.part === null) e.src.each((key, row) => out.push({ op: 'add', key, row }))
    else if (e.depth === 1) { const row = e.src.get(this.part); if (row !== undefined) out.push({ op: 'add', key: this.part, row }) }
    else e.part(this.part, false)?.each((key, row) => out.push({ op: 'add', key, row }))
    return out
  }
  rowCount() {
    const e = this.eng
    if (this.part === null) return e.src.rowCount()
    if (e.depth === 1) return e.src.hasRow(this.part) ? 1 : 0
    return e.part(this.part, false)?.rowCount() ?? 0
  }
  deliver(deltas, seq, prefix) {
    this.seq = seq
    const ls = this.links
    if (ls.length === 0) return
    const c = new Commit(this, deltas, seq, false, prefix)
    for (let i = 0; i < ls.length; i++) { const L = ls[i]; if (L.dead === false) L.feed(c) }
  }
  becameReady() {
    this.ready = true
    const e = this.eng
    if (this.part === null && e.upstream !== null) {
      // the whole now covers every partition selection: their own SUBs end (their rows stay)
      for (const ps of e.sels.values()) if (!ps.covered && !ps.dropped) { e.upstream.unsub(ps); ps.covered = true; e.stats.covered++ }
      const deps = this.dependents; this.dependents = []
      for (const d of deps) if (!d.dropped) d.becameReady()
    }
    const w = this.waiting; this.waiting = []
    for (const L of w) if (!L.dead) L.attach()
    this.flushReads()
  }
  flushReads() { const rw = this.rw; if (rw !== null) { this.rw = null; for (const f of rw) f() } }
  // a dead link is skipped where it stands; the array is compacted once half of it is dead (O(1) amortized)
  unlink(L) { if (++this.deadN * 2 > this.links.length) { this.links = this.links.filter((x) => !x.dead); this.deadN = 0 } }
}

// c.now: the selection's rows, read where they are held. A lookup, never a copy.
class View {
  constructor(sel) { this.sel = sel; this._rows = null }
  get rows() {
    const sel = this.sel, e = sel.eng
    return (this._rows ??= new Proxy(Object.create(null), {
      get: (_, k) => (typeof k === 'string' ? e.rowOf(sel.part, k) : undefined),
      ownKeys: () => sel.pictureDeltas().map((d) => String(d.key)),
      getOwnPropertyDescriptor: (_, k) => { const v = e.rowOf(sel.part, k); return v === undefined ? undefined : { value: v, enumerable: true, configurable: true } },
    }))
  }
  get value() { const s = this.sel; return s.part !== null && s.eng.depth === 1 ? s.eng.src.get(s.part) : this.rows }
}

// ── a link: one live connection from a lens to a target (or a tap, or a bare hold) ──────────────────
let linkIds = 0
export class Link {
  constructor(sel, path, kind, target, fn, prop, opts) {
    this.id = ++linkIds
    this.sel = sel; this.path = path; this.kind = kind; this.fn = fn; this.prop = prop
    this.dead = false; this.bornSeq = -1; this.ref = null; this.strong = null; this.onClose = null; this.closeEv = 'close'; this.onEnd = null
    // held on purpose (review F1): a here() hold or a tap ends only by close() or a scope, never by the collector.
    // A connect link is weak: it never counts, so a read is never served from rows only the net is keeping.
    if (kind !== 'connect') sel.strong++
    this.sub = null // the path below the selection's partition (for 'prop' and field links)
    this.detached = 0
    const e = sel.eng
    const depthCut = e.depth === 1 ? 1 : 2
    if (path.length > depthCut) this.sub = path.slice(depthCut)
    this.rowKey = path.length >= depthCut ? path[depthCut - 1] : null
    if (kind === 'connect') {
      this.ref = e.weak.ref(target)
      e.weak.register(target, this)
      // the target says it closed: end at once. Only for the kinds named here (review F19): a Node EventEmitter
      // (sockets, streams, the `ws` library), a WebSocket, a MessagePort. Any other object is left alone unless
      // the caller names its event: connect(target, fn, { closes: 'close' }). `closes: false` switches it off.
      const ev = opts?.closes
      if (ev !== false) {
        const emitter = target instanceof EventEmitter
        const evTarget = !emitter && ((typeof WebSocket === 'function' && target instanceof WebSocket) || (typeof MessagePort === 'function' && target instanceof MessagePort))
        if (emitter || (typeof ev === 'string' && typeof target.once === 'function')) { this.onClose = () => this.end('target-closed'); this.closeEv = ev ?? 'close'; target.once(this.closeEv, this.onClose) }
        else if (evTarget || (typeof ev === 'string' && typeof target.addEventListener === 'function')) { this.onClose = () => this.end('target-closed'); this.closeEv = ev ?? 'close'; target.addEventListener(this.closeEv, this.onClose, { once: true }) }
      }
    }
    this.scope = curScope
    if (curScope !== null) curScope.links.add(this)
    sel.acquire()
    this._readyP = null; this._res = null; this.attached = false
  }
  // made only when asked for: most links never await it
  get ready() {
    if (this._readyP === null) this._readyP = this.attached ? Promise.resolve() : new Promise((r) => (this._res = r))
    return this._readyP
  }
  _ready() { this.attached = true; if (this._res !== null) { this._res(); this._res = null } }
  // first delivery: the picture so far (clause 7: inside an open batch, at the batch's commit)
  attach() {
    const sel = this.sel
    if (this.dead) return
    if (!sel.ready) { sel.waiting.push(this); return }
    const rt = sel.eng.rt
    if (rt.midBatch && MUTATE !== 'settled') rt.attachWhenSettled(() => this.first())
    else this.first()
  }
  first() {
    if (this.dead) return
    const sel = this.sel
    this.bornSeq = sel.eng.rt.connectSeq() // a link made inside a commit's effects: its picture holds that commit
    sel.links.push(this)
    sel.eng.stats.firsts++
    if (this.kind !== 'held') this.feed(new Commit(sel, null, sel.seq, true), true)
    this._ready()
  }
  feed(c, isFirst = false) {
    if (!isFirst && c.seq === this.bornSeq && MUTATE !== 'bornseq') return
    let t
    if (this.ref !== null) {
      t = this.ref.deref()
      if (t === undefined) { this.end('check'); return } // the net, rule 1: a dead target is never called
      if (this.sel.eng.dev && t.isConnected === false && ++this.detached === 3)
        this.sel.eng.warnings.push(`dev: a link on ${this.sel.eng.name}.${this.path.join('.')} feeds a detached DOM node that is still alive: does its function close over its target?`)
    }
    if (this.kind === 'held') return
    // a row or field lens: only commits that touch its row (and, below the row, its leaf)
    if (this.rowKey !== null && this.sel.part !== this.rowKey) {
      let hit = isFirst
      if (!hit) { const ds = c.changes; for (let i = 0; i < ds.length; i++) if (ds[i].key === this.rowKey) { hit = true; break } }
      if (!hit) return
    }
    this.sel.eng.stats.deliveries++
    if (this.prop !== null) {
      const v = this.valueNow()
      if (isFirst || !Object.is(t[this.prop], v)) t[this.prop] = v
      return
    }
    if (this.kind === 'tap') this.fn(c)
    else this.fn(t, c)
  }
  valueNow() {
    const e = this.sel.eng
    const row = e.rowOf(this.sel.part, this.rowKey ?? this.sel.part)
    return this.sub === null ? row : leafAt(row, this.sub)
  }
  end(reason) {
    if (this.dead) return
    this.dead = true
    const e = this.sel.eng
    if (reason === 'collected' || reason === 'check') {
      e.stats.netEnded++
      if (reason === 'collected') e.stats.collected++; else e.stats.checkEnded++
      const w = `the net ended links on ${e.name}.${this.path.join('.')}: close them, or end them with a scope`
      e.warnCount.set(w, (e.warnCount.get(w) ?? 0) + 1)
      if (e.warnCount.get(w) === 1) e.warnings.push(w)
    }
    if (this.ref !== null && reason !== 'collected') e.weak.unregister(this)
    if (this.onClose !== null) { const t = this.ref?.deref(); if (t) (t.off ?? t.removeListener ?? t.removeEventListener)?.call(t, this.closeEv, this.onClose) }
    if (this.kind !== 'connect') this.sel.strong--
    if (this.onEnd !== null) { const f = this.onEnd; this.onEnd = null; f() }
    this.scope?.links.delete(this)
    this.sel.unlink(this)
    const i = this.sel.waiting.indexOf(this); if (i >= 0) this.sel.waiting.splice(i, 1)
    this.fn = null // let go of the user's function at once
    this.sel.release()
  }
  close() { this.end('close') }
}

// ── the handle here() gives: a counted hold, read through it ────────────────────────────────────────
export class Held {
  constructor(r, path) {
    this.r = r; this.path = path
    const e = r.eng
    this.sel = e.sel(e.partOf(path))
    this.link = new Link(this.sel, path, 'held', null, null, null)
    this.link.attach()
  }
  get ready() { return this.link.ready }
  get rows() { return this.sel.view.rows }
  get value() { return this.r.eng.readSync(this.path) }
  get [VALUE]() { return this.r.eng.readSync(this.path) }
  close() { this.link.end('close') }
  // D6 (review F4): every view made from this handle, and every sink on one, ends when the handle ends
  // (close(), its scope). The first build left them running: V4-54's dead filter.
  own(x) { if (this.owned === undefined) { this.owned = new Set(); if (MUTATE !== 'viewleak') this.link.onEnd = () => { const o = [...this.owned]; this.owned.clear(); for (const y of o) y.end('handle') } } this.owned.add(x); return x }
  tap(fn) { const L = new Link(this.sel, this.path, 'tap', null, fn, null); L.attach(); return L }
  connect(target, fnOrProp, opts) { return this.r.connectAt(this.path, target, fnOrProp, opts) }
  // operators right of here(): data's own views on the held rows, run here
  op(name, args) { return new LocalView(this, [[name, args]]) }
}
for (const name of [...PLAIN, ...FUNCS]) Held.prototype[name] = function (...args) { return this.op(name, args) }

// a data view right of here(): its own commit object per view batch; tap/connect like a held selection.
// It belongs to the handle it was made from (D6): the handle's end releases the view (the data node is disposed
// when its last user lets go) and ends every sink on it.
export class LocalView {
  constructor(held, ops, ownsHeld = false) {
    this.held = held; this.ops = ops; this.ownsHeld = ownsHeld; this.dead = false
    this.key = JSON.stringify([held.path, ops])
    this.h = held.r.localView(held.path, ops, this.key); this.node = this.h[D.node]
    this.sinks = new Set()
    held.own(this)
  }
  get ready() { return this.held.ready }
  get rows() { return this.h[D.value] }
  get value() { return this.h[D.value] }
  op(name, args) { return new LocalView(this.held, [...this.ops, [name, args]]) }
  // one sink on the view: fn(c) per view batch, the first call with the picture so far
  sinkOn(deliver) {
    const node = this.node, self = this
    if (node.kind === 'scalar') {
      deliver({ first: true, changes: EMPTY, now: self, seq: 0 })
      return node.connect({ wantsOrder: false, origin: null, apply: (b) => deliver({ first: false, changes: EMPTY, now: self, seq: b.seq }) })
    }
    return this.h.sink({ init: () => { deliver({ first: true, get changes() { const o = []; node.each((key, row) => o.push({ op: 'add', key, row })); return o }, now: self, seq: 0 }) }, apply: (b) => deliver({ first: false, changes: b.rows, now: self, seq: b.seq }) })
  }
  // a strong sink: until close(), its scope, or the handle's end
  tap(fn) { return new ViewLink(this, null, fn, null) }
  // a weak link: also ends with its target (the net), like connect on a selection
  connect(target, fnOrProp, opts) {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) throw new FeroError('bad-target', 'connect(target, …) needs an object to feed')
    return typeof fnOrProp === 'string' ? new ViewLink(this, target, null, fnOrProp, opts) : new ViewLink(this, target, fnOrProp, null, opts)
  }
  end() {
    if (this.dead) return
    this.dead = true
    for (const l of [...this.sinks]) l.end('handle')
    this.held.r.releaseView(this.key)
  }
  close() { this.held.close() }
}
// a link on a view right of here(): strong (tap) or weak (connect). The same five ways to end as a Link.
export class ViewLink {
  constructor(view, target, fn, prop, opts) {
    this.view = view; this.fn = fn; this.prop = prop; this.dead = false; this.ref = null; this.h = null
    const e = view.held.r.eng
    if (target !== null) { this.ref = e.weak.ref(target); e.weak.register(target, this) }
    this.scope = curScope
    if (curScope !== null) curScope.links.add(this)
    view.sinks.add(this)
    const h = view.sinkOn((c) => this.feed(c))
    if (this.dead) h?.dispose?.(); else this.h = h
  }
  feed(c) {
    if (this.dead) return
    const e = this.view.held.r.eng
    if (this.ref === null) { e.stats.deliveries++; this.fn(c); return }
    const t = this.ref.deref()
    if (t === undefined) { this.end('check'); return } // the net, rule 1
    e.stats.deliveries++
    if (this.prop !== null) t[this.prop] = c.now.value
    else this.fn(t, c)
  }
  end(reason) {
    if (this.dead) return
    this.dead = true
    const e = this.view.held.r.eng
    if (reason === 'collected' || reason === 'check') { e.stats.netEnded++; if (reason === 'collected') e.stats.collected++; else e.stats.checkEnded++ }
    if (this.h !== null) { this.h.dispose(); this.h = null }
    this.scope?.links.delete(this)
    this.view.sinks.delete(this)
    this.fn = null
    // a link made by `lens.gt(…).connect(target, fn)` owns its handle: the handle (and the view) end with it
    if (this.view.ownsHeld && this.view.sinks.size === 0 && reason !== 'handle') this.view.held.close()
  }
  close() { this.end('close') }
}
for (const name of [...PLAIN, ...FUNCS]) LocalView.prototype[name] = function (...args) { return this.op(name, args) }

// ── the lens: an address. A Proxy per step over a callable target. Caches nothing. ────────────────────
// target fields: r (the resource), up (the parent target, or null at the root), k (this step's key),
// p (this lens's own path, built on first use). A step allocates one function, one Proxy, nothing more.
function inspectLens() { const t = this[LENS]; return `Lens(${t.r.name}${pathOf(t).map((k) => '.' + String(k)).join('')})` }
export function pathOf(t) {
  if (t.p !== null) return t.p
  if (t.up === null) return (t.p = EMPTY)
  const up = pathOf(t.up), p = new Array(up.length + 1)
  for (let i = 0; i < up.length; i++) p[i] = up[i]
  p[up.length] = t.k
  return (t.p = p)
}
function step(r, up, k) {
  const t = function () {}
  t.r = r; t.up = up; t.k = k; t.p = null; t[INSPECT] = inspectLens
  return new Proxy(t, H)
}
const H = {
  get(t, k) {
    if (typeof k === 'symbol') {
      if (k === VALUE) return t.r.eng.readSync(pathOf(t))
      if (k === LENS) return t
      if (k === INSPECT) return inspectLens
      if (k === Symbol.toPrimitive) return () => `${t.r.name}${pathOf(t).map((x) => '.' + String(x)).join('')}`
      return undefined
    }
    // names that JavaScript or libraries probe on any object read as undefined, so a lens is never taken for a
    // promise (await, an async function's return, Promise.all), a Svelte store, a React element, a Jest matcher,
    // a DOM node, or something with its own JSON form (review F3). A key so named takes at().
    switch (k) { case 'then': case 'toJSON': case 'constructor': case '$$typeof': case 'asymmetricMatch': case 'nodeType': case 'subscribe': return undefined }
    return step(t.r, t, k)
  },
  apply(t, _this, args) {
    if (t.up === null) throw new FeroError('not-a-verb', 'the root lens is not callable')
    return callVerb(t.r, pathOf(t.up), t.k, args)
  },
  // plain assignment still writes (untyped code): f.data.k.f = v
  set(t, k, v) { if (typeof k === 'symbol') return false; t.r.set([...pathOf(t), k], v); return true },
  deleteProperty(t, k) { t.r.remove([...pathOf(t), k]); return true },
}

// verbs win over methods; a method named like a verb is reached by call(name, arg)
const VERBS = {
  get: (r, p) => r.read(p), // read once: here if held on purpose, else one trip. Keeps nothing
  set: (r, p, a) => r.set(p, a[0], a[1]),
  remove: (r, p) => r.remove(p),
  here: (r, p) => r.here(p),
  connect: (r, p, a) => r.connectAt(p, a[0], a[1], a[2]),
  tap: (r, p, a) => r.tapAt(p, a[0]),
  at: (r, p, a) => { let l = r.lensAt(p); for (const k of a) l = step(r, l[LENS], atKey(k)); return l },
  call: (r, p, a) => r.callMethod(a[0], a[1], p),
}
// at() keys: a number becomes its string, as a property step does (f.data[1] is f.data['1']); a symbol stays;
// anything else is refused, so at(1, 'n') and data[1].n are one address and one leader (review F23)
export function atKey(k) {
  if (typeof k === 'string' || typeof k === 'symbol') return k
  if (typeof k === 'number' && Number.isFinite(k)) return String(k)
  throw new FeroError('bad-key', `at(): a key is a string or a finite number, not ${k === null ? 'null' : typeof k}`)
}
function callVerb(r, p, name, args) {
  const v = VERBS[name]
  if (v !== undefined) return v(r, p, args)
  if (PLAIN.has(name)) return new Selection(r, p, [[name, args]])
  if (FUNCS.has(name)) throw new FeroError('unencodable', `${name}(fn) left of here(): code cannot travel. Put it right of here(), or in a method`)
  if (r.methods !== null && Object.hasOwn(r.methods, name)) return r.callMethod(name, args[0], p)
  throw new FeroError('not-a-verb', `${String(name)}() on ${r.name}.${p.join('.')}: no such verb or method`)
}

// operators left of here(): plain data, written down (D7). The first build serves class B as A: the partition
// is held, and the operators run here, on it.
export class Selection {
  constructor(r, path, ops) { this.r = r; this.path = path; this.ops = ops }
  plain() { return { path: this.path, ops: this.ops } } // the selector as plain data
  here() {
    const held = new Held(this.r, this.path)
    return new LocalView(held, this.ops)
  }
  // a weak link, as on a plain selection (review F4: the first build closed over `target` and held it for good)
  connect(target, fnOrProp, opts) {
    const held = new Held(this.r, this.path)
    return new LocalView(held, this.ops, true).connect(target, fnOrProp, opts)
  }
}
for (const name of PLAIN) Selection.prototype[name] = function (...args) { return new Selection(this.r, this.path, [...this.ops, [name, args]]) }
for (const name of FUNCS) Selection.prototype[name] = function () { throw new FeroError('unencodable', `${name}(fn) left of here()`) }

// f.at(...keys): the same address, no Proxy
export class At {
  constructor(r, p) { this.r = r; this.p = p }
  get [VALUE]() { return this.r.eng.readSync(this.p) }
  get() { return this.r.read(this.p) }
  set(v, o) { return this.r.set(this.p, v, o) }
  remove() { return this.r.remove(this.p) }
  here() { return this.r.here(this.p) }
  connect(t, f, o) { return this.r.connectAt(this.p, t, f, o) }
  tap(fn) { return this.r.tapAt(this.p, fn) }
  call(name, arg) { return this.r.callMethod(name, arg, this.p) }
  [INSPECT]() { return `At(${this.r.name}.${this.p.join('.')})` }
}

// ── a resource: a server (holds every row) or a client (a cache fed by upstream) ────────────────────
export class Resource {
  constructor(name, { depth = 1, data = {}, methods = null, role = 'server', transport = null, hold = 'none', linger = 0, weak = null, timers = null, leakyRows = false, dev = false } = {}) {
    this.name = name
    this.role = role
    this.hold = role === 'server' ? 'all' : hold
    this.methods = methods
    this.leakyRows = leakyRows // the WRONG design, kept as a control: f.rows reads the whole cache
    this.eng = new Store({ depth, seed: role === 'server' ? data : {}, runtime: role === 'server' ? null : new D.Runtime(), linger, weak, timers, name, dev })
    this.views = new Map() // equal local views share one data view
    if (role === 'client') {
      this.transport = transport
      this.eng.upstream = transport
      transport.bind(this)
    }
    this.data = step(this, null, undefined)
    this.allHold = role === 'client' && hold === 'all' ? new Held(this, EMPTY) : null
  }
  at(...keys) { for (let i = 0; i < keys.length; i++) if (typeof keys[i] !== 'string') keys[i] = atKey(keys[i]); return new At(this, keys) }
  lensAt(p) { let l = this.data; for (const k of p) l = l[k]; return l }
  // f.rows: only what is held on purpose (a server, or hold: 'all'). Never what a link happens to hold.
  get rows() {
    const e = this.eng
    if (this.role === 'server' || this.allHold !== null || this.leakyRows)
      return new Proxy(Object.create(null), { get: (_, k) => (typeof k === 'string' ? (e.depth === 1 ? e.src.get(k) : e.parts.get(k)) : undefined), ownKeys: () => (e.depth === 1 ? [...e.src.snapshot().keys()].map(String) : [...e.parts.keys()]), getOwnPropertyDescriptor: (_, k) => ({ value: e.depth === 1 ? e.src.get(k) : e.parts.get(k), enumerable: true, configurable: true }) })
    throw new FeroError('not-held', `${this.name}.rows: this client holds nothing on purpose. Read through a handle (here()), or open with hold: 'all'`)
  }
  set(path, v, opts) {
    if (this.role === 'server') return this.eng.write(path, v)
    return this.transport.write(path, v, opts)
  }
  remove(path) { if (this.role === 'server') return this.eng.remove(path); return this.transport.write(path, undefined, { remove: true }) }
  // lens.get(): read once. Keeps nothing. Review F1: it is served here only from rows held ON PURPOSE (a server,
  // hold: 'all', a live here() or tap on the partition or on the whole resource). Rows that only a connect link
  // keeps (weak: the collector may end it at any time) never serve a read, or the trip count, and over a network
  // the value, would depend on when the collector runs. The first build's rule is kept as the planted bug 'weakread'.
  purposeSel(path) {
    const e = this.eng
    if (MUTATE === 'weakread') { const s = e.sels.get(e.partOf(path)) ?? (this.allHold !== null ? e.all : undefined); return s !== undefined && s.ready ? s : undefined }
    const s = e.sels.get(e.partOf(path))
    if (s !== undefined && s.strong > 0 && !s.dropped) return s
    const a = e.all
    return a !== null && a.strong > 0 && !a.dropped ? a : undefined
  }
  readWhere(path) { return this.role === 'server' || this.purposeSel(path) !== undefined ? 'here' : 'trip' }
  read(path) {
    if (this.role === 'server') return Promise.resolve(this.eng.readSync(path))
    const s = this.purposeSel(path)
    if (s === undefined) return this.transport.get(path)
    if (s.ready) return Promise.resolve(this.eng.readSync(path))
    // held on purpose, its first picture still on the way: wait for it (no second trip), then read here
    return new Promise((res) => { (s.rw ??= []).push(() => res(this.read(path))) })
  }
  here(path) { return new Held(this, path) }
  connectAt(path, target, fnOrProp, opts) {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) throw new FeroError('bad-target', 'connect(target, …) needs an object to feed')
    const e = this.eng
    const sel = e.sel(e.partOf(path))
    const L = typeof fnOrProp === 'string'
      ? new Link(sel, path, 'connect', target, null, fnOrProp, opts)
      : new Link(sel, path, 'connect', target, fnOrProp, null, opts)
    L.attach()
    return L
  }
  tapAt(path, fn) {
    const e = this.eng
    const L = new Link(e.sel(e.partOf(path)), path, 'tap', null, fn, null)
    L.attach()
    return L
  }
  // equal local views share one data view; the view is disposed when its last user lets go (D6)
  releaseView(key) {
    const v = this.views.get(key)
    if (v === undefined || --v.n > 0) return
    this.views.delete(key)
    for (let i = v.chain.length - 1; i >= 0; i--) v.chain[i].dispose()
  }
  localView(path, ops, key = JSON.stringify([path, ops])) {
    const e = this.eng
    const hit = this.views.get(key)
    if (hit !== undefined) { hit.n++; return hit.h }
    let h
    let base
    if (e.depth === 1) { if (path.length !== 0) throw new FeroError('not-a-view', 'operators need a partition of rows: with depth 1, here() the whole resource'); base = D.handleFor(e.src) }
    else base = D.handleFor(e.part(path[0], true))
    h = base
    const chain = []
    for (const [name, args] of ops) { h = h[name](...args); chain.push(h) }
    this.views.set(key, { h, n: 1, chain })
    return h
  }
  // a method on a path: runs here (a server) with ctx.at = that lens; a client sends it (net.mjs routes it)
  callMethod(name, arg, path) {
    if (this.role !== 'server') return this.transport.call(name, arg, path)
    const def = this.methods?.[name]
    // review F8: a method says where it may be called: a bare function only with no path (f.methods.x(arg));
    // { at: 'row' | 'partition' | 'any', run } on a path of that shape. The SERVER checks it, since under V4-5
    // a method is the only door and a client chooses the path: any other path is refused `bad-path`.
    const m = typeof def === 'function' ? def : def?.run
    if (typeof m !== 'function') throw new FeroError('no-method', name)
    const where = typeof def === 'function' ? 'root' : (def.at ?? 'root')
    const d = this.eng.depth
    const ok = where === 'any' || (where === 'root' && path.length === 0) || (where === 'partition' && path.length === 1) || (where === 'row' && path.length === d)
    if (!ok) return Promise.reject(new FeroError('bad-path', `${name}() may be called at ${where === 'root' ? 'the root (f.methods.' + name + ')' : 'a ' + where} only, not at ${this.name}.${path.join('.')}`))
    const ctx = { at: this.lensAt(path), data: this.data, set: (p, v) => this.set(p, v) }
    return Promise.resolve(m(arg, ctx))
  }
}
export function fero(name, opts) { return new Resource(name, opts) }

// ── the loopback transport: a client cache in this process, fed by a server Resource in this process ─
// No serialization: frames carry the server's wire records by reference (as data's sinks do).
export class Loop {
  constructor(server, { json = false } = {}) { this.server = server; this.json = json; this.subs = new Map(); this.stats = { subs: 0, unsubs: 0, gets: 0, frames: 0, decodes: 0 } }
  bind(client) { this.client = client }
  sub(sel) {
    this.stats.subs++
    const se = this.server.eng
    const path = sel.part === null ? EMPTY : [sel.part]
    const ssel = se.sel(sel.part)
    const self = this
    const L = new Link(ssel, path, 'tap', null, (c) => self.frame(sel, c), null)
    this.subs.set(sel, L)
    L.attach()
  }
  frame(sel, c) {
    if (sel.dropped || this.subs.get(sel)?.dead) return
    this.stats.frames++
    const e = this.client.eng
    if (c.first) {
      let recs = c.recs()
      if (this.json) { recs = JSON.parse(c.text()); this.stats.decodes++ }
      e.applyPicture(sel, recs)
      sel.seq = c.seq
      if (!sel.ready) sel.becameReady()
      return
    }
    let recs = c.recs()
    if (this.json) { recs = JSON.parse(c.text()); this.stats.decodes++ }
    e.applyRecs(recs)
  }
  unsub(sel) {
    this.stats.unsubs++
    const L = this.subs.get(sel); this.subs.delete(sel); L?.end('close')
  }
  get(path) { this.stats.gets++; return Promise.resolve(this.server.eng.readSync(path)) }
  write(path, v, o) { if (o?.remove) this.server.remove(path); else this.server.set(path, v); return Promise.resolve() }
  call(name, arg, path) { return this.server.callMethod(name, arg, path) }
}
