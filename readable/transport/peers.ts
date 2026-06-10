// The peer pool: ONE reactive proxy of truth (membership/status) + derived projections; sockets in a side Map.

import { $, value as VALUE, view as VIEW } from '../../data/index.ts'
import { Peer, STATUS, type HeartbeatOpts } from './peer.ts'
import type { Frame, ChangeRecord } from './message.ts'
import type { RetryOpts } from './retries.ts'

// Pool config: own identity (me/uuid for self-reject), retry/heartbeat tuning, and the frame/connect/gone callbacks.
export type PeersOpts = {
  me?: string
  uuid?: string
  retries?: RetryOpts
  heartbeat?: HeartbeatOpts
  onFrame?: (frame: Frame, peer: Peer) => void
  onConnect?: (peer: Peer) => void
  onPeerGone?: (peer: Peer) => void
}

// A dialable peer address + role — the minimum to register/dial or wrap an accepted socket.
export type PeerInfo = { host: string; port: number; role?: 'server' | 'client' }

// What the handshake teaches us about an accepted inbound peer (subset of Identity — stays decoupled from join).
export type PeerIdentity = { uuid: string; role?: 'server' | 'client'; listen?: string }

export class Peers {
  // cluster.peers — the reactive membership/status view, keyed by address.
  readonly peers: any = $({})
  // Derived projections — incrementally maintained by `data`, no manual lists.
  readonly connected: any = this.peers.filter((p: any) => p.status === STATUS.connected)

  #conns = new Map<string, Peer>() // address → socket machinery
  #blocked = new Set<string>() // addresses isolated by the chaos seam — refuse to (re)dial until healed
  #closing = false // pool teardown in progress — destroy() bulk-clears the maps; per-peer prunes stay quiet
  // #published: a peer owns a cluster.peers row iff published — dialed peers + identified inbound clients only.
  #published = new WeakSet<Peer>()
  // #shadows: identified inbound server sockets keyed by listen address — send fallback + teardown, never ringed.
  #shadows = new Map<string, Peer>()
  #selfAddrs = new Set<string>() // OUR own alternate addresses, learned by uuid at handshake — never (re)dial them
  #me?: string
  #uuid?: string
  #retries?: RetryOpts
  #heartbeat?: HeartbeatOpts
  #onFrame?: (frame: Frame, peer: Peer) => void
  #onConnect?: (peer: Peer) => void
  #onPeerGone?: (peer: Peer) => void

  constructor(opts: PeersOpts = {}) {
    this.#me = opts.me
    this.#uuid = opts.uuid
    this.#retries = opts.retries
    this.#heartbeat = opts.heartbeat
    this.#onFrame = opts.onFrame
    this.#onConnect = opts.onConnect
    this.#onPeerGone = opts.onPeerGone
  }

