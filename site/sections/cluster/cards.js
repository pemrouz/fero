// sections/cluster/cards.js — variant a: four node screens under a band of links. Frames ride the links for their
// real simulated flight time (sent at the sender's sink, arriving at the receiver's step): the write's frames in
// the accent, ballots in ink with their verb, HELLO faint; PING, PONG and DIGEST are counted, not drawn, unless
// asked. Each card is one node's own state, read from the kernel every frame: its rows and their stamps, the
// rows it owns (★, by its own view), its write gate, its waiting writes, its disk, its view and fingerprint.
import { page, REDUCED } from '../../cluster.js'
import { nid, stamp as stampHTML, rec, inspect, vt, esc } from '../../ui.js'
import { M, ownerOf, waiting, landed, live, lastRecords, majorityHash, onWire, pruneFrames, base, diskOf, noServerWhy } from './model.js'
import { A, num } from './say.js'

const root = document.getElementById('cl-a')
const stage = root.querySelector('#cl-stage-a'), band = root.querySelector('#cl-band-a'), cardsEl = root.querySelector('#cl-cards-a')
const hiddenEl = root.querySelector('#cl-hidden-a'), tapeEl = root.querySelector('#cl-tape-list-a'), bandK = root.querySelector('#cl-band-k-a')
const SVG = 'http://www.w3.org/2000/svg'
const ROWS = ['widgets', 'gadgets', 'gizmos'], BIG = 'gadgets'
const H = 96
let showHidden = false

// ── small DOM helpers: write only on change ──
const setH = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html } }
const setT = (el, s) => { if (el.textContent !== s) el.textContent = s }
const setC = (el, c, on) => { if (el.classList.contains(c) !== on) el.classList.toggle(c, on) }
const att = (s) => A(esc(s))
const setHid = (el, v) => { if (el && el.hidden !== v) el.hidden = v }
// fit(html, longer): show html, but keep the box as big as the longer text would make it, so a part of a card never
// changes height as a routine write passes through (the cards, the tape and everything under them stay still, and
// the browser's scroll anchoring has nothing to correct). The fonts are mono, so the longer text is a template: the
// same characters with every digit written as x — it is never seen (visibility: hidden) and says nothing.
const tmpl = (s) => s.replace(/\d/g, 'x')
// several longer texts may be given: the box is as big as the largest of them (they all stack in one grid cell)
const fitH = (html, ...longerHTML) => `<span class="cl-fit"><span class="cl-fit-v">${html}</span>${longerHTML.map((l) => `<span class="cl-fit-r" aria-hidden="true">${tmpl(l)}</span>`).join('')}</span>`
const fit = (html, longer) => fitH(html, esc(longer))

// ── the band legend: the real verb names, drawn the way the frames are drawn ──
bandK.innerHTML = '<span class="cl-band-t">on the wire</span>' +
  '<span class="cl-lg"><i class="lg k-write">WRITE</i><i class="lg k-repl">RECORDS</i><i class="lg k-vote">VOTE</i><i class="lg k-link"></i>HELLO</span>' +
  '<span class="cl-band-n">flight times are simulated</span>'
hiddenEl.addEventListener('click', (e) => { if (e.target.closest('[data-toggle]')) { showHidden = !showHidden; M.keepHidden = showHidden; paintHidden(true) } })

// what a server's disk holds, in facts.md §6's words (the disk line counts records and names the saved view)
const DISK_TITLE = "on disk: the write-ahead log (WAL), this server's records in the same bytes as the wire, and the boot record, the small file a restart trusts: the view, the vote already spent, the clock's ceiling and the life count"
// ── structure: one card per node (servers, then clients); rebuilt when the node set changes ──
let ids = [], gen = -1, cards = new Map(), arcs = new Map(), pairs = [], pos = new Map(), pool = []
const arcLayer = document.createElementNS(SVG, 'g'), frameLayer = document.createElementNS(SVG, 'g')
arcLayer.setAttribute('class', 'arcs'); frameLayer.setAttribute('class', 'frames')
band.append(arcLayer, frameLayer)

