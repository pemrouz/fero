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
import { Cursor, Writer, HEADER, MAGIC, MAX_FRAME, crcFrame } from '../kernel/codec.ts'
import type { Applied, BootRecord, Rec } from '../kernel/env.ts'

//! syncDir — fsync a DIRECTORY: a rename is not durable until the directory entry is (POSIX leaves
// it to the fs; ext4/xfs need the explicit dir fsync). Best-effort catch: some platforms refuse
// fsync on a directory fd — there the rename+fsync(file) is the strongest available ordering.
const syncDir = (dir: string) => {
  try {
    const fd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch { /* platform without dir-fsync: nothing stronger exists to ask for */ }
}

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
  //! WAL ops run STRICTLY IN ORDER through one promise chain: fs.write completions ride a threadpool
  // and are not order-guaranteed, so two appends landing swapped would replay as a chain hole on a
  // CLEAN restart; the queue is also what makes the snapshot swap atomic wrt appends (nothing
  // straddles the rename — every queued append lands wholly before or wholly after the new file).
  #ioq: Promise<void> = Promise.resolve()
  //! #walFailed — the SHELL-side fsyncgate latch: after one failed write/fsync/swap, every queued and
  // future WAL op is skipped outright. Without it the queue kept appending past the failure and could
  // SUCCEED, leaving an interior hole on an HONEST disk — which would then read as a lie at replay
  // and condemn an innocent restore (M4-review: the hole-means-lie premise requires stop-on-failure).
  #walFailed = false
  onApply: (rec: Applied) => void
  //! onConfirm — the guarantee ladder's answers surface here (M5's confirm option resolves off it)
  onConfirm: (id: number, ok: boolean, count: number) => void = () => {}
  //! the M5c method plane surfaces here — the api layer is the HOST (it runs handlers) and the CALLER
  // (it awaits results / folds sub records); the kernel only routes frames (env.ts contract).
  onInvoke: (link: number, id: number, mode: number, m: string, a: unknown) => void = () => {}
  onResult: (id: number, ok: boolean, value: unknown) => void = () => {}
  onSubRecs: (id: number, recs: Rec[]) => void = () => {}

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
        // Rows are copied out at CALL time (the kernel owns `bytes` only until return) and appended
        // through the ordered #ioq (see its banner — unordered appends corrupt the chain on disk).
        persist(batch, bytes, prev) {
          if (runtime.#wal === null) return
          const w = new Writer()
          w.varint(prev)
          w.bytes(bytes)
          const row = w.buf.slice(0, w.len)
          runtime.#ioq = runtime.#ioq.then(() => new Promise<void>((done) => {
            const fd = runtime.#wal
            //! a queued append still RUNS after destroy() begins — a clean shutdown must flush what the
            // kernel already committed (M4-review: guarding the write on `destroyed` silently dropped
            // the tail of every clean run). Only the ECHO checks destroyed — a dead node ignores it anyway.
            if (fd === null || runtime.#walFailed) return done()
            fs.write(fd, row, (err) => {
              if (err) {
                runtime.#walFailed = true
                if (!runtime.node.destroyed) runtime.node.step({ kind: 'persistFail', batch, reason: err.code ?? 'write' })
                return done()
              }
              fs.fsync(fd, (err2) => {
                if (err2) runtime.#walFailed = true
                if (!runtime.node.destroyed)
                  runtime.node.step(err2 ? { kind: 'persistFail', batch, reason: err2.code ?? 'fsync' } : { kind: 'persisted', batch })
                done()
              })
            })
          }))
        },
        //! snapshot (M4e): the atomic whole-file swap — write every row to wal.log.tmp, fsync, close,
        // rename over wal.log, reopen the append fd. Synchronous inside its #ioq slot (a swap is cold
        // and must not interleave with appends); the old file survives any crash before the rename.
        snapshot(batch, rows) {
          if (!runtime.#opts.dir) return
          const p = path.join(runtime.#opts.dir, 'wal.log')
          const dir = runtime.#opts.dir
          runtime.#ioq = runtime.#ioq.then(() => {
            if (runtime.#wal === null || runtime.#walFailed || runtime.node.destroyed) return
            try {
              const w = new Writer()
              for (const r of rows) { w.varint(r.prev); w.bytes(r.bytes) }
              const fd = fs.openSync(p + '.tmp', 'w')
              try {
                fs.writeSync(fd, w.buf.subarray(0, w.len))
                fs.fsyncSync(fd)
              } finally { fs.closeSync(fd) }
              fs.renameSync(p + '.tmp', p)
              //! the rename is not durable until the DIRECTORY entry is — without this, a power loss
              // after the swap "resolved" brings the OLD file back: every swap would be a correlated
              // rename-lie (M4-review). Same ordering discipline as the boot record below.
              syncDir(dir)
              //! fd swap LAST, only after the new file is durably in place: any throw above leaves the
              // old fd valid and owned (no dangling-fd window — a closed-then-recycled fd number here
              // once meant queued appends could write into an unrelated file; M4-review major).
              const old = runtime.#wal
              runtime.#wal = fs.openSync(p, 'a')
              try { fs.closeSync(old) } catch { /* already the new fd's problem space — never fatal */ }
              runtime.node.step({ kind: 'persisted', batch })
            } catch (err) {
              runtime.#walFailed = true
              if (!runtime.node.destroyed) runtime.node.step({ kind: 'persistFail', batch, reason: (err as NodeJS.ErrnoException).code ?? 'swap' })
            }
          })
        },
        //! boot: atomic replace, SYNCHRONOUS, FSYNCED — must be DURABLY on disk before any later-emitted
        // frame hits the wire (the kernel's write-before-later-sends contract: a vote must not outrun
        // its own record). The M4-review critical here: writeFileSync+rename with no fsync (file OR
        // directory) let the one record everything else fences on — votedFor, the Lamport ceiling, the
        // incarnation — regress across a power crash: a double-vote and cross-life seq reuse in one bug.
        boot(record) {
          if (!runtime.#opts.dir) return
          const p = path.join(runtime.#opts.dir, 'boot.json')
          const fd = fs.openSync(p + '.tmp', 'w')
          try {
            fs.writeSync(fd, JSON.stringify(record))
            fs.fsyncSync(fd)
          } finally { fs.closeSync(fd) }
          fs.renameSync(p + '.tmp', p)
          syncDir(runtime.#opts.dir)
        },
        confirm(id, ok, count) { runtime.onConfirm(id, ok, count) },
        invoke(link, id, mode, m, a) { runtime.onInvoke(link, id, mode, m, a) },
        result(id, ok, value) { runtime.onResult(id, ok, value) },
        subRecs(id, recs) { runtime.onSubRecs(id, recs) },
      },
    })
  }

  //! restore — walk the WAL rows ([varint prev][frame]) and replay each through the kernel's
  // source=replay ingest, BEFORE start() brings the network up. A torn tail (a row the crash cut mid-
  // append) fails the walk's bounds and simply ends the restore there — the loss is a tail, which is
  // exactly what anti-entropy heals once the network exists. A failure that is NOT the tail — an
  // intact, crc-valid row exists further on — is interior corruption, and the kernel (not this walk)
  // must pass the verdict: the resync scan below hands it the evidence.
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
    } catch {
      //! the walk failed mid-file: torn tail OR interior corruption — distinguishable by whether any
      // crc-valid frame still exists past the failure. If one does, the file is corrupt in the MIDDLE
      // (bit rot, a lying disk): deliver that frame with an impossible chain link (prev −1) so the
      // kernel's hole verdict — condemn, refold from the cluster — fires exactly as for any proven
      // lie. Silently stopping here treated corruption as an honest tear and kept a partial fold the
      // sim cannot even represent (M4-review major). No candidate ⇒ a genuine tail tear ⇒ done.
      for (let x = c.pos; x + HEADER <= c.end; x++) {
        if (bytes[x] !== MAGIC) continue
        const bl = bytes[x + 3] | (bytes[x + 4] << 8) | (bytes[x + 5] << 16) | (bytes[x + 6] * 0x1000000)
        if (bl < 0 || bl > MAX_FRAME || x + HEADER + bl > c.end) continue
        const view = bytes.subarray(x, x + HEADER + bl)
        const stored = (view[7] + view[8] * 0x100 + view[9] * 0x10000 + view[10] * 0x1000000) >>> 0
        if (crcFrame(view, HEADER + bl) !== stored) continue
        this.node.step({ kind: 'replay', bytes: bytes.slice(x, x + HEADER + bl), prev: -1 })
        break
      }
    }
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

  //! hook — a post-step tap (M5a): fn runs after EVERY node.step, on whatever event path (socket,
  // timer, write, replay). The api's cluster fold rides this — one integer compare per event when
  // nothing changed (it checks journal.n), so the hot path pays an indirection and nothing else.
  // Interim seam: whether membership changes become first-class sink effects is an M5d decision.
  hook(fn: () => void) {
    const step = this.node.step.bind(this.node)
    this.node.step = (e) => { step(e); fn() }
  }

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
    //! FLUSH, then close: queued appends carry records the kernel already committed — a clean destroy
    // that dropped them would un-persist acknowledged writes (M4-review major). The thunks themselves
    // keep writing after destroy() begins (only their echoes check `destroyed`), so awaiting the queue
    // here is what makes shutdown durable.
    await this.#ioq.catch(() => {})
    if (this.#wal !== null) { try { fs.closeSync(this.#wal) } catch {} this.#wal = null }
    if (this.#server) await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
  }
}

const split = (addr: string): [string, number] => {
  const i = addr.lastIndexOf(':')
  return [addr.slice(0, i), Number(addr.slice(i + 1))]
}
