// sections/data.js — 07 Built on data.
//
// What runs here: data 4.0.0, the files `npm i data` installs, loaded from jsDelivr only once this section comes near.
// Into it go the records c1's kernel applies (page.on('apply') for node c1), one lane() call per record. That is what
// fero's api does on every node: api/data.ts #apply → api/substrate.ts applyRec → data's lane(p, …) on the source
// handle that `shop.data` sits on. On top sits the README's view, `shop.data.filter((r) => r.stock < 2)`, which is
// data's filter on that source (api/substrate.ts lens: operators delegate to the handle). It moves when the house
// writer dips gadgets below 2.
//
// Every printed digit is RUNTIME (the kernel's records, stamps and counts; data's own rows, deltas, report and
// constants, read in this tab), MEASURED (data's load: files, KB, ms — "this machine"), or BUILD (data/data/sync.json,
// written by tools/data-sync.mjs from the two checkouts). Nothing is typed.
import { page, attest, REC, stable, REDUCED, onFrame, pair } from '../cluster.js'
import { stamp as stampHTML, inspect, esc, vt } from '../ui.js'

const PKG = 'https://cdn.jsdelivr.net/npm/data@4.0.0'   // the version this section was checked against (sections/data.md)
const NODE = 'c1'                                        // the house client: the README's watcher
const TAPE = 2                                           // records on the tape
const CHANGES = 2                                        // data's changes to low on its tape
const ROWS = 5                                           // rows per table before "+ N more"
// A write the house writer issued shows as waiting only once it has waited longer than a routine round trip can
// take (c1 → its server → the owner and back: four hops of 30–90 ms simulated). Shorter waits keep the last write
// on screen, so the column does not blink every 2.5 s. A visitor's own write shows as waiting at once.
const ROUTINE = 400
const IDENT = /^[A-Za-z_$][\w$]*$/                       // ui.js inspect()'s rule: a bare key, else a quoted one

const root = document.getElementById('data')
if (root) main(root)

