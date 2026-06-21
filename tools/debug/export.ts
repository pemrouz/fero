// ════════════════════════════════════════════════════════════════════════
// export — P1 producer: fold live fero introspection into the store-once
// debug file the viewer's normalize() consumes (tools/debug/mockups/shape.js).
//
// This is the INVERSE of normalize(): normalize derives the cross-cuts; here we
// emit only the FACTS, each once on its natural owner, and let the viewer
// re-derive. foldSnapshots() is pure — it takes the per-node InspectSnapshots a
// caller already pulled (via the always-available [diagnostics].snapshot() seam,
// or the gated __inspect over the wire) plus an authoritative owner/replica
// lookup (cluster.owner(key) / cluster.replicas(key)), and produces the file.
//
// Emitted from a REAL seam today:
//   • resource — members, R (committed view + ring)                            [P1]
//   • node     — keys (LWW-winner count), health (writable/pending/orphans/    [P1]
//                stale epoch)
//   • partition— owner + R-set + held-count, so UNDER-REPLICATION is real      [P1]
//   • replica  — DIVERGENCE: a holder parked on a lower (epoch,seq) than its    [P2]
//                owner is flagged stuck, via foldDivergence over the version-sample drill
//   • epoch    — ownerByEpoch HISTORY: rebuild the ring from each past committed   [P4]
//                view (snapshot.viewHistory) to recover who owned what, when
// Deliberately NOT emitted (no seam yet — the IDEAS workstream):
//   per-partition keys/wps, the change-record log, per-subscription lag (P3).
// The viewer renders the gaps gracefully (normalize fills defaults), so a capture
// already replaces the hand-authored rows with live data.
// ════════════════════════════════════════════════════════════════════════

import type { InspectSnapshot, InspectSub } from '../../resource/inspect.ts'
import type { ProvRecord } from '../../resource/observe.ts'
import { diagnostics, type Fero } from '../../resource/index.ts'
import { DHT } from '../../transport/dht.ts'

//! DebugFile: the store-once snapshot shape (the subset P1/P2 can fill); shape.js#normalize consumes it.
export type DebugReplica = { addr: string; lag?: number; stuckAt?: string; stale?: boolean; missing?: boolean; note?: string }
export type DebugNode = { addr: string; keys?: number; status?: string; note?: string }
//! DebugOutcome: one REJECTED write — a fence (stale-view reject) or a same-epoch conflict-loser; never a committed record.
export type DebugOutcome = { key: string; origin?: string; seq?: number; epoch?: number; out: 'fence' | 'conflict'; winner?: string }
export type DebugPartition = { name: string; owner?: string; R?: number; held?: number; status?: string; note?: string; replicas?: DebugReplica[]; ownerByEpoch?: Record<string, string>; bornAt?: string; outcomes?: DebugOutcome[] }
export type DebugEpoch = { id: string; members: number; current?: boolean }
//! DebugSub / DebugClient: the subscription-topology rows the viewer renders (a downstream consumer + the subs it holds).
// No head/delivered: the delta stream carries no provenance, so a seq-lag isn't honestly measurable — the
// viewer's normalize() degrades its lag column to '0' when those are absent (a gap, not a fabricated rate). [P3]
export type DebugSub = { key: string; owner?: string; kind?: string }
export type DebugClient = { id: string; role?: string; server?: string; status?: string; note?: string; subs: DebugSub[] }
export type DebugResource = { name: string; members: string[]; R: number; nodes: DebugNode[]; partitions: DebugPartition[]; epochs?: DebugEpoch[]; clients?: DebugClient[] }
export type DebugFile = { 'fero.debug': 1; _about: string; capturedAt?: string; view: string; resources: DebugResource[] }

//! VersionStamp / VersionSample: one node's per-key LWW stamps (from snapshot({sample})) — the divergence input.
export type VersionStamp = { epoch: number; seq: number; origin: string }
export type VersionSample = Record<string, VersionStamp>

//! OwnerLookup: authoritative routing for a partition key — cluster.owner / cluster.replicas, per resource.
export type OwnerLookup = {
  owner?: (resource: string, key: string) => string | undefined
  replicas?: (resource: string, key: string) => string[] | undefined
}

