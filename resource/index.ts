// L2 public surface: fero(name, opts) → { data, methods, cluster, destroy }.
//
// The whole library, in one call. Composes L1's record machinery onto an L0
// mesh and exposes the three reactive surfaces from plan.md §1:
//
//   data     — a $() ViewProxy of the resource state. Reads via property access
//              (`r.data.user42`), writes via assignment (`r.data.user42 = {…}`).
//              Writes are captured, logged, and replicated to peers.
//   methods  — RPC + subscriptions. Default update/insert/remove/read, each
//              overridable by an opts function of the same name. A method
//              returns whatever it wants; the caller's await-or-not picks the
//              consumption mode (Promise for value, ViewProxy for subscription).
//   cluster  — { peers, me, uuid, owner } — peers is the L0 ViewProxy.
//
//   destroy  — teardown (drops the mesh + the write-capture sink).
//
// `await fero(...)` IS the ready signal (plan §1): it resolves once the cluster
// is reachable, or after `wait` ms with no peers (the "I'm first" case). There
// is no `.ready` / `.on('connected')`.
//
// MODEL — the data proxy is the source of truth; the log is a history sidecar.
// `data`'s set/delete traps already materialize state AND emit change records;
// a single write-capture sink stamps those records with provenance (origin uuid
// + a Lamport seq) and turns them into log appends + peer broadcasts. Inbound
// records carry that provenance, so the replication core can dedup re-delivered
// records (per-origin high-water mark), keep a full per-origin history in the
// log (the basis for catch-up), and resolve concurrent same-key writes by
// last-writer-wins — so two nodes converge instead of diverging. This is the
// day0 hypothesis (records in ⇄ records out) wired through L0 + L1 with a
// convergent replication discipline on top. See [../log/index.ts](../log/index.ts)
// for the L1 `distribute()` variant where the LOG is the write API instead
// (arch A); here the PROXY is (arch B), because assignment is the write surface.
//
// v1 scope: server / full-replication mode (every server materializes every
// record via dialed-broadcast). Deferred — client→server RPC dispatch, per-
// client `read()` projections, DHT-partitioned routing. See ./IDEAS.md.

import { $, value as VALUE, view as VIEWSYM } from '../../data/index.ts'
import { transport, type Mesh, type TransportOpts } from '../transport/index.ts'
import { Log } from '../log/partition.ts'
import { applyRecord } from '../log/index.ts'
import type { ChangeRecord } from '../transport/message.ts'

export { value } from '../../data/index.ts'
export { fileStorage } from './storage.ts'

export type Method = (arg: any, context: Context) => any

export type Cluster = {
  peers: any // L0 cluster.peers ViewProxy (queryable / connectable)
  readonly me?: string // this server's listen address (undefined for read-only clients)
  uuid: string
  owner: (key: string) => string | undefined // DHT owner of a partition key
}

// What every method receives as its second arg. plan §6.1 names data/peer/
// methods/cluster; log + name are useful extras for handlers and L1 work.
export type Context = {
  data: any
  cluster: Cluster
  methods: Record<string, (arg?: any) => any>
  log: Log
  name: string
  peer?: any // the calling peer (set for routed RPC — deferred; undefined locally)
}

export type Fero = {
  data: any
  methods: Record<string, (arg?: any) => any>
  cluster: Cluster
  destroy: () => void
}

// Durable-log seam (plan §4). `load` returns the persisted records at boot (they
// replay through the same accept path as inbound replication); `append` persists
// each accepted record. A built-in file adapter lives in ./storage.ts; bring your
// own (Redis, S3, a DB WAL) by implementing these two.
export type Storage = {
  load: () => ChangeRecord[] | Promise<ChangeRecord[]>
  append: (record: ChangeRecord) => void
}

export type FeroOpts = Record<string, unknown> & Partial<Omit<TransportOpts, 'name' | 'onRecord'>> & { storage?: Storage }

// A change record's `key` may arrive as an array path (`['user42','active']`)
// or a bare scalar (`'user42'`, sugar). Normalize to a path.
const norm = (k: unknown): (string | number)[] =>
  Array.isArray(k) ? k : k == null ? [] : [k as string | number]

