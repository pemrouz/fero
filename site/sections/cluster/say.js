// sections/cluster/say.js — attested HTML pieces, and the ONE plain sentence of what is happening now.
// Every digit goes out inside a [data-attested] span; plain words carry none (a guard warns if one slips in).
// The sentence is fixed words over the kernel's own journal rows (suspect, giveUp, propose, evict, replayed,
// gateClose, aeShip), the page's write log and the live state — never a script of what "should" happen.
// Priority: a write that is stuck, then what just changed (a view, a write that waited, a heal), then states
// that last (a crash, a rejoin, a cut, a clean stop), and the routine writes last. Every waiting line says why,
// and every time in it says "simulated".
import { page, pair } from '../../cluster.js'
import { nid, stamp as stampHTML, inspect, vt, esc } from '../../ui.js'
import { M, ownerOf, waiting, landed, appliedSince, stampFor, batchOf, diskOf, noServerWhy } from './model.js'

// one cached formatter (cluster.js fmt builds a new one per call: too slow to run every frame)
const NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
export const num = (n) => (Number.isInteger(n) && Math.abs(n) < 1000 ? String(n) : NF.format(n))
export const A = (html, tier = 'runtime') => `<span data-attested="${tier}">${html}</span>`
export const N = (id) => A(nid(id))
export const S = (s) => A(stampHTML(s))
export const T = (ms) => A(esc(vt(ms)))
export const V = (v) => A(inspect(v))
export const X = (n, tier = 'runtime') => A(esc(typeof n === 'number' ? num(n) : String(n)), tier)
export const R = (row) => A(`<span class="cl-row">${esc(row)}</span>`)
// a seed is an id the reader can type into ?seed=, not a quantity: printed as is, never with a thousands separator
export const SEED = () => A(esc(String(page.seed)))

// sentence segments: w = plain words, h = attested html, L = a live value updated in place between rebuilds
const w = (t) => { if (/\d/.test(t)) console.warn('cluster: a digit in plain words:', t); return { k: 'w', t: esc(t) } }
const h = (t) => ({ k: 'h', t })
const L = (name, text) => ({ k: 'L', name, text, t: `<span data-attested="runtime" data-live="${name}">${esc(text)}</span>` })
const list = (ids) => {
  const out = []
  ids.forEach((id, i) => { if (i) out.push(w(i === ids.length - 1 ? ' and ' : ', ')); out.push(h(N(id))) })
  return out
}
// a verb that agrees with how many names come before it: one survivor "keeps", two "keep"
const agree = (ids, one, many) => w(ids.length === 1 ? one : many)

// paint(el, segs): rebuild only when the words change; otherwise update the live values in place
export function paint(el, segs) {
  let key = ''
  for (const s of segs) key += s.k === 'L' ? '\u0000' + s.name : s.t
  if (el._key !== key) { el._key = key; el.innerHTML = segs.map((s) => s.t).join(''); return true }
  for (const s of segs) if (s.k === 'L') { const x = el.querySelector(`[data-live="${s.name}"]`); if (x && x.textContent !== s.text) x.textContent = s.text }
  return false
}

const ROWS = ['widgets', 'gadgets', 'gizmos']
const fresh = (at, ms) => at != null && page.now - at >= 0 && page.now - at < ms
const relayOf = (id) => (page.role(id) === 'client' ? page.primary(id) : id)
const reach = (a, b) => a === b || (page.alive(a) && page.alive(b) && page.peers(a).includes(b))

