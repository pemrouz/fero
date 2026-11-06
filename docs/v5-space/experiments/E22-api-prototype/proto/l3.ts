// l3 — flow: each process's replica of a resource folds the committed entries it learns of through
// the data seam; log readers walk the same entries from a cursor; follows hold a picture of chosen
// partitions; a near cache holds only what it reads. One Feed orders entries for all of them: per
// group in log order, and per slot across a move (an entry of a slot's new epoch waits until the
// old group's 'out' entry for it has passed), so each partition's order holds across groups.
// Under a world with `shuffle`, deliveries of different partitions interleave in a seeded order
// that keeps each partition's own order (TEST-12).

import { SLOTS, type Entry, type Group, type Kernel, type Rec, type ResMeta } from './kernel.ts'
import type { World, Proc } from './world.ts'
import { FeroError } from './errors.ts'
import { source, fold, batch, rowOf, hasRow, keysOf, lens, type LensHooks } from './seam.ts'
import { ZERO_VERSION, deepEqual, sizeOf, verIndex } from './util.ts'
import { upcast as upcastEntry } from './l2.ts'

// ── the feed ────────────────────────────────────────────────────────────────
export interface CursorState { r: string; i: number; p: number[]; s: number[]; e: [number, number][] }
export class Feed {
  readonly meta: ResMeta
  pos: number[]
  sub: number[]
  ep: Int32Array
  constructor(meta: ResMeta, pos?: number[], ep?: Int32Array, sub?: number[]) {
    this.meta = meta
    this.pos = pos ?? meta.groups.map((g) => g.base)
    this.sub = sub ?? meta.groups.map(() => 0)
    this.ep = ep ?? new Int32Array(SLOTS)
  }
  clone(): Feed { return new Feed(this.meta, [...this.pos], new Int32Array(this.ep), [...this.sub]) }
  /** Walk committed entries up to `known` per group, handing each deliverable one to `take`.
   *  Returns 'expired' (with the group) if a position fell below a group's kept history. */
  pull(k: Kernel, known: readonly number[], take: (e: Entry, g: Group) => void, order?: number[]): { expired: number } | null {
    let progress = true
    while (progress) {
      progress = false
      for (const n of order ?? this.meta.groups.map((_, i) => i)) {
        const g = this.meta.groups[n]
        const es = k.read(g, this.pos[n], known[n] ?? 0)
        if (es === 'expired') return { expired: n }
        for (const e of es) {
          if (e.slot >= 0) {
            const at = this.ep[e.slot]
            if (e.k === 'out') { if (e.ep === at) { this.ep = new Int32Array(this.ep); this.ep[e.slot] = at + 1 } }
            else if (e.ep > at) break            // a newer epoch of this slot: wait for its old group's 'out'
          }
          this.pos[n] = e.i
          this.sub[n] = 0
          progress = true
          if (e.k === 'w' || e.k === 'x') take(e, g)
        }
      }
    }
    return null
  }
  encode(): string { return Feed.encodeState(this.meta, this.pos, this.sub, this.ep) }
  static encodeState(meta: ResMeta, pos: readonly number[], sub: readonly number[], ep: Int32Array): string {
    const e: [number, number][] = []
    for (let s = 0; s < SLOTS; s++) if (ep[s] !== 0) e.push([s, ep[s]])
    const c: CursorState = { r: meta.name, i: meta.inc, p: [...pos], s: [...sub], e }
    return Buffer.from(JSON.stringify(c)).toString('base64url')
  }
  static decode(meta: ResMeta, cursor: string): Feed {
    let c: CursorState
    try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { throw new FeroError('unknown-log', { resource: meta.name, message: 'not a cursor' }) }
    if (c.r !== meta.name || c.i !== meta.inc) throw new FeroError('unknown-log', { resource: meta.name })
    const ep = new Int32Array(SLOTS)
    for (const [s, v] of c.e) ep[s] = v
    return new Feed(meta, c.p, ep, c.s)
  }
}

