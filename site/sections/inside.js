/* sections/inside.js — §04 See inside: fero's debugger fold, run over the house cluster.
   REAL, every value:
     capture   lib/tools/debug/capture.js captureSim(page.sim): the debugger's own capture of the live run
     fold      lib/tools/debug/model.mjs verifyReplay · routes · contested · stateAt, unchanged (the bytes
               viewer.html loads). verifyReplay must pass, or fail only because a journal ring dropped
               lines (said in amber, never a red ✗), before the card paints anything.
     clock     the simulated time of every journal line, noted as the kernel writes it (the core tap's
               'journal' event), so the time bar lines every node up on one clock (./inside/fold.js)
     tips      lib/tools/debug/eli5.mjs mountTips: the debugger's own plain-English card, on every label
               (hover; on a touch screen, a tap)
   It refolds when the card comes into view and after each change to the cluster (page events),
   throttled, never while the tab is hidden or the card off-screen. A journal ring that dropped lines
   turns the replay check and the time bar off for that node, in amber words, and offers a rebuild from
   the seed: an own run in a Worker with every journal line kept (./inside/worker.js). The page's words
   say "read" for a fold: the card reads the journals back and builds its views from them. */
import { page, attest, put, fmt, onFrame, REDUCED } from '../cluster.js'
import { stamp, inspect, rec, vt, esc } from '../ui.js'
import { mountTips } from '../lib/tools/debug/eli5.mjs'
import { Clock, capture, STAGES, fold, viewAt, marks, captureNode, prettyCell, noteCuts, cutAt, CUT_EVENTS } from './inside/fold.js'

const section = document.getElementById('inside')
const $ = (id) => document.getElementById(id)
const card = $('inside-card')
const table = section.querySelector('.ic-t'), wrap = section.querySelector('.ic-tablewrap')
const ROWS = 5                 // writes shown, newest first
const MIN_GAP = 250            // ms between refolds at least; a fold that costs more waits longer (×60)
const IDLE_GAP = 1000          // refold this often while in view even when nothing happens (journals keep growing)
const SPLIT_MS = 8             // a fold that cost more than this runs one stage per idle task
const SPLIT_ROWS = 30000       // …and so does any fold over this many journal lines (about 8 ms here)
const QUIET_AFTER = 5000       // a live paint this long after the last one changes cells without flashing them

// ── the journal clock: when each line was written, on the simulated clock ──────────────────────────
const clock = new Clock()
clock.seed(page.sim.nodes, page.journal, page.now)
page.on('journal', (e) => clock.row(page.node(e.node), e.node, e.at))
page.on('restart', (id) => { clock.sync(page.node(id), id, page.now); touch(true) })
page.on('join', (id) => { clock.sync(page.node(id), id, page.now); touch(true) })
page.on('kill', (id) => { const n = page.node(id); clock.died(n, page.now, captureNode(n), 'down'); touch(true) })
page.on('left', (id) => { clock.died(page.node(id), page.now, null, 'left'); touch(true) })
// who is cut off from every other node, and since when (no journal line says so: the page notes it, ./inside/fold.js)
const cuts = noteCuts(page, new Map())
for (const ev of CUT_EVENTS) page.on(ev, () => noteCuts(page, cuts))
page.on('reset', () => { clock.clear(); clock.seed(page.sim.nodes, page.journal, page.now); cuts.clear(); noteCuts(page, cuts); F = null; src = null; range.disabled = true; scrubT = null; job = null; building?.terminate(); building = null; if (own) { own.stop(); own = null } swMax = 0; quietNext = true; showRebuildIdle(); touch(true) })
for (const ev of ['write', 'commit', 'apply', 'cut', 'heal', 'view', 'fault', 'disk', 'leave', 'writer']) page.on(ev, () => touch(false))

// ── state ────────────────────────────────────────────────────────────────────────────────────────────
let F = null             // the live fold: fold() over page.sim
let src = null           // what the card paints from: the live fold, or the own run's (see rebuild())
let own = null           // the rebuilt own run, while it is shown
let scrubT = null        // simulated ms the bar is rewound to; null = the end of the fold
let dirty = true, urgent = true, lastFold = -1e9, inView = false
let building = null      // the rebuild worker while it runs
let quietNext = true     // the next paint changes cells without flashing them (first paint, back from a rewind…)
let lastLive = -1e9      // when the last live (not rewound) paint happened, wall ms
function touch(now) { dirty = true; if (now) urgent = true }

// ── the tooltip layer: the debugger's own card; neutral chrome while it explains this section ───────
const tips = mountTips(document)
// the neutral chrome follows the card's anchor (mouse or touch alike): on while it explains a label in #inside
// (it is left as it was while the card fades out, so the chrome never flips during the fade)
if (tips) new MutationObserver(() => { if (!tips.anchor) return; const want = section.contains(tips.anchor); if (tips.card.classList.contains('inside-tip') !== want) tips.card.classList.toggle('inside-tip', want) }).observe(tips.card, { attributes: true, attributeFilter: ['class'] })
// a touch screen has no hover: a tap on a label opens its note (eli5 hides the card on the tap's mousedown;
// the click comes after it). Buttons and the bar keep their own job.
const HOVERLESS = typeof matchMedia === 'function' ? matchMedia('(hover: none)') : null
const syncHint = () => put($('inside-hint'), `${HOVERLESS?.matches ? 'Tap' : 'Hover'} a label for the debugger's own plain-English note.`)
syncHint(); HOVERLESS?.addEventListener?.('change', syncHint)
section.addEventListener('click', (e) => {
  if (!tips || !HOVERLESS?.matches) return
  const el = e.target.closest?.('[data-tip]')
  if (!el || el.closest('button, input, a')) return
  tips.show(el)
})
// Chrome's touch emulation follows every tap with a hover refresh at the page origin (0, 0), and eli5 closes
// the card on a hover over no label. A finger is never there, so while one of this section's notes is open
// that one event is not passed on (taps elsewhere, scrolls and keys still close the note).
window.addEventListener('mouseover', (e) => {
  if (HOVERLESS?.matches && e.clientX === 0 && e.clientY === 0 && tips?.anchor && section.contains(tips.anchor)) e.stopPropagation()
}, true)

