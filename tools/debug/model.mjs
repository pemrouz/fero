//! ── tools/debug/model — ONE typed debug model, shared verbatim by Node and the browser ──
// Plain-JS ESM on purpose: v2 kept two hand-ported copies of its reductions (bridge
// TS + browser JS) and a real bug had to be fixed in BOTH (the dual-fix lesson).
// This file is imported by the capture writer, the model tests, the serve bridge,
// AND the viewer — the browser loads these exact bytes, so the folds structurally
// cannot drift. The event vocabulary is NOT defined here: it rides inside every
// capture (`capture.vocab`, generated from the kernel's JK const at capture time),
// so viewer filters can never disagree with the wire (v2's filter grammar had 5 of
// 6 sub: tokens returning empty on live feeds because its vocab was hand-authored).
//
// HONESTY RULES (v2's hard-won debug ethics, enforced here by construction):
//   - folds DERIVE, they never synthesize: every row traces to a journal event or
//     a log record in the capture; absent data renders as absent.
//   - state reconstruction is REPLAY through the same LWW rules the kernel runs —
//     verifyReplay() proves this model's fold matches the kernel's on every
//     capture (the drift guard: if the reimplementation diverges, tests fail).

//! ── value codec: capture JSON must carry what JSON cannot (NaN, undefined, ±Infinity, -0, bytes) ──
//! the CLOSED enums (M7 honesty gate): every fold-minted status string lives in one of these two lists —
// the string-leaf traceability test walks fold outputs and rejects any leaf outside capture-strings ∪
// these enums ∪ vocab names ∪ cellKey encodings. Add a status HERE (and to its fold) or the gate fails.
export const ROUTE_STATUS = ['origin', 'applied', 'lww-lost', 'duplicate', 'never-arrived', 'not-a-holder', 'acquired', 'feeder-unknown']
export const ABSENT_REASONS = ['refused', 'timeout', 'unauthorized', 'frame', 'vocab-mismatch', 'restarted', 'error']

export const encodeVal = (v) => {
  if (v === undefined) return { $: 'u' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (Object.is(v, -0)) return { $: '-0' }
    return v
  }
  if (v === null || typeof v !== 'object') return v
  if (v instanceof Uint8Array) return { $: 'u8', b: Array.from(v) }
  if (Array.isArray(v)) return v.map(encodeVal)
  const o = {}
  for (const k of Object.keys(v)) o[k] = encodeVal(v[k])
  if ('$' in v) return { $: 'esc', o } // a genuine user object with a '$' key must not collide with markers
  return o
}
export const decodeVal = (v) => {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(decodeVal)
  switch (v.$) {
    case 'u': return undefined
    case 'nan': return NaN
    case 'inf': return Infinity
    case '-inf': return -Infinity
    case '-0': return -0
    case 'u8': return new Uint8Array(v.b)
    case 'esc': { const o = {}; for (const k of Object.keys(v.o)) o[k] = decodeVal(v.o[k]); return o }
    default: { const o = {}; for (const k of Object.keys(v)) o[k] = decodeVal(v[k]); return o }
  }
}

//! kindNames — invert the capture's embedded vocabulary: {1:'dial', 2:'linkUp', ...}.
export const kindNames = (capture) => {
  const names = {}
  for (const [name, code] of Object.entries(capture.vocab)) names[code] = name
  return names
}

//! cellKey — the kernel's state-cell identity, mirrored exactly (full key path; root inserts key by `at`).
export const cellKey = (k, at) => JSON.stringify(k.length ? k : [at ?? ''])
//! partOf — a captured log entry's partition, the kernel's partitionOf (kernel/env.ts): key[0], or `at` for a root insert
const partOf = (x) => String(x.k.length ? x.k[0] : (x.at ?? ''))

//! partOfCell — a captured state cell's partition: the first part of its cellKey (the same key[0]-or-`at` rule)
const partOfCell = (ck) => {
  try { const p = JSON.parse(ck); return String(Array.isArray(p) ? p[0] : p) } catch { return null }
}
//! groupOf — the resource a node replicates: its captured name (diagNode carries it; a `#` name is fero's own
// `#directory`). Two resources never share a record (the HELLO refuses a different name), so every fold that
// compares nodes compares them inside one resource. A capture without names (the sim) is one group.
const groupOf = (n) => (typeof n.name === 'string' ? n.name : '')
//! newestView — the newest view a resource's nodes carry: { top, node } (node = one carrying it; null when none
// does). agreement() judges only its members; routes() falls back to it when the writer is not in the capture.
const newestView = (ns) => {
  const top = Math.max(0, ...ns.map((n) => (n.view ? n.view.epoch : 0)))
  return { top, node: ns.find((n) => n.view && n.view.epoch === top) || null }
}

//! copying — the rows a member is meant to hold but is still copying in at capture end: an acquireStart (a=partition)
// its journal has not yet closed with an acquire of the same row or with a view install. A latch opens only on a row
// the ring makes this node hold (every #latch site checks ring.holdsAny), and the ring changes only at a view install
// (kernel/membership.ts journals viewInstall right after rescope, which aborts every open latch 'epoch'). So until the
// next install the node is still meant to hold that row — also after an abort for any other reason (teacher link down,
// timeout, torn, overflow): the entry drops to `out` and the next round re-offers it, the ring unchanged. `held` leaves
// such a row out, and so, without this, would every fold that reads `held` when no writer's `holders` fact names the
// row (the writer not captured). A truncated journal may have lost the opening row: then there is no fact, and nothing
// is claimed.
const copying = (node, K) => {
  const open = new Set()
  for (const e of node.journal)
    if (e.kind === K.acquireStart) open.add(String(e.a))
    else if (e.kind === K.acquire) open.delete(String(e.a))
    else if (e.kind === K.viewInstall) open.clear()
  return open
}
//! feederHeld — a client's feeder when the page can judge the client by it: captured and carrying `held`. A client of
// a scoped resource folds only what its feeder holds (DESIGN-SCALE stage 2), so with no such feeder (no primary at
// capture end, or a live attach that could not reach it) the page cannot tell which rows the client is meant to have:
// agreement() does not compare it per row and routes() gives its stops `feeder-unknown` — one rule, both folds.
const feederHeld = (node, byUuid) => {
  const f = node.feeder != null ? byUuid.get(node.feeder) : null
  return f && Array.isArray(f.held) ? f : null
}

