// E-56 probes: the owner's one `connect`, built on E-55's prototype (proto/lens.mjs is imported from E-55's folder and
// never edited; its worker and MessagePort half, proto/net.mjs, is not used: every probe here runs in one process, with
// E-55's loopback client). What is here:
//   lens.connect(fn?, opts?)   fn(state, commit) once per commit, the first call with the picture so far (commit.first).
//                              opts: { from, until, signal, once }. Returns a handle: disconnect() (bound; close is an
//                              alias), state (a sync read), ready, and Symbol.asyncIterator, which yields { state, commit }.
//   three variants, chosen per resource (r.e56 = { variant }):
//     'b'  (V-b, the default) the handle has no `then`; lens.get() is connect({ once }) and returns a promise of the state
//     'a'  (V-a) the handle is thenable: `await handle` gives the first state, and the link stays open
//     'a1' (V-a, second form) the same, but awaiting the handle also ends the link (await means once)
//   two ways for a `for await` loop to see commits it was too slow for:
//     merge (no `from`): the newest state, and one merged change per row since the last turn (the live state's rule)
//     every (`from: 'now'`): every commit, kept here in order until the loop takes it (the log's rule). The prototype has
//       no log, so `from` takes only 'now' (start from this moment); a position or a negative count is refused not-built
//   three policies a probe may switch (policy.first, policy.brk, policy.until):
//     first 'micro' (the default): the link takes its picture and makes its first call a microtask after connect()
//           returns; 'sync': inside connect() when the selection is ready (E-55's Link.attach as built)
//     brk 'link' (the default): `break` out of a for-await loop ends the whole handle (as a Node stream's async iterator
//         destroys the stream, from memory);
//         'cursor': it ends only that loop, and the handle's callback goes on
//     until 'strict' (the default): `until` takes only a thing whose closed state can be read now (a Node socket or
//           stream: `destroyed`; the `ws` library or a WebSocket: `readyState`), and never an HTTP request (`method`:
//           a request may say 'close' once its body is read, long before the client goes); anything else is refused
//           bad-target. 'loose': anything with once() or addEventListener() (a plain EventEmitter, a MessagePort)
//   one policy for what a partition's state is once its link has ended (policy.after):
//     'view' (the default, as first built): the selection's live view, shared by every link on it; read after the end,
//           it shows whatever the cache holds then (a client evicts it, a server or another link keeps it changing)
//     'throw' (the fix CONNECT.md takes): each link gets its own guard over the view; any read through it after the
//           link ends throws FeroError('ended'), on every role, linger and number of links; so does handle.state
// Views right of the handle (h.gt(...), h.filter(fn)) are E-55's LocalView; a view's own sink is viewConnect(view, fn, opts).
// Planted bugs (E56_MUTATE; never set in a measured run): twice | percopy | mergeprev | mergedrop | untilclosed |
// nosignalcleanup | onceheld. E55_MUTATE=viewleak plants E-55's own view leak in this handle too.
import { EventEmitter } from 'node:events'
import { Resource, Link, Selection, LocalView, ViewLink, FeroError, PLAIN, FUNCS, toRecs } from '../../../E55-lens-prototype/proto/lens.mjs'

export const MUT = process.env.E56_MUTATE ?? ''
const VIEWLEAK = process.env.E55_MUTATE === 'viewleak'
export const policy = { first: 'micro', brk: 'link', until: 'strict', after: 'view' }
export const counts = { conns: 0, live: 0, untilListeners: 0, signalListeners: 0, attaches: 0, attachMidBatch: 0, attachInEffects: 0 }