// ── small DOM helpers ────────────────────────────────────────────────────────────────────────────────
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
// set an element's markup (only when it changed, so a hovered tooltip anchor survives a refold) + its tier
// (ui.js chips carry a native title; inside the card the eli5 card is the one tooltip, so titles go)
const html = (el, s, tier = 'runtime') => { if (el.__h !== s) { el.innerHTML = s; el.__h = s; for (const t of el.querySelectorAll('[title]')) t.removeAttribute('title') } if (tier) { if (el.getAttribute('data-attested') !== tier) el.setAttribute('data-attested', tier) } else el.removeAttribute('data-attested'); return el }
const tip = (el, key, fact) => { if (key) el.setAttribute('data-tip', key); else el.removeAttribute('data-tip'); if (fact) el.setAttribute('data-tip-fact', fact); else el.removeAttribute('data-tip-fact'); return el }
// restart a cell's flash by swapping between two animation names: no forced layout (the page is long)
const flash = (el) => { if (REDUCED || !el) return; const a = el.classList.contains('flash'); el.classList.toggle('flash', !a); el.classList.toggle('flash2', a) }
const nidHTML = (id) => `<span class="nid" data-node="${esc(id)}">${esc(id)}</span>`
const stampText = (s) => `view ${s.epoch} · #${s.seq} · ${s.origin}`
const recText = (r) => { const d = document.createElement('div'); d.innerHTML = rec(r); return d.textContent }
const inspectText = (v) => { const d = document.createElement('div'); d.innerHTML = inspect(v); return d.textContent }
// a full-width table row whose text stays in view when the table scrolls sideways
const spanRow = (cls, n) => { const tr = h('tr', cls), td = h('td'); td.colSpan = n; td.append(h('span', 'sx')); tr.append(td); return tr }
let ctx = { down: new Set(), left: new Set(), servers: new Set(), cut: new Set(), trunc: false } // the paint source's node facts
const roleOf = (id) => (ctx.servers.has(id) ? 'server' : 'client')

// ── the replay gate: nothing below paints until it passes ────────────────────────────────────────────
const gate = $('inside-gate')
function renderGate(R) {
  const trunc = R.filter((r) => r.dropped > 0), bad = R.filter((r) => !r.ok && !(r.dropped > 0)), good = R.filter((r) => r.ok)
  let s
  if (bad.length) {
    s = `<span class="ic-verdict bad" data-tip="replay-bad">replay ✗</span><span class="why"><span class="badt">${bad.map((r) => `${esc(r.uuid)}: ${esc(r.reason)}`).join(' · ')}</span>. The card will not draw what the replay does not prove.</span>`
  } else if (trunc.length) {
    const names = trunc.map((r) => esc(r.uuid)).join(', '), many = trunc.length > 1
    s = `<span class="ic-verdict warn" data-tip="node:truncated">replay</span><span class="why"><span class="warnt" data-tip="node:truncated">${names} dropped ${many ? 'their' : 'its'} oldest journal lines</span>, so ${many ? 'they' : 'it'} cannot be replayed from the start. Below: what each node holds now, and the writes in the lines still kept.</span>`
  } else s = `<span class="ic-verdict ok" data-tip="replay-ok">replay ✓</span><span class="why"><span data-tip="replay-ok">${good.length} of ${R.length} nodes</span> rebuilt exactly from their journals and records</span>`
  // "the recording is complete" (replay-ok) is only true while no journal dropped a line
  if (!bad.length && trunc.length) s += `<span class="n" data-tip="node:truncated">${good.length} of ${R.length} nodes checked</span>`
  html(gate, s)
  return !bad.length
}

