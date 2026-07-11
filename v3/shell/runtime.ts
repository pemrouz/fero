//! ── shell/runtime — the production adapter: real TCP + real timers ───────────
// The whole shell fits in this file and contains ZERO protocol decisions —
// that is the point (plan §4): simulation-first testing concentrates its
// fidelity risk into these ~150 lines, which Tier-3 smoke tests then exercise
// directly. Everything here is mechanical translation:
//
//   socket events  → kernel Events   (connect/data/close → linkUp/bytesIn/linkDown)
//   kernel Effects → socket/timer ops (send/close/timer → write/destroy/setTimeout)
//
// Backpressure is wired from day 0: write()===false posts `pause`, 'drain'
// posts `drain` — the kernel's bounded outbox does the queuing policy, the
// shell just reports the socket's state (v2 ignored every write() return).
//
// Storage (M4b): `dir` in RuntimeOpts turns the durable mode on. The WAL is a
// plain byte-stream of codec frames (`wal.log` — the same Framer that reads a
// socket reads the file), appended per batch with fsync before the 'persisted'
// echo. The boot record is JSON at `boot.json`, replaced atomically
// (write-tmp + rename) and SYNCHRONOUSLY — the kernel's contract is that a
// vote is durable before the VOTE frame it precedes reaches the wire, and boot
// writes are per-ballot/per-view (cold), so sync I/O is the correct trade.
// Runtime.restore() reads both back BEFORE the network exists: boot facts into
// NodeOpts, WAL frames replayed through the kernel's own source=replay ingest.

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { Node, type NodeOpts } from '../kernel/node.ts'
import { Cursor, Writer, HEADER } from '../kernel/codec.ts'
import type { Applied, BootRecord, Rec } from '../kernel/env.ts'

//! RuntimeOpts: NodeOpts + the storage directory (presence = durable mode; NodeOpts.durable derives from it).
export interface RuntimeOpts extends NodeOpts { dir?: string }

//! restoreOpts — read the durable facts back into NodeOpts shape (the embedder calls this BEFORE
// constructing the Runtime, bumps incarnation itself, then replays via runtime.restore()).
export const restoreOpts = (dir: string): { boot?: NodeOpts['boot']; incarnation?: number } => {
  const bootPath = path.join(dir, 'boot.json')
  if (!fs.existsSync(bootPath)) return {}
  const b = JSON.parse(fs.readFileSync(bootPath, 'utf8')) as BootRecord
  return {
    boot: { epoch: b.epoch, members: b.members, lamport: b.lamport, votedFor: b.votedFor },
    incarnation: b.incarnation + 1,
  }
}

export class Runtime {
  node: Node
  #sockets = new Map<number, net.Socket>()
  #paused = new Set<number>()
  #timers = new Map<number, NodeJS.Timeout>()
  #server: net.Server | null = null
  #linkSeq = 0
  #opts: RuntimeOpts
  #wal: number | null = null // fd, held open for append (the plan's fd-held contract)
  onApply: (rec: Applied) => void
  //! onConfirm — the guarantee ladder's answers surface here (M5's confirm option resolves off it)
  onConfirm: (id: number, ok: boolean, count: number) => void = () => {}

