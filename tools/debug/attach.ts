//! ── tools/debug/attach — the DIAG wire consumer: dial, latch, pull, never invent (DESIGN-M7 §3) ──
// The ONE client everyone copies (the cursor conventions live here): a DiagClient per target holds a
// persistent socket + the kernel's OWN Framer/encodeControl (imported, never reimplemented), latches
// via the r:2 HELLO + bearer token, and answers pulls promise-per-id. The pull-spine survives end to
// end: no timer lives anywhere in this file — the HTTP request is the fan-out, the viewer's poll is
// the only cadence in the system (v2 DECISIONS O, literal).
//
// Honesty rules the assembly enforces STRUCTURALLY:
//   - a node that won't answer is NEVER synthesized into nodes[] — it becomes an absent row
//     {target, reason} with a closed reason set (folds range over nodes[] only, so no fold can mint
//     a status for an uncaptured node);
//   - a timeout/frame fault discards the socket AND the framer (a half-read framer is never reused);
//   - every reply echoes {u, i} — an incarnation change mid-pull is 'restarted', never a stitch
//     (the origin-lane rebirth rule applied to diagnostics);
//   - a deny is STICKY ('unauthorized'): a bad token is a config error — re-dialing every poll would
//     only spam the node's deny journal.

import net from 'node:net'
import { Framer, VERB, encodeControl, type Frame } from '../../kernel/codec.ts'
import { captureAttached, type Absent, type AttachAnswer } from './capture.ts'
import { encodeVal } from './model.mjs'

//! one pull's budget must sit UNDER the viewer's 1.5s poll — overlapping rebuilds must never pile up
export const PULL_BUDGET_MS = 1200

export class DiagClient {
  readonly target: string
  #token: string
  #sock: net.Socket | null = null
  #framer = new Framer()
  #nextId = 1
  #pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  #ready: Promise<void> | null = null
  #accept: { resolve: () => void; reject: (e: Error) => void } | null = null
  #refused = false
  denied = false // sticky — see the banner
  peer: { u: string; i: number } | null = null

  constructor(target: string, token: string) {
    this.target = target
    this.#token = token
  }

  //! teardown — the ONLY exit: socket destroyed, framer REPLACED (never reused half-read), waiters rejected
  #teardown(err: Error) {
    this.#sock?.destroy()
    this.#sock = null
    this.#framer = new Framer()
    this.#ready = null
    const ps = [...this.#pending.values()]
    this.#pending.clear()
    for (const p of ps) p.reject(err)
    this.#accept?.reject(err)
    this.#accept = null
  }

