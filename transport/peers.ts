// The peer pool. The headline L0 rethink: fero-old kept SIX imperative arrays
// (connected/disconnected/connecting/throttled/client/all) rebuilt on every
// status transition (peers.js:17, peer.js:99,114). Here there is ONE source of
// truth — `peers`, a `data` $() proxy keyed by address — and the membership
// "lists" are *derived projections* (`.filter(...)`) that `data` maintains
// incrementally: flipping one peer's status emits one change record and updates
// each projection in O(delta), not an O(n) array rebuild.
//
// Split of concerns: the reactive proxy holds membership + status (the surface
// L2 exposes as cluster.peers). The socket machinery — Peer instances from
// peer.ts — lives in a side Map; a Peer's onStatus callback mirrors its state
// into the proxy as a single assignment.

import { $, value as VALUE } from '../../data/index.ts'
import { Peer, STATUS, type HeartbeatOpts } from './peer.ts'
import type { Frame, ChangeRecord } from './message.ts'
import type { RetryOpts } from './retries.ts'

export type PeersOpts = {
  me?: string // own address ("host:port") — rejected if added (no self-connect)
  retries?: RetryOpts
  heartbeat?: HeartbeatOpts
  onFrame?: (frame: Frame, peer: Peer) => void
  onConnect?: (peer: Peer) => void // fired when a DIALED peer reaches connected (the dialer initiates the handshake)
  onPeerGone?: (peer: Peer) => void // fired when a peer transitions TO disconnected (socket close / destroy) — drives subscription reaping
}

export type PeerInfo = { host: string; port: number; role?: 'server' | 'client' }

export class Peers {
  // cluster.peers — the reactive membership/status view, keyed by address.
  readonly peers: any = $({})
  // Derived projections — incrementally maintained by `data`, no manual lists.
  readonly connected: any = this.peers.filter((p: any) => p.status === STATUS.connected)

  #conns = new Map<string, Peer>() // address → socket machinery
  #blocked = new Set<string>() // addresses isolated by the chaos seam — refuse to (re)dial until healed
  #me?: string
  #retries?: RetryOpts
  #heartbeat?: HeartbeatOpts
  #onFrame?: (frame: Frame, peer: Peer) => void
  #onConnect?: (peer: Peer) => void
  #onPeerGone?: (peer: Peer) => void

  constructor(opts: PeersOpts = {}) {
    this.#me = opts.me
    this.#retries = opts.retries
    this.#heartbeat = opts.heartbeat
    this.#onFrame = opts.onFrame
    this.#onConnect = opts.onConnect
    this.#onPeerGone = opts.onPeerGone
  }

  // Register a server peer we should dial (from discovery/handshake) and dial it.
  // Idempotent: a re-announced address is a no-op (set semantics give dedup free).
  add({ host, port, role = 'server' }: PeerInfo): Peer | undefined {
    const address = `${host}:${port}`
    if (address === this.#me) return undefined // never connect to self
    if (this.#blocked.has(address)) return undefined // isolated link: refuse to (re)dial, incl. gossip-revival via handshake learn
    const existing = this.#conns.get(address)
    if (existing) return existing // dedup
    this.peers[address] = { address, host, port, role, status: STATUS.disconnected }
    const peer = this.#make({ host, port, role })
    peer.connect()
    return peer
  }

  // Wrap an inbound accepted socket as a connected peer (won't be redialed).
  accept(socket: any, { host, port, role = 'client' }: PeerInfo): Peer {
    const address = `${host}:${port}`
    this.peers[address] = { address, host, port, role, status: STATUS.connected }
    const peer = this.#make({ host, port, role, socket })
    return peer
  }

  #make(opts: PeerInfo & { socket?: any }): Peer {
    const peer = new Peer({
      ...opts,
      retries: this.#retries,
      heartbeat: this.#heartbeat,
      onStatus: (p) => this.#mirror(p),
      onFrame: (f, p) => this.#onFrame?.(f, p),
    })
    this.#conns.set(peer.address, peer)
    return peer
  }

  // Reflect a Peer's connection state into the proxy. Both `status` and the
  // failure-detector `suspect` flag come through here; we write only the field
  // that actually changed (read the row snapshot first) so a suspect flip doesn't
  // emit a redundant `status` record that would needlessly churn derived
  // projections (e.g. the DHT's connected-servers reconcile).
  #mirror(peer: Peer) {
    const row = this.peers[peer.address]
    const snap: any = row[VALUE] ?? {}
    if (snap.status !== peer.status) {
      row.status = peer.status
      // A transition TO disconnected (socket close / destroy) fires onPeerGone — the signal L2
      // reaps a gone peer's served subscriptions on (it never sends an UNSUBSCRIBE frame). Gated to
      // the status CHANGE (not a `suspect`-only mirror), so a suspect flip doesn't spuriously reap;
      // firing for a never-connected dial-failure is harmless (the reaper finds no subs).
      if (peer.status === STATUS.disconnected) this.#onPeerGone?.(peer)
    }
    if (snap.suspect !== peer.suspect) row.suspect = peer.suspect
    if (peer.status === STATUS.connected && peer.dialed) this.#onConnect?.(peer)
  }

