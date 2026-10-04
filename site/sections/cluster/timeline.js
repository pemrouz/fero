// sections/cluster/timeline.js — variant b: the timeline (CONCEPT.md §4 b). One lane per node, simulated time
// running left to right, the last few seconds scrolling. Every frame is a thin slanted line from its sender's
// lane to its receiver's, drawn at its real send and arrival times (core.js's frame tap: sentAt at the sender's
// sink, recvAt at its delivery), so a line's slant IS its time on the wire. While a frame is on the wire, its tip
// rides the "now" line. The write's frames are in the accent, ballots in ink with their verb, HELLO faint; PING,
// PONG and DIGEST are counted, not drawn, unless asked. Each lane is tinted by that node's OWN committed view (its
// journal's viewInstall rows: nodes install a view at slightly different moments). A commit is a tick carrying
// the stamp its owner gave (the owner's apply); a record landing on another copy is a dot. A waiting write is an
// amber bar on its issuer's lane, from issue to commit (page.writes). A crash ends a lane with ✕; a restart
// resumes it under the node's new origin (n02~2). Clicking a line takes that frame apart with kernel/codec.js.
// Everything here OBSERVES the house cluster: no listener calls an action.
import { page, REDUCED, COARSE, decode, pair } from '../../cluster.js'
import { nid, stamp as stampHTML, rec, inspect, vt, esc } from '../../ui.js'
import { M, ownerOf, base, majorityHash, frameTaps, diskOf, noServerWhy } from './model.js'
import { A, num } from './say.js'
import { D } from './dock.js'

const root = document.getElementById('cl-b')
const $ = (s) => root.querySelector(s)
const headsEl = $('#cl-tl-heads-b'), plotEl = $('#cl-tl-plot-b'), svg = $('#cl-tl-svg-b')
const hiddenEl = $('#cl-tl-hidden-b'), legendEl = $('#cl-tl-legend-b'), winEl = $('#cl-tl-win-b')
const frMode = $('#cl-tl-fr-mode-b'), frBody = $('#cl-tl-fr-body-b'), frNav = root.querySelector('.tl-fr-nav')
const NS = 'http://www.w3.org/2000/svg'
const BIG = 'gadgets', KEY = JSON.stringify([BIG])
const KEEP = 15000          // ms of simulated history kept in memory (the widest window is 12 s)
const CH = 5.4              // px per character of the 9 px mono labels (measured once below)

// ── what each verb is, in plain words (facts.md §4, printable as written) and what its body's keys mean (the
// kernel/codec.ts header comments; the WACK keys from kernel/write.ts, where the owner builds it) ──
const GIST = {
  HELLO: 'the first frame on every link: who I am (name, life, address), whether I am a client, and, when set, which resource.',
  RECORDS: 'stamped records from one writer, sent live or to fill a gap.',
  PING: 'the lower-named side checks each link on every heartbeat.',
  PONG: 'the answer, as proof of life.',
  DIGEST: '"the highest counter I hold per writer; <code>r=1</code> means send me yours".',
  JOIN: 'a new server asks a member to propose it into the view.',
  PROPOSE: 'a ballot for the next view: its number and its members.',
  VOTE: "a member's answer to a ballot. One yes per view number.",
  VIEW: 'announces a committed view, or answers a PULL.',
  PULL: '"I saw a newer view number; send me that view."',
  WRITE: "a write not yet stamped, on its way to the row's owner.",
  WACK: "the owner's yes, with the stamp it gave.",
  WNACK: "the owner's no, with a reason: <code>not-owner</code>, <code>stale-epoch</code>, <code>withheld</code>, <code>invalid</code>.",
  LEAVE: '"I am stopping on purpose; vote me out."',
}
const KEYS = {
  HELLO: '<code>u</code> its name · <code>i</code> its life · <code>l</code> its address',
  JOIN: '<code>u</code> its name · <code>i</code> its life · <code>l</code> its address',
  PROPOSE: '<code>e</code> the view number · <code>m</code> its members, each [name, address] · <code>p</code> who proposes it',
  VOTE: "<code>e</code> the view it answers · <code>g</code> yes (<code>1</code>) or no (<code>0</code>) · <code>ce</code> the voter's own view",
  VIEW: '<code>e</code> the view number · <code>m</code> its members, each [name, address]',
  PULL: '<code>e</code> the view it asks for',
  WACK: "<code>u</code> the writer · <code>c</code> its attempt counter · <code>n</code> how many records · <code>s</code> and <code>e</code> the stamp's counter and view",
  WNACK: '<code>u</code> the writer · <code>c</code> its attempt counter · <code>r</code> the reason · <code>ce</code> the owner\'s view',
  DIGEST: '<code>d</code> the highest counter held per writer · <code>r</code> asks for theirs',
}
// a WRITE's provenance is the attempt triple [issuer, baseCid, attemptEpoch] (kernel/codec.ts). Its epoch is the view
// the SENDER put on it: a client always sends 0 ("ae 0, the marker an honest spoke always sends", kernel/write.ts),
// and the server it writes through puts in its own view when it passes the write on. Its origin always names the
// issuer's life (c1~1), where a stamp names the life only from the second one (n02, then n02~2)
const lifeOf = (o) => { const t = String(o), i = t.lastIndexOf('~'); return i < 0 ? A(esc(t)) : `${A(esc(t))} is ${A(nid(t.slice(0, i)))} in life ${A(esc(t.slice(i + 1)))}` }
const PROV = {
  WRITE: ['attempt', (p) => `<code>origin</code> who issued it, with its life: ${lifeOf(p.origin)} · <code>baseSeq</code> its attempt counter · <code>epoch</code> the view the sender put on it: a client always sends <code>0</code>, and the server it writes through puts in its own view when it passes the write on`],
  RECORDS: ['writer', () => "<code>origin</code> the owner that stamped them · <code>baseSeq</code> the first record's counter · <code>epoch</code> the view they were stamped in"],
}

// ── the store: what the page's events taught us, kept for KEEP ms of simulated time ──
const S = {
  frames: [],     // { id, from, to, verb, kind, sentAt, recvAt, size, bytes, fresh, hidden, el }
  byId: new Map(),
  ticks: [],      // applies grouped by (node, instant): { node, at, owner, stamps: [], el }
  bands: [],      // a node's own committed view over time: { node, from, to, epoch, el }
  lives: [],      // { node, from, to, life, origin, end: 'crash'|'left'|null, restart, joined, el }
  cuts: [],       // { node, from, to, text, el }
  marks: [],      // the node's own journal, in plain words: { node, at, text, el }
  writes: [],     // fresh WRITE frames, newest last (what the panel's "latest" follows)
  seq: 0,
}
let showHidden = false
let held = false            // the plot holds still while a mouse or pen is on it, or after a tap (see setHeld)
let heldBy = ''             // 'pointer' | 'touch'
const cutText = new Map()
const replayAt = new Map()   // node → the mark collecting its WAL replay rows at one instant

function initRun() {
  S.frames.length = 0; S.byId.clear(); S.ticks.length = 0; S.bands.length = 0; S.lives.length = 0; S.cuts.length = 0; S.marks.length = 0
  S.writes.length = 0; cutText.clear(); replayAt.clear(); restartAt.clear(); redraw.clear()
  for (const k in cur) cur[k] = 0
  for (const id of page.ids()) {
    S.lives.push({ node: id, from: 0, to: null, life: 1, origin: id, end: null, el: null })
    S.bands.push({ node: id, from: 0, to: null, epoch: 0, el: null })
  }
  sel.f = null; sel.auto = true
  dirty = true
}
// cursors into the time-ordered arrays: everything before a draw cursor has been considered for drawing, everything
// before a prune cursor has no element left — so a frame never walks the whole kept history
const cur = { fDraw: 0, fPrune: 0, tDraw: 0, tPrune: 0, mDraw: 0 }
const redraw = new Set()   // a tick or mark that changed after it was drawn
const trim = (arr, end, keys = []) => {
  const t = page.now - KEEP; let i = 0
  while (i < arr.length && end(arr[i]) < t && arr[i] !== sel.f) i++
  if (!i) return
  for (let j = 0; j < i; j++) { dropEl(arr[j]); if (arr === S.frames) S.byId.delete(arr[j].id) }
  arr.splice(0, i)
  for (const k of keys) cur[k] = Math.max(0, cur[k] - i)
}
const trimFrames = () => trim(S.frames, (f) => f.recvAt, ['fDraw', 'fPrune'])
const trimTicks = () => trim(S.ticks, (t) => t.at, ['tDraw', 'tPrune'])
const trimMarks = () => trim(S.marks, (m) => m.at, ['mDraw'])
const closeOpen = (arr, id, at) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].node === id && arr[i].to === null) { arr[i].to = at; return arr[i] } return null }
function mark(node, at, text, cls = '') { S.marks.push({ node, at, text, cls, el: null }) }

