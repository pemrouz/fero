// E-57 group A: one seeded world. A log (one group, as in the first build: a position is a log index), three copies
// that fold it with their own lags (a stand-in for Raft followers; the leader folds at once), clients on links with
// FIFO queues in each direction, and faults drawn from the seed: disconnects, copy kills and restarts, leader kills,
// deploys. The same seed gives the same run.
//
// What it leaves out: Raft itself (an append is committed at once; a new leader has every committed entry), real
// sockets (links are in-process queues; E-55 ran the same frames over MessagePorts), slots and slot moves (one group),
// time (a step is one tick), and the membership protocol (every copy and client sees the copy list at once).
import { Copy, table, impureTable, liveViews, MUT, canon, D, SourceNode } from '../proto/served.mjs'
import { Client } from '../proto/client.mjs'
import { query, chainQuery, compare } from '../proto/oracle.mjs'

// mulberry32 (31-bit outputs): good low bits, so r() % n is fair for small n (an LCG's low bit alternates)
export const rng = (seed) => { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) & 0x7fffffff } }
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }

export function newStats() {
  return {
    commits: 0, unequal: 0, settledUnequal: 0, backInTime: 0, doubled: 0, missed: 0, gaps: 0, dupFrames: 0, framesDropped: 0, framesApplied: 0,
    encodes: 0, sends: 0, frames: 0, frameBytes: 0, pictures: 0, pictureBytes: 0, resumeBytes: 0, resumePictures: 0, ringResumes: 0, ringFrames: 0, clientRingResumes: 0, clientPictures: 0,
    subs: 0, resubs: 0, joins: 0, builds: 0, disposed: 0, sinkAfterDispose: 0, sinkAfterEnd: 0, sinkCalls: 0, waits: 0, decodes: 0, stale: 0,
    disconnects: 0, kills: 0, leaderKills: 0, restarts: 0, deploys: 0, movedAnswers: 0, leaderEntries: 0, leaderMovedEnds: 0,
    refusedCap: 0, refusedHeld: 0, capExceeded: 0, admitMismatch: 0, admits: 0, denied: 0, leaked: 0, gets: 0, getsChecked: 0, getUnequal: 0, getRefused: 0, getTooMany: 0, getMoved: 0,
    xa4Unequal: 0, xa4Unchanged: 0, xa5Unequal: 0, xa6Unequal: 0, xa6Checks: 0, tooBig: 0, maxBuildsPerKey: 0, warn80: 0,
    syncs: 0, syncFail: 0, calls: 0, callUnequal: 0, leftEntries: 0, leftViews: 0, versionBack: 0, staleShape: 0, retryOld: 0, fallbacks: 0,
    checks: 0, pageReads: 0, crossDup: 0, rebuildAfterTooBig: 0, buildsOnSnapshot: 0, dupViews: 0, clientShares: 0, resumeSeqMismatch: 0, oldVersionFrames: 0, costExceeded: 0, pageIndexes: 0,
  }
}