// ── one process's replica of one resource ───────────────────────────────────
export class Replica {
  readonly l3: L3
  readonly proc: Proc
  readonly meta: ResMeta
  readonly src = source()
  /** null: holds every partition; else the near cache's held partitions, in least-recently-read order */
  held: Map<string, { bytes: number; pins: number }> | null
  limit = Infinity
  readonly feed: Feed
  readonly known: number[]
  readonly pVer = new Map<string, string>()
  readonly rowVer = new Map<string, string>()
  readonly rowBorn = new Map<string, string>()
  /** the newest born version each row key has had, kept after the row goes: writers judge fences
   *  against it (bug fix, E-22 step 2: a released or expired lock row took its token with it, so a
   *  stale token passed on any row the newer holder had not written) */
  readonly bornMax = new Map<string, string>()
  #born(k: string, v: string): void { this.rowBorn.set(k, v); if ((this.bornMax.get(k) ?? '') < v) this.bornMax.set(k, v) }
  readonly partRows = new Map<string, Set<string>>()
  readonly waiters = new Map<string, { v: string; fn: () => void }[]>()
  readonly follows = new Set<FollowImpl>()
  readonly readers = new Set<ReaderImpl>()
  readonly onEntry = new Set<(e: Entry) => void>()
  /** shuffle: the time after which each partition's next entry may apply */
  readonly #busy = new Map<string, number>()
  #holding = new Map<string, { v: string; buf: Entry[] }>()
  bytes = 0
  /** entries taken by the feed but not yet applied (the shuffle delays them) */
  inflight = 0