frameTaps.add((fr, f) => {
  const x = { id: ++S.seq, from: fr.from, to: fr.to, verb: fr.verb, kind: fr.kind, sentAt: fr.sentAt, recvAt: fr.recvAt, size: fr.size, bytes: f.bytes, fresh: fr.fresh, hidden: fr.hidden, el: null }
  S.frames.push(x); S.byId.set(x.id, x)
  if (x.verb === 'WRITE' && x.fresh) { S.writes.push(x); if (S.writes.length > 64) S.writes.splice(0, 32) }
  if (S.frames.length > 4000 && S.frames[0].recvAt < page.now - KEEP) trimFrames()
})
const restartAt = new Map()   // node → the simulated instant of its last restart (its WAL replays then)
page.on('apply', (a) => {
  if (restartAt.get(a.node) === a.at) return   // a WAL replay at boot: an old stamp read back from disk, not a commit
  const owner = a.node === base(a.origin)
  const st = { epoch: a.epoch, seq: a.seq, origin: a.origin }
  for (let i = S.ticks.length - 1; i >= 0 && i >= S.ticks.length - 12; i--) {
    const t = S.ticks[i]
    if (t.at === a.at && t.node === a.node && t.owner === owner) { t.stamps.push(st); if (t.el) { dropEl(t); t.el = null; redraw.add(t) } return }
  }
  S.ticks.push({ node: a.node, at: a.at, owner, stamps: [st], el: null })
  if (S.ticks.length > 3000) trimTicks()
})
const GATE = { minority: "read-only: it can't reach a majority" }
page.on('journal', (e) => {
  switch (e.name) {
    case 'viewInstall': {
      const b = closeOpen(S.bands, e.node, e.at)
      if (b && b.from === e.at && b.epoch === 0) S.bands.splice(S.bands.indexOf(b), 1)   // a lane that starts in this very view
      S.bands.push({ node: e.node, from: e.at, to: null, epoch: e.a, el: null })
      break
    }
    case 'suspect': mark(e.node, e.at, `suspects ${e.a}`); break
    case 'giveUp': mark(e.node, e.at, `gives up on ${String(e.a).replace(/^sim:/, '')}`); break
    case 'propose': mark(e.node, e.at, `proposes view ${e.a}`); break
    case 'replayed': {
      const r = replayAt.get(e.node)
      if (r && r.at === e.at) { r.n += e.a; r.text = `its disk gave back ${r.n} ${r.n === 1 ? 'record' : 'records'}`; if (r.el && !r.el.merged) { dropEl(r); r.el = null; redraw.add(r) } }
      else { const m = { node: e.node, at: e.at, n: e.a, text: `its disk gave back ${e.a} ${e.a === 1 ? 'record' : 'records'}`, cls: 'wal', el: null }; S.marks.push(m); replayAt.set(e.node, m) }
      break
    }
    // the write gate is shown for servers only (a client's gate is not a client's "can I write?": facts.md §5)
    case 'gateClose': if (page.role(e.node) === 'server' && GATE[e.a]) mark(e.node, e.at, GATE[e.a], 'gate'); break
    case 'gateOpen': { if (page.role(e.node) !== 'server') break; const last = S.marks.findLast((m) => m.node === e.node && m.cls === 'gate'); if (last && last.text !== 'takes writes again') mark(e.node, e.at, 'takes writes again', 'gate'); break }
  }
  if (S.marks.length > 600) trimMarks()
})
// one click can cut or heal several links at one instant (isolate, reconnect, a crash): sync once, after the
// click's last event, so only the final state of that instant is drawn
let cutQueued = false
function queueCuts() { if (cutQueued) return; cutQueued = true; queueMicrotask(() => { cutQueued = false; syncCuts() }) }
function syncCuts() {
  const ids = page.ids()
  for (const id of ids) {
    let text = ''
    if (page.alive(id) && page.cuts.size) {
      if (page.isolated(id)) text = 'cut off from everyone'
      else {
        // links cut to a node that is itself cut off are shown on THAT node's lane, not here
        const peers = ids.filter((o) => o !== id && page.cuts.has(pair(id, o)) && !page.isolated(o))
        if (peers.length) text = `cut from ${peers.join(', ')}`
      }
    }
    const before = cutText.get(id) ?? ''
    if (before === text) continue
    closeOpen(S.cuts, id, page.now)
    if (text) { const c = { node: id, from: page.now, to: null, text, el: null }; S.cuts.push(c); mark(id, page.now, text, 'cut') }
    else if (page.alive(id)) mark(id, page.now, 'links back', 'healed')
    cutText.set(id, text)
  }
}
page.on('cut', queueCuts)
page.on('heal', queueCuts)
page.on('kill', (id) => { const l = closeOpen(S.lives, id, page.now); if (l) l.end = 'crash'; closeOpen(S.bands, id, page.now); mark(id, page.now, 'crashed · its disk is kept', 'crash'); queueCuts() })
page.on('left', (id) => { const l = closeOpen(S.lives, id, page.now); if (l) l.end = 'left'; closeOpen(S.bands, id, page.now); mark(id, page.now, 'left on purpose', 'left'); queueCuts() })
page.on('restart', (id) => {
  const n = page.node(id)
  restartAt.set(id, page.now)
  S.lives.push({ node: id, from: page.now, to: null, life: n.incarnation, origin: n.origin, end: null, restart: true, el: null })
  mark(id, page.now, `${n.origin} · life ${n.incarnation}`, 'life')   // its WAL replay ("its disk gave back …") follows at this instant
  S.bands.push({ node: id, from: page.now, to: null, epoch: page.viewOf(id).epoch, el: null })
  queueCuts()
})
page.on('join', (id) => {
  S.lives.push({ node: id, from: page.now, to: null, life: 1, origin: id, end: null, joined: true, el: null })
  mark(id, page.now, `${id} starts`, 'life')
  S.bands.push({ node: id, from: page.now, to: null, epoch: 0, el: null })
})
page.on('reset', () => initRun())

// prime: the house cluster may have moved before this module loaded. Rebuild what the taps would have seen:
// frames from page.frames (the last ~2.5 s, bytes included), views and marks from the journal.
function prime() {
  initRun()
  for (const f of page.frames) {
    const hidden = f.kind === 'beat' || f.kind === 'heal'
    if (!hidden && !['write', 'repl', 'vote', 'link'].includes(f.kind)) continue
    const x = { id: ++S.seq, from: f.from, to: f.to, verb: f.verb, kind: f.kind, sentAt: f.sentAt, recvAt: f.recvAt, size: f.size, bytes: f.bytes, fresh: !hidden, hidden, el: null }
    S.frames.push(x); S.byId.set(x.id, x)
    if (x.verb === 'WRITE') S.writes.push(x)
  }
  for (const e of page.journal) if (e.name === 'viewInstall') {
    closeOpen(S.bands, e.node, e.at); S.bands.push({ node: e.node, from: e.at, to: null, epoch: e.a, el: null })
  }
}

// ── geometry ──
const G = { L: 76, axisH: 24, gutter: 96, W: 3000, k: 0.25, w: 0, h: 0, ids: [], lane: new Map(), gen: -1, left: 0, leftT: 0, n: 0, tx: 0 }
const yOf = (id) => { const i = G.lane.get(id); return i === undefined ? null : i * G.L + Math.round(G.L * 0.62) }
const topOf = (id) => { const i = G.lane.get(id); return i === undefined ? null : i * G.L }
let dirty = true
const NARROW = typeof matchMedia === 'function' ? matchMedia('(max-width: 860px)') : { matches: false }
// the window: one period of the page's writer (its every: a write's whole trace is always on screen), 1.5 s on a
// phone, four times wider while 4× runs, so the lines always scroll at a readable pace
function windowMs(plotW) { return (plotW < 520 ? 1500 : (page.writer.every || 2500)) * (D.speed === '4' ? 4 : 1) }