//! newer — the ONE conflict rule, mirrored from kernel/node.ts #apply: lexicographic (epoch, seq, origin).
const newer = (a, b) => // is `a` strictly newer than `b`?
  a.epoch > b.epoch || (a.epoch === b.epoch && (a.seq > b.seq || (a.seq === b.seq && a.origin > b.origin)))

//! logIndex — per-origin seq→entry lookup for a captured node's logs.
const logIndex = (node) => {
  const idx = {}
  for (const [origin, entries] of Object.entries(node.logs)) {
    idx[origin] = new Map()
    for (const e of entries) idx[origin].set(e.seq, e)
  }
  return idx
}

//! laneOf — the provenance lane a node's OWN writes stamp under: the bare uuid for its first life, `uuid~<inc>` after
// a restart (kernel/node.ts `origin`). A writeLocal row carries only the seq (a=seq, b=partition) and a capture holds
// no incarnation, so the lane is read off the node's own facts: the highest `uuid~N` among its log and stream lanes,
// else the bare uuid. Every writeLocal row in a journal belongs to the CURRENT life — a restart starts a fresh
// journal, and the old life comes back as applyInbound rows from the WAL replay — so one lane per node is exact.
// ISSUES I-1: joining them to the bare uuid made a reborn node replay ✗ and split each new write into two routes.
const laneOf = (node) => {
  let lane = node.uuid, inc = 1
  for (const o of [...Object.keys(node.logs || {}), ...Object.keys(node.streams || {})]) {
    if (!o.startsWith(node.uuid + '~')) continue
    const n = Number(o.slice(node.uuid.length + 1))
    if (Number.isInteger(n) && n > inc) { inc = n; lane = o }
  }
  return lane
}

//! handoffs — what an acquire (journal acquire, a=partition) folded at a node: the one-teacher fold puts the teacher's
// entries for p into the node's book with NO per-write row. The ones it taught are the captured entries of p that do
// not arrive by their own row later on: an entry with an apply row after the acquire came in live (the kernel's
// covered-below-the-cut rule makes a taught entry's later copy a dupDrop, never an applyInbound). Returns
// (p, ta) → [{origin, seq, rows}] (rows: the journal t of every apply row for that entry at this node). Built once per
// fold and only on the first acquire, so a capture without hand-offs pays nothing. A row compacted or shed again
// before capture end is absent from the book — rendered unknown, never invented, like every other absent record.
// stateAt folds these entries' cells; topologyAt raises their lanes' watermarks; routes() names the same last
// acquire for an `acquired` stop — one rule for every plane.
//! a row acquired MORE THAN ONCE (a heal re-latches a holder that fell behind — kernel/scope.ts held-found-lagging):
// an entry with no row of its own after the first acquire may have come in at that one or at a later one; the book
// cannot say which (the acquire row carries only the count the teacher shipped). Folding it at the first claimed
// the later hand-offs' records early, so the replay ran AHEAD of the kernel with nothing on the page to say so (the
// wave 5f review: up to 10 records ahead for dozens of rows). Each such entry is folded at the row's LAST acquire —
// the replay may trail the kernel between the two hand-offs, never lead it — and the earlier acquire hands back the
// entries it may have folded as `later`, so a fold can mark what it is unsure of. Returns
// (p, ta) → { taught, later, last }: `taught` the entries folded here, `later` the ones a later acquire (at `last`)
// folds instead.
const handoffs = (node, K) => {
  const lane = laneOf(node)
  const rowsAt = new Map() // 'origin#seq' → the journal t of every apply row for it at this node
  const row = (k, at) => { if (!rowsAt.has(k)) rowsAt.set(k, []); rowsAt.get(k).push(at) }
  const lastAt = new Map() // partition → the journal t of its last acquire at this node
  for (const e of node.journal)
    if (e.kind === K.writeLocal) row(lane + '#' + e.a, e.t)
    else if (e.kind === K.applyInbound) row(e.a + '#' + e.b, e.t)
    else if (e.kind === K.acquire) lastAt.set(String(e.a), e.t)
  const byPart = new Map()
  for (const [origin, entries] of Object.entries(node.logs || {}))
    for (const x of entries) {
      const q = partOf(x)
      if (!byPart.has(q)) byPart.set(q, [])
      byPart.get(q).push({ origin, seq: x.seq, rows: rowsAt.get(origin + '#' + x.seq) || [] })
    }
  const none = []
  return (p, ta) => {
    const open = (byPart.get(p) || none).filter((x) => !x.rows.some((r) => r > ta))
    const last = lastAt.get(p)
    return last === ta ? { taught: open, later: none, last } : { taught: none, later: open, last }
  }
}

