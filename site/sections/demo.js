// sections/demo.js — "Try it": fero's real kernel in the tab (the shared `page` cluster), drawn as A's live cluster,
// with B's seven-step story played on the same picture.
//
// What moves, and from what (all read from the kernel, nothing typed):
//  · the boxes: each node's luna.mood (page.cell), its state (page.down / page.left / page.isolated / page.waiting, the
//    list of servers page.view(), and its state hash against luna's owner's), and the ★ (page.owner('luna')).
//  · the lines: page.on('frame'). A WRITE frame lights the write path (over the top) from its sender to its receiver
//    while it flies (sentAt ≤ page.now < recvAt); a RECORDS frame lights the copies path (under). On a wide screen a dot
//    shows how far it got; on a narrow one (stacked boxes) each box glows as a message reaches it, in route order.
//  · the narrator: the driver's events (write, commit, kill, restart, leave, left, cut, heal, view, reset), each told
//    with the state captured at the event itself; why a write waits comes from words.js (holdCause), once per cause.
//  · the story: each step acts on the page, then runs the clock (slowed while a write travels) until a kernel event,
//    then holds the clock while the reader reads. A timeout in simulated time keeps a step from waiting forever.
import { page, attest, put, fmt, onFrame, REDUCED, Ring, RULE_LINES } from '../cluster.js'
import { catSvg } from '../cats.js'
import { N, M, V, OK, STAR, NB, OWNS, CODE, words, secs, list, moodsIn, text, plainLog, holdCause, causeParts, causeLine, cannotVote, voters, breaches, breachParts } from './demo/words.js'

const root = document.getElementById('demo')
if (root) init()

