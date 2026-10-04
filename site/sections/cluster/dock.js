// sections/cluster/dock.js — the page's ONE persistent control. Inside the centrepiece it is the head row (the
// story, the speed, pause, the seed) plus the verbs row; once that scrolls away, the same verbs float beside the
// column (a rail in the right margin at 1400 px and wider, a slim tab in the gutter below that, whose menu opens with
// the whole status line). Every verb is a page action (core.js): the action log replays, and
// every section reacts through page events. Actions run from click handlers and from the section's frame loop
// (between two advances), never from inside a cluster event callback.
import { page, REDUCED } from '../../cluster.js'
import { esc, nid } from '../../ui.js'
import { M, ownerOf, onWire, waiting, diskOf, noServerWhy } from './model.js'
import { paint, status, statusLine, dockState } from './say.js'

const root = document.getElementById('cluster')
const $ = (s) => root.querySelector(s)
const $$ = (s) => [...root.querySelectorAll(s)]

export const D = { target: null, speed: 'watch', slow: false, step: 0, st: {}, deferred: null, docked: false, victim: null }
const ROWS = ['widgets', 'gadgets', 'gizmos']

// ── the write a verb or a story step posts: one WHOLE row — a sale (one less in stock), or a restock when the
// node's own copy shows none left. Read from the writing node's copy, like a shop's own code would.
const stockOf = (id, row) => { try { return page.alive(id) ? page.cell(id, row)?.stock : undefined } catch { return undefined } }
const sale = (cur) => (typeof cur === 'number' && cur > 0 ? cur - 1 : 9)
function nextValue(id) { return sale(stockOf(id, page.writer.row)) }
const writer = () => (D.target && page.alive(D.target) ? D.target : page.writer.id)
function doWrite(id = writer()) {
  if (!page.alive(id)) return null
  return page.write(id, page.writer.row, { stock: nextValue(id) })
}
function healAll() { for (const p of [...page.cuts]) { const [a, b] = p.split('|'); page.heal(a, b) } }
function resetTo(seed, by) {
  M.resetAt = performance.now(); M.resetBy = by
  D.step = 0; D.st = {}; D.deferred = null; D.victim = null
  page.reset(seed)
}

// ── the story: six steps of scripted input on the live cluster, each finished by a kernel event ──
const majorityOwner = (row) => ownerOf(row, page.view())
export const STEPS = [
  { name: 'a write', title: 'c1 writes gadgets: it goes to the owner, gets a stamp, and lands on every copy',
    run(st) { st.w = doWrite(page.writer.id) },
    done: (st) => !st.w || (st.w.state === 'committed' && page.agree()) },
  { name: 'crash the owner', title: 'the owner of gadgets crashes: it is cut off and killed; its disk is kept',
    run(st) { const o = majorityOwner(page.writer.row); if (o && page.alive(o)) { page.kill(o); st.victim = o } D.victim = st.victim ?? [...page.down][0] },
    done: () => true },
  { name: 'write while it is down', title: 'c1 writes gadgets again: the write waits until the others vote the dead owner out',
    // if c1 already has a write waiting (the scripted writer's, posted while the owner was down), the step follows
    // that one instead of stacking a second: the figure then describes one write, not two
    run(st) { const id = page.writer.id; st.w = waiting(id)[0] ?? doWrite(id) },
    done: (st) => !st.w || st.w.state === 'committed' || !page.alive(st.w.node) },
  { name: 'restart from disk', title: 'the crashed server comes back from its disk, in its next life, and rejoins the view',
    run(st) { const id = D.victim && page.down.has(D.victim) ? D.victim : [...page.down][0]; if (id) { page.restart(id); st.id = id } },
    done: (st) => !st.id || (page.view().members.includes(st.id) && page.agree()) },
  { name: 'cut one off', title: 'n03 is split from everyone: it keeps serving reads, and its own write waits',
    run(st) {
      const id = page.alive('n03') ? 'n03' : page.serverIds.filter((s) => page.alive(s)).pop()
      if (!id) return
      page.isolate(id); st.id = id
      // the write goes once the kernel says the gate is closed (the cut is only known when the link-down lands)
      D.deferred = { id, at: page.now }
    },
    done: (st) => !st.id || !!st.w },
  { name: 'heal', title: 'the links come back: digests are swapped, the cut node catches up, its write goes out',
    run(st) { healAll(); st.w = D.st[4]?.w },
    done: (st) => (!st.w || st.w.state === 'committed') && page.agree() },
]
function stepNext() {
  if (D.step >= STEPS.length) { resetTo(page.seed, 'story'); return }
  const k = D.step, st = (D.st[k] = {})
  D.step = k + 1
  STEPS[k].run(st)
}
// the cut node's write: issued from the frame loop once its write gate has closed (a kernel state)
export function storyTick() {
  const d = D.deferred
  if (!d) return
  if (!page.alive(d.id)) { D.deferred = null; return }
  const g = page.writable(d.id)
  if (g && !g.open) {
    const view = page.viewOf(d.id)
    const row = ROWS.find((r) => ownerOf(r, view) === d.id) ?? 'gizmos'
    const st = D.st[4] ?? (D.st[4] = {})
    st.w = page.write(d.id, row, { stock: sale(stockOf(d.id, row)) })
    D.deferred = null
  }
}