// the redial / vote phase after a member went silent: what the survivors' journals say so far
function phase(gone, view) {
  const F = M.f, since = Math.max(F.kills.get(gone) ?? -1, [...F.cuts].filter(([p]) => p.split('|').includes(gone)).reduce((m, [, at]) => Math.max(m, at), -1))
  const surv = view.members.filter((m) => m !== gone && page.alive(m) && !page.isolated(m))
  if (F.propose && F.propose.at >= since && F.propose.epoch > view.epoch) return [h(N(F.propose.node)), w(' proposes view '), h(X(F.propose.epoch)), w(' without '), h(N(gone))]
  const gave = [...(F.giveUp.get(gone) ?? new Map())].filter(([n, at]) => at >= since && surv.includes(n)).map(([n]) => n).sort()
  const majority = surv.length * 2 > view.members.length
  if (gave.length) {
    if (majority) return [...list(gave), w(' gave up redialing it · the vote comes next')]
    // README: "two members cannot survive a crash" — one of two is not a majority, so no ballot can pass
    if (view.members.length === 2 && page.down.has(gone)) return [...list(gave), w(' gave up redialing it · two servers cannot survive a crash: one of two is not a majority, so no vote can pass')]
    return [...list(gave), w(' gave up redialing it · '), ...list(surv), agree(surv, ' alone is not a majority of view ', ' are not a majority of view '), h(X(view.epoch)), w(', so no vote can pass')]
  }
  const sus = [...(F.suspect.get(gone) ?? new Map())].filter(([n, at]) => at >= since && surv.includes(n)).map(([n]) => n).sort()
  if (sus.length) return [...list(sus), agree(sus, ' suspects it and keeps redialing it', ' suspect it and keep redialing it')]
  return surv.length ? [...list(surv), agree(surv, ' keeps redialing it', ' keep redialing it')] : [w('no server is left to vote')]
}

// why a server's write gate is closed, in words (kernel/membership.ts gate(): minority, rejoining, evicted,
// stale-epoch), and what has to change before a write it holds can go.
// lostOf: the members of its view it cannot reach, in groups — down (crashed), left (stopped on purpose), cut (the
// page holds the link between them cut), back (no cut any more, but the link has not come up again yet: just after
// a heal, the nodes redial)
function lostOf(id) {
  const out = { down: [], left: [], cut: [], back: [] }
  for (const m of page.viewOf(id).members) {
    if (m === id || reach(id, m)) continue
    if (page.left.has(m)) out.left.push(m)
    else if (!page.alive(m)) out.down.push(m)
    else if (page.cuts.has(pair(id, m))) out.cut.push(m)
    else out.back.push(m)
  }
  return out
}
const linksTo = (ids, one, many) => [w(ids.length === 1 ? 'its link to ' : 'its links to '), ...list(ids), w(ids.length === 1 ? one : many)]
function gateWhy(id, g) {
  const v = page.viewOf(id)
  if (g.reason === 'minority') {
    if (page.isolated(id)) return [w(' it is cut off from everyone, so it cannot reach a majority of view '), h(X(v.epoch))]
    const ls = lostOf(id), segs = [w(' it cannot reach a majority of view '), h(X(v.epoch))]
    // only links still coming back (a heal just happened): say that, not "cut off"
    if (ls.back.length && !ls.down.length && !ls.left.length && !ls.cut.length) return [...segs, w(' yet: '), ...linksTo(ls.back, ' is coming back', ' are coming back')]
    const parts = []
    if (ls.down.length) parts.push([...list(ls.down), agree(ls.down, ' is down', ' are down')])
    if (ls.left.length) parts.push([...list(ls.left), w(' left on purpose')])
    if (ls.cut.length) parts.push(linksTo(ls.cut, ' is cut', ' are cut'))
    if (ls.back.length) parts.push(linksTo(ls.back, ' is coming back', ' are coming back'))
    if (parts.length) { segs.push(w(' (')); parts.forEach((p, i) => { if (i) segs.push(w(' and ')); segs.push(...p) }); segs.push(w(')')) }
    return segs
  }
  if (g.reason === 'rejoining') return [w(' it restarted and is rejoining: it takes writes once a live member confirms its view')]
  if (g.reason === 'stale-epoch') return [w(' it saw a newer view and is fetching it')]
  if (g.reason === 'evicted') return [w(' it is not in the view, and asks to be voted back in')]
  return [w(' its write gate is closed')]
}
function gateUntil(id, g) {
  if (g.reason !== 'minority') return [w(' · the write waits in its buffer until then')]
  if (page.isolated(id)) return [w(' · the write waits in its buffer until the cut heals')]
  const v = page.viewOf(id), ls = lostOf(id)
  if (ls.down.length && !ls.cut.length && !ls.back.length && !ls.left.length) {
    if (v.members.length === 2) return [w(' · two servers cannot survive a crash, so the write waits until '), h(N(ls.down[0])), w(' is back')]
    return [w(' · the write waits until enough of them are back for a majority')]
  }
  if (!ls.cut.length && ls.back.length) return [w(' · the write waits in its buffer until the links are back')]
  return [w(' · the write waits in its buffer until the cut heals')]
}

