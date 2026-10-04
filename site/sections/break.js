// sections/break.js — §02 Break it.
//   a · chips in four groups act on THE shared house cluster (cluster.js `page`); one panel says what the chip
//       is, what it is in Node, what fero promises (quoted from the repo at build time: data/break/facts.json),
//       what the kernel did since the click (its own journal, grouped into plain lines, simulated times), the
//       numbers that matter for that fault, and the ten rules the simulator checked since the click. A fault
//       caused anywhere else on the page (the dock, the centrepiece, another section) starts the same story.
//   b · three OWN runs side by side (break/runs.js, in a Worker): crash · clean stop · crash with two servers,
//       the same write in each, a view timeline under each, the write's wait counted.
// Honesty: every digit is attested — runtime (the kernel, or the page's own write log built from kernel
// applies), measured (none here), or build (facts.json: the repo's sentences, defaults and constants).
import { page, attest, put, onFrame, CONFIRM, pair } from '../cluster.js'
import { nid, stamp, rec, inspect, vt, esc } from '../ui.js'
import { tip } from '../lib/tools/debug/eli5.mjs'
import { Story, annotate } from './break/narrate.js'

const root = document.getElementById('break')
const VA = root.querySelector(':scope > .opt > [data-variant="a"]')
const VB = root.querySelector(':scope > .opt > [data-variant="b"]')
const $ = (id) => document.getElementById(id)

// the faults this section installs — inputs to the simulator, never printed as typed numbers (what prints is
// what the kernel then did: frame flight times, save times, journal rows)
const SLOW = [200, 300]        // a slow link, kept under the leave window (4 heartbeats at 100 ms)
const DUP = 0.5                // a duplicated frame, one in two
const SLOW_DISK = [250, 350]   // a slow fsync
const LIE = 0.5                // a lying fsync: half the saves resolve but do not survive a crash
const WINDOW = 30000           // the panel follows the kernel at most this long after a click (simulated ms)
const TAIL = 2500              // …and stops this long after the chip's story is over (the vote landed, the write committed)
const ROWS = ['widgets', 'gadgets', 'gizmos']
const SCOPED = new Set(['scoped-lawful-holding', 'orphan-frozen'])   // the two rules that need `replicas`
const GATE_WORDS = { minority: 'it cannot reach a majority', rejoining: 'it is rejoining', evicted: 'it is not in the view', 'stale-epoch': 'its view is out of date' }

// ── small html helpers ───────────────────────────────────────────────────────────────────────────────
// numbers as cluster.js fmt prints them (en-US grouping, up to 2 decimals), with the formatters built once: fmt's
// toLocaleString builds a new one on every call, and this panel prints dozens of numbers several times a second
const NF0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }), NF2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? (Number.isInteger(v) ? NF0 : NF2).format(v) : String(v))
const T = (v, tier = 'runtime') => `<b class="tv" data-attested="${tier}">${esc(typeof v === 'number' ? num(v) : v)}</b>`
const list = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])
const ids = (xs) => list(xs.map((id) => nid(id)))
// the subject of a journal line: one node, or "each of n01, n03 and c1" (the words are always one verb for one node)
const who = (xs) => (xs.length > 1 ? `<span class="each">each of</span> ${ids(xs)}` : xs.length ? nid(xs[0]) : '')
const many = (n, one, more = one + 's') => (n === 1 ? one : more)
const codeify = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
// an offset on the simulated clock, written the way every section writes one (ui.js vt: '+30 ms', '+4.6 s')
const plus = (ms) => `+${vt(Math.max(0, ms))}`
const jkTip = (name) => tip('jk:' + name)?.d ?? ''
const liveServers = () => page.serverIds.filter((id) => page.alive(id))
const bare = (s) => String(s ?? '').split('~')[0]
const isServer = (id) => !!id && page.role(id) === 'server'
const OK = { ok: true }
const no = (why) => ({ ok: false, why })