function cardHTML(id) {
  const role = page.role(id), srv = role === 'server'
  const row = (r) => `<div class="cl-r" data-row="${r}"><span class="cl-r-k"><span class="cl-row">${r}</span><span class="cl-star" data-k="star-${r}" hidden title="this server owns ${r} in its view: it stamps every write to it">★</span></span><span class="cl-r-v" data-k="v-${r}" data-attested="runtime">—</span><span class="cl-r-st" data-k="st-${r}"></span></div>`
  return `<div class="cl-card-head">
      <span class="cl-role">${role}</span><span class="cl-name" data-attested="runtime">${nid(id)}</span>
      <span class="cl-pill" data-k="pill">up</span>
      <span class="cl-life" data-k="life"></span>
    </div>
    <div class="cl-body">
      <div class="cl-vals" data-k="vals">
        <div class="cl-big-k"><span class="cl-row">${BIG}</span>.stock<span class="cl-star" data-k="star-${BIG}" hidden title="this server owns ${BIG} in its view: it stamps every write to it">★</span></div>
        <div class="cl-big" data-k="big" data-attested="runtime">—</div>
        <div class="cl-big-st" data-k="st-${BIG}"></div>
        <div class="cl-rows">${ROWS.filter((r) => r !== BIG).map(row).join('')}</div>
        <div class="cl-more" data-k="more" hidden></div>
      </div>
      <div class="cl-gone" data-k="gone" hidden></div>
      <div class="cl-wait" data-k="wait"></div>
      ${srv ? `<div class="cl-disk" data-k="disk" title="${DISK_TITLE}"></div>` : '<div class="cl-disk cl-nodisk" data-k="nodisk">no disk: its copy is in memory</div>'}
      <div class="cl-links" data-k="links"></div>
    </div>
    <div class="cl-card-foot"><span class="cl-view" data-k="view"></span><span class="cl-fp" data-k="fp"></span></div>`
}
function build() {
  ids = page.ids(); gen = M.gen
  cardsEl.style.setProperty('--n', ids.length)
  const keep = new Map()
  cardsEl.textContent = ''
  for (const id of ids) {
    const el = document.createElement('article')
    el.className = 'cl-card'; el.dataset.node = id; el.dataset.role = page.role(id)
    el.innerHTML = cardHTML(id)
    const k = {}; for (const x of el.querySelectorAll('[data-k]')) k[x.dataset.k] = x
    keep.set(id, { el, k, seen: {}, fresh: {}, flip: {} })
    cardsEl.append(el)
  }
  cards = keep
  pairs = []
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]])
  arcLayer.textContent = ''; arcs = new Map()
  for (const [a, b] of pairs) {
    const p = document.createElementNS(SVG, 'path'); p.setAttribute('class', 'arc')
    arcLayer.append(p); arcs.set(`${a}|${b}`, { el: p, a, b, cls: '' })
  }
  layout()
}
const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
function layout() {
  const sw = Math.max(1, stage.clientWidth)
  band.setAttribute('viewBox', `0 0 ${sw} ${H}`)
  pos = new Map()
  for (const [id, c] of cards) pos.set(id, { x: c.el.offsetLeft + c.el.offsetWidth / 2, w: c.el.offsetWidth, i: ids.indexOf(id) })
  // narrow cards (five or more nodes in a row, or a mid-width screen): stamps take their own line
  const cw = cards.size ? [...cards.values()][0].el.offsetWidth : 0
  if (cw) cardsEl.classList.toggle('narrow', cw < 218)
  const n = ids.length, step = Math.min(0.14, 0.56 / Math.max(1, n - 1))
  for (const [a, b] of pairs) {
    const A_ = pos.get(a), B_ = pos.get(b); if (!A_ || !B_) continue
    const [L, R] = A_.i < B_.i ? [A_, B_] : [B_, A_]
    const span = R.i - L.i
    // nearest peers take the inner end of each card's top edge, so arcs nest instead of tangling
    const rankR = span - 1, rankL = span - 1
    const x1 = L.x + (0.3 - step * rankR) * L.w, x2 = R.x - (0.3 - step * rankL) * R.w
    const hgt = 14 + (H - 30) * (span - 1) / Math.max(1, n - 2)
    const g = { x1, y1: H, cx: (x1 + x2) / 2, cy: H - 2 * hgt, x2, y2: H, left: L === A_ ? a : b }
    const arc = arcs.get(`${a}|${b}`); arc.g = g
    arc.el.setAttribute('d', `M${x1.toFixed(1)} ${H} Q${g.cx.toFixed(1)} ${g.cy.toFixed(1)} ${x2.toFixed(1)} ${H}`)
  }
}
const at = (g, t) => { const u = 1 - t; return [u * u * g.x1 + 2 * u * t * g.cx + t * t * g.x2, u * u * g.y1 + 2 * u * t * g.cy + t * t * g.y2] }
if ('ResizeObserver' in window) new ResizeObserver(() => { if (cards.size) layout() }).observe(stage)