  #connect(): Promise<void> {
    if (this.denied) return Promise.reject(new Error('unauthorized'))
    if (this.#ready) return this.#ready
    this.#ready = new Promise<void>((resolve, reject) => {
      const at = this.target.lastIndexOf(':')
      const sock = net.connect(Number(this.target.slice(at + 1)), this.target.slice(0, at))
      this.#sock = sock
      this.#accept = { resolve, reject }
      this.#refused = false
      sock.on('data', (chunk: Buffer) => {
        try {
          for (const f of this.#framer.push(new Uint8Array(chunk))) this.#onFrame(f)
        } catch {
          this.#teardown(new Error('frame'))
        }
      })
      sock.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'ECONNREFUSED') this.#refused = true })
      sock.on('close', () =>
        this.#teardown(new Error(this.denied ? 'unauthorized' : this.#refused ? 'refused' : 'refused')))
      //! the latch: our HELLO carries r:2 + the token; the node's ACCEPT (DIAGA id:0) resolves the dial.
      // close-before-ACCEPT = denied — the one reliable client contract (the deny frame is best-effort).
      sock.on('connect', () =>
        sock.write(encodeControl(VERB.HELLO, { u: `diag-${process.pid}-${this.#nextId}`, i: 1, l: '', r: 2, t: this.#token })))
    })
    return this.#ready
  }

  #onFrame(f: Frame) {
    if (f.verb === VERB.HELLO) return // the node's own identity frame — {u,i} also echo on every DIAGA
    if (f.verb === VERB.PING) { this.#sock?.write(encodeControl(VERB.PONG)); return }
    if (f.verb !== VERB.DIAGA) return
    const v = f.value as Record<string, unknown>
    if (v.id === 0) {
      if (v.ok === 1) {
        this.peer = { u: v.u as string, i: v.i as number }
        this.#accept?.resolve()
        this.#accept = null
      } else this.denied = true // the server closes right after; 'close' finishes the teardown
      return
    }
    const w = this.#pending.get(v.id as number)
    if (w) { this.#pending.delete(v.id as number); w.resolve(v) }
  }

  //! q — one pull: latch if needed, send DIAGQ, await ITS DIAGA under the deadline. Replies are
  // guarded for ok + the (u,i) segment identity; a restarted node rejects 'restarted' and tears down.
  async q(body: Record<string, unknown>, deadlineMs: number): Promise<Record<string, unknown>> {
    const timed = <T>(p: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => { this.#teardown(new Error('timeout')); reject(new Error('timeout')) }, deadlineMs)
        p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
      })
    await timed(this.#connect())
    const id = this.#nextId++
    const v = await timed(new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#sock!.write(encodeControl(VERB.DIAGQ, { id, ...body }))
    }))
    if (this.peer && (v.u !== this.peer.u || v.i !== this.peer.i)) {
      this.#teardown(new Error('restarted'))
      throw new Error('restarted')
    }
    //! a typed per-op failure is absent, never invented data: 'too-large' (the answer does not fit in one frame)
    // keeps its own word so reasonOf can name it 'frame'; anything else (bad-op, bad-args) is 'error'
    if (v.ok !== 1) throw new Error(v.e === 'too-large' ? 'too-large' : 'error')
    return v
  }

  close() { this.#teardown(new Error('closed')) }
}

//! the per-attach caches (wave 5e) — what this bridge already pulled from one node LIFE, so a rebuild asks only
// for what changed. Keyed by the client object (one per target); a cache belongs to one (uuid, incarnation): a
// restarted node starts a new journal at t=0 and new lanes, so a different peer drops the cache whole.
//   journal — rows are immutable per t: keep rows [dropped, cursor) and ask from the cursor (INCLUSIVE f), where
//             cursor = the last snapshot's head. A ring wrap past the cursor (the answer's f0 > cursor) is a hole:
//             the cache is dropped and the slice starts at f0, its `dropped` raised to say so — never a splice.
//   logs    — a record (origin, seq) is immutable too, but the SET changes (compaction, shed, splice, acquire,
//             condemn, resync): ask q:'seqs' for the seqs there NOW, pull only the missing ones (q:'logs' from just
//             below the lowest), and keep exactly the listed seqs — nothing below the node's base survives a rebuild.
type JRow = { t: number; kind: number; a?: unknown; b?: unknown; c?: unknown }
type LogEntry = { k: unknown; at: unknown; ty: number; v: unknown; seq: number; epoch: number; iss?: string; cid?: number }
type Cache = { u: string; i: number; rows: JRow[]; cursor: number; logs: Map<string, Map<number, LogEntry>> }
const caches = new WeakMap<object, Cache>()
//! the client surface pullNode needs — a DiagClient, or any object answering the same questions (the suites drive a
// kernel Node through onDiagQ directly to make restarts, ring wraps and hand-offs happen on cue)
export type Puller = { target: string; peer: { u: string; i: number } | null; q: (body: Record<string, unknown>, deadlineMs: number) => Promise<Record<string, unknown>> }

//! pullNode — one truthful node slice via the chunked ops: meta (vocab) → node (the fold) → state (single
// frame) → journal delta (INCLUSIVE f from the cache's cursor) → per-origin seqs
// + the missing log entries (EXCLUSIVE f — the digest/AE convention). The blob it assembles is captureNode's EXACT
// shape — the parity pins in attach.test.ts hold them deepEqual — with encodeVal applied bridge-side (the wire
// carries values raw; JSON safety is the capture's concern).
export const pullNode = async (c: Puller, budgetMs = PULL_BUDGET_MS): Promise<AttachAnswer> => {
  const t0 = performance.now()
  const left = () => Math.max(50, budgetMs - (performance.now() - t0))
  const meta = await c.q({ q: 'meta' }, left())
  //! one cache per node life: the peer the latch (or the meta reply) named
  const peer = c.peer ?? { u: meta.u as string, i: meta.i as number }
  let cache = caches.get(c)
  if (!cache || cache.u !== peer.u || cache.i !== peer.i) {
    cache = { u: peer.u, i: peer.i, rows: [], cursor: 0, logs: new Map() }
    caches.set(c, cache)
  }
  const nq = await c.q({ q: 'node' }, left())
  const w = nq.n as {
    uuid: string; name?: string; listen: string; seq: number; epoch: number
    view: { epoch: number; members: string[] }; gate: string
    pendingWrites: number; client?: boolean; feeder?: string | null; replicas?: number; holders?: Record<string, string[]>; held?: string[]
    stateHash: number; jn: number; dropped: number
    streams: Record<string, { a: number; s: number; d: number }>
    origins: Record<string, { tail: number; base: number }>
    links: unknown[]
  }
  //! state RIGHT AFTER the snapshot — the shortest window the wire allows between the two instants the replay
  // oracle compares. The state's own hash (sh) against the snapshot's says whether anything landed in that window:
  // if so the read is TORN — the state is a later instant than the journal (cut at the snapshot, below) — and the
  // slice says so, so the viewer paints "torn read" where a replay mismatch would have read as a fault (ISSUES I-2)
  const st = await c.q({ q: 'state' }, left())
  const torn = st.sh !== w.stateHash
  //! journal: the delta from the cursor, resumed via next until the snapshot's head. CUT at the head: a row with
  // t ≥ w.jn landed AFTER the node fold was taken (a busy node keeps writing while we page), and folding it against
  // the snapshot's links/streams read as drift where there was only skew (ISSUES I-18). Rows below the snapshot's
  // `dropped` left the node's ring and leave the cache; a hole past the cursor drops the cache (never a splice).
  let rows = [...cache.rows] // a fresh array: a slice handed out earlier must never grow under its reader
  let start = w.dropped
  for (let f = cache.cursor; f < w.jn; ) {
    const page = await c.q({ q: 'journal', f }, left())
    if ((page.f0 as number) > f) { rows = []; start = Math.max(start, page.f0 as number) } // the ring wrapped past f: rows [f, f0) are gone
    for (const row of page.ev as [number, number, unknown, unknown, unknown][])
      if (row[0] < w.jn && row[0] >= f) rows.push({ t: row[0], kind: row[1], a: row[2], b: row[3], c: row[4] })
    if (page.next === undefined || (page.next as number) >= w.jn) break
    f = page.next as number
  }
  rows = rows.filter((r) => r.t >= start)
  cache.rows = rows
  cache.cursor = w.jn
  //! logs: the seqs there now, then only the missing entries — EXCLUSIVE cursor, resumed from `next` (the last served seq)
  const logs: Record<string, unknown[]> = {}
  for (const o of [...cache.logs.keys()]) if (!(o in w.origins)) cache.logs.delete(o)
  for (const o of Object.keys(w.origins)) {
    if (!((meta.p as number) >= 2)) { logs[o] = await pullLogs(c, o, left); continue } // an older node has no q:'seqs': the whole book, uncached
    const have = cache.logs.get(o) ?? new Map<number, LogEntry>()
    const seqs: number[] = []
    for (let f = 0; ; ) {
      const page = await c.q({ q: 'seqs', o, f }, left())
      for (const s of page.s as number[]) seqs.push(s)
      if (page.next === undefined) break
      f = page.next as number
    }
    const missing = seqs.filter((s) => !have.has(s))
    if (missing.length) {
      const want = new Set(missing)
      for (let f = missing[0] - 1; ; ) {
        const page = await c.q({ q: 'logs', o, f }, left())
        for (const e of page.ev as { s: number; e: number; ty: number; k: unknown; at: unknown; v: unknown; iss?: string; cid?: number }[]) {
          //! a seq listed now, or a new tail landed after the list (the old whole pull took it too)
          if (!want.has(e.s) && e.s <= seqs[seqs.length - 1]) continue
          if (!want.has(e.s)) seqs.push(e.s)
          have.set(e.s, { k: e.k, at: e.at, ty: e.ty, v: encodeVal(e.v), seq: e.s, epoch: e.e, iss: e.iss, cid: e.cid })
        }
        if (page.next === undefined) break
        f = page.next as number
      }
    }
    const keep = new Map<number, LogEntry>()
    const entries: LogEntry[] = []
    for (const s of seqs) { const e = have.get(s); if (e) { keep.set(s, e); entries.push(e) } }
    cache.logs.set(o, keep)
    logs[o] = entries
  }
  return {
    target: c.target,
    vocab: meta.vocab as Record<string, number>,
    node: {
      uuid: w.uuid, ...(w.name !== undefined ? { name: w.name } : {}), listen: w.listen, seq: w.seq, epoch: w.epoch, view: w.view, gate: w.gate,
      pendingWrites: w.pendingWrites, client: w.client,
      ...('feeder' in w ? { feeder: w.feeder } : {}),
      replicas: w.replicas,
      ...(w.holders ? { holders: w.holders } : {}),
      ...(w.held ? { held: w.held } : {}),
      stateHash: w.stateHash, dropped: start,
      journal: rows, logs,
      state: (st.cells as [string, unknown][]).map(([k, v]) => [k, encodeVal(v)]),
      streams: w.streams, links: w.links,
      ...(torn ? { torn: true } : {}),
    } as AttachAnswer['node'],
  }
}

//! pullLogs — one origin's whole record book (EXCLUSIVE cursor, resumed from `next`): the pre-5e pull, kept for an older node
const pullLogs = async (c: Puller, o: string, left: () => number): Promise<LogEntry[]> => {
  const entries: LogEntry[] = []
  for (let f = 0; ; ) {
    const page = await c.q({ q: 'logs', o, f }, left())
    for (const e of page.ev as { s: number; e: number; ty: number; k: unknown; at: unknown; v: unknown; iss?: string; cid?: number }[])
      entries.push({ k: e.k, at: e.at, ty: e.ty, v: encodeVal(e.v), seq: e.s, epoch: e.e, iss: e.iss, cid: e.cid })
    if (page.next === undefined) break
    f = page.next as number
  }
  return entries
}

//! reasonOf — map a pull failure onto the CLOSED absent-reason set (anything unrecognized is 'refused':
// the dial-level default, never a fabricated specific). 'too-large' is 'frame': the node's answer is bigger
// than one frame may be — a message-size fault, not a question the node cannot answer.
const reasonOf = (e: unknown): Absent['reason'] => {
  const m = e instanceof Error ? e.message : ''
  if (m === 'too-large') return 'frame'
  return (['refused', 'timeout', 'unauthorized', 'frame', 'restarted', 'error'] as const).includes(m as Absent['reason'])
    ? (m as Absent['reason'])
    : 'refused'
}

//! AttachPool — the /capture.json source for a REAL cluster: one DiagClient per target, FRESH pulls per
// HTTP request, and an in-flight COALESCER (concurrent requests share one fan-out — with the budget
// under the poll interval this bounds the whole system at one rebuild in flight, no pileup).
export class AttachPool {
  #clients: DiagClient[]
  #inflight: Promise<ReturnType<typeof captureAttached>> | null = null

  constructor(targets: string[], token: string) {
    this.#clients = targets.map((t) => new DiagClient(t, token))
  }

  capture(budgetMs = PULL_BUDGET_MS): Promise<ReturnType<typeof captureAttached>> {
    if (this.#inflight) return this.#inflight
    this.#inflight = this.#build(budgetMs).finally(() => { this.#inflight = null })
    return this.#inflight
  }

  async #build(budgetMs: number) {
    const answers: AttachAnswer[] = []
    const failures: Absent[] = []
    await Promise.all(this.#clients.map(async (c) => {
      try {
        answers.push(await pullNode(c, budgetMs))
      } catch (e) {
        failures.push({ target: c.target, reason: reasonOf(e) })
      }
    }))
    //! stable order: answers land by fan-out completion — sort by target so the dash doesn't reshuffle
    answers.sort((a, b) => (a.target < b.target ? -1 : 1))
    return captureAttached(answers, failures)
  }

  close() { for (const c of this.#clients) c.close() }
}