// ── build facts: the repo's own sentences, defaults and constants (tools/break-facts.mjs) ───────────────
let FACTS = null
const factsReady = fetch(new URL('../data/break/facts.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((f) => { FACTS = f; return f })
const cite = (q) => `<cite data-attested="build" title="${esc(q.src)}, line ${q.line}">${esc(q.where)}</cite>`
const quote = (id) => { const q = FACTS?.quotes?.[id]; return q ? `<p>${codeify(q.text)}</p>${cite(q)}` : '' }
// a quote as a row of the numbers: the repo's words, then where they are
const quoteRow = (id, lead = '') => { const q = FACTS?.quotes?.[id]; return q ? F(`<p>${lead}${codeify(q.text)}</p>${cite(q)}`, '', { quote: true, wide: true }) : null }
// "Two members cannot survive a crash." (README · Membership), then the rest of the sentence, then where it is from
const twoMembers = (rest) => { const q = FACTS?.quotes?.crash; return q && /two members cannot survive a crash/.test(q.text) ? `<span class="waiting">Two members cannot survive a crash.</span> ${rest} ${cite(q)}` : `One of two members is not a majority. ${rest}` }
const addCmd = () => FACTS?.quotes?.addcmd?.text.split('#')[0].trim() || 'node server.ts'

// ── what the page knows about faults (any section's, through the page's events) ─────────────────────────
const linkFx = new Map()   // pair → the fault object last installed on it (sim.fault replaces, never merges)
const diskFx = new Map()   // node → the store fault last installed on it
const killed = []          // crashed nodes, most recent last
page.on('fault', ([a, b, f]) => { linkFx.set(pair(a, b), { a, b, f }); dirty = true })
page.on('disk', ([id, f]) => { diskFx.set(id, f); dirty = true })
const slowPairs = () => [...linkFx.values()].filter((x) => x.f.delay && x.f.delay[0] >= SLOW[0])
const dupPairs = () => [...linkFx.values()].filter((x) => x.f.dupP > 0)
const diskWith = (k) => [...diskFx.entries()].filter(([, f]) => f[k]).map(([id]) => id)
const house = () => page.opts.delay

// a probe changes the kernel's event count, so log it like a visitor action: LiveCluster.replay() then posts
// the same confirm at the same event and a replay twin stays identical (core.js does not log probes itself)
function probe(on, origin, seq, level) {
  page.actions.push({ at: page.now, ev: page.events, op: 'probe', args: [on, origin, seq, level] })
  return page.probe(on, origin, seq, level)
}

// ── targets ─────────────────────────────────────────────────────────────────────────────────────────────
const gadgetsOwner = () => page.owner('gadgets')
function processTarget() { const o = gadgetsOwner(); if (o && page.alive(o)) return o; const ls = liveServers(); return ls[ls.length - 1] ?? null }
function sideTarget() { const o = gadgetsOwner(); const ls = liveServers().filter((id) => id !== o && !page.isolated(id)); return ls[ls.length - 1] ?? null }
function diskTarget() { const ls = liveServers(); return ls[ls.length - 1] ?? null }
function c1Link() { if (!page.alive('c1')) return null; const p = page.primary('c1'); return p ? ['c1', p] : null }
const firstWriteAfter = (c, node = 'c1') => page.writes.find((w) => w.issuedAt >= c.t0 && w.node === node && !w.remove)
const cell = (id, row) => (page.alive(id) ? page.object(id)[row] : undefined)
const nextStock = (row) => { const v = cell('c1', row); const s = v && typeof v.stock === 'number' ? v.stock : 0; return { stock: (s + 1) % 10 } }
const ownerWords = (id) => { const rows = ROWS.filter((r) => page.owner(r) === id); return rows.length ? `the owner of ${list(rows)}` : 'a member' }
// would cutting `t` off leave a majority of the view on the other side? (the members that are not t, alive, not cut off)
function leavesMajority(t) { const v = page.view(); const rest = v.members.filter((m) => m !== t && page.alive(m) && !page.isolated(m)); return rest.length * 2 > v.members.length }
// rows whose owner in the committed view is a server that is down (it was never voted out, so writes to its row wait)
const deadOwned = () => ROWS.map((row) => ({ row, owner: page.owner(row) })).filter((x) => x.owner && page.down.has(x.owner)).sort((a, b) => killed.indexOf(b.owner) - killed.indexOf(a.owner))
// both sides of a split: cut off a row's owner (so c1's write must wait for a vote), never the last majority
function splitPlan() {
  const go = gadgetsOwner(), out = []
  for (const row of ['gizmos', 'widgets']) {
    const t = page.owner(row)
    if (!t || !page.alive(t) || page.isolated(t) || !leavesMajority(t)) continue
    out.push({ target: t, row, rank: (t === go ? 2 : 0) + (row === 'gizmos' ? 0 : 1) })   // keep the writer's row out of it when possible
  }
  return out.sort((a, b) => a.rank - b.rank)[0] ?? null
}
function splitWhyNot() {
  const owners = ['gizmos', 'widgets'].map((r) => page.owner(r)).filter((t) => t && page.alive(t) && !page.isolated(t))
  return owners.length ? 'cutting one off would leave no majority on either side' : 'no live server owns a row to split off'
}
const cutNodes = () => [...page.cuts].map((k) => k.split('|')).flat().filter((v, i, a) => a.indexOf(v) === i).filter((id) => !page.down.has(id) && !page.left.has(id))

// ── the chips ───────────────────────────────────────────────────────────────────────────────────────────
// Each: group · label · name · pick() (its target, fixed at the click) · enabled() · live() (a fault that stays
// on) · node { lines (what you type: sh = a shell command, js = a line of code, note = a comment), cite (the
// repo line the command comes from), say } · promise (one quote id) · did(c) · act(c) · step(c) (later
// actions, run from the frame loop, never from inside a cluster callback) · facts(c) · focus (journal kinds
// promoted from routine)
const CHIPS = [
  // ── network ──
  { id: 'cut', group: 'network', label: 'cut off', name: 'cut one server off',
    pick: sideTarget,
    enabled: () => (!page.isReady ? no('the cluster is still forming') : sideTarget() ? OK : no('no server left to cut off')),
    warn: () => { const t = sideTarget(); return t && !leavesMajority(t) ? 'with this few members up, neither side will be a majority' : '' },
    node: { say: 'a cable pulled out between machines. There is nothing to type: both ends just see their links drop.' },
    promise: 'minority',
    did: (c) => `The page cuts every link between ${nid(c.target)} and the rest. Nothing is destroyed.`,
    act: (c) => { c.before = page.view(); page.isolate(c.target) },
    done: (c) => !!c.vote || (!!c.noMajority && page.now - c.t0 > 3000), facts: cutFacts },
  { id: 'heal', group: 'network', label: 'heal', name: 'heal every cut',
    pick: cutNodes,
    enabled: () => (page.cuts.size ? OK : no('nothing is cut')),
    node: { say: 'the cable back in. There is nothing to type: each side keeps calling the other, so the links come back by themselves.' },
    promise: 'digests',
    did: (c) => `The page restores every cut link${c.target.length ? ` (${ids(c.target)})` : ''}.`,
    act: (c) => { c.before = page.view(); c.wasCut = [...page.cuts]; c.waitingBefore = page.writes.filter((w) => w.state === 'pending').map((w) => w.id); for (const k of c.wasCut) { const [a, b] = k.split('|'); page.heal(a, b) } },
    done: (c) => agreeNow() && page.now - c.t0 > 1500 && liveServers().every((id) => page.view().members.includes(id)), facts: healFacts, focus: ['aeShip', 'linkUp', 'identified'] },
  { id: 'slow', group: 'network', label: 'slow a link', name: 'slow a link', toggle: true,
    pick: () => (slowPairs()[0] ? [slowPairs()[0].a, slowPairs()[0].b] : c1Link()),
    live: () => slowPairs().length > 0,
    enabled: () => (slowPairs().length || c1Link() ? OK : no('c1 has no server link to slow')),
    node: { say: 'a slow network between two machines. The link still works, so no one suspects anything: every frame just takes longer.' },
    promise: 'silence',
    did: (c) => (c.off ? `The page puts the link between ${ids(c.target)} back to the cluster’s usual delay.` : `The page slows the link between ${ids(c.target)}, the path of c1’s writes.`),
    act: (c) => {
      c.off = slowPairs().length > 0
      c.beforeWrites = page.writes.filter((w) => w.state === 'committed' && w.node === 'c1' && !w.remove).slice(-4).map((w) => w.committedAt - w.issuedAt)
      if (c.off) for (const x of slowPairs()) page.fault(x.a, x.b, { ...x.f, delay: house() })
      else { const [a, b] = c.target; const f = linkFx.get(pair(a, b))?.f ?? {}; page.fault(a, b, { ...f, delay: SLOW }) }
    },
    done: (c) => committedSince(c) >= 3, facts: slowFacts },
  { id: 'dup', group: 'network', label: 'duplicate frames', name: 'duplicate frames', toggle: true,
    pick: () => (dupPairs()[0] ? [dupPairs()[0].a, dupPairs()[0].b] : c1Link()),
    live: () => dupPairs().length > 0,
    enabled: () => (dupPairs().length || c1Link() ? OK : no('c1 has no server link')),
    node: { say: 'the same frame delivered twice. In a real cluster a write comes twice when its first answer got lost, and a record comes twice when two paths deliver it.' },
    promise: 'harmless',
    did: (c) => (c.off ? `The page stops duplicating frames on the link between ${ids(c.target)}.` : `The page delivers about every second frame twice on the link between ${ids(c.target)}, the path of c1’s writes.`),
    act: (c) => {
      c.off = dupPairs().length > 0
      if (c.off) for (const x of dupPairs()) { const { dupP, ...rest } = x.f; page.fault(x.a, x.b, { ...rest, delay: rest.delay ?? house() }) }
      else { const [a, b] = c.target; const f = linkFx.get(pair(a, b))?.f ?? {}; page.fault(a, b, { delay: house(), ...f, dupP: DUP }) }
    },
    done: (c) => committedSince(c) >= 3, facts: dupFacts, focus: ['dupDrop', 'writeDup'] },
  // ── process ──
  { id: 'crash', group: 'process', label: 'crash', name: (c) => ((c.pressed ? c.target === c.ownerThen : (!page.view().epoch || processTarget() === gadgetsOwner())) ? 'crash the owner' : 'crash a server'),
    pick: processTarget,
    enabled: () => (!page.isReady ? no('the cluster is still forming') : liveServers().length >= 2 ? OK : no('one server is left')),
    node: { lines: [{ sh: 'kill -9 <pid>' }], cite: 'killcmd', say: 'a hard kill: no goodbye and no vote. The process just stops, and its disk keeps what it saved.' },
    promise: 'crash',
    did: (c) => `The page cuts ${nid(c.target)}${c.target === c.ownerThen ? ', the owner of gadgets,' : ''} from everyone at once, then destroys it. Its disk is kept, for a restart.`,
    act: (c) => { c.before = page.view(); page.kill(c.target) },
    done: (c) => !!c.vote && firstWriteAfter(c)?.state === 'committed', facts: crashFacts },
  { id: 'stop', group: 'process', label: 'clean stop', name: 'stop a server cleanly',
    pick: processTarget,
    enabled: () => (!page.isReady ? no('the cluster is still forming') : liveServers().length >= 2 ? OK : no('one server is left')),
    node: { cite: 'ctrlc', say: 'press <kbd>Ctrl-C</kbd> in the server’s terminal, or send it SIGTERM. The process asks to be voted out, waits for the vote, then exits.' },
    promise: 'stop',
    did: (c) => `The page asks ${nid(c.target)} to leave. The kernel sends LEAVE and the others vote. Once the kernel says it left, the page ends the process. A server that left does not come back on this page: <b>add a server</b> brings the count back.`,
    act: (c) => { c.before = page.view(); page.leave(c.target) },
    done: (c) => !!(c.seen.left ?? []).length && firstWriteAfter(c)?.state === 'committed', facts: stopFacts },
  { id: 'restart', group: 'process', label: 'restart from disk', name: 'restart from disk',
    pick: () => killed[killed.length - 1] ?? [...page.down][0] ?? null,
    enabled: () => (page.down.size ? OK : page.left.size ? no('a server that left cleanly does not come back on this page: add a server instead') : no('no server is down: crash one first')),
    node: { lines: [{ sh: 'node server.ts' }], cite: 'samecmd', say: 'the same command again, with the same dir. It is the same member, in its next life.' },
    promise: 'restart',
    did: (c) => `The page restarts ${nid(c.target)} from its disk: its boot record, then its log replayed, then its links.`,
    act: (c) => { c.before = page.view(); c.wasMember = page.view().members.includes(c.target); page.restart(c.target) },
    done: (c) => (c.wasMember || !!voteIn(c, c.target)) && agreeNow(), facts: restartFacts, focus: ['identified', 'linkUp', 'bootWrite'] },
  { id: 'add', group: 'process', label: 'add a server', name: 'add a server',
    pick: () => null,
    enabled: () => (!page.isReady ? no('the cluster is still forming') : page.serverIds.length < 5 ? OK : no('five servers is enough for this page')),
    node: { lines: () => [{ sh: addCmd() }], cite: 'addcmd', say: 'one more server process with its own dir. It asks a member to let it in, and the members vote.' },
    promise: 'vote',
    did: (c) => `The page starts ${nid(c.target)}: it dials the servers and sends JOIN.`,
    act: (c) => { addBefore(c); c.target = page.addServer() },
    done: (c) => !!c.target && !!voteIn(c, c.target) && agreeNow(), facts: addFacts, focus: ['identified'] },
  // ── disk ──
  { id: 'slowdisk', group: 'disk', label: 'slow fsync', name: 'slow a disk', toggle: true,
    pick: () => diskWith('delay')[0] ?? diskTarget(),
    live: () => diskWith('delay').length > 0,
    enabled: () => (diskWith('delay').length || diskTarget() ? OK : no('no server is up')),
    node: { say: 'a disk that takes long to finish a save (an fsync). Nothing fails: the save is just late.' },
    promise: 'ladder',
    did: (c) => (c.off ? `The page gives ${nid(c.target)} its fast disk back.` : `The page makes every save on ${nid(c.target)}’s disk slow.`),
    act: (c) => { c.off = diskWith('delay').length > 0; if (c.off) for (const id of diskWith('delay')) { const { delay, ...rest } = diskFx.get(id); page.storeFault(id, rest) } else page.storeFault(c.target, { ...(diskFx.get(c.target) ?? {}), delay: SLOW_DISK }) },
    step: probeNextWrite, done: (c) => (c.off ? committedSince(c) >= 1 : !!c.persisted), facts: slowDiskFacts, focus: ['persisted'] },
  { id: 'lie', group: 'disk', label: 'lying fsync', name: 'a disk that lies', toggle: true,
    pick: () => diskWith('lieP')[0] ?? diskTarget(),
    live: () => diskWith('lieP').length > 0,
    enabled: () => (diskWith('lieP').length || diskTarget() ? OK : no('no server is up')),
    node: { say: 'a disk, or its cache, that says a save is done when the bytes are not safe. You find out only after a crash.' },
    promise: 'liar',
    did: (c) => (c.off ? `The page gives ${nid(c.target)} an honest disk again.` : `The page makes about half of ${nid(c.target)}’s saves lie: they report done, but are gone after a crash. It does this to one server at a time: if most disks lied, a persisted write could be lost.`),
    act: (c) => { c.off = diskWith('lieP').length > 0; if (c.off) for (const id of diskWith('lieP')) { const { lieP, ...rest } = diskFx.get(id); page.storeFault(id, rest) } else { page.storeFault(c.target, { ...(diskFx.get(c.target) ?? {}), lieP: LIE }); c.wal0 = page.sim.stores.get(c.target)?.wal.length ?? 0 } },
    next: (c) => (!c.off && !c.restarted && page.alive(c.target) ? { label: `crash and restart ${c.target} ▸`, run: () => {
      c.restartAt = page.now
      c.walRows = page.sim.stores.get(c.target)?.wal.slice(c.wal0 ?? 0) ?? []
      c.lied = c.walRows.filter((r) => r.lied).length
      c.torn = c.walRows.filter((r) => !r.resolved && !r.lied).length   // still being saved at the crash: a torn tail, not a lie
      page.kill(c.target); page.restart(c.target); c.restarted = true
    } } : null),
    done: (c) => (c.off ? committedSince(c) >= 1 : c.restarted && agreeNow() && page.now - c.restartAt > 2000), facts: lieFacts, focus: ['bootWrite', 'aeShip'] },
  { id: 'faildisk', group: 'disk', label: 'failed fsync', name: 'a disk that fails', toggle: true,
    pick: () => diskWith('failP')[0] ?? diskTarget(),
    live: () => diskWith('failP').length > 0,
    enabled: () => (diskWith('failP').length || diskTarget() ? OK : no('no server is up')),
    node: { say: 'a disk that reports a failed save (an I/O error).' },
    promise: 'deadwal',
    did: (c) => (c.off ? `The page gives ${nid(c.target)} a working disk again. In this life its log stays dead; a restart opens it again.` : `The page makes every save on ${nid(c.target)}’s disk fail.`),
    act: (c) => { c.off = diskWith('failP').length > 0; if (c.off) for (const id of diskWith('failP')) { const { failP, ...rest } = diskFx.get(id); page.storeFault(id, rest) } else page.storeFault(c.target, { ...(diskFx.get(c.target) ?? {}), failP: 1 }) },
    step: probeNextWrite, done: (c) => (c.off ? committedSince(c) >= 1 : !!c.persisted), facts: failDiskFacts },
  { id: 'plugs', group: 'disk', label: 'pull every plug', name: 'pull every plug',
    pick: () => liveServers(),
    enabled: () => (!page.isReady ? no('the cluster is still forming') : liveServers().length ? OK : no('no server is up')),
    node: { lines: [{ note: '# on every server, at once' }, { sh: 'kill -9 <pid>' }, { sh: 'node server.ts' }], cite: 'killcmd', say: 'every server dies at the same moment, then each starts again from its own dir.' },
    promise: 'plugs',
    did: (c) => `The page asks the kernel whether the latest record of each row is on a majority of disks. Then it crashes ${ids(c.target)} and restarts them, all at one simulated instant.`,
    act: plugsAct, step: plugsStep, done: (c) => c.phase === 'done' && !!c.firstNew, facts: plugsFacts, focus: ['bootWrite', 'confirmed'] },
  // ── writes ──
  { id: 'deadrow', group: 'writes', label: 'write to a dead owner', name: 'write to a dead owner’s row',
    pick: () => deadOwned()[0]?.owner ?? null,
    enabled: () => (!page.alive('c1') ? no('c1 is down') : deadOwned().length ? OK : page.down.size ? no('the server that is down owns no row now') : no('no server is down: crash one first')),
    node: { lines: (c) => [{ note: '// on c1' }, { js: `shop.data.${c.row ?? 'gadgets'} = ${c.value ? short(c.value) : '{ stock: … }'}` }], say: 'a plain assignment on a client while the server that owns the row is dead.' },
    promise: 'owner',
    did: (c) => `The page posts the record that <code>shop.data.${esc(c.row)} = ${esc(short(c.value))}</code> becomes, on c1. The row’s owner in view ${T(c.epochThen)} is ${nid(c.ownerThen)}, which is ${page.alive(c.ownerThen) ? 'up again' : 'down'}.`,
    act: (c) => {
      const d = deadOwned().find((x) => x.owner === c.target) ?? deadOwned()[0]
      c.row = d.row; c.ownerThen = d.owner; c.originThen = page.origin(d.owner); c.epochThen = page.view().epoch
      c.value = nextStock(c.row)
      c.w = page.write('c1', c.row, c.value)
    },
    done: (c) => c.w?.state === 'committed', facts: deadRowFacts },
  { id: 'split', group: 'writes', label: 'write on both sides', name: 'write on both sides',
    pick: () => splitPlan()?.target ?? null,
    enabled: () => (!page.isReady ? no('the cluster is still forming') : !page.alive('c1') ? no('c1 is down') : splitPlan() ? OK : no(splitWhyNot())),
    node: { lines: (c) => [{ note: `// on ${c.target ?? 'the cut-off server'}` }, { js: `shop.data.${c.row ?? 'gizmos'} = ${c.vMin ? short(c.vMin) : '{ stock: … }'}` }, { note: '// on c1' }, { js: `shop.data.${c.row ?? 'gizmos'} = ${c.vMaj ? short(c.vMaj) : '{ stock: … }'}` }], say: 'two assignments to the same row, one on each side of a cut.' },
    promise: 'lww',
    did: (c) => `The page cuts ${nid(c.target)}, the owner of ${esc(c.row)}, off from the rest. Then it writes ${esc(c.row)} on each side: on ${nid(c.target)}, and on c1. After the vote, once c1’s write has landed, the page heals the cut.`,
    act: (c) => {
      const p = splitPlan(); c.target = p.target; c.row = p.row
      c.before = page.view(); c.phase = 'cut'
      c.pairs = page.ids().filter((o) => o !== c.target && !page.cuts.has(pair(c.target, o))).map((o) => pair(c.target, o))
      page.isolate(c.target)
      HEALS.push({ c, pairs: c.pairs, at: page.now, done: false })   // a promise: the page heals what it cut, whatever happens next
    },
    step: splitStep, done: (c) => c.phase === 'done', facts: splitFacts, focus: ['lwwSkip'] },
  { id: 'remove', group: 'writes', label: (s) => (s.gone ? 'put it back' : 'remove a row'), name: (c) => (c.putBack ? 'put the row back' : 'remove a row'),
    pick: () => 'c1',
    enabled: () => (!page.isReady ? no('the cluster is still forming') : !page.alive('c1') ? no('c1 is down') : OK),
    node: { lines: (c) => [{ note: '// on c1' }, { js: c.putBack ? `shop.data.${c.row} = ${short(c.value)}` : 'delete shop.data.gizmos' }],
      cite: (c) => (c.putBack ? null : 'removerec'),
      say: (c) => (c.putBack ? 'an assignment: the whole row comes back as one update record, with a bigger stamp than the remove.' : 'deleting a key. The record it becomes has a type and a key, and no value.') },
    promise: 'tombstone',
    did: (c) => (c.putBack ? `The page writes ${esc(c.row)} back on c1 as one whole row.` : `The page posts the record that <code>delete shop.data.${esc(c.row)}</code> becomes, on c1.`),
    act: (c) => {
      c.row = 'gizmos'
      c.putBack = cell('c1', c.row) === undefined
      if (c.putBack) { c.value = REMOVED.get(c.row) ?? page.opts.data?.[c.row] ?? { stock: 1 }; c.w = page.write('c1', c.row, c.value) }
      else { REMOVED.set(c.row, cell('c1', c.row)); c.w = page.remove('c1', c.row) }
    },
    done: (c) => !!c.applied && page.ids().filter((id) => page.alive(id)).every((id) => (cell(id, c.row) === undefined) !== !!c.putBack), facts: removeFacts, focus: ['tombstoneGC'] },
]
const REMOVED = new Map()   // the row value a remove took away, so "put it back" restores it for every figure
const HEALS = []            // cuts the split chip made: healed when its story is done with them, or the moment it is not
const agreeNow = () => { const k = page.copies(); return k.agree === k.of }
const committedSince = (c) => page.writes.filter((w) => w.issuedAt >= c.t0 && w.node === 'c1' && w.state === 'committed').length
const short = (v) => JSON.stringify(v).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ').replace(/^\{/, '{ ').replace(/\}$/, ' }')
const BY = Object.fromEntries(CHIPS.map((c) => [c.id, c]))
function addBefore(c) { c.before = page.view(); c.rowsBefore = Object.keys(page.alive('c1') ? page.object('c1') : {}); c.ownersBefore = Object.fromEntries(c.rowsBefore.map((r) => [r, page.owner(r)])) }

// ── the story since the click ──────────────────────────────────────────────────────────────────────────
let cur = null            // { chip, pressed, t0, ev0, viol0, story, seen, target, external, … }
let pressing = 0          // > 0 while this section itself acts: those events are this story's, not someone else's
const own = (fn) => { pressing++; try { return fn() } finally { pressing-- } }
function fresh(chip, target) {
  return { chip, pressed: true, t0: page.now, ev0: page.events, viol0: page.sim.violations.length, story: new Story(page.now, chip.focus ?? []), seen: {}, logs: [], target: target === undefined ? chip.pick() : target, ownerThen: gadgetsOwner(), follow: false, fr: { n: 0, twice: 0, min: Infinity, max: 0, last: null } }
}
const SEEN = new Set(['viewInstall', 'linkUp', 'replayed', 'aeShip', 'persist', 'persisted', 'persistFail', 'walHole', 'walTaint', 'lwwSkip', 'dupDrop', 'writeDup', 'suspect', 'gateClose', 'gateOpen', 'identified', 'join', 'left', 'confirmed', 'evict'])
page.on('journal', (e) => {
  const c = cur; if (!c?.pressed || e.at < c.t0 || e.at > storyEnd(c)) return
  const x = annotate(page, e)   // now, inside the kernel's emit: the link and the gate are still as the row saw them
  c.story.add(x)
  if (SEEN.has(e.name)) { const l = (c.seen[e.name] ??= []); if (l.length < 400) l.push(x) }
  dirty = true
})
const PAGE_KINDS = new Set(['kill', 'restart', 'leave', 'left', 'join', 'cut', 'heal', 'fault', 'disk'])
page.on('log', (e) => { const c = cur; if (c?.pressed && e.at >= c.t0 && e.at <= storyEnd(c) && PAGE_KINDS.has(e.kind)) { c.logs.push(e); dirty = true } })
const storyEnd = (c) => Math.min(c.t0 + WINDOW, c.endAt ?? Infinity)
page.on('apply', (a) => { const c = cur; if (c?.pressed && c.chip.onApply && a.at >= c.t0) c.chip.onApply(c, a) })
page.on('commit', () => { dirty = true })
page.on('frame', (f) => {
  const c = cur; if (!c?.pressed || (c.chip.id !== 'slow' && c.chip.id !== 'dup') || !Array.isArray(c.target) || f.sentAt < c.t0) return
  const [a, b] = c.target; if (!((f.from === a && f.to === b) || (f.from === b && f.to === a))) return
  const fr = c.fr, d = f.recvAt - f.sentAt
  fr.n++; fr.min = Math.min(fr.min, d); fr.max = Math.max(fr.max, d)
  if (fr.last && fr.last.bytes === f.bytes && fr.last.to === f.to) fr.twice++   // the simulator delivers a duplicate inside the same send
  fr.last = f
})
page.on('reset', () => { linkFx.clear(); diskFx.clear(); killed.length = 0; REMOVED.clear(); HEALS.length = 0; allBroken.i = 0; allBroken.map.clear(); cur = { chip: BY.crash, pressed: false }; if (OWN?.seed !== page.seed) { OWN = null; askOwn(); paintB() } lastPanelKey = ''; dirty = true; paintChips(true) })
page.on('view', () => { dirty = true })

// a fault from anywhere else on the page (the dock, the centrepiece, another section, the console) starts the
// story of the matching chip, so this panel narrates it too. Only state changes here: no cluster action is
// ever taken inside a cluster callback.
page.on('kill', (id) => { const i = killed.indexOf(id); if (i >= 0) killed.splice(i, 1); killed.push(id); if (!pressing && isServer(id)) external('crash', id); dirty = true })
page.on('restart', (id) => { const i = killed.indexOf(id); if (i >= 0) killed.splice(i, 1); if (!pressing && isServer(id)) external('restart', id); dirty = true })
page.on('leave', (id) => { if (!pressing && isServer(id)) external('stop', id); dirty = true })
page.on('left', () => { dirty = true })
page.on('join', (id) => { if (!pressing && isServer(id)) external('add', id); dirty = true })
page.on('cut', ([a, b]) => { if (!pressing) externalCut(a, b); dirty = true })
page.on('heal', ([a, b]) => { if (!pressing) externalHeal(a, b); dirty = true })
const sameBurst = (chip) => cur?.external && cur.chip === chip && cur.t0 === page.now
function external(id, target) {
  const chip = BY[id]
  if (sameBurst(chip)) return cur   // one action, several events at one instant: one story
  const c = fresh(chip, target)
  c.external = true
  c.logs = page.log.filter((e) => e.at === page.now && PAGE_KINDS.has(e.kind))   // core.js notes an action just before it emits it
  c.before = page.view()   // a crash: the survivors' view still lists the dead server until they vote
  if (id === 'restart') c.wasMember = page.view().members.includes(target)
  if (id === 'add') addBefore(c)
  cur = c; lastPanelKey = ''; dirty = true
  return c
}
function externalCut(a, b) {
  let c = cur
  if (!sameBurst(BY.cut)) { c = external('cut', a); c.pairs = [] }
  c.pairs.push([a, b])
  const common = c.pairs.reduce((s, p) => s.filter((x) => p.includes(x)), [a, b])
  c.target = common.find(isServer) ?? common[0] ?? a
}
function externalHeal(a, b) {
  let c = cur
  if (!sameBurst(BY.heal)) { c = external('heal', []); c.wasCut = []; c.waitingBefore = page.writes.filter((w) => w.state === 'pending').map((w) => w.id) }
  c.wasCut.push(pair(a, b))
  c.target = [...new Set([...c.target, a, b])].filter((x) => !page.down.has(x) && !page.left.has(x))
}
const EXT = {
  crash: (c) => `The dock or another figure crashed ${nid(c.target)} (like kill -9). This panel follows what the kernel does about it.`,
  restart: (c) => `The dock or another figure restarted ${nid(c.target)} from its disk. This panel follows what the kernel does about it.`,
  stop: (c) => `Something outside this panel asked ${nid(c.target)} to leave. This panel follows the vote.`,
  add: (c) => `Something outside this panel started ${nid(c.target)}. This panel follows its vote.`,
  cut: (c) => (c.pairs?.length === 1 ? `The dock or another figure cut the link between ${ids(c.pairs[0])}.` : `The dock or another figure cut ${nid(c.target)} off from the rest.`) + ' This panel follows what the kernel does about it.',
  heal: (c) => `The dock or another figure restored the cut links${c.target.length ? ` (${ids(c.target)})` : ''}. This panel follows the catch-up.`,
}

const vote = (c, excl) => (c.seen.viewInstall ?? []).find((v) => !v.members.includes(excl) && v.a > (c.before?.epoch ?? 0))
const voteIn = (c, who_) => (c.seen.viewInstall ?? []).find((v) => v.members.includes(who_) && v.a > (c.before?.epoch ?? 0))

function press(chip) {
  const chk = chip.enabled(); if (!chk.ok) return
  const c = fresh(chip)
  cur = c   // first: the page's own log line for this action must land in this story
  own(() => { try { chip.act(c) } catch (err) { c.error = String(err?.message ?? err) } })
  lastPanelKey = ''
  dirty = true
  paintChips(true)
  paintPanel(true)
}

// ── rules: which broke, and where first (a rule that breaks fails again at every later event, so the count
// of failing events says little; the rule's name and its first event say it all) ────────────────────────
const allBroken = { i: 0, map: new Map() }
function brokenSince(c) {
  const vs = page.sim.violations
  const b = c.pressed ? (c.bk ??= { i: c.viol0, map: new Map() }) : allBroken
  const end = c.pressed && c.violEnd != null ? c.violEnd : vs.length
  for (; b.i < end; b.i++) { const v = vs[b.i]; if (v && !b.map.has(v.monitor)) b.map.set(v.monitor, v) }
  return b.map
}
// "attempt c1~1|1 committed TWICE: n02|4|1 and n01|4|2 (seen at n01)" (sim/monitors.ts) → the two stamps
function twoStamps(v) {
  const m = /TWICE: (\S+?)\|(\d+)\|(\d+) and (\S+?)\|(\d+)\|(\d+)/.exec(v.detail ?? '')
  return m ? `${stamp({ origin: m[1], seq: +m[2], epoch: +m[3] })} and ${stamp({ origin: m[4], seq: +m[5], epoch: +m[6] })}` : esc(v.detail ?? '')
}
const ruleDetail = (v) => (v.monitor === 'attempt-exactly-once' ? `one write attempt got two stamps: ${twoStamps(v)}` : esc(String(v.detail ?? '').slice(0, 140)))

// ── chip facts: the numbers for each fault, all read from the kernel since the click ────────────────────
// a fact row: { k, v (html), cls, bar (0..1), note (html), wide, say, quote }
const F = (k, v, o = {}) => ({ k, v, ...o })
function ownNote(r) {
  if (!r) return 'own run · running…'
  if (r.failed) return `own run · it could not run here${r.why ? `: ${esc(r.why)}` : ''}`
  const b = r.broken ?? []
  return `own run · <span class="nw">seed ${T(String(r.seed))}</span>${b.length ? ` · <span class="broken">${T(b.length)} ${many(b.length, 'rule')} broke in this run: ${esc(b.map((x) => x.monitor).join(', '))}</span>` : ''}`
}
function writeFact(label, w, extra = '') {
  if (!w) return F(label, esc('the next write…'), { cls: 'pend' })
  if (w.state === 'committed') return F(label, `waited ${T(vt(w.committedAt - w.issuedAt))}`, { note: `${w.remove ? 'removed' : 'committed'} · ${stamp(w.stamp)}${extra}` })
  return F(label, `waiting ${T(vt(page.now - w.issuedAt))}`, { cls: 'waiting', note: `a pending row of ${nid(w.node)}’s <code>cluster.writes</code>: it shows nowhere until it commits${extra}` })
}
function voteRows(c, mode) {
  // the vote that matters for this chip, live, against the own runs: crash · crash at fero's defaults · clean stop
  const own_ = OWN, rows = []
  const live = c.pressed && c.vote ? c.vote.at - c.t0 : null
  const oc = own_?.crash?.vote ? own_.crash.vote.at - own_.crash.t0 : null
  const os = own_?.stop?.vote ? own_.stop.vote.at - own_.stop.t0 : null
  const od = own_?.defaults?.voteMs ?? null
  const max = Math.max(1, ...[live, oc, os, od].filter((x) => x != null))
  const bar = (ms) => (ms == null ? null : ms / max)
  const hb = FACTS?.consts?.heartbeatMs, rd = FACTS?.consts?.redialMs
  const ownRow = (label, r, ms) => F(label, ms == null ? esc(r?.failed ? 'could not run' : '…') : T(vt(ms)), { cls: ms == null ? 'pend' : '', bar: bar(ms), note: ownNote(r) })
  if (mode === 'crash' && c.pressed) rows.push(c.vote ? F('crash → vote', T(vt(live)), { bar: bar(live), note: `this cluster · view ${T(c.vote.a)} without ${nid(c.target)}` }) : F('crash → vote', c.noMajority ? esc('no vote can pass') : `waiting ${T(vt(page.now - c.t0))}`, { cls: c.noMajority ? 'bad' : 'waiting', note: c.noMajority ? 'the members left are not a majority of the view' : 'the survivors keep redialing before they vote' }))
  else rows.push(ownRow('crash → vote', own_?.crash, oc))
  { const r = own_?.defaults; rows.push(F('crash → vote at fero’s defaults', od == null ? esc(r?.failed ? 'could not run' : '…') : T(vt(od)), { cls: od == null ? 'pend' : '', bar: bar(od), note: `${ownNote(r)} · <span class="nw">heartbeat ${hb ? T(hb, 'build') : '…'} ms</span> · <span class="nw">redial ${rd ? T(rd, 'build') : '…'} ms</span>` })) }
  if (mode === 'stop' && c.pressed) rows.push(c.vote ? F('clean stop → vote', T(vt(live)), { bar: bar(live), note: `this cluster · view ${T(c.vote.a)} without ${nid(c.target)}` }) : F('clean stop → vote', `waiting ${T(vt(page.now - c.t0))}`, { cls: 'waiting', note: 'the leaver asks; the others vote' }))
  else rows.push(ownRow('clean stop → vote', own_?.stop, os))
  return rows
}
function crashFacts(c) {
  const rows = []
  if (c.pressed) {
    c.vote ??= vote(c, c.target)
    const m = c.before?.members.length ?? 0
    const left = (c.before?.members ?? []).filter((x) => x !== c.target && page.alive(x))
    c.noMajority = !c.vote && m > 0 && left.length * 2 <= m
    if (c.noMajority) rows.push(F(m === 2 ? twoMembers('The write waits until the dead one comes back.') : `${esc(list(left))} ${left.length === 1 ? 'is' : 'are'} not a majority of ${T(m)} members. The write waits until the dead one comes back.`, '', { say: true, wide: true }))
  }
  rows.push(...voteRows(c, 'crash'))
  if (c.pressed) rows.push(writeFact('c1’s next write', firstWriteAfter(c)))
  else { const r = OWN?.crash; rows.push(F('c1’s write', r?.write?.committedAt ? `waited ${T(vt(r.write.committedAt - r.write.issuedAt))}` : esc('…'), { cls: r?.write ? '' : 'pend', note: r?.write ? `${ownNote(r)} · ${stamp(r.write.stamp)}` : ownNote(r) })) }
  return rows
}
function stopFacts(c) {
  const rows = []
  if (c.pressed) c.vote ??= vote(c, c.target)
  rows.push(...voteRows(c, 'stop'))
  if (c.pressed) {
    const l = (c.seen.left ?? [])[0]
    rows.push(F('the kernel says it left', l ? (l.b ? '<span class="agree-ok">clean ✓</span>' : esc('without its vote')) : esc('…'), { cls: l ? (l.b ? 'ok' : 'bad') : 'pend', note: l ? `${T(plus(l.at - c.t0))} after the click` : '' }))
    rows.push(writeFact('c1’s next write', firstWriteAfter(c)))
    const twice = brokenSince(c).get('attempt-exactly-once')
    if (twice) {
      rows.push(F(`<span class="broken">A write got two stamps</span>: ${twoStamps(twice)}. The rule attempt-exactly-once caught it at event ${T(twice.event)}.`, '', { say: true, wide: true }))
      const q = quoteRow('residual', 'The kernel’s own notes name this gap: '); if (q) rows.push(q)
    }
  }
  return rows
}
function restartFacts(c) {
  const rows = [], t = c.target
  rows.push(F('its life now', page.alive(t) ? `life ${T(page.life(t))} · ${T(page.origin(t))}` : esc('…'), { note: 'a restart is the same member in its next life' }))
  const rp = (c.seen.replayed ?? []).filter((e) => e.node === t), lu = (c.seen.linkUp ?? []).find((e) => e.node === t)
  const n = rp.reduce((s, e) => s + (e.a || 0), 0)
  rows.push(F('records read back from its disk', rp.length ? T(n) : esc('…'), { cls: rp.length ? '' : 'pend', note: rp.length ? `at ${T(plus(rp[0].at - c.t0))}${lu ? `, before its first link at ${T(plus(lu.at - c.t0))}` : ''}` : '' }))
  const vi = voteIn(c, t)
  if (c.wasMember) rows.push(F('the view', T(`view ${page.view().epoch}`), { note: `${nid(t)} was never voted out, so no ballot is needed to take it back` }))
  else rows.push(F('voted back in', vi ? T(vt(vi.at - c.t0)) : esc('…'), { cls: vi ? '' : 'pend', note: vi ? `view ${T(vi.a)} · ${ids(vi.members)}` : 'it asks to join; the members vote' }))
  rows.push(copiesFact(c))
  return rows
}
// the copies: live nodes whose fingerprint matches the most common one; a copy that differs because its node is
// cut off cannot catch up until a heal, so it says so instead of "catching up"
function copiesState() {
  const live = page.ids().filter((id) => page.alive(id)), n = new Map()
  for (const id of live) { const h = page.hash(id); n.set(h, (n.get(h) ?? 0) + 1) }
  let top = null, max = 0; for (const [h, k] of n) if (k > max) { max = k; top = h }
  const off = live.filter((id) => page.hash(id) !== top)
  return { agree: max, of: live.length, off, cut: off.filter((id) => page.isolated(id)) }
}
const cutWords = (xs) => `${esc(list(xs))} ${xs.length > 1 ? 'are cut off and serve their' : 'is cut off and serves its'} old copy`
function copiesFact(c) {
  const k = copiesState()
  if (k.agree === k.of) { c.agreedAt ??= page.now; return F('copies', `<span class="agree-ok">${T(k.agree)} of ${T(k.of)} agree ✓</span>`, { note: c.pressed ? `since ${T(plus(c.agreedAt - c.t0))}` : '' }) }
  c.agreedAt = null
  return F('copies', `${T(k.agree)} of ${T(k.of)} agree`, { cls: 'waiting', note: k.cut.length ? cutWords(k.cut) : 'catching up' })
}
function addFacts(c) {
  const rows = [], t = c.target
  if (!t) return rows
  const vi = voteIn(c, t)
  rows.push(F('voted in', vi ? T(vt(vi.at - c.t0)) : esc('…'), { cls: vi ? '' : 'pend', note: vi ? `view ${T(vi.a)} · ${ids(vi.members)}` : `${nid(t)} sent JOIN; the members vote` }))
  if (vi) {
    const changed = (c.rowsBefore ?? []).filter((r) => page.owner(r) !== c.ownersBefore[r])
    rows.push(F('rows that changed owner', `${T(changed.length)} of ${T(c.rowsBefore.length)}`, { note: changed.length ? `${changed.map(esc).join(', ')} moved: a row moves only if its place on the ring now falls to ${nid(t)}` : `a row moves only if its place on the ring now falls to ${nid(t)}` }))
    const m = vi.members.length, maj = Math.floor(m / 2) + 1
    rows.push(F('a majority now', `${T(maj)} of ${T(m)}`, { note: 'a vote or a write needs this many members' }))
    const q = FACTS?.quotes?.addcmd, said = q?.text.split('#')[1]?.trim()
    if (m === 4 && said) rows.push(F(`<p>The same step on real processes, in examples/13: ${esc(said)}</p>${cite(q)}`, '', { quote: true, wide: true }))
  }
  return rows
}
function copyOn(t, row = 'gadgets') {
  const other = page.ids().find((id) => id !== t && page.alive(id) && !page.isolated(id) && isServer(id))
  if (!other || !page.alive(t)) return null
  const a = cell(t, row), b = cell(other, row), sa = page.stamp(t, row), sb = page.stamp(other, row)
  const same = sa && sb && sa.epoch === sb.epoch && sa.seq === sb.seq && sa.origin === sb.origin
  return F(`${row} on ${t}`, `<span class="rec">${inspect(a)}</span>`, { wide: true, note: same ? `the same as ${nid(other)}: ${stamp(sa)}` : `its old copy, ${stamp(sa)} · ${nid(other)} holds ${inspect(b)}, ${stamp(sb)}` })
}
function cutFacts(c) {
  const rows = [], t = c.target
  if (!t) return rows
  if (!isServer(t)) {   // a client cut off: no gate to show (a client's cluster.writable is wrong today), only its writes and its copy
    rows.push(writeFact(`${t}’s next write`, firstWriteAfter(c, t)))
    rows.push(copyOn(t))
    return rows
  }
  const g = page.alive(t) ? page.writable(t) : null
  rows.push(F(`${t}’s write gate`, g ? esc(g.open ? 'open' : 'closed') : esc('…'), { cls: g && !g.open ? 'bad' : '', note: g && !g.open ? `${esc(GATE_WORDS[g.reason] ?? g.reason ?? '')}: it takes no writes, but still serves reads` : 'it still reaches a majority' }))
  c.vote ??= vote(c, t)
  const m = c.before?.members.length ?? 0
  const others = (c.before?.members ?? []).filter((x) => x !== t && page.alive(x))
  c.noMajority = !c.vote && m > 0 && (c.before?.members ?? []).includes(t) && others.length * 2 <= m
  if (c.noMajority) {
    rows.push(F(`No vote can pass: ${esc(list(others))} ${others.length === 1 ? 'alone is' : 'are'} not a majority of the ${T(m)} members of view ${T(c.before.epoch)}. Neither side takes writes until the cut heals.`, '', { say: true, wide: true }))
    for (const o of others) { const go = page.writable(o); rows.push(F(`${o}’s write gate`, esc(go?.open ? 'open' : 'closed'), { cls: go && !go.open ? 'bad' : '', note: go && !go.open ? esc(GATE_WORDS[go.reason] ?? go.reason ?? '') : 'it closes once its links drop' })) }
  } else rows.push(F('voted out', c.vote ? T(vt(c.vote.at - c.t0)) : (page.isolated(t) ? `waiting ${T(vt(page.now - c.t0))}` : esc('no')), { cls: c.vote ? '' : 'waiting', note: c.vote ? `view ${T(c.vote.a)} · ${ids(c.vote.members)}` : 'the others vote once their redials give up' }))
  rows.push(copyOn(t))
  return rows
}
function healFacts(c) {
  const rows = []
  const lu = c.seen.identified ?? []
  rows.push(F('links back', lu.length ? T(new Set(lu.map((e) => pair(e.node, e.b))).size) : esc('…'), { cls: lu.length ? '' : 'pend', note: lu.length ? `the first at ${T(plus(lu[0].at - c.t0))}` : '' }))
  const ae = c.seen.aeShip ?? []
  rows.push(F('records resent', T(ae.reduce((s, e) => s + (e.b || 0), 0)), { note: 'each side sends a digest; the other sends only what is missing' }))
  const went = page.writes.filter((w) => c.waitingBefore?.includes(w.id) && w.state === 'committed')
  if (c.waitingBefore?.length) rows.push(F('waiting writes that went out', `${T(went.length)} of ${T(c.waitingBefore.length)}`))
  rows.push(copiesFact(c))
  const back = (c.seen.viewInstall ?? []).filter((v) => v.a > (c.before?.epoch ?? 0) && v.members.length > (c.before?.members.length ?? 0))[0]
  if (back) rows.push(F('voted back in', T(vt(back.at - c.t0)), { note: `view ${T(back.a)} · ${ids(back.members)}` }))
  return rows
}
function slowFacts(c) {
  const rows = []
  if (!c.target) return rows
  const fr = c.fr
  if (fr.n) rows.push(F('frames on the link take', `${T(Math.round(fr.min))}–${T(Math.round(fr.max))} ms`, { note: `${T(fr.n)} ${many(fr.n, 'frame')} since the click, from their send and arrival times` }))
  else rows.push(F('frames on the link take', esc('…'), { cls: 'pend' }))
  const before = c.beforeWrites ?? []
  const after = page.writes.filter((w) => w.issuedAt >= c.t0 && w.node === 'c1' && w.state === 'committed' && !w.remove).map((w) => w.committedAt - w.issuedAt)
  const avg = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length)
  if (before.length) rows.push(F('c1’s writes, before the click', `took ${T(vt(avg(before)))}`, { note: `the last ${T(before.length)}, on average` }))
  rows.push(F('c1’s writes, since the click', after.length ? `took ${T(vt(avg(after)))}` : esc('…'), { cls: after.length ? '' : 'pend', note: after.length ? `${T(after.length)} so far, on average` : 'the next write is on its way' }))
  const sus = (c.seen.suspect ?? []).filter((e) => c.target.includes(e.a))
  rows.push(F('suspects', sus.length ? T(sus.length) : '<span class="agree-ok">none ✓</span>', { cls: sus.length ? 'bad' : 'ok', note: 'a slow link is still a working link' }))
  return rows
}
function dupFacts(c) {
  const rows = []
  if (!c.target) return rows
  rows.push(F('frames delivered twice', T(c.fr.twice), { note: `of ${T(c.fr.n)} ${many(c.fr.n, 'delivery', 'deliveries')} on the link between ${ids(c.target)} since the click` }))
  rows.push(F('repeated records dropped', T((c.seen.dupDrop ?? []).length), { note: 'dupDrop: already held, so ignored' }))
  rows.push(F('write attempts that came twice', T((c.seen.writeDup ?? []).length), { note: 'writeDup: the owner applies the first and answers the second with the same stamp' }))
  const ws = page.writes.filter((w) => w.issuedAt >= c.t0)
  const twice = brokenSince(c).get('attempt-exactly-once')
  rows.push(F('writes stamped twice', twice ? '<span class="broken">one ✕</span>' : '<span class="agree-ok">none ✓</span>', { cls: twice ? 'bad' : 'ok', note: twice ? `${twoStamps(twice)} · the rule attempt-exactly-once caught it at event ${T(twice.event)}` : `of ${T(ws.length)} ${many(ws.length, 'write')} since the click · the rule attempt-exactly-once checks it after every event` }))
  return rows
}
function probeNextWrite(c) {
  // the disk chips ask the kernel's confirm ladder about c1's first write after the click: persisted?
  if (c.off || c.probed) return
  const w = firstWriteAfter(c)
  if (!w || w.state !== 'committed' || !w.stamp) return
  const on = bare(w.stamp.origin)
  if (!page.alive(on)) return
  c.probed = { w, at: page.now }
  probe(on, w.stamp.origin, w.stamp.seq, CONFIRM.persisted).then((r) => { c.persisted = r; dirty = true })
}
function savesOn(c, id) {
  const ps = (c.seen.persist ?? []).filter((e) => e.node === id), done = (c.seen.persisted ?? []).filter((e) => e.node === id)
  const out = []
  for (const d of done) { const p = ps.find((e) => e.a === d.a); if (p) out.push(d.at - p.at) }
  return out
}
const mid = (xs) => { const s = xs.slice().sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]) }
const midNote = (n) => (n === 1 ? 'its one save since the click' : `the middle of its ${n} saves since the click`)
function slowDiskFacts(c) {
  const rows = [], t = c.target
  const mine = savesOn(c, t), others = liveServers().filter((id) => id !== t).flatMap((id) => savesOn(c, id))
  rows.push(F(`a save on ${t}`, mine.length ? T(vt(mid(mine))) : esc('…'), { cls: mine.length ? '' : 'pend', note: mine.length ? esc(midNote(mine.length)).replace(/\d+/, (d) => T(+d)) : 'the next write makes a save' }))
  rows.push(F('a save on the others', others.length ? T(vt(mid(others))) : esc('…'), { cls: others.length ? '' : 'pend', note: others.length ? (others.length === 1 ? 'their one save since the click' : `the middle of their ${T(others.length)} saves since the click`) : '' }))
  rows.push(writeFact('c1’s next write', firstWriteAfter(c), ' · committing does not wait for a disk'))
  const pf = persistedFact(c); if (pf) rows.push(pf)
  return rows
}
function persistedFact(c) {
  if (c.off) return null
  const r = c.persisted
  if (!r) return F('persisted', esc(c.probed ? 'asking the kernel…' : 'after the next write'), { cls: 'pend' })
  const m = page.view().members.length
  return F('persisted', r.ok ? `${T(r.count)} of ${T(m)} disks` : esc('not yet'), { cls: r.ok ? 'ok' : 'waiting', note: `the kernel’s answer, ${T(vt(r.at - c.probed.w.committedAt))} after the commit: ${r.ok ? 'a majority holds it on disk' : 'no majority holds it on disk yet'}` })
}
function lieFacts(c) {
  const rows = [], t = c.target
  if (c.off) return [F('lying saves', esc('off'))]
  const st = page.sim.stores.get(t)
  const walRows = c.restarted ? c.walRows : (st?.wal.slice(c.wal0 ?? 0) ?? [])
  const lied = c.restarted ? c.lied : walRows.filter((r) => r.lied).length
  rows.push(F('saves that lied', `${T(lied)} of ${T(walRows.length)}`, { cls: lied ? 'bad' : '', note: c.restarted ? 'the simulator’s own record, up to the crash' : 'the simulator’s own record: the kernel cannot see it yet' }))
  if (!c.restarted) { rows.push(F('what the kernel sees', esc('every save done'), { wide: true, note: 'a lie shows only after a crash: press the button under the promise' })); return rows }
  const rp = (c.seen.replayed ?? []).filter((e) => e.node === t && e.at >= c.restartAt)
  rows.push(F('records read back', T(rp.reduce((s, e) => s + (e.a || 0), 0)), { note: `from ${nid(t)}’s disk at the restart` }))
  // what the kernel can know: an interior hole proves a lie (walHole → walTaint); a lost tail looks exactly like
  // saves never made (kernel/node.ts: "loss is always TAIL loss"), so the others' digests heal it without a word
  const hole = (c.seen.walHole ?? []).find((e) => e.node === t && e.at >= c.restartAt), taint = (c.seen.walTaint ?? []).find((e) => e.node === t && e.at >= c.restartAt)
  const lost = lied + (c.torn ?? 0)
  if (hole) rows.push(F('the kernel', '<span class="broken">caught the lie</span>', { wide: true, note: `walHole: a gap in the middle of its saved log${taint ? ' · walTaint: it clears its copy, and the others teach it again' : ''}` }))
  else if (!lost) rows.push(F('the kernel', '<span class="agree-ok">lost nothing</span>', { wide: true, note: 'no save lied before the crash' }))
  else rows.push(F('the kernel', esc('saw no gap'), { wide: true, note: `the lost ${lost === 1 ? 'save was the last one' : 'saves were the last ones'}, so it cannot tell ${lost === 1 ? 'it' : 'them'} from saves never made. The others send what it is missing.` }))
  const ship = (c.seen.aeShip ?? []).filter((e) => bare(e.a) === t && e.at >= c.restartAt).reduce((s, e) => s + (e.b || 0), 0)
  rows.push(F('records the others sent it', T(ship), { note: 'aeShip, after the restart: each side sends a digest, the other sends what is missing' }))
  rows.push(copiesFact(c))
  return rows
}
function failDiskFacts(c) {
  const rows = [], t = c.target
  if (c.off) return [F('failing saves', esc('off'))]
  const f = (c.seen.persistFail ?? []).find((e) => e.node === t)
  rows.push(F(`${t}’s log`, f ? '<span class="broken">dead</span>' : esc('…'), { cls: f ? 'bad' : 'pend', note: f ? `persistFail at ${T(plus(f.at - c.t0))}: it stops trusting its disk, and keeps working with the others` : 'the next save fails' }))
  rows.push(writeFact('c1’s next write', firstWriteAfter(c)))
  const pf = persistedFact(c); if (pf) rows.push(pf)
  return rows
}
// pull every plug: ask, then crash and restart every server at one simulated instant, then check
function plugsAct(c) {
  c.asked = []
  for (const r of ROWS) {
    const o = page.owner(r)
    const s = o && page.alive(o) ? page.stamp(o, r) : null
    if (!s) continue
    const q = { row: r, stamp: s, on: o, res: null }
    c.asked.push(q)
    probe(o, s.origin, s.seq, CONFIRM.persisted).then((x) => { q.res = x; dirty = true })
  }
  c.phase = 'asking'
}
function plugsStep(c) {
  if (c.phase === 'asking') {
    if (c.asked.some((q) => !q.res) && page.now - c.t0 < 3000) return
    c.ceilings = Object.fromEntries(c.target.map((id) => [id, page.disk(id)?.boot?.lamport ?? null]))
    c.cutAt = page.now
    for (const id of c.target) if (page.alive(id)) page.kill(id)
    for (const id of c.target) if (page.down.has(id)) page.restart(id)
    c.newOrigins = new Set(c.target.map((id) => page.origin(id)))
    c.phase = 'back'
    return
  }
  if (c.phase === 'back') {
    const up = c.target.every((id) => page.alive(id))
    if (up && agreeNow() && page.now - c.cutAt > 1500) {
      // sim/monitors.ts confirmedIntact's test, on every server: its log holds the seq, or its stream applied past it
      c.check = c.asked.filter((q) => q.res?.ok).map((q) => {
        const held = c.target.filter((id) => { const n = page.node(id); return n.logs.get(q.stamp.origin)?.some((e) => e.seq === q.stamp.seq) || (n.streams.get(q.stamp.origin)?.applied ?? 0) >= q.stamp.seq })
        return { ...q, held: held.length }
      })
      c.phase = 'done'
    }
  }
}
BY.plugs.onApply = (c, a) => { if (!c.firstNew && c.newOrigins?.has(a.origin) && a.at > c.cutAt) c.firstNew = a }
function plugsFacts(c) {
  const rows = []
  const ok = (c.asked ?? []).filter((q) => q.res?.ok)
  const answered = c.asked?.every((q) => q.res)
  rows.push(F('persisted before', answered ? `${T(ok.length)} of ${T(c.asked.length)}` : esc('asking…'), { cls: answered ? '' : 'pend', note: 'the latest record of each row: the kernel’s answer to “is it on a majority of disks?” (the confirm ladder)' }))
  if (c.phase === 'done') {
    const intact = c.check.filter((q) => q.held === c.target.length).length
    rows.push(F('after the restart', `${T(intact)} of ${T(c.check.length)}`, { cls: intact === c.check.length ? 'ok' : 'bad', note: `held on every one of the ${T(c.target.length)} servers (the test of sim/monitors.ts confirmedIntact)` }))
    rows.push(F('lost', T(c.check.length - intact), { cls: c.check.length - intact ? 'bad' : 'ok' }))
  } else rows.push(F('after the restart', esc(c.phase === 'back' ? 'restarting…' : '…'), { cls: 'pend' }))
  if (c.firstNew) {
    const id = bare(c.firstNew.origin), ceil = c.ceilings?.[id]
    rows.push(F('the first stamp after', stamp({ epoch: c.firstNew.epoch, seq: c.firstNew.seq, origin: c.firstNew.origin }), { wide: true, note: ceil != null ? `${nid(id)}’s boot record kept the clock ceiling ${T('#' + ceil)}` : '' }))
    const q = quoteRow('lease'); if (q) rows.push(q)
  } else if (c.phase !== 'asking') rows.push(F('the first stamp after', esc('the next write…'), { cls: 'pend' }))
  // a disk that lied before this click (the lying fsync chip) is caught at this restart: say where that came from
  const holes = [...new Set((c.seen.walHole ?? []).filter((e) => e.at >= (c.cutAt ?? Infinity)).map((e) => e.node))]
  const tainted = holes.length && holes.every((id) => (c.seen.walTaint ?? []).some((e) => e.node === id && e.at >= c.cutAt))
  if (holes.length) rows.push(F(`${esc(list(holes))} found a hole in ${holes.length > 1 ? 'their' : 'its'} saved log: saves that lied before this click, still on ${holes.length > 1 ? 'those disks' : 'that disk'}. ${tainted ? `${holes.length > 1 ? 'They clear their copies' : 'It clears its copy'} and the others teach ${holes.length > 1 ? 'them' : 'it'} again (walHole, walTaint).` : `The others send what is missing (walHole).`}`, '', { say: true, wide: true }))
  return rows
}
function deadRowFacts(c) {
  if (!c.w) return [F('the write', esc(c.error ?? '…'), { cls: 'bad' })]
  const rows = []
  rows.push(F('the row', esc(c.row), { note: `its owner in view ${T(c.epochThen)}: ${nid(c.ownerThen)}${page.alive(c.ownerThen) ? ' · up again' : ' ✕ down'}` }))
  rows.push(writeFact('c1’s write', c.w))
  if (c.w.state === 'committed') {
    const o = c.w.stamp.origin, mine = bare(o) === c.ownerThen
    rows.push(F('stamped by', nid(o), { note: mine && o !== c.originThen ? `the old owner, back from its disk as ${T(o)}` : mine ? 'the old owner' : `the row’s owner in view ${T(c.w.stamp.epoch)}` }))
  }
  return rows
}
// both sides of a split: cut → (gate closed) both write → (voted out, c1's write landed) heal → (both landed) verdict
function splitStep(c) {
  const t = c.target
  if (c.phase === 'cut') {
    const g = page.alive(t) ? page.writable(t) : null
    if ((g && !g.open) || page.now - c.t0 > 800) {
      if (!page.alive(t) || !page.alive('c1')) { c.phase = 'off'; return }
      const base = cell('c1', c.row); const s = base && typeof base.stock === 'number' ? base.stock : 0
      c.vMin = { stock: (s + 1) % 10 }; c.vMaj = { stock: (s + 2) % 10 }
      c.wMin = page.write(t, c.row, c.vMin)
      c.wMaj = page.write('c1', c.row, c.vMaj)
      c.phase = 'wait'
    }
    return
  }
  if (c.phase === 'wait') {
    c.vote ??= vote(c, t)
    if (!c.pairs.some((k) => page.cuts.has(k))) { c.healAt = page.now; c.phase = 'healed'; return }   // healed by someone else
    if (c.vote && c.wMaj.state === 'committed' && page.now - c.wMaj.committedAt > 500) healSplit(c)
    return
  }
  if (c.phase === 'healed' && c.wMin?.state === 'committed' && c.wMaj?.state === 'committed' && agreeNow()) c.phase = 'done'
}
function healSplit(c) {
  for (const k of c.pairs) if (page.cuts.has(k)) { const [a, b] = k.split('|'); page.heal(a, b) }
  c.healAt ??= page.now; c.healedByPage = true
  if (c.phase === 'wait' || c.phase === 'cut') c.phase = 'healed'
  const h = HEALS.find((x) => x.c === c); if (h) h.done = true
}
// the split's promise, kept from the frame loop: a cut the split made is healed the moment its story stops
// following it (another chip, another control, the window ran out), so nothing is left cut by accident
function runHeals() {
  for (const h of HEALS) {
    if (h.done) continue
    const following = h.c === cur && !h.c.over && h.c.phase !== 'off' && page.now - h.at < WINDOW
    if (following) continue
    if (cur?.pressed && cur !== h.c && h.pairs.some((k) => page.cuts.has(k))) cur.logs.push({ at: page.now, kind: 'note', text: `the page heals the cut it made for “write on both sides”: that story is over`, ids: [] })
    healSplit(h.c)
  }
  for (let i = HEALS.length - 1; i >= 0; i--) if (HEALS[i].done) HEALS.splice(i, 1)
}
const sameStamp = (a, b) => !!a && !!b && a.epoch === b.epoch && a.seq === b.seq && a.origin === b.origin
function splitFacts(c) {
  const rows = [], t = c.target
  if (!c.wMin) return [F('the split', esc(c.phase === 'off' ? 'a server went down first' : 'cutting…'), { cls: 'pend', note: `${nid(t)} is cut off; the writes go out once it knows it is on the smaller side` })]
  // label each side from the view as it is now, not from the plan
  const v = page.view(), side = v.members.filter((m) => m !== t && page.alive(m) && !page.isolated(m)).length
  rows.push(writeFact(`${t}’s write (cut off)`, c.wMin))
  rows.push(writeFact(`c1’s write (${side * 2 > v.members.length ? 'the majority side' : 'no majority'})`, c.wMaj))
  if (c.phase === 'done') {
    const live = page.ids().filter((id) => page.alive(id))
    const vals = live.map((id) => JSON.stringify(cell(id, c.row)))
    const same = vals.every((x) => x === vals[0])
    const win = page.stamp(live[0], c.row)
    rows.push(F(`${c.row} on every copy`, `<span class="rec">${inspect(cell(live[0], c.row))}</span>`, { wide: true, cls: same ? 'ok' : 'waiting', note: same ? `${T(live.length)} of ${T(live.length)} copies · the bigger stamp kept the cell: ${stamp(win)}` : 'copies still catching up' }))
    const sm = c.wMin.stamp, sM = c.wMaj.stamp
    if (sameStamp(win, sM)) {
      const skips = (c.seen.lwwSkip ?? []).filter((e) => e.a === sm?.origin && e.b === sm?.seq), n = new Set(skips.map((e) => e.node)).size
      rows.push(F(`${t}’s write lost on`, `${T(n)} ${many(n, 'node')}`, { note: `its stamp ${stamp(sm)} is smaller than c1’s ${stamp(sM)}, so it does not replace the cell (lwwSkip). Nothing merges.` }))
    } else if (sameStamp(win, sm)) rows.push(F(`${t}’s write won`, esc('on every copy'), { note: `it was stamped last, ${stamp(sm)} after c1’s ${stamp(sM)}: the last writer wins` }))
  } else if (c.phase === 'healed') rows.push(F('the cut', esc('healed'), { note: `at ${T(plus(c.healAt - c.t0))}${c.healedByPage ? ', by the page' : ''}: ${nid(t)}’s held write goes out` }))
  return rows
}
BY.remove.onApply = (c, a) => { if (!c.applied && a.node === 'c1' && a.path[0] === c.row && (c.putBack ? a.type !== 2 : a.type === 2)) c.applied = a }
function removeFacts(c) {
  const rows = []
  if (!c.w) return [F('the write', esc(c.error ?? '…'), { cls: 'bad' })]
  const live = page.ids().filter((id) => page.alive(id))
  if (!c.putBack) {
    rows.push(F('the record', c.applied ? rec({ type: c.applied.type, key: c.applied.path }) : esc('on its way to the row’s owner'), { wide: true, cls: c.applied ? '' : 'pend', note: c.applied ? `as c1 applied it, stamped ${stamp({ epoch: c.applied.epoch, seq: c.applied.seq, origin: c.applied.origin })} by the row’s owner` : '' }))
    const gone = live.filter((id) => cell(id, c.row) === undefined)
    rows.push(F(`${c.row} gone from`, `${T(gone.length)} of ${T(live.length)} copies`, { cls: gone.length === live.length ? 'ok' : 'waiting' }))
  } else {
    rows.push(writeFact('c1’s write', c.w))
    const back = live.filter((id) => cell(id, c.row) !== undefined)
    rows.push(F(`${c.row} back on`, `${T(back.length)} of ${T(live.length)} copies`, { cls: back.length === live.length ? 'ok' : 'waiting', note: 'a new write has a bigger stamp than the remove, so it wins' }))
  }
  return rows
}

