//! L4 inspect spine: makeSnapshot(deps) → () → InspectSnapshot — a pure point-in-time read of a node's internals.
// resource/inspect.ts — the PULL spine of the L4 observer (see ../plan.md L4 +
// ../tools/observe/).
//
// A running fero node holds a lot of state that is invisible from outside: the
// committed view (epoch / members / writable gate), the DHT ring, the per-origin
// high-water marks, the LWW version map, orphan/shed bookkeeping, the served-
// subscription count, and its own peer table. A plain read-only client sees NONE
// of it (it reports epoch=1 / members=[]). makeSnapshot() exposes all of it as ONE
// plain, JSON-serializable object that an observer pulls on demand.
//
// WHY PULL (vs an always-on reactive tap): a snapshot is a PURE READ of state the
// hot path already maintains — it reads `seen`/`versions`/`log`/`mesh` BY REFERENCE
// and materializes the object only when called. So when nobody is observing it
// costs exactly nothing: an unused closure, never invoked on the write/replicate
// path. The observer polls it (~1/s); the truthful slow-changing families
// (topology, replication health) ride this channel. The fast per-record contention
// stream is a SEPARATE, gated push hook (resource/observe.ts — a later slice).
//
// It is multi-node-keyed-by-uuid from day one: each node self-reports its own view,
// so a bridge that polls N nodes composes the cluster picture (and divergence
// between nodes is itself the split-brain signal).

import { value } from '../../data/index.ts'
import type { Cluster } from './index.ts'
import type { Log } from '../log/log.ts'
import type { RingSnapshot } from '../transport/index.ts'

//! RING_SEGMENTS: the fixed sampling resolution of the ownership donut — constant payload/render cost regardless of cluster size.
export const RING_SEGMENTS = 120

//! InspectPeer: one row of a node's OWN peer table (its view of who it can reach) — the network observer can't see this otherwise.
export type InspectPeer = {
  address: string
  host?: string
  port?: number
  role?: string
  status?: number // STATUS enum (0 disconnected · 1 connecting · 2 throttled · 3 connected)
  suspect?: boolean // the failure detector's verdict (half-open but unreachable)
  uuid?: string // stable identity (present once the handshake completes)
}

//! InspectSnapshot: the whole pull payload — identity + committed view + ring + log/replication digest + peers, all JSON-safe.
// A point-in-time, JSON-serializable picture of ONE node. Stable contract: later
// slices ADD fields (a coarse change stream, lag detail) but never reshape these.
export type InspectSnapshot = {
  at: number // wall-clock ms when sampled — the staleness gate (cross-node ordering uses the bridge's clock, not this)
  name: string // the resource name (multi-resource dashboards key on it)
  uuid: string // this node's stable identity — the merge key across N nodes
  me?: string // listen address; undefined ⇒ a read-only client
  role: 'server' | 'client'
  // committed view (Milestone V) — a read-only client reports epoch=1 / members=[] / writable=true
  epoch: number
  members: string[]
  writable: boolean
  // ownership / ring — { members, vnodes, coverage } + the replication factor (null ⇒ full replication, R=∞) and scoped flag.
  // `coverage[i]` is the member-INDEX (into ring.members) owning the i-th of K evenly-spaced keyspace segments — the ownership donut.
  ring: RingSnapshot & { replicas: number | null; scoped: boolean }
  // replication / log
  log: { size: number; partitions: number; heads: Record<string, number> }
  marks: Record<string, number> // the dedup high-water digest (raw seenKey granularity: origin, or origin\x00partition when scoped)
  versions: number // count of LWW-winner entries (the full map can be large; a sample is a later slice)
  pending: number // write-gate buffer depth (writes held while quorum-less)
  orphans: string[] // scoped: partitions held but no longer replicated (awaiting confirmed shed)
  subscriptions: number // served-subscription count
  observing: boolean // is the __observe push gate armed (≥1 live subscriber)? A bridge holding a sub against observing:false knows its push leg died (e.g. a socket bounce reaped it server-side) and re-subscribes
  peers: Record<string, InspectPeer> // this node's own peer table
}

//! What makeSnapshot closes over — all BY REFERENCE; nothing is read until the returned closure is called.
export type SnapshotDeps = {
  name: string
  cluster: Cluster // live getters: uuid / me / epoch / members / writable
  ringSnapshot: (opts?: { vnodes?: boolean; coverage?: number }) => RingSnapshot // mesh.ringSnapshot
  peers: () => Record<string, any> // () => mesh.peers[value] (the raw backing row map)
  log: Log
  seen: Map<string, number> // dedup high-water (the digest)
  versions: Map<string, unknown> // LWW winners (we ship the count)
  pending: { length: number } // the write-gate buffer
  orphans: Set<string>
  servedCount: () => number // dispatch.servedCount
  observing: () => boolean // is the push gate armed? (() => observe !== undefined)
  R: number // replication factor (Infinity ⇒ full replication)
  scoped: boolean
}

//! makeSnapshot: build the pure-read closure once (construction-time, zero hot-path cost); each call is a fresh point-in-time read.
// Returns a thunk that, WHEN CALLED, reads the live state by reference and copies
// out a plain object. Constructed once per node (even when observe is off — it's a
// harmless closure that nothing invokes); the in-process diagnostics seam exposes
// it directly, and the gated `__inspect` method projects it to a remote observer.
// Allocations here (Object.fromEntries(seen), log.heads(), the peer copy) are
// O(origins + partitions + peers) and happen ONCE PER POLL, never per write — so
// they sit firmly off the replication hot path.
export const makeSnapshot = (deps: SnapshotDeps): (() => InspectSnapshot) => {
  const { name, cluster, ringSnapshot, peers, log, seen, versions, pending, orphans, servedCount, observing, R, scoped } = deps
  return () => {
    //! Copy out the node's own peer rows as plain scalars (decoupled from data's backing object; truthful point-in-time).
    const raw = peers() ?? {}
    const peerOut: Record<string, InspectPeer> = {}
    for (const a in raw) {
      const r = raw[a]
      if (!r) continue
      peerOut[a] = { address: r.address, host: r.host, port: r.port, role: r.role, status: r.status, suspect: r.suspect, uuid: r.uuid }
    }
    return {
      at: Date.now(),
      name,
      uuid: cluster.uuid,
      me: cluster.me,
      role: cluster.me === undefined ? 'client' : 'server',
      epoch: cluster.epoch,
      members: cluster.members.slice(),
      writable: cluster.writable,
      //! replicas: ∞ doesn't survive JSON (→ null), so map full replication to null; `scoped` carries the real distinction. coverage:k samples the ownership donut.
      ring: { ...ringSnapshot({ coverage: RING_SEGMENTS }), replicas: Number.isFinite(R) ? R : null, scoped },
      log: { size: log.size, partitions: log.partitions().length, heads: log.heads() },
      marks: Object.fromEntries(seen), // raw seenKey granularity — do NOT collapse (scoped marks are per-(origin,partition))
      versions: versions.size,
      pending: pending.length,
      orphans: [...orphans],
      subscriptions: servedCount(),
      observing: observing(),
      peers: peerOut,
    }
  }
}

//! peerValue: the data `value` symbol, re-exported so index.ts can pass `() => mesh.peers[peerValue]` without re-importing.
export const peerValue = value