function main(root) {
  const q = (s) => root.querySelector(s)
  const el = {
    who: q('.dt-fero .nm'), nrec: q('#dt-nrec'), tape: q('#dt-tape'), wait: q('#dt-wait'), write: q('#dt-write'),
    nsrc: q('#dt-nsrc'), src: q('#dt-src-rows'), report: q('#dt-report'),
    nlow: q('#dt-nlow'), low: q('#dt-low-rows'), delta: q('#dt-delta'),
    status: q('#dt-status'), below: q('#dt-below'),
    imp: q('#dt-import'), nnames: q('#dt-nnames'), names: q('#dt-names'), ntests: q('#dt-ntests'),
    types: q('#dt-types'), sched: q('#dt-sched'),
  }
  const ROW = page.writer?.row ?? 'gadgets'              // the scripted writer's row (core.js HOUSE.writer)
  // a record as ui.js rec() draws it (the same tokens and classes), with each field kept whole (.f) so a narrow
  // column breaks between fields, never inside { stock: 6 } (ui.js has no such option; see sections/data.md)
  const TYPE = ['update', 'insert', 'remove']
  const fields = (fs) => `<span class="rec"><span class="p">{ </span>${fs.map((x, i) => `<span class="f">${x}<span class="p">${i < fs.length - 1 ? ',' : ' }'}</span></span>`).join(' ')}</span>`
  const recWrap = (r) => {
    const fs = [`<span class="k">type</span><span class="p">:</span> <span class="n" title="${TYPE[r.type] ?? r.type}">${esc(r.type)}</span>`,
      `<span class="k">key</span><span class="p">:</span> <span class="p">[</span>${r.key.map((k) => `<span class="s">'${esc(k)}'</span>`).join('<span class="p">, </span>')}<span class="p">]</span>`]
    if (r.type !== REC.remove) fs.push(`<span class="k">value</span><span class="p">:</span> ${inspect(r.value)}`)
    return fields(fs)
  }
  const unit = (n, one, many) => (n === 1 ? one : many)
  // a node's name is an identifier, not a figure: printed as a literal (the audit's data-literal), plain ink
  const L = (id) => `<span data-literal>${esc(id)}</span>`
  page.watch(root)

  // ── data's side: the same objects fero's api builds on a node ──
  let D = null, C = null, version = '', versionTier = 'runtime'
  let src = null, apply = null, low = null, subs = []
  let report = { applied: 0, rejected: 0 }
  let changes = []                                     // data's last changes to `low`: { d, s, mine } (s: the stamp of the record that caused it)
  let cause = null                                     // { s, mine } for the record being handed to lane() right now
  let dataVer = 0, dataPainted = -1, emptyPainted = ''
  let checks = 0, differ = 0                           // comparisons of data's source with c1's copy, and misses
  const flashSrc = new Set(), flashLow = new Set()
  let loading = false, loaded = false, failed = null, meas = null

  // ── fero's side: every record c1's kernel applies, from its first (subscribed now, long before data is here) ──
  // Once data is here, each record goes into lane() right inside c1's apply, as fero's api does it (api/data.ts
  // #onApply → applyRec, synchronously), and data's whole source is compared with c1's whole copy after it. Before
  // data is here, a record waits in `queue` with c1's copy as it stood right after it, so the catch-up is checked
  // record by record too.
  let queue = []        // { r, want, s, mine }: records not yet handed to data, in apply order (s: the stamp)
  let tape = []         // the newest few: { r, s, mine, n }
  let nrec = 0          // records c1 has applied in this life of this run
  let lifeSince = 0     // page.now when this run (or c1's present life) began: older writes went into an older source
  let tapeVer = 0, tapePainted = -1, freshAt = 0
  // a visitor's write from c1: any control on the page posts it with by: 'page'. core.js marks it committed, with the
  // stamp its owner gave it, just before it emits the apply that carries it, so the stamp pairs the two
  const sameStamp = (x, s) => !!x && x.epoch === s.epoch && x.seq === s.seq && x.origin === s.origin
  const yours = (s) => page.writes.some((w) => w.node === NODE && w.by === 'page' && w.state === 'committed' && sameStamp(w.stamp, s))
  page.on('apply', (a) => {
    if (a.node !== NODE) return
    // the record exactly as the kernel carries it (kernel/env.ts Rec): a remove has no value
    const r = a.type === REC.remove ? { type: a.type, key: a.path } : { type: a.type, key: a.path, value: a.value }
    const s = { epoch: a.epoch, seq: a.seq, origin: a.origin }   // the stamp its owner gave it
    const mine = yours(s)
    nrec++
    tape.unshift({ r, s, mine, n: nrec })
    if (tape.length > TAPE) tape.length = TAPE
    tapeVer++
    if (failed) return                                   // data will not come: nothing to hand it to
    const want = stable(page.object(NODE))               // c1's whole copy, right after this record
    if (apply) take(r, want, s, mine)
    else { queue.push({ r, want, s, mine }); if (queue.length > 20000) compact() }
  })
  // only if data stays away for hours of simulated time: keep, per row, what follows its last whole-row record (a
  // whole-row update or remove replaces the row, so the fold is the same); then only the final copy can be checked
  function compact() {
    const byRow = new Map(), end = queue[queue.length - 1].want
    for (const x of queue) {
      if (x.r.key.length <= 1) byRow.set(x.r.key[0], [x])
      else (byRow.get(x.r.key[0]) ?? byRow.set(x.r.key[0], []).get(x.r.key[0])).push(x)
    }
    queue = [...byRow.values()].flat().map((x) => ({ r: x.r, want: null, s: x.s, mine: x.mine }))
    queue[queue.length - 1].want = end
  }

  function build() {
    for (const s of subs) { try { s.dispose() } catch { /* already gone */ } }
    subs = []
    try { low?.dispose() } catch { /* already gone */ }
    try { src?.dispose() } catch { /* already gone */ }
    src = D.$({})
    apply = D.lane(src)                                      // exactly the line the card shows; a reject throws, take() counts it
    low = src.filter((r) => r.stock < 2)
    subs.push(src.sink({ apply: (b) => { for (const d of b.rows) flashSrc.add(String(d.key)) } }))
    // data's sinks run inside the lane() call, so `cause` is the record that made this change (SCHEDULE clause 1)
    subs.push(low.sink({ apply: (b) => { for (const d of b.rows) { changes.unshift({ d, s: cause?.s ?? null, mine: !!cause?.mine }); flashLow.add(String(d.key)) } if (changes.length > CHANGES) changes.length = CHANGES } }))
    report = { applied: 0, rejected: 0 }
    changes = []
    checks = 0; differ = 0
    dataVer++
  }
  // one record into data: one lane() call, as api/substrate.ts applyRec makes it; then the whole source against
  // c1's whole copy as it stood right after that record
  function take(r, want, s, mine) {
    cause = { s, mine }
    try { const rep = apply([r]); report.applied += rep.applied; report.rejected += rep.rejected }
    catch (e) { report.rejected++; console.error('07: data refused a record', r, e) }
    cause = null
    if (want !== null) { checks++; if (stable(src[D.value]) !== want) differ++ }
    dataVer++
  }
  // the catch-up, once data is here: every record c1 applied before, in order
  function feed() {
    if (!apply || !queue.length) return
    const batch = queue
    queue = []
    for (const x of batch) take(x.r, x.want, x.s, x.mine)
  }

  async function load() {
    if (loading || loaded) return
    loading = true
    paint(true)
    const t0 = performance.now()
    try {
      const [d, c] = await Promise.all([
        import(`${PKG}/dist/api/index.js`),          // data's public entry: exports["."]
        import(`${PKG}/dist/contract/index.js`),     // the module that entry takes its contract from
      ])
      const ms = performance.now() - t0
      D = d; C = c
      // the version is the one the pinned URL names, the URL the modules were just imported from. No fetch of its
      // package.json: a host that loads scripts but refuses fetch() (a hosted preview, connect-src 'self') logged
      // two console errors for it on every load, for the same answer
      version = PKG.match(/@([\d.]+)$/)?.[1] ?? ''; versionTier = 'build'
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
      loaded = true
      build()
      feed()
    } catch (e) {
      failed = e
      console.warn('07: data could not load from jsDelivr:', e?.message ?? e)
    } finally {
      loading = false
      paintFacts()
      paint(true)
    }
  }

  // ── when to work: load once near; paint only while on screen ──
  let onScreen = false
  // root: document, so the margins also work in a cross-origin frame (a hosted preview): there the default root is the
  // top-level viewport and the browser drops rootMargin, so data would only start loading once 07 was on screen. At
  // the top level both roots behave the same. (A browser that refuses a document root gets the default one.)
  const io = (cb, rootMargin) => { try { return new IntersectionObserver(cb, { root: document, rootMargin }) } catch { return new IntersectionObserver(cb, { rootMargin }) } }
  const near = io((es) => { if (es.some((e) => e.isIntersecting)) { near.disconnect(); load() } }, '700px 0px')
  near.observe(root)
  io((es) => { onScreen = es.some((e) => e.isIntersecting); if (onScreen) paint(true) }, '120px 0px').observe(root)

  // 'tick' fires after each step of the simulation; every record of that step is already in data: paint
  let stale = false
  page.on('tick', () => {
    if (!onScreen) return
    if (stale || tapeVer !== tapePainted || dataVer !== dataPainted) { stale = false; paint() }
    else if (page.alive(NODE) && page.waiting(NODE).length) { paintWait(); paintButton() }
  })
  // these can fire in the middle of a step (inside the kernel's callbacks), before c1's record reaches the 'apply'
  // listener: never paint there, or the check would compare data with a copy one record ahead. Paint on the next tick.
  for (const ev of ['commit', 'write', 'view', 'left']) page.on(ev, () => { stale = true })
  // these only come from a visitor's action, between steps: paint now (the page may be paused, with no ticks)
  for (const ev of ['kill', 'leave', 'cut', 'heal', 'writer', 'restart']) page.on(ev, () => paint())
  // pause is a plain flag (the dock sets page.paused), with no event and no ticks while it holds: watch it per frame
  let wasPaused = page.paused
  onFrame(() => { if (page.paused !== wasPaused) { wasPaused = page.paused; if (onScreen) { paintWait(); paintButton() } } })
  // a reset rebuilds the run and starts a fresh data source, as a new process would. core.js refuses to restart a
  // client (it has no disk, so a crashed c1 stays down until a reset); if a later driver allows it, that next life is
  // a new process too, with its own fresh source
  page.on('reset', () => fresh())
  page.on('restart', (id) => { if (id === NODE) fresh() })
  function fresh() {
    queue = []; tape = []; nrec = 0; tapeVer++
    lifeSince = page.now
    if (loaded) build()
    paint(true)
  }

  // ── the one control: c1 assigns the writer's row, as `shop.data.gadgets = { stock: v }` ──
  // It waits only for the visitor's own write (one at a time), never for the house writer's routine one, and it
  // uses aria-disabled, so keyboard focus stays on it while a write is out.
  el.write.addEventListener('click', () => {
    paintButton()                                      // the label is exactly what the click posts
    if (el.write.getAttribute('aria-disabled') === 'true') return
    try { page.write(NODE, ROW, { stock: +el.write.dataset.v }) } catch (e) { console.error(e); return }
    paint(true)
  })
  // dip the row below 2 when it is at 2 or more, else lift it back up. It starts from c1's copy, or from a write of
  // c1's still on its way (the house writer's), so it never posts the value that write carries
  const nextStock = (row) => (row && typeof row.stock === 'number' && row.stock < 2 ? 5 : 1)

  // the assignment a write stands for, as a program would spell it: `shop.data.gadgets = …`, or `shop.data['sale-c1-1']`
  // for a key that is not a bare name (ui.js inspect()'s rule); `delete …` for a remove
  const plain = (v) => {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    if (typeof v !== 'object') return String(v)
    if (Array.isArray(v)) return v.length ? `[ ${v.map(plain).join(', ')} ]` : '[]'
    const ks = Object.keys(v)
    return ks.length ? `{ ${ks.map((k) => `${IDENT.test(k) ? k : plain(k)}: ${plain(v[k])}`).join(', ')} }` : '{}'
  }
  const target = (row) => `shop.data${IDENT.test(row) ? '.' + row : `[${plain(row)}]`}`
  const assign = (w) => (w.remove ? `delete ${target(w.path[0])}` : `${target(w.path[0])} = ${plain(w.value)}`)

  // ── painting ──
  function paint(force = false) {
    if (!onScreen && !force) return
    paintTape(); paintWait(); paintData(); paintStatus(); paintButton()
  }

  function paintTape() {
    attest(el.who, page.alive(NODE) ? page.origin(NODE) : NODE, 'runtime')       // c1, or c1~2 in its next life
    attest(el.nrec, nrec, 'runtime')
    el.nrec.nextSibling.textContent = ` ${unit(nrec, 'record', 'records')}`
    if (tapeVer === tapePainted) return
    const isNew = tapePainted >= 0 && tape.length
    tapePainted = tapeVer
    if (!tape.length) { el.tape.innerHTML = `<li class="dt-empty">waiting for ${L(NODE)}'s first record</li>`; return }
    if (isNew) freshAt = performance.now()
    el.tape.innerHTML = tape.map((t, i) => {
      const top = i === 0 && isNew
      const st = stampHTML(t.s).replace('class="stamp"', `class="stamp${top ? ' fresh' : ''}"`)
      return `<li class="dt-rec${top && !REDUCED ? ' in' : ''}" data-attested="runtime">${recWrap(t.r)}<span class="dt-st">${st}${t.mine ? '<span class="dt-yours">← your write</span>' : ''}</span></li>`
    }).join('')
    if (isNew) setTimeout(() => { if (performance.now() - freshAt >= 1400) el.tape.querySelector('.stamp.fresh')?.classList.remove('fresh') }, 1450)
  }

  // the last write of c1's (this life) that committed: the visitor's, while it is one of the last two, else the newest
  function lastDone() {
    let last = null, prev = null
    for (let i = page.writes.length - 1; i >= 0; i--) {
      const w = page.writes[i]
      if (w.node !== NODE || w.state !== 'committed' || w.issuedAt < lifeSince) continue
      if (!last) last = w
      else { prev = w; break }
    }
    return last && last.by !== 'page' && prev?.by === 'page' ? prev : last
  }
  // where a committed write went, by what this tab knows about data
  const tail = () => (loaded ? 'then went into data' : failed ? `; ${L(NODE)} holds it, but data did not load here` : '; data takes it once it loads')

  let waitHTML = null
  function paintWait() {
    let html, tier = 'runtime'
    if (!page.alive(NODE)) {
      html = `<span class="bad">✕ ${L(NODE)} is down</span> · a client has no disk, so no records reach data until a reset`
      tier = null
    } else {
      const ws = page.waiting(NODE).filter((w) => w.issuedAt >= lifeSince)
      const pend = [...ws].reverse().find((w) => w.by === 'page' || page.now - w.issuedAt >= ROUTINE)
      const done = pend ? null : lastDone()
      if (pend) html = `<span class="waiting">waiting</span> · <code>${esc(assign(pend))}</code><br><span class="waiting"><b>${vt(page.now - pend.issuedAt)}</b></span>, simulated&nbsp;· ${why(pend)}`
      else if (done) html = `${done.by === 'page' ? 'your write' : 'last write'} · <code>${esc(assign(done))}</code><br>waited <b>${vt(done.committedAt - done.issuedAt)}</b>, simulated${loaded ? ', ' : ''}${tail()}`
      else { html = `${L(NODE)} has not written yet`; tier = null }
    }
    if (html === waitHTML) return
    waitHTML = html
    el.wait.innerHTML = `<span class="dt-w">${html}</span>`
    if (tier) el.wait.setAttribute('data-attested', tier); else el.wait.removeAttribute('data-attested')
  }

  // why a write from c1 is not in data yet, from the cluster's own state (a write shows when it commits). Each
  // blocker is checked where the write really is: c1, then the server c1 follows, then the owner in THAT server's view.
  const GATE = { minority: 'cannot reach a majority of its view', evicted: 'was voted out', rejoining: 'is rejoining the view', 'stale-epoch': 'is behind on the view' }
  const gateWords = (id, g) => (g.reason === 'minority' ? noMajority(id) : g.reason === 'evicted' ? notIn(id) : GATE[g.reason] ?? 'takes no writes right now')
  // the kernel's 'evicted' gate: the server is not in the view it holds. Either it was voted out, or the others have
  // just voted it in and the news has not reached it yet (page.view(): the newest view any live server holds)
  function notIn(id) {
    const now = page.view(), its = page.viewOf(id)
    return now.epoch > its.epoch && now.members.includes(id) ? `is in view&nbsp;${now.epoch} now, but does not know it yet` : GATE.evicted
  }
  // the kernel's 'minority' gate (kernel/membership.ts gate()): a server counts itself and each member of its view it
  // has a working link to, and needs more than half. A crash closes it as well as a cut, so say who it cannot reach and
  // why: down (crashed), left, cut off by the page (page.cuts), or a link that is not back yet after a heal or restart
  const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  const count = (n) => COUNT[n] ?? String(n)
  const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
  const names = (xs) => and(xs.map(L))
  function noMajority(id) {
    const v = page.viewOf(id), linked = new Set(page.peers(id))
    const lost = v.members.filter((m) => m !== id && !linked.has(m))
    if (!lost.length || !v.members.includes(id)) return GATE.minority
    const up = (m) => page.alive(m), cut = (m) => page.cuts.has(pair(id, m))
    const down = lost.filter((m) => !up(m) && !page.left.has(m)), left = lost.filter((m) => !up(m) && page.left.has(m))
    const off = lost.filter((m) => up(m) && cut(m)), back = lost.filter((m) => up(m) && !cut(m))
    const why = []
    if (down.length) why.push(`${names(down)} ${down.length === 1 ? 'is' : 'are'} down`)
    if (left.length) why.push(`${names(left)} ${left.length === 1 ? 'has' : 'have'} left`)
    if (off.length) why.push(`it is cut off from ${names(off)}`)
    if (back.length) why.push(`its ${back.length === 1 ? 'link' : 'links'} to ${names(back)} ${back.length === 1 ? 'is' : 'are'} not back yet`)
    return `cannot reach a majority: ${why.join(', ')}, and ${count(v.members.length - lost.length)} of ${count(v.members.length)} is not a majority`
  }
  // a pause stops the whole simulation, but it is never the whole story: the real blocker comes first, then the pause.
  // Only a write that nothing else holds back says "the cluster is paused" alone (it moves on as soon as play is pressed).
  function blocker(w) {
    const b = holdsBack(w)
    if (!page.paused) return b
    return b.until ? { why: 'the cluster is paused' } : { why: `${b.why}&nbsp;· the cluster is paused` }
  }
  function holdsBack(w) {
    if (page.isolated(NODE)) return { why: `${L(NODE)} is cut off` }
    const p = page.primary(NODE)
    if (!p || !page.alive(p)) return { why: `${L(NODE)} has no server right now` }
    if (page.cuts.has(pair(NODE, p))) return { why: `${L(NODE)} is cut off from its server ${L(p)}` }
    const g = page.writable(p)
    if (g && !g.open) return { why: `its server ${L(p)} ${gateWords(p, g)}` }
    const owner = page.owner(w.path[0], p)               // the owner in the view c1's server holds
    if (!owner) return { why: 'no view yet' }
    if (!page.alive(owner)) return { why: `its owner ${L(owner)} is down` }
    if (page.isolated(owner)) return { why: `its owner ${L(owner)} is cut off` }
    if (owner !== p && page.cuts.has(pair(p, owner))) return { why: `its server ${L(p)} is cut off from its owner ${L(owner)}` }
    const og = page.writable(owner)
    if (og && !og.open) return { why: `its owner ${L(owner)} ${gateWords(owner, og)}` }
    return { until: owner }
  }
  function why(w) {
    const b = blocker(w)
    if (failed) return b.until ? `until ${L(b.until)} stamps it` : b.why
    return b.until ? `not in data until ${L(b.until)} stamps it` : `not in data: ${b.why}`
  }

  let btnHTML = null
  function paintButton() {
    const alive = page.alive(NODE)
    const ws = alive ? page.waiting(NODE) : []
    const yoursOut = ws.some((w) => w.by === 'page' && w.issuedAt >= lifeSince)
    const onRow = [...ws].reverse().find((w) => w.path[0] === ROW && !w.remove)
    const v = nextStock(onRow ? onRow.value : alive ? page.object(NODE)[ROW] : undefined)
    const html = `<code>${esc(target(ROW))} = { stock: ${v} }</code> ▸`
    if (html !== btnHTML) { el.write.innerHTML = html; btnHTML = html }
    if (el.write.dataset.v !== String(v)) el.write.dataset.v = String(v)
    const off = String(!alive || !page.isReady || yoursOut)
    if (el.write.getAttribute('aria-disabled') !== off) el.write.setAttribute('aria-disabled', off)
    const title = !alive ? `${NODE} is down` : !page.isReady ? 'the cluster is still starting'
      : yoursOut ? 'your write is still waiting: one at a time'
      : `posts the record this assignment becomes, { type: 0, key: ['${ROW}'], value: { stock: ${v} } }, from ${NODE}`
    if (el.write.title !== title) el.write.title = title
  }

  const table = (obj, keys, flash) => `<div class="dt-th"><span>key</span><span>row</span></div>` +
    keys.slice(0, ROWS).map((k) => `<div class="dt-tr"><span class="k" title="${esc(k)}">${esc(k)}</span><span class="v${flash.has(k) ? ' flash' : ''}"><span class="rec">${inspect(obj[k])}</span></span></div>`).join('') +
    (keys.length > ROWS ? `<div class="dt-more">+ ${keys.length - ROWS} more rows</div>` : '')
  // data's row delta (contract/delta.ts), printed the way the examples print objects
  const kv = (k, v) => `<span class="k">${k}</span><span class="p">: </span>${v}`
  const str = (s) => `<span class="s">'${esc(s)}'</span>`
  const delta = (d) => {
    const parts = [kv('op', str(d.op)), kv('key', str(String(d.key)))]
    if (d.op !== 'remove') parts.push(kv('row', inspect(d.row)))
    if (d.op !== 'add') parts.push(kv('prev', inspect(d.prev)))
    if (d.op === 'update') parts.push(kv('path', d.path?.length ? inspect(d.path) : '<span class="p">[]</span>'))
    return fields(parts)
  }

  function paintData() {
    if (!loaded) {
      // before data is here: say what is happening, once per state
      const st = failed ? 'failed' : loading ? 'loading' : 'idle'
      if (st === emptyPainted) return
      emptyPainted = st
      if (st === 'failed') {
        if (el.nsrc.isConnected) el.nsrc.parentElement.textContent = 'not loaded'
        if (el.nlow.isConnected) el.nlow.parentElement.textContent = 'not loaded'
        el.src.innerHTML = '<div class="dt-empty">data did not load, so there is no source here</div>'
        el.low.innerHTML = '<div class="dt-empty">no view without data</div>'
        el.delta.innerHTML = '<li class="dt-empty">nothing to show</li>'
        el.report.innerHTML = '<code>apply([record])</code> never ran'
        el.below.textContent = 'data could not load from jsDelivr here, so the view below cannot run.'
      } else if (st === 'loading') {
        el.src.innerHTML = '<div class="dt-empty">loading data from jsDelivr …</div>'
        el.low.innerHTML = '<div class="dt-empty">loading data from jsDelivr …</div>'
      }
      return
    }
    if (dataVer === dataPainted) return
    dataPainted = dataVer
    const rows = src[D.value]                         // a fresh plain object: data materializes it on read
    const keys = Object.keys(rows)
    attest(el.nsrc, keys.length, 'runtime')
    el.nsrc.nextSibling.textContent = ` ${unit(keys.length, 'row', 'rows')}`
    el.src.innerHTML = keys.length ? table(rows, keys, flashSrc) : '<div class="dt-empty">no rows yet</div>'
    if (keys.length) el.src.setAttribute('data-attested', 'runtime'); else el.src.removeAttribute('data-attested')
    el.report.innerHTML = `<code>apply([record])</code> once per record<br>applied <b>${report.applied.toLocaleString('en-US')}</b> · rejected <b>${report.rejected.toLocaleString('en-US')}</b>`
    el.report.setAttribute('data-attested', 'runtime')
    const lv = low[D.value]
    const lk = Object.keys(lv)
    attest(el.nlow, lk.length, 'runtime')
    el.nlow.nextSibling.textContent = ` ${unit(lk.length, 'row', 'rows')}`
    el.low.innerHTML = lk.length ? table(lv, lk, flashLow) : `<div class="dt-empty">no row passes <code>r.stock &lt; 2</code> right now</div>`
    if (lk.length) el.low.setAttribute('data-attested', 'runtime'); else el.low.removeAttribute('data-attested')
    el.delta.innerHTML = changes.length
      ? changes.map((c, i) => `<li class="dt-rec${i === 0 && flashLow.size && !REDUCED ? ' in' : ''}" data-attested="runtime">${delta(c.d)} <span class="dt-from">from ${c.s ? stampHTML(c.s) : 'a record'}${c.mine ? '<span class="dt-yours">← your write</span>' : ''}</span></li>`).join('')
      : `<li class="dt-empty">none yet: <code>low</code> changes only when a row starts or stops passing <code>r.stock &lt; 2</code></li>`
    flashSrc.clear(); flashLow.clear()
  }

  const n = (v, tier) => `<b data-attested="${tier}">${typeof v === 'number' ? v.toLocaleString('en-US') : esc(v)}</b>`
  // how data reached this tab, as resource timing saw it: from jsDelivr, from this browser's cache, or both
  function loadText() {
    const t = `<span class="nb">in ${n(Math.round(meas.ms), 'measured')} ms <span class="sep">·</span> this machine</span>`
    if (!meas.files) return `<span class="nb">loaded</span> ${t}`
    const files = `${n(meas.files, 'measured')} ${unit(meas.files, 'file', 'files')}`
    if (meas.cached === meas.files) return `<span class="nb">${files} from this browser's cache</span> ${t}`
    const kb = meas.kb ? `, ${n(meas.kb, 'measured')} KB` : ''
    const some = meas.cached ? ` (${n(meas.cached, 'measured')} from this browser's cache)` : ''
    return `<span class="nb">${files}${kb} from jsDelivr${some}</span> ${t}`
  }
  let statusHTML = null
  function paintStatus() {
    let html
    if (failed) html = `<span class="bad nb">✕ data did not load from jsDelivr</span> <span class="sep">·</span> <span class="nb">without it, there is no live view here</span>`
    else if (!loaded) html = `<span class="pending">${loading ? 'loading data from jsDelivr …' : 'data loads from jsDelivr when this section comes near'}</span>`
    else {
      const check = !page.alive(NODE) ? `<span class="bad nb">✕ ${L(NODE)} is down</span> <span class="sep">·</span> <span class="nb">data keeps the rows ${L(NODE)} held</span>`
        : differ === 0 ? `<span class="ok nb">✓ data holds what ${L(NODE)} holds</span> <span class="sep">·</span> <span class="nb">checked after each record</span>`
        : `<span class="bad nb">✕ data and ${L(NODE)} differed after ${n(differ, 'runtime')} of ${n(checks, 'runtime')} records</span> <span class="sep">·</span> <span class="nb">a bug in this page</span>`
      html = `${check} <span class="sep">·</span> ${version ? `<span class="nb">data ${n(version, versionTier)}</span> <span class="sep">·</span> ` : ''}${loadText()}`
    }
    if (html === statusHTML) return
    statusHTML = html
    el.status.innerHTML = html
  }

  // ── the facts under the card: BUILD facts from data/data/sync.json; the type numbers from both engines in this tab ──
  // fero's REC and data's HOT: one line when they are the same object, both lines (and ✕) when they are not
  function paintFacts() {
    const line = (label, v) => `<span class="dt-pair"><span class="dt-tl">${label}</span> ${v}</span>`
    const rec = `<span class="rec">${inspect(REC)}</span>`
    if (loaded) {
      const same = stable(D.HOT) === stable(REC)
      el.types.innerHTML = same
        ? line("fero's <code>REC</code> and data's <code>HOT</code> are both", `${rec} <span class="ok">✓ same</span>`)
        : line("fero's <code>REC</code>", rec) + line("data's <code>HOT</code>", `<span class="rec">${inspect(D.HOT)}</span> <span class="bad">✕ different</span>`)
      el.types.title = "fero's REC (kernel/env.ts, read from the kernel this page runs) and data's HOT (the numbers lane() reads, read from data in this tab), compared"
      el.sched.innerHTML = line('the data in this tab:', `<code>SCHEDULE_VERSION</code> ${n(C.SCHEDULE_VERSION, 'runtime')}`)
      el.sched.title = "read from data's dist/contract/index.js in this tab; the first of the contract tests checks this number"
    } else {
      el.types.innerHTML = line("fero's <code>REC</code>", rec) + (failed ? line("data's <code>HOT</code>", 'not loaded') : '')
      el.sched.innerHTML = line('the data in this tab:', failed ? 'not loaded' : '…')
    }
    el.types.setAttribute('data-attested', 'runtime')
  }
  fetch('./data/data/sync.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).then((s) => {
    // the sentence says what the build found: one importer outside the tests, the seam file itself
    const only = Array.isArray(s.importers) && s.importers.length === 1 && s.importers[0] === s.seam.file
    if (!only && Array.isArray(s.importers)) el.imp.innerHTML = `Outside the tests, <b data-attested="build">${s.importers.length}</b> fero files import data: ${s.importers.map((f) => `<code>${esc(f)}</code>`).join(', ')}. <code>${esc(s.seam.file)}</code> takes <b id="dt-nnames">…</b> names from it:`
    attest(root.querySelector('#dt-nnames'), s.seam.count, 'build')
    el.names.innerHTML = s.seam.names.map((x) => `<span class="dt-name">${esc(x)}</span>`).join('')
    el.names.setAttribute('data-attested', 'build')
    el.names.title = `the import in ${s.seam.file}, from '${s.seam.entry}', read when this page was built`
    if (s.contract?.tests) attest(el.ntests, s.contract.tests, 'build')
  }).catch((e) => console.warn('07: data/data/sync.json:', e?.message ?? e))

  paintFacts()
  paint(true)
}