//! stateAt — TIME TRAVEL: replay a node's journal to event-index t (its per-node counter) through the LWW
// fold, joining apply events to the captured logs for the record payloads. Returns Map cellKey → {v (encoded),
// origin, seq, epoch, removed}. Only valid when the node's journal is untruncated (node.dropped === 0).
export const stateAt = (capture, uuid, t) => {
  const node = capture.nodes.find((n) => n.uuid === uuid)
  const K = capture.vocab
  const idx = logIndex(node)
  const lane = laneOf(node) // the node's OWN lane this life — where its writeLocal rows' records live
  const versions = new Map()
  const state = new Map()
  let deepest = 1 // the deepest live path seen — a write can only sweep cells deeper than itself
  const applyOne = (origin, seq) => {
    const entry = idx[origin]?.get(seq)
    if (!entry) return // record absent from this node's capture — render as unknown, never invent
    const key = cellKey(entry.k, entry.at)
    const path = entry.k.length ? entry.k : [entry.at ?? '']
    const cand = { epoch: entry.epoch, seq, origin, p: partOf(entry) }
    const cur = versions.get(key)
    if (cur && !newer(cand, cur)) return // the LWW election, identical to the kernel's
    //! across depth (V4-18, kernel/node.ts apply): a field cell loses to ANY ancestor stamped at or above it
    for (let d = 1; d < path.length; d++) {
      const va = versions.get(JSON.stringify(path.slice(0, d)))
      if (va && !newer(cand, va)) return
    }
    versions.set(key, cand)
    if (entry.ty === 2 /* remove */) state.delete(key)
    else { state.set(key, { v: entry.v, origin, seq, epoch: entry.epoch }); if (path.length > deepest) deepest = path.length }
    //! the sweep (same site): every live cell UNDER this one stamped at or below it leaves, its version
    // becoming this stamp — the kernel's tombstone for a late copy of the swept record
    if (path.length < deepest) {
      const pfx = key.slice(0, -1) + ','
      for (const c of [...state.keys()]) {
        if (!c.startsWith(pfx)) continue
        if (newer(versions.get(c), cand)) continue
        state.delete(c)
        versions.set(c, cand)
      }
    }
  }
  //! hand-offs (scoped replication, kernel/scope.ts). shed(a=p): the row lawfully leaves this node — its cells AND
  // their versions go, outside the election (#shed + dropCell). acquire(a=p): the one-teacher fold puts the
  // teacher's entries for p into this node's book and state with NO per-write row — handoffs() names them.
  // Re-folding one already held is a no-op (the election).
  let taught = null
  for (const e of node.journal) {
    if (e.t > t) break
    if (e.kind === K.writeLocal) applyOne(lane, e.a)
    else if (e.kind === K.applyInbound) applyOne(e.a, e.b)
    else if (e.kind === K.acquire) { if (!taught) taught = handoffs(node, K); for (const x of taught(String(e.a), e.t).taught) applyOne(x.origin, x.seq) }
    else if (e.kind === K.shed) {
      const p = String(e.a)
      for (const [k, v] of versions) if (v.p === p) { versions.delete(k); state.delete(k) }
    }
    //! walTaint: the fsyncgate verdict — kernel/node.ts condemn() wipes state, versions, logs and streams, then
    // anti-entropy re-teaches the node. The end-state refold cannot see this (the re-taught fold coincides),
    // so the row is honoured HERE: everything replayed before the hole is gone at this step.
    else if (e.kind === K.walTaint) { state.clear(); versions.clear() }
    //! resync: a spoke found itself ahead of its feeder — kernel/node.ts #resyncBegin wipes the fold exactly
    // like condemn() and the feeder re-teaches it; same rule, same reason (the end-state refold cannot see it)
    else if (e.kind === K.resync) { state.clear(); versions.clear() }
  }
  return state
}

//! verifyReplay — the replay-refold check (plan §3.1 graft): this model's fold, run over the capture, must
// reproduce every node's captured end state exactly. Proves capture completeness AND that this file's LWW
// mirror matches the kernel's — the drift guard for the whole debug stack.
export const verifyReplay = (capture) => {
  return capture.nodes.map((node) => {
    //! truncated: the replay is UNCHECKED, not failed — the reason string is the honesty-gate template, the flag
    // lets the viewer say "unchecked" in amber instead of painting a lost diary page as a replay fault
    if (node.dropped > 0) return { uuid: node.uuid, ok: false, truncated: true, reason: `journal truncated (${node.dropped} dropped)` }
    const replayed = stateAt(capture, node.uuid, Infinity)
    const actual = new Map(node.state)
    if (replayed.size !== actual.size)
      return { uuid: node.uuid, ok: false, reason: `size ${replayed.size} vs ${actual.size}` }
    for (const [k, cell] of replayed) {
      if (!actual.has(k)) return { uuid: node.uuid, ok: false, reason: `replay has ${k}, capture does not` }
      if (JSON.stringify(cell.v) !== JSON.stringify(actual.get(k)))
        return { uuid: node.uuid, ok: false, reason: `${k}: ${JSON.stringify(cell.v)} vs ${JSON.stringify(actual.get(k))}` }
    }
    return { uuid: node.uuid, ok: true }
  })
}

