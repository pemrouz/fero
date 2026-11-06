// api — L4, the surface API.md §3 declares: fero(name, opts) → a Resource with data, snapshot,
// methods, cluster, destroy, and the verbs get, follow, read, set, remove, touch, claim, batch.
// Writes route to their group's writer (a client goes through its server first: Y `fwd`), retry
// by themselves with the same attempt id, and answer after commit; a process that folds the
// partition answers only once its own fold shows the write (read-your-writes).

import { Kernel, type Group, type ResMeta, type Rec } from './kernel.ts'
import { L2, type WriteReq, type Answer, type W, type Cond, type OpSpec, type Who, leafAt } from './l2.ts'
import { L3, Feed, FollowImpl, ReaderImpl, type Replica, type LogEntry } from './l3.ts'
import { World, Proc, theWorld, boundWorld } from './world.ts'
import { FeroError, INTERNAL, toError, type Code, type Refusal } from './errors.ts'
import { lens, snapshotProxy, source, records, ingest, isView, valueOf, rowOf, type LensHooks } from './seam.ts'
import { ms, bytes, fnv1a, wireCopy, WireError, sizeOf, deepFreeze, verIndex } from './util.ts'

// ── op values ───────────────────────────────────────────────────────────────
export interface Op { readonly __op: OpSpec['op']; readonly spec: OpSpec }
const mkOp = (spec: OpSpec): Op => Object.freeze({ __op: spec.op, spec })
export const op = {
  incr: (n: number, b?: { min?: number; max?: number }): Op => {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new FeroError('invalid', { reason: 'incr takes a finite number' })
    return mkOp({ op: 'incr', n, min: b?.min, max: b?.max })
  },
  push: (...items: unknown[]): Op => mkOp({ op: 'push', items: items.map((x) => wireCopy(x)) }),
  merge: (fields: Record<string, unknown>): Op => mkOp({ op: 'merge', fields: wireCopy(fields) as Record<string, unknown> }),
  max: (x: number | string): Op => mkOp({ op: 'max', x }),
  min: (x: number | string): Op => mkOp({ op: 'min', x }),
}
const isOp = (v: unknown): v is Op => v !== null && typeof v === 'object' && '__op' in (v as object) && 'spec' in (v as object)

// ── the stack: one per world ────────────────────────────────────────────────
export interface Stack { w: World; k: Kernel; l2: L2; l3: L3 }
const stacks = new WeakMap<World, Stack>()
export const stackOf = (w: World): Stack => {
  let s = stacks.get(w)
  if (!s) {
    const groups = (w as any).groupsPerResource ?? Number(process.env.FERO_GROUPS ?? 2)
    const k = new Kernel(w, groups)
    const l2 = new L2(w, k)
    const l3 = new L3(w, k)
    w.kernel = k
    s = { w, k, l2, l3 }
    stacks.set(w, s)
    wire(s)
  }
  return s
}
const wire = (s: Stack): void => {
  const { w, k, l2, l3 } = s
  // writers follow #locks: the newest token for a lock is the newest born version its #locks row
  // has had, as this process folded it, kept after the row is released or expires (E-22 step 2)
  l2.lockToken = (p, lock) => {
    const meta = k.meta('#locks')
    if (!meta) return ''
    return l3.replica(p, meta).bornMax.get(lock) ?? ''
  }
  // writers follow #sessions: a lapsed session's rows go
  const lapsed = new Set<string>()
  l2.sessionLapsed = (ses) => lapsed.has(ses)
  k.hooks.commit.push((g, prev, to) => {
    if (g.res !== '#sessions') return
    const es = k.read(g, prev, to)
    if (es === 'expired') return
    for (const e of es) {
      if (e.k !== 'x') continue
      for (const r of e.recs) {
        const ses = String(r.key[0])
        lapsed.add(ses)
        w.after(0, null, `session-gone ${ses}`, () => l2.sessionGone(ses))
      }
    }
  })
  // history: compact the log with the snapshot op, keeping what `history` asks (the retention
  // policy is L1's own business, so it reads the log's times directly)
  k.hooks.commit.push((g, _prev, to) => {
    const meta = k.meta(g.res)
    const h = meta?.opts.history
    if (h === undefined || h === 0 || h === 'all') return
    if (typeof h === 'number') {
      if (to - g.base >= 2 * h + 64) k.snapshot(g, h)
    } else if (/[smhd]$/.test(h)) {
      const keepMs = ms(h, 0)
      const oldest = g.log[0]
      if (oldest && oldest.t < g.lastT - keepMs && g.log.length > 64) {
        let keep = 0
        for (let i = g.log.length - 1; i >= 0 && g.log[i].t >= g.lastT - keepMs; i--) keep++
        k.snapshot(g, Math.max(keep, to - g.commit))
      }
    }
  })
  // a client that opened a name before any server defined it gets its replica now
  k.hooks.defined.push((meta) => {
    for (const p of w.procs.values()) {
      const hs = (p.state.get('handles') as Map<string, Handle[]> | undefined)?.get(meta.name)
      if (hs && hs.length > 0) l3.replica(p, meta, hs[0].cacheLimit)
    }
  })
}

// ── per-process node state ─────────────────────────────────────────────────
interface Handle { res: ResourceImpl; cacheLimit: number | null }
const handlesOf = (p: Proc): Map<string, Handle[]> => {
  let m = p.state.get('handles') as Map<string, Handle[]> | undefined
  if (!m) { m = new Map(); p.state.set('handles', m) }
  return m
}
const floorsOf = (p: Proc): Map<string, string> => {
  let m = p.state.get('floors') as Map<string, string> | undefined
  if (!m) { m = new Map(); p.state.set('floors', m) }
  return m
}
const seen = (p: Proc, res: string, part: string, v: string): void => {
  if (!v) return
  const f = floorsOf(p), key = res + '\u0000' + part
  if ((f.get(key) ?? '') < v) f.set(key, v)
}
const floorOf = (p: Proc, res: string, part: string): string => floorsOf(p).get(res + '\u0000' + part) ?? ''

const SERVER_KEYS = ['server', 'listen', 'dir', 'seeds', 'data', 'methods', 'validation', 'schema', 'rules', 'load'] as const
const NODE_KEYS = ['project', 'uuid', 'server', 'listen', 'advertise', 'hosts', 'seeds', 'dir', 'object', 'secret', 'token', 'admin', 'rendezvous', 'memory', 'shuffle'] as const
const RESOURCE_KEYS = ['partition', 'history', 'rows', 'durability', 'copies', 'standbys', 'shape'] as const

