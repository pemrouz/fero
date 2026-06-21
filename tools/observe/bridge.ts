//! L4 observer bridge: pull per-node snapshots from a cluster and relay them to browsers over SSE — the TCP→browser hop.
// tools/observe/bridge.ts — the observer bridge (see ../../plan.md L4 §3.5).
//
// A browser can't be a fero peer (the transport is TCP / node:net), and a plain
// read-only client can't see a server's internals. The bridge resolves both: it
// PULLS each node's InspectSnapshot (over the wire, or in-process) and RELAYS them
// to the browser over Server-Sent Events — a one-way, zero-dependency push that
// EventSource speaks natively.
//
// The bridge is decoupled from HOW snapshots are obtained via a pluggable `Source`:
//   • networkSource — dials a running cluster as a read-only mesh client and calls
//     each server's gated `__inspect` method. The production / real-VM path. Its
//     footprint is O(N) connections, spread one-per-node.
//   • inProcessSource — for harness war games: reads each in-process node's
//     [diagnostics].snapshot() DIRECTLY. Zero added connections, zero perturbation
//     of the cluster under test, and an omniscient view a real observer can't have
//     during a partition.
// Both yield the SAME InspectSnapshot keyed by uuid, so the SSE/dashboard downstream
// is identical — only the source adapter differs (the gather adapter for thousands
// of nodes drops in here later; see ../../IDEAS.md).

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize, sep } from 'node:path'
import { transport, STATUS } from '../../transport/index.ts'
import { diagnostics, type Fero } from '../../resource/index.ts'
import type { InspectSnapshot } from '../../resource/inspect.ts'
import type { ProvRecord } from '../../resource/observe.ts'
import type { ChangeRecord } from '../../transport/message.ts'
import { foldLive, foldOutcomes } from '../debug/export.ts'
import type { DHT } from '../../transport/dht.ts'

//! ProvEvent: a flattened provenance record the bridge relays, tagged with `by` (the address of the node that observed it).
export type ProvEvent = ProvRecord & { by: string }
import { value } from '../../../data/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, 'web') //! the static dashboard lives here (Slice 1+; a placeholder serves before it exists)
//! The promoted debug viewer (tree.html + shape.js + sample), served same-origin at /debug/ so it can EventSource the bridge's /events live feed. [P5]
const DEBUG_WEB = join(HERE, '..', 'debug', 'mockups')
//! The sibling `data` lib's built ESM, mounted at /vendor/data/ so the browser dashboard can `import 'data'` (dist lives OUTSIDE the web root).
const DATA_DIST = join(HERE, '..', '..', '..', 'data', 'dist')

//! Source: the pluggable snapshot supplier — `targets()` lists reachable nodes, `inspect()` pulls one, `observe()` opens its live provenance stream. The only seam the bridge depends on.
export type Source = {
  targets: () => string[] // node addresses currently reachable
  inspect: (target: string) => Promise<InspectSnapshot | undefined> // PULL one node's snapshot (undefined if it didn't answer) — the [a]/[c] families
  // PUSH: subscribe a node's __observe provenance/contention stream; onRecord gets each
  // ChangeRecord (initial buffer dump {key:[],value:map}, then per-event deltas whose
  // value carries a `.kind`). Returns an unsubscribe, or undefined if the node can't be
  // reached / isn't observe-enabled. Optional — a source without it serves only the poll.
  observe?: (target: string, onRecord: (record: ChangeRecord) => void) => (() => void) | undefined
  destroy: () => void
}

