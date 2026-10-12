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
import os from 'node:os'
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

//! rowOf — one WAL row, [varint prev][frame], built at its EXACT size (V4-51): never in a frame-capped Writer — a frame
// received within a few bytes of MAX_FRAME is a legal row, and its prev varint must never make it unwritable (that
// threw FULL inside the RECORDS step that received it and dropped a good link). The varint goes through one reused
// scratch (Infinity: not a frame); the kernel owns `bytes` only until return, so the row is copied out at call time.
const ROW = new Writer(Infinity)
const rowOf = (prev: number, bytes: Uint8Array): Uint8Array => {
  ROW.len = 0
  ROW.varint(prev)
  const row = new Uint8Array(ROW.len + bytes.length)
  row.set(ROW.buf.subarray(0, ROW.len), 0)
  row.set(bytes, ROW.len)
  return row
}
//! writeAll — fs.writeSync until every byte is down: one call may write fewer bytes than asked (Linux writes at most
// ~2 GiB at once), and a short write would tear the snapshot file in the middle
const writeAll = (fd: number, b: Uint8Array): void => { for (let off = 0; off < b.length;) off += fs.writeSync(fd, b, off) }
//! STAGE — the snapshot file is streamed, never assembled whole: rows under 1 MiB are staged and written 1 MiB at a
// time, a bigger row goes straight to the fd
const STAGE = 1 << 20

