//! The peer pool: ONE reactive proxy of truth (membership/status) + derived projections; sockets in a side Map.
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

import { $, value as VALUE, view as VIEW } from '../../data/index.ts'
import { Peer, STATUS, type HeartbeatOpts } from './peer.ts'
import type { Frame, ChangeRecord } from './message.ts'
import type { RetryOpts } from './retries.ts'

//! Pool config: own identity (me/uuid for self-reject), retry/heartbeat tuning, and the frame/connect/gone callbacks.
export type PeersOpts = {
  me?: string // own address ("host:port") — rejected if added (no self-connect)
  uuid?: string // own stable identity — rejects a self-connect reached via an ALTERNATE address (uuid self-reject)
  retries?: RetryOpts
  heartbeat?: HeartbeatOpts
  onFrame?: (frame: Frame, peer: Peer) => void
  onConnect?: (peer: Peer) => void // fired when a DIALED peer reaches connected (the dialer initiates the handshake)
  onPeerGone?: (peer: Peer) => void // fired when a peer transitions TO disconnected (socket close / destroy) — drives subscription reaping
}

//! A dialable peer address + role — the minimum to register/dial or wrap an accepted socket.
export type PeerInfo = { host: string; port: number; role?: 'server' | 'client' }

//! What the handshake teaches us about an accepted inbound peer (subset of Identity — stays decoupled from join).
// What the handshake teaches us about an accepted inbound peer (a structural subset
// of handshake.ts's Identity — Peers stays decoupled from the join protocol).
export type PeerIdentity = { uuid: string; role?: 'server' | 'client'; listen?: string }

export class Peers {
  //! cluster.peers — the reactive membership/status view, keyed by address.
  readonly peers: any = $({})
  //! Derived projections — incrementally maintained by `data`, no manual lists.
  readonly connected: any = this.peers.filter((p: any) => p.status === STATUS.connected)

  #conns = new Map<string, Peer>() //! address → socket machinery
  #blocked = new Set<string>() //! addresses isolated by the chaos seam — refuse to (re)dial until healed
  //! #published: a peer owns a cluster.peers row iff published — dialed peers + identified inbound clients only.
  // A peer OWNS a cluster.peers row iff it's published: every dialed peer, plus an inbound
  // CLIENT once the handshake identifies it. An inbound SERVER socket is instead a receive/
  // serve SHADOW (re-keyed to its listen address for stable onSubscribe/reap keys) whose
  // membership identity is the dialed row — so a half-handshake inbound never leaks a phantom
  // row, and the ring only ever sees dialed server rows.
  #published = new WeakSet<Peer>()
  //! #shadows: identified inbound server sockets keyed by listen address — send fallback + teardown, never ringed.
  // Identified inbound server sockets, keyed by listen address. Two jobs: (1) a SEND fallback in
  // peer() so an inbound-only link (no successful dial back) is still reachable point-to-point; the
  // dialed peer to that address WINS when present. (2) the teardown set. NOT in #conns (so broadcast
  // — dialed-only — never double-sends) and never published (so the ring sees only dialed rows).
  #shadows = new Map<string, Peer>()
  #selfAddrs = new Set<string>() //! OUR own alternate addresses, learned by uuid at handshake — never (re)dial them
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

