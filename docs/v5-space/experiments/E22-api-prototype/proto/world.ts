// world — the deterministic executive. One OS process holds one world; a world holds many simulated
// processes (Proc), a virtual clock, one event queue, and seeded random streams. Every message,
// fsync, timer and fault is an event; the driver runs them in (time, sequence) order and lets the
// app's promise continuations run between them. So a run is a function of its seed and its fault
// schedule (TEST-02), and a failing schedule replays exactly.
//
// When does virtual time move? The driver runs while (a) some app promise is pending (a write, a
// get, a call: each has a timeout, so this always ends), or (b) a reader waits and a foreground
// event exists, or (c) advance()/settle() asks. Background events (renewals, controller ticks)
// never keep it running on their own.

import { AsyncLocalStorage } from 'node:async_hooks'
import { Heap, Rng, TraceHash, ms, type Duration } from './util.ts'

export interface WorldOpts {
  seed?: number
  start?: number
  shuffle?: boolean
  /** network latency range in ms, and the chance a message is lost */
  net?: { lat?: [number, number]; drop?: number }
  /** fsync latency range in ms */
  fsync?: [number, number]
  /** keep every event label in memory (for debugging a seed); the hash is always kept */
  trace?: boolean
  /** groups per resource (E-22 asks for at least 2); default 2, or FERO_GROUPS */
  groups?: number
  /** cluster keys (API.md ClusterKeys), virtual ms */
  keys?: Partial<ClusterKeys>
}
export interface ClusterKeys {
  'ping.ms': number; 'election.ms': number; 'election.jitter': number; 'skew.max': number
  'session.ms': number; 'lag.max': number; 'copies.default': 1 | 3 | 5
}
const KEY_DEFAULTS: ClusterKeys = {
  'ping.ms': 500, 'election.ms': 2000, 'election.jitter': 500, 'skew.max': 250, 'session.ms': 10000, 'lag.max': 1000, 'copies.default': 3,
}

interface Ev { t: number; seq: number; proc: Proc | null; fn: () => void; bg: boolean; label: string; dead?: boolean }
/** a scheduled event; cancel() drops it (a timeout that is no longer needed) */
export interface Timer { cancel(): void }

export interface HistoryOp {
  i: number; proc: string; res: string; op: string; key?: unknown; arg?: unknown
  t0: number; t1?: number; ok?: boolean; value?: unknown; code?: string; outcome?: 'refused' | 'unknown'
  /** a write's attempt id and body, for the outside checkers (E-22 step 3, TEST-13) */
  a?: string; w?: readonly unknown[]; touch?: unknown; claim?: { n: number }
}

export type FaultStep =
  | { at: number; do: 'leader-change'; res?: string; group?: number; down?: number }
  | { at: number; do: 'move'; res?: string; slot?: number; to?: number }
  | { at: number; do: 'kill'; proc: string }
  | { at: number; do: 'pause'; proc: string; for: number }
  | { at: number; do: 'skew'; proc: string; by: number }
  | { at: number; do: 'drop'; p: number }

const als = new AsyncLocalStorage<Proc>()
const NO_TIMER: Timer = { cancel() {} }
let bound: World | null = null
let implicitSeed = 0

/** The world fero() resolves in. Without fero.world(), the first fero() makes one, seeded from
 *  FERO_SEED or at random, and prints the seed (a live run of the prototype is still simulated). */
export const theWorld = (): World => {
  if (bound) return bound
  const seed = process.env.FERO_SEED !== undefined ? Number(process.env.FERO_SEED) : (implicitSeed = (Date.now() ^ (process.pid << 8)) >>> 0)
  if (process.env.FERO_SEED === undefined) process.stderr.write(`fero: no world bound; seed ${implicitSeed}\n`)
  return new World({ seed, shuffle: false })
}
export const boundWorld = (): World | null => bound