// ── link states: up (admitted), cut (a user's split), down (an end crashed), forming (alive, not yet admitted) ──
function linkStates() {
  const up = new Set(page.links().map(([a, b]) => pk(a, b)))
  const out = new Map()
  for (const [a, b] of pairs) {
    const k = pk(a, b)
    if (!page.alive(a) || !page.alive(b)) out.set(k, 'down')
    else if (page.cuts.has(k)) out.set(k, 'cut')
    else if (up.has(k)) out.set(k, 'up')
    else out.set(k, 'forming')
  }
  return out
}

// ── frames: pooled <g> elements, one per frame on the wire ──
function frameEl(i) {
  if (pool[i]) return pool[i]
  const g = document.createElementNS(SVG, 'g'), r = document.createElementNS(SVG, 'rect'), t = document.createElementNS(SVG, 'text'), c = document.createElementNS(SVG, 'circle')
  t.setAttribute('text-anchor', 'middle'); t.setAttribute('dy', '3.2'); r.setAttribute('rx', '3'); r.setAttribute('height', '13'); r.setAttribute('y', '-6.5')
  g.append(r, t, c); frameLayer.append(g)
  return (pool[i] = { g, r, t, c, verb: '', cls: '' })
}
// reduced motion: nothing flies. An arc that carries a fresh frame turns solid and holds the frame's verb still at its
// apex for at least HOLD ms of wall time (a frame's real flight is 30–90 ms simulated, too short to read), or until a
// newer fresh frame takes that link
const HOLD = 1200, carried = new Map()   // pair key → { f, until }
// the pills' room inside the band: below the legend row, above the cards' top edge
const YMIN = 23, YMAX = H - 7
function drawFrames(states) {
  const now = page.now
  pruneFrames(now)
  let used = 0
  const items = []
  for (const f of M.frames) {
    if (f.sentAt > now || f.recvAt <= now) continue
    if (f.hidden && !showHidden) continue
    const k = pk(f.from, f.to), st = states.get(k), arc = arcs.get(`${f.from}|${f.to}`) ?? arcs.get(`${f.to}|${f.from}`)
    if (!arc?.g || st === 'down') continue
    if (REDUCED) { if (f.fresh) { const c = carried.get(k); if (!c || (c.f !== f && c.f.sentAt <= f.sentAt)) carried.set(k, { f, until: performance.now() + HOLD }) } continue }
    const p = Math.min(1, Math.max(0, (now - f.sentAt) / Math.max(1e-6, f.recvAt - f.sentAt)))
    const [x, y] = at(arc.g, arc.g.left === f.from ? p : 1 - p)
    const label = f.kind === 'write' || f.kind === 'repl' || f.kind === 'vote'
    items.push({ f, x, y, label, w: label ? 8 + f.verb.length * 5.6 : 6 })
  }
  // labels never sit on each other, on the legend row, or on the cards: two frames at one spot (a RECORDS and its
  // WACK leave together on a FIFO link; two links cross) take the nearest free height inside the band, above
  // first. Fresh frames are placed first; in a burst with no free height left, a frame shows as a dot on its arc.
  items.sort((a, b) => (b.f.fresh - a.f.fresh) || (b.label - a.label))
  const placed = []
  for (const it of items) {
    if (!it.label) continue
    const y0 = Math.max(YMIN, Math.min(YMAX, it.y))
    let best = null
    for (const dy of [0, -15, 15, -30, 30, -45, 45, -60, 60]) {
      const y = y0 + dy
      if (y < YMIN || y > YMAX) continue
      if (!placed.some((q) => Math.abs(q.x - it.x) < (q.w + it.w) / 2 + 2 && Math.abs(q.y - y) < 14)) { best = y; break }
    }
    if (best === null) { it.label = false; it.w = 6; continue }
    it.y = best
    placed.push(it)
  }
  for (const it of items) {
    const f = it.f, e = frameEl(used++)
    const cls = `fr k-${f.kind}${f.fresh ? '' : ' again'}${it.label ? '' : ' dot'}`
    if (e.cls !== cls) { e.cls = cls; e.g.setAttribute('class', cls) }
    if (it.label) {
      if (e.verb !== f.verb) { e.verb = f.verb; e.t.textContent = f.verb; e.r.setAttribute('width', it.w.toFixed(1)); e.r.setAttribute('x', (-it.w / 2).toFixed(1)) }
    } else if (e.verb) { e.verb = ''; e.t.textContent = ''; e.r.setAttribute('width', '0') }
    e.c.setAttribute('r', it.label ? '0' : f.hidden ? '1.6' : '2.6')
    e.g.setAttribute('transform', `translate(${it.x.toFixed(1)} ${it.y.toFixed(1)})`)
    if (e.g.style.display) e.g.style.display = ''
  }
  for (let i = used; i < pool.length; i++) if (pool[i].g.style.display !== 'none') pool[i].g.style.display = 'none'
  // reduced motion: drop the holds that ran out (and those on a link that is no longer up)
  if (REDUCED) { const t = performance.now(); for (const [k, c] of carried) if (c.until < t || states.get(k) === 'down') carried.delete(k) }
  // arcs: state + (reduced motion) the verb a fresh frame is carrying, held still at the arc's apex
  for (const [key, arc] of arcs) {
    const k = pk(arc.a, arc.b), st = states.get(k)
    let cls = `arc ${st}`
    if (page.role(arc.a) === 'client' || page.role(arc.b) === 'client') {
      const c = page.role(arc.a) === 'client' ? arc.a : arc.b, s = c === arc.a ? arc.b : arc.a
      if (st === 'up') cls += page.primary(c) === s ? ' primary' : ' spare'
    }
    const cf = REDUCED ? carried.get(k)?.f : null
    if (cf) cls += ` carry k-${cf.kind}`
    if (arc.cls !== cls) { arc.cls = cls; arc.el.setAttribute('class', cls) }
  }
  if (REDUCED) {
    let i = 0
    for (const [k, { f }] of carried) {
      const arc = arcs.get(k) ?? arcs.get(k.split('|').reverse().join('|')); if (!arc?.g) continue
      const [x, y] = at(arc.g, 0.5), e = frameEl(i++)
      const cls = `fr k-${f.kind} still`
      if (e.cls !== cls) { e.cls = cls; e.g.setAttribute('class', cls) }
      if (e.verb !== f.verb) { e.verb = f.verb; e.t.textContent = f.verb; const w = 8 + f.verb.length * 5.6; e.r.setAttribute('width', w.toFixed(1)); e.r.setAttribute('x', (-w / 2).toFixed(1)) }
      e.c.setAttribute('r', '0')
      e.g.setAttribute('transform', `translate(${x.toFixed(1)} ${Math.max(YMIN, y).toFixed(1)})`); e.g.style.display = ''
    }
    for (let j = i; j < pool.length; j++) pool[j].g.style.display = 'none'
  }
}

