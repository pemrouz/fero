// sections/break.js — 02 Break it: four cards, each with a Try it that does its thing to the shared `page` cluster
// (fero's real kernel in this tab), on the live café drawn in the demo above, then writes ONE live result line on
// the card from the kernel's own events: one short sentence, in a slot the card keeps for it (break.css), so a card
// never grows when its line fills. The longer telling is the demo narrator's.
//
// A Try it always does its thing. First it sets up its own start: whatever an earlier press (or the café's own
// buttons) left broken comes back — a server that is down or has left starts again from its disk, a cut-off one is
// healed — and the café settles: every server holds the newest list of servers with its writes open, every copy
// agrees, and no write waits. While it does, the line says what comes back ("n01 is down, so it comes back first.").
// Then it acts. A card's button is Try it, or this card's own way back while what it did still holds (Restart n01 ·
// Heal n03 · Start n02 again), never another card's. Every wait is on kernel events, with a timeout in simulated time.
//
// The demo's story holds the clock while it plays, and any action here ends the story. So when the story holds the
// clock and nothing needed fixing, a Try it acts at once instead of waiting on a clock that is not running.
//
// What each card reads (every name and number printed is attest(…, 'runtime')):
//  · Crash a server:    page.kill(luna's owner) and one write from c1 → the vote: page.view() without it, the new
//                       owner page.owner('luna'), the simulated ms from the crash; the write's commit (w.state).
//  · Cut one off:       page.isolate('n03') → its write gate closes (page.writable → { open: false }); it is still up
//                       and keeps its own copy, so it still serves reads.
//  · Restart from disk: page.restart(the server that is down or has left; if none, luna's owner crashes first while
//                       c1 changes luna's mood, and the others vote it out) → back from its own disk; at its FIRST
//                       frame (before it reached anyone) its copy matched the others' or not: "it had missed nothing"
//                       or "caught up".
//  · Stop it (Ctrl-C):  page.leave('n02') → the `left` event: clean when the driver put it in page.left; one that
//                       timed out is in page.down (it went like a crash, so it is down, and comes back as itself).
import { page, attest, onFrame, REDUCED } from '../cluster.js'

const root = document.getElementById('break')
if (root) init()