// ── the speed: watch = 1×, slowed to ¼× while a FRESH frame is on the wire and the figure is on screen ──
export function pace(figureOnScreen) {
  let sp
  if (D.speed === 'watch') {
    D.slow = !REDUCED && figureOnScreen && !page.paused && onWire().some((f) => f.fresh)
    sp = D.slow ? 0.25 : 1
  } else { D.slow = false; sp = +D.speed }
  if (page.speed !== sp) page.speed = sp
}

// ── menus: one popover, filled per verb ──
const menu = $('#cl-menu')
let menuFor = null
const NO_SERVER = { cut: 'no server: it is cut off', down: 'no server: none is up', yet: 'no server yet: it is connecting' }
function hint(id) {
  if (page.role(id) === 'client') { const p = page.alive(id) ? page.primary(id) : null; return page.alive(id) ? `the client · ${p ? `follows ${p}` : NO_SERVER[noServerWhy(id)]}` : 'the client' }
  const own = ROWS.filter((r) => ownerOf(r, page.view()) === id)
  return own.length ? `owns ${own.join(', ')}` : 'owns no house row'
}
function items(kind) {
  const ids = page.ids()
  const t = D.target
  const sortT = (a, b) => (a === t ? -1 : b === t ? 1 : 0)
  // crash and restart are for servers: a server has a disk, so a crash keeps it and a restart reads it back.
  // A client has no disk (a `dir` makes a node a server), so it cannot come back as the same node — and c1 is
  // the page's writer. Restarting a disk-less node under its old name would replay a life fero never has.
  if (kind === 'crash') return ids.filter((id) => page.alive(id) && page.role(id) === 'server').sort(sortT).map((id) => ({ act: 'kill', id, label: id, sub: hint(id) }))
  if (kind === 'restart') return [...page.down].sort(sortT).map((id) => {
    if (page.role(id) !== 'server') return { act: 'none', id, label: id, sub: 'no disk: a client cannot come back as itself · reset rebuilds the run', off: true }
    // counted in records, the same unit as the sentence ("its disk keeps N records") and the restart's replay
    const d = diskOf(id); return { act: 'restart', id, label: id, sub: d ? `from its disk · ${d.recs} ${d.recs === 1 ? 'record' : 'records'}` : 'from its disk' } })
  if (kind === 'cut') return ids.filter((id) => page.alive(id) && !page.isolated(id)).sort(sortT).map((id) => ({ act: 'isolate', id, label: id, sub: 'from everyone' }))
  return []
}
function menuList(kind) {
  if (kind !== 'more') return items(kind)
  const list = [{ act: 'write', label: 'write', sub: `${writer()} writes ${page.writer.row}` }]
  for (const k of ['crash', 'restart', 'cut']) for (const it of items(k)) if (!it.off) list.push({ ...it, label: `${k} ${it.id}` })
  if (page.cuts.size) list.push({ act: 'heal', label: 'heal', sub: 'every cut link' })
  list.push({ act: 'pause', label: page.paused ? 'play' : 'pause', sub: '' }, { act: 'reset', label: 'reset', sub: 'rebuild from the seed' })
  return list
}
const listKey = (list) => list.map((it) => `${it.act}|${it.id ?? ''}|${it.label}|${it.sub}|${it.off ? 1 : 0}`).join('\n')
function fillMenu(kind, list) {
  menu.innerHTML = (kind === 'more' ? `<div class="mi-h" role="none">${statusLine()}</div>` : '') + list.map((it, i) => `<button type="button" role="menuitem" data-mi="${i}"${it.off ? ' disabled' : ''}><span class="mi-l">${it.id ? nid(it.id, { text: it.label }) : esc(it.label)}</span>${it.sub ? `<span class="mi-s">${esc(it.sub)}</span>` : ''}</button>`).join('')
  // digits in node names are the kernel's ids: attest them for the honesty gate
  for (const el of menu.querySelectorAll('.mi-l, .mi-s')) el.setAttribute('data-attested', 'runtime')
  menu._list = list; menu._key = listKey(list); menu._kind = kind
}
function openMenu(kind, btn) {
  if (menuFor === btn && !menu.hidden) { closeMenu(); return }
  const list = menuList(kind)
  if (!list.length) return
  fillMenu(kind, list)
  menu.hidden = false
  menuFor = btn; menuY = window.scrollY
  placeMenu()
  menu.scrollTop = 0
  menu.querySelector('button')?.focus({ preventScroll: true })
}
// an open menu follows the cluster running behind it: the ⋯ menu's status line keeps time with the clock, the view
// and the waiting count, and any menu's items change once a node goes down, comes back or is cut ("restart n02" shows
// as soon as it can be done). The focused item keeps its place.
function refreshMenu() {
  if (menu.hidden || !menu._kind) return
  const list = menuList(menu._kind)
  if (!list.length) { closeMenu(); return }
  if (listKey(list) !== menu._key) {
    const btns = [...menu.querySelectorAll('button')], fi = btns.indexOf(document.activeElement), top = menu.scrollTop
    fillMenu(menu._kind, list)
    placeMenu(); menu.scrollTop = top
    if (fi >= 0) menu.querySelectorAll('button')[Math.min(fi, list.length - 1)]?.focus({ preventScroll: true })
    return
  }
  const h = menu._kind === 'more' && menu.querySelector('.mi-h')
  if (h) { const s = statusLine(); if (h._h !== s) { h._h = s; h.innerHTML = s } }
}
// placeMenu: below its button when it fits, else above; a menu taller than the room on either side (a phone held
// sideways) starts 8 px from the edge and scrolls inside, so its first line, the status, always shows
function placeMenu() {
  const btn = menuFor; if (!btn || menu.hidden) return
  // measure at the left edge with no height cap first: a menu still squeezed by its last position would measure
  // narrow, land too far right and then grow past the screen's edge
  menu.style.left = '0px'; menu.style.top = '0px'; menu.style.maxHeight = ''
  const r = btn.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  const below = vh - 8 - (r.bottom + 6), above = r.top - 6 - 8
  let top, cap = 0
  if (mh <= below) top = r.bottom + 6
  else if (mh <= above) top = r.top - 6 - mh
  else if (above >= below) { cap = above; top = 8 }
  else { cap = below; top = r.bottom + 6 }
  if (cap) menu.style.maxHeight = Math.max(96, Math.floor(cap)) + 'px'
  menu.style.left = Math.max(8, Math.min(vw - mw - 8, r.left)) + 'px'
  menu.style.top = Math.max(8, Math.round(top)) + 'px'
}
function closeMenu() { menu.hidden = true; menuFor = null }
let menuY = 0
menu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mi]'); if (!b) return
  const it = menu._list[+b.dataset.mi]; if (it.off) return
  closeMenu()
  if (it.act === 'kill') page.kill(it.id)
  else if (it.act === 'restart') page.restart(it.id)
  else if (it.act === 'isolate') page.isolate(it.id)
  else if (it.act === 'write') doWrite()
  else if (it.act === 'heal') healAll()
  else if (it.act === 'pause') page.paused = !page.paused
  else if (it.act === 'reset') resetTo(page.seed, 'reset')
  render(true)
})
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== menuFor && !menuFor?.contains(e.target)) closeMenu() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { const b = menuFor; closeMenu(); b?.focus() } })
// scrolling: the browser's scroll anchoring moves the page a few pixels whenever something above the viewport
// changes height (a card grows by a line as a vote lands). That is not the reader scrolling, so an open menu stays.
// Only a real scroll — more than SCROLL_CLOSE px from where the menu opened — closes it. The dock's rail and tab are
// fixed, so their menus never drift; a menu from the head follows its button until then.
const SCROLL_CLOSE = 60
window.addEventListener('scroll', () => {
  if (menu.hidden) return
  if (Math.abs(window.scrollY - menuY) > SCROLL_CLOSE) { closeMenu(); return }
  if (menuFor && !menuFor.closest('#cl-dock')) placeMenu()
}, { passive: true })
window.addEventListener('resize', () => { if (!menu.hidden) placeMenu() }, { passive: true })

