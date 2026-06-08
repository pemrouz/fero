//! L0 public surface: transport({…}) → Mesh — composes discovery + pool + handshake + DHT into a routing cluster.
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
import { partitionOf, encodeFrame, encodeFrames, controlFrame, VERB, type ChangeRecord, type Frame } from './message.ts'
import type { RetryOpts } from './retries.ts'

// Re-export the peer STATUS enum as part of the L0 public surface, so L1/L2 (e.g. the
// view-change reachability check) read it from the Mesh seam instead of reaching into peer.ts.
export { STATUS } from './peer.ts'

//! Config: presence of `port` ⇒ server; the rest are L1/L2 inbound-event hooks routed off the wire.
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
  onDigest?: (payload: unknown, address: string) => void // a peer's anti-entropy digest ({v: vector, reply: bool})
  onCall?: (method: string, arg: unknown, address: string) => unknown // inbound RPC — return the reply (may be a Promise)
  callTimeout?: number // ms before an unanswered call() rejects (default 5000)
  onSubscribe?: (subId: number, method: string, arg: unknown, address: string) => void // a peer opened a live subscription
  onUnsubscribe?: (subId: number, address: string) => void // a peer closed one
  onPeerGone?: (address: string) => void // a peer's connection dropped (socket close / destroy) — reap its served subscriptions (it never sent UNSUBSCRIBE)
  onWrite?: (record: ChangeRecord, address: string) => void // a peer forwarded a write-request for a partition we own
  // Membership view-change control frames (Milestone V) — each routes to its own
  // hook so a view frame can NEVER fall through to onRecord (the data path).
  onViewPrepare?: (value: unknown, address: string) => void
  onViewAck?: (value: unknown, address: string) => void
  onViewCommit?: (value: unknown, address: string) => void
  onJoinRequest?: (value: unknown, address: string) => void
}

//! Mesh: the L0 seam — routing (send/replicate/forward/owners), view-change frames, RPC/subscriptions, chaos taps.
export type Mesh = {
  peers: any // cluster.peers ViewProxy
  me?: string
  uuid: string
  owner: (key: string) => string | undefined
  send: (record: ChangeRecord) => void
  replicateTo: (addresses: string[], record: ChangeRecord) => void // scoped replication (Milestone P): send a committed record to the given R-set, excluding self (the committer already holds + logged it). Caller passes the precomputed owners(key,R) so the ring is walked once per write.
  broadcast: (record: ChangeRecord) => void
  forward: (address: string, record: ChangeRecord) => boolean // route a write-request to the owner; false if it isn't connected
  owners: (key: string, replicas?: number) => string[] // the owner + next R-1 replicas clockwise
  installView: (members: string[]) => void // adopt a committed view's membership (V1a: stored; V1b: drives the ring)
  viewMembers: () => string[] // the current committed view's members
  viewPrepare: (address: string, value: unknown) => boolean // view-change phase-1 proposal (a ballot); false if the peer isn't connected
  viewAck: (address: string, value: unknown) => boolean // view-change phase-1 promise/ack
  viewCommit: (address: string, value: unknown) => boolean // view-change phase-2 commit
  digestTo: (address: string, payload: unknown) => void // send our anti-entropy digest payload
  catchupTo: (address: string, records: ChangeRecord[]) => void // ship records a peer lacks
  call: (method: string, arg: unknown, to?: string) => Promise<unknown> // RPC; to a specific peer (owner-routed reads — Q1) or a picked connected server
  hasServer: () => boolean // is there a connected server to call?
  subscribe: (method: string, arg: unknown, onDelta: (record: ChangeRecord) => void, to?: string) => (() => void) | undefined // live subscription; to a specific peer or a picked server; returns an unsubscribe (or undefined if not connected)
  deltaTo: (address: string, subId: number, record: ChangeRecord) => void // server → client: ship one subscription delta
  drop: (address: string) => boolean // abruptly close a peer's connection (no UNSUBSCRIBE/teardown frames) — fault injection for chaos tests + the subscription-reap path; false if not connected
  isolate: (address: string) => void // fault injection: reversibly sever a dialed link AND block redial (use symmetrically for a true bidirectional partition); reverse with heal()
  heal: (address: string) => void // reverse isolate(): unblock + re-dial by listen address (reconnect → handshake → anti-entropy heal → view re-admit)
  ready: Promise<void>
  destroy: () => void
}

