// kernel — L1, the log. Each resource is split into `groups` groups over 1,024 fixed slots. A group
// is an ordered log with one leader (the writer) and a set of voters. The leader's uncommitted tail
// lives only on the voters that have it; a leader change keeps what the new leader holds and drops
// the rest, as Raft does. The kernel offers exactly five operations to the layers above:
//
//   append(g, entries, term)   the leader adds entries to its log end; they commit at a majority
//   read(g, from, to)          committed entries (from, to]; 'expired' below the kept history
//   snapshot(g)                the group's L2 state at its commit index (a consistent cut), kept so
//                              the log can be compacted and a slot can move
//   changeMembers(g, voters)   a new voter set (one config entry; the sim does not model joint steps)
//   handOver(g, to)            a clean leader transfer: nothing committed or appended is lost
//
// Everything else here is the simulation of how those behave (latency, fsync, acks, elections) and
// the one controller (C `cent-co`) that grows voters, spreads leaders and moves one slot.

import type { World, Proc } from './world.ts'
import { fnv1a, ver } from './util.ts'

export const SLOTS = 1024
export type Rec = { type: 0 | 1 | 2; key: (string | number)[]; value?: unknown; at?: string }
export const REC = { update: 0, insert: 1, remove: 2 } as const

export interface EntryMeta {
  /** ttl deadline set by this write, by row key (writer time) */
  ttl?: Record<string, number>
  /** rows bound to a session by this write */
  ses?: Record<string, string>
  /** claims made: row key → [lease until, deliveries] */
  claims?: Record<string, [number, number]>
  /** rows (re)born by this write: their ttl and lease state starts afresh */
  born?: string[]
  /** a fence token passed by this write */
  fence?: [string, string]
  /** what the attempt answered (an op's value, a claim's rows) */
  ans?: unknown
  /** the state a slot carries into its new group ('in' entries) */
  slot?: SlotState
}
export interface SlotState {
  rows: [string, unknown][]
  rowMeta: [string, RowMetaWire][]
  attempts: [string, AttemptWire][]
  fences: [string, string][]
}
export interface RowMetaWire { v: string; born: string; t: number; ttl?: number; ses?: string; lease?: number; dl: number }
export interface AttemptWire { v: string; h: string; ans: unknown; t: number; slot: number }

export interface Entry {
  i: number
  term: number
  /** w: a write; x: a removal the writer made (ttl, max, where, session); noop; cfg; out/in: a slot leaves or arrives */
  k: 'w' | 'x' | 'noop' | 'cfg' | 'out' | 'in'
  slot: number
  ep: number
  p: string
  t: number
  a?: string
  h?: string
  recs: Rec[]
  why?: 'ttl' | 'max' | 'where' | 'session' | 'erased'
  m?: EntryMeta
  sv?: number
  v: string
}
export type NewEntry = Omit<Entry, 'i' | 'term' | 'v'>

export interface Snapshot { index: number; term: number; t: number; state: unknown }

export class Group {
  readonly id: string
  readonly res: string
  readonly n: number
  voters: string[] = []
  leader: string | null = null
  term = 1
  log: Entry[] = []
  /** entries at or below base were compacted into `snap` */
  base = 0
  snap: Snapshot | null = null
  commit = 0
  /** what the leader knows each voter holds (from acks): commits count these */
  match = new Map<string, number>()
  /** what each voter really has on disk (its fsync done): an election keeps what the winner holds */
  persisted = new Map<string, number>()
  /** a handOver in progress: appends are refused 'retry' until it lands */
  transferring: string | null = null
  /** an election in progress until this time: no writer */
  downUntil = 0
  lastT = 0
  /** followers with a replicate message on its way (the sim coalesces them) */
  readonly replPending = new Set<string>()
  /** a heartbeat (resend) is armed */
  hb = false
  constructor(res: string, n: number) { this.id = `${res}/g${n}`; this.res = res; this.n = n }
  get last(): number { return this.base + this.log.length }
  entry(i: number): Entry | undefined { return this.log[i - this.base - 1] }
}