//! ── the dir lock (wave 6b, DECISIONS V4-NN) ──
// One process at a time holds a `dir`. Before this nothing locked the folder: a second process started on a dir the
// first still held restored it, ran as the SAME uuid, and both appended rows to one log (the platform spikes,
// 2026-10-12); with sockets the two would also claim one identity on the wire. The lock is a file, `lock`, beside
// wal.log, holding the holder's pid, host, boot id and process start time as JSON, put there in ONE step (written whole
// to a side file and hard-linked onto the name: link fails EEXIST atomically, so no reader ever meets an empty lock)
// before the boot record is read and the WAL opens, and removed at destroy() and at process exit.
// Who holds it, from the record: the same running kernel (the boot id; without one, the host name) with the pid alive
// and started when the record says — a pid the kernel has since given to another program, a container's pid 1 after a
// restart, this process's own pid from a life before this one — is a LIVE holder, and the open is refused with a typed
// error, code 'dir-held', naming the pid and host. A dead pid, a reused one, or a boot id of this host's that is not the
// running one (the box rebooted) is a stale lock: taken over. Another machine (another boot id under another host name,
// or another host name where no boot id can be read) cannot be checked and counts as live: the message says to remove
// the file by hand once that machine is gone (a shared network dir is not the deployment rule). Pids are per namespace,
// so two containers on one kernel sharing a volume cannot check each other: not a shape the lock protects, as before.
// A takeover is serialised through a second file of the same kind, `lock.take`: two heirs starting at once after a
// crash cannot both remove the stale lock and both hold the dir, and a process that opens the dir fresh while a
// takeover runs wins or loses by the one atomic link of `lock` itself.
const LOCK = 'lock'
const HOST = os.hostname()
const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
//! BOOT — this kernel's boot id (Linux; null elsewhere). The same id is the same running kernel, so a pid on the record
// can be checked here; a different id under this host name is a reboot; a different id under another name is another
// machine. startOf — when a pid started, in clock ticks since boot (/proc/<pid>/stat field 22, counted from the last ')'
// because the command name may hold spaces and parentheses); null where /proc has no such file.
const BOOT = read('/proc/sys/kernel/random/boot_id')?.trim() || null
const startOf = (pid: number): number | null => {
  const s = read(`/proc/${pid}/stat`)
  if (s === null) return null
  const n = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19])
  return Number.isFinite(n) ? n : null
}
interface Holder { pid: number; host: string; boot: string | null; start: number | null }
export interface DirHeld extends Error { code: 'dir-held'; pid: number; host: string }
const alivePid = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const holderOf = (p: string): Holder | null => {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as { pid?: unknown; host?: unknown; boot?: unknown; start?: unknown }
    return typeof v?.pid === 'number' && typeof v?.host === 'string'
      ? { pid: v.pid, host: v.host, boot: typeof v.boot === 'string' ? v.boot : null, start: typeof v.start === 'number' ? v.start : null }
      : null
  } catch { return null }
}
//! holderAt — the record at `p`. An empty or half-written file younger than GRACE is a writer caught between the create
// and the write (the no-hard-link fallback of claim): wait for its record. Null = stale (nothing readable after GRACE,
// or a file that is not this lock's shape), or gone.
const GRACE = 2000
const napCell = new Int32Array(new SharedArrayBuffer(4))
const holderAt = (p: string): Holder | null => {
  const until = Date.now() + GRACE
  for (;;) {
    const h = holderOf(p)
    if (h !== null) return h
    let age: number
    try { age = Date.now() - fs.statSync(p).mtimeMs } catch { return null }
    if (age > GRACE || Date.now() > until) return null
    Atomics.wait(napCell, 0, 0, 10)
  }
}
//! locks — every lock this process holds, by resolved path, with its release: the exit hook runs them
const locks = new Map<string, () => void>()
let exitHooked = false
//! ME — this process's own record. A record naming my pid is MINE when it says my start time, whatever spelling of the
// dir it was opened under (a symlink, another letter case on a case-blind disk: one process held one dir twice and the
// second release deleted the lock the first ran on); a life before this one (a container restarts its node as pid 1
// again, on the same volume) started at another time and is stale. Without a start time (no /proc) the path decides.
const ME: Holder = { pid: process.pid, host: HOST, boot: BOOT, start: startOf(process.pid) }
//! liveHolder — may the process the record names still be running? 'mine' = this process holds it; 'alive' = another
// process on this kernel; 'elsewhere' = another machine (never checked); null = stale.
const liveHolder = (p: string, h: Holder | null): 'mine' | 'alive' | 'elsewhere' | null => {
  if (h === null) return null
  const sameKernel = h.boot !== null && BOOT !== null ? h.boot === BOOT : h.host === HOST
  if (!sameKernel) return h.host === HOST ? null : 'elsewhere' // this host rebooted: nothing survives one; another machine
  if (h.pid === ME.pid) return h.start !== null && ME.start !== null ? (h.start === ME.start ? 'mine' : null) : locks.has(p) ? 'mine' : null
  if (!alivePid(h.pid)) return null
  const s = startOf(h.pid)
  return h.start === null || s === null || s === h.start ? 'alive' : null
}
//! claim — put my record at `p` in one step: written whole to a side file, then hard-linked onto the name (link fails
// EEXIST when the name exists, atomically). False when the name exists (held, or stale), anything else throws. A
// filesystem without hard links (exFAT) falls back to the O_EXCL create and the write; a reader that meets the empty
// file in that gap waits for the record (holderAt).
const claim = (p: string, mine: string): boolean => {
  const side = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(side, mine, { flag: 'wx' })
  try { fs.linkSync(side, p); return true } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw e
    let fd: number
    try { fd = fs.openSync(p, 'wx') } catch (e2) { if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e2 }
    try { fs.writeSync(fd, mine) } finally { fs.closeSync(fd) }
    return true
  } finally { try { fs.unlinkSync(side) } catch { /* linked, or never made */ } }
}
const heldError = (who: string, dir: string, h: Holder, why: 'mine' | 'alive' | 'elsewhere'): DirHeld =>
  Object.assign(new Error(why === 'mine'
    ? `${who}: dir ${dir} is held by this process already (pid ${h.pid} on ${h.host}); one dir is one node: stop the fero that holds it first, or give this one a dir of its own`
    : `${who}: dir ${dir} is held by another process — pid ${h.pid} on ${h.host}; one dir is one node: stop that process first, or give this one a dir of its own${why === 'elsewhere' ? ` (a lock from another machine is never taken over: remove ${path.join(dir, LOCK)} by hand once that machine is gone)` : ''}`), { code: 'dir-held' as const, pid: h.pid, host: h.host })
