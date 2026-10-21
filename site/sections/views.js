// sections/views.js — 05 Live views.
//
// What runs here: data 4.0.0 from npm (the files `npm i data` installs), loaded from jsDelivr once this section comes
// near. data starts from the copy the café's client holds right then (page.object('c1')), and from that moment it
// takes every record c1's kernel applies (page.on('apply'), node c1), one lane() call each. That is what fero's api
// does in every process: api/substrate.ts applyRec → lane(p)([rec]) on the handle `cafe.data` sits on, and
// `cafe.data.filter(fn)` is data's filter on that handle. So the two-liner the section shows runs for real:
//     const hungry = cafe.data.filter((cat) => cat.mood === 'hungry')
// Its comment prints the rows data's filter holds, in data's own order: the one place the answer shows. The second
// line is c1's latest committed write, and its comment says what that write did to `hungry`, from data's own change
// report for that row. With no write of c1's in this run yet, there is no second line (nothing stands in for it), but
// the card keeps its room, empty, so it does not grow when the first write lands.
// After every simulation step that changed anything, the page also checks each cat in c1's copy by hand, in plain
// JavaScript, and compares the rows with data's. The door prints the tally; the figure stays quiet. Only when
// something is wrong (data stopped, or the rows differ) does the caption say so, in red.
// The words say "the data library", never a bare "data", which reads like a typo.
//
// Every printed digit is BUILD (data's version, from the pinned URL the modules come from), RUNTIME (the count of
// checks) or MEASURED (data's load: files, KB, ms, "on this machine"). Node names come from page.clientIds (RUNTIME).
import { page, attest, REC, stable, REDUCED } from '../cluster.js'

const PKG = 'https://cdn.jsdelivr.net/npm/data@4.0.0'   // the version this section was checked against (views.md)
const isHungry = (cat) => cat.mood === 'hungry'         // exactly the function the code shows, run by data and by the check
const SLOW = 6000                                       // ms of loading before the line says data is slow
const WIDE = 84                                         // characters the one-line layout keeps room for: 67 to the comments, 16 for the longest
const EFFECT = { add: 'joins hungry', remove: 'leaves hungry', update: 'still hungry', not: 'not hungry', is: "she's hungry" }
const LONGEST = Object.values(EFFECT).reduce((a, b) => (b.length > a.length ? b : a))   // the room a second comment needs
// the door's words for the check (sections/views.html carries the same sentence before the page runs)
const CHECKS = "After every change, the page also checks each cat in that copy by hand, in plain JavaScript, and compares the rows with the filter's"

const root = document.getElementById('views')
if (root) main(root)