// classify(wr, count): what a waiting write is waiting for. blocked = it cannot move until something changes.
// count = how many of its issuer's writes wait (wr is the oldest of them).
function classify(wr, count = 1) {
  const issuer = wr.node, row = wr.path[0]
  const head = [h(N(issuer)), ...(wr.remove ? [w(' removed '), h(R(row))] : [w(' wrote '), h(R(row)), w(' = '), h(V(wr.value))])]
  const wait = count > 1
    ? [w(' · '), h(X(count)), w(' writes from '), h(N(issuer)), w(' wait, the oldest for '), L('wait', vt(page.now - wr.issuedAt)), w(' simulated')]
    : [w(' · waiting '), L('wait', vt(page.now - wr.issuedAt)), w(' simulated')]
  const gate = page.role(issuer) === 'server' ? page.writable(issuer) : null
  if (gate && !gate.open) {
    const e = page.viewOf(issuer).epoch, maj = page.view()
    const out = maj.epoch > e && !maj.members.includes(issuer) ? [w(' · the others formed view '), h(X(maj.epoch)), w(' without it')] : []
    return { blocked: true, segs: [...head, w(' · '), h(N(issuer)), w(' is read-only:'), ...gateWhy(issuer, gate), w(' · the write waits in its buffer'), ...out, ...wait] }
  }
  const relay = relayOf(issuer)
  // the client's server just crashed and the client has not seen its link drop yet (30–90 ms simulated): it then
  // moves to another server and sends the write again there (kernel/node.ts: the client's failover)
  if (relay && !page.alive(relay) && page.serverIds.some((s) => s !== relay && page.alive(s) && !page.cuts.has(pair(issuer, s))))
    return { blocked: true, segs: [...head, w(' · its server '), h(N(relay)), w(' is down · '), h(N(issuer)), w(' sends it again through another server once it sees the link drop'), ...wait] }
  if (!relay || !page.alive(relay)) {
    // why there is no server to send it to: cut off from every server, no server up, or still connecting
    const why = page.role(issuer) === 'client' ? noServerWhy(issuer) : 'yet'
    const tail = why === 'cut' ? [w(' · '), h(N(issuer)), w(' is cut off from every server, so the write waits until the cut heals')]
      : why === 'down' ? [w(' · no server is up, so the write waits until one is back')]
      : [w(' · '), h(N(issuer)), w(' has no server to send it to yet: it is connecting')]
    return { blocked: true, segs: [...head, ...tail, ...wait] }
  }
  const view = page.viewOf(relay), owner = ownerOf(row, view)
  // a client's server holds the write while its own gate is closed (it parks everything): say why
  const rg = relay !== issuer && page.role(relay) === 'server' ? page.writable(relay) : null
  if (rg && !rg.open) {
    const who = relay === owner ? [w(' · its owner '), h(N(relay)), w(' holds it and is read-only:')] : [w(' · its server '), h(N(relay)), w(' holds it and is read-only:')]
    return { blocked: true, segs: [...head, ...who, ...gateWhy(relay, rg), ...gateUntil(relay, rg), ...wait] }
  }
  if (owner && !reach(relay, owner)) {
    const how = page.alive(owner) ? ' is cut off · ' : ' is down · '
    return { blocked: true, segs: [...head, w(' · its owner '), h(N(owner)), w(how), h(N(relay)), w(relay === issuer ? ' holds it · ' : ' holds the write · '), ...phase(owner, view), ...wait] }
  }
  // the owner is reachable but read-only (the minority side of its view): it holds the write until it is not
  if (owner && owner !== relay && page.alive(owner)) {
    const og = page.writable(owner)
    if (og && !og.open) return { blocked: true, segs: [...head, w(' · its owner '), h(N(owner)), w(' is read-only:'), ...gateWhy(owner, og), ...gateUntil(owner, og), ...wait] }
  }
  const st = stampFor(wr)
  if (st) {
    const { n, of } = landed(st)
    return { blocked: false, segs: [...head, w(' · '), h(N(st.origin.split('~')[0])), w(' stamped it '), h(S(st)), w(' · on '), L('land', num(n)), w(' of '), h(X(of)), w(' copies so far')] }
  }
  const hops = M.hops.get(wr.id), last = hops?.[hops.length - 1]
  const path = []
  if (hops && hops.length > 1) hops.forEach((id, i) => { if (i) path.push(w(' → ')); path.push(h(N(id))) })
  const segs = [...head]
  if (!path.length) segs.push(w(' · it goes to its owner '), h(N(owner)), w(' for a stamp'))
  else if (last === owner) segs.push(w(' · it goes '), ...path, w(', its owner, for a stamp'))
  else segs.push(w(' · it goes '), ...path, w(' on its way to its owner '), h(N(owner)))
  const long = page.now - wr.issuedAt > 1200
  if (long) segs.push(...wait)
  return { blocked: long, segs }
}

