// sections/lede.js — the lede. Both variants run on THE house cluster (cluster.js `page`); nothing here keeps a
// second world except variant B's one labelled own run.
//
// The card ("shop: one write, every copy") follows every write to the house row (gadgets), whoever issues it: the
// scripted writer's (c1), the dock's, any section's. It follows only that row, so its column is always that row's
// value on every node. When a later write beats the followed one (a bigger stamp), it follows the winner.
//   WRITE   the assignment the page's write stands for (page.on('write') → w.node, w.path, w.value)
//   RECORD  decoded with kernel/codec.js from the WRITE frame the writer actually sent (page.on('frame') →
//           decode(bytes); the frame's ATTEMPT origin names the writer); its size is that frame's. A write the owner
//           issues itself sends no WRITE frame: its record is read from the first RECORDS frame that carries it.
//   rows    one per node in a fixed order (the owner ★ first, then servers, then clients, crashed and departed
//           nodes last), each read from that node's kernel state: page.object(id)[row], page.stamp(id, row)
//   LANDED  page.on('apply'): the first apply of a stamp is its owner's (it stamps, applies, then ships); a copy's
//           time is its apply's simulated time minus the owner's. `down ✕`, `left`, `cut off` from page.down,
//           page.left, page.cuts; `waiting` from the write's state.
//   foot    stamped by · on k of n copies (live nodes holding that stamp) · copies agree ✓ (page.agree()); while the
//           write waits, why, from the kernel's state: who is down or cut off, and the vote's arithmetic (members
//           up against a majority of the committed view, README "Membership").
//
// Variant B adds one button (crash the owner of gadgets, then restart it from its disk) and lines that print only
// when the kernel produces them: journal rows (suspect, viewInstall, replayed, linkUp), views, stamps, agree().
// Its settings line comes from data/lede/settings.json (BUILD: tools/lede-settings.mjs reads the repo) plus one own
// run at fero's defaults (three servers built with sim.add, labelled `own run · seed N`).
// The trust line and the status chip come from data/manifest.json (BUILD); a field that is absent never renders.
// The "data ↗" link renders only when data/lede/links.json (BUILD: tools/lede-links.mjs) says the data site carries
// none of CONCEPT §8's claims about fero.
import { page, attest, decode, stable, REDUCED, role as roleOf, Ring, pair, keyOf } from '../cluster.js'
import { nid, stamp as stampHtml, rec as recHtml, inspect, vt, esc } from '../ui.js'
import { defaultsRun } from './break/runs.js'

const root = document.getElementById('lede')
const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
let reduced = REDUCED
motion?.addEventListener?.('change', (e) => { reduced = e.matches })

const homeRow = () => page.writer?.row ?? 'gadgets'
const writerId = () => page.writer?.id ?? 'c1'
const base = (origin) => String(origin ?? '').split('~')[0]
const same = (a, b) => !!a && !!b && a.epoch === b.epoch && a.seq === b.seq && a.origin === b.origin
const skey = (s) => `${s.epoch}|${s.seq}|${s.origin}`
// stamps order by (view, counter, origin), compared in that order (kernel/node.ts: "lexicographic (epoch, seq, origin)")
const bigger = (a, b) => !b || (a.epoch !== b.epoch ? a.epoch > b.epoch : a.seq !== b.seq ? a.seq > b.seq : a.origin > b.origin)
const IDENT = /^[A-Za-z_$][\w$]*$/
const FRESH_MS = 1500   // presentation only: how long a just-applied stamp stays violet (wall clock, at 1×)
const B = (v) => `<b>${esc(v)}</b>`
const SEP = '<span class="sep">·</span>'
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v))
const and = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])
const stampOf = (id, row) => { try { return page.stamp(id, row) } catch { return undefined } }
// one HTML write per change; the container is stamped with its tier (the attest() contract, for rich content)
function html(el, s, tier = 'runtime') {
  if (!el) return
  if (el._h !== s) { el.innerHTML = s; el._h = s }
  if (tier) { if (el.getAttribute('data-attested') !== tier) el.setAttribute('data-attested', tier) }
  else if (el.hasAttribute('data-attested')) el.removeAttribute('data-attested')
}

// ── the cluster's state, as the card and B's lines both read it ──────────────────────────────────────────
const isOut = (id) => page.down.has(id) || page.left.has(id)
// cut off: alive, and cut from every other live node (the page's cuts are whole-node isolations: the dock, 02, the story)
function cutOff(id) {
  if (!page.alive(id)) return false
  let others = 0
  for (const o of page.ids()) if (o !== id && page.alive(o)) { others++; if (!page.cuts.has(pair(id, o))) return false }
  return others > 0
}
// the vote's arithmetic (README "Membership": voting a member out "needs a majority of the whole old view"): the
// members of the committed view that are up and reachable, against floor(n/2) + 1
function quorum() {
  const v = page.view(), size = v.members.length, need = Math.floor(size / 2) + 1
  const gone = v.members.filter((m) => !page.alive(m) || cutOff(m))
  return { size, need, up: size - gone.length, ok: size - gone.length >= need, gone }
}
const until = (q) => (q.gone.length === 1 ? (cutOff(q.gone[0]) ? 'until the cut heals' : `until ${nid(q.gone[0])} comes back`) : 'until one comes back')
// the owner of a row on the committed view, cached per view (page.owner builds a ring per call)
let ownerKey = '', ownerMemo = new Map()
function ownerOf(row) {
  const v = page.view(), k = v.epoch + ':' + v.members.join(',')
  if (k !== ownerKey) { ownerKey = k; ownerMemo = new Map() }
  if (!ownerMemo.has(row)) ownerMemo.set(row, v.members.length ? page.owner(row) : '')
  return ownerMemo.get(row)
}