const ABOUT =
  'Captured from a live cluster via the [diagnostics] seam (debug viewer P1+P2+P3+P4). REAL: committed ' +
  'members + R, per-node key count (LWW winners) + health, per-partition owner + replica-set + held ' +
  '(under-replication), per-replica DIVERGENCE (a replica parked on a lower (epoch,seq) than its owner ' +
  'is flagged stuck — via the version-sample drill), ownerByEpoch HISTORY (re-derived by rebuilding ' +
  'the ring from each past committed view), and the live SUBSCRIPTION TOPOLOGY (who subscribes to what, ' +
  'served by whom, of what kind — forwarded reads reveal the client→relay→owner chain). PENDING (no seam ' +
  'yet): per-partition keys/wps, the change-record log, and per-subscription seq-lag (the delta stream ' +
  'carries no provenance, so a seq-lag is not honestly measurable — topology is shipped instead).'

//! foldSnapshots: pure fold of per-node InspectSnapshots (+ owner lookup) → the store-once debug file.
export function foldSnapshots(snaps: InspectSnapshot[], lookup: OwnerLookup = {}, capturedAt?: string): DebugFile {
  // group by resource name — a node self-reports the resource it belongs to
  const byResource = new Map<string, InspectSnapshot[]>()
  for (const s of snaps) {
    const list = byResource.get(s.name)
    if (list) list.push(s)
    else byResource.set(s.name, [s])
  }

  let maxEpochAll = 1
  const resources: DebugResource[] = []
  for (const [name, ss] of byResource) {
    const servers = ss.filter((s) => s.role === 'server')
    if (!servers.length) continue
    // the freshest committed view is the truth for membership; a node on a lower
    // epoch is itself the stale-view signal (don't trust its members)
    const ref = servers.reduce((a, b) => (b.epoch > a.epoch ? b : a), servers[0])
    const maxEpoch = ref.epoch
    if (maxEpoch > maxEpochAll) maxEpochAll = maxEpoch
    const members = ref.members.slice()
    // ring.replicas is null for full replication (R=∞ doesn't survive JSON) — then
    // every member holds everything, so R = the member count is the truthful value
    const R = ref.ring.replicas ?? members.length

    // nodes — one per server, keyed by its listen address; keys = the LWW-winner
    // count (the real "distinct keys held"), health derived from the snapshot
    const nodes: DebugNode[] = servers.map((s) => {
      const notes: string[] = []
      if (!s.writable) notes.push('write-gated (no quorum)')
      if (s.pending) notes.push(`${s.pending} buffered`)
      if (s.orphans.length) notes.push(`${s.orphans.length} orphan${s.orphans.length > 1 ? 's' : ''} awaiting shed`)
      if (s.subscriptions) notes.push(`${s.subscriptions} sub${s.subscriptions > 1 ? 's' : ''}`)
      const status = s.epoch < maxEpoch ? 'stale' : s.orphans.length ? 'under' : !s.writable ? 'stale' : 'healthy'
      return { addr: s.me!, keys: s.versions, status, note: notes.join(' · ') }
    })

    // partitions — the union of every node's held partition keys (log.heads); the
    // OWNER + R-set come from the authoritative routing lookup, and held = how many
    // nodes actually hold it, so held < |R-set| is a real under-replication signal
    const holders = new Map<string, Set<string>>()
    for (const s of servers) {
      for (const p of Object.keys(s.log.heads)) {
        const set = holders.get(p)
        if (set) set.add(s.me!)
        else holders.set(p, new Set([s.me!]))
      }
    }
    const partitions: DebugPartition[] = [...holders.keys()].sort().map((pname) => {
      const owner = lookup.owner?.(name, pname)
      const repl = lookup.replicas?.(name, pname)
      const Rp = repl ? repl.length : R
      const held = holders.get(pname)!.size
      const under = held < Rp
      return { name: pname, owner, R: Rp, held, status: under ? 'under' : 'healthy', note: under ? `${held}/${Rp} holding` : '' }
    })

    resources.push({ name, members, R, nodes, partitions })
  }

  return { 'fero.debug': 1, _about: ABOUT, capturedAt, view: 'e' + maxEpochAll, resources }
}

//! stamp comparison + display: a replica is BEHIND the owner at (epoch, seq), lexicographic (epoch fences seq).
const behindStamp = (r: VersionStamp, o: VersionStamp) => r.epoch < o.epoch || (r.epoch === o.epoch && r.seq < o.seq)
const dispKey = (k: string) => k.split('\x00').join('.')

