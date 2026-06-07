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
// Built across milestones A–H, V, P/P4, Q1–Q3 (see ../DECISIONS.md): the
// per-origin LWW core (A) and proxy-as-source model (H) are the foundation;
// client→server RPC (D), per-client read() projections + live subscriptions (E),
// owner-routed writes (F1), view-synchronous membership (V), R-way scoped holding
// + orphan shedding (P/P4), hold-relative reads (Q1), and distributed aggregates
// + whole-resource gather (Q2/Q3) all ship here. Open work: ../IDEAS.md.

import { $, view as VIEWSYM, Operators } from '../../data/index.ts'
import { transport, type Mesh, type TransportOpts } from '../transport/index.ts'
import { Log, originKey } from '../log/partition.ts'
import { applyRecord } from '../log/index.ts'
import { partitionOf, type ChangeRecord } from '../transport/message.ts'
import { ViewManager } from './view.ts'
import { AGG, makeFold } from './fold.ts'
import { lazyHandle, isViewProxy, snapshot } from './handle.ts'

export { value } from '../../data/index.ts'
export { fileStorage } from './storage.ts'

export type Method = (arg: any, context: Context) => any

export type Cluster = {
  peers: any // L0 cluster.peers ViewProxy (queryable / connectable)
  readonly me?: string // this server's listen address (undefined for read-only clients)
  uuid: string
  owner: (key: string) => string | undefined // DHT owner of a partition key
  replicas: (key: string) => string[] // the R-way replica set for a partition key (owner + the next R-1 peers clockwise); ALL members under full replication (the default). Milestone P.
  readonly epoch: number // current committed view-epoch (Milestone V); 1 for a read-only client
  readonly members: string[] // current committed view membership (servers); [] for a client
  readonly writable: boolean // can this server reach a quorum of its view? false ⇒ read-only (writes buffer)
}

