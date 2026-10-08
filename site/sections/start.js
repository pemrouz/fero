// sections/start.js — 03 "From zero".
//   a · example 02: server.ts and client.ts exactly as they are in the repo (BUILD: tools/start-sync.mjs →
//       data/start/example-02.json), the lines that act carrying a live "// →" note bound to THE house cluster
//       (RUNTIME: cluster.js `page`); at each card's foot what that file printed in a REAL run (BUILD:
//       data/demo-02.json, recorded by tools/record.mjs), replayed at the speed it ran; then the series (BUILD).
//   b · the README's shape block (its checkout comment kept) with the same live notes, then the same run + series.
// Honesty: every digit is attested — build values from the synced JSON / data/manifest.json, everything else read
// from the kernel as it renders. The page never runs fero(): "run this line ▸" posts the record the line becomes
// (page.write → one whole-row { type: 0, key: [row], value }) on the node that plays that file's process. A note
// names where a record came from whenever it is not this line's own (the seed, another writer), and its times are
// the kernel's: "stamped" is the owner's own apply of the record, "back on c1" is the issuer's.
import { page, attest, REDUCED, onFrame, keyOf, stable, decode, pair } from '../cluster.js'
import { nid, stamp, rec, inspect, vt, esc } from '../ui.js'

const root = document.getElementById('start')
const url = (p) => new URL(p, import.meta.url).href
const json = (p) => fetch(url(p)).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json() })
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e }
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')      // a README's `backticks` → <code>
// attest() for markup: kernel/build values rendered as HTML (records, stamps), tier stamped on the element
const putHTML = (el, html, tier) => {
  if (el.__h !== html) { el.innerHTML = html; el.__h = html }
  if (!html) el.removeAttribute('data-attested')                 // an empty element is never attested
  else if (tier && el.getAttribute('data-attested') !== tier) el.setAttribute('data-attested', tier)
}
// one span per part, reused by place: a part that did not change keeps its DOM, so a word under the pointer keeps
// its tooltip while the waiting time beside it ticks
function putParts(box, parts, tier) {
  const list = parts.filter(Boolean)
  while (box.childElementCount > list.length) box.lastElementChild.remove()
  list.forEach((html, i) => { let el = box.children[i]; if (!el) { el = document.createElement('span'); box.append(el) } putHTML(el, html, tier) })
}
// object literals as the files write them ({ stock: 4 }, { item: 'gadgets', qty: 1 }) → values; null if not one
const literal = (s) => { try { return JSON.parse(s.replace(/'([^']*)'/g, '"$1"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')) } catch { return null } }
const cmp = (a, b) => (a.epoch - b.epoch) || (a.seq - b.seq) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0)
const same = (a, b) => !!a && !!b && cmp(a, b) === 0
const simulated = (ms) => `${vt(ms)} simulated`
const sep = '<span class="sep"> · </span>'
const base = (origin) => String(origin).replace(/~\d+$/, '')       // n01~2 → n01: the node behind an origin
// a fero word, explained on hover in facts.md's words (§1, §6), for a reader who lands on 03 first
const TERM = {
  view: 'a view is the agreed list of servers, with a number; a new view needs a vote',
  owner: "a row's owner is the one server that stamps every write to that row",
  majority: 'more than half of the servers in the view',
}
const term = (word, key = word) => `<span class="term" title="${esc(TERM[key])}">${word}</span>`
// ui.js rec(), its value kept on one line: a record that must wrap breaks before `value:`, never leaving a lone `}`
const recW = (r) => rec(r).replace(/(<span class="k">value<\/span>[\s\S]*)(<\/span>)$/, '<span class="nw">$1</span>$2')

// ── syntax colour: v2.css .tok-* (data's landing tokenizer, plus template literals) ───────────────────────
const TOKEN = /(\/\/[^\n]*)|(`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")|\b(\d+\.?\d*)\b|\b(import|from|const|let|var|function|return|new|if|else|for|of|in|true|false|null|undefined|delete|class|extends|export|default|async|await|typeof|instanceof)\b|([(){}[\];,])/g
function highlight(src) {
  let out = '', last = 0, m
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(src))) {
    out += esc(src.slice(last, m.index))
    const cls = m[1] ? 'tok-com' : m[2] ? 'tok-str' : m[3] ? 'tok-num' : m[4] ? 'tok-key' : 'tok-pun'
    out += `<span class="${cls}">${esc(m[0])}</span>`
    last = m.index + m[0].length
  }
  return out + esc(src.slice(last))
}

// ── which node plays which process: n01 applied the house seed (it is the shop); c1 is the one client ──────
const SERVER = page.opts.seedFrom ?? page.serverIds[0]
const CLIENT = page.clientIds[0]
const GATE = { minority: 'cannot reach a majority of the view', evicted: 'is not in the view', rejoining: 'is rejoining the view', 'stale-epoch': 'has seen a newer view and is fetching it' }
let B = {}                                                     // build values, once loaded (fero's major, …)

const downWord = (id) => page.left.has(id) ? 'has left' : 'is down ✕'
const liveServers = () => page.serverIds.filter((s) => page.alive(s))
// a row's owner as one phrase: up (★), down, or cut off from everyone
const ownerState = (o) => !page.alive(o) ? `${nid(o)} ${downWord(o)}` : page.isolated(o) ? `${nid(o)} is cut off` : nid(o, { owner: true })

// the latest record of a row across live nodes: the biggest stamp, its value, and how many live copies hold it.
// A remove leaves a tombstone stamp, which a server releases once nothing can contest it (journal: tombstoneGC), so a
// removed row is counted by the copies it is GONE from, never by the stamp (that would say "1 of 4" for a done remove).
const has = (id, row) => page.node(id).state.has(keyOf([row]))
function latest(row) {
  let best = null, value, live = 0, on = 0, gone = 0
  for (const id of page.ids()) {
    if (!page.alive(id)) continue
    live++
    if (!has(id, row)) gone++
    const s = page.stamp(id, row)
    if (s && (!best || cmp(s, best) > 0)) { best = s; value = page.cell(id, row) }
  }
  if (best) for (const id of page.ids()) if (page.alive(id) && same(page.stamp(id, row), best)) on++
  return { stamp: best, value, removed: !!best && value === undefined, on, gone, live }
}
// live copies holding one exact stamp of a row
function holding(row, s) {
  let on = 0, live = 0
  for (const id of page.ids()) if (page.alive(id)) { live++; if (same(page.stamp(id, row), s)) on++ }
  return { on, live }
}
const onOf = ({ on, live }, word = 'on') => `<span class="on${on === live ? ' agree-ok' : ''}">${word} ${on} of ${live}${on === live ? ' ✓' : ''}</span>`

// the records the seeding node stamped before any view: its own per-writer log, epoch 0 (kernel/node.ts `logs`; a
// node keeps every record it holds, so any copy's lane answers if the seeder is gone). Read once per run: compaction
// may later drop those log entries, and what the seed did at boot never changes.
let seedCache = null
function seedRecords() {
  if (seedCache) return seedCache
  for (const id of [SERVER, ...page.ids()]) {
    const lane = page.node(id)?.logs?.get(SERVER)
    const rs = lane ? lane.filter((e) => e.epoch === 0 && e.rec && e.rec.key.length === 1) : []
    if (rs.length) return (seedCache = rs.map((e) => ({ row: e.rec.key[0], value: e.rec.value, stamp: { epoch: e.epoch, seq: e.seq, origin: SERVER } })))
  }
  return null
}

// ── a write a line made, followed through the kernel ──────────────────────────────────────────────────────
// n.w is the page.write() object (state pending → committed when the record applies on the ISSUING node).
// n.ws adds what that object cannot say: the owner's own apply (the stamp: when, by whom), the WRITE frame that
// carried it off the issuer (so a crash after that is not a loss), and the issuer's crash or leave.
const NOTES = []                                               // every bound note, both variants
function follow(n, w) {
  n.w = w
  n.ws = { life: page.life(w.node), owner: page.owner(w.path[0]), stamp: null, stampedAt: 0, stampedBy: '', sentTo: '', ended: '' }
}
// idle · waiting (not stamped, issuer up) · stamped (owner applied it, not back on the issuer yet) · orphan (stamped,
// issuer died first) · sent (issuer died after sending it on, no stamp yet) · gone (issuer died with it) · done
function status(n) {
  const w = n.w
  if (!w) return 'idle'
  if (w.state === 'committed') return 'done'
  const up = page.alive(w.node) && page.life(w.node) === n.ws.life
  if (n.ws.stamp) return up ? 'stamped' : 'orphan'
  if (up) return 'waiting'
  return n.ws.sentTo ? 'sent' : 'gone'
}
const ended = (n) => n.ws.ended || 'crashed'

// why a write still waits, in plain words, from the kernel's state now
function why(w) {
  const row = w.path[0], owner = page.owner(row)
  // where the write sits: a server holds its own; a client hands it to the server it follows
  let at = w.node
  if (page.role(w.node) !== 'server') {
    at = page.primary(w.node)
    if (!at) return `${nid(w.node)} has no server to send it to yet`
    if (!page.alive(at)) return `its server ${nid(at)} ${downWord(at)}; ${nid(w.node)} moves to another once it notices`
    if (page.cuts.has(pair(w.node, at))) return `the link ${nid(w.node)} — ${nid(at)} is cut; ${nid(w.node)} moves to another server once it notices`
  }
  if (owner && owner !== at) {
    // an owner the write cannot reach: crashed, gone, or cut off from everyone. Only a majority of the view can
    // vote it out (README: two members cannot survive a crash)
    const lost = !page.alive(owner), cut = !lost && page.isolated(owner)
    if (lost || cut) {
      const v = page.view(), up = v.members.filter((m) => page.alive(m) && !page.isolated(m)).length
      const how = lost ? downWord(owner) : 'is cut off'
      return up * 2 > v.members.length
        ? `its ${term('owner')} ${nid(owner)} ${how}; the others must vote it out first`
        : `its ${term('owner')} ${nid(owner)} ${how}, and too few servers are left for a ${term('majority')} to vote it out`
    }
    if (page.cuts.has(pair(at, owner))) return `the link ${nid(at)} — ${nid(owner)} is cut, so ${nid(at)} cannot pass it to the row's ${term('owner')}`
    const og = page.writable(owner)
    if (og && !og.open) return `its ${term('owner')} ${nid(owner)} ${GATE[og.reason] ?? `cannot take writes (${esc(og.reason)})`}`
  }
  const g = page.writable(at)
  if (g && !g.open) return `${at === w.node ? '' : 'its server '}${nid(at)} ${GATE[g.reason] ?? `cannot take writes (${esc(g.reason)})`}`
  return owner ? `on its way to ${nid(owner)}, the row's ${term('owner')}` : `on its way to the row's ${term('owner')}`
}

