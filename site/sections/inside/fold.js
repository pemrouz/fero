// sections/inside/fold.js — §04's DOM-free half, shared by the page (inside.js) and the rebuild worker.
//
//   Clock    when each journal line was written, on the SIMULATED clock. A journal row carries only its
//            per-node counter t (kernel/journal.ts: "NOT wall time"), so the page notes sim.now as every
//            line is written (the core tap's 'journal' event) and keeps one time per line, per node life.
//   fold()   capture.js captureSim(sim) → model.mjs verifyReplay · routes · contested, called unchanged:
//            the same files the debugger's viewer.html loads (site:next/lib/tools/debug/, stripped).
//   viewAt() the fold at simulated time T: each node life alive at T is replayed with the model's own
//            stateAt() to its last journal line written at or before T, and routes() is read up to the
//            same lines. T = null is the end of the fold (the captured state, which verifyReplay proved).
import { captureSim, captureNode } from '../../lib/tools/debug/capture.js'
import { verifyReplay, routes, contested, stateAt, decodeVal, cellKey } from '../../lib/tools/debug/model.mjs'
import { toObject } from '../../core.js'

export { captureNode }

// ── the journal clock ────────────────────────────────────────────────────────────────────────────────
export class Clock {
  lives = new Map()   // node object → life { uuid, inc, born, died, times, n, slice, floor }
  byUuid = new Map()  // uuid → [life, …], oldest first
  life(node, uuid, at) {
    let L = this.lives.get(node)
    if (!L) {
      L = { uuid, inc: node.incarnation ?? 1, born: at, died: null, times: new Float64Array(512), n: 0, slice: null, floor: at }
      this.lives.set(node, L)
      const ls = this.byUuid.get(uuid) ?? []
      ls.push(L); this.byUuid.set(uuid, ls)
    }
    return L
  }
  #grow(L, n) { if (n <= L.times.length) return; let c = L.times.length; while (c < n) c *= 2; const t = new Float64Array(c); t.set(L.times.subarray(0, L.n)); L.times = t }
  // every line up to the node's journal counter that the clock has not seen was written at or before `at`
  sync(node, uuid, at) {
    const L = this.life(node, uuid, at)
    const n = node.journal.n
    if (n > L.n) { this.#grow(L, n); for (let i = L.n; i < n; i++) L.times[i] = at; L.n = n }
    return L
  }
  // one line, just written (the core tap emits 'journal' right after the kernel's own emit, so the
  // counter already includes it: its t is journal.n - 1)
  row(node, uuid, at) { return this.sync(node, uuid, at) }
  // start from the core's own journal log ({ node, at } per line, in order): exact when it still holds
  // every line a node wrote; otherwise that node's times are known only from `now` on (its floor)
  seed(nodes, log, now) {
    const per = new Map()
    for (const e of log) { let a = per.get(e.node); if (!a) per.set(e.node, (a = [])); a.push(e.at) }
    for (const [uuid, node] of nodes) {
      const L = this.life(node, uuid, 0)
      const a = per.get(uuid) ?? [], n = node.journal.n
      this.#grow(L, n)
      if (a.length === n) for (let i = 0; i < n; i++) L.times[i] = a[i]
      else { for (let i = 0; i < n; i++) L.times[i] = now; if (n) L.floor = now }
      L.n = n
    }
  }
  // a life ended: 'down' (a crash, its last state kept as a capture slice) or 'left' (a clean stop)
  died(node, at, slice, how = 'down') { const L = this.lives.get(node); if (L && L.died === null) { L.died = at; L.slice = slice; L.how = how } }
  // tAt(L, T, last): the last journal line of life L written at or before simulated time T (≤ last), or -1
  tAt(L, T, last = Infinity) {
    let lo = 0, hi = Math.min(L.n, last + 1) - 1, best = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L.times[m] <= T) { best = m; lo = m + 1 } else hi = m - 1 }
    return best
  }
  timeOf(L, t) { return L && t !== null && t !== undefined && t >= 0 && t < L.n ? L.times[t] : null }
  clear() { this.lives.clear(); this.byUuid.clear() }
}

