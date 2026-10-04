// sections/break/narrate.js — the kernel's journal, told in plain words. DOM-free: the live panel (break.js)
// and the own runs (runs.js, in a Worker) share it.
//
// A journal row is { node, at, name, a, b, c }: `name` is a kernel/journal.ts JK key and a/b/c are its flat
// scalars (journal.ts documents each). One row per event is far too many to read (every ping, every digest,
// every redial), so rows GROUP: one line per (kind, the args that matter), carrying the nodes that wrote it,
// how many rows it stands for, and the simulated time of the first one. Nothing here invents a fact: every
// word is a kind's meaning (journal.ts, eli5.mjs) filled with that row's own values, or with what the kernel
// held at the instant the row was written (annotate()).
//
// Every `words` is a verb phrase for ONE subject ("loses its link to n02"). The page prints one node as the
// subject, or "each of n01, n03 and c1" for a group, so the verb is always right.

const bare = (s) => String(s ?? '').replace(/^sim:/, '').split('~')[0]   // 'sim:n02' → n02 · a client attempt lane 'c1~1' → c1
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const GATE = { minority: 'it cannot reach a majority', rejoining: 'it is rejoining', evicted: 'it is not in the view', 'stale-epoch': 'its view is out of date' }

// ROUTINE kinds happen all the time on a healthy cluster: they are counted in one summary line unless the
// chip in view is about them (its `focus`). QUIET kinds are only counted (pings, digests, dials).
export const QUIET = new Set(['ping', 'digestOut', 'digestIn', 'dial', 'dupLink', 'confirmReq', 'diagPull', 'rpcOut', 'rpcIn', 'rpcAnswer'])
export const ROUTINE = new Set(['applyInbound', 'aeShip', 'dupDrop', 'writeLocal', 'persist', 'persisted', 'linkUp', 'identified', 'bootWrite', 'writeForward', 'writeRelay', 'writeAck', 'compacted', 'tombstoneGC'])

// annotate(lc, e) — what a row cannot say by itself, read from the kernel AT the instant it is written. Call it
// inside the journal listener: core.js emits 'journal' from inside the kernel's own emit, so a link is still
// in its node's table while its linkDown is written, and a write gate is exactly what the drain just tested.
//   linkDown      → peer (the uuid at the far end) and cut (the page holds that pair cut: a network fault; a
//                   'partition' that is NOT a held cut is how core.js takes a crashed or stopped node's links)
//   writeBuffered → why: 'client' (no server link), 'gate' (its own write gate is closed), 'owner' (it cannot
//                   reach the row's owner) — kernel/write.ts #drain parks for exactly these reasons
//   viewInstall   → members, the view that node now holds
export function annotate(lc, e) {
  try {
    if (e.name === 'linkDown') {
      const peer = lc.node(e.node)?.links?.get(e.a)?.uuid ?? null
      return { ...e, peer, cut: !!peer && lc.cuts.has(pairKey(e.node, peer)) }
    }
    if (e.name === 'writeBuffered') {
      const n = lc.node(e.node)
      return { ...e, why: n?.client ? 'client' : lc.writable(e.node)?.open === false ? 'gate' : 'owner' }
    }
    if (e.name === 'viewInstall') return { ...e, members: lc.viewOf(e.node).members }
  } catch { /* a node mid-teardown: the row stays as the kernel wrote it */ }
  return e
}

const HELD = { client: 'holds its write back: it has no server link yet', gate: 'holds a write back until it takes writes again', owner: 'holds a write back: it cannot reach the row’s owner yet' }