// ── own runs (Worker) ──────────────────────────────────────────────────────────────────────────────────
let OWN = null, worker = null, wid = 0
Object.defineProperty(window, '__breakOwn', { get: () => OWN, configurable: true })   // read-only, for tools/break-drive.mjs
const pendingRuns = new Map()
function runOwn(kind, seed, opts = {}) {
  return new Promise((resolve) => {
    try {
      worker ??= new Worker(new URL('./break/worker.js', import.meta.url), { type: 'module' })
      worker.onmessage = (e) => { const p = pendingRuns.get(e.data.id); if (p) { pendingRuns.delete(e.data.id); if (!e.data.ok) console.warn('[break] own run failed:', e.data.err); p(e.data.ok ? e.data.r : null) } }
      worker.onerror = () => { for (const p of pendingRuns.values()) p(null); pendingRuns.clear(); worker = null }
      const id = ++wid; pendingRuns.set(id, resolve); worker.postMessage({ id, kind, seed, opts })
    } catch {
      import('./break/runs.js').then((m) => resolve(m.scenario(kind, seed, opts))).catch(() => resolve(null))
    }
  })
}
let ownAsked = null
function askOwn() {
  const seed = page.seed
  if (ownAsked === seed && OWN) return
  ownAsked = seed
  const o = { seed }
  OWN = o
  const land = (k) => (r) => { if (OWN === o) { o[k] = r ?? { failed: true, seed }; dirty = true; paintB() } }
  for (const k of ['crash', 'stop', 'crash2']) runOwn(k, seed).then(land(k))
  // fero's defaults come from the build (api/index.ts), the link delay from the house config: the run types neither
  factsReady.then((f) => {
    const hb = f?.consts?.heartbeatMs, rd = f?.consts?.redialMs
    if (!hb || !rd) return land('defaults')({ kind: 'defaults', seed, failed: true, why: 'the build facts did not load' })
    runOwn('defaults', seed, { heartbeatMs: hb, redialMs: rd, delay: page.opts.delay }).then(land('defaults'))
  })
}

