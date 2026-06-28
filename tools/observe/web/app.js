// fero observe — the dashboard (Slice 1: family [a] topology).
//
// It dogfoods `data`: SSE-delivered InspectSnapshots are merged into ONE reactive
// model proxy, and the DOM is bound to that model declaratively (data/render does
// surgical per-node updates — no paint loop, no innerHTML). Each poll touches only
// the leaves that actually changed (see merge() — equality-gated), so a 200-node
// cluster updates a handful of DOM nodes per tick, not the whole page.
//
// Plain browser ESM (no build step) — the bridge serves it as-is.

import { $, value, render, HTML, SVG } from 'data'

const { div, span, header, main, section, h1, h2, ul, li, code, button } = HTML

// ── model: one row per node, keyed by uuid ────────────────────────────────────
const model = $({ nodes: {} })

// ── freeze: hold every panel to study a moment under churn (the live stream keeps arriving but is
// DROPPED, never buffered — so freezing can't grow memory; resuming catches up on the next event).
// `frozen` is the plain guard read by the ingest fns + samplers; `ui.frozen` drives the button visual.
let frozen = false
const ui = $({ frozen: false })

// ── surgical merge: assign only genuinely-changed leaves so the DOM updates minimally ──
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]))
const merge = (proxy, obj) => {
  const cur = proxy[value] ?? {}
  for (const k in obj) {
    if (isObj(obj[k])) {
      if (!isObj(cur[k])) proxy[k] = {}
      merge(proxy[k], obj[k])
    } else if (!same(cur[k], obj[k])) {
      proxy[k] = obj[k]
    }
  }
  // drop keys that vanished from the snapshot (a peer that left) — but keep our client-only _fields
  for (const k in cur) if (!(k in obj) && k[0] !== '_') delete proxy[k]
}

// ── ingest: SSE snapshots → the model ─────────────────────────────────────────
// First sight of a uuid is an INSERT (assign the whole object so the card is built
// with complete data before it's shown); thereafter a surgical MERGE. _rx is a
// client-side receive stamp (the bridge's clock — never a node's skewable `at`),
// driving staleness.
const ingest = (s) => {
  if (frozen) return // freeze: drop live updates (never buffer) so every panel holds the moment
  const nodes = model.nodes
  if (s.uuid in (nodes[value] ?? {})) merge(nodes[s.uuid], s)
  else nodes[s.uuid] = s
  nodes[s.uuid]._rx = Date.now()
}
// ── stream model: family [b] live data + provenance (fed by the bridge's `records` SSE) ──
// One reactive model for the contention stream. `ticker` is a bounded ring of recent
// provenance events keyed by a zero-padded client counter (insertion order ≈ arrival
// order; the CSS shows newest-first). `keys` is the live hot-keys table — the latest
// stamp per contended key path. `stats` drives the counters strip + the kind filter.
// The panel answers three questions, NOT "show me every record":
//   • is data flowing, and is it healthy?  → `rates` (writes/s, repl/s) + `stats` (forwards, CONFLICTS)
//   • what's being written, and where's contention?  → `keys` (hot working set + per-key conflict flag)
//   • what NOTABLE things happened?  → `notable` (conflicts / view / writable only — the applied/local
//     write-flow is summarised by the rates, so the log stays calm and high-signal, empty when healthy)
const stream = $({
  notable: {},
  keys: {},
  stats: { events: 0, applied: 0, local: 0, forwarded: 0, lost: 0, view: 0, writable: 0, dropped: 0 },
  rates: { writes: 0, repl: 0, conflicts: 0, rebalance: 0 },
  spark: { points: '' }, // writes/s history → a sparkline (driven by the grid interval, or by 'provagg' at scale)
  headline: '0 records', // the activity-panel header note — "N records" (grid) or "aggregated · K nodes" (blobs)
})
const rateHist = [] // plain ring of writes/s for the activity sparkline; mirrored into stream.spark for render
// A loser is EITHER expected rebalance churn (epoch-fenced: a stale-view write superseded — the
// dominant kind during a node rejoin, and NOT a problem) OR a TRUE conflict (same-epoch concurrent
// write to the same key — the real "contention now" signal). We separate them: only true conflicts
// drive the red alarm; epoch-fence churn gets its own calm metric. (See the loser investigation.)
const conflictTimes = [] // true (same-epoch) conflicts → the windowed alarm
const rebalanceTimes = [] // epoch-fenced losers → calm rebalance-churn metric
const WINDOW = 5000 // metrics answer "...NOW?", so they clear ~5s after a transient
const NOTABLE_CAP = 60
const HOT_CAP = 40 // hot keys is a RECENT working set, not every key ever written
// Hot keys use STABLE slot keys ('0'..'39') whose VALUES update in place (the displayed key is a
// field). We never delete a model key — a full slot is reused for a new key — so the keyed list
// never churns keys (delete+re-add leaves orphaned blank rows), it only updates rows in place.
const hotSlots = new Map() // key → slot id
let tick = 0
const shortId = (s) => (s ?? '').slice(0, 8) // a uuid → its first 8 hex (matches the card uuid)
const shortAddr = (a) => { const i = (a ?? '').lastIndexOf(':'); return i >= 0 ? a.slice(i) : a ?? '' } // an address → :port (the host is shared locally)
const safeKey = (k) => (k ?? '').replace(/[.\s]/g, '·') || '·root·'

// One provenance event → the counters, the hot-keys working set, and (only if notable) the event log.
const onEvent = (ev) => {
  if (frozen) return // freeze: hold the activity/hot-keys panels
  tick++
  const st = stream.stats
  const sv = st[value] // read raw counts (st[kind] is a child VIEW, not a number)
  st.events = tick
  if (ev.kind in sv) st[ev.kind] = (sv[ev.kind] ?? 0) + 1

  // classify a loser: epoch-fenced (loser's view epoch < winner's — a superseded stale-view write,
  // EXPECTED during a rejoin/rebalance) vs a TRUE conflict (same epoch, lost on seq — genuine
  // concurrent contention). Only true conflicts are alarm-worthy.
  const fenced = ev.kind === 'lost' && ev.we !== undefined && ev.epoch < ev.we
  const trueConflict = ev.kind === 'lost' && !fenced

  // hot-keys tracks WRITES + TRUE conflicts (local/forwarded/true-conflict), NOT the `won`
  // replication-echo nor epoch-fence churn — a key is "hot" because it's being written, not because
  // replication fans it out or a superseded version is re-delivered during catch-up.
  if (ev.key && (ev.kind === 'local' || ev.kind === 'forwarded' || trueConflict)) {
    const sk = ev.key
    const hk = stream.keys[value] ?? {}
    let slot = hotSlots.get(sk)
    let fresh = false
    if (slot === undefined) {
      // assign a slot: a free one while warming up, else REUSE the least-recently-touched slot
      if (hotSlots.size < HOT_CAP) slot = String(hotSlots.size)
      else {
        let lru = '0'
        let lruT = Infinity
        for (const s in hk) {
          const t = hk[s]._t ?? 0
          if (t < lruT) {
            lruT = t
            lru = s
          }
        }
        const evicted = hk[lru]?.key
        if (evicted !== undefined) hotSlots.delete(evicted) // free the old key's mapping; the slot is reused
        slot = lru
      }
      hotSlots.set(sk, slot)
      fresh = true
      if (!(slot in hk)) stream.keys[slot] = { key: sk, _n: 0, _conflict: false }
    }
    const prev = (stream.keys[value] ?? {})[slot] ?? {}
    merge(stream.keys[slot], {
      key: sk,
      origin: ev.origin,
      seq: ev.seq,
      epoch: ev.epoch,
      by: ev.by,
      kind: ev.kind,
      _t: tick,
      _n: fresh ? 1 : (prev._n ?? 0) + 1, // reset the counter when a slot is reused for a new key
      _conflict: (!fresh && prev._conflict) || trueConflict,
    })
  }

  if (trueConflict) conflictTimes.push(Date.now()) // real contention → the red alarm
  else if (fenced) rebalanceTimes.push(Date.now()) // expected churn → the calm rebalance metric

  // the event LOG carries ONLY genuinely-notable events: TRUE conflicts + membership/gate changes.
  // Epoch-fence churn is excluded (it would flood the log during every rebalance and isn't a problem).
  if (trueConflict || ev.kind === 'view' || ev.kind === 'writable' || ev.kind === 'dropped') {
    const id = String(tick).padStart(9, '0')
    ev._id = id
    stream.notable[id] = ev
    const ids = Object.keys(stream.notable[value] ?? {})
    if (ids.length > NOTABLE_CAP) {
      ids.sort()
      for (let i = 0; i < ids.length - NOTABLE_CAP; i++) delete stream.notable[ids[i]]
    }
  }
}

