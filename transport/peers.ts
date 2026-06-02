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

import { $ } from '../../data/index.ts'
import { Peer, STATUS } from './peer.ts'
import type { Frame, ChangeRecord } from './message.ts'
import type { RetryOpts } from './retries.ts'

export type PeersOpts = {
  me?: string // own address ("host:port") — rejected if added (no self-connect)
  retries?: RetryOpts
  onFrame?: (frame: Frame, peer: Peer) => void
  onConnect?: (peer: Peer) => void // fired when a DIALED peer reaches connected (the dialer initiates the handshake)
}

export type PeerInfo = { host: string; port: number; role?: 'server' | 'client' }

export class Peers {
  // cluster.peers — the reactive membership/status view, keyed by address.
  readonly peers: any = $({})
  // Derived projections — incrementally maintained by `data`, no manual lists.
  readonly connected: any = this.peers.filter((p: any) => p.status === STATUS.connected)

  #conns = new Map<string, Peer>() // address → socket machinery
  #me?: string
  #retries?: RetryOpts
  #onFrame?: (frame: Frame, peer: Peer) => void
  #onConnect?: (peer: Peer) => void

  constructor(opts: PeersOpts = {}) {
    this.#me = opts.me
    this.#retries = opts.retries
    this.#onFrame = opts.onFrame
    this.#onConnect = opts.onConnect
  }

  // Register a server peer we should dial (from discovery/handshake) and dial it.
  // Idempotent: a re-announced address is a no-op (set semantics give dedup free).
  add({ host, port, role = 'server' }: PeerInfo): Peer | undefined {
    const address = `${host}:${port}`
    if (address === this.#me) return undefined // never connect to self
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
      onStatus: (p) => this.#mirror(p),
      onFrame: (f, p) => this.#onFrame?.(f, p),
    })
    this.#conns.set(peer.address, peer)
    return peer
  }

  // Reflect a Peer's connection state into the proxy — one nested assignment,
  // one change record; the derived projections recompute in O(delta).
  #mirror(peer: Peer) {
    this.peers[peer.address].status = peer.status
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

  destroy() {
    for (const peer of this.#conns.values()) peer.destroy()
    this.#conns.clear()
  }
}