// ── the table: node columns, shared by "what each node holds" and "where each write went" ───────────
// The label column is pinned (sticky) so row names and stamps stay in view when the table scrolls sideways.
const thead = $('inside-thead'), holds = $('inside-holds'), writesEl = $('inside-writes')
let cols = ''                 // the node columns the table is built for
let heads = new Map()         // uuid → th
let phHolds = null, phWrites = null, linesRow = null, moreRow = null, wMoreRow = null
let xcue = null               // "n03 c1 →": the node columns past the card's right edge (a phone, or many nodes)
const hrows = new Map()       // row name → { tr, th, tds: Map uuid → td }
const wrows = new Map()       // write id → { tr, th, tds: Map uuid → { td, st, dt } }
function build(V) {
  cols = V.nodes.map((n) => n.uuid).join('|')
  const N = V.nodes.length + 1
  table.querySelector('colgroup')?.remove()
  const cg = document.createElement('colgroup'); cg.append(h('col', 'c-label')); for (const n of V.nodes) cg.append(h('col', 'c-node'))
  table.prepend(cg)
  table.style.setProperty('--n', String(V.nodes.length))
  thead.replaceChildren(h('th', 'corner')); heads = new Map()
  for (const n of V.nodes) { const th = h('th', 'nh'); thead.append(th); heads.set(n.uuid, th) }
  holds.replaceChildren(); writesEl.replaceChildren(); hrows.clear(); wrows.clear()
  const head = (cls, parts) => { const tr = h('tr', 'ph ' + cls), th = h('th'), w = h('div', 'phw'); th.colSpan = N; w.append(...parts); th.append(w); tr.append(th); return tr }
  xcue = h('button', 'xcue'); xcue.type = 'button'; xcue.hidden = true; xcue.setAttribute('aria-label', 'scroll the table sideways')
  xcue.addEventListener('click', () => wrap.scrollTo({ left: wrap.scrollWidth, behavior: REDUCED ? 'auto' : 'smooth' }))
  phHolds = head('hp', [tip(h('span', 't', 'what each node holds'), 'node'), xcue])
  linesRow = h('tr', 'jl'); { const th = tip(h('th', 'rk', 'journal lines'), 'jrnl'); linesRow.append(th); for (const n of V.nodes) { const td = h('td'); td.append(h('span', 'lc'), h('span', 'rp')); linesRow.append(td) } }
  moreRow = spanRow('more', N)
  holds.append(phHolds, linesRow)
  phWrites = head('wp', [tip(h('span', 't', 'where each write went'), 'g:writes'), tip(h('span', 'r', 'ms after the stamp · simulated'), 'kind:sim')])
  wMoreRow = spanRow('more wmore', N)
  writesEl.append(phWrites)
  queueX()
}
function renderHeads(V) {
  for (const n of V.nodes) {
    const th = heads.get(n.uuid)
    // how the node is absent: down (a crash) or left (a clean stop) — from the life that ended, else the page
    const end = n.why === 'down' || n.why === 'left' ? n.why : n.gone ? (n.how ?? (ctx.left.has(n.uuid) ? 'left' : 'down')) : null
    let sub = ''
    if (end === 'down') sub = '<span class="sub down">down ✕</span>'
    else if (end === 'left') sub = '<span class="sub">left</span>'
    else if (ctx.cut.has(n.uuid)) sub = `<span class="sub down" data-tip="p:cut" data-tip-fact="every link between ${esc(n.uuid)} and the other nodes is cut, so no record reaches it and it keeps its own copy">cut off</span>`
    else if (n.why === 'none') sub = '<span class="sub">not started</span>'
    else if (n.inc > 1 || n.earlier) sub = `<span class="sub">life ${n.inc}</span>`
    html(th, nidHTML(n.uuid) + sub)
    th.classList.toggle('is-gone', !!end)
    tip(th, 'node', `${roleOf(n.uuid)} ${n.uuid}${n.inc ? ` · life ${n.inc}` : ''}`)
  }
}
function renderHolds(V, R, quiet) {
  const scrub = V.T !== null
  const want = new Set(V.table.map((r) => r.row))
  for (const [row, r] of hrows) if (!want.has(row)) { r.tr.remove(); hrows.delete(row) }
  let at = phHolds
  for (const t of V.table) {
    let r = hrows.get(t.row)
    if (!r) {
      const tr = h('tr', 'hr'), th = h('th', 'rk'), tds = new Map()
      tr.append(th); for (const n of V.nodes) { const td = h('td', 'v'); tr.append(td); tds.set(n.uuid, td) }
      r = { tr, th, tds }; hrows.set(t.row, r)
    }
    if (at.nextSibling !== r.tr) holds.insertBefore(r.tr, at.nextSibling)
    at = r.tr
    html(r.th, esc(t.row), null); tip(r.th, 'partition', t.top ? `newest stamp: ${stampText(t.top)}` : '')
    t.cells.forEach((c, i) => {
      const n = V.nodes[i], td = r.tds.get(n.uuid); if (!td) return
      let s, key = null, fact = ''
      if (!c.has && c.why) { s = '<span class="none">·</span>'; key = null }
      else if (!c.has) { s = '<span class="none">∅</span>'; key = c.behind ? 'absent-cell' : null }
      else {
        s = inspect(c.v)
        key = c.behind ? (scrub ? 'cell:differs@t' : 'cell:differs') : 'stamp'
        const vt2 = inspectText(c.v)
        fact = [vt2.length > 13 ? vt2 : '', c.stamp ? stampText(c.stamp) : ''].filter(Boolean).join(' · ')
      }
      const changed = td.__h !== undefined && td.__h !== s
      html(td, s)
      td.classList.toggle('behind', !!c.behind)
      td.classList.toggle('gone', !!n.gone)
      if (n.gone && c.has) { key = 'stamp'; fact = (c.stamp ? stampText(c.stamp) + ' · ' : '') + (n.how === 'left' ? 'its last state, from before it left' : 'its last state, from before it went down') }
      tip(td, key, fact)
      if (changed && !scrub && !quiet) flash(td)
    })
  }
  // more rows than shown (no eli5 entry names hidden rows, so no note), then the journal lines + each verdict
  if (V.more > 0) { attest(moreRow.firstChild.firstChild, `+${fmt(V.more)} more row${V.more > 1 ? 's' : ''} held`); if (at.nextSibling !== moreRow) holds.insertBefore(moreRow, at.nextSibling); at = moreRow }
  else moreRow.remove()
  if (at.nextSibling !== linesRow) holds.insertBefore(linesRow, at.nextSibling)
  html(linesRow.firstChild, scrub ? '<span class="lg">journal </span>lines by then' : 'journal lines', null)
  tip(linesRow.firstChild, scrub ? 'jrnl@t' : 'jrnl')
  V.nodes.forEach((n, i) => {
    const td = linesRow.children[i + 1]; if (!td) return
    const [lc, rp] = td.children
    const rv = R.find((x) => x.uuid === n.uuid)
    if (scrub) { html(lc, n.line === null ? '<span class="none">·</span>' : `<b>${fmt(n.line + 1)}</b> <span class="of">of ${fmt(n.lineMax + 1)}</span>`); tip(lc, n.line === null ? null : 'jrnl@t') }
    else { html(lc, `<b>${fmt(n.kept)}</b>${n.dropped ? ` <span class="warnt">+${fmt(n.dropped)} dropped</span>` : ''}`); tip(lc, n.dropped ? 'node:truncated' : 'jrnl') }
    // (a node whose ring dropped lines says so in amber beside its count, so it needs no second word here)
    const [word, cls, key] = !rv || (scrub && n.line === null) || rv.dropped > 0 ? ['', '', null] : rv.ok ? ['✓', 'ok', 'replay-ok'] : ['✗', 'bad', 'replay-bad']
    put(rp, word); rp.className = 'rp ' + cls; tip(rp, key, rv && !rv.ok ? rv.reason : '')
    td.classList.toggle('gone', !!n.gone)
  })
}
const STATUS_TIP = { origin: 'stop:origin', applied: 'stop:applied', 'lww-lost': 'stop:lww-lost', duplicate: 'stop:duplicate', 'never-arrived': 'stop:inflight', 'not-yet': 'stop:not-yet' }
// a status cell is two short lines: the status, then a time or the reason it has none (so no line runs into
// the next column). Returns [line 1, class, line 2, line-2 class, eli5 key]
function statusOf(c) {
  if (c.status === 'never-arrived') {
    if (ctx.down.has(c.uuid)) return ['not yet', 'never-arrived', 'down ✕', 'down', 'stop:inflight'] // it may catch up after a restart
    if (ctx.left.has(c.uuid)) return ['never', 'left', 'left', '', null]                           // gone for good: no eli5 entry says so
    if (ctx.cut.has(c.uuid)) return ['not yet', 'never-arrived', 'cut off', 'down', 'p:cut']         // nothing reaches it until a link is back
    return ['not yet', 'never-arrived', '', '', 'stop:inflight']
  }
  if (c.status === 'dropped') return ['not known', 'dropped', 'lines dropped', 'warn', 'node:truncated'] // its line there went with the ring
  if (c.status === 'not-yet') return ctx.cut.has(c.uuid) ? ['not yet', 'not-yet', 'cut off', 'down', 'p:cut'] : ['not yet', 'not-yet', '', '', 'stop:not-yet']
  if (c.status === 'down') return ['down ✕', 'down', '', '', null]
  if (c.status === 'left') return ['left', 'left', '', '', null]
  if (c.status === 'none') return ['·', 'none', '', '', null]
  return [c.status, c.status, '', '', STATUS_TIP[c.status] ?? null]
}
let swMax = 0 // the widest stamp (in characters) this run has shown in the write rows
function placeMore(at, more, pinned) {
  if (more <= 0) { wMoreRow.remove(); return at }
  attest(wMoreRow.firstChild.firstChild, `+${fmt(more)} more write${more > 1 ? 's' : ''}${ctx.trunc ? ' in the lines kept' : ''}${pinned ? ' · the newest one a node set aside:' : ''}`)
  if (at.nextSibling !== wMoreRow) writesEl.insertBefore(wMoreRow, at.nextSibling)
  return wMoreRow
}
function renderWrites(V, quiet) {
  const scrub = V.T !== null
  const want = new Set(V.writes.map((w) => w.id))
  for (const [id, r] of wrows) if (!want.has(id)) { r.tr.remove(); wrows.delete(id) }
  // the stamp column fits the widest stamp shown so far (a monospace character count, sized in CSS ch), so
  // a stamp is never cut; past the card's width the table scrolls sideways with its labels pinned
  for (const w of V.writes) swMax = Math.max(swMax, (w.stamp ? stampText(w.stamp) : `#${w.seq} · ${w.origin}`).length)
  if (table.__sw !== swMax) { table.style.setProperty('--sw', String(swMax)); table.__sw = swMax }
  let at = phWrites
  const fresh = [], more = V.total - V.writes.length
  V.writes.forEach((w, i) => {
    if (V.pinned && i === V.writes.length - 1) at = placeMore(at, more, true) // "+N more writes", then the pinned one
    let r = wrows.get(w.id)
    if (!r) {
      const tr = h('tr', 'wr'), th = h('th', 'ic-w'), tds = new Map()
      tr.append(th)
      for (const n of V.nodes) { const td = h('td'), st = h('span', 'ic-st'), dt = h('span', 'ic-dt'); td.append(st, dt); tr.append(td); tds.set(n.uuid, { td, st, dt }) }
      r = { tr, th, tds }; wrows.set(w.id, r)
      if (lastWrites && !quiet) fresh.push(tr)
    }
    if (at.nextSibling !== r.tr) writesEl.insertBefore(r.tr, at.nextSibling)
    at = r.tr
    // the write: its stamp (view · counter · origin), then the debugger's own key = value
    const name = w.stamp ? stamp(w.stamp) : `<span class="stamp">#${esc(w.seq)} · <span class="o">${esc(w.origin)}</span></span>`
    const kv = !w.rec ? '<span class="x" data-tip="not-captured">record not captured</span>'
      : w.rec.type === 2 ? `<span data-tip="rec:remove">remove</span> <span class="kk" data-tip="rec-key">${esc(w.key)}</span>`
      : `<span class="kk" data-tip="rec-key">${esc(w.key)}</span> = <span data-tip="rec-value">${inspect(w.rec.value)}</span>`
    const noOrigin = !w.cells.some((c) => c.status === 'origin') && w.cells.some((c) => c.status === 'applied')
    const fact = (w.rec ? recText(w.rec) : '') + (noOrigin ? ` · stamped by ${w.origin} in an earlier life; that life's journal is not in the capture, so no node shows its origin line` : '')
    html(r.th, `<span class="nm" data-tip="change-record" data-tip-fact="${esc(fact)}">${name}</span><span class="kv">${kv}</span>`)
    for (const c of w.cells) {
      const cell = r.tds.get(c.uuid); if (!cell) continue
      const [text, cls, sub, subCls, key] = statusOf(c)
      const was = cell.st.__s
      put(cell.st, text); cell.st.__s = text
      cell.st.className = 'ic-st ' + cls
      const cutNote = !ctx.cut.has(c.uuid) ? '' : scrub ? ` · every link to ${c.uuid} was cut, so nothing could reach it` : ` · every link to ${c.uuid} is cut, so nothing reaches it until a link is back`
      tip(cell.td, key, !key ? '' : c.status === 'never-arrived' ? `routes() says never-arrived: ${c.uuid} has no record of this write yet${cutNote}` : c.status === 'not-yet' && cutNote ? `at this moment ${c.uuid} had not seen this write${cutNote}` : c.status === 'dropped' ? `routes() says never-arrived, but ${c.uuid}'s journal dropped its lines from that time, so whether this write reached it is not known` : '')
      cell.td.classList.toggle('gone', !!c.gone && c.status !== 'down' && c.status !== 'left')
      if (sub) { put(cell.dt, sub); cell.dt.className = 'ic-dt ' + subCls; cell.dt.removeAttribute('data-attested') }
      else if (c.dt !== null && c.status !== 'origin') { attest(cell.dt, `+${fmt(Math.round(c.dt))} ms`, 'runtime'); cell.dt.className = 'ic-dt' }
      else { cell.dt.textContent = ''; cell.dt.className = 'ic-dt'; cell.dt.removeAttribute('data-attested') }
      if (was !== undefined && was !== text && !scrub && !quiet) flash(cell.st)
    }
  })
  if (!V.pinned) at = placeMore(at, more, false)
  if (!REDUCED) for (const tr of fresh) { tr.classList.add('is-new'); setTimeout(() => tr.classList.remove('is-new'), 400) }
  lastWrites = true
  let empty = writesEl.querySelector('tr.empty')
  if (!V.writes.length) {
    if (!empty) { empty = spanRow('empty', V.nodes.length + 1); writesEl.append(empty) }
    put(empty.firstChild.firstChild, scrub ? 'no write yet at this moment' : 'no write yet')
  } else empty?.remove()
}
let lastWrites = false