//! topologyAt — TIME TRAVEL for the topology planes: replay a node's journal to event index t into its
// link table and its per-origin watermark ladder — the SAME row shapes diagNode snapshots at capture end
// (kernel/diag.ts `links` / `streams`), so the viewer paints one row type from either source. Every rule
// below is a kernel emit site (cited so drift is auditable), the way stateAt mirrors the LWW election:
//   links    linkUp(a=id, b=dialed) opens · identified(a=id, b=uuid) admits (kernel/node.ts HELLO: LS.admitted
//            is set in the same synchronous block as the emit — identified ⇔ admitted) · dupLink(a=closed) /
//            selfReject(a) / nameReject(a) / doorReject(a) / contractReject(a) mark the LOSER closing: dead, still in the table until its linkDown
//            echo (the kernel deletes only on the echo — deleting early would read as a failed dial and redial
//            the race) · linkDown(a) removes · pause(a)/drain(a) flip paused · dropOldest(a) de-syncs (the
//            whole queue was cleared) · digestIn(a) syncs UNLESS the link is paused (the DIGEST handler marks
//            debt and returns before `synced = true`) or the node is a CLIENT and the link is not its primary
//            (the single-feeder rule: primary = the first admitted link, re-elected to the next admitted
//            survivor when it goes down) · diagAuth(a) latches a diagnostics session.
//   streams  writeLocal(a=seq) advances the OWN lane's applied+shippable together (node.ts commit: the stamp
//            site) · applyInbound(a=origin, b=seq) advances both by max (write.ts: the fast path sets them to
//            seq, a splice fills BELOW the fence and never lowers them) · gateDrop(a=origin) names a lane
//            without advancing it (streams.for runs before the gate) · acquire(a=partition) merges each lane
//            up to the hand-off's cut (scope.ts onAcqDone), read off the entries it folded (handoffs()).
// NOT derivable — carried as null, never guessed: `queued` while paused (ship() parks frames silently),
// `durable` once anything was ever persisted (persist/persisted carry batch ids, never origins; a node with
// no persisted/replayed row anywhere in its journal provably never reached disk, so its durable IS 0), and
// whether the PEER is a client (no emit). `n` on a stream is the count of records folded so far.
// verifyTopology() is the drift guard: this fold at t=∞ must reproduce every captured end table exactly —
// the viewer replays a node's topology only where that proof holds, and shows the end (labelled) elsewhere.
// KNOWN BOUNDS the ∞ guard cannot see (per-step oracle findings, each transient,
// each self-healing at the next journal row that names the fact): (1) a link killed by a FATAL frameDrop
// is `dead` in the kernel until its linkDown echo, and a CLIENT's primary re-election skips dead links —
// the fold cannot tell a fatal frameDrop from a non-fatal one (same kind, free-text reason), so it may
// elect such a link for the one round-trip before the echo; (2) armed (replicas) and durable nodes mint
// EMPTY lanes with no journal row (boot floors, the replay entry, a staged record) — lane PRESENCE at an
// intermediate step is a lower bound there; (3) `synced` flips at the END of the digestIn step, after any
// aeShip row the same step emits — one row early at row granularity; (4) the hand-off's cut is not journaled:
// the replay raises each lane to the highest seq the acquire folded (armed nodes never compact, so the book keeps
// them). The teacher's cut can trail that seq when its floor waits on a gap, and a row shed again before capture
// end has left the book — the jump is then too high or too low until the lane's next row (the ∞ guard refuses a
// node whose END tables it misses); when the same row is acquired twice, an entry with no row of its own is
// folded at the LAST acquire of that row (handoffs()), so between the two the lane may trail the kernel, never
// lead it.
export const topologyAt = (capture, uuid, t) => {
  const node = capture.nodes.find((n) => n.uuid === uuid)
  const K = capture.vocab
  const links = new Map()
  const streams = new Map()
  const isClient = node.client === true
  let primary = null
  //! durable0: nothing ever went to (or came back from) disk — the durable mark is provably still 0
  const durable0 = !node.journal.some((e) => e.kind === K.persisted || e.kind === K.replayed)
  const lane = (origin) => {
    let d = streams.get(origin)
    if (!d) { d = { a: 0, s: 0, d: durable0 ? 0 : null, n: 0 }; streams.set(origin, d) }
    return d
  }
  const advance = (origin, seq) => { const d = lane(origin); if (seq > d.a) d.a = seq; if (seq > d.s) d.s = seq; d.n++ }
  const electPrimary = () => { primary = null; for (const l of links.values()) if (l.admitted && !l.closing) { primary = l.id; break } }
  let taught = null // handoffs(), built on the first acquire row
  const counted = new Set() // 'origin#seq' an acquire already counted as folded
  for (const e of node.journal) {
    if (e.t > t) break
    const k = e.kind
    if (k === K.linkUp) {
      links.set(e.a, { id: e.a, uuid: '', dialed: e.b === 1, admitted: false, synced: false, paused: false, queued: 0, client: null, diag: false, closing: false })
    } else if (k === K.identified) {
      const l = links.get(e.a)
      if (l) { l.uuid = e.b; l.admitted = true; if (isClient && primary === null) primary = l.id }
    } else if (k === K.dupLink || k === K.selfReject || k === K.nameReject || k === K.doorReject || k === K.contractReject) {
      const l = links.get(e.a)
      if (l) l.closing = true
    } else if (k === K.linkDown) {
      links.delete(e.a) // a linkDown with no prior linkUp is a FAILED dial — nothing to remove
      if (isClient && primary === e.a) electPrimary()
    } else if (k === K.pause) {
      const l = links.get(e.a)
      if (l) { l.paused = true; l.queued = null }
    } else if (k === K.drain) {
      const l = links.get(e.a)
      if (l) { l.paused = false; l.queued = 0 }
    } else if (k === K.dropOldest) {
      const l = links.get(e.a)
      if (l) l.synced = false
    } else if (k === K.digestIn) {
      const l = links.get(e.a)
      if (l && !l.paused && (!isClient || l.id === primary)) l.synced = true
    } else if (k === K.diagAuth) {
      const l = links.get(e.a)
      if (l) l.diag = true
    } else if (k === K.writeLocal) advance(uuid, e.a)
    else if (k === K.applyInbound) advance(e.a, e.b)
    else if (k === K.acquire) {
      //! the hand-off's watermark jump (kernel/scope.ts onAcqDone): each lane's applied and shippable merge up to the
      // teacher's cut, with no row per record. The cut is not journaled; the entries it folded are (handoffs(), the
      // rule stateAt folds by), and the highest of them per lane stands for the cut (KNOWN BOUND 4)
      if (!taught) taught = handoffs(node, K)
      for (const x of taught(String(e.a), e.t).taught) {
        const d = lane(x.origin)
        if (x.seq > d.a) d.a = x.seq
        if (x.seq > d.s) d.s = x.seq
        //! folded: an entry with no apply row before this acquire came in this hand-off (counted once, at the first)
        const id = x.origin + '#' + x.seq
        if (!counted.has(id) && !x.rows.some((r) => r < e.t)) { counted.add(id); d.n++ }
      }
    }
    else if (k === K.gateDrop) lane(e.a)
    else if (k === K.walTaint || k === K.resync) streams.clear() // condemn() / a spoke's resync: every lane is wiped with the fold; AE re-teaches (links untouched)
  }
  return { links, streams }
}

