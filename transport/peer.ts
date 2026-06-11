//! One peer: TCP socket lifecycle + a small connection state machine, zero events (injected callbacks).
// One peer: the TCP socket lifecycle + a small connection state machine. NOT
// framing (message.ts), NOT handshake (handshake.ts), NOT RPC dispatch (L2).
// The legacy 461-line god-class (fero-old/peer.js) is decomposed to this.
//
// Zero events: a Peer is not an EventEmitter. It surfaces two things via plain
// injected callbacks — `onStatus(peer)` when its connection state changes (the
// pool mirrors this into the cluster.peers ViewProxy) and `onFrame(frame,peer)`
// for each decoded inbound frame. Outbound, records queued via send() are
// coalesced into one frame per microtask and written once.
//
// `role` (server|client) is kept SEPARATE from `status` (connection state) —
// the legacy code overloaded one field with both ('connected'|address vs
// 'throttled'); splitting them lets peers.ts filter on either axis cleanly.

import net from 'node:net'
import { Framer, encodeFrame, encodeFrames, VERB, FrameError, type ChangeRecord, type Frame } from './message.ts'
import { Retries, type RetryOpts } from './retries.ts'

//! Heartbeat constants: app-level PING/PONG failure detector, since TCP close never fires on a half-open peer.
// Failure detector. TCP `close` does NOT fire for a hard-crashed or
// silently-partitioned peer, so a half-open connection looks alive forever. An
// application-level heartbeat fixes that: every `interval` ms we send a PING; the
// peer answers PONG (any inbound frame counts as liveness). After `misses`
// unanswered probes the peer is flagged `suspect` — the reachability signal the
// membership/view layer keys off (it never trusts raw STATUS.connected for
// liveness). `suspect` is orthogonal to `status` (the socket may still be open),
// so it does not disturb the data path's status===connected routing checks.
const PING_FRAME = encodeFrame([], { verb: VERB.PING }) // constant, reused (never mutated)
const PONG_FRAME = encodeFrame([], { verb: VERB.PONG })
const HEARTBEAT_MS = 1000 // default probe interval
const HEARTBEAT_MISSES = 3 // unanswered probes before flagging suspect

//! Connection-state enum (orthogonal to `role`); the data path routes only on status===connected.
export const STATUS = {
  disconnected: 0,
  connecting: 1,
  throttled: 2, // waiting out a reconnect backoff
  connected: 3,
} as const
export type Status = (typeof STATUS)[keyof typeof STATUS]

export type HeartbeatOpts = { interval?: number; misses?: number }

//! Peer construction opts: dial target + role + retry/heartbeat tuning + the injected lifecycle callbacks.
export type PeerOpts = {
  host: string
  port: number
  role?: 'server' | 'client'
  socket?: net.Socket // inbound: wrap an already-accepted socket (won't redial)
  retries?: RetryOpts
  heartbeat?: HeartbeatOpts
  onStatus?: (peer: Peer) => void
  onFrame?: (frame: Frame, peer: Peer) => void
  onGone?: (peer: Peer) => void // TERMINAL departure: an inbound socket closed (no redial) or a dial gave up (retries exhausted) — drives row pruning
}

//! The Peer: one socket, an outbox coalesced per microtask, a heartbeat, and reconnect/backoff state.
export class Peer {
  readonly host: string
  readonly port: number
  // address + role are mutable: an accepted inbound socket is keyed by an undialable
  // ephemeral port and its role is provisional until the handshake reveals identity.
  // Peers.identify() re-keys a server peer to its learned listen address on DONE.
  address: string
  role: 'server' | 'client'
  uuid = '' // stable peer identity, learned in the handshake (empty until then)
  status: Status = STATUS.disconnected

  #socket?: net.Socket
  #framer = new Framer()
  #outbox: ChangeRecord[] = []
  #deltaOutbox = new Map<number, ChangeRecord[]>() // subId → its tick's subscription deltas (one frame per sub per tick)
  #flushing = false
  #retries: Retries
  #dialed: boolean // outbound (we dial → redial on drop) vs inbound (accepted)
  #destroyed = false
  #gone = false // the terminal-departure signal fired (once) — see #fireGone
  #reconnect?: ReturnType<typeof setTimeout>
  #onStatus?: (peer: Peer) => void
  #onFrame?: (frame: Frame, peer: Peer) => void
  #onGone?: (peer: Peer) => void