//! networkSource: a read-only mesh client that dials a cluster and calls each server's `__inspect` — the real/remote path (O(N) connections).
// Builds a bare transport() mesh with NO listen port — so it is a client, never a
// ring member (it can't take ownership or be admitted to a view). It dials the
// seed(s); handshake gossip then teaches it every other server, so one reachable
// seed is enough. `targets()` = the connected SERVER peers; `inspect()` calls a
// SPECIFIC server (the raw mesh's call(method,arg,to) — the public fero client only
// routes to a picked server, so the bridge uses the mesh directly to poll per node).
export const networkSource = (opts: { seeds: string[]; name?: string; host?: string }): Source => {
  const host = opts.host ?? '127.0.0.1'
  const hosts = new Set<string>()
  const ports = new Set<number>()
  for (const s of opts.seeds) {
    const i = s.lastIndexOf(':')
    hosts.add(i >= 0 ? s.slice(0, i) : host)
    ports.add(i >= 0 ? +s.slice(i + 1) : NaN)
  }
  // The mesh discovers the rest via gossip; a spurious host×port grid entry just fails to dial (harmless).
  const mesh = transport({ name: opts.name ?? 'fero', host, hosts: [...hosts], ports: [...ports].filter((p) => !Number.isNaN(p)) })
  const connectedServers = (): string[] => {
    const raw = ((mesh.peers as any)[value] ?? {}) as Record<string, any>
    const out: string[] = []
    for (const a in raw) {
      const r = raw[a]
      if (r && r.role === 'server' && r.status === STATUS.connected) out.push(a)
    }
    return out
  }
  return {
    targets: connectedServers,
    inspect: (target) => (mesh.call('__inspect', undefined, target) as Promise<InspectSnapshot>).catch(() => undefined),
    // PUSH leg: a live subscription to the target server's gated __observe stream (rides
    // the same mesh client). Returns the mesh unsub; undefined if the target isn't
    // connected (the bridge retries on the next poll tick).
    observe: (target, onRecord) => mesh.subscribe('__observe', undefined, onRecord, target),
    destroy: () => mesh.destroy(),
  }
}

//! inProcessSource: read each in-process node's [diagnostics].snapshot() directly — the harness war-game path (zero added connections, omniscient).
// `nodes` may be a live array (or a thunk) so churn (kill/restart/join) is reflected
// per call. Indexes by each node's listen address (cluster.me); a node with no `me`
// (a read-only client) is skipped — we observe servers.
export const inProcessSource = (nodes: Fero[] | (() => Fero[])): Source => {
  const list = typeof nodes === 'function' ? nodes : () => nodes
  const index = (): Map<string, Fero> => {
    const m = new Map<string, Fero>()
    for (const n of list()) {
      const me = n?.cluster?.me
      if (me) m.set(me, n)
    }
    return m
  }
  return {
    targets: () => [...index().keys()],
    inspect: async (target) => (index().get(target) as any)?.[diagnostics]?.snapshot?.(),
    // PUSH leg (omniscient, zero added connections): attach a sink to the node's
    // in-process observe ring buffer directly via the diagnostics seam.
    observe: (target, onRecord) => (index().get(target) as any)?.[diagnostics]?.observe?.(onRecord),
    destroy: () => {},
  }
}

//! Static content types for the dashboard assets.
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}
const contentType = (f: string) => TYPES[f.slice(f.lastIndexOf('.'))] ?? 'application/octet-stream'

//! Serve one file from a root dir with a path-traversal guard; returns false if absent so the caller can fall back.
const serveFrom = async (root: string, rel: string, res: http.ServerResponse): Promise<boolean> => {
  const file = normalize(join(root, rel))
  // containment must be SEGMENT-aware: a bare prefix test lets `web-evil` escape past `web`
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403)
    res.end('forbidden')
    return true
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': contentType(file) })
    res.end(body)
    return true
  } catch {
    return false
  }
}

//! Slice-0 placeholder page (Slice 1 drops a real web/index.html that supersedes this).
const PLACEHOLDER =
  `<!doctype html><meta charset=utf-8><title>fero observe</title>` +
  `<body style="font:14px/1.6 system-ui;background:#0b0e14;color:#cbd5e1;padding:2.5rem;max-width:42rem;margin:auto">` +
  `<h1 style="color:#e2e8f0">fero observe</h1>` +
  `<p>Slice 0 — the pull pipe is live. The dashboard UI lands in Slice 1.</p>` +
  `<p>Live per-node snapshots stream at <a style="color:#7dd3fc" href="/events">/events</a> (Server-Sent Events).</p></body>`

const SEEN_SEP = '\x00' // seenKey = origin '\x00' partition (log.ts originKey) — split to get the origin uuid

//! coverFrom: resolve one snapshot's sampled ownership donut (member-INDEX per segment) into owner ADDRESSES — the comparable form the heatmap diffs across ticks.
// `ring.coverage[i]` indexes into the SAME snapshot's `ring.members`; an index is meaningless across
// nodes/ticks (membership reorders), an address is stable. '' marks an unowned/missing segment.
const coverFrom = (s?: InspectSnapshot): string[] => {
  const cov = s?.ring?.coverage
  const mem = s?.ring?.members
  if (!cov || !mem) return []
  const out = new Array<string>(cov.length)
  for (let i = 0; i < cov.length; i++) { const idx = cov[i]; out[i] = idx >= 0 && mem[idx] ? mem[idx] : '' }
  return out
}