// ── svg layers: the time-based ones live in one group that scrolls; the now line and its gutter stay put ──
const mk = (tag, cls, parent, attrs) => {
  const e = document.createElementNS(NS, tag)
  if (cls) e.setAttribute('class', cls)
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k])
  if (parent) parent.append(e)
  return e
}
const L = {}
L.sep = mk('g', 'tl-sep', svg)
L.scroll = mk('g', 'tl-scroll', svg)
L.grid = mk('g', 'tl-grid', L.scroll)
L.band = mk('g', 'tl-bands', L.scroll)
L.base = mk('g', 'tl-bases', L.scroll)
L.bar = mk('g', 'tl-bars', L.scroll)
L.line = mk('g', 'tl-lines', L.scroll)
L.tag = mk('g', 'tl-tags', L.scroll)
L.mark = mk('g', 'tl-marks', L.scroll)
L.now = mk('g', 'tl-nowl', svg)
const dropEl = (x) => { if (x && x.el) { x.el.g?.remove(); x.el.tag?.remove(); x.el = false } }

// ── labels never sit on each other: every placed label's box, in scroll coordinates ──
let boxes = []
const hits = (b) => boxes.some((q) => q.x1 < b.x2 + 2 && b.x1 < q.x2 + 2 && q.y1 < b.y2 + 1 && b.y1 < q.y2 + 1)
function chip(parent, x, y, text, cls) {
  const w = 8 + text.length * CH
  const g = mk('g', cls, parent, { transform: `translate(${x.toFixed(1)} ${y})` })
  mk('rect', '', g, { x: 0, y: -5.5, width: w.toFixed(1), height: 11, rx: 2.5 })
  const t = mk('text', '', g, { x: 4, y: 3 }); t.textContent = text
  boxes.push({ x1: x, x2: x + w, y1: y - 5.5, y2: y + 5.5 })
  return g
}

