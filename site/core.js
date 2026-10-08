// core.js — fero's kernel on the simulator, as one object a page (or a Worker) can drive. NO DOM here:
// cluster.js adds the page-wide frame loop and the shared `page` cluster; a Worker imports this file directly.
//
// fero's deterministic kernel (lib/kernel/*.js) runs on the simulation executive (lib/sim/exec.js): a virtual
// network, virtual disks and virtual time. These are the same kernel files the TCP shell runs — type-stripped by
// strip.mjs, unbundled. The kernel cannot tell the simulator from a real network (sim/exec.ts: "that is the design").
//
// What a page CANNOT run is the public fero() call (it needs node:net/fs/crypto). A page writes by posting the
// record the api's lens builds from an assignment, and must say so:
//     shop.data.gadgets = { stock: 4 }   →   { type: 0 /* update */, key: ['gadgets'], value: { stock: 4 } }
//
// DETERMINISM. Everything automatic happens INSIDE the simulation (sim.at): the seed at boot, the scripted
// writer, finishing a clean leave. Visitor actions are logged with their virtual time and event index
// (`actions`), so `LiveCluster.replay(opts, actions, t)` rebuilds the same run event for event, however the
// frames were paced. A rolling hash of sim.trace (`traceHash`, `traceCount`) is what a replay compares.
import { Sim } from './lib/sim/exec.js'
import { cluster as harnessCluster, client as harnessClient } from './lib/sim/harness.js'
import { REC } from './lib/kernel/env.js'
import { Ring, VNODES, fnv } from './lib/kernel/ring.js'
import { VERB, Frame } from './lib/kernel/codec.js'
import { LS } from './lib/kernel/link.js'
import { JK } from './lib/kernel/journal.js'
import { CONFIRM } from './lib/kernel/confirm.js'
import { stable } from './lib/kernel/node.js'

export { Sim, REC, Ring, VNODES, VERB, Frame, JK, CONFIRM, stable }

// ── names ────────────────────────────────────────────────────────────────────────────────────────────
export const VERB_NAME = Object.fromEntries(Object.entries(VERB).map(([k, v]) => [v, k]))
export const JK_NAME = Object.fromEntries(Object.entries(JK).map(([k, v]) => [v, k]))
//  write: an unstamped write travelling to its owner, and the owner's answer · repl: stamped records fanning
//  out · heal: digests (anti-entropy) · beat: heartbeats · link: the handshake · vote: membership ballots ·
//  rpc: the method plane · scope: scoped replication · diag: the diagnostics channel
export const VERB_KIND = {
  WRITE: 'write', WACK: 'write', WNACK: 'write', RECORDS: 'repl', DIGEST: 'heal', HELLO: 'link',
  PING: 'beat', PONG: 'beat', JOIN: 'vote', PROPOSE: 'vote', VOTE: 'vote', VIEW: 'vote', PULL: 'vote', LEAVE: 'vote',
  CALL: 'rpc', RESULT: 'rpc', SUB: 'rpc', UNSUB: 'rpc', SUBREC: 'rpc',
  HAVEQ: 'scope', HAVEA: 'scope', ACQ: 'scope', ACQDONE: 'scope', DIAGQ: 'diag', DIAGA: 'diag',
}
for (const name of Object.keys(VERB)) VERB_KIND[name] ??= 'vote'
export const role = (id) => (id.startsWith('c') ? 'client' : 'server')
export const label = (id) => `${role(id)} ${id}`

