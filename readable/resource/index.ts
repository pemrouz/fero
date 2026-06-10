// L2 public surface: fero(name, opts) → { data, methods, cluster, destroy } — the whole library in one call.

import { $, view as VIEWSYM } from '../../data/index.ts'
import { transport, type Mesh, type TransportOpts } from '../transport/index.ts'
import { Log, originKey, versionKey } from '../log/log.ts'
import { applyRecord } from '../log/index.ts'
import { partitionOf, type ChangeRecord } from '../transport/message.ts'
import { ViewManager } from './membership.ts'
import { makeFold } from './fold.ts'
import { makeDispatch } from './dispatch.ts'
import { makeSnapshot, peerValue, type InspectSnapshot } from './inspect.ts'
import { makeObserve, type Observe, type ObserveOpts } from './observe.ts'

export { value } from '../../data/index.ts'
export { fileStorage } from './storage.ts'

export type Method = (arg: any, context: Context) => any

// Cluster surface: peers + identity + ownership/replica queries + the committed view (epoch/members/writable).
export type Cluster = {
  peers: any
  readonly me?: string
  uuid: string
  owner: (key: string) => string | undefined
  replicas: (key: string) => string[]
  readonly epoch: number
  readonly members: string[]
  readonly writable: boolean
}

// Context: the second arg every method receives — data/cluster/methods/log/name + the calling peer (routed RPC).
export type Context = {
  data: any
  cluster: Cluster
  methods: Record<string, (arg?: any) => any>
  log: Log
  name: string
  peer?: any
}

// Fero: the returned instance — the three reactive surfaces + teardown.
export type Fero = {
  data: any
  methods: Record<string, (arg?: any) => any>
  cluster: Cluster
  destroy: () => void
}

// Storage: the durable-log seam (plan §4) — load() replays at boot, append() persists each accepted record.
export type Storage = {
  load: () => ChangeRecord[] | Promise<ChangeRecord[]>
  append: (record: ChangeRecord) => void
}

// FeroOpts: method functions + resource config + transport opts (minus name/onRecord) + optional storage.
export type FeroOpts = Record<string, unknown> & Partial<Omit<TransportOpts, 'name' | 'onRecord'>> & { storage?: Storage }

// norm: coerce a record key (array path or bare scalar sugar) to a path array.
const norm = (k: unknown): (string | number)[] =>
  Array.isArray(k) ? k : k == null ? [] : [k as string | number]

// setPath/delPath: walk the proxy tree and assign/delete the leaf, so the set/delete trap emits one record.
function setPath(data: any, path: (string | number)[], value: unknown) {
  if (path.length === 0) return
  let o = data
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]]
  o[path[path.length - 1]] = value
}
function delPath(data: any, path: (string | number)[]) {
  if (path.length === 0) return
  let o = data
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]]
  delete o[path[path.length - 1]]
}

