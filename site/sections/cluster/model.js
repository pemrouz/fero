// sections/cluster/model.js — what the centrepiece knows about THE house cluster, built only from page events.
// Every listener here OBSERVES: it never calls an action (actions come from UI handlers and the section's frame
// loop, between two advances, so the action log replays). Variant b (the timeline) reads the same model.
import { page, decode, Ring, stable, Frame, pair } from '../../cluster.js'

export const base = (origin) => String(origin).split('~')[0]
const skey = (s) => `${s.origin}|${s.seq}|${s.epoch}`

export const M = {
  frames: [],            // frames to draw: { from, to, verb, kind, sentAt, recvAt, size, fresh, hidden }
  sent: new Map(),       // freshness keys already seen (bounded)
  stamps: new Map(),     // stamp key → { stamp, row, path, type, value, nodes: Set, at, ownerAt }
  order: [],             // stamp keys, first seen first (bounded)
  commits: new Set(),    // stamp keys applied at their owner (the owner's own apply)
  life: new Map(),       // page write id → the issuer's life when it was issued
  hops: new Map(),       // page write id → [from, to, to…] from the first WRITE frames that carried it
  flash: new Map(),      // `${node}|${row}` → simulated time of the last apply there
  applied: [],           // { node, at } for every apply (bounded): how much a healed or restarted node took in
  f: null,               // facts for the sentence (see clearFacts)
  resetAt: -1,           // wall time of the last reset (the sentence says "rebuilt from seed …")
  resetBy: '',           // 'story' | 'reset' | 'seed'
  gen: 0,                // bumps on every reset: renderers drop their caches
  keepHidden: false,     // collect PING/PONG/DIGEST frames only while a figure draws them (they are most frames)
}
function clearFacts() {
  M.f = {
    kills: new Map(),      // id → simulated time of the crash
    restarts: new Map(),   // id → simulated time of the restart
    suspect: new Map(),    // suspected id → Map(node → at)
    giveUp: new Map(),     // target id → Map(node → at)
    propose: null,         // { node, epoch, count, at }
    evict: new Map(),      // id → { at, node }
    replay: new Map(),     // id → { records, at, life }
    gate: new Map(),       // id → { open, reason, at }
    ae: [],                // { node, peer, records, at } — anti-entropy shipments
    views: [],             // committed views as the page saw them: { epoch, members, at }
    commit: null,          // the latest page write that committed: { w, at, ws } — ws = that node's writes that
                           // committed at the same instant (an owner stamps a node's waiting writes in one go), kept
                           // WITH the commit, so a later routine commit never changes how this one is told
    batch: null,           // every page write that committed at the current instant: { at, ws }
    waited: null,          // the latest page write that committed after waiting (≥ 0.9 s simulated): { w, at, ws }
    cuts: new Map(),       // pair → simulated time of the cut
    heal: null,            // { a, b, at }
    left: new Map(),       // id → at
    leaving: new Map(),    // id → at: asked to leave (the Ctrl-C path)
    joined: new Map(),     // id → at (addServer / addClient)
    asked: new Map(),      // id → at: the node's own journal says it asked to join (JOIN sent)
    broken: new Map(),     // monitor name → { at, detail, reports }: a kernel check (sim/monitors.ts) that broke.
                           // A broken check is reported again at every later event, so the page counts rules,
                           // not reports
  }
}
clearFacts()

// ── the ring, cached per view (Ring.build is cheap, but the cards ask every frame) ──
const ringCache = new Map()
export function ownerOf(row, view) {
  if (!view || !view.members?.length) return ''
  const k = view.epoch + '|' + view.members.join(',')
  let r = ringCache.get(k)
  if (!r) { r = new Ring(); r.build(view.epoch, view.members.map((m) => [m, `sim:${m}`])); ringCache.set(k, r); if (ringCache.size > 64) ringCache.delete(ringCache.keys().next().value) }
  return r.ownerOf(row)
}

