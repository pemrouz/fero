// sections/argument/track.js — follow ONE write through fero's kernel by its bytes. DOM-free: it takes a
// LiveCluster (the page's `page`, or a core.js run in Node) and listens to the driver's taps.
//
// How a write is followed (kernel/write.ts): c1's assignment leaves c1 as a WRITE frame whose provenance
// triple is the ATTEMPT triple [issuer, cid, attemptEpoch 0]. The first such frame after the page posts the
// record names the attempt (issuer + cid). From then on a frame carries this write when:
//   WRITE         — it holds a record with that issuer and cid (a relay hop, or a retry);
//   WACK / WNACK  — its { u, c, n } covers that cid (the owner's receipt, passed on, or re-sent);
//   RECORDS       — its attempt identity (FLAG_ATTEMPT) covers that cid, or it holds the stamped record.
// The first RECORDS frame names the stamp the owner gave (origin, seq, epoch). An `apply` with that origin
// and seq is a copy taking the write. Nothing here is guessed or typed: every value is read off a frame
// the kernel sent (decoded by kernel/codec.js) or an apply the kernel made.
//
// `trail` keeps every apply to the write's row on every node after the write was issued, so the page can
// show what each copy held at any simulated instant of the write (its slow-motion replay reads the past).
//
// Probes (the confirm ladder) are posted by askProbes(), which the page calls from its own frame loop,
// never from inside a cluster callback. core.js does not log probes in `actions`, but a probe is an event
// (one more sim event, one more trace entry), so a replay twin built from `actions` would not match the
// live run. askProbes() logs each probe it posts, in the same shape as core.js's own actions, so
// LiveCluster.replay re-posts it at the same simulated instant. If core.js starts logging probes itself,
// the length check below skips ours.
const CARRY = new Set(['WRITE', 'RECORDS', 'WACK', 'WNACK'])
const KEEP = 4 // writes followed at once (newest last); a pinned write is never dropped
const TAIL = 2500 // ms of simulated time a write is still followed after it is done (late re-ships, receipts)
const TRAIL = 256 // applies to the row kept per write