export interface ResMeta {
  name: string
  /** a new number each time the name is created, so old cursors are refused 'unknown-log' */
  inc: number
  opts: Record<string, any>
  code: Record<string, any>
  groups: Group[]
  table: Int32Array
  epochs: Int32Array
  servers: Set<string>
  /** processes whose replicas fold this resource (servers, and clients that follow it) */
  folders: Set<Proc>
  gate: string | null
  /** shape.version in force from which group index (per group): [fromIndex, version][] */
  shapes: [number, number][][]
  createdAt: number
}

type Hook<A extends unknown[]> = ((...a: A) => void)[]

export class Kernel {
  readonly w: World
  readonly catalog = new Map<string, ResMeta>()
  readonly groupsPerResource: number
  #inc = 0
  readonly hooks = {
    lead: [] as Hook<[Group]>,
    depose: [] as Hook<[Group]>,
    commit: [] as Hook<[Group, number, number]>,
    snapshotter: null as null | ((g: Group) => unknown),
    defined: [] as Hook<[ResMeta]>,
    /** L2 fills these in: the slot move's steps, and which slots hold rows */
    mover: null as Mover | null,
    usedSlots: null as null | ((meta: ResMeta) => number[]),
  }
  /** counters for checks: elections, uncommitted entries lost, handovers */
  readonly stats = { elections: 0, lost: 0, handovers: 0, appends: 0 }
  /** every slot move the controller made, for checks */
  readonly moves: { res: string; slot: number; from: number; to: number; ep: number; at: number; done?: number }[] = []

  constructor(w: World, groups = 2) {
    this.w = w
    this.groupsPerResource = Math.max(1, groups)
  }

  // ── the catalog (#meta, kept here as one table: see API-NOTES) ──────────
  define(name: string, opts: Record<string, any>, code: Record<string, any>, creator: Proc): ResMeta {
    const G = this.groupsPerResource
    const meta: ResMeta = {
      name, inc: ++this.#inc, opts, code, groups: [], table: new Int32Array(SLOTS), epochs: new Int32Array(SLOTS),
      servers: new Set([creator.id]), folders: new Set(), gate: null, shapes: [], createdAt: this.w.time,
    }
    for (let s = 0; s < SLOTS; s++) meta.table[s] = Math.floor((s * G) / SLOTS)
    for (let n = 0; n < G; n++) {
      const g = new Group(name, n)
      g.voters = [creator.id]
      g.match.set(creator.id, 0)
      g.leader = creator.id
      meta.groups.push(g)
      meta.shapes.push([[0, opts.shape?.version ?? 1]])
    }
    this.catalog.set(name, meta)
    for (const h of this.hooks.defined) h(meta)
    for (const g of meta.groups) for (const h of this.hooks.lead) h(g)
    return meta
  }
  meta(name: string): ResMeta | undefined { return this.catalog.get(name) }
  drop(name: string): void { this.catalog.delete(name) }
  partitionOf(meta: ResMeta, key: string): string {
    const before = meta.opts.partition?.before
    if (before === undefined) return key
    const i = key.indexOf(before)
    return i < 0 ? key : key.slice(0, i)
  }
  slotOf(partition: string): number { return fnv1a(partition) % SLOTS }
  groupOf(meta: ResMeta, slot: number): Group { return meta.groups[meta.table[slot]] }
  group(id: string): Group | undefined {
    const i = id.lastIndexOf('/g')
    return this.catalog.get(id.slice(0, i))?.groups[Number(id.slice(i + 2))]
  }

  // ── op 1: append ────────────────────────────────────────────────────────
  /** The leader `by` appends entries in its term. Returns them with their index and version, or a
   *  reason: 'no-writer' (not the leader in this term, or an election), 'retry' (a handover). */
  append(g: Group, by: string, term: number, entries: NewEntry[]): Entry[] | 'no-writer' | 'retry' {
    if (g.leader !== by || g.term !== term || this.w.time < g.downUntil) return 'no-writer'
    if (g.transferring !== null) return 'retry'
    const out: Entry[] = []
    this.stats.appends += entries.length
    for (const e of entries) {
      const i = g.last + 1
      const full = { ...e, i, term, v: ver(e.ep, i) } as Entry
      g.log.push(full)
      if (full.t > g.lastT) g.lastT = full.t
      out.push(full)
    }
    const meta = this.catalog.get(g.res)!
    if (meta.opts.durability === 'none') {
      // durability 'none': the writer took it; it commits at once, and followers get it if they can
      this.#advance(g, g.last)
      this.#replicate(g)
      return out
    }
    const me = this.w.proc(by)
    const upTo = g.last
    this.w.after(this.w.fsyncDelay(), me, `fsync ${g.id}@${upTo}`, () => {
      if (g.term !== term || g.leader !== by) return
      if ((g.match.get(by) ?? 0) < upTo) g.match.set(by, Math.min(upTo, g.last))
      if ((g.persisted.get(by) ?? 0) < upTo) g.persisted.set(by, Math.min(upTo, g.last))
      this.#tryCommit(g)
    })
    this.#replicate(g)
    return out
  }