// the state a call hands over: a row or a field is its value now (data makes a new row object at each write); a partition
// or the whole resource is the selection's live view, the same object at every commit (nothing is copied)
function stateOf(r, sel, path, conn) {
  const e = r.eng, cut = e.depth === 1 ? 1 : 2
  if (path.length >= cut) return () => e.readSync(path)
  const v = sel.view
  if (policy.after !== 'throw') return () => v.rows
  let g = null
  return () => (g ??= guardOf(v, conn))
}
// policy.after 'throw': a link's own guard over the shared live view. Each read checks the link first; after the end
// it throws 'ended' (the same at every run), never an answer that depends on the role, the linger or other links
function guardOf(v, conn) {
  const live = () => { if (conn.dead) throw new FeroError('ended', `the rows of ${conn.r.name}.${conn.path.join('.')} were read after their link ended (${conn.why}): copy them while it is live, { ...rows }`) }
  return new Proxy(Object.create(null), {
    get: (_, k) => { live(); return v.rows[k] },
    has: (_, k) => { live(); return k in v.rows },
    ownKeys: () => { live(); return Reflect.ownKeys(v.rows) },
    getOwnPropertyDescriptor: (_, k) => { live(); return Reflect.getOwnPropertyDescriptor(v.rows, k) },
  })
}

// a closed thing: a Node socket or stream (destroyed, closed), the `ws` library or a WebSocket (readyState 2 or 3)
function isClosed(t) { return t.destroyed === true || t.closed === true || t.readyState === 2 || t.readyState === 3 }
// a thing whose closed state can be read now: a Node socket or stream (destroyed), the ws library or a WebSocket (readyState)
function hasState(t) { return typeof t.destroyed === 'boolean' || typeof t.readyState === 'number' }

export class Conn {
  constructor(r, path, fn, opts) {
    if (fn !== undefined && fn !== null && typeof fn !== 'function') throw new FeroError('bad-arg', 'connect(fn?, opts?): the first argument is a function or the options')
    const o = opts ?? {}
    if (o.from !== undefined && o.from !== 'now') throw new FeroError('not-built', `connect({ from: ${JSON.stringify(o.from)} }): this prototype has no log; only 'now'`)
    checkUntil(o.until)
    this.r = r; this.path = path; this.fn = fn ?? null; this.dead = false; this.why = null
    this.cursors = null; this.owned = undefined; this.onDone = null
    this.once = o.once === true; this.every = o.from !== undefined
    this.signal = o.signal ?? null; this.onAbort = null; this.until = o.until ?? null; this.onUntil = null
    this.link = null; this.sel = null; this.firstSeen = false
    counts.conns++
    // born dead: no selection, no SUB
    if (this.signal !== null && this.signal.aborted) { this.dead = true; this.why = 'signal'; return }
    if (this.until !== null && MUT !== 'untilclosed' && isClosed(this.until)) { this.dead = true; this.why = 'until'; return }
    const e = r.eng
    this.sel = e.sel(e.partOf(path))
    this.state0 = stateOf(r, this.sel, path, this)
    this.link = new Link(this.sel, path, 'tap', null, (c) => this.deliver(c), null)
    counts.live++
    if (this.signal !== null) { this.onAbort = () => this.disconnect('signal'); this.signal.addEventListener('abort', this.onAbort, { once: true }); counts.signalListeners++ }
    if (this.until !== null) {
      this.onUntil = () => this.disconnect('until')
      onUntilClose(this.until, this.onUntil)
      counts.untilListeners++
    }
    // the first call: its picture is taken here (sync, E-55's Link.attach) or a microtask after connect() returns
    const go = () => {
      const rt = r.eng.rt
      counts.attaches++; if (rt.midBatch) counts.attachMidBatch++; if (rt.connectSeq() !== 0) counts.attachInEffects++
      this.link.attach()
    }
    if (policy.first === 'sync') go()
    else queueMicrotask(go)
  }
  get ready() { return this.link === null ? Promise.resolve() : this.link.ready }
  get state() {
    if (this.dead && policy.after === 'throw') throw new FeroError('ended', `${this.r.name}.${this.path.join('.')}: state read after the link ended (${this.why})`)
    return this.link === null ? undefined : this.state0()
  }
  get attached() { return this.firstSeen }
  deliver(c) {
    if (c.first) this.firstSeen = true
    if (MUT === 'percopy') c = { __proto__: c, _recs: null, _text: null } // the planted bug: a new commit per link, so text() is built per link
    if (this.fn !== null) this.fn(this.state0(), c)
    if (this.cursors !== null) for (const k of this.cursors) k.push(c)
    if (this.once && !this.dead) this.disconnect('once')
  }
  // bound, so `return h.disconnect` works as a framework's cleanup
  disconnect = (why = 'disconnect') => {
    if (this.dead) {
      if (MUT === 'twice' && this.link !== null && why !== 'once') this.sel.release() // the planted bug: a second end releases again
      return
    }
    this.dead = true; this.why = why
    if (this.onAbort !== null && MUT !== 'nosignalcleanup') { this.signal.removeEventListener('abort', this.onAbort); this.onAbort = null; counts.signalListeners-- }
    if (this.onUntil !== null) { offUntil(this.until, this.onUntil); this.onUntil = null; counts.untilListeners-- }
    if (this.cursors !== null) { const ks = [...this.cursors]; this.cursors = null; for (const k of ks) k.finish() }
    if (this.link !== null) { this.link.end('close'); counts.live-- }
    this.fn = null
    if (this.onDone !== null) { const f = this.onDone; this.onDone = null; f(why) }
  }
  close() { this.disconnect('close') }
  [Symbol.dispose]() { this.disconnect('dispose') }
  [Symbol.asyncIterator]() {
    const k = new Cursor(this)
    if (this.dead) { k.done = true; return k }
    ;(this.cursors ??= new Set()).add(k)
    return k
  }
  // views right of the handle end with it (D6), as on E-55's Held
  own(x) {
    if (this.owned === undefined) {
      this.owned = new Set()
      if (!VIEWLEAK && this.link !== null) this.link.onEnd = () => { const o = [...this.owned]; this.owned.clear(); for (const y of o) y.end('handle') }
    }
    this.owned.add(x); return x
  }
  op(name, args) { return new LocalView(this, [[name, args]]) }
}
for (const name of [...PLAIN, ...FUNCS]) Conn.prototype[name] = function (...args) { return this.op(name, args) }