function main(root) {
  const $ = (s) => root.querySelector(s)
  const fig = $('.vw-fig'), pre = $('.vw-code')
  const status = $('.vw-status'), said = $('.vw-said'), loadEl = $('.vw-load'), checksEl = $('.vw-checks'), c1El = $('.vw-c1')
  const C1 = () => page.clientIds[0]                    // the café's one client: c1
  page.watch(root)

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  // ── data's side ──
  let D = null, src = null, lane = null, hungry = null, sub = null
  let state = 'idle'                // idle · loading · slow · ready · failed
  let deltas = []                   // data's changes to `hungry` during the lane() call being made right now
  let last = null                   // c1's latest committed write: { row, value, remove, effect, at }
  const joined = new Map()          // row → when it joined `hungry` (wall clock): violet for a moment
  let ver = 0, checkedVer = -1, painted = -1
  let checks = 0, differ = 0, meas = null

  function build() {
    for (const h of [sub, hungry, src]) { try { h?.dispose() } catch { /* already gone */ } }
    src = D.$({})
    lane = D.lane(src)                                   // what fero's api makes per handle (api/substrate.ts laneOf)
    hungry = src.filter(isHungry)
    sub = hungry.sink({ apply: (b) => { for (const d of b.rows) deltas.push(d) } })
    // start from c1's copy as it is now: one whole-row record per row, as a seed arrives
    const recs = Object.entries(page.object(C1())).map(([k, v]) => ({ type: REC.update, key: [k], value: v }))
    stopped = false
    if (recs.length) { try { lane(recs) } catch (e) { stopped = true; console.warn('05: data could not take c1\'s copy:', e?.message ?? e) } }
    deltas = []; joined.clear()
    // the second line starts at c1's latest write of this run, if any (what it did before data came is not known)
    last = null
    for (let i = page.writes.length - 1; i >= 0; i--) {
      const w = page.writes[i]
      if (w.node !== C1() || w.state !== 'committed' || w.path.length !== 1) continue
      const row = String(w.path[0])
      last = { row, value: w.value, remove: !!w.remove, effect: inHungry(row) ? 'is' : 'not', at: -1e9 }
      break
    }
    checkedVer = -1
    ver++
  }
  // data's answer, read safely: a row the filter cannot read (only the console can write one, e.g. a null row) makes
  // data throw; then the page says data stopped (the comment and the caption), and never throws from a paint
  const held = () => { try { return hungry[D.value] } catch (e) { if (!stopped) { stopped = true; console.warn('05: data could not read its filter:', e?.message ?? e) } return {} } }
  // data 4.0.0 (and data's HEAD, 391c458): once a filter's function throws, every later lane() call in the tab
  // rethrows it, on any source (sections/views.md). So a throw is shown as data stopping, not as a page bug.
  let stopped = false
  const inHungry = (row) => Object.hasOwn(held(), row)

  // every record c1's kernel applies, into data at once, as fero's api does it (inside the apply, synchronously)
  page.on('apply', (a) => {
    if (!lane || a.node !== C1()) return
    const r = a.type === REC.remove ? { type: a.type, key: a.path } : { type: a.type, key: a.path, value: a.value }
    deltas = []
    try { lane([r]) } catch (e) { if (!stopped) console.warn('05: data stopped on a record', r, e?.message ?? e); stopped = true; ver++; return }
    const row = String(a.path[0])
    const d = deltas.find((x) => String(x.key) === row)  // data's own change to `hungry` for this row, if any
    if (d?.op === 'add') joined.set(row, performance.now())
    if (d && (d.op === 'add' || d.op === 'remove')) say(`${row} ${EFFECT[d.op]}`)
    // c1's own write: core.js marks it committed, with this record's stamp, just before it emits this apply
    let mine = null
    for (let i = page.writes.length - 1; i >= 0 && !mine; i--) {
      const w = page.writes[i]
      if (w.node === a.node && w.state === 'committed' && w.stamp && w.stamp.epoch === a.epoch && w.stamp.seq === a.seq && w.stamp.origin === a.origin) mine = w
    }
    if (mine && a.path.length === 1) last = { row, value: a.value, remove: a.type === REC.remove, effect: d ? d.op : (inHungry(row) ? 'update' : 'not'), at: performance.now() }
    ver++
  })

  // after each step: data's answer against a check of each cat in c1's copy by hand, then paint
  function check() {
    checkedVer = ver
    checks++
    try {
      const copy = page.object(C1())
      const plain = Object.fromEntries(Object.entries(copy).filter(([, cat]) => isHungry(cat)))
      if (stable(held()) !== stable(plain) || stable(src[D.value]) !== stable(copy)) differ++
    } catch { differ++ }
  }
  page.on('tick', () => {
    if (state === 'ready' && ver !== checkedVer) check()
    if (onScreen && ver !== painted) paint()
  })
  page.on('reset', () => { last = null; if (D && state === 'ready') { build(); check() } else ver++; paint(true) })
  for (const ev of ['kill', 'restart']) page.on(ev, () => { ver++ })

  // ── loading data: once, when the section comes near ──
  async function load() {
    if (state !== 'idle') return
    setState('loading')
    const t0 = performance.now()
    const slow = setTimeout(() => { if (state === 'loading') setState('slow') }, SLOW)
    try {
      D = await import(`${PKG}/dist/api/index.js`)      // data's public entry: exports["."]
      const ms = performance.now() - t0
      // what this tab pulled from the package (resource timing; jsDelivr sends timing-allow-origin). A file this
      // browser already held reports no transfer: it is counted as cached, never as bytes from jsDelivr.
      let files = 0, net = 0, cached = 0
      for (const e of performance.getEntriesByType('resource')) {
        if (!e.name.startsWith(PKG + '/')) continue
        files++
        if (e.transferSize > 0) net += e.transferSize
        else if (e.decodedBodySize > 0) cached++
      }
      meas = { ms, files, kb: Math.round(net / 1024), cached }
      build()
      check()
      setState('ready')
    } catch (e) {
      console.warn('05: data could not load from jsDelivr:', e?.message ?? e)
      setState('failed')
    } finally { clearTimeout(slow) }
  }
  function setState(s) { state = s; fig.dataset.state = s; ver++; paint(true) }

  // root: document, so the margins also hold in a cross-origin frame (a hosted preview); see next/sections/data.js
  const io = (cb, rootMargin) => { try { return new IntersectionObserver(cb, { root: document, rootMargin }) } catch { return new IntersectionObserver(cb, { rootMargin }) } }
  const near = io((es) => { if (es.some((e) => e.isIntersecting)) { near.disconnect(); load() } }, '1200px 0px')
  near.observe(root)
  let onScreen = false
  io((es) => { onScreen = es.some((e) => e.isIntersecting); if (onScreen) paint(true) }, '120px 0px').observe(root)

  // ── the code: one line per statement when it fits, else the statements broken the way a formatter would ──
  // the room is measured (characters that fit across the code), and the layout chosen from what is printed now: a
  // fixed floor of WIDE keeps it from flipping as the comments change; only an unusual comment (three hungry cats)
  // can need more, and then the lines break rather than scroll
  let mode = 'wide', room = Infinity
  function measure() {
    const probe = document.createElement('span')
    probe.textContent = '0'.repeat(20)
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
    pre.append(probe)
    const cw = probe.getBoundingClientRect().width / 20
    probe.remove()
    const cs = getComputedStyle(pre)
    const avail = pre.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const r = cw > 0 ? avail / cw : Infinity
    if (r !== room) { room = r; paint(true) }
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(pre)

  const IDENT = /^[A-Za-z_$][\w$]*$/
  const lit = (v) => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : v === undefined ? 'undefined' : JSON.stringify(v))
  // a value as the code would spell it: { mood: 'zoomies' } on one line, or one field per line when narrow
  function spell(v, narrow) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return lit(v)
    const ks = Object.keys(v)
    if (!ks.length) return '{}'
    const fields = ks.map((k) => `${IDENT.test(k) ? k : lit(k)}: ${typeof v[k] === 'object' && v[k] !== null ? JSON.stringify(v[k]) : lit(v[k])}`)
    return narrow ? `{\n    ${fields.join(',\n    ')}\n}` : `{ ${fields.join(', ')} }`
  }
  const target = (row) => `cafe.data${IDENT.test(row) ? '.' + row : `[${lit(row)}]`}`
  // the visible length of a line's last row of text (what the comments line up after)
  const tail = (s) => s.length - s.lastIndexOf('\n') - 1

  function codeHTML() {
    const wide = spellCode(false)
    mode = room >= Math.max(WIDE, wide.chars) ? 'wide' : 'narrow'
    if (fig.dataset.mode !== mode) fig.dataset.mode = mode
    const out = mode === 'wide' ? wide : spellCode(true)
    keepRoom(out.keep)
    return out.html
  }
  function spellCode(narrow) {
    const head = `<span class="c">// who wants dinner?</span>\n`
    // line 1: the filter, and data's answer (read first: a filter that cannot read a row marks data stopped). Narrow,
    // the arrow function gets its own line; on a phone too narrow even for that line (360 px), its body breaks too
    const arrow = '(cat) => cat.mood === \'hungry\''
    const fn = !narrow ? arrow : room >= 4 + arrow.length ? `\n    ${arrow}\n` : '\n    (cat) =>\n        cat.mood === \'hungry\'\n'
    const l1 = `const hungry = cafe.data.filter(${fn})`
    const l1h = esc(l1).replace(/^const/, '<span class="k">const</span>').replace('&#39;hungry&#39;', '<span class="s">&#39;hungry&#39;</span>')
    const names = state === 'ready' ? Object.keys(held()) : []
    const c1h = state === 'failed' ? 'the data library did not load'
      : state !== 'ready' ? '…'
      : stopped ? 'the data library stopped'
      : names.length ? names.map((n) => `<span class="vw-n${recent(joined.get(n)) ? ' new' : ''}">${esc(n)}</span>`).join(', ')
      : '<span class="vw-n">nobody</span>'
    // line 2, only for a real write: c1's latest, and what it did to `hungry`
    let l2 = null, l2h = '', c2h = ''
    if (state === 'ready' && !stopped && last) {
      l2 = last.remove ? `delete ${target(last.row)}` : `${target(last.row)} = ${spell(last.value, narrow)}`
      l2h = last.remove ? `<span class="k">delete</span> ${esc(target(last.row))}` : `${esc(target(last.row))} = <span class="w">${esc(spell(last.value, narrow))}</span>`
      c2h = `<span class="vw-eff">${esc(EFFECT[last.effect] ?? '')}</span>`
    }
    // the comments line up one tab after the longer statement; narrow, each trails its statement's last line, or
    // sits on the line under it when it would not fit there (a long comment on a phone: it breaks, it never scrolls)
    const text = (h) => h.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&[a-z]+;/g, '.')
    const col = narrow ? 0 : Math.max(tail(l1), l2 ? tail(l2) : 0) + 4
    const gap = (s, c) => narrow ? (tail(s) + 3 + 3 + text(c).length <= room ? '   ' : '\n') : ' '.repeat(Math.max(2, col - tail(s)))
    let html = head + l1h + gap(l1, c1h) + `<span class="c">// ${c1h}</span>`
    if (l2) html += `\n<span class="vw-l2${recent(last.at) ? ' fresh' : ''}">${l2h}</span>${gap(l2, c2h)}<span class="c">// ${c2h}</span>`
    // no second line yet (no write of c1's, data still loading, or data stopped): the card keeps that line's room,
    // empty, so it does not grow when the first write lands. The room is what the scripted visitor's write takes in
    // this layout: one line wide; narrow, its value one field per line, and one more line when its comment would not
    // fit after it. Not when data could not load: no write will ever show then, and the card stays one statement.
    let keep = 0
    if (!l2 && state !== 'failed') {
      const w = page.writer ?? {}
      const s = `${target(w.row ?? 'luna')} = ${spell({ [w.field ?? 'mood']: 'purring' }, narrow)}`
      keep = s.split('\n').length + (gap(s, LONGEST) === '\n' ? 1 : 0)
    }
    // the characters the widest line takes: the comment column plus the longer comment (text, not markup)
    return { html, chars: col + Math.max(text(c1h).length, text(c2h).length) + 3, keep }
  }
  // the empty room for the second line, drawn after the code by views.css: data-keep, and --vw-keep lines tall
  function keepRoom(n) {
    const v = n > 0 ? String(n) : undefined
    if (pre.dataset.keep === v) return
    if (v) { pre.dataset.keep = v; pre.style.setProperty('--vw-keep', v) }
    else { delete pre.dataset.keep; pre.style.removeProperty('--vw-keep') }
  }

  // ── painting ──
  let codePainted = ''
  // a write or a join is "just now" for 1.6 s of wall time: its violet fades once (calm.css: violet is a write)
  const recent = (t) => !REDUCED && t !== undefined && performance.now() - t < 1600
  function paint(force = false) {
    if (!onScreen && !force) return
    painted = ver
    const html = codeHTML()
    if (html !== codePainted) { pre.innerHTML = html; codePainted = html }
    paintStatus(); paintDoor()
  }

  // the caption's second sentence: where it runs, or, in red, what went wrong
  let statusKey = null
  function paintStatus() {
    const id = C1(), up = page.alive(id), bad = '<span class="bad" aria-hidden="true">✕ </span>'
    const key = `${state}|${up}|${id}|${stopped}|${differ > 0}`
    if (key === statusKey) return
    statusKey = key
    if (state === 'ready') {
      status.innerHTML = stopped ? `${bad}The data library stopped: the filter could not read a row.`
        : differ ? `${bad}The filter's rows are not the same as checking each cat by hand.`
        : up ? 'In your tab, the data library from npm runs it on client <span class="vw-id"></span>\'s copy.'
        : 'Client <span class="vw-id"></span> is down, so no new writes reach this copy.'
      const idEl = status.querySelector('.vw-id')
      if (idEl) attest(idEl, id, 'runtime')
    } else {
      status.textContent = state === 'loading' ? 'Loading the data library from npm…'
        : state === 'slow' ? 'The data library is slow to load from npm. The rest of the page works without it.'
        : state === 'failed' ? 'The data library could not load from npm here. The rest of the page works without it.'
        : 'The data library loads from npm as you scroll here.'
      if (state === 'failed') status.insertAdjacentHTML('afterbegin', bad)
    }
  }

  let doorKey = null
  function paintDoor() {
    attest(c1El, C1(), 'runtime')
    const key = `${state}|${checks}|${differ}|${stopped}`
    if (key === doorKey) return
    doorKey = key
    const n = (v, tier) => `<b data-attested="${tier}">${typeof v === 'number' ? v.toLocaleString('en-US') : esc(v)}</b>`
    if (state === 'ready' && meas) {
      const version = PKG.match(/@([\d.]+)$/)?.[1] ?? ''
      // a number never leaves its unit at a line's end (&nbsp;)
      const time = `in ${n(Math.round(meas.ms), 'measured')}&nbsp;ms on this machine`
      const what = !meas.files ? `${time}`
        : meas.cached === meas.files ? `${n(meas.files, 'measured')}&nbsp;files from this browser's cache, ${time}`
        : `${n(meas.files, 'measured')}&nbsp;files${meas.kb ? `, ${n(meas.kb, 'measured')}&nbsp;KB` : ''}, ${time}`
      loadEl.innerHTML = `This page loaded the <b>data</b> library, version&nbsp;${n(version, 'build')}, from npm through jsDelivr: ${what}.`
      // the tally stays on one line, so a growing count never leaves "so far." alone
      checksEl.innerHTML = `${CHECKS}: <span class="vw-tally">${n(checks - differ, 'runtime')} of ${n(checks, 'runtime')} agree so far.</span>`
    } else {
      loadEl.textContent = state === 'failed' ? 'The data library could not load from npm through jsDelivr here, so nothing below runs.' : 'This page loads the data library from npm through jsDelivr when you scroll here.'
      checksEl.textContent = CHECKS + '.'
    }
  }

  // a short spoken note when a cat joins or leaves, only while the section is on screen
  function say(text) { if (onScreen) said.textContent = text }

  measure()
  paint(true)
}