  // ── op 2: read ──────────────────────────────────────────────────────────
  /** Committed entries (from, to]. Below the kept history: 'expired' (the caller installs `g.snap`).
   *  With `tail`, the leader reads its own log end too, uncommitted entries included: how a new
   *  leader's L2 rebuilds the state it judges against. */
  read(g: Group, from: number, to = g.commit, opts: { tail?: boolean } = {}): Entry[] | 'expired' {
    if (from < g.base) return 'expired'
    const hi = Math.min(to, opts.tail ? g.last : g.commit)
    if (hi <= from) return []
    return g.log.slice(from - g.base, hi - g.base)
  }

  // ── op 3: snapshot ──────────────────────────────────────────────────────
  /** The group's L2 state at its commit index, from the registered snapshotter (L2). With `keep`,
   *  the log is compacted so that only the last `keep` committed entries stay readable. */
  snapshot(g: Group, keep?: number): Snapshot {
    const state = this.hooks.snapshotter ? this.hooks.snapshotter(g) : null
    const e = g.entry(g.commit)
    const snap: Snapshot = { index: g.commit, term: e?.term ?? g.term, t: e?.t ?? 0, state }
    g.snap = snap
    if (keep !== undefined) {
      const newBase = Math.max(g.base, g.commit - keep)
      if (newBase > g.base) { g.log = g.log.slice(newBase - g.base); g.base = newBase }
    }
    return snap
  }

  // ── op 4: changeMembers ─────────────────────────────────────────────────
  /** A new voter set, by the leader, as one config entry; it applies at once (Raft's one-at-a-time
   *  rule; the prototype changes one voter per call). A new voter starts empty and catches up. */
  changeMembers(g: Group, voters: string[]): Entry | 'no-writer' | 'retry' {
    if (g.leader === null) return 'no-writer'
    const r = this.append(g, g.leader, g.term, [{ k: 'cfg', slot: -1, ep: 0, p: '', t: g.lastT, recs: [], m: { ans: voters } }])
    if (typeof r === 'string') return r
    for (const v of voters) if (!g.match.has(v)) g.match.set(v, 0)
    for (const v of [...g.match.keys()]) if (!voters.includes(v)) { g.match.delete(v); g.persisted.delete(v) }
    g.voters = [...voters]
    this.w.note(`members ${g.id} [${voters.join(',')}]`)
    this.#replicate(g)
    if (g.leader !== null && !voters.includes(g.leader)) this.handOver(g, voters[0])
    return r[0]
  }

  // ── op 5: handOver ──────────────────────────────────────────────────────
  /** Move leadership to `to` with nothing lost: appends pause ('retry') until `to` holds the whole
   *  log, then `to` leads in a new term and the old leader's L2 state is dropped. */
  handOver(g: Group, to: string, done?: () => void): void {
    if (g.leader === to) { done?.(); return }
    if (!g.voters.includes(to) || !this.w.proc(to).alive) return
    g.transferring = to
    const check = (): void => {
      if (g.transferring !== to) return
      if (g.leader === null || !this.w.proc(to).alive) { g.transferring = null; return }
      if ((g.match.get(to) ?? 0) >= g.last && g.commit >= g.last) {
        const old = g.leader
        for (const h of this.hooks.depose) h(g)
        g.term++
        g.leader = to
        g.transferring = null
        this.w.note(`handover ${g.id} ${old}->${to} t${g.term}`)
        this.stats.handovers++
        this.#noop(g)
        for (const h of this.hooks.lead) h(g)
        done?.()
        return
      }
      this.#replicate(g)
      this.w.after(1, null, `handover-wait ${g.id}`, check)
    }
    check()
  }

