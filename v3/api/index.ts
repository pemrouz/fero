//! ── api/index — the composer: fero(name, opts) → { data, methods, cluster, destroy } ──
// The whole public surface (plan §9, the v2 shape kept): zero events, zero hooks —
// everything reactive is a ViewProxy you connect or tap. Config recognition is by
// VALUE TYPE backed by a DECLARED schema: function-valued opts are methods (any
// name — no reserved-verb discipline), non-function values must be known FeroConfig
// keys, typos throw at fero() time. Function-valued CONFIG lives under the one
// reserved `seams` key so the recognition rule survives.
//
// M5a scope: the server/solo composer over the shell Runtime — data binding both
// directions with the cid-overlay (api/data.ts), the default write methods with
// {confirm, timeout} against the M4c guarantee ladder, restore-before-network when
// `dir` holds a previous life, and a minimal reactive cluster surface. The client
// role (M5b) and user-method dispatch (M5c) land next.

import { randomUUID } from 'node:crypto'
import { Runtime, restoreOpts, type RuntimeOpts } from '../shell/runtime.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import { REC, type Rec } from '../kernel/env.ts'
import { JK } from '../kernel/journal.ts'
import { Bind, type Coords } from './data.ts'
import { Caller, Host, SYSTEM, handle, type Context } from './methods.ts'
import { proxy, snapshot as snap, isProxy } from './substrate.ts'
import type { Change, Fero, FeroOpts, Guarantee, Methods, WriteOpts, WriteReject, WriteResolve } from './types.ts'

//! the declared config schema: PICKED keys, everything else is a loud error (plan §9)
const CONFIG_KEYS = new Set(['uuid', 'listen', 'hosts', 'dir', 'heartbeatMs', 'redialMs', 'journalCap', 'seams'])
const SEAM_KEYS = new Set(['validation'])

//! keyPath — normalize the Change.key sugar: 'user42' and ['user42','active'] are both paths.
const keyPath = (k: string | string[] | undefined): string[] =>
  k === undefined ? [] : Array.isArray(k) ? k.map(String) : [String(k)]