// ── the hidden-frames line: heartbeats and digests, counted since this run started ──
let hiddenKey = ''
function paintHidden(force) {
  const vc = page.verbCounts, p = vc.PING ?? 0, q = vc.PONG ?? 0, d = vc.DIGEST ?? 0
  const key = `${p}|${q}|${d}|${showHidden}`
  if (!force && key === hiddenKey) return
  hiddenKey = key
  hiddenEl.title = 'heartbeats (PING, PONG) and digests (DIGEST) sent since this run started — most of the frames on the wire'
  setH(hiddenEl, `${showHidden ? 'drawn faint' : 'not drawn'}: <span class="cl-hv">PING ${att(num(p))}</span> · <span class="cl-hv">PONG ${att(num(q))}</span> · <span class="cl-hv">DIGEST ${att(num(d))}</span> <button type="button" class="cl-show" data-toggle aria-pressed="${showHidden}">${showHidden ? 'hide' : 'show'}</button>`)
}

// ── one card, from the kernel ──
// a client with no server: cut off from every server, none up, or still connecting (only then "yet")
const NO_SERVER = { cut: 'no server: cut off', down: 'no server: none is up', yet: 'follows no server yet' }
const NO_ROUTE = { cut: 'cut off: no server to write through', down: 'no server is up to write through', yet: 'connecting to a server' }
// why a server's write gate is closed, in plain words (kernel/membership.ts gate reasons)
const GATE = { minority: 'read-only: it cannot reach a majority of its view · reads still work', rejoining: 'read-only: rejoining the view', evicted: 'read-only: not in the view · it asks to join', 'stale-epoch': 'read-only: it saw a newer view and is fetching it' }
const GATE_SHORT = { minority: 'it cannot reach a majority', rejoining: 'it is rejoining', evicted: 'it is not in the view', 'stale-epoch': 'it is fetching a newer view' }
const hex = (h) => (h >>> 0).toString(16).padStart(8, '0')
const KEY = Object.fromEntries(ROWS.map((r) => [r, JSON.stringify([r])]))
// paintCard: gather the node's raw facts from the kernel (its own maps: state, versions — no copies), build a
// cheap signature, and touch the DOM only when something the card shows has changed
function paintCard(id, c, states, maj, now, allWaiting) {
  const k = c.k, n = page.node(id), alive = page.alive(id), down = page.down.has(id), left = page.left.has(id), srv = page.role(id) === 'server'
  const iso = alive && page.isolated(id)
  const leaving = alive && !left && M.f.leaving.has(id)
  const gate = alive && srv ? page.writable(id) : null
  const target = D_target() === id
  const life = n ? n.incarnation : 0, origin = n ? n.origin : id
  const prim = !srv && alive ? page.primary(id) : null
  let sig = `${alive}${down}${left}${leaving}${iso}${gate ? gate.open + gate.reason : ''}${target}|${life}|${origin}|${prim}`
  const view = alive ? page.viewOf(id) : null
  const rows = []
  let extra = 0
  if (alive) {
    let present = 0
    for (const r of ROWS) {
      const v = n.state.get(KEY[r]), st = n.versions.get(KEY[r])
      if (v !== undefined) present++
      // ★ = this server owns the row in its own view. A read-only server (cut off, rejoining) keeps its old view and so
      // its old rows, but it stamps nothing: its star is drawn hollow, so the figure never shows two owners that can stamp
      const own = srv && ownerOf(r, view) === id ? (gate && !gate.open ? 'old' : 'yes') : ''
      const ft = M.flash.get(`${id}|${r}`)
      let flash = false
      if (ft !== undefined && ft !== c.seen[r]) { if (c.seen[r] !== undefined) { flash = true; c.fresh[r] = now + 1400 } c.seen[r] = ft }
      const fresh = (c.fresh[r] ?? 0) > now
      rows.push({ r, v, st, own, flash, fresh })
      sig += `|${v && typeof v === 'object' ? v.stock : v}:${st ? `${st.epoch}.${st.seq}.${st.origin}` : '-'}${own}${fresh ? '!' : ''}${flash ? '~' : ''}`
    }
    extra = n.state.size - present
    sig += `|x${extra}`
  }
  // waiting: this node's own writes (the oldest, and how many — the sentence names the same one), or (a server) the
  // oldest client write it holds as that client's server
  let mine = null, mineN = 0, held = null
  if (alive) {
    for (const w of allWaiting) if (w.node === id) { mine ??= w; mineN++ }
    if (!mine && srv && page.pending(id) > 0) for (const w of allWaiting) if (w.node !== id && page.role(w.node) === 'client' && page.primary(w.node) === id) { held = w; break }
    const ww = mine ?? held
    // keyed on the printed time itself, so the card and the sentence always show the same number
    if (ww) sig += `|w${ww.id}:${mineN}:${vt(now - ww.issuedAt)}${mine ? 'm' : 'h'}`
  }
  const d = srv ? diskOf(id) : null
  if (d) sig += `|d${d.recs}.${d.unsaved}.${d.boot ? d.boot.epoch : '-'}`
  const hsh = alive ? page.hash(id) : 0
  if (alive) sig += `|v${view.epoch}|h${hsh}|${hsh === maj}`
  for (const o of ids) if (o !== id) sig += `|${states.get(pk(id, o))}${hot.has(pk(id, o)) ? '+' : ''}`
  if (sig === c.sig) return
  c.sig = sig

  setC(c.el, 'cl-down', down || left || !alive)
  setC(c.el, 'is-cut', iso)
  setC(c.el, 'is-target', target)
  // pill
  let pill = 'up', pc = 'up'
  if (down || (!alive && !left)) { pill = 'down ✕'; pc = 'neg' }
  else if (left) { pill = 'left'; pc = 'dim' }
  else if (leaving) { pill = 'leaving'; pc = 'dim' }
  else if (iso) { pill = 'cut off'; pc = 'neg' }
  else if (gate && !gate.open) { pill = 'read-only'; pc = 'wait' }
  setT(k.pill, pill); if (k.pill.dataset.c !== pc) { k.pill.dataset.c = pc; k.pill.className = `cl-pill ${pc}` }
  // life · origin · primary
  let lf = `life ${life}`
  if (origin !== id) lf += ` · writes as ${origin}`
  if (!srv && alive) lf += prim ? ` · follows ${prim}` : ` · ${NO_SERVER[noServerWhy(id)]}`
  if (!alive && !left) lf += ' · crashed'
  setH(k.life, att(lf))
  // gone / values
  setHid(k.gone, alive)
  setHid(k.vals, !alive)
  if (!alive) setH(k.gone, left ? '<b class="ok">left</b> on purpose: the others voted it out when it asked'
    : srv ? '<b>✕</b> crashed: the process is gone · its disk is kept'
      : '<b>✕</b> crashed: the process is gone, and its copy with it · a client has no disk')
  if (k.nodisk) setHid(k.nodisk, !alive)
  if (alive) {
    for (const { r, v, st, own, flash, fresh } of rows) {
      const vEl = r === BIG ? k.big : k[`v-${r}`]
      const shown = v === undefined ? (st ? 'removed' : 'none') : (v && typeof v === 'object' && 'stock' in v ? num(v.stock) : null)
      if (shown !== null) { if (vEl._h !== undefined) vEl._h = undefined; setT(vEl, shown) }
      else setH(vEl, inspect(v))
      setC(vEl, 'word', shown === null || !/^[\d,.-]+$/.test(shown))
      if (flash) { c.flip[r] = !c.flip[r]; setC(vEl, 'fl0', c.flip[r]); setC(vEl, 'fl1', !c.flip[r]) }
      setH(k[`st-${r}`], st ? A(stampHTML(st).replace('class="stamp"', `class="stamp${fresh ? ' fresh' : ''}"`)) : '')
      const star = k[`star-${r}`]
      if (star) {
        if (star.hidden === !!own) star.hidden = !own
        const old = own === 'old', face = old ? '☆' : '★'
        if (star.textContent !== face) star.textContent = face
        setC(star, 'old', old)
        const tt = old ? `owner of ${r} only in its old view ${view.epoch} · read-only: it stamps nothing until it can reach a majority again` : `this server owns ${r} in its view: it stamps every write to it`
        if (star.title !== tt) star.title = tt
      }
    }
    setHid(k.more, !extra)
    if (extra) {
      const names = []; for (const key of n.state.keys()) { const p = JSON.parse(key); if (p.length === 1 && !ROWS.includes(p[0])) names.push(p[0]) }
      setH(k.more, att(`+ ${extra} more ${extra === 1 ? 'row' : 'rows'}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' …' : ''}`))
    }
  }
  // the slot: a waiting write (amber; every time says "simulated"), a held client write (with the holder's own gate
  // reason when it is read-only), or, when nothing waits, the node's write route in a few words: the kernel's write
  // gate for a server (open only while it is in the view and can reach a majority), the server a client writes through
  let wait = '', quiet = false, gated = false
  const sim = (ms) => A(esc(`${vt(ms)} simulated`))
  // the write's row and value; on a phone it takes its own line (cluster.css), so it never breaks inside its braces
  const rowv = (w) => `<span class="cl-sep"> · </span><span class="cl-wait-why">${A(esc(w.path[0]))}${w.remove ? ' (remove)' : ` = ${A(inspect(w.value ?? null))}`}</span>`
  if (mine) wait = mineN > 1 ? `${A(esc(String(mineN)))} writes waiting · the oldest ${sim(now - mine.issuedAt)}${rowv(mine)}` : `waiting ${sim(now - mine.issuedAt)}${rowv(mine)}`
  else if (held) wait = `holds ${A(nid(held.node))}'s write${gate && !gate.open ? ` · read-only: ${esc(GATE_SHORT[gate.reason] ?? gate.reason)}` : ''} · waiting ${sim(now - held.issuedAt)}`
  else if (alive) {
    if (leaving) { wait = 'stopping on purpose (Ctrl-C) · it asked to be voted out'; gated = true }
    else if (gate && !gate.open) { wait = esc(GATE[gate.reason] ?? `read-only: ${gate.reason}`); gated = true }
    else if (srv) { wait = view.epoch ? 'takes writes' : 'takes writes: no view yet'; quiet = true }
    else if (iso || !prim) { wait = NO_ROUTE[iso ? 'cut' : noServerWhy(id)]; gated = true }
    else { wait = `writes go through ${A(nid(prim))}`; quiet = true }
  }
  setC(k.wait, 'gated', gated)
  setC(k.wait, 'quiet', quiet)
  // the scripted writer's node (c1) has a write waiting for a moment on every write: its slot keeps the room that line
  // takes ("waiting 117 ms simulated · gadgets = { stock: 4 }"), so its card never grows and shrinks with each write.
  // So does every live server: the one c1 writes through holds each write for a moment when it does not own the row
  // ("holds c1's write · waiting 100 ms simulated", three lines on a phone), and after a failover that can be any of
  // them. A server's own write (03's restock line, from n01) gets the same room.
  const ownRoom = (row, v) => `waiting 000 ms simulated<span class="cl-sep"> · </span><span class="cl-wait-why">${esc(row)} = { stock: ${v} }</span>`
  setH(k.wait, !alive ? wait
    : page.writer.id === id ? fitH(wait, ownRoom(page.writer.row, '0'))
      : srv ? fitH(wait, `holds ${esc(page.writer.id)}'s write · waiting 000 ms simulated`, ownRoom('widgets', '00'))
        : wait)
  // disk (servers): the records in its write-ahead log — counted in records, the unit the sentence and the restart's
  // replay use — and the view its boot record saved for the next life. A record is "not yet saved" for the moment
  // its fsync takes (a few simulated ms; longer under 02's slow disk): the line keeps the room that longer text
  // takes, so the card does not grow for that moment
  if (srv && k.disk) {
    let html = ''
    if (d) {
      const head = `disk${alive ? '' : ' kept'} · ${d.recs} ${d.recs === 1 ? 'record' : 'records'}`
      const tail = d.boot ? ` · saved view ${d.boot.epoch}` : ' · no view saved yet'
      const unsaved = ` (${Math.max(1, d.unsaved)} not yet saved)`
      html = fit(att(head + (d.unsaved ? ` (${d.unsaved} not yet saved)` : '') + tail), head + unsaved + tail)
    }
    setH(k.disk, html)
  }
  // footer: its own view, and its fingerprint against the most common one
  if (alive) {
    // the fingerprint is the node's state hash (node.stateHash); equal fingerprints mean equal copies. A copy that
    // differs may be behind or ahead (the owner applies first), so the word is "differs", never "behind". On a phone
    // the verdict sits beside the view ("view 1 · copy ✓"), so "differs" never pushes the fingerprint onto a third
    // line for the moment a record is on its way (cluster.css shows one of the two)
    const verdict = hsh === maj ? '<span class="agree-ok">✓</span>' : '<span class="waiting">differs</span>'
    setH(k.view, `${att(`view ${view.epoch}`)}<span class="cl-verd-n"> · copy ${verdict}</span>`)
    k.fp.title = `fingerprint ${hex(hsh)}: this copy's state hash — equal fingerprints mean equal copies`
    setH(k.fp, `<span class="cl-fp-k">fingerprint</span> ${att(hex(hsh).slice(0, 6))}<span class="cl-verd-w"> ${verdict}</span>`)
  } else { setH(k.view, ''); setH(k.fp, '<span class="cl-fp-k">no process</span>') }
  // phones: the band becomes a line of links on each card
  const toks = []
  for (const o of ids) {
    if (o === id) continue
    const st = states.get(pk(id, o))
    toks.push(`<span class="cl-lk ${st}${hot.has(pk(id, o)) ? ' hot' : ''}" title="${st === 'up' ? 'link up' : st === 'cut' ? 'link cut' : st === 'down' ? 'the other end is down' : 'connecting'}">${A(esc(o))}${st === 'cut' ? ' cut' : ''}</span>`)
  }
  setH(k.links, `<span class="cl-lk-k">links</span> ${toks.join(' ')}`)
}
let hot = new Set()
let D_target = () => null
export function setTargetReader(fn) { D_target = fn }