// per-second rates: snapshot the cumulative counters each tick and diff (writes = local+forwarded,
// repl = applied). Rates answer "is it flowing?" at a glance — far more legible than a scrolling firehose.
let lastSnap = { w: 0, r: 0 }
setInterval(() => {
  if (frozen) return // freeze: hold the rates/sparkline
  if (aggMode === 'blobs' && aggSeen) return // at scale the raw firehose is suppressed → 'provagg' drives the rates + sparkline
  const s = stream.stats[value] ?? {}
  const w = (s.local ?? 0) + (s.forwarded ?? 0)
  const r = s.applied ?? 0
  const writes = w - lastSnap.w
  stream.rates.writes = writes
  stream.rates.repl = r - lastSnap.r
  lastSnap = { w, r }
  const cut = Date.now() - WINDOW // windowed counts: prune anything older than the window
  while (conflictTimes.length && conflictTimes[0] < cut) conflictTimes.shift()
  while (rebalanceTimes.length && rebalanceTimes[0] < cut) rebalanceTimes.shift()
  stream.rates.rebalance = rebalanceTimes.length
  stream.rates.conflicts = conflictTimes.length
  rateHist.push(writes) // writes/s sparkline (same source as the bigstat, shown as a trend)
  if (rateHist.length > SPARK_CAP) rateHist.shift()
  stream.spark.points = sparkPoints(rateHist)
  stream.headline = `${s.events ?? 0} records`
}, 1000)

// ── scale tier: the bridge's compact rollup ('aggregate' SSE) ─────────────────
// Above ~24 nodes the bridge STOPS shipping per-node 'snapshot' (the O(N²)/poll wall)
// and ships only this bounded rollup — view-groups + 3-state convergence + cluster
// totals + top-K lag — so the browser renders O(groups+topK), independent of N. The
// dashboard then switches the per-node grid to view-group BLOBS and drives the
// convergence/counts/lag from `agg` instead of model.nodes. Below the threshold both
// channels coexist and grid mode renders from per-node snapshots exactly as before.
const GROUP_CAP = 24 // max distinct view-groups rendered as blobs
const LAG_CAP = 20 // top-K worst-behind nodes
const agg = $({
  mode: 'grid',
  totals: { nodes: 0, epochs: 0, writable: 0, retained: 0, behind: 0, orphans: 0, orphanNodes: 0 },
  conv: { state: 'waiting', views: 0, frac: 0, writableMajorities: 0 },
  groups: {}, // stable-slot keyed ('0'..) — values updated in place, never delete a model key (keyed-list orphan bug)
  topLag: {}, // stable-slot keyed ('0'..)
  dropped: { snapshots: 0, mode: 'grid' },
})
const summary = $({ nodes: 0, epochs: 0, writable: 0 }) // header counts, fed by whichever source `mode` selects
let aggMode = 'grid' // plain mirror for non-reactive branch logic
let aggSeen = false // received at least one rollup?
const groupSlots = new Map() // group sig → slot id
const lagSlots = new Map() // node uuid → slot id

// Map a CHANGING set of keyed items onto STABLE slot ids ('0'..cap-1) so the data keyed-list
// never deletes+re-adds a model key (which orphans blank <li>s — IDEAS.md:20). A vanished key
// frees its slot (value → {_present:false}, hidden via CSS); present items update in place.
const syncSlots = (model, slots, items, keyOf, cap) => {
  const incoming = new Map(items.map((it) => [keyOf(it), it]))
  for (const [k, slot] of [...slots]) {
    if (!incoming.has(k)) { slots.delete(k); if (slot in (model[value] ?? {})) model[slot] = { _present: false } }
  }
  const used = new Set(slots.values())
  for (const [k, it] of incoming) {
    let slot = slots.get(k)
    if (slot === undefined) {
      for (let i = 0; i < cap; i++) { const s = String(i); if (!used.has(s)) { slot = s; break } }
      if (slot === undefined) continue // more distinct than cap (rare) — dropped from view
      slots.set(k, slot); used.add(slot)
    }
    const row = { ...it, _present: true }
    if (slot in (model[value] ?? {})) merge(model[slot], row)
    else model[slot] = row
  }
}

const ingestAgg = (a) => {
  if (frozen) return // freeze: hold the blobs + heatmap + scale lag/counts
  aggMode = a.mode
  aggSeen = true
  agg.mode = a.mode
  merge(agg.totals, a.totals ?? {})
  merge(agg.conv, a.conv ?? {})
  merge(agg.dropped, a.dropped ?? {})
  syncSlots(agg.groups, groupSlots, a.groups ?? [], (g) => g.sig, GROUP_CAP)
  syncSlots(agg.topLag, lagSlots, a.topLag ?? [], (l) => l.uuid, LAG_CAP)
  updateHeat(a.cover ?? []) // key-movement heatmap rides the same rollup (cover is O(segments), shipped both modes)
}

// ── key-movement heatmap: consensus keyspace ownership + recent rebalance churn ───
// The bridge ships `cover` — the authoritative (largest) view's ownership donut resolved to owner
// ADDRESSES, one per keyspace segment — every aggregate tick. We diff successive covers: a segment
// that changed owner FLASHES (heat→1) then decays, so a rebalance reads as a wave of activity across
// the keyspace that SETTLES once ownership stabilises. Answers "did the rebalance finish, or is
// ownership still churning?" — the spatial complement to the [c] orphan line. Cells are FIXED slots
// '0'..K-1 (never deleted → no keyed-list churn). cover is O(segments) and shipped in BOTH modes, so
// the heatmap works at every scale; at war-game scale it replaces the unreadable 40k-vnode arc view.
const HEAT_DECAY = 0.5 // per aggregate (~1/s): a moved segment is bright, then ~halves each second (~3s tail)
const heat = $({ cells: {}, moves: 0, owners: 0, segments: 0, active: false })
let coverPrev = []
const heatLevel = [] // per-segment decaying heat (plain array; mirrored into heat.cells for render)
const updateHeat = (cover) => {
  if (!cover.length) return
  const matched = coverPrev.length === cover.length // skip the FIRST cover (every segment would read as "moved")
  let moves = 0
  const owners = new Set()
  for (let i = 0; i < cover.length; i++) {
    const owner = cover[i]
    if (owner) owners.add(owner)
    if (matched && coverPrev[i] !== owner) { heatLevel[i] = 1; moves++ } // owner changed → flash
    else heatLevel[i] = (heatLevel[i] ?? 0) * HEAT_DECAY // decay toward calm
    const row = { owner, color: owner ? colorOf(owner) : 'var(--panel-2)', heat: Math.round((heatLevel[i] ?? 0) * 100) / 100 }
    const cells = heat.cells[value] ?? {}
    if (String(i) in cells) merge(heat.cells[String(i)], row)
    else heat.cells[String(i)] = row
  }
  // reconcile DOWN if a later cover is shorter (defensive — today cover is always 0 or RING_SEGMENTS, so this
  // is inert; but a shorter non-zero cover would otherwise freeze orphaned cells + pin `active` true forever)
  if (heatLevel.length > cover.length) {
    const cells = heat.cells[value] ?? {}
    for (let i = cover.length; i < heatLevel.length; i++) if (String(i) in cells) merge(heat.cells[String(i)], { owner: '', color: 'var(--panel-2)', heat: 0 })
    heatLevel.length = cover.length
  }
  coverPrev = cover
  heat.moves = moves
  heat.owners = owners.size
  heat.segments = cover.length
  heat.active = moves > 0 || heatLevel.some((h) => h > 0.05) // heatLevel is now bounded to cover.length
}