// ── the model: every write to the house row, followed through the kernel's own events ─────────────────────
const M = { cur: null, hist: [], wid: 0, dirty: true }
function follow(w) {
  // the biggest stamp the row held anywhere when the write was issued: the write's own stamp must beat it, so a
  // restart's replayed history never passes for this write landing
  let floor = null
  for (const id of page.ids()) if (page.alive(id)) { const s = stampOf(id, w.path[0]); if (s && bigger(s, floor)) floor = s }
  M.cur = { id: ++M.wid, w, row: w.path[0], key: w.key, floor, rec: null, size: 0, via: '', sends: 0, stamps: new Map() }
  M.hist.push(M.cur); if (M.hist.length > 12) M.hist.shift()   // B's story looks its write up here after newer writes
}
// the stamp a followed write shows: the one its writer committed under, else the biggest seen (one, nearly always)
function shown(t) {
  if (!t) return null
  if (t.w.stamp) { const e = t.stamps.get(skey(t.w.stamp)); if (e) return e }
  let best = null
  for (const e of t.stamps.values()) if (!best || bigger(e.s, best.s)) best = e
  return best
}
page.on('write', (w) => { if (w.path.length === 1 && w.path[0] === homeRow()) { follow(w); M.dirty = true; kick() } })
page.on('frame', (f) => {
  if (f.verb !== 'WRITE' && f.verb !== 'RECORDS') return
  for (let i = M.hist.length - 1; i >= 0; i--) {
    const t = M.hist[i]
    if (f.from !== t.w.node || f.sentAt < t.w.issuedAt) continue
    if (f.verb === 'RECORDS' && (t.rec || t.sends)) continue
    if (f.verb === 'WRITE' && t.rec) { t.sends++; return }
    let d; try { d = decode(f.bytes) } catch { return }
    // a WRITE frame names its writer in its ATTEMPT origin; a RECORDS frame from an owner that wrote it itself carries
    // the record under the owner's own origin
    const r = d.recs?.find((x) => x.key.length === 1 && x.key[0] === t.row && (t.w.remove ? x.type === 2 : x.type !== 2 && stable(x.value) === stable(t.w.value)) && base(f.verb === 'WRITE' ? d.prov?.origin : x.origin) === t.w.node)
    if (!r) continue
    if (f.verb === 'WRITE') t.sends++
    t.rec = r.type === 2 ? { type: r.type, key: r.key } : { type: r.type, key: r.key, value: r.value }
    t.size = f.size; t.via = f.verb; M.dirty = true
    return
  }
})
page.on('apply', (a) => {
  if (!M.hist.length || a.key !== keyOf([homeRow()])) return
  const s = { epoch: a.epoch, seq: a.seq, origin: a.origin }
  for (let i = M.hist.length - 1; i >= 0; i--) {
    const t = M.hist[i]
    if (a.at < t.w.issuedAt) continue
    if (t.w.remove ? a.type !== 2 : (a.type === 2 || stable(a.value) !== stable(t.w.value))) continue
    if (t.floor && !bigger(s, t.floor)) continue
    land(t, s, a)
    return
  }
})
function land(t, s, a) {
  const k = skey(s)
  let e = t.stamps.get(k)
  if (!e) { e = { s, at: a.at, by: base(s.origin), landed: new Map(), wall: new Map() }; t.stamps.set(k, e) }   // the first apply of a stamp is its owner's
  if (e.landed.has(a.node)) return
  e.landed.set(a.node, a.at); e.wall.set(a.node, performance.now()); M.dirty = true
  // the row's winner: a stamped write that this bigger stamp now beats is not the row's latest any more
  const ce = shown(M.cur)
  if (t !== M.cur && ce && shown(t) === e && bigger(e.s, ce.s)) M.cur = t
}
page.on('reset', () => { M.cur = null; M.hist = []; story.forEach((s) => s.reset()); cards.forEach((c) => { c.cw = null }); kick() })
for (const ev of ['kill', 'restart', 'left', 'join', 'cut', 'heal', 'view', 'commit', 'leave', 'writer']) page.on(ev, () => { M.dirty = true; kick() })

// why the followed write has no stamp yet, from the kernel's state → { parts, named } (named: nodes it mentions)
function why(c, owner) {
  const me = c.w.node, W = (s) => `<span class="wait nw">${s}</span>`
  if (isOut(me)) return { parts: [`<span class="neg nw">${nid(me)} is ${page.down.has(me) ? 'down' : 'gone'}</span>`, '<span class="nw">its write has not committed</span>'], named: [me] }
  if (!owner) return { parts: [W('waiting for the first view')], named: [] }
  if (cutOff(me)) return { parts: [W(`${nid(me)} is cut off`), W('its write waits until the cut heals')], named: [me] }
  const q = quorum()
  if (!q.ok) return { parts: [W(`no majority: ${B(q.up)} of ${B(q.size)} servers up`), W(`the write waits ${until(q)}`)], named: q.gone.filter(cutOff) }
  if (isOut(owner) || cutOff(owner)) return { parts: [W(`the owner ${nid(owner)} is ${cutOff(owner) ? 'cut off' : 'down'}`), W('waiting for the vote')], named: [owner] }
  if (roleOf(me) === 'client') {
    const p = page.primary(me)
    if (!p || !page.alive(p)) return { parts: [W(`${nid(me)} has no link to a server yet`), W('its write waits')], named: [] }
  } else {
    const g = page.writable(me)
    if (g && !g.open) return { parts: [W(`${nid(me)} cannot reach a majority`), W('its write waits')], named: [] }
  }
  return { parts: [W(`on its way to the owner ${nid(owner)}`)], named: [] }
}