// ── clicks: every [data-act] in the section (head row, verbs row, floating dock) ──
root.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return
  const a = b.dataset.act
  if (a === 'write') doWrite()
  else if (a === 'crash' || a === 'restart' || a === 'cut' || a === 'more') { openMenu(a, b); return }
  else if (a === 'heal') healAll()
  else if (a === 'pause') page.paused = !page.paused
  else if (a === 'reset') resetTo(page.seed, 'reset')
  else if (a === 'seed') {
    let s; do { s = 1 + Math.floor(Math.random() * 9999) } while (s === page.seed)
    try { const u = new URL(location.href); u.searchParams.set('seed', String(s)); history.replaceState(null, '', u) } catch {}
    resetTo(s, 'seed')
  }
  else if (a === 'story-next') stepNext()
  else if (a === 'story-prev') resetTo(page.seed, 'story')
  else if (a === 'speed') D.speed = b.dataset.speed
  render(true)
})
// clicking a node's name anywhere on the page makes it the target (write posts from it; menus list it first)
document.addEventListener('click', (e) => {
  const n = e.target.closest('.nid[data-node]')
  if (!n || menu.contains(n)) return
  const id = n.dataset.node
  if (!page.ids().includes(id)) return
  D.target = D.target === id ? null : id
  render(true)
})
page.on('reset', () => { if (!M.resetAt || performance.now() - M.resetAt > 100) { M.resetAt = performance.now(); M.resetBy = 'reset'; D.step = 0; D.st = {}; D.deferred = null; D.victim = null } D.target = null })