// whose record a row's latest is, when no write of this line is in flight
function whose(n, row, L, sale) {
  const w = n.w
  if (w && w.state === 'committed' && same(w.stamp, L.stamp)) {
    const ws = n.ws, by = ws.stampedBy || base(L.stamp.origin)
    // past tense, tied to the stamp shown beside it: who owned the row in THAT view, not now
    if (by === w.node && ws.stamp && ws.stampedAt === w.issuedAt) return `this line's record, stamped at once by its ${term('owner')} ${esc(by)}`
    const t1 = ws.stamp ? ` after ${vt(ws.stampedAt - w.issuedAt)}` : ''
    return `${sale ? '' : "this line's record: "}${esc(by)} stamped it${t1}${by !== w.node ? `, ${esc(w.node)} had it back after ${vt(w.committedAt - w.issuedAt)}` : ''} (simulated)`
  }
  const seed = seedRecords()?.find((r) => r.row === row)
  if (seed && same(seed.stamp, L.stamp)) {
    const line = n.seedLine?.[row] !== undefined && stable(n.seedLine[row]) === stable(seed.value)
    return `from ${line ? 'the seed line above' : "the page's seed"}${w ? '' : '; this line has not run here yet'}`
  }
  for (let i = page.writes.length - 1; i >= 0; i--) {
    const x = page.writes[i]
    if (x.state === 'committed' && x !== w && same(x.stamp, L.stamp)) return `${x.remove ? 'removed' : 'written'} by ${x.by === 'writer' ? `the page's scripted writer on ${esc(x.node)}` : esc(x.node)}, not by this line`
  }
  return `stamped by ${esc(L.stamp.origin)}, not by this line`
}