// ── one card controller per variant ──────────────────────────────────────────────────────────────────────
const WIDE = typeof matchMedia === 'function' ? matchMedia('(min-width: 1100px)') : { matches: true }
const PHONE = typeof matchMedia === 'function' ? matchMedia('(max-width: 520px)') : { matches: false }
const COLS = ['node', 'role', 'val', 'stamp', 'land']
// the room an element takes in its line: its box plus its margins (a value's flash padding is cancelled by margins)
const outerW = (el) => { if (!el) return 0; const cs = getComputedStyle(el); return el.getBoundingClientRect().width + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0) }
class Card {
  constructor(fig) {
    this.fig = fig
    this.variant = fig.closest('[data-variant]')
    const q = (s) => fig.querySelector(s)
    this.el = { view: q('.lf-view'), write: q('.lf-write'), rec: q('.lf-rec'), hint: q('.lf-hint'), rowname: q('.lf-rowname'), rows: q('.lf-rows'), foot: q('.lf-foot'), clock: q('.lf-clock'), scroll: q('.fig-scroll') }
    this.th = Object.fromEntries(COLS.map((k) => [k, q('thead .c-' + k)]))
    this.rows = new Map()
    this.vals = new Map()
    this.order = []
    this.flashed = new Set()
    this.cw = null; this.sig = ''; this.scrollW = 0
    this.wasLive = false
    this.shown = !this.variant.hidden
    this.onscreen = false
    this.variant.addEventListener('variantshow', () => { this.shown = true; this.cw = null; kick() })
    this.variant.addEventListener('varianthide', () => { this.shown = false })
    new IntersectionObserver((es) => { this.onscreen = es.some((e) => e.isIntersecting); if (this.onscreen) kick() }, { rootMargin: '80px' }).observe(fig)
    // a new card width starts the columns over (the widths below only grow while the width holds)
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { const w = this.el.scroll.clientWidth; if (w !== this.scrollW) { this.scrollW = w; this.cw = null; M.dirty = true; kick() } }).observe(this.el.scroll)
    // drop each light/flash class once it has played (a moved row would restart it)
    this.el.rows.addEventListener('animationend', (e) => { if (e.target.classList.contains('flash') || e.target.classList.contains('lit')) e.target.classList.remove('flash', 'lit') })
  }
  get live() { return this.shown && this.onscreen && !document.hidden }
  render() {
    if (!this.live) { this.wasLive = false; return }
    const c = M.cur, e = shown(c), row = c?.row ?? homeRow(), now = page.now
    const v = page.view()
    // head: the committed view by its members' names (a member that is down stays struck until the vote, as in the
    // dock), then the clients. Names, not a count: "2 servers" over a table that lists three server rows (one of them
    // down) would count two different things with one word.
    const clients = page.clientIds.length
    const members = v.members.map((id) => (isOut(id) ? `<span class="is-down">${nid(id)}</span>` : nid(id))).join(' ')
    html(this.el.view, v.epoch ? `view ${B(v.epoch)} ${SEP} ${members} ${SEP} ${B(clients)} client${clients === 1 ? '' : 's'}` : 'the servers are voting', v.epoch ? 'runtime' : null)
    // the write, the record, the frame it left in
    if (!c) html(this.el.write, `<span class="dim">no write to ${esc(row)} yet</span>`, null)
    else {
      const lhs = `<span class="k">shop.data</span>${IDENT.test(row) ? `<span class="k">.</span>${esc(row)}` : `<span class="p">[</span><span class="s">'${esc(row)}'</span><span class="p">]</span>`}`
      const code = c.w.remove ? `<span class="k">delete</span> ${lhs}` : `${lhs} <span class="p">=</span> ${inspect(c.w.value)}`
      html(this.el.write, `<span class="who">${esc(c.w.node)}</span>${SEP}<code class="rec">${code}</code>`)
    }
    html(this.el.rec, c?.rec ? recHtml(c.rec) : '<span class="dim">…</span>', c?.rec ? 'runtime' : null)
    const hint = 'the page posts the record this line becomes'
    // its size on the wire: the WRITE frame the writer sent, or (an owner writing its own row sends none) the RECORDS
    // frame that carried it stamped; the frame's name is on hover
    if (c?.size) html(this.el.hint, `${hint} ${SEP} <span class="nw" title="${c.via === 'WRITE' ? `the WRITE frame ${esc(c.w.node)} sent: one message, ${c.size} bytes` : `${esc(c.w.node)} owns ${esc(c.row)}, so it sent no WRITE frame: this is the RECORDS frame that carried the record, stamped, ${c.size} bytes`}">${B(c.size)} <abbr title="bytes">B</abbr> on the wire</span>`)
    else html(this.el.hint, hint, null)
    if (this.el.rowname._t !== row) { this.el.rowname.textContent = row; this.el.rowname._t = row }
    // the rows
    const owner = ownerOf(row)
    const ids = page.ids()
    for (const id of ids) if (!this.rows.has(id)) this.addRow(id)
    for (const [id, r] of this.rows) if (!ids.includes(id)) { r.tr.remove(); this.rows.delete(id); this.order = this.order.filter((x) => x !== id) }
    for (const tr of this.el.rows.querySelectorAll('tr.ph')) tr.remove()   // more placeholders than nodes
    for (const id of ids) this.fillRow(id, c, e, row, owner, now)
    this.arrange(ids, owner, this.wasLive)
    this.layout()
    this.fillFoot(c, e, row, owner, ids)
    html(this.el.clock, `${SEP} ${B(vt(now))} simulated`)
    this.wasLive = true
  }
  addRow(id) {
    // adopt a placeholder row from the page's HTML first (it holds the card's height before the first render)
    let tr = this.el.rows.querySelector('tr.ph')
    if (tr) tr.classList.remove('ph')
    else { tr = document.createElement('tr'); for (const k of COLS) { const td = document.createElement('td'); td.className = 'c-' + k; tr.append(td) } this.el.rows.append(tr) }
    tr.dataset.node = id
    const td = {}
    for (const k of COLS) td[k] = tr.querySelector('.c-' + k)
    this.rows.set(id, { tr, td })
    this.order.push(id)
  }
  fillRow(id, c, e, row, owner, now) {
    const { tr, td } = this.rows.get(id)
    const out = isOut(id), cut = cutOff(id)
    const isOwner = id === owner
    html(td.node, nid(id, { owner: isOwner }))
    html(td.role, `<span>${isOwner ? 'owner' : roleOf(id)}</span>`, null)
    // the node's value, read from its kernel state (cached per state fingerprint)
    let val
    const h = page.alive(id) ? page.hash(id) : 'down', vk = id + '|' + row
    const vc = this.vals.get(vk)
    if (vc && vc.h === h && vc.node === page.node(id)) val = vc.v
    else { try { val = page.object(id)[row] } catch { val = undefined } this.vals.set(vk, { h, v: val, node: page.node(id) }) }
    // its stamp; violet only for a moment after this copy applied the followed write
    const s = stampOf(id, row)
    let sh
    if (!s && c?.w.remove && e?.landed.has(id)) sh = '<span class="stamp gone" title="the remove landed here, and this copy keeps no stamp for the row any more">removed</span>'
    else {
      sh = stampHtml(s)
      if (e && same(s, e.s) && performance.now() - (e.wall.get(id) ?? -1e9) < FRESH_MS / Math.max(1, page.speed)) sh = sh.replace('class="stamp"', 'class="stamp fresh"')
    }
    // phones show the stamp under the value (the stamp column folds away there)
    html(td.val, `${val === undefined ? '<span class="none">none</span>' : `<span class="rec">${inspect(val)}</span>`}<span class="sub">${sh}</span>`)
    html(td.stamp, sh)
    // landed
    let land
    if (page.down.has(id)) land = '<span class="neg">down ✕</span>'
    else if (page.left.has(id)) land = '<span class="faint">left</span>'
    else if (cut) land = '<span class="neg" title="every link to it is cut: it takes no writes and keeps serving its own copy">cut off</span>'
    else if (!c) land = s && s.epoch === 0 && base(s.origin) === page.opts.seedFrom ? '<span class="faint" title="a seed row, applied at boot before any view">seed</span>' : '<span class="faint">…</span>'
    else if (e && e.landed.has(id)) land = id === e.by ? '<span class="acc">stamped</span>' : `<span class="dim">+${esc(vt(e.landed.get(id) - e.at))}</span>`
    else if (id === c.w.node && c.w.state === 'pending') land = `<span class="wait">waiting<span class="dur"> ${esc(vt(now - c.w.issuedAt))}</span></span>`
    else land = '<span class="faint">…</span>'
    html(td.land, land)
    tr.classList.toggle('is-down', out)
    tr.classList.toggle('is-wait', !!c && id === c.w.node && c.w.state === 'pending' && !out && !cut)
    // motion: the owner's row lights as it stamps, each copy's value flashes as it applies — at 1× or slower, for
    // landings that just happened (at 4× a write lands every ~0.6 s: the values would never stop flashing)
    if (e && e.landed.has(id)) {
      const k = c.id + '|' + skey(e.s) + '|' + id
      if (!this.flashed.has(k)) {
        this.flashed.add(k); if (this.flashed.size > 400) this.flashed = new Set([...this.flashed].slice(-100))
        if (!reduced && page.speed <= 1 && performance.now() - (e.wall.get(id) ?? 0) < 900) {
          const span = td.val.querySelector('.rec')
          if (span) { span.classList.remove('flash'); void span.offsetWidth; span.classList.add('flash') }
          if (id === e.by) { tr.classList.remove('lit'); void tr.offsetWidth; tr.classList.add('lit') }
        }
      }
    }
  }
  // a fixed order: the owner first (struck through while it is down, until the vote moves the ★), then the live
  // servers and clients by name, then crashed and departed nodes. Rows move only when that changes (a new owner, a
  // node down or back); the LANDED times carry the order in which the copies applied the write.
  arrange(ids, owner, animate) {
    const rank = (id) => (roleOf(id) === 'server' ? 0 : 1)
    const by = (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)
    const rest = ids.filter((id) => id !== owner)
    const want = [...(owner && ids.includes(owner) ? [owner] : []), ...rest.filter((id) => !isOut(id)).sort(by), ...rest.filter(isOut).sort(by)]
    if (want.join(',') === this.order.join(',')) return
    const trs = want.map((id) => this.rows.get(id).tr)
    const top0 = animate && !reduced ? new Map(trs.map((tr) => [tr, tr.getBoundingClientRect().top])) : null
    for (const tr of trs) this.el.rows.append(tr)
    this.order = want
    if (!top0) return
    for (const tr of trs) {
      const dy = top0.get(tr) - tr.getBoundingClientRect().top
      if (dy) { tr.style.transition = 'none'; tr.style.transform = `translateY(${dy}px)` }
    }
    requestAnimationFrame(() => { for (const tr of trs) if (tr.style.transform) { tr.style.transition = 'transform 280ms ease'; tr.style.transform = '' } })
  }
  // fixed columns (table-layout: fixed; widths on the header cells). Each column is as wide as the widest content it
  // has held since the last reset or resize, and never narrower than a reserve (the waiting line, a 3-digit counter),
  // so a write never moves a column. ROLE folds away only when the stamps outgrow the card (a restart's stamps, say)
  // and stays folded until a reset or a resize.
  layout() {
    const avail = this.el.scroll.clientWidth
    if (!avail) return
    const phone = PHONE.matches
    let sig = phone + ':' + avail
    for (const r of this.rows.values()) for (const k of COLS) sig += ',' + r.td[k].textContent.length
    if (this.cw && sig === this.sig) return
    this.sig = sig
    if (!this.cw || this.cw.avail !== avail || this.cw.phone !== phone) {
      // a rebuild starts unfolded: the reserves and the rows are measured with ROLE showing (while 'tight' is on,
      // its cells are display:none and measure 0 px), then 'tight' comes back below if the widths still overflow
      this.fig.classList.remove('tight')
      this.cw = { avail, phone, tight: false, ...this.reserve(phone) }
    }
    const cw = this.cw, wd = outerW
    for (const r of this.rows.values()) {
      const td = r.td
      const need = {
        node: wd(td.node.firstElementChild), role: wd(td.role.firstElementChild),
        val: Math.max(wd(td.val.querySelector('.rec, .none')), phone ? wd(td.val.querySelector('.sub > *')) : 0),
        stamp: phone ? 0 : wd(td.stamp.firstElementChild), land: wd(td.land.firstElementChild),
      }
      for (const k of COLS) if (need[k]) cw.w[k] = Math.max(cw.w[k], Math.ceil(need[k] + cw.pad[k] + 1))
    }
    const vis = (k) => !(phone && (k === 'role' || k === 'stamp')) && !(k === 'role' && cw.tight)
    const total = () => COLS.reduce((a, k) => a + (vis(k) ? cw.w[k] : 0), 0)
    if (!phone && !cw.tight && total() > avail) cw.tight = true
    this.fig.classList.toggle('tight', cw.tight)
    for (const k of COLS) { const px = vis(k) ? cw.w[k] + 'px' : ''; if (this.th[k].style.width !== px) this.th[k].style.width = px }
  }
  // the widest content each column must hold without moving, at the card's own fonts: sample cells built, measured
  // and removed in one go (never painted)
  reserve(phone) {
    const m = document.createElement('div')
    m.className = 'lf-measure'
    m.innerHTML = `<span class="c-node">${nid('n02', { owner: true })}</span><span class="c-role"><span>server</span></span>`
      + `<span class="c-val"><span class="rec">${inspect({ stock: 5 })}</span></span><span class="c-val"><span class="sub">${stampHtml({ epoch: 9, seq: 999, origin: 'n02' })}</span></span>`
      + `<span class="c-stamp">${stampHtml({ epoch: 9, seq: 999, origin: 'n02' })}</span>`
      + `<span class="c-land">${phone ? '<span class="wait">waiting</span>' : `<span class="wait">waiting<span class="dur"> ${vt(99900)}</span></span>`}</span>`
    this.fig.append(m)
    const wd = (sel) => outerW(m.querySelector(sel))
    const content = { node: wd('.c-node > *'), role: wd('.c-role > *'), val: Math.max(wd('.c-val > .rec'), phone ? wd('.c-val > .sub > *') : 0), stamp: wd('.c-stamp > *'), land: wd('.c-land > *') }
    m.remove()
    const pad = {}, w = {}
    for (const k of COLS) {
      const th = this.th[k], cs = getComputedStyle(th)
      pad[k] = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      w[k] = Math.ceil(content[k] + pad[k] + 1)
    }
    return { pad, w }
  }
  fillFoot(c, e, row, owner, ids) {
    let parts = [], named = []
    const live = ids.filter((id) => page.alive(id))
    if (!c) parts.push(`<span class="faint nw">no write to ${esc(row)} yet</span>`)
    else if (e) {
      const k = live.filter((id) => (c.w.remove && e.landed.has(id)) || same(stampOf(id, row), e.s)).length
      parts.push(`<span class="nw">stamped by ${nid(e.by, { text: e.s.origin })}</span>`, `<span class="nw">on ${B(k)} of ${B(live.length)}${live.length < ids.length ? ' live' : ''} copies</span>`)
    } else ({ parts, named } = why(c, owner))
    // phones keep the writer's row on one line (the cell says "waiting"); its live duration rides here instead
    const dur = c && c.w.state === 'pending' && !isOut(c.w.node) ? `<span class="wait nw dur-foot">${esc(c.w.node)} waiting ${esc(vt(page.now - c.w.issuedAt))}</span>` : ''
    // a cut-off node keeps serving its own copy (README: "Reads never wait: every node keeps serving its local copy,
    // through a split"): say so, rather than "catching up", which a cut node cannot do until the cut heals
    const cut = live.filter((id) => cutOff(id) && !named.includes(id))
    const tail = cut.length
      ? [`<span class="neg nw">${and(cut.map((id) => nid(id)))} ${cut.length === 1 ? 'is' : 'are'} cut off</span>`, `<span class="nw">${cut.length === 1 ? 'it keeps' : 'each keeps'} serving its own copy</span>`]
      : [page.agree() ? '<span class="ok nw">copies agree ✓</span>' : '<span class="faint nw">copies catching up</span>']
    html(this.el.foot, parts.join(` ${SEP} `) + (dur ? `<span class="dur-foot"> ${SEP} </span>${dur}` : '') + ` ${SEP} ` + tail.join(` ${SEP} `))
  }
}

