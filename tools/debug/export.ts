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
// P1 emits only the subset with a REAL seam today:
//   • resource — members, R (committed view + ring)
//   • node     — keys (LWW-winner count), health derived from writable / pending
//                / orphans / a stale view epoch
//   • partition— owner + R-set + held-count, so UNDER-REPLICATION is real
// Deliberately NOT emitted (no seam yet — arrive in P2-P4, the IDEAS workstream):
//   per-partition keys/wps, replica lag/stuck, the change-record log, ownerByEpoch.
// The viewer renders the gaps gracefully (normalize fills defaults), so a P1
// capture already replaces the hand-authored healthy rows with live data.
// ════════════════════════════════════════════════════════════════════════

import type { InspectSnapshot } from '../../resource/inspect.ts'
import { diagnostics, type Fero } from '../../resource/index.ts'

//! DebugFile: the store-once snapshot shape (the subset P1 can fill); shape.js#normalize consumes it.
export type DebugNode = { addr: string; keys?: number; status?: string; note?: string }
export type DebugPartition = { name: string; owner?: string; R?: number; held?: number; status?: string; note?: string }
export type DebugResource = { name: string; members: string[]; R: number; nodes: DebugNode[]; partitions: DebugPartition[] }
export type DebugFile = { 'fero.debug': 1; _about: string; capturedAt?: string; view: string; resources: DebugResource[] }

//! OwnerLookup: authoritative routing for a partition key — cluster.owner / cluster.replicas, per resource.
export type OwnerLookup = {
  owner?: (resource: string, key: string) => string | undefined
  replicas?: (resource: string, key: string) => string[] | undefined
}

const P1_ABOUT =
  'Captured from a live cluster via the [diagnostics] seam (debug viewer P1). REAL: committed ' +
  'members + R, per-node key count (LWW winners) and health, per-partition owner + replica-set + ' +
  'held-count (so under-replication is a real signal). PENDING (no seam yet — P2-P4): per-partition ' +
  'keys/wps, replica lag, the change-record log, and ownerByEpoch history.'

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

  return { 'fero.debug': 1, _about: P1_ABOUT, capturedAt, view: 'e' + maxEpochAll, resources }
}

//! captureInProcess: snapshot a live in-process cluster — pull each node's
//! [diagnostics].snapshot() + resolve authoritative ownership off a server's ring.
// The always-available diagnostics seam (no observe:true gate, no added
// connections) reads state the hot path already maintains; cluster.owner/replicas
// are pure ring lookups. So a capture perturbs nothing — it's the harness / embedded
// path. (A networkSource-backed CLI over the gated __inspect is a later bite.)
export function captureInProcess(nodes: Fero[], capturedAt = new Date().toISOString()): DebugFile {
  const snaps: InspectSnapshot[] = []
  const ringByResource = new Map<string, { owner: (k: string) => string | undefined; replicas: (k: string) => string[] }>()
  for (const n of nodes) {
    const snap = (n as any)[diagnostics]?.snapshot?.() as InspectSnapshot | undefined
    if (!snap) continue
    snaps.push(snap)
    // a server (cluster.me defined) carries ring authority for its resource; the
    // first one we see per resource answers owner/replicas for that resource
    const cl = (n as any).cluster
    if (cl?.me !== undefined && !ringByResource.has(snap.name)) ringByResource.set(snap.name, cl)
  }
  const lookup: OwnerLookup = {
    owner: (resource, k) => ringByResource.get(resource)?.owner(k),
    replicas: (resource, k) => ringByResource.get(resource)?.replicas(k),
  }
  return foldSnapshots(snaps, lookup, capturedAt)
}