  // ── the simulation of replication ───────────────────────────────────────
  #replicate(g: Group): void {
    if (g.leader === null) return
    const L = this.w.proc(g.leader)
    const pending = g.replPending
    for (const v of g.voters) {
      if (v === g.leader || pending.has(v)) continue
      const f = this.w.proc(v)
      if (!f.alive) continue
      pending.add(v)
      const term = g.term
      const upTo = g.last
      const sent = this.w.send(L, f, `repl ${g.id}@${upTo}`, () => {
        pending.delete(v)
        if (g.term !== term) return
        this.w.after(this.w.fsyncDelay(), f, `fsync ${g.id}@${upTo} ${v}`, () => {
          if (g.term !== term) return
          if ((g.persisted.get(v) ?? 0) < upTo) g.persisted.set(v, Math.min(upTo, g.last))
          this.w.send(f, L, `ack ${g.id}@${upTo} ${v}`, () => {
            if (g.term !== term || !g.match.has(v)) return
            if ((g.match.get(v) ?? 0) < upTo) g.match.set(v, Math.min(upTo, g.last))
            this.#tryCommit(g)
            if ((g.match.get(v) ?? 0) < g.last) this.#replicate(g)
          })
        })
      })
      if (!sent) pending.delete(v)
    }
    this.#heartbeat(g)
  }
  /** Raft's heartbeat, as far as the sim needs it: while anything is uncommitted, the leader resends
   *  every few ms, so a lost replicate message or a lost ack cannot stall a commit forever */
  #heartbeat(g: Group): void {
    if (g.hb || g.leader === null || g.commit >= g.last) return
    // no majority alive: nothing can commit; resending would only spin the sim
    if (g.voters.filter((v) => this.w.proc(v).alive).length * 2 <= g.voters.length) return
    g.hb = true
    const term = g.term, by = g.leader
    this.w.after(5, this.w.proc(by), `heartbeat ${g.id}`, () => {
      g.hb = false
      if (g.term !== term || g.leader !== by || g.commit >= g.last) return
      g.replPending.clear()
      this.#replicate(g)
    })
  }
  #tryCommit(g: Group): void {
    const ms = g.voters.map((v) => g.match.get(v) ?? 0).sort((a, b) => b - a)
    const q = ms[Math.floor(g.voters.length / 2)]
    // Raft: only an entry of the current term commits by counting; earlier ones commit under it
    if (q > g.commit && g.entry(q)?.term === g.term) this.#advance(g, q)
  }
  #advance(g: Group, to: number): void {
    const prev = g.commit
    if (to <= prev) return
    g.commit = to
    for (const h of this.hooks.commit) h(g, prev, to)
  }
  #noop(g: Group): void {
    this.append(g, g.leader!, g.term, [{ k: 'noop', slot: -1, ep: 0, p: '', t: g.lastT, recs: [] }])
  }

  /** A leader change: the new leader is a live voter that holds every committed entry (Raft's vote
   *  rule); entries past what it holds are lost. Writes get 'no-writer' for `down` ms meanwhile. */
  electAnew(g: Group, opts: { exclude?: string; down?: number } = {}): string {
    // every live voter counts for the majority; the voter being replaced (exclude) is avoided as the
    // new leader only while another holder exists (bug fix, E-22 step 3: excluding it from the count
    // left a 3-voter group with one dead voter unable to elect forever, P-20 under a forced change)
    const live = g.voters.filter((v) => this.w.proc(v).alive && this.w.proc(v).pausedUntil <= this.w.time)
    const has = (v: string): number => Math.max(g.persisted.get(v) ?? 0, g.match.get(v) ?? 0)
    const all = live.filter((v) => has(v) >= g.commit || v === g.leader)
    const others = all.filter((v) => v !== opts.exclude)
    const holders = others.length > 0 ? others : all
    if (holders.length === 0 || live.length * 2 <= g.voters.length) {
      // no majority alive: no writer until one comes back; try again later
      if (g.leader !== null) { for (const h of this.hooks.depose) h(g); g.leader = null; g.term++ }
      this.w.after(this.w.keys['election.ms'], null, `elect-retry ${g.id}`, () => { if (g.leader === null) this.electAnew(g, opts) })
      return 'none'
    }
    const chosen = this.w.faultRng.pick(holders)
    const none = this.catalog.get(g.res)?.opts.durability === 'none'
    // durability 'none' commits at the writer alone, so what no follower took is lost even if it
    // was "committed"; readers count the restart in `gaps`
    const keep = chosen === g.leader ? g.last
      : none ? Math.max(g.base, Math.min(has(chosen), g.last))
      : Math.max(g.commit, Math.min(has(chosen), g.last))
    if (none && g.commit > keep) g.commit = keep
    const lost = g.last - keep
    this.stats.elections++
    this.stats.lost += lost
    if (g.leader !== null) for (const h of this.hooks.depose) h(g)
    g.log.length = keep - g.base
    for (const [v, m] of g.match) if (m > keep) g.match.set(v, keep)
    for (const [v, m] of g.persisted) if (m > keep) g.persisted.set(v, keep)
    g.term++
    g.leader = null
    g.transferring = null
    const down = opts.down ?? this.w.keys['election.ms'] + this.w.faultRng.range(0, this.w.keys['election.jitter'])
    g.downUntil = this.w.time + down
    const term = g.term
    this.w.note(`elect ${g.id} -> ${chosen} t${term} lost ${lost} down ${down.toFixed(1)}`)
    this.w.at(g.downUntil, null, `lead ${g.id} ${chosen}`, () => {
      if (g.term !== term) return
      if (!this.w.proc(chosen).alive) { this.electAnew(g, opts); return }
      g.leader = chosen
      g.match.set(chosen, Math.max(g.match.get(chosen) ?? 0, Math.min(has(chosen), g.last)))
      this.#noop(g)
      for (const h of this.hooks.lead) h(g)
    })
    return `${g.id} -> ${chosen} (lost ${lost})`
  }

  // ── faults the world schedules ─────────────────────────────────────────
  faultLeaderChange(res?: string, n?: number, down?: number): string {
    const gs = this.#pickGroups(res).filter((g) => g.leader !== null)
    if (gs.length === 0) return 'no group with a leader'
    const g = n !== undefined ? gs.find((x) => x.n === n) ?? gs[0] : this.w.faultRng.pick(gs)
    return this.electAnew(g, { exclude: g.voters.length > 1 ? g.leader! : undefined, down })
  }
  faultMove(res?: string, slot?: number, to?: number): string {
    const metas = res ? [this.catalog.get(res)].filter(Boolean) as ResMeta[] : [...this.catalog.values()].filter((m) => !m.name.startsWith('#') && m.groups.length > 1)
    if (metas.length === 0) return 'no resource with two groups'
    const meta = this.w.faultRng.pick(metas)
    // prefer a slot that holds data, so the move is felt
    let s = slot
    if (s === undefined) {
      const used = this.hooks.usedSlots?.(meta) ?? []
      s = used.length > 0 ? this.w.faultRng.pick(used) : this.w.faultRng.int(SLOTS)
    }
    const from = meta.table[s]
    const dest = to ?? (from + 1 + this.w.faultRng.int(meta.groups.length - 1)) % meta.groups.length
    this.moveSlot(meta, s, dest)
    return `${meta.name} slot ${s} g${from}->g${dest}`
  }
  #pickGroups(res?: string): Group[] {
    const metas = res ? [this.catalog.get(res)].filter(Boolean) as ResMeta[] : [...this.catalog.values()].filter((m) => !m.name.startsWith('#'))
    return metas.flatMap((m) => m.groups)
  }

  /** The controller's one slot move, built from the five operations: A's writer seals the slot with
   *  an 'out' entry (append), its state is cut (snapshot of that slot), B's writer appends an 'in'
   *  entry carrying it (append), then the slot table points at B with a higher epoch. Each step
   *  retries until it lands, across leader changes. */
  moveSlot(meta: ResMeta, slot: number, toN: number): void {
    const fromN = meta.table[slot]
    if (fromN === toN) return
    const ep = meta.epochs[slot]
    const rec = { res: meta.name, slot, from: fromN, to: toN, ep: ep + 1, at: this.w.time } as (typeof this.moves)[number]
    this.moves.push(rec)
    this.w.note(`move start ${meta.name} s${slot} g${fromN}->g${toN} ep${ep + 1}`)
    const A = meta.groups[fromN], B = meta.groups[toN]
    const l2 = this.hooks.mover!
    const step1 = (): void => {
      const out = l2.sealed(A, slot, ep)
      if (out !== null && A.commit >= out) { step2(); return }
      if (out === null) l2.seal(A, slot, ep)
      this.w.after(2, null, `move-wait-out ${A.id} s${slot}`, step1)
    }
    const step2 = (): void => {
      const state = l2.slotState(A, slot)
      if (state === null) { this.w.after(2, null, `move-wait-state ${A.id}`, step2); return }
      const step3 = (): void => {
        const inn = l2.arrived(B, slot, ep + 1)
        if (inn !== null && B.commit >= inn) { finish(); return }
        if (inn === null) l2.admit(B, slot, ep + 1, state)
        this.w.after(2, null, `move-wait-in ${B.id} s${slot}`, step3)
      }
      step3()
    }
    const finish = (): void => {
      meta.table[slot] = toN
      meta.epochs[slot] = ep + 1
      rec.done = this.w.time
      this.w.note(`move done ${meta.name} s${slot} -> g${toN} ep${ep + 1}`)
    }
    step1()
  }

  /** The controller grows a group to `copies` voters as servers arrive, one voter per change, and
   *  spreads leaders over the servers with handOver (so a writer is often not the caller). */
  join(meta: ResMeta, server: Proc): void {
    meta.servers.add(server.id)
    const copies = Math.min(meta.opts.copies ?? this.w.keys['copies.default'], 5)
    for (const g of meta.groups) {
      if (g.voters.includes(server.id) || g.voters.length >= copies) continue
      // the voter set grows only to an odd size the cluster can hold: 1, then 3 (copies: 2 is cut)
      const live = [...meta.servers].filter((s) => this.w.proc(s).alive && !g.voters.includes(s))
      if (g.voters.length === 1 && live.length < 2) continue
      const add = g.voters.length === 1 ? live.slice(0, 2) : [server.id]
      let voters = [...g.voters]
      for (const a of add) {
        voters = [...voters, a]
        const r = this.changeMembers(g, voters)
        if (typeof r === 'string') break
      }
      const want = g.voters[g.n % g.voters.length]
      if (g.leader !== want) this.handOver(g, want)
    }
  }
  /** A server leaves a resource (destroy): it hands over what it leads, then is voted out. */
  leave(meta: ResMeta, server: Proc): void {
    meta.servers.delete(server.id)
    for (const g of meta.groups) {
      if (!g.voters.includes(server.id)) continue
      const rest = g.voters.filter((v) => v !== server.id && this.w.proc(v).alive)
      if (rest.length === 0) continue
      const out = (): void => { void this.changeMembers(g, g.voters.filter((v) => v !== server.id)) }
      if (g.leader === server.id) this.handOver(g, rest[0], out)
      else out()
    }
  }

  onKill(p: Proc): void {
    for (const meta of this.catalog.values()) {
      meta.folders.delete(p)
      for (const g of meta.groups) {
        if (g.leader !== p.id) continue
        this.w.after(this.w.keys['election.ms'], null, `failover ${g.id}`, () => {
          if (g.leader === p.id) this.electAnew(g, { exclude: p.id, down: this.w.faultRng.range(0, this.w.keys['election.jitter']) })
        })
      }
    }
  }
  onPause(p: Proc, by: number): void {
    if (by <= this.w.keys['election.ms']) return
    for (const meta of this.catalog.values()) for (const g of meta.groups) {
      if (g.leader !== p.id || g.voters.length < 3) continue
      this.w.after(this.w.keys['election.ms'], null, `failover ${g.id}`, () => {
        if (g.leader === p.id) this.electAnew(g, { exclude: p.id, down: this.w.faultRng.range(0, this.w.keys['election.jitter']) })
      })
    }
  }
}

export interface Mover {
  /** the index of the committed-or-appended 'out' entry for (slot, epoch) in A, or null */
  sealed(A: Group, slot: number, ep: number): number | null
  seal(A: Group, slot: number, ep: number): void
  slotState(A: Group, slot: number): SlotState | null
  arrived(B: Group, slot: number, ep: number): number | null
  admit(B: Group, slot: number, ep: number, state: SlotState): void
}