// ── cells and objects (kernel/node.ts apply(): the internal cell key is JSON.stringify(path)) ──────────
export const keyOf = (path) => JSON.stringify(path)
// toObject — a node's cells as the plain object `shop.snapshot` would show. NEVER writes into a stored value:
// a value in node.state is also the record held in that node's per-writer log, so descending into it to merge a
// field cell would corrupt the kernel (a row changing under an unchanged stamp). Copy on every descent.
export function toObject(state) {
  const out = {}
  for (const [k, v] of state) {
    const path = JSON.parse(k)
    if (path.length === 1) {
      // a whole-row cell after field cells of the same row would replace them; keep whichever is the object view
      out[path[0]] = (out[path[0]] && typeof out[path[0]] === 'object' && v && typeof v === 'object' && !Array.isArray(v)) ? { ...out[path[0]], ...v } : v
      continue
    }
    let o = out
    for (let i = 0; i < path.length - 1; i++) {
      const cur = o[path[i]]
      o = o[path[i]] = (cur && typeof cur === 'object' && !Array.isArray(cur) && !(cur instanceof Uint8Array)) ? { ...cur } : {}
    }
    o[path[path.length - 1]] = v
  }
  return out
}

// ── the ring, drawn exactly (kernel/ring.ts: VNODES points per member at fnv(member + '#' + v)) ──────────
// fnv is the kernel's own (fnv-1a finished with fmix32 since DECISIONS V4-14), imported, so the page cannot drift
export const ringHash = fnv
export function ringPoints(members) {
  const pts = []
  for (const m of members) for (let v = 0; v < VNODES; v++) pts.push({ p: fnv(m + '#' + v), member: m, v })
  pts.sort((a, b) => a.p - b.p || members.indexOf(a.member) - members.indexOf(b.member) || a.v - b.v)
  return pts.map((x) => ({ at: x.p / 4294967296, member: x.member }))
}
export const partitionAt = (row) => fnv(row) / 4294967296
export function ownerOnRing(points, row) {
  const at = partitionAt(row)
  for (const p of points) if (p.at >= at) return p.member
  return points[0]?.member ?? ''
}
{ // self-check: the page's ring math must match the kernel's
  const ms = [['n01', 'sim:n01'], ['n02', 'sim:n02'], ['n03', 'sim:n03']]
  const r = new Ring(); r.build(1, ms)
  const pts = ringPoints(ms.map((m) => m[0]))
  for (const row of ['widgets', 'gadgets', 'gizmos', 'sprockets', 'a', 'b', 'c', 'row42'])
    if (ownerOnRing(pts, row) !== r.ownerOf(row)) throw new Error(`core.js: ring mismatch on ${row}`)
}

// decode(bytes) → a frame taken apart by kernel/codec.js: { verb, name, flags, prov, attempt, recs, value }
export function decode(bytes) {
  const f = new Frame(bytes)
  const out = { verb: f.verb, name: VERB_NAME[f.verb] ?? String(f.verb), flags: f.flags, size: bytes.length, prov: null, attempt: null, recs: null, value: undefined }
  if (out.name === 'RECORDS' || out.name === 'WRITE' || out.name === 'ACQ') {
    out.prov = f.prov(); out.attempt = f.attempt()
    out.recs = f.records().map((r) => ({ ...r.rec(), origin: r.origin, seq: r.seq, epoch: r.epoch }))
  } else {
    try { out.value = f.value } catch { out.value = undefined }
  }
  return out
}

const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
export { pair }

// the house config (CONCEPT.md §0): the resource `shop`, three durable servers + one client, heartbeat 100 ms on
// all four, the harness's redial 20 ms, links 30–90 ms simulated, seed 7, whole rows only
export const HOUSE = {
  name: 'shop', seed: 7, servers: 3, clients: 1, heartbeatMs: 100, durable: true, delay: [30, 90],
  data: { widgets: { stock: 10 }, gadgets: { stock: 3 }, gizmos: { stock: 7 } }, seedFrom: 'n01',
  writer: { on: true, id: 'c1', row: 'gadgets', every: 2500, cycle: [4, 6, 3, 1, 5, 2, 0, 8] },
}

// ── LiveCluster ──────────────────────────────────────────────────────────────────────────────────────
export class LiveCluster {
  static ticker = null // set by cluster.js to its onFrame; a Worker never paces
  #listeners = new Map()
  #watched = new Set()
  #visible = new Set()
  #io = null
  #off = null
  #lastNow = 0
  constructor(opts = {}) {
    this.opts = { ...HOUSE, paced: true, ...opts, writer: opts.writer === false ? { ...HOUSE.writer, on: false } : { ...HOUSE.writer, ...(opts.writer || {}) } }
    this.speed = this.opts.speed ?? 1
    this.paused = false
    this.#boot(this.opts.seed)
    if (this.opts.paced) this.start()
  }

