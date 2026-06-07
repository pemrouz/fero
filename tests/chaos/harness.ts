// The reusable N-node chaos harness (plan §9, `tests/chaos/`). The L2 suite grew
// ~30 near-identical copies of one lifecycle: allocate ports, build a per-node
// cfg, fero() them all, wait for a committed view + full mesh, write keys on their
// owners, then destroy everyone. This collects that in one place and adds the
// chaos operations the cluster-level scenarios need — kill / restart / join, a
// faithful network partition (symmetric isolate across the cut) + heal, and the
// convergence + leak predicates to assert against.
//
// It builds on #utils (ports / until / connected / sleep) and the Symbol-keyed
// diagnostics seam (isolate / heal / servedSubscriptions) — the only library
// surface beyond the public fero() API the chaos tests touch.
//
// Two faithful "loss of a node" modes, deliberately distinct:
//   • kill(x) / restart(x) — the process dies (TCP close) and later comes back
//     (re-fero on the same port, restoring from its WAL if storage:true).
//   • partition(a, b) / heal() — the nodes stay ALIVE but can't reach each other
//     (a true bidirectional cut via symmetric isolate); heal() reconnects them
//     WITHOUT a restart, exercising the failure detector + write-gate + rejoin
//     path that a plain kill never does.

import os from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { value } from '../../../data/index.ts'
import { fero, fileStorage, diagnostics } from '../../resource/index.ts'
import { ports, until, connected } from '#utils'

export type Node = Awaited<ReturnType<typeof fero>>

export type ClusterOpts = {
  n: number // number of server nodes to start
  replicas?: number // R; omit ⇒ ∞ (full replication — every node holds everything)
  name?: string // resource name (default: unique per cluster)
  wait?: number // fero() ready wait (default 250)
  antiEntropy?: number // scoped anti-entropy interval (only meaningful with finite replicas)
  heartbeat?: { interval?: number; misses?: number } // failure-detector tuning (fast = quick partition detection)
  evictAfter?: number // view eviction grace (short = quick view change on partition)
  storage?: boolean // back each node with a temp-file WAL so restart() restores state (crash-recovery)
  extra?: Record<string, unknown> // merged into every node's opts (methods, config)
  host?: string
}

const HOST = '127.0.0.1'

// Order-insensitive structural compare. Replicas converge on VALUES, not key
// insertion order (DECISIONS A) — equality must ignore key order. Mirrors the
// `sameState` in resource/index.test.ts (lifted here so chaos tests share it).
const stable = (o: unknown): string =>
  JSON.stringify(o, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)))
      : v,
  )
export const sameState = (a: unknown, b: unknown) => stable(a) === stable(b)

const has = (n: Node, k: string) => k in ((n.data as any)[value] ?? {})

export type Cluster = {
  readonly name: string
  all: () => Node[] // currently-alive nodes (kill/partition aware)
  node: (addr: string) => Node | undefined // alive node by listen address
  owner: (key: string) => string | undefined
  replicasOf: (key: string) => string[]
  formed: (timeout?: number) => Promise<boolean> // committed view of all alive nodes AND full mesh
  viewed: (size?: number, timeout?: number) => Promise<boolean> // committed view of the given size on every alive node
  place: (keys: string[], vfn?: (k: string) => unknown, timeout?: number) => Promise<boolean> // write each key on its owner, await it on its full R-set
  converged: (timeout?: number) => Promise<boolean> // every alive node holds byte-identical state (full replication)
  heldOnReplicas: (keys: string[], timeout?: number) => Promise<boolean> // each key on exactly its R-set, nowhere else (scoped)
  kill: (x: Node | string) => number // destroy a node (returns its port for restart)
  restart: (x: Node | string, extra?: Record<string, unknown>) => Promise<Node> // re-fero on the same port (+ WAL)
  add: (extra?: Record<string, unknown>) => Promise<Node> // join a fresh node on a new port
  client: (server?: Node) => Promise<Node> // a read-only client dialing one server (caller destroys it)
  partition: (a: Node[], b: Node[]) => void // symmetric isolate across the cut (a true bidirectional partition)
  heal: () => void // reverse every active isolation
  servedSubs: () => number // total served subscriptions across alive nodes (leak assertions)
  peerRows: (n: Node) => number // size of a node's cluster.peers (row-leak assertions)
  destroy: () => void // tear down every node + remove temp WALs
}