//! verifyTopology — the topology replay's refold check (the verifyReplay pattern applied to links/streams):
// topologyAt at t=∞ must reproduce each node's captured link table and watermark ladder field for field.
// Null fields in the replay are declared unknowns (never compared); fields ABSENT from an older capture
// (synced, diag) are not claims either — they are reported as `unverified` so the viewer paints them as
// unknown under scrub rather than as a derivation nothing vouched for. A node that fails here keeps its
// END tables in the viewer, labelled with this reason — the fold layer proves what may be replayed
// instead of the page assuming it.
export const verifyTopology = (capture) => {
  const LINK_FIELDS = ['uuid', 'dialed', 'admitted', 'synced', 'paused', 'queued', 'diag']
  return capture.nodes.map((node) => {
    if (node.dropped > 0) return { uuid: node.uuid, ok: false, truncated: true, reason: `journal truncated (${node.dropped} dropped)` }
    const bad = (reason) => ({ uuid: node.uuid, ok: false, reason })
    const { links, streams } = topologyAt(capture, node.uuid, Infinity)
    const end = node.links || []
    if (links.size !== end.length) return bad(`links size ${links.size} vs ${end.length}`)
    const unverified = []
    for (const f of LINK_FIELDS) if (end.some((l) => l[f] === undefined)) unverified.push(f)
    for (const l of end) {
      const r = links.get(l.id)
      if (!r) return bad(`capture has link #${l.id}, replay does not`)
      for (const f of LINK_FIELDS)
        if (r[f] !== null && l[f] !== undefined && r[f] !== l[f]) return bad(`link #${l.id} ${f}: ${r[f]} vs ${l[f]}`)
    }
    const ends = Object.entries(node.streams || {})
    if (streams.size !== ends.length) return bad(`streams size ${streams.size} vs ${ends.length}`)
    for (const [o, w0] of ends) {
      const r = streams.get(o)
      if (!r) return bad(`capture has stream ${o}, replay does not`)
      const w = typeof w0 === 'number' ? { a: w0, s: w0, d: 0 } : w0 // pre-M4a captures carried the applied scalar alone
      for (const f of ['a', 's', 'd'])
        if (r[f] !== null && r[f] !== w[f]) return bad(`stream ${o} ${f}: ${r[f]} vs ${w[f]}`)
    }
    return unverified.length ? { uuid: node.uuid, ok: true, unverified } : { uuid: node.uuid, ok: true }
  })
}