function init() {
  const ROW = 'luna'
  const SLOW = 0.16        // the story's slow motion while a write travels: simulated ms per wall ms
  const DWELL = 2600       // the least time a story step holds for reading (wall ms, counted while on screen)
  const WAIT_SIM = 500     // a write pending longer than this (simulated ms) is held up, not travelling
  const SETTLE_SIM = 220   // free play: a copy must lag luna's owner this long (simulated ms) to show as behind
  const LINGER = 950       // a hop stays lit this long after it lands (presentation ms)
  const FRESH = 1700       // a changed value stays violet this long (presentation ms)
  const RX = 700           // narrow screens: a box glows this long after a write or a copy reaches it (presentation ms)
  const SAY_HOLD = 4500    // a visitor's sentence is not replaced by a routine one for this long (presentation ms)
  const CHAIN = 2600       // a consequence this soon after a visitor's press is told after its sentence
  const QUIET = 20000      // after a free-play press the scripted visitor rests this long (presentation ms, on screen)
  const MODEL_MS = 100     // the boxes and numbers are re-read at least this often; at once when the kernel acts
  const QUIET_CAP = 1000   // story step 4 waits at most this long (simulated ms) for the wire to go quiet before the crash
  // why the vote takes about a second here, not the four or so at fero's defaults (02's card says "about four seconds
  // at the defaults"; its live line gives only the time): the tab's servers check on each other every 100 ms
  const WHY_QUICK = ' (this café\'s servers check on each other more often than fero\'s defaults)'
  const SVGNS = 'http://www.w3.org/2000/svg'

  const $ = (s) => root.querySelector(s)
  const fig = $('#demo-fig'), svg = fig.querySelector('svg.wires')
  const gW = svg.querySelector('.g-w'), gC = svg.querySelector('.g-c')
  const cutG = svg.querySelector('.cutmarks'), litG = svg.querySelector('.lit'), dotG = svg.querySelector('.dots')
  const lw = fig.querySelector('.wl-w'), lc = fig.querySelector('.wl-c')
  const sayEl = $('#demo-say'), srEl = $('#demo-say-sr'), storyEl = $('#demo-story'), ctl = $('#demo-ctl')
  const playBtn = storyEl.querySelector('[data-story=play]'), playLbl = playBtn.querySelector('.lbl'), nextBtn = storyEl.querySelector('[data-story=next]')
  const overBtn = storyEl.querySelector('[data-story=over]'), tagEl = storyEl.querySelector('.story-tag')
  const nowEl = $('#demo-now'), nowNo = nowEl.querySelector('.step-no'), nowT = nowEl.querySelector('.t'), nowNext = nowEl.querySelector('[data-story=next]')
  const steps = [...storyEl.querySelectorAll('li[data-step]')]
  const heirEls = [...storyEl.querySelectorAll('[data-name=heir]')], ownerEls = [...storyEl.querySelectorAll('[data-name=owner]')]
  const agreeEl = $('#demo-agree'), agreeWhy = $('#demo-agree-why'), waitEl = $('#demo-wait'), waitK = $('#demo-wait-k')
  const waitWhy = $('#demo-wait-why'), brokenEl = $('#demo-broken'), rulesEl = $('#demo-rules'), logEl = $('#demo-log'), door = $('#demo-door')
  const brokeEl = $('#demo-broke'), brokeRule = brokeEl.querySelector('.rule-t'), brokeWhat = brokeEl.querySelector('.broke-what')

  page.watch(root)

  // ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────
  const clients = () => page.clientIds, servers = () => page.serverIds
  const order = () => [...page.clientIds, ...page.serverIds]
  const C1 = () => page.clientIds[0]
  const isClient = (id) => page.clientIds.includes(id)
  const connected = (id) => page.alive(id) && !page.isolated(id)
  const moodOf = (id) => { try { return page.alive(id) ? page.cell(id, ROW)?.mood ?? null : null } catch { return null } }
  const cycle = () => (page.writer?.cycle?.length ? page.writer.cycle : ['purring', 'playful', 'hungry', 'zoomies', 'sleepy', 'grumpy'])
  const nextMood = (cur) => { const c = cycle(), i = c.indexOf(cur); return c[(i + 1) % c.length] }
  const assign = (v) => CODE(`cafe.data.${ROW} = { mood: '${v?.mood ?? ''}' }`, v?.mood)
  const cap = (parts) => (typeof parts[0] === 'string' ? [parts[0][0].toUpperCase() + parts[0].slice(1), ...parts.slice(1)] : parts)
  const setClass = (el, c) => { if (el.className !== c) el.className = c }
  // the owner luna would have without `gone`: the kernel's own ring, built from the live view minus one member
  function ownerWithout(gone) {
    const v = page.view(), ms = v.members.filter((m) => m !== gone)
    if (!ms.length) return ''
    const r = new Ring(); r.build(v.epoch, ms.map((m) => [m, `sim:${m}`])); return r.ownerOf(ROW)
  }

  // ── the narrator: one line on screen, and a screen-reader line that gets only what is new ─────────────────────
  // parts are strings, or { n } a node name, { m } a mood, { c } code, { v } a number, STAR, { ok } (words.js)
  function render(el, parts) {
    const frag = document.createDocumentFragment()
    const add = (p) => {
      if (p == null || p === false || p === '') return
      if (Array.isArray(p)) { for (const q of p) add(q); return }
      if (typeof p === 'string') { frag.append(p); return }
      const s = document.createElement(p.c != null ? 'code' : 'span')
      if (p.n != null) { s.className = 'nm'; attest(s, p.n, 'runtime') }
      else if (p.m != null) { s.className = 'mood'; s.textContent = p.m }
      else if (p.c != null) s.textContent = p.c
      else if (p.v != null) attest(s, p.v, 'runtime')
      else if (p.star) { s.className = 'star'; s.textContent = '★'; s.setAttribute('aria-hidden', 'true') }   // the words say "luna's owner"
      else if (p.ok != null) { s.className = 'ok'; s.textContent = p.ok }
      frag.append(s)
    }
    add(parts)
    el.replaceChildren(frag)
  }
  // a state line's words as text, each mark (✕ ✓ ◌ ·) in an aria-hidden span: a screen reader hears "down", "agrees"
  function glyphless(s) {
    const frag = document.createDocumentFragment()
    for (const piece of s.split(/([✕✓◌·])/)) {
      if (!piece) continue
      if (/^[✕✓◌·]$/.test(piece)) { const g = document.createElement('span'); g.setAttribute('aria-hidden', 'true'); g.textContent = piece; frag.append(g) }
      else frag.append(piece)
    }
    return frag
  }
  let srTimer = 0
  function announce(parts) {
    clearTimeout(srTimer)
    render(srEl, parts)
    // then empty again, so a screen reader browsing the page meets the sentence once, in the narrator itself
    srTimer = setTimeout(() => srEl.replaceChildren(), 9000)
  }
  // what the narrator shows now: its parts, how many sentences were chained, the causes it gave, whether it already
  // says the client's write waits, and the moods it quotes (a newer write makes a quoted mood stale)
  const blank = () => ({ key: '', prio: 0, at: -1e9, parts: null, n: 0, causes: new Set(), waits: false, moods: new Set() })
  let said = blank()
  // prio 2: a press (here or in a Break card), a page write landing · 1: an event · 0: routine (the scripted visitor).
  // Routine never hides a fresher sentence for a while, unless it lands a mood the sentence quotes. An event soon after
  // a press, or a write waiting for a cause the narrator already gave, is added after the sentence on screen.
  function say(parts, prio = 1, meta = {}) {
    if (story.active) return false
    const stale = meta.mood != null && said.moods.size > 0 && !said.moods.has(meta.mood)
    if (!stale && prio === 0 && said.prio > 0 && pt - said.at < SAY_HOLD) return false
    const chain = !stale && said.parts && said.n < 3 && (meta.append || (prio === 1 && said.prio === 2 && pt - said.at < CHAIN))
    const show = chain ? [said.parts, ' ', parts] : parts
    const key = JSON.stringify(show)
    if (key !== said.key) { render(sayEl, show); if (prio > 0) announce(parts) }
    const causes = chain ? new Set(said.causes) : new Set()
    if (meta.cause) causes.add(meta.cause)
    said = chain
      ? { ...said, key, parts: show, n: said.n + 1, causes, waits: said.waits || !!meta.waits, moods: moodsIn(parts, new Set(said.moods)) }
      : { key, prio, at: pt, parts: show, n: 1, causes, waits: !!meta.waits, moods: moodsIn(parts) }
    return true
  }
  // the story tells its own steps; `add` is the part that is new since the last sentence (for screen readers)
  function sayStory(parts, add = parts) {
    const key = JSON.stringify(parts)
    if (said.key !== key) { render(sayEl, parts); announce(add) }
    said = { ...blank(), key, prio: 9, at: pt, parts, n: 1, moods: moodsIn(parts) }
  }

  // ── the boxes ──────────────────────────────────────────────────────────────────────────────────────────────
  const boxes = new Map()
  function bindBoxes() {
    const want = order(), have = [...fig.querySelectorAll('.node[data-id]')].map((el) => el.dataset.id)
    if (want.join() !== have.join()) {
      // the cluster changed shape (a server was added): draw one box per process, in the same mould
      const tpl = fig.querySelector('.node[data-id]:not(.client)') ?? fig.querySelector('.node[data-id]')
      const wrap = fig.querySelector('.nodes')
      wrap.replaceChildren(...want.map((id) => {
        const el = tpl.cloneNode(true)
        el.dataset.id = id; el.className = 'node' + (isClient(id) ? ' client' : '')
        el.querySelector('.role').textContent = isClient(id) ? 'Client' : 'Server'
        return el
      }))
    }
    boxes.clear()
    for (const el of fig.querySelectorAll('.node[data-id]')) {
      const id = el.dataset.id
      const b = { id, el, nm: el.querySelector('.nm'), star: el.querySelector('.owner-star'), value: el.querySelector('.value'),
        state: el.querySelector('.state'), cat: el.querySelector('.cat'), badge: el.querySelector('.badge'),
        mood: null, catMood: null, freshAt: -1e9, behindSince: null, stateKey: '', cls: '' }
      attest(b.nm, id, 'runtime')
      boxes.set(id, b)
    }
    geoDirty = true
  }

  // ── geometry: measured from the real boxes, so the lines meet them at every width ───────────────────────────
  let geo = null, geoDirty = true, geoVer = 0
  const NARROW = typeof matchMedia === 'function' ? matchMedia('(max-width: 960px)') : { matches: false }
  const PHONE = typeof matchMedia === 'function' ? matchMedia('(max-width: 700px)') : { matches: false }
  function measure() {
    const fr = fig.getBoundingClientRect()
    if (!fr.width) return false
    const vert = NARROW.matches
    const ports = new Map()
    for (const [id, b] of boxes) {
      const r = b.el.getBoundingClientRect()
      const l = r.left - fr.left, t = r.top - fr.top, w = r.width, h = r.height
      ports.set(id, { l, t, r: l + w, b: t + h, cx: l + w / 2, cy: vert ? t + Math.min(h / 2, 34) : t + h / 2 })
    }
    const ps = [...ports.values()]
    if (!ps.length) return false
    const g = { w: fr.width, h: fr.height, vert, ports, ver: ++geoVer }
    if (vert) { g.busW = Math.min(...ps.map((p) => p.l)) - 14; g.busC = Math.max(...ps.map((p) => p.r)) + 14 }
    else { g.busW = Math.min(...ps.map((p) => p.t)) - 25; g.busC = Math.max(...ps.map((p) => p.b)) + 25 }
    geo = g
    svg.setAttribute('viewBox', `0 0 ${fr.width.toFixed(1)} ${fr.height.toFixed(1)}`)
    // the two labels sit on their paths: "write" between the client and the first server, "copies" between the first two servers
    const o = order(), cs = clients(), ss = servers()
    if (!vert && ports.get(cs[0]) && ports.get(ss[0])) {
      place(lw, (ports.get(cs[0]).cx + ports.get(ss[0]).cx) / 2, g.busW)
      const a = ports.get(ss[0]), b = ports.get(ss[1] ?? ss[0])
      place(lc, (a.cx + b.cx) / 2, g.busC)
    } else if (o.length) {
      place(lw, g.busW + 30, 15)
      place(lc, g.busC - 34, 15)
    }
    geoDirty = false
    for (const e of litPool.values()) { e.d = ''; e.g = null }
    staticKey = ''
    return true
  }
  function place(el, x, y) { el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)` }
  const R = 9
  // a hop's path: out of the sender's edge to its bus, along the bus, back into the receiver's edge. Returns the SVG
  // path and the same line as points (its two quarter-turns sampled), so a travelling dot is a lookup by length,
  // never a layout query
  function hopGeom(bus, a, b) {
    const A = geo.ports.get(a), B = geo.ports.get(b)
    if (!A || !B) return null
    let P0, P1, C1, P2, P3, C2, P4, P5
    if (!geo.vert) {
      const top = bus === 'w', yb = top ? geo.busW : geo.busC, dy = top ? 1 : -1
      const y0 = (top ? A.t : A.b) - dy, y1 = (top ? B.t : B.b) - dy, x0 = A.cx, x1 = B.cx, s = Math.sign(x1 - x0) || 1
      P0 = [x0, y0]; P1 = [x0, yb + dy * R]; C1 = [x0, yb]; P2 = [x0 + s * R, yb]; P3 = [x1 - s * R, yb]; C2 = [x1, yb]; P4 = [x1, yb + dy * R]; P5 = [x1, y1]
    } else {
      const left = bus === 'w', xb = left ? geo.busW : geo.busC, dx = left ? 1 : -1
      const x0 = (left ? A.l : A.r) - dx, x1 = (left ? B.l : B.r) - dx, y0 = A.cy, y1 = B.cy, s = Math.sign(y1 - y0) || 1
      P0 = [x0, y0]; P1 = [xb + dx * R, y0]; C1 = [xb, y0]; P2 = [xb, y0 + s * R]; P3 = [xb, y1 - s * R]; C2 = [xb, y1]; P4 = [xb + dx * R, y1]; P5 = [x1, y1]
    }
    const f = (p) => `${p[0]},${p[1]}`
    const d = `M${f(P0)}L${f(P1)}Q${f(C1)} ${f(P2)}L${f(P3)}Q${f(C2)} ${f(P4)}L${f(P5)}`
    const quad = (p, c, q) => [0.25, 0.5, 0.75, 1].map((t) => [(1 - t) ** 2 * p[0] + 2 * (1 - t) * t * c[0] + t * t * q[0], (1 - t) ** 2 * p[1] + 2 * (1 - t) * t * c[1] + t * t * q[1]])
    const pts = [P0, P1, ...quad(P1, C1, P2), P3, ...quad(P3, C2, P4), P5]
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    return { d, pts, cum }
  }
  // the point a fraction f of the way along a hop
  function pointAt(g, f) {
    const L = g.cum[g.cum.length - 1] * Math.max(0, Math.min(1, f))
    let i = 1
    while (i < g.cum.length - 1 && g.cum[i] < L) i++
    const span = g.cum[i] - g.cum[i - 1] || 1, t = (L - g.cum[i - 1]) / span, a = g.pts[i - 1], b = g.pts[i]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  // the faint guides: one bus per kind, with a stub to every box that is up and reachable
  function guidePath(bus, ids) {
    const P = ids.map((id) => geo.ports.get(id)).filter(Boolean)
    if (P.length < 2) return ''
    let d = ''
    if (!geo.vert) {
      const top = bus === 'w', yb = top ? geo.busW : geo.busC, dy = top ? 1 : -1
      P.sort((p, q) => p.cx - q.cx)
      const a = P[0], z = P[P.length - 1], ya = (top ? a.t : a.b) - dy, yz = (top ? z.t : z.b) - dy
      d = `M${a.cx},${ya}V${yb + dy * R}Q${a.cx},${yb} ${a.cx + R},${yb}H${z.cx - R}Q${z.cx},${yb} ${z.cx},${yb + dy * R}V${yz}`
      for (const p of P.slice(1, -1)) d += `M${p.cx},${(top ? p.t : p.b) - dy}V${yb}`
    } else {
      const left = bus === 'w', xb = left ? geo.busW : geo.busC, dx = left ? 1 : -1
      P.sort((p, q) => p.cy - q.cy)
      const a = P[0], z = P[P.length - 1], xa = (left ? a.l : a.r) - dx, xz = (left ? z.l : z.r) - dx
      d = `M${xa},${a.cy}H${xb + dx * R}Q${xb},${a.cy} ${xb},${a.cy + R}V${z.cy - R}Q${xb},${z.cy} ${xb + dx * R},${z.cy}H${xz}`
      for (const p of P.slice(1, -1)) d += `M${(left ? p.l : p.r) - dx},${p.cy}H${xb}`
    }
    return d
  }
  // a cut: a dashed red mark in the gap beside the cut-off box
  function cutPath(id) {
    const o = order(), i = o.indexOf(id), p = geo.ports.get(id)
    if (!p) return ''
    const nb = geo.ports.get(o[i - 1] ?? o[i + 1]), before = i > 0
    if (!geo.vert) { const x = nb ? (before ? (nb.r + p.l) / 2 : (p.r + nb.l) / 2) : p.l - 12; return `M${x},6V${geo.h - 6}` }
    const y = nb ? (before ? (nb.b + p.t) / 2 : (p.b + nb.t) / 2) : p.t - 7
    return `M4,${y}H${geo.w - 4}`
  }
  // ── the lines: real frames, kept a moment after they land ──────────────────────────────────────────────────
  const hops = []           // { bus, from, to, sentAt, recvAt, landedPt }
  const c1Writes = []       // WRITE frames sent by a client: the server each write went through, for the narrator and the story
  const rxAt = new Map()    // narrow screens: when a write or a copy last reached each box (presentation ms)
  page.on('frame', (f) => {
    let bus = null
    if (f.verb === 'WRITE') bus = 'w'
    else if (f.kind === 'repl') bus = 'c'
    if (!bus) return
    hops.push({ bus, from: f.from, to: f.to, sentAt: f.sentAt, recvAt: f.recvAt, landedPt: null })
    if (hops.length > 400) hops.splice(0, hops.length - 300)
    if (bus === 'w' && isClient(f.from)) { c1Writes.push({ from: f.from, to: f.to, sentAt: f.sentAt, recvAt: f.recvAt }); if (c1Writes.length > 60) c1Writes.splice(0, 30) }
  })
  // a clean slate for a new scene: the lines of messages that already landed go out at once, and no box glows
  function clearWires() {
    for (const h of hops) if (h.recvAt <= page.now) h.landedPt = -1e9
    rxAt.clear()
    dirty = true
  }
  const litPool = new Map()   // `${bus}:${from}>${to}` → { el, d, g (its points), op }
  const dotPool = []
  let staticKey = ''
  function mk(tag, cls) { const e = document.createElementNS(SVGNS, tag); if (cls) e.setAttribute('class', cls); return e }

  function drawWires(now, model) {
    if (!geo || !model) return
    // guides, the waiting mark and the cut marks change only with the cluster's shape (read with the model)
    if (model.staticKey !== staticKey) {
      staticKey = model.staticKey
      gW.setAttribute('d', guidePath('w', model.up)); gC.setAttribute('d', guidePath('c', model.up))
      put(lw, model.heldPath ? 'waiting' : 'write'); lw.classList.toggle('wait', !!model.heldPath)
      cutG.replaceChildren(...model.cutIds.map((id) => { const p = mk('path'); p.setAttribute('d', cutPath(id)); return p }))
    }
    const held = model.heldPath, dots = !REDUCED && !geo.vert
    const since = heldSince()
    // the lit hops: one path per sender → receiver pair on each bus, as bright as its brightest message
    const want = new Map(), fly = []
    let keep = 0
    for (let i = 0; i < hops.length; i++) {
      const h = hops[i]
      const inFlight = now < h.recvAt
      if (!inFlight && h.landedPt === null) {
        const fresh = now - h.recvAt <= 400
        h.landedPt = fresh ? pt : pt - LINGER
        if (fresh) {
          // a box glows for the newest message that reached it lately (the story's holds look at when it was sent)
          const r = rxAt.get(h.to), lit = r && pt - r.pt < RX
          rxAt.set(h.to, { pt, sentAt: lit ? Math.max(r.sentAt, h.sentAt) : h.sentAt })
          if (geo.vert) dirty = true
        }
      }
      let op = 1
      if (!inFlight) { const age = pt - h.landedPt; op = age >= LINGER ? 0 : REDUCED ? 1 : 1 - age / LINGER }
      if (op <= 0) continue
      hops[keep++] = h
      if (!connected(h.from) || !connected(h.to)) continue
      // while the story holds the clock, a message from before the step that is still on its way is not drawn: its
      // dot would sit frozen mid-line in a scene it does not belong to (it shows again when the clock runs)
      if (inFlight && h.sentAt < since) continue
      // a write that is held up knocks in amber: waiting, not travelling
      const amber = h.bus === 'w' && held && h.from === held[0]
      const k = `${h.bus}:${h.from}>${h.to}${amber ? ':held' : ''}`
      const w = want.get(k)
      if (!w || w.op < op) want.set(k, { h, op, amber })
      if (inFlight && dots) fly.push({ k, amber, p: (now - h.sentAt) / Math.max(1e-6, h.recvAt - h.sentAt) })
    }
    hops.length = keep
    for (const [k, w] of want) {
      let e = litPool.get(k)
      if (!e) {
        e = { el: mk('path', w.amber ? 'held' : ''), d: '', g: null, op: -1 }
        e.el.setAttribute('marker-end', `url(#demo-arrow${w.amber ? '-w' : ''})`); e.el.setAttribute('marker-start', `url(#demo-tail${w.amber ? '-w' : ''})`)
        litG.append(e.el); litPool.set(k, e)
      }
      if (!e.d) { e.g = hopGeom(w.h.bus, w.h.from, w.h.to); e.d = e.g?.d ?? ''; e.el.setAttribute('d', e.d) }
      const op = Math.round(w.op * 20) / 20
      if (e.op !== op) { e.el.style.opacity = op; e.el.style.display = op ? '' : 'none'; e.op = op }
    }
    for (const [k, e] of litPool) if (!want.has(k) && e.op !== 0) { e.el.style.opacity = 0; e.el.style.display = 'none'; e.op = 0 }
    // the travelling dots (wide screens): where each message in flight is now
    let n = 0
    for (const f of fly) {
      const e = litPool.get(f.k)
      if (!e || !e.g) continue
      let c = dotPool[n]
      if (!c) { c = mk('circle'); c.setAttribute('r', '4.5'); dotG.append(c); dotPool[n] = c; c.cls = '' }
      const dc = f.amber ? 'held' : ''
      if (c.cls !== dc) { c.setAttribute('class', dc); c.cls = dc }
      const [x, y] = pointAt(e.g, f.p), xs = x.toFixed(1), ys = y.toFixed(1)
      // only what changed: a dot that holds still (the story holds the clock mid-flight) costs no repaint
      if (c.px !== xs) { c.setAttribute('cx', xs); c.px = xs }
      if (c.py !== ys) { c.setAttribute('cy', ys); c.py = ys }
      if (c.style.display) c.style.display = ''
      n++
    }
    for (let i = n; i < dotPool.length; i++) if (dotPool[i].style.display !== 'none') dotPool[i].style.display = 'none'
  }

  // ── the model: what each box shows, read from the kernel ───────────────────────────────────────────────────
  const leaving = new Set(), wasLeft = new Set(), catching = new Set(), behindOnce = new Set(), caughtAt = new Map()
  const killAt = new Map(), cutAt = new Map(), iso = new Set(), everMember = new Set()
  let pt = 0                // presentation time: runs while the cluster's clock runs and the demo is on screen
  let curOwner = null, curMembers = null, lastPrimary = null, curCause = null, freshCafe = false
  const track = new Map()   // writes being told: id → { w, heldTold }

  function computeModel() {
    const now = page.now, strict = story.active, v = page.view()
    const owner = page.owner(ROW), c1 = C1()
    // the copy to agree with: luna's owner's, unless it is down, cut off or still catching up after a restart; then
    // the biggest group of the other live, reachable copies (a tie goes to the client's)
    const cand = order().filter((id) => connected(id) && !catching.has(id))
    let ref = null
    if (owner && cand.includes(owner)) ref = page.hash(owner)
    else {
      const pool = cand.length ? cand : order().filter((id) => page.alive(id)), n = new Map()
      for (const id of pool) { const h = page.hash(id); n.set(h, (n.get(h) ?? 0) + 1) }
      let best = -1; for (const [h, c] of n) if (c > best || (c === best && c1 && page.alive(c1) && h === page.hash(c1))) { best = c; ref = h }
    }
    const cause = holdCause(page, c1, ROW, owner)
    curCause = cause?.key ?? null
    const nodes = [], byId = new Map(), cutIds = [], up = []
    let agree = 0, of = 0, waitN = 0, heldPath = null, catchN = 0, startN = 0
    for (const id of order()) {
      const b = boxes.get(id); if (!b) continue
      const alive = page.alive(id), down = page.down.has(id), left = page.left.has(id) && !down
      const cut = alive && page.isolated(id), stopping = alive && leaving.has(id)
      const mood = alive ? moodOf(id) : b.mood
      // starting: before the first vote, or while this copy does not hold luna's row yet (it shows "…", never "✓")
      const starting = alive && (!v.epoch || mood == null)
      const out = alive && !cut && !stopping && !starting && !isClient(id) && v.epoch > 0 && !v.members.includes(id)
      let behind = false
      if (alive && ref !== null && !starting) {
        const raw = page.hash(id) !== ref
        if (!raw) b.behindSince = null
        else if (b.behindSince === null) b.behindSince = now
        // a copy that just restarted or healed shows "catching up" until it matches: never smoothed over
        behind = raw && (strict || catching.has(id) || now - b.behindSince >= SETTLE_SIM)
        if (behind && catching.has(id)) behindOnce.add(id)
      } else b.behindSince = null
      const pend = isClient(id) && alive ? page.waiting(id) : []
      // a write is held when something keeps it from going through (words.js) or it has been pending a while;
      // a younger one with nothing in its way is on its way: "sending…", not "waiting"
      const held = cause && id === c1 ? pend : pend.filter((w) => now - w.issuedAt > WAIT_SIM)
      const waiting = held.length > 0, sending = !waiting && pend.length > 0
      waitN += held.length
      if (waiting && !heldPath && owner && owner !== id) heldPath = [id, owner]
      if (alive) { of++; if (!behind && !starting) agree++ }
      if (starting) startN++
      if (behind && catching.has(id)) catchN++
      if (cut) cutIds.push(id)
      if (alive && !cut) up.push(id)
      const s = { id, b, alive, down, left, cut, stopping, starting, out, mood, behind, waiting, sending, owner: id === owner, catching: catching.has(id) }
      nodes.push(s); byId.set(id, s)
    }
    const staticKey = `${geo?.ver ?? 0}|${up.join()}|${cutIds.join()}|${heldPath ? heldPath[0] : ''}`
    return { now, owner, view: v, cause, nodes, byId, agree, of, waitN, catchN, startN, cutIds, up, heldPath, staticKey }
  }

  function syncBoxes(model) {
    for (const s of model.nodes) {
      const b = s.b
      // the value: luna's mood in this copy (a down copy keeps its last word, greyed)
      if (s.mood && s.mood !== b.mood) {
        if (b.mood !== null) { b.freshAt = pt; if (!REDUCED && b.cat) { b.cat.classList.remove('hop'); void b.cat.offsetWidth; b.cat.classList.add('hop') } }
        b.mood = s.mood
      }
      attest(b.value, b.mood ?? '…', 'runtime')
      if (b.cat && b.catMood !== b.mood && b.mood) { b.catMood = b.mood; b.cat.innerHTML = catSvg(b.mood) }
      // one state line
      let st, cls = ''
      if (s.down) { st = ['✕ down'] }
      else if (s.left) { st = ['left'], cls = 'left' }
      else if (s.stopping) { st = ['stopping…'], cls = 'left' }
      else if (s.cut) { st = [['cutw', 'cut off'], ['dimw', ' · reads ✓']] }
      else if (s.starting) { st = ['starting'], cls = 'left' }
      else if (s.waiting) { st = ['◌ waiting'], cls = 'wait' }
      else if (s.sending) { st = ['sending…'], cls = 'send' }
      else if (s.behind) { st = s.catching ? ['catching up'] : ['not yet'], cls = s.catching ? 'catch' : 'left' }
      else if (s.out) { st = ['asking to join'], cls = 'catch' }
      else if (pt - (caughtAt.get(s.id) ?? -1e9) < 2600) { st = ['✓ caught up'], cls = 'agree' }
      else if (s.alive) { st = ['✓ agrees'], cls = 'agree' }
      else st = ['…']
      const key = JSON.stringify(st) + cls
      if (key !== b.stateKey) {
        b.stateKey = key
        b.state.className = 'state' + (cls ? ' ' + cls : '')
        b.state.replaceChildren(...st.map((x) => { if (typeof x === 'string') return glyphless(x); const sp = document.createElement('span'); sp.className = x[0]; sp.append(glyphless(x[1])); return sp }))
      }
      const fresh = pt - b.freshAt < FRESH && s.alive
      // a box glows for a moment as a message reaches it (a story hold puts out the glow of an older message: dwell)
      const r = rxAt.get(s.id)
      const rx = geo?.vert && s.alive && !s.cut && !!r && pt - r.pt < RX
      // .gone is a server that left (calm.css: a dashed box); one that is stopping still runs and keeps its box
      const c = ['node', isClient(s.id) && 'client', s.owner && s.alive && !s.cut && 'owner', s.down && 'down', s.left && 'gone',
        s.cut && 'cut', s.waiting && 'wait-on', fresh && 'fresh', rx && 'rx'].filter(Boolean).join(' ')
      if (c !== b.cls) { b.cls = c; b.el.className = c }
      if (b.star.hidden === s.owner) b.star.hidden = !s.owner
      if (b.badge.hidden === s.down) b.badge.hidden = !s.down
    }
  }

  let brokeKey = ''
  function syncStats(model) {
    // the ✓ says every copy agrees, so it never shows while two live boxes show different moods: free play counts a
    // copy that lags luna's owner by less than SETTLE_SIM as agreeing (no flicker while a write travels), so for that
    // moment the count is plain "N of N", and the ✓ and the green come back once every box shows the new mood.
    // (syncBoxes ran first: b.mood is the word each box shows.)
    const shown = new Set(model.nodes.filter((s) => s.alive).map((s) => s.b.mood))
    const all = model.agree === model.of && model.of > 0 && shown.size <= 1
    attest(agreeEl, `${model.agree} of ${model.of}${all ? ' ✓' : ''}`, 'runtime')
    // green when every copy agrees; amber while a copy catches up after a restart or a heal; plain ink while a
    // write is simply on its way to the copies that do not have it yet
    setClass(agreeEl, 'v' + (all ? ' ok' : model.catchN ? ' wait' : ''))
    const why = [], notYet = [], behind = []
    for (const s of model.nodes) {
      if (s.down) why.push(`${s.id} is down`)
      else if (s.left) why.push(`${s.id} left`)
      else if (s.cut) why.push(`${s.id} is cut off`)
      else if (s.behind) (s.catching ? behind : notYet).push(s.id)
    }
    const names = (ids) => ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`
    if (model.startN) why.push('the café is starting')
    if (behind.length) why.push(`${names(behind)} ${behind.length > 1 ? 'are' : 'is'} catching up`)
    if (notYet.length) {
      const others = model.nodes.filter((s) => s.alive && !s.cut && s.id !== model.owner).length
      why.push(notYet.length === others && notYet.length > 1 ? 'the write has not reached the others yet' : `the write has not reached ${names(notYet)} yet`)
    }
    attestLine(agreeWhy, why.join(' · '))
    attest(waitEl, model.waitN, 'runtime')
    setClass(waitEl, 'v' + (model.waitN ? ' wait' : ''))
    put(waitK, model.waitN === 1 ? 'write waiting' : 'writes waiting')
    attestLine(waitWhy, model.waitN ? causeLine(model.cause) : '')
    // rules broken: one per distinct breach (core.js reports each once), with the rule in core.js's plain words
    // (what it checks) and what the simulator caught
    const bs = breaches(page)
    attest(brokenEl, bs.length, 'runtime'); setClass(brokenEl, 'v ' + (bs.length ? 'bad' : 'ok'))
    attest(rulesEl, words(page.rules.length), 'runtime')
    const b = bs.at(-1), agreeNow = page.agree()
    const k = b ? b.monitor + '|' + b.detail + '|' + agreeNow + '|' + bs.length : ''
    if (k !== brokeKey) {
      brokeKey = k
      brokeEl.hidden = !b
      if (b) {
        put(brokeRule, RULE_LINES[b.monitor] ?? b.monitor)
        render(brokeWhat, breachParts(b, page, { crashed: (id) => killAt.has(id) || page.down.has(id) }))
      } else { brokeRule.textContent = ''; brokeWhat.replaceChildren() }
    }
  }
  // a runtime line that may be empty: an empty attested element would claim a value it does not show
  function attestLine(el, text) {
    if (text) attest(el, text, 'runtime')
    else if (el.textContent || el.hasAttribute('data-attested')) { el.textContent = ''; el.removeAttribute('data-attested') }
  }

  // the story's step titles name the owner and the new owner from the kernel
  let titleKey = ''
  function syncTitles(force) {
    if (story.active && !force) return
    const v = page.view()
    if (!v.members.length) return
    const k = v.epoch + ':' + v.members.join()
    if (!force && k === titleKey) return
    // the titles say what the story will do, and the story starts from a whole cluster: follow only a whole one
    if (!force && (!healthy() || leaving.size)) return
    const owner = page.owner(ROW)
    if (!owner) return
    titleKey = k
    const heir = ownerWithout(owner)
    for (const e of ownerEls) attest(e, owner, 'runtime')
    for (const e of heirEls) attest(e, heir || owner, 'runtime')
  }

  // ── the buttons under the boxes: each acts on the box above it, and never offers what the kernel would refuse ──
  const ctlBtns = [...ctl.querySelectorAll('button[data-do]')].map((btn) => ({ btn, id: btn.dataset.id, kind: btn.dataset.do, verb: btn.querySelector('.verb'), tail: btn.querySelector('.tail') }))
  for (const { btn, id } of ctlBtns) { const nm = btn.querySelector('.nm'); if (nm) attest(nm, id, 'runtime') }
  function syncButtons() {
    for (const { btn, id, kind, verb: vEl, tail: tEl } of ctlBtns) {
      const alive = page.alive(id), gone = page.down.has(id) || page.left.has(id), cut = alive && page.isolated(id)
      let verb = null, tail = '', dis = false, title = ''
      if (kind === 'write') { dis = !alive; title = alive ? '' : `${id} is down` }
      else if (kind === 'crash') { verb = alive ? 'Crash' : 'Restart'; dis = !alive && !gone }
      else if (kind === 'stop') {
        if (alive && leaving.has(id)) { verb = 'Stopping'; dis = true }
        else if (alive) verb = 'Ctrl-C'
        else { verb = 'Start'; tail = ' again'; dis = !gone }
      } else if (kind === 'cut') { verb = cut ? 'Heal' : 'Cut off'; dis = !alive }
      if (verb !== null && vEl) put(vEl, verb)
      if (tEl) put(tEl, tail)
      if (btn.disabled !== dis) btn.disabled = dis
      if ((btn.title || '') !== title) btn.title = title
    }
  }
  function nextFrom(id) {
    const pend = page.waiting(id)
    return nextMood(pend.length ? pend[pend.length - 1].value?.mood : moodOf(id))
  }
  // after a press the scripted visitor rests, so its own writes do not talk over what you just did; it comes back
  // by itself after a while on screen with no press
  let quietSince = null
  function hush() { if (page.writer.on) page.setWriter(false); quietSince = pt }
  let visitorDepth = 0
  const asVisitor = (fn) => { visitorDepth++; try { return fn() } finally { visitorDepth-- } }
  ctl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-do]')
    if (!btn || btn.disabled) return
    if (story.active) finish('turn')
    nowEl.hidden = true
    const id = btn.dataset.id, kind = btn.dataset.do
    asVisitor(() => {
      if (kind === 'write') { if (page.alive(id)) page.write(id, ROW, { mood: nextFrom(id) }) }
      else if (kind === 'crash') page.alive(id) ? page.kill(id) : page.restart(id)
      else if (kind === 'stop') page.alive(id) ? page.leave(id) : page.restart(id)
      else if (kind === 'cut') page.isolated(id) ? page.reconnect(id) : page.isolate(id)
    })
    hush()
    dirty = true
  })

  // ── events: the state each one leaves is read at the event itself, then told by the narrator ─────────────────
  const queue = []
  const told = new Set()    // the causes the narrator gave, while they hold (a cause is said once, not per write)
  for (const t of ['write', 'commit', 'kill', 'restart', 'leave', 'left', 'cut', 'heal', 'view', 'reset', 'join']) {
    page.on(t, (v) => {
      const visitor = visitorDepth > 0, mine = story.mine > 0
      if (story.active && !mine && t !== 'commit' && t !== 'view') finish('turn')   // someone else acted: the story ends
      const e = { t, v, visitor, at: page.now }
      const c1 = C1()
      switch (t) {
        case 'reset': queue.length = 0; onReset(); break
        case 'write': track.set(v.id, { w: v, heldTold: false }); if (track.size > 40) track.delete(track.keys().next().value); break
        case 'kill': {
          leaving.delete(v); catching.delete(v); behindOnce.delete(v); killAt.set(v, page.now)
          e.wasOwner = page.owner(ROW) === v; e.voters = voters(page, v)
          e.prevCause = curCause; e.cause = holdCause(page, c1, ROW); curCause = e.cause?.key ?? null
          break
        }
        case 'restart': {
          catching.add(v); behindOnce.delete(v); e.wasLeft = wasLeft.delete(v)
          const vt = voters(page, v); e.inList = vt.members.includes(v); e.can = vt.can; e.rest = vt.rest
          break
        }
        case 'leave': leaving.add(v); break
        case 'left': {
          // core.js: a clean leave is in page.left; one that timed out is in page.down (it went like a crash)
          leaving.delete(v); catching.delete(v); e.clean = page.left.has(v)
          if (e.clean) wasLeft.add(v); else killAt.set(v, page.now)
          e.rest = servers().filter((m) => m !== v && connected(m))
          e.prevCause = curCause; e.cause = holdCause(page, c1, ROW); curCause = e.cause?.key ?? null
          break
        }
        case 'cut': case 'heal': {
          // isolate and reconnect cut or heal one link at a time: tell each process once, when it is cut off from
          // every other one, and once when it is back
          for (const x of v) {
            if (t === 'cut' && !iso.has(x) && page.alive(x) && page.isolated(x)) {
              iso.add(x); cutAt.set(x, page.now)
              const prevCause = curCause, cause = holdCause(page, c1, ROW); curCause = cause?.key ?? null
              queue.push({ t: 'iso', v: x, visitor, at: page.now, wasOwner: page.owner(ROW) === x, voters: voters(page, x), prevCause, cause })
            } else if (t === 'heal' && iso.has(x) && !page.isolated(x)) {
              iso.delete(x); cutAt.delete(x)
              if (page.alive(x)) { catching.add(x); behindOnce.delete(x) }
              queue.push({ t: 'back', v: x, visitor, at: page.now })
            }
          }
          dirty = true
          return
        }
        case 'view': {
          e.owner = page.owner(ROW); e.prevOwner = curOwner; e.prev = curMembers
          const gone = curMembers ? curMembers.filter((m) => !v.members.includes(m)) : []
          e.gone = gone.map((id) => ({ id, t0: page.down.has(id) ? killAt.get(id) : (page.alive(id) && page.isolated(id)) ? cutAt.get(id) : null }))
          e.back = (curMembers ? v.members.filter((m) => !curMembers.includes(m)) : []).map((id) => ({ id, was: everMember.has(id) }))
          for (const m of v.members) everMember.add(m)
          curOwner = e.owner; curMembers = v.members.slice()
          break
        }
      }
      queue.push(e)
      dirty = true
    })
  }
  page.on('apply', () => { dirty = true })
  function onReset() {
    hops.length = 0; c1Writes.length = 0; track.clear(); leaving.clear(); wasLeft.clear(); catching.clear(); behindOnce.clear(); caughtAt.clear()
    killAt.clear(); cutAt.clear(); iso.clear(); everMember.clear(); told.clear(); rxAt.clear()
    curOwner = null; curMembers = null; lastPrimary = null; curCause = null
    for (const b of boxes.values()) { b.mood = null; b.freshAt = -1e9; b.behindSince = null }
    staticKey = ''
  }
  function everyCopy() {
    const off = order().filter((id) => page.alive(id) && page.isolated(id))
    const down = order().some((id) => !page.alive(id))
    if (off.length) return [', then to every copy but ', list(off), ', which ', off.length > 1 ? 'are' : 'is', ' cut off']
    return [down ? ', then to every live copy' : ', then to every copy']
  }
  // a cause the narrator tells: the sentence, and it is marked told while it holds
  function tellCause(c) { told.add(c.key); return c.key }
  // the owner's own words for a crash or a cut: it owns luna, so writes wait until the others vote it out (if they
  // can). When it is the only server left in the list there is nobody to vote: the client's own reason is told instead
  const ownerHeld = (vt, cause) => vt.can ? 'It owns luna, so writes wait until the others vote it out.'
    : vt.rest.length ? ['It owns luna, and ', cannotVote(vt.rest, 'out'), '. Writes wait; reads still work.']
    : cause ? causeParts(cause, 'writes') : 'It owns luna, and it is the only server in the list, so writes wait until it is back.'
  function narrate(e) {
    const c1 = C1()
    switch (e.t) {
      case 'reset': freshCafe = true; say(['A fresh café: ', words(servers().length), ' servers and ', clients().length === 1 ? 'a client' : `${words(clients().length)} clients`, ' start.'], 1); break
      case 'write': {
        if (!e.visitor) break
        const w = e.v, tr = track.get(w.id), cause = holdCause(page, w.node, ROW)
        if (cause) {
          if (tr) tr.heldTold = true
          say([N(w.node), ' writes ', assign(w.value), '. ', causeParts(cause)], 2, { cause: tellCause(cause), waits: true })
        } else say([N(w.node), ' writes ', assign(w.value), '. It goes to luna\'s owner first.'], 2)
        break
      }
      case 'commit': {
        const w = e.v, origin = String(w.stamp?.origin ?? '').split('~')[0]
        track.delete(w.id)
        if (!origin) break
        // a write the page made (a press, the story, a Break card) is always told; the scripted visitor's is routine
        const prio = w.by === 'page' ? 2 : 0, meta = { mood: w.value?.mood }
        const waited = (w.committedAt ?? e.at) - w.issuedAt
        if (waited > WAIT_SIM) say([N(w.node), '\'s waiting write landed, ', V(secs(waited)), ' after it was made (simulated time): ', OWNS(origin), ' took it', everyCopy(), '.'], Math.max(prio, 1), meta)
        else {
          // the server it went through: the first WRITE frame the client sent for it
          const via = c1Writes.find((f) => f.from === w.node && f.sentAt >= w.issuedAt)?.to
          say([N(w.node), ' wrote ', assign(w.value), '. It went ', via && via !== origin ? ['through ', N(via), ' '] : '', 'to ', OWNS(origin), ', luna\'s owner', everyCopy(), '.'], prio, meta)
        }
        break
      }
      case 'kill': {
        const id = e.v, parts = [N(id), ' crashed, like kill -9. ']
        let cause = null
        if (e.wasOwner) { parts.push(ownerHeld(e.voters, e.cause)); if (e.cause) cause = tellCause(e.cause) }
        else if (e.cause && e.cause.key !== e.prevCause) { parts.push(causeParts(e.cause, 'writes')); cause = tellCause(e.cause) }
        else parts.push('The others carry on, and every copy still serves reads.')
        say(parts, 2, { cause })
        break
      }
      case 'restart': {
        const id = e.v
        const parts = e.wasLeft ? [N(id), ' starts again from its disk and asks to join.'] : [N(id), ' restarts from its disk: its rows come back before it reaches anyone.']
        if (!e.inList && !e.can) parts.push(' ', cap(cannotVote(e.rest, e.wasLeft ? 'in' : 'back in')), '.')
        say(parts, 2)
        break
      }
      case 'leave': say([N(e.v), ' is stopping cleanly (Ctrl-C). It asks the others to vote it out.'], 2); break
      case 'left': {
        const id = e.v
        if (e.clean) say(e.rest.length ? [N(id), ' left by a vote; ', list(e.rest), e.rest.length > 1 ? ' carry on.' : ' carries on.'] : [N(id), ' left.'], 2)
        else {
          const fresh = e.cause && e.cause.key !== e.prevCause
          say([N(id), ' could not get its vote, so it stopped like a crash.', fresh ? [' ', causeParts(e.cause, 'writes')] : ''], 2, { cause: fresh ? tellCause(e.cause) : null })
        }
        break
      }
      case 'iso': {
        const id = e.v
        if (id === c1) { say([N(id), ' is cut off: it still reads its own copy, and its writes wait for the split to heal.'], 2, { cause: e.cause ? tellCause(e.cause) : null }); break }
        const parts = [N(id), ' is cut off. It keeps serving reads from its own copy.']
        let cause = null
        if (e.wasOwner) { parts.push(' ', ownerHeld(e.voters, e.cause)); if (e.cause) cause = tellCause(e.cause) }
        else if (e.cause && e.cause.key !== e.prevCause) { parts.push(' ', causeParts(e.cause, 'writes')); cause = tellCause(e.cause) }
        say(parts, 2, { cause })
        break
      }
      case 'back': say([N(e.v), ' is back on the network.'], 2); break
      case 'view': {
        if (!e.prev) break
        const ownerNow = e.owner !== e.prevOwner ? [' ', OWNS(e.owner), ' owns luna now.'] : ''
        for (const g of e.gone) if (g.t0 != null) say([list(e.v.members), ' voted ', N(g.id), ' out after ', V(secs(e.at - g.t0)), ' (simulated time).', ownerNow], 1)
        for (const b of e.back) say([N(b.id), b.was ? ' is back in the list of servers' : ' is in the list of servers now', e.owner === b.id && e.prevOwner !== b.id ? [', and owns luna', b.was ? ' again' : '', NB, STAR] : '', '.'], 1)
        break
      }
    }
  }
  function drainNarration(model) {
    while (queue.length) { const e = queue.shift(); if (!story.active) narrate(e) }
    // a cause that no longer holds may be told again if it comes back
    for (const k of told) if (k !== model.cause?.key) told.delete(k)
    // a restarted or healed copy whose data matches again (told only if it was behind)
    for (const id of catching) {
      const s = model.byId.get(id)
      if (!s || !s.alive) { catching.delete(id); behindOnce.delete(id); continue }
      if (s.behind || s.cut || s.starting) continue
      catching.delete(id)
      // only a copy that really fell behind "caught up" (one that missed nothing just agrees)
      if (behindOnce.delete(id)) { caughtAt.set(id, pt); say([N(id), ' caught up with the other copies.'], 1) }
    }
    const c1 = C1()
    if (story.active) { freshCafe = false; if (c1 && page.alive(c1)) lastPrimary = page.primary(c1) ?? lastPrimary; return }
    // a fresh café is "the same everywhere" only once every copy holds the rows
    if (freshCafe && model.view.epoch > 0 && model.of === boxes.size && model.agree === model.of && model.nodes.every((s) => !s.starting)) {
      freshCafe = false
      say(['Every copy is the same.'], 1, { append: /^A fresh café/.test(text(said.parts)) })
    }
    // a write held up: say why, once per cause
    const cause = model.cause
    for (const tr of track.values()) {
      if (tr.heldTold || tr.w.state !== 'pending' || model.now - tr.w.issuedAt <= WAIT_SIM) continue
      if (!cause) continue                                  // nothing in its way: it is just slow; look again later
      tr.heldTold = true
      // the line on screen gave this reason: add only that a write now waits (unless it says so, or is full);
      // the reason was given a moment ago: say only that it waits; else the reason, once
      if (said.causes.has(cause.key) && (said.waits || said.n < 3)) { if (!said.waits) say([N(tr.w.node), '\'s write is waiting.'], 1, { append: true, waits: true }) }
      else if (told.has(cause.key) && !said.causes.has(cause.key)) say([N(tr.w.node), '\'s write is waiting.'], 1, { waits: true })
      else say(causeParts(cause), 1, { cause: tellCause(cause), waits: true })
    }
    // the client moved to another server by itself
    if (c1 && page.alive(c1)) {
      const p = page.primary(c1)
      if (p && lastPrimary && p !== lastPrimary && !connected(lastPrimary) && connected(p)) say([N(lastPrimary), ' was ', N(c1), '\'s server, so ', N(c1), ' moved to ', N(p), ' by itself.'], 1)
      if (p) lastPrimary = p
    }
  }

  // the door: the driver's own plain-words log, the last few lines with their simulated time (read only while open)
  let logKey = ''
  function syncLog() {
    if (!door.open) return
    const last = page.log.slice(-8)
    const k = last.length + '|' + (last.at(-1)?.at ?? '') + '|' + (last.at(-1)?.text ?? '')
    if (k === logKey) return
    logKey = k
    logEl.replaceChildren(...last.map((l) => {
      const li = document.createElement('li'), at = document.createElement('span'), tx = document.createElement('span')
      at.className = 'at'; tx.className = 'tx'
      attest(at, `${fmt(l.at / 1000, 2)} s`, 'runtime')
      // a commit's stamp stays on one line, as 01's door keeps it ("view 3 · counter 4100 · n01")
      const line = plainLog(l.text), m = /^(.*?)(view \d+ · counter \d+ · \S+)$/.exec(line)
      if (m) { const st = document.createElement('span'); st.className = 'stamp'; attest(st, m[2], 'runtime'); tx.append(m[1], st); tx.setAttribute('data-attested', 'runtime') }
      else attest(tx, line, 'runtime')
      li.append(at, tx); return li
    }))
  }

  // ── the story ──────────────────────────────────────────────────────────────────────────────────────────────
  const story = { active: false, token: 0, mine: 0, drive: null, hold: null, skip: false, ended: false, step: 0, stepAt: 0 }
  const act = (fn) => { story.mine++; try { return fn() } finally { story.mine-- } }
  // while the story holds the clock, only what the step itself sent is drawn on its way: the simulated time the step
  // began (-Infinity while the clock runs, so every message shows)
  function heldSince() { return story.active && story.hold ? story.stepAt : -Infinity }
  function setStep(n) {
    story.step = n
    story.stepAt = page.now
    storyEl.dataset.step = String(n)
    storyEl.classList.toggle('playing', story.active)
    for (const li of steps) {
      const k = +li.dataset.step
      li.classList.toggle('on', k === n)
      li.classList.toggle('done', story.active && k < n)
      if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current')
    }
    // the phone's one-row copy of the step that is playing (the list itself has scrolled away)
    const li = steps.find((x) => +x.dataset.step === n)
    nowEl.classList.toggle('blank', !li)
    nowNo.textContent = li ? String(n) : ''
    nowT.replaceChildren(...(li ? [...li.querySelector('.t').childNodes].map((c) => c.cloneNode(true)) : []))
    if (n > 0) frameStory(false)
  }
  function uiPlaying(on, keepRow = false) {
    playBtn.hidden = on; nextBtn.hidden = !on; overBtn.hidden = !on
    // a story that ends keeps its (now blank) row, so the narrator and the boxes do not jump by themselves; the row
    // goes at the next press under the boxes
    nowEl.hidden = !on && !keepRow
    tagEl.hidden = on || !story.ended
    put(playLbl, story.ended ? 'Play it again' : 'Play the story')
    // once the story has run, Write luna is the one violet button: the story's button steps back
    playBtn.classList.toggle('primary', !story.ended)
    storyEl.classList.toggle('playing', on)
  }
  // ── keeping the story in view: on a wide screen the step list near the top when it starts; on a phone the step
  // that plays and the narrator at the top, at every new step, until the reader scrolls on their own ──────────
  let follow = false
  function frameStory(first) {
    if (!story.active) return
    const phone = PHONE.matches
    if (!first && (!phone || !follow)) return
    const el = phone ? nowEl : storyEl
    const y = Math.max(0, Math.round(el.getBoundingClientRect().top + scrollY - (phone ? 12 : 24)))
    if (Math.abs(scrollY - y) < 2) return
    window.scrollTo({ top: y, behavior: REDUCED ? 'auto' : 'smooth' })
  }
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
  const stopFollow = () => { follow = false }
  addEventListener('wheel', stopFollow, { passive: true, capture: true })
  addEventListener('touchmove', stopFollow, { passive: true, capture: true })
  addEventListener('keydown', (e) => { if (SCROLL_KEYS.has(e.key) && !e.target.closest?.('button, a, input, textarea, select, summary')) follow = false }, true)

  // run the clock until `until()` holds or `holdAt()` (a simulated time) is reached; resolves false on a timeout
  function drive({ rate = 1, until = () => false, holdAt = null, timeout = 3000 }) {
    storyEl.dataset.phase = 'run'
    return new Promise((resolve) => { story.drive = { rate, until, holdAt, deadline: page.now + timeout, resolve } })
  }
  function driveStep(dt) {
    const d = story.drive
    if (d.until()) { story.drive = null; d.resolve(true); return }
    const rate = story.skip ? Math.max(d.rate, 0.6) : d.rate
    let budget = Math.min(dt, 100) * rate
    const chunk = rate < 1 ? 4 : 17
    let guard = 0
    while (budget > 1e-6 && story.drive === d && guard++ < 64) {
      let ms = Math.min(budget, chunk)
      const h = d.holdAt ? d.holdAt() : null
      if (h != null) ms = Math.min(ms, Math.max(0, h - page.now))
      if (ms > 0) { page.advance(ms); budget -= ms }
      if ((h != null && page.now >= h - 1e-6) || d.until()) { story.drive = null; d.resolve(true); return }
      if (page.now >= d.deadline) { story.drive = null; d.resolve(false); return }
      if (ms <= 0) return
    }
  }
  function dwell(ms = DWELL) {
    if (story.skip) { story.skip = false; return Promise.resolve(true) }
    storyEl.dataset.phase = 'hold'
    // a box lit by a message sent before the step began goes out now, for good: the hold shows the step's own
    for (const [id, r] of rxAt) if (r.sentAt < story.stepAt) rxAt.delete(id)
    dirty = true
    return new Promise((resolve) => { story.hold = { left: ms, resolve } })
  }
  function holdStep(dt) {
    const h = story.hold
    h.left -= dt
    if (h.left <= 0 || story.skip) { story.skip = false; story.hold = null; h.resolve(true) }
  }
  function cancelWaits() {
    const d = story.drive, h = story.hold
    story.drive = null; story.hold = null
    d?.resolve(false); h?.resolve(false)
  }
  const healthy = () => page.ids().every((id) => page.alive(id) && !page.isolated(id)) && page.down.size === 0 && page.left.size === 0 &&
    page.cuts.size === 0 && page.view().members.length === page.serverIds.length
  const allAgree = () => { const c = page.copies(); return c.agree === c.of }
  const nonePending = () => page.ids().every((id) => !page.alive(id) || page.waiting(id).length === 0)
  const quietFor = (ms) => hops.every((h) => h.recvAt <= page.now - ms)
  const calm = () => page.isReady && healthy() && allAgree() && nonePending() && quietFor(600)
  const wordsIn = (parts) => JSON.stringify(parts).split(/\s+/).length
  const read = (parts) => Math.min(6500, Math.max(DWELL, wordsIn(parts) * 190))

  async function runStory(fresh) {
    const my = ++story.token
    cancelWaits()
    story.active = true; story.skip = false
    page.paused = true                       // the story drives the clock itself, and holds it while you read
    quietSince = null
    uiPlaying(true); setStep(0)
    follow = true; frameStory(true)
    act(() => page.setWriter(false))
    if (fresh || !healthy()) {
      act(() => page.reset())
      act(() => page.setWriter(false))       // a reset brings the scripted visitor back; the story needs it quiet
      sayStory(['A fresh café: ', words(servers().length), ' servers and ', clients().length === 1 ? 'a client' : `${words(clients().length)} clients`, ' start.'])
    } else sayStory(['Getting ready: letting anything in flight land.'])
    await drive({ rate: 1, until: calm, timeout: 5000 })
    if (story.token !== my) return
    syncTitles(true)
    const x = { c1: C1(), owner: page.owner(ROW) }
    x.heir = ownerWithout(x.owner)
    for (let i = 0; i < STEPS.length; i++) {
      if (story.token !== my) return
      for (const b of boxes.values()) b.freshAt = -1e9
      setStep(i + 1)
      await STEPS[i](x, my)
      if (story.token !== my) return
    }
    finish('done')
  }
  const live = (my) => story.token === my
  const STEPS = [
    // 1 · You write one line
    async (x, my) => {
      x.via = page.primary(x.c1); x.m0 = moodOf(x.c1); x.m1 = nextMood(x.m0)
      const tell = () => [N(x.c1), ' sets luna\'s mood with one line, ', assign({ mood: x.m1 }), '. The write heads for ', N(x.c1), '\'s server', x.via ? [', ', N(x.via)] : '', '.']
      sayStory(tell())
      x.w1 = act(() => page.write(x.c1, ROW, { mood: x.m1 }))
      const first = () => c1Writes.find((f) => f.from === x.c1 && f.sentAt >= x.w1.issuedAt)
      await drive({ rate: SLOW, holdAt: () => { const f = first(); return f ? f.sentAt + 0.55 * (f.recvAt - f.sentAt) : null }, timeout: 1500 })
      if (!live(my)) return
      // the server is the one the write really went to
      const f = first(); if (f && f.to !== x.via) { x.via = f.to; sayStory(tell()) }
      await dwell(read(tell()))
    },
    // 2 · It goes to the owner first
    async (x, my) => {
      const o = x.owner = page.owner(ROW)
      const still = [N(x.c1), '\'s own copy still says ', M(x.m0), '.']
      const t = x.via === o
        ? [OWNS(o), ' is ', N(x.c1), '\'s server and luna\'s owner: the one server that takes luna\'s writes first. ', still]
        : x.via ? [N(x.via), ' passes it on to ', OWNS(o), ', luna\'s owner: the one server that takes luna\'s writes first. ', still]
        : ['It goes to ', OWNS(o), ', luna\'s owner: the one server that takes luna\'s writes first. ', still]
      sayStory(t)
      await drive({ rate: SLOW, until: () => moodOf(o) === x.m1, timeout: 2000 })
      if (!live(my)) return
      await dwell(read(t))
    },
    // 3 · It reaches every copy, yours too
    async (x, my) => {
      const o = x.owner, others = servers().filter((id) => id !== o && connected(id))
      const relay = x.via && x.via !== o
      const head = relay ? [N(o), ' sends it to every copy: ', list(others), ', and through ', N(x.via), ' to ', N(x.c1), '.']
        : [N(o), ' sends it to every copy: ', list([...others, x.c1]), '.']
      sayStory(head)
      const ok = await drive({ rate: SLOW, until: () => x.w1.state === 'committed' && allAgree(), timeout: 3000 })
      if (!live(my)) return
      const c = page.copies()
      const add = ok ? ['All ', V(c.agree), ' copies say ', M(x.m1), ' now ', OK('✓')] : [V(c.agree), ' of ', V(c.of), ' copies have it so far.']
      const t = [head, ' ', add]
      sayStory(t, add)
      await dwell(read(t))
    },
    // 4 · Now crash the owner
    async (x, my) => {
      // the crash scene starts quiet: what step 3 sent lands first (a short cap), then its lines and glows go out
      const busy = () => page.inFlight().some((f) => f.kind === 'write' || f.kind === 'repl')
      if (busy()) await drive({ rate: 1, until: () => !busy(), timeout: QUIET_CAP })
      if (!live(my)) return
      clearWires(); story.stepAt = page.now
      x.victim = page.owner(ROW)
      act(() => page.kill(x.victim)); x.killAt = page.now
      const t = [OWNS(x.victim), ', luna\'s owner, crashes, like kill -9. The other copies keep serving reads.']
      sayStory(t)
      await drive({ rate: 1, until: () => true, timeout: 100 })
      if (!live(my)) return
      await dwell(read(t))
    },
    // 5 · A new write waits
    async (x, my) => {
      x.m2 = nextMood(x.m1)
      const before = x.via
      x.w2 = act(() => page.write(x.c1, ROW, { mood: x.m2 }))
      const t0 = [N(x.c1), ' writes ', assign({ mood: x.m2 }), '. luna\'s owner is down, so the write waits. Every copy still says ', M(x.m1), '.']
      sayStory(t0)
      const reached = () => c1Writes.find((f) => f.from === x.c1 && f.sentAt >= x.w2.issuedAt && f.recvAt <= page.now && connected(f.to))
      await drive({ rate: SLOW, until: () => !!reached(), timeout: 1500 })
      if (!live(my)) return
      const now = page.primary(x.c1)
      let t = t0
      if (before && now && now !== before) {
        t = [N(before), ' was ', N(x.c1), '\'s server, so ', N(x.c1), ' moved to ', N(now), ' by itself. Its write, ', assign({ mood: x.m2 }), ', waits: luna\'s owner is down.']
        sayStory(t)
      }
      await dwell(read(t))
    },
    // 6 · <heir> takes over, the write lands
    async (x, my) => {
      const v0 = page.view().members.filter((m) => m !== x.victim && connected(m))
      const head = ['Once their retries to ', N(x.victim), ' give up, ', list(v0), ' vote it out.']
      sayStory(head)
      let tv = null
      const voted = await drive({ rate: 1, until: () => !page.view().members.includes(x.victim), timeout: 9000 })
      if (!live(my)) return
      if (voted) tv = page.now
      await drive({ rate: SLOW, until: () => x.w2.state === 'committed' && allAgree(), timeout: 3000 })
      if (!live(my)) return
      const o = page.owner(ROW)
      // once the vote is in, one sentence in the past tense (it fits the narrator's three lines); the reason the vote
      // is quick here is the one 02 gives, word for word
      const t = tv !== null
        ? [list(page.view().members), ' voted ', N(x.victim), ' out after ', V(secs(tv - x.killAt)), ' of simulated time', WHY_QUICK, '. Now ', OWNS(o), ' owns luna',
          x.w2.state === 'committed' ? [', and the waiting write lands ', OK('✓')] : '.']
        : [head, ' They have not voted yet.']
      sayStory(t, tv !== null ? t : ['They have not voted yet.'])
      for (const e of heirEls) attest(e, o, 'runtime')
      await dwell(read(t))
    },
    // 7 · Restart <owner>, it catches up
    async (x, my) => {
      act(() => page.restart(x.victim))
      const head = [N(x.victim), ' starts again from its disk, with its rows from before the crash.']
      sayStory(head)
      const ok = await drive({ rate: SLOW * 1.6, until: () => page.view().members.includes(x.victim) && allAgree() && page.copies().of === page.ids().length, timeout: 6000 })
      if (!live(my)) return
      const o = page.owner(ROW)
      const add = ok
        ? ['It catches up and is back in the list of servers. Each row\'s owner is picked from that list, so luna goes back to ', OWNS(o), '.']
        : ['It is still catching up.']
      const t = [head, ' ', add]
      sayStory(t, add)
      await dwell(read(t))
    },
  ]
  function finish(why) {
    if (!story.active) return
    story.token++
    cancelWaits()
    story.active = false; story.ended = true; story.skip = false; follow = false
    page.paused = false
    act(() => page.setWriter(true))
    uiPlaying(false, true); setStep(0); storyEl.dataset.phase = why
    said = blank()
    if (why === 'done') say(['That is the story. Your turn: press a button below.'], 2)
    dirty = true
  }
  playBtn.addEventListener('click', () => { if (!story.active) runStory(story.ended) })
  overBtn.addEventListener('click', () => { if (story.active) { story.token++; cancelWaits(); story.active = false } runStory(true) })
  const skip = () => { story.skip = true; if (story.hold) { const h = story.hold; story.hold = null; story.skip = false; h.resolve(true) } }
  nextBtn.addEventListener('click', skip)
  nowNext.addEventListener('click', skip)

  // ── the one frame loop ─────────────────────────────────────────────────────────────────────────────────────
  let visible = false, dirty = true, lastNow = -1, lastWall = 0, model = null, modelPt = -1e9
  try {
    const io = (() => { try { return new IntersectionObserver(cb, { root: document, rootMargin: '160px' }) } catch { return new IntersectionObserver(cb, { rootMargin: '160px' }) } })()
    function cb(es) { for (const e of es) { visible = e.isIntersecting; if (visible) { dirty = true; geoDirty = true } } }
    io.observe(root)
  } catch { visible = true }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { geoDirty = true; dirty = true }).observe(fig)
  NARROW.addEventListener?.('change', () => { geoDirty = true; dirty = true })
  door.addEventListener('toggle', () => { logKey = ''; dirty = true })

  bindBoxes()
  { const v = page.view(); if (v.members.length) { curMembers = v.members.slice(); for (const m of v.members) everMember.add(m); curOwner = page.owner(ROW) } const c = C1(); if (c && page.alive(c)) lastPrimary = page.primary(c) }
  onFrame((wall) => {
    const dt = lastWall ? Math.min(100, wall - lastWall) : 16
    lastWall = wall
    if (!visible || document.hidden) return
    if (story.drive) driveStep(dt)
    const now = page.now, moved = now !== lastNow
    if (moved || (!page.paused && page.onScreen)) pt += dt
    if (story.hold) holdStep(dt)
    // the scripted visitor comes back quietly once you have left the buttons alone for a while
    if (quietSince !== null && !story.active && pt - quietSince > QUIET) { quietSince = null; if (!page.writer.on) page.setWriter(true) }
    if (page.serverIds.length + page.clientIds.length !== boxes.size) bindBoxes()
    if (geoDirty) measure()
    // read the kernel when it did something (an event, an apply), else at most every MODEL_MS while its clock runs
    if (dirty || (moved && pt - modelPt >= MODEL_MS) || pt - modelPt > 250) {
      lastNow = now; dirty = false; modelPt = pt
      model = computeModel()
      syncBoxes(model); syncButtons(); drainNarration(model); syncStats(model); syncTitles(false); syncLog()
    }
    drawWires(now, model)
  })
}