// a write that committed — named by its row and value, so the figure never mixes up two writes. When the owner
// stamped several of one node's waiting writes at once, say so: the last one is what every copy now shows.
const rowValue = (wr) => (wr.remove ? [w('removing '), h(R(wr.path[0]))] : [h(R(wr.path[0])), w(' = '), h(V(wr.value))])
function committed(c) {
  const wr = c.w, ws = batchOf(c), { n, of } = landed(wr.stamp)
  const segs = [h(N(wr.node))]
  if (ws.length > 1) segs.push(w("'s "), h(X(ws.length)), w(' waiting writes are stamped · the last, '), ...rowValue(wr), w(', as '), h(S(wr.stamp)))
  else segs.push(w("'s write "), ...rowValue(wr), w(' is stamped '), h(S(wr.stamp)))
  const oldest = ws.reduce((m, x) => Math.min(m, x.issuedAt), wr.issuedAt)
  const waited = wr.committedAt - oldest
  if (waited >= 900) segs.push(w(ws.length > 1 ? ' · the oldest waited ' : ' · it waited '), h(T(waited)), w(' simulated'))
  segs.push(w(' · on '), L('land', num(n)), w(' of '), h(X(of)), w(' copies'))
  return segs
}

function viewChange(v, prev) {
  if (!prev) {
    // the first view: say what a view is, and that every server derives the same owners from it (the ring)
    const segs = [w('view '), h(X(v.epoch)), w(' committed: '), ...list(v.members), w(', the first agreed list of members · from it, every server works out the same owners: ')]
    ROWS.forEach((row, i) => { if (i) segs.push(w(', ')); segs.push(h(R(row)), w(' → '), h(N(ownerOf(row, v)))) })
    return segs
  }
  const segs = [w('view '), h(X(v.epoch)), w(' committed: '), ...list(v.members)]
  const out = prev.members.filter((m) => !v.members.includes(m)), inn = v.members.filter((m) => !prev.members.includes(m))
  const quit = out.filter((m) => M.f.leaving.has(m)), gone = out.filter((m) => !M.f.leaving.has(m))
  if (gone.length) segs.push(w(' · '), ...list(gone), w(gone.length > 1 ? ' are out' : ' is out'))
  if (quit.length) segs.push(w(' · '), ...list(quit), w(quit.length > 1 ? ' left on purpose: they asked' : ' left on purpose: it asked'))
  // a member back from an earlier view "is back in"; one never in a view before "joins"
  const before = new Set(M.f.views.slice(0, -1).flatMap((x) => x.members))
  const back = inn.filter((m) => before.has(m)), fresh_ = inn.filter((m) => !before.has(m))
  if (back.length) segs.push(w(' · '), ...list(back), w(back.length > 1 ? ' are back in' : ' is back in'))
  if (fresh_.length) segs.push(w(' · '), ...list(fresh_), w(fresh_.length > 1 ? ' join' : ' joins'))
  for (const row of ROWS) { const a = ownerOf(row, prev), b = ownerOf(row, v); if (a && b && a !== b) segs.push(w(' · '), h(R(row)), w(' now belongs to '), h(N(b))) }
  return segs
}