// ── painting: chips ────────────────────────────────────────────────────────────────────────────────────
const chipEl = new Map()
for (const chip of CHIPS) {
  const host = VA.querySelector(`.brk-chips[data-group="${chip.group}"]`)
  const b = document.createElement('button')
  b.type = 'button'; b.className = 'chip'; b.dataset.chip = chip.id
  b.innerHTML = '<span class="lbl"></span>'
  b.addEventListener('click', () => press(chip))
  host.append(b); chipEl.set(chip.id, b)
}
// a chip's look says three separate things: the outline = the panel shows this chip; the red ON word = a fault
// that stays on (the five toggles, also aria-pressed); greyed = not possible right now (the title says why)
function paintChips(force = false) {
  const gone = page.alive('c1') && cell('c1', 'gizmos') === undefined
  for (const chip of CHIPS) {
    const b = chipEl.get(chip.id), e = chip.enabled(), shown = cur?.chip === chip, live = chip.live?.() ?? false
    const label = typeof chip.label === 'function' ? chip.label({ gone }) : chip.label
    const warn = e.ok && chip.warn ? chip.warn() : ''
    const key = `${label}|${e.ok}|${e.why ?? ''}|${shown}|${live}|${warn}`
    if (!force && b.dataset.k === key) continue
    b.dataset.k = key
    b.querySelector('.lbl').textContent = label
    let mark = b.querySelector('.brk-live')
    if (live && !mark) { mark = document.createElement('i'); mark.className = 'brk-live'; mark.textContent = 'on'; b.append(mark) }
    if (!live && mark) mark.remove()
    b.classList.toggle('sel', shown); b.classList.toggle('is-live', live); b.classList.remove('on')
    b.disabled = !e.ok
    if (shown) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current')
    if (chip.toggle) b.setAttribute('aria-pressed', String(live)); else b.removeAttribute('aria-pressed')
    b.setAttribute('aria-label', `${label}${live ? ' (on)' : ''}${e.ok ? '' : ` (${e.why})`}`)
    b.title = e.ok ? (live ? `${label} is on: press again to turn it off` : warn ? `do it to the cluster above: ${warn}` : 'do it to the cluster above') : e.why
  }
}