// ── who was cut off, on the simulated clock ──────────────────────────────────────────────────────────
// A node is cut off while every link between it and the other nodes is cut (LiveCluster.isolated: the dock's
// cut, 02's "cut off", 06's "cut n03 off ▸"). No journal line says so, so the page notes each change as it
// happens: per node, spans [from, to) on the simulated clock (to = null while it lasts). A node that is down
// is not cut off (down says more), so a crash ends its span and a restart opens a new one if the cut stands.
// Call noteCuts after every cut, heal, kill, restart, join and left.
export function noteCuts(c, spans) {
  const at = c.now, ids = c.ids()
  for (const id of ids) {
    const on = ids.length > 1 && c.alive(id) && c.isolated(id)
    const ls = spans.get(id), open = !!ls && ls.length > 0 && ls[ls.length - 1][1] === null
    if (on && !open) { if (ls) ls.push([at, null]); else spans.set(id, [[at, null]]) }
    else if (!on && open) ls[ls.length - 1][1] = at
  }
  return spans
}
export const CUT_EVENTS = ['cut', 'heal', 'kill', 'restart', 'join', 'left']
// was node `id` cut off at simulated time T?
export function cutAt(spans, id, T) {
  const ls = spans?.get(id)
  if (ls) for (const [a, b] of ls) if (a <= T && (b === null || T < b)) return true
  return false
}

const lastT = (n) => (n.journal.length ? n.journal[n.journal.length - 1].t : -1)

// ── the fold: the debugger's model, called as the viewer calls it ────────────────────────────────────
// In stages, so a page can give each its own task: capture (captureSim, and the node lives behind each
// captured node) → replay (verifyReplay: the gate) → routes → contested. fold() runs them all at once.
export function capture(sim, clock) {
  const t0 = performance.now()
  const cap = captureSim(sim)
  const cur = new Map(), prev = new Map(), last = new Map()
  for (const n of cap.nodes) {
    const node = sim.nodes.get(n.uuid)
    const L = clock.sync(node, n.uuid, sim.now)
    cur.set(n.uuid, L)
    prev.set(n.uuid, (clock.byUuid.get(n.uuid) ?? []).filter((x) => x !== L && x.slice).map((x) => ({ ...x, last: lastT(x.slice) })))
    last.set(n.uuid, lastT(n))
  }
  const tmin = Math.max(0, ...[...cur.values()].map((L) => (L.floor === L.born ? 0 : L.floor)))
  return { cap, replay: null, routes: null, contested: null, at: sim.now, ms: performance.now() - t0, cur, prev, last, tmin, events: sim.events, rows: cap.nodes.reduce((s, n) => s + n.journal.length, 0), dropped: cap.nodes.reduce((s, n) => s + n.dropped, 0), memo: new Map() }
}
const timed = (F, fn) => { const t0 = performance.now(); fn(); F.ms += performance.now() - t0; return F }
export const STAGES = [
  (F) => timed(F, () => { F.replay = verifyReplay(F.cap) }),
  (F) => timed(F, () => { F.routes = routes(F.cap) }),
  (F) => timed(F, () => { F.contested = contested(F.cap) }),
]
export const fold = (sim, clock) => { const F = capture(sim, clock); for (const s of STAGES) s(F); return F }

// the record a route carries, joined from any captured log (absent when no log still holds it)
function recordOf(capture, r) {
  for (const n of capture.nodes) {
    const es = n.logs[r.origin]; if (!es) continue
    for (let i = es.length - 1; i >= 0; i--) if (es[i].seq === r.seq) {
      const e = es[i]
      const rec = { type: e.ty, key: e.k }
      if (e.ty !== 2) rec.value = decodeVal(e.v)
      if (e.at !== undefined && e.at !== null) rec.at = e.at
      return { rec, epoch: e.epoch, row: e.k.length ? String(e.k[0]) : String(e.at ?? '') }
    }
  }
  return null
}

const PRESENT = new Set(['origin', 'applied', 'lww-lost', 'duplicate'])