function downPhrase(d, v) {
  // a client has no disk (a `dir` makes a node a server): its copy dies with the process
  if (page.role(d) === 'client') return [h(N(d)), w(' crashed · a client has no disk, so it cannot come back as itself · ↺ reset rebuilds the run')]
  if (v.members.includes(d)) return [h(N(d)), w(' crashed · its links dropped at once, and its disk is kept · '), ...phase(d, v)]
  const dk = diskOf(d)
  return [h(N(d)), w(' is down · view '), h(X(v.epoch)), w(' is '), ...list(v.members), w(' · its disk keeps '), h(X(dk ? dk.recs : 0)), w(dk && dk.recs === 1 ? ' record' : ' records'), w(' in its write-ahead log · restart brings it back from them')]
}
function rejoinPhrase(id, v) {
  if (!page.alive(id) || page.role(id) !== 'server' || v.members.includes(id) || page.isolated(id) || page.left.has(id) || leavingNow(id)) return null
  const F = M.f, life = page.life(id), r = F.replay.get(id)
  if (life > 1) return [h(N(id)), w(' restarted as life '), h(X(life)), w(' and writes as '), h(A(esc(page.origin(id)))),
    ...(r ? [w(' · its write-ahead log gave back '), h(X(r.records)), w(r.records === 1 ? ' record' : ' records'), w(' before any link came up')] : []),
    w(' · its counter starts above any it used before'),
    ...(F.asked.get(id) >= (F.restarts.get(id) ?? 0) ? [w(' · it asks to join')] : [w(' · it dials the others')])]
  return [h(N(id)), w(' is starting and asks to join · the members vote on it')]
}
// a clean stop (Ctrl-C, 02's "clean stop"): the node asked to be voted out and is still running until it is
const leavingNow = (id) => M.f.leaving.has(id) && page.alive(id) && !page.left.has(id)
function leavePhrase(id, v) {
  return [h(N(id)), w(' is stopping on purpose (Ctrl-C) and asks to be voted out'), w(v.members.includes(id) ? ' · the vote is on' : ' · the others voted it out · it stops now')]
}
function cutPhrase(v) {
  for (const id of page.ids()) {
    if (!page.alive(id) || !page.isolated(id)) continue
    const segs = [h(N(id)), w(' is cut off from everyone · it still serves reads from its own copy · a write there waits')]
    if (page.role(id) === 'server' && !v.members.includes(id)) segs.push(w(' · the others formed view '), h(X(v.epoch)), w(' without it'))
    else if (page.role(id) === 'server') {
      const others = v.members.filter((m) => m !== id && page.alive(m) && !page.isolated(m))
      if (others.length * 2 > v.members.length) segs.push(w(' · the others vote it out when their redials give up'))
    }
    return segs
  }
  if (page.cuts.size) { const [a, b] = [...page.cuts][0].split('|'); return [w('the link '), h(N(a)), w(' — '), h(N(b)), w(' is cut · writes still need a majority; reads never wait')] }
  return null
}
let disagree = null

// a kernel check that broke (sim/monitors.ts runs every rule after every event): the rule's name and what it caught,
// in the monitor's own terms. attempt-exactly-once ("one (issuer, cid) commits at most one distinct (origin, seq,
// epoch) anywhere in the cluster") names the two stamps one attempt got; any other rule shows its own words.
const TWICE = /^attempt (\S+?)\|(\d+) committed TWICE: (\S+?)\|(\d+)\|(\d+) and (\S+?)\|(\d+)\|(\d+)/
function brokenPhrase(name, b) {
  const segs = [w("the kernel's own check "), h(A(`<b class="broken">${esc(name)}</b>`)), w(' broke')]
  const m = name === 'attempt-exactly-once' && TWICE.exec(b.detail)
  if (m) {
    const [, iss, , o1, s1, e1, o2, s2, e2] = m, who = iss.includes('~') ? iss.slice(0, iss.lastIndexOf('~')) : iss
    segs.push(w(': one write from '), h(N(who)), w(' was stamped twice, as '), h(S({ epoch: +e1, seq: +s1, origin: o1 })), w(' and as '), h(S({ epoch: +e2, seq: +s2, origin: o2 })),
      w(' · the rule is that one attempt commits at most once'))
  } else if (b.detail) segs.push(w(': '), h(A(esc(b.detail))))
  return segs
}