// ── provenance rollup (blobs mode): the scale replacement for the raw per-record firehose ──
// At scale the bridge stops shipping raw 'records' and ships 'provagg' — per-second write/repl rates,
// windowed conflict/rebalance counts, and top-K hot keys/origins (who's writing most) — already
// reduced to O(top-K), independent of N. It drives the SAME activity rates (one binding, both modes)
// plus the blobs-only hot-keys + top-origins boards. Grid mode keeps the raw onEvent() path; this fires
// only once the firehose is suppressed.
const PROV_CAP = 12 // top-K hot keys / origins rendered at scale
const prov = $({ keys: {}, origins: {}, nodes: 0 })
const provKeySlots = new Map()
const provOriginSlots = new Map()
const provConfWin = [] // recent windows' conflict counts ({t,n}) → summed to the 5s alarm metric (matches grid semantics)
const provRebWin = []
const ingestProvAgg = (p) => {
  if (frozen) return // freeze: hold the scale rate/keys/origins boards
  aggMode = 'blobs' // provagg ONLY fires in blobs mode → become authoritative so the grid rate interval's
  aggSeen = true //    `if (aggMode === 'blobs' && aggSeen) return` trips at once (no 1-tick rate fight on the flip)
  const r = p.rates ?? {}
  stream.rates.writes = r.writes ?? 0
  stream.rates.repl = r.repl ?? 0
  const now = Date.now()
  provConfWin.push({ t: now, n: r.conflicts ?? 0 })
  provRebWin.push({ t: now, n: r.rebalance ?? 0 })
  const cut = now - WINDOW // 5s window so a transient conflict stays visible (the per-window count alone would flicker)
  while (provConfWin.length && provConfWin[0].t < cut) provConfWin.shift()
  while (provRebWin.length && provRebWin[0].t < cut) provRebWin.shift()
  stream.rates.conflicts = provConfWin.reduce((s, x) => s + x.n, 0)
  stream.rates.rebalance = provRebWin.reduce((s, x) => s + x.n, 0)
  rateHist.push(r.writes ?? 0)
  if (rateHist.length > SPARK_CAP) rateHist.shift()
  stream.spark.points = sparkPoints(rateHist)
  prov.nodes = p.nodes ?? 0
  stream.headline = `aggregated · ${p.nodes ?? 0} node${(p.nodes ?? 0) === 1 ? '' : 's'}`
  syncSlots(prov.keys, provKeySlots, p.keys ?? [], (k) => k.key, PROV_CAP)
  syncSlots(prov.origins, provOriginSlots, p.origins ?? [], (o) => o.origin, PROV_CAP)
}

const es = new EventSource('/events')
es.addEventListener('snapshot', (e) => {
  try {
    ingest(JSON.parse(e.data))
  } catch {
    /* partial frame — ignore */
  }
})
es.addEventListener('records', (e) => {
  try {
    for (const ev of JSON.parse(e.data)) onEvent(ev)
  } catch {
    /* partial frame — ignore */
  }
})
es.addEventListener('aggregate', (e) => {
  try {
    ingestAgg(JSON.parse(e.data))
  } catch {
    /* partial frame — ignore */
  }
})
es.addEventListener('provagg', (e) => {
  try {
    ingestProvAgg(JSON.parse(e.data))
  } catch {
    /* partial frame — ignore */
  }
})

// ── staleness + prune: grey a node after ~3s silent, REMOVE its card after ~15s (gone for good) ──
// The bridge stops sending snapshots for a node that left the cluster, so its _rx goes stale; we
// grey it first (a transient blip stays visible), then prune the dead card so it doesn't linger —
// and a node that restarts on a NEW uuid no longer leaves a ghost behind.
setInterval(() => {
  if (frozen) return // freeze: don't grey/evict held cards
  if (aggMode === 'blobs') return // at scale per-node snapshots are suppressed → DON'T evict (counts come from agg; evicting would collapse nodeCount to 0)
  const now = Date.now()
  const ns = model.nodes[value] ?? {}
  for (const id in ns) {
    const age = now - (ns[id]._rx ?? 0)
    if (age > 15000) delete model.nodes[id]
    else model.nodes[id]._stale = age > 3000
  }
}, 1000)

// ── convergence: group live server nodes by their committed view (epoch + members) ──
// THREE meaningful states, not a boolean (the source of truth for both the topbar pill
// and the timeline below):
//   • converged          — all live servers share one (epoch, members) view.
//   • converging (amber)  — views disagree but only ONE side is writable: the healthy
//                           case — a minority correctly went read-only on quorum loss, or
//                           a node is briefly on a stale view while it catches up (rejoin).
//   • partition (red)     — ≥2 DISTINCT views each hold a writable node: split-brain, both
//                           sides think they can write. The genuine alarm. (Time-persistence
//                           is conveyed by the timeline BAND — a blip is one segment, a real
//                           partition is a red run.)
const viewSig = (n) => `${n.epoch}|${(n.members ?? []).slice().sort().join(',')}`
const servers = (nodes) => Object.values(nodes).filter((n) => n.role === 'server' && !n._stale)
const convergence = (nodes) => {
  const live = servers(nodes)
  if (!live.length) return { state: 'waiting', label: 'waiting for nodes…', frac: 0, views: 0 }
  // group live servers by committed view; track each view's member count + whether it's writable
  const groups = new Map() // viewSig → { size, reps, writable }
  for (const n of live) {
    const s = viewSig(n)
    const g = groups.get(s) ?? { size: (n.members ?? []).length, reps: 0, writable: false }
    g.reps++ // actual live nodes ON this view (not the count it CLAIMS in members)
    if (n.writable) g.writable = true
    groups.set(s, g)
  }
  const views = groups.size
  const writableN = live.filter((n) => n.writable).length
  const frac = writableN / live.length // fraction of the cluster that can accept writes (availability)
  if (views === 1) return { state: 'converged', label: `converged · ${live.length} nodes agree`, frac, views }
  // A dangerous SIDE is a writable view that holds a MAJORITY OF ITS OWN MEMBER SET by actual node
  // count (reps > size/2) AND is a real multi-node view (size ≥ 2). That excludes BOTH a lone
  // pre-join node (size 1, writable while it boots solo — verified in the harness) AND a minority
  // still on a stale LARGER view (reps ≤ size/2). Both of those are healthy `converging`. RED is
  // reserved for ≥2 such writable majorities — genuine split-brain, both sides accepting writes.
  const writableMajorities = [...groups.values()].filter((g) => g.writable && g.size >= 2 && g.reps > g.size / 2).length
  if (writableMajorities >= 2) return { state: 'partition', label: `partition suspected · ${writableMajorities} writable majorities`, frac, views }
  return { state: 'converging', label: `converging · ${views} views · ${live.length - writableN} read-only`, frac, views }
}