export class World {
  constructor(seed, cfg) {
    this.seed = seed; this.r = rng(seed); this.t = 0
    const r = this.r
    this.cfg = { copies: 3, clients: 3, steps: 300, ring: 2 + (r() % 7), linger: 3 + (r() % 18), viewsMax: 64, viewsClient: 16, viewsRows: 0, headroom: 0, budget: 0, shapes: 1000, place: true, downFor: 6, depth: 1, rows: 20 + (r() % 30), parts: 4, tv: 1, ...cfg }
    this.stats = newStats()
    this.fails = new Map()
    // the log and the truth: snaps[p] is the rows after commit p (pure JS; never data)
    this.log = [null]
    const rows = new Map()
    this.nextKey = 0
    for (let i = 0; i < this.cfg.rows; i++) { const row = this.newRow(); rows.set(this.fk(row), row) }
    this.snaps = [rows]
    this.copies = []
    for (let i = 0; i < this.cfg.copies; i++) { const c = new Copy(this, i); c.start(this.rowsFor(0), 0, this.cfg.tv, this.cfg.depth); this.copies.push(c) }
    this.leader = 0
    this.links = new Map(); this.linkIds = 0; this.downs = []
    this.clients = []
    for (let i = 0; i < this.cfg.clients; i++) this.clients.push(new Client(this, i, this.cfg.clientOpts?.(i) ?? {}))
    this.builds = new Map() // copy incarnation + key -> builds (XA-12)
    this.clock = new Map() // XA-8: a clock per copy
  }
  fk(row) { return this.cfg.depth === 1 ? row.id : row.part + '/' + row.id }
  newRow(id) {
    const r = this.r
    const row = { id: id ?? 'k' + this.nextKey++, points: r() % 10, pts: ((r() % 2001) - 1000) / 10, team: 't' + (r() % 4), name: 'u' + (r() % 4), at: this.log ? this.log.length : 0 }
    if (this.cfg.depth === 2) row.part = 'p' + (r() % this.cfg.parts)
    return row
  }
  rowsFor(p) {
    const snap = this.snaps[p]
    if (this.cfg.depth === 1) return [...snap]
    const parts = new Map()
    for (let i = 0; i < this.cfg.parts; i++) parts.set('p' + i, new Map())
    for (const row of snap.values()) parts.get(row.part).set(row.id, row)
    return [...parts]
  }
  partRows(p, part) { const m = new Map(); for (const row of this.snaps[p].values()) if (row.part === part) m.set(row.id, row); return m }
  tables(tv, copy) { return this.cfg.impure ? impureTable(() => this.copyClock(copy)) : table(tv) }
  // XA-8: a copy's clock advances with time, from its own offset (a restarted copy reads its own clock)
  copyClock(copy) { return this.cfg.clockConst !== undefined ? this.cfg.clockConst : (this.clock.get(copy.id + '.' + copy.inc) ?? 0) + this.t }
  get logEnd() { return this.log.length - 1 }

  // ── the leader appends one commit (1 to 3 ops) ──
  append(forced) {
    if (this.leader < 0) return null
    const r = this.r, cur = this.snaps[this.logEnd], keys = [...cur.keys()], ops = [], next = new Map(cur), used = new Set()
    const n = forced ? 1 : 1 + (r() % 3)
    for (let i = 0; i < n; i++) {
      const x = r() % 100
      let fk = keys.length ? keys[r() % keys.length] : null
      if (fk !== null && used.has(fk)) continue
      if (fk === null || x < 10) { // a new row
        const row = this.newRow(); fk = this.fk(row); ops.push({ p: row.part, k: row.id, row }); next.set(fk, row)
      } else if (x < 15 && keys.length > 5) {
        const old = cur.get(fk); ops.push({ p: old.part, k: old.id, del: true }); next.delete(fk)
      } else {
        const old = cur.get(fk)
        if (x < 55) { const v = r() % 10; ops.push({ p: old.part, k: old.id, f: 'points', v }); next.set(fk, { ...old, points: v }) }
        else if (x < 75) { const v = ((r() % 2001) - 1000) / 10; ops.push({ p: old.part, k: old.id, f: 'pts', v }); next.set(fk, { ...old, pts: v }) }
        else if (x < 85) { const v = 't' + (r() % 4); ops.push({ p: old.part, k: old.id, f: 'team', v }); next.set(fk, { ...old, team: v }) }
        else { const row = { ...this.newRow(old.id), part: old.part }; if (this.cfg.depth === 1) delete row.part; ops.push({ p: old.part, k: old.id, row }); next.set(fk, row) }
      }
      used.add(fk)
    }
    if (!ops.length) return null
    this.log.push(ops); this.snaps.push(next); this.stats.commits++
    const L = this.copies[this.leader]
    L.fold(this.logEnd, ops)
    return this.logEnd
  }
  foldOne(c) { if (c.alive && c.pos < this.logEnd) c.fold(c.pos + 1, this.log[c.pos + 1]) }