// ── variant B: one button and the kernel's lines ────────────────────────────────────────────────────────
class Story {
  constructor(variant) {
    this.variant = variant
    this.btn = variant.querySelector('.lb-btn')
    this.list = variant.querySelector('.lb-story')
    this.settings = variant.querySelector('.lb-settings')
    this.ep = null
    this.lis = []
    this.said = new Set()
    this.shown = !variant.hidden
    this.onscreen = false
    variant.addEventListener('variantshow', () => { this.shown = true; this.shape = null; ownRunSoon(); kick() })
    variant.addEventListener('varianthide', () => { this.shown = false })
    new IntersectionObserver((es) => { this.onscreen = es.some((e) => e.isIntersecting); if (this.onscreen) kick() }, { rootMargin: '80px' }).observe(variant)
    this.btn.addEventListener('click', () => this.click())
  }
  get live() { return this.shown && this.onscreen && !document.hidden }
  reset() { this.ep = null }
  // the button acts on the owner of the house row: crash it while it is up, restart a crashed server from its disk
  state() {
    if (!page.isReady || !page.view().epoch) return { kind: 'wait', text: 'crash the owner ▸', title: 'the servers are still voting' }
    const down = page.serverIds.find((id) => page.down.has(id))
    if (down) return { kind: 'restart', id: down, text: `restart ${down} ▸`, title: `restart ${down} from its disk: its next life, its rows back from its write-ahead log` }
    const owner = ownerOf(homeRow())
    if (!owner || !page.alive(owner)) return { kind: 'wait', text: 'crash the owner ▸', title: 'no owner to crash right now' }
    return { kind: 'crash', id: owner, text: 'crash the owner ▸', title: `crash ${owner}, the owner of ${homeRow()}, like kill -9: its links drop, its disk stays` }
  }
  click() {
    const s = this.state()
    if (s.kind === 'crash') page.kill(s.id)
    else if (s.kind === 'restart') page.restart(s.id)
    kick()
  }
  // episodes start from the cluster's own events, whoever acted: B's button, the dock, the story, 02's chips.
  // A crash holds a write up only when it breaks the write's path: it killed the row's owner, or the writer's
  // server, or the majority. Only such a write is said to wait; after any other crash the next write shows that
  // writes go on.
  onKill(id) {
    if (roleOf(id) !== 'server') return
    const v = page.view(), row = homeRow(), owner0 = ownerOf(row), q = quorum()
    const ep = this.ep = { kind: 'crash', id, t0: page.now, e0: v.epoch, row, owner0, ownerHit: owner0 === id, primaryHit: page.primary(writerId()) === id, noMajority: q.ok ? null : { up: q.up, size: q.size, until: until(q) }, suspects: [], write: null, view: null, owner1: null }
    ep.blocks = ep.ownerHit || ep.primaryHit || !!ep.noMajority
    const c = M.cur
    if (ep.blocks && c && c.row === row && c.w.state === 'pending' && !isOut(c.w.node)) ep.write = c.w   // caught in flight
  }
  onRestart(id) {
    if (roleOf(id) !== 'server') return
    const row = homeRow()
    this.ep = { kind: 'restart', id, t0: page.now, e0: page.view().epoch, row, owner0: ownerOf(row), life: page.life(id), replayed: 0, linkAt: null, view: null, owner1: null, agreeAt: null }
  }
  onJournal(e) {
    const ep = this.ep
    if (!ep) return
    const ringOwner = (epoch, members) => { const r = new Ring(); r.build(epoch, members.map((m) => [m, `sim:${m}`])); return r.ownerOf(ep.row) }
    if (ep.kind === 'crash') {
      if (e.name === 'suspect' && e.a === ep.id && !ep.suspects.some((x) => x.node === e.node)) ep.suspects.push({ node: e.node, at: e.at })
      else if (e.name === 'viewInstall' && !ep.view && e.a > ep.e0 && !isOut(e.node) && roleOf(e.node) === 'server') {
        const v = page.viewOf(e.node)
        if (!v.members.includes(ep.id)) { ep.view = { epoch: e.a, members: v.members, at: e.at }; ep.owner1 = ringOwner(e.a, v.members) }
      }
    } else {
      if (e.node === ep.id && e.name === 'replayed' && ep.linkAt === null) ep.replayed += +e.a || 0
      else if (e.node === ep.id && e.name === 'linkUp' && ep.linkAt === null) ep.linkAt = e.at
      else if (e.name === 'viewInstall' && !ep.view && e.a > ep.e0 && roleOf(e.node) === 'server' && !isOut(e.node)) {
        const v = page.viewOf(e.node)
        if (v.members.includes(ep.id)) { ep.view = { epoch: e.a, members: v.members, at: e.at }; ep.owner1 = ringOwner(e.a, v.members) }
      }
    }
  }
  // a write to the row after the crash: adopted while the crash still holds writes up (a dead owner before the vote,
  // no majority), or, after a crash off the write's path, as the write that shows writes go on
  onWrite(w) {
    const ep = this.ep
    if (ep?.kind !== 'crash' || ep.write || w.path.length !== 1 || w.path[0] !== ep.row) return
    if (!ep.blocks || ep.noMajority || (ep.ownerHit && !ep.view)) ep.write = w
  }
  // after a restart, the first moment every live copy agrees: checked at the end of each advance of the cluster
  // (frame-precise on the simulated clock), whether or not the section is on screen
  onTick() { const ep = this.ep; if (ep?.kind === 'restart' && ep.agreeAt === null && ep.linkAt !== null && page.agree()) { ep.agreeAt = page.now; M.dirty = true } }
  lines() {
    const ep = this.ep, out = []
    // the owner change rides on the view line: the ring on the new view names the row's owner
    const viewLine = (vw) => `view ${B(vw.epoch)} ${SEP} ${vw.members.map((m) => nid(m)).join(' ')} ${SEP} ${esc(ep.row)} ${ep.owner1 && ep.owner1 !== ep.owner0 ? 'now belongs to' : 'still belongs to'} ${nid(ep.owner1 || ep.owner0, { owner: true })}`
    if (!ep) {
      const v = page.view(), row = homeRow(), owner = ownerOf(row)
      out.push({ t: 'live', x: '<span class="faint">the card is fero\'s kernel on a simulated network, in this tab</span>' })
      if (v.epoch) out.push({ t: 'now', x: `view ${B(v.epoch)} ${SEP} ${v.members.map((m) => nid(m)).join(' ')} ${SEP} ${esc(row)} belongs to ${nid(owner, { owner: true })}` })
      else out.push({ t: 'now', x: '<span class="faint">the servers are voting in their first view</span>' })
      return out
    }
    // one caption row that every episode keeps (never hidden): what the times are, and where they count from.
    // pri: when the box is short of room, the lowest folds away first (8 and up never do)
    out.push({ t: '', x: `<span class="faint">simulated time, counted from the ${ep.kind}</span>`, pri: 9 })
    const ev = []
    if (ep.kind === 'crash') {
      ev.push({ at: ep.t0, x: `${nid(ep.id)} <span class="neg">crashed</span>: its links drop, its disk stays`, pri: 8 })
      const nm = ep.noMajority
      if (nm) ev.push({ at: ep.t0, x: `<span class="wait">only ${B(nm.up)} of ${B(nm.size)} servers ${nm.up === 1 ? 'is' : 'are'} up: no majority, so no vote. Writes wait ${nm.until}.</span>`, pri: 7 })
      if (ep.suspects.length) ev.push({ at: ep.suspects[0].at, x: `${and(ep.suspects.map((s) => nid(s.node)))} lost ${nid(ep.id)} ${SEP} redialing it`, pri: 3 })
      const w = ep.write, t = w && M.hist.find((x) => x.w === w), e = shown(t)
      if (w) {
        const head = `${nid(w.node)} writes ${esc(w.path[0])}${w.issuedAt < ep.t0 ? ', sent before the crash' : ''}`
        let x
        if (ep.blocks) x = w.state === 'pending' ? `${head} ${SEP} <span class="wait">waiting ${esc(vt(page.now - w.issuedAt))}</span>` : `${head} ${SEP} it waited ${B(vt(w.committedAt - w.issuedAt))}`
        else x = w.state === 'pending' ? `${head} ${SEP} on its way` : `${head} ${SEP} it commits after ${B(vt(w.committedAt - w.issuedAt))}${e ? ` ${SEP} its owner ${nid(e.by)} is up` : ''}`
        ev.push({ at: Math.max(w.issuedAt, ep.t0), x, pri: 6 })
      }
      if (ep.view) ev.push({ at: ep.view.at, x: viewLine(ep.view), pri: 5 })
      // the stamp that write got, and how many live copies have applied it (landings, so a newer write to the same
      // row does not erase the count); a stamp from before the crash is not part of this story
      if (e && e.at >= ep.t0) {
        const live = page.ids().filter((id) => page.alive(id))
        ev.push({ at: e.at, x: `${stampHtml(e.s)} ${SEP} on ${B(live.filter((id) => e.landed.has(id)).length)} of ${B(live.length)} live copies`, pri: 4 })
      }
    } else {
      ev.push({ at: ep.t0, x: `${nid(ep.id)} restarts from its disk as life ${B(ep.life)}`, pri: 8 })
      if (ep.linkAt !== null) ev.push({ at: ep.linkAt, x: ep.replayed ? `its rows were back before any link: ${B(ep.replayed)} record${ep.replayed === 1 ? '' : 's'} read from its disk` : 'its first link is up', pri: 6 })
      if (ep.agreeAt !== null) ev.push({ at: ep.agreeAt, x: `${nid(ep.id)} caught up ${SEP} <span class="ok">copies agree ✓</span>`, pri: 4 })
      if (ep.view) ev.push({ at: ep.view.at, x: viewLine(ep.view), pri: 5 })
    }
    ev.forEach((x, i) => { x.i = i })
    for (const x of ev.sort((a, b) => a.at - b.at || a.i - b.i)) out.push({ t: `+${vt(x.at - ep.t0)}`, x: x.x, pri: x.pri })
    return out
  }
  render() {
    if (!this.live) return
    const s = this.state()
    attest(this.btn, s.text, 'runtime')
    if (this.btn.title !== (s.title ?? '')) this.btn.title = s.title ?? ''
    this.btn.disabled = s.kind === 'wait'
    this.btn.classList.toggle('danger', s.kind === 'crash')
    const ls = this.lines()
    while (this.lis.length > ls.length) this.lis.pop().li.remove()
    ls.forEach((l, i) => {
      let r = this.lis[i]
      if (!r) {
        const li = document.createElement('li'), t = document.createElement('span'), x = document.createElement('span')
        t.className = 't'; x.className = 'x'; li.append(t, x); this.list.append(li)
        r = this.lis[i] = { li, t, x }
      }
      html(r.t, esc(l.t), /\d/.test(l.t) ? 'runtime' : null)
      html(r.x, l.x, /\d/.test(l.x.replace(/<[^>]+>/g, '')) ? 'runtime' : null)
      r.li.classList.toggle('cap', !l.t && l.pri === 9)
    })
    // screen readers hear each new line once (its live counter does not repeat it): the section's polite region
    const said = []
    ls.forEach((l, i) => {
      const text = l.x.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim()
      const sig = (this.ep ? this.ep.t0 + this.ep.kind : 'rest') + '|' + i + '|' + text.replace(/[\d.,]+\s*(ms|s)\b/g, '#').replace(/[\d.,]+/g, '#')
      if (!this.said.has(sig)) { this.said.add(sig); if (this.ep) said.push(text) }
    })
    if (said.length) { const live = root.querySelector('.lede-live'); if (live) { live.removeAttribute('data-literal'); attest(live, said.join('. '), 'runtime') } }
    // beside the card the box is exactly the room the card leaves (contain: size); under it, a fixed box. When the
    // lines do not fit, the least important fold away first (oldest first among equals); the caption and the crash
    // or restart line never do
    const shape = ls.length + ':' + ls.map((l) => l.x.length).join(',') + ':' + WIDE.matches + ':' + PHONE.matches
    if (shape === this.shape) return
    this.shape = shape
    const box = this.list.parentElement
    for (const r of this.lis) r.li.hidden = false
    if (box.clientHeight > 0 && this.list.scrollHeight > box.clientHeight + 1) {
      const fold = ls.map((_, i) => i).filter((i) => (ls[i].pri ?? 0) < 8).sort((a, b) => (ls[a].pri ?? 0) - (ls[b].pri ?? 0) || a - b)
      for (const i of fold) { if (this.list.scrollHeight <= box.clientHeight + 1) break; this.lis[i].li.hidden = true }
    }
  }
}