//! foldDivergence: cross-node version-sample diff → real per-partition replica divergence.
// For each partition, the OWNER holds the authoritative LWW winner per key; any holder
// whose sampled stamp for a key is BEHIND the owner's is stuck (the user42.score-on-:49807
// case). We flag the worst-behind key per replica with its parked (epoch·seq) + the seq gap
// as lag, and mark the partition diverged. Pure over (file, the per-node samples) — the drill
// that produced the samples lives in captureInProcess; here it's just the comparison.
export function foldDivergence(file: DebugFile, sampleByNode: Map<string, VersionSample>): DebugFile {
  for (const r of file.resources) {
    for (const p of r.partitions) {
      if (!p.owner) continue
      const ownerSample = sampleByNode.get(p.owner)
      if (!ownerSample) continue
      const keysOfP = Object.keys(ownerSample).filter((k) => k === p.name || k.startsWith(p.name + '\x00'))
      if (!keysOfP.length) continue

      const replicas: DebugReplica[] = []
      for (const [addr, sample] of sampleByNode) {
        if (addr === p.owner) continue
        // a holder of p shares at least one of p's keys; nodes that don't replicate p
        // simply never sampled its keys, so they're skipped (not false-flagged)
        let holds = false
        let worst: { key: string; stamp: VersionStamp; gap: number } | null = null
        for (const k of keysOfP) {
          const rv = sample[k]
          if (!rv) continue
          holds = true
          const ov = ownerSample[k]
          if (behindStamp(rv, ov)) {
            const gap = (ov.epoch - rv.epoch) * 1e9 + (ov.seq - rv.seq)
            if (!worst || gap > worst.gap) worst = { key: k, stamp: rv, gap }
          }
        }
        if (holds && worst) {
          const ov = ownerSample[worst.key]
          replicas.push({ addr, lag: Math.max(1, ov.seq - worst.stamp.seq), stuckAt: `e${worst.stamp.epoch}·s${worst.stamp.seq}`, stale: true, note: `behind on ${dispKey(worst.key)}` })
        }
      }

      if (replicas.length) {
        p.replicas = replicas
        p.status = 'diverged'
        p.note = [p.note, `${replicas.length} replica${replicas.length > 1 ? 's' : ''} behind`].filter(Boolean).join(' · ')
      }
    }
  }
  return file
}

//! foldOwnership: re-derive ownerByEpoch by rebuilding the ring from each PAST view's members.
// The committed-view history (snapshot.viewHistory, P4a) gives {epoch, members} per epoch;
// rebuilding the DHT ring from a view's members and querying owner(partition) recovers who
// owned what at that epoch — the cluster-replay / owner-timeline primitive. A buildRing factory
// is injected (the live path uses a default DHT; tests inject a deterministic ring).
//
// VALIDATION GUARD: re-deriving the LATEST view must reproduce the authoritative owner P1 set
// (cluster.owner). If any partition disagrees, the live ring config differs from the default we
// rebuild with — so we SKIP rather than emit misleading history (better a gap than a lie).
//
// BIRTH-GATING: `births` (partition → first-seen epoch, from the WAL via foldWal) anchors each
// partition's owner-timeline at the view it was first written. WITHOUT it we back-project the
// CURRENT partition set onto every past view, so a partition created at e6 gets a fabricated owner
// at e2…e5 — a counterfactual ("where this key WOULD have hashed") the viewer miscounts as a MOVE.
// Gating skips those pre-birth epochs and stamps `bornAt`, so the viewer can show the birth as a
// PLACEMENT, not a move. births is OPTIONAL: with no WAL source (the live bridge), gating is off and
// behaviour is exactly today's full back-projection (lossy but always available).
export function foldOwnership(
  file: DebugFile,
  viewsByEpoch: Map<number, string[]>,
  buildRing: (members: string[]) => (key: string) => string | undefined,
  births: Record<string, number> = {},
): DebugFile {
  if (!viewsByEpoch.size) return file
  const epochs = [...viewsByEpoch.keys()].sort((a, b) => a - b)
  const latest = epochs[epochs.length - 1]
  // build one ring per distinct view, reused across all partitions
  const ringByEpoch = new Map<number, (k: string) => string | undefined>()
  for (const e of epochs) ringByEpoch.set(e, buildRing(viewsByEpoch.get(e)!))

  for (const r of file.resources) {
    const latestRing = ringByEpoch.get(latest)!
    if (!r.partitions.every((p) => !p.owner || latestRing(p.name) === p.owner)) continue // config mismatch → skip
    for (const p of r.partitions) {
      const born = births[p.name] // first-seen epoch (from the WAL), or undefined when no source
      const obe: Record<string, string> = {}
      for (const e of epochs) {
        if (born !== undefined && e < born) continue // pre-birth → don't fabricate a counterfactual owner
        const o = ringByEpoch.get(e)!(p.name)
        if (o) obe['e' + e] = o
      }
      if (Object.keys(obe).length) p.ownerByEpoch = obe
      if (born !== undefined) p.bornAt = 'e' + born // the view this partition first appeared — a PLACEMENT, not a move
    }
    r.epochs = epochs.map((e) => ({ id: 'e' + e, members: viewsByEpoch.get(e)!.length, current: e === latest }))
  }
  return file
}