const UNKNOWN: Holder = { pid: 0, host: HOST, boot: BOOT, start: null }
//! lockDir — take the dir for this process (made if missing); returns the release, which is also run at process exit.
// `who` prefixes the refusal (the composer's fero('name')).
export const lockDir = (dir: string, who = 'Runtime'): (() => void) => {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(path.resolve(dir), LOCK), take = p + '.take'
  const mine = JSON.stringify(ME) + '\n'
  //! release only what is still mine: a crash and a takeover may have put another holder's record there since
  const release = () => { locks.delete(p); try { if (fs.readFileSync(p, 'utf8') === mine) fs.unlinkSync(p) } catch { /* gone already */ } }
  const held = () => {
    locks.set(p, release)
    if (!exitHooked) { exitHooked = true; process.on('exit', () => { for (const r of [...locks.values()]) r() }) }
    return release
  }
  if (claim(p, mine)) return held()
  const h = holderAt(p), why = liveHolder(p, h)
  if (why !== null) throw heldError(who, dir, h!, why)
  //! stale — take it over, one heir at a time
  if (!claim(take, mine)) {
    const t = holderAt(take), tw = liveHolder(take, t)
    if (tw !== null) throw heldError(who, dir, t!, tw)
    try { fs.unlinkSync(take) } catch { /* the other heir finished first */ }
    if (!claim(take, mine)) throw heldError(who, dir, holderAt(take) ?? UNKNOWN, 'alive')
  }
  try {
    const now = holderAt(p), nw = liveHolder(p, now) // read again under the marker: a holder that started between the two looks is live
    if (nw !== null) throw heldError(who, dir, now!, nw)
    try { fs.unlinkSync(p) } catch { /* gone */ }
    if (!claim(p, mine)) throw heldError(who, dir, holderAt(p) ?? UNKNOWN, 'alive') // a fresh opener slipped in: it holds
    return held()
  } finally { try { fs.unlinkSync(take) } catch { /* gone */ } }
}

//! RuntimeOpts: NodeOpts + the storage directory (presence = durable mode; NodeOpts.durable derives from it).
export interface RuntimeOpts extends NodeOpts {
  dir?: string
  //! lock (wave 6b) — the release of a lock on `dir` the embedder already holds (the composer takes it BEFORE it reads
  // the boot record, so the record it restores is the last one the previous life wrote, never one a holder still alive
  // overwrote a moment later); the Runtime adopts it instead of taking its own. Absent: the Runtime takes the lock.
  lock?: () => void
}