  // ── placement: rendezvous hashing over the serving copies (alive, not the leader) ──
  serving() { // planted 'onleader': the leader serves views too
    const live = this.copies.filter((c) => c.alive)
    // standbys first (cfg.standbysFirst, the page's first rule); else every live copy but the leader serves
    if (this.cfg.standbys && this.cfg.standbysFirst) { const sb = live.filter((c) => this.isStandby(c.id)); if (sb.length) return sb }
    return live.filter((c) => c.id !== this.leader || MUT.has('onleader'))
  }
  // a standby holds a copy and never leads (cfg.standbys: the last copies are standbys; added after the skeptic's F2)
  isStandby(id) { return id >= this.cfg.copies - (this.cfg.standbys ?? 0) }
  // headroom kept free for held views. cfg.headroomRule (added after the skeptic's F2): views.max / k with k >= 2
  // serving copies, and 0 with one serving copy (its failover goes to copies that hold no views); the planted
  // 'fixedhead' keeps views.max / k at k = 1 too (the page's first formula). Without the rule: cfg.headroom, fixed.
  headroomNow() {
    if (!this.cfg.headroomRule) return this.cfg.headroom
    const k = this.serving().length
    return k >= 2 || MUT.has('fixedhead') ? Math.floor(this.cfg.viewsMax / Math.max(k, 1)) : 0
  }
  owner(place) {
    let best = null, bh = -1
    for (const c of this.serving()) { const h = fnv(place + '#' + c.id); if (h > bh) { bh = h; best = c.id } }
    return best
  }
  placeKey(s) { return s.cls === 'C' ? (s.spec?.method === 'page' ? 'C|page' : s.key) : 'P|' + s.spec.part }
  route(client, s) {
    if (this.cfg.place && s.cls === 'C' && MUT.has('freecopy')) { const sv = this.serving(); return sv.length ? sv[this.r() % sv.length].id : null }
    return this.owner(this.placeKey(s))
  }
  rebalance() {
    for (const c of this.copies) if (c.alive) for (const e of [...c.entries.values()]) {
      const o = this.owner(e.place)
      if (o !== c.id) { if (c.id === this.leader) this.stats.leaderMovedEnds++; c.endEntry(e, 'moved', o) }
    }
  }
  costOf(def, copy) {
    if (!this.cfg.budget || !def) return 0
    const N = this.cfg.nominalRows ?? 1000
    return def.cost === 'ordered' ? 0.0018 * N : def.cost === 'bucket' ? 1.2 : 0.3 // µs per write (a guess from E-05 and the critic's 1.1)
  }

  // ── links ──
  linkOf(ci, k) { return this.links.get(ci + ':' + k) }
  toCopy(client, k, m, ensure) {
    let l = this.linkOf(client.id, k)
    if (!l) { if (!ensure) return; l = { id: ++this.linkIds, ci: client.id, k, qC: [], qS: [] }; this.links.set(client.id + ':' + k, l) }
    if (!this.copies[k].alive) { this.downs.push([client, k]); return }
    l.qC.push(m)
  }
  toClient(copy, linkId, msg) {
    for (const l of this.links.values()) if (l.id === linkId) { l.qS.push(msg); return }
  }
  disconnect(l) {
    this.links.delete(l.ci + ':' + l.k)
    l.qC.length = 0; l.qS.length = 0
    const c = this.copies[l.k]
    if (c.alive) c.dropLink(l.id)
    this.clients[l.ci].linkDown(l.k)
    this.stats.disconnects++
  }
  deliverOne() {
    const ls = [...this.links.values()].filter((l) => l.qC.length || l.qS.length)
    if (!ls.length) return false
    const l = ls[this.r() % ls.length]
    if (l.qC.length && (!l.qS.length || this.r() % 2 === 0)) { const m = l.qC.shift(); const c = this.copies[l.k]; if (c.alive) c.onMsg(l.id, l.ci, m) }
    else { const m = l.qS.shift(); this.clients[l.ci].onMsg(l.k, m) }
    return true
  }