// Header counts ride `summary` (updated by the convergence sampler below), so they read
// from per-node snapshots in grid mode and from the bridge rollup in blobs mode — one binding.
// The convergence pill rides the timeline's debounced state, also set in that sampler.
//
//! clusterState(): the current convergence + counts + total-behind, from whichever source `mode` selects (per-node snapshots, or the bridge rollup at scale).
const clusterState = () => {
  if (aggMode === 'blobs' && aggSeen) {
    const a = agg.conv[value] ?? {}
    const t = agg.totals[value] ?? {}
    const label =
      a.state === 'converged' ? `converged · ${t.nodes ?? 0} nodes agree`
      : a.state === 'partition' ? `partition suspected · ${a.writableMajorities ?? 0} writable majorities`
      : a.state === 'converging' ? `converging · ${a.views ?? 0} views`
      : 'waiting for nodes…'
    return { state: a.state ?? 'waiting', label, frac: a.frac ?? 0, views: a.views ?? 0, behind: t.behind ?? 0, nodes: t.nodes ?? 0, epochs: t.epochs ?? 0, writable: t.writable ?? 0 }
  }
  const c = convergence(model.nodes[value] ?? {})
  const live = servers(model.nodes[value] ?? {})
  return { ...c, behind: repl.totals.behind[value] ?? 0, nodes: live.length, epochs: new Set(live.map((s) => s.epoch)).size, writable: live.filter((s) => s.writable).length }
}

// ── building blocks ───────────────────────────────────────────────────────────
const metric = (label, v) => span.metric(span.mlabel.text(label), span.mval.text(v))
const STATUS = { 0: 'down', 1: 'connecting', 2: 'throttled', 3: 'connected' }

// stable colour per member address (hash → hue) so a node reads as the same colour
// everywhere. FNV-1a + an avalanche finalizer — without the mix, addresses that differ
// only in the last digit (…:56301 vs …:56302) hash to nearly the same hue (the same
// vnode-clustering the DHT's fmix32 guards against), so all the donut arcs look alike.
const hash32 = (s) => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return h >>> 0
}
// a curated palette of distinct, vivid hues — indexing by hash gives each owner a
// clearly different colour (vs raw hue-from-hash, where a few addresses can all land in
// one band). Consistent per address, so a node reads as the same colour on every card.
const PALETTE = ['#7dd3fc', '#fbbf24', '#f472b6', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#a3e635', '#60a5fa', '#facc15', '#c084fc']
const colorOf = (addr) => PALETTE[hash32(addr) % PALETTE.length]

//! the ownership donut as a CSS conic-gradient — collapse consecutive same-owner segments into arc stops.
const conicGradient = (ring) => {
  const cov = ring && ring.coverage
  const mem = ring && ring.members
  if (!cov || !cov.length || !mem) return 'background:#1b2230'
  const K = cov.length
  const stops = []
  for (let i = 0; i < K; ) {
    let j = i + 1
    while (j < K && cov[j] === cov[i]) j++
    const color = cov[i] >= 0 && mem[cov[i]] ? colorOf(mem[cov[i]]) : '#1b2230'
    stops.push(`${color} ${((i / K) * 360).toFixed(1)}deg ${((j / K) * 360).toFixed(1)}deg`)
    i = j
  }
  return `background: conic-gradient(from -90deg, ${stops.join(', ')})`
}

//! tooltip: each member's share of the keyspace, biggest first.
const ownershipText = (ring) => {
  const cov = ring && ring.coverage
  const mem = ring && ring.members
  if (!cov || !mem) return 'keyspace ownership'
  const counts = {}
  for (const s of cov) if (s >= 0 && mem[s]) counts[mem[s]] = (counts[mem[s]] ?? 0) + 1
  return (
    'keyspace ownership\n' +
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([a, n]) => `${a}  ${Math.round((n / cov.length) * 100)}%`)
      .join('\n')
  )
}

//! configure one node card (the keyed-list factory gets the provided `li.node_card` element).
const card = (el, node, uuid) =>
  el
    .class('stale', node._stale)
    .class('readonly', node.writable.to((w) => w === false))
    .nodes(
      div.card_head(
        span.wdot.attr('data-writable', node.writable),
        code.uuid.text(node.uuid.to((u) => (u ?? uuid).slice(0, 8))),
        span.addr.text(node.me),
        div.ownership_ring.attr('style', node.ring.to(conicGradient)).attr('title', node.ring.to(ownershipText)),
        span.role.text(node.role),
      ),
      div.card_view(
        metric('epoch', node.epoch),
        metric('members', node.members.to((m) => (m ?? []).length)),
        span.wbadge.attr('data-writable', node.writable).text(node.writable.to((w) => (w ? 'writable' : 'read-only'))),
      ),
      div.card_repl(
        metric('log', node.log.size),
        metric('marks', node.marks.to((m) => Object.keys(m ?? {}).length)),
        metric('subs', node.subscriptions),
        metric('pending', node.pending),
      ),
      div.card_peers(
        span.peers_label.text('peers'),
        div.peerdots(
          span.peerdot(node.peers, (d, peer, addr) =>
            d
              .attr('data-status', peer.status)
              .attr('data-role', peer.role)
              .attr('title', peer.status.to((s) => `${addr} · ${STATUS[s] ?? s}`)),
          ),
        ),
      ),
    )

// ── family [b]: live data + provenance/contention ─────────────────────────────
//! a big health metric — a number over a label; `alarm` turns it red the moment it goes non-zero (conflicts).
const statBig = (label, reactive, alarm) =>
  span.bigstat
    .attr('data-alarm', alarm ? reactive.to((n) => ((n ?? 0) > 0 ? 'on' : 'off')) : 'off')
    .nodes(span.bignum.text(reactive.to((n) => n ?? 0)), span.biglabel.text(label))

//! one NOTABLE-event row (conflict / membership / gate) — immutable, so read its raw snapshot once and build a plain-English line.
const notableRow = (el, ev) => {
  const e = ev[value]
  const label =
    e.kind === 'view'
      ? `view changed → ${e.members} members`
      : e.kind === 'writable'
        ? `write-gate ${e.writable ? 'OPENED (quorum)' : 'CLOSED (no quorum)'}`
        : e.kind === 'lost'
          ? `conflict on ${e.key || '·root·'} — concurrent write (same epoch)`
          : `duplicate dropped — ${e.key || '·root·'}`
  const meta =
    e.kind === 'view' || e.kind === 'writable' ? `@ ${shortAddr(e.by)}` : `${shortId(e.origin)} → ${shortAddr(e.by)} · #${e.seq} · e${e.epoch}`
  return el.attr('data-kind', e.kind).nodes(span.rk.text(e.kind), span.rkey.text(label), span.rmeta.text(meta))
}

//! one hot-key row — the latest stamp per key + a write counter, flagged red once it has seen a conflict.
const hotRow = (el, row) =>
  el
    .attr('data-kind', row.kind)
    .class('conflict', row._conflict.to((c) => c === true))
    .nodes(
      span.hk_dot.attr('data-kind', row.to((r) => (r._conflict ? 'lost' : r.kind))),
      span.hkey.text(row.key),
      span.hmeta.text(row.to((r) => `${shortId(r.origin)} · #${r.seq} · e${r.epoch}`)),
      span.hn.text(row._n.to((n) => `×${n ?? 1}`)),
    )

//! one SCALE hot-key row — top-K by write count over the window; CSS `order:-n` floats the hottest up (the aggregated form of the grid hot-keys list).
const provKeyRow = (el, row) =>
  el
    .attr('data-present', row.to((r) => (r && r._present === false ? 'no' : 'yes')))
    .attr('style', row.n.to((n) => `order:${-(n ?? 0)}`))
    .nodes(
      span.hk_dot.attr('data-kind', 'local'),
      span.hkey.text(row.key),
      span.hn.text(row.n.to((n) => `×${n ?? 0}`)),
    )

//! one busiest-owner row — top-K committing nodes over the window. `origin` is the node that SEQUENCED the
//! write (the partition owner — a forwarded write is restamped origin=owner at commit), so this surfaces the
//! hottest partition/owner (a write hotspot to investigate), NOT the user-facing caller.
const provOriginRow = (el, row) =>
  el
    .attr('data-present', row.to((r) => (r && r._present === false ? 'no' : 'yes')))
    .attr('style', row.n.to((n) => `order:${-(n ?? 0)}`))
    .nodes(
      code.luuid.text(row.origin.to((o) => (o ?? '').slice(0, 8))),
      span.hn.text(row.n.to((n) => `×${n ?? 0}`)),
    )

