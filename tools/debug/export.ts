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
// Deliberately NOT emitted (no seam yet — arrive in P3-P4, the IDEAS workstream):
//   per-partition keys/wps, the change-record log, ownerByEpoch history.
// The viewer renders the gaps gracefully (normalize fills defaults), so a capture
// already replaces the hand-authored rows with live data.
// ════════════════════════════════════════════════════════════════════════

import type { InspectSnapshot } from '../../resource/inspect.ts'
import { diagnostics, type Fero } from '../../resource/index.ts'

//! DebugFile: the store-once snapshot shape (the subset P1/P2 can fill); shape.js#normalize consumes it.
export type DebugReplica = { addr: string; lag?: number; stuckAt?: string; stale?: boolean; missing?: boolean; note?: string }
export type DebugNode = { addr: string; keys?: number; status?: string; note?: string }
export type DebugPartition = { name: string; owner?: string; R?: number; held?: number; status?: string; note?: string; replicas?: DebugReplica[] }
export type DebugResource = { name: string; members: string[]; R: number; nodes: DebugNode[]; partitions: DebugPartition[] }
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
  'Captured from a live cluster via the [diagnostics] seam (debug viewer P1+P2). REAL: committed ' +
  'members + R, per-node key count (LWW winners) + health, per-partition owner + replica-set + held ' +
  '(under-replication), and per-replica DIVERGENCE — a replica parked on a lower (epoch,seq) than its ' +
  "owner is flagged stuck (P2, via the version-sample drill). PENDING (no seam yet — P3-P4): per-partition " +
  'keys/wps, the change-record log, and ownerByEpoch history.'

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

//! captureInProcess: snapshot a live in-process cluster — pull each node's
//! [diagnostics].snapshot() + resolve authoritative ownership off a server's ring.
// The always-available diagnostics seam (no observe:true gate, no added
// connections) reads state the hot path already maintains; cluster.owner/replicas
// are pure ring lookups. So a capture perturbs nothing — it's the harness / embedded
// path. (A networkSource-backed CLI over the gated __inspect is a later bite.)
export function captureInProcess(nodes: Fero[], capturedAt = new Date().toISOString()): DebugFile {
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
  return foldDivergence(file, sampleByNode)
}