// ── cells where a node set a write aside (model contested(), with the set-asides from routes()) ──────
const contEl = $('inside-cont'), contN = $('inside-cont-n')
function renderContested(V) {
  const scrub = V.T !== null, C = V.contested, endNote = scrub ? 'at the end of the read' : ''
  if (!C.length) {
    put(contN, endNote); contN.removeAttribute('data-attested')
    // contested() reads lwwSkip lines from the journals; a ring that dropped lines may have dropped them too
    if (ctx.trunc) html(contEl, '<span class="warnt" data-tip="node:truncated">none in the lines still kept</span><span class="why">: a write set aside earlier would have gone with the dropped lines. A rebuild from the seed keeps every line.</span>', null)
    else if (V.lost > 0) html(contEl, '<span class="none" data-tip="stop:lww-lost">none listed</span><span class="why">: a node did set a write aside, but no node still keeps that record, so its cell cannot be named.</span>', null)
    else html(contEl, '<span class="none" data-tip="m:contested">none</span><span class="why">: no node has had to set a write aside. Once a view exists, each row has one owner, and the owner stamps its writes in turn.</span>', null)
    return
  }
  attest(contN, `${C.length} cell${C.length > 1 ? 's' : ''}${ctx.trunc ? ' in the lines kept' : ''}${endNote ? ' · ' + endNote : ''}`)
  html(contEl, C.slice(0, 2).map((c) => {
    const lost = c.candidates.filter((x) => x.lostAt.length)
    const won = c.winner.ty === 2 ? '<span class="v">removed</span>' : `<span class="v">${inspect(c.winner.v)}</span>`
    return `<div class="ic-c"><span class="cell" data-tip="cell">${esc(prettyCell(c.cell))}</span>` +
      `<span class="it"><span class="w won" data-tip="won">won</span>${stamp(c.winner)}${won}</span>` +
      lost.slice(0, 2).map((x) => `<span class="it"><span class="w" data-tip="stop:lww-lost">set aside</span>${stamp(x)}<span class="at">at ${x.lostAt.map(nidHTML).join(', ')}</span></span>`).join('') +
      (lost.length > 2 ? `<span class="why">+${lost.length - 2} more set aside</span>` : '') + '</div>'
  }).join('') + (C.length > 2 ? `<div class="why">+${C.length - 2} more cells</div>` : '') +
    '<div class="why ic-cwhy">A node keeps the bigger stamp it already holds. That happens when two writers race, and when an older record reaches a node late, as it can while a node catches up.</div>')
}

