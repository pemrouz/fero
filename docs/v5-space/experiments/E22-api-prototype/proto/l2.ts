// l2 — fold and ops at the writer, as a LIBRARY over the kernel's five operations. The writer's
// state (rows at the log end, row versions, ttl deadlines, sessions, leases, attempts, fences, which
// slots it owns) is a pure fold of its group's log, including the uncommitted tail. So a new leader
// rebuilds it with read() (from the last snapshot()), and a slot carries its part in an 'in' entry.
// Judging order (API.md §4): dedup; shape checks; validation, schema, rules.write; conditions; ops.
// The writer appends results only: followers, clients and replays apply plain values.

import { Kernel, SLOTS, type Entry, type Group, type NewEntry, type Rec, type ResMeta, type SlotState, type RowMetaWire, type AttemptWire } from './kernel.ts'
import type { World, Proc } from './world.ts'
import type { Refusal } from './errors.ts'
import { source, fold, rowOf, hasRow, keysOf } from './seam.ts'
import { Heap, deepEqual, wireCopy } from './util.ts'

// ── the request a writer judges, and its answer ─────────────────────────────
export type Path = (string | number)[]
export interface Cond { absent?: true; present?: true; version?: string; equals?: unknown; fence?: { lock: string; token: string }; expired?: true }
export interface OpSpec { op: 'incr' | 'push' | 'merge' | 'max' | 'min'; n?: number; min?: number; max?: number; items?: unknown[]; fields?: Record<string, unknown>; x?: number | string }
export interface W { key: Path; value?: unknown; op?: OpSpec; remove?: true; if?: Cond; ttl?: number; while?: 'session' }
export interface Who { peer: string; claims: Record<string, unknown> | null; session: string }
export interface WriteReq {
  res: string; inc: number; p: string; slot: number; a: string; h: string; from: string; who: Who; sv: number
  kind: 'w' | 'claim' | 'touch'
  writes?: W[]
  claim?: { n: number; lease: number; where?: (row: any, t: number) => boolean }
  touch?: { key: string; ttl?: number; lease?: number; if?: Cond }
}
export type Answer =
  | { ok: true; v: string; t: number; ans?: unknown; rows?: { key: string; value: unknown; until: number; deliveries: number }[] }
  | { ok: false; r: Refusal }

interface RowMeta { v: string; born: string; t: number; ttl?: number; td?: number; ses?: string; lease?: number; dl: number; p: string; slot: number }
interface Att { v: string; i: number; h: string; ans: unknown; t: number; slot: number }

const ATTEMPT_HORIZON = 10 * 60_000   // a retry within this of its first send is answered from the table

export class Writer {
  readonly g: Group
  readonly meta: ResMeta
  readonly l2: L2
  readonly rows = source()
  readonly rowMeta = new Map<string, RowMeta>()
  readonly byPart = new Map<string, Set<string>>()
  readonly attempts = new Map<string, Att>()
  readonly fences = new Map<string, string>()
  readonly owned = new Map<number, number>()
  readonly sealed = new Map<string, number>()        // `${slot}:${ep}` → index of the 'out' entry
  readonly sealedState = new Map<number, SlotState>()
  readonly arrived = new Map<string, number>()       // `${slot}:${ep}` → index of the 'in' entry
  readonly bySession = new Map<string, Set<string>>()
  readonly waiters = new Map<number, (() => void)[]>()
  readonly ttl = new Heap<{ t: number; seq: number; key: string }>()
  #ttlSeq = 0
  #ttlTimer = Infinity
  term: number
  lastT = 0
  live = true

  constructor(l2: L2, g: Group, meta: ResMeta) {
    this.l2 = l2; this.g = g; this.meta = meta; this.term = g.term
  }
  get w(): World { return this.l2.w }
  get leader(): Proc { return this.w.proc(this.g.leader!) }