  // ── faults ──
  kill(k) {
    const c = this.copies[k]
    if (!c.alive) return
    for (const l of [...this.links.values()]) if (l.k === k) this.disconnect(l)
    c.kill(); this.stats.kills++
    ;(this.killTimes ??= []).push(this.t)
    if (k === this.leader) { this.stats.leaderKills++; this.elect() }
    this.rebalance()
  }
  elect() {
    const live = this.copies.filter((c) => c.alive && !this.isStandby(c.id)) // a standby never leads
    if (!live.length) { this.leader = -1; return }
    const L = live[this.r() % live.length]
    while (L.pos < this.logEnd) this.foldOne(L) // a new leader has every committed entry
    this.leader = L.id
    // XA-1: no views on a leader: the new leader hands its entries on (END moved)
    if (!MUT.has('onleader')) for (const e of [...L.entries.values()]) { this.stats.leaderMovedEnds++; L.endEntry(e, 'moved', this.owner(e.place)) }
  }
  restart(k) {
    const c = this.copies[k]
    if (c.alive) return
    // from a snapshot at a recent position (as from a peer), never from the log's start
    const p0 = Math.max(0, this.logEnd - (this.r() % 10))
    c.start(this.rowsFor(p0), p0, this.cfg.tvOf ? this.cfg.tvOf(k) : this.curTv(k), this.cfg.depth)
    if (this.cfg.impure) this.clock.set(c.id + '.' + c.inc, this.r() % 40)
    this.stats.restarts++
    if (this.leader < 0 && !this.isStandby(k)) { this.leader = k; while (c.pos < this.logEnd) this.foldOne(c) }
    this.rebalance()
  }
  curTv(k) { return this.deployed?.has(k) ? this.cfg.tv2 ?? 2 : this.cfg.tv }