// Walk a path on the data proxy and assign / delete the leaf. Single-segment is
// the common case; nested walks the proxy tree (each hop is a child ViewProxy,
// so the leaf assignment still routes through the set trap → emits one record).
function setPath(data: any, path: (string | number)[], value: unknown) {
  if (path.length === 0) return // root replace: not exposed via default methods
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

export async function fero(name: string, opts: FeroOpts = {}): Promise<Fero> {
  // Recognition rule (plan §1): function values are methods, everything else is
  // transport/resource config. By value type, not key name.
  const methods: Record<string, Method> = {}
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'function') methods[k] = v as Method
    else config[k] = v
  }

  // State: the proxy is the source of truth; the log records history (catch-up
  // groundwork — not yet read back in v1).
  const log = new Log()
  const data = $({})
  const res = (data as any)[VIEWSYM].res

  // ── Replication core: provenance + dedup + last-writer-wins ──
  //
  // `clock` is a LAMPORT clock (not a plain counter): merged up on every inbound
  // record, bumped on every local write. That makes a local write always
  // causally newest, so it WINS the LWW comparison — without this a local write
  // with a small per-node number would lose to a high-numbered remote write and
  // the two nodes would diverge permanently. Each origin's own stamped seqs stay
  // strictly increasing (its clock only rises), so per-origin high-water marks
  // dedup re-delivered records. Within one synchronous write burst the clock
  // increments contiguously and the microtask outbox flushes before the next
  // (macrotask) inbound, so a frame's records keep contiguous seqs (base+index).
  let clock = 0 // this node's Lamport clock; local writes stamp ++clock
  const seen = new Map<string, number>() // origin → highest seq seen (dedup high-water)
  // keyPath → current LWW winner. The {seq,origin} stamp is MUTATED in place on
  // re-write (not reallocated) so the steady-state write path allocates nothing
  // here — version churn was the dominant cost when this was a fresh object per
  // write (see index.perf.ts).
  const versions = new Map<string, { seq: number; origin: string }>()

  // The key path a record contends on for LWW. An insert folds `at` into the
  // path so an insert and a later update to the same key contend as one key;
  // distinct leaves (k1 vs k1.score) are independent → field-level LWW. The
  // single-segment cases (top-level set, whether insert or update) reuse an
  // existing string — no `join` allocation on the hot path.
  const versionKey = (record: ChangeRecord): string => {
    const key = record.key
    if (record.at !== undefined) return key.length === 0 ? record.at : key.join('\x00') + '\x00' + record.at
    return key.length === 1 ? key[0] : key.join('\x00')
  }

  // Inbound records carry their origin's provenance. (1) Drop duplicates by
  // per-origin high-water. (2) Log every accepted record (the full per-origin
  // history catch-up forwards from). (3) Apply only LWW winners to the proxy —
  // losers stay in the log but don't mutate state. The apply re-emits through
  // the write-capture sink; the `applying` guard stops that re-emission from
  // being re-logged or re-broadcast.
  let applying = false

  // Accept a record into local state: dedup by per-origin high-water, Lamport-
  // merge the clock, log it (full per-origin history), LWW-resolve, and apply the
  // winner to the proxy. Shared by inbound replication AND restore-from-storage
  // replay — neither path broadcasts (the sink's `applying` guard keeps the
  // re-emission from looping back out, and restore runs before any peer exists).
  const applyInbound = (record: ChangeRecord) => {
    const origin = record.origin
    if (origin !== undefined) {
      const n = record.seq ?? 0
      if (n <= (seen.get(origin) ?? 0)) return // already have it (dedup)
      seen.set(origin, n)
      if (n > clock) clock = n // Lamport merge
      log.append(record)
      const key = versionKey(record)
      const cur = versions.get(key)
      // LWW, lexicographic (seq, origin): higher seq wins; origin uuid breaks
      // exact ties so every node elects the same winner. Loser stays logged.
      if (cur && !(n > cur.seq || (n === cur.seq && origin > cur.origin))) return
      if (cur) {
        cur.seq = n
        cur.origin = origin
      } else versions.set(key, { seq: n, origin })
    } else {
      log.append(record) // provenance-less (handshake / non-fero) — apply verbatim
    }
    applying = true
    try {
      applyRecord(res, record)
    } finally {
      applying = false
    }
  }

  // Restore durable state BEFORE the mesh exists (no network yet → no races):
  // replay the persisted log through applyInbound, rebuilding seen/clock/versions
  // and the proxy. The append-on-write hook is attached AFTER replay so we don't
  // re-persist what we just loaded; thereafter every accepted record (local OR
  // inbound) is appended to storage.
  const storage = config.storage as Storage | undefined
  delete (config as any).storage // L2 config — not a transport option
  if (storage) {
    for (const record of await storage.load()) applyInbound(record)
    log.onAppend((record) => storage.append(record))
  }

  const mesh: Mesh = transport({
    name,
    ...(config as object),
    onRecord: applyInbound,
    // Catch-up (anti-entropy). When a dialed peer's handshake completes, send it
    // our per-origin high-water digest; when a peer sends us theirs, ship back
    // every record they lack. The receiver folds the records through the same
    // dedup + LWW path above, so a late joiner or a peer that blipped converges
    // without any node having to stay connected the whole time.
    onConnect: (address: string) => mesh.digestTo(address, Object.fromEntries(seen)),
    onDigest: (vector: Record<string, number>, address: string) => mesh.catchupTo(address, log.recordsSince(vector)),
    // Inbound RPC: a client called one of our methods. Run it here with the
    // caller as context.peer; the transport ships the return value back. (Defined
    // after the method table below — fires only once a client is connected.)
    onCall: (method: string, arg: unknown, address: string) => serveCall(method, arg, address),
  })

  const uuid = mesh.uuid

  // Write-capture: a local assignment on the proxy is stamped with our
  // provenance, recorded as the current LWW winner for its key (the proxy has
  // already materialized it — it's the newest write we know of), logged, and
  // broadcast. `connect(obj, fn)` pins the sink to `obj`; we retain that host
  // (via destroy's closure) so the sink stays alive (data holds it only by
  // WeakRef). The first emission is the empty attach-snapshot of an empty proxy
  // — swallow it. Inbound re-emissions are skipped (the `applying` guard) — they
  // were already logged/applied in onRecord.
  let primed = false
  const writeHost = data.connect({}, (change: ChangeRecord) => {
    if (!primed) {
      primed = true
      return
    }
    if (applying) return
    const n = ++clock
    change.origin = uuid
    change.seq = n
    seen.set(uuid, n)
    const key = versionKey(change)
    const cur = versions.get(key)
    if (cur) {
      cur.seq = n
      cur.origin = uuid
    } else versions.set(key, { seq: n, origin: uuid })
    log.append(change)
    mesh.broadcast(change) // full replication: every server materializes every record
  })

  const cluster: Cluster = {
    peers: mesh.peers,
    get me() {
      return mesh.me
    },
    uuid: mesh.uuid,
    owner: (key: string) => mesh.owner(key),
  }

  // Default methods (plan §6.3), overridable by same-named opts functions. Each
  // assigns to context.data → the write-capture sink replicates the result. A method
  // assigning to data is a trusted local commit; it does NOT re-invoke the method
  // (plan §5 recursion-safety) — the sink replicates, it doesn't dispatch.
  const defaults: Record<string, Method> = {
    read: (_arg, c) => c.data, // full passthrough (per-client projection: deferred)
    update: (chg, c) => setPath(c.data, norm(chg?.key), chg?.value),
    insert: (chg, c) => setPath(c.data, norm(chg?.at ?? chg?.key), chg?.value),
    remove: (chg, c) => delPath(c.data, norm(chg?.key)),
  }
  const allMethods: Record<string, Method> = { ...defaults, ...methods }

  const context: Context = { data, cluster, log, name, methods: undefined as any, peer: undefined }

  // Run a method here (on this server). `peer`, when set, is the calling client
  // — handlers read it as context.peer for auth. A method returning a ViewProxy
  // (e.g. the default `read`) is reduced to a snapshot for the RPC reply path;
  // the live-subscription path (returning the proxy itself) is deferred (E).
  const invoke = (method: string, arg: unknown, peer?: string): unknown => {
    const fn = allMethods[method]
    if (!fn) throw new Error(`fero: unknown method "${method}"`)
    return fn(arg, peer ? { ...context, peer } : context)
  }
  const serveCall = (method: string, arg: unknown, address: string): unknown => snapshot(invoke(method, arg, address))

  // The local method surface (server) calls handlers in-process; a read-only
  // client (no listen port) has no handlers — every call is RPC'd to its
  // connected server. `await`-ing the result is the consumption mode for values;
  // the ViewProxy-subscription mode is deferred (E).
  const isClient = mesh.me === undefined
  const localMethods: Record<string, (arg?: any) => any> = {}
  for (const k of Object.keys(allMethods)) localMethods[k] = (arg?: any) => invoke(k, arg)
  context.methods = localMethods // method-to-method calls run locally

  const methodSurface: Record<string, (arg?: any) => any> = isClient
    ? (new Proxy({}, { get: (_t, name: string) => (arg?: any) => mesh.call(name, arg) }) as any)
    : localMethods

  await mesh.ready

  return {
    data,
    methods: methodSurface,
    cluster,
    destroy() {
      void writeHost // retain the sink host until teardown
      mesh.destroy()
    },
  }
}

// Reduce a method's return value for the wire: a ViewProxy collapses to its
// snapshot (its [value]); everything else passes through. Lets `await read()`
// return a plain object across the network while a local server can hand back
// the live proxy.
function snapshot(v: unknown): unknown {
  if (v != null && (typeof v === 'object' || typeof v === 'function')) {
    const snap = (v as any)[VALUE]
    if (snap !== undefined) return snap
  }
  return v
}