// ── freshness: a frame is FRESH the first time its content crosses that directed link. Retransmits (the
// client's write retry clock, a repeated JOIN, the same VIEW announced again, an anti-entropy re-send of a
// stamp already sent on that link) are not. "watch" slows down only for fresh frames.
function seen(k) { if (M.sent.has(k)) return true; M.sent.set(k, 1); if (M.sent.size > 24000) { let i = 0; for (const x of M.sent.keys()) { M.sent.delete(x); if (++i > 6000) break } } return false }
const lifeOf = (id) => { try { return page.node(id)?.incarnation ?? 0 } catch { return 0 } }
function freshness(f) {
  const link = `${f.from}>${f.to}`
  try {
    if (f.verb === 'HELLO') return !seen(`H ${link} ${lifeOf(f.from)} ${lifeOf(f.to)}`)
    const d = decode(f.bytes)
    if (f.verb === 'WRITE') {
      const p = d.prov || {}
      const fresh = !seen(`W ${link} ${p.origin} ${p.baseSeq} ${p.epoch}`)
      if (fresh) noteHop(f, d)
      return fresh
    }
    if (f.verb === 'RECORDS') { let fresh = false; for (const r of d.recs || []) if (!seen(`R ${link} ${r.origin} ${r.seq}`)) fresh = true; return fresh }
    if (f.verb === 'WACK' || f.verb === 'WNACK') { const v = d.value || {}; return !seen(`A ${link} ${f.verb} ${v.u} ${v.c} ${v.e}`) }
    const v = d.value || {}
    return !seen(`B ${link} ${f.verb} ${v.e ?? ''} ${v.i ?? ''} ${lifeOf(f.from)}`)
  } catch { return false }
}
// the path a page write took: the first fresh WRITE frames whose record is that write's record, from that write's
// node (a WRITE's provenance is the attempt triple: its origin is the issuer and its life, c1~1)
function noteHop(f, d) {
  const r = d.recs?.[0]; if (!r) return
  const key = JSON.stringify(r.key), val = r.type === 2 ? null : stable(r.value)
  const o = d.prov?.origin, issuer = typeof o === 'string' && o.includes('~') ? o.slice(0, o.lastIndexOf('~')) : null
  for (let i = page.writes.length - 1; i >= 0; i--) {
    const w = page.writes[i]
    if (w.state !== 'pending' || w.key !== key || (issuer && w.node !== issuer)) continue
    if (w.remove ? r.type !== 2 : stable(w.value) !== val) continue
    const h = M.hops.get(w.id) ?? []
    if (!h.length) h.push(f.from)
    if (h[h.length - 1] === f.from && !h.includes(f.to)) h.push(f.to)
    M.hops.set(w.id, h)
    return
  }
}