  //! Register & dial a server peer (from discovery/handshake); idempotent, with self/self-alt/isolated guards.
  // Register a server peer we should dial (from discovery/handshake) and dial it.
  // Idempotent: a re-announced address is a no-op (set semantics give dedup free).
  add({ host, port, role = 'server' }: PeerInfo): Peer | undefined {
    const address = `${host}:${port}`
    if (address === this.#me) return undefined // never connect to self (by address)
    if (this.#selfAddrs.has(address)) return undefined // a self alternate-address, learned via uuid at handshake — no self-loop
    if (this.#blocked.has(address)) return undefined // isolated link: refuse to (re)dial, incl. gossip-revival via handshake learn
    const existing = this.#conns.get(address)
    if (existing) return existing // dedup
    this.peers[address] = { address, host, port, role, status: STATUS.disconnected }
    const peer = this.#make({ host, port, role })
    this.#published.add(peer) // a dialed peer owns its listen-keyed row
    peer.connect()
    return peer
  }

  //! Wrap an inbound accepted socket as a connected peer (never redialed); owns no row until identify().
  // Wrap an inbound accepted socket as a connected peer (won't be redialed). It owns NO
  // cluster.peers row yet — an accepted socket is keyed by an undialable ephemeral port and
  // its role is unknown until the handshake. identify() (on handshake DONE) publishes a
  // client row or folds a server into its dialed listen-address identity, so a half-handshake
  // inbound never leaks a phantom row.
  accept(socket: any, { host, port, role = 'client' }: PeerInfo): Peer {
    return this.#make({ host, port, role, socket })
  }

  //! Apply handshake identity: server inbound → re-keyed shadow, client inbound → published row, dial → uuid stamp.
  // Resolve an accepted inbound peer's real identity from the completed handshake (or stamp a
  // dialed peer's uuid). An inbound socket is accepted under an ephemeral port; the handshake
  // reveals uuid, role and (for a server) the listen address:
  //  - a SERVER inbound socket becomes a receive/serve SHADOW re-keyed to its listen address
  //    (so onSubscribe and the reap that follows key under one stable, dialable address), while
  //    the DIALED peer to that listen address stays the routable/ring identity + row owner;
  //  - a CLIENT inbound socket is published under its ephemeral address as role 'client';
  //  - a DIALED peer already owns a correctly-keyed row — we only stamp its uuid.
  // The ring only ever sees dialed server rows, so a server shadow is never ringed (matching the
  // prior ephemeral-client exclusion) — this just kills the phantom client row and gives the
  // sender a stable address. Connection-dedup to one socket + dead-row pruning stay open (IDEAS).
  identify(peer: Peer, id: PeerIdentity) {
    //! Idempotency guard: skip an already-identified inbound peer so a replayed DONE can't re-key it twice.
    // Idempotent: a duplicate/replayed DONE (a retransmit, or a re-handshake triggered when a
    // suspect-flip re-fires #onConnect → re-initiate, or a buggy/hostile peer) must NOT re-key an
    // inbound peer twice. Once a shadow is re-keyed, peer.address === its listen address, and a
    // second identify() would run #conns.delete(peer.address) — deleting the DIALED peer that owns
    // that listen key (the real send target), stranding routing while the row still shows connected.
    // An already-identified inbound peer is in #shadows (server) or #published (client); skip it.
    if (this.#shadows.get(peer.address) === peer || (!peer.dialed && this.#published.has(peer))) return
    //! Self-reject by uuid: a handshake carrying OUR uuid (alternate-address self) — prune, destroy, remember.
    // Self-reject by uuid: a dial to one of our OWN alternate addresses (multi-NIC, localhost vs
    // 127.0.0.1) — or a uuid collision — completes a handshake carrying OUR uuid. add()'s self-guard
    // is a host:port STRING compare, so it misses an alternate-address self; the uuid catches it.
    // Tear the connection down (drop its #conns entry + row via #prune) and, for a dial, remember the
    // address so discovery can't redial it into a self-loop in the mesh.
    if (this.#uuid && id.uuid === this.#uuid) {
      if (peer.dialed) this.#selfAddrs.add(peer.address)
      this.#prune(peer) // a dialed self is published — prune leaves no lingering self row
      peer.destroy()
      return
    }
    peer.uuid = id.uuid
    // Heartbeat-only dedup: elect the heartbeat ORIGINATOR by uuid order — the lower-uuid node probes,
    // the higher-uuid node watchdogs. Both ends of each socket compute the same min over the same two
    // uuids, so exactly one side per socket originates (halving steady-state PING traffic). Both the
    // dialed peer and its paired inbound shadow to the same listen address get the same value (same
    // uuids). Pre-identify both originate (today's behavior); a pool with no uuid keeps that default.
    if (this.#uuid) peer.setOriginate(this.#uuid < id.uuid)
    //! Dialed peer already owns a correctly-keyed row — just stamp its uuid.
    if (peer.dialed) {
      const row = this.peers[peer.address]
      if (row?.[VALUE]) row.uuid = id.uuid
      return
    }
    //! No listen address ⇒ inbound CLIENT — publish a connected row under its ephemeral address.
    if (!id.listen) {
      peer.role = id.role ?? 'client'
      this.#published.add(peer)
      this.peers[peer.address] = { address: peer.address, host: peer.host, port: peer.port, role: peer.role, uuid: id.uuid, status: STATUS.connected }
      return
    }
    if (id.listen === this.#me) return // self-addressed inbound: never re-key to `me` / stamp the self row (mirrors add()'s self-guard)
    //! Inbound SERVER ⇒ re-key the ephemeral socket to its listen address as a shadow; the dialed peer owns the row.
    this.#conns.delete(peer.address) // drop the ephemeral key; the dialed peer owns `listen`
    peer.role = 'server'
    peer.address = id.listen
    this.#shadows.set(id.listen, peer)
    const row = this.peers[id.listen] // stamp uuid on the dialed row if it exists
    if (row?.[VALUE]) row.uuid = id.uuid
  }

  //! Construct a Peer wired to the pool callbacks (status→#mirror, frame→onFrame, gone→#prune) and index it in #conns.
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

  //! Drop a terminally-gone peer's #conns entry + row (identity-guarded so a shadow can't strand the live dial).
  // A peer is TERMINALLY gone (an inbound socket closed, or a dial gave up) — drop its bookkeeping
  // so a churned/departed peer doesn't leak a `disconnected` row forever. Guard the #conns delete on
  // identity: a server SHADOW's address is its LISTEN address, which is the DIALED peer's #conns key —
  // deleting it would strand the live dial. (A shadow owns no row + isn't in #conns under that key, so
  // #prune is a safe no-op for it; #mirror already drops it from #shadows on its own disconnect.)
  #prune(peer: Peer) {
    if (this.#conns.get(peer.address) === peer) this.#conns.delete(peer.address)
    if (this.#published.delete(peer) && this.peers[peer.address]?.[VALUE]) this.peers[VIEW].res.remove([peer.address])
  }

  //! Mirror a Peer's status/suspect into its row, writing only the changed field; fires onConnect/onPeerGone.
  // Reflect a Peer's connection state into the proxy. Both `status` and the
  // failure-detector `suspect` flag come through here; we write only the field
  // that actually changed (read the row snapshot first) so a suspect flip doesn't
  // emit a redundant `status` record that would needlessly churn derived
  // projections (e.g. the DHT's connected-servers reconcile).
  #mirror(peer: Peer) {
    if (this.#published.has(peer)) {
      const row = this.peers[peer.address]
      const snap: any = row[VALUE] ?? {}
      if (snap.status !== peer.status) {
        row.status = peer.status
        // A transition TO disconnected fires onPeerGone — the signal L2 reaps a gone peer's served
        // subscriptions on (a socket close never sends UNSUBSCRIBE). Gated to the status CHANGE so a
        // suspect flip doesn't spuriously reap. Gated to `!dialed` because subscriptions are served
        // over INBOUND sockets (a client row here, or a server shadow below) — a DIALED peer serves
        // none, and post-re-key its listen address COLLIDES with the shadow's served-sub key, so
        // firing it would FALSE-reap the shadow's still-live subs on a one-directional drop.
        if (peer.status === STATUS.disconnected && !peer.dialed) this.#onPeerGone?.(peer)
      }
      if (snap.suspect !== peer.suspect) row.suspect = peer.suspect
      if (peer.status === STATUS.connected && peer.dialed) this.#onConnect?.(peer)
      return
    }
    //! Unpublished path: a disconnecting server shadow is the sole server-pair reap trigger — fire onPeerGone, drop it.
    // An unidentified inbound peer owns no row (nothing to mirror). An identified server SHADOW owns
    // no row either, but MUST still reap its served subscriptions on drop — keyed under the same
    // listen address onSubscribe saw (L2 opens a served sub only after a view commit, well after the
    // DONE that re-keys, so the keys line up). It is the SOLE server-pair reap trigger (the dialed
    // peer is gated out above); prune it from #shadows on the way out so reconnect churn can't leak.
    if (this.#shadows.get(peer.address) === peer && peer.status === STATUS.disconnected) {
      this.#onPeerGone?.(peer)
      this.#shadows.delete(peer.address)
    }
  }

  //! Resolve an address to a send target — dialed peer wins, else its inbound shadow (point-to-point reachability).
  peer(address: string): Peer | undefined {
    // The dialed peer wins; an inbound-only server link (no dial back) is reachable via its shadow,
    // so point-to-point sends (deltaTo a served sub, forward, digest/catchup) still land. broadcast
    // reads #conns directly, so a shadow is never double-sent.
    return this.#conns.get(address) ?? this.#shadows.get(address)
  }

  //! Fan-out primitives (owner-routing is the DHT's job): send to one address...
  // Fan-out helpers. Owner-routing (which peer) is the DHT's job (index.ts);
  // here we provide the primitives: one address, or every connected peer.
  sendTo(address: string, record: ChangeRecord) {
    this.#conns.get(address)?.send(record)
  }

  //! ...or broadcast to every connected DIALED peer — outbound-only avoids double-delivery in a full mesh.
  // Send to every connected peer we DIALED (outbound). In a gossip-formed full
  // mesh every peer has exactly one outbound conn to every other, so this
  // delivers a record once per peer — avoiding the double-delivery that sending
  // over inbound conns too would cause (each pair has two directional sockets).
  // Server→inbound-client push (subscriptions) is an L2 concern, not this.
  broadcast(record: ChangeRecord) {
    for (const peer of this.#conns.values()) if (peer.dialed && peer.status === STATUS.connected) peer.send(record)
  }

  //! ── Fault injection (chaos harness): reversible link isolation ──────────────
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
  //! isolate(): block redial + destroy the dialed link — a reversible cut (bidirectional when applied symmetrically).
  isolate(address: string) {
    this.#blocked.add(address)
    const peer = this.#conns.get(address)
    if (peer) {
      peer.destroy() // sets the row disconnected (peer.ts) → #reachable drops it → eviction + write-gate engage
      this.#conns.delete(address) // remove so heal() re-dials a FRESH Peer (a destroyed one is terminal)
    }
  }

  //! Reverse isolate(): unblock and re-dial by listen address. The disconnected row
  // still carries host/port, so reconnect → handshake → anti-entropy heals the
  // missed writes and the view re-admits the peer (a rejoin WITHOUT a restart).
  heal(address: string) {
    if (!this.#blocked.delete(address)) return // wasn't isolated
    if (this.#conns.has(address)) return // already (re)connected by another path
    const row = this.peers[address]?.[VALUE] as PeerInfo | undefined
    if (row) this.add({ host: row.host, port: row.port, role: row.role ?? 'server' })
  }

  //! Tear down every dialed conn AND every inbound server shadow (shadows aren't in #conns), then clear the maps.
  destroy() {
    for (const peer of this.#conns.values()) peer.destroy()
    for (const peer of this.#shadows.values()) peer.destroy() // re-keyed inbound server sockets (not in #conns)
    this.#conns.clear()
    this.#shadows.clear()
  }
}
