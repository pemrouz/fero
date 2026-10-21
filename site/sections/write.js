// sections/write.js — 01 How a write travels: four step cards that follow the real writes of the shared cluster.
//
// What the cards show, and where it comes from (nothing is typed):
//  · one write of luna at a time (page.on('write')): the writer and the mood in card 1's code; in card 2 the server
//    that really stamped it (its own 'apply': the record's origin), or page.owner('luna') at rest; in card 3 every
//    other copy (page.ids()); in card 4 how many live copies hold that mood NOW (page.cell): always the live count;
//    in the door, luna's newest stamp among the live copies (page.stamp) and how many copies hold it.
//  · card 2's top line: the server the writer's WRITE frame really went to (page.on('frame')), or page.primary(c1)
//    at rest: "through n02, c1's server", or "straight from c1" when that server is luna's owner. It is always there,
//    so the card never changes height.
//  · a write that is held up turns card 2 amber, with the reason under it: the owner is down, has left or is cut off,
//    the writer's server is, or the owner cannot reach more than half of the servers (the kernel's write gate,
//    page.writable → 'minority').
//
// Two ways to tell a write, so the section rests between writes:
//  · LIT (a sweep): the cards light in order from the kernel's events: the 'write' event lights card 1, the owner's
//    'apply' card 2, the other copies' 'apply' (the writer's own is its 'commit') card 3, one copy at a time in the
//    order they really applied it, and every live copy holding it card 4. A write crosses the cluster in about a
//    quarter of a simulated second, so the lighting replays those events in their real order, never before they
//    happened, at least STEP_GAP apart so a reader can follow. Until card 4 lights, its count is dimmed and has no ✓
//    (it is live: the copies are usually there long before the story is). Lit: the first write after the cards come
//    into view, every write a reader made (the demo's buttons and story: w.by === 'page'), and otherwise at most one
//    write every SWEEP_SIM of simulated time.
//  · IN PLACE: every other write changes the values where they stand, with no lights, once its owner has taken it
//    (or once it is held up: then card 2 says why, and card 4 is dimmed with no ✓ until the write lands).
// The section renders once the cluster is ready, even off screen, then while it is on screen. The cluster's clock
// runs while it is on screen (page.watch).
import { page, attest, put, onFrame, REDUCED, stable } from '../cluster.js'
import { catSvg } from '../cats.js'

const root = document.getElementById('write')
if (root) init()

