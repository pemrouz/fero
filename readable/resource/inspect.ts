// L4 inspect spine: makeSnapshot(deps) → () → InspectSnapshot — a pure point-in-time read of a node's internals.

import { value } from '../../data/index.ts'
import type { Cluster } from './index.ts'
import type { Log } from '../log/log.ts'
import type { RingSnapshot } from '../transport/index.ts'

// RING_SEGMENTS: the fixed sampling resolution of the ownership donut — constant payload/render cost regardless of cluster size.
export const RING_SEGMENTS = 120

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
  ring: RingSnapshot & { replicas: number | null; scoped: boolean }
  log: { size: number; partitions: number; heads: Record<string, number> }
  marks: Record<string, number>
  versions: number
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
  ringSnapshot: (opts?: { vnodes?: boolean; coverage?: number }) => RingSnapshot
  peers: () => Record<string, any>
  log: Log
  seen: Map<string, number>
  versions: Map<string, unknown>
  pending: { length: number }
  orphans: Set<string>
  servedCount: () => number
  observing: () => boolean
  R: number
  scoped: boolean
}

// makeSnapshot: build the pure-read closure once (construction-time, zero hot-path cost); each call is a fresh point-in-time read.
export const makeSnapshot = (deps: SnapshotDeps): (() => InspectSnapshot) => {
  const { name, cluster, ringSnapshot, peers, log, seen, versions, pending, orphans, servedCount, observing, R, scoped } = deps
  return () => {
    // Copy out the node's own peer rows as plain scalars (decoupled from data's backing object; truthful point-in-time).
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
  }
}

// peerValue: the data `value` symbol, re-exported so index.ts can pass `() => mesh.peers[peerValue]` without re-importing.
export const peerValue = value