export class Proc {
  readonly world: World
  readonly id: string
  life: string
  alive = true
  pausedUntil = 0
  /** this process's clock offset from the world's, in ms (a skew fault moves it) */
  skew = 0
  /** node scope: set by the first fero() in this process (API.md NodeOptions) */
  node: { role: 'server' | 'client' | 'solo'; listen: string | false; opts: Record<string, unknown> } | null = null
  /** whatever L3/L4 hang on this process (replicas, handles, sessions) */
  readonly state: Map<string, any> = new Map()
  readonly pendings: Set<{ release(): void }> = new Set()
  seq = 0
  constructor(world: World, id: string) {
    this.world = world
    this.id = id
    this.life = world.rng.int(1e9).toString(36)
  }
  get session(): string { return `${this.id}:${this.life}` }
  /** this process's wall clock (writer time is clamped from it, L2) */
  clock(): number { return this.world.time + this.skew }
  /** run fn as this process: fero() and the libraries inside it resolve here */
  run<T>(fn: () => T): T { return als.run(this, fn) }
  /** fero() bound to this process */
  get fero(): any { return this.world.feroFor(this) }
}

export class World {
  readonly seed: number
  readonly shuffle: boolean
  readonly keys: ClusterKeys
  /** virtual time, ms */
  time: number
  readonly rng: Rng
  readonly netRng: Rng
  readonly faultRng: Rng
  readonly shuffleRng: Rng
  readonly idRng: Rng
  readonly trace = new TraceHash()
  readonly traceLog: string[] | null
  readonly history: HistoryOp[] = []
  readonly procs = new Map<string, Proc>()
  readonly main: Proc
  /** set by the layers above: the kernel, and fero() per process (World.api, from index.ts) */
  kernel: any = null
  static api: ((p: Proc) => any) | null = null
  feroFor(p: Proc): any { if (!World.api) throw new Error('fero: the API layer is not loaded'); return World.api(p) }
  readonly groupsPerResource: number
  readonly faultLog: string[] = []
  events = 0

  #q = new Heap<Ev>()
  #seq = 0
  #fg = 0
  #hard = 0
  #soft = 0
  #running = false
  #wakeQueued = false
  #flag = false
  #until: number | null = null
  #untilWaiters: (() => void)[] = []
  #settleUntil: number | null = null
  #settleWaiters: (() => void)[] = []
  #links = new Map<string, number>()
  #net: { lat: [number, number]; drop: number }
  #fsync: [number, number]
  #idn = 0
  #closed = false

  constructor(opts: WorldOpts = {}) {
    this.seed = opts.seed ?? 1
    this.shuffle = opts.shuffle ?? true
    this.time = opts.start ?? 0
    this.keys = { ...KEY_DEFAULTS, ...opts.keys }
    this.rng = new Rng(this.seed)
    this.netRng = this.rng.fork()
    this.faultRng = this.rng.fork()
    this.shuffleRng = this.rng.fork()
    this.idRng = this.rng.fork()
    this.traceLog = opts.trace ? [] : null
    this.groupsPerResource = opts.groups ?? Number(process.env.FERO_GROUPS ?? 2)
    this.#net = { lat: opts.net?.lat ?? [0.05, 0.4], drop: opts.net?.drop ?? 0 }
    this.#fsync = opts.fsync ?? [0.1, 0.3]
    bound = this
    this.main = this.proc('main')
  }

  // ── processes ──────────────────────────────────────────────────────────
  proc(id: string): Proc {
    let p = this.procs.get(id)
    if (!p) { p = new Proc(this, id); this.procs.set(id, p) }
    return p
  }
  /** the simulated process the caller runs as (AsyncLocalStorage), else main */
  current(): Proc { const p = als.getStore(); return p && p.world === this ? p : this.main }