// ── one bound line: a note under it, rendered from the kernel ─────────────────────────────────────────────
const BIND = [
  { kind: 'import', re: /^import \{ fero \} from 'fero'/ },
  { kind: 'seed', re: /await fero\('shop', \{ data: (\{.*\}) \}\)/ },
  { kind: 'snap', re: /^shop\.data\.tap\(\(\) => console\.log\(shop\.snapshot\)\)/ },
  { kind: 'restock', re: /shop\.data\.widgets = \{ stock: (\d+) \+ \(\+\+t % (\d+)\) \}/ },
  { kind: 'write', re: /^shop\.data\.(\w+) = (\{[^}]*\})/ },
  { kind: 'filter', re: /^const \w+ = shop\.data\.filter\(\(r\) => r\.stock < (\d+)\)/ },
  { kind: 'follows', re: /await fero\('shop'\)/ },
  { kind: 'sale', re: /shop\.data\[`sale-\$\{process\.pid\}-\$\{\+\+n\}`\] = (\{[^}]*\})/ },
  { kind: 'sale1', re: /^watcher\.data\.([\w$]+) = (\{[^}]*\})/ },
]
const CLIENT_KINDS = new Set(['follows', 'sale', 'sale1'])
const RUNS = new Set(['restock', 'write', 'sale', 'sale1'])

function makeNote(kind, m, fileNode, seedLine) {
  const el = h('div', 'st-note')
  el.dataset.kind = kind                                         // for tools/start-fix-drive.mjs
  const n = { kind, el, node: CLIENT_KINDS.has(kind) ? CLIENT : kind === 'snap' ? fileNode : SERVER, btn: null, w: null, ws: null, seedLine }
  if (kind === 'restock') { n.row = 'widgets'; n.base = +m[1]; n.mod = +m[2]; n.t = 0 }
  if (kind === 'write') { n.row = m[1]; n.value = literal(m[2]) }
  if (kind === 'filter') n.below = +m[1]
  if (kind === 'seed') n.line = literal(m[1])
  if (kind === 'sale') { n.value = literal(m[1]); n.n = 0 }
  if (kind === 'sale1') { n.row = m[1]; n.value = literal(m[2]) }
  if (RUNS.has(kind) && (kind === 'restock' || n.value)) {
    el.classList.add('runs')
    if (kind === 'sale') el.classList.add('sale')
    n.body = h('div')
    const foot = h('div', 'f')
    n.btn = h('button', 'act', 'run this line ▸')
    n.btn.type = 'button'
    n.btn.addEventListener('click', () => run(n))
    n.state = h('span', 'st-state')
    n.btn.setAttribute('data-attested', 'runtime')   // its label is kernel state too ("n01 is down", "waiting…")
    foot.append(n.btn, n.state)                     // the state, then the button at its right (CSS order)
    el.append(n.body, foot)
  } else n.body = el
  return n
}

// "run this line ▸": the record this line becomes, posted on the node that plays its process (a UI handler only)
function run(n) {
  if (!page.isReady || !page.alive(n.node) || ['waiting', 'stamped'].includes(status(n))) return
  try {
    if (n.kind === 'restock') { n.t++; follow(n, page.write(n.node, n.row, { stock: n.base + (n.t % n.mod) })) }
    else if (n.kind === 'write' || n.kind === 'sale1') follow(n, page.write(n.node, n.row, n.value))
    else if (n.kind === 'sale') { n.n++; follow(n, page.write(n.node, `sale-${n.node}-${n.n}`, n.value)) }
  } catch { /* the node went down between the paint and the click: the next paint says so */ }
  schedule(true)
}