//! deriveAggregate: fold N held snapshots into the compact rollup — view-groups + 3-state convergence + cluster totals + top-K lag. Pure + exported so it's unit/perf-testable (the new hot path).
// Ported verbatim from the dashboard's client-side reductions (web/app.js) so blobs/grid agree
// exactly: view-grouping by (epoch,members), the writable-MAJORITY split-brain classification, and
// the floor-relative + LIVE-ORIGIN lag (dead-origin marks are debris, not "behind" — IDEAS.md [c]).
// Filters role==='server' first — a read-only client (epoch=1/members=[]/writable=true) would poison
// every reduction. O(N·origins) in the frontier loop: guarded by bridge.perf.ts, runs once per poll.
export const deriveAggregate = (snapshots: InspectSnapshot[], mode: 'grid' | 'blobs', suppressed: number) => {
  const at = Date.now()
  const live = snapshots.filter((s) => s.role === 'server')
  const empty = { at, mode, totals: { nodes: 0, epochs: 0, writable: 0, retained: 0, behind: 0, orphans: 0, orphanNodes: 0 }, groups: [], conv: { state: 'waiting', views: 0, frac: 0, writableMajorities: 0 }, topLag: [], cover: [], dropped: { snapshots: suppressed, mode } }
  if (!live.length) return empty
  // view-groups: bucket by committed (epoch, members); a partition = ≥2 groups. The sig is an
  // ORDER-INDEPENDENT hash of the member set (no sort, no O(members) join) keyed by epoch+size, with
  // per-address hashes memoized across nodes — so grouping is O(N·members) of cheap adds, not the
  // O(N²) string-build that joining 200 addresses per node would cost (measured 49ms→sub-ms at N=200).
  const addrHash = (() => {
    const cache = new Map<string, number>()
    return (a: string) => {
      let h = cache.get(a)
      if (h === undefined) { h = 2166136261 >>> 0; for (let i = 0; i < a.length; i++) { h ^= a.charCodeAt(i); h = Math.imul(h, 16777619) } h >>>= 0; cache.set(a, h) }
      return h
    }
  })()
  const viewSig = (s: InspectSnapshot) => {
    const m = s.members ?? []
    let h = 0
    for (const a of m) h = (h + addrHash(a)) >>> 0 // sum is order-independent → no sort needed
    return `${s.epoch}|${m.length}|${h}`
  }
  const gmap = new Map<string, { sig: string; size: number; writable: boolean; majority: boolean; members: string[]; reps: number; sample?: InspectSnapshot }>()
  for (const s of live) {
    const sig = viewSig(s)
    let g = gmap.get(sig)
    if (!g) { g = { sig, size: (s.members ?? []).length, writable: false, majority: false, members: s.members ?? [], reps: 0, sample: s }; gmap.set(sig, g) }
    g.reps++
    if (s.writable) g.writable = true
  }
  const groups = [...gmap.values()]
  const views = groups.length
  const writableN = live.filter((s) => s.writable).length
  const frac = writableN / live.length
  // a dangerous SIDE holds a majority of its OWN members by actual node count (reps > size/2) and is
  // a real multi-node view (size ≥ 2) — excludes a solo-booting rejoiner AND a stale-larger-view minority
  for (const g of groups) g.majority = g.size >= 2 && g.reps > g.size / 2
  // 3-state: RED only for ≥2 writable MAJORITIES (split-brain); a lone rejoiner / read-only minority is converging
  const writableMajorities = groups.filter((g) => g.writable && g.majority).length
  const state = views === 1 ? 'converged' : writableMajorities >= 2 ? 'partition' : 'converging'
  // cluster totals
  let retained = 0, orphans = 0, orphanNodes = 0
  const epochs = new Set<number>()
  for (const s of live) { retained += s.log?.size ?? 0; const o = (s.orphans ?? []).length; if (o) { orphans += o; orphanNodes++ }; epochs.add(s.epoch) }
  // top-K lag: live-origin frontier → per-node deficit → floor-relative excess → rank → top-K
  const liveUuids = new Set(live.map((s) => s.uuid))
  // memoize the live-origin test per seenKey: the same ~origins×partitions keys recur across all N
  // nodes, so this turns N×origins string-splits into one split per distinct key (cache hits after)
  const liveK = new Map<string, boolean>()
  const isLiveK = (k: string) => {
    let v = liveK.get(k)
    if (v === undefined) { const sep = k.indexOf(SEEN_SEP); v = liveUuids.has(sep < 0 ? k : k.slice(0, sep)); liveK.set(k, v) }
    return v
  }
  const frontier: Record<string, number> = {}
  for (const s of live) { const m = (s.marks ?? {}) as Record<string, number>; for (const k in m) if (isLiveK(k) && (m[k] ?? 0) > (frontier[k] ?? 0)) frontier[k] = m[k] }
  const scoped = live.some((s) => s.ring?.scoped)
  // dense frontier arrays: lagOf runs once PER NODE, so iterating an indexed array beats re-enumerating
  // the frontier OBJECT's keys N times — `for (k in obj)` is markedly slower + deopt-prone in V8, and at
  // N=200 × ~100 keys that second pass dominated the rollup. Flatten once, then index. (perf guard: bridge.perf.ts)
  const fkeys = Object.keys(frontier)
  const fvals = fkeys.map((k) => frontier[k])
  const nf = fkeys.length
  const lagOf = (s: InspectSnapshot) => { const m = (s.marks ?? {}) as Record<string, number>; let b = 0; for (let i = 0; i < nf; i++) { const mine = m[fkeys[i]]; if (mine === undefined) { if (!scoped) b += fvals[i] } else if (fvals[i] > mine) b += fvals[i] - mine } return b }
  const raw = live.map((s) => ({ uuid: s.uuid, addr: s.me, logSize: s.log?.size ?? 0, lag: lagOf(s) }))
  let floor = Infinity; for (const r of raw) if (r.lag < floor) floor = r.lag
  if (!isFinite(floor)) floor = 0
  const tol = 16
  const lags = raw.map((r) => { const gap = Math.max(0, r.lag - floor); const excess = gap > tol ? gap : 0; return { uuid: r.uuid, addr: r.addr, behind: gap, excess, bar: 0, logSize: r.logSize } })
  let worst = 0; for (const l of lags) if (l.excess > worst) worst = l.excess
  let behindAll = 0; for (const l of lags) { behindAll += l.excess; l.bar = worst ? l.excess / worst : 0 }
  lags.sort((a, b) => b.excess - a.excess)
  const topLag = lags.slice(0, 20)
  // fold transient SINGLETONS (each solo-booting rejoiner is its own viewSig) into one 'others' blob
  // so the blob list stays bounded and isn't noisy during churn; real partition sides (reps≥2) stay
  // separate. (conv above is computed on the FULL groups, so divergence still counts singletons.)
  const big = groups.filter((g) => g.reps >= 2)
  const small = groups.filter((g) => g.reps < 2)
  let displayGroups: typeof groups = big
  if (small.length) {
    let reps = 0, writable = false
    for (const g of small) { reps += g.reps; if (g.writable) writable = true }
    displayGroups = [...big, { sig: 'others', size: reps, reps, writable, majority: false, members: [] }]
  }
  // consensus ownership donut → the key-movement heatmap. `coverage[i]` is a member-INDEX into
  // THAT node's ring.members, so resolve to the owner ADDRESS before shipping (indices aren't
  // comparable across nodes/ticks; addresses are). We take the LARGEST view-group's ring as the
  // authoritative one — during a partition the majority side's ownership is what's live (the
  // minority is read-only), and within a converged cluster every node agrees anyway. O(segments),
  // shipped every tick; the dashboard diffs successive `cover` arrays to light up moved segments.
  let lead = groups[0]
  const epochOf = (g?: { sample?: InspectSnapshot }) => g?.sample?.epoch ?? 0
  for (const g of groups) {
    if (g === lead) continue
    if (g.reps !== lead.reps) { if (g.reps > lead.reps) lead = g; continue }
    // exact reps tie (e.g. a view install mid-commit): prefer the FRESHEST committed view (highest
    // epoch), then a writable one — so `cover` follows the newest authoritative ownership and the tie
    // resolving doesn't diff two epochs' donuts into a phantom rebalance wave. Deterministic, not insertion-order.
    const ge = epochOf(g), le = epochOf(lead)
    if (ge !== le) { if (ge > le) lead = g; continue }
    if (g.writable && !lead.writable) lead = g
  }
  const cover = coverFrom(lead?.sample)
  return { at, mode, totals: { nodes: live.length, epochs: epochs.size, writable: writableN, retained, behind: behindAll, orphans, orphanNodes }, groups: displayGroups, conv: { state, views, frac, writableMajorities }, topLag, cover, dropped: { snapshots: suppressed, mode } }
}