// ── the time bar ─────────────────────────────────────────────────────────────────────────────────────
const range = $('inside-t'), tread = $('inside-tread'), nowBtn = $('inside-now'), marksEl = $('inside-marks'), legend = $('inside-legend')
const live = $('inside-live'), liveT = $('inside-live-t')
function renderBar(S) {
  const lo = S.tmin, hi = S.at, off = S.dropped > 0
  range.disabled = off || hi - lo < 1
  range.min = String(lo); range.max = String(hi); range.step = '1'
  range.value = String(scrubT ?? hi)
  // the run's marks on the same simulated axis: each write's first sighting, each crash, restart, clean stop, join
  const M = S.marks, x = (t) => (hi > lo ? ((t - lo) / (hi - lo)) * 1000 : 1000).toFixed(1), T = scrubT ?? hi
  // one path per kind (a long run holds hundreds of writes), updated in place
  if (!marksEl.__p) {
    marksEl.setAttribute('viewBox', '0 0 1000 24')
    marksEl.innerHTML = ['base', 'fill', 'w', 'j', 'l', 'd', 'u'].map((c) => `<path class="${c}" vector-effect="non-scaling-stroke"/>`).join('')
    marksEl.__p = Object.fromEntries([...marksEl.children].map((p) => [p.getAttribute('class'), p]))
  }
  const P = marksEl.__p, ticks = (ts, y1, y2) => ts.map((t) => `M${x(t)} ${y1}V${y2}`).join('')
  P.base.setAttribute('d', 'M0 12H1000'); P.fill.setAttribute('d', `M0 12H${x(T)}`)
  P.w.setAttribute('d', ticks(M.writes, 1, 7)); P.l.setAttribute('d', ticks(M.lefts ?? [], 2, 22))
  P.w.style.opacity = String(Math.max(0.15, Math.min(0.55, 40 / Math.max(1, M.writes.length)))) // crowded ticks fade, so a long run stays a hairline band
  P.d.setAttribute('d', ticks(M.downs, 2, 22)); P.u.setAttribute('d', ticks(M.ups, 2, 22)); P.j.setAttribute('d', ticks(M.joins ?? [], 5, 19))
  legend.querySelector('.ld').hidden = !M.downs.length; legend.querySelector('.lu').hidden = !M.ups.length
  legend.querySelector('.ll').hidden = !(M.lefts ?? []).length; legend.querySelector('.lj').hidden = !(M.joins ?? []).length
  if (off) {
    html(tread, '<span class="warnt">time bar off: a journal dropped lines, so a rewind would have to make up its start</span>', null)
    tip(tread, 'time-travel-off'); nowBtn.hidden = true
  } else if (scrubT === null) {
    html(tread, `read at ${vt(hi)} on the simulated clock`); tip(tread, 'kind:sim'); nowBtn.hidden = true
  } else {
    html(tread, `rewound to ${vt(scrubT)} · ${vt(hi - scrubT)} before the last read · simulated`); tip(tread, 'kind:sim'); nowBtn.hidden = false
  }
  legend.hidden = !nowBtn.hidden || off
}
function setLive(kind) {
  if (kind === 'live') { live.className = 'ic-live'; put(liveT, 'live'); tip(liveT, 'not-quiesced'); liveT.removeAttribute('data-attested') }
  else if (kind === 'rewound') { live.className = 'ic-live is-paused'; put(liveT, 'rewound'); tip(liveT, 'live-paused'); liveT.removeAttribute('data-attested') }
  else if (kind === 'own') { live.className = 'ic-live is-own'; attest(liveT, `own run · seed ${own.seed}`); tip(liveT, 'kind:sim') }
}