// V-a: the handle is a thenable. `await h` gives the first state; the link stays open.
export class ConnA extends Conn {
  then(res, rej) { return this.ready.then(() => this.state).then(res, rej) }
}
// V-a, second form: awaiting the handle also ends it (await means "once")
export class ConnA1 extends Conn {
  then(res, rej) { return this.ready.then(() => { const s = this.state; this.disconnect('await'); return s }).then(res, rej) }
}

// ── a for-await loop over a handle ──────────────────────────────────────────────────────────────────────────────
// merge: pending changes fold into one change per row (prev = the row before the first unseen commit); every: a queue
export class Cursor {
  constructor(conn) {
    this.conn = conn; this.every = conn.every; this.done = false; this.waiter = null
    this.firstDue = true // the picture is owed: the first turn yields the state so far
    this.q = []; this.qh = 0 // every: commits in order (E-55's Commit objects, by reference)
    this.m = new Map(); this.n = 0; this.seqFrom = -1; this.seq = 0 // merge
    this.maxQ = 0
    this.onTake = null // a check's hook: called with each item as it is taken (the sims compare it with the source then)
    // every, made after the link's picture: its own picture now, so later commits queue after it
    if (this.every && conn.attached) { this.q.push(pictureNow(conn)); this.firstDue = false }
  }
  get size() { return this.every ? this.q.length - this.qh : this.m.size }
  push(c) {
    if (this.done) return
    if (this.every) {
      if (c.first) { this.q.push(pictureNow(this.conn)); this.firstDue = false }
      else this.q.push(c)
      const s = this.q.length - this.qh; if (s > this.maxQ) this.maxQ = s
    } else if (!this.firstDue && !c.first) {
      const ds = c.changes
      for (let i = 0; i < ds.length; i++) mergeInto(this.m, ds[i])
      if (this.n === 0) this.seqFrom = c.seq
      this.n++; this.seq = c.seq
      if (this.m.size > this.maxQ) this.maxQ = this.m.size
    }
    // merge with the picture owed: drop it; the picture taken at the next turn holds it
    if (this.waiter !== null) { const v = this.take(); if (v !== null) { const w = this.waiter; this.waiter = null; w({ value: v, done: false }) } }
  }
  take0() {
    const conn = this.conn
    if (this.every) {
      if (this.qh >= this.q.length) return null
      const c = this.q[this.qh]; this.q[this.qh++] = undefined
      if (this.qh > 1024 && this.qh * 2 > this.q.length) { this.q = this.q.slice(this.qh); this.qh = 0 }
      return { state: conn.state0(), commit: c }
    }
    if (this.firstDue) {
      if (!conn.attached) return null
      this.firstDue = false; this.m.clear(); this.n = 0
      return { state: conn.state0(), commit: pictureNow(conn) }
    }
    if (this.n === 0) return null
    const changes = [...this.m.values()]
    const c = new Merged(conn, changes, this.seqFrom, this.seq, this.n)
    this.m.clear(); this.n = 0
    return { state: conn.state0(), commit: c }
  }
  take() {
    const v = this.take0()
    if (v !== null && this.onTake !== null) this.onTake(v)
    return v
  }
  next() {
    if (this.done) return Promise.resolve({ value: undefined, done: true })
    const v = this.take()
    if (v !== null) return Promise.resolve({ value: v, done: false })
    return new Promise((res) => { this.waiter = res })
  }
  finish() { this.done = true; if (this.waiter !== null) { const w = this.waiter; this.waiter = null; w({ value: undefined, done: true }) } }
  // `break`, `return` or a throw in the loop body
  return() {
    this.finish()
    const conn = this.conn
    if (policy.brk === 'link') conn.disconnect('break')
    else conn.cursors?.delete(this)
    return Promise.resolve({ value: undefined, done: true })
  }
  [Symbol.asyncIterator]() { return this }
}

