// sections/argument.js — §01 The argument, on THE house cluster (cluster.js `page`).
//
// "run it ▸" posts the record `shop.data.gizmos = { stock: N }` becomes, as c1, to fero's kernel (page.write —
// one whole-row update). The tracker (./argument/track.js) then follows that one write by its bytes: c1's
// WRITE frame names the attempt (issuer + cid); every WRITE / WACK / RECORDS frame that carries it is decoded
// with kernel/codec.js (decode()); the first RECORDS frame names the stamp; each copy's `apply` of that stamp
// is the copy taking the write. The ladder is two confirm probes (page.probe) on the owner, answered by the
// kernel. Every printed digit is attested (runtime): nothing here is typed.
//
// SLOW MOTION. At the cluster's pace a write crosses the cluster in about 0.3 s of wall time: too fast to read.
// So the cards (and b's frame list) PLAY BACK the visitor's write on their own clock (`e.show`, simulated ms): a quarter of the
// cluster's pace while a frame of the write's story is on the wire, four times its pace otherwise, and never
// ahead of the kernel (`page.now`). Every value shown is the kernel's value AT that simulated instant (frames by
// their send/arrival times, applies by their times, each copy's value from the apply trail), and every time
// printed is the kernel's. The head line says "slow motion" while the cards are behind the live cluster. The
// shared clock (page.speed, the dock's) is never touched. Under reduced motion there is no playback.
//
// a · five cards, ASSIGN → RECORD → OWNER → STAMP → EVERY COPY. At rest (no write of yours, or your last write
//     is done and the cluster has changed since) the cards show the row as the cluster holds it now.
// b · the same write as every frame it caused, top to bottom. At rest it shows one of the scripted writer's
//     writes (the shared cluster's c1 writes gadgets every 2.5 s of simulated time), pinned once shown.
import { page, attest, onFrame, REDUCED, decode, stable, CONFIRM, pair, REC, VNODES } from '../cluster.js'
import { nid, stamp as stampHTML, inspect, vt, esc } from '../ui.js'
import { tip } from '../lib/tools/debug/eli5.mjs'
import { createTracker } from './argument/track.js'

const root = document.getElementById('argument')
if (root) init(root)