  // ── the fold: one entry into the writer's state ───────────────────────────
  apply(e: Entry): void {
    if (e.t > this.lastT) this.lastT = e.t
    switch (e.k) {
      case 'noop': case 'cfg': return
      case 'out': {
        const state = this.#cutSlot(e.slot)
        this.sealedState.set(e.slot, state)
        this.sealed.set(`${e.slot}:${e.ep}`, e.i)
        this.owned.delete(e.slot)
        for (const [k] of state.rows) this.#forget(k, true)
        for (const [a, att] of this.attempts) if (att.slot === e.slot) this.attempts.delete(a)
        return
      }
      case 'in': {
        const st = e.m!.slot!
        this.owned.set(e.slot, e.ep)
        this.arrived.set(`${e.slot}:${e.ep}`, e.i)
        if (st.rows.length > 0) this.#fold(st.rows.map(([k, v]) => ({ type: 0, key: [k], value: v })))
        for (const [k, m] of st.rowMeta) this.#setMeta(k, { ...m, p: this.l2.k.partitionOf(this.meta, k), slot: e.slot })
        for (const [a, at] of st.attempts) this.attempts.set(a, { ...at, i: 0 })
        for (const [l, tok] of st.fences) if ((this.fences.get(l) ?? '') < tok) this.fences.set(l, tok)
        return
      }
    }
    // 'w' and 'x': rows change (a stream keeps none: only its attempts)
    if (this.meta.opts.rows === false) {
      if (e.a !== undefined) this.attempts.set(e.a, { v: e.v, i: e.i, h: e.h ?? '', ans: e.m?.ans, t: e.t, slot: e.slot })
      return
    }
    const touched = new Set<string>()
    for (const r of e.recs) touched.add(String(r.key[0]))
    if (e.m?.ttl) for (const k of Object.keys(e.m.ttl)) touched.add(k)
    if (e.m?.claims) for (const k of Object.keys(e.m.claims)) touched.add(k)
    const before = new Map<string, boolean>()
    for (const k of touched) before.set(k, hasRow(this.rows, k))
    if (e.recs.length > 0) this.#fold(upcast(this.meta, e))
    for (const k of touched) {
      const exists = hasRow(this.rows, k)
      if (!exists) { this.#forget(k, false); continue }
      const old = this.rowMeta.get(k)
      const reborn = !before.get(k) || (e.m?.born?.includes(k) ?? false)
      const m: RowMeta = reborn || !old
        ? { v: e.v, born: e.v, t: e.t, dl: 0, p: e.p, slot: e.slot }
        : { ...old, v: e.v, t: e.recs.some((r) => String(r.key[0]) === k) ? e.t : old.t }
      if (reborn && old) { m.ttl = undefined; m.lease = undefined; m.ses = undefined }
      const ttl = e.m?.ttl?.[k]
      if (ttl !== undefined) { m.ttl = e.t + ttl; m.td = ttl }
      else if (e.k === 'w' && m.td !== undefined && e.recs.some((r) => String(r.key[0]) === k)) m.ttl = e.t + m.td
      const ses = e.m?.ses?.[k]
      if (ses !== undefined) m.ses = ses
      const c = e.m?.claims?.[k]
      if (c) { m.lease = c[0]; m.dl = c[1] }
      this.#setMeta(k, m)
    }
    if (e.m?.fence) { const [l, tok] = e.m.fence; if ((this.fences.get(l) ?? '') < tok) this.fences.set(l, tok) }
    if (e.a !== undefined) this.attempts.set(e.a, { v: e.v, i: e.i, h: e.h ?? '', ans: e.m?.ans, t: e.t, slot: e.slot })
  }
  #fold(recs: Rec[]): void {
    const bad = fold(this.rows, recs, (err) => this.w.note(`writer-fault ${this.g.id} ${String(err)}`))
    if (bad !== null) this.l2.divergence(`writer ${this.g.id}: data refused a record the writer judged: ${bad}`)
  }
  #setMeta(k: string, m: RowMeta): void {
    const old = this.rowMeta.get(k)
    if (old?.ses !== undefined && old.ses !== m.ses) this.bySession.get(old.ses)?.delete(k)
    this.rowMeta.delete(k)          // re-insert: Map order is order of last write (rows.max evicts the first)
    this.rowMeta.set(k, m)
    let s = this.byPart.get(m.p)
    if (!s) { s = new Set(); this.byPart.set(m.p, s) }
    s.add(k)
    if (m.ses !== undefined) { let b = this.bySession.get(m.ses); if (!b) { b = new Set(); this.bySession.set(m.ses, b) } b.add(k) }
    if (m.ttl !== undefined) this.ttl.push({ t: m.ttl, seq: this.#ttlSeq++, key: k })
  }
  #forget(k: string, alsoRows: boolean): void {
    const m = this.rowMeta.get(k)
    if (!m) return
    this.rowMeta.delete(k)
    this.byPart.get(m.p)?.delete(k)
    if (m.ses !== undefined) this.bySession.get(m.ses)?.delete(k)
    if (alsoRows) this.#fold([{ type: 2, key: [k] }])
  }
  #cutSlot(slot: number): SlotState {
    const rows: [string, unknown][] = [], rowMeta: [string, RowMetaWire][] = [], attempts: [string, AttemptWire][] = []
    for (const [k, m] of this.rowMeta) {
      if (m.slot !== slot) continue
      rows.push([k, rowOf(this.rows, k)])
      rowMeta.push([k, { v: m.v, born: m.born, t: m.t, ttl: m.ttl, ses: m.ses, lease: m.lease, dl: m.dl }])
    }
    for (const [a, at] of this.attempts) if (at.slot === slot) attempts.push([a, { v: at.v, h: at.h, ans: at.ans, t: at.t, slot }])
    return { rows, rowMeta, attempts, fences: [...this.fences] }
  }

  // ── judging ────────────────────────────────────────────────────────────────
  writerTime(): number {
    const skewMax = this.w.keys['skew.max']
    const c = Math.min(Math.max(this.leader.clock(), this.w.time - skewMax), this.w.time + skewMax)
    return Math.max(c, this.lastT, this.g.lastT)
  }
  #cur(key: string, overlay: Map<string, unknown>): unknown {
    return overlay.has(key) ? overlay.get(key) : (hasRow(this.rows, key) ? rowOf(this.rows, key) : undefined)
  }
  #expired(k: string, t: number, overlay: Map<string, unknown>): boolean {
    if (this.#cur(k, overlay) === undefined) return true
    const m = this.rowMeta.get(k)
    return m?.ttl !== undefined && m.ttl <= t
  }
  #cond(c: Cond, key: Path, t: number, overlay: Map<string, unknown>, born: Set<string>): Refusal | null {
    const k = String(key[0])
    const row = this.#cur(k, overlay)
    const m = this.rowMeta.get(k)
    const conflict = (): Refusal => ({ code: 'conflict', current: m?.v })
    if (c.absent && row !== undefined) return conflict()
    if (c.present && row === undefined) return conflict()
    if (c.version !== undefined && (m?.v ?? '') !== c.version) return conflict()
    if (c.expired) { if (!this.#expired(k, t, overlay)) return conflict(); born.add(k) }
    if (c.absent) born.add(k)
    if (c.equals !== undefined && !deepEqual(leafAt(row, key.slice(1)), c.equals)) return conflict()
    if (c.fence) {
      const seen = this.#fenceSeen(c.fence.lock)
      if (c.fence.token < seen) return { code: 'fenced', current: seen }
    }
    return null
  }
  /** the newest token for a lock this writer has seen: fences in its own log, and the #locks row */
  #fenceSeen(lock: string): string {
    const own = this.fences.get(lock) ?? ''
    const fromLocks = this.l2.lockToken(this.leader, lock)
    return fromLocks > own ? fromLocks : own
  }

  /** Judge one request; the answer goes to `reply` once it commits (or at once, if refused). */
  handle(req: WriteReq, reply: (a: Answer) => void): void {
    const refuse = (r: Refusal): void => reply({ ok: false, r })
    if (!this.live || this.g.leader === null || this.g.term !== this.term || this.w.time < this.g.downUntil) return refuse({ code: 'no-writer' })
    if (req.inc !== this.meta.inc) return refuse({ code: 'unknown-log', reason: 'the resource was re-created' })
    if (!this.owned.has(req.slot)) {
      const ep = this.meta.epochs[req.slot]
      return refuse({ code: this.sealed.has(`${req.slot}:${ep}`) || [...this.sealed.keys()].some((s) => s.startsWith(`${req.slot}:`)) ? 'moved' : 'wrong-group' })
    }
    // 1. dedup
    const seen = this.attempts.get(req.a)
    if (seen) {
      this.l2.stats.dedup++
      if (seen.i > this.g.commit) this.l2.stats.dedupTail++
      // the attempt may still sit in the uncommitted tail: say so only once it has committed (bug fix, E-22 step 3)
      if (seen.h !== req.h) {
        const div = (): void => refuse({ code: 'call-diverged', reason: 'a re-run wrote something different under the same attempt' })
        if (seen.i === 0 || seen.i <= this.g.commit) div(); else this.#onCommit(seen.i, div)
        return
      }
      const answer = (): void => reply({ ok: true, v: seen.v, t: seen.t, ans: seen.ans, rows: (seen.ans as any)?.rows })
      if (seen.i === 0 || seen.i <= this.g.commit) answer(); else this.#onCommit(seen.i, answer)
      return
    }
    if (this.meta.gate !== null) return refuse({ code: 'read-only', reason: this.meta.gate })
    const t = this.writerTime()
    const opts = this.meta.opts
    if (req.kind === 'claim' || req.kind === 'touch' || req.writes?.some((x) => x.op || x.if)) {
      if (opts.rows === false) return refuse({ code: 'no-rows' })
    }
    let built: { entries: NewEntry[]; ans?: unknown } | Refusal
    try {
      built = req.kind === 'w' ? this.#judgeWrites(req, t) : req.kind === 'claim' ? this.#judgeClaim(req, t) : this.#judgeTouch(req, t)
    } catch (e) {
      built = { code: 'rule-threw', reason: String((e as Error)?.message ?? e) }
    }
    // a refusal, or a claim that finds nothing, was judged against the log end, which may hold
    // entries not committed yet: answer only once they have committed, so the answer is
    // linearizable. If this writer is deposed first, the waiter never runs and the client's resend
    // is judged anew (bug fix, E-22 step 3: Porcupine on lin-kv calm seed 77, a 'conflict' answered
    // from an uncommitted incr; verify/phantom.check.ts, a refusal caused by a write that was lost)
    const end = this.g.last
    const settled = (f: () => void): void => { if (end <= this.g.commit) f(); else this.#onCommit(end, f) }
    if ('code' in built) { const r = built; settled(() => refuse(r)); return }
    if (built.entries.length === 0) {               // an empty claim writes nothing ('empty')
      const ans = built.ans
      settled(() => reply({ ok: true, v: '', t, ans, rows: [] }))
      return
    }
    const r = this.l2.k.append(this.g, this.g.leader, this.term, built.entries)
    if (typeof r === 'string') return refuse({ code: r })
    for (const e of r) this.apply(e)
    const main = r[0]
    const answer = (): void => reply({ ok: true, v: main.v, t: main.t, ans: main.m?.ans, rows: (main.m?.ans as any)?.rows })
    // durability 'none' commits inside append, before this line: answer at once
    if (main.i <= this.g.commit) answer(); else this.#onCommit(main.i, answer)
    this.#afterWrite(r)
  }

  #judgeWrites(req: WriteReq, t: number): { entries: NewEntry[]; ans?: unknown } | Refusal {
    const opts = this.meta.opts, code = this.meta.code
    const recs: Rec[] = []
    const overlay = new Map<string, unknown>()
    const born = new Set<string>()
    const m: NonNullable<Entry['m']> = {}
    const answers: unknown[] = []
    for (const wr of req.writes!) {
      const key = wr.key, k = String(key[0])
      if (opts.rows === false) {
        // a stream: the record is logged and delivered; no row is kept, so nothing to judge but validation
        const rec: Rec = { type: 0, key: key as any, value: wr.value }
        const why = this.#userChecks(rec, req.who, undefined)
        if (why) return why
        recs.push(rec)
        continue
      }
      const row = this.#cur(k, overlay)
      // 2. shape checks
      if (key.length > 1 && row === undefined && !wr.remove) return { code: 'absent-row' }
      if (key.length > 2 && !wr.remove) {
        const parent = leafAt(row, key.slice(1, -1))
        if (parent === null || typeof parent !== 'object') return { code: 'absent-path' }
      }
      if (wr.remove && key.length > 1) {
        const parent = leafAt(row, key.slice(1, -1))
        if (Array.isArray(parent) && Object.hasOwn(parent, String(key[key.length - 1]))) return { code: 'sparse-hole' }
      }
      // 4 before 5 needs the condition first? No: API order is checks, then conditions, then ops;
      // an op's value is needed for validation, so ops are computed first and judged after.
      let value: unknown = wr.value
      if (wr.op) {
        const cur = leafAt(row, key.slice(1))
        const r = computeOp(cur, wr.op)
        if ('code' in r) return { ...r, current: this.rowMeta.get(k)?.v }
        value = r.value
        answers.push(value)
      } else answers.push(undefined)
      const rec: Rec = wr.remove ? { type: 2, key: key as any } : { type: 0, key: key as any, value }
      // 3. validation, schema, rules.write
      const after = applyPlain(row, rec)
      const why = this.#userChecks(rec, req.who, row, after)
      if (why) return why
      // 4. conditions
      if (wr.if) { const c = this.#cond(wr.if, key, t, overlay, born); if (c) return c; if (wr.if.fence) m.fence = [wr.if.fence.lock, wr.if.fence.token] }
      recs.push(rec)
      overlay.set(k, after)
      // ttl and session binding
      const ttl = wr.ttl ?? (opts.rows?.ttl !== undefined ? msOf(opts.rows.ttl) : undefined)
      if (ttl !== undefined && !wr.remove) (m.ttl ??= {})[k] = ttl
      if ((wr.while === 'session' || opts.rows?.while === 'session') && !wr.remove) (m.ses ??= {})[k] = req.who.session
    }
    if (born.size > 0) m.born = [...born]
    m.ans = req.writes!.length === 1 ? answers[0] : answers
    void code
    return { entries: [{ k: 'w', slot: req.slot, ep: this.owned.get(req.slot)!, p: req.p, t, a: req.a, h: req.h, recs, m, sv: req.sv }] }
  }
  #userChecks(rec: Rec, who: Who, before: unknown, after?: unknown): Refusal | null {
    const code = this.meta.code
    if (code.validation) {
      const r = code.validation(toDataRec(rec))
      if (r !== true) return { code: 'invalid', reason: String(r) }
    }
    if (code.schema && rec.type !== 2 && after !== undefined) {
      const res = code.schema['~standard'].validate(after)
      if (res && typeof (res as any).then === 'function') return { code: 'schema', reason: 'an async schema cannot run at the writer' }
      if (res.issues) return { code: 'schema', reason: res.issues[0]?.message, path: res.issues[0]?.path }
    }
    if (code.rules?.write) {
      const r = code.rules.write(who, toDataRec(rec), before)
      if (r !== true) return { code: 'rule', reason: String(r) }
    }
    return null
  }
  #judgeClaim(req: WriteReq, t: number): { entries: NewEntry[]; ans?: unknown } | Refusal {
    const { n, lease, where } = req.claim!
    const keys = this.byPart.get(req.p)
    const claims: Record<string, [number, number]> = {}
    const rows: { key: string; value: unknown; until: number; deliveries: number }[] = []
    if (keys) for (const k of keys) {
      if (rows.length >= n) break
      const m = this.rowMeta.get(k)!
      if (m.lease !== undefined && m.lease > t) continue
      if (m.ttl !== undefined && m.ttl <= t) continue
      const row = rowOf(this.rows, k)
      if (where && !where(row, t)) continue
      claims[k] = [t + lease, m.dl + 1]
      rows.push({ key: k, value: row, until: t + lease, deliveries: m.dl + 1 })
    }
    if (rows.length === 0) return { entries: [], ans: { rows: [] } }
    return { entries: [{ k: 'w', slot: req.slot, ep: this.owned.get(req.slot)!, p: req.p, t, a: req.a, h: req.h, recs: [], m: { claims, ans: { rows } }, sv: req.sv }] }
  }
  #judgeTouch(req: WriteReq, t: number): { entries: NewEntry[]; ans?: unknown } | Refusal {
    const { key, ttl, lease, if: cond } = req.touch!
    const m = this.rowMeta.get(key)
    if (!m || !hasRow(this.rows, key)) return { code: 'absent-row' }
    if (cond) { const c = this.#cond(cond, [key], t, new Map(), new Set()); if (c) return c }
    const meta: NonNullable<Entry['m']> = {}
    const d = ttl ?? m.td ?? (this.meta.opts.rows?.ttl !== undefined ? msOf(this.meta.opts.rows.ttl) : undefined)
    if (d !== undefined) meta.ttl = { [key]: d }
    if (lease !== undefined) meta.claims = { [key]: [t + lease, m.dl] }
    return { entries: [{ k: 'w', slot: req.slot, ep: this.owned.get(req.slot)!, p: req.p, t, a: req.a, h: req.h, recs: [], m: meta, sv: req.sv }] }
  }

  /** after an append: rows.max and rows.where removals, and the ttl timer */
  #afterWrite(entries: Entry[]): void {
    const opts = this.meta.opts
    const x: NewEntry[] = []
    const t = this.writerTime()
    if (opts.rows?.where) {
      for (const e of entries) for (const r of e.recs) {
        const k = String(r.key[0])
        if (!hasRow(this.rows, k)) continue
        if (!opts.rows.where(rowOf(this.rows, k))) x.push(this.#removal(k, 'where', t))
      }
    }
    if (opts.rows?.max !== undefined) {
      const share = Math.ceil((opts.rows.max * this.owned.size) / SLOTS)
      let over = this.rowMeta.size - share - x.length
      for (const k of this.rowMeta.keys()) { if (over-- <= 0) break; x.push(this.#removal(k, 'max', t)) }
    }
    if (x.length > 0) this.#appendSystem(x)
    this.#armTtl()
  }
  #removal(k: string, why: Entry['why'], t: number): NewEntry {
    const m = this.rowMeta.get(k)!
    return { k: 'x', slot: m.slot, ep: this.owned.get(m.slot) ?? 0, p: m.p, t, recs: [{ type: 2, key: [k] }], why }
  }
  #appendSystem(x: NewEntry[]): void {
    const r = this.l2.k.append(this.g, this.g.leader!, this.term, x)
    if (typeof r === 'string') return
    for (const e of r) this.apply(e)
  }
  #armTtl(): void {
    const top = this.ttl.peek()
    if (!top || top.t >= this.#ttlTimer) return
    this.#ttlTimer = top.t
    const at = top.t
    // the deadline is writer time and the timer runs on world time: wait out the writer clock's lag
    // behind the world (bug fix, E-22 step 2: with a writer clock behind world time, inside skew.max,
    // the timer re-armed at the same instant forever and the world never moved on)
    const lag = this.g.leader !== null ? Math.max(0, this.w.time - this.writerTime()) : 0
    const when = Math.max(at + lag, this.w.time + 0.001)
    this.w.at(when, this.leader, `ttl ${this.g.id}`, () => {
      if (this.#ttlTimer === at) this.#ttlTimer = Infinity
      if (!this.live) return
      this.expire()
    }, true)
  }
  /** remove every row whose ttl has passed by writer time: work grows with what expires */
  expire(): void {
    const t = this.writerTime()
    const x: NewEntry[] = []
    const done = new Set<string>()
    while (this.ttl.size > 0 && this.ttl.peek()!.t <= t) {
      const { t: dl, key } = this.ttl.pop()!
      const m = this.rowMeta.get(key)
      if (!m || m.ttl !== dl || done.has(key)) continue          // stale heap entry: rewritten or gone
      done.add(key)
      x.push(this.#removal(key, 'ttl', t))
    }
    if (x.length > 0) this.#appendSystem(x)
    this.#armTtl()
  }
  /** A new writer gives every lease row (a #sessions or #locks row with a ttl) at least one election
   *  window to be renewed, as etcd's lessor extends leases on promotion: a renewal that could not
   *  reach any writer during the election must not lapse a live session or lock (bug fix, E-22
   *  step 2: a 5 s pause plus a #sessions failover lapsed a live session; P-13 forbids it). The
   *  extension is this writer's own state, not logged: the next writer extends again at its start. */
  extendLeases(by: number): void {
    const until = this.writerTime() + by
    for (const [k, m] of this.rowMeta) if (m.ttl !== undefined && m.ttl < until) { m.ttl = until; this.ttl.push({ t: until, seq: this.#ttlSeq++, key: k }) }
  }
  /** a session lapsed: remove the rows bound to it */
  sessionGone(session: string): void {
    const keys = this.bySession.get(session)
    if (!keys || keys.size === 0 || !this.live) return
    const t = this.writerTime()
    this.#appendSystem([...keys].map((k) => this.#removal(k, 'session', t)))
  }

  #onCommit(i: number, fn: () => void): void {
    let ws = this.waiters.get(i)
    if (!ws) { ws = []; this.waiters.set(i, ws) }
    ws.push(fn)
  }
  committed(prev: number, to: number): void {
    for (let i = prev + 1; i <= to; i++) {
      const ws = this.waiters.get(i)
      if (ws) { this.waiters.delete(i); for (const f of ws) f() }
    }
    // drop attempts past the horizon (by writer time)
    if (this.attempts.size > 4096) {
      const cut = this.lastT - ATTEMPT_HORIZON
      for (const [a, at] of this.attempts) if (at.t < cut) this.attempts.delete(a)
    }
  }

  /** the state as a plain object (the snapshot op's payload) */
  dump(): unknown {
    return {
      owned: [...this.owned], sealed: [...this.sealed], arrived: [...this.arrived], sealedState: [...this.sealedState],
      rows: keysOf(this.rows).map((k) => [k, rowOf(this.rows, k)]),
      rowMeta: [...this.rowMeta], attempts: [...this.attempts], fences: [...this.fences], lastT: this.lastT,
    }
  }
  load(s: any): void {
    for (const [sl, ep] of s.owned) this.owned.set(sl, ep)
    for (const [k, v] of s.sealed) this.sealed.set(k, v)
    for (const [k, v] of s.arrived) this.arrived.set(k, v)
    for (const [k, v] of s.sealedState) this.sealedState.set(k, v)
    if (s.rows.length > 0) this.#fold(s.rows.map(([k, v]: [string, unknown]) => ({ type: 0, key: [k], value: v })))
    for (const [k, m] of s.rowMeta) this.#setMeta(k, m)
    for (const [a, at] of s.attempts) this.attempts.set(a, { ...at, i: 0 })
    for (const [l, tok] of s.fences) this.fences.set(l, tok)
    this.lastT = s.lastT
  }
}

export class L2 {
  readonly w: World
  readonly k: Kernel
  readonly writers = new Map<string, Writer>()
  readonly divergences: string[] = []
  /** counters for checks: retries answered from the attempt table (dedup), of which still in the tail */
  readonly stats = { dedup: 0, dedupTail: 0 }
  /** the #locks row's token as `proc` sees it (L3 fills this in: writers follow #locks) */
  lockToken: (p: Proc, lock: string) => string = () => ''
  constructor(w: World, k: Kernel) {
    this.w = w; this.k = k
    k.hooks.lead.push((g) => this.#lead(g))
    k.hooks.depose.push((g) => this.#depose(g))
    k.hooks.commit.push((g, prev, to) => this.writers.get(g.id)?.committed(prev, to))
    k.hooks.snapshotter = (g) => this.#replay(g, g.commit).dump()
    k.hooks.usedSlots = (meta) => {
      const s = new Set<number>()
      for (const g of meta.groups) { const wr = this.writers.get(g.id); if (wr) for (const m of wr.rowMeta.values()) s.add(m.slot) }
      return [...s].sort((a, b) => a - b)
    }
    k.hooks.mover = {
      sealed: (A, slot, ep) => this.writers.get(A.id)?.sealed.get(`${slot}:${ep}`) ?? null,
      seal: (A, slot, ep) => {
        const wr = this.writers.get(A.id)
        if (!wr || !wr.live || wr.owned.get(slot) !== ep) return
        const r = this.k.append(A, A.leader!, wr.term, [{ k: 'out', slot, ep, p: '', t: wr.writerTime(), recs: [] }])
        if (typeof r !== 'string') for (const e of r) wr.apply(e)
      },
      slotState: (A, slot) => this.writers.get(A.id)?.sealedState.get(slot) ?? null,
      arrived: (B, slot, ep) => this.writers.get(B.id)?.arrived.get(`${slot}:${ep}`) ?? null,
      admit: (B, slot, ep, state) => {
        const wr = this.writers.get(B.id)
        if (!wr || !wr.live) return
        const r = this.k.append(B, B.leader!, wr.term, [{ k: 'in', slot, ep, p: '', t: wr.writerTime(), recs: [], m: { slot: state } }])
        if (typeof r !== 'string') for (const e of r) wr.apply(e)
        // the arriving rows' ttls need this writer's timer (bug fix, E-22 step 2: they waited for
        // the group's next write, so a moved row with a ttl and no later write never expired)
        if (typeof r !== 'string') wr.expire()
      },
    }
  }
  divergence(msg: string): void { this.divergences.push(msg); this.w.note(`DIVERGENCE ${msg}`) }

  /** a fresh writer state for g, folded from its snapshot and log up to `to` (read, op 2) */
  #replay(g: Group, to: number): Writer {
    const meta = this.k.meta(g.res)!
    const wr = new Writer(this, g, meta)
    wr.live = false
    if (g.snap && g.snap.state && g.base > 0) wr.load(g.snap.state)
    else for (let s = 0; s < SLOTS; s++) if (Math.floor((s * meta.groups.length) / SLOTS) === g.n) wr.owned.set(s, 0)
    const es = this.k.read(g, g.base, to, { tail: true })
    if (es !== 'expired') for (const e of es) wr.apply(e)
    return wr
  }
  #lead(g: Group): void {
    const meta = this.k.meta(g.res)
    if (!meta) return
    // the new leader's state: its snapshot, then every entry it holds, the surviving tail included
    const wr = this.#replay(g, g.last)
    wr.live = true
    wr.term = g.term
    this.writers.set(g.id, wr)
    this.w.note(`writer ${g.id} @${g.leader} t${g.term} rows ${wr.rowMeta.size}`)
    if (g.res === '#sessions' || g.res === '#locks') wr.extendLeases(this.w.keys['election.ms'])
    // a writer that takes over finishes what the old one left: due ttls, lapsed sessions
    this.w.after(0, this.w.proc(g.leader!), `writer-start ${g.id}`, () => {
      if (!wr.live) return
      wr.expire()
      for (const s of wr.bySession.keys()) if (this.sessionLapsed?.(s)) wr.sessionGone(s)
    }, true)
  }
  #depose(g: Group): void {
    const wr = this.writers.get(g.id)
    if (wr) { wr.live = false; this.writers.delete(g.id) }
  }
  /** set by L4's session keeper: whether a session is known to have lapsed */
  sessionLapsed: ((session: string) => boolean) | null = null
  /** every writer drops the rows bound to a lapsed session (writers follow #sessions) */
  sessionGone(session: string): void { for (const wr of this.writers.values()) wr.sessionGone(session) }

  /** route a request to the writer of its group, as the leader process receives it */
  receive(req: WriteReq, g: Group, reply: (a: Answer) => void): void {
    const wr = this.writers.get(g.id)
    if (!wr) { reply({ ok: false, r: { code: 'no-writer' } }); return }
    wr.handle(req, reply)
  }
}

/** records written under an older shape.version pass the upcasters in order (P-20), on every
 *  path: the writer's fold, every replica's fold, every reader */
export const upcast = (meta: ResMeta, e: Entry): Rec[] => {
  const want = meta.opts.shape?.version ?? 1
  const up = meta.code.up as Record<number, (r: any) => any> | undefined
  if (!up || (e.sv ?? want) >= want) return e.recs
  return upcastRecs(up, e.recs, e.sv ?? 1, want)
}
export const upcastRecs = (up: Record<number, (r: any) => any>, recs: Rec[], from: number, to: number): Rec[] => {
  for (let v = from; v < to; v++) {
    const f = up[v]
    if (!f) continue
    const next: Rec[] = []
    for (const r of recs) {
      const o = f({ type: r.type === 0 ? 'update' : r.type === 1 ? 'insert' : 'remove', key: r.key, ...(r.type === 2 ? {} : { value: r.value }) })
      if (o === null) continue
      for (const x of Array.isArray(o) ? o : [o]) next.push({ type: x.type === 'update' ? 0 : x.type === 'insert' ? 1 : 2, key: x.key, ...(x.type === 'remove' ? {} : { value: wireCopy(x.value) }) } as Rec)
    }
    recs = next
  }
  return recs
}
/** at a shape bump, the rows a fold already holds pass the upcasters as whole-row updates, so the
 *  live state equals a rebuild from the log (see API-NOTES) */
export const upcastHeld = (src: any, up: Record<number, (r: any) => any>, from: number, to: number, fault: (e: unknown) => void): void => {
  const recs: Rec[] = []
  for (const k of keysOf(src)) recs.push(...upcastRecs(up, [{ type: 0, key: [k], value: rowOf(src, k) }], from, to))
  if (recs.length > 0) fold(src, recs, fault)
}

// ── helpers ─────────────────────────────────────────────────────────────────
const msOf = (d: number | string): number => (typeof d === 'number' ? d : msDur(d))
const msDur = (d: string): number => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(d)!
  return Number(m[1]) * ({ ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 } as Record<string, number>)[m[2]]
}
export const leafAt = (v: unknown, path: readonly (string | number)[]): unknown => {
  let x: any = v
  for (const p of path) { if (x === null || typeof x !== 'object') return undefined; x = x[p as any] }
  return x
}
/** a record applied to a plain row (for the schema check and a batch's later writes only; the
 *  writer's real state folds through data) */
export const applyPlain = (row: unknown, r: Rec): unknown => {
  if (r.key.length === 1) return r.type === 2 ? undefined : r.value
  const set = (x: any, path: readonly (string | number)[]): any => {
    const [h, ...rest] = path
    const base = Array.isArray(x) ? [...x] : { ...(x ?? {}) }
    if (rest.length === 0) { if (r.type === 2) delete base[h as any]; else base[h as any] = r.value; return base }
    base[h as any] = set(x?.[h as any], rest)
    return base
  }
  return set(row, r.key.slice(1))
}
const toDataRec = (r: Rec): { type: 'update' | 'insert' | 'remove'; key: (string | number)[]; value?: unknown } =>
  ({ type: r.type === 0 ? 'update' : r.type === 1 ? 'insert' : 'remove', key: r.key, ...(r.type === 2 ? {} : { value: r.value }) })

export const computeOp = (cur: unknown, s: OpSpec): { value: unknown } | Refusal => {
  switch (s.op) {
    case 'incr': {
      if (cur !== undefined && typeof cur !== 'number') return { code: 'conflict', reason: 'incr on a value that is not a number' }
      const next = ((cur as number | undefined) ?? 0) + s.n!
      if (s.min !== undefined && next < s.min) return { code: 'conflict', reason: `below min ${s.min}` }
      if (s.max !== undefined && next > s.max) return { code: 'conflict', reason: `above max ${s.max}` }
      return { value: next }
    }
    case 'push': {
      if (cur !== undefined && !Array.isArray(cur)) return { code: 'conflict', reason: 'push on a value that is not an array' }
      return { value: wireCopy([...((cur as unknown[]) ?? []), ...s.items!]) }
    }
    case 'merge': {
      if (cur !== undefined && (cur === null || typeof cur !== 'object' || Array.isArray(cur))) return { code: 'conflict', reason: 'merge on a value that is not an object' }
      return { value: wireCopy({ ...((cur as object) ?? {}), ...s.fields }) }
    }
    case 'max': return { value: cur === undefined || (s.x as any) > (cur as any) ? s.x : cur }
    case 'min': return { value: cur === undefined || (s.x as any) < (cur as any) ? s.x : cur }
  }
}