const M = '<span class="m">// →</span>'
const row1 = (inner, cls = 'r') => `<div class="${cls}">${M}${inner}</div>`
// rowFit(inner, longer): the row as shown, stacked on an unseen copy of the longer text it can become, so a note whose
// value changes keeps one height and nothing under it moves (03, and 04 for a reader parked there). The copy is never
// seen and says nothing: digits written as x, no links, no titles
const ghost = (html) => html.replace(/<a\b[^>]*>/g, '<span>').replace(/<\/a>/g, '</span>').replace(/ (data-attested|title|href)="[^"]*"/g, '').replace(/\d/g, 'x')
const rowFit = (inner, longer) => `<div class="r st-fit"><div>${M}${inner}</div><div class="st-fit-r" aria-hidden="true">${M}${ghost(longer)}</div></div>`
const down = (id) => row1(`<span class="broken">${nid(id)} ${downWord(id)}</span>`)
function render(n) {
  const k = n.kind, id = n.node
  let html = ''
  if (k === 'import') {
    html = row1(`<span class="st-pub">fero <span data-attested="build">${esc(B.major)}</span> is not published yet: from a checkout, this line imports <code>'../../api/index.ts'</code>, as its comment says. </span>The page cannot run <code>fero()</code> itself. Its notes read fero's kernel on a simulated network, and <b>run this line ▸</b> posts the record a line becomes.`)
  } else if (k === 'seed') {
    const rs = seedRecords()
    if (!rs) html = row1(`${nid(id)} applies the page's seed at boot, before any ${term('view')}…`)
    else {
      // rows the line does not seed, or seeds with another value: the page's own (said, never hidden)
      const own = rs.filter((r) => !n.line || JSON.stringify(n.line[r.row]) !== JSON.stringify(r.value)).map((r) => r.row)
      const all = own.length === rs.length
      html = row1(`${nid(id)} applied ${all ? "the page's seed rows" : 'these'} at boot, before any ${term('view')}, as a <code>data:</code> seed does`) +
        `<div class="r st-seed">${rs.map((r) => `<span class="pair"><span class="row">${esc(r.row)}</span> ${own.includes(r.row) ? `${inspect(r.value)} ` : ''}${stamp(r.stamp)}${!all && own.includes(r.row) ? ' <span class="why">the page\'s own row</span>' : ''}</span>`).join('')}</div>`
    }
  } else if (k === 'snap') {
    html = page.alive(id) ? row1(`${nid(id)} now <span class="obj">${inspect(page.object(id))}</span>`) : down(id)
  } else if (k === 'filter') {
    if (!page.alive(id)) html = down(id)
    else {
      const o = page.object(id)
      const pass = Object.keys(o).filter((r) => o[r] && typeof o[r].stock === 'number' && o[r].stock < n.below)
      const d7 = B.dataNo ? `${sep}<span class="why">section <a href="#data" data-attested="build">${esc(B.dataNo)}</a> runs this view in data itself, on ${nid(CLIENT)}'s records</span>` : ''
      const says = (rows) => `the page tests <code>r.stock &lt; ${n.below}</code> on ${nid(id)}'s copy now: ${rows}${d7}`
      // the writer's row dips below the line and back on every cycle: the note keeps the room "gadgets { stock: 1 }
      // passes" takes, so it does not grow and shrink by a line each time
      html = rowFit(says(pass.length ? `${pass.map((r) => `<span class="row">${esc(r)}</span> ${inspect(o[r])}`).join(sep)} ${pass.length === 1 ? 'passes' : 'pass'}` : '<span class="why">no row passes</span>'),
        says(`<span class="row">${esc(page.writer.row)}</span> ${inspect({ stock: 0 })} passes`))
    }
  } else if (k === 'follows') {
    if (!page.alive(id)) html = down(id)
    else {
      const p = page.primary(id)
      const live = liveServers().length
      const say = !p ? `${nid(id)} has no server right now and keeps redialing.`
        : !page.alive(p) ? `${nid(id)} still follows ${nid(p)}, which ${downWord(p)}; it moves once it notices the link is gone.`
        : page.cuts.has(pair(id, p)) ? `${nid(id)} still follows ${nid(p)}, but the link between them is cut; it moves once it notices.`
        : `${nid(id)} follows ${nid(p)}, ${live === 1 ? 'the only live server' : `one of ${live} live servers`}.`
      html = row1(`${say} <span class="why">The page hands ${esc(id)} their addresses; a real client finds them by name.</span>`)
    }
  } else if (RUNS.has(k)) {
    const w = n.w, st = status(n), sale = k === 'sale' || k === 'sale1'
    const row = k === 'sale' ? (w ? w.path[0] : null) : n.row       // the sale line makes a new row each run
    const pid = k === 'sale' ? `${sep}<span class="why">process.pid is ${esc(id)} here</span>` : ''
    let parts = [], shown = null                                  // shown: the stamp on screen, if it is this line's
    if (st !== 'idle' && st !== 'done') {
      // this line's own write, while it is in flight or after its issuer died: its record, and where it is
      html = row1(recW({ type: 0, key: w.path, value: w.value }))
      const ws = n.ws
      if (st === 'waiting') parts = [`<span class="waiting">waiting · ${simulated(page.now - w.issuedAt)}</span>`, `${sep}<span class="why">${why(w)}</span>`, pid]
      else if (st === 'stamped' || st === 'orphan') {
        shown = ws.stamp
        parts = [`${stamp(ws.stamp)} ${onOf(holding(row, ws.stamp))}`, `${sep}<span class="why">${esc(ws.stampedBy)} stamped it after ${simulated(ws.stampedAt - w.issuedAt)}; ${st === 'stamped' ? `on its way back to ${esc(w.node)}` : `${esc(w.node)} ${ended(n)} before it came back`}</span>`, pid]
      } else if (st === 'sent') parts = [`<span class="broken">${esc(w.node)} ${ended(n)}</span>`, `${sep}<span class="why">after it sent this write to ${nid(ws.sentTo)}; no stamp yet</span>`]
      else parts = ['<span class="broken">gone</span>', `${sep}<span class="why">${esc(w.node)} ${ended(n)} before it ${ws.owner === w.node ? 'stamped this write' : 'passed this write on'}, so the write went with it</span>`]
    } else if (!row || (!w && !latest(row).stamp)) {
      // a line not run yet whose row is on no copy (the sale's next row, B's sale1): the record it becomes, and
      // that row's owner
      const next = row ?? `sale-${id}-${n.n + 1}`, o = page.owner(next)
      html = row1(recW({ type: 0, key: [next], value: n.value }))
      parts = ['<span class="why">not run yet</span>', pid, o ? `${sep}<span class="why">its ${term('owner')} ${ownerState(o)}</span>` : '']
    } else {
      // the row's latest record across live copies, and whose it is
      const L = latest(row)
      if (!L.stamp) html = row1(`no ${esc(row)} row on any live copy`)
      else {
        html = row1(recW(L.removed ? { type: 2, key: [row] } : { type: 0, key: [row], value: L.value }))
        if (w && w.state === 'committed' && same(w.stamp, L.stamp)) shown = L.stamp
        parts = [`${stamp(L.stamp)} ${L.removed ? onOf({ on: L.gone, live: L.live }, 'gone from') : onOf(L)}`, `${sep}<span class="why">${whose(n, row, L, sale)}</span>`, pid]
      }
    }
    // the write and its stamp are the accent: light the note once, when THIS line's write is stamped
    if (shown && n.litW !== w.id) {
      n.litW = w.id
      if (!REDUCED) {
        n.el.classList.add('lit'); n.freshUntil = performance.now() + 1500
        clearTimeout(n.lt); n.lt = setTimeout(() => { n.el.classList.remove('lit'); schedule() }, 1500)
      }
    }
    if (shown && performance.now() < (n.freshUntil ?? 0)) parts[0] = parts[0].replace('class="stamp"', 'class="stamp fresh"')
    putParts(n.state, parts, 'runtime')
    let label = 'run this line ▸', off = !page.isReady
    if (!page.alive(n.node)) { label = `${n.node} ${page.left.has(n.node) ? 'has left' : 'is down'}`; off = true }
    else if (st === 'waiting' || st === 'stamped') { label = 'waiting…'; off = true }
    if (n.btn.textContent !== label) n.btn.textContent = label
    if (n.btn.disabled !== off) n.btn.disabled = off
    const aria = k === 'sale' ? `run this line: ${n.node} writes the new sale row sale-${n.node}-${n.n + 1}` : `run this line: ${n.node} writes the whole ${n.row} row`
    if (n.btn.getAttribute('aria-label') !== aria) n.btn.setAttribute('aria-label', aria)
  }
  putHTML(n.body, html, 'runtime')
}