export async function cluster(opts: ClusterOpts): Promise<Cluster> {
  const host = opts.host ?? HOST
  const name = opts.name ?? `chaos-${randomUUID().slice(0, 8)}`
  const pts = await Promise.all(Array.from({ length: opts.n }, () => ports.free()))
  const wals = new Map<number, string>() // port → WAL path (stable across restart so state survives)
  const isolated: Array<[Node, string]> = [] // (node, peer-address) pairs to undo in heal()
  let nodes: Node[] = []

  const walFor = (port: number) => {
    let p = wals.get(port)
    if (!p) {
      p = join(os.tmpdir(), `fero-chaos-${name}-${port}-${randomUUID().slice(0, 8)}.log`)
      wals.set(port, p)
    }
    return p
  }

  const cfg = (port: number, extra?: Record<string, unknown>) => ({
    host,
    port,
    ports: pts,
    wait: opts.wait ?? 250,
    ...(opts.replicas !== undefined ? { replicas: opts.replicas } : {}),
    ...(opts.antiEntropy !== undefined ? { antiEntropy: opts.antiEntropy } : {}),
    ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}),
    ...(opts.evictAfter !== undefined ? { view: { evictAfter: opts.evictAfter } } : {}),
    ...(opts.storage ? { storage: fileStorage(walFor(port)) } : {}),
    ...(opts.extra ?? {}),
    ...(extra ?? {}),
  })

  const spawn = (port: number, extra?: Record<string, unknown>) => fero(name, cfg(port, extra))

  nodes = await Promise.all(pts.map((p) => spawn(p)))

  const all = () => nodes.filter(Boolean)
  const node = (addr: string) => all().find((n) => n.cluster.me === addr)
  const addrOf = (x: Node | string) => (typeof x === 'string' ? x : x.cluster.me!)
  const ref = () => all()[0]

  const formed = (timeout = 8000) =>
    until(() => {
      const live = all()
      return live.every((n) => n.cluster.members.length === live.length && live.every((m) => m === n || connected(n.cluster, m.cluster.me!)))
    }, timeout)

  const viewed = (size = all().length, timeout = 8000) => until(() => all().every((n) => n.cluster.members.length === size), timeout)

  const place = async (keys: string[], vfn: (k: string) => unknown = (k) => ({ v: k }), timeout = 8000) => {
    const r = ref()
    for (const k of keys) {
      const owner = node(r.cluster.owner(k)!)
      if (owner) owner.data[k] = vfn(k)
    }
    return until(() => keys.every((k) => r.cluster.replicas(k).every((a) => { const h = node(a); return h ? has(h, k) : false })), timeout)
  }

  const converged = (timeout = 8000) =>
    until(() => {
      const live = all()
      if (live.length === 0) return true
      const r = (live[0].data as any)[value]
      return live.every((n) => sameState((n.data as any)[value], r))
    }, timeout)

  const heldOnReplicas = (keys: string[], timeout = 8000) =>
    until(() => {
      const r = ref()
      return keys.every((k) => {
        const reps = r.cluster.replicas(k)
        return reps.every((a) => { const h = node(a); return h ? has(h, k) : false }) && all().every((n) => reps.includes(n.cluster.me!) || !has(n, k))
      })
    }, timeout)

  const kill = (x: Node | string): number => {
    const addr = addrOf(x)
    const n = node(addr)
    const port = +addr.split(':')[1]
    if (n) {
      n.destroy()
      nodes = nodes.filter((m) => m !== n)
    }
    return port
  }

  const restart = async (x: Node | string, extra?: Record<string, unknown>): Promise<Node> => {
    const port = kill(x) // idempotent if already dead — derives the port from the address either way
    const n = await spawn(port, extra)
    nodes.push(n)
    return n
  }

  const add = async (extra?: Record<string, unknown>): Promise<Node> => {
    const port = await ports.free()
    pts.push(port) // future nodes learn it too; existing nodes learn it via inbound handshake gossip
    const n = await spawn(port, extra)
    nodes.push(n)
    return n
  }

  const client = (server?: Node): Promise<Node> => {
    const target = server ?? ref()
    const port = +target.cluster.me!.split(':')[1]
    return fero(name, { host, ports: [port], wait: opts.wait ?? 250, ...(opts.extra ?? {}) })
  }

  // A true bidirectional partition. Each broadcast / catch-up / forward travels
  // over the DIALER's outbound socket, so cutting both dials of every cross-cut
  // pair (and blocking redial / gossip-revival) severs both directions cleanly.
  const partition = (a: Node[], b: Node[]) => {
    for (const x of a)
      for (const y of b) {
        if (x === y) continue
        ;(x as any)[diagnostics].isolate(y.cluster.me)
        ;(y as any)[diagnostics].isolate(x.cluster.me)
        isolated.push([x, y.cluster.me!], [y, x.cluster.me!])
      }
  }

  const heal = () => {
    for (const [n, addr] of isolated)
      try {
        ;(n as any)[diagnostics].heal(addr)
      } catch {}
    isolated.length = 0
  }

  const servedSubs = () => all().reduce((s, n) => s + (n as any)[diagnostics].servedSubscriptions(), 0)
  const peerRows = (n: Node) => Object.keys((n.cluster.peers as any)[value] ?? {}).length

  const destroy = () => {
    for (const n of nodes)
      try {
        n.destroy()
      } catch {}
    nodes = []
    for (const p of wals.values())
      try {
        rmSync(p, { force: true })
      } catch {}
  }

  return {
    name,
    all,
    node,
    owner: (key) => ref()?.cluster.owner(key),
    replicasOf: (key) => ref()?.cluster.replicas(key) ?? [],
    formed,
    viewed,
    place,
    converged,
    heldOnReplicas,
    kill,
    restart,
    add,
    client,
    partition,
    heal,
    servedSubs,
    peerRows,
    destroy,
  }
}