//! restoreOpts — read the durable facts back into NodeOpts shape (the embedder calls this BEFORE
// constructing the Runtime, bumps incarnation itself, then replays via runtime.restore()).
// NB (v4.1): the result now carries the dir's uuid and resource name — an embedder that blind-spreads
// it AFTER a configured uuid silently adopts the dir's identity (and before it, silently keeps its
// own over the dir's boot facts). Compare explicitly like the composer does (api/index.ts): a
// config/dir identity contradiction should THROW, never resolve by spread order.
export const restoreOpts = (dir: string): { uuid?: string; name?: string; boot?: NodeOpts['boot']; incarnation?: number } => {
  //! a store that failed mid-life (I-36): its boot record stopped landing while the process lived on and kept
  // voting from memory, so whatever boot.json still says (votedFor, the Lamport ceiling) is stale — restoring
  // it could vote twice in one epoch. boot() marks the dir when a record fails; this refuses it.
  const condemnedPath = path.join(dir, CONDEMNED)
  if (fs.existsSync(condemnedPath))
    throw new Error(`restoreOpts: ${dir} is a store that failed mid-life (${fs.readFileSync(condemnedPath, 'utf8').trim() || 'a boot record did not land'}) — its boot record is stale; refusing to restore from it (move the dir aside to start this node fresh)`)
  const bootPath = path.join(dir, 'boot.json')
  if (!fs.existsSync(bootPath)) {
    //! a NON-EMPTY wal.log with no boot record is an incomplete dir (partial copy, deleted
    // boot.json, a rename that never survived a foreign fs) — replaying it would adopt an unowned
    // log under whatever identity the caller happens to hold: the silent merge v4.1 refuses. An
    // EMPTY wal.log is the honest crash-before-first-boot-write window (the append fd creates the
    // file at construction) — a pristine fresh boot, not an adoption. A store that failed mid-life lands
    // here too when only boot()'s unlink got through (its marker write did not).
    const walPath = path.join(dir, 'wal.log')
    if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0)
      throw new Error(`restoreOpts: ${dir} holds a wal.log but no boot.json — an incomplete dir (a partial copy, or a store that failed mid-life); refusing to adopt an unowned log`)
    return {}
  }
  const b = JSON.parse(fs.readFileSync(bootPath, 'utf8')) as BootRecord
  return {
    //! identity recovery (v4.1): the dir knows who it belongs to — a pre-v4.1 boot.json lacks the
    // field (absent key) and the caller falls back to its configured/random uuid, the legacy behavior
    ...(b.uuid ? { uuid: b.uuid } : {}),
    ...(b.name ? { name: b.name } : {}),
    boot: {
      epoch: b.epoch, members: b.members, lamport: b.lamport, votedFor: b.votedFor,
      //! M6 (armed lives only — absent keys stay absent, so unscoped restores are shape-identical):
      // the held/orphan/dirty ledgers + the floor seed all ride, or a frozen orphan's rows lose
      // their replay authority and its floors collapse (the fix-round H1 regression in the sim)
      ...(b.heldPartitions ? { heldPartitions: b.heldPartitions } : {}),
      ...(b.orphanParts ? { orphanParts: b.orphanParts } : {}),
      ...(b.dirtyParts ? { dirtyParts: b.dirtyParts } : {}),
      ...(b.floors ? { floors: b.floors } : {}),
    },
    incarnation: b.incarnation + 1,
  }
}

export class Runtime {
  node: Node
  #sockets = new Map<number, net.Socket>()
  #paused = new Set<number>()
  #timers = new Map<number, NodeJS.Timeout>()
  #server: net.Server | null = null
  #started = false // start() runs once: a second call would leak the first bind (see start())
  #linkSeq = 0
  #opts: RuntimeOpts
  //! the graceful leave (V4-6): one promise per runtime, settled by the kernel's `left` effect or the cap
  #leaving: Promise<boolean> | null = null
  #onLeft: ((clean: boolean) => void) | null = null
  #wal: number | null = null // fd, held open for append (the plan's fd-held contract)
  #unlock: (() => void) | null = null // the dir lock's release (wave 6b): run at destroy() and at process exit
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
  //! #bootFailed — the boot record's own latch (I-36). The found case is a dir deleted under a running
  // member: the append fd stays open on the unlinked file, so appends and fsyncs keep SUCCEEDING, and the
  // first boot record after it (a vote, a view install, the Lamport lease) is the first write that meets
  // the missing directory — it used to throw ENOENT out of the kernel's step, uncaught, mid-leave. One
  // failed boot write now condemns the store like a failed fsync (#walFailed too, so `persisted` is never
  // answered again), stops every later boot write, and tells the kernel ONCE (persistFail). The leave that
  // carried the vote completes without its record — the store is dead either way — the process lives,
  // and the survivors shrink the view by ballot.
  #bootFailed = false
  onApply: (rec: Applied) => void
  //! onLost — a write of ours the kernel refused at the election (V4-18): it committed at these
  // coordinates and lost, and no apply will ever carry it (env.ts lost). The api settles the promise here.
  onLost: (iss: string, cid: number, origin: string, seq: number, epoch: number) => void = () => {}
  //! onAcked — a write of ours the owner committed, whose record will never fold here (a scoped non-holder,
  // a spoke of one): the WACK's coordinates are the settlement (env.ts acked). The api settles the promise here.
  onAcked: (iss: string, cid: number, origin: string, seq: number, epoch: number) => void = () => {}
  //! onConfirm — the guarantee ladder's answers surface here (M5's confirm option resolves off it)
  onConfirm: (id: number, ok: boolean, count: number) => void = () => {}
  //! the M5c method plane surfaces here — the api layer is the HOST (it runs handlers) and the CALLER
  // (it awaits results / folds sub records); the kernel only routes frames (env.ts contract).
  onInvoke: (link: number, id: number, mode: number, m: string, a: unknown) => void = () => {}
  onResult: (id: number, ok: boolean, value: unknown, local: boolean) => void = () => {}
  onSubRecs: (id: number, recs: Rec[]) => void = () => {}