//! bridge(): serve the dashboard + an SSE stream of per-node snapshots; poll the source on an interval and relay each snapshot.
// Returns once listening, with the localhost URL and a close(). The poll loop calls
// source.inspect() for every source.targets() each tick and pushes the snapshot to
// every connected SSE client. (Backpressure is best-effort in Slice 0 — bounded
// drop-oldest batching is the contention-stream slice; the poll payload is small and
// ~1/s, so a stalled client can't meaningfully grow it here.)
export const bridge = (opts: {
  source: Source
  port?: number
  host?: string
  poll?: number
  flush?: number // provenance-stream batch-flush cadence (ms); default 100
  aggregateAbove?: number // server-count threshold to switch from per-node 'snapshot' to the aggregated blobs rollup (default 24)
}): Promise<{ url: string; port: number; close: () => Promise<void> }> => {
  const host = opts.host ?? '127.0.0.1'
  const pollMs = opts.poll ?? 1000
  const flushMs = opts.flush ?? 100
  const clients = new Set<http.ServerResponse>()

  // PUSH leg: one __observe subscription per reachable target, plus a bounded
  // drop-oldest buffer of FLATTENED provenance events flushed to clients in BATCHES —
  // never a synchronous per-record SSE write (the backpressure safety of plan §6: a
  // slow/deaf SSE client can't make the buffer grow without bound, and a deaf flush
  // discards rather than queues).
  // target address → its push-leg state: the unsubscribe + the per-SUBSCRIPTION dedup
  // watermark (the highest ProvRecord.t seen on this stream — the initial ring-buffer
  // dump seeds it, so history is never re-accounted as fresh events; t resets with a new
  // makeObserve instance, but so does the subscription, so per-sub scope is exact).
  const observeSubs = new Map<string, { unsub: () => void; lastT: number }>()
  const EVENT_CAP = 4000
  let events: ProvEvent[] = []
  let evHead = 0 // ring write index once `events` is saturated — O(1) drop-oldest, no splice shift

  // ── SCALE TIER (war-game views) ────────────────────────────────────────────
  // The bridge holds all N snapshots (keyed by uuid) and DERIVES a compact rollup, so
  // the browser renders O(groups + topK) regardless of N. Above `aggregateAbove` server
  // nodes the per-node 'snapshot' fan-out (the O(N²)/poll wall) is suppressed and ONLY
  // the bounded 'aggregate' rollup ships — the dashboard switches the 200-dot grid to
  // view-group blobs. The mode change is hysteretic (a kill/restart crosses the
  // threshold every few seconds; it must not flap).
  const latest = new Map<string, InspectSnapshot>() // uuid → most recent snapshot (the merge key, stable across restart-on-same-port unlike address)
  // P5: persistent per-view DHT ring cache for foldLive's ownership derivation — built once per distinct
  // member set, reused across polls (a fresh build is O(members×vnodes)). Bounded below so churn can't leak it.
  const debugRings = new Map<string, DHT>()
  const DEBUG_RING_CAP = 32
  const addrUuid = new Map<string, string>() // address → the uuid last seen there: detects a same-address restart (new uuid) so the old uuid's ghost row is pruned
  const aggregateAbove = opts.aggregateAbove ?? 24
  let aggMode: 'grid' | 'blobs' = 'grid'
  let aggModeInit = false // the FIRST tick decides the mode immediately; only later flips are debounced
  let modeStreak = 0 // a pending mode change must persist this many ticks before it takes

  // PROVENANCE ROLLUP (scale tier) ── the raw per-record 'records' firehose can't reach the browser at
  // scale (O(writes) — a heal floods it). So in blobs mode the bridge REDUCES the __observe stream it
  // already receives into a compact 'provagg' per window — per-second write/repl rates, windowed
  // conflict/rebalance counts, top-K hot keys + top-K hot origins (who's writing most) — and SUPPRESSES
  // the raw fan-out. Grid mode keeps the raw stream (the small-cluster ticker/hot-keys drill-down).
  // Accumulators are O(1)/event, reset each window; bounded by distinct keys/origins seen (top-K slices the rest).
  const PROV_TOPK = 12
  const provReset = () => ({ writes: 0, won: 0, conflicts: 0, rebalance: 0, keys: new Map<string, number>(), origins: new Map<string, number>(), since: Date.now() })
  let prov = provReset()

  //! Emit one SSE event to every connected client.
  const sse = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(payload)
  }

  //! Account one provenance event into the rollup (reads scalars off the RAW record — no clone), then buffer the flattened event ONLY in grid mode (the only path that retains it).
  // The clone is the steady-state allocation at war-game scale (N nodes × write-rate events/sec) — so in
  // blobs mode, where pushEvent only bumps O(1) counters and discards the object, we never materialize it.
  const account = (e: ProvRecord, by: string) => {
    if (e.kind === 'local' || e.kind === 'forwarded') {
      prov.writes++
      if (e.origin) prov.origins.set(e.origin, (prov.origins.get(e.origin) ?? 0) + 1) // hot owners = top committing nodes
      if (e.key) prov.keys.set(e.key, (prov.keys.get(e.key) ?? 0) + 1)
    } else if (e.kind === 'won') prov.won++
    else if (e.kind === 'lost') {
      // same split as the dashboard: a stale-view loser (epoch < winner epoch) is EXPECTED rebalance
      // churn; a same-epoch loser is a TRUE conflict (the alarm) and a genuinely contended hot key.
      const fenced = e.we !== undefined && e.epoch !== undefined && e.epoch < e.we
      if (fenced) prov.rebalance++
      else { prov.conflicts++; if (e.key) prov.keys.set(e.key, (prov.keys.get(e.key) ?? 0) + 1) }
    }
    // materialize the flattened ProvEvent only when we'll actually ship it (grid mode); blobs suppresses the firehose
    if (aggMode === 'grid') {
      const ev = { ...e, by }
      if (events.length < EVENT_CAP) events.push(ev)
      else { events[evHead] = ev; evHead = (evHead + 1) % EVENT_CAP } // saturated: overwrite oldest in place
    }
  }
  //! Walk one __observe delta into provenance events: a per-event delta (value has `.kind`) is accounted once (dedup by t); an initial buffer dump is HISTORY — it only seeds the watermark.
  const flatten = (by: string, rec: ChangeRecord) => {
    const sub = observeSubs.get(by)
    const v = rec.value as any
    if (!v || typeof v !== 'object') return
    if ('kind' in v) {
      // per-event delta: dedup by the stream's monotonic t so a replayed/overlapping
      // event (e.g. around a re-subscribe) can't double-count into rates/conflicts.
      // t starts at 1, so only a real positive t participates (a t-less event passes).
      const t = (v as ProvRecord).t
      if (sub && typeof t === 'number' && t > 0) {
        if (t <= sub.lastT) return
        sub.lastT = t
      }
      account(v as ProvRecord, by)
    } else {
      // initial ring-buffer dump = history: seed the dedup watermark, never account it
      // as fresh events (it would inflate rates/conflicts on every (re)subscribe)
      let maxT = 0
      for (const slot in v) {
        const e = v[slot]
        if (e && typeof e === 'object' && 'kind' in e && (e.t ?? 0) > maxT) maxT = e.t
      }
      if (sub && maxT > sub.lastT) sub.lastT = maxT
    }
  }
  //! Flush the batched events to clients in arrival order (discarded if nobody's connected — never queues toward OOM).
  const flushEvents = () => {
    if (!events.length) return
    // a grid→blobs flip can leave grid-mode events buffered — drop them rather than ship a stale raw
    // batch into a blobs dashboard (which suppressed the firehose on purpose). Only grid mode relays.
    if (aggMode !== 'grid') { events = []; evHead = 0; return }
    const batch = evHead ? events.slice(evHead).concat(events.slice(0, evHead)) : events // rotate the saturated ring back to arrival order
    events = []
    evHead = 0
    if (clients.size) sse('records', batch)
  }

  //! Open the target's __observe stream if we don't already have one (a fresh/rejoined node).
  const ensureObserve = (target: string) => {
    if (observeSubs.has(target) || !opts.source.observe) return
    // register BEFORE subscribing: the in-process source delivers the initial buffer dump
    // SYNCHRONOUSLY inside subscribe, and flatten needs the entry to seed its watermark
    const entry = { unsub: () => {}, lastT: 0 }
    observeSubs.set(target, entry)
    const unsub = opts.source.observe(target, (rec) => flatten(target, rec))
    if (!unsub) {
      observeSubs.delete(target) // not reachable / not observe-enabled — retried next tick
      return
    }
    entry.unsub = unsub
  }
  //! Drop one target's observe sub (departed, restarted, or detected dead) — unsubscribe best-effort + forget.
  const dropObserve = (target: string) => {
    const sub = observeSubs.get(target)
    if (!sub) return
    try { sub.unsub() } catch {}
    observeSubs.delete(target)
  }
  //! Drop observe subs for targets that vanished (a killed/partitioned-away node) so we don't leak a dead subscription.
  const pruneObserve = (live: Set<string>) => {
    for (const t of [...observeSubs.keys()]) if (!live.has(t)) dropObserve(t)
  }

  //! deriveSnapshotAgg: fold the N held snapshots into the compact rollup — view-groups + 3-state convergence + cluster totals + top-K lag. The new hot path (guarded by bridge.perf.ts).
  // Ported verbatim from the dashboard's client-side reductions (web/app.js) so blobs/grid
  // agree exactly: view-grouping by (epoch,members), the writable-MAJORITY split-brain
  // classification, and the floor-relative + LIVE-ORIGIN lag (dead-origin marks are debris,
  // not "behind" — see tools/observe/IDEAS.md [c]). Filters role==='server' first — a
  // read-only client (epoch=1/members=[]/writable=true) would poison every reduction.
  const deriveSnapshotAgg = (mode: 'grid' | 'blobs', suppressed: number) => deriveAggregate([...latest.values()], mode, suppressed)

  //! deriveProvAgg: reduce the window's provenance accumulators into the compact rollup (per-second rates + windowed conflict/rebalance counts + top-K hot keys/origins), then reset the window.
  const topK = (m: Map<string, number>, k: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
  const deriveProvAgg = () => {
    const elapsed = Math.max(1, Date.now() - prov.since)
    const perSec = (n: number) => Math.round((n / (elapsed / 1000)) * 10) / 10
    const out = {
      at: Date.now(),
      window: elapsed,
      rates: { writes: perSec(prov.writes), repl: perSec(prov.won), conflicts: prov.conflicts, rebalance: prov.rebalance },
      keys: topK(prov.keys, PROV_TOPK).map(([key, n]) => ({ key, n })),
      origins: topK(prov.origins, PROV_TOPK).map(([origin, n]) => ({ origin, n })),
      nodes: observeSubs.size, // # of node streams this rollup folds (it's an aggregate, not one node — surfaced for honesty)
    }
    prov = provReset()
    return out
  }

  //! One poll tick: reconcile the observe subscriptions, then pull every reachable node's snapshot and relay it (keyed by uuid on the client side).
  let polling = false
  const tick = async () => {
    if (polling) return // never overlap ticks (a slow source must not stack)
    polling = true
    try {
      const targets = opts.source.targets()
      const live = new Set(targets)
      // push legs are armed ONLY while a dashboard is watching: with zero SSE clients every
      // sub is dropped, so no node pays the ~3× watched write tax for nobody — the bridge
      // must not be the subscriber that never leaves (re-arms within one tick of a client)
      pruneObserve(clients.size ? live : new Set())
      // decide the mode for THIS tick (hysteretic — a kill/restart crosses the threshold
      // every few seconds and must not flap the dashboard between grid and blobs)
      const want: 'grid' | 'blobs' = targets.length > aggregateAbove ? 'blobs' : 'grid'
      if (!aggModeInit) { aggMode = want; aggModeInit = true; modeStreak = 0 } // first tick: decide now (no startup grid-snapshot waste)
      else if (want !== aggMode) { if (++modeStreak >= 3) { aggMode = want; modeStreak = 0 } } else modeStreak = 0
      let suppressed = 0
      for (const t of targets) {
        const snap = await opts.source.inspect(t)
        if (snap) {
          // same-address restart: a NEW uuid under a tracked address means the old uuid's
          // row is a ghost the address-prune below can't catch (the address is still live)
          // — drop it, plus the observe sub (it belonged to the dead process)
          const prev = addrUuid.get(t)
          if (prev !== undefined && prev !== snap.uuid) {
            latest.delete(prev)
            dropObserve(t)
          }
          addrUuid.set(t, snap.uuid)
          // dead push leg: we hold a sub but the node reports its gate UNARMED — the sub
          // was reaped server-side (a socket bounce inside one poll interval). Re-subscribe
          // below. STRICTLY false: a source whose snapshots predate the `observing` field
          // (or a stub) must not churn the sub every tick. (Blind spot: a SECOND bridge
          // keeping the gate armed masks ours — ledgered in tools/observe/IDEAS.md.)
          if (snap.observing === false && observeSubs.has(t)) dropObserve(t)
          latest.set(snap.uuid, snap)
          // grid mode: relay per-node as before. blobs mode: SUPPRESS the per-node fan-out
          // (the O(N²)/poll wall) — the rollup carries everything; account the drop honestly.
          if (aggMode === 'grid') sse('snapshot', snap)
          else suppressed++
        }
        // (re)open the push leg AFTER the health checks so a dropped/dead sub re-arms this tick
        if (clients.size) ensureObserve(t)
      }
      // prune departed uuids (a node that left) so the rollup excludes ghosts — by ADDRESS
      // (same-address restarts were already pruned above, where the address never goes dead)
      for (const [uuid, s] of latest) if (!s.me || !live.has(s.me)) latest.delete(uuid)
      for (const a of [...addrUuid.keys()]) if (!live.has(a)) addrUuid.delete(a)
      // always ship the compact rollup (guarded by the deaf-client discard, like flushEvents)
      if (clients.size) sse('aggregate', deriveSnapshotAgg(aggMode, suppressed))
      // P5: ship the store-once DEBUG file too (the promoted hierarchical viewer at /debug/ consumes
      // it through the SAME normalize() the file-fed viewer uses). foldLive folds the held poll payload
      // with no extra drill calls; `debugRings` memoizes the per-view DHT rings ACROSS polls so the
      // steady state rebuilds nothing (a fresh build is O(members×vnodes) — see bridge.perf.ts).
      if (clients.size) {
        const debugFile = foldLive([...latest.values()], undefined, debugRings)
        foldOutcomes(debugFile, events) // attach recent rejected-write rows (fence/conflict) from the held 'lost' stream — grid-mode only (blobs keeps counters)
        sse('debug', debugFile)
        // bound the cache: keep recent view-rings (working set ≤ the 16-deep history + current); evict
        // oldest-inserted past that so churn can't grow it unbounded (an evicted ring just rebuilds if seen again)
        while (debugRings.size > DEBUG_RING_CAP) debugRings.delete(debugRings.keys().next().value as string)
      }
    } finally {
      polling = false
    }
  }
  const timer = setInterval(() => void tick(), pollMs)
  timer.unref?.()
  const flushTimer = setInterval(flushEvents, flushMs)
  flushTimer.unref?.()
  // provenance rollup window: once per second, ship 'provagg' (blobs mode + a connected client), else
  // just reset the window so the accumulators never grow unbounded in grid mode / while nobody watches.
  const provTimer = setInterval(() => {
    if (aggMode === 'blobs' && clients.size) sse('provagg', deriveProvAgg())
    else prov = provReset()
  }, 1000)
  provTimer.unref?.()

  //! Serve a static asset: /vendor/data/* from the sibling data dist, everything else from web/, with the placeholder fallback for '/'.
  const serveStatic = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const urlPath = (req.url || '/').split('?')[0]
    // the dashboard's `import 'data'` resolves here — the built data ESM lives outside the web root
    if (urlPath.startsWith('/vendor/data/')) {
      if (!(await serveFrom(DATA_DIST, urlPath.slice('/vendor/data/'.length), res))) {
        res.writeHead(404)
        res.end(`data dist not found — run \`cd ../data && npm run build\` (looked in ${DATA_DIST})`)
      }
      return
    }
    // the promoted debug viewer is mounted at /debug/ (its own root) so it's same-origin with /events
    if (urlPath === '/debug' || urlPath.startsWith('/debug/')) {
      const drel = urlPath === '/debug' || urlPath === '/debug/' ? 'tree.html' : urlPath.slice('/debug/'.length)
      if (await serveFrom(DEBUG_WEB, drel, res)) return
      res.writeHead(404)
      res.end('not found')
      return
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    if (await serveFrom(WEB, rel, res)) return
    if (urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PLACEHOLDER)
      return
    }
    res.writeHead(404)
    res.end('not found')
  }

  const server = http.createServer((req, res) => {
    if ((req.url || '/').split('?')[0] === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write('retry: 1000\n\n') // tell EventSource to reconnect after 1s if the stream drops
      clients.add(res)
      void tick() // push an immediate snapshot so a fresh client isn't blank for a whole poll interval
      req.on('close', () => clients.delete(res))
      return
    }
    void serveStatic(req, res)
  })

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const port = (server.address() as { port: number }).port
      resolve({
        // localhost (NOT 127.0.0.1) — WSL2/VSCode forwarding only resolves under localhost.
        url: `http://localhost:${port}/`,
        port,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(timer)
            clearInterval(flushTimer)
            clearInterval(provTimer)
            for (const { unsub } of observeSubs.values())
              try { unsub() } catch {}
            observeSubs.clear()
            for (const c of clients) c.end()
            clients.clear()
            opts.source.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}