const roleOf = (o: Record<string, any>): 'server' | 'client' | 'solo' => {
  if (o.listen === false) return 'solo'
  if (o.server === false) return 'client'
  if (SERVER_KEYS.some((k) => o[k] !== undefined && o[k] !== false)) return 'server'
  if (o.shape?.up !== undefined) return 'server'
  return 'client'
}
const isServer = (p: Proc): boolean => p.node?.role === 'server' || p.node?.role === 'solo'

/** the server a client's requests go through (its primary): a live server of the resource, chosen by hash */
const primaryOf = (s: Stack, p: Proc, meta: ResMeta, need?: (q: Proc) => boolean): Proc | null => {
  if (isServer(p) && meta.servers.has(p.id) && (!need || need(p))) return p
  const xs = [...meta.servers].map((id) => s.w.proc(id)).filter((q) => q.alive && (!need || need(q)))
  if (xs.length === 0) return null
  return xs[fnv1a(p.id + '/' + meta.name) % xs.length]
}

// ── the client side of a write: route, retry, answer after commit ─────────────
interface IssueBody { kind: WriteReq['kind']; p: string; writes?: W[]; claim?: WriteReq['claim']; touch?: WriteReq['touch'] }
interface IssueOpts { timeout: number; attempt?: string; who: Who; hist?: { op: string; key?: unknown; arg?: unknown }; quiet?: boolean }
const BACKOFF0 = 200

export const issue = (s: Stack, P: Proc, name: string, body: IssueBody, o: IssueOpts): Promise<Answer & { ok: true }> => {
  const { w, k } = s
  const a = o.attempt!
  const d = w.deferred<Answer & { ok: true }>(P)
  // the attempt id and the body go in the history too, for the outside checkers (E-22 step 3, TEST-13)
  const hist = o.hist ? w.record({ i: w.history.length, proc: P.id, res: name, op: o.hist.op, key: o.hist.key, arg: o.hist.arg, t0: w.time, a: o.attempt, w: body.writes, touch: body.touch, claim: body.claim ? { n: body.claim.n } : undefined }) : null
  const wr = writeRow(P, name, a, body)
  const h = hashBody(body)
  let done = false
  let lastCause: Code | undefined
  let backoff = BACKOFF0
  let timer: { cancel(): void } | null = null
  const deadline = w.time + o.timeout
  const horizon = w.time + 5 * 60_000
  const finish = (ans: Answer): void => {
    if (done) return
    done = true
    timer?.cancel()
    deadlineTimer.cancel()
    if (ans.ok) {
      const meta = k.meta(name)!
      seen(P, name, body.p, ans.v)
      wr.state = 'committed'; wr.version = ans.v
      const rep = s.l3.replicaIf(P, name)
      const resolve = (): void => {
        if (hist && hist.t1 === undefined) Object.assign(hist, { t1: w.time, ok: true, value: ans.ans ?? (ans.rows ? ans.rows : undefined), v: ans.v })
        d.resolve(ans as Answer & { ok: true })
      }
      if (rep && ans.v && meta.opts.rows !== false) rep.waitFor(body.p, ans.v, resolve)
      else resolve()
    } else {
      const err = toError(ans.r, name, body.writes?.[0]?.key ?? (body.touch ? [body.touch.key] : undefined), a)
      wr.state = 'refused'; wr.code = ans.r.code
      if (hist && hist.t1 === undefined) Object.assign(hist, { t1: w.time, ok: false, code: ans.r.code, outcome: 'refused' })
      d.reject(err)
    }
  }
  /** (re)arm the one retry timer: a resend of the same attempt, judged by the writer's dedup */
  const arm = (dt: number): void => {
    timer?.cancel()
    const jit = dt * (0.5 + w.netRng.next() * 0.5)
    timer = w.after(jit, P, `retry ${a}`, () => {
      timer = null
      if (done || w.time >= horizon) return
      backoff = Math.min(backoff * 2, w.keys['election.ms'])
      send()
    }, w.time >= deadline)
  }
  const send = (): void => {
    if (done || !P.alive) return
    const meta = k.meta(name)
    if (!meta) { lastCause = 'no-writer'; arm(BACKOFF0); return }  // unplaced: no server has defined it yet
    const slot = k.slotOf(body.p)
    const g = k.groupOf(meta, slot)
    const req: WriteReq = {
      res: name, inc: meta.inc, p: body.p, slot, a, h, from: P.id, who: o.who, sv: meta.opts.shape?.version ?? 1,
      kind: body.kind, writes: body.writes, claim: body.claim, touch: body.touch,
    }
    arm(backoff)
    route(s, P, g, req, (ans) => {
      if (done) return
      if (!ans.ok && INTERNAL.has(ans.r.code)) {
        lastCause = ans.r.code
        arm(ans.r.code === 'moved' || ans.r.code === 'wrong-group' || ans.r.code === 'retry' ? 5 : backoff)
        return
      }
      finish(ans)
    })
  }
  // the promise gives up at its timeout ('timeout', outcome unknown); fero keeps trying in the
  // background, and a late answer still lands in cluster.writes
  const deadlineTimer = w.at(deadline, P, `timeout ${a}`, () => {
    if (done || d.done) return
    if (hist) Object.assign(hist, { t1: w.time, ok: false, code: 'timeout', outcome: 'unknown' })
    d.reject(new FeroError('timeout', { resource: name, attempt: a, cause: lastCause }))
  })
  send()
  return d.promise
}

/** one hop to the writer, through the client's server (fwd) when the sender is a client */
const route = (s: Stack, P: Proc, g: Group, req: WriteReq, onAnswer: (a: Answer) => void): void => {
  const { w, l2 } = s
  if (g.leader === null) { onAnswer({ ok: false, r: { code: 'no-writer' } }); return }
  const L = w.proc(g.leader)
  const meta = s.k.meta(req.res)!
  const via = isServer(P) ? P : primaryOf(s, P, meta)
  if (via === null) { onAnswer({ ok: false, r: { code: 'no-writer' } }); return }
  const atWriter = (back: (a: Answer) => void): void => {
    w.send(via, L, `write ${req.a} ${g.id}`, () => l2.receive(req, g, (ans) => w.send(L, via, `answer ${req.a}`, () => back(ans))))
  }
  if (via === P) atWriter(onAnswer)
  else w.send(P, via, `fwd ${req.a}`, () => atWriter((ans) => w.send(via, P, `answer ${req.a}`, () => onAnswer(ans))))
}

const hashBody = (b: IssueBody): string => {
  const j = JSON.stringify(b, (_k, v) => (typeof v === 'function' ? `fn:${String(v)}` : v))
  return fnv1a(j).toString(36) + j.length.toString(36)
}