// ── the own run behind B's settings line: the same vote at fero's defaults ───────────────────────────────
// The run section 02 and the centrepiece's caption print (sections/break/runs.js defaultsRun, imported, never
// copied): three durable servers built with sim.add at the heartbeat and redial fero ships with
// (data/lede/settings.json, read from api/index.ts at build time), on the house's simulated links; the owner of the
// house row is killed and the first survivor's viewInstall is timed. So one seed prints one number on the whole page.
// Run once per seed, when the browser is idle.
let settings = null
const ownRuns = new Map()   // seed → { Z, seed, events, violations } | 'running'
let settingsFailed = false
fetch(new URL('../data/lede/settings.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((s) => { settings = s; if (!s?.defaults) settingsFailed = true; ownRunSoon(); M.dirty = true; kick() }).catch(() => { settingsFailed = true; kick() })
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 30))
function ownRunSoon() {
  const want = story.some((s) => s.shown)
  const d = settings?.defaults
  if (!want || !d || !(d.heartbeatMs > 0) || !(d.redialMs > 0)) return
  const seed = page.seed
  if (ownRuns.has(seed)) return
  ownRuns.set(seed, 'running')
  idle(() => {
    const r = defaultsRun(seed, { heartbeatMs: d.heartbeatMs, redialMs: d.redialMs, delay: page.opts.delay })
    ownRuns.set(seed, r.voteMs != null ? { Z: r.voteMs, seed, events: r.events, violations: r.violations } : { Z: null, seed })
    M.dirty = true; kick()
  })
}
function renderSettings(s) {
  // the line is printed from the start with dots where a number will go (as many as its characters: the line is
  // mono), so nothing moves when the numbers arrive; "simulated clock" at its head covers every time in it
  const el = s.settings, d = settings?.defaults, hRed = settings?.harness?.redialMs
  if (!s.live || !el) return
  const run = ownRuns.get(page.seed)
  const q = (c) => el.querySelector(c)
  if (settingsFailed || (typeof run === 'object' && (run.Z == null || run.violations))) { el.hidden = true; return }
  if (page.opts.heartbeatMs > 0) attest(q('.s-hb'), `${n(page.opts.heartbeatMs)} ms`, 'runtime')
  if (hRed > 0) attest(q('.s-rd'), `${n(hRed)} ms`, 'build')
  if (d?.heartbeatMs > 0) attest(q('.s-dhb'), `${n(d.heartbeatMs)} ms`, 'build')
  if (d?.redialMs > 0) attest(q('.s-drd'), `${n(d.redialMs)} ms`, 'build')
  if (typeof run === 'object') { attest(q('.s-z'), vt(run.Z), 'runtime'); attest(q('.s-seed'), String(run.seed), 'runtime') }
  else for (const c of ['.s-z', '.s-seed']) { const x = q(c); if (x.hasAttribute('data-attested')) { x.removeAttribute('data-attested'); x.textContent = x.dataset.ph } }   // a new seed: measuring again
}