// ── drawing one item (scroll coordinates: x = simulated ms × k) ──
const flying = new Set(), open = new Set()
// heartbeat and digest lines on screen, oldest first: at most HID_MAX (a 4× window holds over a thousand). Over that,
// one in two is drawn, then one in four…: thinned evenly across the window, never cut off at its left, and the
// hidden-frames line says how many are drawn
const hidDrawn = []
const HID_MAX = 500
let hidStride = 1, hidN = 0
function thinHidden() {
  let live = hidDrawn.filter((f) => f.el)
  if (live.length > HID_MAX) {
    hidStride *= 2
    live = live.filter((f, i) => { if (i % 2) { flying.delete(f); dropEl(f); return false } return true })
    paintHidden(true)
  }
  hidDrawn.length = 0
  for (const f of live) hidDrawn.push(f)
}
function drawFrame(f) {
  const y1 = yOf(f.from), y2 = yOf(f.to)
  if (y1 == null || y2 == null || (f.hidden && !showHidden)) { f.el = false; return }
  if (f.hidden && hidN++ % hidStride) { f.el = false; return }
  const g = mk('g', `fr k-${f.kind}${f.fresh || f.hidden ? '' : ' again'}${f.hidden ? ' hid' : ''}${sel.f === f ? ' sel' : ''}`, L.line)
  g.dataset.fid = f.id
  if (!f.hidden) { const t = mk('title', '', g); t.textContent = `${f.verb} ${f.from} → ${f.to} · ${Math.round(f.recvAt - f.sentAt)} ms on the wire (simulated) · click to take it apart` }
  const x1 = f.sentAt * G.k
  const hit = f.hidden ? null : mk('line', 'hit', g, { x1: x1.toFixed(1), y1 })
  const ln = mk('line', 'ln', g, { x1: x1.toFixed(1), y1 })
  f.el = { g, hit, ln, x1, y1, y2, tip: null }
  if (f.hidden) { hidDrawn.push(f); if (hidDrawn.length > HID_MAX) thinHidden() }
  if (page.now >= f.recvAt) land(f)
  else {
    if (REDUCED) g.style.display = 'none'
    else f.el.tip = mk('circle', 'tip', g, { r: f.hidden ? 1.4 : 2.8 })
    flying.add(f); fly(f, page.now)
  }
}
function fly(f, now) {
  const e = f.el
  if (REDUCED) return
  const p = Math.min(1, Math.max(0, (now - f.sentAt) / Math.max(1e-6, f.recvAt - f.sentAt)))
  const x = (now * G.k).toFixed(1), y = (e.y1 + (e.y2 - e.y1) * p).toFixed(1)
  e.ln.setAttribute('x2', x); e.ln.setAttribute('y2', y)
  if (e.hit) { e.hit.setAttribute('x2', x); e.hit.setAttribute('y2', y) }
  e.tip.setAttribute('cx', x); e.tip.setAttribute('cy', y)
  e.tipY = +y
}
function land(f) {
  const e = f.el, x2 = (f.recvAt * G.k).toFixed(1)
  e.ln.setAttribute('x2', x2); e.ln.setAttribute('y2', e.y2)
  if (e.hit) { e.hit.setAttribute('x2', x2); e.hit.setAttribute('y2', e.y2) }
  if (e.tip) { e.tip.remove(); e.tip = null }
  e.g.style.display = ''
  if (!f.hidden) { mk('circle', 'end', e.g, { cx: x2, cy: e.y2, r: 1.8 }); tag(f) }
  flying.delete(f)
}
// a verb tag on a landed line, at the first free spot along it (none if every spot is taken: the frame panel still
// takes it apart). Each lane keeps two strips free of tags: the top, where its "view N" label sits, and the foot,
// where its journal words go ("proposes view 3", "its disk gave back 14 records") — those words are drawn later than
// the tags near them, so a tag must never take their place. In a burst (a vote, a restart's announcements), one tag
// per verb per pair of lanes is enough.
const tagged = new Map()   // `${verb}|${lane pair}` → simulated time of the last tag
function tagRoom(cy, h) {
  const i = Math.floor(cy / G.L), rel = cy - i * G.L, line = Math.round(G.L * 0.62)
  return rel - h / 2 >= 15 && rel + h / 2 <= line + 9
}
function tag(f) {
  if (f.kind === 'link' || !f.fresh) return
  const la = G.lane.get(f.from), lb = G.lane.get(f.to)
  const key = `${f.verb}|${Math.min(la, lb)}|${Math.max(la, lb)}`
  if (f.sentAt - (tagged.get(key) ?? -1e9) < 600) return
  const e = f.el, w = 6 + f.verb.length * CH, h = 11
  const xa = e.x1, ya = e.y1, xb = f.recvAt * G.k, yb = e.y2
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.75, 0.8, 0.85, 0.25, 0.2, 0.15]) {
    const cx = xa + (xb - xa) * t, cy = ya + (yb - ya) * t
    if (!tagRoom(cy, h)) continue
    const b = { x1: cx - w / 2, x2: cx + w / 2, y1: cy - h / 2, y2: cy + h / 2 }
    if (hits(b)) continue
    boxes.push(b)
    const g = mk('g', `tag k-${f.kind}${sel.f === f ? ' sel' : ''}`, L.tag, { transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})` })
    mk('rect', '', g, { x: (-w / 2).toFixed(1), y: -h / 2, width: w.toFixed(1), height: h, rx: 2.5 })
    const tx = mk('text', '', g, { 'text-anchor': 'middle', y: 3.1 }); tx.textContent = f.verb
    e.tag = g
    tagged.set(key, f.sentAt)
    return
  }
}
function drawTick(t) {
  const y = yOf(t.node); if (y == null) { t.el = false; return }
  const x = t.at * G.k
  const g = mk('g', `tick${t.owner ? ' own' : ''}`, L.mark)
  if (t.owner) {
    mk('line', 'tk', g, { x1: x.toFixed(1), x2: x.toFixed(1), y1: y - 9, y2: y + 9 })
    // one chip per stamp, ending at its tick (so a fresh stamp sits just left of the now line, never under the
    // verbs of frames still on the wire), each on the lowest free level above the lane's line
    const texts = t.stamps.map((s) => `view ${s.epoch} · #${s.seq} · ${s.origin}`)
    let level = 0
    for (let i = 0; i < texts.length; i++) {
      const rest = texts.length - i
      const text = level === 2 && rest > 1 ? `+ ${rest} more` : texts[i]
      const w = 8 + text.length * CH, x0 = x - 3 - w
      // three levels of 12 px fit above the lane's line (it sits at 62% of the lane's height)
      while (level < 3 && hits({ x1: x0, x2: x0 + w, y1: y - 18.5 - level * 12, y2: y - 7.5 - level * 12 })) level++
      if (level >= 3) break
      chip(g, x0, y - 13 - level * 12, text, text.startsWith('+') ? 'chip more' : 'chip st')
      if (text.startsWith('+')) break
      level++
    }
  } else mk('circle', 'ap', g, { cx: x.toFixed(1), cy: y, r: 2.4 })
  t.el = { g, born: t.at }
}
function drawBand(b) {
  const top = topOf(b.node); if (top == null) { b.el = false; return }
  const x = b.from * G.k, x2 = (b.to ?? page.now) * G.k
  const g = mk('g', `band ${b.epoch % 2 ? 'odd' : 'even'}`, L.band)
  const r = mk('rect', '', g, { x: x.toFixed(1), y: top + 1, width: Math.max(0, x2 - x).toFixed(1), height: G.L - 2 })
  if (b.from > 0) mk('line', 'bd', g, { x1: x.toFixed(1), x2: x.toFixed(1), y1: top + 1, y2: top + G.L - 1 })
  // the band's label shows once it fits inside its own band and left of the now line (a label born at the now line
  // would run into the gutter; a band too short for its label keeps none, so two labels never meet)
  const t = mk('text', 'bl', g, { x: (x + 4).toFixed(1), y: top + 11 }); t.textContent = b.epoch ? `view ${b.epoch}` : 'no view yet'
  t.style.visibility = 'hidden'
  b.el = { g, r, x, t, lw: t.textContent.length * CH * 0.95, top }
  pendingLabels.add(b)
  if (b.to === null) open.add(b)
}
const pendingLabels = new Set()
function syncLabels(now) {
  for (const b of pendingLabels) {
    if (!b.el) { pendingLabels.delete(b); continue }
    const right = Math.min((b.to ?? now) * G.k, now * G.k - 4), avail = right - (b.el.x + 4)
    if (avail >= b.el.lw) {
      b.el.t.style.visibility = ''
      boxes.push({ x1: b.el.x + 2, x2: b.el.x + 6 + b.el.lw, y1: b.el.top + 2, y2: b.el.top + 14 })
      pendingLabels.delete(b)
    } else if (b.to !== null && b.to * G.k - (b.el.x + 4) < b.el.lw) pendingLabels.delete(b)   // too short: no label
  }
}
function drawLife(l) {
  const y = yOf(l.node); if (y == null) { l.el = false; return }
  const x = l.from * G.k, x2 = (l.to ?? page.now) * G.k
  const g = mk('g', 'life', L.base)
  const ln = mk('line', 'bl', g, { x1: x.toFixed(1), x2: x2.toFixed(1), y1: y, y2: y })
  l.el = { g, ln, x }
  if (l.to === null) open.add(l); else endLife(l)
}
function endLife(l) {
  const y = yOf(l.node), x2 = l.to * G.k
  l.el.ln.setAttribute('x2', x2.toFixed(1))
  if (l.end === 'crash') { const t = mk('text', 'x', l.el.g, { x: x2.toFixed(1), y: y + 4.5, 'text-anchor': 'middle' }); t.textContent = '✕' }
}
function drawCut(c) {
  const y = yOf(c.node); if (y == null) { c.el = false; return }
  const x = c.from * G.k, x2 = (c.to ?? page.now) * G.k
  const g = mk('g', 'cut', L.base)
  const ln = mk('line', 'cl', g, { x1: x.toFixed(1), x2: x2.toFixed(1), y1: y, y2: y })
  c.el = { g, ln, x }
  if (c.to === null) open.add(c)
}
// journal marks sit along the lane's foot; two that would touch merge into one line ("gives up on n02 · proposes
// view 2"), so the order stays readable at any window. A mark is drawn once its words fit left of the now line (a
// mark is born at the now line, so a long one waits a moment for the line to move): nothing runs into the gutter,
// where the verbs of frames on the wire and the "waiting" labels are, or past the plot's edge.
const markEnd = new Map()
const markW = (text) => text.length * CH * 0.95
function drawMark(m, tx) {
  const y = yOf(m.node); if (y == null) { m.el = false; return true }
  const x = m.at * G.k, last = markEnd.get(m.node)
  const limit = Math.min(G.w - 2 - tx, page.now * G.k - 4)
  if (last && last.t.isConnected && x < last.right + 8) {
    const right = last.right + markW(` · ${m.text}`)
    if (right > limit) return false
    const sp = mk('tspan', m.cls || 'plain', last.t); sp.textContent = ` · ${m.text}`
    last.right = right
    m.el = { g: null, merged: true }
    return true
  }
  if (x + 3 + markW(m.text) > limit) return false
  const g = mk('g', `mk ${m.cls || ''}`, L.mark)
  mk('line', 'mt', g, { x1: x.toFixed(1), x2: x.toFixed(1), y1: y + 13, y2: y + 21 })
  const t = mk('text', '', g, { x: (x + 3).toFixed(1), y: y + 21 })
  const sp = mk('tspan', m.cls || 'plain', t); sp.textContent = m.text
  m.el = { g, t }
  markEnd.set(m.node, { el: m.el, t, right: x + 3 + markW(m.text) })
  return true
}
// the waiting bars: one per page write, from issue to commit (or to the crash that dropped it)
const bars = new Map()
function barEnd(w) {
  if (w.state === 'committed') return { end: w.committedAt, st: 'done' }
  for (let i = S.lives.length - 1; i >= 0; i--) {
    const l = S.lives[i]
    if (l.node === w.node && l.from <= w.issuedAt) return l.to === null ? { end: null, st: 'on' } : { end: l.to, st: 'lost' }
  }
  return { end: null, st: page.alive(w.node) ? 'on' : 'lost' }
}
function syncBars(now, leftT) {
  const ws = page.writes
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i]
    if (w.issuedAt < leftT - 30000) break
    let b = bars.get(w.id)
    const { end, st } = barEnd(w)
    if (!b) {
      if (end !== null && end < leftT) continue
      const y = yOf(w.node); if (y == null) continue
      const g = mk('g', `bar ${st}`, L.bar)
      const x = w.issuedAt * G.k
      const r = mk('rect', '', g, { x: x.toFixed(1), y: y + 5, height: 4, rx: 1, width: 0 })
      b = { w, g, r, x, st: '' }
      bars.set(w.id, b)
    }
    const x2 = (end ?? now) * G.k
    b.r.setAttribute('width', Math.max(2, x2 - b.x).toFixed(1))
    if (b.st !== st) { b.st = st; b.g.setAttribute('class', `bar ${st}`) }
  }
  for (const [id, b] of bars) { const e = barEnd(b.w).end; if (e !== null && e < leftT - 200) { b.g.remove(); bars.delete(id) } }
}
// the clock: a grid line and an axis label on every whole simulated second, a small tick every heartbeat-sized
// 100 ms — each drawn only once the clock has reached it, so nothing on the axis runs ahead of now
const secs = new Map(), minors = new Map()
function syncSecs(leftT, now) {
  const yb = G.n * G.L, step = G.W > 6000 ? 2 : 1
  const s0 = Math.max(0, Math.floor(leftT / 1000)), s1 = Math.floor(now / 1000)
  for (let s = s0; s <= s1; s++) {
    if (secs.has(s) || s % step) continue
    const x = s * 1000 * G.k
    const g = mk('g', 'sec', L.grid)
    mk('line', 'gl', g, { x1: x.toFixed(1), x2: x.toFixed(1), y1: 0, y2: yb })
    mk('line', 'at', g, { x1: x.toFixed(1), x2: x.toFixed(1), y1: yb, y2: yb + 5 })
    const t = mk('text', 'al', g, { x: x.toFixed(1), y: yb + 15, 'text-anchor': 'middle' }); t.textContent = `${s} s`
    secs.set(s, { g, t, x })
  }
  for (const [s, e] of secs) if (s < s0 - 1) { e.g.remove(); secs.delete(s) }
  if (G.W > 6000) return
  const m0 = Math.max(0, Math.floor(leftT / 100)), m1 = Math.floor(now / 100)
  for (let m = m0; m <= m1; m++) {
    if (m % 10 === 0 || minors.has(m)) continue
    const x = (m * 100 * G.k).toFixed(1)
    minors.set(m, mk('line', 'am', L.grid, { x1: x, x2: x, y1: yb, y2: yb + 2.5 }))
  }
  for (const [m, el] of minors) if (m < m0 - 2) { el.remove(); minors.delete(m) }
}