// the picture now, as adds, read at once (E-55's first Commit reads it lazily, which a queue cannot wait for)
function pictureNow(conn) {
  const sel = conn.sel, deltas = sel.pictureDeltas()
  return { first: true, changes: deltas, seq: sel.seq, recs() { return toRecs(deltas, sel.prefix) }, text() { return JSON.stringify(this.recs()) } }
}
export class Merged {
  constructor(conn, changes, from, seq, n) { this.first = false; this.changes = changes; this.from = from; this.seq = seq; this.commits = n; this.prefix = conn.sel.prefix; this._recs = null }
  recs() { return (this._recs ??= toRecs(this.changes.map((d) => (d.op === 'update' ? { ...d, path: [] } : d)), this.prefix)) }
  text() { return JSON.stringify(this.recs()) }
}
// one change per row since the last turn: prev is the row before the first unseen commit, row the newest
export function mergeInto(m, d) {
  const k = d.part !== undefined ? d.part + '\u0000' + d.key : d.key
  const p = m.get(k)
  if (p === undefined) { m.set(k, { op: d.op, key: d.key, part: d.part, row: d.row, prev: d.prev }); return }
  if (MUT === 'mergeprev') p.prev = d.prev // the planted bug: prev of the newest commit
  if (p.op === 'add') { if (d.op === 'remove') m.delete(k); else p.row = d.row } // add then update: an add; add then remove: nothing
  else if (p.op === 'update') { if (d.op === 'remove') { p.op = 'remove'; p.row = undefined } else p.row = d.row }
  else if (d.op === 'add' || d.op === 'update') { p.op = MUT === 'mergedrop' ? 'add' : 'update'; p.row = d.row } // remove then add: an update
}

// ── V-b: get() is connect({ once }) ───────────────────────────────────────────────────────────────────────────
export function getOnce(r, path, opts) {
  return new Promise((res, rej) => {
    let got = false
    const c = new (classFor(r))(r, path, (s) => { got = true; res(s) }, { ...opts, once: true })
    if (c.dead && !got) { rej(new FeroError('aborted', `get() on ${r.name}.${path.join('.')} ended (${c.why}) before its value came`)); return }
    c.onDone = (why) => { if (!got) rej(new FeroError('aborted', `get() on ${r.name}.${path.join('.')} ended (${why}) before its value came`)) }
  })
}