export const fero = async (name: string, opts: FeroOpts = {}): Promise<Fero> => {
  //! split by value type: functions → methods; the rest must be declared config
  const userMethods: Record<string, (...args: unknown[]) => unknown> = {}
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'function') {
      if (k.startsWith(SYSTEM)) throw new Error(`fero('${name}'): method names may not start with \\u0000 (reserved for the system plane)`)
      if (k === 'update' || k === 'insert' || k === 'remove') throw new Error(`fero('${name}'): '${k}' is a built-in writer — wrap it via seams.validation or name the method differently`)
      userMethods[k] = v as (...args: unknown[]) => unknown
    }
    else if (CONFIG_KEYS.has(k)) config[k] = v
    else throw new Error(`fero('${name}'): unknown option '${k}' — config keys are ${[...CONFIG_KEYS].join(', ')}; function values are methods`)
  }
  const seams = (config.seams ?? {}) as Record<string, unknown>
  for (const k of Object.keys(seams))
    if (!SEAM_KEYS.has(k)) throw new Error(`fero('${name}'): unknown seam '${k}' — M5a ships ${[...SEAM_KEYS].join(', ')}; hash/codec/storage land with their milestones`)

  //! role by shape (the v2 rule, kept): hosts without a listen address = a CLIENT — a spoke that can
  // never be dialed can never be a member. listen (with or without hosts) = a server; neither = solo.
  const isClient = !config.listen && Array.isArray(config.hosts) && (config.hosts as string[]).length > 0
  if (isClient && config.dir) throw new Error(`fero('${name}'): a durable client (dir on a spoke) is not supported yet — offline-first clients are tracked for M6`)
  const rtOpts: RuntimeOpts = {
    uuid: (config.uuid as string) ?? randomUUID().slice(0, 8),
    listen: config.listen as string | undefined,
    hosts: config.hosts as string[] | undefined,
    client: isClient || undefined,
    dir: config.dir as string | undefined,
    //! the KERNEL keeps heartbeats explicit (0 = off, the sweep mode); the COMPOSER is where production
    // defaults live: 500ms drives genesis/suspicion on servers and the write-retry clock + AE floor on
    // clients. Pass heartbeatMs: 0 to opt out.
    heartbeatMs: (config.heartbeatMs as number | undefined) ?? 500,
    redialMs: config.redialMs as number | undefined,
    journalCap: config.journalCap as number | undefined,
    //! restore-before-network: a dir holding a previous life boots as its heir (incarnation bumped,
    // clock leased, votedFor honored) — the composer makes the wal.test.ts idiom the default path
    ...(config.dir ? restoreOpts(config.dir as string) : {}),
  }
  const rt = new Runtime(rtOpts)
  //! the binding wires rt.onApply BEFORE restore, so the WAL replay refills the proxy. `tracked` is
  // late-bound to the method host (flush-on-return attribution — api/methods.ts).
  let host: Host | null = null
  const bind = new Bind(rt, {
    validate: seams.validation as ((rec: Rec) => true | string) | undefined,
    tracked: () => host?.tracked(),
  })
  if (config.dir) rt.restore()

  //! ── the confirm-probe multiplexer (M4c events under the methods surface) ──
  let probeSeq = 0
  const probes = new Map<number, (ok: boolean) => void>()
  rt.onConfirm = (id, ok) => { probes.get(id)?.(ok); probes.delete(id) }
  const probe = (c: Coords, level: number, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const id = ++probeSeq
      const t = setTimeout(() => {
        if (!probes.delete(id)) return
        rt.node.step({ kind: 'confirmCancel', id })
        resolve(false)
      }, ms)
      t.unref?.()
      probes.set(id, (ok) => { clearTimeout(t); resolve(ok) })
      rt.node.step({ kind: 'confirm', id, origin: c.origin, seq: c.seq, level })
    })

  //! ── the method plane (M5c): every node HOSTS (servers get invokes; a spoke none), clients CALL ──
  //! the built-in read: the whole resource or one child — subscribable by return type like any method
  const table: Record<string, (arg: unknown, ctx: Context) => unknown> = {
    read: (a, ctx) => (a == null ? ctx.data : ctx.data.get(String(a))),
    ...(userMethods as Record<string, (arg: unknown, ctx: Context) => unknown>),
  }
  //! the system plane: confirm-over-RPC — a spoke's ladder evidence is one digest wide (M5b residual),
  // so its probes run at the PRIMARY, which holds the full member evidence
  const system: Record<string, (arg: unknown, ctx: Context) => unknown> = {
    confirm: (a) => {
      const v = a as { o: string; s: number; l: number; t: number }
      return probe({ origin: v.o, seq: v.s, epoch: 0 }, v.l, Math.min(v.t ?? 8000, 60_000))
    },
  }
  host = new Host(rt, bind.data, table, system)
  const caller = isClient ? new Caller(rt) : null

  //! ── the default write methods: the SAME ingest as assignment, plus await surfaces ──
  const write = async (rec: Rec, o: WriteOpts = {}): Promise<WriteResolve> => {
    const want: Guarantee = o.confirm ?? 'committed'
    const ms = o.timeout ?? 10_000
    const r = bind.issue([rec], false)[0]
    if (typeof r === 'string') throw { guarantee: want, reached: 'issued', reason: r } satisfies WriteReject
    const coords = await Promise.race([
      r,
      new Promise<never>((_, rej) => setTimeout(() => rej({ guarantee: want, reached: 'issued', reason: 'timeout' } satisfies WriteReject), ms).unref?.()),
    ])
    const resolved: WriteResolve = { guarantee: 'committed', key: rec.key.length ? rec.key : [String(rec.at ?? '')], origin: coords.origin, seq: coords.seq, epoch: coords.epoch, cid: coords.cid }
    if (want === 'committed') return resolved
    const level = want === 'persisted' ? CONFIRM.persisted : CONFIRM.replicated
    //! a spoke proves its guarantee AT THE PRIMARY (system confirm) — its own evidence is one digest wide
    const ok = caller
      ? await caller.call(SYSTEM + 'confirm', { o: coords.origin, s: coords.seq, l: level, t: ms }, { timeout: ms, retry: true }).then((v) => v === true, () => false)
      : await probe(coords, level, ms)
    if (!ok) throw { guarantee: want, reached: 'committed', reason: 'timeout', localCommit: { origin: coords.origin, seq: coords.seq, epoch: coords.epoch } } satisfies WriteReject
    return { ...resolved, guarantee: want }
  }

  const methods = {
    update: (c: Change, o?: WriteOpts) => write({ type: REC.update, key: keyPath(c.key), value: c.value }, o),
    //! an insert without `at` mints its row key here (the substrate's proxy.insert mints too — the
    // wire needs the key BEFORE routing, so the api is the mint site for method-issued inserts)
    insert: (c: Change, o?: WriteOpts) => write({ type: REC.insert, key: keyPath(c.key), value: c.value, at: String(c.at ?? randomUUID()) }, o),
    remove: (c: Change, o?: WriteOpts) => write({ type: REC.remove, key: keyPath(c.key) }, o),
  } as Methods
  //! user methods + the built-in read. On a SERVER a call is a local one-shot invoke (value, or
  // SNAPSHOT of a returned proxy) — live local projections are `data` + operators directly, no wire
  // needed (v2's localMethods rule, kept). On a CLIENT the namespace is OPEN (a spoke cannot know the
  // servers' method names): ANY name yields the dual-mode Handle maker (await = one-shot CALL,
  // reactive touch = live subscription — api/methods.ts); unknown names reject typed FROM the server.
  if (!caller) {
    for (const m of Object.keys(table)) {
      methods[m] = async (a?: unknown) => {
        const ctx: Context = { data: bind.data, flush: async () => {} }
        const result = await table[m](a, ctx)
        return isProxy(result) ? snap(result) : result
      }
    }
  }
  const methodSurface = caller
    ? new Proxy(methods, {
        get(t, prop) {
          if (typeof prop !== 'string' || prop in t || prop === 'then') return (t as Record<string | symbol, unknown>)[prop]
          return (a?: unknown, o?: { timeout?: number; retry?: boolean }) => handle(caller, prop, a, o)
        },
      })
    : methods

  //! ── cluster: a real ViewProxy over the committed view + peers + me (M5a minimal) ──
  // Folded from the journal cursor after any step that emitted membership-relevant events; one
  // integer compare per event otherwise. M5d makes this end-to-end (writes ring, partitions).
  const node = rt.node
  const cluster: any = proxy({
    epoch: node.epoch,
    writable: node.membership.gate(node).open,
    members: {},
    peers: {},
    writes: {},
    me: { uuid: node.uuid, origin: node.uuid + '~' + node.incarnation, listen: (config.listen as string) ?? '' },
  })
  const FOLD = new Set<number>([JK.viewInstall, JK.evict, JK.gateOpen, JK.gateClose, JK.identified, JK.linkDown, JK.suspect, JK.start])
  let cursor = 0
  let lastPrimary = node.primary
  let lastOutcomes = 0
  const fold = () => {
    //! cluster.writes — the bounded confirm ring (plan §9; Q4 decided: pending rows are visible HERE,
    // never marked inside `data`): folded whole when the ring version moved, one compare otherwise
    if (bind.outcomes.n !== lastOutcomes) {
      lastOutcomes = bind.outcomes.n
      const rows: Record<string, unknown> = {}
      for (const [id, o] of bind.outcomes.rows) rows[id] = { ...o }
      cluster.writes = rows
    }
    const j = node.journal
    if (j.n === cursor) return
    const events = j.read(cursor)
    cursor = j.n
    //! method-plane housekeeping rides the same fold: dead links reap their served subscriptions
    // (the v2 leak guard), and a primary change fires the caller's failover policies (OQ2)
    for (const e of events) if (e.kind === JK.linkDown) host!.reapLink(e.a as number)
    if (caller && node.primary !== lastPrimary) {
      lastPrimary = node.primary
      if (node.primary !== null) caller.onPrimaryChange()
    }
    if (!events.some((e) => FOLD.has(e.kind))) return
    cluster.epoch = node.epoch
    cluster.writable = node.membership.gate(node).open
    cluster.members = Object.fromEntries(node.membership.view.members)
    const peers: Record<string, { uuid: string; incarnation: number; up: boolean }> = {}
    for (const l of node.links.values())
      if (l.uuid && !l.dead) peers[l.uuid] = { uuid: l.uuid, incarnation: l.incarnation, up: true }
    cluster.peers = peers
  }
  rt.hook(fold)

  await rt.start()
  fold()

  return {
    name,
    data: bind.data,
    methods: methodSurface,
    cluster,
    async destroy() {
      bind.destroy()
      host!.destroy()
      caller?.destroy()
      //! settle in-flight confirm probes honestly (false = could not prove in time) — never hang a caller
      for (const [, settle] of probes) settle(false)
      probes.clear()
      await rt.destroy()
    },
  }
}

export type { Fero, FeroOpts, Guarantee, WriteResolve, WriteReject, Change, WriteOpts, Methods } from './types.ts'