// ── the now line, the gutter (tips' verbs and waiting labels), the lane separators ──
let nowLine, nowLabel, gutterPills = []
function buildStatic() {
  L.sep.textContent = ''; L.now.textContent = ''
  for (let i = 1; i <= G.n; i++) mk('line', i === G.n ? 'axl' : 'sl', L.sep, { x1: 0, x2: G.w, y1: i * G.L - 0.5, y2: i * G.L - 0.5 })
  nowLine = mk('line', 'nl', L.now, { y1: 0, y2: G.n * G.L })
  nowLabel = mk('text', 'nt', L.now, { y: G.n * G.L + 15, 'text-anchor': 'middle' })
  gutterPills = []
}
function pill(i) {
  if (gutterPills[i]) return gutterPills[i]
  const g = mk('g', 'gp', L.now), r = mk('rect', '', g, { rx: 2.5, height: 11, y: -5.5 }), t = mk('text', '', g, { y: 3.1 })
  return (gutterPills[i] = { g, r, t, s: '', c: '' })
}
const waitLabels = new Map()

// ── the lane heads: each node's gadgets.stock and its stamp (its own maps: state, versions — no copies) ──
let heads = new Map()
function headHTML(id) {
  const srv = page.role(id) === 'server'
  return `<div class="tl-h1"><span class="tl-role">${srv ? 'server' : 'client'}</span><span class="tl-name" data-attested="runtime">${nid(id)}</span>${srv ? '' : '<span class="tl-via" data-k="via"></span>'}<span class="tl-pill" data-k="pill">up</span></div>
    <div class="tl-h2"><span class="tl-v" data-k="v" data-attested="runtime">…</span><span class="tl-star" data-k="star" hidden title="this server owns ${BIG} in its view: it stamps every write to it">★</span><span class="tl-st" data-k="st"></span></div>
    <div class="tl-h3" data-k="meta"></div>`
}
function buildHeads(ids) {
  headsEl.textContent = ''
  heads = new Map()
  for (const id of ids) {
    const el = document.createElement('div')
    el.className = 'tl-lane'; el.dataset.node = id; el.dataset.role = page.role(id)
    el.innerHTML = headHTML(id)
    const k = {}; for (const x of el.querySelectorAll('[data-k]')) k[x.dataset.k] = x
    heads.set(id, { el, k, sig: '', seen: undefined, fresh: 0, flip: false })
    headsEl.append(el)
  }
  const ax = document.createElement('div'); ax.className = 'tl-lane-ax'; ax.textContent = 'simulated clock'
  headsEl.append(ax)
}
const setH = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html } }
const setT = (el, s) => { if (el.textContent !== s) { el._h = undefined; el.textContent = s } }
// a client with no server: cut off from every server, none up, or still connecting (only then "yet")
const NO_SERVER = { cut: 'no server: cut off', down: 'no server: none is up', yet: 'no server yet' }
const setC = (el, c, on) => { if (el.classList.contains(c) !== on) el.classList.toggle(c, on) }
function paintHead(id, h, now, maj) {
  const n = page.node(id), alive = page.alive(id), down = page.down.has(id), left = page.left.has(id), srv = page.role(id) === 'server'
  const iso = alive && page.isolated(id), gate = alive && srv ? page.writable(id) : null
  const view = alive ? page.viewOf(id) : null
  const v = alive ? n.state.get(KEY) : undefined, st = alive ? n.versions.get(KEY) : undefined
  // ★ = owns gadgets in its own view; hollow while read-only (cut off, rejoining): it keeps its old view, and stamps nothing
  const own = srv && alive && ownerOf(BIG, view) === id ? (gate && !gate.open ? 'old' : 'yes') : ''
  const ft = M.flash.get(`${id}|${BIG}`)
  let flash = false
  if (ft !== undefined && ft !== h.seen) { if (h.seen !== undefined) { flash = true; h.fresh = now + 1400 } h.seen = ft }
  const fresh = h.fresh > now
  const life = n ? n.incarnation : 0, prim = !srv && alive ? page.primary(id) : null
  const d = srv && !alive ? diskOf(id) : null
  const hsh = alive ? page.hash(id) : 0
  const target = D.target === id
  const sig = `${alive}${down}${left}${iso}${gate ? gate.open + gate.reason : ''}${target}|${life}|${prim}|${v && typeof v === 'object' ? v.stock : v}|${st ? `${st.epoch}.${st.seq}.${st.origin}` : '-'}|${own}|${fresh}|${view ? view.epoch : '-'}|${hsh === maj}|${d ? d.recs : ''}`
  if (sig === h.sig && !flash) return
  h.sig = sig
  setC(h.el, 'down', !alive)
  setC(h.el, 'is-cut', iso)
  setC(h.el, 'is-target', target)
  let pill = 'up', pc = 'up'
  if (down || (!alive && !left)) { pill = 'down ✕'; pc = 'neg' }
  else if (left) { pill = 'left'; pc = 'dim' }
  else if (iso) { pill = 'cut off'; pc = 'neg' }
  else if (gate && !gate.open) { pill = 'read-only'; pc = 'wait' }
  setT(h.k.pill, pill); if (h.k.pill.dataset.c !== pc) { h.k.pill.dataset.c = pc; h.k.pill.className = `tl-pill ${pc}` }
  if (alive) {
    const shown = v === undefined ? (st ? 'removed' : 'none') : (v && typeof v === 'object' && 'stock' in v ? num(v.stock) : null)
    if (shown !== null) setT(h.k.v, shown); else setH(h.k.v, inspect(v))
    setC(h.k.v, 'word', shown === null || !/^[\d,.-]+$/.test(shown))
    if (flash) { h.flip = !h.flip; setC(h.k.v, 'fl0', h.flip); setC(h.k.v, 'fl1', !h.flip) }
    setH(h.k.st, st ? A(stampHTML(st).replace('class="stamp"', `class="stamp${fresh ? ' fresh' : ''}"`)) : '')
    if (h.k.star.hidden === !!own) h.k.star.hidden = !own
    const old = own === 'old', face = old ? '☆' : '★'
    if (h.k.star.textContent !== face) h.k.star.textContent = face
    setC(h.k.star, 'old', old)
    const tt = old ? `owner of ${BIG} only in its old view ${view.epoch} · read-only: it stamps nothing until it can reach a majority again` : `this server owns ${BIG} in its view: it stamps every write to it`
    if (h.k.star.title !== tt) h.k.star.title = tt
    // a client's server goes on the name line, so the meta line (view, life, copy) always fits its column
    if (h.k.via) setH(h.k.via, prim ? `follows ${A(nid(prim))}` : NO_SERVER[noServerWhy(id)])
    // on narrower screens the life count drops out of this line (timeline.css hides .tl-life-m), so it always fits
    setH(h.k.meta, `${A(esc(`view ${view.epoch}`))}${life > 1 ? `<span class="tl-life-m"> · ${A(esc(`life ${life}`))}</span>` : ''} · ${hsh === maj ? '<span class="agree-ok" title="this copy\'s state fingerprint matches the most common one">copy ✓</span>' : '<span class="waiting" title="this copy\'s state fingerprint differs from the most common one: it may be behind, or ahead (the owner applies first)">copy differs</span>'}`)
  } else {
    setT(h.k.v, left ? 'left' : '✕ crashed'); setC(h.k.v, 'word', true)
    setH(h.k.st, '')
    if (!h.k.star.hidden) h.k.star.hidden = true
    if (h.k.via) setH(h.k.via, '')
    // records, the unit the sentence and the restart's replay use
    setH(h.k.meta, left ? 'left on purpose: voted out when it asked' : d ? `${A(esc(`disk kept · ${d.recs} ${d.recs === 1 ? 'record' : 'records'}`))}` : 'no disk: its copy is gone')
  }
}