// ── a file card: the listing exactly as in the repo, a note under each bound line ─────────────────────────
function fileCard(file, opts) {
  const card = h('figure', 'st-file')
  const head = h('figcaption', 'st-file-head')
  const role = (file.text.match(/console\.log\(`([A-Z]+) /) || [])[1]
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
  head.innerHTML = `${role ? `<span class="st-role">${esc(role.toLowerCase())}</span>` : ''}<span class="st-file-name">${dir ? `<span class="dir" data-attested="build">${esc(dir)}</span>` : ''}${esc(file.name)}</span>` +
    `<span class="st-here" data-attested="runtime">on this page ${opts.here}</span>`   // the ids are the live cluster's (page.opts.seedFrom, page.clientIds)
  const code = h('div', 'st-code')
  code.setAttribute('role', 'group')
  code.setAttribute('aria-label', `${file.path}, line for line`)
  const notes = []
  const seedLine = literal((file.text.match(/await fero\('shop', \{ data: (\{.*\}) \}\)/) || [])[1] ?? '')
  for (const line of file.text.split('\n')) {
    const ln = h('div', 'st-ln')
    ln.setAttribute('data-literal', '')
    const no = h('span', 'st-no')
    no.setAttribute('aria-hidden', 'true')
    const src = h('span', 'st-src', highlight(line) || ' ')
    src.style.setProperty('--ind', `${line.match(/^ */)[0].length}ch`)
    ln.append(no, src)
    code.append(ln)
    for (const b of BIND) {
      const m = line.match(b.re)
      if (!m) continue
      const note = makeNote(b.kind, m, opts.node, seedLine)
      ln.classList.add('bound')
      code.append(note.el)
      notes.push(note)
      break
    }
  }
  card.append(head, code)
  return { card, notes }
}

// ── the recorded run: the two terminals replayed from data/demo-02.json, at the speed it ran ──────────────
// The <pre> holds ONLY screens the processes printed. The command, the process's state (starting, killed, …) and
// the badge sit in the pane's head, outside it: they are the page's words about the recording's events.
function recRun(demo) {
  const ev = demo.events
  const find = (re) => ev.find((e) => re.test(e.what))
  const sStart = find(/^server start$/)?.t, cStart = find(/^client start$/)?.t, again = find(/^server restart$/)?.t
  const killEv = find(/^kill server -\d+$/), killed = find(/^server exited/)?.t
  const sig = killEv ? killEv.what.match(/(-\d+)$/)[1] : ''           // the signal flag the recorder used, as it logged it
  const frames = demo.frames
  const total = Math.max(...frames.server.map((f) => f.t), ...frames.client.map((f) => f.t), ...ev.map((e) => e.t))
  // tools/record.mjs keeps the newest frame in its buffer until the NEXT frame's header arrives, so a frame's `t` is
  // when the following frame began: a frame was printed at the previous frame's `t` (checked: read that way, the
  // shop's and the watcher's restocks line up within a few ms every second). The first frame of each process run
  // has no earlier frame; it is placed one frame-gap before its own `t`, never before its command.
  const printedAt = (list, from) => list.map((f, i) => ({ text: f.text, t: i ? list[i - 1].t : Math.max(from, list.length > 1 ? 2 * f.t - list[1].t : f.t) }))
  const run1 = frames.server.filter((f) => killed === undefined || f.t <= killed)
  const run2 = again === undefined ? [] : frames.server.filter((f) => f.t > again)
  // a terminal is a list of moments: a state word, or a screen (each replaces the last: console.clear)
  const S = [{ t: sStart, state: 'starting' }, ...printedAt(run1, sStart).map((x, i) => i ? x : { ...x, state: 'running' })]
  if (killed !== undefined) S.push({ t: killed, state: 'killed ✕', dead: true })
  if (again !== undefined) S.push({ t: again, state: 'starting again', dead: true }, ...printedAt(run2, again).map((x, i) => i ? x : { ...x, state: 'running again' }))
  const C = [{ t: cStart, state: 'starting' }, ...printedAt(frames.client, cStart).map((x, i) => i ? x : { ...x, state: 'running' })]
  const screen = (list, rt) => {
    let text = null, state = 'not started yet', dead = false
    for (const s of list) {
      if (s.t > rt) break
      if (s.state) { state = s.state; dead = !!s.dead }
      if (s.text !== undefined) { text = s.text; dead = false }
    }
    return { text, state, dead }
  }
  // the tallest screen either terminal ever printed, so a pane never jumps
  const rows = Math.max(1, ...[...frames.server, ...frames.client].map((f) => f.text.split('\n').length))
  const pane = (label) => { const p = h('pre', 'st-term'); p.style.setProperty('--rows', rows); p.setAttribute('aria-label', `${label}, recorded`); p.setAttribute('data-scroll-x', ''); return p }
  const term1 = { pre: pane('the shop terminal'), cmd: 'node server.ts', list: S }, term2 = { pre: pane('the watcher terminal'), cmd: 'node client.ts', list: C }
  const tl = h('div', 'st-tl')
  tl.setAttribute('aria-hidden', 'true')
  tl.innerHTML = '<div class="st-tl-rail"></div><div class="st-tl-fill"></div>'
  const fill = tl.querySelector('.st-tl-fill')
  const marks = [[sStart, 'node server.ts', ''], [cStart, 'node client.ts', ''], [killEv?.t, `kill ${sig} the shop`, 'kill'], [again, 'node server.ts again', ''], [total, 'end of the recording', 'end']]
    .filter(([t]) => t !== undefined)
    .map(([t, text, cls]) => { const e = h('div', `st-tl-ev ${cls}`, `<span data-attested="build">${esc(text)}</span>`); e.style.left = `${(t / total) * 100}%`; tl.append(e); return { t, e, text } })
  const now = h('div', 'st-tl-now')
  tl.append(now)
  const cap = h('p', 'st-rec-cap')
  // a loop opens just before the first screen either terminal printed (the boot before it is silence); the
  // timeline keeps every event at its true place
  const first = Math.min(...[...S, ...C].filter((x) => x.text !== undefined).map((x) => x.t))
  const start = Math.max(0, first - 400)
  let shown = -1
  const terms = [term1, term2]
  return {
    total, start, terms, tl, cap,
    paint(rt) {
      for (const T of terms) {
        const sc = screen(T.list, rt)
        putHTML(T.pre, sc.text ? esc(sc.text) : '', 'build')
        T.pre.classList.toggle('dead', sc.dead)
        if (T.state) { putHTML(T.state, esc(sc.state), 'build'); T.state.classList.toggle('dead', sc.dead && /killed/.test(sc.state)) }
      }
      fill.style.transform = `scaleX(${Math.min(1, rt / total)})`
      let cur = 0
      marks.forEach((mk, i) => { const past = mk.t <= rt; mk.e.classList.toggle('past', past); if (past) cur = i })
      if (cur !== shown) { shown = cur; putHTML(now, esc(marks[cur].text), 'build') }
    },
  }
}
// a terminal: its head (the README's command, the process's state, the badge) over the recorded screen
function printed(T, recorded, badge) {
  const box = h('div', 'st-print')
  const head = h('div', 'st-print-head')
  const cmd = h('span', 'st-cmd', esc(T.cmd))
  cmd.title = `the README's command for this terminal. tools/record.mjs ran the same file from the repository root, on a private directory port, and kept every screen it printed`
  T.state = h('span', 'st-tstate')
  head.append(cmd, T.state)
  if (badge) {
    const b = h('span', 'st-badge', `recorded from a real run · <span>${esc(recorded)}</span>`)
    b.querySelector('span').setAttribute('data-attested', 'build')
    head.append(b)
  }
  box.append(head, T.pre)
  return box
}

// ── the series: examples/README.md's table, compact — a rung's number and name, its whole lesson on hover or focus
// (a card under its row, over the rows below: nothing moves). A screen reader gets the lesson as the rung's description.
function rungList(box, foot, rr, ex, hereText) {
  const vid = box.closest('[data-variant]')?.dataset.variant ?? 'x'
  const els = rr.rungs.map((r) => {
    const mark = r.no === ex.example.no || r.no === rr.vote.no
    const el = h('div', 'st-rung' + (mark ? ' marked' : ''))
    el.tabIndex = 0
    el.setAttribute('role', 'listitem')
    el.setAttribute('aria-describedby', `st-ls-${vid}-${r.no}`)   // the lesson is not drawn until hovered, but always read
    putHTML(el, `<span class="no">${esc(r.no)}${mark ? '<span class="up">↑</span>' : ''}</span><span class="nm">${esc(r.name)}</span><span class="ls" id="st-ls-${esc(vid)}-${esc(r.no)}"><span class="lsn">${esc(r.no)} ${esc(r.name)} · </span>${md(r.lesson)}</span>`, 'build')
    return el
  })
  const v = rr.rungs.find((r) => r.no === rr.vote.no)
  putHTML(foot, `<span class="ln"><span class="up">↑</span> <b>${esc(ex.example.no)}</b> is ${hereText}. <span class="up">↑</span> <b>${esc(v.no)}</b> is the vote above, on real processes: <q>${md(rr.vote.text)}</q> <span class="st-path nw">${esc(rr.vote.path)}</span></span>`, 'build')
  // explicit columns, read down then across; each knows its place (--i), so a lesson card spans the whole list
  let cols = 0
  const split = () => {
    const c = innerWidth > 980 ? 4 : innerWidth > 640 ? 3 : 2
    if (c === cols) return
    cols = c
    box.replaceChildren()
    const per = Math.ceil(els.length / c)
    for (let i = 0; i < c; i++) { const col = h('div', 'st-rung-col'); col.setAttribute('role', 'list'); col.style.setProperty('--i', i); col.append(...els.slice(i * per, (i + 1) * per)); box.append(col) }
    box.style.setProperty('--cols', c)
  }
  split()
  addEventListener('resize', split)
}
// the series' hint names the gesture this screen has: a touch screen has no hover (a tap focuses the rung)
const HOVERLESS = typeof matchMedia === 'function' ? matchMedia('(hover: none)') : null
const syncHint = () => {
  root?.classList.toggle('st-tap', !!HOVERLESS?.matches)          // a tap focuses a rung, so focus shows its lesson there
  for (const el of root?.querySelectorAll('[data-rung-hint]') ?? []) el.textContent = `${HOVERLESS?.matches ? 'tap' : 'hover'} a rung for its lesson`
}
syncHint(); HOVERLESS?.addEventListener?.('change', syncHint)

// ── boot ──────────────────────────────────────────────────────────────────────────────────────────────────
let schedule = () => {}
let dirty = true
if (root) boot().catch((e) => console.error('[start]', e))

async function boot() {
  const [ex, rr, man, demo] = await Promise.all([json('../data/start/example-02.json'), json('../data/start/rungs.json'), json('../data/manifest.json'), json('../data/demo-02.json')])
  const major = String(man.version ?? '').split('.')[0]
  // "not published yet" prints only while both build checks hold (facts.md §5): npm's fero is not this major,
  // and the repository has no remote
  const unpublished = man.remote === false && typeof man.npm?.fero === 'string' && !man.npm.fero.startsWith(`${major}.`)
  if (!unpublished) root.classList.add('st-unverified')
  // section 07's numeral, read from the page as built (the B filter note points there); none if 07 is absent
  const dataNo = document.querySelector('#data .sec-no')?.textContent.trim() ?? ''
  B = { major, node: rr.node?.floor, node23: rr.node?.line23, node23line: String(rr.node?.line23 ?? '').split('.')[0], exno: ex.example.no, exdir: `examples/${ex.example.dir}/`, head: ex.head, recorded: String(demo.recorded).slice(0, 10), rungs: rr.count, dataNo }
  for (const el of root.querySelectorAll('[data-b]')) { const v = B[el.dataset.b]; if (v !== undefined && v !== '') attest(el, String(v), 'build') }
  // the series table links to the repository on GitHub only while the build saw a remote (the chip above reads the
  // same field); without one the path stays, unlinked
  if (man.remote !== true) for (const a of root.querySelectorAll('a[data-repo]')) a.replaceWith(a.querySelector('code'))

  const views = []
  for (const v of root.querySelectorAll('.opt > [data-variant]')) {
    const files = v.querySelector('[data-files]'), recEl = v.querySelector('[data-rec]')
    const notes = []
    const tape = recRun(demo)
    if (v.dataset.variant === 'a') {
      for (const f of ex.files) {
        const node = /client/.test(f.name) ? CLIENT : SERVER
        const { card, notes: ns } = fileCard(f, { node, here: nid(node) })
        card.append(printed(node === CLIENT ? tape.terms[1] : tape.terms[0], B.recorded, true))
        files.append(card); notes.push(...ns)
      }
    } else {
      const { card, notes: ns } = fileCard({ name: `${ex.shape.path} · the shape block`, path: ex.shape.path, text: ex.shape.text }, { node: SERVER, here: `${nid(SERVER)} is <code>shop</code>${sep}${nid(CLIENT)} is <code>watcher</code>` })
      files.append(card); notes.push(...ns)
      recEl.append(printed(tape.terms[0], B.recorded, false), printed(tape.terms[1], B.recorded, false))
    }
    recEl.append(tape.tl, tape.cap)
    putHTML(tape.cap, `<q>${md(ex.restart.text)}</q> <span class="st-path nw">${esc(ex.restart.path)}</span>`, 'build')
    rungList(v.querySelector('[data-rungs]'), v.querySelector('[data-rungs-foot]'), rr, ex, v.dataset.variant === 'a' ? 'the two files above' : 'the run recorded above')
    NOTES.push(...notes)
    views.push({ v, notes, replay: tape, shown: !v.hidden, rt: 0, recSeen: false })
  }

  // ── follow this section's writes through the kernel (reads only: no action is ever taken in a callback) ──
  page.on('apply', (a) => {
    for (const n of NOTES) {
      const w = n.w
      if (!w || n.ws.stamp || a.key !== w.key || a.at < w.issuedAt || base(a.origin) !== a.node) continue   // the stamp site: the owner applying its own stamp
      if (a.type === 2 || stable(a.value) !== stable(w.value)) continue
      n.ws.stamp = { epoch: a.epoch, seq: a.seq, origin: a.origin }; n.ws.stampedAt = a.at; n.ws.stampedBy = a.node
    }
    dirty = true
  })
  page.on('frame', (f) => {
    if (f.verb !== 'WRITE') return
    for (const n of NOTES) {
      const w = n.w
      if (!w || w.state !== 'pending' || n.ws.sentTo || f.from !== w.node || f.sentAt < w.issuedAt) continue
      let d = null
      try { d = decode(f.bytes) } catch { continue }
      if (d.recs?.some((r) => keyOf(r.key) === w.key)) n.ws.sentTo = f.to
    }
  })
  for (const t of ['kill', 'left']) page.on(t, (id) => { for (const n of NOTES) if (n.w && n.w.node === id && n.w.state === 'pending' && !n.ws.ended) n.ws.ended = t === 'kill' ? 'crashed' : 'left'; dirty = true })

  // ── gates: this section on screen × the variant shown × the tab visible ──
  let onScreen = false, lastWait = 0, lastSig = ''
  page.watch(root)                                         // the house cluster advances while 03 is on screen
  new IntersectionObserver((es) => { for (const e of es) onScreen = e.isIntersecting; if (onScreen) dirty = true }, { rootMargin: '120px' }).observe(root)
  const recIO = new IntersectionObserver((es) => { for (const e of es) { const view = views.find((x) => x.replay.terms[0].pre === e.target); if (view) view.recSeen = e.isIntersecting } }, { threshold: 0.25 })
  for (const view of views) {
    recIO.observe(view.replay.terms[0].pre)
    view.v.addEventListener('variantshow', () => { view.shown = true; dirty = true })
    view.v.addEventListener('varianthide', () => { view.shown = false })
    view.rt = view.replay.start
    view.replay.paint(REDUCED ? view.replay.total : view.rt)
  }
  const paintNotes = () => { for (const view of views) if (view.shown) for (const n of view.notes) render(n) }
  schedule = (now) => { dirty = true; if (now === true) paintNotes() }
  for (const t of ['commit', 'write', 'view', 'restart', 'leave', 'cut', 'heal', 'join', 'ready']) page.on(t, () => { dirty = true })
  page.on('reset', () => {
    seedCache = null
    for (const n of NOTES) { n.w = null; n.ws = null; n.litW = 0; n.freshUntil = 0; if ('t' in n) n.t = 0; if ('n' in n) n.n = 0 }
    dirty = true
  })
  // which server c1 follows changes with no page event (the kernel moves it when a link drops): check it per frame
  const followSig = () => `${page.isReady}|${page.alive(CLIENT) ? page.primary(CLIENT) : '-'}|${liveServers().length}|${page.cuts.size}`
  paintNotes()
  let last = 0
  onFrame((now) => {
    const dt = last ? Math.min(100, now - last) : 0
    last = now
    if (!onScreen || document.hidden) return
    const sig = followSig()
    if (sig !== lastSig) { lastSig = sig; dirty = true }
    const waiting = views.some((view) => view.shown && view.notes.some((n) => status(n) === 'waiting'))
    if (dirty || (waiting && now - lastWait > 150)) { dirty = false; lastWait = now; paintNotes() }
    if (REDUCED) return
    for (const view of views) {
      if (!view.shown || !view.recSeen) continue
      view.rt += dt
      if (view.rt > view.replay.total + 3000) view.rt = view.replay.start
      view.replay.paint(Math.min(view.rt, view.replay.total))
    }
  })
}