// ── wiring ──────────────────────────────────────────────────────────────────────────────────────────────
const cards = [...root.querySelectorAll('.lede-fig')].map((f) => new Card(f))
const story = [...root.querySelectorAll('[data-variant="b"]')].map((v) => new Story(v))
ownRunSoon()
page.on('kill', (id) => story.forEach((s) => s.onKill(id)))
page.on('restart', (id) => story.forEach((s) => s.onRestart(id)))
page.on('journal', (e) => { if (e.name === 'suspect' || e.name === 'viewInstall' || e.name === 'replayed' || e.name === 'linkUp') story.forEach((s) => s.onJournal(e)) })
page.on('write', (w) => story.forEach((s) => s.onWrite(w)))
page.on('reset', () => { ownRunSoon() })
let lastRender = 0
function renderAll(force) {
  const t = performance.now()
  if (!force && !M.dirty && t - lastRender < 100) return
  M.dirty = false; lastRender = t
  for (const c of cards) { try { c.render() } catch (e) { console.error('lede: card render', e) } }
  for (const s of story) { try { s.render(); renderSettings(s) } catch (e) { console.error('lede: story render', e) } }
}
let raf = 0
function kick() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(true) }) }
page.on('tick', () => { for (const s of story) s.onTick(); renderAll(false) })
document.addEventListener('visibilitychange', kick)
page.watch(root)
kick()