  // ── hooks from the copies and clients ──
  onBuild(copy, e) {
    this.stats.builds++
    const k = copy.id + '.' + copy.inc + '|' + e.key
    const n = (this.builds.get(k) ?? 0) + 1
    this.builds.set(k, n)
    if (n > this.stats.maxBuildsPerKey) this.stats.maxBuildsPerKey = n
    if (copy.id === this.leader) this.stats.leaderEntries++
    if (copy.tooBigEver.has(e.key)) { this.stats.rebuildAfterTooBig++; this.fail('rebuildTooBig') }
    if (copy.pos > 0 && copy.startPos > 0) this.stats.buildsOnSnapshot++
    // A4: two live entries on one copy for one (method, canonical argument, version)
    if (e.cls === 'C') { const k = e.method + '|' + canon(e.arg) + '|' + e.ver; for (const x of copy.entries.values()) if (x !== e && x.cls === 'C' && !x.dead && x.method + '|' + canon(x.arg) + '|' + x.ver === k) { this.stats.dupViews++; this.fail('dupView') } }
  }
  checkJoin(copy, ci, ok) {
    let cli = 0
    for (const e of copy.entries.values()) if (e.holders.has(ci) || (e.lingerAt !== null && e.last === ci)) cli++
    if ((cli < this.cfg.viewsClient) !== ok) { this.stats.admitMismatch++; this.fail('join') }
  }
  onAttach(copy, e, ci, m) { if (!e.place) e.place = m.place }
  onRefused(client, s, m) {
    if (m.code === 'too-many-views' && s.held) {
      this.stats.refusedHeld++
      // how many copy failures came in the two lingers before this refusal (added after the skeptic's F2 and F24)
      const n = (this.killTimes ?? []).filter((t) => t > this.t - 2 * this.cfg.linger).length
      const k = 'refusedHeldAfter' + Math.min(n, 2) + (n >= 2 ? 'plus' : '') + 'Kills'
      this.stats[k] = (this.stats[k] ?? 0) + 1
      if (this.cfg.failHeld) this.fail('refusedHeld')
    }
  }
  checkAdmit(copy, ci, held, cost, ok) {
    const cfg = this.cfg
    let n = copy.entries.size, cli = 0, costSum = 0
    for (const e of copy.entries.values()) { if (e.holders.has(ci) || (e.lingerAt !== null && e.last === ci)) cli++; costSum += this.costOf(copy.table[e.method], copy) }
    // the rule written apart from the copy's (a planted 'fixedhead' changes only the copy's)
    const ks = this.serving().length, head = cfg.headroomRule ? (ks >= 2 ? Math.floor(cfg.viewsMax / ks) : 0) : cfg.headroom
    const room = held ? cfg.viewsMax : cfg.viewsMax - head
    let want = n < room && cli < cfg.viewsClient
    if (cfg.headroomRule && !held) { const k = 'fresh' + (ok ? 'Admitted' : 'Refused') + 'At' + Math.min(this.serving().length, 3) + 'Serving'; this.stats[k] = (this.stats[k] ?? 0) + 1 }
    if (cfg.budget) want = want && costSum + cost <= cfg.budget
    this.stats.admits++
    if (want !== ok) { this.stats.admitMismatch++; this.fail('admit') }
  }
  // the independent count of live plus lingering entries, after every step
  checkCaps() {
    const cfg = this.cfg
    // XA-2: one key is built on one copy only (live entries, across copies)
    if (cfg.place) { const where = new Map(); for (const c of this.copies) if (c.alive) for (const e of c.entries.values()) if (e.cls === 'C') { const k = e.key; if (where.has(k) && where.get(k) !== c.id) { this.stats.crossDup++; this.fail('crossDup') } where.set(k, c.id) } }
    for (const c of this.copies) {
      if (!c.alive) continue
      if (c.id === this.leader && c.entries.size) { this.stats.leaderEntries++; this.fail('leader') }
      if (c.entries.size > cfg.viewsMax) { this.stats.capExceeded++; this.fail('cap') }
      const per = new Map()
      for (const e of c.entries.values()) {
        const who = new Set(e.holders.keys()); if (e.lingerAt !== null && e.last !== null) who.add(e.last)
        for (const ci of who) per.set(ci, (per.get(ci) ?? 0) + 1)
        if (cfg.viewsRows && e.cls === 'C' && e.view.kind !== 'scalar' && e.view.size() > 0.8 * cfg.viewsRows) this.stats.warn80++
      }
      for (const n of per.values()) if (n > cfg.viewsClient) { this.stats.capExceeded++; this.fail('capClient') }
      if (cfg.budget) { let s = 0; for (const e of c.entries.values()) s += this.costOf(c.table[e.method], c); if (s > cfg.budget + 1e-9) { this.stats.costExceeded++; this.fail('cost') } }
    }
  }
  expected(s, p) {
    if (s.cls === 'C') {
      if (this.cfg.impure) return query('recent', 1, { threshold: s.th }, this.snaps[p])
      return query(s.spec.method, s.ver, s.spec.arg, this.snaps[p])
    }
    return chainQuery(s.spec.ops ?? [], this.partRows(p, s.spec.part))
  }
  check(client, s, why, c) {
    const st = this.stats
    st.checks++
    if (s.pos < 0 || s.pos > this.logEnd) { st.unequal++; this.fail('pos', s); return }
    if (this.cfg.impure && s.th === undefined) s.th = this.cfg.thresholdOf(s) // XA-8: the query keeps the threshold of the first picture
    const exp = this.expected(s, s.pos)
    if (s.cls === 'A' && !(s.spec.ops ?? []).length) { /* a bare partition: compare rows */ }
    const why2 = compare(exp, s.value)
    if (why2) { st.unequal++; this.fail('unequal:' + why + ':' + why2, s) }
    // A4: a frame to a subscriber whose allow fails
    if (s.cls === 'C') {
      const def = table(1)[s.spec.method]
      if (def?.allow && !def.allow(s.spec.arg, client.claims)) { st.leaked++; this.fail('leaked', s) }
      if (this.cfg.typedV1 && client.shapes && s.spec.method === 'best' && s.ver === 2) { st.staleShape++; this.fail('staleShape', s) }
    }
    // XA-6: operators right of a served ordered view (map and filter) keep its order
    if (s.cls === 'C' && exp.kind === 'rows' && this.cfg.right) {
      st.xa6Checks++
      const want = exp.rows.filter((r) => r.pts > 0).map((r) => r.id + ':' + r.points)
      const got = this.right(s, c)
      if (JSON.stringify(want) !== JSON.stringify(got)) { st.xa6Unequal++; this.fail('xa6', s) }
    }
  }
  // XA-6: the client's operators right of the live verb. The design: an ordered mirror (the selection's rows and order,
  // N8) that map and filter read in order. Planted 'keyedright': a plain keyed data source fed from c (E-55's sim).
  right(s, c) {
    if (!MUT.has('keyedright')) return s.value.order.map((k) => s.value.rows.get(k) ?? { id: k, pts: 1, points: 'missing' }).filter((r) => r.pts > 0).map((r) => r.id + ':' + r.points)
    if (!s.keyed) {
            s.keyed = { rt: new D.Runtime() }
      s.keyed.src = new SourceNode(s.keyed.rt, {})
      s.keyed.view = D.handleFor(s.keyed.src).filter((r) => r.pts > 0).map((r) => r.id + ':' + r.points)
    }
    const K = s.keyed
    if (c) K.rt.batch(() => { for (const d of c.first ? [] : c.diff) { if (d.type === 'remove') { if (K.src.get(d.key) !== undefined) K.src.remove(d.key) } else K.src.write(d.key, [], d.row) } })
    const v = K.view[D.value]
    return Array.isArray(v) ? v : Object.values(v)
  }
  checkSync(client, s, m) {
    this.stats.syncs++
    const want = s.syncWant ?? 0
    const exp = this.expected(s, Math.max(m.p, want))
    if (m.p < want || compare(exp, s.value)) { this.stats.syncFail++; this.fail('sync', s) }
    s.syncWant = undefined
  }
  checkGet(client, g, m) {
    const st = this.stats
    st.getsChecked++
    const v = { kind: m.k }
    if (m.k === 'rows') { v.rows = new Map(m.r.map((x) => [x[1], x[2]])); v.order = m.r.map((x) => x[1]) }
    else if (m.k === 'buckets') v.map = new Map(m.r.map((x) => [x[1], x[2]]))
    else v.value = m.r[0][1]
    const exp = query(g.spec.method === 'page' ? 'after' : g.spec.method, m.v || 1, g.spec.arg, this.snaps[m.p])
    if (compare(exp, v) || m.p < g.seen) { st.getUnequal++; this.fail('get') }
  }
  checkCall(client, c, m) {
    const want = [...this.snaps[m.p].values()].filter((r) => r.points > c.arg).length
    if (want !== m.v) { this.stats.callUnequal++; this.fail('call') }
  }
  fail(kind, s) { this.fails.set(kind, (this.fails.get(kind) ?? 0) + 1) }