// ── taps ──
// frameTaps: variant b's timeline keeps its own longer window of frames; it receives every frame a figure could
// draw (heartbeats and digests included), with the freshness computed here once, plus the raw frame (its bytes).
export const frameTaps = new Set()
page.on('frame', (f) => {
  const hidden = f.kind === 'beat' || f.kind === 'heal'
  const matters = f.kind === 'write' || f.kind === 'repl' || f.kind === 'vote' || f.kind === 'link'
  const keep = hidden ? M.keepHidden : matters
  if (!keep && !(frameTaps.size && (hidden || matters))) return
  const fr = { from: f.from, to: f.to, verb: f.verb, kind: f.kind, sentAt: f.sentAt, recvAt: f.recvAt, size: f.size, hidden, fresh: hidden ? false : freshness(f) }
  if (keep) { M.frames.push(fr); if (M.frames.length > 900) M.frames.splice(0, M.frames.length - 700) }
  for (const fn of frameTaps) fn(fr, f)
})
page.on('apply', (a) => {
  const s = { epoch: a.epoch, seq: a.seq, origin: a.origin }, k = skey(s)
  let e = M.stamps.get(k)
  if (!e) { e = { stamp: s, row: a.path[0], path: a.path, type: a.type, value: a.value, iss: typeof a.iss === 'string' ? a.iss : null, nodes: new Set(), at: a.at, ownerAt: null }; M.stamps.set(k, e); M.order.push(k); if (M.order.length > 400) { for (const x of M.order.splice(0, 200)) M.stamps.delete(x) } }
  e.nodes.add(a.node)
  if (a.node === base(a.origin)) { M.commits.add(k); if (e.ownerAt == null) e.ownerAt = a.at }
  M.flash.set(`${a.node}|${a.path[0]}`, a.at)
  M.applied.push({ node: a.node, at: a.at }); if (M.applied.length > 800) M.applied.splice(0, 400)
})
page.on('write', (w) => {
  M.life.set(w.id, lifeOf(w.node))
  // keep these maps to the writes the driver still holds (page.writes keeps the last few hundred)
  if (M.life.size > 600) { const keep = new Set(page.writes.map((x) => x.id)); for (const id of M.life.keys()) if (!keep.has(id)) { M.life.delete(id); M.hops.delete(id) } }
})
page.on('commit', (w) => {
  if (M.f.batch && M.f.batch.at === page.now) M.f.batch.ws.push(w); else M.f.batch = { at: page.now, ws: [w] }
  // the batch this commit belongs to, as a copy: the node's writes stamped at this same instant, oldest first
  const ws = M.f.batch.ws.filter((x) => x.node === w.node)
  M.f.commit = { w, at: page.now, ws }
  if (w.committedAt - w.issuedAt >= 900) M.f.waited = { w, at: page.now, ws }
})
page.on('kill', (id) => { M.f.kills.set(id, page.now); M.f.restarts.delete(id); M.f.replay.delete(id); M.f.leaving.delete(id) })
page.on('restart', (id) => { M.f.restarts.set(id, page.now); M.f.kills.delete(id); M.f.suspect.delete(id); M.f.giveUp.delete(id) })
page.on('cut', ([a, b]) => { M.f.cuts.set(a < b ? `${a}|${b}` : `${b}|${a}`, page.now) })
// one heal click can heal several links at one instant (reconnect): keep the node they all share
page.on('heal', ([a, b]) => {
  M.f.cuts.delete(a < b ? `${a}|${b}` : `${b}|${a}`)
  const h = M.f.heal
  if (h && h.at === page.now) { h.nodes = h.nodes.filter((x) => x === a || x === b); if (!h.nodes.length) h.nodes = [a, b] }
  else M.f.heal = { nodes: [a, b], at: page.now }
})
page.on('left', (id) => { M.f.left.set(id, page.now) })
page.on('leave', (id) => { M.f.leaving.set(id, page.now) })
page.on('join', (id) => { M.f.joined.set(id, page.now) })
page.on('view', (v) => { M.f.views.push({ epoch: v.epoch, members: v.members.slice(), at: page.now }); if (M.f.views.length > 40) M.f.views.splice(0, 20) })
page.on('journal', (e) => {
  const F = M.f
  switch (e.name) {
    case 'suspect': { const m = F.suspect.get(e.a) ?? new Map(); m.set(e.node, e.at); F.suspect.set(e.a, m); break }
    case 'giveUp': { const t = String(e.a).replace(/^sim:/, ''); const m = F.giveUp.get(t) ?? new Map(); m.set(e.node, e.at); F.giveUp.set(t, m); break }
    case 'propose': F.propose = { node: e.node, epoch: e.a, count: e.b, at: e.at }; break
    case 'evict': if (e.a !== e.node) F.evict.set(e.a, { at: e.at, node: e.node }); break
    case 'replayed': { const r = F.replay.get(e.node); const life = lifeOf(e.node); if (r && r.life === life) r.records += e.a; else F.replay.set(e.node, { records: e.a, at: e.at, life }); break }
    case 'gateClose': F.gate.set(e.node, { open: false, reason: e.a, at: e.at }); break
    case 'gateOpen': F.gate.set(e.node, { open: true, reason: '', at: e.at }); break
    case 'join': if (e.a === e.node) M.f.asked.set(e.node, e.at); break
    case 'aeShip': F.ae.push({ node: e.node, peer: e.a, records: e.b, at: e.at }); if (F.ae.length > 200) F.ae.splice(0, 100); break
  }
})
// the kernel's own checks: note each rule the first time it breaks, with the monitor's own words
let vSeen = 0
page.on('tick', () => {
  const vs = page.sim.violations
  if (vs.length < vSeen) vSeen = 0
  for (let i = vSeen; i < vs.length; i++) {
    const v = vs[i], b = M.f.broken.get(v.monitor)
    if (b) b.reports++
    else M.f.broken.set(v.monitor, { at: page.now, detail: String(v.detail ?? ''), reports: 1 })
  }
  vSeen = vs.length
})
page.on('reset', () => {
  vSeen = 0
  M.frames.length = 0; M.sent.clear(); M.stamps.clear(); M.order.length = 0; M.commits.clear(); M.life.clear(); M.hops.clear(); M.flash.clear(); M.applied.length = 0
  clearFacts(); M.gen++
})