//! routes — the write-route join (v2's flagship debug feature, impossible there because origin was
// re-stamped at commit; trivial here because provenance is a real join key): for every (origin, seq),
// what happened at every node — origin / applied / lww-lost / duplicate / never-arrived / not-a-holder.
// not-a-holder (ISSUES I-3): scoped replication sends a write to its partition's holders only. A node with
// no row for it that is a member of the origin's view, not a client, and outside the holder set the ORIGIN's
// capture carries for that partition (kernel/diag.ts ownHolders — the ring's answer at capture end, never
// re-derived here) was never meant to get it. No holder facts (unscoped, an older capture, a partition
// compacted out of the origin's log) → absent is never-arrived, exactly as before.
// acquired: when the holders change, a new holder copies the row's whole history from an old one in one
// fold (journal acquire, a=partition, c=teacher) — no applyInbound row per write. A node with no row for
// the write whose record book HOLDS (origin, seq) and that journaled an acquire of the write's partition got
// it that way: closed status `acquired`, at the last such acquire row, with the teacher. Both facts or none.
// The writer not in the capture (a live attach that could not reach it): the route's partition comes from a captured
// log entry, its view from the resource's newest committed view, its holders from the rest of the resource.
// feeder-unknown: a client of a scoped resource whose feeder the page cannot see (no primary at capture end, or not
// captured) — whether it was meant to get the write is unknown, so its stop is not judged, as agreement() leaves it out.
export const routes = (capture) => {
  const K = capture.vocab
  const map = new Map() // 'origin#seq' → { origin, seq, partition, nodes: {uuid: {status, t}} }
  const touch = (origin, seq) => {
    const id = origin + '#' + seq
    if (!map.has(id)) map.set(id, { origin, seq, partition: null, group: null, nodes: {} }) // null until a writeLocal row names it — a route seen only inbound (a reborn origin's old life) has no partition FACT
    return map.get(id)
  }
  const acquired = new Map() // uuid → Map<partition, {t, from}> — the LAST acquire of each partition at that node
  for (const node of capture.nodes) {
    const skips = new Set() // lwwSkip fires just before its applyInbound — join them into one status
    const lane = laneOf(node) // a reborn node's writes are `uuid~inc#seq` routes — its peers apply them under that lane
    for (const e of node.journal) {
      if (e.kind === K.lwwSkip) skips.add(e.a + '#' + e.b)
      else if (e.kind === K.acquire) {
        if (!acquired.has(node.uuid)) acquired.set(node.uuid, new Map())
        acquired.get(node.uuid).set(String(e.a), { t: e.t, from: e.c })
      }
      else if (e.kind === K.writeLocal) {
        const r = touch(lane, e.a)
        r.partition = String(e.b)
        r.nodes[node.uuid] = { status: skips.has(lane + '#' + e.a) ? 'lww-lost' : 'origin', t: e.t }
      } else if (e.kind === K.applyInbound) {
        const r = touch(e.a, e.b)
        r.nodes[node.uuid] = { status: skips.has(e.a + '#' + e.b) ? 'lww-lost' : 'applied', t: e.t }
      } else if (e.kind === K.dupDrop) {
        const r = touch(e.a, e.b)
        if (!r.nodes[node.uuid]) r.nodes[node.uuid] = { status: 'duplicate', t: e.t }
      }
    }
  }
  //! absent entries are REAL information: a node with no row for (origin, seq) never saw that write —
  // or, on a scoped capture, was never one of its holders
  const byLane = new Map()
  for (const node of capture.nodes) byLane.set(laneOf(node), node)
  const byUuid = new Map(capture.nodes.map((n) => [n.uuid, n]))
  const seqs = new Map() // 'uuid lane' → Set of the seqs that node's record book holds (built on first need)
  const holds = (node, lane, seq) => {
    const k = node.uuid + ' ' + lane
    if (!seqs.has(k)) seqs.set(k, new Set(((node.logs || {})[lane] || []).map((x) => x.seq)))
    return seqs.get(k).has(seq)
  }
  //! epochOf — the epoch a write was stamped at, from any captured record book (null when no log holds it)
  let epochs = null
  const epochOf = (origin, seq) => {
    if (!epochs) {
      epochs = new Map()
      for (const n of capture.nodes) for (const [o, entries] of Object.entries(n.logs || {})) for (const x of entries) epochs.set(o + '#' + x.seq, x.epoch)
    }
    return epochs.has(origin + '#' + seq) ? epochs.get(origin + '#' + seq) : null
  }
  //! tenure — for a node outside the writer's view (it left cleanly, or was voted out), what it can be shown to
  // have held while it was a member, and the last epoch it was one. `until`: its own view's epoch while that
  // view still names it (a node cut off and voted out never installed the view without it); else the last view
  // it installed before its own evict row (install journals evict(self) just before the new viewInstall), else
  // one below the view that left it out. `rows`: what it holds now, every row it acquired, and every row that
  // froze into an orphan at an epoch past `until` — the rescope of the install that left it out freezes exactly
  // the rows it held at the exit (an orphan minted at arming, for a row it was never assigned, is at or below
  // `until` and does not count). Built on first need.
  const tenures = new Map()
  const tenure = (node) => {
    if (tenures.has(node.uuid)) return tenures.get(node.uuid)
    const view = node.view || { epoch: 0, members: [] }
    let until = view.members.includes(node.uuid) ? view.epoch : null
    if (until === null) {
      let last = null
      for (const e of node.journal) if (e.kind === K.viewInstall) last = e.a; else if (e.kind === K.evict && e.a === node.uuid) until = last
      if (until === null) until = view.epoch - 1
    }
    const rows = new Set(Array.isArray(node.held) ? node.held : [])
    for (const e of node.journal)
      if (e.kind === K.acquire || (e.kind === K.orphaned && Number(e.b) > until)) rows.add(String(e.a))
    const t = { until, rows }
    tenures.set(node.uuid, t)
    return t
  }
  //! the partition of a write whose writeLocal row is not in the capture (the writer was not reached, or it is a
  // reborn origin's old life): partOf of any captured log entry for it — the kernel's own partitionOf rule on the
  // record's key, a fact, never a guess. null when no log holds the record.
  let parts = null
  const partFromLogs = (origin, seq) => {
    if (!parts) {
      parts = new Map()
      for (const n of capture.nodes) for (const [o, entries] of Object.entries(n.logs || {})) for (const x of entries) parts.set(o + '#' + x.seq, partOf(x))
    }
    return parts.get(origin + '#' + seq) ?? null
  }
  //! with the writer not captured, the holders of a row come from the rest of its resource: the ring's answer any
  // node on the newest view carries for that row (`holders`, a writer's own rows), else the members of that view
  // whose `held` names it, or that are still copying it in on that view (copying(): a latch since the last install — the
  // ring gives them the row, and agreement() judges them on it too). null — the old rule — when the resource carries no scoped
  // fact, or no captured member holds the row.
  const byGroup = new Map()
  for (const n of capture.nodes) { const g = groupOf(n); if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(n) }
  const newest = new Map([...byGroup].map(([g, ns]) => [g, newestView(ns)]))
  const scopedG = new Map([...byGroup].map(([g, ns]) => [g, ns.some((n) => Array.isArray(n.held))]))
  const copies = new Map() // uuid → copying(node), built on first need
  const copyingOf = (n) => { if (!copies.has(n.uuid)) copies.set(n.uuid, copying(n, K)); return copies.get(n.uuid) }
  const holdersFromGroup = (g, p) => {
    const { top, node: tv } = newest.get(g)
    const ns = byGroup.get(g)
    for (const n of ns) if (n.holders && n.view && n.view.epoch === top && n.holders[p]) return n.holders[p]
    if (!tv || !scopedG.get(g)) return null
    //! the client and newest-view checks are defensive (no capture under test needs them): a client never latches,
    // and a member off the newest view latched against an older ring that may no longer give it the row
    const hs = tv.view.members.filter((u) => {
      const n = byUuid.get(u)
      return !!n && n.client !== true && ((Array.isArray(n.held) && n.held.includes(p)) || (!!n.view && n.view.epoch === top && copyingOf(n).has(p)))
    })
    return hs.length ? hs : null
  }
  for (const r of map.values()) {
    const o = byLane.get(r.origin)
    //! one resource per route: the writer's (or, with the writer not captured, that of a node that has a row for it —
    // records never cross resources). Only that resource's nodes are stops; another resource never was meant to get it
    const g = o ? groupOf(o) : groupOf(capture.nodes.find((n) => r.nodes[n.uuid]) || {})
    r.group = g === '' ? null : g
    //! the writer's own facts when it is captured; else the resource's newest committed view, the same view the
    // header (agreement) judges by, so a live attach that could not reach the writer still tells one story
    const part = r.partition != null ? r.partition : o ? null : partFromLogs(r.origin, r.seq)
    const tv = newest.get(g).node
    const view = o ? o.view : tv && tv.view.epoch > 0 ? tv.view : null
    const holders = part == null ? null : o ? (o.holders ? o.holders[part] : null) : holdersFromGroup(g, part)
    const members = holders && view ? view.members : null
    //! no holder fact (unscoped, or an older capture): every member is meant to get every write, so only a node
    // outside the committed view needs its tenure (it left, or was voted out): a write stamped after its last member
    // epoch never was meant for it — scoped or not
    const inView = view && view.epoch > 0 ? view.members : null
    for (const node of capture.nodes)
      if (!r.nodes[node.uuid] && groupOf(node) === g) {
        const got = part != null && acquired.has(node.uuid) ? acquired.get(node.uuid).get(part) : null
        if (got && holds(node, r.origin, r.seq)) { r.nodes[node.uuid] = { status: 'acquired', t: got.t, from: got.from }; continue }
        //! a client of a scoped resource with no feeder to judge it by (no primary at capture end, or a live attach that
        // could not reach the feeder) is not judged: agreement() does not compare it either, so the header and the stops
        // tell one story. An older capture (no `held` anywhere) keeps the old rule
        if (node.client === true && scopedG.get(g) && !feederHeld(node, byUuid)) { r.nodes[node.uuid] = { status: 'feeder-unknown', t: null }; continue }
        let quiet = false
        if (members && node.client === true) {
          //! a client folds what its feeder holds (DESIGN-SCALE stage 2): meant to get a write only when its feeder holds
          // the write's row at capture end. No feeder fact on an older capture → the old rule
          const f = feederHeld(node, byUuid)
          quiet = !!f && !f.held.includes(part)
        } else if (members && members.includes(node.uuid)) quiet = !holders.includes(node.uuid)
        else if (members) {
          //! a node outside the view is judged only for rows it held while a member, and only for writes stamped
          // while it was one (epoch ≤ until); a write whose record no log holds has no epoch — the row decides
          const tn = tenure(node), e = epochOf(r.origin, r.seq)
          quiet = !(tn.rows.has(part) && (e === null || e <= tn.until))
        } else if (inView && node.client !== true && !inView.includes(node.uuid)) {
          //! an unknown epoch (no log holds the record) proves nothing: the old rule, never-arrived
          const e = epochOf(r.origin, r.seq)
          quiet = e !== null && e > tenure(node).until
        }
        r.nodes[node.uuid] = { status: quiet ? 'not-a-holder' : 'never-arrived', t: null }
      }
  }
  return map
}