  // Register & dial a server peer (from discovery/handshake); idempotent, with self/self-alt/isolated guards.
  add({ host, port, role = 'server' }: PeerInfo): Peer | undefined {
    const address = `${host}:${port}`
    if (address === this.#me) return undefined
    if (this.#selfAddrs.has(address)) return undefined
    if (this.#blocked.has(address)) return undefined
    const existing = this.#conns.get(address)
    if (existing) return existing
    this.peers[address] = { address, host, port, role, status: STATUS.disconnected }
    const peer = this.#make({ host, port, role })
    this.#published.add(peer)
    peer.connect()
    return peer
  }

  // Wrap an inbound accepted socket as a connected peer (never redialed); owns no row until identify().
  accept(socket: any, { host, port, role = 'client' }: PeerInfo): Peer {
    return this.#make({ host, port, role, socket })
  }

  // Apply handshake identity: server inbound → re-keyed shadow, client inbound → published row, dial → uuid stamp.
  identify(peer: Peer, id: PeerIdentity) {
    // Idempotency guard: skip an already-identified inbound peer so a replayed DONE can't re-key it twice.
    if (this.#shadows.get(peer.address) === peer || (!peer.dialed && this.#published.has(peer))) return
    // Self-reject by uuid: a handshake carrying OUR uuid (alternate-address self) — prune, destroy, remember.
    if (this.#uuid && id.uuid === this.#uuid) {
      if (peer.dialed) this.#selfAddrs.add(peer.address)
      this.#prune(peer)
      peer.destroy()
      return
    }
    peer.uuid = id.uuid
    if (this.#uuid) peer.setOriginate(this.#uuid < id.uuid)
    // Dialed peer already owns a correctly-keyed row — just stamp its uuid.
    if (peer.dialed) {
      const row = this.peers[peer.address]
      if (row?.[VALUE]) row.uuid = id.uuid
      return
    }
    // No listen address ⇒ inbound CLIENT — publish a connected row under its ephemeral address.
    if (!id.listen) {
      peer.role = id.role ?? 'client'
      this.#published.add(peer)
      this.peers[peer.address] = { address: peer.address, host: peer.host, port: peer.port, role: peer.role, uuid: id.uuid, status: STATUS.connected }
      return
    }
    if (id.listen === this.#me) return
    // Inbound SERVER ⇒ re-key the ephemeral socket to its listen address as a shadow; the dialed peer owns the row.
    this.#conns.delete(peer.address)
    peer.role = 'server'
    peer.address = id.listen
    this.#shadows.set(id.listen, peer)
    const row = this.peers[id.listen]
    if (row?.[VALUE]) row.uuid = id.uuid
  }

  // Construct a Peer wired to the pool callbacks (status→#mirror, frame→onFrame, gone→#prune) and index it in #conns.
  #make(opts: PeerInfo & { socket?: any }): Peer {
    const peer = new Peer({
      ...opts,
      retries: this.#retries,
      heartbeat: this.#heartbeat,
      onStatus: (p) => this.#mirror(p),
      onFrame: (f, p) => this.#onFrame?.(f, p),
      onGone: (p) => this.#prune(p),
    })
    this.#conns.set(peer.address, peer)
    return peer
  }

  // Drop a terminally-gone peer's #conns entry + row (identity-guarded so a shadow can't strand the live dial).
  #prune(peer: Peer) {
    if (this.#closing) return
    if (this.#conns.get(peer.address) === peer) this.#conns.delete(peer.address)
    if (this.#blocked.has(peer.address)) return
    if (this.#published.delete(peer) && this.peers[peer.address]?.[VALUE]) this.peers[VIEW].res.remove([peer.address])
  }

  // Mirror a Peer's status/suspect into its row, writing only the changed field; fires onConnect/onPeerGone.
  #mirror(peer: Peer) {
    if (this.#published.has(peer)) {
      const row = this.peers[peer.address]
      const snap: any = row[VALUE] ?? {}
      if (snap.status !== peer.status) {
        row.status = peer.status
        if (peer.status === STATUS.disconnected && !peer.dialed) this.#onPeerGone?.(peer)
      }
      if (snap.suspect !== peer.suspect) row.suspect = peer.suspect
      if (peer.status === STATUS.connected && peer.dialed) this.#onConnect?.(peer)
      return
    }
    // Unpublished path: a disconnecting server shadow is the sole server-pair reap trigger — fire onPeerGone, drop it.
    if (this.#shadows.get(peer.address) === peer && peer.status === STATUS.disconnected) {
      this.#onPeerGone?.(peer)
      this.#shadows.delete(peer.address)
    }
  }

  // Resolve an address to a send target — dialed peer wins, else its inbound shadow (point-to-point reachability).
  peer(address: string): Peer | undefined {
    return this.#conns.get(address) ?? this.#shadows.get(address)
  }

  // Fan-out primitives (owner-routing is the DHT's job): send to one address...
  sendTo(address: string, record: ChangeRecord) {
    this.#conns.get(address)?.send(record)
  }

  // ...or broadcast to every connected DIALED peer — outbound-only avoids double-delivery in a full mesh.
  broadcast(record: ChangeRecord) {
    for (const peer of this.#conns.values()) if (peer.dialed && peer.status === STATUS.connected) peer.send(record)
  }

  // ── Fault injection (chaos harness): reversible link isolation ──────────────
  // isolate(): block redial + destroy the dialed link — a reversible cut (bidirectional when applied symmetrically).
  isolate(address: string) {
    this.#blocked.add(address)
    const peer = this.#conns.get(address)
    if (peer) {
      peer.destroy()
      this.#conns.delete(address)
    }
  }

  // Reverse isolate(): unblock and re-dial by listen address. The disconnected row
  heal(address: string) {
    if (!this.#blocked.delete(address)) return
    if (this.#conns.has(address)) return
    const row = this.peers[address]?.[VALUE] as PeerInfo | undefined
    if (row) this.add({ host: row.host, port: row.port, role: row.role ?? 'server' })
  }

  // Tear down every dialed conn AND every inbound server shadow (shadows aren't in #conns), then clear the maps.
  destroy() {
    this.#closing = true
    for (const peer of this.#conns.values()) peer.destroy()
    for (const peer of this.#shadows.values()) peer.destroy()
    this.#conns.clear()
    this.#shadows.clear()
  }
}