//! birthsOf: merge per-node snapshot.births into one partition → EARLIEST-epoch map — the live owner-timeline anchor.
// A partition's birth is the lowest first-seen epoch any node reports for it (debug-on nodes carry
// `births`; nodes without it contribute nothing). Empty when no node ran with `debug`, in which case
// foldOwnership back-projects as before — the honest degrade, never a fabricated placement.
export function birthsOf(snaps: InspectSnapshot[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of snaps) for (const [p, e] of Object.entries(s.births ?? {})) if (out[p] === undefined || e < out[p]) out[p] = e
  return out
}

//! foldSubs: fold each node's served-subscription topology into per-resource client→sub rows.
// Each snapshot carries `subs` (who this node serves, of what kind). We group (servingNode, sub) by the
// downstream `to` address into a client row, within the server's resource (a node serves exactly one).
// A forwarded read shows up TWICE — the real client served by the relay, AND the relay served by the
// owner (role 'server') — which faithfully reveals the forward chain (client → relay → owner). No
// head/delivered (not honestly measurable; see DebugSub) — the viewer's lag column degrades gracefully.
export function foldSubs(file: DebugFile, subsByNode: Map<string, InspectSub[]>): DebugFile {
  // map each serving-node addr → its resource (a node belongs to exactly one)
  const resOf = new Map<string, DebugResource>()
  for (const r of file.resources) for (const n of r.nodes) resOf.set(n.addr, r)

  const clientsOf = new Map<DebugResource, Map<string, DebugClient>>()
  for (const [serving, subs] of subsByNode) {
    const r = resOf.get(serving)
    if (!r) continue
    let clients = clientsOf.get(r)
    if (!clients) clientsOf.set(r, (clients = new Map()))
    for (const s of subs) {
      let c = clients.get(s.to)
      // role: a downstream that is itself a committed member is a server (a relay's upstream); else a reader
      if (!c) clients.set(s.to, (c = { id: s.to, role: r.members.includes(s.to) ? 'server' : 'reader', server: serving, subs: [] }))
      c.subs.push({ key: s.key ?? s.kind, owner: s.owner ?? serving, kind: s.kind })
    }
  }
  for (const [r, clients] of clientsOf) if (clients.size) r.clients = [...clients.values()]
  return file
}

//! foldOutcomes: fold the observe `lost` push-stream into per-partition REJECTED-write rows (fence vs conflict).
// The viewer's most telling rows — fences (a stale-view write rejected) and conflict-losers (a same-epoch LWW
// loss) — are never committed records, so they're absent from the snapshot/log. But applyInbound ALREADY emits
// them on the __observe stream as kind:'lost', carrying the WINNER's epoch (`we`) + seq (`ws`) — exactly the
// "why". So no new instrumentation, no hot-path cost: we just classify (record epoch < winner epoch ⇒ FENCE /
// stale view; equal ⇒ same-epoch CONFLICT), group by partition (the key's first dotted segment) within the
// resource of the node that observed it (`by`), dedup the same logical write seen on several replicas
// (origin,seq,key), and attach a bounded newest-first list. Pure over (file, events). Grid-mode only — blobs
// mode keeps the windowed conflict/rebalance COUNTERS, not the raw events.
export function foldOutcomes(file: DebugFile, events: (ProvRecord & { by: string })[], cap = 8): DebugFile {
  const resOf = new Map<string, DebugResource>()
  for (const r of file.resources) for (const n of r.nodes) resOf.set(n.addr, r)
  const partOf = new Map<DebugResource, Map<string, DebugPartition>>()
  for (const r of file.resources) partOf.set(r, new Map(r.partitions.map((p) => [p.name, p])))
  const seen = new Set<string>() // (origin,seq,key) — the same rejected write loses on every replica that holds it
  for (let i = events.length - 1; i >= 0; i--) {
    // newest-first
    const e = events[i]
    if (e.kind !== 'lost' || !e.key) continue
    const r = resOf.get(e.by)
    if (!r) continue
    const p = partOf.get(r)!.get(e.key.split('.')[0]) // partition = the top-level key (first dotted segment)
    if (!p) continue
    const sig = (e.origin ?? '') + '|' + (e.seq ?? 0) + '|' + e.key
    if (seen.has(sig)) continue
    seen.add(sig)
    const list = (p.outcomes ??= [])
    if (list.length >= cap) continue
    const fenced = e.we !== undefined && e.epoch !== undefined && e.epoch < e.we // stale view: lost to a NEWER-epoch winner
    list.push({ key: e.key, origin: e.origin, seq: e.seq, epoch: e.epoch, out: fenced ? 'fence' : 'conflict', winner: e.we !== undefined ? 'e' + e.we + '·s' + (e.ws ?? 0) : undefined })
  }
  return file
}