// spec(row) → { key, words: (g) => string } — g is the group: { nodes, n, first, last, sum, seqs, ms, … }
// `ms` is filled for 'persisted' (the save's time on that disk, from its persist row).
export function spec(e) {
  const { name, a, b, c } = e
  switch (name) {
    case 'linkDown': {
      if (e.peer && b === 'partition') {
        const how = e.cut ? 'cut' : 'gone'
        return { key: `linkDown|${how}|${e.peer}`, target: e.peer, mergeKey: `linkDown|${how}`,
          many: (t) => (how === 'cut' ? `loses its links to ${t}: the network cut them` : `loses its links to ${t}`),
          words: () => (how === 'cut' ? `loses its link to ${e.peer}: the network cut it` : `loses its link to ${e.peer}`) }
      }
      if (e.peer) return { key: `linkDown|${b}|${e.peer}`, words: () => `loses its link to ${e.peer} (${b ?? 'closed'})` }
      // a link this node never had: only a node in its next life gets one (its last life's links went down
      // as it crashed, and the news lands after the restart)
      if (b === 'partition') return { key: 'linkDown|old', words: () => 'hears that old links went down: they belonged to its last life' }
      return { key: `linkDown|${b}`, words: () => `loses a link (${b ?? 'closed'})` }
    }
    case 'redial': return { key: `redial|${bare(b)}`, target: bare(b), many: (t) => `calls ${t} again, waiting longer each time`, words: () => `calls ${bare(b)} again, waiting longer each time` }
    case 'giveUp': return { key: `giveUp|${bare(a)}`, target: bare(a), many: (t) => `stops calling ${t} for now`, words: () => `stops calling ${bare(a)} for now` }
    case 'revive': return { key: `revive|${bare(a)}`, target: bare(a), many: (t) => `calls ${t} again from scratch`, words: () => `calls ${bare(a)} again from scratch` }
    case 'suspect': return { key: `suspect|${a}`, target: a, many: (t, n) => `marks ${t} ${n > 1 ? 'as suspects' : 'a suspect'}: no working link`, words: () => `marks ${a} a suspect: no working link to it` }
    case 'propose': return { key: `propose|${a}`, words: () => `asks for a vote on view ${a} (${b} members)` }
    case 'vote': return { key: `vote|${a}|${b}|${c}`, words: () => `votes ${b ? 'yes' : 'no'} on view ${a}, asked by ${c}` }
    case 'viewInstall': return { key: `viewInstall|${a}`, words: () => (e.members?.length ? `installs view ${a}: ${e.members.join(', ')}` : `installs view ${a} (${b} members)`) }
    // the node a row is about writes it too ("learns it was voted out"), so self and the others are separate lines
    case 'evict': return e.node === a ? { key: `evict|${a}|self`, words: () => 'learns it is no longer in the view' } : { key: `evict|${a}`, words: () => `drops ${a} from the view` }
    case 'epochStale': return { key: `epochStale|${a}`, words: () => `sees that view ${a} exists: new writes wait while it asks for it` }
    case 'gateClose': return { key: `gateClose|${a}`, words: () => `stops taking writes: ${GATE[a] ?? a}` }
    case 'gateOpen': return { key: 'gateOpen', words: () => 'takes writes again' }
    case 'gateAlarm': return { key: `gateAlarm|${a}`, words: () => `gives up asking for view ${a}: takes writes again, with an alarm` }
    case 'writeBuffered': { const why = e.why ?? 'owner'; return { key: `writeBuffered|${why}`, words: () => HELD[why] ?? HELD.owner } }
    case 'writeBufferDrop': return { key: 'writeBufferDrop', words: () => 'drops its oldest held write: the queue is full' }
    case 'join': return e.node === a ? { key: `join|${a}|self`, words: () => 'asks to join the view' } : { key: `join|${a}`, words: () => `hears ${a} ask to join` }
    case 'leave': return e.node === a ? { key: `leave|${a}|self`, words: () => 'asks to be voted out: a clean stop' } : { key: `leave|${a}`, words: () => `hears ${a} ask to be voted out` }
    case 'left': return { key: `left|${b}`, words: () => (b ? `leaves: the view without it committed (view ${a})` : 'leaves without its vote: from here it looks like a crash') }
    case 'writeForward': return { key: `writeForward|${bare(a)}`, words: () => `sends a write on to ${bare(a)}` }
    case 'writeRelay': return { key: `writeRelay|${bare(a)}`, words: () => `takes ${bare(a)}’s write and sends it to the row’s owner` }
    case 'writeAck': return { key: `writeAck|${bare(a)}`, words: () => `gets the stamp for ${bare(a)}’s write: it committed` }
    case 'writeNack': return { key: `writeNack|${a}`, words: () => `gets a write turned back (${a}): it tries again` }
    case 'writeDup': return { key: `writeDup|${bare(a)}`, words: () => `gets ${bare(a)}’s write a second time and does not apply it again` }
    case 'writeLocal': return { key: `writeLocal|${b}`, words: (g) => `stamps a write to ${b} (#${g.lastA})` }
    case 'applyInbound': return { key: `applyInbound|${bare(a)}`, words: () => `applies records stamped by ${a}` }
    case 'dupDrop': return { key: `dupDrop|${a}`, words: () => `drops repeats of ${a}’s records it already has` }
    case 'lwwSkip': return { key: `lwwSkip|${a}`, words: (g) => (g.seqs.size === 1 ? `skips ${a}’s #${b}: its cell already holds a bigger stamp` : `skips ${g.seqs.size} of ${a}’s records (#${g.seqMin} to #${g.seqMax}): their cells already hold bigger stamps`) }
    case 'aeShip': return { key: `aeShip|${bare(a)}`, words: (g) => `sends ${bare(a)} the records it was missing (${g.sum} in all)` }
    case 'persist': return { key: `persist|${e.node}`, words: () => 'hands a batch to its disk' }
    case 'persisted': return { key: `persisted|${e.node}`, words: (g) => (g.ms != null ? `has a batch on disk: the last save took ${g.ms}\u00a0ms` : 'has a batch on disk') }
    case 'persistFail': return { key: `persistFail|${b}`, words: () => `sees a save fail (${b}): it stops trusting its disk` }
    case 'replayed': return { key: 'replayed', words: (g) => `reads ${g.sum} saved records back from its disk` }
    case 'bootWrite': return { key: 'bootWrite', words: () => 'rewrites its boot record: its view, its vote, its clock ceiling' }
    case 'walHole': return { key: `walHole|${a}`, words: () => 'finds a hole in its saved log: the disk lied' }
    case 'walTaint': return { key: `walTaint|${a}`, words: () => 'stops trusting its disk: clears its copy and gets it back from the others' }
    case 'start': return { key: 'start', words: () => 'starts' }
    case 'linkUp': return { key: 'linkUp', words: () => 'opens a link' }
    case 'identified': return { key: `identified|${b}|${c}`, target: b, many: (t) => `hears hello from ${t}, life ${c}`, mergeKey: `identified|${c}`, words: () => `hears hello from ${b}, life ${c}` }
    case 'confirmed': return { key: `confirmed|${b}|${c}`, words: () => (b ? `answers a probe: ${c} members hold it` : `answers a probe: not yet (${c} hold it)`) }
    case 'compacted': return { key: 'compacted', words: () => 'drops old records every copy already has' }
    case 'tombstoneGC': return { key: 'tombstoneGC', words: () => 'drops delete markers nothing can contest any more' }
    case 'resync': return { key: 'resync', words: () => 'finds itself ahead of its server: starts over from the server' }
    case 'resynced': return { key: 'resynced', words: () => 'finishes starting over: it shows what the cluster has' }
    case 'frameDrop': return { key: `frameDrop|${b}`, words: () => `throws away a frame it cannot read (${b})` }
    case 'dropOldest': return { key: 'dropOldest', words: () => 'drops the pile of frames for a slow link: it resends them later' }
    case 'pause': return { key: 'pause', words: () => 'pauses a link: its pipe to a slow peer is full' }
    case 'drain': return { key: 'drain', words: () => 'drains a full pipe' }
    default: return null
  }
}

