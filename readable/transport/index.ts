// L0 public surface: transport({…}) → Mesh — composes discovery + pool + handshake + DHT into a routing cluster.

import net from 'node:net'
import { value as VALUE } from '../../data/index.ts'
import { Peers } from './peers.ts'
import { STATUS, type Peer } from './peer.ts'
import { DHT, type DHTOpts } from './dht.ts'
import { staticDiscovery } from './discovery/static.ts'
import { initiate, handle, type Identity, type HandshakeHooks } from './handshake.ts'
import { partitionOf, encodeFrame, encodeFrames, controlFrame, VERB, type ChangeRecord, type Frame } from './message.ts'
import type { RetryOpts } from './retries.ts'

export { STATUS } from './peer.ts'

// Config: presence of `port` ⇒ server; the rest are L1/L2 inbound-event hooks routed off the wire.
export type TransportOpts = {
  name: string
  host?: string
  port?: number
  server?: boolean
  hosts?: string[]
  ports?: number[]
  broker?: { host: string; port: number }
  dht?: DHTOpts
  retries?: RetryOpts
  heartbeat?: { interval?: number; misses?: number }
  uuid?: string
  wait?: number
  onRecord?: (record: ChangeRecord, peer?: Peer) => void
  onConnect?: (address: string) => void
  onDigest?: (payload: unknown, address: string) => void
  onCall?: (method: string, arg: unknown, address: string) => unknown
  callTimeout?: number
  onSubscribe?: (subId: number, method: string, arg: unknown, address: string) => void
  onUnsubscribe?: (subId: number, address: string) => void
  onPeerGone?: (address: string) => void
  onWrite?: (record: ChangeRecord, address: string) => WriteOutcome | void
  onReplProbe?: (cid: number, probe: { origin: string; seq: number; partition: string }, address: string) => void
  onReplAck?: (cid: number, address: string) => void
  onViewPrepare?: (value: unknown, address: string) => void
  onViewAck?: (value: unknown, address: string) => void
  onViewCommit?: (value: unknown, address: string) => void
  onJoinRequest?: (value: unknown, address: string) => void
}

// RingSnapshot: the committed ring's shape for L4 observability — members + vnode count, optionally the full arcs.
export type RingSnapshot = { members: string[]; vnodes: number; coverage?: number[]; hashes?: number[]; owners?: string[] }

// WriteOutcome: L2's result for a forwarded write — committed (with the sequencer's origin + seq/epoch) or not (reason: withheld = quorum-less buffer, timeout = no ack). Carried on the WRITE-ACK so a forward learns the TRUE outcome (and, for confirm:'replicated', the (origin,seq) to probe the R-set with), not just receipt.
export type WriteOutcome = { committed: boolean; seq?: number; epoch?: number; reason?: string; origin?: string }

// Mesh: the L0 seam — routing (send/replicate/forward/owners), view-change frames, RPC/subscriptions, chaos taps.
export type Mesh = {
  peers: any
  me?: string
  uuid: string
  owner: (key: string) => string | undefined
  send: (record: ChangeRecord) => void
  replicateTo: (addresses: string[], record: ChangeRecord) => void
  broadcast: (record: ChangeRecord) => void
  forward: (address: string, record: ChangeRecord, onOutcome?: (outcome: WriteOutcome) => void) => boolean
  replProbe: (address: string, cid: number, probe: { origin: string; seq: number; partition: string }) => boolean
  replAck: (address: string, cid: number) => boolean
  owners: (key: string, replicas?: number) => string[]
  holds: (key: string, addr: string, replicas?: number) => boolean
  ringSnapshot: (opts?: { vnodes?: boolean; coverage?: number }) => RingSnapshot
  installView: (members: string[]) => void
  viewMembers: () => string[]
  viewPrepare: (address: string, value: unknown) => boolean
  viewAck: (address: string, value: unknown) => boolean
  viewCommit: (address: string, value: unknown) => boolean
  digestTo: (address: string, payload: unknown) => void
  catchupTo: (address: string, records: ChangeRecord[]) => void
  call: (method: string, arg: unknown, to?: string) => Promise<unknown>
  hasServer: () => boolean
  pickServer: () => string | undefined
  subscribe: (method: string, arg: unknown, onDelta: (record: ChangeRecord) => void, to?: string) => (() => void) | undefined
  deltaTo: (address: string, subId: number, record: ChangeRecord) => void
  drop: (address: string) => boolean
  isolate: (address: string) => void
  heal: (address: string) => void
  ready: Promise<void>
  destroy: () => void
}