//! Split "host:port" on the LAST colon so IPv6 hosts survive intact.
const splitAddress = (address: string): [string, number] => {
  const i = address.lastIndexOf(':')
  return [address.slice(0, i), +address.slice(i + 1)]
}

//! transport(): wires pool + DHT + handshake + discovery and returns the Mesh seam.
export function transport(opts: TransportOpts): Mesh {
  const host = opts.host ?? '127.0.0.1'
  const isServer = opts.server ?? opts.port !== undefined
  const me = isServer && opts.port !== undefined ? `${host}:${opts.port}` : undefined
  const uuid = opts.uuid ?? crypto.randomUUID()

  //! ready resolves on first outbound connect, or falls back to a `wait` timer (the "I'm first" case).
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((r) => (resolveReady = r))
  const readyTimer = setTimeout(resolveReady, opts.wait ?? 500)
  readyTimer.unref?.()

  //! addServer: enqueue a server candidate to dial, skipping self.
  const addServer = (address: string) => {
    if (!address || address === me) return
    const [h, p] = splitAddress(address)
    pool.add({ host: h, port: p, role: 'server' })
  }

  //! Handshake hooks: advertise our identity+known servers, learn theirs, and finalize the relationship.
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
    //! done: re-key the peer to its real identity, then fire onConnect for DIALED peers only (once per direction).
    // Relationship established. First resolve the peer's real identity (re-key an
    // inbound server socket to its listen address, stamp uuid, publish a client row),
    // then fire onConnect for DIALED peers only (each pair dials both ways → gate to
    // one side so catch-up runs once per direction, mirroring broadcast's dialed-only
    // fan-out). identify runs before onConnect so a catch-up routes to a stable address.
    done: (peer: Peer, id: Identity) => {
      pool.identify(peer, id)
      // Gate onConnect on still-connected: identify() self-rejects (destroys) a peer presenting our
      // OWN uuid, so a self-connect must not fire the catch-up / ready trigger.
      if (peer.dialed && peer.status === STATUS.connected) opts.onConnect?.(peer.address)
    },
  }

  //! Peer pool: dials/accepts sockets, runs the failure detector, and surfaces frames/connect/gone to us.
  const pool = new Peers({
    me,
    uuid,
    retries: opts.retries,
    heartbeat: opts.heartbeat,
    onConnect: (peer) => {
      resolveReady() // first outbound connection ⇒ cluster reachable
      initiate(peer, hooks) // the dialer starts the handshake
    },
    onPeerGone: (peer) => opts.onPeerGone?.(peer.address), // socket close/destroy → L2 reaps that peer's served subscriptions
    onFrame: (frame: Frame, peer: Peer) => dispatch(frame, peer),
  })

  const dht = new DHT(opts.dht)

  //! Seed self into the ring + peer table — self owns partitions and is delivered locally (no socket).
  // Self is a ring member (it owns partitions) and a row in cluster.peers, but
  // has no socket — a record whose owner === me is delivered locally.
  if (me) {
    pool.peers[me] = { address: me, host, port: opts.port, role: 'server', status: STATUS.connected }
    dht.add(me)
  }
  //! view: the committed membership that SOLELY drives the ring (not live connections) — ownership stable per epoch.
  // Committed view membership (Milestone V). The ring is driven SOLELY by the
  // committed view (installView below), NOT by live connections — ownership is
  // stable within an epoch. L2's ViewManager installs each committed view; until
  // it does, a server rings only itself (seeded via dht.add(me) above), so a
  // pre-view write owns locally and broadcasts (converges) rather than misroutes.
  let view: string[] = me ? [me] : []

  //! RPC/subscription state: shared id counter; `pending` resolves calls, `subs` routes deltas, `warnedVerbs` dedupes drops.
  // RPC state: outstanding calls keyed by frame id, resolved on RESOLVE/REJECT.
  // The same counter ids subscriptions; `subs` routes inbound deltas to handlers.
  let callId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> }>()
  const subs = new Map<number, (record: ChangeRecord) => void>()
  const warnedVerbs = new Set<number>() // unrecognized verbs already warned about (fail-closed default, once per verb)

  //! dispatch: the inbound frame router — handshake first, then fan each verb to its hook (fail-closed default).
  function dispatch(frame: Frame, peer: Peer) {
    if (handle(frame, peer, hooks)) return // INIT/SYNC/DONE
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
      case VERB.WRITE:
        //! WRITE: a forwarded write-request for a partition we own — L2 commits it, making us its sole sequencer.
        // A peer forwarded a write-request for a partition we own. Hand each
        // record to L2, which commits it locally (its sink stamps origin=us and
        // replicates) — so we become the single sequencer for the partition.
        for (const record of frame.records()) opts.onWrite?.(record, peer.address)
        return
      //! View-change frames: explicit cases so a VIEW_* frame never falls through to the onRecord data path.
      // Membership view-change frames (Milestone V) — explicit cases so they
      // route to their own hooks and never fall through to onRecord below.
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
        //! CALL: run the RPC handler, then reply RESOLVE/REJECT to the same frame id.
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
        //! RESOLVE/REJECT: settle the pending call for this id (clear its timeout) — ignore if already gone.
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
        //! RECORDS: the steady-state data path — id ⇒ subscription delta (route by sub), no id ⇒ plain replication.
        // The steady-state DATA path (the highest-throughput inbound) — a first-class named case, not
        // the catch-all. RECORDS with a frame id is a subscription delta (route by sub id); without
        // one it is plain replication (deliver to onRecord). A frame that HAS an id but no matching
        // sub is a STALE/late delta for an already-closed subscription — e.g. an in-flight aggregate
        // partial arriving after a fold unsubscribed a departed holder under churn (Q2c) — and is
        // DROPPED: falling through to onRecord would mis-apply a {key:[],value} subscription delta as
        // a replicated record and clobber state (a key:[] root replace). Plain replication never
        // carries a frame id, so this only ever drops orphaned subscription deltas.
        if (frame.id !== undefined) {
          const sub = subs.get(frame.id)
          if (sub) for (const record of frame.records()) sub(record)
        } else {
          for (const record of frame.records()) opts.onRecord?.(record, peer)
        }
        return
      }
      default:
        //! Fail closed: DROP an unrecognized verb (never fall into RECORDS) and warn once per verb.
        // FAIL CLOSED on an unrecognized verb — DROP it rather than let it fall into the RECORDS path,
        // where a structurally-valid-but-unknown frame would mis-apply via onRecord and clobber state.
        // (PING/PONG are consumed in peer.ts; INIT/SYNC/DONE in handle() above; ACK is unused — so
        // nothing legitimate reaches here.) Warn once per verb so version-skew / corruption is visible
        // without flooding the log.
        if (!warnedVerbs.has(frame.verb)) {
          warnedVerbs.add(frame.verb)
          console.warn(`fero/transport: dropping frame with unrecognized verb ${frame.verb} from ${peer.address}`)
        }
        return
    }
  }

  //! pickServer: choose a connected server (not self) to route an unaddressed call/subscribe to — v1: first match.
  // Pick a connected server peer to route a call to (not self). v1: first match.
  const pickServer = (): string | undefined => {
    for (const [address, row] of Object.entries((pool.peers[VALUE] ?? {}) as Record<string, any>))
      if (address !== me && row.role === 'server' && row.status === STATUS.connected) return address
    return undefined
  }

  //! TCP listener (servers only): accept inbound sockets as receive-side peers; we route over our own dialed link.
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

  //! Discovery → dial: seed static candidates now and tap the ViewProxy so dynamic sources feed the same addServer path.
  // Discovery → dial. Static candidates are emitted synchronously; tap as well
  // so a dynamic source (multicast, later) feeds the same path.
  const candidates = staticDiscovery({ hosts: opts.hosts ?? [host], ports: opts.ports ?? [], broker: opts.broker, me })
  for (const c of Object.values(candidates[VALUE] ?? {}) as any[]) addServer(c.address)
  const candHost = candidates.connect({}, (change: any) => {
    if (change.type === 'insert') addServer(change.value.address)
  })

  const deliverLocal = (record: ChangeRecord) => opts.onRecord?.(record)

  //! sendViewFrame: shared point-to-point VIEW_* sender so L2 never spells a wire verb; false if not connected.
  // Shared body for the named view-frame senders below: one VIEW_* control frame,
  // point-to-point. False if the peer isn't connected. Named per phase (viewPrepare/
  // viewAck/viewCommit) so L2's ViewManager never spells a wire verb — mirroring the
  // inbound onViewPrepare/onViewAck/onViewCommit hooks (the V1a layering seam, made symmetric).
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
    //! send: route a record to its partition owner — deliver locally if we own it, else over the socket.
    send(record) {
      const owner = dht.owner(partitionOf(record))
      if (owner === me) deliverLocal(record)
      else if (owner) pool.sendTo(owner, record)
    },
    //! replicateTo: ship a committed record to its R-set, excluding self (already applied + logged).
    // Scoped replication (Milestone P): ship a committed record to the given R-set
    // (the caller's precomputed owners(key,R)), excluding self — the committer already
    // applied + logged it (commitLocal). Uses the same batched per-peer outbox as
    // broadcast, so framing is identical.
    replicateTo(addresses, record) {
      for (const a of addresses) if (a !== me) pool.sendTo(a, record)
    },
    broadcast: (record) => pool.broadcast(record),
    owners: (key, replicas) => dht.owners(key, replicas),
    //! installView: rebuild the ring to EXACTLY the committed members — the ONLY ring mutation, so ownership is stable per epoch.
    // Adopt a committed view's membership: rebuild the DHT ring to EXACTLY these
    // members (add new, remove departed). This is the only thing that mutates the
    // ring, so ownership is constant between view commits.
    installView: (members) => {
      view = members.slice()
      for (const m of dht.members()) if (!view.includes(m)) dht.remove(m)
      for (const m of view) if (!dht.has(m)) dht.add(m)
    },
    viewMembers: () => view,
    //! Named view-frame senders (V1a layering seam): L2 calls these, never a raw verb.
    viewPrepare: (address, value) => sendViewFrame(address, VERB.VIEW_PREPARE, value),
    viewAck: (address, value) => sendViewFrame(address, VERB.VIEW_ACK, value),
    viewCommit: (address, value) => sendViewFrame(address, VERB.VIEW_COMMIT, value),
    //! forward: route a write-request to the owner (point-to-point); false if the socket isn't writable so caller commits locally.
    // Forward a write-request to the partition owner (WRITE verb, point-to-point —
    // not the batched broadcast outbox). Returns whether the frame was actually
    // handed to a writable socket: false if the owner has no peer OR its socket
    // isn't writable right now (e.g. mid-reconnect), so the caller falls back to a
    // local commit rather than SILENTLY DROPPING the write. (peer.write returns
    // false only when the socket is gone — small control frames don't hit
    // backpressure — so a false here means the frame did not go out.)
    forward(address, record) {
      const peer = pool.peer(address)
      if (!peer) return false
      return peer.write(encodeFrame([record], { verb: VERB.WRITE }))
    },
    //! digestTo/catchupTo: anti-entropy sent point-to-point (not the batched outbox) so it can't disturb its single-origin invariant.
    // Point-to-point. Sent as prebuilt frames straight to the peer's socket (not
    // the batched broadcast outbox), so catch-up traffic never disturbs the
    // single-origin-contiguous invariant the steady-state outbox relies on.
    digestTo(address, vector) {
      pool.peer(address)?.write(controlFrame(VERB.DIGEST, vector))
    },
    catchupTo(address, records) {
      const peer = pool.peer(address)
      if (!peer || !records.length) return
      //! Reuse the outbox's mixed-origin framing: maximal contiguous-seq runs per frame.
      // Reuse the outbox's mixed-origin framing: maximal runs of one origin with
      // contiguous seqs per frame (Lamport gaps and origin changes split).
      for (const buf of encodeFrames(records)) peer.write(buf)
    },
    hasServer: () => pickServer() !== undefined,
    //! subscribe: open a live sub on a server, returning an unsubscribe; undefined if no writable peer (caller retries).
    subscribe(method, arg, onDelta, to) {
      const address = to ?? pickServer()
      const peer = address ? pool.peer(address) : undefined
      //! Gate on writability BEFORE committing the sub, else SUBSCRIBE is silently dropped and the holder's shard is lost forever.
      // Gate on writability BEFORE committing the sub: a peer row can exist while its
      // socket is still connecting (the admit race — a member is in the committed view a
      // tick before its socket finishes), and write() would SILENTLY DROP the SUBSCRIBE
      // (control frames don't queue). Reporting failure (undefined) here makes the caller
      // (a fold's reconcileMembers) NOT record it subscribed, so the aeTimer/commit retry
      // re-attempts once connected — without this the holder's whole shard is dropped
      // forever. Gating on `writable` (not write()'s return) avoids a false-negative on
      // backpressure, where write() returns false but the frame IS queued and will send.
      if (!peer || !peer.writable) return undefined
      const id = ++callId
      subs.set(id, onDelta)
      peer.write(controlFrame(VERB.SUBSCRIBE, { method, arg }, id))
      return () => {
        if (subs.delete(id)) peer.write(controlFrame(VERB.UNSUBSCRIBE, null, id))
      }
    },
    //! deltaTo: server → client — ship one subscription delta as a RECORDS frame tagged with its sub id.
    deltaTo(address, subId, record) {
      pool.peer(address)?.write(encodeFrame([record], { verb: VERB.RECORDS, id: subId }))
    },
    //! drop: abruptly kill a peer's socket (no teardown frames) — fault injection that drives the onPeerGone reap path.
    // Abruptly close a peer's connection — no UNSUBSCRIBE / teardown frames, the way a real network
    // drop looks. Drives onPeerGone (→ L2 reaps that peer's served subscriptions) and is the fault
    // injection the chaos harness needs. Returns false if the peer isn't tracked.
    drop(address) {
      const peer = pool.peer(address)
      if (!peer) return false
      peer.destroy()
      return true
    },
    //! isolate/heal: reversible link partition — unlike drop, isolate blocks redial so the cut PERSISTS until heal.
    // Reversible link isolation (chaos partition→heal) — see Peers.isolate/heal.
    // Unlike drop(), isolate() blocks redial so the cut PERSISTS; heal() restores it.
    isolate: (address) => pool.isolate(address),
    heal: (address) => pool.heal(address),
    //! call: send an RPC to a peer (or picked server) and resolve on RESOLVE/REJECT, rejecting on timeout.
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
    //! destroy: tear down — cancel the ready timer, close the pool and listener.
    destroy() {
      clearTimeout(readyTimer)
      void candHost
      pool.destroy()
      server?.close()
    },
  }
}