  peer(address: string): Peer | undefined {
    return this.#conns.get(address)
  }

  // Fan-out helpers. Owner-routing (which peer) is the DHT's job (index.ts);
  // here we provide the primitives: one address, or every connected peer.
  sendTo(address: string, record: ChangeRecord) {
    this.#conns.get(address)?.send(record)
  }

  // Send to every connected peer we DIALED (outbound). In a gossip-formed full
  // mesh every peer has exactly one outbound conn to every other, so this
  // delivers a record once per peer — avoiding the double-delivery that sending
  // over inbound conns too would cause (each pair has two directional sockets).
  // Server→inbound-client push (subscriptions) is an L2 concern, not this.
  broadcast(record: ChangeRecord) {
    for (const peer of this.#conns.values()) if (peer.dialed && peer.status === STATUS.connected) peer.send(record)
  }

  // ── Fault injection (chaos harness): reversible link isolation ──────────────
  // `drop` (transport) is terminal + one-directional; a faithful partition→heal
  // needs a REVERSIBLE cut. isolate(address) severs our dialed link to a peer AND
  // blocks any redial (direct retry or gossip-revival via handshake learn), so the
  // link stays down until heal(). Used SYMMETRICALLY (the harness isolates both
  // sides) it is a true bidirectional partition: broadcast / catch-up / forward all
  // travel over the dialer's OUTBOUND socket, so cutting both dials cuts both
  // directions, and the inbound sockets (the far end of those dials) close with
  // them. Zero steady-state cost: the isolated peer leaves #conns, so broadcast /
  // sendTo skip it with no new check; #blocked is consulted only in the cold add()
  // dial path (empty Set ⇒ a no-op there in production).
  isolate(address: string) {
    this.#blocked.add(address)
    const peer = this.#conns.get(address)
    if (peer) {
      peer.destroy() // sets the row disconnected (peer.ts) → #reachable drops it → eviction + write-gate engage
      this.#conns.delete(address) // remove so heal() re-dials a FRESH Peer (a destroyed one is terminal)
    }
  }

  // Reverse isolate(): unblock and re-dial by listen address. The disconnected row
  // still carries host/port, so reconnect → handshake → anti-entropy heals the
  // missed writes and the view re-admits the peer (a rejoin WITHOUT a restart).
  heal(address: string) {
    if (!this.#blocked.delete(address)) return // wasn't isolated
    if (this.#conns.has(address)) return // already (re)connected by another path
    const row = this.peers[address]?.[VALUE] as PeerInfo | undefined
    if (row) this.add({ host: row.host, port: row.port, role: row.role ?? 'server' })
  }

  destroy() {
    for (const peer of this.#conns.values()) peer.destroy()
    this.#conns.clear()
  }
}
