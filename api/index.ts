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
import { REC, partitionOf, type Rec } from '../kernel/env.ts'
import { JK } from '../kernel/journal.ts'
import { Bind, type Coords } from './data.ts'
import { Caller, Host, SYSTEM, handle, type Context } from './methods.ts'
import { Gather, rowsPartial, liveCadence, type Rows } from './fold.ts'
import { proxy, contract } from './substrate.ts'
import { diagnostics, type Diagnostics } from './diagnostics.ts'
import { compact, frontier, gcTombstones } from '../kernel/log.ts'
import { captureNode } from '../tools/debug/capture.ts'
import type { Change, Fero, FeroOpts, Guarantee, Methods, WriteOpts, WriteReject, WriteResolve } from './types.ts'

//! the declared config schema: PICKED keys, everything else is a loud error (plan §9)
const CONFIG_KEYS = new Set(['uuid', 'listen', 'hosts', 'dir', 'heartbeatMs', 'redialMs', 'journalCap', 'replicas', 'seams'])
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
  //! replicas (M6): declared config, validated loudly — an integer R ≥ 1, servers only (a spoke
  // holds nothing to scope; it follows whatever the cluster replicates)
  if (config.replicas !== undefined) {
    if (!Number.isInteger(config.replicas) || (config.replicas as number) < 1)
      throw new Error(`fero('${name}'): replicas must be an integer ≥ 1 (omit for full replication)`)
    if (isClient) throw new Error(`fero('${name}'): replicas is a server-side setting — a client follows the cluster's scoping`)
  }
  //! uuid discipline (v4.1): the string is validated (an empty uuid, or one containing '~' — the
  // incarnation-lane separator — could alias another node's lane in origin-string space), and a
  // durable dir's RESTORED identity beats the random default: fero(name, {dir}) with uuid omitted
  // boots as the SAME node every life. A user-supplied uuid that contradicts the dir throws loudly —
  // adopting a foreign log under a new name is the silent evicted-heir bug, never a default.
  if (config.uuid !== undefined && (typeof config.uuid !== 'string' || config.uuid === '' || config.uuid.includes('~')))
    throw new Error(`fero('${name}'): uuid must be a non-empty string without '~' (the incarnation-lane separator)`)
  //! restore-before-network: a dir holding a previous life boots as its heir (identity recovered,
  // incarnation bumped, clock leased, votedFor honored) — the composer makes the wal.test.ts idiom
  // the default path
  const restored = config.dir ? restoreOpts(config.dir as string) : {}
  if (config.uuid !== undefined && restored.uuid !== undefined && config.uuid !== restored.uuid)
    throw new Error(`fero('${name}'): uuid '${config.uuid as string}' does not match this dir's previous life '${restored.uuid}' — one dir, one identity (use a fresh dir for a new node)`)
  const rtOpts: RuntimeOpts = {
    uuid: (config.uuid as string) ?? restored.uuid ?? randomUUID().slice(0, 8),
    //! the resource name rides HELLO (v4.1): a misdial onto another resource's port refuses loudly
    // (JK.nameReject) instead of silently cross-replicating two unrelated logs
    name,
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
    ...(config.replicas !== undefined ? { replicas: config.replicas as number } : {}),
    ...(restored.boot !== undefined ? { boot: restored.boot } : {}),
    ...(restored.incarnation !== undefined ? { incarnation: restored.incarnation } : {}),
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
  const probe = (c: Coords, level: number, ms: number, part?: string): Promise<boolean> =>
    new Promise((resolve) => {
      const id = ++probeSeq
      const t = setTimeout(() => {
        if (!probes.delete(id)) return
        rt.node.step({ kind: 'confirmCancel', id })
        resolve(false)
      }, ms)
      t.unref?.()
      probes.set(id, (ok) => { clearTimeout(t); resolve(ok) })
      rt.node.step({ kind: 'confirm', id, origin: c.origin, seq: c.seq, level, part })
    })

  //! ── the method plane (M5c): every node HOSTS (servers get invokes; a spoke none), clients CALL ──
  //! M6: scoped servers get a MEMBER caller (rpc `to` routing) — the gather's fan-out and the
  // non-held remote read ride the same method plane a client uses; one Caller per node either way.
  const node = rt.node
  const scoped = !isClient && typeof config.replicas === 'number'
  const memberCaller = scoped ? new Caller(rt) : null
  //! the gather (M6, DESIGN-M6 C5): whole-resource read() under scoping — memoized, ONE per node,
  // and LAZY (M6-review finding 41): constructed on FIRST consumption (read() / `await data`), so a
  // scoped server whose union nobody ever reads never fans out N² full-claims downloads on view
  // installs — the install-triggered refresh below fires only once `gather` is non-null.
  let gather: Gather | null = null
  const gatherOf = (): Gather =>
    (gather ??= new Gather(rt, (uuid, t) => memberCaller!.call(SYSTEM + 'rows', undefined, { timeout: t, to: uuid }) as Promise<Rows>))

  //! ── the scoped data facade (M6, DESIGN-M6 C6): §9's promise — an expression means the same at
  // R=2 and R=∞, TYPED ERRORS, never a silent partial. Operators would fold the held SHARD as if it
  // were the resource: they throw ScopedError with the materialize-first hint (the distributed
  // decomposable folds are deferred by de-scoping rung 2 — recorded at slice 5). `await data` routes
  // through the gather; a non-held key access returns a typed one-shot remote handle (await = the
  // owner's value); held keys and writes pass straight through to the raw proxy. Built BEFORE the
  // Host so handlers receive it as ctx.data (M6-review finding 4 — see below).
  //! the operator set comes from data's exportContract() (DESIGN-DATA3 W17 promise: fero
  // deletes its hand-copied operator lists — drift with data's registry is now impossible)
  const OPERATORS = new Set(Object.keys(contract().operators))
  const scopedThrow = (op: string, reason: 'holistic' | 'shortfall', hint: string, partition?: string): never => {
    throw { scoped: true, op, reason, replicas: node.replicas, ...(partition !== undefined ? { partition } : {}), hint } satisfies import('./types.ts').ScopedError
  }
  //! keyedRead — the ONE keyed-read routing every internal path shares (the remote-key handle, the
  // built-in read's non-held leg, the SYSTEM-plane hop). M6-review finding 5: the hop dispatches
  // SYSTEM + 'read', never the user-claimable 'read' name — a user-supplied `read` method can no
  // longer intercept `await data.<key>` or the owner-routed keyed read. M6-review finding 15: when
  // THIS node is the resolved owner but the entry is still ACQUIRING (state 2), the raw base would
  // answer a silent undefined (§9's banned answer) — defer on a short poll (the handover is
  // heartbeat-paced) until the entry leaves acquiring, bounded at ~2s, then serve; past the bound,
  // typed shortfall with the retry hint. The handler always runs on the resolved owner, so this one
  // guard site covers the local first-hop and the remote answer alike.
  const keyedRead = async (k: string): Promise<unknown> => {
    if (scoped && node.armed && !node.scope!.held(k)) {
      //! the ring must be BUILT for the committed epoch before ownerOf answers (the fix-round pin
      // caught a stale ring answering self-owns-everything here — the hop never left the node and
      // the non-held read fell through to a silent local undefined, §9's banned answer)
      const ring = node.writes.ring
      if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
      const owner = ring.ownerOf(k)
      if (owner && owner !== node.uuid)
        return memberCaller!.call(SYSTEM + 'read', k, { timeout: 8000, to: owner })
      //! THIS node is the owner but does not hold k — the handover windows (finding 15 and its
      // pre-latch sibling the fix-round pin caught): ACQUIRING (base mid-latch), ENTRY-ABSENT
      // (assigned but not yet offered — the liveness rounds close it within a tick or two), and
      // the data-at-an-unshed-ORPHAN window (an epoch-0 writer whose broadcast reached nobody
      // still CLAIMS until its shed proves coverage). One mechanism answers all three honestly:
      // THE GATHER — parked claims include every unshed orphan's, absence is attested by the full
      // holder set, and an unreachable member is a typed error, never a silent partial. A truly
      // absent key answers fast (one fan-out round-trip); a local-shard undefined never leaks.
      const union = await gatherOf().refresh(rt, { throwOnPartial: true }) as Record<string, unknown>
      return union[k]
    }
    return bind.data.get(k)
  }
  const remoteKey = (k: string): unknown => new Proxy(Object.freeze({}), {
    get(_, prop) {
      if (prop === 'then') {
        //! the one-shot fetch rides keyedRead — the SYSTEM plane + the acquiring-owner guard
        // (M6-review findings 5/15), never the public 'read' dispatch
        return (F?: (v: unknown) => unknown, R?: (e: unknown) => unknown) => keyedRead(k).then(F, R)
      }
      if (prop === Symbol.toStringTag) return 'FeroRemoteKey'
      if (typeof prop === 'symbol') return undefined
      return scopedThrow('get', 'shortfall', `'${k}' lives on its holders — await data.${k} (or methods.read('${k}')) for the value`, k)
    },
  })
  const dataSurface = !scoped ? bind.data : new Proxy(bind.data, {
    get(t, prop, r) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, r)
      if (prop === 'then') {
        //! `await data` means the RESOURCE — the gather, never the shard (typed reject on shortfall)
        return (F?: (v: unknown) => unknown, R?: (e: unknown) => unknown) => gatherOf().refresh(rt, { throwOnPartial: true }).then(F, R)
      }
      if (OPERATORS.has(prop)) return scopedThrow(prop, 'holistic', 'materialize first: (await methods.read()).' + prop + '(…) — or define a derived resource')
      if (prop === 'get') return (k: unknown) => (!node.armed || node.scope!.held(String(k)) ? t[String(k)] : remoteKey(String(k)))
      if (!node.armed || node.scope!.held(prop)) return Reflect.get(t, prop, r)
      return remoteKey(prop)
    },
  })

  //! the built-in read: the whole resource or one child — subscribable by return type like any
  // method. Scoped + no key = THE GATHER (v2 Q3: read() IS the download): one-shot on CALL, the
  // live parked-union proxy on SUB (ctx.live — re-gathered on installs + a paced tick).
  const table: Record<string, (arg: unknown, ctx: Context) => unknown> = {
    read: (a, ctx) => {
      if (a != null) {
        //! a keyed read on a scoped node for a NON-HELD partition routes to the owner (one hop) —
        // the same answer at R=2 and R=∞, never a silent local undefined (plan §9). The routed hop
        // travels keyedRead (SYSTEM plane + acquiring guard — M6-review findings 5/15); the held/
        // unscoped case stays a SYNC child read so a keyed SUB still streams a live proxy.
        const k = String(a)
        if (scoped && node.armed && !node.scope!.held(k)) return keyedRead(k)
        return ctx.data.get(k)
      }
      if (!scoped || !node.armed) return ctx.data
      //! the live cadence is FLOORED (M6-review finding 9): heartbeatMs: 0 is the documented
      // heartbeat opt-out, not a request for a ~1ms full-cluster refresh storm
      if (ctx.live) { const g = gatherOf(); g.live(liveCadence(config.heartbeatMs as number | undefined)); return g.proxy }
      return gatherOf().refresh(rt, { throwOnPartial: true })
    },
    ...(userMethods as Record<string, (arg: unknown, ctx: Context) => unknown>),
  }
  //! the system plane: confirm-over-RPC — a spoke's ladder evidence is one digest wide (M5b residual),
  // so its probes run at the PRIMARY, which holds the full member evidence. `rows` (M6) answers the
  // gather fan-out with this node's stamped claims (held ∪ orphan — an orphan claims until shed).
  // `read` (M6-review finding 5) is the KEYED read the internal machinery dispatches — off the
  // user-claimable namespace, so a user method named 'read' only ever changes the PUBLIC dispatch.
  const system: Record<string, (arg: unknown, ctx: Context) => unknown> = {
    confirm: (a) => {
      const v = a as { o: string; s: number; l: number; t: number; pt?: string }
      return probe({ origin: v.o, seq: v.s, epoch: 0 }, v.l, Math.min(v.t ?? 8000, 60_000), v.pt)
    },
    rows: () => rowsPartial(rt),
    read: (a) => keyedRead(String(a)),
  }
  //! the Host receives the SCOPED facade as ctx.data (M6-review finding 4): a handler's
  // `ctx.data[id]` / `ctx.data.filter(…)` must mean the same as the public surface — typed
  // routing/refusal, never a silent shard read. Unscoped servers: dataSurface IS bind.data,
  // byte-identical to before.
  host = new Host(rt, dataSurface, table, system)
  const caller = isClient ? new Caller(rt) : null

  //! ── the default write methods: the SAME ingest as assignment, plus await surfaces ──
  const write = async (rec: Rec, o: WriteOpts = {}): Promise<WriteResolve> => {
    const want: Guarantee = o.confirm ?? 'committed'
    const ms = o.timeout ?? 10_000
    const r = bind.issue([rec], false)[0]
    if (typeof r === 'string') throw { guarantee: want, reached: 'issued', reason: r } satisfies WriteReject
    //! the timeout timer is CAPTURED and CLEARED on settle (M5-review #3: the bare setTimeout leaked one
    // live timer + reject closure per write for the full `ms` on the hot path). And a POST-ISSUE kernel
    // reject ('superseded'/'dropped'/'destroyed') is normalized to a typed WriteReject (M5-review #9:
    // the bare string escaped the WriteReject contract). Only the coordinate resolution races the timer.
    let timer: ReturnType<typeof setTimeout>
    const coords = await new Promise<Coords>((resolve, reject) => {
      timer = setTimeout(() => reject({ guarantee: want, reached: 'issued', reason: 'timeout' } satisfies WriteReject), ms)
      timer.unref?.()
      ;(r as Promise<Coords>).then(resolve, (e) =>
        reject(typeof e === 'string' ? ({ guarantee: want, reached: 'issued', reason: e } satisfies WriteReject) : e))
    }).finally(() => clearTimeout(timer))
    const resolved: WriteResolve = { guarantee: 'committed', key: rec.key.length ? rec.key : [String(rec.at ?? '')], origin: coords.origin, seq: coords.seq, epoch: coords.epoch, cid: coords.cid }
    if (want === 'committed') return resolved
    const level = want === 'persisted' ? CONFIRM.persisted : CONFIRM.replicated
    //! a spoke proves its guarantee AT THE PRIMARY (system confirm) — its own evidence is one digest
    // wide. `pt` (M6): the partition rides along so an armed prover ranges the probe over the R-set.
    const pt = partitionOf(rec)
    const ok = caller
      ? await caller.call(SYSTEM + 'confirm', { o: coords.origin, s: coords.seq, l: level, t: ms, pt }, { timeout: ms, retry: true }).then((v) => v === true, () => false)
      : await probe(coords, level, ms, pt)
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
  //! user methods + the built-in read. On a SERVER a call routes through host.invokeLocal — the SAME
  // flush-on-return + non-blind-await + proxy-collapse (with a CLONE) as a wire CALL, so local and
  // remote invocation of the same handler are indistinguishable (M5-review #5/#10). Live local
  // projections are `data` + operators directly, no method needed. On a CLIENT the namespace is OPEN
  // (a spoke cannot know the servers' method names): ANY name yields the dual-mode Handle maker
  // (await = one-shot CALL, reactive touch = live subscription); unknown names reject typed FROM the server.
  if (!caller) {
    for (const m of Object.keys(table)) methods[m] = (a?: unknown) => host!.invokeLocal(m, a)
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
  //! cluster.partitions (M6, DESIGN-M6 C9): bounded local scalars, zeros while unscoped. The scope
  // tallies + shedWaitingOn fold from the kernel scope map once slice 4 wires JK 59-63; until then
  // the row is a truthful projection of "nothing is scoped on this node".
  let acquiredEver = 0
  let shedEver = 0
  const partitionsRow = () => {
    const t = node.scope?.tallies() ?? { held: 0, acquiring: 0, orphaned: 0 }
    return {
      replicas: node.replicas,
      epoch: node.epoch,
      w: node.replicas > 0 ? (Math.min(node.replicas, Math.max(node.membership.view.members.length, 1)) >> 1) + 1 : 0,
      held: t.held, acquiring: t.acquiring, orphaned: t.orphaned,
      acquired: acquiredEver, shed: shedEver,
      shedWaitingOn: node.armed ? node.scope!.shedWaitingOn(node) : [] as string[],
    }
  }
  const cluster: any = proxy({
    epoch: node.epoch,
    writable: node.membership.gate(node).open,
    members: {},
    peers: {},
    writes: {},
    me: { uuid: node.uuid, origin: node.uuid + '~' + node.incarnation, listen: (config.listen as string) ?? '' },
    partitions: partitionsRow(),
  })
  const FOLD = new Set<number>([JK.viewInstall, JK.evict, JK.gateOpen, JK.gateClose, JK.identified, JK.linkDown, JK.suspect, JK.start,
    //! M6: the scope lifecycle re-folds cluster.partitions (tallies + lifetime counters + the H7 surface)
    JK.shed, JK.acquire, JK.orphaned, JK.acquireStart, JK.acquireAbort, JK.shedStall])
  let cursor = 0
  let lastPrimary = node.primary
  let lastOutcomes = 0
  let lastScopeN = -1
  const fold = () => {
    //! cluster.writes — the bounded confirm ring (plan §9; Q4 decided: pending rows are visible HERE,
    // never marked inside `data`): folded whole when the ring version moved, one compare otherwise
    if (bind.outcomes.n !== lastOutcomes) {
      lastOutcomes = bind.outcomes.n
      const rows: Record<string, unknown> = {}
      for (const [id, o] of bind.outcomes.rows) rows[id] = { ...o }
      cluster.set('writes', rows)
    }
    const j = node.journal
    let refold = false
    if (j.n !== cursor) {
      const events = j.read(cursor)
      cursor = j.n
      //! method-plane housekeeping rides the same fold: dead links reap their served subscriptions
      // (the v2 leak guard), and a primary change fires the caller's failover policies (OQ2)
      for (const e of events) {
        if (e.kind === JK.linkDown) host!.reapLink(e.a as number)
        //! M6: the kernel shed a partition — mirror it out of the proxy (ONE synthesized subtree
        // remove, echo pre-consumed: nothing re-issues) and count the lifetime tallies
        else if (e.kind === JK.shed) { shedEver++; bind.shedPartition(String(e.a)) }
        else if (e.kind === JK.acquire) acquiredEver++
        //! M6: a view install re-gathers the LIVE union against the new ring (the Q3a leg) — but
        // ONLY when the gather was ever consumed (M6-review finding 41): `gather` stays null until
        // read()/`await data` materializes it, so an idle scoped cluster pays nothing on churn
        else if (e.kind === JK.viewInstall && gather) void gather.refresh(rt, { throwOnPartial: false }).catch(() => {})
      }
      if (caller && node.primary !== lastPrimary) {
        lastPrimary = node.primary
        if (node.primary !== null) caller.onPrimaryChange()
      }
      if (events.some((e) => FOLD.has(e.kind))) {
        refold = true
        cluster.set('epoch', node.epoch)
        cluster.set('writable', node.membership.gate(node).open)
        cluster.set('members', Object.fromEntries(node.membership.view.members))
        const peers: Record<string, { uuid: string; incarnation: number; up: boolean }> = {}
        for (const l of node.links.values())
          if (l.uuid && !l.dead) peers[l.uuid] = { uuid: l.uuid, incarnation: l.incarnation, up: true }
        cluster.set('peers', peers)
      }
    }
    //! cluster.partitions: ONE O(P) recompute per fold() invocation, AFTER the event loop (M6-review
    // finding 42: the tallies + shedWaitingOn walk used to run once for the scope.n drift check and
    // AGAIN in the FOLD branch — coalesced here so each fold pays the walk at most once, and the row
    // still reflects the final post-step state). The scope.n compare catches tally drift that
    // journals nothing (held-mints at the gate/stamp site) — one int compare on the hot path.
    if (refold || (node.scope !== null && node.scope.n !== lastScopeN)) {
      if (node.scope) lastScopeN = node.scope.n
      cluster.set('partitions', partitionsRow())
    }
  }
  rt.hook(fold)

  await rt.start()
  fold()

  const inst: Fero = {
    name,
    data: dataSurface,
    methods: methodSurface,
    cluster,
    async destroy() {
      bind.destroy()
      host!.destroy()
      caller?.destroy()
      memberCaller?.destroy()
      gather?.destroy()
      //! settle in-flight confirm probes honestly (false = could not prove in time) — never hang a caller
      for (const [, settle] of probes) settle(false)
      probes.clear()
      await rt.destroy()
    },
  }
  //! [diagnostics] (M7, DESIGN-M7 §3): the Symbol-keyed internals seam — attached WITHOUT widening the
  // typed Fero surface (diag() in api/diagnostics.ts is the one sanctioned door). Every member is a
  // pull or a bounded effect; nothing here runs unless called, so the instance's hot paths are untouched.
  const diagHandle: Diagnostics = {
    capture: () => captureNode(node),
    journal: (from = 0) => ({ n: node.journal.n, dropped: node.journal.dropped, events: node.journal.read(from) }),
    served: () => host!.served,
    confirms: () => ({ api: probes.size, kernel: node.confirm.inflight }),
    logSize: () => { let n = 0; for (const [, entries] of node.logs) n += entries.length; return n },
    compact: () => {
      //! honest refusals (DESIGN-M7 §3, the panel's shared-defect fix): 0 on an ARMED node — compaction
      // is PINNED under scoping (the member-ranged frontier says nothing about a holder's possession;
      // forcing it here would be a diagnostics member that can cause real data loss) — and 0 after
      // destroy. Otherwise the REAL pass, size-gate-free (v2's drive-it-deterministically purpose).
      if (node.armed || node.destroyed) return 0
      let d = 0
      for (const o of [...node.logs.keys()]) d += compact(node, o, frontier(node, o))
      d += gcTombstones(node)
      fold() // compaction ran OUTSIDE node.step — the composer's hook wraps step only, so fold by hand
      return d
    },
    drop: (uuid: string) => rt.drop(uuid),
  }
  ;(inst as Fero & { [diagnostics]?: Diagnostics })[diagnostics] = diagHandle
  return inst
}

export type { Fero, FeroOpts, Guarantee, WriteResolve, WriteReject, Change, WriteOpts, Methods, Partitions, ScopedError } from './types.ts'
