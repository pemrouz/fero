// sections/hero.js — the hero's live object: one client's copy of cafe.data, read from fero's real kernel running in
// this tab (the shared `page` cluster), and the trust line from the dated build manifest.
//
// What moves, and from what (nothing is typed):
//  · the rows ← page.object(c1): the client's own copy, what `cafe.snapshot` would print there. A row whose value
//    changes in that copy is "just changed" (violet band, its cat face hops once) for HOT_SIM of simulated time, and
//    never longer than HOT_WALL on screen. A write c1 issued that is held up shows "waiting" on its row instead: a
//    write shows when it commits, never before.
//  · the foot ← page.agree() / page.stamp() (which live copies hold every row's newest write), page.down, page.left,
//    page.isolated(): every copy the same, or who is down, who has left, how many are up to date and who is catching
//    up or cut off.
//  · the label ← page.isReady; the caption ← page.writer (who writes, which row, and whether it is on).
//  · the trust line ← data/manifest.json (BUILD): tests, simulated runs green, the Node floor, the licence.
// Two clocks. In free play the cluster's simulated clock follows the wall clock, and the foot waits LAG_SIM before it
// says the copies differ (every write leaves them different for ~0.15 s while it spreads). While the demo's story
// plays it drives the clock itself (page.paused): it slows it down and holds it while you read, so the foot tells a
// difference at once, and "just changed" ends by the wall clock. Events that change the cluster without moving the
// clock (a crash, a restart, a cut…) redraw the card at once.
// The card only renders while the hero is on screen; the cluster's clock runs while it is (page.watch).
import { page, attest, put, fmt, onFrame, REDUCED } from '../cluster.js'
import { catSvg } from '../cats.js'

const root = document.getElementById('hero')
if (root) init()