  constructor(opts: RuntimeOpts, onApply: (rec: Applied) => void = () => {}) {
    this.#opts = opts
    this.onApply = onApply
    if (opts.dir) {
      fs.mkdirSync(opts.dir, { recursive: true })
      this.#wal = fs.openSync(path.join(opts.dir, 'wal.log'), 'a')
    }
    const runtime = this
    this.node = new Node({ ...opts, durable: opts.dir !== undefined }, {
      now: () => performance.now(),
      //! rng for backoff jitter only — the kernel makes no correctness decisions off it
      rng: () => Math.random(),
      sink: {
        connect(to) { runtime.#dial(to) },
        send(link, bytes) {
          const sock = runtime.#sockets.get(link)
          if (!sock || sock.destroyed) return
          //! bytes are an owned copy per frame (codec Outbox contract), so handing them to the socket queue is safe.
          // The paused-guard matters: several false writes can precede one 'drain', and stacking a once-listener
          // per false write would deliver N drain events (and N spurious kernel drains) for one socket drain.
          if (!sock.write(bytes) && !runtime.#paused.has(link)) {
            runtime.#paused.add(link)
            runtime.node.step({ kind: 'pause', link })
            sock.once('drain', () => {
              runtime.#paused.delete(link)
              runtime.node.step({ kind: 'drain', link })
            })
          }
        },
        close(link) { runtime.#sockets.get(link)?.destroy() },
        timer(id, tag, ms) {
          runtime.#timers.set(id, setTimeout(() => {
            runtime.#timers.delete(id)
            runtime.node.step({ kind: 'timer', id, tag })
          }, ms))
        },
        cancel(id) {
          const t = runtime.#timers.get(id)
          if (t) { clearTimeout(t); runtime.#timers.delete(id) }
        },
        apply(rec) { runtime.onApply(rec) },
        //! persist: append [varint prev][frame] + fsync, then echo — batch-per-call today (each call IS
        // a run frame; the group-many-appends-per-fsync batching is an M8 measured optimization, not a
        // semantic). The prev prefix is the chain link replay's interior-hole detector reads back.
        persist(batch, bytes, prev) {
          const fd = runtime.#wal
          if (fd === null) return
          const w = new Writer()
          w.varint(prev)
          w.bytes(bytes)
          fs.write(fd, w.buf.slice(0, w.len), (err) => {
            if (err) return runtime.node.step({ kind: 'persistFail', batch, reason: err.code ?? 'write' })
            fs.fsync(fd, (err2) => {
              if (runtime.node.destroyed) return
              if (err2) runtime.node.step({ kind: 'persistFail', batch, reason: err2.code ?? 'fsync' })
              else runtime.node.step({ kind: 'persisted', batch })
            })
          })
        },
        //! boot: atomic replace, SYNCHRONOUS — must be on disk before any later-emitted frame hits the wire
        boot(record) {
          if (!runtime.#opts.dir) return
          const p = path.join(runtime.#opts.dir, 'boot.json')
          fs.writeFileSync(p + '.tmp', JSON.stringify(record))
          fs.renameSync(p + '.tmp', p)
        },
        confirm(id, ok, count) { runtime.onConfirm(id, ok, count) },
      },
    })
  }

  //! restore — walk the WAL rows ([varint prev][frame]) and replay each through the kernel's
  // source=replay ingest, BEFORE start() brings the network up. A torn tail (a row the crash cut mid-
  // append) fails the walk's bounds and simply ends the restore there — the loss is a tail, which is
  // exactly what anti-entropy heals once the network exists.
  restore(): void {
    if (!this.#opts.dir) return
    const p = path.join(this.#opts.dir, 'wal.log')
    if (!fs.existsSync(p)) return
    const file = fs.readFileSync(p)
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.length)
    const c = new Cursor(bytes)
    try {
      while (c.pos < c.end) {
        const prev = c.varint()
        c.need(HEADER)
        const bodyLen = bytes[c.pos + 3] | (bytes[c.pos + 4] << 8) | (bytes[c.pos + 5] << 16) | (bytes[c.pos + 6] * 0x1000000)
        c.need(HEADER + bodyLen)
        const frame = bytes.slice(c.pos, c.pos + HEADER + bodyLen)
        c.pos += HEADER + bodyLen
        this.node.step({ kind: 'replay', bytes: frame, prev })
      }
    } catch { /* the torn tail: everything before it replayed; the rest is the wire's to re-ship */ }
  }

  //! start — listen (if this node is dialable), then post the boot stimulus.
  // Listen failure (EADDRINUSE etc.) REJECTS — net.Server signals it as an 'error'
  // event, which with no listener would crash the process while start() hung forever.
  async start(): Promise<void> {
    if (this.#opts.listen) {
      const [host, port] = split(this.#opts.listen)
      const server = net.createServer((sock) => this.#accept(sock))
      this.#server = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          server.on('error', () => {}) // post-start server errors must not become uncaughtException
          resolve()
        })
      })
    }
    this.node.step({ kind: 'start' })
  }

  //! write — the embedder's write ingress (the api layer binds $() assignment to this at M5).
  write(recs: Rec[]) { this.node.step({ kind: 'write', recs }) }

  #wire(sock: net.Socket, link: number) {
    this.#sockets.set(link, sock)
    sock.on('data', (chunk: Buffer) => {
      //! re-view as plain Uint8Array: Buffer.slice is a VIEW (unlike Uint8Array.slice), and the codec's
      // copy-on-retain contract (carry, .rec()) depends on .slice meaning COPY — a Buffer would silently
      // alias Node's pooled receive memory into retained state.
      this.node.step({ kind: 'bytesIn', link, bytes: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length) })
    })
    sock.on('error', () => {}) // 'close' always follows; the kernel hears exactly one linkDown
  }

  #dial(to: string) {
    const link = ++this.#linkSeq
    const [host, port] = split(to)
    const sock = net.connect(port, host)
    //! registered from CREATION, not from 'connect' — a dial still in flight when destroy() runs must be
    // torn down too, or the late 'connect' resurrects a live socket nothing owns (adversarial-review finding)
    this.#sockets.set(link, sock)
    let up = false
    sock.on('connect', () => {
      if (this.node.destroyed) return sock.destroy()
      up = true
      this.#wire(sock, link)
      this.node.step({ kind: 'linkUp', link, dialed: true, to })
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      this.#sockets.delete(link)
      this.#paused.delete(link)
      //! a dial that failed before 'connect' carries `to` so the kernel can back off and retry (same shape the sim produces)
      this.node.step(up ? { kind: 'linkDown', link, reason: 'close' } : { kind: 'linkDown', link, reason: 'refused', to })
    })
  }

  #accept(sock: net.Socket) {
    const link = ++this.#linkSeq
    this.#wire(sock, link)
    sock.on('close', () => {
      this.#sockets.delete(link)
      this.#paused.delete(link)
      this.node.step({ kind: 'linkDown', link, reason: 'close' })
    })
    this.node.step({ kind: 'linkUp', link, dialed: false })
  }

  async destroy(): Promise<void> {
    this.node.destroy()
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#timers.clear()
    for (const s of this.#sockets.values()) s.destroy()
    this.#sockets.clear()
    this.#paused.clear()
    if (this.#wal !== null) { try { fs.closeSync(this.#wal) } catch {} this.#wal = null }
    if (this.#server) await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
  }
}

const split = (addr: string): [string, number] => {
  const i = addr.lastIndexOf(':')
  return [addr.slice(0, i), Number(addr.slice(i + 1))]
}