// Story: a growing set of grouped lines since one moment (a click, or an own run's fault).
export class Story {
  constructor(t0, focus = []) {
    this.t0 = t0
    this.focus = new Set(focus)
    this.groups = new Map()     // key → group
    this.order = []             // keys, by first row
    this.quiet = 0              // pings, digests, dials…
    this.routine = new Map()    // name → rows, routine kinds not in focus
    this.rows = 0
    this.saves = new Map()      // node|batch → persist time (pairs persist → persisted into a save time)
    this.changed = true
  }
  add(e) {
    if (e.at < this.t0) return
    this.rows++
    if (e.name === 'persist') this.saves.set(e.node + '|' + e.a, e.at)
    let ms = null
    if (e.name === 'persisted') { const t = this.saves.get(e.node + '|' + e.a); if (t != null) { ms = Math.round(e.at - t); this.saves.delete(e.node + '|' + e.a) } }
    // a refused call is one redial failing: the redial line already tells that story
    if (QUIET.has(e.name) || (e.name === 'linkDown' && (e.b === 'refused' || e.b === 'dup-link'))) { this.quiet++; return }
    if (ROUTINE.has(e.name) && !this.focus.has(e.name)) { this.routine.set(e.name, (this.routine.get(e.name) ?? 0) + 1); this.changed = true; return }
    const s = spec(e)
    if (!s) { this.quiet++; return }
    // rows of one kind from several nodes fold into one line through the key: the line names every node that wrote one
    let g = this.groups.get(s.key)
    if (!g) { g = { key: s.key, name: e.name, words: s.words, target: s.target, many: s.many, mergeKey: s.mergeKey ?? e.name, nodes: [], n: 0, first: e.at, last: e.at, sum: 0, lastA: e.a, ms: null, seqs: new Set(), seqMin: Infinity, seqMax: -Infinity }; this.groups.set(s.key, g); this.order.push(s.key) }
    if (!g.nodes.includes(e.node)) g.nodes.push(e.node)
    g.n++; g.last = e.at; g.lastA = e.a
    if (typeof e.a === 'number' && e.name === 'replayed') g.sum += e.a
    if (typeof e.b === 'number' && e.name === 'aeShip') g.sum += e.b
    if (e.name === 'lwwSkip' && typeof e.b === 'number') { g.seqs.add(e.b); g.seqMin = Math.min(g.seqMin, e.b); g.seqMax = Math.max(g.seqMax, e.b) }
    if (ms != null) g.ms = ms
    this.changed = true
  }
  // lines() → [{ at (ms after t0), nodes, name, text, n }] in order of first row. Groups of one kind written by the
  // SAME nodes about different peers merge into one line: "n03 calls n01, n02 and c1 again" instead of three.
  lines() {
    const out = [], merged = new Map()
    const list = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])
    for (const k of this.order) {
      const g = this.groups.get(k)
      if (g.many) {
        const mk = g.mergeKey + '|' + g.nodes.slice().sort().join(',')
        const m = merged.get(mk)
        if (m) { m.targets.push(g.target); m.n += g.n; m.first = Math.min(m.first, g.first); continue }
        const line = { key: k, at: g.first - this.t0, first: g.first, nodes: g.nodes, name: g.name, n: g.n, targets: [g.target], many: g.many, text: null }
        merged.set(mk, line); out.push(line); continue
      }
      out.push({ at: g.first - this.t0, nodes: g.nodes, name: g.name, text: g.words(g), n: g.n, key: k })
    }
    for (const l of out) if (l.many) { l.at = l.first - this.t0; l.text = l.targets.length > 1 ? l.many(list(l.targets), l.targets.length) : this.groups.get(l.key).words(this.groups.get(l.key)) }
    // plain data only: a Worker posts these lines (structured clone refuses functions)
    return out.sort((x, y) => x.at - y.at).map((l) => ({ at: l.at, nodes: l.nodes.slice(), name: l.name, text: l.text, n: l.n, key: l.key }))
  }
  routineText() {
    const r = this.routine, parts = []
    const n = (k) => r.get(k) ?? 0
    const add = (k, one, many) => { if (n(k)) parts.push([n(k) === 1 ? one : many, n(k)]) }
    add('writeLocal', 'stamp', 'stamps')
    add('applyInbound', 'record applied', 'records applied')
    add('aeShip', 'resend', 'resends')
    add('dupDrop', 'repeat dropped', 'repeats dropped')
    add('persisted', 'save', 'saves')
    return parts
  }
}