export function sentence() {
  const F = M.f, v = page.view()
  if (M.resetAt > 0 && performance.now() - M.resetAt < 2600)
    return [w('rebuilt from seed '), h(SEED()), w(M.resetBy === 'story' ? ' · the story starts again' : ' · the same seed gives the same run, event for event')]
  // 0. a kernel check that just broke comes first, for a few seconds (the strip keeps it after that)
  for (const [name, b] of F.broken) if (fresh(b.at, 4000)) return brokenPhrase(name, b)
  if (!v.epoch) return [w('the servers dial each other and vote on their first view, the agreed list of members · '), h(N(page.opts.seedFrom)), w(' already holds the starting rows: it applied them at boot')]
  // 1. a write that is stuck (the one stuck longest; its issuer's other waiting writes are counted with it)
  const all = waiting()
  const per = new Map(); for (const x of all) per.set(x.node, (per.get(x.node) ?? 0) + 1)
  const ws = all.map((x) => ({ x, c: classify(x, per.get(x.node)) }))
  const stuck = ws.filter((y) => y.c.blocked)
  if (stuck.length) return stuck[0].c.segs
  // 2. what just changed — the newest of: a view, a write that waited, a heal, a crash, a restart, a cut, a clean
  //    stop (one window for all, newest wins; a view and the write it freed merge into one sentence)
  const WIN = 3000
  const lastV = F.views[F.views.length - 1], prevV = F.views[F.views.length - 2]
  const c = F.commit, cw = F.waited
  const ev = []
  if (lastV && fresh(lastV.at, WIN)) ev.push({ at: lastV.at, kind: 'view' })
  if (cw && fresh(cw.at, WIN)) ev.push({ at: cw.at, kind: 'commit' })
  if (F.heal && fresh(F.heal.at, WIN)) ev.push({ at: F.heal.at, kind: 'heal' })
  for (const [id, at] of F.kills) if (fresh(at, WIN) && page.down.has(id)) ev.push({ at, kind: 'kill', id })
  for (const [id, at] of F.restarts) if (fresh(at, WIN) && page.alive(id)) ev.push({ at, kind: 'restart', id })
  for (const [p, at] of F.cuts) if (fresh(at, WIN)) ev.push({ at, kind: 'cut', p })
  for (const [id, at] of F.leaving) if (fresh(at, WIN) && leavingNow(id)) ev.push({ at, kind: 'leave', id })
  ev.sort((a, b) => b.at - a.at)
  const top = ev[0]
  if (top) {
    const near = (k) => ev.find((e) => e.kind === k && Math.abs(e.at - top.at) <= 700)
    if (top.kind === 'view') return [...viewChange(lastV, prevV), ...(near('commit') ? [w(' · '), ...committed(cw)] : [])]
    if (top.kind === 'commit') return [...(near('view') ? [...viewChange(lastV, prevV), w(' · ')] : []), ...committed(cw)]
    if (top.kind === 'heal') {
      const id = F.heal.nodes.length === 1 ? F.heal.nodes[0] : null
      const n = id ? appliedSince(id, F.heal.at) : 0
      return [w('the links are back · '), ...(id ? [h(N(id)), w(' and the others swap digests: each side sends what the other is missing')] : [w('the two sides swap digests: each sends what the other is missing')]),
        ...(n ? [w(' · '), h(N(id)), w(' has applied '), h(X(n)), w(n === 1 ? ' record since the heal' : ' records since the heal')] : [])]
    }
    if (top.kind === 'kill') return downPhrase(top.id, v)
    if (top.kind === 'restart') { const r = rejoinPhrase(top.id, v); if (r) return r }
    if (top.kind === 'cut') { const r = cutPhrase(v); if (r) return r }
    if (top.kind === 'leave') return leavePhrase(top.id, v)
  }
  // 3. states that last
  for (const d of [...page.down].sort()) return downPhrase(d, v)
  for (const [id] of F.leaving) if (leavingNow(id)) return leavePhrase(id, v)
  for (const id of page.serverIds) { const r = rejoinPhrase(id, v); if (r) return r }
  { const r = cutPhrase(v); if (r) return r }
  for (const [id] of F.left) if (!page.alive(id)) return [h(N(id)), w(' left on purpose · the others voted it out when it asked')]
  const cp = page.copies()
  if (cp.agree < cp.of && !ws.length && !(c && fresh(c.at, 1600))) {
    disagree ??= page.now
    if (page.now - disagree > 800) return [w('copies are catching up: '), h(X(cp.agree)), w(' of '), h(X(cp.of)), w(' agree · digests show each side what is missing')]
  } else disagree = null
  // 4. the routine: a write on its way, or one that just landed
  if (ws.length) return ws[ws.length - 1].c.segs
  if (c && fresh(c.at, 1600)) return committed(c)
  const wr = page.writer
  if (wr.on && page.alive(wr.id)) {
    const owner = ownerOf(wr.row, v)
    return [h(N(wr.id)), w(' writes '), h(R(wr.row)), w(' every '), h(T(wr.every)), w(' of simulated time · '), h(N(owner)), w(' owns '), h(R(wr.row)), w(' and stamps each write'), ...(cp.agree === cp.of ? [w(' · copies agree')] : [])]
  }
  return [w('the cluster is quiet'), ...(cp.agree === cp.of ? [w(' · copies agree')] : [])]
}