// ── the foot ─────────────────────────────────────────────────────────────────────────────────────────
const footL = $('inside-foot-l'), footR = $('inside-foot-r')
const fNodes = tip(h('span'), 'node'), fRows = tip(h('span'), 'journal-rows'), fDrop = tip(h('span'), 'jrnl')
footL.append(fNodes, ' · ', fRows, ' · ', fDrop)
function renderFoot(S) {
  attest(fNodes, `${fmt(S.nodes)} nodes`); attest(fRows, `${fmt(S.rows)} journal lines`); attest(fDrop, `${fmt(S.dropped)} dropped`)
  fDrop.classList.toggle('warnt', S.dropped > 0); tip(fDrop, S.dropped ? 'node:truncated' : 'jrnl')
  attest(footR, `read in ${S.ms < 0.1 ? '<0.1' : fmt(Math.round(S.ms * 10) / 10, 1)} ms · this machine`, 'measured')
}

// ── one paint from a view model ──────────────────────────────────────────────────────────────────────
const body = $('inside-body'), bar = $('inside-bar')
function paint(S, V) {
  // a flash says "a record just landed": not after a rewind, a reset, an own run, or a long gap off-screen
  const quiet = quietNext || (V.T === null && performance.now() - lastLive > QUIET_AFTER)
  quietNext = false
  const T = V.T ?? S.at
  ctx = { down: new Set(S.down), left: new Set(S.left), servers: new Set(S.servers), cut: new Set(V.nodes.filter((n) => cutAt(S.cuts, n.uuid, T)).map((n) => n.uuid)), trunc: S.dropped > 0 }
  const ok = renderGate(S.replay)
  body.hidden = !ok; bar.hidden = !ok
  renderFoot(S)
  if (!ok) return
  if (V.nodes.map((n) => n.uuid).join('|') !== cols) build(V)
  renderHeads(V)
  renderHolds(V, S.replay, quiet)
  renderWrites(V, quiet)
  renderContested(V)
  renderBar(S)
  if (V.T === null) lastLive = performance.now()
}
function liveSource(F) {
  return {
    at: F.at, tmin: F.tmin, rows: F.rows, dropped: F.dropped, ms: F.ms, nodes: F.cap.nodes.length, marks: marks(F),
    replay: F.replay.map((r) => ({ ...r, dropped: F.cap.nodes.find((n) => n.uuid === r.uuid)?.dropped ?? 0 })),
    down: [...page.down], left: [...page.left], servers: [...page.serverIds], cuts,
  }
}
// a fold, start to paint, outside the page's frame task: one idle task when folds are cheap, one idle task
// per stage (capture · replay · routes · contested · paint) when they are not, so no task carries it all
const idle = typeof requestIdleCallback === 'function' ? (fn) => requestIdleCallback(fn, { timeout: 200 }) : (fn) => setTimeout(fn, 0)
let job = null // { F, i } — the fold in progress
// the view of a finished fold (its own idle task when folds are dear), then the paint (another one)
function prepare(F2) { return { F: F2, S: liveSource(F2), V: viewAt(F2, clock, null, { rows: ROWS }) } }
function commit(P) {
  if (own || scrubT !== null) return // a rewind or an own run took the card meanwhile: drop this fold
  F = P.F; src = P.S
  paint(src, P.V)
  setLive('live')
  syncActions()
}
function refold() { // now, in one go (first paint, back to now, back to live) — always a quiet paint
  if (own) return
  job = null; scrubT = null; quietNext = true
  commit(prepare(fold(page.sim, clock)))
}
function startFold() {
  if (job) return
  job = { F: null, i: -1 }
  idle(next)
}
function next() {
  if (!job) return
  if (own || scrubT !== null) { job = null; return }
  const a = performance.now()
  // split when the last fold was dear, or when the journals grew a lot since (the card was off-screen)
  let rows = 0; for (const n of page.sim.nodes.values()) rows += Math.min(n.journal.n, 1 << 16)
  const split = (F && F.ms > SPLIT_MS) || rows > SPLIT_ROWS
  let k
  do {
    k = job.i
    if (job.i < 0) job.F = capture(page.sim, clock)
    else if (job.i < STAGES.length) STAGES[job.i](job.F)
    else if (job.i === STAGES.length) job.P = prepare(job.F)
    else { const P = job.P; job = null; commit(P) }
    if (job) job.i++
  } while (job && !split)
  note(performance.now() - a, split ? k : 'all')
  if (job) idle(next)
}