// ── the floating dock: shown while the head's controls are above the viewport (the visitor is further down the
// page). Worked out from the scroll position on every scroll, not only from IntersectionObserver edges: a jump (a
// nav link, a #hash, a "break it ↓" link) moves the head from below the viewport to above it without ever crossing
// it, and an observer would never fire. Where the bar ends on the page is measured only when the layout changes (a
// ResizeObserver on <main>, a resize, a pageshow, the bar crossing an edge), never in the scroll handler: a layout
// read there forced a layout on every scroll frame, which a phone-class CPU paid for in long frames. The page's
// end needs nothing extra: the footer keeps 4rem clear below its line, more than the pill takes, and the rail sits
// in the margin beside the column. ──
const dock = $('#cl-dock'), bar = $('#cl-bar')
let dockQueued = false, barEnd = null
const measureBar = () => { barEnd = bar.getBoundingClientRect().bottom + window.scrollY }
function queueDock() { if (dockQueued) return; dockQueued = true; requestAnimationFrame(() => { dockQueued = false; syncDock() }) }
function syncDock() {
  if (barEnd === null) measureBar()
  const want = barEnd - window.scrollY < 0
  if (want === D.docked) return
  D.docked = want
  dock.hidden = !want
  if (!want && menuFor && dock.contains(menuFor)) closeMenu()
  render(true)
}
const remeasure = () => { barEnd = null; queueDock() }
window.addEventListener('scroll', queueDock, { passive: true })
window.addEventListener('resize', remeasure, { passive: true })
window.addEventListener('hashchange', queueDock)
window.addEventListener('pageshow', remeasure)
// a ResizeObserver runs after layout, so measuring inside it costs no extra layout
if ('ResizeObserver' in window) new ResizeObserver(() => { measureBar(); queueDock() }).observe(document.querySelector('main') ?? document.body)
if ('IntersectionObserver' in window) new IntersectionObserver(remeasure, { threshold: [0, 1] }).observe(bar)
queueDock()

