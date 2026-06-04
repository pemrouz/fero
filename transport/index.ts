// L0 public surface: transport({…}) → Mesh. Composes the modules into a
// self-organizing, routing cluster:
//
//   discovery → pool dials servers → handshake gossips membership →
//   DHT rings the connected servers → send()/replicate() route records to owners
//
// Pure composition, no god-class. `peers` is the cluster.peers ViewProxy; the
// mesh delivers inbound records to `onRecord` (L1 consumes them) and never owns
// a data store itself. v1 handshake is membership-only — state reconciliation on
// join is deferred to L1.

import net from 'node:net'
import { value as VALUE } from '../../data/index.ts'
import { Peers } from './peers.ts'
import { STATUS, type Peer } from './peer.ts'
import { DHT, type DHTOpts } from './dht.ts'
import { staticDiscovery } from './discovery/static.ts'
import { initiate, handle, type Identity, type HandshakeHooks } from './handshake.ts'
import { partitionOf, encodeFrame, encodeFrames, VERB, type ChangeRecord, type Frame } from './message.ts'
import type { RetryOpts } from './retries.ts'

export type TransportOpts = {
  name: string
  host?: string
  port?: number // listen port — present ⇒ server
  server?: boolean
  hosts?: string[] // static discovery: hosts to consider
  ports?: number[] // static discovery: ports to consider
  broker?: { host: string; port: number }
  dht?: DHTOpts
  retries?: RetryOpts
  heartbeat?: { interval?: number; misses?: number } // failure-detector probe interval + miss threshold
  uuid?: string
  wait?: number // ms to wait for a peer before resolving ready (the "I'm first" case)
  onRecord?: (record: ChangeRecord, peer?: Peer) => void // inbound records (incl. self-routed)
  onConnect?: (address: string) => void // a DIALED peer's handshake completed (catch-up trigger)
  onDigest?: (vector: Record<string, number>, address: string) => void // a peer's anti-entropy digest
  onCall?: (method: string, arg: unknown, address: string) => unknown // inbound RPC — return the reply (may be a Promise)
  callTimeout?: number // ms before an unanswered call() rejects (default 5000)
  onSubscribe?: (subId: number, method: string, arg: unknown, address: string) => void // a peer opened a live subscription
  onUnsubscribe?: (subId: number, address: string) => void // a peer closed one
  onWrite?: (record: ChangeRecord, address: string) => void // a peer forwarded a write-request for a partition we own
  // Membership view-change control frames (Milestone V) — each routes to its own
  // hook so a view frame can NEVER fall through to onRecord (the data path).
  onViewPrepare?: (value: unknown, address: string) => void
  onViewAck?: (value: unknown, address: string) => void
  onViewCommit?: (value: unknown, address: string) => void
  onJoinRequest?: (value: unknown, address: string) => void
}

export type Mesh = {
  peers: any // cluster.peers ViewProxy
  me?: string
  uuid: string
  owner: (key: string) => string | undefined
  send: (record: ChangeRecord) => void
  replicate: (record: ChangeRecord, replicas?: number) => void
  broadcast: (record: ChangeRecord) => void
  forward: (address: string, record: ChangeRecord) => boolean // route a write-request to the owner; false if it isn't connected
  owners: (key: string, replicas?: number) => string[] // the owner + next R-1 replicas clockwise
  installView: (members: string[]) => void // adopt a committed view's membership (V1a: stored; V1b: drives the ring)
  viewMembers: () => string[] // the current committed view's members
  viewSend: (address: string, verb: number, value: unknown) => boolean // send a view-change control frame; false if the peer isn't connected
  digestTo: (address: string, vector: Record<string, number>) => void // send our high-water digest
  catchupTo: (address: string, records: ChangeRecord[]) => void // ship records a peer lacks
  call: (method: string, arg: unknown) => Promise<unknown> // RPC to a connected server
  hasServer: () => boolean // is there a connected server to call?
  subscribe: (method: string, arg: unknown, onDelta: (record: ChangeRecord) => void) => (() => void) | undefined // open a live subscription; returns an unsubscribe (or undefined if no server)
  deltaTo: (address: string, subId: number, record: ChangeRecord) => void // server → client: ship one subscription delta
  ready: Promise<void>
  destroy: () => void
}