  // Failure detector state.
  #suspect = false
  #missed = 0 // probes sent since the last inbound frame
  #heartbeat?: ReturnType<typeof setInterval>
  #hbInterval: number
  #hbMisses: number
  // Heartbeat-only dedup: one side per pair ORIGINATES probes (sends PING), the other WATCHDOGS
  // (never sends PING; flags suspect on inbound-frame starvation, since the originator's PINGs are
  // proof-of-life). Default true = today's behavior (both ends probe) until identify() elects.
  #originate = true

  //! Wire opts to fields; an injected (inbound) socket is attached already-connected and never redialed.
  constructor(opts: PeerOpts) {
    this.host = opts.host
    this.port = opts.port
    this.address = `${opts.host}:${opts.port}`
    this.role = opts.role ?? 'server'
    this.#retries = new Retries(opts.retries)
    this.#hbInterval = opts.heartbeat?.interval ?? HEARTBEAT_MS
    this.#hbMisses = opts.heartbeat?.misses ?? HEARTBEAT_MISSES
    this.#onStatus = opts.onStatus
    this.#onFrame = opts.onFrame
    this.#onGone = opts.onGone
    this.#dialed = !opts.socket
    if (opts.socket) this.#attach(opts.socket, true) // inbound — already connected
  }

  //! Likely-dead-but-socket-still-open (the failure detector's verdict). Distinct
  // from `status`; the view layer treats this — not status — as "unreachable".
  get suspect() {
    return this.#suspect
  }

  //! Was this peer dialed by us (outbound) vs accepted (inbound)? The dialer is
  // the side that initiates the handshake.
  get dialed() {
    return this.#dialed
  }

  //! Does this side originate heartbeat probes (vs watchdog)? Elected by uuid order in Peers.identify().
  get originate() {
    return this.#originate
  }
  setOriginate(v: boolean) {
    this.#originate = v
  }

  //! Can a control frame be written RIGHT NOW? Callers that record subscribe-success gate on this, not status.
  // Can a control frame be written RIGHT NOW (socket exists and is writable)? A peer
  // row can exist while its socket is still connecting (status 'connecting') — write()
  // would silently drop the frame (it doesn't queue control frames). Callers that need a
  // frame to actually go out (a subscription whose success they record — see transport
  // subscribe()) gate on this so a not-yet-connected peer reports failure and is retried,
  // rather than being recorded as subscribed with a dropped SUBSCRIBE. Distinct from
  // write()'s false, which also covers backpressure (the frame IS queued by the socket).
  get writable() {
    return this.#socket?.writable ?? false
  }

