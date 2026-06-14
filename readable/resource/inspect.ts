// L4 inspect spine: makeSnapshot(deps) → () → InspectSnapshot — a pure point-in-time read of a node's internals.

import { value } from '../../data/index.ts'
import type { Cluster } from './index.ts'
import type { Log } from '../log/log.ts'
import type { RingSnapshot } from '../transport/index.ts'

// RING_SEGMENTS: the fixed sampling resolution of the ownership donut — constant payload/render cost regardless of cluster size.
export const RING_SEGMENTS = 120

// VERSION_SAMPLE_CAP: max per-key stamps a requested versionSample returns — bounds the drill-down payload (the version map can be huge).
export const VERSION_SAMPLE_CAP = 200

// InspectPeer: one row of a node's OWN peer table (its view of who it can reach) — the network observer can't see this otherwise.
export type InspectPeer = {
  address: string
  host?: string
  port?: number
  role?: string
  status?: number
  suspect?: boolean
  uuid?: string
}

// InspectSnapshot: the whole pull payload — identity + committed view + ring + log/replication digest + peers, all JSON-safe.
export type InspectSnapshot = {
  at: number
  name: string
  uuid: string
  me?: string
  role: 'server' | 'client'
  epoch: number
  members: string[]
  writable: boolean
  viewHistory?: { epoch: number; members: string[] }[]
  ring: RingSnapshot & { replicas: number | null; scoped: boolean }
  log: { size: number; partitions: number; heads: Record<string, number> }
  marks: Record<string, number>
  versions: number
  versionSample?: Record<string, { epoch: number; seq: number; origin: string }>
  pending: number
  orphans: string[]
  subscriptions: number
  observing: boolean
  peers: Record<string, InspectPeer>
}

// What makeSnapshot closes over — all BY REFERENCE; nothing is read until the returned closure is called.
export type SnapshotDeps = {
  name: string
  cluster: Cluster
  viewHistory?: () => { epoch: number; members: string[] }[]
  ringSnapshot: (opts?: { vnodes?: boolean; coverage?: number }) => RingSnapshot
  peers: () => Record<string, any>
  log: Log
  seen: Map<string, number>
  versions: Map<string, { epoch: number; seq: number; origin: string }>
  pending: { length: number }
  orphans: Set<string>
  servedCount: () => number
  observing: () => boolean
  R: number
  scoped: boolean
}

// makeSnapshot: build the pure-read closure once (construction-time, zero hot-path cost); each call is a fresh point-in-time read.
export const makeSnapshot = (deps: SnapshotDeps): ((opts?: { sample?: string[] }) => InspectSnapshot) => {
  const { name, cluster, viewHistory, ringSnapshot, peers, log, seen, versions, pending, orphans, servedCount, observing, R, scoped } = deps
  return (opts) => {
    // Copy out the node's own peer rows as plain scalars (decoupled from data's backing object; truthful point-in-time).
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
      // replicas: ∞ doesn't survive JSON (→ null), so map full replication to null; `scoped` carries the real distinction. coverage:k samples the ownership donut.
      ring: { ...ringSnapshot({ coverage: RING_SEGMENTS }), replicas: Number.isFinite(R) ? R : null, scoped },
      log: { size: log.size, partitions: log.partitions().length, heads: log.heads() },
      marks: Object.fromEntries(seen),
      versions: versions.size,
      pending: pending.length,
      orphans: [...orphans],
      subscriptions: servedCount(),
      observing: observing(),
      peers: peerOut,
    }
    // versionSample (DRILL-DOWN ONLY): per-key LWW stamps for the requested partitions, capped. The
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
    // viewHistory: the committed-view ring, when this node runs membership (servers) — absent on a client.
    const vh = viewHistory?.()
    if (vh && vh.length) out.viewHistory = vh
    return out
  }
}

// peerValue: the data `value` symbol, re-exported so index.ts can pass `() => mesh.peers[peerValue]` without re-importing.
export const peerValue = value