export function createTracker(lc, { decode, stable, CONFIRM, pair }) {
  const entries = []
  const subs = new Set()
  let dirty = false
  let seq = 0

  const nodeOf = (origin) => String(origin).split('~')[0]
  const touch = () => { dirty = true }
  // the issuer is gone: crashed, left, or back in a later life (a new life does not carry the old attempt)
  const issuerGone = (e) => !lc.alive(e.node) || (e.life !== null && lc.life(e.node) !== e.life)

  function track(w, { probes = false, mine = false } = {}) {
    const e = {
      id: ++seq, w, mine, wantProbes: probes, pinned: false,
      node: w.node, row: w.path[0], key: w.key, value: w.value, valueKey: stable(w.value), by: w.by,
      life: lc.alive(w.node) ? lc.life(w.node) : null,
      issuedAt: w.issuedAt, events0: lc.events, violations0: lc.violations, rules: lc.rules.length,
      before: new Map(), // node → { value, stamp } as the write was issued
      att: null, recordFrame: null,
      frames: [], byVerb: {}, bytes: 0,
      hops: [], routes: new Map(), retries: 0, nacks: [],
      stamp: null, stampAt: null, ownerId: null, ownerAtIssue: lc.owner(w.path[0]), primaryAtIssue: lc.primary(w.node),
      viewAtStamp: null,
      applies: new Map(), cands: [], trail: [],
      asked: false, probes: { replicated: null, persisted: null },
      diedAt: null, doneAt: null, closed: false,
    }
    for (const id of lc.ids()) if (lc.alive(id)) e.before.set(id, { value: lc.cell(id, e.row), stamp: lc.stamp(id, e.row) ?? null })
    entries.push(e)
    // drop the oldest write no one is reading any more: a pinned write and a visitor's write still in progress stay
    while (entries.length > KEEP) {
      const i = entries.findIndex((x) => !x.pinned && (x.closed || !x.mine))
      if (i < 0) break
      entries.splice(i, 1)
    }
    touch()
    return e
  }

  function setStamp(e, s, at) {
    e.stamp = s
    e.ownerId = nodeOf(s.origin)
    e.stampAt = at
    if (lc.alive(e.ownerId)) e.viewAtStamp = lc.viewOf(e.ownerId)
    for (const a of e.cands) if (a.origin === s.origin && a.seq === s.seq && !e.applies.has(a.node)) e.applies.set(a.node, { at: a.at, value: a.value })
    const own = e.applies.get(e.ownerId)
    if (own) e.stampAt = own.at
    e.cands = []
  }

  function carries(e, f, d) {
    const { issuer, cid } = e.att
    if (d.name === 'WRITE') return d.recs.some((r) => r.origin === issuer && r.seq === cid) ? 'write' : null
    if (d.name === 'WACK' || d.name === 'WNACK') {
      const v = d.value
      return v && v.u === issuer && cid >= v.c && cid < v.c + v.n ? (d.name === 'WACK' ? 'ack' : 'nack') : null
    }
    if (d.name === 'RECORDS') {
      let i = -1
      const a = d.attempt
      if (a && a.issuer === issuer) { i = cid - a.baseCid; if (i < 0 || i >= d.recs.length) i = -1 }
      if (i < 0 && e.stamp) i = d.recs.findIndex((r) => r.origin === e.stamp.origin && r.seq === e.stamp.seq)
      if (i < 0) return null
      if (!e.stamp) { const r = d.recs[i]; setStamp(e, { epoch: r.epoch, seq: r.seq, origin: r.origin }, f.sentAt) }
      return 'repl'
    }
    return null
  }

  function push(e, f, d, kind) {
    // n: a unique id per followed frame (two frames can share route, verb and instant: a live send and a re-ship)
    const item = { n: (e.fseq = (e.fseq ?? 0) + 1), from: f.from, to: f.to, verb: d.name, kind, sentAt: f.sentAt, recvAt: f.recvAt, size: f.size, d, first: false, again: false }
    const route = f.from + '>' + f.to + '>' + kind
    if (e.routes.has(route)) { item.again = true; if (kind === 'write') e.retries++ }
    else { e.routes.set(route, item); item.first = true; if (kind === 'write') e.hops.push(item) }
    if (kind === 'nack') e.nacks.push(item)
    e.frames.push(item)
    if (e.frames.length > 600) e.frames.shift()
    e.byVerb[d.name] = (e.byVerb[d.name] ?? 0) + 1
    e.bytes += f.size
    touch()
  }

  const offs = []
  offs.push(lc.on('frame', (f) => {
    if (!entries.length || !CARRY.has(f.verb)) return
    let d = null
    for (const e of entries) {
      if (e.closed) continue
      if (!e.att) {
        if (f.from !== e.node || f.verb !== 'WRITE' || f.sentAt < e.issuedAt) continue
        d ??= decode(f.bytes)
        const r = d.recs.find((x) => x.key.length === 1 && x.key[0] === e.row && stable(x.value) === e.valueKey)
        if (!r) continue
        e.att = { issuer: r.origin, cid: r.seq }
        e.recordFrame = { from: f.from, to: f.to, sentAt: f.sentAt, recvAt: f.recvAt, size: f.size, rec: { type: r.type, key: r.key, value: r.value }, count: d.recs.length }
        push(e, f, d, 'write')
        continue
      }
      d ??= decode(f.bytes)
      const kind = carries(e, f, d)
      if (kind) push(e, f, d, kind)
    }
  }))
  offs.push(lc.on('apply', (a) => {
    for (const e of entries) {
      if (e.closed || a.key !== e.key || a.at < e.issuedAt) continue
      e.trail.push({ node: a.node, at: a.at, value: a.value, stamp: { epoch: a.epoch, seq: a.seq, origin: a.origin } })
      if (e.trail.length > TRAIL) e.trail.shift()
      if (e.stamp) {
        if (a.origin === e.stamp.origin && a.seq === e.stamp.seq && !e.applies.has(a.node)) { e.applies.set(a.node, { at: a.at, value: a.value }); touch() }
      } else { e.cands.push(a); if (e.cands.length > 64) e.cands.shift() }
    }
  }))
  offs.push(lc.on('journal', (j) => {
    if (j.name !== 'confirmed') return
    for (const e of entries) for (const p of Object.values(e.probes))
      if (p && p.ok === undefined && p.on === j.node && p.id === j.a) { p.ok = j.b === 1; p.count = j.c; p.at = j.at; p.members = lc.alive(j.node) ? lc.viewOf(j.node).members.length : null; touch() }
  }))
  // the issuer's own death (a crash, or a clean leave finishing): the instant is what tells whether its
  // WRITE had already reached a server (a frame that landed before the cut was delivered)
  const died = (id) => { for (const e of entries) if (e.node === id && e.diedAt === null) { e.diedAt = lc.now; touch() } }
  offs.push(lc.on('kill', died), lc.on('left', died))
  offs.push(lc.on('tick', (now) => {
    for (const e of entries) {
      if (e.closed) continue
      if (!e.doneAt && isDone(e, now)) { e.doneAt = now; touch() }
      if (e.doneAt && now - e.doneAt > TAIL) { e.closed = true; touch() }
    }
    if (dirty) { dirty = false; for (const fn of subs) { try { fn() } catch (err) { console.error(err) } } }
  }))
  offs.push(lc.on('reset', () => { entries.length = 0; touch(); for (const fn of subs) { try { fn() } catch (err) { console.error(err) } } }))

  // done: every live node holds the stamp (the issuer too, unless it is gone), and the probes (when asked
  // for) have answered
  function isDone(e, now) {
    if (!e.stamp) return false
    if (!e.applies.has(e.node) && !issuerGone(e)) return false
    const late = now - e.stampAt > 3000
    for (const id of lc.ids()) if (lc.alive(id) && !e.applies.has(id) && !late && !(id === e.node && issuerGone(e))) return false
    if (e.wantProbes && lc.alive(e.ownerId) && !late) {
      if (!e.asked) return false
      for (const p of Object.values(e.probes)) if (p && p.ok === undefined) return false
    }
    return true
  }

  // reached(e): the write was in a server's hands before its issuer went: a WRITE from the issuer that landed
  // at or before the death instant (or a server already passed it on). Then the server owns the attempt and
  // the write goes on without its issuer (kernel/write.ts: the relay owns re-resolution).
  function reached(e) {
    if (e.frames.some((f) => f.kind === 'write' && f.from !== e.node)) return true
    const cut = e.diedAt ?? Infinity
    return e.frames.some((f) => f.kind === 'write' && f.from === e.node && f.recvAt <= cut)
  }

  // askProbes(e): post the two confirm probes on the owner (from the page's frame loop, never a callback)
  function askProbes(e) {
    if (!e || e.asked || !e.wantProbes || !e.stamp || !lc.alive(e.ownerId)) return false
    e.asked = true
    for (const [name, level] of [['replicated', CONFIRM.replicated], ['persisted', CONFIRM.persisted]]) {
      const n0 = lc.actions.length, c0 = lc.sim.confirms.size
      const askedAt = lc.now, ev = lc.events
      const promise = lc.probe(e.ownerId, e.stamp.origin, e.stamp.seq, level)
      if (lc.actions.length === n0) lc.actions.push({ at: askedAt, ev, op: 'probe', args: [e.ownerId, e.stamp.origin, e.stamp.seq, level] })
      let id = null
      if (lc.sim.confirms.size > c0) { let last = ''; for (const k of lc.sim.confirms.keys()) last = k; id = Number(last.slice(last.lastIndexOf('|') + 1)) }
      const p = { name, level, id, on: e.ownerId, askedAt, ok: undefined, count: undefined, at: undefined, members: null }
      e.probes[name] = p
      // the journal's `confirmed` row gives the exact simulated instant; the promise is the fallback
      promise.then((r) => { if (p.ok === undefined) { p.ok = r.ok; p.count = r.count; p.at = r.at; p.approx = true; touch() } })
    }
    touch()
    return true
  }

  // cutOff(id): alive, and cut from every other live node — lede.js's test, so 01 and the hero say "cut off" about the
  // same node at the same moment. The page's cuts are whole-node isolations (the dock, 02, 06, the lede's story); a
  // node cut from only some of the others still gets records by another path, so it is not "cut off".
  function cutOff(id) {
    if (!lc.alive(id)) return false
    let others = 0
    for (const o of lc.ids()) if (o !== id && lc.alive(o)) { others++; if (!lc.cuts.has(pair(id, o))) return false }
    return others > 0
  }

  // waitReason(e): why a write that has no stamp yet is not moving — read from the cluster, never guessed
  function waitReason(e) {
    if (!e || e.stamp) return null
    if (issuerGone(e) && !reached(e)) return { code: 'issuer-down', ids: [e.node] }
    // the issuer is cut off and its WRITE never reached a server: nothing leaves it until the cut heals
    if (!reached(e) && cutOff(e.node)) return { code: 'issuer-cut', ids: [e.node] }
    const owner = lc.owner(e.row)
    if (owner && lc.down.has(owner)) return { code: 'owner-down', ids: [owner] }
    const relay = lc.alive(e.node) ? lc.primary(e.node) : null
    if (relay == null && lc.alive(e.node)) return { code: 'no-server', ids: [e.node] }
    if (!reached(e) && relay != null && relay !== e.node && lc.cuts.has(pair(e.node, relay))) return { code: 'cut', ids: [e.node, relay] }
    if (relay != null && lc.alive(relay)) { const g = lc.writable(relay); if (g && !g.open) return { code: 'gate', ids: [relay], reason: g.reason } }
    if (relay != null && owner && owner !== relay && lc.cuts.has(pair(relay, owner))) return { code: 'cut', ids: [relay, owner] }
    if (owner && cutOff(owner)) return { code: 'owner-cut', ids: [owner] }
    return null
  }

  return {
    entries, track, askProbes, waitReason, cutOff, nodeOf, issuerGone, reached,
    on(fn) { subs.add(fn); return () => subs.delete(fn) },
    latest(pred = () => true) { for (let i = entries.length - 1; i >= 0; i--) if (pred(entries[i])) return entries[i]; return null },
    dispose() { for (const off of offs) off(); subs.clear() },
  }
}