// fero(name, opts): compose L0 mesh + L1 records into the three surfaces; await = ready (plan §1).
export async function fero(name: string, opts: FeroOpts = {}): Promise<Fero> {

  // ── 0 · config: methods/config split + replication factor ──
  const methods: Record<string, Method> = {}
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'function') methods[k] = v as Method
    else config[k] = v
  }

  // R = replication factor (Milestone P): finite ⇒ scoped per-partition holding; default ∞ ⇒ full replication.
  const R = typeof config.replicas === 'number' ? (config.replicas as number) : Infinity
  delete (config as any).replicas
  config.dht = { ...((config.dht as Record<string, unknown>) ?? {}), replicas: R }
  const scoped = R !== Infinity
  // antiEntropyMs: periodic anti-entropy interval driving scoped acquisition + drift healing (resync below).
  const antiEntropyMs = typeof config.antiEntropy === 'number' ? (config.antiEntropy as number) : 1000
  delete (config as any).antiEntropy
  // compactMs: periodic log-compaction interval (collapse superseded same-key updates); 0 disables. Both replication modes.
  const compactMs =
    config.compact === false ? 0 : typeof config.compact === 'number' ? (config.compact as number) : 30_000
  delete (config as any).compact

  // observe: opt-in L4 diagnostics — registers the wire-reachable __inspect pull method (off by default; trust boundary in ../IDEAS.md).
  const observeOpt = config.observe
  delete (config as any).observe
  const observeOn = observeOpt === true || (typeof observeOpt === 'object' && observeOpt !== null)
  // observeVerbose: also stream dedup-drops (the highest-frequency, least-useful event) — OFF by default even when observe is on (plan §6).
  const observeVerbose = typeof observeOpt === 'object' && observeOpt !== null && (observeOpt as ObserveOpts).verbose === true
  // snapshot: forward-declared so `defaults.__inspect` can close over it; assigned after dispatch (its servedCount dep) exists.
  let snapshot: () => InspectSnapshot = () => {
    throw new Error('fero: inspect snapshot not ready')
  }

  // ── 1 · replication core: state (proxy = truth, log = history) + provenance + dedup + LWW ──
  const log = new Log({ scoped })
  const data = $({})
  const res = (data as any)[VIEWSYM].res

  let clock = 0 // this node's Lamport clock; local writes stamp ++clock so a local write always wins LWW
  // seen: per-seenKey dedup high-water marks; doubles as the anti-entropy digest a node ships.
  const seen = new Map<string, number>()
  // versions: keyPath → current LWW winner stamp, MUTATED in place on re-write (zero steady-state alloc).
  const versions = new Map<string, { epoch: number; seq: number; origin: string }>()
  // pending: write-gate buffer (V1e) — writes held while quorum-less, flushed on quorum return; bounded drop-oldest.
  const pending: ChangeRecord[] = []
  const MAX_PENDING = 10_000

  // versionKey (imported from log/log.ts): the key a record contends on for LWW — shared with the log so compaction collapses EXACTLY the records LWW treats as one cell.

  // seenKey: provenance key for dedup/catch-up — origin alone (full) or (origin,partition) (scoped).
  const seenKey = scoped
    ? (origin: string, p: string): string => originKey(origin, p)
    : (origin: string, _p: string): string => origin

  // applying: guard set while applying an inbound record, so its sink re-emission isn't re-logged/re-broadcast.
  let applying = false
  // committingForward: guard so an applied forwarded write commits as-is, never re-evaluating ownership.
  let committingForward = false

  // observe: the L4 push-hook gate — null until the first __observe subscriber arms it, nulled again when the last one leaves (zero-cost when unwatched).
  let observe: Observe | undefined
  // buildObserve: lazily construct + arm the push-hook for ONE subscriber; returns the proxy to stream + the close that disarms the gate on the last detach.
  const buildObserve = () => {
    const inst = (observe ??= makeObserve(typeof observeOpt === 'object' && observeOpt !== null ? (observeOpt as ObserveOpts) : {}))
    inst.attach()
    let closed = false
    return {
      proxy: inst.proxy,
      close: () => {
        if (closed) return
        closed = true
        if (inst.detach() && observe === inst) observe = undefined
      },
    }
  }

  // applyInbound: dedup → Lamport-merge → epoch-skip | log → LWW-resolve → apply winner; shared by replication + restore replay.
  const applyInbound = (record: ChangeRecord) => {
    const origin = record.origin
    if (origin !== undefined) {
      const sk = seenKey(origin, partitionOf(record))
      const n = record.seq ?? 0
      if (n <= (seen.get(sk) ?? 0)) {
        if (observeVerbose) observe?.onRecord(record, 'dropped')
        return
      }
      seen.set(sk, n)
      if (n > clock) clock = n
      const e = record.epoch ?? 0
      const key = versionKey(record)
      const cur = versions.get(key)
      // Epoch-aware catch-up: a STRICTLY-lower-epoch record is a permanent loser (epoch fence) — skip logging AND applying.
      if (cur && e < cur.epoch) {
        observe?.onRecord(record, 'lost', { we: cur.epoch, ws: cur.seq })
        return
      }
      log.append(record)
      // LWW resolve, lexicographic (epoch, seq, origin): epoch fences stale views, seq then origin decide; a same-epoch loser stays logged.
      if (cur && !(e > cur.epoch || (e === cur.epoch && (n > cur.seq || (n === cur.seq && origin > cur.origin))))) {
        observe?.onRecord(record, 'lost', { we: cur.epoch, ws: cur.seq })
        return
      }
      if (cur) {
        cur.epoch = e
        cur.seq = n
        cur.origin = origin
      } else versions.set(key, { epoch: e, seq: n, origin })
      observe?.onRecord(record, 'won')
    } else {
      log.append(record)
    }
    applying = true
    try {
      applyRecord(res, record)
    } finally {
      applying = false
    }
  }

  // ── 2 · durable restore + transport mesh ──
  const storage = config.storage as Storage | undefined
  delete (config as any).storage
  const viewOpts = (config.view as Record<string, unknown>) ?? {}
  delete (config as any).view
  let storageUnsub: (() => void) | undefined
  if (storage) {
    for (const record of await storage.load()) applyInbound(record)
    storageUnsub = log.onAppend((record) => storage.append(record))
  }

  // mesh: the L0 transport, wired with all the inbound hooks (record/digest/RPC/subscribe/write/view).
  const mesh: Mesh = transport({
    name,
    ...(config as object),
    // onRecord: held-gate then accept — scoped nodes drop records for partitions they don't replicate.
    onRecord: (record: ChangeRecord) => {
      if (scoped && !holds(partitionOf(record))) return
      applyInbound(record)
    },
    // onConnect: on handshake, a server sends its digest (reply:true) so catch-up heals both directions.
    onConnect: (address: string) => {
      if (me !== undefined) mesh.digestTo(address, { v: Object.fromEntries(seen), reply: true, me })
    },
    // onDigest: ship the records the peer lacks (scoped: only partitions it replicates), confirm-shed, reply once.
    onDigest: (payload: any, address: string) => {
      const vector: Record<string, number> = payload?.v ?? payload ?? {}
      let recs = log.recordsSince(vector)
      if (scoped && payload?.me && R < viewSize())
        recs = recs.filter((r) => mesh.holds(partitionOf(r), payload.me, R))
      mesh.catchupTo(address, recs)
      if (scoped && payload?.me) shedConfirmed(payload.v ?? {}, payload.me)
      if (me !== undefined && payload?.reply) mesh.digestTo(address, { v: Object.fromEntries(seen), reply: false, me })
    },
    // onCall: inbound RPC — run the named method with the caller as context.peer, ship the return value back.
    onCall: (method: string, arg: unknown, address: string) => dispatch.serveCall(method, arg, address),
    // onSubscribe: inbound subscription — stream a returned ViewProxy's deltas to the client (else one value).
    onSubscribe: (subId: number, method: string, arg: unknown, address: string) => dispatch.serveSubscribe(subId, method, arg, address),
    onUnsubscribe: (subId: number, address: string) => dispatch.serveUnsubscribe(subId, address),
    // onPeerGone: reap a dropped peer's served subscriptions so a gone client doesn't leak sinks/openFolds.
    onPeerGone: (address: string) => dispatch.reapPeer(address),
    // onWrite: a forwarded write for a partition we own — commit it locally; we are its single sequencer.
    onWrite: (record: ChangeRecord) => commitForwarded(record),
    // onView*: membership view-change frames (Milestone V) routed to the ViewManager state machine.
    onViewPrepare: (value: unknown) => viewMgr?.onPrepare(value),
    onViewAck: (value: unknown) => viewMgr?.onAck(value),
    onViewCommit: (value: unknown) => viewMgr?.onCommit(value),
    onJoinRequest: (value: unknown) => viewMgr?.onJoinRequest(),
  })

  const uuid = mesh.uuid
  const me = mesh.me

  const viewSize = (): number => mesh.viewMembers().length

  // ── 3 · holding + membership + anti-entropy ──
  // holds(key): does this node replicate the partition? full ⇒ always; scoped ⇒ in its R-set on the ring (memoized).
  const heldCache = new Map<string, boolean>()
  const holds = (key: string): boolean => {
    if (me === undefined) return false
    if (!scoped || R >= viewSize()) return true
    let h = heldCache.get(key)
    if (h === undefined) heldCache.set(key, (h = mesh.holds(key, me, R)))
    return h
  }

  // resync (scoped): digest every view member to acquire rebalanced partitions + heal drift (reciprocal heals both ways).
  const resync = () => {
    if (!scoped || me === undefined) return
    const digest = { v: Object.fromEntries(seen), reply: true, me }
    for (const m of mesh.viewMembers()) if (m !== me) mesh.digestTo(m, digest)
  }

  // aggregate registries (Q2c): rebinds re-scope live partials on a ring change; reconciles fix fold holder sets.
  type Rescope = () => void
  type Reconcile = () => void
  const aggregateRebinds = new Set<Rescope>()
  const aggregateReconciles = new Set<Reconcile>()

  // viewMgr (servers only): the view-change state machine — committed {epoch,members}; onCommit rebalances + rebinds.
  const viewMgr =
    me !== undefined
      ? new ViewManager({
          me,
          mesh,
          peers: mesh.peers,
          ...viewOpts,
          onWritable: (w) => {
            if (w) flushPending()
            observe?.onWritable(w)
          },
          onCommit: () => {
            heldCache.clear()
            markOrphans()
            resync()
            for (const rescope of aggregateRebinds) rescope()
            for (const reconcile of aggregateReconciles) reconcile()
            observe?.onView(viewEpoch(), viewSize())
          },
        })
      : undefined
  const viewEpoch = (): number => viewMgr?.epoch ?? 1

  // aeTimer (scoped): periodic resync + fold-reconcile — the backstop for acquisition/drift a commit-triggered run can race.
  const aeTimer =
    scoped && me !== undefined
      ? setInterval(() => {
          resync()
          for (const reconcile of aggregateReconciles) reconcile()
        }, antiEntropyMs)
      : undefined
  aeTimer?.unref?.()

  // compactTimer (both modes): periodic log compaction — collapse superseded same-key updates so a hot key can't grow the log unbounded.
  const compactTimer = compactMs > 0 ? setInterval(() => void log.compact(), compactMs) : undefined
  compactTimer?.unref?.()

  // ── 4 · write path: capture sink → forward-to-owner | commit-local ──
  let primed = false
  let destroyed = false
  const writeHost = data.connect({}, (change: ChangeRecord) => {
    // 0) destroyed-skip: the node is torn down — a late write must not commit/persist.
    if (destroyed) return

    // 1) prime: swallow the empty attach-snapshot.
    if (!primed) {
      primed = true
      return
    }

    // 2) applying-skip: an inbound re-emission — already handled in onRecord.
    if (applying) return

    // 3) F1 forward: not owner + owner reachable ⇒ hand off (a forwarded write skips this).
    if (!committingForward) {
      const p = partitionOf(change)
      const owner = me !== undefined ? mesh.owner(p) : undefined
      if (owner !== undefined && owner !== me && mesh.forward(owner, change)) {
        if (scoped && !holds(p)) discardOptimistic(p)
        return
      }
    }

    // 4) commit-local: stamp/log/replicate under our provenance.
    commitLocal(change)
  })

  // ── orphan shedding (P4, scoped): keep a no-longer-replicated partition until an R-set member is caught up, then drop ──
  // orphans / shedReady: partitions we hold but no longer replicate, + the R-set members confirmed caught up on each.
  const orphans = new Set<string>()
  const shedReady = new Map<string, Set<string>>()

  // discardOptimistic: drop a forwarded-but-unheld partition we optimistically applied (guarded — no sink echo).
  const discardOptimistic = (partition: string) => {
    applying = true
    try {
      applyRecord(res, { type: 'remove', key: [partition] })
    } finally {
      applying = false
    }
  }

  // shed: fully drop an orphan from proxy/log/seen/versions — complete handoff, only after R-set confirmed caught up.
  const shed = (partition: string) => {
    discardOptimistic(partition)
    log.drop(partition)
    const suffix = '\x00' + partition
    for (const k of seen.keys()) if (k.endsWith(suffix)) seen.delete(k)
    for (const k of versions.keys()) if (k === partition || k.startsWith(partition + '\x00')) versions.delete(k)
    orphans.delete(partition)
    shedReady.delete(partition)
  }

  // markOrphans: on a ring rebalance, flag held-but-no-longer-replicated partitions as orphans-to-shed.
  const markOrphans = () => {
    if (!scoped || me === undefined) return
    for (const p of log.partitions()) if (!holds(p) && !orphans.has(p)) orphans.add(p)
  }

  // shedConfirmed: mark an R-set peer caught up on each orphan from its digest; shed only when EVERY member is (never < R).
  const shedConfirmed = (peerMarks: Record<string, number>, peerMe: string) => {
    if (!scoped || me === undefined || !orphans.size) return
    const shippable = log.marks()
    for (const p of [...orphans]) {
      if (holds(p)) {
        orphans.delete(p)
        shedReady.delete(p)
        continue
      }
      const rset = mesh.owners(p, R)
      if (!rset.includes(peerMe)) continue
      let caughtUp = true
      const suffix = '\x00' + p
      for (const key in shippable) {
        if (key.endsWith(suffix) && (peerMarks[key] ?? 0) < shippable[key]) {
          caughtUp = false
          break
        }
      }
      if (!caughtUp) continue
      let ready = shedReady.get(p)
      if (!ready) shedReady.set(p, (ready = new Set()))
      ready.add(peerMe)
      if (rset.every((m) => ready!.has(m))) shed(p)
    }
  }

  // commitLocal: stamp under our provenance, record as LWW winner, log, replicate — owned writes + never-drop fallback.
  function commitLocal(change: ChangeRecord) {
    // write-gate chokepoint (V1e): no quorum ⇒ buffer instead of commit, so a minority can't diverge.
    if (viewMgr && !viewMgr.canWrite) {
      if (pending.length >= MAX_PENDING) pending.shift()
      pending.push(change)
      return
    }
    const n = ++clock
    change.origin = uuid
    change.seq = n
    const e = (change.epoch = viewEpoch())
    const p = partitionOf(change)
    seen.set(seenKey(uuid, p), n)
    const key = versionKey(change)
    const cur = versions.get(key)
    if (cur) {
      cur.epoch = e
      cur.seq = n
      cur.origin = uuid
    } else versions.set(key, { epoch: e, seq: n, origin: uuid })
    log.append(change)
    observe?.onRecord(change, committingForward ? 'forwarded' : 'local')
    // replicate: scoped R<members ⇒ send to the R-set only (orphan-mark if we're not in it); else broadcast to all.
    if (scoped && R < viewSize()) {
      const rset = mesh.owners(p, R)
      mesh.replicateTo(rset, change)
      if (!rset.includes(me!)) {
        orphans.add(p)
        shedReady.delete(p)
      }
    } else mesh.broadcast(change)
  }

  // commitForwarded: apply a forwarded write so the sink commits it as ours; committingForward stops a re-forward.
  const commitForwarded = (record: ChangeRecord) => {
    committingForward = true
    try {
      applyRecord(res, record)
    } finally {
      committingForward = false
    }
  }

  // flushPending: quorum returned — re-commit the buffered writes in order (re-buffers if the gate closed again).
  function flushPending() {
    if (!pending.length) return
    const batch = pending.splice(0)
    for (const c of batch) commitLocal(c)
  }

  // distributed aggregates (Q2/Q3): the fold ENGINE lives in ./fold.ts (makeFold), built below once invoke+clientSubs exist.

  // ── 5 · surfaces: cluster + methods + dispatch ──
  // cluster: the public cluster surface — peers, identity, owner/replica queries, live view (epoch/members/writable).
  const cluster: Cluster = {
    peers: mesh.peers,
    get me() {
      return mesh.me
    },
    uuid: mesh.uuid,
    owner: (key: string) => mesh.owner(key),
    replicas: (key: string) => mesh.owners(key, R),
    get epoch() {
      return viewMgr?.epoch ?? 1
    },
    get members() {
      return viewMgr ? viewMgr.members : []
    },
    get writable() {
      return viewMgr ? viewMgr.canWrite : true
    },
  }

  // defaults: read/aggregate/update/insert/remove (plan §6.3), each overridable by a same-named opts function.
  const defaults: Record<string, Method> = {
    // read() → whole data; read(key) → that key's child view (Q1 keyed read, server side of a remote read).
    read: (arg, c) => (typeof arg === 'string' ? c.data[arg] : c.data),
    // aggregate(spec) → this node's owner-scoped PARTIAL; the querying node fans out + folds the disjoint cover (Q2).
    aggregate: (spec) => fold.buildPartial(spec),
    update: (chg, c) => setPath(c.data, norm(chg?.key), chg?.value),
    insert: (chg, c) => setPath(c.data, norm(chg?.at ?? chg?.key), chg?.value),
    remove: (chg, c) => delPath(c.data, norm(chg?.key)),
  }
  // __inspect: gated L4 pull method — returns this node's InspectSnapshot to a remote observer (registered only when observe is on).
  if (observeOn) defaults.__inspect = () => snapshot()
  const allMethods: Record<string, Method> = { ...defaults, ...methods }

  const context: Context = { data, cluster, log, name, methods: undefined as any, peer: undefined }

  // invoke: run a named method on this server with context (+ peer when routed); the in-process dispatcher.
  const invoke = (method: string, arg: unknown, peer?: string): unknown => {
    const fn = allMethods[method]
    if (!fn) throw new Error(`fero: unknown method "${method}"`)
    return fn(arg, peer ? { ...context, peer } : context)
  }

  const clientSubs = new Set<() => void>()

  // fold: build the distributed-aggregate engine (./fold.ts) now that invoke + the registries + clientSubs exist.
  const fold = makeFold({ data, mesh, me, invoke, aggregateRebinds, aggregateReconciles, clientSubs })

  // dispatch: build LAST — the RPC/subscription servers, method surfaces, remote-read handles, and data facade.
  const dispatch = makeDispatch({ allMethods, defaults, context, mesh, me, scoped, R, viewSize, holds, data, clientSubs, invoke, fold, onObserve: observeOn ? buildObserve : undefined })

  // Build the L4 pull snapshot now that all replication state + dispatch.servedCount exist; exposed via [diagnostics] (always) + __inspect (gated).
  snapshot = makeSnapshot({
    name,
    cluster,
    ringSnapshot: mesh.ringSnapshot,
    peers: () => mesh.peers[peerValue],
    log,
    seen,
    versions,
    pending,
    orphans,
    servedCount: dispatch.servedCount,
    observing: () => observe !== undefined,
    R,
    scoped,
  })

  await mesh.ready

  return {
    data: dispatch.dataFacade,
    methods: dispatch.methodSurface,
    cluster,
    destroy() {
      void writeHost
      destroyed = true
      storageUnsub?.()
      if (aeTimer) clearInterval(aeTimer)
      if (compactTimer) clearInterval(compactTimer)
      viewMgr?.destroy()
      for (const unsub of clientSubs) unsub()
      mesh.destroy()
      observe = undefined
    },
    // [diagnostics]: Symbol-keyed internals seam (off the public API) — pull snapshot + served-sub count + drop/isolate/heal fault injection.
    [diagnostics]: {
      snapshot,
      servedSubscriptions: dispatch.servedCount,
      // observing(): is the push-hook armed (≥1 subscriber attached)? The leak-guard test asserts this returns to false after an ungraceful drop.
      observing: () => observe !== undefined,
      // observe(onRecord): in-process provenance stream (harness war games + the demo) — attach a sink directly; the returned closer (idempotent) detaches + disarms on the last detach.
      observe: (onRecord: (r: ChangeRecord) => void) => {
        const o = buildObserve()
        let active = true
        let host: unknown = o.proxy.connect({}, (r: ChangeRecord) => {
          if (active) onRecord(r)
        })
        return () => {
          if (!active) return
          active = false
          host = undefined
          o.close()
        }
      },
      drop: (address: string) => mesh.drop(address),
      isolate: (address: string) => mesh.isolate(address),
      heal: (address: string) => mesh.heal(address),
      // compact(): run a log-compaction pass NOW (the production cadence is the unref'd compactTimer); returns records dropped. Lets tests drive it deterministically.
      compact: () => log.compact(),
      // logSize(): live record count across all partition segments — asserts compaction actually shrank the log.
      logSize: () => log.size,
    },
  } as Fero
}

// diagnostics: the Symbol key for the internals handle, kept off the typed public surface and out of Object.keys.
export const diagnostics = Symbol('fero.diagnostics')