// ── the hidden frames line and the legend ──
legendEl.innerHTML = '<span class="tl-lg"><i class="lg k-write">WRITE</i><i class="lg k-repl">RECORDS</i><i class="lg k-vote">VOTE</i><i class="lg k-link"></i>HELLO</span>' +
  '<span class="tl-lg" title="a frame whose content already crossed that link: a retry, a repeated ballot, a record sent again to fill a gap"><i class="lg k-write again">WRITE</i>sent again</span>' +
  '<span class="tl-lg"><i class="lg tk"></i>stamped <i class="lg ap"></i>landed <i class="lg bar"></i>waiting <i class="lg x">✕</i>crash</span>'
let hiddenKey = ''
const INWORDS = { 2: 'two', 4: 'four', 8: 'eight', 16: 'sixteen', 32: 'thirty-two', 64: 'sixty-four' }
function paintHidden(force) {
  const vc = page.verbCounts, p = vc.PING ?? 0, q = vc.PONG ?? 0, d = vc.DIGEST ?? 0
  const key = `${p}|${q}|${d}|${showHidden}|${hidStride}`
  if (!force && key === hiddenKey) return
  hiddenKey = key
  hiddenEl.title = 'heartbeats (PING, PONG) and digests (DIGEST) sent since this run started — most of the frames on the wire'
  const how = !showHidden ? 'not drawn' : hidStride > 1 ? `drawn faint, one in ${INWORDS[hidStride] ?? 'many'}` : 'drawn faint'
  setH(hiddenEl, `${how}: PING ${A(esc(num(p)))} · PONG ${A(esc(num(q)))} · DIGEST ${A(esc(num(d)))} <button type="button" class="cl-show" data-toggle aria-pressed="${showHidden}">${showHidden ? 'hide' : 'show'}</button>`)
}
hiddenEl.addEventListener('click', (e) => { if (e.target.closest('[data-toggle]')) { showHidden = !showHidden; paintHidden(true); dirty = true } })

// ── the frame panel: one frame taken apart by kernel/codec.js (core.js decode) ──
const sel = { f: null, auto: true, painted: '' }
function drawable(f) { return f && (showHidden || !f.hidden) }
function latest() {
  // the newest WRITE that has landed (a new one still on the wire keeps the last one shown): the frame that carries
  // the record an assignment becomes. Before the first one lands, the panel says it is coming.
  const now = page.now
  for (let i = S.writes.length - 1; i >= 0; i--) { const w = S.writes[i]; if (w.recvAt <= now && S.byId.has(w.id)) return w }
  return null
}
function select(f, auto) {
  if (sel.f === f && sel.auto === auto) return
  if (sel.f?.el) { sel.f.el.g.classList.remove('sel'); sel.f.el.tag?.classList.remove('sel') }
  sel.f = f; sel.auto = auto
  if (f?.el) { f.el.g.classList.add('sel'); f.el.g.parentNode.append(f.el.g); f.el.tag?.classList.add('sel') }
  paintPanel(true)
}
function step(dir) {
  const i = sel.f ? S.frames.indexOf(sel.f) : S.frames.length
  for (let j = i + dir; j >= 0 && j < S.frames.length; j += dir) {
    const f = S.frames[j]
    if (drawable(f) && f.sentAt <= page.now) { select(f, false); return }
  }
}
const navB = { prev: frNav.querySelector('[data-tl="prev"]'), next: frNav.querySelector('[data-tl="next"]'), latest: frNav.querySelector('[data-tl="latest"]') }
let navAt = 0
function paintNav() {
  navAt = performance.now()
  const f = sel.f
  if (navB.latest.getAttribute('aria-pressed') !== String(sel.auto)) navB.latest.setAttribute('aria-pressed', String(sel.auto))
  const i = f ? S.frames.indexOf(f) : -1
  let prev = false, next = false
  if (f) {
    for (let j = i - 1; j >= 0 && !prev; j--) if (drawable(S.frames[j])) prev = true
    for (let j = i + 1; j < S.frames.length && !next; j++) if (drawable(S.frames[j]) && S.frames[j].sentAt <= page.now) next = true
  }
  if (navB.prev.disabled !== !prev) navB.prev.disabled = !prev
  if (navB.next.disabled !== !next) navB.next.disabled = !next
}
function paintPanel(force) {
  const f = sel.f
  if (force || performance.now() - navAt > 300) paintNav()
  const landed = f && f.recvAt <= page.now
  const tap = COARSE || sawTouch
  const key = f ? `${f.id}|${landed}|${sel.auto}|${held}|${heldBy}|${tap}` : `none|${held}|${heldBy}|${tap}`
  if (!force && key === sel.painted) return
  sel.painted = key
  // what the panel shows, then how to pick (or that the plot is holding still: under the pointer, or after a tap)
  const how = held ? (heldBy === 'touch' ? 'the plot holds still for a few seconds after a tap: tap a line' : 'the plot holds still while the pointer is on it')
    : sel.auto ? (tap ? 'tap the plot to hold it, then tap a line' : 'point at the plot to hold it, then click any line') : 'latest follows the newest WRITE again'
  setT(frMode, `${sel.auto ? 'the latest WRITE' : 'the frame you picked'} · ${how}`)
  if (!f) {
    // after a reset the panel keeps the room the last frame took until the new run's first WRITE lands, so it does not
    // shrink and grow again under the figure
    if (!frBody.style.minHeight) { const hh = frBody.getBoundingClientRect().height; if (hh > 40) frBody.style.minHeight = `${hh}px` }
    setH(frBody, `<span class="tl-fr-none">no WRITE frame yet: the first one goes out when ${A(nid(page.writer.id))} next writes ${esc(page.writer.row)}</span>`); return
  }
  if (frBody.style.minHeight) frBody.style.minHeight = ''
  let d = null
  try { d = decode(f.bytes) } catch { d = null }
  const flight = f.recvAt - f.sentAt
  const at = (ms) => `${(ms / 1000).toFixed(2)} s`
  const rows = []
  rows.push(`<div class="tl-fr-l1"><span class="tl-fv k-${f.kind}">${esc(f.verb)}</span> ${A(nid(f.from))} <span class="tl-arrow">→</span> ${A(nid(f.to))}` +
    `<span class="tl-fr-t"> · sent ${A(esc(at(f.sentAt)))} · ${landed ? `landed ${A(esc(at(f.recvAt)))}` : 'still on the wire'} · ${A(esc(`${Math.round(flight)} ms`))} on the wire · ${A(esc(`${num(f.size)} bytes`))} · simulated clock</span></div>`)
  rows.push(`<div class="tl-fr-gist">${GIST[f.verb] ?? ''}</div>`)
  if (d && d.prov && PROV[f.verb]) {
    const [k, help] = PROV[f.verb]
    rows.push(`<div class="tl-fr-r"><span class="tl-fk">${k}</span><span class="tl-fo">${A(inspect({ origin: d.prov.origin, baseSeq: d.prov.baseSeq, epoch: d.prov.epoch }))}</span><span class="tl-fh">${help(d.prov)}</span></div>`)
  }
  if (d && d.recs) {
    const list = d.recs.slice(0, 4)
    for (const r of list) {
      const st = f.verb === 'WRITE' ? '<span class="stamp un" title="a WRITE carries no stamp yet: the owner gives it one">unstamped</span>' : A(stampHTML({ epoch: r.epoch, seq: r.seq, origin: r.origin }))
      const rr = { type: r.type, key: r.key }; if (r.type !== 2) rr.value = r.value
      rows.push(`<div class="tl-fr-r"><span class="tl-fk">record</span><span class="tl-fo">${st} ${A(rec(rr))}</span></div>`)
    }
    if (d.recs.length > list.length) rows.push(`<div class="tl-fr-r"><span class="tl-fk"></span><span class="tl-fo tl-fh">${A(esc(`+ ${d.recs.length - list.length} more records in this frame`))}</span></div>`)
  } else if (d && d.value !== undefined) {
    rows.push(`<div class="tl-fr-r"><span class="tl-fk">body</span><span class="tl-fo">${A(inspect(d.value))}</span>${KEYS[f.verb] ? `<span class="tl-fh">${KEYS[f.verb]}</span>` : ''}</div>`)
  } else if (d) {
    rows.push(`<div class="tl-fr-r"><span class="tl-fk">body</span><span class="tl-fo tl-fh">none: the verb is the whole message</span></div>`)
  }
  setH(frBody, rows.join(''))
}
frNav.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tl]'); if (!b || b.disabled) return
  if (b.dataset.tl === 'prev') step(-1)
  else if (b.dataset.tl === 'next') step(1)
  else { select(latest(), true) }
})
// ── holding still: while a mouse or pen is on the plot, the plot stops scrolling (the cluster runs on; the plot
// catches up when the pointer leaves), so a line can be picked where it is instead of chased. A press picks the line
// under the pointer, or the nearest drawn line within 8 px — resolved at the press, never at a later click.
// Touch has nothing to point with: the first tap holds the plot (it picks nothing: the finger aimed at a plot that
// was moving), and a tap while it holds picks the line under it, within 14 px, from the still drawing. It lets go
// TOUCH_HOLD ms after the last tap on it, or at a tap anywhere else. A drag that scrolls the page never picks. ──
const TOUCH_HOLD = 4000
let sawTouch = false, touchTimer = 0, tapHolds = false
function setHeld(on, by = 'pointer') {
  if (on === held && (!on || by === heldBy)) return
  held = on; heldBy = on ? by : ''
  if (!on) clearTimeout(touchTimer)
  setC(root, 'tl-held', on)
  paintWin(); paintPanel(true)
}
function armTouch() { clearTimeout(touchTimer); touchTimer = setTimeout(() => { if (heldBy === 'touch') setHeld(false) }, TOUCH_HOLD) }
plotEl.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') setHeld(true, 'pointer') })
plotEl.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && heldBy === 'pointer') setHeld(false) })
plotEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return
  sawTouch = true
  // a press on a moving plot only holds it; the tap that follows (if this is not a scroll) picks nothing
  tapHolds = !(held && heldBy === 'touch')
  setHeld(true, 'touch'); armTouch()
})
document.addEventListener('pointerdown', (e) => { if (heldBy === 'touch' && !plotEl.contains(e.target)) setHeld(false) }, true)
// the line nearest the press wins, not simply the one drawn on top: lines that leave one sender at one instant (a
// RECORDS fan-out) overlap near their start, and the top one's wide hit area would take a press aimed at its
// neighbour. Lines that lie on each other (as near as the nearest, within a pixel) go to the one on top: it is the
// one the reader sees, and ‹ earlier / later › step to the other
function pick(e, within = 8) {
  const g = e.target.closest && e.target.closest('g.fr[data-fid]')
  const top0 = g ? S.byId.get(+g.dataset.fid) : null, top = top0 && drawable(top0) ? top0 : null
  const m = svg.getScreenCTM(); if (!m) return top
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY
  const q = pt.matrixTransform(m.inverse()), x = q.x - G.tx, y = q.y
  let best = null, bd = within, topD = Infinity
  for (const f of S.frames) {
    const el = f.el; if (!el || !el.ln || !drawable(f) || el.g.style.display === 'none') continue
    const x1 = el.x1, y1 = el.y1, x2 = +el.ln.getAttribute('x2'), y2 = +el.ln.getAttribute('y2')
    const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy
    const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0
    const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
    if (f === top) topD = d
    if (d < bd) { bd = d; best = f }
  }
  return top && topD <= bd + 1 ? top : best ?? top
}
svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.pointerType === 'touch') return
  const f = pick(e)
  if (f) { e.preventDefault(); select(f, false) }
})
// a tap (touch): picks only while the plot already held still before the finger came down
svg.addEventListener('click', (e) => {
  if (heldBy !== 'touch') return
  if (tapHolds) { tapHolds = false; return }
  const f = pick(e, 14)
  if (f) select(f, false)
  armTouch()
})