  constructor(l3: L3, proc: Proc, meta: ResMeta, cache: number | null) {
    this.l3 = l3; this.proc = proc; this.meta = meta
    this.held = cache === null ? null : new Map()
    if (cache !== null) this.limit = cache
    this.feed = new Feed(meta)
    this.known = meta.groups.map((g) => g.commit)
    meta.folders.add(proc)
    // the first picture lands whole (a snapshot, not deltas), so the shuffle does not delay it
    this.#catchingUp = true
    this.pull()
    this.#catchingUp = false
  }
  #catchingUp = false
  get w(): World { return this.l3.w }
  holds(p: string): boolean { return this.held === null || this.held.has(p) }
  get whole(): boolean { return this.held === null }
  /** this process learned that group n committed up to `to` */
  notice(n: number, to: number): void {
    if (to <= (this.known[n] ?? 0)) return
    this.known[n] = to
    this.pull()
  }
  pull(): void {
    const order = this.w.shuffle ? this.#order() : undefined
    const r = this.feed.pull(this.l3.k, this.known, (e) => this.#take(e), order)
    if (r) this.#install(r.expired)
    for (const rd of this.readers) rd.poke()
  }
  #order(): number[] {
    const xs = this.meta.groups.map((_, i) => i)
    for (let i = xs.length - 1; i > 0; i--) { const j = this.w.shuffleRng.int(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]] }
    return xs
  }
  /** fell behind the kept history: take the group's snapshot rows, then go on from its index */
  #install(n: number): void {
    const g = this.meta.groups[n]
    const st = g.snap?.state as any
    if (st?.rows) this.#applyRecs(st.rows.map(([k, v]: [string, unknown]) => ({ type: 0, key: [k], value: v })), '', ZERO_VERSION)
    this.feed.pos[n] = g.base
    this.pull()
  }
  #take(e: Entry): void {
    if (this.#holding.size > 0) { const h = this.#holding.get(e.p); if (h) h.buf.push(e) }
    for (const x of this.#selWait) if (x.sel(e.p)) x.buf.push(e)
    // a new partition under a held selector (a prefix or share follow) is held from its first entry
    if (!this.holds(e.p) && this.held !== null && this.#sels.some((f) => f(e.p))) this.held.set(e.p, { bytes: 0, pins: 1 })
    if (!this.holds(e.p)) return
    if (!this.w.shuffle || this.#catchingUp) { this.#apply(e); return }
    // shuffle: each partition's entries wait a seeded 0-2 ms, in order; partitions interleave
    const at = Math.max(this.w.time + this.w.shuffleRng.range(0, 2), this.#busy.get(e.p) ?? 0)
    this.#busy.set(e.p, at)
    this.inflight++
    this.w.at(at, this.proc, `fold ${this.meta.name} ${e.p}@${e.v}`, () => { this.inflight--; this.#apply(e) })
  }
  #apply(e: Entry): void {
    if (!this.holds(e.p)) return
    if ((this.pVer.get(e.p) ?? '') >= e.v) return
    const recs = this.l3.upcast(this.meta, e)
    this.#applyRecs(recs, e.p, e.v, e)
  }
  #applyRecs(recs: Rec[], p: string, v: string, e?: Entry): void {
    const rowsKept = this.meta.opts.rows !== false
    if (rowsKept && recs.length > 0) {
      const before = new Map<string, boolean>()
      for (const r of recs) { const k = String(r.key[0]); if (!before.has(k)) before.set(k, hasRow(this.src, k)) }
      let bad: string | null = null
      batch(() => { bad = fold(this.src, recs, (err) => this.l3.fault(this.proc, err)) })
      if (bad !== null) this.l3.k.hooks && this.l3.divergence(`fold ${this.proc.id} ${this.meta.name}: ${bad}`)
      for (const [k, was] of before) {
        const now = hasRow(this.src, k)
        const pp = p || this.l3.k.partitionOf(this.meta, k)
        if (now) {
          this.rowVer.set(k, v)
          if (!was || e?.m?.born?.includes(k)) this.#born(k, v)
          let s = this.partRows.get(pp); if (!s) { s = new Set(); this.partRows.set(pp, s) } s.add(k)
        } else {
          this.rowVer.delete(k); this.rowBorn.delete(k); this.partRows.get(pp)?.delete(k)
        }
      }
    }
    if (e) {
      for (const k of Object.keys(e.m?.claims ?? {})) this.rowVer.set(k, v)
      for (const k of Object.keys(e.m?.ttl ?? {})) if (hasRow(this.src, k)) this.rowVer.set(k, v)
      for (const k of e.m?.born ?? []) if (hasRow(this.src, k)) this.#born(k, v)
    }
    if (p !== '') {
      this.pVer.set(p, v)
      const ws = this.waiters.get(p)
      if (ws) {
        const keep = ws.filter((x) => x.v > v)
        for (const x of ws) if (x.v <= v) x.fn()
        if (keep.length > 0) this.waiters.set(p, keep); else this.waiters.delete(p)
      }
      if (this.held !== null) this.#account(p)
    }
    if (e) {
      for (const f of this.follows) if (f.sel(p)) f.apply(recs)
      for (const fn of this.onEntry) fn(e)
    }
  }
  /** resolve `fn` once this replica has applied partition p up to version v (read-your-writes) */
  waitFor(p: string, v: string, fn: () => void): void {
    if (!this.holds(p) || (this.pVer.get(p) ?? '') >= v || v === '') { fn(); return }
    let ws = this.waiters.get(p); if (!ws) { ws = []; this.waiters.set(p, ws) } ws.push({ v, fn })
  }
  /** a server's answer for a partition: its rows, the version they stand at */
  serve(p: string): { rows: [string, unknown][]; v: string } {
    const keys = this.partRows.get(p) ?? new Set()
    return { rows: [...keys].map((k) => [k, rowOf(this.src, k)]), v: this.pVer.get(p) ?? ZERO_VERSION }
  }

  // ── the near cache: hold a partition from a server's answer, then its deltas ──
  /** begin buffering p's entries, before asking a server for it */
  expect(p: string): void { if (!this.holds(p) && !this.#holding.has(p)) this.#holding.set(p, { v: '', buf: [] }) }
  /** the server answered p at version v: hold it, apply what came after (no gap, no overlap) */
  hold(p: string, rows: [string, unknown][], v: string): void {
    if (this.holds(p)) return
    const h = this.#holding.get(p)
    this.#holding.delete(p)
    this.held!.set(p, { bytes: 0, pins: 0 })
    this.#applyRecs(rows.map(([k, val]) => ({ type: 0, key: [k], value: val })), p, v)
    // entries the feed passed while we asked: those newer than the answer apply now, in order
    for (const e of h?.buf ?? []) if (e.v > v) this.#apply(e)
    // and anything committed that the feed had passed before we began buffering
    const n = this.meta.table[this.l3.k.slotOf(p)]
    const g = this.meta.groups[n]
    const from = Math.max(g.base, verIndex(v))
    const es = this.l3.k.read(g, from, this.feed.pos[n])
    if (es !== 'expired') for (const e of es) if (e.p === p && e.v > (this.pVer.get(p) ?? '') && (e.k === 'w' || e.k === 'x')) this.#apply(e)
    this.#evict()
  }
  // ── a near cache's prefix or share follow (bug fix, E-22 step 2: a near cache held only the
  //    partitions it fetched one by one, so `follow({ prefix })` there held nothing and dropped
  //    every delta). It buffers the selector's entries, asks a server for every matching partition,
  //    holds each (pinned) with what came after, then holds new matching partitions as they appear.
  readonly #sels: ((p: string) => boolean)[] = []
  #selWait: { sel: (p: string) => boolean; buf: Entry[] }[] = []
  expectSel(sel: (p: string) => boolean): void { this.#selWait.push({ sel, buf: [] }) }
  holdSel(sel: (p: string) => boolean, ans: [string, { rows: [string, unknown][]; v: string }][]): void {
    const i = this.#selWait.findIndex((x) => x.sel === sel)
    const buf = i >= 0 ? this.#selWait.splice(i, 1)[0].buf : []
    const byP = new Map<string, Entry[]>()
    for (const e of buf) { let xs = byP.get(e.p); if (!xs) { xs = []; byP.set(e.p, xs) } xs.push(e) }
    const take = (p: string, rows: [string, unknown][], v: string): void => {
      if (this.holds(p)) { this.pin(p, 1); return }
      this.#holding.set(p, { v: '', buf: byP.get(p) ?? [] })
      this.hold(p, rows, v)
      this.pin(p, 1)
    }
    for (const [p, a] of ans) { take(p, a.rows, a.v); byP.delete(p) }
    for (const p of byP.keys()) take(p, [], ZERO_VERSION)
    this.#sels.push(sel)
  }
  touch(p: string): void {
    if (this.held === null) return
    const h = this.held.get(p)
    if (h) { this.held.delete(p); this.held.set(p, h) }
  }
  pin(p: string, by: number): void { const h = this.held?.get(p); if (h) h.pins += by }
  #account(p: string): void {
    const h = this.held!.get(p)
    if (!h) return
    let b = 0
    for (const k of this.partRows.get(p) ?? []) b += sizeOf(rowOf(this.src, k)) + k.length
    this.bytes += b - h.bytes
    h.bytes = b
    this.#evict()
  }
  #evict(): void {
    if (this.held === null) return
    for (const [p, h] of this.held) {
      if (this.bytes <= this.limit) break
      if (h.pins > 0) continue
      this.held.delete(p)
      this.bytes -= h.bytes
      const keys = [...(this.partRows.get(p) ?? [])]
      if (keys.length > 0) fold(this.src, keys.map((k) => ({ type: 2, key: [k] })), (err) => this.l3.fault(this.proc, err))
      for (const k of keys) { this.rowVer.delete(k); this.rowBorn.delete(k) }
      this.partRows.delete(p)
      this.pVer.delete(p)
      this.w.note(`evict ${this.proc.id} ${this.meta.name} ${p}`)
    }
  }
}

// ── follow (state mode) ─────────────────────────────────────────────────────
export class FollowImpl {
  readonly rep: Replica
  readonly src = source()
  readonly sel: (p: string) => boolean
  readonly ready: Promise<void>
  readonly view: any
  #parts: string[] | null
  closed = false
  constructor(rep: Replica, sel: { parts?: string[]; prefix?: string; share?: { index: number; of: number } }, fetch: (p: string) => Promise<void>, fetchSel?: (sel: (p: string) => boolean) => Promise<void>) {
    this.rep = rep
    const k = rep.l3.k
    this.#parts = sel.parts ?? null
    this.sel = sel.parts ? ((p) => sel.parts!.includes(p))
      : sel.prefix !== undefined ? ((p) => p.startsWith(sel.prefix!))
      : sel.share ? ((p) => Math.floor((k.slotOf(p) * sel.share!.of) / SLOTS) === sel.share!.index)
      : () => true
    const hooks: LensHooks = {
      sink: () => { throw new Error('fero: a follow is read-only; write through the resource') },
      need: (key) => { if (!this.sel(k.partitionOf(rep.meta, key))) throw new FeroError('shortfall', { resource: rep.meta.name, key: [key] }) },
      whole: () => {},
    }
    this.view = lens(this.src, [], hooks)
    const d = rep.w.deferred<void>(rep.proc, 'soft')
    this.ready = d.promise
    const need = this.#parts ?? []
    const missing = rep.whole ? [] : need.filter((p) => !rep.holds(p))
    const finish = (): void => {
      // the snapshot: exactly the selected partitions, as this process holds them now
      const recs: Rec[] = []
      for (const [p, keys] of rep.partRows) if (this.sel(p)) for (const key of keys) recs.push({ type: 0, key: [key], value: rowOf(rep.src, key) })
      if (recs.length > 0) batch(() => { fold(this.src, recs, (e) => rep.l3.fault(rep.proc, e)) })
      for (const p of need) rep.pin(p, 1)
      rep.follows.add(this)
      rep.w.after(0, rep.proc, `follow-ready ${rep.meta.name}`, () => d.resolve())
    }
    if (!rep.whole && !this.#parts && (sel.prefix !== undefined || sel.share) && fetchSel) fetchSel(this.sel).then(finish, (e) => d.reject(e))
    else if (missing.length === 0) finish()
    else Promise.all(missing.map(fetch)).then(finish, (e) => d.reject(e))
    if (!rep.whole && !this.#parts && sel.prefix === undefined && !sel.share) d.reject(new FeroError('holistic', { resource: rep.meta.name }))
  }
  apply(recs: Rec[]): void {
    if (this.closed) return
    batch(() => { fold(this.src, recs, (e) => this.rep.l3.fault(this.rep.proc, e)) })
  }
  cursor(): string { return this.rep.feed.encode() }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.rep.follows.delete(this)
    for (const p of this.#parts ?? []) this.rep.pin(p, -1)
  }
}

// ── read (log mode) ────────────────────────────────────────────────────────
export interface LogEntry { rec: { type: 'update' | 'insert' | 'remove'; key: (string | number)[]; value?: unknown }; row?: unknown; partition: string; version: string; t: number; reason?: string }
export class ReaderImpl {
  readonly rep: Replica
  readonly feed: Feed
  readonly sel: (p: string) => boolean
  gaps = 0
  /** each buffered record carries the feed state just after it, so the cursor is exact */
  #buf: { e: Entry; j: number; pos: number[]; ep: Int32Array; n: number }[] = []
  #at: { pos: number[]; sub: number[]; ep: Int32Array }
  #wait: { resolve(v: IteratorResult<LogEntry>): void; reject(e: unknown): void } | null = null
  #closed = false
  #err: unknown = null
  constructor(rep: Replica, feed: Feed, sel: (p: string) => boolean) {
    this.rep = rep; this.feed = feed; this.sel = sel
    this.#at = { pos: [...feed.pos], sub: [...feed.sub], ep: feed.ep }
    rep.readers.add(this)
  }
  /** just after the last entry yielded */
  get cursor(): string { return Feed.encodeState(this.rep.meta, this.#at.pos, this.#at.sub, this.#at.ep) }
  poke(): void {
    if (this.#closed) return
    // a shuffle here interleaves groups (a random group order per pull), never records inside one
    // group's log: that keeps a cursor of one position per group exact (see API-NOTES)
    const order = this.rep.w.shuffle ? this.#order() : undefined
    const skip = [...this.feed.sub]
    const r = this.feed.pull(this.rep.l3.k, this.rep.known, (e, g) => {
      if (!this.sel(e.p)) return
      const from = e.i === this.#at.pos[g.n] + 1 ? skip[g.n] : 0
      const recs = Math.max(1, e.recs.length)
      for (let j = from; j < recs; j++) this.#buf.push({ e, j, pos: [...this.feed.pos], ep: this.feed.ep, n: g.n })
    }, order)
    if (r && !this.#err) {
      // `earliest` must be readable in every group, not only the one that tripped (bug fix, E-22
      // step 2: a second compacted group made reading on from `earliest` throw 'expired' again)
      const pos = this.feed.pos.map((p, n) => Math.max(p, this.rep.meta.groups[n].base))
      this.#err = new FeroError('expired', { resource: this.rep.meta.name, earliest: Feed.encodeState(this.rep.meta, pos, this.feed.sub.map(() => 0), this.feed.ep) })
    }
    this.#flush()
  }
  #order(): number[] {
    const xs = this.rep.meta.groups.map((_, i) => i)
    for (let i = xs.length - 1; i > 0; i--) { const j = this.rep.w.shuffleRng.int(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]] }
    return xs
  }
  #flush(): void {
    if (!this.#wait) return
    const w = this.#wait
    if (this.#buf.length > 0) { this.#wait = null; w.resolve({ value: this.#next(), done: false }); this.rep.w.poke(); return }
    if (this.#err) { this.#wait = null; w.reject(this.#err); this.rep.w.poke(); return }
    if (this.#closed) { this.#wait = null; w.resolve({ value: undefined, done: true }); this.rep.w.poke() }
  }
  #next(): LogEntry {
    const { e, j, pos, ep, n } = this.#buf.shift()!
    const recs = this.rep.l3.upcast(this.rep.meta, e)
    const last = j + 1 >= Math.max(1, e.recs.length)
    const at = { pos: [...pos], sub: [...this.#at.sub], ep }
    if (last) at.sub[n] = 0
    else { at.pos[n] = e.i - 1; at.sub[n] = j + 1 }
    for (let m = 0; m < at.sub.length; m++) if (m !== n) at.sub[m] = 0
    this.#at = at
    const r = recs[j]
    const out: LogEntry = r
      ? { rec: { type: r.type === 0 ? 'update' : r.type === 1 ? 'insert' : 'remove', key: r.key, ...(r.type === 2 ? {} : { value: r.value }) }, partition: e.p, version: e.v, t: e.t }
      : { rec: { type: 'update', key: [e.p] }, partition: e.p, version: e.v, t: e.t }
    if (r && r.type === 0 && r.key.length === 1) out.row = r.value
    if (e.why) out.reason = e.why
    return out
  }
  next(): Promise<IteratorResult<LogEntry>> {
    if (this.#buf.length > 0) return Promise.resolve({ value: this.#next(), done: false })
    if (this.#err) return Promise.reject(this.#err)
    if (this.#closed) return Promise.resolve({ value: undefined, done: true })
    const d = this.rep.w.deferred<IteratorResult<LogEntry>>(this.rep.proc, 'soft')
    this.#wait = d
    this.poke()
    return d.promise
  }
  close(): void { this.#closed = true; this.rep.readers.delete(this); this.#flush() }
}

// ── the layer ───────────────────────────────────────────────────────────────
export class L3 {
  readonly w: World
  readonly k: Kernel
  readonly divergences: string[] = []
  readonly faults: { proc: string; error: string }[] = []
  constructor(w: World, k: Kernel) {
    this.w = w; this.k = k
    // a commit is announced by the writer to every process that folds the resource (one hop each)
    k.hooks.commit.push((g, _prev, to) => {
      const meta = k.meta(g.res)
      if (!meta || g.leader === null) return
      const from = this.w.proc(g.leader)
      // a lost notice is sent again, as Raft's next heartbeat carries the commit index (bug fix,
      // E-22 step 2: a dropped notice left a client behind until its group's next commit, and a
      // read-your-writes wait on a quiet group never ended)
      const tell = (p: Proc): void => {
        if (!p.alive || !from.alive) return
        if (!this.w.send(from, p, `notice ${g.id}@${to}`, () => this.replicaIf(p, meta.name)?.notice(g.n, to)))
          this.w.after(5, from, `notice-again ${g.id}@${to}`, () => tell(p), true)
      }
      for (const p of meta.folders) tell(p)
    })
  }
  replicaIf(p: Proc, name: string): Replica | undefined { return (p.state.get('replicas') as Map<string, Replica> | undefined)?.get(name) }
  replica(p: Proc, meta: ResMeta, cache: number | null = null): Replica {
    let m = p.state.get('replicas') as Map<string, Replica> | undefined
    if (!m) { m = new Map(); p.state.set('replicas', m) }
    let r = m.get(meta.name)
    if (!r || r.meta !== meta) { r = new Replica(this, p, meta, cache); m.set(meta.name, r) }
    return r
  }
  fault(p: Proc, e: unknown): void {
    const msg = e instanceof AggregateError ? e.errors.map((x) => String((x as Error)?.message ?? x)).join('; ') : String((e as Error)?.message ?? e)
    this.faults.push({ proc: p.id, error: msg })
    process.stderr.write(`fero: your code threw while ${p.id} folded a commit: ${msg}\n`)
  }
  divergence(msg: string): void { this.divergences.push(msg); this.w.note(`DIVERGENCE ${msg}`) }
  /** records written under an older shape.version pass the upcasters in order (P-20) */
  upcast(meta: ResMeta, e: Entry): Rec[] { return upcastEntry(meta, e) }
  /** The monitor P-01 asks for: every caught-up replica that holds the whole resource equals a
   *  fresh fold of the committed log (through the same seam). Returns the mismatches. */
  checkFolds(): string[] {
    const bad: string[] = []
    for (const meta of this.k.catalog.values()) {
      if (meta.opts.rows === false) continue
      const ref = source()
      const feed = new Feed(meta)
      const known = meta.groups.map((g) => g.commit)
      if (meta.groups.some((g) => g.base > 0)) continue
      feed.pull(this.k, known, (e) => { fold(ref, this.upcast(meta, e), () => {}) })
      const want = Object.fromEntries(keysOf(ref).map((k) => [k, rowOf(ref, k)]))
      for (const p of meta.folders) {
        const r = this.replicaIf(p, meta.name)
        if (!r || !r.whole || !p.alive) continue
        if (r.inflight > 0 || meta.groups.some((g, n) => r.feed.pos[n] < g.commit)) continue
        const have = Object.fromEntries(keysOf(r.src).map((k) => [k, rowOf(r.src, k)]))
        if (!deepEqual(have, want)) bad.push(`${p.id}/${meta.name}: ${JSON.stringify(have).slice(0, 200)} != ${JSON.stringify(want).slice(0, 200)}`)
      }
    }
    return bad
  }
}