// ── painting: the panel ────────────────────────────────────────────────────────────────────────────────
let dirty = true, lastPanelKey = '', lastPaint = 0, animate = false, progTop = -1
const nameOf = (c) => (typeof c.chip.name === 'function' ? c.chip.name(c) : c.chip.name)
const pick = (v, c) => (typeof v === 'function' ? v(c) : v)
// the parts that do not move while a story runs: In Node this is, the promise
function paintLeft(c) {
  const chip = c.chip, n = chip.node, cc = c.pressed ? c : {}
  paintCmd(c)
  const q = FACTS?.quotes?.[pick(n.cite, cc)]
  $('brk-src-a').innerHTML = q ? cite(q) : ''
  $('brk-say-a').innerHTML = pick(n.say, cc) ?? ''
  const pr = $('brk-promise-a')
  pr.innerHTML = quote(chip.promise)
  pr.hidden = !pr.innerHTML
  if (pr.innerHTML) pr.setAttribute('data-attested', 'build'); else pr.removeAttribute('data-attested')
}
// the name and what the page did (its target folded in): repainted every time, since before the first view
// (just after a reset) there is no owner yet, and a target can go down while the panel watches
function paintHead(c) {
  const chip = c.chip
  put($('brk-name-a'), nameOf(c))
  put($('brk-cat-a'), chip.group)
  let t
  if (!c.pressed) {
    const tgt = chip.pick()
    t = page.view().epoch && tgt ? `Press <b>${esc(typeof chip.label === 'function' ? chip.label({}) : chip.label)}</b> to do this to ${nid(tgt)}, ${esc(ownerWords(tgt))}, in the cluster above. Until you do, the numbers are from own runs.` : 'The cluster above is still forming its first view. Until it has one, the numbers are from own runs.'
  } else t = c.error ? `The page could not do it: ${esc(c.error)}` : c.external ? EXT[chip.id](c) : chip.did(c)
  const did = $('brk-did-a')
  if (did.dataset.h !== t) { did.innerHTML = t; did.dataset.h = t }
  did.setAttribute('data-attested', 'runtime')
}
function paintCmd(c) {
  const n = c.chip.node, cmd = $('brk-cmd-a')
  const lines = pick(n.lines, c.pressed ? c : {}) ?? []
  const html = lines.map((l) => {
    if (l.note != null) return `<span class="brk-comment">${esc(l.note)}</span>`
    if (l.js != null) return esc(l.js)
    const k = l.sh.indexOf('#')
    return `<span class="brk-prompt">$ </span>${k > 0 ? `${esc(l.sh.slice(0, k))}<span class="brk-comment">${esc(l.sh.slice(k))}</span>` : esc(l.sh)}`
  }).join('\n')
  if (cmd.dataset.h !== html) { cmd.innerHTML = html; cmd.dataset.h = html }
}
function paintNext(c) {
  const n = c.pressed && c.chip.next ? c.chip.next(c) : null
  const wrap = $('brk-next-wrap-a'), b = $('brk-next-a')
  wrap.hidden = !n
  if (n) { attest(b, n.label, 'runtime'); b.onclick = () => { own(() => n.run()); dirty = true; paintPanel(true) } }
  else { put(b, 'next ▸'); b.removeAttribute('data-attested'); b.onclick = null }
}
function lineList(c) {
  const out = []
  if (!c.pressed) {
    const r = OWN?.crash
    if (!r || r.failed) return out
    for (const l of r.lines) out.push({ key: 'o' + l.key, at: l.at, who: l.nodes, text: esc(l.text), jk: l.name, n: l.n, cls: l.name === 'viewInstall' || l.name === 'propose' ? 'is-vote' : '' })
    out.push({ key: 'ow', at: r.write.issuedAt - r.t0, who: ['c1'], text: `writes gadgets ${inspect(r.rec.value)} · ${r.write.committedAt ? `committed ${T(vt(r.write.committedAt - r.write.issuedAt))} later, ${stamp(r.write.stamp)}` : 'still waiting'}`, cls: 'is-write' })
    return out.sort((a, b) => a.at - b.at)
  }
  // the page's own lines: several of one kind at one instant (a cut of three links, three crashes) are one line
  const runs = []
  for (const e of c.logs) { const last = runs[runs.length - 1]; if (last && last.kind === e.kind && last.at === e.at) last.items.push(e); else runs.push({ kind: e.kind, at: e.at, items: [e] }) }
  for (const [i, r] of runs.entries()) {
    let text = r.items[0].text
    if (r.items.length > 1) {
      const pairs = list(r.items.map((e) => e.ids.join(' — ')))
      const whoList = list(r.items.map((e) => e.ids[0]))
      if (r.kind === 'cut') text = `the links ${pairs} are cut`
      else if (r.kind === 'heal') text = `the links ${pairs} are back`
      else if (r.kind === 'kill') text = `${whoList} crashed (like kill -9): their links drop, their disks stay`
      else if (r.kind === 'restart') text = `${whoList} restart from their disks: their rows come back before any link`
      else text = r.items.map((e) => e.text).join(' · ')
    }
    out.push({ key: 'p' + i, at: r.at - c.t0, who: [], page: true, text: esc(text), cls: 'is-page' })
  }
  for (const w of page.writes) {
    // a write made before the click that lands during the story (it waited through a cut, a vote…) is part of it too
    if (w.issuedAt < c.t0 && w.state === 'committed' && w.committedAt >= c.t0 && w.committedAt <= storyEnd(c)) {
      out.push({ key: 'w' + w.id, at: w.committedAt - c.t0, who: [], text: `${nid(w.node)}’s earlier write lands: ${w.remove ? `removes ${esc(w.path[0])}` : `${esc(w.path[0])} ${inspect(w.value)}`} · it waited ${T(vt(w.committedAt - w.issuedAt))}, ${stamp(w.stamp)}`, cls: 'is-write' })
      continue
    }
    if (w.issuedAt < c.t0 || w.issuedAt > storyEnd(c)) continue
    const what = w.remove ? `removes ${esc(w.path[0])}` : `writes ${esc(w.path[0])} ${inspect(w.value)}`
    const st = w.state === 'committed' ? `committed ${T(vt(w.committedAt - w.issuedAt))} later, ${stamp(w.stamp)}` : `<span class="waiting">waiting ${T(vt(page.now - w.issuedAt))}</span>`
    out.push({ key: 'w' + w.id, at: w.issuedAt - c.t0, who: [w.node], text: `${what} · ${st}`, cls: 'is-write' })
  }
  for (const l of c.story.lines()) out.push({ key: 'j' + l.key, at: l.at, who: l.nodes, text: esc(l.text), jk: l.name, n: l.n, cls: l.name === 'viewInstall' || l.name === 'propose' ? 'is-vote' : '' })
  out.sort((a, b) => a.at - b.at)
  if (c.over) out.push({ key: 'end', at: storyEnd(c) - c.t0, who: [], text: c.endAt ? 'the story is over; the cluster above runs on' : 'the panel stops here; the cluster above runs on', cls: 'is-gap' })
  return out
}
function paintLines(c) {
  const host = $('brk-lines-a')
  const items = lineList(c)
  put($('brk-lines-label-a'), c.pressed ? 'what the kernel did since the click' : 'what the kernel did after a crash')
  const cnt = $('brk-count-a')
  if (c.pressed) { cnt.innerHTML = `${T(c.story.rows)} journal lines`; cnt.title = 'the rows the nodes wrote in their journals since the click; the list groups them' }
  else if (OWN?.crash && !OWN.crash.failed) cnt.innerHTML = `own run · <span class="nw">seed ${T(String(OWN.crash.seed))}</span>`
  else cnt.textContent = 'own run · running…'
  if (!items.length) {
    for (const li of host.children) { lineIO?.unobserve(li); shownLines.delete(li) }
    host.innerHTML = `<li class="brk-empty">${c.pressed ? 'waiting for the kernel’s first journal row…' : 'running a separate simulation of the same crash…'}</li>`
  } else {
    const have = new Map([...host.children].map((li) => [li.dataset.key, li]))
    let prev = null
    for (const l of items) {
      const w = l.page ? '<span class="who">page</span>' : (l.who.length ? `<span class="who">${who(l.who)}</span>` : '')
      const html = `<span class="t">${plus(l.at)}</span><span class="w">${w}${l.text}${l.jk ? `<span class="jk" title="${esc(jkTip(l.jk))}">${esc(l.jk)}</span>` : ''}${l.n > 1 ? `<span class="x">×${l.n}</span>` : ''}</span>`
      let li = have.get(l.key)
      if (!li) { li = document.createElement('li'); li.dataset.key = l.key; if (animate) li.classList.add('fresh'); li.setAttribute('data-attested', 'runtime'); lineIO?.observe(li) }
      li.className = `brk-line ${l.cls ?? ''}${li.classList.contains('fresh') ? ' fresh' : ''}`
      if (li.dataset.h !== html) { li.innerHTML = html; li.dataset.h = html }
      if (prev ? prev.nextSibling !== li : host.firstChild !== li) host.insertBefore(li, prev ? prev.nextSibling : host.firstChild)
      have.delete(l.key); prev = li
    }
    for (const li of have.values()) { lineIO?.unobserve(li); shownLines.delete(li); li.remove() }
    // the list never jumps by itself: the start of the story stays in view; it follows new lines only after
    // the visitor has scrolled to its end (or pressed "more lines")
    if (c.follow && host.scrollHeight > host.clientHeight) { host.scrollTop = host.scrollHeight; progTop = host.scrollTop }
  }
  paintMore()
  // the routine rows: counted, not listed
  const rt = $('brk-routine-a')
  const parts = c.pressed ? c.story.routineText() : (OWN?.crash?.routine ?? [])
  const quiet = c.pressed ? c.story.quiet : OWN?.crash?.quiet
  rt.innerHTML = parts.length || quiet ? `also: ${parts.map(([k, n]) => `${T(n)} ${esc(k)}`).join(' · ')}${quiet ? `${parts.length ? ' · ' : ''}${T(quiet)} pings, digests and calls` : ''}` : ''
}
// "↑ N earlier lines" / "↓ N more lines": what the box is hiding, counted from the lines themselves. An
// IntersectionObserver rooted on the list says which lines show; painting never reads layout (a layout read right
// after the list changes would lay out the whole page, several times a second)
const shownLines = new Set()
const lineIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting) shownLines.add(e.target); else shownLines.delete(e.target) } paintMore() }, { root: $('brk-lines-a'), threshold: 0 }) : null
function paintMore() {
  const host = $('brk-lines-a'), more = $('brk-more-a'), earlier = $('brk-earlier-a')
  const lis = [...host.children]
  let first = -1, last = -1
  lis.forEach((li, i) => { if (shownLines.has(li)) { if (first < 0) first = i; last = i } })
  const above = first > 0 ? first : 0, below = last >= 0 ? lis.length - 1 - last : 0
  more.hidden = !below; earlier.hidden = !above
  if (below) { attest(more.querySelector('b'), num(below)); put(more.querySelector('i'), below === 1 ? 'more line' : 'more lines') }
  if (above) { attest(earlier.querySelector('b'), num(above)); put(earlier.querySelector('i'), above === 1 ? 'earlier line' : 'earlier lines') }
}
{
  const host = $('brk-lines-a')
  host.addEventListener('scroll', () => {
    if (progTop >= 0 && Math.abs(host.scrollTop - progTop) < 2) { progTop = -1; return }
    progTop = -1
    if (cur) cur.follow = host.scrollTop > 0 && host.scrollTop + host.clientHeight >= host.scrollHeight - 4
  }, { passive: true })
  $('brk-more-a').addEventListener('click', () => { if (cur) cur.follow = true; host.scrollTop = host.scrollHeight; progTop = host.scrollTop })
  $('brk-earlier-a').addEventListener('click', () => { if (cur) cur.follow = false; host.scrollTop = 0; progTop = 0 })
}
function paintFacts(c) {
  const rows = c.chip.facts(c).filter(Boolean)
  const host = $('brk-facts-a')
  const html = rows.map((r) => {
    const cls = ['brk-fact', r.wide ? 'wide' : '', r.say ? 'say' : '', r.quote ? 'quote' : ''].filter(Boolean).join(' ')
    if (r.say || r.quote) return `<div class="${cls}" data-attested="${r.quote ? 'build' : 'runtime'}"><span class="k">${r.k}</span></div>`
    const bar = r.bar != null ? `<span class="bar"><i style="width:${Math.max(0.5, Math.min(100, r.bar * 100)).toFixed(1)}%"></i></span>` : ''
    return `<div class="${cls}" data-attested="runtime"><span class="k">${esc(r.k)}</span><span class="v ${r.cls ?? ''}">${r.v}</span>${bar}${r.note ? `<span class="n">${r.note}</span>` : ''}</div>`
  }).join('')
  if (host.dataset.h !== html) { host.innerHTML = html; host.dataset.h = html }
  put($('brk-facts-title-a'), c.chip.id === 'crash' || c.chip.id === 'stop' ? 'the vote' : 'the numbers')
  paintRules(c)
}
// the ten monitors in plain words (facts.md §4, from sim/monitors.ts) — each rule's hover
const RULE_GIST = {
  'queued-implies-paused': 'frames wait in a link’s queue only while that link is paused',
  'one-view-per-epoch': 'no two nodes install different member lists under one view number',
  'epoch-monotone': 'a node’s view number never goes down',
  'log-monotone': 'each writer’s log stays in rising counter order',
  'single-writer': 'for any row and any view after the first vote, at most one writer stamps it',
  'attempt-exactly-once': 'one write attempt commits at most one stamp, anywhere in the cluster',
  'watermark-monotone': 'a node’s dealt-with-up-to-here mark for each writer never goes down',
  'watermark-ordering': 'for each writer, applied ≥ shippable ≥ durable, at every instant',
  'scoped-lawful-holding': 'with replicas, a node holds only rows the current ring gives it',
  'orphan-frozen': 'with replicas, a row a node should no longer hold stays frozen until it can be dropped safely',
}
function paintRules(c) {
  const names = page.rules
  const broken = brokenSince(c)
  const events = c.pressed ? (c.evEnd ?? page.events) - c.ev0 : page.events
  $('brk-rulesum-a').innerHTML = `${T(events)} events ${c.pressed ? (c.over ? 'in this story' : 'since the click') : 'on this cluster so far'} · ${broken.size ? `<span class="broken">${T(broken.size)} of ${T(names.length)} ${many(names.length, 'rule')} broken</span>` : `<span class="agree-ok">none of ${T(names.length)} broken ✓</span>`}`
  const key = names.join(',') + '|' + [...broken.keys()].join(',')
  const rl = $('brk-rules-a')
  if (rl.dataset.k !== key) {
    rl.dataset.k = key
    const inPlay = names.filter((n) => !SCOPED.has(n)), scoped = names.filter((n) => SCOPED.has(n))
    rl.innerHTML = inPlay.map((n) => `<span class="rule${broken.has(n) ? ' bad' : ''}" title="${esc(RULE_GIST[n] ?? '')}"><i>${broken.has(n) ? '✕' : '✓'}</i>${esc(n)}</span>`).join(' ')
    $('brk-scoped-a').innerHTML = scoped.length ? `only with <code>replicas</code>, so not in play here: ${scoped.map((n) => `<span class="rule" title="${esc(RULE_GIST[n] ?? '')}">${esc(n)}</span>`).join(' · ')}` : ''
  }
  const bad = $('brk-rulebad-a')
  const bh = [...broken.values()].map((v) => `<p><span class="broken">✕ ${esc(v.monitor)}</span>, first at event ${T(v.event)}: ${ruleDetail(v)}</p>`).join('')
  if (bad.dataset.h !== bh) { bad.innerHTML = bh; bad.dataset.h = bh; bad.hidden = !bh; if (bh) bad.setAttribute('data-attested', 'runtime') }
}
function paintPanel(force = false) {
  const c = cur
  const key = (c.pressed ? 'p' : 'd') + c.chip.id + (c.t0 ?? '') + (FACTS ? 'f' : '') + (c.pressed ? '' : (OWN?.crash ? 'o' : ''))
  const isNew = key !== lastPanelKey
  if (isNew) { paintLeft(c); const h = $('brk-lines-a'); for (const li of h.children) lineIO?.unobserve(li); shownLines.clear(); h.innerHTML = ''; h.scrollTop = 0; animate = false } else if (force) paintLeft(c)
  paintHead(c)
  paintCmd(c)
  paintNext(c)
  paintLines(c)
  paintFacts(c)
  lastPanelKey = key
  animate = true
}