// the rail's status (1400 px and wider), one fact a line: the seed, the simulated clock, the view and its members (a
// crashed member struck through, and named as down at once — the vote that drops it comes seconds later), what is
// down or cut off, the waiting writes, the copies. "paused" shows; slow motion does not (it toggles about once a
// second in watch mode, and the dock must not twitch).
export function status() {
  const v = page.view(), c = page.copies(), wn = waiting().length
  const down = [...page.down].sort()
  const cut = page.ids().filter((id) => page.alive(id) && page.isolated(id))
  const members = v.members.map((m) => (page.down.has(m) ? `<span class="is-down">${N(m)}</span>` : N(m))).join(' ')
  const names = (ids) => ids.map((id) => N(id)).join(' ')
  const segs = [
    h(`<span class="ds-l ds-k">cluster · seed ${SEED()}</span><span class="ds-l">`), L('t', vt(page.now)), w(' simulated'), h('</span>'),
    h(`<span class="ds-l">${v.epoch ? `view ${X(v.epoch)} · ${members}` : 'no view yet'}</span>`),
  ]
  if (page.paused) segs.push(h('<span class="ds-l ds-mode">paused</span>'))
  if (down.length) segs.push(h(`<span class="ds-l broken">${names(down)} down ✕</span>`))
  if (cut.length) segs.push(h(`<span class="ds-l broken">${names(cut)} cut off</span>`))
  segs.push(h(`<span class="ds-l${wn ? ' waiting' : ''}">${X(wn)} waiting</span>`))
  segs.push(h(`<span class="ds-l">${c.agree === c.of ? '<span class="agree-ok">copies agree ✓</span>' : `<span class="waiting">${X(c.agree)} of ${X(c.of)} agree</span>`}</span>`))
  return segs
}
// the tab's state (narrower than 1400 px): the most pressing one, as a shape, with its words for the label —
// a node down or cut off (✕), a write waiting or copies that differ (⋯), else copies agree (✓)
export function dockState() {
  const c = page.copies(), wn = waiting().length
  const down = [...page.down].sort(), cut = page.ids().filter((id) => page.alive(id) && page.isolated(id))
  if (down.length) return { g: '✕', cls: 'bad', words: `${down.join(' ')} down` }
  if (cut.length) return { g: '✕', cls: 'bad', words: `${cut.join(' ')} cut off` }
  if (wn) return { g: '⋯', cls: 'wait', words: `${wn} waiting` }
  if (c.agree !== c.of) return { g: '⋯', cls: 'wait', words: `${c.agree} of ${c.of} copies agree` }
  return { g: '✓', cls: 'ok', words: 'copies agree' }
}
// the whole status on one line, for the head of the ⋯ menu (the pill shows only part of it)
export function statusLine() {
  const v = page.view(), c = page.copies(), wn = waiting().length
  const down = [...page.down].sort(), cut = page.ids().filter((id) => page.alive(id) && page.isolated(id))
  let out = `seed ${SEED()} · ${X(vt(page.now))} simulated · ${v.epoch ? `view ${X(v.epoch)}: ${v.members.map((m) => (page.down.has(m) ? `<span class="is-down">${N(m)}</span>` : N(m))).join(' ')}` : 'no view yet'}`
  if (down.length) out += ` · <span class="broken">${down.map(N).join(' ')} down ✕</span>`
  if (cut.length) out += ` · <span class="broken">${cut.map(N).join(' ')} cut off</span>`
  out += ` · <span${wn ? ' class="waiting"' : ''}>${X(wn)} waiting</span> · ${c.agree === c.of ? '<span class="agree-ok">copies agree ✓</span>' : `<span class="waiting">${X(c.agree)} of ${X(c.of)} agree</span>`}`
  if (page.paused) out += ' · paused'
  return out
}