// ── render: the controls' states (called from the section's frame loop, throttled, and after every click) ──
let lastStatus = 0
const T_ = (el, v) => { if (el && el.textContent !== v) el.textContent = v }
const At = (el, k, v) => { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v) }
const Hd = (el, v) => { if (el && el.hidden !== v) el.hidden = v }
const Dis = (el, v) => { if (el && el.disabled !== v) el.disabled = v }
const Cls = (el, c, v) => { if (el && el.classList.contains(c) !== v) el.classList.toggle(c, v) }
export function render(force = false) {
  // story: "↺ start over" rebuilds from the seed (it is not a step back, and its face says so); at the last step
  // the › button's face turns ↺ too, because pressing it starts the story again
  const k = D.step
  T_($('#cl-story-pos'), `${k} / ${STEPS.length}`)
  // a step, once done, stays done: a routine write makes the copies differ for a moment, and that must not take the
  // ink off › or turn "the story is over" back into the last step's name
  const st = k > 0 ? (D.st[k - 1] ??= {}) : null
  if (st && !st.done && STEPS[k - 1].done(st)) st.done = true
  const doneNow = k === 0 || st.done === true
  const over = k >= STEPS.length
  T_($('#cl-story-name'), k === 0 ? 'start the story' : over && doneNow ? 'the story is over' : STEPS[k - 1].name)
  const next = $('#cl-story-next')
  T_(next, over ? '↺' : '›')
  Cls(next, 'ready', doneNow && !over)
  At(next, 'title', !over ? `next: ${STEPS[k].name} — ${STEPS[k].title}` : 'start the story again: the cluster is rebuilt from its seed')
  At(next, 'aria-label', !over ? `next step: ${STEPS[k].name}` : 'start the story again: the cluster is rebuilt from its seed')
  Dis($('#cl-story-prev'), k === 0)
  // speed, pause, seed
  for (const b of $$('[data-act="speed"]')) At(b, 'aria-pressed', String(b.dataset.speed === D.speed))
  Cls($('#cl-slow'), 'on', D.slow)
  for (const b of $$('[data-act="pause"]')) {
    At(b, 'aria-pressed', String(page.paused))
    // the head's button carries its word (hidden on phones, where the icon and its label say it); the dock's is an icon
    const html = b.closest('.cl-dock') ? (page.paused ? '▶' : '⏸') : (page.paused ? '▶<span class="cl-pw"> play</span>' : '⏸<span class="cl-pw"> pause</span>')
    if (b._h !== html) { b._h = html; b.innerHTML = html }
    At(b, 'aria-label', page.paused ? 'play' : 'pause')
  }
  const seedEl = $('#cl-seed'); T_(seedEl, String(page.seed)); At(seedEl, 'data-attested', 'runtime')
  // verbs: availability follows the cluster
  const anyLive = page.serverIds.some((id) => page.alive(id))
  const canCut = page.ids().some((id) => page.alive(id) && !page.isolated(id))
  const wid = writer()
  for (const b of $$('[data-act="write"]')) {
    Dis(b, !page.alive(wid))
    At(b, 'title', page.alive(wid) ? `${wid} assigns shop.data.${page.writer.row} = { stock: ${nextValue(wid)} } — the page posts the record this becomes` : `${wid} is down`)
    const label = D.target && D.target !== page.writer.id ? `write from ${D.target}` : 'write'
    if (b.textContent !== label) { b.textContent = label; if (/\d/.test(label)) b.setAttribute('data-attested', 'runtime'); else b.removeAttribute('data-attested') }
  }
  for (const b of $$('[data-act="crash"]')) Dis(b, !anyLive)
  for (const b of $$('[data-act="restart"]')) Dis(b, page.down.size === 0)
  for (const b of $$('[data-act="crash"]')) At(b, 'title', 'crash a server, like kill -9: its links drop, its disk is kept')
  for (const b of $$('[data-act="cut"]')) Dis(b, !canCut)
  for (const b of $$('[data-act="heal"]')) Hd(b, page.cuts.size === 0)
  // the floating dock's status (4 Hz is plenty for a clock); it sits above the prototype's options bar when open
  if (D.docked && (force || performance.now() - lastStatus > 240)) {
    lastStatus = performance.now(); paint($('#cl-dock-status'), status())
    // the tab (narrower than 1400 px): the state as a shape over ⋮; its label carries the words
    const more = $('#cl-dock .cl-dock-more'), ds = dockState()
    const html = `<span class="ds-g ${ds.cls}" aria-hidden="true">${ds.g}</span><span class="ds-e" aria-hidden="true">⋮</span>`
    if (more._h !== html) { more._h = html; more.innerHTML = html }
    const label = `the cluster: ${ds.words}${page.paused ? ', paused' : ''} · open for write, crash, restart, cut, pause and reset`
    At(more, 'aria-label', label); At(more, 'title', label)
    if (/\d/.test(label)) At(more, 'data-attested', 'runtime')
    const ob = document.getElementById('optbar'), open = !!ob && !ob.hidden
    Cls(dock, 'beside-bar', open)
    if (open) { const h = ob.offsetHeight + 'px'; if (dock.style.getPropertyValue('--cl-ob-h') !== h) dock.style.setProperty('--cl-ob-h', h) }
  }
  refreshMenu()
}