// ── the tape: the last stamps the apply tap saw, each with how many live copies applied it (a newer record of the
// same row may have replaced it since: the cards show what each copy holds now) ──
const TAPE_N = 4
function paintTape(now) {
  const recs = lastRecords(TAPE_N)
  const cells = recs.map((e) => {
    const { n, of } = landed(e.stamp)
    const r = { type: e.type, key: e.path, ...(e.type === 2 ? {} : { value: e.value }) }
    return `${A(stampHTML(e.stamp))}<span class="cl-tr-rec">${A(rec(r))}</span><span class="cl-tr-on ${n === of ? 'agree-ok' : ''}" title="${esc(`applied on ${n} of the ${of} live copies · a newer record of the same row may have replaced it since`)}">${A(esc(`on ${n} of ${of}`))}</span><span class="cl-tr-t">${A(esc(vt(e.at)))}</span>`
  })
  let html = cells.map((c) => `<li class="cl-tr">${c}</li>`).join('')
  // a run starts with the three seed records: the tape keeps its four rows' room from the start, so it never grows
  // by a row under the cards when the first write lands (or after a reset). The missing rows are unseen copies of the
  // newest one, digits written as x and nothing attested: they hold the room and say nothing
  if (cells.length && cells.length < TAPE_N) {
    const pad = `<li class="cl-tr cl-tr-pad" aria-hidden="true">${cells[0].replace(/ (data-attested|title)="[^"]*"/g, '').replace(/\d/g, 'x')}</li>`
    html += pad.repeat(TAPE_N - cells.length)
  }
  setH(tapeEl, html || '<li class="cl-tr cl-tr-none">no records yet</li>')
}

// ── the loop body (the section's one frame loop calls it while variant a is shown and on screen) ──
let lastHidden = 0
export function frame() {
  const now_ids = page.ids()
  if (now_ids.length !== ids.length || now_ids.some((id, i) => id !== ids[i])) build()
  else if (gen !== M.gen) { gen = M.gen; carried.clear(); for (const c of cards.values()) { c.sig = ''; c.seen = {}; c.fresh = {} } for (const a of arcs.values()) a.cls = '' }
  const now = page.now, states = linkStates(), maj = majorityHash()
  hot = new Set()
  for (const f of onWire(now)) if (f.fresh) hot.add(pk(f.from, f.to))
  drawFrames(states)
  const allWaiting = waiting()
  for (const [id, c] of cards) paintCard(id, c, states, maj, now, allWaiting)
  if (performance.now() - lastHidden > 250) { lastHidden = performance.now(); paintHidden(false) }
}
export function relayout() { if (cards.size) layout() }
// the slow tick (with the sentence and the strip, so the tape's counts and theirs always agree)
export function slow() { if (cards.size) paintTape(page.now) }