  // ── one run: everything below is rebuilt by reset() ──
  #cur = null
  #killCuts = new Map()
  #lastEpoch = 0
  #wid = 0
  #onReady = null
  #traceAt = 0
  #probes = []
  #pid = 0
  #writerReady = false
  #boot(seed) {
    const o = this.opts
    this.seed = seed
    this.sim = new Sim(seed, { delay: o.delay })
    this.frames = []        // { from, to, verb, kind, sentAt, recvAt, size, bytes } — ~2 s of virtual time
    this.writes = []        // writes the page issued: { id, node, path, value, by, issuedAt, state, stamp?, committedAt? }
    this.log = []           // plain-words events: { at, kind, text, ids }
    this.journal = []       // every node's kernel journal, with virtual time: { node, at, kind, name, a, b, c }
    this.actions = []       // visitor actions, for replay: { at, ev, op, args }
    this.cuts = new Set()   // user partitions, as pair keys
    this.down = new Set()   // crashed nodes, awaiting restart
    this.left = new Set()   // nodes that left cleanly
    this.verbCounts = {}
    this.applies = 0
    this.traceHash = 0x811c9dc5 | 0
    this.traceCount = 0
    this.#cur = null; this.#killCuts = new Map(); this.#lastEpoch = 0; this.#wid = 0; this.#traceAt = 0; this.#probes = []; this.#pid = 0; this.#writerReady = false
    this.writer = { ...o.writer, i: 0 }
    this.isReady = false
    this.ready = new Promise((r) => { this.#onReady = r })
    // a bytesIn posted while #cur is set IS that frame's delivery (exec.ts send → deliver → post)
    const post = this.sim.post.bind(this.sim)
    this.sim.post = (uuid, ev, delay = 0) => {
      if (ev.kind === 'bytesIn' && this.#cur) {
        const f = { from: this.#cur.from, to: uuid, verb: this.#cur.verb, kind: VERB_KIND[this.#cur.verb] ?? 'other', sentAt: this.sim.now, recvAt: this.sim.now + delay, size: ev.bytes.length, bytes: ev.bytes }
        this.frames.push(f)
        this.#emit('frame', f)
      }
      return post(uuid, ev, delay)
    }
    this.serverIds = harnessCluster(this.sim, o.servers, { heartbeatMs: o.heartbeatMs, durable: o.durable }).map((n) => n.uuid)
    this.clientIds = []
    for (let i = 1; i <= o.clients; i++) this.clientIds.push(harnessClient(this.sim, `c${i}`, this.serverIds.map((u) => this.sim.nodes.get(u)), { heartbeatMs: o.heartbeatMs }).uuid)
    for (const n of this.sim.nodes.values()) this.#tap(n)
    // one breach, one report: a rule that breaks keeps failing at every later event, so sim.violations would gain
    // the same report once per event for the rest of the session. Keep the first report of each distinct breach
    // (the rule and the monitor's own words); the array stays append-only, so stored indices into it stay valid.
    const reported = new Set()
    for (const m of this.sim.monitors) {
      const check = m.check
      m.check = (sim) => { const bad = check(sim); if (!bad) return bad; const k = m.name + '\u0000' + String(bad); if (reported.has(k)) return null; reported.add(k); return bad }
    }
    this.note('boot', `${words(o.servers)} servers and ${words(o.clients)} client start; the servers dial each other`, this.ids())
    if (o.data) {
      // the seed, as a real `fero('shop', { data })` applies it: at boot, on an empty node, before any view —
      // one whole-row update per row (README: "Initial rows, applied only when the local fold is empty at boot")
      this.sim.post(o.seedFrom, { kind: 'write', recs: Object.entries(o.data).map(([k, v]) => ({ type: REC.update, key: [k], value: v })) }, 0)
      this.note('seed', `${o.seedFrom} applies the seed rows at boot, before any view: ${Object.keys(o.data).join(', ')}`, [o.seedFrom])
    } else { this.isReady = true; this.#onReady() }
    if (this.writer.every) this.sim.at(this.writer.every, () => this.#writerTick())
  }
  reset(seed = this.seed) {
    this.#boot(seed)
    this.#emit('reset', seed)
    this.#emit('tick', this.sim.now)
  }

  // ── taps: they observe and forward, never change behaviour ──
  #tap(node) {
    const s = node.env.sink, me = node.uuid
    const send = s.send
    s.send = (link, bytes) => {
      const verb = VERB_NAME[bytes[2]] ?? String(bytes[2])
      this.verbCounts[verb] = (this.verbCounts[verb] ?? 0) + 1
      this.#cur = { from: me, verb }
      try { send.call(s, link, bytes) } finally { this.#cur = null }
    }
    const apply = s.apply
    s.apply = (a) => {
      this.applies++
      const path = a.key.length ? a.key : [a.at ?? '']
      const key = keyOf(path)
      // the kernel's attempt identity (iss = issuer uuid~life) ties a record to the node that issued it, so a
      // same-value write from another node never commits this node's pending write
      const issuer = typeof a.iss === 'string' ? a.iss.slice(0, a.iss.lastIndexOf('~')) : null
      for (const w of this.writes) {
        if (w.state === 'pending' && w.node === me && w.key === key && (issuer === null || issuer === me) && (a.type === REC.remove ? w.remove : stable(w.value) === stable(a.value))) {
          w.state = 'committed'; w.stamp = { epoch: a.epoch, seq: a.seq, origin: a.origin }; w.committedAt = this.sim.now
          this.note('commit', `${me}'s write to ${w.path.join('.')} committed: view ${a.epoch} · #${a.seq} · ${a.origin}`, [me, a.origin])
          this.#emit('commit', w)
        }
      }
      this.#emit('apply', { node: me, key, path, type: a.type, value: a.value, epoch: a.epoch, seq: a.seq, origin: a.origin, iss: a.iss, cid: a.cid, at: this.sim.now })
      apply.call(s, a)
    }
    const left = s.left
    s.left = (clean) => {
      left.call(s, clean)
      // finish the clean stop INSIDE the simulation, at this instant — deterministic, like membership.test.ts's idiom
      this.sim.at(0, () => this.#finishLeave(me, clean))
    }
    const j = node.journal
    const emit = j.emit.bind(j)
    j.emit = (kind, a, b, c) => {
      emit(kind, a, b, c)
      const e = { node: me, at: this.sim.now, kind, name: JK_NAME[kind] ?? String(kind), a, b, c }
      this.journal.push(e); if (this.journal.length > 6000) this.journal.splice(0, 3000)
      this.#emit('journal', e)
    }
  }

  // ── listeners ──
  on(type, fn) { (this.#listeners.get(type) ?? this.#listeners.set(type, new Set()).get(type)).add(fn); return () => this.#listeners.get(type)?.delete(fn) }
  #emit(type, v) { const ls = this.#listeners.get(type); if (ls) for (const fn of ls) { try { fn(v) } catch (e) { console.error(e) } } }
  note(kind, text, ids = []) { const e = { at: this.sim.now, kind, text, ids }; this.log.push(e); if (this.log.length > 400) this.log.splice(0, 200); this.#emit('log', e) }

  // ── pacing: virtual time follows the wall clock × speed while any watched element is on screen ──
  start() { if (this.#off || !LiveCluster.ticker) return; this.#off = LiveCluster.ticker((now) => this.#frame(now)) }
  stop() { this.#off?.(); this.#off = null }
  #frame(now) {
    const dt = this.#lastNow ? Math.min(100, now - this.#lastNow) : 16
    this.#lastNow = now
    if (this.paused) return
    if (this.#watched.size && !this.#visible.size) return
    if (typeof document !== 'undefined' && document.hidden) return
    this.advance(dt * this.speed)
  }
  watch(el) {
    if (!el || typeof IntersectionObserver === 'undefined') return
    // root: document, so the 160px slack also holds in a cross-origin frame (a hosted preview), where the default root
    // is the top-level viewport and the browser drops rootMargin; at the top level the two are the same
    const cb = (es) => { for (const e of es) e.isIntersecting ? this.#visible.add(e.target) : this.#visible.delete(e.target) }
    if (!this.#io) { try { this.#io = new IntersectionObserver(cb, { root: document, rootMargin: '160px' }) } catch { this.#io = new IntersectionObserver(cb, { rootMargin: '160px' }) } }
    this.#watched.add(el); this.#io.observe(el)
  }
  get onScreen() { return !this.#watched.size || this.#visible.size > 0 }
  // advance(ms): run every event due within the next `ms` of virtual time, then hold virtual time there
  advance(ms) {
    const until = this.sim.now + ms
    this.sim.run({ until, maxEvents: 200_000 })
    if (this.sim.now < until) this.sim.now = until
    this.#after()
  }
  runTo(t) { if (t > this.sim.now) this.advance(t - this.sim.now); else this.#after() }
  #after() {
    const now = this.sim.now
    // fold the new trace entries into the rolling hash, then trim (the live cluster never keeps the whole trace)
    const tr = this.sim.trace
    let h = this.traceHash
    for (let i = this.#traceAt; i < tr.length; i++) { h ^= tr[i]; h = Math.imul(h, 0x01000193) }
    this.traceHash = h | 0; this.traceCount += tr.length - this.#traceAt
    if (tr.length > 20000) { tr.splice(0, tr.length - 2000) }
    this.#traceAt = tr.length
    if (!this.isReady && this.#seedLanded()) { this.isReady = true; this.#onReady(); this.#emit('ready', now) }
    const v = this.view()
    if (v.epoch !== this.#lastEpoch) {
      const before = this.#lastEpoch
      this.#lastEpoch = v.epoch
      if (before) this.note('view', `view ${v.epoch} committed: ${v.members.join(', ')}`, v.members)
      else this.note('view', `the servers vote in view ${v.epoch}: ${v.members.join(', ')}`, v.members)
      this.#emit('view', v)
    }
    for (const p of this.#probes) if (!p.done) {
      const c = this.sim.confirms.get(p.on + '|' + p.id)
      if (c && c.ok !== undefined) { p.done = true; p.resolve({ ok: c.ok, count: c.count, at: now, ms: now - p.t0 }) }
    }
    if (this.frames.length > 6000 || (this.frames.length && this.frames[0].recvAt < now - 2500)) {
      let i = 0; while (i < this.frames.length && this.frames[i].recvAt < now - 2500) i++
      this.frames.splice(0, Math.max(i, this.frames.length - 6000))
    }
    this.#emit('tick', now)
  }
  #seedLanded() {
    if (!this.opts.data) return true
    const rows = Object.keys(this.opts.data)
    return this.ids().every((id) => !this.alive(id) || rows.every((r) => this.node(id).state.has(keyOf([r]))))
  }

  // ── the scripted writer: c1's next whole-row value every `every` ms of SIMULATED time, never stacking more
  // than one waiting write. It runs inside the simulation, so the same seed gives the same writes.
  // It starts once every live node holds the seed rows, and that is latched: a row removed later never stops
  // it. The latch is decided inside the simulation (at a tick), so it does not depend on frame pacing.
  #writerTick() {
    const w = this.writer
    if (!this.#writerReady && this.#seedLanded()) this.#writerReady = true
    if (w.on && this.alive(w.id) && this.#writerReady && this.node(w.id).writes.pending.size === 0 && !this.writes.some((x) => x.node === w.id && x.state === 'pending')) {
      this.#write(w.id, [w.row], { stock: w.cycle[w.i++ % w.cycle.length] }, 'writer')
    }
    this.sim.at(w.every, () => this.#writerTick())
  }

  // ── actions (each visitor action is logged for replay; `by` says who issued a write) ──
  #act(op, args) { this.actions.push({ at: this.sim.now, ev: this.sim.events, op, args }) }
  // write(id, row, value): what `shop.data[row] = value` issues on node `id` — ONE WHOLE ROW. The page writes
  // whole rows only: a field write on a row seeded whole is the open two-cells bug (STATUS.md).
  write(id, row, value) {
    const path = Array.isArray(row) ? row : [row]
    if (path.length !== 1) throw new Error('the page writes whole rows only (one write style per row): write(id, row, value)')
    if (!this.alive(id)) throw new Error(`${id} is down`)
    this.#act('write', [id, path[0], value])
    return this.#write(id, path, value, 'page')
  }
  #write(id, path, value, by) {
    const w = { id: ++this.#wid, node: id, path, key: keyOf(path), value, by, issuedAt: this.sim.now, state: 'pending' }
    this.writes.push(w); if (this.writes.length > 300) this.writes.splice(0, 150)
    this.sim.post(id, { kind: 'write', recs: [{ type: REC.update, key: path, value }] })
    this.note('write', `${id} assigns shop.data.${path[0]} = ${short(value)}`, [id])
    this.#emit('write', w)
    return w
  }
  remove(id, row) {
    if (!this.alive(id)) throw new Error(`${id} is down`)
    this.#act('remove', [id, row])
    const w = { id: ++this.#wid, node: id, path: [row], key: keyOf([row]), remove: true, by: 'page', issuedAt: this.sim.now, state: 'pending' }
    this.writes.push(w)
    this.sim.post(id, { kind: 'write', recs: [{ type: REC.remove, key: [row] }] })
    this.note('write', `${id} deletes shop.data.${row}`, [id])
    this.#emit('write', w)
    return w
  }
  // kill(id): a crash (like kill -9) — cut from everyone at once, then destroyed; its disk stays for restart()
  kill(id) {
    const n = this.sim.nodes.get(id); if (!n || n.destroyed) return
    this.#act('kill', [id])
    const cut = []
    for (const o of this.sim.nodes.keys()) if (o !== id) { this.sim.partition(id, o); cut.push(o) }
    this.#killCuts.set(id, cut)
    n.destroy(); this.down.add(id)
    this.note('kill', `${id} crashed (like kill -9): its links drop, its disk stays`, [id])
    this.#emit('kill', id)
  }
  // restart(id): the same node's next life — boot record, WAL replayed before any link, then it dials (sim.restart).
  // Servers only: a client has no disk, and the harness would bring back the same uuid at view 0 (a real client
  // process would start fresh), which trips epoch-monotone. A crashed client stays down until reset().
  restart(id) {
    if (!this.down.has(id) || this.clientIds.includes(id)) return
    this.#act('restart', [id])
    for (const o of this.#killCuts.get(id) ?? []) if (!this.cuts.has(pair(id, o)) && !this.down.has(o)) this.sim.heal(id, o)
    this.#killCuts.delete(id); this.down.delete(id)
    const n = this.sim.restart(id); this.#tap(n)
    this.note('restart', `${id} restarts from its disk as life ${n.incarnation}: its rows come back before any link`, [id])
    this.#emit('restart', id)
    return n
  }
  // leave(id): the Ctrl-C path — ask for a view without me; the node goes once the kernel reports it left
  leave(id) {
    if (!this.alive(id)) return
    this.#act('leave', [id])
    this.sim.post(id, { kind: 'leave' })
    this.note('leave', `${id} is stopping on purpose (Ctrl-C) and asks to be voted out`, [id])
    this.#emit('leave', id)
  }
  #finishLeave(id, clean) {
    const n = this.sim.nodes.get(id); if (!n || n.destroyed) return
    for (const o of this.sim.nodes.keys()) if (o !== id) this.sim.partition(id, o)
    n.destroy(); this.left.add(id)
    this.note('left', clean ? `${id} left: the others voted it out on its own request` : `${id} left without its vote (timed out): it went like a crash`, [id])
    this.#emit('left', id)
  }
  partition(a, b) { if (this.cuts.has(pair(a, b))) return; this.#act('partition', [a, b]); this.cuts.add(pair(a, b)); this.sim.partition(a, b); this.note('cut', `the link ${a} — ${b} is cut`, [a, b]); this.#emit('cut', [a, b]) }
  heal(a, b) { if (!this.cuts.has(pair(a, b))) return; this.#act('heal', [a, b]); this.cuts.delete(pair(a, b)); if (!this.down.has(a) && !this.down.has(b) && !this.left.has(a) && !this.left.has(b)) this.sim.heal(a, b); this.note('heal', `the link ${a} — ${b} is back`, [a, b]); this.#emit('heal', [a, b]) }
  isolate(id) { for (const o of this.ids()) if (o !== id) this.partition(id, o) }
  reconnect(id) { for (const o of this.ids()) if (o !== id) this.heal(id, o) }
  isolated(id) { return this.ids().filter((o) => o !== id).every((o) => this.cuts.has(pair(id, o))) }
  // fault(a, b, { delay: [min, max], dupP }) — a link's personality (sim.fault); storeFault(id, { delay, lieP, failP }) — a disk's
  fault(a, b, f) { this.#act('fault', [a, b, f]); this.sim.fault(a, b, f); this.note('fault', `the link ${a} — ${b} now ${describeFault(f)}`, [a, b]); this.#emit('fault', [a, b, f]) }
  storeFault(id, f) { this.#act('storeFault', [id, f]); this.sim.storeFault(id, f); this.note('disk', `${id}'s disk now ${describeStore(f)}`, [id]); this.#emit('disk', [id, f]) }
  setWriter(on) { if (this.writer.on === on) return; this.#act('setWriter', [on]); this.writer.on = on; this.#emit('writer', on) }
  addServer() {
    const id = `n${String(this.serverIds.length + 1).padStart(2, '0')}`
    this.#act('addServer', [])
    const n = this.sim.add({ uuid: id, listen: `sim:${id}`, hosts: this.serverIds.map((u) => `sim:${u}`), heartbeatMs: this.opts.heartbeatMs, durable: this.opts.durable, redialMs: 20, journalCap: 1 << 16 })
    this.#tap(n); this.serverIds.push(id); this.sim.post(id, { kind: 'start' })
    this.note('join', `${id} starts and asks to join; the members vote on it`, [id])
    this.#emit('join', id)
    return id
  }
  addClient() {
    const id = `c${this.clientIds.length + 1}`
    this.#act('addClient', [])
    const n = harnessClient(this.sim, id, this.serverIds.filter((u) => this.alive(u)).map((u) => this.sim.nodes.get(u)), { heartbeatMs: this.opts.heartbeatMs })
    this.#tap(n); this.clientIds.push(id)
    this.note('join', `${id} starts and dials the servers`, [id])
    this.#emit('join', id)
    return id
  }
  // probe(on, origin, seq, level): open a confirm-ladder probe at node `on` (CONFIRM.replicated / .persisted) →
  // Promise<{ ok, count, at, ms }> answered by the kernel (sim.confirms). Not logged: a probe changes nothing.
  probe(on, origin, seq, level) {
    const id = ++this.#pid
    return new Promise((resolve) => {
      this.#probes.push({ on, id, t0: this.sim.now, resolve, done: false })
      this.sim.post(on, { kind: 'confirm', id, origin, seq, level })
    })
  }

  // ── reads ──
  ids() { return [...this.serverIds, ...this.clientIds] }
  node(id) { return this.sim.nodes.get(id) }
  alive(id) { const n = this.sim.nodes.get(id); return !!n && !n.destroyed }
  role(id) { return role(id) }
  // view(): the committed view with the highest epoch among live servers
  view() {
    let best = null
    for (const id of this.serverIds) if (this.alive(id)) { const v = this.node(id).membership.view; if (!best || v.epoch > best.epoch) best = v }
    return best ? { epoch: best.epoch, members: best.members.map((m) => m[0]) } : { epoch: 0, members: [] }
  }
  viewOf(id) { const v = this.node(id).membership.view; return { epoch: v.epoch, members: v.members.map((m) => m[0]) } }
  owner(row, id) { const v = id ? this.viewOf(id) : this.view(); if (!v.members.length) return ''; const r = new Ring(); r.build(v.epoch, v.members.map((m) => [m, `sim:${m}`])); return r.ownerOf(row) }
  object(id) { return toObject(this.node(id).state) }
  rows(id) { return Object.keys(this.object(id)) }
  cell(id, row) { return this.node(id).state.get(keyOf([row])) }
  stamp(id, row) { return this.node(id).versions.get(keyOf(Array.isArray(row) ? row : [row])) }
  hash(id) { return this.node(id).stateHash }
  life(id) { return this.node(id).incarnation }
  origin(id) { return this.node(id).origin }
  primary(id) { const n = this.node(id); if (!n.client || n.primary == null) return null; return n.links.get(n.primary)?.uuid ?? null }
  writable(id) { const n = this.node(id); return n.client ? null : n.membership.gate(n) }
  pending(id) { return this.node(id).writes.pending.size }
  waiting(id) { return this.writes.filter((w) => w.node === id && w.state === 'pending') }
  peers(id) { const n = this.node(id); const out = []; for (const l of n.links.values()) if (l.state === LS.admitted && !l.dead) out.push(l.uuid); return out }
  links() {
    const seen = new Set(), out = []
    for (const id of this.ids()) if (this.alive(id)) for (const p of this.peers(id)) { const k = pair(id, p); if (!seen.has(k) && this.alive(p)) { seen.add(k); out.push([id, p].sort()) } }
    return out
  }
  agree() { const hs = new Set(); for (const id of this.ids()) if (this.alive(id)) hs.add(this.hash(id)); return hs.size <= 1 }
  // copies(): live nodes whose state hash matches the most common one → { agree, of }
  copies() {
    const n = new Map(); let live = 0
    for (const id of this.ids()) if (this.alive(id)) { live++; const h = this.hash(id); n.set(h, (n.get(h) ?? 0) + 1) }
    return { agree: Math.max(0, ...n.values()), of: live }
  }
  disk(id) { const s = this.sim.stores.get(id); return s ? { wal: s.wal.length, resolved: s.wal.filter((r) => r.resolved).length, boot: s.boot } : null }
  inFlight() { const now = this.sim.now; return this.frames.filter((f) => f.sentAt <= now && f.recvAt > now) }
  get rules() { return this.sim.monitors.map((m) => m.name) }
  get now() { return this.sim.now }
  get events() { return this.sim.events }
  get violations() { return this.sim.violations.length }

  // replay(opts, actions, untilT): rebuild a run from its seed and the visitor's actions, unpaced, and return the
  // twin plus the first action whose event index differed (null when every one lined up)
  static replay(opts, actions, untilT) {
    const twin = new LiveCluster({ ...opts, paced: false })
    let diverged = null
    for (const a of actions) {
      twin.runTo(a.at)
      if (twin.events !== a.ev && !diverged) diverged = { action: a, events: twin.events }
      twin[a.op](...a.args)
    }
    twin.actions = actions.slice()
    if (untilT !== undefined) twin.runTo(untilT)
    return { twin, diverged }
  }
}
const words = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n)
const short = (v) => { try { return JSON.stringify(v).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ').replace(/^\{/, '{ ').replace(/\}$/, ' }') } catch { return String(v) } }
const describeFault = (f) => [f.delay ? `takes ${f.delay[0]}–${f.delay[1]} ms` : '', f.dupP ? `duplicates ${Math.round(f.dupP * 100)}% of frames` : ''].filter(Boolean).join(' and ') || 'is back to normal'
const describeStore = (f) => [f.delay ? `takes ${f.delay[0]}–${f.delay[1]} ms per save` : '', f.lieP ? `lies about ${Math.round(f.lieP * 100)}% of saves` : '', f.failP ? `fails ${Math.round(f.failP * 100)}% of saves` : ''].filter(Boolean).join(', ') || 'is back to normal'