function init() {
  const ROW = 'luna', KEY = JSON.stringify([ROW])
  const STEP_GAP = 580    // wall ms: a card lights no sooner than this after the card before it
  const CHIP_GAP = 220    // wall ms between two copies lighting up in card 3
  const LAST_GAP = 420    // wall ms from the last copy lighting up to card 4
  const HOLD = 1500       // wall ms: the last card stays lit this long, then the cards rest
  const STALL = 6000      // wall ms: card 3 stops waiting for a copy that never answers (one cut off mid-trip)
  const WAIT_SIM = 500    // simulated ms: a write that has not reached its owner after this is held up: card 2 says so
  const SWEEP_SIM = 19000 // simulated ms: the scripted visitor's writes light the cards at most this often (every
                          // fourth write, at one write per 5 s); the others change the values in place
  const SPREAD_SIM = 1000 // simulated ms: a copy still without the write this long after its owner took it is behind
  const SVGNS = 'http://www.w3.org/2000/svg'

  const $ = (s) => root.querySelector(s)
  const steps = $('.wr-steps')
  const cards = [...root.querySelectorAll('.wr-step')], arrows = [...root.querySelectorAll('.wr-arrow')]
  const writerEl = $('[data-wr=writer]'), roleEl = $('[data-wr=role]'), moodEl = $('[data-wr=mood]')
  const viaLine = $('.wr-via'), downArrow = $('.wr-down')
  const ownChip = $('.wr-own .wr-chip'), ownerEl = $('[data-wr=owner]'), ownX = ownChip.querySelector('.x'), ownK = $('.wr-own-k'), whyEl = $('.wr-why')
  const fanSvg = $('.wr-fan-lines'), toEl = $('.wr-to')
  const resultEl = $('.wr-result'), catEl = $('.wr-cat'), bigEl = $('.wr-big'), nEl = $('[data-wr=n]'), ofEl = $('[data-wr=of]')
  const sayEl = $('[data-wr=say]'), noteEl = $('[data-wr=note]')
  const stampEl = $('[data-wr=stamp]'), snEl = $('[data-wr=sn]'), smEl = $('[data-wr=sm]')

  page.watch(root)

  // ── small helpers ──
  const isClient = (id) => page.clientIds.includes(id)
  const C1 = () => page.clientIds[0]
  const cut = (id) => page.alive(id) && page.isolated(id)
  // a server that left cleanly is in page.left; a crash, or a Ctrl-C whose vote timed out, is in page.down
  const leftOnly = (id) => page.left.has(id) && !page.down.has(id)
  const moodOf = (id) => { try { if (!id || !page.alive(id)) return null; const v = page.cell(id, ROW); return v && typeof v.mood === 'string' ? v.mood : null } catch { return null } }
  const stampOf = (id) => { try { return page.alive(id) ? page.stamp(id, ROW) ?? null : null } catch { return null } }
  const sameStamp = (a, b) => !!a && !!b && a.epoch === b.epoch && a.seq === b.seq && a.origin === b.origin
  const nodeOf = (lane) => String(lane ?? '').split('~')[0]
  const replay = (el, cls) => { if (REDUCED || !el) return; el.classList.remove(cls); void el.getBoundingClientRect(); el.classList.add(cls) }
  const setCls = (el, cls, on) => { if (el && el.classList.contains(cls) !== on) el.classList.toggle(cls, on) }
  // the hidden attribute, which an SVG element has no property for
  const show = (el, on) => { if (el && el.hasAttribute('hidden') === on) el.toggleAttribute('hidden', !on) }
  // a runtime value that may be absent: an attested element must never sit empty
  function attestOr(el, v, fallback = '…') {
    if (v === null || v === undefined || v === '') { if (el.hasAttribute('data-attested')) el.removeAttribute('data-attested'); put(el, fallback) }
    else attest(el, v, 'runtime')
  }
  // a line of words and process names; a name is attested (it comes from page.ids()). Rebuilt only when it changes.
  function words(el, parts) {
    const key = JSON.stringify(parts)
    if (el.__key === key) return
    el.__key = key
    el.replaceChildren(...parts.map((p) => {
      if (typeof p === 'string') return p
      const s = document.createElement('span'); s.className = 'nm'; attest(s, p.n, 'runtime'); return s
    }))
  }
  const N = (id) => ({ n: id })

  // ── the writes: `shown` is the one the cards tell; `next` is the newest one, until it is shown ────────────────
  // a write: { w, json, mood, writer, via, owner, ownerAt (wall ms), ownerSim, cid, got: Map(copy → wall ms it applied),
  //   sweep, step 0-4, stepAt, lit: [copy], litAt, done, away }. got keeps insertion order: the order the copies
  //   really applied the write.
  let shown = null, next = null
  let lastSweep = -Infinity   // page.now when the last lit sweep began
  let seen = false, fresh = false   // the cards are in the reader's view; they just came into it
  let visible = false               // the section is near the viewport: the loop draws it
  const tracked = () => (next ? (shown ? [shown, next] : [next]) : shown ? [shown] : [])
  const sweeping = (t) => !!t && t.sweep && !t.done

  page.on('write', (w) => {
    if (w.remove || !Array.isArray(w.path) || w.path.length !== 1 || w.path[0] !== ROW) return
    const mood = w.value && typeof w.value === 'object' && typeof w.value.mood === 'string' ? w.value.mood : null
    if (mood === null) return
    const t = { w, json: stable(w.value), mood, writer: w.node, via: null, owner: null, ownerAt: null, ownerSim: null, cid: null, got: new Map(),
      sweep: false, step: 0, stepAt: 0, lit: [], litAt: 0, done: false, away: false }
    // lit: the first write since the cards came into view, a write a reader made, or the first in SWEEP_SIM
    if (seen && !document.hidden && (w.by === 'page' || fresh || page.now - lastSweep >= SWEEP_SIM)) {
      t.sweep = true; lastSweep = page.now; fresh = false
      shown = t; next = null
    } else next = t
  })
  // the server the writer handed its write to: its latest WRITE frame for this write until the owner takes it (a
  // client whose server dies sends it again through its next one)
  page.on('frame', (f) => {
    if (f.verb !== 'WRITE') return
    for (const t of tracked()) if (t.ownerAt === null && f.from === t.writer && f.sentAt >= t.w.issuedAt) t.via = f.to
  })
  // a copy applied a record: is it this write? The same row and value, issued by the same node, and the same attempt
  // (the kernel's iss + cid: the first matching apply pins it), so two writes of one value are never mixed up
  page.on('apply', (a) => {
    if (a.key !== KEY) return
    const json = stable(a.value)
    const iss = typeof a.iss === 'string' && a.iss.includes('~') ? a.iss.slice(0, a.iss.lastIndexOf('~')) : null
    const cid = typeof a.iss === 'string' && a.cid != null ? a.iss + '#' + a.cid : null
    for (const t of tracked()) {
      if (json !== t.json || (iss !== null && iss !== t.writer)) continue
      if (t.cid !== null && cid !== null && t.cid !== cid) continue
      if (t.cid === null) t.cid = cid
      const origin = nodeOf(a.origin), at = performance.now()
      // the node that stamped it applies it first: that is the owner taking it
      if (a.node === origin) { if (t.ownerAt === null) { t.owner = origin; t.ownerAt = at; t.ownerSim = page.now } }
      else { if (!t.owner && origin) t.owner = origin; if (!t.got.has(a.node)) t.got.set(a.node, at) }
      return
    }
  })
  // the writer's own copy: its write committed (the kernel emits this as the record lands there)
  page.on('commit', (w) => {
    for (const t of tracked()) {
      if (w.id !== t.w.id || t.got.has(w.node) || w.node === nodeOf(w.stamp?.origin)) continue
      t.got.set(w.node, performance.now())
    }
  })
  page.on('reset', () => { shown = null; next = null; lastSweep = -Infinity; fresh = seen; noteKey = ''; lastStep = -1 })
  // draw as soon as the café is in and the servers have voted their first list (luna has an owner), even off screen,
  // and again off screen whenever the picture's shape changes, so the cards have their final shape before anyone
  // scrolls to them (a phone reader saw them grow while reading). These events are rare; on screen the loop draws.
  for (const ev of ['ready', 'view', 'kill', 'restart', 'leave', 'left', 'join', 'cut', 'heal', 'reset']) page.on(ev, () => { if (!visible) render() })

  // the copies this write still has to reach: every live copy but the owner, except one that is cut off
  const expected = (t) => page.ids().filter((id) => id !== t.owner && page.alive(id) && !page.isolated(id))
  const complete = (t) => t.ownerAt !== null && expected(t).every((id) => t.got.has(id))

  function light(t, k, now) {
    t.step = k; t.stepAt = now
    if (k >= 2) replay(arrows[k - 2], 'go')
    if (k === 4) replay(catEl, 'hop')
  }
  // the lighting: each card waits for its real event, and for STEP_GAP after the card before it
  function advance(now) {
    const t = shown
    if (!sweeping(t)) return
    if (t.step === 0) light(t, 1, now)
    if (t.step === 1 && t.ownerAt !== null && now - t.stepAt >= STEP_GAP) light(t, 2, now)
    if (t.step === 2 && t.got.size && now - t.stepAt >= STEP_GAP) { light(t, 3, now); t.lit.push(t.got.keys().next().value); t.litAt = now }
    if (t.step === 3) {
      const order = [...t.got.keys()]
      if (t.lit.length < order.length && now - t.litAt >= CHIP_GAP) { t.lit.push(order[t.lit.length]); t.litAt = now }
      const all = complete(t) && t.lit.length === order.length
      if ((all && now - t.litAt >= LAST_GAP) || now - t.stepAt >= STALL) { for (const id of order) if (!t.lit.includes(id)) t.lit.push(id); light(t, 4, now) }
    }
    if (t.step === 4 && now - t.stepAt >= HOLD) t.done = true
  }

  // ── card 3's fan: one line from the owner to every other copy ─────────────────────────────────────────────────
  const CH = 34, CGAP = 10, FW = 44
  let fanKey = '', fanBranches = []
  function drawFan(n) {
    const key = String(n)
    if (key === fanKey) return
    fanKey = key
    const H = Math.max(CH, n * CH + (n - 1) * CGAP), mid = H / 2
    fanSvg.setAttribute('viewBox', `0 0 ${FW} ${H}`)
    fanSvg.style.height = `${H}px`
    const kids = []
    fanBranches = []
    for (let i = 0; i < n; i++) {
      const y = CH / 2 + i * (CH + CGAP), x1 = FW - 7
      const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'br')
      const p = document.createElementNS(SVGNS, 'path')
      p.setAttribute('d', Math.abs(y - mid) < 0.5 ? `M3 ${mid}H${x1}` : `M3 ${mid}C${FW * 0.52} ${mid} ${FW * 0.42} ${y} ${x1} ${y}`)
      const h = document.createElementNS(SVGNS, 'path'); h.setAttribute('class', 'hd')
      h.setAttribute('d', `M${x1 - 1.5} ${y - 4.6}L${FW - 0.5} ${y}L${x1 - 1.5} ${y + 4.6}z`)
      g.append(p, h); kids.push(g); fanBranches.push(g)
    }
    const dot = document.createElementNS(SVGNS, 'circle'); dot.setAttribute('class', 'root'); dot.setAttribute('cx', '3'); dot.setAttribute('cy', String(mid)); dot.setAttribute('r', '3')
    fanSvg.replaceChildren(...kids, dot)
  }
  let chipKey = ''
  const chips = new Map()   // id → { li, x (its ✕), cls }
  function syncChips(ids) {
    const key = ids.join()
    if (key !== chipKey) {
      chipKey = key
      chips.clear()
      toEl.replaceChildren(...ids.map((id) => {
        const li = document.createElement('li'), nm = document.createElement('span'), r = document.createElement('span'), x = document.createElement('span')
        li.className = 'wr-chip'; nm.className = 'nm'; r.className = 'r'; x.className = 'badge x'; x.textContent = '✕'; x.hidden = true; x.setAttribute('aria-hidden', 'true')
        attest(nm, id, 'runtime')
        r.textContent = isClient(id) ? 'client' : 'server'
        li.append(nm, r, x)
        chips.set(id, { li, x, cls: '' })
        return li
      }))
      drawFan(ids.length)
    }
  }

  // ── why a write waits: read from the kernel, in the order a reader would look ──────────────────────────────────
  function whyWaiting(writer, owner, via) {
    if (!page.view().epoch) return null                      // before the first vote nothing is held
    if (writer && cut(writer)) return [N(writer), ' is cut off']
    if (owner && !page.alive(owner)) return [N(owner), leftOnly(owner) ? ' has left' : ' is down']
    if (owner && cut(owner)) return [N(owner), ' is cut off']
    if (via && via !== owner && !page.alive(via)) return [N(via), leftOnly(via) ? ' has left' : ' is down']
    if (via && via !== owner && cut(via)) return [N(via), ' is cut off']
    // the owner can be reached, but its write gate is shut: it cannot reach more than half of the list of servers
    let g = null
    try { g = owner && page.alive(owner) ? page.writable(owner) : null } catch { g = null }
    if (g && !g.open && g.reason === 'minority') return [N(owner), ' cannot reach more than half of the servers']
    if (g && !g.open && (g.reason === 'rejoining' || g.reason === 'stale-epoch')) return [N(owner), ' is catching up']
    return null
  }

  // ── what the cards show now ───────────────────────────────────────────────────────────────────────────────
  let noteKey = '', lastStep = -1
  function render() {
    const ringOwner = page.isReady ? page.owner(ROW) : ''
    if (!ringOwner) return
    const t = shown
    const lit = sweeping(t), step = lit ? t.step : 0
    const c1 = C1(), writer = t ? t.writer : c1
    // the write has not reached its owner yet (in place, it is shown this early only once it is held up)
    const pending = !!t && t.ownerAt === null && t.w.state === 'pending'
    const owner = (lit && t.owner) || ringOwner
    const mood = t ? t.mood : (moodOf(c1) ?? moodOf(owner))
    const via = writer && isClient(writer) && page.alive(writer) ? (((lit || pending) && t.via) || page.primary(writer)) : null
    const waiting = pending && page.now - t.w.issuedAt > WAIT_SIM && (!lit || step === 1)

    // the cards and the arrows between them
    if (step !== lastStep) {
      lastStep = step
      cards.forEach((c, i) => {
        setCls(c, 'on', step === i + 1); setCls(c, 'done', step > i + 1)
        if (step === i + 1) c.setAttribute('aria-current', 'step'); else c.removeAttribute('aria-current')
      })
      arrows.forEach((a, i) => setCls(a, 'on', step >= i + 2))
    }
    setCls(cards[1], 'wait', waiting)

    // 1 · you assign
    attestOr(writerEl, writer)
    put(roleEl, writer && !isClient(writer) ? 'server' : 'client')
    attestOr(moodEl, mood ? `'${mood}'` : null, "'…'")

    // 2 · the owner takes it: the line into it (always there), the owner, and while the write waits, why
    if (via && owner && via !== owner) words(viaLine, ['through ', N(via), ', ', N(writer), '\'s server'])
    else if (via && owner) words(viaLine, ['straight from ', N(writer)])
    setCls(viaLine, 'off', !(via && owner)); setCls(downArrow, 'off', !(via && owner))
    attestOr(ownerEl, owner)
    const ownDown = !!owner && page.down.has(owner)
    setCls(ownChip, 'down', ownDown); setCls(ownChip, 'gone', !!owner && leftOnly(owner)); setCls(ownChip, 'cut', !!owner && cut(owner))
    show(ownX, ownDown)
    put(ownK, waiting ? '◌ waiting' : 'owner of luna')
    setCls(ownK, 'wait', waiting)
    const why = waiting ? whyWaiting(writer, owner, via) : null
    if (why) words(whyEl, why)
    setCls(whyEl, 'off', !why)

    // 3 · it goes to every copy
    const others = page.ids().filter((id) => id !== owner)
    syncChips(others)
    others.forEach((id, i) => {
      const c = chips.get(id); if (!c) return
      const down = page.down.has(id), left = leftOnly(id)
      const got = lit && step >= 3 && t.lit.includes(id)
      const cls = ['wr-chip', got && 'got', down && 'down', left && 'gone', cut(id) && 'cut'].filter(Boolean).join(' ')
      if (cls !== c.cls) { c.cls = cls; c.li.className = cls }
      show(c.x, down)
      const br = fanBranches[i]
      if (br) { const on = got ? 'br on' : down || left ? 'br off' : 'br'; if (br.getAttribute('class') !== on) br.setAttribute('class', on) }
    })

    // 4 · it shows everywhere: how many live copies hold this mood, always the live count. Dimmed, with no ✓, until
    // the lit story reaches card 4, and while the write waits for its owner.
    const live = page.ids().filter((id) => page.alive(id))
    const n = live.filter((id) => moodOf(id) === mood).length, of = live.length
    const pre = lit ? step < 4 : pending
    const ok = !pre && n === of && of > 0
    attest(nEl, n, 'runtime'); attest(ofEl, of, 'runtime')
    setCls(resultEl, 'pre', pre); setCls(resultEl, 'ok', ok); setCls(bigEl, 'ok', ok)
    attestOr(sayEl, mood)
    if (catEl.dataset.mood !== (mood ?? '')) { catEl.dataset.mood = mood ?? ''; catEl.innerHTML = mood ? catSvg(mood) : '' }
    // the note: why a copy does not say it (down, left, cut off, catching up), once the count is shown; a copy is
    // catching up only once the write has had time to reach it
    const spreading = !!t && t.ownerAt !== null && t.ownerSim !== null && page.now - t.ownerSim < SPREAD_SIM && !complete(t)
    const notes = []
    if (!pre) {
      for (const id of page.ids()) {
        if (page.down.has(id)) notes.push(['neg', `${id} is down`])
        else if (leftOnly(id)) notes.push(['dim', `${id} has left`])
        else if (cut(id)) notes.push(['neg', `${id} is cut off`])
        else if (page.alive(id) && mood && moodOf(id) !== mood && !spreading && !lit) notes.push(['wait', `${id} is catching up`])
      }
    }
    // the door: luna's newest stamp among the live copies (the kernel's own, now), and how many copies hold it
    let best = null
    for (const id of live) { const s = stampOf(id); if (s && (!best || s.epoch > best.epoch || (s.epoch === best.epoch && s.seq > best.seq))) best = s }
    if (best) {
      attest(stampEl, `view ${best.epoch} · counter ${best.seq} · ${nodeOf(best.origin)}`, 'runtime')
      attest(snEl, live.filter((id) => sameStamp(stampOf(id), best)).length, 'runtime'); attest(smEl, live.length, 'runtime')
    }
    const nk = JSON.stringify(notes)
    if (nk !== noteKey) {
      noteKey = nk
      noteEl.replaceChildren(...notes.flatMap(([cls, text], i) => {
        const s = document.createElement('span'); s.className = cls; attest(s, text, 'runtime')
        return i ? [' · ', s] : [s]
      }))
    }
  }

  // ── on screen: the loop runs while the section is near the viewport; the cards are "seen" while they cross the
  // middle of it (the first write after that is lit) ─────────────────────────────────────────────────────────────
  const observe = (el, cb, rootMargin) => {
    if (typeof IntersectionObserver !== 'function') return false
    // root: document, as page.watch does, so the margins also hold inside a cross-origin frame (a hosted preview)
    let io
    try { io = new IntersectionObserver(cb, { root: document, rootMargin }) } catch { io = new IntersectionObserver(cb, { rootMargin }) }
    io.observe(el)
    return true
  }
  if (!observe(root, (es) => { for (const e of es) visible = e.isIntersecting }, '400px 0px')) visible = true
  if (!observe(steps, (es) => { for (const e of es) { if (e.isIntersecting && !seen) fresh = true; seen = e.isIntersecting } }, '-15% 0px -15% 0px')) seen = true
  if (page.isReady) render()
  onFrame((now) => {
    if (!visible || document.hidden) { if (sweeping(shown)) shown.away = true; return }
    // a lit write that landed while you were away is not replayed: the cards rest on its values
    if (shown?.away) { shown.away = false; if (sweeping(shown) && complete(shown)) shown.done = true }
    advance(now)
    // the newest write, in place: once its owner has taken it, or once it is held up; never in the middle of a sweep
    if (next && !sweeping(shown) && (next.ownerAt !== null || page.now - next.w.issuedAt > WAIT_SIM)) { shown = next; next = null }
    render()
  })
}