//! one heatmap cell — a keyspace segment coloured by its owner; the white overlay (--heat) flashes on an owner change then decays, so a rebalance reads as a wave settling.
const heatCell = (el, c) =>
  el.attr('style', c.to((x) => (x ? `--c:${x.color};--heat:${x.heat ?? 0}` : '--c:var(--panel-2);--heat:0')))

// ── family [c]: replication health ────────────────────────────────────────────
// "Is replication keeping up, and is anything stuck behind?" Built ENTIRELY from the
// polled __inspect snapshot already in `model.nodes` (marks / log.size / orphans) —
// NO new server instrumentation, NO push stream, no second sink. Two questions, each
// tied to an ACTION (not a firehose):
//   • lag leaderboard  → which node is NOT catching up? (did the partition actually heal?)
//   • log-growth spark → is the log growing unbounded? (the compaction trigger — and the
//                         proof it worked: the line flattens once compaction lands)
// Orphans are the rebalance-in-flight signal (held-but-unowned partitions, shedding —
// transient & safe), surfaced calm-by-default.
const SPARK_CAP = 60 // ~1 min of cluster-total log-size history at 1 sample/s
const repl = $({
  lag: {}, // keyed by uuid — per-node "records behind the frontier" + a normalised bar
  totals: { retained: 0, peak: 0, behind: 0, nodes: 0, orphans: 0, orphanNodes: 0 },
  spark: { points: '' }, // the SVG polyline points for the cluster-total log-size trend
})
const sparkHist = [] // plain client ring of cluster-total log.size; mirrored into repl.spark for render

//! a value series → an SVG polyline points string. Auto-scales to its own max, unless fixedMax is given (e.g. 100 for a 0–100% axis).
const sparkPoints = (vals, w = 100, h = 26, fixedMax) => {
  if (vals.length < 2) return ''
  let max = fixedMax ?? 1
  if (fixedMax === undefined) for (const v of vals) if (v > max) max = v
  const step = w / (vals.length - 1)
  let out = ''
  for (let i = 0; i < vals.length; i++) out += `${(i * step).toFixed(1)},${(h - 1 - (Math.min(vals[i], max) / max) * (h - 2)).toFixed(1)} `
  return out.trim()
}