  constructor(opts: RuntimeOpts, onApply: (rec: Applied) => void = () => {}) {
    this.#opts = opts
    this.onApply = onApply
    if (opts.dir) {
      fs.mkdirSync(opts.dir, { recursive: true })
      //! the lock comes FIRST (wave 6b): a refused open has touched nothing but the folder itself
      this.#unlock = opts.lock ?? lockDir(opts.dir, opts.name !== undefined ? `fero('${opts.name}')` : 'Runtime')
      try { this.#wal = fs.openSync(path.join(opts.dir, 'wal.log'), 'a') } catch (e) { this.#unlock(); throw e }
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
        left(clean) { runtime.#onLeft?.(clean) },
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
        lost(iss, cid, origin, seq, epoch) { runtime.onLost(iss, cid, origin, seq, epoch) },
        acked(iss, cid, origin, seq, epoch) { runtime.onAcked(iss, cid, origin, seq, epoch) },
        //! persist: append [varint prev][frame] + fsync, then echo — batch-per-call today (each call IS
        // a run frame; the group-many-appends-per-fsync batching is an M8 measured optimization, not a
        // semantic). The prev prefix is the chain link replay's interior-hole detector reads back.
        // Rows are copied out at CALL time (the kernel owns `bytes` only until return) and appended
        // through the ordered #ioq (see its banner — unordered appends corrupt the chain on disk).
        persist(batch, bytes, prev) {
          if (runtime.#wal === null) return
          const row = rowOf(prev, bytes)
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
        //! STREAMED (V4-51): the file is every live row, which passes one frame by far on a big store. It used to be
        // assembled in ONE Writer capped at MAX_FRAME + HEADER, so the first swap of a store whose live data passed
        // 256 MiB threw here, latched #walFailed, and the store lost its WAL for good (persistFail 'swap').
        snapshot(batch, rows) {
          if (!runtime.#opts.dir) return
          const p = path.join(runtime.#opts.dir, 'wal.log')
          const dir = runtime.#opts.dir
          runtime.#ioq = runtime.#ioq.then(() => {
            if (runtime.#wal === null || runtime.#walFailed || runtime.node.destroyed) return
            try {
              const fd = fs.openSync(p + '.tmp', 'w')
              try {
                const w = new Writer(Infinity)
                for (const r of rows) {
                  w.varint(r.prev)
                  if (r.bytes.length >= STAGE) { writeAll(fd, w.buf.subarray(0, w.len)); w.len = 0; writeAll(fd, r.bytes); continue }
                  w.bytes(r.bytes)
                  if (w.len >= STAGE) { writeAll(fd, w.buf.subarray(0, w.len)); w.len = 0 }
                }
                if (w.len > 0) writeAll(fd, w.buf.subarray(0, w.len))
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
          if (!runtime.#opts.dir || runtime.#bootFailed) return
          const p = path.join(runtime.#opts.dir, 'boot.json')
          try {
            const fd = fs.openSync(p + '.tmp', 'w')
            try {
              fs.writeSync(fd, JSON.stringify(record))
              fs.fsyncSync(fd)
            } finally { fs.closeSync(fd) }
            fs.renameSync(p + '.tmp', p)
            syncDir(runtime.#opts.dir)
          } catch (err) {
            //! the record did not land (see #bootFailed): latch both stores dead NOW — synchronously, so no
            // append or echo can slip in — and post the alarm on a microtask, not as a nested step: boot()
            // runs INSIDE the kernel's own step (persistBoot is synchronous by contract), and the api's
            // post-step fold must never observe a half-stepped node.
            runtime.#bootFailed = true
            runtime.#walFailed = true
            const reason = (err as NodeJS.ErrnoException).code ?? 'boot'
            //! and mark the DIR (I-36): the process lives on and votes from memory, so the boot.json on disk
            // is stale from here — a restart must refuse it, not replay an honest prefix under an old votedFor.
            // Two best-effort steps, each alone enough for restoreOpts to refuse: the marker (survives an
            // empty wal.log), then the unlink (works where a write cannot, e.g. ENOSPC). A dir that is gone
            // (the found case) takes neither — and holds nothing to restore from.
            const dir = runtime.#opts.dir!
            try { fs.writeFileSync(path.join(dir, CONDEMNED), `boot record failed: ${reason}\n`) } catch { /* the disk refuses this too */ }
            try { fs.unlinkSync(p) } catch { /* absent, or the disk refuses this too */ }
            queueMicrotask(() => { if (!runtime.node.destroyed) runtime.node.step({ kind: 'persistFail', batch: 0, reason }) })
          }
        },
        confirm(id, ok, count) { runtime.onConfirm(id, ok, count) },
        invoke(link, id, mode, m, a) { runtime.onInvoke(link, id, mode, m, a) },
        result(id, ok, value, local) { runtime.onResult(id, ok, value, local) },
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
  // A stop that lands first — destroy() before 'listening', or before start() was even called —
  // REJECTS too, typed `code: 'stopped'`: destroy()'s server.close() means 'listening' never fires
  // (Node 26 binds an IP literal asynchronously; Node 22 binds it at once and drops the queued
  // 'listening' when the handle closes), so the old promise stayed pending for ever. A start() after
  // destroy() binds nothing: that server would have had nobody left to close it. A second start()
  // REJECTS typed `code: 'started'`: it would have replaced #server and leaked the first bind, which
  // destroy() could then never close. So the promise can reject on an ordinary stop: await it or
  // attach a handler (the composer races it), or a stop before 'listening' is an unhandled rejection.
  async start(): Promise<void> {
    if (this.node.destroyed) throw stoppedError()
    if (this.#started) throw Object.assign(new Error('runtime already started'), { code: 'started' })
    this.#started = true
    if (this.#opts.listen) {
      const [host, port] = split(this.#opts.listen)
      const server = net.createServer((sock) => this.#accept(sock))
      this.#server = server
      await new Promise<void>((resolve, reject) => {
        //! whichever settles first removes all three listeners — the 'close' that a later stop fires on a
        // server that DID listen must not reach a promise that already resolved
        const off = () => { server.removeListener('error', onError); server.removeListener('close', onClose) }
        const onError = (err: Error) => { off(); reject(err) }
        const onClose = () => { off(); reject(stoppedError()) }
        server.once('error', onError)
        server.once('close', onClose)
        server.listen(port, host, () => {
          off()
          server.on('error', () => {}) // post-start server errors must not become uncaughtException
          //! port 0 (V4-3): the OS chose — publish the real address to the kernel NOW, inside the listen
          // callback: before the start stimulus dials anyone and before any accepted socket can HELLO
          // (accept fires only after listen), so the gossiped listen is never ':0'.
          if (port === 0) {
            const a = server.address() as net.AddressInfo
            this.node.listen = `${host}:${a.port}`
          }
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
    //! a dial that lands after destroy() began: refuse it, as #dial's late 'connect' does — the socket
    // loop in destroy() has already run, so a socket wired now would keep server.close() waiting forever
    if (this.node.destroyed) return sock.destroy()
    const link = ++this.#linkSeq
    this.#wire(sock, link)
    sock.on('close', () => {
      this.#sockets.delete(link)
      this.#paused.delete(link)
      this.node.step({ kind: 'linkDown', link, reason: 'close' })
    })
    this.node.step({ kind: 'linkUp', link, dialed: false })
  }

  //! drop (M7 [diagnostics]): abruptly destroy the socket to an IDENTIFIED peer — what a real network
  // drop looks like (no goodbye; both kernels hear linkDown via 'close'). A transient, not a partition:
  // the peer redials within redialMs. false = no identified live link for that uuid; never throws.
  drop(uuid: string): boolean {
    const link = this.node.byUuid.get(uuid)
    if (link === undefined) return false
    const sock = this.#sockets.get(link)
    if (!sock || sock.destroyed) return false
    sock.destroy()
    return true
  }

  //! leave (V4-6) — the graceful exit: ask the kernel to get the view changed without this node and
  // wait for the outcome. Resolves true when the shrunk view committed and a survivor echoed it (or
  // there was nothing to leave), false when the kernel's bound ran out (node.tune: leaveTicks with no member
  // link that could answer, leaveWindow with one — the knock window, DESIGN-LEAVE §10.7) or this wall-clock cap
  // did — the caller tears down either way; false means the survivors will evict us the slow way, or (a
  // scoped member, DESIGN-SCALE stage 1 (b)) that the view change did commit but the new holders did not
  // prove inside tune.drainTicks that they hold every partition this node held: those rows went with it.
  // The cap covers the tick bounds at this node's heartbeat cadence plus slack — the window (never less
  // than the bound), plus the drain's on a scoped node, plus one tick for a drain that starts at the view
  // half's last tick + 1 when it timed out: with the defaults that is the 34th tick after leave(), and a cap
  // of 34 periods could win the race and tear the node down before it writes its `undrained` row
  // (heartbeats OFF ⇒ no view ⇒ the kernel answers at once). Idempotent: a second call joins the first wait.
  //! The cap is clamped to Node's timer ceiling (2^31 - 1 ms, about 24.8 days): setTimeout treats a longer delay as
  // 1 ms, so an operator who set leave.ms to a huge number to mean "wait as long as it takes" got the opposite — the
  // cap won before the kernel ticked once and every stop with a slow survivor was a crash (the wave 5c review;
  // tests/knock.test.ts pins it). The window's ticks are the kernel's bound; the clamp only keeps the timer honest.
  leave(): Promise<boolean> {
    if (this.#leaving) return this.#leaving
    if (this.node.destroyed) return Promise.resolve(false)
    this.#leaving = new Promise<boolean>((resolve) => {
      const ticks = Math.max(this.node.tune.leaveWindow, this.node.tune.leaveTicks) + (this.node.scoped ? this.node.tune.drainTicks + 1 : 0) + 2
      const capMs = Math.min(MAX_TIMER_MS, Math.max(250, (this.#opts.heartbeatMs ?? 0) * ticks))
      const cap = setTimeout(() => { this.#onLeft = null; resolve(false) }, capMs)
      this.#onLeft = (clean) => { clearTimeout(cap); this.#onLeft = null; resolve(clean) }
      this.node.step({ kind: 'leave' })
    })
    return this.#leaving
  }

  async destroy(): Promise<void> {
    this.node.destroy()
    //! stop ACCEPTING first: close() refuses new dials at once and settles when the last socket is gone.
    // It used to run after the WAL flush below — a peer's redial (30 ms in a hurried cluster) accepted
    // during that wait was never torn down, and the stop hung until fero.spawn's SIGKILL (I-21).
    const closed = this.#server ? new Promise<void>((resolve) => this.#server!.close(() => resolve())) : null
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
    //! the dir is free once the WAL is closed: the next life (this process or another) may open it
    if (this.#unlock !== null) { this.#unlock(); this.#unlock = null }
    if (closed) await closed
  }
}

//! CONDEMNED — the marker boot() leaves in a dir whose boot record failed mid-life (I-36); restoreOpts refuses it
const CONDEMNED = 'condemned'
//! MAX_TIMER_MS — Node's setTimeout ceiling (2^31 - 1 ms): a longer delay fires after 1 ms. The destroy cap is clamped to it.
const MAX_TIMER_MS = 2_147_483_647

//! the typed reject start() settles with when the runtime stopped before it listened
const stoppedError = () => Object.assign(new Error('runtime stopped before it listened'), { code: 'stopped' })

const split = (addr: string): [string, number] => {
  const i = addr.lastIndexOf(':')
  return [addr.slice(0, i), Number(addr.slice(i + 1))]
}