// ── the fold at simulated time T (null = the end of the fold) ────────────────────────────────────────
export function viewAt(F, clock, T = null, { rows = 5 } = {}) {
  const scrub = T !== null && T !== undefined
  const cap = F.cap
  // per node: the journal slice that speaks for it at T, the last line of that slice at or before T, and
  // whether the node was up at T (a node that is down holds nothing, but the lines it wrote before it went
  // down are still the past: its routes count them)
  const cols = []
  for (const n of cap.nodes) {
    const L = F.cur.get(n.uuid)
    const curGone = L.died !== null && (!scrub || T >= L.died)
    if (!scrub) { cols.push({ uuid: n.uuid, slice: n, life: L, tAt: Infinity, here: true, gone: curGone }); continue }
    if (L.born <= T && !curGone) { cols.push({ uuid: n.uuid, slice: n, life: L, tAt: clock.tAt(L, T, F.last.get(n.uuid)), here: true, gone: false }); continue }
    if (curGone) { cols.push({ uuid: n.uuid, slice: n, life: L, tAt: F.last.get(n.uuid), here: false, why: L.how ?? 'down' }); continue }
    const ps = F.prev.get(n.uuid) ?? []
    const p = ps.find((x) => x.born <= T && (x.died === null || T < x.died))
    if (p) { cols.push({ uuid: n.uuid, slice: p.slice, life: p, tAt: clock.tAt(p, T, p.last), here: true, gone: false, earlier: true }); continue }
    const dead = [...ps].reverse().find((x) => x.died !== null && x.died <= T)
    if (dead) { cols.push({ uuid: n.uuid, slice: dead.slice, life: dead, tAt: dead.last, here: false, why: 'down', earlier: true }); continue }
    cols.push({ uuid: n.uuid, slice: null, life: null, tAt: -1, here: false, why: 'none' })
  }
  // the capture of the lives alive at T (the same capture-node slices captureNode produced)
  let capT = cap, R = F.routes
  if (scrub) {
    const key = cols.map((c) => (!c.slice ? '-' : c.earlier ? 'p' + c.life.inc : 'c')).join('|')
    let m = F.memo.get(key)
    if (!m) {
      const nodes = cols.filter((c) => c.slice).map((c) => c.slice)
      const same = nodes.length === cap.nodes.length && nodes.every((x, i) => x === cap.nodes[i])
      const c2 = same ? cap : { ...cap, nodes }
      m = { capT: c2, R: same ? F.routes : routes(c2) }
      F.memo.set(key, m)
    }
    capT = m.capT; R = m.R
  }
  // per column: the simulated time of the oldest line a ring that dropped lines still keeps. A write first seen
  // before then may have left its line at that node in the dropped part, so "never-arrived" there is not known.
  for (const c of cols) c.keptFrom = c.slice && c.slice.dropped > 0 && c.slice.journal.length ? clock.timeOf(c.life, c.slice.journal[0].t) : null
  // writes × nodes: the route of each write, read up to each node's line at T
  const all = []
  for (const r of R.values()) {
    const cells = []
    let first = Infinity, originT = null, any = false
    for (const c of cols) {
      if (!c.slice) { cells.push({ uuid: c.uuid, status: c.why, at: null }); continue }
      const stop = r.nodes[c.uuid]
      let status = stop ? stop.status : 'never-arrived'
      const t = stop ? stop.t : null
      if (scrub && (t === null || t > c.tAt)) status = c.here ? 'not-yet' : c.why
      const at = PRESENT.has(status) ? clock.timeOf(c.life, t) : null
      if (PRESENT.has(status)) { any = true; if (at !== null && at < first) first = at; if (status === 'origin') originT = at }
      cells.push({ uuid: c.uuid, status, at, t, gone: !c.here || !!c.gone })
    }
    if (any) {
      cols.forEach((c, i) => { if (cells[i].status === 'never-arrived' && c.keptFrom !== null && first < c.keptFrom) cells[i].status = 'dropped' })
      all.push({ r, cells, first, originT })
    }
  }
  all.sort((a, b) => b.first - a.first || (a.r.origin === b.r.origin ? b.r.seq - a.r.seq : 0))
  // the newest `rows` writes; when none of them was set aside anywhere but an older one was, the last slot
  // shows the newest write some node set aside (lww-lost), so the status the model reports stays in view
  const isLost = (w) => w.cells.some((c) => c.status === 'lww-lost')
  let wshown = all.slice(0, rows), pinned = null
  if (all.length > rows && !wshown.some(isLost)) {
    pinned = all.find(isLost) ?? null
    if (pinned) wshown = all.slice(0, rows - 1)
  }
  const writes = (pinned ? [...wshown, pinned] : wshown).map((w) => {
    const j = recordOf(capT, w.r) ?? (capT !== cap ? recordOf(cap, w.r) : null)
    return {
      id: w.r.origin + '#' + w.r.seq, origin: w.r.origin, seq: w.r.seq,
      stamp: j ? { epoch: j.epoch, seq: w.r.seq, origin: w.r.origin } : null,
      rec: j ? j.rec : null, row: w.r.partition ?? (j ? j.row : null),
      key: j ? prettyCell(cellKey(j.rec.key, j.rec.at)) : null,
      at: Number.isFinite(w.first) ? w.first : null,
      cells: w.cells.map((c) => ({ ...c, dt: c.at !== null && w.originT !== null && c.status !== 'origin' ? c.at - w.originT : null })),
    }
  })
  // what each node holds at T: per row (a top-level key), its value and the biggest stamp among its cells
  const order = [], seen = new Set()
  const nodes = cols.map((c) => {
    const capNode = cap.nodes.find((n) => n.uuid === c.uuid)
    const how = c.life && c.life.died !== null && (!scrub || T >= c.life.died) ? (c.life.how ?? 'down') : null // how this life ended, once it has
    const base = { uuid: c.uuid, inc: c.life ? c.life.inc : null, kept: capNode.journal.length, dropped: capNode.dropped, client: capNode.client === true, earlier: !!c.earlier, gone: !!c.gone, how }
    if (!c.here) return { ...base, why: c.why, obj: null, stamps: null, line: null, lineMax: null }
    // rewound: the model's stateAt to the node's line at T (values and the stamp of each cell).
    // at the end: the captured state, which verifyReplay proved equal to stateAt(∞), with each cell's stamp
    // read from the captured logs (a log always keeps the record that holds a cell's value, so this works
    // for a node whose journal ring dropped lines too)
    const cells = new Map(), stamps = new Map()
    const stampRow = (k, s) => { const row = rowOf(k), cur = stamps.get(row); if (!cur || newer(s, cur)) stamps.set(row, s) }
    if (scrub) for (const [k, x] of stateAt(capT, c.uuid, c.tAt)) { cells.set(k, decodeVal(x.v)); stampRow(k, { epoch: x.epoch, seq: x.seq, origin: x.origin }) }
    else {
      for (const [k, v] of c.slice.state) cells.set(k, decodeVal(v))
      const win = winners(c.slice)
      for (const k of cells.keys()) { const s = win.get(k); if (s) stampRow(k, s) }
    }
    const obj = toObject(cells)
    for (const row of Object.keys(obj)) if (!seen.has(row)) { seen.add(row); order.push(row) }
    return { ...base, obj, stamps, line: scrub ? c.tAt : lastT(c.slice), lineMax: lastT(c.slice), kept: c.slice.journal.length, dropped: c.slice.dropped }
  })
  // the rows to show: the first three, then the two most recently stamped (a session can add many rows)
  const best = (row) => { let b = null; for (const n of nodes) { const s = n.stamps?.get(row); if (s && (!b || newer(s, b))) b = s } return b }
  let shown = order
  if (order.length > 5) {
    const rest = order.slice(3).map((r) => ({ r, s: best(r) })).sort((a, b) => (a.s && b.s ? (newer(a.s, b.s) ? -1 : 1) : a.s ? -1 : 1)).slice(0, 2).map((x) => x.r)
    shown = order.filter((r, i) => i < 3 || rest.includes(r))
  }
  // per cell: held or not, and whether this copy is behind the newest copy of that row among the live nodes
  const table = shown.map((row) => {
    const top = best(row)
    const ref = top ? null : nodes.find((n) => n.obj && !n.gone && row in n.obj)?.obj[row]
    const anyHas = nodes.some((n) => n.obj && !n.gone && row in n.obj)
    return {
      row, top,
      cells: nodes.map((n) => {
        if (!n.obj) return { has: false, why: n.why }
        const has = row in n.obj, s = n.stamps?.get(row) ?? null
        const behind = !n.gone && anyHas && (!has || (top && s ? newer(top, s) : !top && JSON.stringify(n.obj[row]) !== JSON.stringify(ref)))
        return { has, v: has ? n.obj[row] : undefined, stamp: s, behind }
      }),
    }
  })
  // contested cells (at the end of the fold), each candidate with the nodes whose route says it was set
  // aside there (routes(): lww-lost) — the records a node really set aside, not every earlier edit
  const lostAt = (c) => { const r = F.routes.get(c.origin + '#' + c.seq); return r ? cap.nodes.filter((n) => r.nodes[n.uuid]?.status === 'lww-lost').map((n) => n.uuid) : [] }
  if (F.lostN === undefined) { let k = 0; for (const r of F.routes.values()) if (Object.values(r.nodes).some((s) => s.status === 'lww-lost')) k++; F.lostN = k }
  return {
    T: scrub ? T : null, at: F.at, nodes, table, more: order.length - shown.length, writes, total: all.length, pinned: !!pinned,
    lost: F.lostN, // routes with a set-aside somewhere (end of the fold), so an empty contested() can be told apart
    contested: F.contested.map((x) => ({ cell: x.cell, winner: { ...x.winner, v: decodeVal(x.winner.v) }, candidates: x.candidates.map((c) => ({ ...c, v: decodeVal(c.v), lostAt: lostAt(c) })) })),
  }
}
// each cell's newest stamp among a captured node's log entries (the LWW rule, the model's own order)
function winners(n) {
  const out = new Map()
  for (const [origin, es] of Object.entries(n.logs)) for (const e of es) {
    const k = cellKey(e.k, e.at), s = { epoch: e.epoch, seq: e.seq, origin }, cur = out.get(k)
    if (!cur || newer(s, cur)) out.set(k, s)
  }
  return out
}
const newer = (a, b) => a.epoch > b.epoch || (a.epoch === b.epoch && (a.seq > b.seq || (a.seq === b.seq && a.origin > b.origin)))
const rowOf = (ck) => { try { const p = JSON.parse(ck); return String(Array.isArray(p) ? p[0] : p) } catch { return ck } }
// the debugger's own way to name a cell: the key path joined with · (viewer.html prettyCell)
export const prettyCell = (ck) => { try { const p = JSON.parse(ck); return (Array.isArray(p) ? p : [p]).map(String).join('·') } catch { return String(ck) } }