//! seconds → a compact "4m 12s" / "8s" duration (the convergence-stability headline).
const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`)

// Recompute once per second from the polled snapshots (same cadence as the poll). The lag
// metric is each node's deficit vs the cluster FRONTIER (the max high-water per seenKey).
// A seenKey is `origin` under full replication, `origin\x00partition` when scoped — so a
// MISSING key means "behind" under full replication (the node SHOULD hold every origin) but
// "not responsible for that partition" under scoped — we skip missing keys when scoped to
// avoid false-flagging a node that simply doesn't own that slice.
setInterval(() => {
  if (frozen) return // freeze: hold the catch-up board + log-growth spark
  // blobs mode: the bridge already computed top-K lag (rendered from agg.topLag) + cluster
  // totals — mirror the totals + drive the log-growth sparkline from agg, and skip the
  // O(N·origins) per-node frontier math (model.nodes is stale at scale, snapshots suppressed).
  if (aggMode === 'blobs' && aggSeen) {
    const t = agg.totals[value] ?? {}
    const tot = repl.totals
    tot.retained = t.retained ?? 0
    if ((t.retained ?? 0) > (tot.peak[value] ?? 0)) tot.peak = t.retained
    tot.behind = t.behind ?? 0
    tot.nodes = t.nodes ?? 0
    tot.orphans = t.orphans ?? 0
    tot.orphanNodes = t.orphanNodes ?? 0
    sparkHist.push(t.retained ?? 0)
    if (sparkHist.length > SPARK_CAP) sparkHist.shift()
    repl.spark.points = sparkPoints(sparkHist)
    return
  }
  const ns = model.nodes[value] ?? {}
  const live = Object.values(ns).filter((n) => n.role === 'server' && !n._stale && n.uuid)
  if (!live.length) return
  // Frontier over LIVE origins only. A seenKey is `origin` (full repl) or `origin\0partition`
  // (scoped); the origin is the WRITER's uuid. Every kill+restart mints a NEW uuid, so a
  // long-churned cluster accumulates DEAD origins whose history is never reclaimed (no
  // compaction). Counting that debris as "node X is behind" is misleading — it's orphaned
  // history, not live traffic a node is missing. So we exclude marks from origins that are
  // no longer a live member: catch-up lag then measures only LIVE-traffic deficit (drains in
  // seconds), while the dead-origin bloat shows where it belongs — the log-growth sparkline.
  const liveUuids = new Set(live.map((n) => n.uuid))
  const isLiveOrigin = (k) => liveUuids.has(k.split('\x00')[0])
  const frontier = {}
  for (const n of live) {
    const m = n.marks ?? {}
    for (const k in m) if (isLiveOrigin(k) && (m[k] ?? 0) > (frontier[k] ?? 0)) frontier[k] = m[k]
  }
  const scoped = live.some((n) => n.ring && n.ring.scoped)
  const lagOf = (n) => {
    const m = n.marks ?? {}
    let b = 0
    for (const k in frontier) {
      const mine = m[k]
      if (mine === undefined) { if (!scoped) b += frontier[k] } // missing origin under FULL repl = fully behind
      else if (frontier[k] > mine) b += frontier[k] - mine
    }
    return b
  }
  // pass 1a: raw lag (vs the absolute frontier) per node
  const behinds = new Map()
  for (const n of live) behinds.set(n.uuid, lagOf(n))
  // floor = the most-caught-up node's lag. A replica ALWAYS trails its owner by the in-flight pipeline
  // depth — across many partitions that sums to hundreds, roughly UNIFORM across nodes, and it is
  // healthy, NOT a stall. So we measure each node RELATIVE to the leader: a uniformly-trailing cluster
  // reads "caught up", and only a genuine OUTLIER (a draining rejoin, a stuck node) fills a bar. (A
  // GLOBAL replication stall — everyone trailing the owners together — shows instead in the log-growth
  // sparkline climbing + replication/s dropping; that blind spot is covered by those signals, not here.)
  let floor = Infinity
  for (const b of behinds.values()) if (b < floor) floor = b
  if (!Number.isFinite(floor)) floor = 0
  const writeRate = (stream.rates[value] ?? {}).writes ?? 0
  const tol = Math.max(8, writeRate) // small jitter margin above the floor, scaled to the write rate
  // pass 1b: gap-to-leader + excess (gap beyond the jitter margin) + cluster aggregates
  let worst = 0, excessAll = 0, retained = 0, orphanParts = 0, orphanNodes = 0
  const liveIds = new Set()
  const gaps = new Map()
  const excesses = new Map()
  for (const n of live) {
    const gap = Math.max(0, behinds.get(n.uuid) - floor)
    const ex = gap > tol ? gap : 0
    gaps.set(n.uuid, gap)
    excesses.set(n.uuid, ex)
    if (ex > worst) worst = ex
    excessAll += ex
    retained += (n.log && n.log.size) || 0
    const o = (n.orphans ?? []).length
    if (o) { orphanParts += o; orphanNodes++ }
    liveIds.add(n.uuid)
  }
  // pass 2: write rows (insert-or-merge so only changed leaves touch the DOM; prune departed uuids —
  // safe because a restarted node returns under a NEW uuid, never re-adding the same key)
  for (const n of live) {
    const row = {
      uuid: n.uuid, addr: n.me,
      behind: gaps.get(n.uuid), excess: excesses.get(n.uuid), // behind = records behind the LEADER (not the absolute frontier)
      bar: worst ? excesses.get(n.uuid) / worst : 0,
      logSize: (n.log && n.log.size) || 0,
    }
    const cur = repl.lag[value] ?? {}
    if (n.uuid in cur) merge(repl.lag[n.uuid], row)
    else repl.lag[n.uuid] = row
  }
  const curLag = repl.lag[value] ?? {}
  for (const id in curLag) if (!liveIds.has(id)) delete repl.lag[id]
  // log-growth sparkline + totals
  sparkHist.push(retained)
  if (sparkHist.length > SPARK_CAP) sparkHist.shift()
  repl.spark.points = sparkPoints(sparkHist)
  const t = repl.totals
  t.retained = retained
  if (retained > (t.peak ?? 0)) t.peak = retained
  t.behind = excessAll // real backlog beyond pipeline depth (0 in steady state → the calm "caught up" state)
  t.nodes = live.length
  t.orphans = orphanParts
  t.orphanNodes = orphanNodes
}, 1000)

const fmt = (n) => (n ?? 0).toLocaleString() // thousands separators for the record counts

//! one lag-leaderboard row — a node's backlog beyond pipeline depth; CSS `order` floats the worst to the top, green when caught up.
const lagRow = (el, row) =>
  el
    .attr('data-present', row.to((r) => (r && r._present === false ? 'no' : 'yes'))) // top-K slots vacated as nodes drain (blobs mode); grid rows have no _present → shown
    .attr('style', row.excess.to((e) => `order:${-(e ?? 0)}`)) // worst catch-up = smallest order = top, without churning DOM keys
    .class('caught', row.excess.to((e) => (e ?? 0) === 0))
    .nodes(
      code.luuid.text(row.uuid.to((u) => (u ?? '').slice(0, 8))),
      div.lagbar(div.lagfill.attr('style', row.bar.to((f) => `width:${Math.round((f ?? 0) * 100)}%`))),
      span.lagval.text(row.to((r) => (!r || (r.excess ?? 0) === 0 ? 'caught up' : `${fmt(r.behind)} behind`))),
    )

// ── convergence timeline ──────────────────────────────────────────────────────
// The topbar pill is the instantaneous "are we converged NOW?" — this is its HISTORY.
// An incident is a narrative (partition opens → minority read-only → heal → reconverge);
// the timeline records it so you can see WHEN divergence began, HOW LONG it lasted, and
// the SHAPE of the heal — and scrub back to any moment. Same source as [c] (sampled from
// model.nodes once a second into a ring); the bridge-buffered version is the scale tier.
const TL_CAP = 150 // ~2½ min of history at 1 sample/s (drop-oldest ring)
const timeline = $({
  samples: {}, // ring slot → { seq, state, views, frac, behind } — CSS `order:seq` lays them out in time order
  now: { state: 'waiting', dur: '0s', label: 'waiting for nodes…' },
  wspark: { points: '' }, // writable-fraction (availability) over the same window, fixed 0–100% axis
  scrub: { active: false, seq: -1, ago: '', state: '', views: 0, frac: 0, behind: 0 }, // the hovered/pinned moment's detail
})
let tlSeq = 0
let tlState = null // last DISPLAYED state — to time how long the CURRENT state has held
let tlSince = 0
const fracHist = [] // time-ordered writable-fraction (%) for the sparkline
// Debounce the partition alarm. A kill+restart briefly creates ≥2 writable views (the
// restarting node boots solo before it joins the committed view), which is NOT split-brain.
// The plan's rule: partition-suspected requires PERSISTENCE. So a raw dual-writable-view
// shows as `converging` (amber) until it has held PARTITION_PERSIST samples, then escalates
// to `partition` (red). A real split-brain persists and goes red; a rejoin blip stays amber.
const PARTITION_PERSIST = 3
let rawPartitionStreak = 0

// ── alerts: the operational layer — ACTIVE, actionable alarms with how long each has held ──
// Not a fifth firehose: a small FIXED set of conditions, each tied to an action, each surfaced only
// while it's true and only once it's earned (persistence where a transient would be noise). Derived
// from signals already computed (convergence state, writable fraction, conflict rate, total-behind) —
// no new data. Deliberately NO log-growth alarm yet: without compaction the log always climbs under
// load, so that alarm would be permanently on (false) — it lands with compaction (see IDEAS).
const ALERT_DEFS = ['partition', 'quorum', 'stalled', 'conflicts'] // fixed keys → the keyed list never delete-orphans
// Persistence is counted in OBSERVED 1 Hz samples, NOT wall-clock: the sampler only ticks while live
// (it early-returns when frozen, and the browser throttles a backgrounded tab), so a wall-clock "8s
// elapsed" would inflate across a freeze/throttle gap and false-fire on resume. Ticks ≈ seconds.
const STALL_TICKS = 8 // samples with total-behind > 0 before it's "lagging" (a healthy rejoin drains in fewer)
const QUORUM_TICKS = 3 // samples with writable-fraction 0 before "quorum lost" (else cluster FORMATION — all nodes boot read-only until quorum commits — flashes a false outage)
const alerts = $({ items: {}, count: 0, worst: 'ok' })
const alertTicks = {} // alert type → consecutive ticks it's been active (drives the duration readout; freeze/throttle-immune)
let behindTicks = 0 // consecutive observed samples with total-behind > 0 — the stall persistence counter
let quorumTicks = 0 // consecutive observed samples with writable-fraction 0 — the quorum-loss persistence counter

setInterval(() => {
  if (frozen) return // freeze: hold the timeline, pill, counts + alerts
  const c = clusterState() // per-node snapshots in grid mode, the bridge rollup in blobs mode
  tlSeq++
  // debounce raw 'partition' → escalate only after it persists
  let state = c.state
  let label = c.label
  if (c.state === 'partition') {
    rawPartitionStreak++
    if (rawPartitionStreak < PARTITION_PERSIST) { state = 'converging'; label = `converging · ${c.views} views` }
  } else rawPartitionStreak = 0
  if (state !== tlState) { tlState = state; tlSince = tlSeq } // state changed → reset the stability timer
  // push the sample into the ring (overwrite slot seq%CAP; CSS order=seq keeps time order despite wrap)
  const slot = String(tlSeq % TL_CAP)
  const sample = { seq: tlSeq, state, views: c.views, frac: c.frac, behind: c.behind }
  const cur = timeline.samples[value] ?? {}
  if (slot in cur) merge(timeline.samples[slot], sample)
  else timeline.samples[slot] = sample
  // availability sparkline (writable fraction, fixed 0–100% so a dip reads as a real drop, not auto-rescaled)
  fracHist.push(c.frac * 100)
  if (fracHist.length > TL_CAP) fracHist.shift()
  timeline.wspark.points = sparkPoints(fracHist, 100, 20, 100)
  // headline: current state + how long it's held (convergence stability / time-to-heal)
  timeline.now.state = state
  timeline.now.label = label
  timeline.now.dur = fmtDur(tlSeq - tlSince)
  // header counts (one binding, both modes)
  summary.nodes = c.nodes
  summary.epochs = c.epochs
  summary.writable = c.writable

  // ── evaluate the active alerts (uses the DEBOUNCED `state`, so a rejoin blip never raises a partition alarm) ──
  const conflicts = (stream.rates[value] ?? {}).conflicts ?? 0
  behindTicks = (c.behind ?? 0) > 0 ? behindTicks + 1 : 0 // count observed behind-samples; reset the instant it drains
  const stalled = behindTicks >= STALL_TICKS // behind that PERSISTS across enough live samples = not catching up
  // quorum loss must PERSIST too — a forming/churning cluster is momentarily all-read-only, which is not an outage
  const noWriter = (c.frac ?? 1) === 0 && (c.nodes ?? 0) > 0
  quorumTicks = noWriter ? quorumTicks + 1 : 0
  const quorumDown = quorumTicks >= QUORUM_TICKS
  const active = {
    partition: state === 'partition' ? { sev: 'crit', msg: `split-brain — ${c.views} writable views accepting writes` } : null,
    quorum: quorumDown ? { sev: 'crit', msg: 'quorum lost — no node can accept writes' } : null,
    stalled: stalled ? { sev: 'warn', msg: `catch-up lagging — ${fmt(c.behind)} records behind for >${STALL_TICKS}s` } : null,
    conflicts: conflicts > 0 ? { sev: 'warn', msg: `${conflicts} conflict${conflicts === 1 ? '' : 's'} — concurrent writes (last 5s)` } : null,
  }
  let count = 0
  let worst = 'ok'
  const items = alerts.items[value] ?? {}
  for (const type of ALERT_DEFS) {
    const a = active[type]
    if (a) {
      alertTicks[type] = (alertTicks[type] ?? 0) + 1 // tick-counted duration → immune to freeze / tab-throttle gaps
      count++
      worst = a.sev === 'crit' ? 'crit' : worst === 'crit' ? 'crit' : 'warn'
      const row = { type, sev: a.sev, msg: a.msg, dur: fmtDur(alertTicks[type]), order: a.sev === 'crit' ? 0 : 1, _present: true }
      if (type in items) merge(alerts.items[type], row)
      else alerts.items[type] = row
    } else {
      alertTicks[type] = 0 // resolved → reset its clock
      // REPLACE the slot (not merge a partial — surgical merge would delete the non-_ fields and the
      // bindings would hit undefined); the keyed list updates the value in place, no delete+re-add orphan.
      if (type in items) alerts.items[type] = { _present: false }
    }
  }
  alerts.count = count
  alerts.worst = worst
}, 1000)

//! one timeline segment — a state-coloured tick; CSS `order:seq` places it in time order; data-seq lets the delegated scrub handler look up the sample.
const tlSeg = (el, s) =>
  el
    .attr('data-state', s.state)
    .attr('data-seq', s.seq)
    .attr('style', s.seq.to((q) => `order:${q ?? 0}`))

//! one view-group BLOB — a circle sized by node count, coloured by its majority owner; a partition shows as ≥2 blobs. The scale replacement for the 200-dot grid. Hidden when its slot is vacant.
const blobDiam = (reps) => Math.round(Math.min(190, 48 + Math.sqrt(reps || 1) * 20)) // area-ish scaling so big groups don't dominate
const blobRow = (el, g) =>
  el
    .attr('data-present', g.to((x) => (x && x._present !== false ? 'yes' : 'no')))
    .attr('data-writable', g.to((x) => (x && x.writable ? 'yes' : 'no')))
    .attr('data-majority', g.to((x) => (x && x.majority ? 'yes' : 'no')))
    .attr('style', g.to((x) => (x ? `--blob:${x.members && x.members[0] ? colorOf(x.members[0]) : '#475569'};--d:${blobDiam(x.reps)}px;order:${-(x.reps ?? 0)}` : '')))
    .attr('title', g.to((x) => (x && x._present !== false ? `${x.reps} node${x.reps === 1 ? '' : 's'} · view of ${x.size} members · ${x.writable ? 'writable' : 'read-only'}${x.majority ? ' · majority' : ''}` : '')))
    .nodes(
      span.blob_n.text(g.to((x) => (x ? (x.reps ?? 0) : 0))),
      span.blob_meta.text(g.to((x) => (x ? (x.writable ? 'writable' : 'read-only') : ''))),
    )

//! one alert row — a severity dot + the actionable message + how long it's held; CSS `order` floats criticals first; hidden when its condition clears.
// Every binding reads the WHOLE value with a guard (the resolved-alert slot is replaced by {_present:false},
// so per-leaf access would hit undefined) — mirrors the lag/blob row factories.
const alertRow = (el, a) =>
  el
    .attr('data-present', a.to((x) => (x && x._present !== false ? 'yes' : 'no')))
    .attr('data-sev', a.to((x) => (x && x.sev) || 'warn'))
    .attr('style', a.to((x) => `order:${x && x.order != null ? x.order : 9}`))
    .nodes(
      span.alert_dot,
      span.alert_msg.text(a.to((x) => (x && x._present !== false ? x.msg : ''))),
      span.alert_dur.text(a.to((x) => (x && x._present !== false ? x.dur : ''))),
    )

// ── the page ──────────────────────────────────────────────────────────────────
render(
  document.getElementById('app'),
  main.app.attr('data-mode', agg.mode).attr('data-frozen', ui.frozen.to((f) => (f ? 'yes' : 'no'))).nodes( // data-mode = grid | blobs → CSS toggles the per-node grid vs view-group blobs
    header.topbar(
      h1.brand(span.brand_name.text('fero'), span.brand_dim.text('observe')),
      span.conv_pill.attr('data-state', timeline.now.state).text(timeline.now.label), // shares the timeline's debounced state
      span.counts(metric('nodes', summary.nodes), metric('epochs', summary.epochs), metric('writable', summary.writable)),
      // freeze: hold every panel to study a moment under churn (click again to go live)
      button.freeze_btn
        .attr('data-frozen', ui.frozen.to((f) => (f ? 'yes' : 'no')))
        .text(ui.frozen.to((f) => (f ? '▶ live' : '⏸ freeze'))),
    ),
    // ── alerts: active, actionable alarms with duration (the operational monitoring layer) ──
    section.alerts.attr('data-worst', alerts.worst).attr('data-any', alerts.to((a) => ((a.count ?? 0) > 0 ? 'yes' : 'no'))).nodes(
      span.alerts_head.text(alerts.to((a) => ((a.count ?? 0) > 0 ? `${a.count} active alert${a.count === 1 ? '' : 's'}` : '✓ all clear'))),
      ul.alertlist(li.arow(alerts.items, (el, a) => alertRow(el, a))),
    ),
    // ── convergence timeline — the history behind the topbar pill ──
    section.convtimeline(
      div.panel.tl_panel(
        div.panel_head(
          h2.panel_title.text('convergence'),
          span.tl_now.attr('data-state', timeline.now.state).text(timeline.now.to((n) => `${n.state} · ${n.dur}`)),
          span.tl_scrub
            .attr('data-active', timeline.scrub.active.to((a) => (a ? 'yes' : 'no')))
            .text(
              timeline.scrub.to((s) =>
                s.active
                  ? `◂ ${s.ago} · ${s.state} · ${s.views} view${s.views === 1 ? '' : 's'} · ${Math.round((s.frac ?? 0) * 100)}% writable · ${fmt(s.behind)} behind`
                  : 'last ~2½ min · hover to scrub · click to pin',
              ),
            ),
        ),
        div.tlband(div.tlseg(timeline.samples, (el, s) => tlSeg(el, s))),
        div.tlfoot(
          span.tl_legend(
            span.tl_key.attr('data-state', 'converged').text('converged'),
            span.tl_key.attr('data-state', 'converging').text('converging'),
            span.tl_key.attr('data-state', 'partition').text('partition'),
          ),
          div.wspark(
            span.wspark_label.text('writable %'),
            SVG.svg
              .attr('class', 'spark')
              .attr('viewBox', '0 0 100 20')
              .attr('preserveAspectRatio', 'none')
              .nodes(SVG.polyline.attr('class', 'sparkline wsparkline').attr('points', timeline.wspark.points)),
          ),
        ),
      ),
    ),
    // ── key-movement heatmap — cluster consensus ownership + rebalance churn (both modes) ──
    section.heatmap.attr('data-active', heat.active.to((a) => (a ? 'yes' : 'no'))).nodes(
      div.hm_head(
        span.hm_title.text('keyspace ownership'),
        span.hm_dim.text(heat.to((h) => `${h.owners ?? 0} owner${(h.owners ?? 0) === 1 ? '' : 's'} · ${h.segments ?? 0} segments`)),
        span.hm_move
          .attr('data-active', heat.active.to((a) => (a ? 'yes' : 'no')))
          .text(heat.to((h) => ((h.moves ?? 0) > 0 ? `⟳ ${h.moves} segment${h.moves === 1 ? '' : 's'} moving` : 'ownership stable'))),
      ),
      div.hmstrip(div.hmcell(heat.cells, (el, c) => heatCell(el, c))),
    ),
    section.grid(ul.cards(li.node_card(model.nodes, (el, node, uuid) => card(el, node, uuid)))),
    // ── scale tier: view-group BLOBS (shown in blobs mode; the per-node grid above is hidden) ──
    section.blobgrid.attr('data-state', agg.conv.state).nodes(
      div.blob_head(
        span.blob_title.text('cluster views'),
        span.blob_dim.text(agg.to((a) => `${a.totals?.nodes ?? 0} nodes · ${a.conv?.views ?? 0} view${(a.conv?.views ?? 0) === 1 ? '' : 's'}`)),
        span.blob_note.text(agg.dropped.to((d) => ((d.snapshots ?? 0) > 0 ? `per-node cards aggregated at scale (${d.snapshots} nodes)` : ''))),
      ),
      ul.blobs(li.blob(agg.groups, (el, g) => blobRow(el, g))),
    ),
    section.streams(
      div.panel(
        div.panel_head(h2.panel_title.text('activity'), span.panel_dim.text(stream.headline)),
        div.metrics(
          statBig('writes/s', stream.rates.writes),
          statBig('replication/s', stream.rates.repl),
          statBig('rebalance (5s)', stream.rates.rebalance), // epoch-fenced losers — expected churn during a rejoin
          statBig('conflicts (5s)', stream.rates.conflicts, true), // TRUE same-epoch contention — the only red alarm
        ),
        // writes/s trend — "is throughput steady, or spiking/stalling?" (same source as the bigstat, shown over time)
        div.ratespark(
          span.ratespark_label.text('writes/s'),
          SVG.svg
            .attr('class', 'spark')
            .attr('viewBox', '0 0 100 22')
            .attr('preserveAspectRatio', 'none')
            .nodes(SVG.polyline.attr('class', 'sparkline').attr('points', stream.spark.points)),
        ),
        // grid mode: the calm notable-events log (conflicts / membership / gate). blobs mode: the top-K
        // busiest OWNERS (committing nodes / hot partitions) — since the raw firehose is aggregated away at scale.
        div.notable_bar.notable_grid(span.notable_title.text('notable events'), span.notable_hint.text('conflicts · membership · write-gate')),
        ul.notable.notable_grid(li.nrow(stream.notable, (el, ev) => notableRow(el, ev))),
        div.notable_empty.notable_grid
          .attr('data-empty', stream.notable.to((n) => (Object.keys(n ?? {}).length === 0 ? 'yes' : 'no')))
          .text('✓ converged — no conflicts or membership changes'),
        div.notable_bar.origins_scale(span.notable_title.text('busiest owners'), span.notable_hint.text('most writes committed (by sequencer)')),
        ul.originsboard.origins_scale(li.orow(prov.origins, (el, row) => provOriginRow(el, row))),
      ),
      div.panel(
        div.panel_head(
          h2.panel_title.text('hot keys'),
          span.panel_dim.hotkeys_grid.text(stream.keys.to((k) => `${Object.keys(k ?? {}).length} active`)),
          span.panel_dim.hotkeys_scale.text(prov.keys.to((k) => `top ${Object.values(k ?? {}).filter((r) => r && r._present !== false).length}`)),
        ),
        // grid mode: per-key latest stamp + write count (LRU working set). blobs mode: top-K by write rate.
        ul.hotkeys.hotkeys_grid(li.hrow(stream.keys, (el, row) => hotRow(el, row))),
        ul.hotkeys.hotkeys_scale(li.krow(prov.keys, (el, row) => provKeyRow(el, row))),
      ),
    ),
    // ── family [c]: replication health — "is anything stuck behind, and is the log growing?" ──
    section.replication(
      div.panel.repl_panel(
        div.panel_head(
          h2.panel_title.text('catch-up'),
          span.panel_dim.text(repl.totals.behind.to((b) => ((b ?? 0) === 0 ? 'all caught up' : `${fmt(b)} records behind`))),
        ),
        // grid mode: per-node lag (≤ threshold). blobs mode: the bridge's pre-ranked top-K. CSS shows one.
        ul.lagboard.lagboard_grid(li.lrow(repl.lag, (el, row) => lagRow(el, row))),
        ul.lagboard.lagboard_scale(li.lrow(agg.topLag, (el, row) => lagRow(el, row))),
        div.lag_empty
          .attr('data-empty', repl.totals.behind.to((b) => ((b ?? 0) === 0 ? 'yes' : 'no')))
          .text('✓ every node is at the replication frontier'),
      ),
      div.panel.repl_panel(
        div.panel_head(
          h2.panel_title.text('log growth'),
          span.panel_dim.text(repl.totals.retained.to((r) => `${fmt(r)} records retained`)),
        ),
        div.sparkwrap(
          SVG.svg
            .attr('class', 'spark')
            .attr('viewBox', '0 0 100 26')
            .attr('preserveAspectRatio', 'none')
            .nodes(SVG.polyline.attr('class', 'sparkline').attr('points', repl.spark.points)),
        ),
        div.spark_meta(
          metric('now', repl.totals.retained.to(fmt)),
          metric('peak', repl.totals.peak.to(fmt)),
          metric('nodes', repl.totals.nodes),
        ),
        div.orphan_line
          .attr('data-orphans', repl.totals.orphans.to((o) => ((o ?? 0) > 0 ? 'yes' : 'no')))
          .text(
            repl.totals.to((t) =>
              (t.orphans ?? 0) > 0
                ? `⟳ ${t.orphans} orphan partition${t.orphans === 1 ? '' : 's'} on ${t.orphanNodes} node${t.orphanNodes === 1 ? '' : 's'} — rebalancing (safe, shedding)`
                : '✓ ownership stable — no orphan partitions',
            ),
          ),
      ),
    ),
  ),
)

// ── timeline scrub: hover a segment to read that moment's convergence state; click to PIN it ──
// One DELEGATED listener on the band (segments come and go as the ring fills, so per-segment
// handlers would churn). The hovered/pinned sample feeds timeline.scrub → the header readout.
const tlband = document.querySelector('.tlband')
let scrubPinned = false
let focusSeq = -1
const tlHighlight = () => {
  if (!tlband) return
  for (const seg of tlband.querySelectorAll('.tlseg')) seg.classList.toggle('focus', +seg.getAttribute('data-seq') === focusSeq)
}
const tlScrubTo = (seq) => {
  const s = (timeline.samples[value] ?? {})[String(seq % TL_CAP)]
  if (!s || s.seq !== seq) return // the slot has since been overwritten (scrolled off the window)
  const sc = timeline.scrub
  sc.ago = `${tlSeq - seq}s ago`; sc.state = s.state; sc.views = s.views; sc.frac = s.frac; sc.behind = s.behind; sc.seq = seq; sc.active = true
  focusSeq = seq
  tlHighlight()
}
const tlScrubOff = () => { timeline.scrub.active = false; timeline.scrub.seq = -1; focusSeq = -1; tlHighlight() }
if (tlband) {
  tlband.addEventListener('mousemove', (e) => {
    if (scrubPinned) return
    const seg = e.target.closest('.tlseg')
    if (seg) tlScrubTo(+seg.getAttribute('data-seq'))
  })
  tlband.addEventListener('mouseleave', () => { if (!scrubPinned) tlScrubOff() })
  tlband.addEventListener('click', (e) => {
    const seg = e.target.closest('.tlseg')
    if (!seg) return
    const seq = +seg.getAttribute('data-seq')
    if (scrubPinned && seq === focusSeq) { scrubPinned = false; tlScrubOff() } // click the pinned one again → unpin
    else { scrubPinned = true; tlScrubTo(seq) } // pin this moment (stays while you read it)
  })
}

// ── freeze toggle: flip the `frozen` guard the ingest fns + samplers read; live updates are dropped while held ──
const freezeBtn = document.querySelector('.freeze-btn')
if (freezeBtn) freezeBtn.addEventListener('click', () => { frozen = !frozen; ui.frozen = frozen })