  // ── time and ids (TEST-02) ─────────────────────────────────────────────
  now(): number { return this.time }
  id(): string {
    const t = Math.floor(this.time).toString(36).padStart(8, '0')
    return t + (this.#idn++).toString(36).padStart(4, '0') + this.idRng.int(36 ** 4).toString(36).padStart(4, '0')
  }

  // ── events ─────────────────────────────────────────────────────────────
  at(t: number, proc: Proc | null, label: string, fn: () => void, bg = false): Timer {
    if (this.#closed) return NO_TIMER
    const ev: Ev = { t: Math.max(t, this.time), seq: this.#seq++, proc, fn, bg, label }
    this.#q.push(ev)
    if (!bg) this.#fg++
    this.wake()
    return { cancel: () => { if (ev.dead) return; ev.dead = true; if (!ev.bg) { ev.bg = true; this.#fg-- } } }
  }
  after(dt: number, proc: Proc | null, label: string, fn: () => void, bg = false): Timer { return this.at(this.time + dt, proc, label, fn, bg) }
  /** a message from one process to another: seeded latency, FIFO per link, maybe lost (false) */
  send(from: Proc, to: Proc, label: string, fn: () => void): boolean {
    if (from === to) { this.at(this.time, to, label, fn); return true }
    if (!from.alive) return false
    if (this.#net.drop > 0 && this.netRng.chance(this.#net.drop)) { this.#mark(`drop ${from.id}>${to.id} ${label}`); return false }
    const link = from.id + '>' + to.id
    const t = Math.max(this.time + this.netRng.range(this.#net.lat[0], this.#net.lat[1]), this.#links.get(link) ?? 0)
    this.#links.set(link, t)
    this.at(t, to, label, fn)
    return true
  }
  fsyncDelay(): number { return this.netRng.range(this.#fsync[0], this.#fsync[1]) }
  setDrop(p: number): void { this.#net.drop = p }

  // ── app promises: they keep the driver running until they settle ───────
  /** a pending app promise owned by `proc`: if the process dies it never settles, and stops counting */
  deferred<T>(proc: Proc, kind: 'hard' | 'soft' = 'hard'): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void; readonly done: boolean } {
    let res!: (v: T) => void, rej!: (e: unknown) => void
    const promise = new Promise<T>((a, b) => { res = a; rej = b })
    // a dead process's promise never settles and, as kill() does for the ones it had, never holds
    // the world (bug fix, E-22 step 2: a call on a dead process's handle kept the driver running forever)
    let done = !proc.alive
    if (done) { /* not counted */ } else if (kind === 'hard') this.#hard++; else this.#soft++
    const entry = { release: () => { if (!done) { done = true; if (kind === 'hard') this.#hard--; else this.#soft-- } } }
    proc.pendings.add(entry)
    this.wake()
    return {
      promise,
      get done() { return done },
      resolve: (v: T) => { if (done) return; entry.release(); proc.pendings.delete(entry); this.#flag = true; res(v) },
      reject: (e: unknown) => { if (done) return; entry.release(); proc.pendings.delete(entry); this.#flag = true; rej(e) },
    }
  }
  /** a promise continuation was made runnable outside deferred() (a tap, a stream): yield after this event */
  poke(): void { this.#flag = true }

  wake(): void {
    if (this.#running || this.#wakeQueued || this.#closed) return
    this.#wakeQueued = true
    setImmediate(() => { this.#wakeQueued = false; void this.#drive() })
  }

  async #drive(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      for (;;) {
        const ev = this.#q.peek()
        // advance(): finish when nothing is left at or before the target
        if (this.#until !== null && (!ev || ev.t > this.#until)) {
          this.time = Math.max(this.time, this.#until)
          this.#until = null
          for (const w of this.#untilWaiters.splice(0)) w()
          await new Promise((r) => setImmediate(r))
          continue
        }
        if (this.#settleUntil !== null && (this.#fg === 0 || !ev || ev.t > this.#settleUntil)) {
          this.#settleUntil = null
          for (const w of this.#settleWaiters.splice(0)) w()
          await new Promise((r) => setImmediate(r))
          continue
        }
        if (!ev) break
        const go = this.#until !== null || this.#settleUntil !== null || this.#hard > 0 || (this.#soft > 0 && this.#fg > 0)
        if (!go) break
        this.#q.pop()
        if (!ev.bg) this.#fg--
        if (ev.dead) continue
        const p = ev.proc
        if (p !== null) {
          if (!p.alive) continue
          if (p.pausedUntil > ev.t) { this.at(p.pausedUntil, p, ev.label, ev.fn, ev.bg); continue }
        }
        if (ev.t > this.time) this.time = ev.t
        this.events++
        const line = `${this.time.toFixed(3)} ${p?.id ?? '-'} ${ev.label}`
        this.trace.add(line)
        this.traceLog?.push(line)
        // each event runs as its own process, so fero(), fero.now() and timers inside a tap or a
        // timer callback resolve there (bug fix, E-22 step 2: they ran as whichever process had
        // started the driver); an event with no process runs as none (main)
        if (p !== null) als.run(p, ev.fn); else als.exit(ev.fn)
        if (this.#flag) { this.#flag = false; await new Promise((r) => setImmediate(r)) }
      }
    } finally {
      this.#running = false
    }
  }

  /** move virtual time by `by`: every event up to then runs in order (timers, leases, TTLs) */
  advance(by: Duration): Promise<void> {
    const target = this.time + ms(by, 0)
    return new Promise<void>((r) => {
      this.#until = Math.max(this.#until ?? 0, target)
      this.#untilWaiters.push(r)
      this.wake()
    })
  }
  /** run until no foreground event is left (every message delivered, every fold caught up), or
   *  `max` of virtual time has passed */
  settle(max: Duration = '60s'): Promise<void> {
    const target = this.time + ms(max, 0)
    return new Promise<void>((r) => {
      this.#settleUntil = Math.max(this.#settleUntil ?? 0, target)
      this.#settleWaiters.push(r)
      this.wake()
    })
  }

  #mark(line: string): void { this.trace.add(line); this.traceLog?.push(`${this.time.toFixed(3)} ${line}`) }
  note(line: string): void { this.#mark(line) }

  // ── faults: each is an event, so it is in the trace and replays ─────────
  /** apply a fault schedule (absolute virtual times); returns it, for printing and replay */
  faults(schedule: readonly FaultStep[]): readonly FaultStep[] {
    for (const f of schedule) this.at(f.at, null, `fault ${f.do}`, () => this.#fault(f))
    return schedule
  }
  /** a seeded random schedule: `leaderChanges` and `moves` at uniform times within `within` */
  chaos(spec: { leaderChanges?: number; moves?: number; within?: Duration; res?: string; down?: number } = {}): FaultStep[] {
    const within = ms(spec.within ?? '200ms', 0)
    const out: FaultStep[] = []
    for (let i = 0; i < (spec.leaderChanges ?? 1); i++)
      out.push({ at: this.time + this.faultRng.range(0, within), do: 'leader-change', res: spec.res, down: spec.down })
    for (let i = 0; i < (spec.moves ?? 1); i++) out.push({ at: this.time + this.faultRng.range(0, within), do: 'move', res: spec.res })
    out.sort((a, b) => a.at - b.at)
    this.faults(out)
    return out
  }
  #fault(f: FaultStep): void {
    const k = this.kernel
    let what = ''
    switch (f.do) {
      case 'leader-change': what = k ? k.faultLeaderChange(f.res, f.group, f.down) : 'no kernel'; break
      case 'move': what = k ? k.faultMove(f.res, f.slot, f.to) : 'no kernel'; break
      case 'kill': this.kill(f.proc); what = f.proc; break
      case 'pause': this.pause(f.proc, f.for); what = `${f.proc} ${f.for}ms`; break
      case 'skew': this.proc(f.proc).skew += f.by; what = `${f.proc} ${f.by}ms`; break
      case 'drop': this.setDrop(f.p); what = String(f.p); break
    }
    this.faultLog.push(`${this.time.toFixed(3)} ${f.do} ${what}`)
    this.#mark(`fault ${f.do} ${what}`)
  }
  /** kill a process: its events stop, its pending promises never settle, its groups elect anew */
  kill(id: string): void {
    const p = this.proc(id)
    if (!p.alive) return
    p.alive = false
    for (const d of p.pendings) d.release()
    p.pendings.clear()
    this.kernel?.onKill(p)
  }
  /** pause a process for `ms`: nothing it would do or receive happens until then (a GC stall, a zombie) */
  pause(id: string, by: number): void {
    const p = this.proc(id)
    p.pausedUntil = Math.max(p.pausedUntil, this.time + by)
    this.kernel?.onPause(p, by)
  }

  /** record a client history entry (TEST-13); returns its index so the completion can fill it in */
  record(op: HistoryOp): HistoryOp { this.history.push(op); return op }

  /** unbind this world: later fero() calls get a new implicit world */
  async close(): Promise<void> {
    for (const p of this.procs.values()) { p.alive = false; for (const d of p.pendings) d.release() }
    this.#closed = true
    if (bound === this) bound = null
  }
}