//! foldLive: fold a set of ALREADY-PULLED InspectSnapshots into a DebugFile with NO drill calls — the remote/over-the-wire path (the observer bridge's ~1/s poll payload).
// captureInProcess is the in-process path: it has live ring authority (cluster.owner) and can issue the
// version-sample drill for divergence. The BRIDGE has neither — it's a read-only client holding only the
// poll payload (members, ring, log.heads, viewHistory, subs, the versions COUNT). So foldLive rebuilds the
// owner lookup from the freshest committed view's members (a DHT ring, exactly as foldOwnership does), runs
// the folds that need only the poll payload (ownership history + subscription topology), and OMITS
// divergence — that needs the two-pass version-sample drill, which the steady ~1/s poll deliberately does
// not pay (it's the forensic capture's job). The viewer degrades gracefully (no divergence flagged live).
export function foldLive(snaps: InspectSnapshot[], capturedAt?: string, ringCache?: Map<string, DHT>): DebugFile {
  // A DHT build is O(members × vnodes) — far too expensive to repeat per epoch per poll (16 rebuilds of
  // a 200-member ring measured ~680ms). So MEMOIZE rings by member-set signature: epochs sharing a member
  // set (the common case — a stable cluster's recent history is one or few sets) collapse to ONE build,
  // and the SAME ring backs both the owner/replicas lookup and foldOwnership's history. The bridge passes
  // a PERSISTENT cache across polls → steady state rebuilds nothing; a one-shot caller (a test) gets a
  // fresh per-call cache (still collapses within the call). owner() is replica-count-independent, so it
  // agrees with the live cluster.owner under the default DHT config (foldOwnership's guard re-checks this).
  const cache = ringCache ?? new Map<string, DHT>()
  const dhtFor = (members: string[]): DHT => {
    const sig = members.length + '|' + [...members].sort().join(',') // order-independent: a committed view's member order may vary across nodes
    let d = cache.get(sig)
    if (!d) {
      d = new DHT()
      for (const m of members) d.add(m)
      cache.set(sig, d)
    }
    return d
  }

  // per resource: the freshest committed view is the authoritative membership; its ring answers owner/replicas
  const freshest = new Map<string, InspectSnapshot>()
  for (const s of snaps) {
    if (s.role !== 'server') continue
    const cur = freshest.get(s.name)
    if (!cur || s.epoch > cur.epoch) freshest.set(s.name, s)
  }
  const ringByResource = new Map<string, { owner: (k: string) => string | undefined; replicas: (k: string) => string[] }>()
  for (const [name, s] of freshest) {
    const R = s.ring.replicas ?? s.members.length // null ⇒ full replication ⇒ every member holds it
    const dht = dhtFor(s.members)
    ringByResource.set(name, { owner: (k) => dht.owner(k), replicas: (k) => dht.owners(k, R) })
  }
  const lookup: OwnerLookup = {
    owner: (resource, k) => ringByResource.get(resource)?.owner(k),
    replicas: (resource, k) => ringByResource.get(resource)?.replicas(k),
  }
  const file = foldSnapshots(snaps, lookup, capturedAt)

  // ownership history — same merge as captureInProcess round 3 (a committed view is globally agreed, so
  // same epoch ⇒ same members); buildRing goes through the SAME memoized cache (no per-epoch rebuild)
  const viewsByEpoch = new Map<number, string[]>()
  for (const s of snaps) for (const v of s.viewHistory ?? []) if (!viewsByEpoch.has(v.epoch)) viewsByEpoch.set(v.epoch, v.members)
  const buildRing = (members: string[]) => {
    const d = dhtFor(members)
    return (k: string) => d.owner(k)
  }
  foldOwnership(file, viewsByEpoch, buildRing, birthsOf(snaps)) // birth-anchor from debug-on nodes' snapshot.births (empty ⇒ back-project)

  // subscription topology — fold each server's served-sub sample (carried in the poll payload)
  const subsByNode = new Map<string, InspectSub[]>()
  for (const s of snaps) if (s.role === 'server' && s.me && s.subs?.length) subsByNode.set(s.me, s.subs)
  return foldSubs(file, subsByNode)
}

