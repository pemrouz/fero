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

//! VERSION_SAMPLE_CAP: max per-key stamps a requested versionSample returns — bounds the drill-down payload (the version map can be huge).
export const VERSION_SAMPLE_CAP = 200

//! InspectSub: one served subscription's TOPOLOGY — who we serve it to (downstream addr), the method/key, its kind, and (forwarded reads) the owner we relay from.
// NO lag/seq field: a subscription delta is a synthetic proxy record ({type,key,value}) carrying no
// provenance, so a seq-based sub-lag isn't honestly measurable — this is the live subscription topology,
// not a rate. kind ∈ forward | gather | fold | partial | observe | projection. [P3 — see DECISIONS O1]
export type InspectSub = { to: string; method: string; key?: string; kind: string; owner?: string }

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
  // viewHistory: bounded ring of committed views (current + past, newest last) — present on
  // servers that run membership. The replay / owner-by-epoch primitive: re-deriving the DHT
  // ring from each past view's members recovers who owned what at that epoch (P4).
  viewHistory?: { epoch: number; members: string[] }[]
  // ownership / ring — { members, vnodes, coverage } + the replication factor (null ⇒ full replication, R=∞) and scoped flag.
  // `coverage[i]` is the member-INDEX (into ring.members) owning the i-th of K evenly-spaced keyspace segments — the ownership donut.
  ring: RingSnapshot & { replicas: number | null; scoped: boolean }
  // replication / log
  log: { size: number; partitions: number; heads: Record<string, number> }
  marks: Record<string, number> // the dedup high-water digest (raw seenKey granularity: origin, or origin\x00partition when scoped)
  versions: number // count of LWW-winner entries (the full map can be large; request a per-key sample via opts.sample)
  // versionSample: present ONLY when a drill-down requested it (opts.sample = partition keys) — per-key LWW
  // stamps for those partitions (k === p OR k.startsWith(p\x00)), capped at VERSION_SAMPLE_CAP. The cross-node
  // divergence / stuck-replica primitive: comparable because every node returns the SAME keys for the same
  // partition request, so a replica parked on a lower (epoch,seq) is visible. Off the steady poll, so the
  // O(versions) scan it costs never rides the per-poll path.
  versionSample?: Record<string, { epoch: number; seq: number; origin: string }>
  pending: number // write-gate buffer depth (writes held while quorum-less)
  orphans: string[] // scoped: partitions held but no longer replicated (awaiting confirmed shed)
  subscriptions: number // served-subscription count
  // subs: a bounded sample of the live subscription TOPOLOGY (who we serve, of what kind) — present
  // when this node serves ≥1 sub. The descriptive companion to `subscriptions` (the count); the viewer
  // folds these into client→sub rows. Captured at subscribe (cold), so it costs the per-delta path nothing.
  subs?: InspectSub[]
  observing: boolean // is the __observe push gate armed (≥1 live subscriber)? A bridge holding a sub against observing:false knows its push leg died (e.g. a socket bounce reaped it server-side) and re-subscribes
  // births: per-partition FIRST-seen epoch ({ partition → epoch }), present only on a node opened with
  // fero(name,{debug}). The owner-timeline anchor — foldOwnership gates each partition's history at its
  // birth so a placement isn't miscounted as a move. Exact + compaction-proof (set-once off log.onAppend).
  births?: Record<string, number>
  peers: Record<string, InspectPeer> // this node's own peer table
}

//! What makeSnapshot closes over — all BY REFERENCE; nothing is read until the returned closure is called.
export type SnapshotDeps = {
  name: string
  cluster: Cluster // live getters: uuid / me / epoch / members / writable
  viewHistory?: () => { epoch: number; members: string[] }[] // ViewManager.history (servers only; absent on a client)
  ringSnapshot: (opts?: { vnodes?: boolean; coverage?: number }) => RingSnapshot // mesh.ringSnapshot
  peers: () => Record<string, any> // () => mesh.peers[value] (the raw backing row map)
  log: Log
  seen: Map<string, number> // dedup high-water (the digest)
  versions: Map<string, { epoch: number; seq: number; origin: string }> // LWW winner stamps (we ship the count; a requested sample reads the stamps)
  pending: { length: number } // the write-gate buffer
  orphans: Set<string>
  servedCount: () => number // dispatch.servedCount
  servedSubs?: () => InspectSub[] // dispatch.servedSubs — the bounded subscription-topology sample (absent on a client, which serves nothing)
  observing: () => boolean // is the push gate armed? (() => observe !== undefined)
  births?: () => Record<string, number> // debug-only: per-partition first-seen epoch (absent unless fero(name,{debug}))
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
export const makeSnapshot = (deps: SnapshotDeps): ((opts?: { sample?: string[] }) => InspectSnapshot) => {
  const { name, cluster, viewHistory, ringSnapshot, peers, log, seen, versions, pending, orphans, servedCount, servedSubs, observing, births, R, scoped } = deps
  return (opts) => {
    //! Copy out the node's own peer rows as plain scalars (decoupled from data's backing object; truthful point-in-time).
    const raw = peers() ?? {}
    const peerOut: Record<string, InspectPeer> = {}
    for (const a in raw) {
      const r = raw[a]
      if (!r) continue
      peerOut[a] = { address: r.address, host: r.host, port: r.port, role: r.role, status: r.status, suspect: r.suspect, uuid: r.uuid }
    }
    const out: InspectSnapshot = {
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
    //! versionSample (DRILL-DOWN ONLY): per-key LWW stamps for the requested partitions, capped. The
    // O(versions) scan rides this branch alone — when no sample is requested the snapshot is unchanged,
    // so the steady poll never pays it. Same partition-prefix matching as shed (k === p | k\x00…).
    if (opts?.sample?.length) {
      const want = opts.sample
      const sample: Record<string, { epoch: number; seq: number; origin: string }> = {}
      let n = 0
      scan: for (const [k, v] of versions) {
        for (let i = 0; i < want.length; i++) {
          const p = want[i]
          if (k === p || k.startsWith(p + '\x00')) {
            sample[k] = { epoch: v.epoch, seq: v.seq, origin: v.origin }
            if (++n >= VERSION_SAMPLE_CAP) break scan
            break
          }
        }
      }
      out.versionSample = sample
    }
    //! viewHistory: the committed-view ring, when this node runs membership (servers) — absent on a client.
    const vh = viewHistory?.()
    if (vh && vh.length) out.viewHistory = vh
    //! subs: the bounded subscription-topology sample, when this node serves ≥1 sub — absent otherwise (keeps the steady poll lean).
    const ss = servedSubs?.()
    if (ss && ss.length) out.subs = ss
    //! births: per-partition first-seen epoch, when this node is opened with fero(name,{debug}) — the owner-timeline anchor.
    const bo = births?.()
    if (bo && Object.keys(bo).length) out.births = bo
    return out
  }
}

//! peerValue: the data `value` symbol, re-exported so index.ts can pass `() => mesh.peers[peerValue]` without re-importing.
export const peerValue = value