const splitAddress = (address: string): [string, number] => {
  const i = address.lastIndexOf(':')
  return [address.slice(0, i), +address.slice(i + 1)]
}

export function transport(opts: TransportOpts): Mesh {
  const host = opts.host ?? '127.0.0.1'
  const isServer = opts.server ?? opts.port !== undefined
  const me = isServer && opts.port !== undefined ? `${host}:${opts.port}` : undefined
  const uuid = opts.uuid ?? crypto.randomUUID()

  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((r) => (resolveReady = r))
  const readyTimer = setTimeout(resolveReady, opts.wait ?? 500)
  readyTimer.unref?.()

  const addServer = (address: string) => {
    if (!address || address === me) return
    const [h, p] = splitAddress(address)
    pool.add({ host: h, port: p, role: 'server' })
  }

  const hooks: HandshakeHooks = {
    identity: (): Identity => ({
      uuid,
      role: isServer ? 'server' : 'client',
      listen: me,
      peers: Object.entries(pool.peers[VALUE] ?? {})
        .filter(([, r]: any) => r.role === 'server')
        .map(([a]) => a),
    }),
    learn: (id: Identity) => {
      if (id.listen) addServer(id.listen)
      for (const a of id.peers ?? []) addServer(a)
    },
    // Relationship established. Fire onConnect for DIALED peers only (each pair
    // dials both ways → gate to one side so catch-up runs once per direction,
    // mirroring broadcast's dialed-only fan-out).
    done: (peer: Peer) => {
      if (peer.dialed) opts.onConnect?.(peer.address)
    },
  }

  const pool = new Peers({
    me,
    retries: opts.retries,
    heartbeat: opts.heartbeat,
    onConnect: (peer) => {
      resolveReady() // first outbound connection ⇒ cluster reachable
      initiate(peer, hooks) // the dialer starts the handshake
    },
    onFrame: (frame: Frame, peer: Peer) => dispatch(frame, peer),
  })

  const dht = new DHT(opts.dht)

  // Self is a ring member (it owns partitions) and a row in cluster.peers, but
  // has no socket — a record whose owner === me is delivered locally.
  if (me) {
    pool.peers[me] = { address: me, host, port: opts.port, role: 'server', status: STATUS.connected }
    dht.add(me)
  }
  // The ring tracks connected SERVERS (the self row above is one) — clients and
  // inbound ephemeral connections are role 'client' and excluded.
  const servers = pool.peers.filter((p: any) => p.role === 'server' && p.status === STATUS.connected)
  dht.track(servers)

  // Committed view membership (Milestone V). Seeded to [self]; L2 installs each
  // committed view here. V1a stores it inert (the ring still tracks live servers
  // above); V1b switches the ring to read from this and removes dht.track.
  let view: string[] = me ? [me] : []

  // RPC state: outstanding calls keyed by frame id, resolved on RESOLVE/REJECT.
  // The same counter ids subscriptions; `subs` routes inbound deltas to handlers.
  let callId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> }>()
  const subs = new Map<number, (record: ChangeRecord) => void>()

  function dispatch(frame: Frame, peer: Peer) {
    if (handle(frame, peer, hooks)) return // INIT/SYNC/DONE
    switch (frame.verb) {
      case VERB.DIGEST:
        opts.onDigest?.((frame.records()[0]?.value as Record<string, number>) ?? {}, peer.address)
        return
      case VERB.SUBSCRIBE: {
        const { method, arg } = (frame.records()[0]?.value as { method: string; arg: unknown }) ?? { method: '', arg: undefined }
        opts.onSubscribe?.(frame.id!, method, arg, peer.address)
        return
      }
      case VERB.UNSUBSCRIBE:
        opts.onUnsubscribe?.(frame.id!, peer.address)
        return
      case VERB.WRITE:
        // A peer forwarded a write-request for a partition we own. Hand each
        // record to L2, which commits it locally (its sink stamps origin=us and
        // replicates) — so we become the single sequencer for the partition.
        for (const record of frame.records()) opts.onWrite?.(record as unknown as ChangeRecord, peer.address)
        return
      // Membership view-change frames (Milestone V) — explicit cases so they
      // route to their own hooks and never fall through to onRecord below.
      case VERB.VIEW_PREPARE:
        opts.onViewPrepare?.(frame.records()[0]?.value, peer.address)
        return
      case VERB.VIEW_ACK:
        opts.onViewAck?.(frame.records()[0]?.value, peer.address)
        return
      case VERB.VIEW_COMMIT:
        opts.onViewCommit?.(frame.records()[0]?.value, peer.address)
        return
      case VERB.JOIN_REQUEST:
        opts.onJoinRequest?.(frame.records()[0]?.value, peer.address)
        return
      case VERB.CALL: {
        const id = frame.id
        const { method, arg } = (frame.records()[0]?.value as { method: string; arg: unknown }) ?? { method: '', arg: undefined }
        Promise.resolve()
          .then(() => opts.onCall?.(method, arg, peer.address))
          .then(
            (value) => peer.write(encodeFrame([{ type: 'update', key: [], value }], { verb: VERB.RESOLVE, id })),
            (err) => peer.write(encodeFrame([{ type: 'update', key: [], value: String((err as Error)?.message ?? err) }], { verb: VERB.REJECT, id })),
          )
        return
      }
      case VERB.RESOLVE:
      case VERB.REJECT: {
        const waiter = pending.get(frame.id!)
        if (!waiter) return
        pending.delete(frame.id!)
        if (waiter.timer) clearTimeout(waiter.timer)
        const value = frame.records()[0]?.value
        if (frame.verb === VERB.RESOLVE) waiter.resolve(value)
        else waiter.reject(new Error(String(value)))
        return
      }
      default: {
        // RECORDS with a frame id is a subscription delta (route by sub id);
        // without one it is plain replication (deliver to onRecord).
        const sub = frame.id !== undefined ? subs.get(frame.id) : undefined
        for (const record of frame.records()) {
          if (sub) sub(record as unknown as ChangeRecord)
          else opts.onRecord?.(record as unknown as ChangeRecord, peer)
        }
      }
    }
  }

  // Pick a connected server peer to route a call to (not self). v1: first match.
  const pickServer = (): string | undefined => {
    for (const [address, row] of Object.entries((pool.peers[VALUE] ?? {}) as Record<string, any>))
      if (address !== me && row.role === 'server' && row.status === STATUS.connected) return address
    return undefined
  }

  // TCP server — accept inbound sockets as receive-side peers (role 'client';
  // we route to a server over the OUTBOUND connection we dial to its listen
  // address, learned via the handshake).
  let server: net.Server | undefined
  if (isServer && opts.port !== undefined) {
    server = net.createServer((socket) =>
      pool.accept(socket, { host: socket.remoteAddress ?? host, port: socket.remotePort ?? 0, role: 'client' }),
    )
    server.listen(opts.port, host)
  }

  // Discovery → dial. Static candidates are emitted synchronously; tap as well
  // so a dynamic source (multicast, later) feeds the same path.
  const candidates = staticDiscovery({ hosts: opts.hosts ?? [host], ports: opts.ports ?? [], broker: opts.broker, me })
  for (const c of Object.values(candidates[VALUE] ?? {}) as any[]) addServer(c.address)
  const candHost = candidates.connect({}, (change: any) => {
    if (change.type === 'insert') addServer(change.value.address)
  })

  const deliverLocal = (record: ChangeRecord) => opts.onRecord?.(record)

  return {
    peers: pool.peers,
    me,
    uuid,
    owner: (key) => dht.owner(key),
    send(record) {
      const owner = dht.owner(partitionOf(record))
      if (owner === me) deliverLocal(record)
      else if (owner) pool.sendTo(owner, record)
    },
    replicate(record, replicas) {
      for (const owner of dht.owners(partitionOf(record), replicas)) {
        if (owner === me) deliverLocal(record)
        else pool.sendTo(owner, record)
      }
    },
    broadcast: (record) => pool.broadcast(record),
    owners: (key, replicas) => dht.owners(key, replicas),
    // Milestone V seam. V1a: installView just stores the committed membership and
    // viewMembers reads it back — the DHT ring still tracks live connected servers
    // (dht.track above), so this is inert (zero behaviour change). V1b makes
    // installView rebuild the ring from these members and removes dht.track.
    installView: (members) => {
      view = members.slice()
    },
    viewMembers: () => view,
    // Send a view-change control frame (one record value under a VIEW_* verb),
    // point-to-point. Returns false if the peer isn't connected.
    viewSend: (address, verb, value) => {
      const peer = pool.peer(address)
      if (!peer) return false
      peer.write(encodeFrame([{ type: 'update', key: [], value }], { verb }))
      return true
    },
    // Forward a write-request to the partition owner (WRITE verb, point-to-point —
    // not the batched broadcast outbox). Returns false if the owner isn't a
    // connected peer right now, so the caller can fall back to a local commit
    // rather than drop the write.
    forward(address, record) {
      const peer = pool.peer(address)
      if (!peer) return false
      peer.write(encodeFrame([record], { verb: VERB.WRITE }))
      return true
    },
    // Point-to-point. Sent as prebuilt frames straight to the peer's socket (not
    // the batched broadcast outbox), so catch-up traffic never disturbs the
    // single-origin-contiguous invariant the steady-state outbox relies on.
    digestTo(address, vector) {
      pool.peer(address)?.write(encodeFrame([{ type: 'update', key: [], value: vector }], { verb: VERB.DIGEST }))
    },
    catchupTo(address, records) {
      const peer = pool.peer(address)
      if (!peer || !records.length) return
      // Reuse the outbox's mixed-origin framing: maximal runs of one origin with
      // contiguous seqs per frame (Lamport gaps and origin changes split).
      for (const buf of encodeFrames(records)) peer.write(buf)
    },
    hasServer: () => pickServer() !== undefined,
    subscribe(method, arg, onDelta) {
      const address = pickServer()
      const peer = address ? pool.peer(address) : undefined
      if (!peer) return undefined
      const id = ++callId
      subs.set(id, onDelta)
      peer.write(encodeFrame([{ type: 'update', key: [], value: { method, arg } }], { verb: VERB.SUBSCRIBE, id }))
      return () => {
        if (subs.delete(id)) peer.write(encodeFrame([{ type: 'update', key: [], value: null }], { verb: VERB.UNSUBSCRIBE, id }))
      }
    },
    deltaTo(address, subId, record) {
      pool.peer(address)?.write(encodeFrame([record], { verb: VERB.RECORDS, id: subId }))
    },
    call(method, arg) {
      const address = pickServer()
      const peer = address ? pool.peer(address) : undefined
      if (!peer) return Promise.reject(new Error('fero: no connected server to call'))
      const id = ++callId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`fero: call ${method} timed out`))
        }, opts.callTimeout ?? 5000)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        peer.write(encodeFrame([{ type: 'update', key: [], value: { method, arg } }], { verb: VERB.CALL, id }))
      })
    },
    ready,
    destroy() {
      clearTimeout(readyTimer)
      void candHost
      pool.destroy()
      server?.close()
    },
  }
}
