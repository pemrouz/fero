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

export const STATUS = {
  disconnected: 0,
  connecting: 1,
  throttled: 2, // waiting out a reconnect backoff
  connected: 3,
} as const
export type Status = (typeof STATUS)[keyof typeof STATUS]

export type HeartbeatOpts = { interval?: number; misses?: number }

export type PeerOpts = {
  host: string
  port: number
  role?: 'server' | 'client'
  socket?: net.Socket // inbound: wrap an already-accepted socket (won't redial)
  retries?: RetryOpts
  heartbeat?: HeartbeatOpts
  onStatus?: (peer: Peer) => void
  onFrame?: (frame: Frame, peer: Peer) => void
}

export class Peer {
  readonly host: string
  readonly port: number
  readonly address: string
  readonly role: 'server' | 'client'
  status: Status = STATUS.disconnected

  #socket?: net.Socket
  #framer = new Framer()
  #outbox: ChangeRecord[] = []
  #flushing = false
  #retries: Retries
  #dialed: boolean // outbound (we dial → redial on drop) vs inbound (accepted)
  #destroyed = false
  #reconnect?: ReturnType<typeof setTimeout>
  #onStatus?: (peer: Peer) => void
  #onFrame?: (frame: Frame, peer: Peer) => void

  // Failure detector state.
  #suspect = false
  #missed = 0 // probes sent since the last inbound frame
  #heartbeat?: ReturnType<typeof setInterval>
  #hbInterval: number
  #hbMisses: number

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
    this.#dialed = !opts.socket
    if (opts.socket) this.#attach(opts.socket, true) // inbound — already connected
  }

  // Likely-dead-but-socket-still-open (the failure detector's verdict). Distinct
  // from `status`; the view layer treats this — not status — as "unreachable".
  get suspect() {
    return this.#suspect
  }

  // Was this peer dialed by us (outbound) vs accepted (inbound)? The dialer is
  // the side that initiates the handshake.
  get dialed() {
    return this.#dialed
  }

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

  #setStatus(s: Status) {
    if (this.status === s) return
    this.status = s
    this.#onStatus?.(this)
  }

  #setSuspect(s: boolean) {
    if (this.#suspect === s) return
    this.#suspect = s
    this.#onStatus?.(this) // mirror upward (same channel as status; peers.ts reflects both)
  }

  // Write a prebuilt frame immediately (control frames: handshake INIT/SYNC/DONE,
  // acks). Data change records go via send()/the batched outbox instead.
  write(buf: Buffer): boolean {
    const s = this.#socket
    if (!s?.writable) return false
    return s.write(buf)
  }

  // Outbound dial. Idempotent while a socket exists.
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
      if (f.verb === VERB.PING) {
        this.write(PONG_FRAME) // liveness probe → answer it
        continue
      }
      if (f.verb === VERB.PONG) continue // pure liveness ack — nothing to deliver
      try {
        this.#onFrame?.(f, this)
      } catch (e) {
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

  #onClose() {
    this.#socket = undefined
    this.#stopHeartbeat()
    if (this.#destroyed) return
    this.#setStatus(STATUS.disconnected)
    if (this.#dialed) this.#scheduleReconnect() // inbound peers can't be redialed
  }

  #scheduleReconnect() {
    const delay = this.#retries.next()
    if (delay < 0) return this.destroy() // attempts exhausted → give up
    this.#setStatus(STATUS.throttled)
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined
      this.connect()
    }, delay)
    this.#reconnect.unref?.()
  }

  // Failure detector. One probe per interval; the peer's PONG (or any inbound
  // frame) resets the miss counter via #onData. After #hbMisses unanswered probes
  // we flag suspect — but keep probing, so a peer that recovers clears it.
  #startHeartbeat() {
    if (this.#heartbeat || this.#hbInterval <= 0) return
    this.#missed = 0
    this.#heartbeat = setInterval(() => this.#beat(), this.#hbInterval)
    this.#heartbeat.unref?.()
  }

  #stopHeartbeat() {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
    this.#missed = 0
    this.#setSuspect(false)
  }

  #beat() {
    if (!this.#socket?.writable) return
    if (this.#missed >= this.#hbMisses) this.#setSuspect(true) // probes went unanswered → likely dead
    this.#missed++
    this.write(PING_FRAME)
  }

  // Queue a change record for delivery; coalesced into one frame per microtask.
  send(record: ChangeRecord) {
    this.#outbox.push(record)
    this.#schedule()
  }

  #schedule() {
    if (this.#flushing) return
    this.#flushing = true
    queueMicrotask(() => this.flush())
  }

  // One write per tick. Own writes (one origin, contiguous seqs) coalesce into a
  // single frame; a relayed batch spanning origins splits into the fewest frames
  // that keep each frame's base+index provenance valid (encodeFrames). If not
  // connected, records stay queued and flush on connect (bounded-buffer/
  // backpressure handling: see ../IDEAS.md).
  flush() {
    this.#flushing = false
    if (!this.#outbox.length) return
    const socket = this.#socket
    if (!socket?.writable || this.status !== STATUS.connected) return
    const outbox = this.#outbox
    this.#outbox = []
    for (const buf of encodeFrames(outbox)) socket.write(buf)
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    if (this.#reconnect) clearTimeout(this.#reconnect)
    this.#stopHeartbeat()
    this.#socket?.destroy()
    this.#socket = undefined
    this.#setStatus(STATUS.disconnected)
  }
}