  //! Set status and mirror the change upward via onStatus — but only on an actual transition.
  #setStatus(s: Status) {
    if (this.status === s) return
    this.status = s
    this.#onStatus?.(this)
  }

  //! Set suspect, mirroring upward on the same onStatus channel (peers.ts reflects both axes).
  #setSuspect(s: boolean) {
    if (this.#suspect === s) return
    this.#suspect = s
    this.#onStatus?.(this) // mirror upward (same channel as status; peers.ts reflects both)
  }

  //! Write a prebuilt frame immediately (control frames: handshake INIT/SYNC/DONE,
  // acks). Data change records go via send()/the batched outbox instead.
  write(buf: Buffer): boolean {
    const s = this.#socket
    if (!s?.writable) return false
    return s.write(buf)
  }

  //! Outbound dial. Idempotent while a socket exists.
  connect() {
    if (this.#destroyed || this.#socket) return
    this.#setStatus(STATUS.connecting)
    const socket = net.connect(this.port, this.host)
    socket.once('connect', () => {
      this.#retries.reset()
      this.#setStatus(STATUS.connected)
      this.#startHeartbeat()
      if (this.#outbox.length) this.#schedule() // flush anything queued pre-connect
    })
    this.#attach(socket, false)
  }

  //! Bind socket options + data/error/close listeners; swallow 'error' since 'close' always cleans up.
  #attach(socket: net.Socket, ready: boolean) {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, this.#hbInterval) // OS-level backstop under the app heartbeat
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.once('error', () => {}) // swallow; 'close' always follows and does cleanup
    socket.once('close', () => this.#onClose())
    this.#socket = socket
    if (ready) {
      this.#setStatus(STATUS.connected)
      this.#startHeartbeat()
    }
  }

  //! Decode inbound frames: bad framing → drop the peer; every frame is proof of life (clears suspect).
  #onData(chunk: Buffer) {
    let frames: Frame[]
    try {
      frames = this.#framer.push(chunk)
    } catch {
      this.destroy() // bad framing → drop the peer (defensive; see ../IDEAS.md)
      return
    }
    for (const f of frames) {
      // Any inbound frame is proof of life: reset the miss counter and clear suspicion.
      this.#missed = 0
      if (this.#suspect) this.#setSuspect(false)
      //! PING/PONG are pure liveness traffic — answer PING, swallow PONG, never deliver upward.
      if (f.verb === VERB.PING) {
        this.write(PONG_FRAME) // liveness probe → answer it
        continue
      }
      if (f.verb === VERB.PONG) continue // pure liveness ack — nothing to deliver
      try {
        this.#onFrame?.(f, this)
      } catch (e) {
        //! Lazy-parse FrameError → drop the peer (like a framing fault); any other throw is a real bug, rethrow.
        // A malformed/hostile frame body surfaces as a FrameError only when the
        // consumer LAZILY parses it (count/length overrun, reserved vtype) — drop
        // the peer, mirroring the framer's structural-fault handling above. Any
        // other throw is a genuine handler/apply bug; rethrow so it isn't masked.
        if (e instanceof FrameError) {
          this.destroy()
          return
        }
        throw e
      }
    }
  }

  //! Fire the terminal-departure signal EXACTLY once, whatever path got us here (inbound close, dial give-up, destroy()).
  // Every terminal path must prune the pool's bookkeeping (row + #conns entry), else the dead
  // Peer is a CORPSE: add() dedups against it forever (blocking any redial), peer() resolves to
  // it (occluding a live shadow), and its outbox accumulates unbounded. The latch makes the
  // give-up path (which fires then destroys) and a user double-destroy safe.
  #fireGone() {
    if (this.#gone) return
    this.#gone = true
    this.#onGone?.(this)
  }

  //! Socket closed: dialed peers reconnect with backoff; inbound peers are terminal → onGone prunes the row.
  #onClose() {
    this.#socket = undefined
    this.#stopHeartbeat()
    if (this.#destroyed) return
    this.#setStatus(STATUS.disconnected)
    if (this.#dialed) this.#scheduleReconnect() // inbound peers can't be redialed
    else this.#fireGone() // inbound socket closed and won't redial → terminal, prune its row
  }

  //! Backoff-then-redial; a negative delay means retries exhausted → terminal, prune and destroy.
  #scheduleReconnect() {
    const delay = this.#retries.next()
    if (delay < 0) {
      this.#fireGone() // out of reconnect attempts → terminal, prune its row
      return this.destroy()
    }
    this.#setStatus(STATUS.throttled)
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined
      this.connect()
    }, delay)
    this.#reconnect.unref?.()
  }

  //! Start the per-interval probe loop (unref'd so it never holds the process open).
  // Failure detector. One probe per interval; the peer's PONG (or any inbound
  // frame) resets the miss counter via #onData. After #hbMisses unanswered probes
  // we flag suspect — but keep probing, so a peer that recovers clears it.
  #startHeartbeat() {
    if (this.#heartbeat || this.#hbInterval <= 0) return
    this.#missed = 0
    this.#heartbeat = setInterval(() => this.#beat(), this.#hbInterval)
    this.#heartbeat.unref?.()
  }

  //! Stop probing and clear suspicion (socket gone or destroyed).
  #stopHeartbeat() {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
    this.#missed = 0
    this.#setSuspect(false)
  }

  //! One beat: flag suspect once misses pile up, then increment; ORIGINATORS also send a PING.
  // The miss-count + suspect logic is identical for both modes — only the PING write is gated. A
  // WATCHDOG relies on the originator's PINGs (and any data) as proof-of-life: #onData resets #missed
  // on every inbound frame, so a healthy link (the originator probing each interval) never trips;
  // when the originator falls silent, #missed climbs to #hbMisses and the watchdog flags suspect too.
  #beat() {
    if (!this.#socket?.writable) return
    if (this.#missed >= this.#hbMisses) this.#setSuspect(true) // probes/PINGs went unanswered → likely dead
    this.#missed++
    if (this.#originate) this.write(PING_FRAME)
  }

  //! Queue a change record for delivery; coalesced into one frame per microtask.
  send(record: ChangeRecord) {
    this.#outbox.push(record)
    this.#schedule()
  }

  //! Queue one subscription delta (id-tagged RECORDS); coalesced into ONE frame per subId per microtask.
  // The served-subscription twin of send(): data sinks fire SYNCHRONOUSLY inside the writer's
  // set trap, so an immediate encode+socket.write per delta put M × (frame + syscall) INLINE in
  // every assignment a server with M live subscriptions made. Queued here, a tick's deltas for
  // one sub flush as one frame — same per-tick coalescing the replication path always had.
  sendDelta(subId: number, record: ChangeRecord) {
    let q = this.#deltaOutbox.get(subId)
    if (!q) this.#deltaOutbox.set(subId, (q = []))
    q.push(record)
    this.#schedule()
  }

  //! Arm a single microtask flush (the per-tick coalescing point).
  #schedule() {
    if (this.#flushing) return
    this.#flushing = true
    queueMicrotask(() => this.flush())
  }

  //! One write per tick via encodeFrames; not connected → records stay queued and flush on connect.
  // One write per tick. Own writes (one origin, contiguous seqs) coalesce into a
  // single frame; a relayed batch spanning origins splits into the fewest frames
  // that keep each frame's base+index provenance valid (encodeFrames). If not
  // connected, records stay queued and flush on connect (bounded-buffer/
  // backpressure handling: see ../IDEAS.md).
  flush() {
    this.#flushing = false
    if (!this.#outbox.length && !this.#deltaOutbox.size) return
    const socket = this.#socket
    if (!socket?.writable || this.status !== STATUS.connected) return
    if (this.#outbox.length) {
      const outbox = this.#outbox
      this.#outbox = []
      for (const buf of encodeFrames(outbox)) socket.write(buf)
    }
    //! delta lane: one id-tagged RECORDS frame per subscription per tick (the client fans frame.records() back out by sub id).
    if (this.#deltaOutbox.size) {
      const deltas = this.#deltaOutbox
      this.#deltaOutbox = new Map()
      for (const [subId, records] of deltas) {
        try {
          socket.write(encodeFrame(records, { verb: VERB.RECORDS, id: subId }))
        } catch (e) {
          // an unserializable user value (BigInt/Symbol) — ship the rest one-by-one, skip the
          // poison loudly (mirrors encodeFrames' fallback; a throw here is a microtask kill)
          for (const r of records) {
            try {
              socket.write(encodeFrame([r], { verb: VERB.RECORDS, id: subId }))
            } catch (err) {
              console.error(`fero/transport: dropping unserializable subscription delta (key=${JSON.stringify(r.key)}): ${(err as Error)?.message ?? err}`)
            }
          }
        }
      }
    }
  }

  //! Terminal teardown: cancel reconnect/heartbeat, kill the socket, mark disconnected, fire gone (idempotent).
  // destroy() is itself a TERMINAL departure (framing fault, lazy-parse FrameError, mesh.drop,
  // self-reject) — it must fire onGone like the other terminal paths, or the dead Peer stays in
  // the pool's #conns as a redial-blocking corpse (the socket 'close' that follows early-returns
  // on #destroyed, so no other path will). Status flips FIRST so the onPeerGone reap (mirrored
  // off the status change) still sees the published row; the prune then removes it.
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    if (this.#reconnect) clearTimeout(this.#reconnect)
    this.#stopHeartbeat()
    this.#socket?.destroy()
    this.#socket = undefined
    this.#setStatus(STATUS.disconnected)
    this.#fireGone()
  }
}