//! agreement — do the nodes agree? The header's `converged`, and the nodes the page pills `differs`. Per resource
// (groupOf): two resources hold different data by design. Inside one resource:
//   unscoped — one fingerprint per node (stateHash): the modal side is a STRICT majority; in an even split no side
//            is the cluster, so every side is off (ISSUES I-7).
//   scoped   — (any node of the resource carries `held`) each node holds only its rows, so whole-node fingerprints
//            differ by design. Each ROW is compared among the nodes that hold it (the scopedConverged monitor's rule):
//            the members whose `held` names it, and every client whose feeder holds it (a client folds its feeder's
//            rows). The row's fingerprint at a node is its cells there, values only; a missing cell disagrees. A node
//            is off when it sits outside a row's strict-majority side (or the row splits evenly). A row frozen on its
//            way out (orphan) has no claim on the node; a row the ring gives a member — a writer's `holders` fact, or
//            its own latch since the last install (copying()) — is judged there even before the copy lands, so a
//            holder still copying in an old value lags, and so does one whose copy aborted with the ring unchanged. A client
//            with no feeder to judge it by is not judged per row (`unjudged`).
// `rows` (scoped only): partition → the nodes judged for it; `judged` (unscoped only): the nodes compared. The page
// compares a cell among exactly these, and routes() judges a node left out by its tenure, so the header, the pills,
// the cells and the writes tell one story about a member that left.
export const agreement = (capture) => {
  if (!capture.nodes.length) return { converged: null, groups: [], off: [] }
  const K = capture.vocab
  const byName = new Map()
  for (const n of capture.nodes) { const g = groupOf(n); if (!byName.has(g)) byName.set(g, []); byName.get(g).push(n) }
  const groups = []
  const off = new Set()
  for (const [g, ns] of byName) {
    const scoped = ns.some((n) => Array.isArray(n.held))
    //! who is judged: a member of the newest committed view the resource's nodes carry, and every client. A node that
    // left (cleanly, or voted out while cut off) keeps a copy that later writes lawfully never reach — its routes are
    // judged by its tenure (routes()), its copy is not compared. With no committed view yet (epoch 0) everyone is.
    const { top, node: topView } = newestView(ns)
    const judged = (n) => n.client === true || top === 0 || !topView || topView.view.members.includes(n.uuid)
    const out = { name: g === '' ? null : g, nodes: ns.map((n) => n.uuid), scoped, converged: true, split: false, sides: [ns.length] }
    if (!scoped) {
      const js = ns.filter(judged)
      out.judged = js.map((n) => n.uuid) // the page compares a cell among exactly these
      const tally = new Map()
      for (const n of js) tally.set(n.stateHash, (tally.get(n.stateHash) || 0) + 1)
      let modal = js.length ? js[0].stateHash : 0, best = -1
      for (const [h, c] of tally) if (c > best) { best = c; modal = h }
      out.sides = [...tally.values()].sort((a, b) => b - a)
      out.split = js.length > 1 && best * 2 <= js.length
      out.converged = tally.size <= 1
      if (!out.converged) for (const n of js) if (out.split || n.stateHash !== modal) off.add(n.uuid)
    } else {
      const byUuid = new Map(ns.map((n) => [n.uuid, n]))
      const fps = new Map() // uuid → Map<partition, fingerprint> (built on first need)
      const fpOf = (n, p) => {
        if (!fps.has(n.uuid)) {
          const m = new Map()
          for (const [ck, v] of n.state) { const q = partOfCell(ck); if (!m.has(q)) m.set(q, []); m.get(q).push(JSON.stringify([ck, v])) }
          for (const [q, a] of m) m.set(q, a.sort().join('\n'))
          fps.set(n.uuid, m)
        }
        return fps.get(n.uuid).get(p) ?? ''
      }
      const rows = new Map()
      const join = (p, u) => { if (!rows.has(p)) rows.set(p, []); rows.get(p).push(u) }
      for (const n of ns) if (Array.isArray(n.held) && n.client !== true && judged(n)) for (const p of n.held) join(p, n.uuid)
      //! the ring's duty too: a node the ring names a holder of a row (a writer's `holders` fact, from the writers on
      // the newest committed view — an older view's list may name a node now lawfully shedding) that does not hold it
      // yet — never got a record of it, or is still copying it in — is judged as lagging, never skipped
      for (const n of ns)
        if (n.holders && n.view && n.view.epoch === top)
          for (const [p, hs] of Object.entries(n.holders))
            for (const u of hs) { const h = byUuid.get(u); if (h && h.client !== true && judged(h) && !(rows.get(p) || []).includes(u)) join(p, u) }
      //! and a member still copying a row in on the newest view (copying(): its latch since the last install) — the ring gives it the row,
      // so it is judged there as lagging even when no captured writer's `holders` names it (the writer not reached).
      // The newest-view check is defensive: a member off that view latched against an older ring
      for (const n of ns)
        if (n.client !== true && judged(n) && n.view && n.view.epoch === top)
          for (const p of copying(n, K)) if (!(rows.get(p) || []).includes(n.uuid)) join(p, n.uuid)
      const unjudged = []
      for (const n of ns) {
        if (n.client !== true) continue
        const f = feederHeld(n, byUuid)
        if (f) for (const p of f.held) join(p, n.uuid)
        else unjudged.push(n.uuid)
      }
      //! a client with no feeder to judge it by (no primary, or the feeder not captured) is compared on no row; the page
      // names it so the header's converged never reads as a verdict on it (routes() gives its stops `feeder-unknown`)
      out.unjudged = unjudged
      const bad = []
      for (const [p, us] of rows) {
        if (us.length < 2) continue
        const sides = new Map()
        for (const u of us) { const fp = fpOf(byUuid.get(u), p); if (!sides.has(fp)) sides.set(fp, []); sides.get(fp).push(u) }
        if (sides.size <= 1) continue
        bad.push(p)
        let top = []
        for (const s of sides.values()) if (s.length > top.length) top = s
        const split = top.length * 2 <= us.length
        for (const s of sides.values()) if (split || s !== top) for (const u of s) off.add(u)
      }
      out.converged = bad.length === 0
      out.rows = rows
      out.bad = bad.sort()
    }
    groups.push(out)
  }
  return { converged: groups.every((x) => x.converged), groups, off: [...off] }
}

