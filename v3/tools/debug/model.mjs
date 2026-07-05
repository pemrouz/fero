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

//! stateAt — TIME TRAVEL: replay a node's journal to event-index t (its per-node counter) through the LWW
// fold, joining apply events to the captured logs for the record payloads. Returns Map cellKey → {v (encoded),
// origin, seq, epoch, removed}. Only valid when the node's journal is untruncated (node.dropped === 0).
export const stateAt = (capture, uuid, t) => {
  const node = capture.nodes.find((n) => n.uuid === uuid)
  const K = capture.vocab
  const idx = logIndex(node)
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
    if (e.kind === K.writeLocal) applyOne(uuid, e.a)
    else if (e.kind === K.applyInbound) applyOne(e.a, e.b)
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

//! routes — the write-route join (v2's flagship debug feature, impossible there because origin was
// re-stamped at commit; trivial here because provenance is a real join key): for every (origin, seq),
// what happened at every node — origin / applied / lww-lost / duplicate / never-arrived.
export const routes = (capture) => {
  const K = capture.vocab
  const map = new Map() // 'origin#seq' → { origin, seq, partition, nodes: {uuid: {status, t}} }
  const touch = (origin, seq) => {
    const id = origin + '#' + seq
    if (!map.has(id)) map.set(id, { origin, seq, partition: '', nodes: {} })
    return map.get(id)
  }
  for (const node of capture.nodes) {
    const skips = new Set() // lwwSkip fires just before its applyInbound — join them into one status
    for (const e of node.journal) {
      if (e.kind === K.lwwSkip) skips.add(e.a + '#' + e.b)
      else if (e.kind === K.writeLocal) {
        const r = touch(node.uuid, e.a)
        r.partition = String(e.b)
        r.nodes[node.uuid] = { status: skips.has(node.uuid + '#' + e.a) ? 'lww-lost' : 'origin', t: e.t }
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
  converged: capture.nodes.every((n) => n.stateHash === capture.nodes[0].stateHash),
})
