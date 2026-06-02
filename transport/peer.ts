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
import { Framer, encodeFrames, type ChangeRecord, type Frame } from './message.ts'
import { Retries, type RetryOpts } from './retries.ts'

export const STATUS = {
  disconnected: 0,
  connecting: 1,
  throttled: 2, // waiting out a reconnect backoff
  connected: 3,
} as const
export type Status = (typeof STATUS)[keyof typeof STATUS]
export const STATUS_NAME = ['disconnected', 'connecting', 'throttled', 'connected'] as const

export type PeerOpts = {
  host: string
  port: number
  role?: 'server' | 'client'
  socket?: net.Socket // inbound: wrap an already-accepted socket (won't redial)
  retries?: RetryOpts
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

  constructor(opts: PeerOpts) {
    this.host = opts.host
    this.port = opts.port
    this.address = `${opts.host}:${opts.port}`
    this.role = opts.role ?? 'server'
    this.#retries = new Retries(opts.retries)
    this.#onStatus = opts.onStatus
    this.#onFrame = opts.onFrame
    this.#dialed = !opts.socket
    if (opts.socket) this.#attach(opts.socket, true) // inbound — already connected
  }

  // Was this peer dialed by us (outbound) vs accepted (inbound)? The dialer is
  // the side that initiates the handshake.
  get dialed() {
    return this.#dialed
  }

  #setStatus(s: Status) {
    if (this.status === s) return
    this.status = s
    this.#onStatus?.(this)
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
      if (this.#outbox.length) this.#schedule() // flush anything queued pre-connect
    })
    this.#attach(socket, false)
  }

  #attach(socket: net.Socket, ready: boolean) {
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.once('error', () => {}) // swallow; 'close' always follows and does cleanup
    socket.once('close', () => this.#onClose())
    this.#socket = socket
    if (ready) this.#setStatus(STATUS.connected)
  }

  #onData(chunk: Buffer) {
    let frames: Frame[]
    try {
      frames = this.#framer.push(chunk)
    } catch {
      this.destroy() // bad framing → drop the peer (defensive; see IDEAS.md)
      return
    }
    for (const f of frames) this.#onFrame?.(f, this)
  }

  #onClose() {
    this.#socket = undefined
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

  // Queue a change record for delivery; coalesced into one frame per microtask.
  send(record: ChangeRecord) {
    this.#outbox.push(record)
    this.#schedule()
  }

  sendMany(records: ChangeRecord[]) {
    for (let i = 0; i < records.length; i++) this.#outbox.push(records[i])
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
  // backpressure handling: see IDEAS.md).
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
    this.#socket?.destroy()
    this.#socket = undefined
    this.#setStatus(STATUS.disconnected)
  }
}