function init() {
  const HOT_SIM = 2000   // a changed row stays "just changed" this long (simulated ms); the visitor writes every 5 s, so it comes and goes
  const HOT_WALL = 2500  // …and never longer than this on screen (wall ms), even while the story holds the clock
  const LAG_SIM = 500    // free play: copies must differ this long (simulated ms) before the foot says so; a write spreads in ~0.15 s
  const WAIT_SIM = 500   // free play: c1's write still pending after this long (simulated ms) shows "waiting" on its row

  const $ = (s) => root.querySelector(s)
  const rowsEl = $('.ho-rows'), footEl = $('.ho-foot'), liveEl = $('.ho-live'), liveT = $('.ho-live-t')
  const capT = $('.ho-cap-t'), trust = $('.hero-trust')

  page.watch(root)

  // ── the cat: a small face per mood, decoration only (the mood word is the value): cats.js, shared by every section

  // ── small helpers ──
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const replay = (e, cls) => { if (REDUCED || !e) return; e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls) }
  const C1 = () => page.clientIds[0]
  const wallNow = () => performance.now()

  // a value as Node's console.log prints a small one: { mood: 'sleepy' }. Strings get their own span (the mood word,
  // violet while its row is "just changed").
  const BARE = /^[A-Za-z_$][\w$]*$/
  function show(v, out = []) {
    if (typeof v === 'string') { out.push(el('span', 'm', `'${v}'`)); return out }
    if (v === null || typeof v !== 'object') { out.push(String(v)); return out }
    if (Array.isArray(v)) { out.push('[ '); v.forEach((x, i) => { if (i) out.push(', '); show(x, out) }); out.push(' ]'); return out }
    const ks = Object.keys(v)
    if (!ks.length) { out.push('{}'); return out }
    out.push('{ ')
    ks.forEach((k, i) => { if (i) out.push(', '); out.push(`${BARE.test(k) ? k : `'${k}'`}: `); show(v[k], out) })
    out.push(' }')
    return out
  }

  // ── the rows: c1's copy, in the order the rows first appeared ──
  const rows = new Map()   // row → { el, face, val, note, json, mood, state }
  let hot = null           // { row, at, wall }: the last row whose value changed in c1's copy, and when (simulated ms, wall ms)
  let hotUntil = 0         // the wall time at which that row stops being "just changed", if the simulated clock has not ended it first
  let lagSince = null      // free play: when the live copies started to differ (simulated ms), or null while they agree
  const catching = new Set() // copies that just restarted, joined or came back from a cut: told behind at once (never
                           // smoothed over, as the demo tells them) until every copy agrees again
  let footKey = ''         // what the foot shows now, so it is rebuilt only when that changes
  function addRow(row) {
    const r = { el: el('div', 'ho-row'), face: el('span', 'ho-face'), key: el('span', 'ho-k', row), val: el('span', 'ho-v'), note: el('span', 'ho-note'), json: '', mood: undefined, state: '' }
    r.el.setAttribute('role', 'listitem'); r.el.dataset.row = row
    r.face.setAttribute('aria-hidden', 'true')
    r.el.append(r.face, r.key, r.val, r.note)
    rowsEl.querySelector('.ho-empty')?.remove()
    rowsEl.append(r.el)
    replay(r.el, 'enter')
    rows.set(row, r)
    return r
  }
  function paint(r, v, changed) {
    r.val.replaceChildren(...show(v))
    r.val.setAttribute('data-attested', 'runtime')
    const mood = v && typeof v === 'object' && typeof v.mood === 'string' ? v.mood : null
    if (mood !== r.mood) { r.mood = mood; r.face.innerHTML = mood ? catSvg(mood) : '' }
    // one effect per write: the violet band (the row's state, below) and the cat's hop
    if (changed) replay(r.face, 'hop')
  }
  function clear() {
    rows.clear(); hot = null; hotUntil = 0; lagSince = null; catching.clear(); footKey = ''
    const empty = el('p', 'ho-empty', 'The café is opening…'); empty.setAttribute('role', 'listitem'); rowsEl.replaceChildren(empty)
  }

  // ── the foot: does every copy agree? plain words, from the kernel ──
  const names = (ids) => {
    const out = []
    ids.forEach((id, i) => { if (i) out.push(i === ids.length - 1 ? ' and ' : ', '); out.push({ n: id }) })
    return out
  }
  function phrase(cls, parts) { return { cls, parts } }
  // the kernel's own order for two writes to one row (lib/kernel/node.js `newer`): epoch, then seq, then origin.
  // The newest write of a row is the one every copy ends with.
  const newer = (a, b) => !b || a.epoch > b.epoch || (a.epoch === b.epoch && (a.seq > b.seq || (a.seq === b.seq && a.origin > b.origin)))
  // which live copies are up to date: for every row, they hold the value of that row's newest write among the live
  // copies. The rest are behind. Values are compared, not stamps: the same value under an older write shows the same.
  // So while a write spreads, the copies that have it are up to date and the others are catching up, whichever side
  // is bigger.
  function split(live) {
    const objs = new Map()
    for (const id of live) { try { objs.set(id, page.object(id)) } catch { objs.set(id, {}) } }
    const keys = new Set()
    for (const o of objs.values()) for (const k of Object.keys(o)) keys.add(k)
    for (const k of rows.keys()) keys.add(k)
    const behind = new Set()
    for (const k of keys) {
      let top = null, ref = null
      for (const id of live) { let s; try { s = page.stamp(id, k) } catch { s = null } if (s && newer(s, top)) { top = s; ref = id } }
      if (ref === null) continue
      const want = JSON.stringify(objs.get(ref)[k])
      for (const id of live) if (JSON.stringify(objs.get(id)[k]) !== want) behind.add(id)
    }
    return { fresh: live.filter((id) => !behind.has(id)), behind: live.filter((id) => behind.has(id)) }
  }
  function footState(now) {
    if (!rows.size || !page.isReady) return [phrase('dim', ['the copies are filling in…'])]
    const ids = page.ids(), live = ids.filter((id) => page.alive(id)), of = live.length
    const down = ids.filter((id) => page.down.has(id)), left = ids.filter((id) => page.left.has(id) && !page.down.has(id))
    // free play: a difference counts once it has lasted LAG_SIM; while the story drives the clock, or while a copy
    // that just restarted or came back catches up, at once
    const lag = !page.agree() && (page.paused || catching.size > 0 || (lagSince !== null && now - lagSince >= LAG_SIM))
    const out = []
    if (down.length) out.push(phrase('neg', [{ icon: '✕' }, ...names(down), down.length > 1 ? ' are down' : ' is down']))
    if (lag) {
      const { fresh, behind } = split(live)
      const cut = behind.filter((id) => page.isolated(id)), rest = behind.filter((id) => !page.isolated(id))
      if (!fresh.length || !behind.length) out.push(phrase('wait', ['the copies are catching up']))
      else {
        out.push(phrase('wait', [{ v: fresh.length }, ' of ', { v: of }, fresh.length === 1 ? ' is up to date' : ' are up to date']))
        if (cut.length) out.push(phrase('wait', [...names(cut), cut.length > 1 ? ' are cut off' : ' is cut off']))
        // one copy behind is named; more are counted, so the common states fit one line of the card
        if (rest.length) out.push(phrase('wait', rest.length === 1 ? [...names(rest), ' is catching up'] : [{ v: rest.length }, ' are catching up']))
      }
    } else if (of <= 1) out.push(phrase('dim', ['only ', { v: of }, ' copy is running']))
    else if (down.length) out.push(phrase('dim', ['the other ', { v: of }, ' agree']))
    else out.push(phrase('pos', [{ icon: '✓' }, 'the same in all ', { v: of }, ' processes']))
    if (left.length) out.push(phrase('dim', [...names(left), left.length > 1 ? ' have left' : ' has left']))
    return out
  }
  function renderFoot(now) {
    const st = footState(now)
    const key = JSON.stringify(st)
    if (key === footKey) return
    footKey = key
    footEl.dataset.tone = st[0].cls
    const frag = document.createDocumentFragment()
    st.forEach((p, i) => {
      if (i) { const sep = el('span', 'sep', ' · '); sep.setAttribute('aria-hidden', 'true'); frag.append(sep) }
      const s = el('span', 'ph ' + p.cls)
      let first = i === 0   // the foot's first word starts with a capital, after its ✓ or ✕
      for (const x of p.parts) {
        if (typeof x === 'string') { s.append(first ? x[0].toUpperCase() + x.slice(1) : x); first = false }
        else if (x.icon) { s.append(el('span', 'ic', x.icon)); s.append(' ') }
        else if (x.n != null) { const e = el('span', 'nm'); attest(e, x.n, 'runtime'); s.append(e); first = false }
        else if (x.v != null) { const e = el('span', 'num'); attest(e, x.v, 'runtime'); s.append(e); first = false }
      }
      frag.append(s)
    })
    footEl.replaceChildren(frag)
  }

  // ── one render: read the kernel, change only what changed ──
  function render() {
    const id = C1(), now = page.now, wall = wallNow()
    let obj = null
    try { obj = id ? page.object(id) : null } catch { obj = null }
    if (obj) {
      for (const [row, v] of Object.entries(obj)) {
        const json = JSON.stringify(v)
        const r = rows.get(row) ?? addRow(row)
        if (r.json === json) continue
        const changed = r.json !== ''
        r.json = json
        paint(r, v, changed)
        if (changed) { hot = { row, at: now, wall }; hotUntil = wall + HOT_WALL }
      }
      for (const [row, r] of rows) if (!Object.hasOwn(obj, row)) { r.el.remove(); rows.delete(row); if (hot?.row === row) hot = null }
    }
    // the note on each row: "waiting" (a write of c1's held up) beats "just changed". A write is held up when its
    // row's owner is down, gone or cut off, or c1 itself is cut off (that shows at once, as the demo tells it), or
    // when it has simply been pending longer than WAIT_SIM. A write that is only on its way (the story's slow motion)
    // is not waiting.
    const held = new Set()
    if (id && page.alive(id)) {
      const pending = page.waiting(id)
      if (pending.length) {
        const cutOff = page.isolated(id)
        const stuck = (row) => { const o = page.owner(row); return !!o && (!page.alive(o) || page.isolated(o)) }
        for (const w of pending) if (now - w.issuedAt >= WAIT_SIM || cutOff || stuck(w.path[0])) held.add(w.path[0])
      }
    }
    const hotRow = hot && now - hot.at < HOT_SIM && wall < hotUntil ? hot.row : null
    for (const [row, r] of rows) {
      const state = held.has(row) ? 'waiting' : row === hotRow ? 'hot' : ''
      if (r.state === state) continue
      r.state = state
      r.el.classList.toggle('hot', state === 'hot')
      r.el.classList.toggle('waiting', state === 'waiting')
      put(r.note, state === 'waiting' ? 'waiting' : state === 'hot' ? 'just changed' : '')
    }
    renderFoot(now)
    // the label: live once the kernel holds the café (the demo's story may drive the clock itself; it is still live)
    const ls = page.isReady ? 'live' : 'starting'
    if (liveEl.dataset.state !== ls) { liveEl.dataset.state = ls; put(liveT, ls) }
    // the caption: who writes, and whether the scripted visitor is on (the demo turns it off while you use it)
    const w = page.writer, who = w?.id === id ? 'This client' : 'A client'
    put(capT, w?.on ? `${who} sets ${w.row}'s ${w.field ?? 'value'} every few seconds.` : `${who}'s automatic writes are paused.`)
  }

  let dirty = true, onScreen = true
  // every tick: redraw, and keep the free-play lag clock, on screen or not, so the foot knows how long a difference
  // has lasted when the hero comes back into view
  page.on('tick', (now) => {
    dirty = true
    if (page.isReady && !page.agree()) lagSince ??= now; else { lagSince = null; catching.clear() }
  })
  page.on('reset', () => { clear(); dirty = true })
  page.on('restart', (id) => { catching.add(id) })
  page.on('join', (id) => { catching.add(id) })
  page.on('heal', ([a, b]) => { catching.add(a); catching.add(b) })
  // these change the cluster without moving its clock (the story fires them while it holds the clock): redraw at once
  for (const ev of ['ready', 'writer', 'write', 'commit', 'kill', 'restart', 'leave', 'left', 'join', 'cut', 'heal', 'view']) page.on(ev, () => { dirty = true })
  if (typeof IntersectionObserver === 'function') new IntersectionObserver((es) => { for (const e of es) onScreen = e.isIntersecting; if (onScreen) dirty = true }, { rootMargin: '120px' }).observe(root)
  onFrame(() => {
    if (hotUntil && wallNow() >= hotUntil) { hotUntil = 0; dirty = true }
    if (dirty && onScreen) { dirty = false; render() }
  })

  // ── the trust line: BUILD values from the dated manifest (tools/manifest.mjs) ──
  fetch('./data/manifest.json').then((r) => { if (!r.ok) throw new Error(`manifest ${r.status}`); return r.json() }).then((m) => {
    const t = m.test?.fero, s = m.sim
    const part = (cls) => trust.querySelector(`:scope > .${cls}`)
    if (t && t.fail === 0 && t.pass === t.tests) attest($('[data-ht="tests"]'), t.tests, 'build'); else part('t-tests').remove()
    if (s && s.seeds > 0) {
      const b = $('[data-ht="runs"]')
      attest(b, `${fmt(s.green)} of ${fmt(s.seeds)}`, 'build')
      b.classList.toggle('ok', s.green === s.seeds)
    } else part('t-runs').remove()
    if (m.node) attest($('[data-ht="node"]'), m.node, 'build'); else part('t-node').remove()
    if (m.license?.declared) attest($('[data-ht="license"]'), m.license.declared, 'build'); else part('t-lic').remove()
    trust.classList.remove('pending')
  }).catch((e) => { console.warn('hero: the build manifest did not load', e); trust.remove() })
}