// ── reads the figures share ──
export const live = () => page.ids().filter((id) => page.alive(id))
// the page's writes still waiting: issued from a node that is alive and still in the life it issued from
// (a crash drops a process's waiting writes — they never commit, so they stop counting)
export function waiting(id) {
  const out = []
  for (const w of page.writes) {
    if (w.state !== 'pending' || (id && w.node !== id) || !page.alive(w.node)) continue
    if (M.life.has(w.id) && M.life.get(w.id) !== lifeOf(w.node)) continue
    out.push(w)
  }
  return out
}
// the waiting writes that committed in the same batch as c (same instant, same issuer), oldest first — read from
// the commit itself (model.js keeps the batch with it), never from whatever committed last
export function batchOf(c) {
  if (!c) return []
  return c.ws && c.ws.length ? c.ws : [c.w]
}
// why a client follows no server right now: 'cut' — it is cut off from every server (or from everyone); 'down' —
// no server is up; 'yet' — it is still connecting (at boot, or just after a cut healed, while its links come back)
export function noServerWhy(id) {
  if (page.isolated(id)) return 'cut'
  const up = page.serverIds.filter((s) => page.alive(s))
  if (!up.length) return 'down'
  if (up.every((s) => page.cuts.has(pair(id, s)))) return 'cut'
  return 'yet'
}
// diskOf(id): what a server's disk holds, counted in RECORDS — the same unit as the journal's `replayed` rows, so
// "its disk keeps N records" and "its write-ahead log gave back N records" are one count. Each WAL row is one
// encoded frame (kernel/node.ts persistRun), which may carry several records: kernel/codec.js Frame counts them,
// once per row (rows are immutable; a restart or compaction makes new ones). unsaved = records in rows whose fsync
// has not resolved yet. boot = the boot record (its view).
const walRecs = new WeakMap()
function recsIn(row) {
  let n = walRecs.get(row)
  if (n === undefined) { try { n = new Frame(row.bytes).records().length } catch { n = 0 } walRecs.set(row, n) }
  return n
}
export function diskOf(id) {
  const s = page.sim.stores.get(id)
  if (!s) return null
  let recs = 0, unsaved = 0
  for (const r of s.wal) { const n = recsIn(r); recs += n; if (!r.resolved) unsaved += n }
  return { recs, unsaved, boot: s.boot }
}
// how many records a node applied since a moment (a restarted or healed node catching up)
export const appliedSince = (id, at) => M.applied.reduce((n, x) => n + (x.node === id && x.at >= at ? 1 : 0), 0)
// the stamp a page write got, once its owner applied it (it may not have reached the issuer yet). The record must be
// the one this write's node issued (the kernel's attempt identity, iss = issuer~life), so a same-value write from
// another node is never taken for it
const issuerOf = (iss) => iss.slice(0, iss.lastIndexOf('~'))
export function stampFor(w) {
  if (w.stamp) return w.stamp
  for (let i = M.order.length - 1; i >= 0; i--) {
    const e = M.stamps.get(M.order[i]); if (!e || e.at == null || e.at < w.issuedAt) continue
    if (e.iss && issuerOf(e.iss) !== w.node) continue
    if (e.ownerAt != null && JSON.stringify(e.path) === w.key && (w.remove ? e.type === 2 : stable(e.value) === stable(w.value))) return e.stamp
  }
  return null
}
// how many live copies hold this stamp, and how many live copies there are
export function landed(stamp) {
  const e = stamp && M.stamps.get(skey(stamp))
  const ids = live()
  let n = 0
  if (e) for (const id of ids) if (e.nodes.has(id)) n++
  return { n, of: ids.length }
}
export function lastRecords(n) {
  const out = []
  for (let i = M.order.length - 1; i >= 0 && out.length < n; i--) { const e = M.stamps.get(M.order[i]); if (e) out.push(e) }
  return out
}
// the most common state fingerprint among live nodes (what "copies agree" compares against)
export function majorityHash() {
  const n = new Map(); let best = null, bn = 0
  for (const id of live()) { const h = page.hash(id); const c = (n.get(h) ?? 0) + 1; n.set(h, c); if (c > bn) { bn = c; best = h } }
  return best
}
// frames on the wire right now (sent, not yet arrived)
export function onWire(now = page.now) {
  const out = []
  for (const f of M.frames) if (f.sentAt <= now && f.recvAt > now) out.push(f)
  return out
}
// drop arrived frames in place (arrival order is not send order: links have different delays)
export function pruneFrames(now = page.now) {
  let j = 0
  for (let i = 0; i < M.frames.length; i++) if (M.frames[i].recvAt > now) M.frames[j++] = M.frames[i]
  M.frames.length = j
}

// ── prime: the house cluster may have advanced before these listeners attached (a frame can run between two
// module evaluations, or another section's script may step it). Rebuild what the apply tap would have seen from
// the kernel itself: which stamps every live node holds (node.versions), and the first moment each stamp was
// applied anywhere (the journal's writeLocal / applyInbound rows, on the simulated clock).
function prime() {
  const first = new Map()
  for (const e of page.journal) {
    let k = null
    if (e.name === 'writeLocal') { try { k = `${page.origin(e.node)}|${e.a}` } catch { k = null } }
    else if (e.name === 'applyInbound') k = `${e.a}|${e.b}`
    if (k && !first.has(k)) first.set(k, e.at)
  }
  for (const id of page.ids()) {
    if (!page.alive(id)) continue
    const n = page.node(id)
    for (const [ck, s] of n.versions) {
      const path = JSON.parse(ck), k = skey(s)
      let e = M.stamps.get(k)
      if (!e) {
        const has = n.state.has(ck)
        e = { stamp: { epoch: s.epoch, seq: s.seq, origin: s.origin }, row: path[0], path, type: has ? 0 : 2, value: has ? n.state.get(ck) : undefined, nodes: new Set(), at: first.get(`${s.origin}|${s.seq}`) ?? null, ownerAt: null }
        M.stamps.set(k, e); M.order.push(k)
      }
      e.nodes.add(id)
      if (id === base(s.origin)) M.commits.add(k)
    }
  }
  M.order.sort((a, b) => (M.stamps.get(a).at ?? -1) - (M.stamps.get(b).at ?? -1))
}
prime()
