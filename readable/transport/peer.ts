// One peer: TCP socket lifecycle + a small connection state machine, zero events (injected callbacks).

import net from 'node:net'
import { Framer, encodeFrame, encodeFrames, VERB, FrameError, type ChangeRecord, type Frame } from './message.ts'
import { Retries, type RetryOpts } from './retries.ts'

// Heartbeat constants: app-level PING/PONG failure detector, since TCP close never fires on a half-open peer.
const PING_FRAME = encodeFrame([], { verb: VERB.PING })
const PONG_FRAME = encodeFrame([], { verb: VERB.PONG })
const HEARTBEAT_MS = 1000
const HEARTBEAT_MISSES = 3

// Connection-state enum (orthogonal to `role`); the data path routes only on status===connected.
export const STATUS = {
  disconnected: 0,
  connecting: 1,
  throttled: 2,
  connected: 3,
} as const
export type Status = (typeof STATUS)[keyof typeof STATUS]

export type HeartbeatOpts = { interval?: number; misses?: number }

// Peer construction opts: dial target + role + retry/heartbeat tuning + the injected lifecycle callbacks.
export type PeerOpts = {
  host: string
  port: number
  role?: 'server' | 'client'
  socket?: net.Socket
  retries?: RetryOpts
  heartbeat?: HeartbeatOpts
  onStatus?: (peer: Peer) => void
  onFrame?: (frame: Frame, peer: Peer) => void
  onGone?: (peer: Peer) => void
}

// The Peer: one socket, an outbox coalesced per microtask, a heartbeat, and reconnect/backoff state.
export class Peer {
  readonly host: string
  readonly port: number
  address: string
  role: 'server' | 'client'
  uuid = ''
  status: Status = STATUS.disconnected

  #socket?: net.Socket
  #framer = new Framer()
  #outbox: ChangeRecord[] = []
  #flushing = false
  #retries: Retries
  #dialed: boolean
  #destroyed = false
  #reconnect?: ReturnType<typeof setTimeout>
  #onStatus?: (peer: Peer) => void
  #onFrame?: (frame: Frame, peer: Peer) => void
  #onGone?: (peer: Peer) => void

  #suspect = false
  #missed = 0
  #heartbeat?: ReturnType<typeof setInterval>
  #hbInterval: number
  #hbMisses: number

  // Wire opts to fields; an injected (inbound) socket is attached already-connected and never redialed.
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
    if (opts.socket) this.#attach(opts.socket, true)
  }

  // Likely-dead-but-socket-still-open (the failure detector's verdict). Distinct
  get suspect() {
    return this.#suspect
  }

  // Was this peer dialed by us (outbound) vs accepted (inbound)? The dialer is
  get dialed() {
    return this.#dialed
  }

  // Can a control frame be written RIGHT NOW? Callers that record subscribe-success gate on this, not status.
  get writable() {
    return this.#socket?.writable ?? false
  }

  // Set status and mirror the change upward via onStatus — but only on an actual transition.
  #setStatus(s: Status) {
    if (this.status === s) return
    this.status = s
    this.#onStatus?.(this)
  }

  // Set suspect, mirroring upward on the same onStatus channel (peers.ts reflects both axes).
  #setSuspect(s: boolean) {
    if (this.#suspect === s) return
    this.#suspect = s
    this.#onStatus?.(this)
  }

  // Write a prebuilt frame immediately (control frames: handshake INIT/SYNC/DONE,
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
      if (this.#outbox.length) this.#schedule()
    })
    this.#attach(socket, false)
  }

  // Bind socket options + data/error/close listeners; swallow 'error' since 'close' always cleans up.
  #attach(socket: net.Socket, ready: boolean) {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, this.#hbInterval)
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.once('error', () => {})
    socket.once('close', () => this.#onClose())
    this.#socket = socket
    if (ready) {
      this.#setStatus(STATUS.connected)
      this.#startHeartbeat()
    }
  }

  // Decode inbound frames: bad framing → drop the peer; every frame is proof of life (clears suspect).
  #onData(chunk: Buffer) {
    let frames: Frame[]
    try {
      frames = this.#framer.push(chunk)
    } catch {
      this.destroy()
      return
    }
    for (const f of frames) {
      this.#missed = 0
      if (this.#suspect) this.#setSuspect(false)
      // PING/PONG are pure liveness traffic — answer PING, swallow PONG, never deliver upward.
      if (f.verb === VERB.PING) {
        this.write(PONG_FRAME)
        continue
      }
      if (f.verb === VERB.PONG) continue
      try {
        this.#onFrame?.(f, this)
      } catch (e) {
        // Lazy-parse FrameError → drop the peer (like a framing fault); any other throw is a real bug, rethrow.
        if (e instanceof FrameError) {
          this.destroy()
          return
        }
        throw e
      }
    }
  }

  // Socket closed: dialed peers reconnect with backoff; inbound peers are terminal → onGone prunes the row.
  #onClose() {
    this.#socket = undefined
    this.#stopHeartbeat()
    if (this.#destroyed) return
    this.#setStatus(STATUS.disconnected)
    if (this.#dialed) this.#scheduleReconnect()
    else this.#onGone?.(this)
  }

  // Backoff-then-redial; a negative delay means retries exhausted → terminal, prune and destroy.
  #scheduleReconnect() {
    const delay = this.#retries.next()
    if (delay < 0) {
      this.#onGone?.(this)
      return this.destroy()
    }
    this.#setStatus(STATUS.throttled)
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined
      this.connect()
    }, delay)
    this.#reconnect.unref?.()
  }

  // Start the per-interval probe loop (unref'd so it never holds the process open).
  #startHeartbeat() {
    if (this.#heartbeat || this.#hbInterval <= 0) return
    this.#missed = 0
    this.#heartbeat = setInterval(() => this.#beat(), this.#hbInterval)
    this.#heartbeat.unref?.()
  }

  // Stop probing and clear suspicion (socket gone or destroyed).
  #stopHeartbeat() {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
    this.#missed = 0
    this.#setSuspect(false)
  }

  // One probe: flag suspect once misses pile up, then increment and send PING.
  #beat() {
    if (!this.#socket?.writable) return
    if (this.#missed >= this.#hbMisses) this.#setSuspect(true)
    this.#missed++
    this.write(PING_FRAME)
  }

  // Queue a change record for delivery; coalesced into one frame per microtask.
  send(record: ChangeRecord) {
    this.#outbox.push(record)
    this.#schedule()
  }

  // Arm a single microtask flush (the per-tick coalescing point).
  #schedule() {
    if (this.#flushing) return
    this.#flushing = true
    queueMicrotask(() => this.flush())
  }

  // One write per tick via encodeFrames; not connected → records stay queued and flush on connect.
  flush() {
    this.#flushing = false
    if (!this.#outbox.length) return
    const socket = this.#socket
    if (!socket?.writable || this.status !== STATUS.connected) return
    const outbox = this.#outbox
    this.#outbox = []
    for (const buf of encodeFrames(outbox)) socket.write(buf)
  }

  // Terminal teardown: cancel reconnect/heartbeat, kill the socket, mark disconnected (idempotent).
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