// ── rebuild: lanes, size, window or run changed — everything is redrawn from the store ──
function rebuild(ids) {
  const r0 = performance.now()
  try { rebuildNow(ids) } finally { const d = performance.now() - r0; perf.rebuilds++; perf.rebuildSum += d; if (d > perf.rebuildMax) perf.rebuildMax = d }
}
// the narrowest plot drawn at its own width (a 360 px phone's is about 203 px): below it the drawing would scale
const MIN_W = 160
function rebuildNow(ids) {
  const pw = Math.max(MIN_W, plotW)
  G.ids = ids.slice(); G.n = ids.length; G.lane = new Map(ids.map((id, i) => [id, i]))
  G.gen = M.gen
  G.phone = pw < 520
  // narrower screens stack the lane head's stamp on its own line (timeline.css), so a lane needs more height there
  G.L = G.phone ? 74 : NARROW.matches ? 78 : 70
  G.gutter = G.phone ? 58 : 84
  G.w = pw; G.h = G.n * G.L + G.axisH
  G.W = windowMs(pw)
  G.k = (G.w - G.gutter) / G.W
  root.style.setProperty('--tl-L', G.L + 'px')
  root.style.setProperty('--tl-ax', G.axisH + 'px')
  svg.setAttribute('width', G.w); svg.setAttribute('height', G.h); svg.setAttribute('viewBox', `0 0 ${G.w} ${G.h}`)
  for (const k of ['grid', 'band', 'base', 'bar', 'line', 'tag', 'mark']) L[k].textContent = ''
  for (const arr of [S.frames, S.ticks, S.bands, S.lives, S.cuts, S.marks]) for (const x of arr) x.el = null
  flying.clear(); open.clear(); boxes = []; secs.clear(); minors.clear(); bars.clear(); markEnd.clear(); waitLabels.clear(); redraw.clear(); hidDrawn.length = 0; tagged.clear(); pendingLabels.clear()
  for (const k in cur) cur[k] = 0
  buildStatic()
  if (heads.size !== ids.length || ids.some((id) => !heads.has(id))) buildHeads(ids)
  for (const h of heads.values()) h.sig = ''
  hidStride = 1; hidN = 0
  winEl._h = ''; paintWin()
  dirty = false
}

// the column header: what the plot shows, and, while it holds still, why it stopped (in place of "the last few
// seconds", so the reason is never the part an ellipsis cuts)
function paintWin() {
  const html = held ? (heldBy === 'touch' ? 'frames on the wire · held still for a few seconds · tap a line' : 'frames on the wire · held still while the pointer is on it')
    : D.speed === '4' ? 'frames on the wire · a wider window while <span data-literal>4×</span> runs · simulated clock' : 'frames on the wire · the last few seconds · simulated clock'
  if (winEl._h !== html) { winEl._h = html; winEl.innerHTML = html }
}