// ── painting: the foot (the links' delay, the heartbeat, the redial wait, fero's defaults) ───────────────
// The cluster's live state (view, clock, waiting writes, copies) and its pause and reset are the dock's: a second
// status line here disagreed with it for a moment on every write, and named its pause button differently.
function paintFoot() {
  attest($('brk-delay-a'), `${house()[0]}–${house()[1]}`)
  attest($('brk-hb-a'), num(page.opts.heartbeatMs))
  const cs = FACTS?.consts
  if (cs) { attest($('brk-rd-a'), num(cs.harnessRedialMs), 'build'); attest($('brk-dhb-a'), num(cs.heartbeatMs), 'build'); attest($('brk-drd-a'), num(cs.redialMs), 'build') }
}

// ── variant b: three own runs, side by side ────────────────────────────────────────────────────────────
function timeline(r) {
  // lanes: every node of the run; x = simulated time from just before the fault to the run's end
  const W = 300, L = 30, top = 4, lh = 19, lanes = r.lanes
  const t0 = r.t0 - 400, t1 = r.end
  const x = (t) => L + ((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0)) * (W - L - 4)
  const H = top + lanes.length * lh + 22
  let s = `<svg class="brk-run-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="the view of each node over time" data-attested="runtime">`
  lanes.forEach((id, i) => {
    const y = top + i * lh
    const kill = r.marks.find((m) => m.node === id && (m.kind === 'kill' || m.kind === 'left'))
    const back = r.marks.find((m) => m.node === id && m.kind === 'restart')
    const vs = r.views.filter((v) => v.node === id).sort((a, b) => a.at - b.at)
    const segs = []
    for (let k = 0; k < vs.length; k++) segs.push({ from: k === 0 ? t0 : vs[k].at, to: vs[k + 1]?.at ?? t1, epoch: vs[k].epoch })
    s += `<text class="lbl" x="0" y="${y + 12}">${esc(id)}</text>`
    for (const g of segs) {
      const a = g.from, b = g.to
      const deadFrom = kill?.at ?? Infinity, deadTo = back?.at ?? Infinity
      const parts = [[a, Math.min(b, deadFrom)], [Math.max(a, deadTo), b]].filter(([p, q]) => q > p)
      for (const [p, q] of parts) {
        s += `<rect class="lane e${g.epoch % 2}" x="${x(p).toFixed(1)}" y="${y + 2}" width="${Math.max(0.5, x(q) - x(p)).toFixed(1)}" height="${lh - 5}" rx="1.5"></rect>`
        if (x(q) - x(p) > 40 && id !== 'c1') s += `<text class="vlbl" x="${(x(p) + 4).toFixed(1)}" y="${y + 12}">view ${g.epoch}</text>`
      }
    }
    if (kill) {
      const xk = x(kill.at), xe = back ? x(back.at) : x(t1)
      s += `<line class="dead" x1="${xk.toFixed(1)}" y1="${y + 8.5}" x2="${xe.toFixed(1)}" y2="${y + 8.5}"></line>`
      if (kill.kind === 'kill') s += `<text class="xmark" x="${(xk - 4).toFixed(1)}" y="${y + 12.5}">✕</text>`
      else s += `<text class="leftmark" x="${(xk + 3).toFixed(1)}" y="${y + 12}">left</text>`
    }
    if (back) s += `<text class="vlbl back" x="${(x(back.at) + 4).toFixed(1)}" y="${y + 12}">${esc(back.origin)}</text>`
    if (id === 'c1' && r.write) {
      const w = r.write, ya = y + 2
      s += `<rect class="wait" x="${x(w.issuedAt).toFixed(1)}" y="${ya}" width="${Math.max(1.5, x(w.committedAt ?? t1) - x(w.issuedAt)).toFixed(1)}" height="${lh - 5}" rx="1.5"></rect>`
      if (w.committedAt) s += `<circle class="stampmark" cx="${x(w.committedAt).toFixed(1)}" cy="${y + 8.5}" r="3.2"></circle>`
    }
  })
  // the axis: the fault at 0, then whole seconds
  const ya = top + lanes.length * lh + 4
  s += `<line class="axis" x1="${L}" y1="${ya}" x2="${W - 4}" y2="${ya}"></line>`
  const span = (t1 - r.t0) / 1000, step = span > 12 ? 4 : span > 5 ? 2 : span > 2 ? 1 : 0.5
  for (let k = 0; k * step * 1000 <= t1 - r.t0; k++) {
    const xx = x(r.t0 + k * step * 1000)
    s += `<line class="tick" x1="${xx.toFixed(1)}" y1="${ya}" x2="${xx.toFixed(1)}" y2="${ya + 3}"></line><text class="tl" x="${xx.toFixed(1)}" y="${ya + 13}" text-anchor="${k === 0 ? 'start' : 'middle'}">${k === 0 ? 'fault' : `${+(k * step).toFixed(1)} s`}</text>`
  }
  return s + '</svg>'
}
const rulesShort = (r) => { const b = r.broken ?? []; return `${b.length ? `<span class="broken">${T(b.length)} of ${T(r.rules)} broken: ${esc(b.map((x) => x.monitor).join(', '))}</span>` : `<span class="agree-ok">none of ${T(r.rules)} broken ✓</span>`} · ${T(r.events)} events` }
function paintRun(el, kind, r) {
  const body = el.querySelector('.brk-run-body')
  if (!r) { body.innerHTML = '<p class="brk-run-wait">running its own simulation…</p>'; return }
  if (r.failed) { body.innerHTML = '<p class="brk-run-wait">this run could not run in this tab.</p>'; return }
  const w = r.write, waited = w.committedAt != null ? w.committedAt - w.issuedAt : null
  const long = waited != null && waited > 1000
  const st = r.stamps ?? [], by = (s) => nid(bare(s.origin))
  const eo = (r.broken ?? []).find((b) => b.monitor === 'attempt-exactly-once')
  // every sentence below is chosen by what this run's kernel did: its votes, its stamps, its rules
  let say = ''
  if (kind === 'crash') say = r.vote ? `The survivors keep redialing ${nid(r.target)} until they give up, then vote it out. Until then the write waits.` : `The survivors keep redialing ${nid(r.target)}. No vote passed in this run.`
  if (kind === 'stop') {
    const head = `${nid(r.target)} asks to be voted out, so the vote passes at once.`
    if (st.length > 1) say = `${head} But c1’s write got two stamps: ${by(st[0])} stamped it in view ${T(st[0].epoch)}, then ${by(st[1])} stamped it again in view ${T(st[1].epoch)}.${eo ? ` The rule attempt-exactly-once caught it at event ${T(eo.event)}.` : ''}`
    else if (st[0] && bare(st[0].origin) === r.target) say = `${head} It stamped the write before it went.`
    else if (st[0]) say = `${head} The row’s new owner, ${by(st[0])}, stamps the write in view ${T(st[0].epoch)}.`
    else say = head
  }
  if (kind === 'crash2') say = twoMembers(`The write waits until the dead one comes back${r.restart ? `: the page restarts ${nid(r.target)} from its disk ${T(vt(r.restart.at - r.t0))} after the crash` : ''}.`)
  const rows = []
  if (r.vote) rows.push(['the vote', `${T(vt(r.vote.at - r.t0))} · view ${T(r.vote.epoch)} · ${ids(r.vote.members)}`])
  else rows.push(['the vote', kind === 'crash2' ? esc('none: one of two is not a majority') : esc('none in time')])
  if (r.restart) rows.push(['back from its disk', `${T(r.restart.origin)} · life ${T(r.restart.life)}`])
  rows.push([st.length > 1 ? 'the stamps' : 'the stamp', st.length > 1 ? st.map((s) => stamp(s)).join(' <span class="then">then</span> ') : (w.stamp ? stamp(w.stamp) : esc('none'))])
  const agree = r.final.every((f) => JSON.stringify(f.value) === JSON.stringify(r.final[0]?.value))
  rows.push(['copies', `<span class="${agree ? 'agree-ok' : 'waiting'}">${T(r.final.length)} of ${T(r.final.length)} hold ${inspect(r.final[0]?.value)}${agree ? ' ✓' : ''}</span>`])
  rows.push(['rules', rulesShort(r)])
  const keyLines = r.lines.filter((l) => ['linkDown', 'suspect', 'giveUp', 'propose', 'viewInstall', 'leave', 'left', 'gateClose', 'replayed', 'gateOpen'].includes(l.name)).slice(0, 6)
  const q = st.length > 1 ? FACTS?.quotes?.residual : null
  body.innerHTML = `
    <span class="brk-run-own" data-attested="runtime">own run · <span class="nw">seed ${esc(r.seed)}</span></span>
    <div class="brk-run-big"><span class="v${long ? ' waiting' : ''}" data-attested="runtime">${waited != null ? esc(vt(waited)) : 'waiting'}</span><span class="k">the write waited, on the simulated clock</span></div>
    ${timeline(r)}
    <p class="brk-run-say" data-attested="runtime">${say}</p>
    ${q ? `<blockquote class="brk-run-q" data-attested="build"><p>The kernel’s own notes name this gap: ${codeify(q.text)}</p>${cite(q)}</blockquote>` : ''}
    <div class="brk-run-rows">${rows.map(([k, v]) => `<div class="r"><span class="k">${k}</span><span class="v" data-attested="runtime">${v}</span></div>`).join('')}</div>
    <ol class="brk-run-lines" data-attested="runtime">${keyLines.map((l) => `<li><span class="t">${plus(l.at)}</span><span><span class="who">${who(l.nodes)}</span> ${esc(l.text)}</span></li>`).join('')}</ol>`
}
function paintB() {
  if (VB.hidden) return
  const o = OWN
  attest($('brk-seed-b'), String(page.seed))   // a seed names a run: no thousands comma
  const recEl = $('brk-rec-b')
  const r0 = [o?.crash, o?.stop].find((r) => r?.rec)
  if (r0) { recEl.innerHTML = `<code>shop.data.gadgets = ${esc(short(r0.rec.value))}</code> → ${rec(r0.rec)}`; recEl.setAttribute('data-attested', 'runtime') }
  for (const el of VB.querySelectorAll('.brk-run')) paintRun(el, el.dataset.kind, o?.[el.dataset.kind])
}
$('brk-rerun-b').addEventListener('click', () => {
  const before = OWN
  ownAsked = null; OWN = null; askOwn(); paintB()
  const o = OWN, el = $('brk-same-b')
  el.textContent = 'running again…'; el.removeAttribute('data-attested'); el.className = 'brk-same'
  const check = () => {
    if (OWN !== o) return
    if (!['crash', 'stop', 'crash2'].every((k) => o[k] !== undefined)) return setTimeout(check, 120)
    const sig = (r) => (r && !r.failed ? `${r.events}|${r.write.committedAt}|${JSON.stringify(r.stamps)}|${r.vote?.at ?? ''}` : 'x')
    const same = before && ['crash', 'stop', 'crash2'].every((k) => sig(before[k]) === sig(o[k]))
    const n = ['crash', 'stop', 'crash2'].reduce((t, k) => t + (o[k]?.events ?? 0), 0)
    el.className = 'brk-same ' + (same ? 'agree-ok' : 'broken')
    attest(el, same ? `the same seed gave the same three runs: ${num(n)} events, the same stamps ✓` : 'the second run differs: a page bug')
  }
  check()
})