// What every method receives as its second arg. plan §6.1 names data/peer/
// methods/cluster; log + name are useful extras for handlers and L1 work.
export type Context = {
  data: any
  cluster: Cluster
  methods: Record<string, (arg?: any) => any>
  log: Log
  name: string
  peer?: any // the calling peer's listen address (set for routed RPC — DECISIONS D); undefined for an in-process method-to-method call. NB: plan §6.1/§7 describe a richer { address, status, auth } peer object — auth not yet built (../IDEAS.md).
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

  // Replication factor (Milestone P). `replicas: R` holds each partition on R
  // replicas (owner + R-1 ring successors); the default ∞ holds every partition on
  // every server (full replication — the pre-P behavior, byte-identical). Extracted
  // FIRST because it picks the granularity of the log + dedup + anti-entropy: full
  // ⇒ per-origin (compact O(origins) digest, coalesced catch-up frames); finite R
  // (scoped) ⇒ per-(origin,partition) (a node holds only its partitions and still
  // re-syncs an acquired one from seq 0). Threaded to the DHT so its replicate
  // default matches; L2 always passes R explicitly.
  const R = typeof config.replicas === 'number' ? (config.replicas as number) : Infinity
  delete (config as any).replicas
  config.dht = { ...((config.dht as Record<string, unknown>) ?? {}), replicas: R }
  const scoped = R !== Infinity
  // Periodic anti-entropy interval (ms) — drives scoped acquisition + drift healing
  // (see resync below). Extracted so it isn't passed to the transport; only armed in
  // scoped mode.
  const antiEntropyMs = typeof config.antiEntropy === 'number' ? (config.antiEntropy as number) : 1000
  delete (config as any).antiEntropy

  // State: the proxy is the source of truth; the log records history.
  const log = new Log({ scoped })
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
  // Dedup high-water, keyed by seenKey(origin, partition) below: per-origin under
  // full replication (compact digest), per-(origin,partition) under scoped holding
  // (Milestone P — so each partition's stream is independently complete). Doubles
  // as the anti-entropy digest a node sends (Object.fromEntries(seen)).
  const seen = new Map<string, number>()
  // keyPath → current LWW winner. The {seq,origin} stamp is MUTATED in place on
  // re-write (not reallocated) so the steady-state write path allocates nothing
  // here — version churn was the dominant cost when this was a fresh object per
  // write (see index.perf.ts).
  const versions = new Map<string, { epoch: number; seq: number; origin: string }>()
  // Write-gate buffer (Milestone V1e): writes attempted while we can't reach a
  // quorum of the view are held here (NOT committed/broadcast) and flushed when
  // quorum returns — so a partition's minority side stays read-only instead of
  // diverging. Bounded (drop-oldest) so a long partition can't grow it without limit.
  const pending: ChangeRecord[] = []
  const MAX_PENDING = 10_000
  // Orphan partitions (Milestone P4): partitions we hold data for but no longer
  // REPLICATE (per the committed ring) — a former replica after a ring expansion, or
  // a write committed locally at a non-replica (never-drop fallback / misrouted
  // forward). We KEEP them (so the partition stays ≥R-replicated — no under-
  // replication window) until a current R-set member is confirmed caught up, then
  // SHED (drop our copy). Scoped-only.
  const orphans = new Set<string>()
  // Per-orphan set of R-set members confirmed caught up (see shedConfirmed): we shed
  // only once EVERY current R-set member is in here, so the partition is fully
  // R-replicated WITHOUT us before we drop it.
  const shedReady = new Map<string, Set<string>>()

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

  // The provenance key a record dedups / catches-up under (see `seen` above).
  // Full replication ⇒ origin alone; scoped holding ⇒ (origin,partition). Mirrors
  // the log's index granularity (constructed with the same `scoped` flag), so the
  // digest a node sends and the records a peer ships back agree on the key.
  const seenKey = scoped
    ? (origin: string, p: string): string => originKey(origin, p)
    : (origin: string, _p: string): string => origin

  // Inbound records carry their origin's provenance. (1) Drop duplicates by
  // per-origin high-water. (2) Log every accepted record (the full per-origin
  // history catch-up forwards from). (3) Apply only LWW winners to the proxy —
  // losers stay in the log but don't mutate state. The apply re-emits through
  // the write-capture sink; the `applying` guard stops that re-emission from
  // being re-logged or re-broadcast.
  let applying = false
  // Set while a FORWARDED write is being applied locally (see applyLocalWrite): the
  // sink commits it as-is instead of re-evaluating ownership, so it never bounces.
  let committingForward = false

  // Accept a record into local state: dedup by per-origin high-water, Lamport-
  // merge the clock, log it (full per-origin history), LWW-resolve, and apply the
  // winner to the proxy. Shared by inbound replication AND restore-from-storage
  // replay — neither path broadcasts (the sink's `applying` guard keeps the
  // re-emission from looping back out, and restore runs before any peer exists).
  const applyInbound = (record: ChangeRecord) => {
    const origin = record.origin
    if (origin !== undefined) {
      const sk = seenKey(origin, partitionOf(record))
      const n = record.seq ?? 0
      if (n <= (seen.get(sk) ?? 0)) return // already have it (dedup, per seenKey granularity)
      seen.set(sk, n)
      if (n > clock) clock = n // Lamport merge (global)
      log.append(record)
      const e = record.epoch ?? 0
      const key = versionKey(record)
      const cur = versions.get(key)
      // LWW, lexicographic (epoch, seq, origin): a write committed under a NEWER
      // membership view wins (epoch fencing — Milestone V1d), so a straggler from
      // a superseded view can't clobber the current one; within a view (constant
      // epoch) the Lamport seq decides; origin uuid breaks exact ties. Every node
      // elects the same winner. Loser stays logged.
      if (cur && !(e > cur.epoch || (e === cur.epoch && (n > cur.seq || (n === cur.seq && origin > cur.origin))))) return
      if (cur) {
        cur.epoch = e
        cur.seq = n
        cur.origin = origin
      } else versions.set(key, { epoch: e, seq: n, origin })
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
  const viewOpts = (config.view as Record<string, unknown>) ?? {}
  delete (config as any).view // L2 view-change tuning — not a transport option
  if (storage) {
    for (const record of await storage.load()) applyInbound(record)
    log.onAppend((record) => storage.append(record))
  }

  const mesh: Mesh = transport({
    name,
    ...(config as object),
    // Scoped holding (Milestone P): materialize ONLY partitions we replicate. A
    // server with finite R drops inbound records for partitions it doesn't hold
    // (scoped delivery shouldn't send them, but catch-up over-ship or a transitional
    // ring could). Storage replay calls applyInbound DIRECTLY (it restores our own
    // held partitions), so the held-gate lives here, not in applyInbound.
    onRecord: (record: ChangeRecord) => {
      if (scoped && !holds(partitionOf(record))) return
      applyInbound(record)
    },
    // Catch-up (anti-entropy). When a dialed peer's handshake completes, send it
    // our high-water digest; when a peer sends us theirs, ship back
    // every record they lack. The receiver folds the records through the same
    // dedup + LWW path above, so a late joiner or a peer that blipped converges
    // without any node having to stay connected the whole time.
    // The digest is RECIPROCAL: the dialer sends {v, reply:true}; the receiver
    // ships back the records the dialer lacks AND replies with its OWN digest
    // {reply:false}, so the dialer ships what the RECEIVER lacks. Without the
    // reply leg, catch-up is one-directional — a node that missed a write while a
    // link was down (e.g. a write committed locally during a forward failure, then
    // the link reconnects) would never learn it's behind, since onConnect only
    // fires on the dialer. The reply:false leg doesn't reciprocate again (bounded).
    // Only servers (me defined) initiate anti-entropy — a read-only client has no
    // log to sync and reads via subscriptions, so it never digests (it would just
    // be shipped state it drops).
    onConnect: (address: string) => {
      if (me !== undefined) mesh.digestTo(address, { v: Object.fromEntries(seen), reply: true, me })
    },
    onDigest: (payload: any, address: string) => {
      const vector: Record<string, number> = payload?.v ?? payload ?? {}
      let recs = log.recordsSince(vector)
      // Scoped holding (P2): ship only partitions the REQUESTER replicates — its own
      // LISTEN address (payload.me, not the ephemeral connection address) against the
      // committed-view ring. Avoids wasting catch-up bandwidth on partitions it would
      // just drop. A partition it's ACQUIRING is absent from its vector, so
      // recordsSince ships it in full and this filter keeps it (it holds it per the
      // ring) — that's the re-sync path. Skipped when R≥members (it holds all) or in
      // full replication (no filter — and no owners() scan on the catch-up path).
      if (scoped && payload?.me && R < viewSize())
        recs = recs.filter((r) => mesh.owners(partitionOf(r), R).includes(payload.me))
      mesh.catchupTo(address, recs)
      // Confirmed shedding (P4): the sender's marks tell us whether it (an R-set
      // member) is caught up on a partition we hold but no longer replicate — if so,
      // shed our orphan copy.
      if (scoped && payload?.me) shedConfirmed(payload.v ?? {}, payload.me)
      if (me !== undefined && payload?.reply) mesh.digestTo(address, { v: Object.fromEntries(seen), reply: false, me })
    },
    // Inbound RPC: a client called one of our methods. Run it here with the
    // caller as context.peer; the transport ships the return value back. (Defined
    // after the method table below — fires only once a client is connected.)
    onCall: (method: string, arg: unknown, address: string) => serveCall(method, arg, address),
    // Inbound subscription: run the method, and if it returns a ViewProxy stream
    // its deltas (initial snapshot + changes) to the client; else ship one value.
    onSubscribe: (subId: number, method: string, arg: unknown, address: string) => serveSubscribe(subId, method, arg, address),
    onUnsubscribe: (subId: number, address: string) => serveUnsubscribe(subId, address),
    // A peer dropped (socket close / destroy) without an UNSUBSCRIBE — reap its served subscriptions
    // so a gone client/coordinator doesn't leak its sinks / openFolds (subscription hygiene).
    onPeerGone: (address: string) => reapPeer(address),
    // Inbound write-request: a peer forwarded a write for a partition we own.
    // Apply it as a LOCAL write so our sink commits it (stamps origin=us, logs,
    // replicates) — we are the single sequencer for the partition.
    onWrite: (record: ChangeRecord) => applyLocalWrite(record),
    // Membership view-change frames (Milestone V) → the view-change state machine.
    onViewPrepare: (value: unknown) => viewMgr?.onPrepare(value),
    onViewAck: (value: unknown) => viewMgr?.onAck(value),
    onViewCommit: (value: unknown) => viewMgr?.onCommit(value),
    onJoinRequest: (value: unknown) => viewMgr?.onJoinRequest(),
  })

  const uuid = mesh.uuid
  const me = mesh.me

  const viewSize = (): number => mesh.viewMembers().length

  // Does this node hold (replicate) a partition's records? Full replication ⇒
  // always (every server holds everything). Scoped (finite R) ⇒ only if we're in
  // the partition's R-set on the committed-view ring. A read-only client (no `me`)
  // holds nothing. The R≥members short-circuit avoids an owners() ring scan when R
  // covers everyone (scoped degenerates to full replication) — this runs on every
  // inbound record + foreign write, so the scan would be a hot-path blowup.
  // The ring is constant between view commits, so memoize the owners() scan per key
  // (cleared on commit). Keeps holds() — on the inbound, write, AND facade-read paths
  // — O(1) in steady state instead of an O(R) ring walk per access.
  const heldCache = new Map<string, boolean>()
  const holds = (key: string): boolean => {
    if (me === undefined) return false
    if (!scoped || R >= viewSize()) return true
    let h = heldCache.get(key)
    if (h === undefined) heldCache.set(key, (h = mesh.owners(key, R).includes(me)))
    return h
  }

  // Anti-entropy re-sync (Milestone P, scoped only): send our high-water digest to
  // every other committed-view member, asking for what we lack — the reciprocal
  // reply leg then heals BOTH directions. This is the ACQUISITION path: on a view
  // change the ring rebalances partitions onto a node that has no records for them
  // (absent from its digest), so a current holder ships them in full. Driven by (a)
  // ViewManager.onCommit (immediate, after the new ring installs) and (b) a periodic
  // timer (the robust backstop — a commit-triggered digest can race the peer's own
  // commit, and periodic AE also heals ordinary drift). Full replication doesn't
  // need it (every node holds everything; onConnect catch-up suffices), so it's
  // gated to scoped — keeping the R=∞ path unchanged. (Digest is O(held keys); a
  // Merkle/range-hash compaction is the deferred P3 refinement.)
  const resync = () => {
    if (!scoped || me === undefined) return
    const digest = { v: Object.fromEntries(seen), reply: true, me }
    for (const m of mesh.viewMembers()) if (m !== me) mesh.digestTo(m, digest)
  }

  // Live distributed-aggregate machinery that reacts to membership changes (Milestone
  // Q2c). Two registries, both populated lazily as partials/folds go live; defined here
  // so the viewMgr.onCommit + aeTimer closures can walk them.
  //   • aggregateRebinds — each LIVE owner-scoped partial (a fold's local self-partial,
  //     or a holder's served partial) re-scopes itself when ITS ring changes (a view
  //     commit). data's filter caches per-row classification and only re-runs its
  //     predicate on a ROW change — never when a partition changes OWNER under a stable
  //     row — so a partial would keep counting a partition it no longer owns (while the
  //     new owner double-counts it) until rebuilt. Walked on commit ONLY.
  //   • aggregateReconciles — each live FOLD reconciles its remote-holder subscription
  //     set: add newly-admitted members, drop departed ones, and RETRY a member that
  //     wasn't connected yet when it was admitted (the admit race — a view can commit a
  //     moment before the coordinator↔member socket finishes the handshake). Walked on
  //     commit AND on the periodic anti-entropy tick (the retry backstop).
  const aggregateRebinds = new Set<() => void>()
  const aggregateReconciles = new Set<() => void>()

  // Membership view (Milestone V). Servers run the view-change state machine: it
  // forms a committed { epoch, members } the cluster agrees on, and drives the
  // DHT ring (via mesh.installView) so ownership is stable within an epoch. A
  // read-only client (no listen address) isn't a ring member, so it has no
  // ViewManager. Every committed write is stamped with the current view epoch
  // (carried on the wire; fenced at apply in V1d).
  const viewMgr =
    me !== undefined
      ? new ViewManager({
          me,
          mesh,
          peers: mesh.peers,
          ...viewOpts,
          onWritable: (w) => w && flushPending(),
          onCommit: () => {
            heldCache.clear() // the ring changed — invalidate the holds() memo
            markOrphans() // ring rebalanced → note partitions we no longer replicate (shed once handed off)
            resync() // ...and re-sync the ones we now acquire
            for (const rescope of aggregateRebinds) rescope() // re-scope live owner-scoped partials over the new ring (Q2c)
            for (const reconcile of aggregateReconciles) reconcile() // add/drop fold holders for the new membership
          },
        })
      : undefined
  const viewEpoch = (): number => viewMgr?.epoch ?? 1

  // Periodic anti-entropy (scoped only): the robust backstop for acquisition + drift
  // (a commit-triggered resync can race a peer that hasn't committed the new view
  // yet; this re-runs until both rings agree and the partition transfers). Off in
  // full replication (the R=∞ path is unchanged — onConnect catch-up suffices there).
  // Also drives the fold-member reconcile RETRY (Q2c): a holder admitted a tick before
  // its socket finished connecting is picked up here, not just at the (already-past)
  // commit — the same backstop role anti-entropy plays for acquisition.
  const aeTimer =
    scoped && me !== undefined
      ? setInterval(() => {
          resync()
          for (const reconcile of aggregateReconciles) reconcile()
        }, antiEntropyMs)
      : undefined
  aeTimer?.unref?.()

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
    // NB: a plain `data.x = y` assignment commits straight through this sink — it does
    // NOT dispatch through methods.update/insert/remove, so a user-overridden `update`
    // (for auth/validation) intercepts only methods.update(...) calls, not assignments.
    // Deliberate, not an oversight: routing assignments through the method risks the
    // re-entrancy the `applying` guard prevents (plan §7). Open design call — ../IDEAS.md
    // "Assignment ↔ methods.update parity".
    // Owner-routed writes (Milestone F1): the partition owner is the single
    // sequencer for its keys. If we don't own this partition — and the owner is a
    // connected peer — FORWARD the raw write; the owner commits it under its own
    // provenance and replicates the canonical record back to us. The optimistic
    // local value is already applied (the set trap ran before this sink), so we
    // just hand off and return; the canonical origin=owner record arrives via
    // replication and reconciles. Clients (no `me`) and an unreachable owner fall
    // through to a local commit so a write is never dropped. The dedup/LWW core's
    // in-order invariant holds per (origin,partition) — each partition's single
    // owner is one in-order source.
    //
    // A FORWARDED write (committingForward) is committed here unconditionally — we
    // do NOT re-check ownership. The forwarder already routed it to us; re-checking
    // would re-forward whenever ring views transiently disagree during mesh
    // formation (each side computing a different owner), ping-ponging the write
    // until membership converges. Honoring the forwarder's decision ends the write
    // in one hop; a brief ring disagreement at worst commits at a not-yet-true
    // owner, which still replicates and converges by LWW (as the pre-F1 model did).
    if (!committingForward) {
      const p = partitionOf(change)
      const owner = me !== undefined ? mesh.owner(p) : undefined
      if (owner !== undefined && owner !== me && mesh.forward(owner, change)) {
        // Scoped holding (P2): we forwarded a write for a partition we DON'T
        // replicate. The owner commits + replicates to the R-set (not us), so the
        // canonical record never comes back — drop the optimistic value we just
        // applied rather than orphan a stale copy. (Reading this key is a remote
        // read — Milestone Q1.) Under full replication we keep it: the canonical
        // record returns and reconciles.
        if (scoped && !holds(p)) dropLocal(p)
        return
      }
    }
    commitLocal(change)
  })

  // Silently remove a foreign partition we optimistically applied but don't hold
  // (after forwarding its write to the owner). Guarded by `applying` so the removal
  // doesn't re-enter the sink — no echo, no spurious forwarded 'remove'.
  const dropLocal = (partition: string) => {
    applying = true
    try {
      applyRecord(res, { type: 'remove', key: [partition] })
    } finally {
      applying = false
    }
  }

  // Fully shed an orphan partition (Milestone P4): remove it from the proxy, the
  // log (segment + provenance index), the dedup high-water, and the LWW version map
  // — a complete handoff off this node. Called ONLY once a current R-set member is
  // confirmed caught up (shedConfirmed), so the partition is never less than
  // R-replicated. After this we no longer claim the partition in our digest.
  const shed = (partition: string) => {
    dropLocal(partition) // proxy (guarded — no re-emit / spurious forwarded remove)
    log.drop(partition)
    const suffix = '\x00' + partition
    for (const k of seen.keys()) if (k.endsWith(suffix)) seen.delete(k)
    for (const k of versions.keys()) if (k === partition || k.startsWith(partition + '\x00')) versions.delete(k)
    orphans.delete(partition)
    shedReady.delete(partition)
  }

  // Note partitions we hold but no longer replicate as orphans-to-shed (scan on view
  // commit, when the ring rebalances). A write committed locally at a non-replica
  // adds itself directly (commitLocal).
  const markOrphans = () => {
    if (!scoped || me === undefined) return
    for (const p of log.partitions()) if (!holds(p) && !orphans.has(p)) orphans.add(p)
  }

  // Confirmed shedding: a peer (at listen address `peerMe`) sent its high-water
  // marks. For each orphan partition we hold, if that peer is a current R-set member
  // AND its marks cover ALL our (origin,partition) records, record it as caught up.
  // We shed only once EVERY member of the partition's current R-set is confirmed
  // caught up — so the partition is fully R-replicated WITHOUT us before we drop it.
  // Single-confirmation would be UNSAFE: if a partition's R-set moves entirely
  // ({A,B}→{C,D}), shedding A as soon as C is caught up (before D acquired) would
  // leave the partition on just {C} (1 < R). Conservative throughout: a missing/
  // lower peer mark keeps the orphan (no data can ever be lost). Runs on every
  // digest (both legs), so orphans drain within a few anti-entropy rounds.
  const shedConfirmed = (peerMarks: Record<string, number>, peerMe: string) => {
    if (!scoped || me === undefined || !orphans.size) return
    for (const p of [...orphans]) {
      if (holds(p)) {
        orphans.delete(p) // we replicate it again (ring moved back) — not an orphan
        shedReady.delete(p)
        continue
      }
      const rset = mesh.owners(p, R)
      if (!rset.includes(peerMe)) continue // peer isn't a current R-set holder of p
      let caughtUp = true
      const suffix = '\x00' + p
      for (const [key, seq] of seen) {
        if (key.endsWith(suffix) && (peerMarks[key] ?? 0) < seq) {
          caughtUp = false
          break
        }
      }
      if (!caughtUp) continue
      let ready = shedReady.get(p)
      if (!ready) shedReady.set(p, (ready = new Set()))
      ready.add(peerMe)
      if (rset.every((m) => ready!.has(m))) shed(p) // every R-set member caught up → safe to drop
    }
  }

  // Commit a record under OUR provenance: stamp (origin=us, Lamport seq), record
  // it as the LWW winner for its key, log it, and replicate. Used for partitions
  // we own and as the never-drop fallback when an owner is unreachable.
  function commitLocal(change: ChangeRecord) {
    // Write-gate chokepoint (V1e): without a reachable quorum we are read-only —
    // buffer the write (don't stamp/log/broadcast) so a minority can't diverge.
    // This SUPERSEDES F1's never-drop local commit for a quorum-less node. Both
    // local writes and forwarded writes (applyLocalWrite) funnel through here.
    if (viewMgr && !viewMgr.canWrite) {
      if (pending.length >= MAX_PENDING) pending.shift() // bounded: drop oldest
      pending.push(change)
      return
    }
    const n = ++clock
    change.origin = uuid
    change.seq = n
    const e = (change.epoch = viewEpoch()) // the view this write commits under (carried on the wire + fenced in LWW)
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
    // Replicate to peers: scoped mode with R < members ships only to the OTHER
    // replicas in this partition's R-set (we already applied + logged it); otherwise
    // (full replication, or R≥members so everyone holds all) broadcast to every
    // connected server. Compute the R-set ONCE and reuse it for both the send and the
    // orphan check (holds() would otherwise re-scan the ring a second time per write).
    if (scoped && R < viewSize()) {
      const rset = mesh.owners(p, R)
      mesh.replicateTo(rset, change)
      // A write committed at a node NOT in the partition's R-set (the never-drop
      // fallback when the owner is unreachable, or a misrouted forward) is an orphan:
      // keep it (we shipped it to the true R-set above) but mark it to shed once that
      // R-set is confirmed caught up (P4).
      if (!rset.includes(me!)) orphans.add(p)
    } else mesh.broadcast(change)
  }

  // A peer forwarded a write for a partition we own. Apply it to our proxy as a
  // local write (NOT guarded by `applying`) so the write-capture sink above runs
  // and commits it under our provenance — turning the forwarder's optimistic
  // write into our authoritative, sequenced one. `committingForward` tells the
  // sink to commit it as-is rather than re-evaluate ownership (no re-forward → no
  // ping-pong while ring views are still settling).
  const applyLocalWrite = (record: ChangeRecord) => {
    committingForward = true
    try {
      applyRecord(res, record)
    } finally {
      committingForward = false
    }
  }

  // Quorum returned (the write-gate opened): re-commit everything buffered while
  // read-only, in order. commitLocal re-checks canWrite, so anything that can't go
  // out (gate closed again) simply re-buffers. (Buffered writes flush under the
  // CURRENT epoch — a known V1e semantic; preserving the attempt-epoch is an F2
  // refinement.)
  function flushPending() {
    if (!pending.length) return
    const batch = pending.splice(0)
    for (const c of batch) commitLocal(c)
  }

  // ── Distributed aggregates (Milestone Q2/Q3) ──
  // The fold ENGINE — owner-scoped partial construction, the live re-scoping partial, and the
  // querying-side one-shot + live gather — lives in [./fold.ts] (makeFold), built below once
  // `invoke` + clientSubs exist (the engine's only injected deps beyond the raw proxy/mesh/state).

  const cluster: Cluster = {
    peers: mesh.peers,
    get me() {
      return mesh.me
    },
    uuid: mesh.uuid,
    owner: (key: string) => mesh.owner(key),
    replicas: (key: string) => mesh.owners(key, R), // owner + R-1 successors; all members when R is ∞ (full replication)
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

  // Default methods (plan §6.3), overridable by same-named opts functions. Each
  // assigns to context.data → the write-capture sink replicates the result. A method
  // assigning to data is a trusted local commit; it does NOT re-invoke the method
  // (plan §5 recursion-safety) — the sink replicates, it doesn't dispatch.
  const defaults: Record<string, Method> = {
    // read() → whole data; read(key) → just that key's child view (Q1 keyed read —
    // the server side of an owner-routed remote read). On a holder, c.data[key] is
    // the live local child; snapshot for the RPC reply, streamed for a subscription.
    read: (arg, c) => (typeof arg === 'string' ? c.data[arg] : c.data),
    // aggregate(spec) → this node's owner-scoped PARTIAL for a distributed aggregate
    // (Milestone Q2). A ViewProxy like read — snapshot for an RPC, streamed for a
    // subscription. The querying node fans this method out to every holder and folds
    // the partials into the global answer (Q2b). Owner-scoped over the RAW proxy via
    // buildPartial, so the union across holders is a disjoint cover (no R-fold
    // double-count). Closes over data/mesh/me (not c.data) — it needs ownership.
    aggregate: (spec) => fold.buildPartial(spec),
    // NB: plain assignments (`data.x = y`) bypass these — they commit straight through
    // the write-capture sink, not via these methods. See ../IDEAS.md "Assignment ↔
    // methods.update parity". Overriding `update` guards methods.update(...) calls only.
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
  // Read-forwarding (Q1): a `read(key)` for a partition we don't hold (a client
  // routed here, but we're not the owner) forwards to the owner, which holds it —
  // returning a Promise the transport awaits before replying. The owner holds the
  // key so it serves (no re-forward). Only in scoped mode; full replication holds all.
  // Strip the `fold` flag → the partial spec a fold fans out to holders (no recursion).
  const stripFold = (arg: any) => ({ op: arg?.op, col: arg?.col, val: arg?.val })
  const serveCall = (method: string, arg: unknown, address: string): unknown => {
    if (method === 'read' && typeof arg === 'string' && scoped && !holds(arg)) {
      const owner = mesh.owner(arg)
      if (owner !== undefined && owner !== me) return mesh.call('read', arg, owner)
    }
    // Whole-resource read() under scoping (Milestone Q3): a client called read() with NO key.
    // No single node holds the whole resource, so GATHER it — fold every holder's owner-scoped
    // rows into the union (the {op:'rows'} partial, fold stripped → no recursion) — and reply
    // with the global snapshot. This is the explicit "download everything" the user chains
    // holistic ops after. R≥members / full replication hold everything, so read() stays a local
    // c.data snapshot there (the hot path is byte-identical — the gather only arms when scoped).
    if (method === 'read' && arg == null && scoped && R < viewSize() && allMethods.read === defaults.read) return fold.foldOnce({ op: 'rows' }, AGG.rows.combine)
    // A CLIENT routed a distributed aggregate here (Milestone Q2e): a client can't
    // owner-scope or fold, so it sends {fold:true} and THIS server (a coordinator) returns
    // the GLOBAL via a one-shot gather. The gather fans out PARTIAL requests (fold stripped)
    // to holders, so there's no recursion. (A server's own facade aggregate uses
    // foldAggregate directly, never this path; a server-to-server fan-out has no fold flag
    // → the partial path below.)
    if (method === 'aggregate' && (arg as any)?.fold) {
      const s = stripFold(arg)
      return fold.foldOnce(s, AGG[s.op]?.combine) // a Promise; the CALL handler awaits it before replying
    }
    return snapshot(invoke(method, arg, address))
  }

  // Server side of a subscription: run the method here; if it returns a ViewProxy
  // (a projection — the default `read` returns the whole `data`, a custom one may
  // return `data.filter(...)`), connect a sink and stream every change (the
  // initial snapshot first, then deltas) to the subscriber. A plain value is shipped
  // once. The sink host is retained per (address, subId) so it keeps firing until
  // the client unsubscribes (data holds sinks only by WeakRef).
  // `src` retains the served SOURCE proxy alongside its sink host: data's FunctionSink
  // (core.ts) back-refs only `this.fn`, not its source, so a derived projection (a custom
  // read's `data.filter(...)`, or an `aggregate` partial) would GC its filter→op chain and
  // freeze the stream after a full GC on a long-running server — pinning only the host
  // isn't enough. (The default read returns the root `data`, retained anyway, so this only
  // bites derived views.) Held until the client unsubscribes.
  const subscriptions = new Map<string, { host?: object; src?: object; unsub?: () => void; close?: () => void }>()
  // Reverse index address → its open subIds, so an ungraceful disconnect (a socket drop, which never
  // delivers an UNSUBSCRIBE frame) can REAP that peer's served subscriptions instead of leaking them
  // (subscription-hygiene fix; before this a dropped client/coordinator leaked its sink hosts, Q1
  // read-forward upstreams, and — worst — Q3 gather / Q2 fold openFolds, each pinning an
  // aggregateReconciles entry re-run every commit + AE tick FOREVER). Keyed by the EXACT address (no
  // `host:port` string-splitting — `:` appears in the key). addSub keeps it in lockstep with `subscriptions`.
  const subsByPeer = new Map<string, Set<number>>()
  const addSub = (address: string, subId: number, entry: { host?: object; src?: object; unsub?: () => void; close?: () => void }) => {
    subscriptions.set(`${address}:${subId}`, entry)
    let ids = subsByPeer.get(address)
    if (!ids) subsByPeer.set(address, (ids = new Set()))
    ids.add(subId)
  }
  const serveSubscribe = (subId: number, method: string, arg: unknown, address: string) => {
    // Read-forwarding (Q1): subscribe a non-held read key FROM the owner and relay its
    // deltas to the subscriber; the upstream unsub is closed on unsubscribe.
    if (method === 'read' && typeof arg === 'string' && scoped && !holds(arg)) {
      const owner = mesh.owner(arg)
      if (owner !== undefined && owner !== me) {
        const unsub = mesh.subscribe('read', arg, (record: ChangeRecord) => mesh.deltaTo(address, subId, record), owner)
        if (unsub) addSub(address, subId, { unsub })
        return
      }
    }
    // A CLIENT's reactive whole-resource read() under scoping (Milestone Q3): build the live
    // GATHER here (the union of every holder's owner-scoped rows, refolded on any shard delta)
    // and stream it to the client; the client runs its holistic ops over the gathered proxy
    // locally. Same openFold machinery as a distributed aggregate, with the union rule. Torn
    // down on unsubscribe.
    //   NOT gated on R<viewSize() (unlike the stateless serveCall one-shot) — this branch runs
    // ONCE at subscribe and is never re-evaluated, so gating on membership-at-subscribe would let a
    // read() opened while members≤R (server momentarily holds all) stream that server's LOCAL c.data
    // forever, then go SILENTLY PARTIAL once a join shards the resource and the server sheds keys
    // (the Q3a review's confirmed defect). The gather is correct at ANY R — owner-scoping is a
    // disjoint cover regardless of replica count — and openFold's reconcileMembers re-arms on each
    // commit, so an ungated gather is membership-robust. Mirrors the aggregate subscribe branch
    // (also ungated). Full replication never builds the facade / sends a scoped read, so R=∞ is
    // unaffected. (serveCall keeps the R<viewSize() optimization: it re-evaluates per call, so a
    // complete-local read at members≤R is always current.)
    if (method === 'read' && arg == null && scoped && allMethods.read === defaults.read) {
      const g = fold.openFold({ op: 'rows' }, AGG.rows.combine)
      const host = (g.proxy as any).connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change))
      addSub(address, subId, { host, src: g.proxy, close: g.close })
      return
    }
    // A CLIENT's reactive distributed aggregate (Milestone Q2e): build the FOLD here and
    // stream the global result to the client; the fold fans out partial requests (fold
    // stripped) so there's no recursion. Torn down on unsubscribe (close).
    if (method === 'aggregate' && (arg as any)?.fold) {
      try {
        const s = stripFold(arg)
        const f = fold.openFold(s, AGG[s.op]?.combine)
        const host = (f.proxy as any).connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change))
        addSub(address, subId, { host, src: f.proxy, close: f.close })
      } catch {
        // unknown op → no stream (RPC path surfaces errors)
      }
      return
    }
    // A served aggregate partial (Milestone Q2c) is a livePartial: it re-scopes itself on
    // THIS holder's own view commit (ownership moved → owner-scope changes) and pushes the
    // new value over this EXISTING subscription, so the coordinator never re-subscribes a
    // stable holder. Streamed as a root-update delta.
    if (method === 'aggregate') {
      try {
        const lp = fold.livePartial(arg, (v) => mesh.deltaTo(address, subId, { type: 'update', key: [], value: v }))
        addSub(address, subId, { close: lp.close })
      } catch {
        // an unknown op throws in buildPartial — yield no stream (RPC path surfaces errors)
      }
      return
    }
    let result: unknown
    try {
      result = invoke(method, arg, address)
    } catch {
      return // a failed subscription just yields no stream (RPC path surfaces errors)
    }
    if (isViewProxy(result)) {
      const host = (result as any).connect({}, (change: ChangeRecord) => mesh.deltaTo(address, subId, change))
      addSub(address, subId, { host, src: result as object }) // src retains the source chain (see map decl)
    } else {
      mesh.deltaTo(address, subId, { type: 'update', key: [], value: result })
    }
  }
  const serveUnsubscribe = (subId: number, address: string) => {
    const k = `${address}:${subId}`
    const sub = subscriptions.get(k)
    sub?.unsub?.() // forwarded subscription → close the upstream; local → just drop the host (sink GC'd)
    sub?.close?.() // a livePartial / openFold (served aggregate or gather) → deregister its rescope/reconcile + drop refs
    subscriptions.delete(k)
    const ids = subsByPeer.get(address)
    if (ids && ids.delete(subId) && ids.size === 0) subsByPeer.delete(address)
  }
  // A peer's connection dropped (socket close / destroy) without an UNSUBSCRIBE — reap every
  // subscription we served it (idempotent: routes each through serveUnsubscribe). Iterates a COPY,
  // since serveUnsubscribe mutates subsByPeer. No-op for a peer we never served (a dial failure, or a
  // server that only ever called/replicated). This is the chokepoint that stops the openFold leak.
  const reapPeer = (address: string) => {
    const ids = subsByPeer.get(address)
    if (!ids) return
    for (const subId of [...ids]) serveUnsubscribe(subId, address)
  }

  // The local method surface (server) calls handlers in-process. A read-only
  // client (no listen port) has no handlers — each method returns a HANDLE that
  // is both a thenable and a live ViewProxy: `await methods.x(arg)` is a one-shot
  // RPC (snapshot/ack), while reactive use (`methods.x(arg).tap(...)`, `.filter`,
  // `[value]`) opens a server-pushed live subscription. await-or-not picks the
  // mode (plan §1) — `then` is the only access that does NOT subscribe.
  const isClient = mesh.me === undefined
  const localMethods: Record<string, (arg?: any) => any> = {}
  for (const k of Object.keys(allMethods)) localMethods[k] = (arg?: any) => invoke(k, arg)
  context.methods = localMethods // method-to-method calls run locally

  const clientSubs = new Set<() => void>()

  // The distributed-aggregate fold engine (Milestone Q2/Q3) — owner-scoped partials + the
  // querying-side one-shot/live gather — lifted to [./fold.ts] (makeFold). Built here, once its
  // injected deps exist: `invoke` (the in-process dispatcher — it does NOT depend on the engine,
  // so the wiring stays linear) plus the raw `data` proxy, the mesh, the two aggregate registries
  // the composer's onCommit/aeTimer walk, and clientSubs (a fold handle's teardown drains here).
  const fold = makeFold({ data, mesh, me, invoke, aggregateRebinds, aggregateReconciles, clientSubs })

  // A remote-access HANDLE: a thenable (await ⇒ one-shot RPC) that is ALSO a live
  // ViewProxy (reactive use ⇒ a server-pushed subscription). `to()` picks the target
  // peer lazily — a specific owner (owner-routed reads) or undefined ⇒ a picked
  // connected server. `then` is the only access that does NOT subscribe.
  const makeHandle = (method: string, arg: unknown, to?: () => string | undefined, writeKey?: string) =>
    lazyHandle({
      then: (onF, onR) => mesh.call(method, arg, to?.()).then(onF, onR), // await ⇒ one-shot RPC
      open: () => {
        // any real data/operator access ⇒ subscribe + delegate to the live proxy
        const live = $({})
        const res = (live as any)[VIEWSYM].res
        const unsub = mesh.subscribe(method, arg, (record: ChangeRecord) => applyRecord(res, record), to?.())
        if (unsub) clientSubs.add(unsub)
        return live
      },
      // Nested write into a non-held partition (`data.x.y = v`): route to the RAW proxy so it
      // flows through the write-capture sink → owner. Only the READ handle passes a writeKey (a
      // method handle has none — set is then absent). Depth-1 only; deeper writes into a non-held
      // partition aren't routed (use a top-level `data.x = {…}` or the holding node) — documented.
      set: writeKey !== undefined ? (prop, v) => ((data as any)[writeKey][prop] = v) : undefined,
    })
  const clientHandle = (method: string, arg: unknown) => makeHandle(method, arg) // routed to a picked server

  // Owner-routed remote read (Q1): reading a partition this node doesn't hold returns
  // a handle that fetches (await) or subscribes from a HOLDER. A server is fully
  // meshed with the owner → route straight to owner(key); a client routes to a picked
  // server (which forwards to the owner — read-forwarding, a follow-up). `await
  // data.x` is one-shot; `data.x.tap(...)`/`.filter`/`[value]` opens a live remote view.
  const remoteRead = (key: string) => makeHandle('read', key, me !== undefined ? () => mesh.owner(key) : undefined, key)

  // The read surface: synchronous-and-local for a partition we hold, a remote handle
  // for one we don't (hold-relative reads). The `data` facade returned below is sugar
  // over this. Internal machinery keeps using the raw `data` (held partitions only).
  const readKey = (key: string) => (holds(key) ? data[key] : remoteRead(key))

  // (foldOnce / openFold / foldAggregate — the querying-side gather machinery — now live in the
  // fold engine [./fold.ts], reached via `fold.*` above.)

  // Server-side whole-resource read() gather (Milestone Q3b). A scoped SERVER holds only its
  // R-set, so its own no-key `methods.read()` would otherwise return a LOCAL partial — wrong for
  // the holistic ops (`methods.read().az('v')`, `.distinct()`, `.reduce(...)`) the user runs AFTER
  // read. Replace the DEFAULT no-key read with the gather HANDLE (foldAggregate over {op:'rows'}):
  // `await methods.read()` is a one-shot gather, reactive use opens the live gather and the holistic
  // op runs over the merged whole-resource proxy locally.
  //   • Only when read is the DEFAULT (allMethods.read === defaults.read): a user-supplied `read` is
  //     THEIR projection — never silently swap it for the raw gather (which would diverge from the
  //     full-rep path, where the custom read runs over complete state). [Q3b review M1]
  //   • MEMOIZED to ONE handle per node: the spec is the constant {op:'rows'}, so a single
  //     foldAggregate (one live openFold, membership-robust via reconcile) backs every call. A fresh
  //     handle per reactive call would leak an O(resource) union-fold into aggregateReconciles —
  //     re-run every commit + AE tick — forever. [Q3b review M3]
  //   • Keyed `methods.read(key)` is LOCAL (this node's held child view, via baseRead). Owner-routing
  //     for a non-held key is the `data` facade (`data[key]` → remoteRead) or an inbound client RPC
  //     (serveCall read-forwarding) — NOT this surface. [Q3b review m4]
  //   • In-handler `context.methods.read()` is this same gather handle (context.methods IS
  //     localMethods): `await` ⇒ global, reactive ⇒ live, sync `[value]` ⇒ the in-progress union;
  //     a handler wanting the LOCAL held state reads `c.data` directly. [Q3b review m5; DECISIONS Q3]
  // Ungated on R (membership-robust — openFold re-arms on commit). Full replication (scoped=false)
  // keeps the raw-c.data read — that node holds everything, so local IS global.
  if (!isClient && scoped && allMethods.read === defaults.read) {
    const baseRead = localMethods.read
    let gather: any
    localMethods.read = (arg?: any) => (arg == null ? (gather ??= fold.foldAggregate({ op: 'rows' })) : baseRead(arg))
  }

  const methodSurface: Record<string, (arg?: any) => any> = isClient
    ? (new Proxy({}, { get: (_t, name: string) => (arg?: any) => clientHandle(name, arg) }) as any)
    : localMethods

  // The `data` facade (Q1): top-level KEY access is hold-relative — the local child
  // view if we hold the partition, a remote handle (await/subscribe to a holder) if
  // not. Operators (`.filter`, `.group`, …), the built-ins, symbols (`[value]`,
  // iterator), and writes pass straight through to the underlying proxy, so the full
  // data surface is preserved and operators run over the LOCAL (held) partitions. We
  // distinguish a partition key from an operator/built-in via the data lib's
  // `Operators` table. Only built when this node can have non-held keys (a scoped
  // server, or any client); a full-replication server returns the raw proxy — a
  // transparent no-op — so its hot read path is unchanged.
  // Built-ins that pass straight through to the raw proxy (the data-lib apply-trap
  // ops that are NOT in the Operators table): the reactive built-ins, the terminal
  // write ops (update/insert/remove), and JS internals. Without update/insert/remove
  // here, `data.update(...)` would be misread as a partition key named "update".
  const BUILTIN = new Set(['connect', 'raf', 'patch', 'first', 'last', 'then', 'toJSON', 'constructor', 'update', 'insert', 'remove'])
  // own-key check (NOT `prop in Operators`): Operators is a plain object literal, so
  // `in` walks Object.prototype and would wrongly classify partition keys named
  // toString/valueOf/hasOwnProperty/… as operators (returning a stale local child
  // instead of a remote handle). hasOwnProperty.call matches only registered operators.
  const isOperator = (prop: string) => Object.prototype.hasOwnProperty.call(Operators, prop)
  // Decomposable aggregate terminals (Q2): on a scoped SERVER, `data.sum('v')` over the
  // WHOLE resource is a fan-out + fold, not a local operator (which would see only this
  // node's held partitions = a partial). count is `length()` with no arg; `length(fn)`
  // (bucketed) and top/limit-K are holistic-shaped → Q3 (the loud guard lands in Q2f).
  // A client cannot owner-scope or fold (no me/view) → its aggregates route to a server
  // (server-as-coordinator, Q2f); until then the facade leaves them to the raw operator.
  const DECOMPOSABLE = new Set(['sum', 'max', 'min', 'avg', 'some', 'every', 'length'])
  const distributable = scoped || isClient // the facade only exists for scoped||isClient; intercept aggregates in both
  // Build a SERIALIZABLE aggregate spec from a facade call, or null if it can't be
  // distributed (a closure predicate, or length(fn) bucketed — both deferred). count is
  // length() with no arg.
  const specOf = (op: string, args: unknown[]): { op: string; col?: unknown; val?: unknown } | null => {
    if (op === 'length') return args[0] !== undefined ? null : { op: 'count' } // length(fn) bucketed → Q3
    if (typeof args[0] === 'function') return null // a closure can't cross the wire
    if (op === 'some' || op === 'every') return { op, col: args[0], val: args[1] }
    return { op, col: args[0] }
  }
  const distributed = (op: string) => (...args: unknown[]) => {
    const spec = specOf(op, args)
    if (spec === null) {
      // Not distributable (a closure predicate, or length(fn) bucketed → Q3). Warn LOUDLY
      // and fall back to the LOCAL operator (held partitions only on a server; empty on a
      // client) rather than silently returning a local partial as if it were the global.
      console.warn(`fero: data.${op}(${typeof args[0] === 'function' ? 'fn' : '…'}) can't be distributed — ${typeof args[0] === 'function' ? 'a closure can\'t cross the wire' : 'bucketed length(fn) is deferred (Q3)'}. Returning a LOCAL result only. Use a declarative argument (a column${op === 'some' || op === 'every' ? '[, value]' : ''}) or a named aggregator method.`)
      return (data as any)[op](...args)
    }
    // A CLIENT (no me/view) can't owner-scope or fold — route the aggregate to a server,
    // which builds the fold and streams the GLOBAL back (server-as-coordinator, Q2e). The
    // `fold:true` flag tells the server to fold rather than return its own partial.
    if (isClient) return clientHandle('aggregate', { ...spec, fold: true })
    // R≥members ⇒ this node holds the whole resource → run the aggregate LOCALLY over
    // complete state (re-checked per access as membership grows). Matches "all data local
    // ⇒ run locally unchanged". EXCEPT some/every: their DECLARATIVE (col) form has no raw
    // data-lib equivalent (data's some/every require a PREDICATE FN — `data.some('active')`
    // would throw "fn is not a function"), so they always go through the fold, which
    // reconstructs the predicate from (col,val) in buildPartial. The fold is correct for
    // any R (owner-scoping is a disjoint cover regardless of how many nodes hold each
    // partition); at R≥members it just fans out to members that each happen to hold all.
    //   NOTE — under FULL replication (R=∞, the default) the facade is NOT built (the raw
    //   proxy is returned, to keep that hot path byte-identical), so this code never runs
    //   there: `data.sum/max/min/avg('col')` / `data.length()` work (data accepts a column),
    //   but `data.some/every('col')` falls through to data's raw some/every and throws — use
    //   the NATIVE predicate form `data.some(s => s.active)` under full replication (you hold
    //   all the data, so the local some/every IS the global). The declarative col form is the
    //   scoped-distributed sugar. Not a Q2 regression (data's some/every always needed a fn);
    //   making the col form uniform needs a data-lib some(col)/every(col) overload — IDEAS.
    if (R >= viewSize() && op !== 'some' && op !== 'every') return (data as any)[op](...args)
    return fold.foldAggregate(spec)
  }
  // Q3 boundary guard. These operators are HOLISTIC or ordered — the global answer needs the
  // full multiset co-located — so they CAN'T fold from per-shard partials. The Q3 path is to
  // GATHER first: `methods.read()` (no key) downloads the whole resource (Q3a/Q3b), and the
  // holistic op runs over THAT — `methods.read().az('v')`, `.distinct()`, `.reduce(...)` — or you
  // derive it as its own named resource. Calling the op DIRECTLY on `data` (no read) runs over
  // only this node's held partitions and would SILENTLY look like a global answer, so we return
  // that local result but WARN LOUDLY (once per op). top/limit-K specifically: data's sort emits
  // positional BMV1 'move' deltas applyRecord ignores ([DECISIONS E]); a grouped aggregate
  // (group(c).sum(v)) needs the L3 chain planner — both still deferred. A full-replication node
  // never builds the facade, so this never fires there (local IS global).
  const HOLISTIC = new Set(['az', 'za', 'top', 'limit', 'group', 'distinct', 'reduce']) // registered chainable operators (sort family = az/za/top/limit)
  const holisticWarned = new Set<string>()
  const holisticGuard = (op: string) => (...args: unknown[]) => {
    if (!isClient && R >= viewSize()) return (data as any)[op](...args) // holds everything → local is global
    if (!holisticWarned.has(op)) {
      holisticWarned.add(op)
      console.warn(`fero: data.${op}(...) is HOLISTIC over the WHOLE resource and can't fold from per-shard partials — returning a LOCAL result (held partitions only). Run it AFTER methods.read() (which gathers the whole resource) — e.g. methods.read().${op}(...) — or derive it as its own named resource. (group(...).sum(...) needs the L3 chain planner; decomposable aggregates — sum/count/max/min/avg/some/every — distribute via the facade with no read.)`)
    }
    return (data as any)[op](...args)
  }
  const dataFacade =
    scoped || isClient
      ? new Proxy(data, {
          get(t, prop) {
            if (typeof prop === 'symbol' || BUILTIN.has(prop as string)) return (t as any)[prop]
            if (distributable && DECOMPOSABLE.has(prop as string)) return distributed(prop as string)
            if (distributable && HOLISTIC.has(prop as string)) return holisticGuard(prop as string) // Q3 boundary: loud, never silent
            if (isOperator(prop as string)) return (t as any)[prop]
            return readKey(prop as string)
          },
          set(t, prop, v) {
            ;(t as any)[prop] = v
            return true
          },
          deleteProperty(t, prop) {
            delete (t as any)[prop]
            return true
          },
        })
      : data

  await mesh.ready

  return {
    data: dataFacade,
    methods: methodSurface,
    cluster,
    destroy() {
      void writeHost // retain the sink host until teardown
      if (aeTimer) clearInterval(aeTimer)
      viewMgr?.destroy()
      for (const unsub of clientSubs) unsub()
      mesh.destroy()
    },
    // Internals seam (Symbol-keyed, off the typed/enumerable public API): observability +
    // fault-injection for tests and power users. `servedSubscriptions` is the count of live
    // subscriptions this node serves (asserts the reap of a dropped peer); `drop` abruptly closes a
    // peer's connection (no UNSUBSCRIBE — the way a real network drop looks) to exercise that reap;
    // `isolate`/`heal` are the reversible partition primitive the chaos harness uses (isolate both
    // sides for a true bidirectional cut that later heals and reconverges — see Peers.isolate).
    [diagnostics]: {
      servedSubscriptions: () => subscriptions.size,
      drop: (address: string) => mesh.drop(address),
      isolate: (address: string) => mesh.isolate(address),
      heal: (address: string) => mesh.heal(address),
    },
  } as Fero
}

// Symbol-keyed internals handle on a returned fero() instance (`instance[diagnostics]`): kept OFF
// the typed public surface (data/methods/cluster/destroy) and out of Object.keys.
export const diagnostics = Symbol('fero.diagnostics')