//! contested — cells where an LWW election ACTUALLY rejected a candidate somewhere (journal lwwSkip,
// joined to its log entry for the cell). Successive updates to the same key are causal history, NOT
// contention — with Lamport stamps a writer that has seen the current value always stamps strictly
// newer, so a genuine concurrent race is exactly the case where some node holds the winner and then
// receives the loser: lwwSkip fires there. Deriving from lwwSkip (not from candidate counts) is what
// keeps a single-writer workload reading as zero conflicts. Truncated journals (dropped>0) can
// under-report here — the viewer surfaces truncation separately rather than this fold guessing.
export const contested = (capture) => {
  const K = capture.vocab
  const losers = new Set() // 'origin#seq' of every record some node's election rejected
  for (const node of capture.nodes)
    for (const e of node.journal) if (e.kind === K.lwwSkip) losers.add(e.a + '#' + e.b)
  if (!losers.size) return []
  const cells = new Map() // cellKey → Map<'origin#seq', {origin, seq, epoch, v, ty}>
  for (const node of capture.nodes)
    for (const [origin, entries] of Object.entries(node.logs))
      for (const e of entries) {
        const key = cellKey(e.k, e.at)
        if (!cells.has(key)) cells.set(key, new Map())
        cells.get(key).set(origin + '#' + e.seq, { origin, seq: e.seq, epoch: e.epoch, v: e.v, ty: e.ty })
      }
  const out = []
  for (const [key, cands] of cells) {
    if (![...cands.keys()].some((id) => losers.has(id))) continue // no election lost here — history, not contention
    let winner = null
    for (const c of cands.values()) if (!winner || newer(c, winner)) winner = c
    out.push({ cell: key, winner, candidates: [...cands.values()].sort((a, b) => (newer(a, b) ? -1 : 1)) })
  }
  return out.sort((a, b) => b.candidates.length - a.candidates.length)
}

//! summarize — the header facts a viewer leads with, all straight from the capture (never computed-then-guessed).
export const summarize = (capture) => ({
  kind: capture.kind,
  seed: capture.seed ?? null,
  nodes: capture.nodes.length,
  events: capture.events ?? null,
  quiesced: capture.quiesced ?? null,
  violations: capture.violations ?? [],
  journalRows: capture.nodes.reduce((n, x) => n + x.journal.length, 0),
  truncated: capture.nodes.filter((n) => n.dropped > 0).map((n) => n.uuid),
  //! converged is NULL on zero nodes — `every()` over an empty set is vacuously true, and a fold must
  // never synthesize a green claim about a cluster it holds no facts for (M7 honesty gate). Otherwise it is
  // agreement()'s verdict: per resource, and per row among its holders on a scoped capture
  converged: agreement(capture).converged,
  //! absent (M7 attach): targets that yielded no slice this rebuild — passthrough of recorded facts;
  // absence contributes ZERO facts to every other fold (they range over nodes[] only)
  absent: capture.absent ?? [],
  //! shrunk (M7): pure passthrough of the capture's shrink facts — the viewer renders the pill from
  // THIS, never infers "shrunk-ness" (honesty: a fold may carry a recorded fact, never mint one).
  shrunk: capture.shrunk ?? null,
})