// ── cluster.writes: this process's last 64 attempts ──────────────────────────
interface WriteRow { id: string; key: unknown; state: 'pending' | 'committed' | 'refused' | 'unknown'; version?: string; code?: Code; res: string }
const writeRow = (P: Proc, res: string, id: string, b: IssueBody): WriteRow => {
  let xs = P.state.get('writes') as WriteRow[] | undefined
  if (!xs) { xs = []; P.state.set('writes', xs) }
  const r: WriteRow = { id, res, key: b.writes?.[0]?.key ?? (b.touch ? [b.touch.key] : [b.p]), state: 'pending' }
  xs.push(r)
  if (xs.length > 64) xs.shift()
  return r
}

// ── the resource ─────────────────────────────────────────────────────────────
type Opts = Record<string, any>
export class ResourceImpl {
  readonly name: string
  readonly #s: Stack
  readonly #P: Proc
  readonly #opts: Opts
  readonly cacheLimit: number | null
  #closed = false
  #data: any
  #snapshot: any
  #methods: any
  #cluster: any
  /** inside a method: the call's attribution (attempt ids, session, flush) */
  readonly #ctx: CallCtx | null

  constructor(s: Stack, P: Proc, name: string, opts: Opts, ctx: CallCtx | null = null) {
    this.#s = s; this.#P = P; this.name = name; this.#opts = opts; this.#ctx = ctx
    this.cacheLimit = opts.cache?.memory !== undefined ? bytes(opts.cache.memory, 0) : null
  }
  get #meta(): ResMeta | undefined { return this.#s.k.meta(this.name) }
  get #rep(): Replica | undefined {
    const meta = this.#meta
    return meta ? this.#s.l3.replica(this.#P, meta, this.cacheLimit) : undefined
  }
  get #who(): Who { return this.#ctx?.who ?? { peer: this.#P.id, claims: null, session: this.#P.session } }
  #part(key: string): string {
    const meta = this.#meta
    if (meta) return this.#s.k.partitionOf(meta, key)
    const before = this.#opts.partition?.before
    if (before === undefined) return key
    const i = key.indexOf(before)
    return i < 0 ? key : key.slice(0, i)
  }
  #need = (key: string): void => {
    const rep = this.#rep
    if (!rep) throw new FeroError('shortfall', { resource: this.name, key: [key], message: 'no server has defined this resource yet' })
    const p = this.#part(key)
    if (!rep.holds(p)) throw new FeroError('shortfall', { resource: this.name, key: [key] })
    rep.touch(p)
  }
  #whole = (): void => {
    const rep = this.#rep
    if (!rep || !rep.whole) throw new FeroError('holistic', { resource: this.name })
  }
  #hooks(): LensHooks {
    return {
      sink: (recs) => this.#assign(recs),
      need: this.#need,
      whole: this.#whole,
    }
  }

  // ── reads of what this process holds ──────────────────────────────────────
  get data(): any {
    if (this.#data) return this.#data
    const rep = this.#rep
    const src = rep?.src ?? source()
    let base = lens(src, [], this.#hooks())
    if (this.#ctx) base = this.#ctx.scope(base)
    if (rep) this.#data = base
    return base
  }
  get snapshot(): any {
    if (this.#snapshot) return this.#snapshot
    const rep = this.#rep
    if (!rep) return snapshotProxy(source(), { need: this.#need, whole: this.#whole })
    this.#snapshot = snapshotProxy(rep.src, { need: this.#need, whole: this.#whole })
    return this.#snapshot
  }

  /** a plain assignment: the same write as set(), with no promise; it shows when it commits */
  #assign(recs: Rec[]): void {
    this.#check()
    for (const r of recs) {
      const key = r.key.map(String)
      const value = r.value
      const p = r.type === 2
        ? this.remove(key.length === 1 ? key[0] : key as any)
        : this.set(key.length === 1 ? key[0] : key as any, value as any)
      if (this.#ctx) this.#ctx.track(p)
      p.catch((e: FeroError) => {
        if (e.code === 'timeout') return
        if (!this.#ctx) process.stderr.write(`fero: a write by assignment was refused: ${e.message}\n`)
      })
    }
  }
  #check(): void { if (this.#closed) throw new FeroError('destroyed', { resource: this.name }) }

  // ── the verbs ─────────────────────────────────────────────────────────────
  get(key: string | (string | number)[], o: { fresh?: boolean; version?: boolean; timeout?: number | string } = {}): Promise<any> {
    this.#check()
    const s = this.#s, P = this.#P, w = s.w
    const path = Array.isArray(key) ? key.map(String) : [key]
    const rk = path[0]
    const p = this.#part(rk)
    const hist = w.record({ i: w.history.length, proc: P.id, res: this.name, op: o.fresh ? 'get-fresh' : 'get', key: path, t0: w.time })
    const d = w.deferred<any>(P)
    const timeout = ms(o.timeout, 10_000)
    const out = (row: unknown, v: string): void => {
      if (d.done) return
      tmo.cancel()
      seen(P, this.name, p, v)
      const val = path.length === 1 ? row : leafAt(row, path.slice(1))
      const res = o.version ? (val === undefined ? undefined : { value: deepFreeze(val), version: v }) : deepFreeze(val)
      Object.assign(hist, { t1: w.time, ok: true, value: val, v })
      d.resolve(res)
    }
    const fail = (e: FeroError): void => { if (d.done) return; Object.assign(hist, { t1: w.time, ok: false, code: e.code, outcome: e.outcome }); d.reject(e) }
    const tmo = w.after(timeout, P, `get-timeout ${this.name}`, () => fail(new FeroError('timeout', { resource: this.name, key: path })))
    /** read-through (P-04): the miss goes to the writer of the key's group, which runs `load` once
     *  per key however many miss, and writes the row with if: { absent } so a write meanwhile wins */
    const missToWriter = (): void => {
      const meta = this.#meta!
      const g = s.k.groupOf(meta, s.k.slotOf(p))
      if (g.leader === null) { w.after(BACKOFF0, P, `get-wait ${this.name}`, attempt); return }
      const L = w.proc(g.leader)
      w.send(P, L, `miss ${this.name} ${rk}`, () => {
        const lrep = s.l3.replica(L, meta)
        const serve = (): void => {
          const row = valueOf(lrep.src.get(rk))
          const v = lrep.rowVer.get(rk) ?? ''
          w.send(L, P, `miss-answer ${rk}`, () => { const rep = s.l3.replicaIf(P, this.name); if (rep && rep.holds(p) && v) rep.waitFor(p, v, () => out(row, v)); else out(row, v) })
        }
        if (valueOf(lrep.src.get(rk)) === undefined) readThrough(s, L, meta, rk, serve); else serve()
      })
    }
    const attempt = (): void => {
      if (d.done) return
      const meta = this.#meta
      if (!meta) { w.after(BACKOFF0, P, `get-wait ${this.name}`, attempt); return }
      const rep = s.l3.replica(P, meta, this.cacheLimit)
      const floor = floorOf(P, this.name, p)
      const g = s.k.groupOf(meta, s.k.slotOf(p))
      if (!o.fresh && rep.holds(p)) {
        rep.touch(p)
        rep.waitFor(p, floor, () => {
          const v = valueOf(rep.src.get(rk))
          if (v === undefined && meta.code.load) { missToWriter(); return }   // a miss with a load: the writer fills it
          out(v, rep.rowVer.get(rk) ?? '')
        })
        return
      }
      if (o.fresh) {
        // a linearizable read: the writer confirms it still leads (one round trip to a voter), then
        // answers once its own fold has reached what was committed when the read arrived
        if (g.leader === null) { w.after(BACKOFF0, P, `get-retry ${this.name}`, attempt); return }
        const L = w.proc(g.leader)
        const term = g.term
        w.send(P, L, `fresh ${this.name} ${rk}`, () => {
          if (g.leader !== L.id || g.term !== term) { w.send(L, P, 'fresh-retry', () => w.after(BACKOFF0, P, 'get-retry', attempt)); return }
          const commitAt = g.commit
          const peer = g.voters.find((v) => v !== L.id && w.proc(v).alive)
          const confirm = (fn: () => void): void => {
            if (!peer) { fn(); return }
            const Q = w.proc(peer)
            w.send(L, Q, 'readindex', () => w.send(Q, L, 'readindex-ack', fn))
          }
          confirm(() => {
            if (g.leader !== L.id || g.term !== term) { w.send(L, P, 'fresh-retry', () => w.after(BACKOFF0, P, 'get-retry', attempt)); return }
            const lrep = s.l3.replica(L, meta)
            const target = lastVersionOf(s.k, g, p, commitAt)
            lrep.waitFor(p, target, () => {
              const row = valueOf(lrep.src.get(rk))
              const v = lrep.rowVer.get(rk) ?? ''
              w.send(L, P, `fresh-answer ${rk}`, () => out(row, v))
            })
          })
        })
        return
      }
      // not held: one hop to a server that folds it; a near cache holds the partition from now on
      const S = meta.code.load ? (g.leader ? w.proc(g.leader) : null) : primaryOf(s, P, meta)
      if (S === null) { w.after(BACKOFF0, P, `get-wait ${this.name}`, attempt); return }
      if (!rep.whole) rep.expect(p)
      w.send(P, S, `get ${this.name} ${p}`, () => {
        const srep = s.l3.replica(S, meta)
        srep.waitFor(p, floor, () => {
          const serve = (): void => {
            const ans = srep.serve(p)
            const row = valueOf(srep.src.get(rk))
            const v = srep.rowVer.get(rk) ?? ''
            w.send(S, P, `got ${this.name} ${p}`, () => {
              if (!rep.whole && !rep.holds(p)) rep.hold(p, ans.rows, ans.v)
              out(row, v)
            })
          }
          if (valueOf(srep.src.get(rk)) === undefined && meta.code.load) readThrough(s, S, meta, rk, serve)
          else serve()
        })
      })
    }
    attempt()
    return d.promise
  }

  follow(sel: string | readonly string[] | { prefix: string } | { share: { index: number; of: number } }): any {
    this.#check()
    const rep = this.#rep
    if (!rep) throw new FeroError('shortfall', { resource: this.name, message: 'no server has defined this resource yet' })
    const parts = typeof sel === 'string' ? [sel] : Array.isArray(sel) ? [...sel] : undefined
    const spec = parts ? { parts: parts.map((x) => this.#part(x)) } : 'prefix' in (sel as object) ? { prefix: (sel as any).prefix } : { share: (sel as any).share }
    // a near cache's prefix or share follow: one hop to a server for every matching partition
    const fetchSel = (sel: (p: string) => boolean): Promise<void> => new Promise<void>((resolve) => {
      const s = this.#s, P = this.#P, meta = this.#meta!
      rep.expectSel(sel)
      const ask = (): void => {
        const S = primaryOf(s, P, meta)
        if (S === null) { s.w.after(BACKOFF0, P, `follow-wait ${this.name}`, ask); return }
        s.w.send(P, S, `follow-sel ${this.name}`, () => {
          const srep = s.l3.replica(S, meta)
          const ans = [...srep.partRows.keys()].filter(sel).map((p) => [p, srep.serve(p)] as [string, { rows: [string, unknown][]; v: string }])
          s.w.send(S, P, `follow-sel-answer ${this.name}`, () => { rep.holdSel(sel, ans); resolve() })
        })
      }
      ask()
    })
    const f = new FollowImpl(rep, spec, (p) => this.get(p).then(() => undefined), fetchSel)
    const view = f.view
    return new Proxy(view, {
      get: (t, prop) => {
        if (prop === 'ready') return f.ready
        if (prop === 'cursor') return () => f.cursor()
        if (prop === 'close') return () => f.close()
        return t[prop]
      },
    })
  }

  read(o: { from: string; partitions?: readonly string[]; prefix?: string; share?: { index: number; of: number }; credit?: unknown }): any {
    this.#check()
    const meta = this.#meta
    if (!meta) throw new FeroError('unknown-log', { resource: this.name, message: 'no server has defined this resource yet' })
    const rep = this.#rep!
    const feed = o.from === 'earliest' ? new Feed(meta) : o.from === 'latest' ? rep.feed.clone() : Feed.decode(meta, o.from)
    const parts = o.partitions?.map((x) => this.#part(x))
    const sel = parts ? (p: string) => parts.includes(p)
      : o.prefix !== undefined ? (p: string) => p.startsWith(o.prefix!)
      : o.share ? (p: string) => Math.floor((this.#s.k.slotOf(p) * o.share!.of) / 1024) === o.share!.index
      : () => true
    const r = new ReaderImpl(rep, feed, sel)
    return {
      get cursor() { return r.cursor },
      get gaps() { return r.gaps },
      close: () => r.close(),
      [Symbol.asyncIterator]: () => ({ next: () => r.next(), return: () => { r.close(); return Promise.resolve({ value: undefined, done: true }) } }),
    }
  }

  set(key: string | (string | number)[], value: unknown, o: Record<string, any> = {}): Promise<any> {
    return this.#write([{ key: Array.isArray(key) ? key : [key], value, if: o.if, ttl: o.ttl, while: o.while }], o, 'set')
  }
  remove(key: string | (string | number)[], o: Record<string, any> = {}): Promise<any> {
    return this.#write([{ key: Array.isArray(key) ? key : [key], remove: true, if: o.if }], o, 'remove')
  }
  batch(writes: readonly Record<string, any>[], o: Record<string, any> = {}): Promise<any> {
    return this.#write(writes.map((x) => ({ key: Array.isArray(x.key) ? x.key : [x.key], value: x.value, remove: x.remove, if: x.if, ttl: x.ttl })), o, 'batch')
  }
  touch(key: string, o: { ttl?: number | string; timeout?: number | string; lease?: number | string; if?: Cond } = {}): Promise<any> {
    this.#check()
    const p = this.#part(key)
    return this.#run({ kind: 'touch', p, touch: { key, ttl: o.ttl !== undefined ? ms(o.ttl, 0) : undefined, lease: o.lease !== undefined ? ms(o.lease, 0) : undefined, if: o.if } }, o, 'touch', key)
      .then((a) => ({ key: [key], version: a.v, attempt: a.attempt }))
  }
  claim(o: { partition: string; n?: number; lease: number | string; where?: (row: any, t: number) => boolean; timeout?: number | string }): Promise<any[]> {
    this.#check()
    const p = this.#part(o.partition)
    return this.#run({ kind: 'claim', p, claim: { n: o.n ?? 1, lease: ms(o.lease, 0), where: o.where } }, o, 'claim', o.partition)
      .then((a) => (a.rows ?? []).map((r: any) => ({ key: r.key, value: r.value, token: a.v, until: r.until, deliveries: r.deliveries })))
  }

  #write(ws: { key: (string | number)[]; value?: unknown; remove?: true; if?: Cond; ttl?: number | string; while?: 'session' }[], o: Record<string, any>, verb: string): Promise<any> {
    try { this.#check() } catch (e) { return Promise.reject(e) }
    const meta = this.#meta
    const P = this.#P
    // the door (V4-5): a client changes a resource with methods only through them
    if (meta?.code.methods && !isServer(P) && !this.#ctx) return Promise.reject(new FeroError('methods-only', { resource: this.name, key: ws[0].key }))
    const parts = new Set<string>()
    const out: W[] = []
    for (const x of ws) {
      if (x.key.length === 0 || x.key[0] === '' || x.key.some((k) => typeof k !== 'string' && typeof k !== 'number'))
        return Promise.reject(new FeroError('invalid-key', { resource: this.name, key: x.key }))
      parts.add(this.#part(String(x.key[0])))
      const wr: W = { key: x.key }
      if (x.remove) wr.remove = true
      else if (isOp(x.value)) wr.op = x.value.spec
      else {
        try { wr.value = wireCopy(x.value) } catch (e) {
          if (e instanceof WireError) return Promise.reject(new FeroError('unencodable', { resource: this.name, key: x.key, reason: e.message }))
          throw e
        }
        if (sizeOf(wr.value) > 1_000_000) return Promise.reject(new FeroError('too-large', { resource: this.name, key: x.key }))
        // validation runs where a write enters, and again at the writer
        if (meta?.code.validation && isServer(P)) {
          const r = meta.code.validation({ type: 'update', key: x.key, value: wr.value })
          if (r !== true) return Promise.reject(new FeroError('invalid', { resource: this.name, key: x.key, reason: String(r) }))
        }
      }
      if (x.if) wr.if = x.if
      if (x.ttl !== undefined) wr.ttl = ms(x.ttl, 0)
      if (x.while) wr.while = x.while
      out.push(wr)
    }
    if (parts.size > 1) return Promise.reject(new FeroError('cross-partition', { resource: this.name }))
    const p = [...parts][0]
    // a row bound to a session needs the session's lease to exist: the writer's process keeps it
    // ... and is written only once that session's record has committed, else a process that dies
    // first leaves rows bound to a session no writer knows, which never lapse (bug fix, E-22 step 3:
    // P-13 with a #sessions leader change during the first renewal, 19 of 100 seeds)
    const ready = !this.#ctx && (meta?.opts.rows?.while === 'session' || out.some((x) => x.while === 'session')) ? keepSession(this.#s, P) : null
    const go = () => this.#run({ kind: 'w', p, writes: out }, o, verb, ws.length === 1 ? ws[0].key : ws.map((x) => x.key), ws.length === 1 ? (ws[0].remove ? undefined : ws[0].value) : undefined)
    return (ready ? ready.then(go) : go())
      .then((a) => {
        if (verb === 'batch') return out.map((x, i) => ({ key: x.key, version: a.v, attempt: a.attempt, value: Array.isArray(a.ans) ? a.ans[i] : undefined }))
        return { key: out[0].key, version: a.v, attempt: a.attempt, ...(a.ans !== undefined ? { value: a.ans } : {}) }
      })
  }
  #run(body: IssueBody, o: Record<string, any>, verb: string, key: unknown, arg?: unknown): Promise<Answer & { ok: true; attempt: string }> {
    const P = this.#P
    const attempt = this.#ctx?.attempt() ?? `${P.session}:${++P.seq}`
    const pr = issue(this.#s, P, this.name, body, {
      timeout: ms(o.timeout, 10_000), attempt, who: this.#who,
      hist: { op: verb, key, arg: isOp(arg) ? { op: (arg as Op).spec } : arg },
    }).then((a) => ({ ...a, attempt }))
    if (this.#ctx) this.#ctx.track(pr)
    return pr
  }

  get methods(): any {
    if (this.#methods) return this.#methods
    this.#methods = new Proxy({}, { get: (_t, name) => (typeof name === 'string' ? (arg?: unknown, o?: Record<string, any>) => callMethod(this.#s, this.#P, this.name, name, arg, o ?? {}) : undefined) })
    return this.#methods
  }
  get cluster(): any {
    if (this.#cluster) return this.#cluster
    this.#cluster = clusterView(this.#s, this.#P, this.name)
    return this.#cluster
  }
  async destroy(): Promise<boolean> {
    if (this.#closed) return true
    this.#closed = true
    const hs = handlesOf(this.#P).get(this.name) ?? []
    const i = hs.findIndex((h) => h.res === this)
    if (i >= 0) hs.splice(i, 1)
    const meta = this.#meta
    if (hs.length === 0 && meta && isServer(this.#P) && meta.servers.has(this.#P.id)) this.#s.k.leave(meta, this.#P)
    return true
  }
  async erase(_p: string): Promise<void> { throw new FeroError('config', { resource: this.name, message: 'erase is not built in the E-22 prototype (step 1)' }) }
}

/** the version of the last committed entry of partition p in g at or below `at` ('' if none) */
const lastVersionOf = (k: Kernel, g: Group, p: string, at: number): string => {
  const es = k.read(g, g.base, at)
  if (es === 'expired') return ''
  for (let i = es.length - 1; i >= 0; i--) { const e = es[i]; if (e.p === p && (e.k === 'w' || e.k === 'x')) return e.v }
  return ''
}

// ── read-through (P-04): one load per key per server, written with if: { absent } ───────────
const readThrough = (s: Stack, S: Proc, meta: ResMeta, key: string, then: () => void): void => {
  let inflight = S.state.get('loads') as Map<string, (() => void)[]> | undefined
  if (!inflight) { inflight = new Map(); S.state.set('loads', inflight) }
  const k = meta.name + '\u0000' + key
  const waiting = inflight.get(k)
  if (waiting) { waiting.push(then); return }
  inflight.set(k, [then])
  const done = (): void => { const ws = inflight!.get(k) ?? []; inflight!.delete(k); for (const f of ws) f() }
  let v: unknown
  try { v = meta.code.load(key, { now: () => S.clock() }) } catch (e) { s.l3.fault(S, e); done(); return }
  s.w.poke()
  Promise.resolve(v).then((row) => {
    if (row === undefined) { done(); return }
    const res = new ResourceImpl(s, S, meta.name, {})
    res.set(key, row, { if: { absent: true } }).then(done, done)
  }, (e) => { s.l3.fault(S, e); done() })
}

// ── methods (L4) ────────────────────────────────────────────────────────────
interface CallCtx {
  who: Who
  attempt(): string | undefined
  track(p: Promise<unknown>): void
  scope(lens: any): any
}
const callMethod = (s: Stack, P: Proc, name: string, method: string, arg: unknown, o: Record<string, any>): any => {
  const { w, k } = s
  const d = w.deferred<any>(P)
  const hist = w.record({ i: w.history.length, proc: P.id, res: name, op: `call:${method}`, arg, t0: w.time })
  const timeout = ms(o.timeout, 10_000)
  let mirror: any = null
  let stream: { stop(): void } | null = null
  let settled = false
  let tmo: { cancel(): void } | null = null
  const settle = (ok: boolean, v: unknown): void => {
    if (settled) return
    settled = true
    tmo?.cancel()
    Object.assign(hist, ok ? { t1: w.time, ok, value: v } : { t1: w.time, ok, code: (v as FeroError).code, outcome: (v as FeroError).outcome })
    if (ok) d.resolve(v); else d.reject(v)
  }
  let argCopy: unknown
  try { argCopy = wireCopy(arg) } catch (e) { settle(false, new FeroError('unencodable', { resource: name, reason: String((e as Error).message) })); return thenable(d.promise, () => null, () => {}) }
  let server: Proc | null = null
  tmo = w.after(timeout, P, `call-timeout ${method}`, () => {
    // an unkeyed call whose server died may have run: 'unknown'; else 'timeout'
    const code: Code = server && !server.alive && !o.key ? 'unknown' : 'timeout'
    settle(false, new FeroError(code, { resource: name, reason: `call ${method}` }))
  })
  const tryCall = (): void => {
    if (settled) return
    const meta = k.meta(name)
    const S = meta ? primaryOf(s, P, meta, (q) => !!handlesOf(q).get(name)?.length) : null
    if (!meta || !S) { w.after(BACKOFF0, P, `call-wait ${method}`, tryCall); return }
    server = S
    const callerWho: Who = { peer: P.id, claims: null, session: P.session }
    w.send(P, S, `call ${name}.${method}`, () => {
      runHandler(s, S, meta, method, argCopy, callerWho, o.key, o.ttl, (ans) => {
        w.send(S, P, `call-answer ${method}`, () => {
          if (ans.retry) { w.after(BACKOFF0, P, `call-retry ${method}`, tryCall); return }
          if (ans.err) { settle(false, ans.err); return }
          if (ans.view && mirror) {
            // the mirror's shape follows the view's: an ordered view (an array) needs an array-born source
            mirror.attach(source(Array.isArray(ans.value)))
            // the server streams the view's changes to this mirror (an opening whole value first), one hop each
            stream = ans.view((r: any) => w.send(S, P, `view-delta ${method}`, () => { if (mirror?.src) { ingest(mirror.src, [r], (e) => s.l3.fault(P, e)); w.poke() } }))
          }
          settle(true, ans.value)
        })
      }, () => mirror !== null)
    })
  }
  tryCall()
  return thenable(d.promise, () => {
    if (!mirror) mirror = liveMirror()
    return mirror.handle
  }, () => { stream?.stop(); mirror = null })
}
/** LiveCall.open()'s mirror: made when the first answer says the view's shape; taps registered
 *  before then are replayed onto it (see API-NOTES: open() cannot know the shape up front) */
const liveMirror = (): { src: any; handle: any; attach(src: any): void } => {
  const taps: ((...a: unknown[]) => void)[] = []
  const m: { src: any; handle: any; attach(src: any): void } = {
    src: null,
    attach(src) { m.src = src; for (const f of taps) src.tap(f) },
    handle: new Proxy(Object.create(null), {
      get(_t, prop) {
        if (prop === 'snapshot') return () => (m.src ? valueOf(m.src) : undefined)
        if (prop === 'tap' && !m.src) return (f: (...a: unknown[]) => void) => { taps.push(f); return m.handle }
        if (!m.src) throw new FeroError('shortfall', { message: 'the live view has not answered yet: await the call first, or tap() it' })
        const v = m.src[prop]
        return typeof v === 'function' ? v.bind(m.src) : v
      },
    }),
  }
  return m
}
const thenable = (p: Promise<any>, open: () => any, close: () => void): any => ({
  then: (a: any, b: any) => p.then(a, b),
  catch: (b: any) => p.catch(b),
  finally: (f: any) => p.finally(f),
  open,
  close,
})

interface HandlerAnswer { value?: unknown; err?: FeroError; retry?: boolean; view?: (fn: (r: unknown) => void) => { stop(): void } }
/** Run a handler on server S for a caller. A keyed call first claims its row in #calls (at most once
 *  within ttl; a retry gets the first result; a dead server's claim lapses and the call re-runs
 *  with the same attempt ids, ctx.now() and ctx.id()). */
const runHandler = (s: Stack, S: Proc, meta: ResMeta, method: string, arg: unknown, who: Who, key: string | undefined, ttl: unknown, answer: (a: HandlerAnswer) => void, wantsStream: () => boolean = () => false): void => {
  const { w } = s
  const fn = meta.code.methods?.[method]
  if (typeof fn !== 'function') { answer({ err: new FeroError('no-method', { resource: meta.name, reason: method }) }); return }
  const run = (t: number, base: string): void => {
    let n = 0, ids = 0
    const tracked: Promise<unknown>[] = []
    const ctxDef: CallCtx = {
      who,
      attempt: () => (key ? `${base}#${++n}` : undefined),
      track: (p) => { tracked.push(p.catch(() => {})) },
      scope: (l) => l,
    }
    const res = new ResourceImpl(s, S, meta.name, {}, ctxDef)
    const ctx: any = new Proxy(res, {
      get: (target, prop) => {
        switch (prop) {
          case 'peer': return who.peer
          case 'claims': return who.claims
          case 'session': return who.session
          case 'key': return key
          case 'now': return () => (key ? t : S.clock())
          case 'id': return () => (key ? `${base}.${(ids++).toString(36)}` : w.id())
          case 'flush': return () => Promise.all(tracked).then(() => undefined)
          case 'use': return (other: any) => new ResourceImpl(s, S, other.name, {}, ctxDef)
        }
        const v = (target as any)[prop]
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    let out: unknown
    try { out = fn(arg, ctx) } catch (e) { answer({ err: new FeroError('threw', { resource: meta.name, reason: String((e as Error)?.message ?? e) }) }); return }
    w.poke()
    Promise.resolve(out).then((v) => {
      if (isView(v)) {
        const snap = valueOf(v)
        answer({ value: deepFreeze(snap), view: wantsStream() ? (f) => records(v, (r) => f(r)) : undefined })
        return
      }
      let copy: unknown
      try { copy = wireCopy(v) } catch (e) { answer({ err: new FeroError('unencodable', { resource: meta.name, reason: String((e as Error).message) }) }); return }
      if (!key) { answer({ value: copy }); return }
      // a keyed call stores its result, so a retry within ttl gets this one
      const calls = sysRes(s, S, '#calls')
      calls.set(callRow(meta.name, method, key), { state: 'done', result: copy, t }, { ttl: ttl ?? '1d' }).then(() => answer({ value: copy }), () => answer({ value: copy }))
    }, (e) => answer({ err: new FeroError('threw', { resource: meta.name, reason: String((e as Error)?.message ?? e) }) }))
  }
  if (!key) { run(S.clock(), ''); return }
  // claim the call key in #calls
  const calls = sysRes(s, S, '#calls')
  const row = callRow(meta.name, method, key)
  const lease = 10_000
  const claim = (): void => {
    // the claim keeps the time the call runs at: a re-run elsewhere gets the same ctx.now()
    const t = S.clock()
    calls.set(row, { state: 'run', by: S.session, until: w.time + lease, t }, { if: { absent: true }, ttl: ttl ?? '1d' }).then(
      () => run(t, row),
      (e: FeroError) => {
        if (e.code !== 'conflict') { answer({ retry: true }); return }
        calls.get(row, { fresh: true, version: true }).then((got: any) => {
          const st = got?.value
          if (!st) { claim(); return }
          if (st.state === 'done') { answer({ value: st.result }); return }
          if (st.until > w.time) { w.after(BACKOFF0, S, `call-busy ${row}`, claim); return }
          // the claim lapsed (its server died): take it over and re-run with the same ids and time
          calls.set(row, { ...st, by: S.session, until: w.time + lease }, { if: { version: got.version } }).then(
            () => run(st.t ?? w.time, row), () => w.after(BACKOFF0, S, `call-retry ${row}`, claim))
        }, () => answer({ retry: true }))
      })
  }
  claim()
}
const callRow = (res: string, method: string, key: string): string => `${res}.${method}.${key}`

/** a system resource handle on process P (#calls, #sessions, #locks): created on first use */
export const sysRes = (s: Stack, P: Proc, name: string): ResourceImpl => {
  let meta = s.k.meta(name)
  if (!meta) {
    const servers = [...s.w.procs.values()].filter((q) => q.alive && isServer(q))
    const creator = isServer(P) ? P : servers[0] ?? P
    const opts = name === '#sessions' ? { rows: { ttl: s.w.keys['session.ms'] } } : {}
    meta = s.k.define(name, opts, {}, creator)
    for (const q of servers) if (q !== creator) s.k.join(meta, q)
  }
  return new ResourceImpl(s, P, name, {})
}

// ── sessions (P-13): a lease the process renews by itself ──────────────────────
const keepSession = (s: Stack, P: Proc): Promise<void> => {
  const have = P.state.get('session-keeper') as Promise<void> | undefined
  if (have) return have
  // resolves once the session's record has committed (a world promise: it keeps the world running)
  const first = s.w.deferred<void>(P)
  P.state.set('session-keeper', first.promise)
  const sessions = sysRes(s, P, '#sessions')
  const every = s.w.keys['session.ms'] / 3
  const beat = (): void => {
    if (!P.alive) return
    sessions.set(P.session, { proc: P.id }, { timeout: every }).then(() => first.resolve(), () => {})
    s.w.after(every, P, `session-renew ${P.id}`, beat, true)
  }
  beat()
  return first.promise
}

// ── cluster view ─────────────────────────────────────────────────────────────
const clusterView = (s: Stack, P: Proc, name: string): any => {
  const view: any = {
    snapshot: () => {
      const meta = s.k.meta(name)
      const health: any[] = []
      const groups: Record<string, any> = {}
      let writable = !!meta
      if (!meta) health.push({ kind: 'unplaced', severity: 'warn', since: s.w.time, message: `no server has defined '${name}' yet`, fix: 'start a server that opens it' })
      for (const g of meta?.groups ?? []) {
        const lead = g.leader !== null && s.w.time >= g.downUntil
        if (!lead) { writable = false; health.push({ kind: 'no-writer', severity: 'down', since: s.w.time, message: `${g.id} has no writer`, fix: 'wait for the election', group: g.id }) }
        const copies = meta!.opts.copies ?? s.w.keys['copies.default']
        if (g.voters.length < copies) health.push({ kind: 'one-voter', severity: 'warn', since: s.w.time, message: `${g.id} has ${g.voters.length} voter(s) of ${copies}`, fix: 'start more servers', group: g.id })
        let shares = 0
        for (let i = 0; i < 1024; i++) if (meta!.table[i] === g.n) shares++
        groups[g.id] = { voters: [...g.voters], learners: [], leader: g.leader, live: g.voters.filter((v) => s.w.proc(v).alive).length, lag: g.last - g.commit, shares, term: g.term, commit: g.commit }
      }
      const rep = meta ? s.l3.replicaIf(P, name) : undefined
      const lag = meta && rep ? Math.max(0, ...meta.groups.map((g, n) => g.commit - rep.feed.pos[n])) : 0
      const members: Record<string, any> = {}
      for (const q of s.w.procs.values()) if (q.node) members[q.id] = { listen: q.node.listen === false ? '' : q.id, roles: isServer(q) ? ['server'] : [], state: q.alive ? 'live' : 'gone', up: q.alive }
      return {
        id: `sim-${s.w.seed}`, project: 'sim', writable,
        me: { id: P.id, life: P.life, role: P.node?.role ?? 'client', listen: P.node?.listen ?? false, caughtUp: lag <= s.w.keys['lag.max'], lag, primary: meta && !isServer(P) ? primaryOf(s, P, meta)?.id ?? null : null },
        members, groups,
        numbers: { writesPerSec: 0, waitingWrites: ((P.state.get('writes') as WriteRow[] | undefined) ?? []).filter((x) => x.state === 'pending').length, lag, memory: rep?.bytes ?? 0, clients: 0 },
        health,
      }
    },
    tap: (fn: () => void) => {
      const meta = s.k.meta(name)
      const rep = meta ? s.l3.replica(P, meta) : undefined
      rep?.onEntry.add(() => fn())
      return view
    },
    writes: {
      snapshot: () => ((P.state.get('writes') as WriteRow[] | undefined) ?? []).filter((x) => x.res === name).map((x) => ({ ...x })),
      tap: (fn: () => void) => { view.tap(fn); return view.writes },
      lookup: (id: string) => lookup(s, P, name, id),
    },
  }
  return view
}
/** ask the writer how an attempt ended: committed, or unknown (refusals are never logged) */
const lookup = (s: Stack, P: Proc, name: string, id: string): Promise<any> => {
  const d = s.w.deferred<any>(P)
  const meta = s.k.meta(name)
  if (!meta) { d.resolve({ id, key: [], state: 'unknown' }); return d.promise }
  const row = ((P.state.get('writes') as WriteRow[] | undefined) ?? []).find((x) => x.id === id)
  const g = row ? s.k.groupOf(meta, s.k.slotOf(String((row.key as any)?.[0] ?? ''))) : meta.groups[0]
  const ask = (): void => {
    if (g.leader === null) { s.w.after(BACKOFF0, P, 'lookup-wait', ask); return }
    const L = s.w.proc(g.leader)
    s.w.send(P, L, `lookup ${id}`, () => {
      const wr = s.l2.writers.get(g.id)
      const at = wr?.attempts.get(id)
      const ans = at ? { id, key: row?.key ?? [], state: at.i === 0 || at.i <= g.commit ? 'committed' : 'pending', version: at.v } : { id, key: row?.key ?? [], state: row?.state === 'refused' ? 'refused' : 'unknown', code: row?.code }
      s.w.send(L, P, `lookup-answer ${id}`, () => d.resolve(ans))
    })
  }
  ask()
  return d.promise
}

// ── fero(name, opts), per process ─────────────────────────────────────────────
export const openResource = (P: Proc, name: string, opts: Opts = {}): Promise<ResourceImpl> => {
  const s = stackOf(P.world)
  const { w, k } = s
  // node scope: set by the first fero() in this process; a later one that differs is refused
  const role = roleOf(opts)
  const nodeOpts: Record<string, unknown> = {}
  for (const key of NODE_KEYS) if (opts[key] !== undefined) nodeOpts[key] = opts[key]
  if (!P.node) P.node = { role, listen: opts.listen ?? (role === 'client' ? false : P.id), opts: nodeOpts }
  else {
    for (const key of NODE_KEYS) {
      if (key === 'server' || key === 'listen') continue
      if (opts[key] !== undefined && JSON.stringify(opts[key]) !== JSON.stringify(P.node.opts[key]))
        return Promise.reject(new FeroError('node-config', { resource: name, reason: `${key} differs from this process's first fero()` }))
    }
    if (role !== 'client' && P.node.role === 'client') P.node.role = role
  }
  const resourceOpts: Record<string, unknown> = {}
  for (const key of RESOURCE_KEYS) if (opts[key] !== undefined) resourceOpts[key] = opts[key]
  if (resourceOpts.durability === 'none' && resourceOpts.rows !== false) return Promise.reject(new FeroError('config', { resource: name, reason: "durability 'none' needs rows: false" }))
  if (resourceOpts.copies !== undefined && ![1, 3, 5].includes(resourceOpts.copies as number)) return Promise.reject(new FeroError('config', { resource: name, reason: 'copies is 1, 3 or 5' }))
  const code: Record<string, unknown> = {}
  for (const key of ['methods', 'validation', 'schema', 'rules', 'load'] as const) if (opts[key] !== undefined) code[key] = opts[key]
  if (opts.rows && typeof opts.rows === 'object' && opts.rows.where) code.where = opts.rows.where
  if (opts.shape?.up) code.up = opts.shape.up
  // a system resource (#locks, #sessions, #calls) always exists: the first open creates it
  if (name.startsWith('#') && !k.meta(name)) sysRes(s, P, name)
  let meta = k.meta(name)
  const seeds: Promise<unknown>[] = []
  if (meta) {
    // a resource key you pass must equal the catalog's
    for (const [key, v] of Object.entries(resourceOpts)) {
      const a = JSON.stringify(v, fnRepl), b = JSON.stringify(meta.opts[key], fnRepl)
      if (a !== b) return Promise.reject(new FeroError('config-differs', { resource: name, reason: `${key}: the catalog has ${b}, this open passes ${a}` }))
    }
    if (isServer(P)) { Object.assign(meta.code, code); k.join(meta, P) }
  } else if (isServer(P)) {
    meta = k.define(name, resourceOpts, code, P)
    for (const q of w.procs.values()) if (q !== P && q.alive && isServer(q) && handlesOf(q).has(name)) k.join(meta, q)
    // the seed: applied once, when the resource is created; fero() answers once it has committed
    if (opts.data) {
      const seedRes = new ResourceImpl(s, P, name, {})
      for (const [key, row] of Object.entries(opts.data as Record<string, unknown>)) seeds.push(seedRes.set(key, row))
    }
  }
  const res = new ResourceImpl(s, P, name, opts)
  const hs = handlesOf(P)
  if (!hs.has(name)) hs.set(name, [])
  hs.get(name)!.push({ res, cacheLimit: res.cacheLimit })
  if (meta) s.l3.replica(P, meta, res.cacheLimit)
  // a server answers once its seed has committed; a client at once
  if (seeds.length === 0) return Promise.resolve(res)
  return Promise.all(seeds).then(() => res)
}
const fnRepl = (_k: string, v: unknown): unknown => (typeof v === 'function' ? `fn:${String(v)}` : v)

/** the fero() function bound to one process */
export const feroFor = (P: Proc): any => (name: string, opts?: Opts) => P.run(() => openResource(P, name, opts))

export { World, Proc, theWorld, boundWorld, stackOf as _stackOf, verIndex }
export type { LogEntry }