// ── scrubbing ────────────────────────────────────────────────────────────────────────────────────────
let wantT = null, raf = 0
function scrubTo(T) {
  if (!src || range.disabled) return
  scrubT = T >= src.at - 0.5 ? null : Math.max(src.tmin, T)
  wantT = scrubT
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    if (own) { if (wantT === null) quietNext = true; own.ask(wantT); return }
    if (wantT === null) { refold(); return }
    paint(src, viewAt(F, clock, wantT, { rows: ROWS }))
    setLive('rewound')
  })
}
range.addEventListener('input', () => scrubTo(+range.value))
range.addEventListener('keydown', (e) => {
  if (!src || range.disabled) return
  const cur = scrubT ?? src.at, step = e.shiftKey ? 1000 : 100
  const T = { ArrowLeft: cur - step, ArrowDown: cur - step, ArrowRight: cur + step, ArrowUp: cur + step, PageDown: cur - 1000, PageUp: cur + 1000, Home: src.tmin, End: src.at }[e.key]
  if (T === undefined) return
  e.preventDefault(); scrubTo(T)
})
nowBtn.addEventListener('click', () => { scrubT = null; quietNext = true; if (own) own.ask(null); else refold() })

// past the card's width the table scrolls sideways: the pinned label column casts a shadow once it is scrolled,
// and the holds head names the node columns still out of view on the right ("n03 c1 →", a tap scrolls to them).
// The columns are read when the table or its box changes size (a ResizeObserver reports after layout, so the read
// costs no extra layout) and on scroll; the cue is written a frame later, so a write never resizes what is observed
// inside its own callback.
let xq = 0, xRead = null
function readX() {
  const sl = wrap.scrollLeft, edge = sl + wrap.clientWidth
  return { sl, out: wrap.scrollWidth - wrap.clientWidth > 1 ? [...heads].filter(([, th]) => th.offsetLeft + th.offsetWidth > edge + 0.5).map(([id]) => id) : [] }
}
function syncX() {
  xq = 0
  const { sl, out } = xRead ?? readX(); xRead = null
  wrap.classList.toggle('is-x', sl > 0)
  if (!xcue) return
  if (out.length) {
    attest(xcue, `${out.join(' ')} →`, 'runtime')
    const label = `scroll the table to show ${out.length > 1 ? out.slice(0, -1).join(', ') + ' and ' + out[out.length - 1] : out[0]}`
    if (xcue.getAttribute('aria-label') !== label) xcue.setAttribute('aria-label', label)
  } else { put(xcue, ''); xcue.removeAttribute('data-attested') }
  xcue.hidden = !out.length
}
function queueX() { xRead = null; if (!xq) xq = requestAnimationFrame(syncX) }
wrap.addEventListener('scroll', queueX, { passive: true })
if ('ResizeObserver' in window) { const ro = new ResizeObserver(() => { const r = readX(); queueX(); xRead = r }); ro.observe(wrap); ro.observe(table) }