function init(root) {
  const va = root.querySelector('[data-variant="a"]')
  const vb = root.querySelector('[data-variant="b"]')
  const $ = (id) => root.querySelector('#' + id)
  const T = createTracker(page, { decode, stable, CONFIRM, pair })
  const ROW = 'gizmos'
  const WHO = () => page.clientIds[0]
  // the values run it cycles through (input, like the data site's two alternating trade sizes); a value
  // equal to what c1 already holds is skipped, so every run changes the row
  const CYCLE = [12, 5, 9, 14, 6, 11, 4, 8]
  let ci = 0
  let cur = null    // the visitor's latest write (a tracker entry)
  let bPick = null  // b's rest state: one of the scripted writer's writes, pinned once shown
  let visible = false
  let hiddenAt = 0
  let dirty = true
  let lastPaint = 0
  let lastWall = 0
  let motion = !REDUCED // slow-motion playback of the visitor's write
  let topo = 0          // cluster changes seen (view, crash, restart, leave, cut, heal, join)
  const TYPE = Object.fromEntries(Object.entries(REC).map(([k, v]) => [v, k]))

  // ── honest printers: every element that may carry a digit is stamped data-attested="runtime" when filled ──
  const html = (el, s, tier = 'runtime') => {
    if (!el) return
    if (el.__h !== s) { el.innerHTML = s; el.__h = s }
    if (s) { if (el.getAttribute('data-attested') !== tier) el.setAttribute('data-attested', tier) }
    else el.removeAttribute('data-attested')
  }
  // words only (no digits): plain text, or markup with no figures in it
  const text = (el, s) => { if (!el) return; if (el.__h !== s) { el.textContent = s; el.__h = s } el.removeAttribute('data-attested') }
  const words = (el, s) => { if (!el) return; if (el.__h !== s) { el.innerHTML = s; el.__h = s } el.removeAttribute('data-attested') }
  const cls = (el, c, on) => { if (el && el.classList.contains(c) !== !!on) el.classList.toggle(c, !!on) }
  const hide = (el, on) => { if (el && el.hidden !== !!on) el.hidden = !!on }
  // one cached formatter (a fresh toLocaleString per number cost a third of b's paint); a no-break space keeps a
  // number on the line of its unit
  const NBSP = ' '
  const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
  const num = (v) => NF.format(v)
  const dur = (ms) => { const r = Math.round(ms); return r < 1000 ? `${num(r)}${NBSP}ms` : ms < 10000 ? `${(ms / 1000).toFixed(2)}${NBSP}s` : `${(ms / 1000).toFixed(1)}${NBSP}s` }
  const vtn = (ms) => vt(ms).replace(' ', NBSP)
  // a running wait, to a tenth of a second (the unit switches after rounding: never "1000 ms")
  const secs = (ms) => { const r = Math.round(ms); return r < 1000 ? `${num(r)}${NBSP}ms` : `${(ms / 1000).toFixed(1)}${NBSP}s` }
  const rel = (e, t) => `+${dur(Math.max(0, t - e.issuedAt))}`
  const times = (n) => (n === 1 ? 'once' : `${num(n)} times`)
  const sameStamp = (a, b) => !!a && !!b && a.epoch === b.epoch && a.seq === b.seq && a.origin === b.origin
  // the kernel's order (kernel/node.ts apply): epoch, then seq, then origin — the bigger stamp wins
  const cmpStamp = (a, b) => (a.epoch - b.epoch) || (a.seq - b.seq) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0)
  // a seed row's stamp: n01 applied the starting rows at boot, before any view (core.js HOUSE.seedFrom) — lede.js's test
  const isSeed = (s) => !!s && s.epoch === 0 && T.nodeOf(s.origin) === page.opts.seedFrom
  const valueHTML = (v) => (v === undefined ? '<span class="p">none</span>' : `<span class="rec">${inspect(v)}</span>`)
  const line = (row, value) => `shop.data<span class="tok-path">.${esc(row)}</span> =\n  <span class="rec">${inspect(value)}</span>`
  const typeN = (r) => `<span class="n" title="${esc(TYPE[r.type] ?? r.type)}">${esc(r.type)}</span>`
  const keyA = (r) => `<span class="p">[</span>${r.key.map((k) => `<span class="s">'${esc(k)}'</span>`).join('<span class="p">, </span>')}<span class="p">]</span>`
  const recLines = (r) => `<span class="rec"><span class="p">{ </span><span class="k">type</span><span class="p">:</span> ${typeN(r)}<span class="p">,</span>\n  <span class="k">key</span><span class="p">:</span> ${keyA(r)}<span class="p">,</span>\n  <span class="k">value</span><span class="p">:</span> ${inspect(r.value)}<span class="p"> }</span></span>`
  const recOne = (r) => `<span class="rec"><span class="p">{ </span><span class="k">type</span><span class="p">:</span> ${typeN(r)}<span class="p">, </span><span class="k">key</span><span class="p">:</span> ${keyA(r)}${r.type === REC.remove ? '' : `<span class="p">, </span><span class="k">value</span><span class="p">:</span> ${inspect(r.value)}`}<span class="p"> }</span></span>`
  const attemptHTML = (issuer, cid, epoch) => `<span class="rec" title="the attempt: who issued the write (with its life), its number, and the view it was sent in (0 marks a client's write). The owner uses it to spot a resend."><span class="p">attempt { </span><span class="k">issuer</span><span class="p">:</span> <span class="s">'${esc(issuer)}'</span><span class="p">, </span><span class="k">cid</span><span class="p">:</span> <span class="n">${esc(cid)}</span><span class="p">, </span><span class="k">epoch</span><span class="p">:</span> <span class="n">${esc(epoch)}</span><span class="p"> }</span></span>`
  // the debugger's glossary (lib/tools/debug/eli5.mjs), quoted word for word — only the sentences that fit the row
  const gloss = (key, n = Infinity) => { const d = tip(key)?.d ?? ''; const s = d.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [d]; return s.slice(0, n).join('').trim() }
  const T_ = (key, n) => esc(gloss(key, n))
  // what the owner does with a resend (kernel/write.ts writeDup), said as what happens, never as a promise: the
  // duplicate check works over a bounded window (facts §5: no "exactly-once")
  const RESEND_TIP = 'The same attempt, sent again. If the owner has stamped it already, it knows the attempt by its number and sends back the stamp it gave.'
  const lost = (e) => !!e && !e.stamp && T.issuerGone(e) && !T.reached(e)

  // ── the slow-motion clock ───────────────────────────────────────────────────────────────────────────────
  const SLOW = 0.25 // a frame of the write's story on the wire: a quarter of the cluster's pace
  const FAST = 4    // nothing of the story on the wire (a hold, a vote): catch up with the cluster
  // credits(e): which RECORDS frame each copy took the write from — the FIRST frame, in send order, that landed
  // at the instant the node applied the stamp (a FIFO link lands a re-ship right behind the live frame at the
  // same instant; only the first one is taken, the node drops the second)
  function credits(e) {
    if (e._cr && e._cr.n === e.frames.length && e._cr.a === e.applies.size) return e._cr.map
    const map = new Map()
    const claimed = new Set()
    const recs = e.frames.filter((f) => f.verb === 'RECORDS').sort((a, b) => a.sentAt - b.sentAt || a.n - b.n)
    for (const f of recs) {
      if (claimed.has(f.to)) continue
      const took = e.applies.get(f.to)
      if (took && Math.abs(took.at - f.recvAt) < 1e-6) { map.set(f.n, f.to); claimed.add(f.to) }
    }
    e._cr = { n: e.frames.length, a: e.applies.size, map }
    return map
  }
  // the story frames: each hop's first WRITE, each route's first receipt, and the RECORDS frame each copy took
  function storyOnWire(e, t) {
    const cr = credits(e)
    for (const f of e.frames) {
      if (f.sentAt > t || f.recvAt <= t) continue
      if ((f.first && f.kind !== 'repl') || cr.has(f.n)) return true
    }
    return false
  }
  function advanceShow(e, dt, wall) {
    if (!e) return
    const live = page.now
    // no playback, nothing left to play, or the write is done on the cards: show the live cluster
    if (!motion || !e.mine || e.closed || e.show == null || e.show >= live || doneShown(e, e.show)) { e.show = live; return }
    // off screen for a while: nobody is watching, so the playback ends (a one-frame flicker of the observer, as a
    // resize gives, must not end it)
    if (!visible && wall - hiddenAt > 400) { e.show = live; return }
    if (page.paused || !visible) return
    const pace = Math.max(1, page.speed)
    e.show = Math.min(live, e.show + dt * pace * (storyOnWire(e, e.show) ? SLOW : FAST))
  }
  const shown = (e) => (e && e.show != null ? Math.min(e.show, page.now) : page.now)
  const replaying = (e) => !!e && motion && e.mine && e.show != null && e.show < page.now - 0.5
  const doneShown = (e, t) => e.doneAt != null && t >= e.doneAt
  const busy = () => !!cur && !lost(cur) && !doneShown(cur, shown(cur))
  // after the write is done, a change to the cluster (a new view, a crash, a cut…) sends the cards back to the
  // live row: the last write's owner and stamp are history once the cluster has moved on
  const stale = (e) => e.topoAtDone != null && topo !== e.topoAtDone
  // what a node held at simulated instant t of the write: its last apply to the row at or before t
  function heldAt(e, id, t) {
    const b = e.before.get(id)
    let out = { value: b?.value, stamp: b?.stamp ?? null }
    for (const a of e.trail) { if (a.at > t) break; if (a.node === id) out = a }
    return out
  }

  // what plays the write back: the five cards in a, the frame list in b
  const PLAYS = { a: 'the cards play', b: 'the list plays' }
  const where = (replay, variant) => {
    const v = page.view()
    const plays = PLAYS[variant]
    return `seed <b>${esc(page.seed)}</b> · view <b>${esc(v.epoch)}</b> · <b>${esc(vtn(page.now))}</b> on the simulated clock` +
      (replay ? ` · <span class="arg-slow" title="${plays[0].toUpperCase() + plays.slice(1)} this write slowly while its frames are on the wire, at a quarter of the cluster's pace, then catch up. Every time shown is the kernel's, on the simulated clock.">slow motion</span>` : '') +
      (page.paused ? ' · <span class="waiting">paused</span>' : '')
  }

  // keyed list sync: unchanged rows keep their DOM (so a flash or a row-in animation runs to its end); returns how
  // many rows were added
  function sync(container, items, tag = 'div', onEnter) {
    const have = new Map()
    for (const el of container.children) have.set(el.__k, el)
    let i = 0, added = 0
    for (const it of items) {
      let el = have.get(it.key)
      const isNew = !el
      if (isNew) { el = document.createElement(tag); el.__k = it.key; added++ }
      have.delete(it.key)
      const c = it.cls
      if (el.__c !== c) { el.className = c + (el.classList.contains('new') ? ' new' : ''); el.__c = c }
      if (el.__h !== it.inner) { el.innerHTML = it.inner; el.__h = it.inner }
      if (it.attrs) for (const [k, v] of Object.entries(it.attrs)) if (el.getAttribute(k) !== v) el.setAttribute(k, v)
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null)
      if (isNew && onEnter) onEnter(el, it)
      i++
    }
    for (const el of have.values()) el.remove()
    if (items.length) { if (container.getAttribute('data-attested') !== 'runtime') container.setAttribute('data-attested', 'runtime') }
    else container.removeAttribute('data-attested')
    return added
  }
  // a changed value flashes (data's cellflash) through the Web Animations API: no forced layout, restartable
  function flash(el) {
    if (REDUCED || !el || !el.animate) return
    el.animate([{ backgroundColor: 'var(--accent)', color: 'var(--accent-ink)' }, { backgroundColor: 'transparent' }], { duration: 600, easing: 'ease-out' })
  }
  // a busy button stays focusable (aria-disabled, never `disabled`): a keyboard user keeps their place, and run()
  // ignores a press while the write is busy
  const setBusy = (btn, off) => { const v = off ? 'true' : 'false'; if (btn && btn.getAttribute('aria-disabled') !== v) btn.setAttribute('aria-disabled', v) }

  function nextValue() {
    const who = WHO()
    const held = who && page.alive(who) ? page.cell(who, ROW) : undefined
    for (let k = 0; k < CYCLE.length; k++) {
      const v = CYCLE[(ci + k) % CYCLE.length]
      if (!held || typeof held !== 'object' || held.stock !== v) return { v, k }
    }
    return { v: CYCLE[ci % CYCLE.length], k: 0 }
  }

  // ── the one action: posting the record the assignment becomes (a UI handler, logged by page.write) ──
  function run() {
    const who = WHO()
    if (!page.isReady || !who || !page.alive(who) || busy()) return
    const { v, k } = nextValue()
    let w
    try { w = page.write(who, ROW, { stock: v }) } catch (err) { console.warn('argument: write refused', err); return }
    ci += k + 1
    cur = T.track(w, { probes: true, mine: true })
    cur.show = cur.issuedAt // the playback starts at the assignment
    dirty = true // painted in the next animation frame, like every other change
  }
  for (const b of [$('arg-run-a'), $('arg-run-b')]) b?.addEventListener('click', run)

  // b follows the scripted writer in the background, so its rest state is a real write
  page.on('write', (w) => { if (w.by === 'writer' && w.node === WHO()) T.track(w) })
  T.on(() => { dirty = true })
  page.on('reset', () => { cur = null; bPick = null; ci = 0; topo = 0; dirty = true })
  for (const ev of ['view', 'kill', 'restart', 'leave', 'left', 'cut', 'heal', 'join']) page.on(ev, () => { topo++; dirty = true })

  // pacing + visibility: the house cluster advances while this section is on screen (page.watch); paint only then
  page.watch(root)
  new IntersectionObserver((es) => { for (const x of es) { visible = x.isIntersecting; if (visible) dirty = true; else hiddenAt = performance.now() } }, { rootMargin: '120px' }).observe(root)
  for (const v of [va, vb]) v?.addEventListener('variantshow', () => { dirty = true })

  // the page's own frame loop (never a cluster callback): ask the owner once it has stamped, move the slow-motion
  // clock, then paint
  onFrame((wall) => {
    const dt = lastWall ? Math.min(100, wall - lastWall) : 16
    lastWall = wall
    if (cur && cur.stamp && !cur.asked) T.askProbes(cur)
    if (cur) advanceShow(cur, dt, wall)
    // the cluster changes counted from the moment the write is done on screen: marked here, not in a paint, so it
    // holds while the section is off screen or showing the other variant
    if (cur && cur.topoAtDone == null && doneShown(cur, shown(cur))) cur.topoAtDone = topo
    if (!visible) return
    if (dirty || replaying(cur) || wall - lastPaint > 250) paint()
  })

  const stats = { paints: 0, maxMs: 0, totalMs: 0, all: [], a: [], b: [] } // this section's own paint cost, read by tools/argument-drive.mjs
  function paint() {
    const t0 = performance.now()
    lastPaint = t0
    dirty = false
    let ta = 0
    if (va && !va.hidden) { paintA(); ta = performance.now() - t0 }
    const t1 = performance.now()
    if (vb && !vb.hidden) { paintB(); stats.b.push(performance.now() - t1); if (stats.b.length > 400) stats.b.shift() }
    if (ta) { stats.a.push(ta); if (stats.a.length > 400) stats.a.shift() }
    const ms = performance.now() - t0
    stats.paints++; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms
    stats.all.push(ms); if (stats.all.length > 400) stats.all.shift()
  }

  // ═════════════════════════════════════════════ a · five cards ═════════════════════════════════════════════
  const A = va && {
    where: $('arg-where-a'), cards: [...va.querySelectorAll('.arg-card')], arrows: [...va.querySelectorAll('.arg-arrow')],
    line: $('arg-line-a'), from: $('arg-from-a'), heldK: $('arg-held-k-a'), held: $('arg-held-a'), assignSub: $('arg-assign-sub-a'),
    rec: $('arg-rec-a'), frame: $('arg-frame-a'), type: $('arg-type-a'),
    owner: $('arg-owner-a'), ownerNote: $('arg-owner-note-a'), hops: $('arg-hops-a'),
    stamp: $('arg-stamp-a'), stampNote: $('arg-stamp-note-a'), beatsCell: $('arg-beats-cell-a'), beatsK: $('arg-beats-k-a'), beats: $('arg-beats-a'),
    atCell: $('arg-at-cell-a'), stamped: $('arg-stamped-a'),
    copies: $('arg-copies-a'), agree: $('arg-agree-a'), copiesNote: $('arg-copies-note-a'),
    btn: $('arg-run-a'), status: $('arg-status-a'), caption: $('arg-caption-a'), ladderNote: $('arg-ladder-note-a'),
    rungs: Object.fromEntries([...va.querySelectorAll('.arg-rung')].map((r) => [r.dataset.rung, { el: r, v: r.querySelector('.arg-rung-v'), t: r.querySelector('.arg-rung-t'), rest: r.querySelector('.arg-rung-v').textContent }])),
    owner0: null,
  }
  const STEP = { assign: 0, record: 1, owner: 2, stamp: 3, copies: 4 }
  // on a phone the five cards stack (~1,400px): run it moves above them, so the cards it lights are the ones below the
  // thumb, and the status line (with why a write waits) sits right beside the button
  if (A) {
    const run = A.btn.closest('.arg-run'), strip = $('arg-strip-a')
    const mq = matchMedia('(max-width: 760px)')
    const place = () => { if (mq.matches) { if (run.nextElementSibling !== strip) strip.before(run) } else if (strip.nextElementSibling !== run) strip.after(run); cls(run, 'above', mq.matches) }
    mq.addEventListener('change', place)
    place()
  }
  // the ring, in plain words (kernel/ring.ts; VNODES read from the kernel module, never typed)
  { const r = $('arg-ring-a'); if (r) r.title = `The ring: every server has ${VNODES} points on a circle. The row's name lands on the circle too, and the next server point after it names the owner. It is built from the committed view alone, so every server names the same owner without asking.` }

  // where the write is at simulated instant t: which card it is in, by the kernel's own timeline
  function stage(e, t) {
    if (!e) return null
    const first = e.hops[0]
    if (!first || t < first.sentAt) return 'assign'
    if (!e.stamp || t < e.stampAt) return first.recvAt <= t ? 'owner' : 'record'
    for (const [id, a] of e.applies) if (id !== e.ownerId && a.at <= t) return 'copies'
    return 'stamp'
  }
  // the owner the write is heading to at instant t: the stamper once it has stamped; during playback, the server
  // its relay forwarded it to (else the owner when it was issued); otherwise the committed view's owner now
  function ownerAt(e, t) {
    if (e && e.stamp && t >= e.stampAt) return e.ownerId
    if (e && replaying(e)) { let o = e.ownerAtIssue; for (const h of e.hops) if (h.sentAt <= t && h.from !== e.node) o = h.to; return o }
    return page.owner(ROW)
  }

  function paintA() {
    const live = page.now
    const who = WHO()
    const e = cur && !lost(cur) && !stale(cur) ? cur : null
    const t = e ? shown(e) : live
    const replay = replaying(e)
    html(A.where, where(replay, 'a'))
    const st = stage(e, t)
    const fin = !!e && doneShown(e, t)
    const stamper = e?.stamp && t >= e.stampAt ? e.ownerId : null
    const reason = e && !stamper ? T.waitReason(e) : null

    // where the write is now: its card lit, the cards it has not reached dimmed. EVERY COPY never dims (its old
    // values are the point: nothing shows early). A held write lights OWNER amber instead.
    A.cards.forEach((c, i) => {
      cls(c, 'lit', !!e && !fin && motion && i === STEP[st] && !(reason && i === STEP.owner))
      cls(c, 'wait', !!e && !fin && i > STEP[st] && i !== STEP.copies)
      cls(c, 'held', !!reason && i === STEP.owner)
    })
    A.arrows.forEach((a, i) => cls(a, 'lit', !!e && !fin && motion && i + 1 === STEP[st]))

    // ASSIGN
    const posted = e ? e.value : { stock: nextValue().v }
    html(A.line, line(ROW, posted))
    html(A.from, who ? `${nid(who)} · ${esc(page.role(who))}` : '')
    if (e) {
      text(A.heldK, 'was')
      html(A.held, valueHTML(e.before.get(e.node)?.value))
      html(A.assignSub, `posted at ${esc(vtn(e.issuedAt))}, simulated`)
    } else {
      text(A.heldK, 'now')
      html(A.held, who && page.alive(who) ? valueHTML(page.cell(who, ROW)) : '<span class="broken">down ✕</span>')
      // the status line beside run it says what the button posts; this card says where the value comes from
      words(A.assignSub, 'the page picks the next value from a fixed list')
    }

    // RECORD
    attest(A.type, `type ${REC.update} is an update; the owner adds the stamp`)
    const rf = e && e.recordFrame && t >= e.recordFrame.sentAt ? e.recordFrame : null
    if (rf) {
      html(A.rec, recLines(rf.rec))
      const more = rf.count > 1 ? ` · ${num(rf.count)} records` : ''
      html(A.frame, `<span title="${T_('jk:writeForward')}">WRITE</span> · ${num(rf.size)}${NBSP}B${more}`)
    } else {
      html(A.rec, recLines({ type: REC.update, key: [ROW], value: posted }))
      // a write stuck at its issuer (cut off, cut from its server, no server) is not "leaving" it: OWNER and the status say why
      if (e && !(reason && stuckAtIssuer(e, reason))) html(A.frame, `leaving ${esc(e.node)}…`)
      else text(A.frame, 'not sent yet')
    }

    // OWNER
    const owner = ownerAt(e, t)
    const ownerDown = !!owner && page.down.has(owner)
    const moved = !!(stamper && e.ownerAtIssue && e.ownerAtIssue !== stamper)
    html(A.owner, owner ? `${nid(owner, { owner: true })}${ownerDown ? ' <span class="broken">✕</span>' : ''}${moved ? `<span class="was">was ${esc(e.ownerAtIssue)}</span>` : ''}` : '<span class="arg-note">no view yet</span>')
    if (A.owner0 !== null && owner !== A.owner0) flash(A.owner)
    A.owner0 = owner
    if (reason) html(A.ownerNote, waitLong(reason))
    else if (owner) html(A.ownerNote, `owns ${esc(ROW)} in view${NBSP}${esc((stamper && e.viewAtStamp ? e.viewAtStamp : page.view()).epoch)}`)
    else text(A.ownerNote, 'the servers are still voting in their first view')
    cls(A.ownerNote, 'waiting', !!reason)
    sync(A.hops, ownerRows(e, t, owner, reason), 'span')

    // STAMP
    if (stamper) {
      const fresh = !fin || t - e.stampAt < 1500
      html(A.stamp, stampHTML(e.stamp).replace('class="stamp"', `class="stamp${fresh ? ' fresh' : ''}"`))
      text(A.stampNote, '')
      hide(A.beatsCell, false); hide(A.atCell, false)
      const old = e.before.get(e.ownerId)?.stamp ?? e.before.get(e.node)?.stamp
      words(A.beatsK, old && isSeed(old) ? 'beats the seed' : 'beats')
      A.beatsK.title = old && isSeed(old) ? `the starting row ${page.opts.seedFrom} wrote at boot, before the first vote` : 'the stamp the row held before'
      if (old) html(A.beats, stampHTML(old)); else text(A.beats, 'nothing: a new row')
      html(A.stamped, `${esc(rel(e, e.stampAt))} by ${esc(e.ownerId)}`)
    } else {
      // the stamp the row carries: now (at rest), or when the write was issued (in flight, not stamped yet)
      const s = e ? oldStamp(e) : heldStamp(owner)
      if (s) html(A.stamp, stampHTML(s)); else text(A.stamp, '')
      hide(A.beatsCell, true); hide(A.atCell, true)
      if (s && isSeed(s)) html(A.stampNote, `the seed: ${nid(T.nodeOf(s.origin))} wrote this row at boot, before the first vote. Since then, only the row's owner stamps it.`)
      else if (s && s.epoch >= 1 && T.nodeOf(s.origin) !== owner) html(A.stampNote, `${nid(T.nodeOf(s.origin))} stamped it in view${NBSP}${esc(s.epoch)}, when it owned the row. ${e ? 'The owner\'s new stamp' : 'The next write'} must beat it.`)
      else if (e) text(A.stampNote, 'held now; the owner\'s new stamp must beat it')
      else text(A.stampNote, s ? 'the next write must beat it' : 'no stamp yet')
    }

    // EVERY COPY
    syncCopies(e, t, owner, replay)
    text(A.copiesNote, stamper ? 'after the stamp' : '')
    const liveIds = page.ids().filter((id) => page.alive(id))
    const stampOf = (id) => (e && replay ? heldAt(e, id, t).stamp : page.stamp(id, ROW))
    const ref = stamper ? e.stamp : e ? oldStamp(e) : heldStamp(owner)
    const holding = ref ? liveIds.filter((id) => sameStamp(stampOf(id), ref)).length : 0
    const all = !!ref && holding === liveIds.length && liveIds.length > 0
    if (stamper) html(A.agree, `${num(holding)} of ${num(liveIds.length)} hold this stamp${all ? ' ✓' : ''}`)
    else if (e) html(A.agree, `${num(holding)} of ${num(liveIds.length)} still hold the old stamp`)
    else if (ref) html(A.agree, `${num(holding)} of ${num(liveIds.length)} hold this stamp${all ? ' ✓' : ''}`)
    else text(A.agree, '')
    cls(A.agree, 'agree-ok', all && (!e || !!stamper))
    cls(A.agree, 'waiting', !!e && !stamper)

    // the button + the status line
    const canRun = page.isReady && !!who && page.alive(who) && !busy()
    setBusy(A.btn, !canRun)
    const label = busy() ? (reason || T.cutOff(cur.node) ? 'waiting…' : 'in flight…') : (cur ? 'run again ▸' : 'run it ▸')
    if (A.btn.textContent !== label) A.btn.textContent = label
    html(A.status, e ? statusHTML(e, t, reason) : restStatus('a'))

    paintLadder(e, t, reason)
    captionClauses(A.caption, 'a')
  }

  // the stamp the row carried when the write was issued: the owner's copy then, else the issuer's own copy
  const oldStamp = (e) => e.before.get(e.ownerAtIssue)?.stamp ?? e.before.get(e.node)?.stamp ?? null
  // the stamp the row carries now: the owner's copy, or (owner down) the first live copy's
  function heldStamp(owner) {
    if (owner && page.alive(owner)) return page.stamp(owner, ROW) ?? null
    for (const id of page.ids()) if (page.alive(id)) { const s = page.stamp(id, ROW); if (s) return s }
    return null
  }

  // the caption says only what a reader of this section could not know from the screens above it: how the write
  // plays back here, and any link a fault has given another delay (02's "slow a link" slows c1's own link, the path
  // of this write, so the hop times grow). What the page runs and the links' usual delay are the centrepiece
  // caption's; they are not repeated here. Rebuilt only when its text changes; hidden when it has nothing to say.
  function captionClauses(cap, variant) {
    if (!cap) return
    let s = cap.querySelector('.arg-delay')
    if (!s) { cap.textContent = ''; s = document.createElement('span'); s.className = 'arg-delay'; cap.append(s) }
    const d = page.opts.delay
    const ms = (r) => `<b>${esc(r[0])}–${esc(r[1])}${NBSP}ms</b>`
    const play = motion ? `While a write's frames are on the wire, ${PLAYS[variant]} it at a quarter of the cluster's pace; every time shown is still the kernel's.` : ''
    const odd = [...oddLinks.values()].map((x) => `the link ${esc(x.a)} — ${esc(x.b)} takes ${x.delay ? ms(x.delay) : 'another time'} now`)
    const links = odd.length ? `${odd.length > 1 ? `${odd.slice(0, -1).join(', ')} and ${odd[odd.length - 1]}` : odd[0]}${d ? `; the others take ${ms(d)}` : ''}.` : ''
    const say = [play, links && links[0].toUpperCase() + links.slice(1)].filter(Boolean).join(' ')
    html(s, say)
    hide(cap, !say)
  }
  // links whose delay is not the house one, from the cluster's own fault events (a fault with no delay falls back to
  // the simulator's default, so it is named without a number)
  const oddLinks = new Map()
  page.on('fault', ([a, b, f]) => {
    const d = page.opts.delay, k = pair(a, b), fd = f?.delay
    if (fd && d && fd[0] === d[0] && fd[1] === d[1]) oddLinks.delete(k)
    else oddLinks.set(k, { a: a < b ? a : b, b: a < b ? b : a, delay: fd ?? null })
    dirty = true
  })
  page.on('reset', () => oddLinks.clear())
  // settle both captions before the section is first painted (under reduced motion there is no playback to explain)
  captionClauses($('arg-caption-a'), 'a'); captionClauses($('arg-caption-b'), 'b')

  // why a write waits, in plain words: the long form under OWNER, the short form in the status line
  function waitLong(r) {
    switch (r.code) {
      case 'owner-down': return `${esc(r.ids[0])} is down · waiting for the vote`
      case 'owner-cut': return `${esc(r.ids[0])} is cut off · waiting`
      case 'issuer-cut': return `${esc(r.ids[0])} is cut off · waiting until the cut heals`
      case 'cut': return `${esc(r.ids[0])} cannot reach ${esc(r.ids[1])} · waiting`
      case 'gate': return `${esc(r.ids[0])} takes no writes now (${esc(r.reason)}) · waiting`
      case 'no-server': return `${esc(r.ids[0])} has no server to send it to · waiting`
      case 'issuer-down': return `${esc(r.ids[0])} is down`
      default: return 'waiting'
    }
  }
  // the write never left its issuer: cut off, cut from its server, or no server to send it to
  function stuckAtIssuer(e, r) { return r.code === 'issuer-cut' || r.code === 'no-server' || (r.code === 'cut' && r.ids[0] === e.node) }
  function waitShort(r) {
    switch (r.code) {
      case 'owner-down': return `${esc(r.ids[0])} is down`
      case 'owner-cut': return `${esc(r.ids[0])} is cut off`
      case 'issuer-cut': return `${esc(r.ids[0])} is cut off`
      case 'cut': return `${esc(r.ids[0])} cannot reach ${esc(r.ids[1])}`
      case 'gate': return `${esc(r.ids[0])} takes no writes now`
      case 'no-server': return `${esc(r.ids[0])} has no server`
      case 'issuer-down': return `${esc(r.ids[0])} is down`
      default: return ''
    }
  }

  // why a write was sent again, read off the frames (kernel/write.ts): a relay passes on every resend that reaches
  // it (the client's retransmit re-enters its queue), and anyone resends when its last send's receipt is late
  const passedOn = (e, f) => e.frames.some((g) => g.kind === 'write' && g.from === e.node && g.to === f.from && Math.abs(g.recvAt - f.sentAt) < 1e-6)
  // does this receipt carry the write's stamp? A WACK answers a run of n attempts from cid c, stamped s, s+1, … in view
  // e (kernel/write.ts #ack). Checked, never assumed: a retry outside the owner's duplicate window is stamped again.
  const ackSame = (e, v) => !!e.stamp && !!e.att && !!v && v.e === e.stamp.epoch && v.s + (e.att.cid - v.c) === e.stamp.seq
  const hadReceipt = (e, f) => e.frames.some((g) => g.kind === 'ack' && g.to === f.from && g.recvAt <= f.sentAt)
  function refusal(e, f) {
    let prev = -Infinity
    for (const g of e.frames) if (g.kind === 'write' && g.from === f.from && g.sentAt < f.sentAt && g.sentAt > prev) prev = g.sentAt
    return e.frames.find((g) => g.kind === 'nack' && g.to === f.from && g.recvAt > prev && g.recvAt <= f.sentAt) ?? null
  }
  function againTitle(e, t) {
    let issuer = 0, own = 0, dup = 0, other = 0
    const pass = new Map()
    const relays = new Set()
    for (const f of e.frames) {
      if (f.sentAt > t || !f.again) continue
      if (f.kind === 'write') {
        if (f.from === e.node) issuer++
        else if (passedOn(e, f)) pass.set(f.from, (pass.get(f.from) ?? 0) + 1)
        else { own++; relays.add(f.from) }
      } else if (f.kind === 'ack' && f.from === e.ownerId) { if (ackSame(e, f.d.value)) dup++; else other++ }
    }
    const out = []
    if (issuer) out.push(`${e.node} sent it again ${times(issuer)}: no receipt had reached it yet.`)
    for (const [r, n] of pass) out.push(n === 1 ? `${r} passed one of those on again, when it reached ${r}.` : `${r} passed ${num(n)} of those on again, as each reached it.`)
    if (own) out.push(`${[...relays].join(' and ')} sent it again ${times(own)} itself: no receipt yet for its last send.`)
    if (dup) out.push(`The owner sent its receipt again ${times(dup)}, with the same stamp: it knew the attempt, so it did not stamp it twice.`)
    if (other) out.push(`The owner sent ${other === 1 ? 'a receipt' : `${num(other)} receipts`} with another stamp.`)
    return out.join(' ')
  }

  function ownerRows(e, t, owner, reason) {
    const items = []
    if (!e) {
      // at rest: who the next write goes through, and whether every server names the same owner
      const who = WHO()
      const prim = who && page.alive(who) ? page.primary(who) : null
      if (prim) items.push({ key: 'prim', cls: 'arg-hop', inner: `<b>${esc(who)}'s server</b><i>${esc(prim)}</i>`, attrs: { title: `${who} follows one server and hands it every write` } })
      const servers = page.serverIds.filter((id) => page.alive(id))
      if (servers.length && owner) {
        const named = servers.map((id) => [id, page.owner(ROW, id)])
        const same = named.filter(([, o]) => o === owner).length
        items.push({ key: 'ring', cls: 'arg-hop', inner: `<b>named by</b><i class="${same === servers.length ? 'agree-ok' : 'waiting'}">${num(same)} of ${num(servers.length)}${same === servers.length ? ' ✓' : ''}</i>`, attrs: { title: 'each server builds the ring from its own committed view and names an owner: ' + named.map(([id, o]) => `${id} → ${o}`).join(' · ') } })
      }
      return items
    }
    let last = null
    for (const h of e.hops) {
      if (h.sentAt > t) continue
      last = h
      const landed = h.recvAt <= t
      items.push({ key: h.from + '>' + h.to, cls: 'arg-hop' + (landed ? '' : ' pending'), inner: `<b>${esc(h.from)} → ${esc(h.to)}</b><i>${landed ? esc(rel(e, h.recvAt)) : 'in flight'}</i>`, attrs: { title: `landed this long after ${e.node}'s assignment, on the simulated clock. ` + gloss(h.from === e.node ? 'jk:writeForward' : 'jk:writeRelay') } })
    }
    if (reason && last && last.recvAt <= t) items.push({ key: 'held', cls: 'arg-hop held', inner: `<b>held at ${esc(last.to)}</b><i>${esc(secs(t - last.recvAt))}</i>`, attrs: { title: gloss('jk:writeBuffered', 1) } })
    let resent = 0
    for (const f of e.frames) if (f.kind === 'write' && f.again && f.sentAt <= t) resent++
    if (resent) items.push({ key: 'again', cls: 'arg-hop again', inner: `<b>sent again</b><i>×${num(resent)}</i>`, attrs: { title: againTitle(e, t) } })
    return items
  }

  function copyRows(e, t, owner, replay) {
    const ids = page.ids()
    const stamped = !!(e && e.stamp && t >= e.stampAt)
    const tookAt = (id) => { const a = stamped ? e.applies.get(id) : null; return a && a.at <= t ? a.at : Infinity }
    // the owner first, then each copy in the order it took the write
    const order = ids.slice().sort((a, b) => (a === owner ? -1 : b === owner ? 1 : (tookAt(a) - tookAt(b)) || ids.indexOf(a) - ids.indexOf(b)))
    const rest = !e ? heldStamp(owner) : null
    return order.map((id) => {
      const isOwner = id === owner
      if (!page.alive(id)) return { key: id, cls: 'arg-copy is-down', inner: `${nid(id, { owner: isOwner })}<span class="v"></span><span class="t">${page.left.has(id) ? 'left' : 'down ✕'}</span>`, attrs: { 'data-node': id } }
      const a = stamped ? e.applies.get(id) : null
      const took = !!(a && a.at <= t)
      const value = took ? a.value : (e && replay ? heldAt(e, id, t).value : page.cell(id, ROW))
      // cut off (T.cutOff, the hero's test): no record can reach it until the cut heals, so it says that, never "…"
      // (on its way) or "behind" (as if it were catching up). Read live, like down ✕.
      const cut = T.cutOff(id)
      let tt = '', c = 'arg-copy'
      if (!e) { const s = page.stamp(id, ROW); const same = sameStamp(s, rest); tt = cut ? 'cut off' : same ? '✓' : !s || (rest && cmpStamp(s, rest) < 0) ? 'behind' : 'ahead'; c += same ? ' holds' : ' old' }
      else if (took) { tt = id === e.ownerId ? 'stamped' : `+${dur(a.at - e.stampAt)}`; c += ' holds' }
      else if (cut) { tt = 'cut off'; c += id === e.node ? ' old waiting' : ' old' }
      else if (id === e.node) { tt = 'waiting'; c += ' old waiting' }
      else { tt = '…'; c += ' old' }
      if (cut && tt === 'cut off') c += ' cut'
      return { key: id, took, cls: c, inner: `${nid(id, { owner: isOwner })}<span class="v">${valueHTML(value)}</span><span class="t"${tt === 'cut off' ? ' title="every link to it is cut: it keeps serving its own copy, and no record reaches it until the cut heals"' : ''}>${tt}</span>`, attrs: { 'data-node': id } }
    })
  }
  // a copy's value flashes the moment it takes the write (once per write per node)
  const tookSeen = new Set()
  function syncCopies(e, t, owner, replay) {
    const rows = copyRows(e, t, owner, replay)
    sync(A.copies, rows, 'div')
    if (!e) return
    for (const r of rows) {
      const k = e.id + ':' + r.key
      if (r.took && !tookSeen.has(k)) { tookSeen.add(k); flash(A.copies.querySelector(`.arg-copy[data-node="${r.key}"] .v`)) }
    }
    if (tookSeen.size > 200) tookSeen.clear()
  }

  // rules broken since the write: DISTINCT monitors (sim/exec.ts records one violation per failing monitor per
  // event, so a rule that stays broken would otherwise be counted many times over)
  function rulesBroken(e) {
    const by = new Map()
    for (const v of page.sim.violations.slice(e.violations0)) by.set(v.monitor, (by.get(v.monitor) ?? 0) + 1)
    return by
  }
  function statusHTML(e, t, reason) {
    let n = 0, bytes = 0
    const by = {}
    for (const f of e.frames) { if (f.sentAt > t) continue; n++; by[f.verb] = (by[f.verb] ?? 0) + 1; bytes += f.size }
    const verbs = ['WRITE', 'RECORDS', 'WACK', 'WNACK'].filter((k) => by[k]).map((k) => `${k}${NBSP}${num(by[k])}`).join(`${NBSP}· `)
    const parts = [`<b>${num(n)}</b> frames carried it${verbs ? ` (${verbs})` : ''}${NBSP}· <b>${num(bytes)}</b>${NBSP}B`]
    if (reason) parts.push(`<span class="waiting">waiting ${esc(secs(Math.max(0, t - e.issuedAt)))}, simulated${waitShort(reason) ? `${NBSP}· ${waitShort(reason)}` : ''}</span>`)
    else if (e.stamp && t >= e.stampAt) {
      const live = page.ids().filter((id) => page.alive(id))
      const took = live.filter((id) => (e.applies.get(id)?.at ?? Infinity) <= t)
      if (took.length === live.length && took.length) parts.push(`assignment to the last copy <b>${esc(dur(Math.max(...took.map((id) => e.applies.get(id).at)) - e.issuedAt))}</b>, simulated`)
      else {
        // a cut-off copy cannot take it until the cut heals: name it, and say "so far" only while others are on their way
        const cut = live.filter((id) => !took.includes(id) && T.cutOff(id))
        const coming = live.length - took.length - cut.length
        parts.push(`on${NBSP}<b>${num(took.length)}</b>${NBSP}of${NBSP}${num(live.length)} copies${coming ? ' so far' : ''}`)
        // the last name and its verb wrap as one ("n01 is cut off" never splits after the name)
        if (cut.length) parts.push(`<span class="broken">${esc(cut.length > 1 ? `${cut.slice(0, -1).join(', ')} and ${cut[cut.length - 1]}` : cut[0])}${NBSP}${cut.length > 1 ? 'are' : 'is'}${NBSP}cut${NBSP}off</span>`)
      }
    } else parts.push('in flight')
    const broken = rulesBroken(e)
    const title = broken.size ? ` title="${esc([...broken].map(([m, k]) => `${m}: ${k} ${k === 1 ? 'time' : 'times'}`).join(' · '))}"` : ''
    parts.push(`<span class="${broken.size ? 'broken' : ''}"${title}>${num(broken.size)}</span>${NBSP}of${NBSP}${num(e.rules)}${NBSP}rules${NBSP}broken`)
    return parts.join(`${NBSP}· `) // a wrapped line ends on its dot, never starts with one
  }
  function restStatus(variant) {
    const who = WHO()
    // core.js restart() refuses a client: it has no disk to come back from, so it stays down until a reset. (Only
    // the console can crash c1: the dock and 02 crash servers.)
    if (!who || !page.alive(who)) {
      const what = cur && lost(cur) ? `${esc(cur.node)} went down before its write was stamped` : `${esc(who ?? 'the client')} ${who && page.left.has(who) ? 'has left' : 'is down'}`
      return `<span class="broken">${what}</span> · a client has no disk, so it cannot restart; ↺ reset brings it back`
    }
    const next = `<code>shop.data.${esc(ROW)} = ${esc(shortValue({ stock: nextValue().v }))}</code>`
    const tail = variant === 'a' ? 'the cards follow it through the cluster' : 'the list above then shows its frames'
    return `as ${esc(who)}, posts the record that ${next} becomes; ${tail}`
  }

  function paintLadder(e, t, reason) {
    const set = (name, state, s, tt = '') => {
      const r = A.rungs[name]
      cls(r.el, 'on', state === 'on'); cls(r.el, 'asking', state === 'asking'); cls(r.el, 'no', state === 'no')
      if (state === 'rest') text(r.v, r.rest)
      else html(r.v, s)
      if (tt) html(r.t, tt); else text(r.t, '')
    }
    if (!e) { for (const k of Object.keys(A.rungs)) set(k, 'rest'); text(A.ladderNote, 'three rungs a write can be waited for'); return }
    text(A.ladderNote, 'the page asks the owner once it stamps; the kernel answers · times from the assignment, simulated')
    const stamped = !!(e.stamp && t >= e.stampAt)
    if (stamped) set('committed', 'on', `<b>${esc(e.ownerId)}</b> stamped it`, esc(rel(e, e.stampAt)))
    else set('committed', 'asking', !reason ? 'on its way to the owner' : stuckAtIssuer(e, reason) ? `waiting: it has not left ${esc(e.node)}` : 'waiting for an owner that can stamp it')
    for (const [name, what] of [['replicated', 'hold it in their log'], ['persisted', 'have it on disk']]) {
      const p = e.probes[name]
      if (!stamped) { set(name, 'rest'); continue }
      if (!p || p.askedAt > t) { set(name, 'asking', `asking ${esc(e.ownerId)}…`); continue }
      if (p.ok === undefined || (p.at !== undefined && p.at > t)) {
        if (!page.alive(p.on)) set(name, 'no', `no answer: ${esc(p.on)} went down`)
        else set(name, 'asking', `asked ${esc(p.on)} at ${esc(rel(e, p.askedAt))}, waiting for proof`)
        continue
      }
      if (p.ok) set(name, 'on', `<b>${num(p.count)}</b> of ${num(p.members ?? p.count)} members ${what}`, esc(rel(e, p.at)))
      else set(name, 'no', `not proven: ${num(p.count)} members`)
    }
  }

  // ═════════════════════════════════════════════ b · follow the bytes ═════════════════════════════════════════
  const B = vb && { where: $('arg-where-b'), box: $('arg-bytes-b'), subject: $('arg-subject-b'), lanes: $('arg-lanes-b'), list: $('arg-frames-b'), rows: $('arg-frames-list-b'), btn: $('arg-run-b'), status: $('arg-status-b'), caption: $('arg-caption-b'), id: null, topped: null, lanesKey: '', atEnd: true, follow: false, progAt: 0 }
  // scrolling the list never reads layout inside a paint (a read there lays out every section's pending changes in the
  // middle of the frame). A ResizeObserver on the rows runs after the browser's own layout, where the reads are free:
  // it follows the newest frame while a write is in flight and the reader is at the end. A reader's own scroll says
  // whether they are at the end (a scroll the page makes itself is ignored).
  if (B) {
    const L = B.list
    new ResizeObserver(() => { if (B.follow && B.atEnd) { B.progAt = performance.now(); L.scrollTop = L.scrollHeight } }).observe(B.rows)
    L.addEventListener('scroll', () => { if (performance.now() - B.progAt < 80) return; B.atEnd = L.scrollHeight - L.scrollTop - L.clientHeight < 24 }, { passive: true })
  }

  // b's rest state: one of the scripted writer's writes, pinned so the tracker keeps it while it is shown
  function restPick() {
    if (bPick && T.entries.includes(bPick)) return bPick
    if (bPick) bPick.pinned = false
    bPick = T.latest((x) => !x.mine && !!x.stamp)
    if (bPick) bPick.pinned = true
    return bPick
  }

  function paintB() {
    const who = WHO()
    let e = cur && !lost(cur) ? cur : null
    if (!e) e = restPick()
    const t = e ? shown(e) : page.now
    html(B.where, where(replaying(e), 'b'))
    const lanes = page.ids()
    const lk = lanes.join(' ')
    if (B.lanesKey !== lk) {
      B.lanesKey = lk
      html(B.lanes, lanes.map((id) => `<span>${esc(id)}</span>`).join(''))
      B.lanes.style.gridTemplateColumns = `repeat(${lanes.length}, minmax(0, 1fr))`
      B.box.style.setProperty('--lanes', String(lanes.length))
    }
    const L = B.list
    if (!e) {
      html(B.subject, `${esc(who ?? 'the client')}'s next write shows here, frame by frame. Press <b>run it</b>, or wait for the scripted writer.`)
      sync(B.rows, [], 'li')
      B.follow = false
    } else {
      let whose
      if (e.mine) whose = 'your write'
      else {
        const newer = page.writes.filter((w) => w.by === 'writer' && w.node === e.node && w.issuedAt > e.issuedAt).length
        whose = newer ? `an earlier write from the scripted writer (${num(newer)} more since)` : 'the scripted writer\'s latest write'
      }
      html(B.subject, `${whose}: <code>shop.data.${esc(e.row)} = ${esc(shortValue(e.value))}</code> from ${nid(e.node)}, posted at <b>${esc(vtn(e.issuedAt))}</b>, simulated. Times below count from there.`)
      const fresh = B.id === e.id // rows that enter after the first paint of this write slide in
      sync(B.rows, frameRows(e, t, lanes), 'li', (el) => { if (fresh && !REDUCED) { el.classList.add('new'); el.addEventListener('animationend', () => el.classList.remove('new'), { once: true }) } })
      const fin = doneShown(e, t)
      B.follow = !fin // in flight: the observer follows the newest frame
      // a new write starts at its first frame; a finished one goes back to it, once (one scroll per write)
      if (!fresh) { B.id = e.id; B.topped = fin ? e.id : null; B.atEnd = true; B.progAt = performance.now(); L.scrollTop = 0 }
      else if (fin && B.topped !== e.id) { B.topped = e.id; B.progAt = performance.now(); L.scrollTop = 0 }
    }
    const canRun = page.isReady && !!who && page.alive(who) && !busy()
    setBusy(B.btn, !canRun)
    const reason = cur && e === cur && !(e.stamp && t >= e.stampAt) ? T.waitReason(e) : null
    const label = busy() ? (reason || T.cutOff(cur.node) ? 'waiting…' : 'in flight…') : (cur ? 'run again ▸' : 'run it ▸')
    if (B.btn.textContent !== label) B.btn.textContent = label
    html(B.status, cur && e === cur ? statusHTML(e, t, reason) : restStatus('b'))
    captionClauses(B.caption, 'b')
  }

  const shortValue = (v) => { try { return JSON.stringify(v).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ').replace(/^\{/, '{ ').replace(/\}$/, ' }') } catch { return String(v) } }

  // the route mark: one dot per lane, an arrow from sender to receiver (or a diamond on the owner for its stamp)
  const svgCache = new Map()
  function lanesSVG(lanes, from, to, mark) {
    const key = `${lanes.join(' ')}|${from}|${to}|${mark}`
    const hit = svgCache.get(key)
    if (hit) return hit
    const W = 16, n = lanes.length, w = n * W
    const x = (id) => (lanes.indexOf(id) + 0.5) * W
    let s = `<svg viewBox="0 0 ${w} 16" aria-hidden="true">`
    for (let i = 0; i < n; i++) s += `<circle class="lane-dot" cx="${(i + 0.5) * W}" cy="8" r="1.4"/>`
    if (mark && lanes.includes(mark)) s += `<rect class="lane-mark" x="${x(mark) - 3}" y="5" width="6" height="6" transform="rotate(45 ${x(mark)} 8)"/>`
    else if (lanes.includes(from) && lanes.includes(to)) {
      const x1 = x(from), x2 = x(to), dir = x2 > x1 ? 1 : -1
      s += `<line class="lane-line" x1="${x1}" y1="8" x2="${x2 - dir * 4}" y2="8"/><path class="lane-head" d="M${x2} 8 L${x2 - dir * 5} 4.8 L${x2 - dir * 5} 11.2 Z"/>`
    }
    s += '</svg>'
    if (svgCache.size > 96) svgCache.clear()
    svgCache.set(key, s)
    return s
  }

  function frameRows(e, t, lanes) {
    const cr = credits(e)
    const items = e.frames.filter((f) => f.sentAt <= t).sort((a, b) => a.sentAt - b.sentAt || a.n - b.n)
    // the stamp sits at its instant, ahead of the frames the owner sends at that same instant
    const seq = []
    let i = 0
    if (e.stamp && e.stampAt <= t) { while (i < items.length && items[i].sentAt < e.stampAt) seq.push(items[i++]); seq.push({ ev: 'stamp', at: e.stampAt }) }
    while (i < items.length) seq.push(items[i++])
    // fold a run of the issuer's own resends (same route) into one line
    const out = []
    for (let k = 0; k < seq.length; k++) {
      const f = seq[k]
      if (f.ev) { out.push(stampRow(e, lanes)); continue }
      let n = 1
      if (f.again && f.kind === 'write' && f.from === e.node) while (k + n < seq.length && seq[k + n].again && seq[k + n].kind === 'write' && seq[k + n].from === f.from && seq[k + n].to === f.to) n++
      const group = n > 2 ? seq.slice(k, k + n) : null
      out.push(frameRow(e, f, t, lanes, group, cr))
      if (group) k += n - 1
    }
    return out
  }

  function stampRow(e, lanes) {
    const sig = `${lanes.join(' ')}|${e.stampAt}`
    if (e._stampRow && e._stampRow.sig === sig) return e._stampRow.item
    const item = { key: 'ev-stamp', cls: 'arg-fr ev', inner: `<span class="arg-fr-lanes">${lanesSVG(lanes, null, null, e.ownerId)}</span><span class="arg-fr-t">${esc(rel(e, e.stampAt))}</span><span class="arg-fr-route">${esc(e.ownerId)}</span><span class="arg-fr-verb">stamps it</span><span class="arg-fr-size"></span><span class="arg-fr-what" title="${T_('jk:writeLocal', 1)}">${stampHTML(e.stamp).replace('class="stamp"', 'class="stamp fresh"')} <span class="note">the owner stamps the record; its own copy shows it now</span></span>` }
    e._stampRow = { sig, item }
    return item
  }

  // one row per frame, built once per state and cached (a row changes only when it lands, is credited, or grows)
  function frameRow(e, f, t, lanes, group, cr) {
    const flight = f.recvAt > t
    const credited = cr.get(f.n)
    const wr = group && !(e.stamp && t >= e.stampAt) ? T.waitReason(e) : null
    const sig = `${flight ? 1 : 0}|${credited ?? ''}|${group ? group.length + ':' + group[group.length - 1].recvAt : ''}|${wr ? wr.code + wr.ids.join(' ') : ''}|${lanes.join(' ')}|${e.applies.has(f.to) ? 1 : 0}|${e.stamp ? 1 : 0}`
    const cache = (e._rows ??= new Map())
    const c = cache.get(f.n)
    if (c && c.sig === sig) return c.item
    const d = f.d
    const tcol = group ? `${esc(rel(e, group[0].sentAt))} … ${esc(rel(e, group[group.length - 1].sentAt))}` : `${esc(rel(e, f.sentAt))} → ${flight ? '…' : esc(rel(e, f.recvAt))}`
    // the size column is one frame's size; a folded run shows its frames' size (the largest, if they differ) and its total
    // in the title — a total grows without bound while a write waits, and the status line sums the bytes anyway
    const gmax = group ? Math.max(...group.map((x) => x.size)) : 0
    const size = group ? `<span title="${esc(`${num(group.length)} frames, ${num(group.reduce((s, x) => s + x.size, 0))} B in all`)}">${group.every((x) => x.size === gmax) ? '' : '≤'}${num(gmax)}${NBSP}B</span>` : `${num(f.size)}${NBSP}B`
    let again = f.again
    let tipText = ''
    let what = ''
    if (f.verb === 'WRITE') {
      const r = d.recs.find((x) => x.origin === e.att.issuer && x.seq === e.att.cid) ?? d.recs[0]
      const att = attemptHTML(r.origin, r.seq, r.epoch)
      tipText = f.again ? RESEND_TIP : gloss(f.from === e.node ? 'jk:writeForward' : 'jk:writeRelay')
      if (group) what = `${att} <span class="note">the same attempt, sent again: no receipt yet${wr && waitShort(wr) ? ` (${waitShort(wr)})` : ''}</span>`
      else if (f.again && f.from === e.node) what = `${att} <span class="note">sent again: no receipt yet</span>`
      else if (f.again) {
        let why
        if (passedOn(e, f)) why = `${esc(e.node)}'s resend reached ${esc(f.from)}, so it passed it on again${hadReceipt(e, f) ? `; ${esc(f.from)} already had the receipt` : ''}`
        else { const nk = refusal(e, f); why = nk ? `sent again after ${esc(nk.from)} refused the last one (${esc(nk.d.value?.r ?? '')})` : 'sent again: no receipt yet for its last send' }
        what = `${att} <span class="note">${why}</span>`
      } else if (f.from === e.node) what = `${recOne(r)} ${att} <span class="note">no stamp yet</span>`
      else what = `${att} <span class="note">${esc(f.from)} sends it on to the owner</span>`
    } else if (f.verb === 'RECORDS') {
      const r = d.recs.find((x) => e.stamp && x.origin === e.stamp.origin && x.seq === e.stamp.seq) ?? d.recs[0]
      const took = e.applies.get(f.to)
      let note
      if (flight) note = 'on its way'
      // the node and its verb wrap as one ("n01 takes it" never splits after the name)
      else if (credited) note = credited === e.node ? `${esc(f.to)}${NBSP}takes${NBSP}it, and the write shows` : `${esc(f.to)}${NBSP}takes${NBSP}it`
      else if (!took || took.at > f.recvAt + 1e-6) note = `${esc(f.to)} does not take it on arrival`
      else { note = `the same record again: ${esc(f.to)} already had it`; again = true }
      tipText = again ? gloss('jk:aeShip', 1) : credited ? gloss('jk:applyInbound', 1) : ''
      const st = stampHTML({ epoch: r.epoch, seq: r.seq, origin: r.origin })
      const more = d.recs.length > 1 ? ` <span class="note">+${num(d.recs.length - 1)} more</span>` : ''
      what = again ? `${st}${more} <span class="note">${note}</span>` : `${recOne({ type: r.type, key: r.key, value: r.value })} ${st}${more} <span class="note">${note}</span>`
    } else if (f.verb === 'WACK') {
      // "the same" only when the receipt's bytes carry the write's stamp (ackSame)
      const same = ackSame(e, d.value)
      const note = f.again
        ? (f.from === e.ownerId ? (same ? 'the same receipt again, for a resend' : 'a receipt for a resend, with another stamp') : (same ? `the same receipt, passed on again to ${esc(f.to)}` : `a receipt with another stamp, passed on to ${esc(f.to)}`))
        : f.from === e.ownerId ? 'the owner\'s receipt, with the stamp it gave' : `the receipt, passed on to ${esc(f.to)}`
      tipText = gloss('jk:writeAck')
      what = `<span class="rec">${inspect(d.value)}</span> <span class="note">${note}</span>`
    } else if (f.verb === 'WNACK') {
      tipText = gloss('jk:writeNack')
      what = `<span class="rec">${inspect(d.value)}</span> <span class="note">refused (${esc(d.value?.r ?? '')}), so the sender tries again</span>`
    }
    const verb = `<span class="vb"${tipText ? ` title="${esc(tipText)}"` : ''}>${esc(f.verb)}</span>${group ? ` ×${num(group.length)}` : ''}`
    const item = { key: 'f' + f.n, cls: `arg-fr${again ? ' again' : ''}${flight ? ' flight' : ''}`, inner: `<span class="arg-fr-lanes">${lanesSVG(lanes, f.from, f.to)}</span><span class="arg-fr-t">${tcol}</span><span class="arg-fr-route">${esc(f.from)} → ${esc(f.to)}</span><span class="arg-fr-verb">${verb}</span><span class="arg-fr-size">${size}</span><span class="arg-fr-what">${what}</span>` }
    cache.set(f.n, { sig, item })
    return item
  }

  paint()
  // a handle for tools/argument-*.mjs: run() posts a write exactly as the button does; motion(false) turns the playback
  // off (the drive scripts step the shared clock by hand to shoot mid-flight states)
  window.__argument = { tracker: T, cur: () => cur, run, stats, motion: (on) => { motion = !!on && !REDUCED; if (cur) cur.show = page.now; dirty = true }, shown: () => (cur ? shown(cur) : page.now), replaying: () => replaying(cur) }
}