// ── the loop body (the section's one frame loop calls it while variant b is shown and on screen) ──
let lastHidden = 0, lastR = 0, lastW = 0
const perf = { frames: 0, sum: 0, max: 0, maxWhy: '', over: 0, slow: [], rebuilds: 0, rebuildMax: 0, rebuildSum: 0, drawn: 0 }
export function frame() {
  const p0 = performance.now(), r0 = perf.rebuilds, n0 = perf.drawn
  body()
  const d = performance.now() - p0
  perf.frames++; perf.sum += d
  const why = `${perf.rebuilds > r0 ? 'rebuild + ' : ''}${perf.drawn - n0} lines drawn${showHidden ? ' (heartbeats on)' : ''} · W ${G.W}`
  if (d > 8) { perf.over++; perf.slow.push(`${d.toFixed(1)} ms: ${why}`); if (perf.slow.length > 20) perf.slow.shift() }
  if (d > perf.max) { perf.max = d; perf.maxWhy = why }
}
function body() {
  const ids = page.ids()
  // the plot's width comes from the ResizeObserver (reading layout every frame could force a reflow after another
  // section's DOM writes in the same frame)
  if (plotW < 0) plotW = Math.round(plotEl.clientWidth)
  if (plotW <= 0) return
  // the same floor rebuildNow puts on the width (comparing the raw width with a floored one rebuilt everything on
  // every frame wherever the plot was narrower than the floor: every phone)
  const pw = Math.max(MIN_W, plotW)
  const rebuilt = dirty || G.gen !== M.gen || ids.length !== G.n || ids.some((id, i) => id !== G.ids[i]) || pw !== G.w || windowMs(pw) !== G.W
  if (rebuilt) rebuild(ids)
  const now = page.now
  if (held && !rebuilt) {
    const maj = majorityHash()
    for (const [id, h] of heads) paintHead(id, h, now, maj)
    paintPanel(false)
    return
  }
  // reduced motion: nothing slides — the window pages, the drawing updates a few times a second
  if (REDUCED) {
    if (performance.now() - lastR < 250) return
    lastR = performance.now()
    if (now < G.leftT || now > G.leftT + G.W) G.leftT = Math.max(0, now - G.W * 0.1)
    G.left = G.leftT
  } else G.left = now - G.W
  const leftT = G.left
  const tx = -leftT * G.k
  G.tx = tx
  L.scroll.setAttribute('transform', `translate(${tx.toFixed(2)} 0)`)
  const nowX = (now - leftT) * G.k
  // new items, in time order (the small arrays are walked whole; the long ones from their cursors)
  for (const arr of [S.bands, S.lives, S.cuts]) for (const x of arr) if (x.el === null && (x.to ?? now) >= leftT - 50) (arr === S.bands ? drawBand : arr === S.lives ? drawLife : drawCut)(x)
  for (; cur.tDraw < S.ticks.length; cur.tDraw++) { const t = S.ticks[cur.tDraw]; if (t.el === null && t.at >= leftT - 400) drawTick(t) }
  for (; cur.mDraw < S.marks.length; cur.mDraw++) { const m = S.marks[cur.mDraw]; if (m.el === null && m.at >= leftT - 1500 && !drawMark(m, tx)) break }
  for (const x of redraw) if (x.el === null) { if (x.stamps) drawTick(x); else if (!drawMark(x, tx)) continue } 
  for (const x of [...redraw]) if (x.el !== null) redraw.delete(x)
  // at most 160 new lines a frame: turning the heartbeats on draws a few hundred at once, spread over a few frames
  for (let budget = 160; cur.fDraw < S.frames.length && budget > 0; cur.fDraw++) {
    const f = S.frames[cur.fDraw]
    if (f.el === null && f.recvAt >= leftT - 50) { drawFrame(f); if (f.el) { budget--; perf.drawn++ } }
  }
  // frames on the wire: the tip on the now line; a frame that arrived lands
  for (const f of flying) { if (!f.el) { flying.delete(f); continue } if (now >= f.recvAt) land(f); else fly(f, now) }
  // open segments grow to now; one that closed gets its end
  for (const x of open) {
    if (!x.el) { open.delete(x); continue }
    const x2 = (x.to ?? now) * G.k
    if (x.el.r) x.el.r.setAttribute('width', Math.max(0, x2 - x.el.x).toFixed(1))
    else x.el.ln.setAttribute('x2', x2.toFixed(1))
    if (x.to !== null) { open.delete(x); if (S.lives.includes(x)) endLife(x) }
  }
  syncBars(now, leftT)
  syncSecs(leftT, now)
  syncLabels(now)
  // forget what has scrolled out of the window (the store keeps it a while longer for a wider window)
  const gone = leftT - 400
  for (; cur.fPrune < cur.fDraw; cur.fPrune++) { const f = S.frames[cur.fPrune]; if (f.recvAt >= gone) break; if (f.el) dropEl(f) }
  for (; cur.tPrune < cur.tDraw; cur.tPrune++) { const t = S.ticks[cur.tPrune]; if (t.at >= gone) break; if (t.el) dropEl(t) }
  if (boxes.length > 200) boxes = boxes.filter((b) => b.x2 >= gone * G.k)
  if (performance.now() - lastW > 500) {
    lastW = performance.now()
    trimTicks(); trimMarks(); trimFrames()
    trim(S.cuts, (c) => c.to ?? Infinity); trim(S.bands, (b) => b.to ?? Infinity)
  }
  // the static layer: the now line, its time, the verbs of frames on the wire, and the waiting writes
  nowLine.setAttribute('x1', nowX.toFixed(1)); nowLine.setAttribute('x2', nowX.toFixed(1))
  nowLabel.setAttribute('x', Math.min(G.w - 30, nowX).toFixed(1)); const nt = `now ${vt(now)}`; if (nowLabel.textContent !== nt) nowLabel.textContent = nt
  // an axis label hides near the now label, and where the plot's left edge would cut it
  for (const [s, e] of secs) { const sx = e.x + tx, hide = Math.abs(sx - nowX) < 46 || sx < 14; if ((e.t.style.display === 'none') !== hide) e.t.style.display = hide ? 'none' : '' }
  paintGutter(now, nowX)
  // heads, the hidden-frames line, the panel
  const maj = majorityHash()
  for (const [id, h] of heads) paintHead(id, h, now, maj)
  if (performance.now() - lastHidden > 250) { lastHidden = performance.now(); paintHidden(false) }
  if (sel.auto) { const f = latest(); if (f && f !== sel.f) { const a = sel.auto; select(f, a) } }
  paintPanel(false)
}
// the gutter right of the now line: the verb of each frame on the wire, at its tip's height, and how long each
// lane's waiting write has waited
function paintGutter(now, nowX) {
  let used = 0
  const items = []
  if (!REDUCED) for (const f of flying) if (f.el && !f.hidden && f.el.tipY != null) items.push(f)
  items.sort((a, b) => a.el.tipY - b.el.tipY)
  let lastY = -99, lastX = 0
  for (const f of items) {
    const w = 6 + f.verb.length * CH
    let x = nowX + 6
    if (Math.abs(f.el.tipY - lastY) < 12) x = lastX
    if (x + w > G.w - 2) continue
    const p = pill(used++)
    const cls = `gp k-${f.kind}${f.fresh ? '' : ' again'}`
    if (p.c !== cls) { p.c = cls; p.g.setAttribute('class', cls) }
    if (p.s !== f.verb) { p.s = f.verb; p.t.textContent = f.verb; p.r.setAttribute('width', w.toFixed(1)); p.t.setAttribute('x', (w / 2).toFixed(1)); p.t.setAttribute('text-anchor', 'middle') }
    p.g.setAttribute('transform', `translate(${x.toFixed(1)} ${f.el.tipY.toFixed(1)})`)
    if (p.g.style.display) p.g.style.display = ''
    lastY = f.el.tipY; lastX = x + w + 3
  }
  for (let i = used; i < gutterPills.length; i++) if (gutterPills[i].g.style.display !== 'none') gutterPills[i].g.style.display = 'none'
  // waiting writes: one label per issuer lane, in the gutter beside the now line, under the lane's line. Like every
  // time on the page it says "simulated": on its own line ("waiting 2.4 s" / "simulated"), or, where the gutter is a
  // phone's, one word or time a line ("waiting" / "2.4 s" / "simulated")
  const seen = new Set()
  for (const b of bars.values()) {
    if (b.st !== 'on') continue
    const id = b.w.node; if (seen.has(id)) continue
    seen.add(id)
    let el = waitLabels.get(id)
    if (!el) { el = { t: mk('text', 'gw', L.now), sp: [], s: '' }; waitLabels.set(id, el) }
    const y = yOf(id); if (y == null) continue
    const t = vt(now - b.w.issuedAt), x = nowX + 6
    const lines = x + (8 + t.length) * CH <= G.w - 2 ? [`waiting ${t}`, 'simulated'] : ['waiting', t, 'simulated']
    const s = lines.join('|')
    if (el.s !== s) {
      el.s = s
      if (el.sp.length !== lines.length) { el.t.textContent = ''; el.sp = lines.map((_, i) => mk('tspan', '', el.t, { dy: i ? (lines.length > 2 ? 9 : 9.6) : 0 })); el.x = el.y = '' }
      lines.forEach((ln, i) => { if (el.sp[i].textContent !== ln) el.sp[i].textContent = ln })
    }
    const xs = x.toFixed(1)
    if (el.x !== xs) { el.x = xs; el.t.setAttribute('x', xs); for (const sp of el.sp) sp.setAttribute('x', xs) }
    const ys = (y + (lines.length > 2 ? 10 : 13)).toFixed(1)
    if (el.y !== ys) { el.y = ys; el.t.setAttribute('y', ys) }
    if (el.t.style.display) el.t.style.display = ''
  }
  for (const [id, el] of waitLabels) if (!seen.has(id) && el.t.style.display !== 'none') el.t.style.display = 'none'
}

let plotW = -1   // -1: measure on the next frame
export function shown() { dirty = true; plotW = -1 }
// a read-only handle for tools/cluster-b-*.mjs (the drive tests)
export const debug = { G, S, sel, get showHidden() { return showHidden }, flying, bars, perf, decode }
export function relayout() { dirty = true; plotW = -1 }
if ('ResizeObserver' in window) new ResizeObserver((es) => { for (const e of es) { const w = Math.round(e.contentRect.width); if (w !== plotW) { plotW = w; dirty = true } } }).observe(plotEl)
prime()