//! captureInProcess: snapshot a live in-process cluster — pull each node's
//! [diagnostics].snapshot() + resolve authoritative ownership off a server's ring.
// The always-available diagnostics seam (no observe:true gate, no added
// connections) reads state the hot path already maintains; cluster.owner/replicas
// are pure ring lookups. So a capture perturbs nothing — it's the harness / embedded
// path. (A networkSource-backed CLI over the gated __inspect is a later bite.)
// `births` (partition → first-seen epoch) is OPTIONAL: a caller holding the WAL passes
// `birthEpochs(foldWal(records))` to birth-anchor the owner-timeline; absent it, ownership history
// back-projects as before (the snapshot carries no birth — log.heads is the HEAD seq, not the floor).
export function captureInProcess(nodes: Fero[], capturedAt = new Date().toISOString(), births: Record<string, number> = {}): DebugFile {
  // round 1: blanket snapshots (topology + holders) — no sample, so the cheap per-poll read
  const snaps: InspectSnapshot[] = []
  const instByAddr = new Map<string, any>()
  const ringByResource = new Map<string, { owner: (k: string) => string | undefined; replicas: (k: string) => string[] }>()
  for (const n of nodes) {
    const snap = (n as any)[diagnostics]?.snapshot?.() as InspectSnapshot | undefined
    if (!snap) continue
    snaps.push(snap)
    // a server (cluster.me defined) carries ring authority for its resource; the
    // first one we see per resource answers owner/replicas for that resource
    const cl = (n as any).cluster
    if (cl?.me !== undefined) {
      instByAddr.set(cl.me, n)
      if (!ringByResource.has(snap.name)) ringByResource.set(snap.name, cl)
    }
  }
  const lookup: OwnerLookup = {
    owner: (resource, k) => ringByResource.get(resource)?.owner(k),
    replicas: (resource, k) => ringByResource.get(resource)?.replicas(k),
  }
  const file = foldSnapshots(snaps, lookup, capturedAt)

  // round 2: divergence drill — ONE sample call per node over the partitions it holds
  // (the O(versions) scan rides this drill, not the per-poll round 1), then diff stamps
  const sampleByNode = new Map<string, VersionSample>()
  for (const snap of snaps) {
    if (snap.role !== 'server' || !snap.me) continue
    const inst = instByAddr.get(snap.me)
    if (!inst) continue
    const parts = Object.keys(snap.log.heads)
    if (!parts.length) continue
    const drilled = (inst[diagnostics].snapshot({ sample: parts }) as InspectSnapshot).versionSample
    if (drilled) sampleByNode.set(snap.me, drilled)
  }
  foldDivergence(file, sampleByNode)

  // round 3: ownership history — merge every node's committed-view ring (a committed view is
  // globally agreed, so same epoch ⇒ same members) and re-derive owner per epoch off a default ring
  const viewsByEpoch = new Map<number, string[]>()
  for (const snap of snaps) for (const v of snap.viewHistory ?? []) if (!viewsByEpoch.has(v.epoch)) viewsByEpoch.set(v.epoch, v.members)
  const buildRing = (members: string[]) => {
    const ring = new DHT()
    for (const m of members) ring.add(m)
    return (k: string) => ring.owner(k)
  }
  foldOwnership(file, viewsByEpoch, buildRing, { ...birthsOf(snaps), ...births }) // debug-on nodes self-report births; an explicit WAL-derived map overrides

  // round 4: subscription topology — fold each server's served-sub sample into client→sub rows
  // (captured at subscribe, so this read perturbs nothing the live path)
  const subsByNode = new Map<string, InspectSub[]>()
  for (const snap of snaps) if (snap.role === 'server' && snap.me && snap.subs?.length) subsByNode.set(snap.me, snap.subs)
  return foldSubs(file, subsByNode)
}