function init() {
  const ROW = 'luna'
  const LIMIT = { vote: 9000, write: 3000, gate: 3000, back: 8000, leave: 6000, settle: 12000 }   // simulated ms before a wait gives up
  page.watch(root)

  // ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────
  const servers = () => page.serverIds
  // one decimal and a no-break space, so a time never splits across two lines ("1.3 s")
  const secs = (ms) => `${(ms / 1000).toFixed(1)}\u00a0s`
  const moodOf = (id) => { try { return page.cell(id, ROW)?.mood ?? null } catch { return null } }
  const clientOf = () => page.clientIds.find((id) => page.alive(id)) ?? null
  const cycle = () => (page.writer?.cycle?.length ? page.writer.cycle : ['purring', 'playful', 'hungry', 'zoomies', 'sleepy', 'grumpy'])
  function nextMood(id) {
    const pend = page.waiting(id), cur = pend.length ? pend[pend.length - 1].value?.mood : moodOf(id)
    const c = cycle()
    return c[(c.indexOf(cur) + 1) % c.length]
  }
  // the server each picture names: Cut one off cuts n03, Ctrl-C stops n02
  const aimOf = (kind) => kind === 'cut' ? (servers().includes('n03') ? 'n03' : servers().at(-1)) : (servers().includes('n02') ? 'n02' : servers()[1])
  // the copy most of the others hold (alive, on the network, not `id`): what a server coming back has to match
  function othersHash(id) {
    const n = new Map()
    for (const x of page.ids()) if (x !== id && page.alive(x) && !page.isolated(x)) { const h = page.hash(x); n.set(h, (n.get(h) ?? 0) + 1) }
    let best = null, most = 0
    for (const [h, k] of n) if (k > most) { best = h; most = k }
    return best
  }

  // ── a line is parts: strings, or { n } a node name, { v } a number, STAR ─────────────────────────────────────
  // Every line is ONE short sentence that fits the card's one-line slot at 1440 (break.css keeps the slot, so a card
  // never grows when its line fills). The longest is the Crash line with c1's write (436 px of the 454 px there).
  const N = (id) => ({ n: id }), V = (v) => ({ v }), STAR = { star: 1 }
  // a time in a line: the café's clock is simulated, and the line says so ("1.2 s (simulated)")
  const T = (ms) => [V(secs(ms)), ' (simulated)']
  const and = (bits) => bits.length <= 1 ? bits : [...bits.slice(0, -1).flatMap((b, i) => (i ? [', ', b] : [b])), ' and ', bits[bits.length - 1]]
  const list = (ids) => and(ids.map(N))
  function render(el, parts) {
    const frag = document.createDocumentFragment()
    const add = (p) => {
      if (p == null || p === false || p === '') return
      if (Array.isArray(p)) { for (const q of p) add(q); return }
      if (typeof p === 'string') { frag.append(p); return }
      const s = document.createElement('span')
      if (p.n != null) { s.className = 'nm'; attest(s, p.n, 'runtime') }
      else if (p.v != null) { s.className = 'v'; attest(s, p.v, 'runtime') }
      else if (p.star) { s.className = 'star'; s.textContent = '★'; s.setAttribute('aria-hidden', 'true') }   // a glyph: seen, not read
      frag.append(s)
    }
    add(parts)
    el.replaceChildren(frag)
  }
  // the same parts as plain text, for a button's accessible name (the ★ is a glyph, not a word)
  const plain = (p) => p == null || p === false ? '' : Array.isArray(p) ? p.map(plain).join('') : typeof p === 'string' ? p
    : String(p.n ?? p.v ?? '')

  // ── the cards ──────────────────────────────────────────────────────────────────────────────────────────────
  const cards = []
  for (const el of root.querySelectorAll('.br-card[data-card]')) {
    const btn = el.querySelector('.br-go')
    // out: the line's slot (its tone is set here); words: the line itself, inside it
    cards.push({ kind: el.dataset.card, el, btn, label: el.querySelector('.br-go .br-label'), out: el.querySelector('.br-out'),
      words: el.querySelector('.br-out .br-line'), aria: btn.getAttribute('aria-label') || 'Try it', res: null, key: null, bkey: null })
  }
  const say = root.querySelector('#br-say')   // a quiet live region: a try's last line is told to screen readers here

  // ── the café, whole and settled: what every Try it starts from ─────────────────────────────────────────────
  const leaving = new Set()
  page.on('leave', (id) => leaving.add(id))
  page.on('left', (id) => leaving.delete(id))
  page.on('kill', (id) => leaving.delete(id))
  // whole: every server up, not leaving, and in the list of servers; no cut anywhere
  function whole() {
    if (!page.isReady || page.cuts.size) return false
    const v = page.view()
    return servers().every((id) => page.alive(id) && !leaving.has(id) && v.members.includes(id))
  }
  // settled: whole, every server linked to every other and holding the newest list itself with its writes open, every
  // copy agrees, no write waits. page.view() is the newest list ANY server holds; right after a vote one server can
  // hold it alone, and crashing that one then leaves the others unable to vote, so each server's own list is checked.
  function settled() {
    if (!whole()) return false
    const v = page.view(), ss = servers()
    for (const id of ss) {
      if (page.viewOf(id).epoch !== v.epoch || page.writable(id)?.open !== true) return false
      const peers = page.peers(id)
      if (!ss.every((o) => o === id || peers.includes(o))) return false
    }
    const c = page.copies()
    return c.agree === c.of && page.clientIds.every((id) => !page.alive(id) || page.waiting(id).length === 0)
  }
  // calm: settled for two heartbeats (HOLD ms of simulated time). A server back on the network still suspects the
  // others until its next heartbeat; a vote in that window can split, and a Ctrl-C then times out (seen in 5 of 120
  // runs after a short cut; none with the hold). Tracked on every tick, so a café that has long been calm acts at once.
  const HOLD = 250
  let calmSince = null
  page.on('tick', () => { if (!settled()) calmSince = null; else calmSince ??= page.now })
  const calm = () => calmSince !== null && page.now - calmSince >= HOLD && settled()
  // back: a server that came back holds the newest list, is in it, has its writes open, and its copy matches the others'
  function backOf(id) {
    const v = page.view()
    return page.viewOf(id).epoch === v.epoch && v.members.includes(id) && page.writable(id)?.open === true && page.hash(id) === othersHash(id)
  }
  // bring back everything that is broken: a server down or gone (but `skip`, which the caller brings back itself)
  // starts again from its disk, and every cut heals. Returns what it did, for the line.
  function fixAll(skip = null) {
    const did = []
    for (const id of servers()) if (id !== skip && (page.down.has(id) || page.left.has(id))) { did.push({ kind: page.left.has(id) ? 'left' : 'down', id }); page.restart(id) }
    for (const id of page.ids()) if (page.alive(id) && page.isolated(id)) { did.push({ kind: 'cut', id }); page.reconnect(id) }
    if (page.cuts.size) { for (const k of [...page.cuts]) { const [a, b] = k.split('|'); page.heal(a, b) } did.push({ kind: 'link' }) }
    return did
  }
  // what is broken at the press, and comes back first, in one line: "n01 is down, so it comes back first." ·
  // "n01 is down and n03 is cut off, so they come back first." Three or more (or a cut link beside a server) are
  // only named, so the line stays one line: "n01, n02 and n03 come back first."
  const IS = { down: ' is down', left: ' has left', cut: ' is cut off' }
  function told(did) {
    const seen = new Set(), ids = [], bits = []
    let link = false
    for (const d of did) {
      if (!d.id) { link = true; continue }
      if (seen.has(d.id)) continue
      seen.add(d.id); ids.push(d.id); bits.push([N(d.id), IS[d.kind]])
    }
    if (!ids.length) return link ? 'Part of the network is cut, so it heals first.' : ''
    if (link || ids.length > 2) return [list(ids), ids.length > 1 ? ' come back first.' : ' comes back first.']
    return [and(bits), ids.length > 1 ? ', so they come back first.' : ', so it comes back first.']
  }

  // ── waits on the kernel: a condition checked after every step of the simulated clock, or a simulated timeout.
  // A reset of the cluster ends every wait with null, and the try that waited stops there.
  let token = 0, busy = null, dirty = true
  const waits = new Set()
  function until(cond, ms) {
    const my = token
    return new Promise((resolve) => { waits.add({ my, cond, end: page.now + ms, resolve }); poll() })
  }
  function poll() {
    for (const w of [...waits]) {
      if (w.my !== token) { waits.delete(w); w.resolve(null); continue }
      let ok = false
      try { ok = !!w.cond() } catch { ok = false }
      if (ok || page.now >= w.end) { waits.delete(w); w.resolve(ok) }
    }
  }
  page.on('tick', poll)
  page.on('reset', () => {
    token++; poll(); busy = null; leaving.clear()
    for (const c of cards) c.res = null
    if (say) say.replaceChildren()
    hideBack(); dirty = true
  })

  function show(card, tone, line, fix = null) { card.res = { tone, line, fix }; dirty = true }

  // ── its own start: whatever is broken comes back, then the café settles. Resolves { did } (what came back), or
  // null when the try ends here (a reset; or the café never settled, which the line then says) ──────────────────
  async function setUp(card) {
    if (!(await leavesDone(card))) return null
    const did = fixAll()
    if (!did.length && page.paused && whole()) return { did }   // the story holds the clock: act now, which ends it
    if (!calm()) {
      show(card, 'run', () => (did.length ? told(did) : 'Waiting for every copy to agree…'))
      const r = await until(calm, LIMIT.settle)
      if (r === null) return null
      if (!r) { show(card, 'off', () => 'The café was still changing; try it again.'); return null }
    }
    return { did }
  }
  // a server still leaving (Ctrl-C) finishes first; then it has left, and comes back with the rest
  async function leavesDone(card) {
    const going = () => servers().filter((id) => page.alive(id) && leaving.has(id))
    if (!going().length) return true
    show(card, 'run', () => [list(going()), going().length > 1 ? ' are' : ' is', ' still leaving…'])
    return (await until(() => going().length === 0, LIMIT.leave)) !== null
  }
  // a card's own way back, while what it did still holds
  const wayBack = (id, label) => () => (page.down.has(id) || page.left.has(id) ? { label, run: (card) => comeBack(card, id) } : null)
  const wayHeal = (id) => () => (page.alive(id) && page.isolated(id) ? { label: ['Heal ', N(id)], run: (card) => heal(card, id) } : null)

  // ── the four tries ─────────────────────────────────────────────────────────────────────────────────────────
  const TRY = {
    // crash luna's owner, and make one write meanwhile: it waits, then lands once the others vote
    async crash(card) {
      const pre = await setUp(card); if (!pre) return
      const victim = page.owner(ROW), t0 = page.now, c1 = clientOf()
      page.kill(victim)
      if (c1 && page.waiting(c1).length === 0) { try { page.write(c1, ROW, { mood: nextMood(c1) }) } catch { /* c1 is down */ } }
      const ws = c1 ? page.waiting(c1) : []   // c1's writes that now wait for the vote: the new one, or one already on its way
      const fix = wayBack(victim, ['Restart ', N(victim)])
      show(card, 'run', () => [N(victim), ' is down; ', ws.length ? [N(c1), '\'s write waits for the vote…'] : 'the others are voting…'])
      const r = await until(() => page.alive(victim) || !page.view().members.includes(victim), LIMIT.vote)
      if (r === null) return
      if (page.alive(victim)) return show(card, 'off', () => [N(victim), ' came back before the others voted it out.'])
      if (!r) return show(card, 'off', () => ['The others have not voted ', N(victim), ' out yet.'], fix)
      const took = page.now - t0, heir = page.owner(ROW)
      if (ws.length && (await until(() => ws.every((w) => w.state !== 'pending'), LIMIT.write)) === null) return
      const landed = ws.length > 0 && ws.every((w) => w.state === 'committed')
      show(card, 'ok', () => [N(heir), ' ', STAR, ' took luna after ', T(took), landed ? ['; ', N(c1), '\'s write landed.'] : '.'], fix)
    },
    // cut n03 off from everyone: it keeps its copy and answers reads; the kernel's gate holds its writes
    async cut(card) {
      const pre = await setUp(card); if (!pre) return
      const id = aimOf('cut')
      page.isolate(id)
      show(card, 'run', () => [N(id), ' is cut off; waiting for it to notice…'])
      const r = await until(() => !page.alive(id) || !page.isolated(id) || page.writable(id)?.open === false, LIMIT.gate)
      if (r === null) return
      show(card, 'ok', () => cutLine(id), wayHeal(id))
    },
    // bring back the server that is down or has left; if none is, crash luna's owner first, change luna's mood while
    // it is down (so it has something to catch up on), and let the others vote it out
    async restart(card) {
      if (!(await leavesDone(card))) return
      const id = servers().find((s) => page.down.has(s) || page.left.has(s))
      if (id) return comeBack(card, id, { all: true })
      const pre = await setUp(card); if (!pre) return
      const v = page.owner(ROW), c1 = clientOf()
      page.kill(v)
      if (c1 && page.waiting(c1).length === 0) { try { page.write(c1, ROW, { mood: nextMood(c1) }) } catch { /* c1 is down */ } }
      const ws = c1 ? page.waiting(c1) : []
      show(card, 'run', () => ['Nothing was down, so ', N(v), ' crashed first…'])
      const r = await until(() => page.alive(v) || (!page.view().members.includes(v) && ws.every((w) => w.state !== 'pending')), LIMIT.vote)
      if (r === null) return
      if (page.alive(v)) return show(card, 'off', () => [N(v), ' came back before the others voted it out.'])
      return comeBack(card, v)
    },
    // Ctrl-C n02: it asks the others to vote it out. The driver puts a clean leave in page.left; one that timed out
    // (it never heard the vote) goes into page.down, like a crash, and its way back brings it back as itself
    async stop(card) {
      const pre = await setUp(card); if (!pre) return
      const id = aimOf('stop'), t0 = page.now
      let how = null
      const offs = [page.on('left', (x) => { if (x === id && !how) how = page.left.has(id) ? 'clean' : 'timeout' }),
        page.on('kill', (x) => { if (x === id && !how) how = 'crash' })]
      page.leave(id)
      show(card, 'run', () => [N(id), ' asked to leave; the others are voting…'])
      const r = await until(() => how !== null, LIMIT.leave)
      for (const off of offs) off()
      if (r === null) return
      const fix = wayBack(id, ['Start ', N(id), ' again'])
      if (how === 'crash') return show(card, 'off', () => [N(id), ' crashed before it could leave.'], fix)
      if (how === 'timeout') return show(card, 'off', () => [N(id), ' could not get its vote, so it stopped like a crash.'], fix)
      if (!how) return show(card, 'off', () => [N(id), ' has not left yet.'])
      const took = page.now - t0
      show(card, 'ok', () => [N(id), ' left by a vote after ', T(took), '.'], fix)
    },
  }
  // re-read on every sync: healed or crashed elsewhere, the line follows the kernel
  function cutLine(id) {
    if (!page.alive(id)) return [N(id), ' was cut off, and is down now.']
    if (!page.isolated(id)) return [N(id), ' was cut off, and is back now.']
    return [N(id), ' is cut off: it still serves reads', page.writable(id)?.open === false ? '; its writes wait.' : '.']
  }

  // ── coming back ────────────────────────────────────────────────────────────────────────────────────────────
  // a crashed or stopped server starts again from its disk. At its first frame (to or from it), so before it reached
  // anyone, its copy is compared with the others': if it matched, it had missed nothing; else it caught up. With
  // `all`, whatever else is broken comes back at the same time.
  async function comeBack(card, id, o = {}) {
    if (!page.down.has(id) && !page.left.has(id)) return show(card, 'off', () => [N(id), ' is already back.'])
    let first = false, missed = false
    const off = page.on('frame', (f) => { if (!first && (f.from === id || f.to === id)) { first = true; missed = page.hash(id) !== othersHash(id) } })
    page.restart(id)
    if (o.all) fixAll(id)
    show(card, 'run', () => [N(id), ' runs again from its disk; catching up…'])
    const r = await until(() => !page.alive(id) || (first && backOf(id)), LIMIT.back)
    off()
    if (r === null) return
    if (!page.alive(id)) return show(card, 'off', () => [N(id), ' went down again before it caught up.'])
    if (!r) return show(card, 'off', () => [N(id), ' is running again, and still catching up.'])
    show(card, 'ok', () => [N(id), missed ? ' came back from its disk and caught up.' : ' came back from its disk; it had missed nothing.'])
  }
  // heal a cut-off server: its copy is compared with the others' at the moment it is back on the network
  async function heal(card, id) {
    if (!page.alive(id) || !page.isolated(id)) return show(card, 'off', () => [N(id), ' is not cut off any more.'])
    const missed = page.hash(id) !== othersHash(id)
    page.reconnect(id)
    show(card, 'run', () => [N(id), ' is back on the network; catching up…'])
    const r = await until(() => !page.alive(id) || page.isolated(id) || backOf(id), LIMIT.back)
    if (r === null) return
    if (!r || !page.alive(id) || page.isolated(id)) return show(card, 'off', () => [N(id), ' is back on the network, and still catching up.'])
    show(card, 'ok', () => [N(id), missed ? ' was cut off, then healed, and caught up.' : ' was cut off, then healed; it had missed nothing.'])
  }

  // ── a press: up to the café, then the try (or the card's own way back) there ─────────────────────────────────
  async function go(card, fn) {
    if (busy) return
    busy = card; dirty = true
    const my = token
    try {
      await toDemo()
      if (my !== token) return
      showBack(card)
      await fn(card)
    } finally {
      if (busy === card) busy = null
      dirty = true
      if (my === token && say && card.res && card.res.tone !== 'run') { const line = card.res.line; say.replaceChildren(); requestAnimationFrame(() => render(say, line())) }
    }
  }
  function buttonOf(card) {
    if (busy) return { label: 'Try it', aria: card.aria, disabled: true }
    const f = card.res?.fix?.()
    if (f) return { label: f.label, aria: plain(f.label), act: () => go(card, f.run) }
    return { label: 'Try it', aria: card.aria, act: () => go(card, TRY[card.kind]) }
  }
  const lineOf = (card) => (card.res ? { tone: card.res.tone, parts: card.res.line() } : null)
  root.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.br-go')
    if (!btn || btn.disabled) return
    const card = cards.find((c) => c.btn === btn)
    if (card) buttonOf(card).act?.()   // decided now, from the cluster as it is at the press
  })

  // ── up to the café: the demo's narrator at the top, its boxes and buttons under it ──────────────────────────
  function toDemo() {
    const t = document.getElementById('demo-say') || document.getElementById('demo')
    if (!t) return Promise.resolve()
    const y = Math.max(0, Math.round(t.getBoundingClientRect().top + scrollY - 24))
    if (Math.abs(scrollY - y) < 2) return Promise.resolve()
    window.scrollTo({ top: y, behavior: REDUCED ? 'auto' : 'smooth' })
    return new Promise((resolve) => {
      const t0 = performance.now(); let last = -1, still = 0
      const step = () => {
        const s = scrollY
        if (Math.abs(s - y) < 2 || performance.now() - t0 > 1600) return resolve()
        still = s === last ? still + 1 : 0; last = s
        if (still > 8) return resolve()   // the reader took over, or the page cannot scroll that far
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }

  // ── and back: a small button while the cards are out of sight ────────────────────────────────────────────────
  const back = root.querySelector('.br-back'), grid = root.querySelector('.br-grid')
  let backCard = null, backTimer = 0, gridSeen = false
  function showBack(card) {
    backCard = card
    if (gridSeen || !back) return
    back.hidden = false
    clearTimeout(backTimer); backTimer = setTimeout(hideBack, 30000)
  }
  function hideBack() { if (back) back.hidden = true; clearTimeout(backTimer) }
  back?.addEventListener('click', () => {
    const c = backCard; hideBack()
    if (!c) return
    c.el.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' })
    c.btn.focus({ preventScroll: true })
  })

  // ── one frame loop: DOM writes only when a line or a button changed ─────────────────────────────────────────
  let visible = true, lastNow = -1
  try {
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (e.target === root) { visible = e.isIntersecting; if (visible) dirty = true }
        else { gridSeen = e.isIntersecting; if (gridSeen) hideBack() }
      }
    }, { rootMargin: '120px 0px' })
    io.observe(root)
    if (grid) io.observe(grid)
  } catch { visible = true }
  function sync(card) {
    const line = lineOf(card)
    const k = line ? line.tone + JSON.stringify(line.parts) : ''
    if (k !== card.key) {
      card.key = k
      if (line) { card.out.dataset.tone = line.tone; render(card.words, line.parts) }
      else { delete card.out.dataset.tone; card.words.replaceChildren() }
    }
    const b = buttonOf(card)
    const bk = JSON.stringify(b.label) + (b.disabled ? '|off' : '')
    if (bk !== card.bkey) {
      card.bkey = bk; render(card.label, b.label)
      card.btn.disabled = !!b.disabled; card.btn.setAttribute('aria-label', b.aria)
    }
  }
  // a press, a result or a reset marks it dirty at once; otherwise the lines are re-read every 100 ms of simulated
  // time while the cards are on screen (a cut-off copy's mood, a way back that no longer applies)
  onFrame(() => {
    const now = page.now
    if (!dirty && (!visible || Math.abs(now - lastNow) < 100)) return
    dirty = false; lastNow = now
    for (const card of cards) sync(card)
  })
}
