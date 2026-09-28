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
export const ROUTE_STATUS = ['origin', 'applied', 'lww-lost', 'duplicate', 'never-arrived']
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
  const applyOne = (origin, seq) => {
    const entry = idx[origin]?.get(seq)
    if (!entry) return // record absent from this node's capture — render as unknown, never invent
    const key = cellKey(entry.k, entry.at)
    const cand = { epoch: entry.epoch, seq, origin }
    const cur = versions.get(key)
    if (cur && !newer(cand, cur)) return // the LWW election, identical to the kernel's
    versions.set(key, cand)
    if (entry.ty === 2 /* remove */) state.delete(key)
    else state.set(key, { v: entry.v, origin, seq, epoch: entry.epoch })
  }
  for (const e of node.journal) {
    if (e.t > t) break
    if (e.kind === K.writeLocal) applyOne(lane, e.a)
    else if (e.kind === K.applyInbound) applyOne(e.a, e.b)
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
    if (node.dropped > 0) return { uuid: node.uuid, ok: false, reason: `journal truncated (${node.dropped} dropped)` }
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
//            selfReject(a) / nameReject(a) mark the LOSER closing: dead, still in the table until its linkDown
//            echo (the kernel deletes only on the echo — deleting early would read as a failed dial and redial
//            the race) · linkDown(a) removes · pause(a)/drain(a) flip paused · dropOldest(a) de-syncs (the
//            whole queue was cleared) · digestIn(a) syncs UNLESS the link is paused (the DIGEST handler marks
//            debt and returns before `synced = true`) or the node is a CLIENT and the link is not its primary
//            (the single-feeder rule: primary = the first admitted link, re-elected to the next admitted
//            survivor when it goes down) · diagAuth(a) latches a diagnostics session.
//   streams  writeLocal(a=seq) advances the OWN lane's applied+shippable together (node.ts commit: the stamp
//            site) · applyInbound(a=origin, b=seq) advances both by max (write.ts: the fast path sets them to
//            seq, a splice fills BELOW the fence and never lowers them) · gateDrop(a=origin) names a lane
//            without advancing it (streams.for runs before the gate).
// NOT derivable — carried as null, never guessed: `queued` while paused (ship() parks frames silently),
// `durable` once anything was ever persisted (persist/persisted carry batch ids, never origins; a node with
// no persisted/replayed row anywhere in its journal provably never reached disk, so its durable IS 0), and
// whether the PEER is a client (no emit). `n` on a stream is the count of records folded so far.
// verifyTopology() is the drift guard: this fold at t=∞ must reproduce every captured end table exactly —
// the viewer replays a node's topology only where that proof holds, and shows the end (labelled) elsewhere.
// KNOWN BOUNDS the ∞ guard cannot see (per-step oracle findings, recorded in ISSUES.md — each transient,
// each self-healing at the next journal row that names the fact): (1) a link killed by a FATAL frameDrop
// is `dead` in the kernel until its linkDown echo, and a CLIENT's primary re-election skips dead links —
// the fold cannot tell a fatal frameDrop from a non-fatal one (same kind, free-text reason), so it may
// elect such a link for the one round-trip before the echo; (2) armed (replicas) and durable nodes mint
// EMPTY lanes with no journal row (boot floors, the replay entry, a staged record) — lane PRESENCE at an
// intermediate step is a lower bound there; (3) `synced` flips at the END of the digestIn step, after any
// aeShip row the same step emits — one row early at row granularity.
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
  for (const e of node.journal) {
    if (e.t > t) break
    const k = e.kind
    if (k === K.linkUp) {
      links.set(e.a, { id: e.a, uuid: '', dialed: e.b === 1, admitted: false, synced: false, paused: false, queued: 0, client: null, diag: false, closing: false })
    } else if (k === K.identified) {
      const l = links.get(e.a)
      if (l) { l.uuid = e.b; l.admitted = true; if (isClient && primary === null) primary = l.id }
    } else if (k === K.dupLink || k === K.selfReject || k === K.nameReject) {
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
    if (node.dropped > 0) return { uuid: node.uuid, ok: false, reason: `journal truncated (${node.dropped} dropped)` }
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
// what happened at every node — origin / applied / lww-lost / duplicate / never-arrived.
export const routes = (capture) => {
  const K = capture.vocab
  const map = new Map() // 'origin#seq' → { origin, seq, partition, nodes: {uuid: {status, t}} }
  const touch = (origin, seq) => {
    const id = origin + '#' + seq
    if (!map.has(id)) map.set(id, { origin, seq, partition: null, nodes: {} }) // null until a writeLocal row names it — a route seen only inbound (a reborn origin's old life) has no partition FACT
    return map.get(id)
  }
  for (const node of capture.nodes) {
    const skips = new Set() // lwwSkip fires just before its applyInbound — join them into one status
    const lane = laneOf(node) // a reborn node's writes are `uuid~inc#seq` routes — its peers apply them under that lane
    for (const e of node.journal) {
      if (e.kind === K.lwwSkip) skips.add(e.a + '#' + e.b)
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
  //! absent entries are REAL information: a node with no row for (origin, seq) never saw that write
  for (const r of map.values())
    for (const node of capture.nodes)
      if (!r.nodes[node.uuid]) r.nodes[node.uuid] = { status: 'never-arrived', t: null }
  return map
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
  // never synthesize a green claim about a cluster it holds no facts for (M7 honesty gate)
  converged: capture.nodes.length === 0 ? null : capture.nodes.every((n) => n.stateHash === capture.nodes[0].stateHash),
  //! absent (M7 attach): targets that yielded no slice this rebuild — passthrough of recorded facts;
  // absence contributes ZERO facts to every other fold (they range over nodes[] only)
  absent: capture.absent ?? [],
  //! shrunk (M7): pure passthrough of the capture's shrink facts — the viewer renders the pill from
  // THIS, never infers "shrunk-ness" (honesty: a fold may carry a recorded fact, never mint one).
  shrunk: capture.shrunk ?? null,
})