// Split "host:port" on the LAST colon so IPv6 hosts survive intact.
const splitAddress = (address: string): [string, number] => {
  const i = address.lastIndexOf(':')
  return [address.slice(0, i), +address.slice(i + 1)]
}

// transport(): wires pool + DHT + handshake + discovery and returns the Mesh seam.
export function transport(opts: TransportOpts): Mesh {
  const host = opts.host ?? '127.0.0.1'
  const isServer = opts.server ?? opts.port !== undefined
  const me = isServer && opts.port !== undefined ? `${host}:${opts.port}` : undefined
  const uuid = opts.uuid ?? crypto.randomUUID()

  // ready resolves on first outbound connect, or falls back to a `wait` timer (the "I'm first" case).
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((r) => (resolveReady = r))
  const readyTimer = setTimeout(resolveReady, opts.wait ?? 500)
  readyTimer.unref?.()

  // addServer: enqueue a server candidate to dial, skipping self.
  const addServer = (address: string) => {
    if (!address || address === me) return
    const [h, p] = splitAddress(address)
    pool.add({ host: h, port: p, role: 'server' })
  }

  // Handshake hooks: advertise our identity+known servers, learn theirs, and finalize the relationship.
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
    // done: re-key the peer to its real identity, then fire onConnect for DIALED peers only (once per direction).
    done: (peer: Peer, id: Identity) => {
      pool.identify(peer, id)
      if (peer.dialed && peer.status === STATUS.connected) opts.onConnect?.(peer.address)
    },
  }

  // Peer pool: dials/accepts sockets, runs the failure detector, and surfaces frames/connect/gone to us.
  const pool = new Peers({
    me,
    uuid,
    retries: opts.retries,
    heartbeat: opts.heartbeat,
    onConnect: (peer) => {
      resolveReady()
      initiate(peer, hooks)
    },
    onPeerGone: (peer) => opts.onPeerGone?.(peer.address),
    onFrame: (frame: Frame, peer: Peer) => dispatch(frame, peer),
  })

  const dht = new DHT(opts.dht)

  // Seed self into the ring + peer table — self owns partitions and is delivered locally (no socket).
  if (me) {
    pool.peers[me] = { address: me, host, port: opts.port, role: 'server', status: STATUS.connected }
    dht.add(me)
  }
  // view: the committed membership that SOLELY drives the ring (not live connections) — ownership stable per epoch.
  let view: string[] = me ? [me] : []

  // RPC/subscription state: shared id counter; `pending` resolves calls, `subs` routes deltas, `warnedVerbs` dedupes drops.
  let callId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> }>()
  const subs = new Map<number, (record: ChangeRecord) => void>()
  const warnedVerbs = new Set<number>()
  // forwards: in-flight ack-confirmed WRITE forwards — id → fallback timer + the outcome callback (the never-drop release).
  const forwards = new Map<number, { timer: ReturnType<typeof setTimeout>; onOutcome: (outcome: WriteOutcome) => void }>()

  // dispatch: the inbound frame router — handshake first, then fan each verb to its hook (fail-closed default).
  function dispatch(frame: Frame, peer: Peer) {
    if (handle(frame, peer, hooks)) return
    switch (frame.verb) {
      case VERB.DIGEST:
        opts.onDigest?.(frame.value ?? {}, peer.address)
        return
      case VERB.SUBSCRIBE: {
        const { method, arg } = (frame.value as { method: string; arg: unknown }) ?? { method: '', arg: undefined }
        opts.onSubscribe?.(frame.id!, method, arg, peer.address)
        return
      }
      case VERB.UNSUBSCRIBE:
        opts.onUnsubscribe?.(frame.id!, peer.address)
        return
      case VERB.WRITE: {
        // WRITE: a forwarded write-request for a partition we own — L2 commits it, making us its sole sequencer.
        let outcome: WriteOutcome | void
        for (const record of frame.records()) outcome = opts.onWrite?.(record, peer.address)
        // WRITE-ACK / NACK: report the TRUE commit outcome — a quorum-less owner that BUFFERED the write must NOT falsely ack it (the acknowledged-loss bug).
        if (frame.id !== undefined) {
          const committed = outcome === undefined || outcome.committed
          peer.write(controlFrame(VERB.ACK, committed ? { ok: true, seq: outcome?.seq, epoch: outcome?.epoch, origin: outcome?.origin } : { ok: false, reason: 'withheld' }, frame.id))
        }
        return
      }
      case VERB.ACK: {
        // ACK: an owner answered a forwarded write — settle the forward with its committed/withheld outcome (+ seq/epoch).
        const fw = forwards.get(frame.id!)
        if (!fw) return
        forwards.delete(frame.id!)
        clearTimeout(fw.timer)
        const v = (frame.value as { ok?: boolean; seq?: number; epoch?: number; reason?: string; origin?: string } | null) ?? { ok: true }
        fw.onOutcome({ committed: v.ok !== false, seq: v.seq, epoch: v.epoch, reason: v.reason, origin: v.origin })
        return
      }
      case VERB.REPL_PROBE:
        // REPL_PROBE: a prober wants a REPL_ACK once our high-water for (origin,partition) reaches seq (confirm:'replicated'); L2 holds it until caught up.
        opts.onReplProbe?.(frame.id!, frame.value as { origin: string; seq: number; partition: string }, peer.address)
        return
      case VERB.REPL_ACK:
        // REPL_ACK: a probed replica confirms it holds (origin,seq) — feed the prober's W-quorum tally for this cid.
        opts.onReplAck?.(frame.id!, peer.address)
        return
      // View-change frames: explicit cases so a VIEW_* frame never falls through to the onRecord data path.
      case VERB.VIEW_PREPARE:
        opts.onViewPrepare?.(frame.value, peer.address)
        return
      case VERB.VIEW_ACK:
        opts.onViewAck?.(frame.value, peer.address)
        return
      case VERB.VIEW_COMMIT:
        opts.onViewCommit?.(frame.value, peer.address)
        return
      case VERB.JOIN_REQUEST:
        opts.onJoinRequest?.(frame.value, peer.address)
        return
      case VERB.CALL: {
        // CALL: run the RPC handler, then reply RESOLVE/REJECT to the same frame id.
        const id = frame.id
        const { method, arg } = (frame.value as { method: string; arg: unknown }) ?? { method: '', arg: undefined }
        Promise.resolve()
          .then(() => opts.onCall?.(method, arg, peer.address))
          .then(
            (value) => peer.write(controlFrame(VERB.RESOLVE, value, id)),
            (err) => peer.write(controlFrame(VERB.REJECT, String((err as Error)?.message ?? err), id)),
          )
        return
      }
      case VERB.RESOLVE:
      case VERB.REJECT: {
        // RESOLVE/REJECT: settle the pending call for this id (clear its timeout) — ignore if already gone.
        const waiter = pending.get(frame.id!)
        if (!waiter) return
        pending.delete(frame.id!)
        if (waiter.timer) clearTimeout(waiter.timer)
        const value = frame.value
        if (frame.verb === VERB.RESOLVE) waiter.resolve(value)
        else waiter.reject(new Error(String(value)))
        return
      }
      case VERB.RECORDS: {
        // RECORDS: the steady-state data path — id ⇒ subscription delta (route by sub), no id ⇒ plain replication.
        if (frame.id !== undefined) {
          const sub = subs.get(frame.id)
          if (sub) for (const record of frame.records()) sub(record)
        } else {
          for (const record of frame.records()) opts.onRecord?.(record, peer)
        }
        return
      }
      default:
        // Fail closed: DROP an unrecognized verb (never fall into RECORDS) and warn once per verb.
        if (!warnedVerbs.has(frame.verb)) {
          warnedVerbs.add(frame.verb)
          console.warn(`fero/transport: dropping frame with unrecognized verb ${frame.verb} from ${peer.address}`)
        }
        return
    }
  }

  // pickServer: choose a connected server (not self) to route an unaddressed call/subscribe to — v1: first match.
  const pickServer = (): string | undefined => {
    for (const [address, row] of Object.entries((pool.peers[VALUE] ?? {}) as Record<string, any>))
      if (address !== me && row.role === 'server' && row.status === STATUS.connected) return address
    return undefined
  }

  // TCP listener (servers only): accept inbound sockets as receive-side peers; we route over our own dialed link.
  let server: net.Server | undefined
  if (isServer && opts.port !== undefined) {
    server = net.createServer((socket) =>
      pool.accept(socket, { host: socket.remoteAddress ?? host, port: socket.remotePort ?? 0, role: 'client' }),
    )
    server.listen(opts.port, host)
  }

  // Discovery → dial: seed static candidates now and tap the ViewProxy so dynamic sources feed the same addServer path.
  const candidates = staticDiscovery({ hosts: opts.hosts ?? [host], ports: opts.ports ?? [], broker: opts.broker, me })
  for (const c of Object.values(candidates[VALUE] ?? {}) as any[]) addServer(c.address)
  const candHost = candidates.connect({}, (change: any) => {
    if (change.type === 'insert') addServer(change.value.address)
  })

  const deliverLocal = (record: ChangeRecord) => opts.onRecord?.(record)

  // sendViewFrame: shared point-to-point VIEW_* sender so L2 never spells a wire verb; false if not connected.
  const sendViewFrame = (address: string, verb: number, value: unknown): boolean => {
    const peer = pool.peer(address)
    if (!peer) return false
    peer.write(controlFrame(verb, value))
    return true
  }

  return {
    peers: pool.peers,
    me,
    uuid,
    owner: (key) => dht.owner(key),
    // send: route a record to its partition owner — deliver locally if we own it, else over the socket.
    send(record) {
      const owner = dht.owner(partitionOf(record))
      if (owner === me) deliverLocal(record)
      else if (owner) pool.sendTo(owner, record)
    },
    // replicateTo: ship a committed record to its R-set, excluding self (already applied + logged).
    replicateTo(addresses, record) {
      for (const a of addresses) if (a !== me) pool.sendTo(a, record)
    },
    broadcast: (record) => pool.broadcast(record),
    // replProbe/replAck: confirm:'replicated' point-to-point control frames (cid in the frame id) — NOT the data outbox, so they never disturb the single-origin-contiguous replication stream.
    replProbe: (address, cid, probe) => {
      const peer = pool.peer(address)
      if (!peer) return false
      peer.write(controlFrame(VERB.REPL_PROBE, probe, cid))
      return true
    },
    replAck: (address, cid) => {
      const peer = pool.peer(address)
      if (!peer) return false
      peer.write(controlFrame(VERB.REPL_ACK, null, cid))
      return true
    },
    owners: (key, replicas) => dht.owners(key, replicas),
    // holds: allocation-free `owners(key,R).includes(addr)` for the per-record held-gate / catch-up filter.
    holds: (key, addr, replicas) => dht.holds(key, addr, replicas),
    // ringSnapshot: cold-path ring summary for the observer — { members, vnodes } by default; full arcs (as plain arrays) only on request.
    ringSnapshot: (opts) => {
      const s = dht.snapshot()
      const out: RingSnapshot = opts?.vnodes
        ? { members: s.members, vnodes: s.vnodes, hashes: Array.from(s.hashes), owners: s.owners.slice() }
        : { members: s.members, vnodes: s.vnodes }
      if (opts?.coverage) out.coverage = dht.coverage(opts.coverage).segments
      return out
    },
    // installView: rebuild the ring to EXACTLY the committed members — the ONLY ring mutation, so ownership is stable per epoch.
    installView: (members) => {
      view = members.slice()
      for (const m of dht.members()) if (!view.includes(m)) dht.remove(m)
      for (const m of view) if (!dht.has(m)) dht.add(m)
    },
    viewMembers: () => view,
    // Named view-frame senders (V1a layering seam): L2 calls these, never a raw verb.
    viewPrepare: (address, value) => sendViewFrame(address, VERB.VIEW_PREPARE, value),
    viewAck: (address, value) => sendViewFrame(address, VERB.VIEW_ACK, value),
    viewCommit: (address, value) => sendViewFrame(address, VERB.VIEW_COMMIT, value),
    // forward: route a write-request to the owner (point-to-point); false if the socket isn't writable so caller commits locally.
    // with onOutcome: ACK-CONFIRMED — socket-write success ≠ delivery (an owner crash inside the
    forward(address, record, onOutcome) {
      const peer = pool.peer(address)
      if (!peer) return false
      if (!onOutcome) return peer.write(encodeFrame([record], { verb: VERB.WRITE }))
      const id = ++callId
      const timer = setTimeout(() => {
        if (forwards.delete(id)) onOutcome({ committed: false, reason: 'timeout' })
      }, opts.callTimeout ?? 5000)
      timer.unref?.()
      forwards.set(id, { timer, onOutcome })
      if (peer.write(encodeFrame([record], { verb: VERB.WRITE, id }))) return true
      forwards.delete(id)
      clearTimeout(timer)
      return false
    },
    // pickServer: the connected server an unaddressed client write/call routes to (undefined ⇒ unreachable).
    pickServer: () => pickServer(),
    // digestTo/catchupTo: anti-entropy sent point-to-point (not the batched outbox) so it can't disturb its single-origin invariant.
    digestTo(address, vector) {
      pool.peer(address)?.write(controlFrame(VERB.DIGEST, vector))
    },
    catchupTo(address, records) {
      const peer = pool.peer(address)
      if (!peer || !records.length) return
      // Reuse the outbox's mixed-origin framing: maximal contiguous-seq runs per frame.
      for (const buf of encodeFrames(records)) peer.write(buf)
    },
    hasServer: () => pickServer() !== undefined,
    // subscribe: open a live sub on a server, returning an unsubscribe; undefined if no writable peer (caller retries).
    subscribe(method, arg, onDelta, to) {
      const address = to ?? pickServer()
      const peer = address ? pool.peer(address) : undefined
      // Gate on writability BEFORE committing the sub, else SUBSCRIBE is silently dropped and the holder's shard is lost forever.
      if (!peer || !peer.writable) return undefined
      const id = ++callId
      subs.set(id, onDelta)
      peer.write(controlFrame(VERB.SUBSCRIBE, { method, arg }, id))
      return () => {
        if (subs.delete(id)) peer.write(controlFrame(VERB.UNSUBSCRIBE, null, id))
      }
    },
    // deltaTo: server → client — queue one subscription delta; the peer's outbox ships ONE id-tagged frame per sub per tick.
    deltaTo(address, subId, record) {
      pool.peer(address)?.sendDelta(subId, record)
    },
    // drop: abruptly kill a peer's socket (no teardown frames) — fault injection that drives the onPeerGone reap path.
    drop(address) {
      const peer = pool.peer(address)
      if (!peer) return false
      peer.destroy()
      return true
    },
    // isolate/heal: reversible link partition — unlike drop, isolate blocks redial so the cut PERSISTS until heal.
    isolate: (address) => pool.isolate(address),
    heal: (address) => pool.heal(address),
    // call: send an RPC to a peer (or picked server) and resolve on RESOLVE/REJECT, rejecting on timeout.
    call(method, arg, to) {
      const address = to ?? pickServer()
      const peer = address ? pool.peer(address) : undefined
      if (!peer) return Promise.reject(new Error('fero: no connected server to call'))
      const id = ++callId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`fero: call ${method} timed out`))
        }, opts.callTimeout ?? 5000)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        peer.write(controlFrame(VERB.CALL, { method, arg }, id))
      })
    },
    ready,
    // destroy: tear down — cancel the ready timer + in-flight forward fallbacks, close the pool and listener.
    destroy() {
      clearTimeout(readyTimer)
      for (const { timer } of forwards.values()) clearTimeout(timer)
      forwards.clear()
      void candHost
      pool.destroy()
      server?.close()
    },
  }
}