// ── a sink on a view right of the handle: fn(state, commit), strong; once, signal and until as on connect ─────
// (operators left of connect, `lens.gt(…).connect(fn)`, make a handle the view owns: it ends with the view's last sink)
export function viewConnect(view, fn, opts) {
  const o = opts ?? {}
  if (typeof fn !== 'function') throw new FeroError('bad-arg', 'view.connect(fn, opts?): fn is a function')
  checkUntil(o.until)
  if (o.signal?.aborted || (o.until !== undefined && MUT !== 'untilclosed' && isClosed(o.until))) { // born ended
    if (view.ownsHeld) view.held.close()
    return { dead: true, disconnect() {}, close() {} }
  }
  let L = null, endNow = false
  const w = (c) => {
    fn(c.now.value, c)
    if (o.once) {
      if (MUT === 'onceheld') view.ownsHeld = false // the planted bug: once ends the sink but leaves its hold
      if (L !== null) L.end('close'); else endNow = true
    }
  }
  const onAbort = () => L.end('close'), onUntil = () => L.end('close')
  L = new ViewLink(view, null, w, null)
  const end0 = L.end.bind(L)
  L.end = (why) => { // the listeners go with the link, however it ends
    if (!L.dead) {
      if (o.signal && MUT !== 'nosignalcleanup') o.signal.removeEventListener('abort', onAbort)
      if (o.until) offUntil(o.until, onUntil)
    }
    end0(why)
  }
  if (endNow || L.dead) { L.end('close'); return L }
  if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true })
  if (o.until) onUntilClose(o.until, onUntil)
  L.disconnect = () => L.end('close')
  return L
}
function checkUntil(u) {
  if (u === undefined) return
  if (u === null || typeof u !== 'object' || (typeof u.once !== 'function' && typeof u.addEventListener !== 'function')) throw new FeroError('bad-target', 'until: a socket, stream or WebSocket')
  if (policy.until === 'strict' && !hasState(u)) throw new FeroError('bad-target', 'until: this thing cannot say whether it has already closed (no destroyed, no readyState); end the link with a signal')
  if (policy.until === 'strict' && typeof u.method === 'string') throw new FeroError('bad-target', 'until: an HTTP request may say it closed once its body is read, while the client stays; pass the response')
}
function onUntilClose(t, f) { if (typeof t.once === 'function') t.once('close', f); else t.addEventListener('close', f, { once: true }) }
function offUntil(t, f) { if (typeof t.off === 'function') t.off('close', f); else if (typeof t.removeListener === 'function') t.removeListener('close', f); else t.removeEventListener('close', f) }

// ── wiring into E-55's lens: its verbs `connect` and `get` call these two Resource methods ─────────────────────
export function classFor(r) { const v = r.e56?.variant ?? 'b'; return v === 'a' ? ConnA : v === 'a1' ? ConnA1 : Conn }
export function connectAt(r, path, a, b) {
  if (typeof a === 'function') return new (classFor(r))(r, path, a, b)
  if (a !== undefined && a !== null && typeof a !== 'object') throw new FeroError('bad-arg', 'connect(fn?, opts?): the first argument is a function or the options')
  return new (classFor(r))(r, path, null, a)
}
const e55Read = Resource.prototype.read
Resource.prototype.connectAt = function (path, a, b) { return connectAt(this, path, a, b) }
Resource.prototype.read = function (path) { return (this.e56?.variant ?? 'b') === 'b' && this.e56?.getOnce !== false ? getOnce(this, path) : e55Read.call(this, path) }
// a view right of the handle: view.connect(fn, opts) is the owner's form (E-55's took a target first)
const e55ViewConnect = LocalView.prototype.connect
LocalView.prototype.connect = function (a, b, c) { return typeof a === 'function' ? viewConnect(this, a, b) : e55ViewConnect.call(this, a, b, c) }
// operators left of the handle, then connect: the link owns its handle (as E-55's Selection.connect)
Selection.prototype.connect = function (fn, opts) {
  const h = new Conn(this.r, this.path, null, {})
  return viewConnect(new LocalView(h, this.ops, true), fn, opts)
}
export { e55Read }
export { EventEmitter }