  // ── the scheduler ──
  step() {
    const r = this.r, cfg = this.cfg, w = cfg.weights
    this.t++
    for (const c of this.copies) if (c.alive) c.tick(this.t)
    for (const [cl, k] of this.downs.splice(0)) cl.linkDown(k)
    for (const cl of this.clients) cl.tick(this.t)
    const x = r() % 1000
    if (x < w.write) this.append()
    else if (x < w.fold) { const lag = this.copies.filter((c) => c.alive && c.pos < this.logEnd); if (lag.length) this.foldOne(lag[r() % lag.length]) }
    else if (x < w.deliver) this.deliverOne()
    else if (x < w.client) this.clientAction(this.clients[r() % this.clients.length])
    else if (x < w.fault) cfg.fault?.(this)
    this.checkCaps()
  }
  clientAction(cl) {
    const r = this.r, cfg = this.cfg
    const open = [...cl.sels.values()]
    const x = r() % 100
    if (x < cfg.pOpen && open.length < cfg.maxOpen) cl.open(cfg.spec(this, cl))
    else if (x < cfg.pClose && open.length) cl.close(open[r() % open.length])
    else if (x < cfg.pGet) { if (cfg.getSpec) cl.get(cfg.getSpec(this, cl)) }
    else if (x < cfg.pWrite) {
      const p = this.append(true)
      if (p !== null) { if (p > cl.seen) cl.seen = p; const up = open.filter((s) => s.status === 'up' && s.syncWant === undefined); if (up.length && cfg.sync) { const s = up[r() % up.length]; s.syncWant = p; this.toCopy(cl, s.copy, { t: 'sync', h: s.h, seen: p, id: ++cl.ids }, false) } }
    } else if (x < cfg.pCall && cfg.calls) {
      const sv = this.serving(); if (sv.length) { const id = ++cl.ids, arg = r() % 10; cl.calls.set(id, { arg }); this.toCopy(cl, sv[r() % sv.length].id, { t: 'call', id, method: 'countAbove', arg }, true) }
    }
  }
  run() {
    for (let i = 0; i < this.cfg.steps; i++) { this.cfg.atStep?.(this, i); this.step() }
    this.settle()
    return this
  }
  settle() {
    for (const c of this.copies) if (!c.alive) this.restart(c.id)
    for (let round = 0; round < 400; round++) {
      for (const c of this.copies) while (c.alive && c.pos < this.logEnd) this.foldOne(c)
      let n = 0
      while (this.deliverOne()) if (++n > 100000) break
      this.t++
      for (const c of this.copies) if (c.alive) c.tick(this.t)
      for (const [cl, k] of this.downs.splice(0)) cl.linkDown(k)
      for (const cl of this.clients) cl.tick(this.t)
      const busy = [...this.links.values()].some((l) => l.qC.length || l.qS.length) || this.clients.some((cl) => [...cl.sels.values()].some((s) => s.status === 'down' || s.status === 'wait' || s.status === 'sub')) || this.copies.some((c) => c.alive && c.pending.length)
      if (!busy) break
    }
    this.checkCaps()
    // settled: every live selection equals the query at the end of the log
    for (const cl of this.clients) for (const s of cl.sels.values()) if (s.status === 'up') {
      const exp = this.expected(s, this.logEnd)
      if (compare(exp, s.value)) { this.stats.settledUnequal++; this.fail('settled', s) }
    }
    if (this.cfg.closeAll) {
      for (const cl of this.clients) for (const s of [...cl.sels.values()]) { s.refs = 1; cl.close(s) }
      for (let i = 0; i < 3; i++) { while (this.deliverOne()); this.t += this.cfg.linger + 10; for (const c of this.copies) if (c.alive) c.tick(this.t); for (const c of this.copies) if (c.alive) c.tick(this.t + 10) }
      for (const c of this.copies) if (c.alive) {
        this.stats.leftEntries += c.entries.size
        if (c.depth === 1) this.stats.leftViews += liveViews(c.src)
        else for (const s of c.parts.values()) this.stats.leftViews += liveViews(s)
      }
      if (this.stats.leftViews || this.stats.leftEntries) this.fail('left')
    }
  }
}