// ── the refold loop: in view, tab visible, not rewound, throttled ────────────────────────────────────
page.watch(card)
if ('IntersectionObserver' in window) {
  new IntersectionObserver((es) => { const was = inView; inView = es.some((e) => e.isIntersecting); if (inView && !was) touch(true) }, { rootMargin: '120px' }).observe(card)
} else inView = true
const perf = { tasks: 0, max: 0, over16: 0, by: {} } // this section's own fold tasks (window.__inside.perf)
const note = (d, k) => { perf.tasks++; if (d > perf.max) perf.max = d; if (d > 16) perf.over16++; perf.by[k] = Math.max(perf.by[k] ?? 0, Math.round(d * 10) / 10) }
onFrame((now) => {
  if (job || !inView || document.hidden || scrubT !== null || own) return
  const gap = Math.max(MIN_GAP, (F ? F.ms : 1) * 60)
  if ((dirty && (urgent || now - lastFold >= gap)) || now - lastFold >= Math.max(IDLE_GAP, gap)) {
    dirty = false; urgent = false; lastFold = now
    startFold()
  }
})

// ── a journal ring that dropped lines: say so, and offer the rebuild from the seed (an own run) ──────
const actions = $('inside-actions'), rebuildBtn = $('inside-rebuild'), rstatus = $('inside-rstatus')
function showRebuildIdle() { rebuildBtn.disabled = false; rebuildBtn.textContent = 'rebuild from the seed ▸'; html(rstatus, 'an own run: the same seed and every action, replayed in the background in this tab, with every journal line kept', null) }
function syncActions() {
  const truncated = !!(src && src.dropped > 0)
  actions.hidden = !truncated && !own
  if (truncated && !own && !rebuildBtn.disabled && rebuildBtn.textContent !== 'rebuild from the seed ▸') showRebuildIdle()
}
showRebuildIdle()
rebuildBtn.addEventListener('click', () => rebuild())
function rebuild() {
  if (own) { own.stop(); own = null; scrubT = null; showRebuildIdle(); touch(true); refold(); return }
  if (rebuildBtn.disabled) return
  rebuildBtn.disabled = true
  const at = page.now, want = { now: at, traceHash: page.traceHash, traceCount: page.traceCount, events: page.events }
  const w = (building = new Worker(new URL('./inside/worker.js', import.meta.url), { type: 'module' }))
  const t0 = performance.now()
  html(rstatus, 'rebuilding from the seed…', null)
  w.onmessage = (m) => {
    const d = m.data
    if (d.type === 'progress') { html(rstatus, `rebuilding · ${vt(d.at)} of ${vt(at)} on the simulated clock`); return }
    if (d.type === 'error') { html(rstatus, `the rebuild failed: ${esc(d.message)}`, null); rebuildBtn.disabled = false; w.terminate(); building = null; return }
    if (d.type === 'ready') {
      building = null
      own = { seed: page.seed, at, same: d.same, ask: (T) => w.postMessage({ type: 'view', T, rows: ROWS }), stop: () => w.terminate() }
      rebuildBtn.disabled = false
      rebuildBtn.textContent = 'back to the live cluster ▸'
      html(rstatus, `${d.same ? 'the same run as the cluster above: every event matches ✓' : 'it diverged from the cluster above, which is a page bug'} · rebuilt in ${fmt(Math.round(performance.now() - t0))} ms, this machine`, 'measured')
      scrubT = null; quietNext = true
      own.ask(null)
      return
    }
    if (d.type === 'view' && own) { src = d.src; scrubT = d.V.T; paint(src, d.V); setLive('own') }
  }
  w.onerror = (e) => { html(rstatus, `the rebuild failed: ${esc(e.message || 'worker error')}`, null); rebuildBtn.disabled = false }
  w.postMessage({ type: 'build', opts: { ...page.opts, seed: page.seed, paced: false }, actions: page.actions, want })
}

// ── the rungs that walk through the debugger (build: data/manifest.json's example folders) ───────────
const rungs = $('inside-rungs')
const noRungs = () => { const p = rungs.parentNode; rungs.remove(); p.lastChild.textContent = p.lastChild.textContent.replace(/^\s*of the examples walk through it\./, ''); p.lastChild.previousSibling.textContent = p.lastChild.previousSibling.textContent.replace(/Rungs\s*$/, 'The examples\' debugger rungs walk through it.') }
fetch(new URL('../data/manifest.json', import.meta.url)).then((r) => r.json()).then((m) => {
  const ns = (m.examples ?? []).map((e) => +e.slice(0, 2)).filter((n) => n >= 20 && n < 30).sort((a, b) => a - b)
  if (ns.length) attest(rungs, `${ns[0]} to ${ns[ns.length - 1]}`, 'build'); else noRungs()
}).catch(noRungs)

// mirror the masthead's mark (the options bar can change it)
const mark = document.querySelector('.masthead .mark b'), myMark = section.querySelector('.ic-brand b')
const syncMark = () => { if (mark && myMark) { myMark.textContent = mark.textContent; myMark.hidden = mark.hidden } }
syncMark(); if (mark) new MutationObserver(syncMark).observe(mark, { childList: true, characterData: true, subtree: true, attributes: true })

// first paint now (the cluster may not have moved yet); the loop takes over from here
refold()

window.__inside = { perf, clock, get F() { return F }, get src() { return src }, get scrubT() { return scrubT }, refold, scrubTo, viewAt: (T) => viewAt(F, clock, T, { rows: ROWS }), rebuild, get own() { return own } }