// the whole run's marks for the time bar: every write's first sighting, every crash and every restart
export function marks(F) {
  const out = { writes: [], downs: [], ups: [], lefts: [], joins: [] }
  for (const r of F.routes.values()) {
    let first = Infinity
    for (const n of F.cap.nodes) {
      const s = r.nodes[n.uuid]; if (!s || !PRESENT.has(s.status)) continue
      const L = F.cur.get(n.uuid)
      const at = L.n > s.t && s.t >= 0 ? L.times[s.t] : null
      if (at !== null && at < first) first = at
    }
    if (Number.isFinite(first)) out.writes.push(first)
  }
  // a later life is a restart; a server's first life born late joined the member list. A client never
  // joins the member list (it follows one server), so its start is not marked as a join.
  const clients = new Set(F.cap.nodes.filter((n) => n.client === true).map((n) => n.uuid))
  const born = (L, uuid) => { if (L.born > 0) { if (L.inc > 1) out.ups.push(L.born); else if (!clients.has(uuid)) out.joins.push(L.born) } }
  for (const [uuid, L] of F.cur) {
    born(L, uuid)
    if (L.died !== null) (L.how === 'left' ? out.lefts : out.downs).push(L.died)
    for (const p of F.prev.get(uuid) ?? []) { if (p.died !== null) out.downs.push(p.died); born(p, uuid) }
  }
  return out
}