// ── the loop: steps run from the frame loop (outside cluster callbacks); paint at most ~8 times a second ──
let shownA = !VA.hidden, onScreen = false
new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); if (onScreen) dirty = true }, { rootMargin: '200px 0px' }).observe(root)
VA.addEventListener('variantshow', () => { shownA = true; dirty = true; paintChips(true) })
VA.addEventListener('varianthide', () => { shownA = false })
VB.addEventListener('variantshow', () => { askOwn(); paintB() })
page.watch(VA)
cur = { chip: BY.crash, pressed: false }
onFrame((now) => {
  const c = cur
  own(() => {
    if (c?.pressed && c.chip.step && page.now <= c.t0 + WINDOW) { try { c.chip.step(c) } catch (err) { c.error = String(err?.message ?? err) } }
    if (HEALS.length) runHeals()
  })
  if (c?.pressed && !c.over) {
    if (c.endAt == null && c.chip.done) { try { if (c.chip.done(c)) c.endAt = page.now + TAIL } catch {} }
    if (page.now >= storyEnd(c)) { c.over = true; c.evEnd = page.events; c.violEnd = page.sim.violations.length; dirty = true }
  }
  if (!shownA || !onScreen || document.hidden) return
  if (now - lastPaint < 125) return
  lastPaint = now
  paintFoot()
  paintChips()
  if (dirty || (c?.pressed && !c.over)) { dirty = false; paintPanel() }
})
factsReady.then(() => { lastPanelKey = ''; dirty = true; if (shownA) { paintPanel(true); paintFoot() } })
// own runs: in idle time after load (the default panel's numbers), or at once if b is the variant shown
const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 300))
if (!VB.hidden) { askOwn(); paintB() } else idle(() => askOwn(), { timeout: 2500 })
paintChips(true)
paintFoot()
paintPanel(true)