// ── the cta row and the trust line (BUILD: data/manifest.json; a field that is absent never renders) ────────
// copyText: the Clipboard API, or where a frame's permissions policy refuses it (a hosted preview with no clipboard
// delegation), the older path inside the same click: a hidden textarea, select, execCommand('copy')
// (the frame's permissions policy is asked first: calling a blocked Clipboard API logs a console error even when the
// refusal is caught)
const clipAllowed = () => { try { const pol = document.permissionsPolicy ?? document.featurePolicy; return !!navigator.clipboard?.writeText && (!pol || pol.allowsFeature('clipboard-write')) } catch { return false } }
async function copyText(text) {
  if (clipAllowed()) { try { await navigator.clipboard.writeText(text); return true } catch { /* refused: try the older path */ } }
  const ta = document.createElement('textarea')
  try {
    ta.value = text; ta.setAttribute('readonly', ''); ta.setAttribute('aria-hidden', 'true')
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.append(ta); ta.focus({ preventScroll: true }); ta.select()
    return document.execCommand('copy')
  } catch { return false } finally { ta.remove() }
}
root.querySelectorAll('[data-copy]').forEach((el) => el.addEventListener('click', async () => {
  const ok = await copyText(el.dataset.copy)
  el.focus({ preventScroll: true })
  if (ok) {
    el.setAttribute('data-state', 'copied ✓'); setTimeout(() => el.removeAttribute('data-state'), 1400)
    // the announcement repeats the README's code line: literal text, like the chip itself
    const live = root.querySelector('.lede-live'); if (live) { live.removeAttribute('data-attested'); live.setAttribute('data-literal', ''); live.textContent = ''; setTimeout(() => { live.textContent = `Copied: ${el.dataset.copy}` }, 30) }
  } else {
    // no clipboard at all: select the line, and say how to copy it
    try { getSelection().selectAllChildren(el.querySelector('code') ?? el) } catch { /* nothing to select */ }
    el.setAttribute('data-state', /Mac|iPhone|iPad/.test(navigator.platform) ? 'selected · ⌘C copies it' : 'selected · Ctrl+C copies it')
    setTimeout(() => el.removeAttribute('data-state'), 2400)
  }
}))
fetch('./data/manifest.json').then((r) => r.json()).then((m) => {
  // the status chip: only while the build saw no public remote and no fero 4 on npm
  const major = String(m.version ?? '').split('.')[0]
  const published = /^4\./.test(String(m.npm?.fero ?? ''))
  for (const chip of root.querySelectorAll('.lede-status')) {
    if (m.remote === false && m.npm?.fero && !published && major) {
      attest(chip.querySelector('.lede-major'), major, 'build')
      chip.title = `fero ${major} has no npm release and no public repository yet, checked when this page was built`   // the same manifest value as the chip
      chip.classList.remove('pending')
    } else chip.hidden = true
  }
  const items = []
  const deps = Array.isArray(m.dependencies) ? m.dependencies.length : null
  if (deps !== null) items.push(`<b class="v" data-k="deps"></b> npm ${deps === 1 ? 'dependency' : 'dependencies'} + ../data`)
  items.push('no build')
  if (m.node) items.push(`Node <b class="v" data-k="node"></b>+`)
  if (m.test?.fero && m.test.fero.fail === 0 && m.test.fero.tests > 0) items.push(`<b data-k="tests"></b> tests`)
  // CONCEPT §7's line has no contract item: 07 prints data's contract tests, and the line must fit one row at 1280
  if (m.perf && m.perf.fail === 0 && m.perf.tests > 0) items.push(`<b data-k="perf"></b> perf pins`)
  if (m.sim && m.sim.seeds > 0 && m.sim.green >= 0) items.push(`<b data-k="sim"></b> sim seeds green`)
  if (m.license?.file === true && m.license.declared) items.push(esc(m.license.declared))
  const vals = { deps, node: m.node, tests: m.test?.fero?.tests, perf: m.perf?.tests, sim: m.sim ? `${n(m.sim.green)}/${n(m.sim.seeds)}` : null }
  for (const p of root.querySelectorAll('.lede-trust')) {
    // each item carries its own dot (lede.css), so a wrapped line never ends or starts on a bare one
    p.innerHTML = `<span class="tl">${items.map((x) => `<span class="ti">${x}</span>`).join('')}</span>`
    for (const b of p.querySelectorAll('[data-k]')) attest(b, typeof vals[b.dataset.k] === 'number' ? n(vals[b.dataset.k]) : vals[b.dataset.k], 'build')
  }
}).catch((e) => { for (const chip of root.querySelectorAll('.lede-status')) chip.hidden = true; console.warn('lede: data/manifest.json unavailable; the trust line stays empty', e) })
// the data site link: held until the build saw the data site free of CONCEPT §8's claims about fero
fetch(new URL('../data/lede/links.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((l) => {
  if (l?.data?.ok === true) for (const a of root.querySelectorAll('.lede-datalink')) a.hidden = false
}).catch(() => {})
